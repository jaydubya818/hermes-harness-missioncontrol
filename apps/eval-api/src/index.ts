import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { summarize, type EvalRecord } from "@hermes-harness-with-missioncontrol/eval-core";

const app = new Hono();
const records: EvalRecord[] = [];

app.get("/health", (c) => c.json({ ok: true, service: "eval-api" }));
app.get("/api/evals", (c) => c.json({ records, summary: summarize(records) }));
app.post("/api/evals", async (c) => {
  const body = await c.req.json<EvalRecord>();
  records.push(body);
  return c.json({ ok: true, summary: summarize(records) }, 201);
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 4303) });
console.log("eval-api listening on http://localhost:4303");
