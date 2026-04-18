import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { resolve } from "node:path";
import { attachArtifact, createWorkflowRun, getCurrentStep, startCurrentStep, advanceRun, markCurrentStepAwaitingApproval, markCurrentStepCompleted, markCurrentStepFailed, type WorkflowArtifact, type WorkflowRun } from "@hermes-harness-with-missioncontrol/workflow-engine";
import { evaluateStepPolicy } from "@hermes-harness-with-missioncontrol/policy-engine";
import { loadJsonFile, saveJsonFile } from "@hermes-harness-with-missioncontrol/state-store";
import { makeId, type HarnessEvent } from "@hermes-harness-with-missioncontrol/shared-types";
import { scoreRun } from "@hermes-harness-with-missioncontrol/eval-core";
import { FinalOutcome, StepKind, type ArtifactRef, type TaskExecutionResult } from "@hermes-harness-with-missioncontrol/contracts";

const app = new Hono();
const stateFile = process.env.ORCHESTRATOR_STATE_FILE ?? resolve(process.cwd(), "../../data/orchestrator-state.json");
const memoryApi = process.env.MEMORY_API_URL ?? "http://localhost:4301";
const evalApi = process.env.EVAL_API_URL ?? "http://localhost:4303";
const workerApi = process.env.WORKER_API_URL ?? "http://localhost:4304";
const operatorToken = process.env.HARNESS_OPERATOR_TOKEN;

type Mission = {
  mission_id: `mis_${string}`;
  title: string;
  objective?: string;
  project_id: `proj_${string}`;
  workflow: string;
  policy_ref?: string;
  profile_ref?: string;
  repo_path?: string;
  workspace_root?: string;
  status: "pending" | "running" | "awaiting_approval" | "paused" | "completed" | "failed" | "cancelled";
  active_run_id?: string;
  summary?: string;
  created_at: string;
  updated_at: string;
};

type Approval = {
  approval_id: `approval_${string}`;
  mission_id: string;
  run_id: string;
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

type WorkerArtifact = {
  artifact_id?: string;
  type: string;
  uri: string;
  content?: string;
  metadata?: Record<string, unknown>;
};

type WorkerExecution = {
  execution_id?: string;
  summary: string;
  confidence: number;
  success: boolean;
  artifacts: WorkerArtifact[];
  step_events?: Array<Record<string, unknown>>;
  sourceRepo?: string;
  branchName?: string;
  source_repo?: string;
  branch_name?: string;
};

function toArtifactRef(artifact: WorkerArtifact): ArtifactRef {
  return {
    artifact_id: artifact.artifact_id ?? makeId("art"),
    kind: artifact.type,
    uri: artifact.uri,
    label: artifact.type,
    metadata: artifact.metadata,
  };
}

function toTaskExecutionResult(run: WorkflowRun, stepId: string, execution: WorkerExecution, approvalNeeded = false): TaskExecutionResult {
  const changedFiles = execution.artifacts
    .flatMap((artifact) => Array.isArray(artifact.metadata?.changed_files) ? artifact.metadata.changed_files : [])
    .filter((value): value is string => typeof value === "string");

  return {
    execution_id: execution.execution_id ?? makeId("exec"),
    mission_id: run.mission_id,
    run_id: run.run_id,
    step_id: stepId,
    final_outcome: execution.success ? FinalOutcome.Success : FinalOutcome.Failed,
    summary: execution.summary,
    artifacts: execution.artifacts.map(toArtifactRef),
    changed_files: changedFiles,
    issues: execution.success ? [] : [execution.summary],
    approval_needed: approvalNeeded,
    recommended_next_step: approvalNeeded ? undefined : StepKind.Test,
    confidence: execution.confidence,
  };
}

const state: OrchestratorState = { missions: [], runs: [], approvals: [], events: [], audit: [] };
let initialized = false;

function authHeaders() {
  return {
    "content-type": "application/json",
    ...(operatorToken ? { authorization: `Bearer ${operatorToken}` } : {})
  };
}

function requireOperator(c: any) {
  if (!operatorToken) return null;
  const auth = c.req.header("authorization") ?? "";
  if (auth !== `Bearer ${operatorToken}`) return c.json({ error: "unauthorized" }, 401);
  return null;
}

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

function recordEvent(event: HarnessEvent | Record<string, unknown>) {
  state.events.unshift(event as any);
  state.audit.unshift({ ...event, audit_id: makeId("audit") });
  if (state.events.length > 200) state.events.length = 200;
  if (state.audit.length > 500) state.audit.length = 500;
}

function getMissionForRun(run: WorkflowRun) {
  return state.missions.find((item) => item.mission_id === run.mission_id);
}

function getStepArtifact(run: WorkflowRun, stepId: string, type: string): WorkflowArtifact | undefined {
  return run.steps.find((step) => step.step_id === stepId)?.artifacts.find((artifact) => (artifact.type ?? artifact.kind) === type);
}

async function recordEval(run: WorkflowRun, approvals: typeof state.approvals): Promise<void> {
  try {
    const scored = scoreRun({ run, approvals });
    await fetch(`${evalApi}/api/evals`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        mission_id:       run.mission_id,
        run_id:           run.run_id,
        outcome:          scored.outcome,
        cost_usd:         scored.cost_usd,
        approval_count:   scored.approval_count,
        artifact_count:   scored.artifact_count,
        duration_ms:      scored.duration_ms,
        confidence:       scored.confidence,
        efficiency_score: scored.efficiency_score,
        risk_score:       scored.risk_score,
        created_at:       new Date().toISOString(),
      }),
    });
  } catch (err) {
    console.error("[orchestrator] recordEval failed (eval-api unavailable):", err instanceof Error ? err.message : err);
  }
}

