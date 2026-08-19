import { mkdir, open, readFile, rename, access, rm } from "node:fs/promises";
import { dirname, join, resolve, relative } from "node:path";
import { makeId, type CloseTaskRequest, type CloseTaskResponse, type PromoteLearningRequest, type PromoteLearningResponse } from "@hermes-harness-with-missioncontrol/shared-types";

function safeVaultPath(vaultRoot: string, relativePath: string) {
  const full = resolve(join(vaultRoot, relativePath));
  const root = resolve(vaultRoot);
  const rel = relative(root, full);
  if (rel.startsWith("..")) throw new Error("path escapes vault root");
  return full;
}

async function readText(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// write-then-rename is only atomic against a *reader*: without an fsync the
// rename can reach disk before the contents do, so a crash between the two
// leaves a valid-looking but truncated (or empty) markdown file where the
// previous version used to be. The vault is the durable record of what an
// agent learned, so flush the contents before the rename publishes them --
// the same guarantee packages/state-store gives the JSON state files.
async function writeFileDurably(path: string, content: string) {
  const handle = await open(path, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeTextAtomically(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = join(dirname(path), `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  try {
    await writeFileDurably(tmpPath, content);
    await rename(tmpPath, path);
  } catch (error) {
    // Do not leave orphaned .tmp files in the vault when the write fails.
    await rm(tmpPath, { force: true });
    throw error;
  }
}

type PendingWrite = { path: string; content: string };

async function commitTextBatchAtomically(writes: PendingWrite[]) {
  const staged = await Promise.all(writes.map(async ({ path, content }) => {
    await mkdir(dirname(path), { recursive: true });
    const tmpPath = join(dirname(path), `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    await writeFileDurably(tmpPath, content);
    return { path, tmpPath, backupPath: join(dirname(path), `.${Date.now()}-${Math.random().toString(36).slice(2)}.bak`) };
  }));

  const applied: Array<{ path: string; backupPath?: string }> = [];
  try {
    for (const item of staged) {
      let backupPath: string | undefined;
      if (await exists(item.path)) {
        backupPath = item.backupPath;
        await rename(item.path, backupPath);
      }
      await rename(item.tmpPath, item.path);
      applied.push({ path: item.path, backupPath });
    }

    for (const item of applied) {
      if (item.backupPath && await exists(item.backupPath)) {
        await rm(item.backupPath, { force: true });
      }
    }
  } catch (error) {
    for (const item of staged) {
      if (await exists(item.tmpPath)) {
        await rm(item.tmpPath, { force: true });
      }
    }

    for (const item of applied.reverse()) {
      if (await exists(item.path)) {
        await rm(item.path, { force: true });
      }
      if (item.backupPath && await exists(item.backupPath)) {
        await rename(item.backupPath, item.path);
      }
    }

    for (const item of staged) {
      if (await exists(item.backupPath) && !await exists(item.path)) {
        await rename(item.backupPath, item.path);
      }
      if (await exists(item.backupPath)) {
        await rm(item.backupPath, { force: true });
      }
    }

    throw error;
  }
}

// closeTask appends via read-modify-write on shared files (task-log.md,
// learned.md, rewrites.md). Two concurrent writebacks that both read before
// either commits would silently drop one of the appends, so writebacks are
// serialized through a module-level queue.
let writebackQueue: Promise<unknown> = Promise.resolve();

export function closeTask(vaultRoot: string, request: CloseTaskRequest): Promise<CloseTaskResponse> {
  const task = writebackQueue.then(() => performCloseTask(vaultRoot, request));
  writebackQueue = task.catch(() => undefined);
  return task;
}

async function performCloseTask(vaultRoot: string, request: CloseTaskRequest): Promise<CloseTaskResponse> {
  const started = Date.now();
  const writes: CloseTaskResponse["writes"] = [];
  const base = safeVaultPath(join(vaultRoot, "wiki", "agents"), request.agent_id);
  const taskLogPath = join(base, "task-log.md");
  const learnedPath = join(base, "learned.md");
  const rewritesPath = join(base, "rewrites.md");

  // Consumers of these files parse them line-anchored (learned_count counts
  // "- " lines, rewrite candidates split on "\n### ", task-log sections are
  // "## " headings), so single-line fields must stay single-line even when a
  // caller passes embedded newlines.
  const inline = (value: string) => value.replace(/[\r\n]+/g, " ").trim();

  // Free-text bodies (summary, rewrite content) sit beneath those anchored
  // headings; a body line that itself starts with a heading marker would
  // forge extra task-log sections or rewrite candidates. Escape such lines
  // so they render as literal text instead of entry boundaries.
  const escapeHeadingLines = (value: string) => value.replace(/^(#{2,6} )/gm, "\\$1");

  const stamp = `
## ${new Date().toISOString()} ${inline(request.step_id ?? "task")}
${escapeHeadingLines(request.summary)}
`;

  const pendingWrites: PendingWrite[] = [];

  const nextTaskLog = `${await readText(taskLogPath)}${stamp}`;
  pendingWrites.push({ path: taskLogPath, content: nextTaskLog });
  writes.push({ path: taskLogPath, memory_class: "working" });

  if ((request.gotchas ?? []).length > 0) {
    const learnedAppend = (request.gotchas ?? []).map((note) => `
- ${inline(note.title)}: ${inline(note.body)}
`).join("");
    pendingWrites.push({ path: learnedPath, content: `${await readText(learnedPath)}${learnedAppend}` });
    writes.push({ path: learnedPath, memory_class: "learned" });
  }

  if ((request.rewrites ?? []).length > 0) {
    const rewritesAppend = (request.rewrites ?? []).map((rewrite) => `
### ${inline(rewrite.target)}
${escapeHeadingLines(rewrite.content)}
`).join("");
    pendingWrites.push({ path: rewritesPath, content: `${await readText(rewritesPath)}${rewritesAppend}` });
    writes.push({ path: rewritesPath, memory_class: "rewrite" });
  }

  await commitTextBatchAtomically(pendingWrites);

  return {
    writeback_id: makeId("wb"),
    status: "ok",
    writes,
    promotion_candidates: (request.discoveries ?? []).map((item, index) => ({ item_id: `disc_${index + 1}`, reason: `promote if repeated: ${item.title}` })),
    trace: { duration_ms: Date.now() - started }
  };
}

export async function promoteLearning(vaultRoot: string, request: PromoteLearningRequest): Promise<PromoteLearningResponse> {
  const target = safeVaultPath(vaultRoot, request.target_path);
  await writeTextAtomically(target, `---
promoted_from: ${request.item_id}
promoted_by: ${request.promoted_by}
promotion_kind: ${request.promotion_kind}
---

Promoted artifact for ${request.item_id}.
`);
  return {
    promotion_id: makeId("promo"),
    target_path: request.target_path,
    status: "promoted"
  };
}
