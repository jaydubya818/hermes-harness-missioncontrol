import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { readdir, readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join, resolve, relative } from "node:path";
import { loadContextBundle, closeTask, promoteLearning } from "@hermes-harness-with-missioncontrol/memory-runtime";
import type { CloseTaskRequest, ContextRequest, PromoteLearningRequest, PublishBusRequest } from "@hermes-harness-with-missioncontrol/shared-types";

const app = new Hono();
const vaultRoot = process.env.HARNESS_VAULT_ROOT ?? resolve(process.cwd(), "../../vault/agentic-kb");
const operatorToken = process.env.HARNESS_OPERATOR_TOKEN;

app.use("*", cors());


function isSafeId(value: string) {
  return /^[a-zA-Z0-9_\-./]+$/.test(value) && !value.includes("..") && !value.startsWith("/");
}

function requireOperator(c: any) {
  if (!operatorToken) return null;
  const auth = c.req.header("authorization") ?? "";
  if (auth !== `Bearer ${operatorToken}`) return c.json({ error: "unauthorized" }, 401);
  return null;
}

function safeWikiPath(...parts: string[]) {
  const root = resolve(join(vaultRoot, "wiki"));
  const full = resolve(join(root, ...parts));
  const rel = relative(root, full);
  if (rel.startsWith("..")) throw new Error("path escapes wiki root");
  return full;
}

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

async function writeTextAtomically(path: string, content: string) {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

async function listProjectFiles(projectId: string) {
  return listDir(safeWikiPath("projects", projectId));
}

app.get("/health", (c) => c.json({ ok: true, service: "memory-api" }));

app.post("/api/memory/context/load", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  const body = await c.req.json<ContextRequest>();
  if (!body.agent_id || !body.project_id || !body.budget_bytes) return c.json({ error: "agent_id, project_id, budget_bytes required" }, 400);
  if (!isSafeId(body.agent_id) || !isSafeId(body.project_id)) return c.json({ error: "unsafe id" }, 400);
  const result = await loadContextBundle(vaultRoot, body);
  return c.json(result);
});

app.post("/api/memory/tasks/close", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  const body = await c.req.json<CloseTaskRequest>();
  if (!body.agent_id || !body.project_id || !body.outcome || !body.summary) return c.json({ error: "agent_id, project_id, outcome, summary required" }, 400);
  if (!isSafeId(body.agent_id) || !isSafeId(body.project_id)) return c.json({ error: "unsafe id" }, 400);
  const result = await closeTask(vaultRoot, body);
  return c.json(result);
});

app.post("/api/memory/promote", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  const body = await c.req.json<PromoteLearningRequest>();
  if (!body.item_id || !body.target_path || !body.promotion_kind) return c.json({ error: "item_id, target_path, promotion_kind required" }, 400);
  if (!isSafeId(body.target_path)) return c.json({ error: "unsafe target_path" }, 400);
  const result = await promoteLearning(vaultRoot, body);
  return c.json(result);
});

app.post("/api/memory/bus/publish", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  const body = await c.req.json<PublishBusRequest>();
  if (!body.channel || !body.agent_id || !body.project_id || !body.title || !body.body) {
    return c.json({ error: "channel, agent_id, project_id, title, body required" }, 400);
  }
  if (!isSafeId(body.agent_id) || !isSafeId(body.project_id)) return c.json({ error: "unsafe id" }, 400);
  const busPath = safeWikiPath("projects", body.project_id, "bus.md");
  const existing = (await readText(busPath)) ?? "";
  const entry = `\n## ${new Date().toISOString()} [${body.channel}] ${body.title}\nAgent: ${body.agent_id}\nSeverity: ${body.severity ?? "n/a"}\nTags: ${(body.tags ?? []).join(", ")}\n\n${body.body}\n`;
  await writeTextAtomically(busPath, `${existing}${entry}`);
  return c.json({ ok: true, path: `wiki/projects/${body.project_id}/bus.md` }, 201);
});

app.get("/api/memory/agents/:id/summary", async (c) => {
  const agentId = c.req.param("id");
  if (!isSafeId(agentId)) return c.json({ error: "unsafe id" }, 400);
  const learned = await readText(safeWikiPath("agents", agentId, "learned.md"));
  const rewrites = await readText(safeWikiPath("agents", agentId, "rewrites.md"));
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
  if (!isSafeId(agentId)) return c.json({ error: "unsafe id" }, 400);
  const rewrites = await readText(safeWikiPath("agents", agentId, "rewrites.md"));
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
  if (!isSafeId(projectId)) return c.json({ error: "unsafe id" }, 400);
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
    const fullPath = safeWikiPath(...path.replace(/^wiki\//, "").split("/"));
    const content = await readText(fullPath);
    if (content && (!query || content.toLowerCase().includes(query) || path.toLowerCase().includes(query))) {
      results.push({ path, snippet: content.slice(0, 240) });
    }
  }
  return c.json({ query, results });
});

app.get("/api/memory/articles", async (c) => {
  const section = c.req.query("section");
  if (section && !isSafeId(section)) return c.json({ error: "unsafe section" }, 400);
  try {
    const base = section ? safeWikiPath(...section.split("/")) : safeWikiPath();
    const files = await listDir(base);
    return c.json({ section: section ?? "root", files });
  } catch (error) {
    return c.json({ error: String(error) }, 400);
  }
});

app.get("/api/memory/articles/:slug{.+}", async (c) => {
  const slug = c.req.param("slug");
  if (!isSafeId(slug)) return c.json({ error: "unsafe slug" }, 400);
  try {
    const fullPath = safeWikiPath(...slug.split("/"));
    const content = await readText(fullPath);
    if (!content) return c.json({ slug, content: "Not found" }, 404);
    return c.json({ slug, content });
  } catch (error) {
    return c.json({ error: String(error) }, 400);
  }
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 4301) });
console.log("memory-api listening on http://localhost:4301");