async function writebackStep(run: WorkflowRun, stepId: string, outcome: "success" | "failure" | "partial", summary: string) {
  const current = run.steps.find((step) => step.step_id === stepId);
  try {
    await fetch(`${memoryApi}/api/memory/tasks/close`, {
      method: "POST",
      headers: authHeaders(),
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
  } catch (err) {
    console.error("[orchestrator] writebackStep failed (memory-api unavailable):", err instanceof Error ? err.message : err);
  }
}

async function publishDiscovery(run: WorkflowRun, stepId: string, title: string, body: string) {
  try {
    await fetch(`${memoryApi}/api/memory/bus/publish`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        channel: "discovery",
        agent_id: "agent_demo",
        project_id: "proj_demo",
        mission_id: run.mission_id,
        run_id: run.run_id,
        title,
        body,
        severity: "medium",
        tags: [stepId, "automation"]
      })
    });
  } catch (err) {
    console.error("[orchestrator] publishDiscovery failed (memory-api unavailable):", err instanceof Error ? err.message : err);
  }
}

async function cleanupExecutionWorkspace(run: WorkflowRun, mission?: Mission, execution?: WorkerExecution | null) {
  const sourceRepo = execution?.sourceRepo ?? execution?.source_repo ?? mission?.repo_path;
  const branchName = execution?.branchName ?? execution?.branch_name ?? `hermes/${run.run_id}`;
  try {
    await fetch(`${workerApi}/api/cleanup-run`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ run_id: run.run_id, source_repo: sourceRepo, branch_name: branchName })
    });
  } catch (err) {
    console.error("[orchestrator] cleanupExecutionWorkspace failed (worker-api unavailable):", err instanceof Error ? err.message : err);
  }
}

async function failRun(run: WorkflowRun, stepId: string, summary: string, execution?: WorkerExecution | null) {
  const mission = getMissionForRun(run);
  markCurrentStepFailed(run, summary);
  await writebackStep(run, stepId, "failure", summary);
  if (mission) {
    mission.status = "failed";
    mission.summary = summary;
  }
  recordEvent({ type: "step.failed", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: stepId as `step_${string}`, payload: { summary, execution } as any });
  await recordEval(run, state.approvals.filter((item) => item.run_id === run.run_id));
  await cleanupExecutionWorkspace(run, mission, execution ?? null);
  await persist();
}

async function fetchWorkerExecution(run: WorkflowRun, stepId: string, stepKind: string, repoPath?: string): Promise<WorkerExecution> {
  const executionId = makeId("exec");
  const response = await fetch(`${workerApi}/api/execute-step`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ mission_id: run.mission_id, execution_id: executionId, run_id: run.run_id, step_id: stepId, kind: stepKind, repo_path: repoPath, branch_name: `hermes/${run.run_id}` })
  });
  const payload = await response.json() as WorkerExecution & { error?: string };
  if (!response.ok) {
    throw new Error(payload.summary || payload.error || `worker execution failed with status ${response.status}`);
  }
  payload.execution_id ??= executionId;
  return payload;
}

