import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { resolve } from "node:path";
import { summarize, type EvalRecord } from "@hermes-harness-with-missioncontrol/eval-core";
import { loadJsonFile, saveJsonFile } from "@hermes-harness-with-missioncontrol/state-store";

const app = new Hono();
const stateFile = process.env.EVAL_STATE_FILE ?? resolve(process.cwd(), "../../data/eval-state.json");
const records: EvalRecord[] = [];
let initialized = false;

async function ensureLoaded() {
  if (initialized) return;
  const loaded = await loadJsonFile<EvalRecord[]>(stateFile, []);
  records.splice(0, records.length, ...loaded);
  initialized = true;
}

async function persist() {
  await saveJsonFile(stateFile, records);
}

app.get("/health", async (c) => {
  await ensureLoaded();
  return c.json({ ok: true, service: "eval-api", persisted_records: records.length });
});
app.get("/api/evals", async (c) => {
  await ensureLoaded();
  return c.json({ records, summary: summarize(records) });
});
app.post("/api/evals", async (c) => {
  await ensureLoaded();
  const body = await c.req.json<EvalRecord>();
  records.push(body);
  await persist();
  return c.json({ ok: true, summary: summarize(records) }, 201);
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 4303) });
console.log("eval-api listening on http://localhost:4303");
