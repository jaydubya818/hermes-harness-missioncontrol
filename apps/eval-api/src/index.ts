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

// The console talks to these APIs via the Vite dev proxy (same-origin), so
// cross-origin access is only needed when the console is pointed directly at
// an API URL. A wildcard here would let any web page a local browser visits
// call these endpoints; allow only the console dev origins unless overridden.
const corsOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
  .split(",").map((origin) => origin.trim()).filter(Boolean);
app.use("*", cors({ origin: corsOrigins }));

// Request bodies land in memory and, for artifacts and markdown writes, on
// disk. c.req.json() buffers whatever arrives, so a single oversized POST
// could balloon process memory (and the persisted state file) unchecked.
// Reject a body that declares more than the limit before any handler reads
// it. Set MAX_REQUEST_BODY_BYTES to 0 to disable. This trusts Content-Length:
// a chunked request that omits the header still reaches json(), so it bounds
// honest clients and accidents rather than a determined attacker that has
// already cleared the operator-token boundary.
const maxRequestBodyBytes = Number(process.env.MAX_REQUEST_BODY_BYTES ?? String(2 * 1024 * 1024));

app.use("*", async (c, next) => {
  if (Number.isFinite(maxRequestBodyBytes) && maxRequestBodyBytes > 0) {
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > maxRequestBodyBytes) {
      return c.json({ error: "request body too large" }, 413);
    }
  }
  await next();
});

// Cross-origin CSRF guard. Browsers send form and no-cors POSTs (text/plain,
// form-encoded, or no content-type at all) without a preflight, and
// c.req.json() parses whatever arrives regardless of content-type. With no
// HARNESS_OPERATOR_TOKEN configured -- the documented local default -- any
// page the operator happened to visit could therefore drive this control
// plane from their browser. application/json is not a CORS "simple" content
// type, so requiring it on state-changing requests forces a preflight, which
// the origin allowlist above governs.
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

app.use("*", async (c, next) => {
  if (MUTATING_METHODS.has(c.req.method)) {
    const mediaType = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (mediaType !== "application/json") {
      return c.json({ error: "content-type must be application/json" }, 415);
    }
  }
  await next();
});

const OPTIONAL_NUMERIC_FIELDS = ["approval_count", "artifact_count", "duration_ms", "confidence", "efficiency_score", "risk_score"] as const;

// confidence, efficiency_score and risk_score are 0-1 ratios in the ScoredEval
// contract, and summarize() averages them straight into average_confidence,
// average_efficiency and average_risk_score. The non-negative check above is
// not enough on its own: a record posted with confidence 500 was accepted and
// reported average_confidence 500, a number no scorer can produce (scoreRun
// clamps its own output and policy-engine clamps the worker's before it ever
// gets here). Bound the ratios at the route so the stored record cannot
// contradict the contract every consumer reads it through.
const RATIO_FIELDS = ["confidence", "efficiency_score", "risk_score"] as const;
const records: EvalRecord[] = [];
let initialized = false;

let hydration: Promise<void> | null = null;

async function ensureLoaded() {
  if (initialized) return;
  // Hydration is not reentrant: two concurrent first requests would both
  // splice the records array, and the second replay would drop any record
  // a POST appended in between. Run it once and share the in-flight
  // promise (same guard orchestrator-api uses).
  hydration ??= hydrateState().finally(() => {
    hydration = null;
  });
  await hydration;
}

async function hydrateState() {
  if (initialized) return;
  const loaded = await loadJsonFile<EvalRecord[]>(stateFile, []);
  // loadJsonFile only guards against unparseable JSON; a valid JSON value of
  // the wrong shape (e.g. an object) would crash .map on every request.
  if (!Array.isArray(loaded)) {
    console.warn(`eval-api: state file ${stateFile} is not an array; starting with empty records`);
    initialized = true;
    return;
  }
  // ensureLoaded() runs on every request, so one unusable entry (a null left
  // by a hand-edit, a value of the wrong shape from an older build) used to
  // throw here and turn every request into a 500 loop with no way back short
  // of editing the state file. Drop what cannot be rehydrated and keep the
  // rest, matching how orchestrator-api hydrates its own state.
  const usable: EvalRecord[] = [];
  for (const record of loaded) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      console.warn(`eval-api: skipping unusable persisted record in ${stateFile}`);
      continue;
    }
    usable.push({
      ...record,
      eval_id: record.eval_id ?? `eval_${randomUUID().replace(/-/g, "").slice(0, 12)}`
    });
  }
  records.splice(0, records.length, ...usable);
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
  for (const field of RATIO_FIELDS) {
    const value = (body as unknown as Record<string, unknown>)[field];
    if (typeof value === "number" && value > 1) {
      return c.json({ error: `${field} must be between 0 and 1` }, 400);
    }
  }
  // created_at is required by the EvalRecord contract and consumers sort and
  // display it; accept only parseable date strings and stamp receipt time
  // when the caller omits it.
  if (body.created_at !== undefined && (typeof body.created_at !== "string" || Number.isNaN(Date.parse(body.created_at)))) {
    return c.json({ error: "created_at must be a parseable date string when provided" }, 400);
  }
  if (body.eval_id) {
    // Replayed submissions (orchestrator retries, network replays) must not
    // duplicate records; mirror the artifact_id dedupe behaviour.
    const existing = records.find((item) => item.eval_id === body.eval_id);
    if (existing) return c.json({ ok: true, record: existing, summary: summarize(records) });
  }
  const record = {
    ...body,
    eval_id: body.eval_id ?? `eval_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    created_at: body.created_at ?? new Date().toISOString()
  } satisfies EvalRecord;
  records.push(record);
  await persist();
  return c.json({ ok: true, record, summary: summarize(records) }, 201);
});

if (!process.env.VITEST) {
  const port = Number(process.env.PORT ?? 4303);
  // @hono/node-server binds 0.0.0.0 when no hostname is given, silently
  // exposing this operator-trust API to the local network. Default to
  // loopback; set HOST explicitly to opt into wider exposure.
  const hostname = process.env.HOST ?? "127.0.0.1";
  serve({ fetch: app.fetch, port, hostname });
  console.log(`eval-api listening on http://${hostname}:${port}`);
}

export { app };
