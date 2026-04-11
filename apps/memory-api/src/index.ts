import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadContextBundle, closeTask, promoteLearning } from "@hermes-harness-with-missioncontrol/memory-runtime";
import type { CloseTaskRequest, ContextRequest, PromoteLearningRequest } from "@hermes-harness-with-missioncontrol/shared-types";

const app = new Hono();
const vaultRoot = process.env.HARNESS_VAULT_ROOT ?? resolve(process.cwd(), "../../vault/agentic-kb");

async function listDir(path: string) {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

async function readText(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function listProjectFiles(projectId: string) {
  return listDir(join(vaultRoot, "wiki", "projects", projectId));
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

app.get("/api/memory/agents/:id/summary", async (c) => {
  const agentId = c.req.param("id");
  const learned = await readText(join(vaultRoot, "wiki", "agents", agentId, "learned.md"));
  const rewrites = await readText(join(vaultRoot, "wiki", "agents", agentId, "rewrites.md"));
  return c.json({
    agent_id: agentId,
    profile_path: `wiki/agents/${agentId}/profile.md`,
    hot_path: `wiki/agents/${agentId}/hot.md`,
    working_path: `wiki/agents/${agentId}/task-log.md`,
    learned_count: learned ? learned.split("\n").filter((line) => line.trim().startsWith("-")).length : 0,
    pending_rewrites: rewrites ? rewrites.split("\n").filter((line) => line.trim().startsWith("###")).length : 0,
    recent_promotions: 0
  });
});

app.get("/api/memory/agents/:id/rewrite-candidates", async (c) => {
  const agentId = c.req.param("id");
  const rewrites = await readText(join(vaultRoot, "wiki", "agents", agentId, "rewrites.md"));
  const items = (rewrites ?? "")
    .split("\n### ")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk, index) => {
      const [target, ...rest] = chunk.split("\n");
      return { id: `rewrite_${index + 1}`, target, content: rest.join("\n").trim() };
    });
  return c.json({ agent_id: agentId, items });
});

app.get("/api/memory/projects/:id/summary", async (c) => {
  const projectId = c.req.param("id");
  const files = await listProjectFiles(projectId);
  return c.json({
    project_id: projectId,
    standards: files.filter((file) => file.includes("standards") || file.startsWith("promoted-")),
    active_rewrites: [],
    recent_postmortems: files.filter((file) => file.includes("postmortem")),
    recipes: files.filter((file) => file.includes("recipe") || file.includes("recipes")),
    promoted: files.filter((file) => file.startsWith("promoted-"))
  });
});

app.get("/api/memory/search", async (c) => {
  const query = (c.req.query("q") ?? "").toLowerCase();
  const candidates = [
    "wiki/agents/agent_demo/profile.md",
    "wiki/agents/agent_demo/hot.md",
    "wiki/agents/agent_demo/learned.md",
    "wiki/agents/agent_demo/rewrites.md",
    "wiki/projects/proj_demo/standards.md",
    "wiki/projects/proj_demo/recipes.md"
  ];
  const results = [] as Array<{ path: string; snippet: string }>;
  for (const path of candidates) {
    const fullPath = join(vaultRoot, path);
    const content = await readText(fullPath);
    if (content && (!query || content.toLowerCase().includes(query) || path.toLowerCase().includes(query))) {
      results.push({ path, snippet: content.slice(0, 240) });
    }
  }
  return c.json({ query, results });
});

app.get("/api/memory/articles", async (c) => {
  const section = c.req.query("section");
  const base = section ? join(vaultRoot, "wiki", section) : join(vaultRoot, "wiki");
  const files = await listDir(base);
  return c.json({ section: section ?? "root", files });
});

app.get("/api/memory/articles/:slug{.+}", async (c) => {
  const slug = c.req.param("slug");
  const fullPath = join(vaultRoot, "wiki", slug);
  const content = await readText(fullPath);
  if (!content) return c.json({ slug, content: "Not found" }, 404);
  return c.json({ slug, content });
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 4301) });
console.log("memory-api listening on http://localhost:4301");
