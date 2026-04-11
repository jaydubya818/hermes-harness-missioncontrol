import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { attachArtifact, createWorkflowRun, getCurrentStep, startCurrentStep, advanceRun, type WorkflowRun } from "@hermes-harness-with-missioncontrol/workflow-engine";
import { evaluateStepPolicy } from "@hermes-harness-with-missioncontrol/policy-engine";
import { makeId, type HarnessEvent } from "@hermes-harness-with-missioncontrol/shared-types";

const app = new Hono();

type Mission = {
  mission_id: `mis_${string}`;
  title: string;
  project_id: `proj_${string}`;
  workflow_id: string;
  status: "pending" | "running" | "completed" | "failed" | "awaiting_approval";
  run_id?: `run_${string}`;
  approval_id?: `approval_${string}`;
};

type Approval = {
  approval_id: `approval_${string}`;
  mission_id: `mis_${string}`;
  run_id: `run_${string}`;
  step_id: string;
  status: "pending" | "approved" | "rejected";
  reason: string;
  created_at: string;
};

const missions: Mission[] = [];
const runs: WorkflowRun[] = [];
const approvals: Approval[] = [];
const events: HarnessEvent[] = [];
const audit: Array<Record<string, unknown>> = [];

function recordEvent(event: HarnessEvent) {
  events.unshift(event);
  audit.unshift({ ...event, audit_id: makeId("audit") });
  if (events.length > 200) events.length = 200;
  if (audit.length > 500) audit.length = 500;
}

async function recordEval(run: WorkflowRun, approvalCount: number) {
  try {
    await fetch("http://localhost:4303/api/evals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mission_id: run.mission_id,
        run_id: run.run_id,
        outcome: run.status === "completed" ? "success" : run.status === "failed" ? "failure" : "partial",
        cost_usd: run.steps.length * 0.12,
        approval_count: approvalCount,
        artifact_count: run.steps.reduce((sum, step) => sum + step.artifacts.length, 0),
        created_at: new Date().toISOString()
      })
    });
  } catch {
    // eval api is optional at runtime
  }
}

app.get("/health", (c) => c.json({ ok: true, service: "orchestrator-api" }));
app.get("/api/missions", (c) => c.json({ missions }));
app.get("/api/runs", (c) => c.json({ runs }));
app.get("/api/approvals", (c) => c.json({ approvals }));
app.get("/api/events", (c) => c.json({ events }));
app.get("/api/audit", (c) => c.json({ audit }));

app.post("/api/missions", async (c) => {
  const body = await c.req.json<{ title: string; project_id: `proj_${string}`; workflow_id?: string }>();
  const mission: Mission = {
    mission_id: makeId("mis") as `mis_${string}`,
    title: body.title,
    project_id: body.project_id,
    workflow_id: body.workflow_id ?? "bugfix",
    status: "pending"
  };
  missions.push(mission);
  recordEvent({ type: "mission.created", ts: new Date().toISOString(), project_id: mission.project_id, mission_id: mission.mission_id, payload: mission });
  return c.json(mission, 201);
});

app.post("/api/missions/:id/start", async (c) => {
  const mission = missions.find((item) => item.mission_id === c.req.param("id"));
  if (!mission) return c.json({ error: "mission not found" }, 404);
  const run = createWorkflowRun(makeId("run") as `run_${string}`, mission.mission_id, mission.workflow_id);
  startCurrentStep(run);
  mission.run_id = run.run_id;
  mission.status = run.status;
  runs.push(run);
  recordEvent({ type: "run.started", ts: new Date().toISOString(), project_id: mission.project_id, mission_id: mission.mission_id, run_id: run.run_id, payload: run as any });
  recordEvent({ type: "step.started", ts: new Date().toISOString(), project_id: mission.project_id, mission_id: mission.mission_id, run_id: run.run_id, step_id: getCurrentStep(run)?.id as `step_${string}` | undefined, payload: (getCurrentStep(run) ?? {}) as any });
  return c.json(run, 201);
});

