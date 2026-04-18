import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { resolve } from "node:path";
import { attachArtifact, createWorkflowRun, getCurrentStep, startCurrentStep, advanceRun, markCurrentStepAwaitingApproval, markCurrentStepCompleted, markCurrentStepFailed, type WorkflowArtifact, type WorkflowRun } from "@hermes-harness-with-missioncontrol/workflow-engine";
import { evaluateStepPolicy } from "@hermes-harness-with-missioncontrol/policy-engine";
import { loadJsonFile, saveJsonFile } from "@hermes-harness-with-missioncontrol/state-store";
import { makeId, type HarnessEvent } from "@hermes-harness-with-missioncontrol/shared-types";
import { scoreRun } from "@hermes-harness-with-missioncontrol/eval-core";
import { FinalOutcome, StepKind, type ApprovalRequest, type ApprovalResult, type ArtifactRef, type TaskExecutionResult } from "@hermes-harness-with-missioncontrol/contracts";

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

type Approval = ApprovalRequest & Partial<ApprovalResult> & {
  status: "pending" | "approved" | "rejected";
  created_at?: string;
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

function normalizeApproval(approval: Approval): Approval {
  return {
    ...approval,
    decision_scope: approval.decision_scope ?? "step",
    requested_at: approval.requested_at ?? approval.created_at ?? new Date().toISOString()
  };
}

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
  state.approvals.splice(0, state.approvals.length, ...((loaded.approvals ?? []).map((approval) => normalizeApproval(approval as Approval))));
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

function buildOverviewReadModel() {
  return {
    metrics: {
      open_missions: state.missions.filter((mission) => !["completed", "cancelled"].includes(mission.status)).length,
      pending_approvals: state.approvals.filter((approval) => approval.status === "pending").length,
      failed_missions: state.missions.filter((mission) => mission.status === "failed").length
    }
  };
}

function buildMissionsReadModel() {
  return {
    mission_queue: state.missions.map((mission) => ({
      mission_id: mission.mission_id,
      title: mission.title,
      objective: mission.objective,
      status: mission.status,
      repo_path: mission.repo_path,
      active_run_id: mission.active_run_id,
      summary: mission.summary,
      updated_at: mission.updated_at
    })),
    approval_queue: state.approvals.map((approval) => ({
      approval_id: approval.approval_id,
      mission_id: approval.mission_id,
      run_id: approval.run_id,
      step_id: approval.step_id,
      status: approval.status,
      reason: approval.reason,
      decision_scope: approval.decision_scope,
      requested_at: approval.requested_at,
      resolved_at: approval.resolved_at
    })),
    run_cards: state.runs.map((run) => ({
      run_id: run.run_id,
      mission_id: run.mission_id,
      workflow_id: run.workflow_id,
      status: run.status,
      current_step_id: run.current_step_id,
      approval_id: run.approval_id,
      summary: run.summary,
      steps: run.steps.map((step) => ({
        step_id: step.step_id,
        title: step.title,
        kind: step.kind,
        state: step.state,
        risk: step.risk,
        approval_id: step.approval_id,
        blocked_reason: step.blocked_reason,
        notes: step.notes,
        artifacts_count: step.artifacts.length,
        latest_artifact_uri: step.artifacts[step.artifacts.length - 1]?.uri
      }))
    }))
  };
}

function toApprovalOperatorView(approval: Approval) {
  return {
    approval_id: approval.approval_id,
    mission_id: approval.mission_id,
    run_id: approval.run_id,
    step_id: approval.step_id,
    actor: approval.resolved_by ?? "system",
    reason: approval.reason,
    requested_at: approval.requested_at,
    resolved_at: approval.resolved_at,
    outcome: approval.status,
    decision_scope: approval.decision_scope
  };
}

function inDateRange(value: string | undefined, from?: string, to?: string) {
  if (!value) return false;
  if (from && value < from) return false;
  if (to && value > to) return false;
  return true;
}

function sortApprovalViews<T extends { outcome: string; requested_at?: string; resolved_at?: string; mission_id?: string; run_id?: string }>(items: T[], sort = "newest") {
  return [...items].sort((a, b) => {
    if (sort === "oldest") return (a.resolved_at ?? a.requested_at ?? "").localeCompare(b.resolved_at ?? b.requested_at ?? "");
    if (sort === "pending_first") {
      const rank = (value: string) => value === "pending" ? 0 : 1;
      const diff = rank(a.outcome) - rank(b.outcome);
      if (diff !== 0) return diff;
    }
    if (sort === "rejected_first") {
      const rank = (value: string) => value === "rejected" ? 0 : value === "pending" ? 1 : 2;
      const diff = rank(a.outcome) - rank(b.outcome);
      if (diff !== 0) return diff;
    }
    if (sort === "mission") {
      const diff = (a.mission_id ?? "").localeCompare(b.mission_id ?? "");
      if (diff !== 0) return diff;
    }
    if (sort === "run") {
      const diff = (a.run_id ?? "").localeCompare(b.run_id ?? "");
      if (diff !== 0) return diff;
    }
    return (b.resolved_at ?? b.requested_at ?? "").localeCompare(a.resolved_at ?? a.requested_at ?? "");
  });
}

function buildApprovalsReadModel(query: Record<string, string | undefined> = {}) {
  const filtered = state.approvals
    .map(toApprovalOperatorView)
    .filter((approval) => (!query.mission_id || approval.mission_id === query.mission_id)
      && (!query.run_id || approval.run_id === query.run_id)
      && (!query.step_id || approval.step_id === query.step_id)
      && (!query.actor || approval.actor === query.actor)
      && (!query.outcome || approval.outcome === query.outcome)
      && inDateRange(approval.requested_at, query.from, query.to));

  const pending = sortApprovalViews(filtered.filter((approval) => approval.outcome === "pending"), query.sort);
  const history = sortApprovalViews(filtered.filter((approval) => approval.outcome !== "pending"), query.sort);
  const pendingPage = paginateItems(pending, query);
  const historyPage = paginateItems(history, query);

  return {
    pending_approvals: pendingPage.items,
    pending_pagination: pendingPage.pagination,
    history: historyPage.items,
    history_pagination: historyPage.pagination
  };
}

function buildApprovalHistoryReadModel(query: Record<string, string | undefined> = {}) {
  const approvals = sortApprovalViews(
    state.approvals
      .filter((approval) => approval.status !== "pending")
      .map(toApprovalOperatorView)
      .filter((approval) => (!query.mission_id || approval.mission_id === query.mission_id)
        && (!query.run_id || approval.run_id === query.run_id)
        && (!query.step_id || approval.step_id === query.step_id)
        && (!query.actor || approval.actor === query.actor)
        && (!query.outcome || approval.outcome === query.outcome)
        && inDateRange(approval.resolved_at ?? approval.requested_at, query.from, query.to)),
    query.sort
  );
  const page = paginateItems(approvals, query);
  return {
    approvals: page.items,
    pagination: page.pagination
  };
}

function sortTimeline<T extends { occurred_at: string; mission_id?: string; run_id?: string }>(items: T[], sort = "newest") {
  return [...items].sort((a, b) => {
    if (sort === "oldest") return a.occurred_at.localeCompare(b.occurred_at);
    if (sort === "mission") {
      const diff = (a.mission_id ?? "").localeCompare(b.mission_id ?? "");
      if (diff !== 0) return diff;
    }
    if (sort === "run") {
      const diff = (a.run_id ?? "").localeCompare(b.run_id ?? "");
      if (diff !== 0) return diff;
    }
    return b.occurred_at.localeCompare(a.occurred_at);
  });
}

function paginateItems<T>(items: T[], query: Record<string, string | undefined>) {
  const rawLimit = query.limit ? Number(query.limit) : (items.length || 1);
  const limit = Math.max(1, Math.min(100, rawLimit));
  const offset = Math.max(0, Number(query.offset ?? 0));
  const page = items.slice(offset, offset + limit);
  return {
    items: page,
    pagination: {
      total: items.length,
      limit,
      offset,
      has_more: offset + limit < items.length
    }
  };
}

function buildAuditReadModel(query: Record<string, string | undefined> = {}) {
  const titleMap: Record<string, { kind: string; title: string }> = {
    "approval.requested": { kind: "approval", title: "Approval requested" },
    "approval.resolved": { kind: "approval", title: "Approval resolved" },
    "step.started": { kind: "step", title: "Step started" },
    "step.completed": { kind: "step", title: "Step completed" },
    "step.failed": { kind: "step", title: "Step failed" },
    "step.blocked": { kind: "step", title: "Step blocked" },
    "run.started": { kind: "run", title: "Run started" },
    "mission.created": { kind: "mission", title: "Mission created" },
    "deployment.completed": { kind: "deployment", title: "Deployment completed" },
    "rollback.triggered": { kind: "deployment", title: "Rollback triggered" }
  };

  const timeline = state.events.map((event: any) => {
    const meta = titleMap[event.type] ?? { kind: "event", title: String(event.type ?? "Event") };
    return {
      kind: meta.kind,
      title: meta.title,
      event_type: event.type,
      occurred_at: event.ts ?? event.timestamp ?? "",
      mission_id: event.mission_id,
      run_id: event.run_id,
      step_id: event.step_id
    };
  }).filter((event) => (!query.mission_id || event.mission_id === query.mission_id)
    && (!query.run_id || event.run_id === query.run_id)
    && (!query.step_id || event.step_id === query.step_id)
    && (!query.kind || event.kind === query.kind)
    && (!query.event_type || event.event_type === query.event_type)
    && inDateRange(event.occurred_at, query.from, query.to));

  const page = paginateItems(sortTimeline(timeline, query.sort), query);
  return {
    timeline: page.items,
    pagination: page.pagination
  };
}

function buildMissionDetailReadModel(missionId: string) {
  const mission = state.missions.find((item) => item.mission_id === missionId);
  if (!mission) return null;

  const runs = state.runs.filter((run) => run.mission_id === missionId);
  const approvals = state.approvals.filter((approval) => approval.mission_id === missionId);
  const timeline = buildAuditReadModel({ mission_id: missionId }).timeline;
  const totalArtifacts = runs.reduce((sum, run) => sum + run.steps.reduce((stepSum, step) => stepSum + step.artifacts.length, 0), 0);
  const activeRun = mission.active_run_id ? runs.find((run) => run.run_id === mission.active_run_id) : undefined;

  return {
    mission,
    active_run: activeRun ? {
      run_id: activeRun.run_id,
      workflow_id: activeRun.workflow_id,
      status: activeRun.status,
      current_step_id: activeRun.current_step_id,
      summary: activeRun.summary
    } : null,
    runs: runs.map((run) => ({
      run_id: run.run_id,
      workflow_id: run.workflow_id,
      status: run.status,
      current_step_id: run.current_step_id,
      summary: run.summary
    })),
    approval_summary: {
      pending: approvals.filter((approval) => approval.status === "pending").length,
      approved: approvals.filter((approval) => approval.status === "approved").length,
      rejected: approvals.filter((approval) => approval.status === "rejected").length
    },
    artifact_summary: {
      total_artifacts: totalArtifacts
    },
    timeline_summary: {
      total_events: timeline.length,
      recent: timeline.slice(0, 10)
    }
  };
}

function buildRunDetailReadModel(runId: string) {
  const run = state.runs.find((item) => item.run_id === runId);
  if (!run) return null;

  const mission = state.missions.find((item) => item.mission_id === run.mission_id);
  const approvals = state.approvals.filter((approval) => approval.run_id === runId);
  const timeline = buildAuditReadModel({ run_id: runId }).timeline;
  const totalArtifacts = run.steps.reduce((sum, step) => sum + step.artifacts.length, 0);

  return {
    run: {
      run_id: run.run_id,
      mission_id: run.mission_id,
      workflow_id: run.workflow_id,
      status: run.status,
      current_step_id: run.current_step_id,
      summary: run.summary
    },
    mission: mission ? {
      mission_id: mission.mission_id,
      title: mission.title,
      status: mission.status,
      summary: mission.summary
    } : null,
    steps: run.steps.map((step) => ({
      step_id: step.step_id,
      title: step.title,
      kind: step.kind,
      state: step.state,
      risk: step.risk,
      blocked_reason: step.blocked_reason,
      notes: step.notes,
      artifacts_count: step.artifacts.length,
      latest_artifact_uri: step.artifacts[step.artifacts.length - 1]?.uri
    })),
    approval_summary: {
      pending: approvals.filter((approval) => approval.status === "pending").length,
      approved: approvals.filter((approval) => approval.status === "approved").length,
      rejected: approvals.filter((approval) => approval.status === "rejected").length
    },
    artifact_summary: {
      total_artifacts: totalArtifacts
    },
    timeline_summary: {
      total_events: timeline.length,
      recent: timeline.slice(0, 10)
    }
  };
}

function buildStepDetailReadModel(runId: string, stepId: string) {
  const run = state.runs.find((item) => item.run_id === runId);
  if (!run) return null;

  const mission = state.missions.find((item) => item.mission_id === run.mission_id);
  const step = run.steps.find((item) => item.step_id === stepId);
  if (!step) return null;

  const approval = step.approval_id ? state.approvals.find((item) => item.approval_id === step.approval_id) : undefined;
  const timeline = buildAuditReadModel({ run_id: runId, step_id: stepId }).timeline;

  return {
    mission: mission ? { mission_id: mission.mission_id, title: mission.title, status: mission.status } : null,
    run: { run_id: run.run_id, mission_id: run.mission_id, workflow_id: run.workflow_id, status: run.status },
    step: {
      step_id: step.step_id,
      title: step.title,
      kind: step.kind,
      state: step.state,
      risk: step.risk,
      notes: step.notes,
      blocked_reason: step.blocked_reason,
      execution_id: step.execution_id,
      started_at: step.started_at,
      completed_at: step.completed_at,
      approval_id: step.approval_id
    },
    approval: approval ? toApprovalOperatorView(approval) : null,
    artifacts: step.artifacts.map((artifact) => ({
      artifact_id: artifact.artifact_id,
      artifact_type: artifact.kind,
      summary: artifact.label,
      ref: artifact.uri,
      created_at: artifact.created_at ?? step.completed_at ?? step.started_at,
      eval_linkage: typeof artifact.metadata?.eval_id === "string" ? artifact.metadata.eval_id : undefined
    })),
    execution_result_summary: {
      execution_id: step.execution_id,
      summary: step.notes,
      outcome: step.state === "completed" ? "success" : step.state === "failed" ? "failure" : "pending"
    },
    timeline_summary: {
      total_events: timeline.length,
      recent: timeline.slice(0, 10)
    }
  };
}

function buildArtifactsReadModel(query: Record<string, string | undefined> = {}) {
  const artifacts = state.runs.flatMap((run) => run.steps.flatMap((step) => step.artifacts.map((artifact) => ({
    artifact_id: artifact.artifact_id,
    artifact_type: artifact.kind,
    mission_id: run.mission_id,
    run_id: run.run_id,
    step_id: step.step_id,
    source_step: step.step_id,
    created_at: artifact.created_at ?? step.completed_at ?? step.started_at ?? run.updated_at,
    created_by: typeof artifact.metadata?.created_by === "string" ? artifact.metadata.created_by : "system",
    summary: artifact.label,
    ref: artifact.uri,
    path: artifact.uri,
    content_type: artifact.content_type,
    eval_linkage: typeof artifact.metadata?.eval_id === "string" ? artifact.metadata.eval_id : undefined
  }))));

  const filtered = artifacts.filter((artifact) => (!query.mission_id || artifact.mission_id === query.mission_id)
    && (!query.run_id || artifact.run_id === query.run_id)
    && (!query.step_id || artifact.step_id === query.step_id)
    && (!query.artifact_type || artifact.artifact_type === query.artifact_type)
    && inDateRange(artifact.created_at, query.from, query.to));

  const sorted = [...filtered].sort((a, b) => {
    if (query.sort === "oldest") return (a.created_at ?? "").localeCompare(b.created_at ?? "");
    if (query.sort === "mission") {
      const diff = a.mission_id.localeCompare(b.mission_id);
      if (diff !== 0) return diff;
    }
    if (query.sort === "run") {
      const diff = a.run_id.localeCompare(b.run_id);
      if (diff !== 0) return diff;
    }
    if (query.sort === "step") {
      const diff = a.step_id.localeCompare(b.step_id);
      if (diff !== 0) return diff;
    }
    return (b.created_at ?? "").localeCompare(a.created_at ?? "");
  });
  const page = paginateItems(sorted, query);

  return {
    artifacts: page.items,
    pagination: page.pagination
  };
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
app.get("/api/read-models/overview", async (c) => { await ensureLoaded(); return c.json(buildOverviewReadModel()); });
app.get("/api/read-models/missions", async (c) => { await ensureLoaded(); return c.json(buildMissionsReadModel()); });
app.get("/api/read-models/missions/:id", async (c) => {
  await ensureLoaded();
  const payload = buildMissionDetailReadModel(c.req.param("id"));
  if (!payload) return c.json({ error: "mission not found" }, 404);
  return c.json(payload);
});
app.get("/api/read-models/runs/:id", async (c) => {
  await ensureLoaded();
  const payload = buildRunDetailReadModel(c.req.param("id"));
  if (!payload) return c.json({ error: "run not found" }, 404);
  return c.json(payload);
});
app.get("/api/read-models/runs/:runId/steps/:stepId", async (c) => {
  await ensureLoaded();
  const payload = buildStepDetailReadModel(c.req.param("runId"), c.req.param("stepId"));
  if (!payload) return c.json({ error: "step not found" }, 404);
  return c.json(payload);
});
app.get("/api/read-models/artifacts", async (c) => { await ensureLoaded(); return c.json(buildArtifactsReadModel(c.req.query())); });
app.get("/api/read-models/approvals", async (c) => { await ensureLoaded(); return c.json(buildApprovalsReadModel(c.req.query())); });
app.get("/api/read-models/approval-history", async (c) => { await ensureLoaded(); return c.json(buildApprovalHistoryReadModel(c.req.query())); });
app.get("/api/read-models/audit", async (c) => { await ensureLoaded(); return c.json(buildAuditReadModel(c.req.query())); });

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
    const requestedAt = new Date().toISOString();
    const approval = normalizeApproval({ approval_id: makeId("approval") as `approval_${string}`, mission_id: run.mission_id, run_id: run.run_id, step_id: step.step_id, status: "pending", reason: `${policy.reason} (confidence ${execution.confidence})`, decision_scope: "step", requested_at: requestedAt });
    state.approvals.unshift(approval);
    markCurrentStepAwaitingApproval(run, approval.approval_id, execution.summary, approval.reason);
    if (mission) {
      mission.status = "awaiting_approval";
      mission.summary = approval.reason;
      mission.updated_at = new Date().toISOString();
    }
    recordEvent({ type: "approval.requested", ts: requestedAt, mission_id: run.mission_id, run_id: run.run_id, step_id: step.step_id as `step_${string}`, payload: approval as any });
    recordEvent({ type: "step.blocked", ts: requestedAt, mission_id: run.mission_id, run_id: run.run_id, step_id: step.step_id as `step_${string}`, payload: { approval_id: approval.approval_id, reason: approval.reason } as any });
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
    const requestedAt = new Date().toISOString();
    const approval = normalizeApproval({ approval_id: makeId("approval") as `approval_${string}`, mission_id: run.mission_id, run_id: run.run_id, step_id: step.step_id, status: "pending", reason: policy.reason, decision_scope: "step", requested_at: requestedAt });
    state.approvals.unshift(approval);
    markCurrentStepAwaitingApproval(run, approval.approval_id, "step completed", policy.reason);
    const mission = getMissionForRun(run);
    if (mission) {
      mission.status = "awaiting_approval";
      mission.summary = approval.reason;
      mission.updated_at = new Date().toISOString();
    }
    recordEvent({ type: "approval.requested", ts: requestedAt, mission_id: run.mission_id, run_id: run.run_id, step_id: step.step_id as `step_${string}`, payload: approval as any });
    recordEvent({ type: "step.blocked", ts: requestedAt, mission_id: run.mission_id, run_id: run.run_id, step_id: step.step_id as `step_${string}`, payload: { approval_id: approval.approval_id, reason: approval.reason } as any });
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
  const body = await c.req.json<{ decision: "approved" | "rejected"; actor?: string }>();
  const run = state.runs.find((item) => item.run_id === approval.run_id);
  const mission = state.missions.find((item) => item.mission_id === approval.mission_id);
  if (!run || !mission) return c.json({ error: "run/mission missing" }, 404);
  const current = getCurrentStep(run);
  if (run.status !== "awaiting_approval" || !current || current.step_id !== approval.step_id || current.approval_id !== approval.approval_id) return c.json({ error: "approval is stale" }, 409);

  approval.status = body.decision;
  approval.resolved_at = new Date().toISOString();
  approval.resolved_by = body.actor?.trim() || "operator";
  const approvalResult = {
    approval_id: approval.approval_id,
    decision: body.decision,
    resolved_at: approval.resolved_at,
    resolved_by: approval.resolved_by,
    reason: approval.reason,
    step_id: approval.step_id
  };
  recordEvent({ type: "approval.resolved", ts: approvalResult.resolved_at, mission_id: mission.mission_id, run_id: run.run_id, step_id: approval.step_id as `step_${string}`, payload: approvalResult as any });

  if (body.decision === "rejected") {
    markCurrentStepFailed(run, `Approval rejected for ${approval.step_id}`);
    mission.status = "failed";
    mission.summary = `Approval rejected for ${approval.step_id}`;
    mission.updated_at = new Date().toISOString();
    if (approval.step_id === "deploy") {
      recordEvent({ type: "rollback.triggered", ts: new Date().toISOString(), mission_id: mission.mission_id, run_id: run.run_id, step_id: approval.step_id as `step_${string}`, payload: { deploy: getStepArtifact(run, approval.step_id, "deploy-note") } as any });
    }
    await writebackStep(run, approval.step_id, "failure", `Approval rejected for ${approval.step_id}`);
    recordEvent({ type: "step.failed", ts: new Date().toISOString(), mission_id: mission.mission_id, run_id: run.run_id, step_id: approval.step_id as `step_${string}`, payload: { approval_id: approval.approval_id, reason: approval.reason } as any });
    await recordEval(run, state.approvals.filter((item) => item.run_id === run.run_id));
    await cleanupExecutionWorkspace(run, mission, null);
    await persist();
    return c.json({ approval, run });
  }

  if (approval.step_id === "deploy") {
    recordEvent({ type: "deployment.completed", ts: new Date().toISOString(), mission_id: mission.mission_id, run_id: run.run_id, step_id: approval.step_id as `step_${string}`, payload: { deploy: getStepArtifact(run, approval.step_id, "deploy-note") } as any });
  }
  markCurrentStepCompleted(run, current.notes ?? `Approval granted for ${approval.step_id}`);
  await writebackStep(run, approval.step_id, "success", `Approval granted for ${approval.step_id}`);
  mission.status = run.status;
  mission.summary = current.notes ?? `Approval granted for ${approval.step_id}`;
  mission.updated_at = new Date().toISOString();
  recordEvent({ type: "step.completed", ts: new Date().toISOString(), mission_id: mission.mission_id, run_id: run.run_id, step_id: approval.step_id as `step_${string}`, payload: { approval_id: approval.approval_id, decision: body.decision } as any });
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
