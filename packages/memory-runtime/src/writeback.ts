import { mkdir, readFile, writeFile, rename, access, rm } from "node:fs/promises";
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

async function writeTextAtomically(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = join(dirname(path), `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, path);
}

type PendingWrite = { path: string; content: string };

async function commitTextBatchAtomically(writes: PendingWrite[]) {
  const staged = await Promise.all(writes.map(async ({ path, content }) => {
    await mkdir(dirname(path), { recursive: true });
    const tmpPath = join(dirname(path), `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    await writeFile(tmpPath, content, "utf8");
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

export async function closeTask(vaultRoot: string, request: CloseTaskRequest): Promise<CloseTaskResponse> {
  const started = Date.now();
  const writes: CloseTaskResponse["writes"] = [];
  const base = join(vaultRoot, "wiki", "agents", request.agent_id);
  const taskLogPath = join(base, "task-log.md");
  const learnedPath = join(base, "learned.md");
  const rewritesPath = join(base, "rewrites.md");

  const stamp = `
## ${new Date().toISOString()} ${request.step_id ?? "task"}
${request.summary}
`;

  const pendingWrites: PendingWrite[] = [];

  const nextTaskLog = `${await readText(taskLogPath)}${stamp}`;
  pendingWrites.push({ path: taskLogPath, content: nextTaskLog });
  writes.push({ path: taskLogPath, memory_class: "working" });

  if ((request.gotchas ?? []).length > 0) {
    const learnedAppend = (request.gotchas ?? []).map((note) => `
- ${note.title}: ${note.body}
`).join("");
    pendingWrites.push({ path: learnedPath, content: `${await readText(learnedPath)}${learnedAppend}` });
    writes.push({ path: learnedPath, memory_class: "learned" });
  }

  if ((request.rewrites ?? []).length > 0) {
    const rewritesAppend = (request.rewrites ?? []).map((rewrite) => `
### ${rewrite.target}
${rewrite.content}
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
