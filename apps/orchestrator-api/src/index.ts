import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { resolve } from "node:path";
import { attachArtifact, createWorkflowRun, getCurrentStep, startCurrentStep, advanceRun, type WorkflowRun } from "@hermes-harness-with-missioncontrol/workflow-engine";
import { evaluateStepPolicy } from "@hermes-harness-with-missioncontrol/policy-engine";
import { loadJsonFile, saveJsonFile } from "@hermes-harness-with-missioncontrol/state-store";
import { makeId, type HarnessEvent } from "@hermes-harness-with-missioncontrol/shared-types";

const app = new Hono();
const stateFile = process.env.ORCHESTRATOR_STATE_FILE ?? resolve(process.cwd(), "../../data/orchestrator-state.json");
const memoryApi = process.env.MEMORY_API_URL ?? "http://localhost:4301";
const evalApi = process.env.EVAL_API_URL ?? "http://localhost:4303";

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

type OrchestratorState = {
  missions: Mission[];
  runs: WorkflowRun[];
  approvals: Approval[];
  events: HarnessEvent[];
  audit: Array<Record<string, unknown>>;
};

const state: OrchestratorState = { missions: [], runs: [], approvals: [], events: [], audit: [] };
let initialized = false;

async function ensureLoaded() {
  if (initialized) return;
  const loaded = await loadJsonFile<OrchestratorState>(stateFile, state);
  state.missions.splice(0, state.missions.length, ...(loaded.missions ?? []));
  state.runs.splice(0, state.runs.length, ...(loaded.runs ?? []));
  state.approvals.splice(0, state.approvals.length, ...(loaded.approvals ?? []));
  state.events.splice(0, state.events.length, ...(loaded.events ?? []));
  state.audit.splice(0, state.audit.length, ...(loaded.audit ?? []));
  initialized = true;
}

async function persist() {
  await saveJsonFile(stateFile, state);
}

function recordEvent(event: HarnessEvent) {
  state.events.unshift(event);
  state.audit.unshift({ ...event, audit_id: makeId("audit") });
  if (state.events.length > 200) state.events.length = 200;
  if (state.audit.length > 500) state.audit.length = 500;
}

