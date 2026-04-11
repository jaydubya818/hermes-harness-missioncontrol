import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadContextBundle, closeTask, promoteLearning } from "@hermes-harness-with-missioncontrol/memory-runtime";
import type { CloseTaskRequest, ContextRequest, PromoteLearningRequest } from "@hermes-harness-with-missioncontrol/shared-types";

const app = new Hono();
const vaultRoot = process.env.HARNESS_VAULT_ROOT ?? resolve(process.cwd(), "../../vault/agentic-kb");

async function listProjectFiles(projectId: string) {
  const projectDir = join(vaultRoot, "wiki", "projects", projectId);
  try {
    return await readdir(projectDir);
  } catch {
    return [];
  }
}

app.get("/health", (c) => c.json({ ok: true, service: "memory-api" }));
app.post("/api/memory/context/load", async (c) => {
  const body = await c.req.json<ContextRequest>();
  const result = await loadContextBundle(vaultRoot, body);
  return c.json(result);
});
app.post("/api/memory/tasks/close", async (c) => {
  const body = await c.req.json<CloseTaskRequest>();
  const result = await closeTask(vaultRoot, body);
  return c.json(result);
});
app.post("/api/memory/promote", async (c) => {
  const body = await c.req.json<PromoteLearningRequest>();
  const result = await promoteLearning(vaultRoot, body);
  return c.json(result);
});
app.get("/api/memory/agents/:id/summary", async (c) => c.json({
  agent_id: c.req.param("id"),
  profile_path: `wiki/agents/${c.req.param("id")}/profile.md`,
  hot_path: `wiki/agents/${c.req.param("id")}/hot.md`,
  working_path: `wiki/agents/${c.req.param("id")}/task-log.md`,
  learned_count: 0,
  pending_rewrites: 0,
  recent_promotions: 0
}));
app.get("/api/memory/projects/:id/summary", async (c) => {
  const projectId = c.req.param("id");
  const files = await listProjectFiles(projectId);
  return c.json({
    project_id: projectId,
    standards: files.filter((file) => file.includes("standards")),
    active_rewrites: [],
    recent_postmortems: files.filter((file) => file.includes("postmortem")),
    recipes: files.filter((file) => file.includes("recipe") || file.includes("recipes"))
  });
});
app.get("/api/memory/search", async (c) => {
  const query = (c.req.query("q") ?? "").toLowerCase();
  const candidates = [
    "wiki/agents/agent_demo/profile.md",
    "wiki/agents/agent_demo/hot.md",
    "wiki/projects/proj_demo/standards.md",
    "wiki/projects/proj_demo/recipes.md"
  ];
  const results = [] as Array<{ path: string; snippet: string }>;
  for (const path of candidates) {
    const fullPath = join(vaultRoot, path.replace(/^wiki\//, "wiki/"));
    try {
      const content = await readFile(fullPath, "utf8");
      if (!query || content.toLowerCase().includes(query) || path.toLowerCase().includes(query)) {
        results.push({ path, snippet: content.slice(0, 160) });
      }
    } catch {
      // ignore
    }
  }
  return c.json({ query, results });
});
app.get("/api/memory/articles/:slug{.+}", async (c) => {
  const slug = c.req.param("slug");
  const fullPath = join(vaultRoot, "wiki", slug);
  try {
    const content = await readFile(fullPath, "utf8");
    return c.json({ slug, content });
  } catch {
    return c.json({ slug, content: "Not found" }, 404);
  }
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 4301) });
console.log("memory-api listening on http://localhost:4301");