app.post("/api/runs/:id/artifacts", async (c) => {
  const run = runs.find((item) => item.run_id === c.req.param("id"));
  if (!run) return c.json({ error: "run not found" }, 404);
  const body = await c.req.json<{ step_id: string; type: string; content?: string; uri?: string }>();
  const artifact = { artifact_id: makeId("art"), type: body.type, uri: body.uri ?? `artifact://${run.run_id}/${body.step_id}/${body.type}`, content: body.content };
  attachArtifact(run, body.step_id, artifact);
  return c.json(artifact, 201);
});

app.post("/api/runs/:id/steps/:stepId/complete", async (c) => {
  const run = runs.find((item) => item.run_id === c.req.param("id"));
  if (!run) return c.json({ error: "run not found" }, 404);
  const step = run.steps.find((item) => item.id === c.req.param("stepId"));
  if (!step) return c.json({ error: "step not found" }, 404);
  const policy = evaluateStepPolicy({ kind: step.kind, risk: step.risk, artifactCount: step.artifacts.length });
  if (!policy.allowed) {
    advanceRun(run, "failed", policy.reason);
    recordEvent({ type: "step.failed", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: step.id as `step_${string}`, payload: { policy } });
    await recordEval(run, approvals.filter((item) => item.run_id === run.run_id).length);
    return c.json({ run, policy }, 400);
  }
  if (policy.requires_approval) {
    const approval: Approval = {
      approval_id: makeId("approval") as `approval_${string}`,
      mission_id: run.mission_id,
      run_id: run.run_id,
      step_id: step.id,
      status: "pending",
      reason: policy.reason,
      created_at: new Date().toISOString()
    };
    approvals.unshift(approval);
    advanceRun(run, "awaiting_approval", policy.reason);
    const mission = missions.find((item) => item.mission_id === run.mission_id);
    if (mission) {
      mission.status = "awaiting_approval";
      mission.approval_id = approval.approval_id;
    }
    recordEvent({ type: "step.completed", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: step.id as `step_${string}`, payload: { policy, awaiting_approval: true } });
    return c.json({ run, approval, policy });
  }
  advanceRun(run, "completed", "step completed");
  const mission = missions.find((item) => item.mission_id === run.mission_id);
  if (mission) mission.status = run.status;
  recordEvent({ type: "step.completed", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: step.id as `step_${string}`, payload: { policy } });
  const next = getCurrentStep(run);
  if (next && run.status !== "completed") {
    startCurrentStep(run);
    recordEvent({ type: "step.started", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: next.id as `step_${string}`, payload: next as any });
  } else {
    await recordEval(run, approvals.filter((item) => item.run_id === run.run_id && item.status === "approved").length);
  }
  return c.json({ run, policy });
});

app.post("/api/approvals/:id/respond", async (c) => {
  const approval = approvals.find((item) => item.approval_id === c.req.param("id"));
  if (!approval) return c.json({ error: "approval not found" }, 404);
  const body = await c.req.json<{ decision: "approved" | "rejected" }>();
  approval.status = body.decision;
  const run = runs.find((item) => item.run_id === approval.run_id);
  const mission = missions.find((item) => item.mission_id === approval.mission_id);
  if (!run || !mission) return c.json({ error: "run/mission missing" }, 404);
  if (body.decision === "rejected") {
    run.status = "failed";
    mission.status = "failed";
    recordEvent({ type: "approval.rejected", ts: new Date().toISOString(), mission_id: mission.mission_id, run_id: run.run_id, step_id: approval.step_id as `step_${string}`, payload: approval });
    await recordEval(run, approvals.filter((item) => item.run_id === run.run_id && item.status === "approved").length);
    return c.json({ approval, run });
  }
  recordEvent({ type: "approval.granted", ts: new Date().toISOString(), mission_id: mission.mission_id, run_id: run.run_id, step_id: approval.step_id as `step_${string}`, payload: approval });
  advanceRun(run, "completed", "approved");
  mission.status = run.status;
  const next = getCurrentStep(run);
  if (next && run.status !== "completed") {
    startCurrentStep(run);
    recordEvent({ type: "step.started", ts: new Date().toISOString(), mission_id: mission.mission_id, run_id: run.run_id, step_id: next.id as `step_${string}`, payload: next as any });
  } else {
    await recordEval(run, approvals.filter((item) => item.run_id === run.run_id && item.status === "approved").length);
  }
  return c.json({ approval, run });
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 4302) });
console.log("orchestrator-api listening on http://localhost:4302");