app.use("*", cors());

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
  const authError = requireOperator(c);
  if (authError) return authError;
  await ensureLoaded();
  const body = await c.req.json<{ title: string; objective?: string; project_id: `proj_${string}`; workflow_id?: string; repo_path?: string; policy_ref?: string; profile_ref?: string; workspace_root?: string }>();
  const now = new Date().toISOString();
  const mission: Mission = {
    mission_id: makeId("mis") as `mis_${string}`,
    title: body.title,
    objective: body.objective ?? body.title,
    project_id: body.project_id,
    workflow: body.workflow_id ?? "bugfix",
    policy_ref: body.policy_ref,
    profile_ref: body.profile_ref,
    repo_path: body.repo_path,
    workspace_root: body.workspace_root,
    status: "pending",
    created_at: now,
    updated_at: now
  };
  state.missions.push(mission);
  recordEvent({ type: "mission.created", ts: new Date().toISOString(), project_id: mission.project_id, mission_id: mission.mission_id, payload: mission as any });
  await persist();
  return c.json(mission, 201);
});

app.post("/api/missions/:id/start", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  await ensureLoaded();
  const mission = state.missions.find((item) => item.mission_id === c.req.param("id"));
  if (!mission) return c.json({ error: "mission not found" }, 404);
  if (mission.active_run_id && ["running", "awaiting_approval", "completed"].includes(mission.status)) return c.json({ error: "mission already started" }, 409);
  const run = createWorkflowRun(makeId("run") as `run_${string}`, mission.mission_id, mission.workflow);
  startCurrentStep(run);
  mission.active_run_id = run.run_id;
  mission.status = run.status;
  mission.summary = "Mission started";
  mission.updated_at = new Date().toISOString();
  state.runs.push(run);
  recordEvent({ type: "run.started", ts: new Date().toISOString(), project_id: mission.project_id, mission_id: mission.mission_id, run_id: run.run_id, payload: run as any });
  recordEvent({ type: "step.started", ts: new Date().toISOString(), project_id: mission.project_id, mission_id: mission.mission_id, run_id: run.run_id, step_id: getCurrentStep(run)?.step_id as `step_${string}` | undefined, payload: (getCurrentStep(run) ?? {}) as any });
  await persist();
  return c.json(run, 201);
});

