import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { loadContextBundle, closeTask, promoteLearning } from "@agentic-harness/memory-runtime";
import type { CloseTaskRequest, ContextRequest, PromoteLearningRequest } from "@agentic-harness/shared-types";

const app = new Hono();
const vaultRoot = process.env.HARNESS_VAULT_ROOT ?? new URL("../../../vault/agentic-kb", import.meta.url).pathname;

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
app.get("/api/memory/projects/:id/summary", async (c) => c.json({
  project_id: c.req.param("id"),
  standards: [], active_rewrites: [], recent_postmortems: [], recipes: []
}));
app.get("/api/memory/search", async (c) => c.json({ query: c.req.query("q") ?? "", results: [] }));
app.get("/api/memory/articles/:slug", async (c) => c.json({ slug: c.req.param("slug"), content: "Not implemented yet" }));

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 4301) });
console.log("memory-api listening on http://localhost:4301");
