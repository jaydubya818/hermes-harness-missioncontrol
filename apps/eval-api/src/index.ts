import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { summarize, type EvalRecord } from "@hermes-harness-with-missioncontrol/eval-core";
import { loadJsonFile, saveJsonFile } from "@hermes-harness-with-missioncontrol/state-store";

const app = new Hono();
const stateFile = process.env.EVAL_STATE_FILE ?? resolve(process.cwd(), "../../data/eval-state.json");
const operatorToken = process.env.HARNESS_OPERATOR_TOKEN;

app.use("*", cors());
const OPTIONAL_NUMERIC_FIELDS = ["approval_count", "artifact_count", "duration_ms", "confidence", "efficiency_score", "risk_score"] as const;
const records: EvalRecord[] = [];
let initialized = false;

async function ensureLoaded() {
  if (initialized) return;
  const loaded = await loadJsonFile<EvalRecord[]>(stateFile, []);
  // loadJsonFile only guards against unparseable JSON; a valid JSON value of
  // the wrong shape (e.g. an object) would crash .map on every request.
  if (!Array.isArray(loaded)) {
    console.warn(`eval-api: state file ${stateFile} is not an array; starting with empty records`);
    initialized = true;
    return;
  }
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
  const auth = Buffer.from(c.req.header("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${operatorToken}`);
  if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return c.json({ error: "unauthorized" }, 401);
  return null;
}

async function parseJsonBody<T>(c: any): Promise<T | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" ? (body as T) : null;
  } catch {
    return null;
  }
}

function normalizeLimit(value?: string) {
  const parsed = Number.parseInt(value ?? "50", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : 50;
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
  const authError = requireOperator(c);
  if (authError) return authError;
  await ensureLoaded();
  const query = c.req.query();
  const filtered = filterRecords(query);
  // Records accumulate in submission order (oldest first). order=desc lets
  // consumers page from the most recent runs without knowing the total.
  const ordered = query.order === "desc" ? [...filtered].reverse() : filtered;
  const limit = normalizeLimit(query.limit);
  const offset = normalizeOffset(query.offset);
  const page = ordered.slice(offset, offset + limit);
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
  const authError = requireOperator(c);
  if (authError) return authError;
  await ensureLoaded();
  const record = records.find((item) => item.eval_id === c.req.param("id"));
  if (!record) return c.json({ error: "eval not found" }, 404);
  return c.json({ record });
});

app.post("/api/evals", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  await ensureLoaded();
  const body = await parseJsonBody<EvalRecord>(c);
  if (!body) return c.json({ error: "invalid JSON body" }, 400);
  if (typeof body.mission_id !== "string" || !body.mission_id || typeof body.run_id !== "string" || !body.run_id) {
    return c.json({ error: "mission_id and run_id required" }, 400);
  }
  // A non-string eval_id would create a record that GET /api/evals/:id can
  // never address (route params are strings) and break replay dedupe.
  if (body.eval_id !== undefined && (typeof body.eval_id !== "string" || !body.eval_id)) {
    return c.json({ error: "eval_id must be a non-empty string when provided" }, 400);
  }
  if (!["success", "failure", "partial"].includes(body.outcome)) return c.json({ error: "outcome must be one of success, failure, partial" }, 400);
  if (typeof body.cost_usd !== "number" || !Number.isFinite(body.cost_usd) || body.cost_usd < 0) return c.json({ error: "cost_usd must be a non-negative number" }, 400);
  // Scoring fields feed summary averages; a single string or negative value
  // here would turn average_confidence & co into NaN (serialized as null).
  for (const field of OPTIONAL_NUMERIC_FIELDS) {
    const value = (body as unknown as Record<string, unknown>)[field];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      return c.json({ error: `${field} must be a non-negative finite number` }, 400);
    }
  }
  if (body.eval_id) {
    // Replayed submissions (orchestrator retries, network replays) must not
    // duplicate records; mirror the artifact_id dedupe behaviour.
    const existing = records.find((item) => item.eval_id === body.eval_id);
    if (existing) return c.json({ ok: true, record: existing, summary: summarize(records) });
  }
  const record = {
    ...body,
    eval_id: body.eval_id ?? `eval_${randomUUID().replace(/-/g, "").slice(0, 12)}`
  } satisfies EvalRecord;
  records.push(record);
  await persist();
  return c.json({ ok: true, record, summary: summarize(records) }, 201);
});

if (!process.env.VITEST) {
  const port = Number(process.env.PORT ?? 4303);
  serve({ fetch: app.fetch, port });
  console.log(`eval-api listening on http://localhost:${port}`);
}

export { app };