app.post("/api/runs/:id/execute-current", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  await ensureLoaded();
  const run = state.runs.find((item) => item.run_id === c.req.param("id"));
  if (!run) return c.json({ error: "run not found" }, 404);
  if (run.status === "awaiting_approval") return c.json({ error: "run awaiting approval" }, 409);
  const step = getCurrentStep(run);
  if (!step) return c.json({ error: "no current step" }, 400);
  if (step.state !== "running") startCurrentStep(run);

  const mission = getMissionForRun(run);
  let execution: WorkerExecution;
  try {
    execution = await fetchWorkerExecution(run, step.step_id, step.kind, mission?.repo_path);
  } catch (error) {
    const summary = String(error instanceof Error ? error.message : error);
    await failRun(run, step.step_id, summary, null);
    return c.json({ run, error: summary }, 400);
  }

  for (const artifact of execution.artifacts) {
    attachArtifact(run, step.step_id, { artifact_id: makeId("art"), type: artifact.type, uri: artifact.uri, content: artifact.content, metadata: artifact.metadata } as any);
  }
  for (const event of execution.step_events ?? []) {
    recordEvent(event);
  }

  if (!execution.success) {
    await failRun(run, step.step_id, execution.summary || "worker execution unsuccessful", execution);
    return c.json({ run, execution, execution_result: toTaskExecutionResult(run, step.step_id, execution) }, 400);
  }

  const policy = evaluateStepPolicy({ kind: step.kind, risk: step.risk, artifactCount: step.artifacts.length, workerConfidence: execution.confidence });
  const executionResult = toTaskExecutionResult(run, step.step_id, execution, policy.requires_approval);
  if (!policy.allowed) {
    await failRun(run, step.step_id, policy.reason, execution);
    return c.json({ run, policy, execution, execution_result: executionResult }, 400);
  }

  if (step.kind === "review") {
    const reviewArtifact = getStepArtifact(run, step.step_id, "review");
    await publishDiscovery(run, step.step_id, "Review completed", `Changed files: ${JSON.stringify(reviewArtifact?.metadata?.changed_files ?? [])}`);
  }

  if (policy.requires_approval) {
    const approval: Approval = { approval_id: makeId("approval") as `approval_${string}`, mission_id: run.mission_id, run_id: run.run_id, step_id: step.step_id, status: "pending", reason: `${policy.reason} (confidence ${execution.confidence})`, created_at: new Date().toISOString() };
    state.approvals.unshift(approval);
    markCurrentStepAwaitingApproval(run, approval.approval_id, approval.reason);
    if (mission) {
      mission.status = "awaiting_approval";
      mission.summary = approval.reason;
      mission.updated_at = new Date().toISOString();
    }
    recordEvent({ type: "step.completed", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: step.step_id as `step_${string}`, payload: { policy, execution, execution_result: executionResult, awaiting_approval: true } as any });
    await persist();
    return c.json({ run, approval, policy, execution, execution_result: executionResult });
  }

  markCurrentStepCompleted(run, execution.summary);
  await writebackStep(run, step.step_id, "success", execution.summary);
  if (mission) {
    mission.status = run.status;
    mission.summary = execution.summary;
    mission.updated_at = new Date().toISOString();
  }
  if (step.kind === "deploy") {
    recordEvent({ type: "deployment.completed", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: step.step_id as `step_${string}`, payload: { deploy: getStepArtifact(run, step.step_id, "deploy-note") } as any });
  }
  recordEvent({ type: "step.completed", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: step.step_id as `step_${string}`, payload: { policy, execution, execution_result: executionResult } as any });
  const next = getCurrentStep(run);
  if (next && run.status !== "completed") {
    startCurrentStep(run);
    recordEvent({ type: "step.started", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: next.step_id as `step_${string}`, payload: next as any });
  } else {
    await recordEval(run, state.approvals.filter((item) => item.run_id === run.run_id));
    await cleanupExecutionWorkspace(run, mission, execution);
  }
  await persist();
  return c.json({ run, policy, execution, execution_result: executionResult });
});

app.post("/api/runs/:id/artifacts", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  await ensureLoaded();
  const run = state.runs.find((item) => item.run_id === c.req.param("id"));
  if (!run) return c.json({ error: "run not found" }, 404);
  const body = await c.req.json<{ step_id: string; type: string; content?: string; uri?: string; metadata?: Record<string, unknown> }>();
  const artifact = { artifact_id: makeId("art"), type: body.type, kind: body.type, label: body.type, uri: body.uri ?? `artifact://${run.run_id}/${body.step_id}/${body.type}`, content: body.content, metadata: body.metadata };
  attachArtifact(run, body.step_id, artifact);
  await persist();
  return c.json(artifact, 201);
});

app.post("/api/runs/:id/steps/:stepId/complete", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  await ensureLoaded();
  const run = state.runs.find((item) => item.run_id === c.req.param("id"));
  if (!run) return c.json({ error: "run not found" }, 404);
  const step = run.steps.find((item) => item.step_id === c.req.param("stepId"));
  const current = getCurrentStep(run);
  if (!step || !current || current.step_id !== c.req.param("stepId")) return c.json({ error: "step is not current runnable step" }, 409);
  const policy = evaluateStepPolicy({ kind: step.kind, risk: step.risk, artifactCount: step.artifacts.length, workerConfidence: 0.5 });
  if (!policy.allowed) {
    await failRun(run, step.step_id, policy.reason, null);
    return c.json({ run, policy }, 400);
  }
  if (policy.requires_approval) {
    const approval: Approval = { approval_id: makeId("approval") as `approval_${string}`, mission_id: run.mission_id, run_id: run.run_id, step_id: step.step_id, status: "pending", reason: policy.reason, created_at: new Date().toISOString() };
    state.approvals.unshift(approval);
    markCurrentStepAwaitingApproval(run, approval.approval_id, policy.reason);
    const mission = getMissionForRun(run);
    if (mission) {
      mission.status = "awaiting_approval";
      mission.summary = approval.reason;
      mission.updated_at = new Date().toISOString();
    }
    recordEvent({ type: "step.completed", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: step.step_id as `step_${string}`, payload: { policy, awaiting_approval: true } as any });
    await persist();
    return c.json({ run, approval, policy });
  }
  markCurrentStepCompleted(run, "step completed");
  await writebackStep(run, step.step_id, "success", `Step ${step.step_id} completed successfully`);
  const mission = getMissionForRun(run);
  if (mission) {
    mission.status = run.status;
    mission.summary = "step completed";
    mission.updated_at = new Date().toISOString();
  }
  recordEvent({ type: "step.completed", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: step.step_id as `step_${string}`, payload: { policy } as any });
  const next = getCurrentStep(run);
  if (next && run.status !== "completed") {
    startCurrentStep(run);
    recordEvent({ type: "step.started", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: next.step_id as `step_${string}`, payload: next as any });
  } else {
    await recordEval(run, state.approvals.filter((item) => item.run_id === run.run_id));
    await cleanupExecutionWorkspace(run, mission, null);
  }
  await persist();
  return c.json({ run, policy });
});

