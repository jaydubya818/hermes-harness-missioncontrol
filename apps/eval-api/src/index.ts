import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { summarize, type EvalRecord } from "@hermes-harness-with-missioncontrol/eval-core";
import { loadJsonFile, saveJsonFile } from "@hermes-harness-with-missioncontrol/state-store";

const app = new Hono();
const stateFile = process.env.EVAL_STATE_FILE ?? resolve(process.cwd(), "../../data/eval-state.json");
const operatorToken = process.env.HARNESS_OPERATOR_TOKEN;

app.use("*", cors());
const records: EvalRecord[] = [];
let initialized = false;

async function ensureLoaded() {
  if (initialized) return;
  const loaded = await loadJsonFile<EvalRecord[]>(stateFile, []);
  records.splice(0, records.length, ...loaded.map((record) => ({
    ...record,
    eval_id: record.eval_id ?? `eval_${randomUUID().replace(/-/g, "").slice(0, 12)}`
  })));
  initialized = true;
}

async function persist() {
  await saveJsonFile(stateFile, records);
}

function requireOperator(c: any) {
  if (!operatorToken) return null;
  const auth = c.req.header("authorization") ?? "";
  if (auth !== `Bearer ${operatorToken}`) return c.json({ error: "unauthorized" }, 401);
  return null;
}

function normalizeLimit(value?: string) {
  const parsed = Number.parseInt(value ?? "50", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
}

function normalizeOffset(value?: string) {
  const parsed = Number.parseInt(value ?? "0", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function filterRecords(query: Record<string, string | undefined>) {
  return records.filter((record) => {
    if (query.mission_id && record.mission_id !== query.mission_id) return false;
    if (query.run_id && record.run_id !== query.run_id) return false;
    if (query.outcome && record.outcome !== query.outcome) return false;
    return true;
  });
}

app.get("/health", async (c) => {
  await ensureLoaded();
  return c.json({ ok: true, service: "eval-api", persisted_records: records.length });
});

app.get("/api/evals", async (c) => {
  await ensureLoaded();
  const query = c.req.query();
  const filtered = filterRecords(query);
  const limit = normalizeLimit(query.limit);
  const offset = normalizeOffset(query.offset);
  const page = filtered.slice(offset, offset + limit);
  return c.json({
    records: page,
    pagination: {
      total: filtered.length,
      limit,
      offset,
      has_more: offset + limit < filtered.length,
    },
    summary: summarize(filtered)
  });
});

app.get("/api/evals/:id", async (c) => {
  await ensureLoaded();
  const record = records.find((item) => item.eval_id === c.req.param("id"));
  if (!record) return c.json({ error: "eval not found" }, 404);
  return c.json({ record });
});

app.post("/api/evals", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  await ensureLoaded();
  const body = await c.req.json<EvalRecord>();
  const record = {
    ...body,
    eval_id: body.eval_id ?? `eval_${randomUUID().replace(/-/g, "").slice(0, 12)}`
  } satisfies EvalRecord;
  records.push(record);
  await persist();
  return c.json({ ok: true, record, summary: summarize(records) }, 201);
});

if (!process.env.VITEST) {
  serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 4303) });
  console.log("eval-api listening on http://localhost:4303");
}

export { app };