async function recordEval(run: WorkflowRun, approvalCount: number) {
  try {
    await fetch(`${evalApi}/api/evals`, {
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
    // optional runtime dependency
  }
}

async function writebackStep(run: WorkflowRun, stepId: string, outcome: "success" | "failure" | "partial", summary: string) {
  const current = run.steps.find((step) => step.id === stepId);
  try {
    await fetch(`${memoryApi}/api/memory/tasks/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent_id: "agent_demo",
        project_id: "proj_demo",
        mission_id: run.mission_id,
        run_id: run.run_id,
        step_id: stepId,
        outcome,
        summary,
        gotchas: outcome === "failure" ? [{ title: `${stepId} failed`, body: summary }] : [{ title: `${stepId} completed`, body: summary }],
        artifacts: (current?.artifacts ?? []).map((artifact) => ({ type: artifact.type, uri: artifact.uri }))
      })
    });
  } catch {
    // optional runtime dependency
  }
}

app.get("/health", async (c) => {
  await ensureLoaded();
  return c.json({ ok: true, service: "orchestrator-api", persisted_missions: state.missions.length });
});

app.get("/api/missions", async (c) => { await ensureLoaded(); return c.json({ missions: state.missions }); });
app.get("/api/runs", async (c) => { await ensureLoaded(); return c.json({ runs: state.runs }); });
app.get("/api/approvals", async (c) => { await ensureLoaded(); return c.json({ approvals: state.approvals }); });
app.get("/api/events", async (c) => { await ensureLoaded(); return c.json({ events: state.events }); });
app.get("/api/audit", async (c) => { await ensureLoaded(); return c.json({ audit: state.audit }); });

app.post("/api/missions", async (c) => {
  await ensureLoaded();
  const body = await c.req.json<{ title: string; project_id: `proj_${string}`; workflow_id?: string }>();
  const mission: Mission = { mission_id: makeId("mis") as `mis_${string}`, title: body.title, project_id: body.project_id, workflow_id: body.workflow_id ?? "bugfix", status: "pending" };
  state.missions.push(mission);
  recordEvent({ type: "mission.created", ts: new Date().toISOString(), project_id: mission.project_id, mission_id: mission.mission_id, payload: mission as any });
  await persist();
  return c.json(mission, 201);
});

app.post("/api/missions/:id/start", async (c) => {
  await ensureLoaded();
  const mission = state.missions.find((item) => item.mission_id === c.req.param("id"));
  if (!mission) return c.json({ error: "mission not found" }, 404);
  const run = createWorkflowRun(makeId("run") as `run_${string}`, mission.mission_id, mission.workflow_id);
  startCurrentStep(run);
  mission.run_id = run.run_id;
  mission.status = run.status;
  state.runs.push(run);
  recordEvent({ type: "run.started", ts: new Date().toISOString(), project_id: mission.project_id, mission_id: mission.mission_id, run_id: run.run_id, payload: run as any });
  recordEvent({ type: "step.started", ts: new Date().toISOString(), project_id: mission.project_id, mission_id: mission.mission_id, run_id: run.run_id, step_id: getCurrentStep(run)?.id as `step_${string}` | undefined, payload: (getCurrentStep(run) ?? {}) as any });
  await persist();
  return c.json(run, 201);
});

app.post("/api/runs/:id/artifacts", async (c) => {
  await ensureLoaded();
  const run = state.runs.find((item) => item.run_id === c.req.param("id"));
  if (!run) return c.json({ error: "run not found" }, 404);
  const body = await c.req.json<{ step_id: string; type: string; content?: string; uri?: string }>();
  const artifact = { artifact_id: makeId("art"), type: body.type, uri: body.uri ?? `artifact://${run.run_id}/${body.step_id}/${body.type}`, content: body.content };
  attachArtifact(run, body.step_id, artifact);
  await persist();
  return c.json(artifact, 201);
});

app.post("/api/runs/:id/steps/:stepId/complete", async (c) => {
  await ensureLoaded();
  const run = state.runs.find((item) => item.run_id === c.req.param("id"));
  if (!run) return c.json({ error: "run not found" }, 404);
  const step = run.steps.find((item) => item.id === c.req.param("stepId"));
  if (!step) return c.json({ error: "step not found" }, 404);
  const policy = evaluateStepPolicy({ kind: step.kind, risk: step.risk, artifactCount: step.artifacts.length });
  if (!policy.allowed) {
    advanceRun(run, "failed", policy.reason);
    await writebackStep(run, step.id, "failure", policy.reason);
    recordEvent({ type: "step.failed", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: step.id as `step_${string}`, payload: { policy } as any });
    await recordEval(run, state.approvals.filter((item) => item.run_id === run.run_id).length);
    await persist();
    return c.json({ run, policy }, 400);
  }
  if (policy.requires_approval) {
    const approval: Approval = { approval_id: makeId("approval") as `approval_${string}`, mission_id: run.mission_id, run_id: run.run_id, step_id: step.id, status: "pending", reason: policy.reason, created_at: new Date().toISOString() };
    state.approvals.unshift(approval);
    advanceRun(run, "awaiting_approval", policy.reason);
    const mission = state.missions.find((item) => item.mission_id === run.mission_id);
    if (mission) { mission.status = "awaiting_approval"; mission.approval_id = approval.approval_id; }
    recordEvent({ type: "step.completed", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: step.id as `step_${string}`, payload: { policy, awaiting_approval: true } as any });
    await persist();
    return c.json({ run, approval, policy });
  }
  advanceRun(run, "completed", "step completed");
  await writebackStep(run, step.id, "success", `Step ${step.id} completed successfully`);
  const mission = state.missions.find((item) => item.mission_id === run.mission_id);
  if (mission) mission.status = run.status;
  recordEvent({ type: "step.completed", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: step.id as `step_${string}`, payload: { policy } as any });
  const next = getCurrentStep(run);
  if (next && run.status !== "completed") {
    startCurrentStep(run);
    recordEvent({ type: "step.started", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: next.id as `step_${string}`, payload: next as any });
  } else {
    await recordEval(run, state.approvals.filter((item) => item.run_id === run.run_id && item.status === "approved").length);
  }
  await persist();
  return c.json({ run, policy });
});

app.post("/api/approvals/:id/respond", async (c) => {
  await ensureLoaded();
  const approval = state.approvals.find((item) => item.approval_id === c.req.param("id"));
  if (!approval) return c.json({ error: "approval not found" }, 404);
  const body = await c.req.json<{ decision: "approved" | "rejected" }>();
  approval.status = body.decision;
  const run = state.runs.find((item) => item.run_id === approval.run_id);
  const mission = state.missions.find((item) => item.mission_id === approval.mission_id);
  if (!run || !mission) return c.json({ error: "run/mission missing" }, 404);
  if (body.decision === "rejected") {
    run.status = "failed";
    mission.status = "failed";
    await writebackStep(run, approval.step_id, "failure", `Approval rejected for ${approval.step_id}`);
    recordEvent({ type: "approval.rejected", ts: new Date().toISOString(), mission_id: mission.mission_id, run_id: run.run_id, step_id: approval.step_id as `step_${string}`, payload: approval as any });
    await recordEval(run, state.approvals.filter((item) => item.run_id === run.run_id && item.status === "approved").length);
    await persist();
    return c.json({ approval, run });
  }
  recordEvent({ type: "approval.granted", ts: new Date().toISOString(), mission_id: mission.mission_id, run_id: run.run_id, step_id: approval.step_id as `step_${string}`, payload: approval as any });
  advanceRun(run, "completed", "approved");
  await writebackStep(run, approval.step_id, "success", `Approval granted for ${approval.step_id}`);
  mission.status = run.status;
  const next = getCurrentStep(run);
  if (next && run.status !== "completed") {
    startCurrentStep(run);
    recordEvent({ type: "step.started", ts: new Date().toISOString(), mission_id: mission.mission_id, run_id: run.run_id, step_id: next.id as `step_${string}`, payload: next as any });
  } else {
    await recordEval(run, state.approvals.filter((item) => item.run_id === run.run_id && item.status === "approved").length);
  }
  await persist();
  return c.json({ approval, run });
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 4302) });
console.log("orchestrator-api listening on http://localhost:4302");
