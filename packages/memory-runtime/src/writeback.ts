import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { makeId, type CloseTaskRequest, type CloseTaskResponse, type PromoteLearningRequest, type PromoteLearningResponse } from "@hermes-harness-with-missioncontrol/shared-types";

async function safeAppend(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, content, "utf8");
}

export async function closeTask(vaultRoot: string, request: CloseTaskRequest): Promise<CloseTaskResponse> {
  const started = Date.now();
  const writes: CloseTaskResponse["writes"] = [];
  const base = join(vaultRoot, "wiki", "agents", request.agent_id);
  const stamp = `
## ${new Date().toISOString()} ${request.step_id ?? "task"}
${request.summary}
`;
  await safeAppend(join(base, "task-log.md"), stamp);
  writes.push({ path: join(base, "task-log.md"), memory_class: "working" });
  for (const note of request.gotchas ?? []) {
    await safeAppend(join(base, "learned.md"), `
- ${note.title}: ${note.body}
`);
  }
  if ((request.gotchas ?? []).length > 0) {
    writes.push({ path: join(base, "learned.md"), memory_class: "learned" });
  }
  for (const rewrite of request.rewrites ?? []) {
    await safeAppend(join(base, "rewrites.md"), `
### ${rewrite.target}
${rewrite.content}
`);
  }
  if ((request.rewrites ?? []).length > 0) {
    writes.push({ path: join(base, "rewrites.md"), memory_class: "rewrite" });
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
  const target = join(vaultRoot, request.target_path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `---
promoted_from: ${request.item_id}
promoted_by: ${request.promoted_by}
promotion_kind: ${request.promotion_kind}
---

Promoted artifact for ${request.item_id}.
`, "utf8");
  return {
    promotion_id: makeId("promo"),
    target_path: request.target_path,
    status: "promoted"
  };
}
