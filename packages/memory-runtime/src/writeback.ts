import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
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

async function writeTextAtomically(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = join(dirname(path), `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, path);
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
  const nextTaskLog = `${await readText(taskLogPath)}${stamp}`;
  await writeTextAtomically(taskLogPath, nextTaskLog);
  writes.push({ path: taskLogPath, memory_class: "working" });

  if ((request.gotchas ?? []).length > 0) {
    const learnedAppend = (request.gotchas ?? []).map((note) => `
- ${note.title}: ${note.body}
`).join("");
    await writeTextAtomically(learnedPath, `${await readText(learnedPath)}${learnedAppend}`);
    writes.push({ path: learnedPath, memory_class: "learned" });
  }

  if ((request.rewrites ?? []).length > 0) {
    const rewritesAppend = (request.rewrites ?? []).map((rewrite) => `
### ${rewrite.target}
${rewrite.content}
`).join("");
    await writeTextAtomically(rewritesPath, `${await readText(rewritesPath)}${rewritesAppend}`);
    writes.push({ path: rewritesPath, memory_class: "rewrite" });
  }

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
