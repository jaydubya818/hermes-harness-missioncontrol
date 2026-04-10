import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { makeId, type ContextRequest, type ContextResponse, type MemoryClass } from "@agentic-harness/shared-types";

function classify(path: string): MemoryClass {
  if (path.endsWith("profile.md")) return "profile";
  if (path.endsWith("hot.md")) return "hot";
  if (path.includes("rewrites")) return "rewrite";
  if (path.includes("task-log")) return "working";
  if (path.includes("learned")) return "learned";
  return "bus";
}

export async function loadContextBundle(vaultRoot: string, request: ContextRequest): Promise<ContextResponse> {
  const candidates = [
    join(vaultRoot, "wiki", "agents", request.agent_id, "profile.md"),
    join(vaultRoot, "wiki", "agents", request.agent_id, "hot.md"),
    join(vaultRoot, "wiki", "projects", request.project_id, "standards.md"),
    join(vaultRoot, "wiki", "projects", request.project_id, "recipes.md")
  ];
  const files = [] as ContextResponse["files"];
  const included = [] as ContextResponse["trace"]["included"];
  const excluded = [] as ContextResponse["trace"]["excluded"];
  let used = 0;
  for (const path of candidates) {
    try {
      const meta = await stat(path);
      const content = await readFile(path, "utf8");
      const bytes = Buffer.byteLength(content, "utf8");
      if (used + bytes > request.budget_bytes) {
        excluded.push({ path, reason: "budget" });
        continue;
      }
      used += bytes;
      const memory_class = classify(path);
      files.push({ path, memory_class, priority: files.length + 1, reason: "default-runtime-scope", content });
      included.push({ path, class: memory_class, reason: "default-runtime-scope", bytes, priority: files.length });
      void meta;
    } catch {
      excluded.push({ path, reason: "missing" });
    }
  }
  return {
    bundle_id: makeId("ctx"),
    truncated: excluded.some((item) => item.reason === "budget"),
    budget_used: used,
    files,
    trace: { included, excluded }
  };
}