app.post("/api/approvals/:id/respond", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  await ensureLoaded();
  const approval = state.approvals.find((item) => item.approval_id === c.req.param("id"));
  if (!approval) return c.json({ error: "approval not found" }, 404);
  if (approval.status !== "pending") return c.json({ error: "approval already resolved" }, 409);
  const body = await c.req.json<{ decision: "approved" | "rejected" }>();
  const run = state.runs.find((item) => item.run_id === approval.run_id);
  const mission = state.missions.find((item) => item.mission_id === approval.mission_id);
  if (!run || !mission) return c.json({ error: "run/mission missing" }, 404);
  const current = getCurrentStep(run);
  if (run.status !== "awaiting_approval" || !current || current.step_id !== approval.step_id) return c.json({ error: "approval is stale" }, 409);

  approval.status = body.decision;

  if (body.decision === "rejected") {
    markCurrentStepFailed(run, `Approval rejected for ${approval.step_id}`);
    mission.status = "failed";
    mission.summary = `Approval rejected for ${approval.step_id}`;
    mission.updated_at = new Date().toISOString();
    if (approval.step_id === "deploy") {
      recordEvent({ type: "rollback.triggered", ts: new Date().toISOString(), mission_id: mission.mission_id, run_id: run.run_id, step_id: approval.step_id as `step_${string}`, payload: { deploy: getStepArtifact(run, approval.step_id, "deploy-note") } as any });
    }
    await writebackStep(run, approval.step_id, "failure", `Approval rejected for ${approval.step_id}`);
    recordEvent({ type: "approval.rejected", ts: new Date().toISOString(), mission_id: mission.mission_id, run_id: run.run_id, step_id: approval.step_id as `step_${string}`, payload: approval as any });
    await recordEval(run, state.approvals.filter((item) => item.run_id === run.run_id));
    await cleanupExecutionWorkspace(run, mission, null);
    await persist();
    return c.json({ approval, run });
  }

  recordEvent({ type: "approval.granted", ts: new Date().toISOString(), mission_id: mission.mission_id, run_id: run.run_id, step_id: approval.step_id as `step_${string}`, payload: approval as any });
  if (approval.step_id === "deploy") {
    recordEvent({ type: "deployment.completed", ts: new Date().toISOString(), mission_id: mission.mission_id, run_id: run.run_id, step_id: approval.step_id as `step_${string}`, payload: { deploy: getStepArtifact(run, approval.step_id, "deploy-note") } as any });
  }
  markCurrentStepCompleted(run, "approved");
  await writebackStep(run, approval.step_id, "success", `Approval granted for ${approval.step_id}`);
  mission.status = run.status;
  mission.summary = `Approval granted for ${approval.step_id}`;
  mission.updated_at = new Date().toISOString();
  const next = getCurrentStep(run);
  const shouldStartNext = !!next && !["completed", "failed", "awaiting_approval", "cancelled"].includes(run.status);
  if (shouldStartNext && next) {
    startCurrentStep(run);
    recordEvent({ type: "step.started", ts: new Date().toISOString(), mission_id: mission.mission_id, run_id: run.run_id, step_id: next.step_id as `step_${string}`, payload: next as any });
  } else {
    await recordEval(run, state.approvals.filter((item) => item.run_id === run.run_id));
    await cleanupExecutionWorkspace(run, mission, null);
  }
  await persist();
  return c.json({ approval, run });
});

if (!process.env.VITEST) {
  serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 4302) });
  console.log("orchestrator-api listening on http://localhost:4302");
}

export { app };
