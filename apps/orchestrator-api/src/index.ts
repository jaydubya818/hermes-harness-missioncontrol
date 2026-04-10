import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { makeId, type HarnessEvent } from "@agentic-harness/shared-types";

const app = new Hono();
const missions: Array<Record<string, unknown>> = [];
const events: HarnessEvent[] = [];

app.get("/health", (c) => c.json({ ok: true, service: "orchestrator-api" }));
app.get("/api/missions", (c) => c.json({ missions }));
app.post("/api/missions", async (c) => {
  const body = await c.req.json<{ title: string; project_id: string }>();
  const mission = { mission_id: makeId("mis"), title: body.title, project_id: body.project_id, status: "pending" };
  missions.push(mission);
  events.push({ type: "mission.created", ts: new Date().toISOString(), project_id: body.project_id as `proj_${string}`, mission_id: mission.mission_id as `mis_${string}`, payload: mission });
  return c.json(mission, 201);
});
app.get("/api/events", (c) => c.json({ events }));

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 4302) });
console.log("orchestrator-api listening on http://localhost:4302");
