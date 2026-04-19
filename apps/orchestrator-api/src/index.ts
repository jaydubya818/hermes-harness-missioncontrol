import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { resolve } from "node:path";
import { readdir } from "node:fs/promises";
import { attachArtifact, createWorkflowRun, getCurrentStep, startCurrentStep, advanceRun, markCurrentStepAwaitingApproval, markCurrentStepCompleted, markCurrentStepFailed, pauseCurrentStep, resumeCurrentStep, retryCurrentStep, cancelCurrentStep, syncRunState, type WorkflowArtifact, type WorkflowRun } from "@hermes-harness-with-missioncontrol/workflow-engine";
import { evaluateStepPolicy } from "@hermes-harness-with-missioncontrol/policy-engine";
import { loadJsonFile, saveJsonFile } from "@hermes-harness-with-missioncontrol/state-store";
import { makeId, type HarnessEvent } from "@hermes-harness-with-missioncontrol/shared-types";
import { scoreRun, type EvalRecord } from "@hermes-harness-with-missioncontrol/eval-core";
import { FinalOutcome, StepKind, type ApprovalRequest, type ApprovalResult, type ArtifactRef, type ExecutionEnvelope, type StepExecutionRequest, type TaskExecutionResult } from "@hermes-harness-with-missioncontrol/contracts";

const app = new Hono();
const stateFile = process.env.ORCHESTRATOR_STATE_FILE ?? resolve(process.cwd(), "../../data/orchestrator-state.json");
const memoryApi = process.env.MEMORY_API_URL ?? "http://localhost:4301";
const evalApi = process.env.EVAL_API_URL ?? "http://localhost:4303";
const workerApi = process.env.WORKER_API_URL ?? "http://localhost:4304";
const workerRunsRoot = resolve(process.env.WORKER_RUNTIME_ROOT ?? resolve(process.cwd(), "../../data/worker-runs"));
const workerWorktreesRoot = resolve(process.env.WORKTREE_ROOT ?? resolve(process.cwd(), "../../data/worktrees"));
const orphanSweepIntervalMs = Number(process.env.ORPHAN_SWEEP_INTERVAL_MS ?? "0");
const allowedRepoRoot = resolve(process.env.ALLOWED_REPO_ROOT ?? "/Users/jaywest/projects");
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
  processed_event_ids: string[];
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

const state: OrchestratorState = { missions: [], runs: [], approvals: [], events: [], audit: [], processed_event_ids: [] };
let initialized = false;

function normalizeApproval(approval: Approval): Approval {
  return {
    ...approval,
    decision_scope: approval.decision_scope ?? "step",
    requested_at: approval.requested_at ?? approval.created_at ?? new Date().toISOString()
  };
}

const CANONICAL_EVENT_TYPES = new Set<HarnessEvent["type"]>([
  "mission.created",
  "mission.updated",
  "mission.paused",
  "mission.running",
  "mission.cancelled",
  "mission.completed",
  "run.started",
  "run.running",
  "run.paused",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "step.started",
  "step.progress",
  "step.paused",
  "step.resumed",
  "step.blocked",
  "step.completed",
  "step.failed",
  "step.cancelled",
  "step.retried",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "artifact.created",
  "approval.requested",
  "approval.resolved",
  "eval.started",
  "eval.completed",
  "eval.failed",
  "policy.violation",
  "execution.timeout",
  "execution.budget_exceeded",
] as const);

const LEGACY_EVENT_TYPE_MAP: Record<string, HarnessEvent["type"]> = {
  "approval.granted": "approval.resolved",
  "approval.rejected": "approval.resolved",
  "mission.started": "mission.running",
  "run.resumed": "run.running",
  "step.awaiting_approval": "step.blocked",
};

function relativeWithin(root: string, path: string) {
  const rel = resolve(path).replace(`${resolve(root)}/`, "");
  if (resolve(path) !== resolve(root) && (rel === resolve(path) || rel.startsWith(".."))) throw new Error("path escapes allowed root");
  return rel;
}

function buildExecutionEnvelope(run: WorkflowRun, step: WorkflowRun["steps"][number], mission?: Mission): ExecutionEnvelope {
  const repoRoot = resolve(
    mission?.repo_path
      ?? mission?.workspace_root
      ?? resolve(allowedRepoRoot, ".missioncontrol-sandboxes", run.run_id)
  );
  const worktreePath = resolve(workerWorktreesRoot, run.run_id);
  const outputDir = resolve(workerRunsRoot, run.run_id, step.step_id);
  const allowedActions = step.kind === "plan" ? ["plan", "read_repo"]
    : step.kind === "implement" ? ["read_repo", "write_repo"]
    : step.kind === "test" ? ["read_repo", "run_tests"]
    : step.kind === "review" ? ["read_repo", "review_repo"]
    : ["read_repo", "deploy"];
  const allowedTools = step.kind === "test"
    ? ["filesystem", "process"]
    : step.kind === "deploy"
      ? ["filesystem", "git", "process"]
      : ["filesystem", "git"];

  return {
    worktree_path: worktreePath,
    workspace_root: repoRoot,
    repo_scope: {
      root_path: repoRoot,
      writable_paths: step.kind === "implement" ? [".hermes-harness"] : []
    },
    allowed_tools: allowedTools,
    allowed_actions: allowedActions,
    approval_mode: step.approval_mode,
    timeout_seconds: step.kind === "deploy" ? 900 : 300,
    resource_budget: {
      token_budget: step.kind === "plan" ? 8000 : 32000,
      max_artifacts: 20,
      max_output_bytes: 1024 * 1024 * 5
    },
    output_dir: outputDir,
    environment_classification: "sandbox"
  };
}

function validateExecutionEnvelope(envelope: ExecutionEnvelope) {
  if (!envelope.workspace_root) throw new Error("invalid execution envelope: workspace_root required");
  if (!envelope.worktree_path) throw new Error("invalid execution envelope: worktree_path required");
  if (!envelope.output_dir) throw new Error("invalid execution envelope: output_dir required");
  if (!envelope.repo_scope?.root_path) throw new Error("invalid execution envelope: repo_scope.root_path required");
  if (!Array.isArray(envelope.allowed_tools) || envelope.allowed_tools.length === 0) throw new Error("invalid execution envelope: allowed_tools required");
  if (!Array.isArray(envelope.allowed_actions) || envelope.allowed_actions.length === 0) throw new Error("invalid execution envelope: allowed_actions required");
  if (envelope.timeout_seconds <= 0) throw new Error("invalid execution envelope: timeout_seconds must be positive");
  if (envelope.resource_budget.max_artifacts <= 0 || envelope.resource_budget.max_output_bytes <= 0 || envelope.resource_budget.token_budget <= 0) {
    throw new Error("invalid execution envelope: resource_budget invalid");
  }
  if (!envelope.environment_classification) throw new Error("invalid execution envelope: environment_classification required");
  relativeWithin(allowedRepoRoot, envelope.workspace_root);
  relativeWithin(allowedRepoRoot, envelope.repo_scope.root_path);
  relativeWithin(workerWorktreesRoot, envelope.worktree_path);
  relativeWithin(workerRunsRoot, envelope.output_dir);
  for (const writablePath of envelope.repo_scope.writable_paths) {
    if (!writablePath || writablePath.startsWith("/")) throw new Error("invalid execution envelope: writable_paths must be relative");
    relativeWithin(envelope.repo_scope.root_path, resolve(envelope.repo_scope.root_path, writablePath));
  }
}

function summarizeEnvelope(envelope: ExecutionEnvelope) {
  return {
    workspace_root: envelope.workspace_root,
    worktree_path: envelope.worktree_path,
    output_dir: envelope.output_dir,
    repo_scope: envelope.repo_scope,
    allowed_tools: envelope.allowed_tools,
    allowed_actions: envelope.allowed_actions,
    timeout_seconds: envelope.timeout_seconds,
    resource_budget: envelope.resource_budget,
    approval_mode: envelope.approval_mode,
    environment_classification: envelope.environment_classification,
  };
}

function buildStepExecutionRequest(run: WorkflowRun, step: WorkflowRun["steps"][number], mission?: Mission): StepExecutionRequest {
  const envelope = buildExecutionEnvelope(run, step, mission);
  validateExecutionEnvelope(envelope);
  return {
    mission_id: run.mission_id,
    run_id: run.run_id,
    step_id: step.step_id,
    execution_id: step.execution_id ?? makeId("exec"),
    kind: step.kind,
    repo_path: mission?.repo_path,
    branch_name: `hermes/${run.run_id}`,
    envelope
  };
}

function normalizeEventType(type: unknown): HarnessEvent["type"] {
  const raw = String(type ?? "").trim();
  const normalized = LEGACY_EVENT_TYPE_MAP[raw] ?? raw;
  if (!CANONICAL_EVENT_TYPES.has(normalized as HarnessEvent["type"])) {
    throw new Error(`unsupported event type: ${raw}`);
  }
  return normalized as HarnessEvent["type"];
}

function nextEventSequence() {
  return state.events.reduce((max, event: any) => Math.max(max, Number(event.sequence ?? 0)), 0) + 1;
}

function normalizeEventRecord(event: HarnessEvent | Record<string, unknown>) {
  const now = new Date().toISOString();
  const raw = event as any;
  return {
    schema_version: raw.schema_version ?? "v1",
    event_id: raw.event_id ?? makeId("evt"),
    timestamp: raw.timestamp ?? raw.ts ?? now,
    ts: raw.ts ?? raw.timestamp ?? now,
    sequence: Number.isFinite(raw.sequence) ? raw.sequence : nextEventSequence(),
    source: raw.source === "hermes" ? "hermes" : "missioncontrol",
    type: normalizeEventType(raw.type),
    mission_id: raw.mission_id,
    run_id: raw.run_id,
    step_id: raw.step_id,
    execution_id: raw.execution_id,
    actor: raw.actor,
    payload: typeof raw.payload === "object" && raw.payload !== null ? raw.payload : {}
  } as HarnessEvent;
}

function missionLifecycleEventType(status: Mission["status"]): HarnessEvent["type"] | undefined {
  if (status === "running") return "mission.running";
  if (status === "paused") return "mission.paused";
  if (status === "cancelled") return "mission.cancelled";
  if (status === "completed") return "mission.completed";
  return undefined;
}

function runLifecycleEventType(status: WorkflowRun["status"]): HarnessEvent["type"] | undefined {
  if (status === "running") return "run.running";
  if (status === "paused") return "run.paused";
  if (status === "completed") return "run.completed";
  if (status === "failed") return "run.failed";
  if (status === "cancelled") return "run.cancelled";
  return undefined;
}

function recordRunStatusEvent(run: WorkflowRun, context: { step_id?: string; actor?: string; execution_id?: string; summary?: string } = {}) {
  const type = runLifecycleEventType(run.status);
  if (!type) return;
  recordEvent({
    type,
    ts: new Date().toISOString(),
    mission_id: run.mission_id,
    run_id: run.run_id,
    step_id: context.step_id,
    actor: context.actor,
    execution_id: context.execution_id,
    payload: { status: run.status, summary: context.summary ?? run.summary, current_step_id: run.current_step_id } as any
  });
}

function updateMissionState(mission: Mission | undefined, status: Mission["status"], summary: string, context: { run_id?: string; step_id?: string; actor?: string } = {}) {
  if (!mission) return;
  const previousStatus = mission.status;
  mission.status = status;
  mission.summary = summary;
  mission.updated_at = new Date().toISOString();
  recordEvent({ type: "mission.updated", ts: mission.updated_at, mission_id: mission.mission_id, run_id: context.run_id, step_id: context.step_id, actor: context.actor, payload: { status, summary } as any });
  const lifecycleEvent = missionLifecycleEventType(status);
  if (lifecycleEvent && previousStatus !== status) {
    recordEvent({ type: lifecycleEvent, ts: mission.updated_at, mission_id: mission.mission_id, run_id: context.run_id, step_id: context.step_id, actor: context.actor, payload: { status, summary } as any });
  }
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
  state.runs.splice(0, state.runs.length, ...((loaded.runs ?? []).map((run) => syncRunState(run as WorkflowRun))));
  state.approvals.splice(0, state.approvals.length, ...((loaded.approvals ?? []).map((approval) => normalizeApproval(approval as Approval))));
  state.events.splice(0, state.events.length);
  state.audit.splice(0, state.audit.length);
  state.processed_event_ids.splice(0, state.processed_event_ids.length);

  const normalizedEvents = (loaded.events ?? [])
    .map((event) => normalizeEventRecord(event))
    .sort((a, b) => (a.ts ?? a.timestamp ?? "").localeCompare(b.ts ?? b.timestamp ?? ""));
  for (const event of normalizedEvents) {
    recordEvent(event);
  }

  if (!state.processed_event_ids.length && Array.isArray(loaded.processed_event_ids)) {
    state.processed_event_ids.splice(0, state.processed_event_ids.length, ...loaded.processed_event_ids);
  }

  for (const mission of state.missions) {
    const activeRun = mission.active_run_id
      ? state.runs.find((run) => run.run_id === mission.active_run_id)
      : state.runs.find((run) => run.mission_id === mission.mission_id && !["completed", "failed", "cancelled"].includes(run.status));

    if (activeRun) {
      mission.active_run_id = !["completed", "failed", "cancelled"].includes(activeRun.status) ? activeRun.run_id : mission.active_run_id;
      mission.status = activeRun.status as Mission["status"];
      mission.summary = activeRun.summary ?? mission.summary;
    }
  }

  initialized = true;
}

async function persist() {
  await saveJsonFile(stateFile, state);
}

type EventStreamFilters = {
  mission_id?: string;
  run_id?: string;
  step_id?: string;
  event_type?: string;
  actor?: string;
};

type EventSubscriber = {
  id: string;
  matches: (event: HarnessEvent) => boolean;
  enqueue: (event: HarnessEvent) => void;
  close: () => void;
};

const eventSubscribers = new Map<string, EventSubscriber>();

function normalizeSseFilters(query: Record<string, string | undefined>): EventStreamFilters {
  return {
    mission_id: query.mission_id,
    run_id: query.run_id,
    step_id: query.step_id,
    event_type: query.event_type,
    actor: query.actor,
  };
}

function eventMatchesFilters(event: HarnessEvent, filters: EventStreamFilters) {
  if (filters.mission_id && event.mission_id !== filters.mission_id) return false;
  if (filters.run_id && event.run_id !== filters.run_id) return false;
  if (filters.step_id && event.step_id !== filters.step_id) return false;
  if (filters.actor && event.actor !== filters.actor) return false;
  if (filters.event_type && event.type !== filters.event_type) return false;
  return true;
}

function parseLastEventCount(value?: string) {
  const parsed = Number.parseInt(value ?? "20", 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 20;
  return Math.min(parsed, 100);
}

function formatSseEvent(event: HarnessEvent) {
  const lines = [
    event.event_id ? `id: ${event.event_id}` : null,
    `event: ${event.type}`,
    `data: ${JSON.stringify(event)}`,
    "",
    "",
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

function getReplayEvents(filters: EventStreamFilters, last: number) {
  if (last === 0) return [];
  return state.events
    .filter((event) => eventMatchesFilters(event, filters))
    .slice(0, last)
    .reverse();
}

function recordEvent(event: HarnessEvent | Record<string, unknown>) {
  const normalized = normalizeEventRecord(event) as any;
  if (normalized.event_id && state.processed_event_ids.includes(normalized.event_id)) return false;
  if (normalized.event_id) {
    state.processed_event_ids.unshift(normalized.event_id);
    if (state.processed_event_ids.length > 2000) state.processed_event_ids.length = 2000;
  }
  state.events.unshift(normalized as any);
  state.audit.unshift({ ...normalized, audit_id: makeId("audit") });
  if (state.events.length > 500) state.events.length = 500;
  if (state.audit.length > 1000) state.audit.length = 1000;
  Array.from(eventSubscribers.values()).forEach((subscriber) => {
    if (!subscriber.matches(normalized as HarnessEvent)) return;
    try {
      subscriber.enqueue(normalized as HarnessEvent);
    } catch {
      subscriber.close();
      eventSubscribers.delete(subscriber.id);
    }
  });
  return true;
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
    "step.progress": { kind: "step", title: "Step progress" },
    "step.blocked": { kind: "step", title: "Step blocked" },
    "step.paused": { kind: "step", title: "Step paused" },
    "step.resumed": { kind: "step", title: "Step resumed" },
    "step.completed": { kind: "step", title: "Step completed" },
    "step.failed": { kind: "step", title: "Step failed" },
    "step.cancelled": { kind: "step", title: "Step cancelled" },
    "step.retried": { kind: "step", title: "Step retried" },
    "run.started": { kind: "run", title: "Run started" },
    "run.running": { kind: "run", title: "Run running" },
    "run.paused": { kind: "run", title: "Run paused" },
    "run.completed": { kind: "run", title: "Run completed" },
    "run.failed": { kind: "run", title: "Run failed" },
    "run.cancelled": { kind: "run", title: "Run cancelled" },
    "mission.created": { kind: "mission", title: "Mission created" },
    "mission.updated": { kind: "mission", title: "Mission updated" },
    "mission.running": { kind: "mission", title: "Mission running" },
    "mission.paused": { kind: "mission", title: "Mission paused" },
    "mission.cancelled": { kind: "mission", title: "Mission cancelled" },
    "mission.completed": { kind: "mission", title: "Mission completed" },
    "tool.started": { kind: "tool", title: "Tool started" },
    "tool.completed": { kind: "tool", title: "Tool completed" },
    "tool.failed": { kind: "tool", title: "Tool failed" },
    "artifact.created": { kind: "artifact", title: "Artifact created" },
    "policy.violation": { kind: "policy", title: "Policy violation" },
    "execution.timeout": { kind: "execution", title: "Execution timeout" },
    "execution.budget_exceeded": { kind: "execution", title: "Execution budget exceeded" }
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
  const scored = scoreRun({ run, approvals });
  const evalDraft: EvalRecord = {
    mission_id: run.mission_id,
    run_id: run.run_id,
    outcome: scored.outcome,
    cost_usd: scored.cost_usd,
    approval_count: scored.approval_count,
    artifact_count: scored.artifact_count,
    duration_ms: scored.duration_ms,
    confidence: scored.confidence,
    efficiency_score: scored.efficiency_score,
    risk_score: scored.risk_score,
    created_at: new Date().toISOString(),
  };

  recordEvent({
    type: "eval.started",
    ts: evalDraft.created_at,
    mission_id: run.mission_id,
    run_id: run.run_id,
    payload: {
      outcome: evalDraft.outcome,
      approval_count: evalDraft.approval_count,
      artifact_count: evalDraft.artifact_count,
    } as any
  });

  try {
    const response = await fetch(`${evalApi}/api/evals`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(evalDraft),
    });
    if (!response.ok) throw new Error(`eval-api returned status ${response.status}`);
    const payload = await response.json() as { record?: EvalRecord };
    const record = payload.record ?? evalDraft;
    recordEvent({
      type: "eval.completed",
      ts: new Date().toISOString(),
      mission_id: run.mission_id,
      run_id: run.run_id,
      payload: {
        eval_id: record.eval_id,
        outcome: record.outcome,
        cost_usd: record.cost_usd,
        confidence: record.confidence,
        efficiency_score: record.efficiency_score,
        risk_score: record.risk_score,
        duration_ms: record.duration_ms,
      } as any
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordEvent({
      type: "eval.failed",
      ts: new Date().toISOString(),
      mission_id: run.mission_id,
      run_id: run.run_id,
      payload: {
        error: message,
        outcome: evalDraft.outcome,
      } as any
    });
    console.error("[orchestrator] recordEval failed (eval-api unavailable):", message);
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

async function listRunDirectoryIds(root: string) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && /^run_[a-zA-Z0-9_-]+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
}

function isTerminalRun(run: WorkflowRun) {
  return ["completed", "failed", "cancelled"].includes(run.status);
}

async function requestWorkerCleanup(runId: `run_${string}` | string, mission?: Mission, execution?: WorkerExecution | null) {
  const sourceRepo = execution?.sourceRepo ?? execution?.source_repo ?? mission?.repo_path;
  const branchName = execution?.branchName ?? execution?.branch_name ?? `hermes/${runId}`;
  const response = await fetch(`${workerApi}/api/cleanup-run`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ run_id: runId, source_repo: sourceRepo, branch_name: branchName })
  });
  if (!response.ok) throw new Error(`worker cleanup failed with status ${response.status}`);
  return { run_id: runId, source_repo: sourceRepo, branch_name: branchName };
}

async function sweepOrphanedExecutionWorkspaces() {
  const protectedRunIds = new Set(state.runs.filter((run) => !isTerminalRun(run)).map((run) => run.run_id));
  const runsById = new Map(state.runs.map((run) => [run.run_id, run]));
  const candidateRunIds = Array.from(new Set([
    ...(await listRunDirectoryIds(workerWorktreesRoot)),
    ...(await listRunDirectoryIds(workerRunsRoot)),
  ])).sort() as Array<`run_${string}`>;

  const removed_run_ids: string[] = [];
  const skipped_run_ids: string[] = [];

  for (const runId of candidateRunIds) {
    if (protectedRunIds.has(runId)) {
      skipped_run_ids.push(runId);
      continue;
    }

    const run = runsById.get(runId);
    const mission = run ? getMissionForRun(run) : undefined;
    await requestWorkerCleanup(runId, mission);
    removed_run_ids.push(runId);
  }

  return {
    scanned_run_ids: candidateRunIds,
    removed_run_ids,
    skipped_run_ids,
    removed_count: removed_run_ids.length,
    skipped_count: skipped_run_ids.length,
  };
}

async function cleanupExecutionWorkspace(run: WorkflowRun, mission?: Mission, execution?: WorkerExecution | null) {
  try {
    await requestWorkerCleanup(run.run_id, mission, execution ?? null);
  } catch (err) {
    console.error("[orchestrator] cleanupExecutionWorkspace failed (worker-api unavailable):", err instanceof Error ? err.message : err);
  }
}

function rejectPendingApprovalForCurrentStep(run: WorkflowRun, actor = "operator") {
  const current = getCurrentStep(run);
  if (!current?.approval_id) return undefined;
  const approval = state.approvals.find((item) => item.approval_id === current.approval_id && item.status === "pending");
  if (!approval) return undefined;
  approval.status = "rejected";
  approval.resolved_at = new Date().toISOString();
  approval.resolved_by = actor;
  recordEvent({ type: "approval.resolved", ts: approval.resolved_at, mission_id: approval.mission_id, run_id: approval.run_id, step_id: approval.step_id as `step_${string}`, actor, payload: { approval_id: approval.approval_id, decision: "rejected", resolved_at: approval.resolved_at, resolved_by: actor, reason: approval.reason, step_id: approval.step_id } as any });
  return approval;
}

async function failRun(run: WorkflowRun, stepId: string, summary: string, execution?: WorkerExecution | null) {
  const mission = getMissionForRun(run);
  markCurrentStepFailed(run, summary);
  await writebackStep(run, stepId, "failure", summary);
  updateMissionState(mission, "failed", summary, { run_id: run.run_id, step_id: stepId });
  recordEvent({ type: "step.failed", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: stepId as `step_${string}`, execution_id: execution?.execution_id, payload: { summary, execution } as any });
  recordRunStatusEvent(run, { step_id: stepId, execution_id: execution?.execution_id, summary });
  await recordEval(run, state.approvals.filter((item) => item.run_id === run.run_id));
  await cleanupExecutionWorkspace(run, mission, execution ?? null);
  await persist();
}

async function fetchWorkerExecution(request: StepExecutionRequest): Promise<WorkerExecution> {
  const response = await fetch(`${workerApi}/api/execute-step`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(request)
  });
  const payload = await response.json() as WorkerExecution & { error?: string; error_code?: string };
  if (!response.ok) {
    const error = new Error(payload.summary || payload.error || `worker execution failed with status ${response.status}`) as Error & { workerExecution?: WorkerExecution; statusCode?: number; errorCode?: string };
    error.workerExecution = payload;
    error.statusCode = response.status;
    error.errorCode = payload.error_code;
    throw error;
  }
  payload.execution_id ??= request.execution_id;
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
app.get("/api/events/stream", async (c) => {
  await ensureLoaded();
  const filters = normalizeSseFilters(c.req.query());
  const replay = getReplayEvents(filters, parseLastEventCount(c.req.query("last")));
  const subscriberId = makeId("sub");
  const encoder = new TextEncoder();
  let closed = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  const close = () => {
    if (closed) return;
    closed = true;
    eventSubscribers.delete(subscriberId);
    try {
      controllerRef?.close();
    } catch {}
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      replay.forEach((event) => controller.enqueue(encoder.encode(formatSseEvent(event))));
      eventSubscribers.set(subscriberId, {
        id: subscriberId,
        matches: (event) => eventMatchesFilters(event, filters),
        enqueue: (event) => {
          if (closed) return;
          controller.enqueue(encoder.encode(formatSseEvent(event)));
        },
        close,
      });
      c.req.raw.signal?.addEventListener("abort", close, { once: true });
    },
    cancel() {
      close();
    }
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    }
  });
});
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

app.post("/api/maintenance/sweep-orphans", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  await ensureLoaded();
  return c.json(await sweepOrphanedExecutionWorkspaces());
});

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
  if (mission.active_run_id && ["running", "awaiting_approval", "paused", "completed"].includes(mission.status)) return c.json({ error: "mission already started" }, 409);
  const run = createWorkflowRun(makeId("run") as `run_${string}`, mission.mission_id, mission.workflow);
  startCurrentStep(run);
  mission.active_run_id = run.run_id;
  updateMissionState(mission, run.status, "Mission started", { run_id: run.run_id, step_id: getCurrentStep(run)?.step_id });
  state.runs.push(run);
  recordEvent({ type: "run.started", ts: new Date().toISOString(), project_id: mission.project_id, mission_id: mission.mission_id, run_id: run.run_id, payload: run as any });
  recordRunStatusEvent(run, { step_id: getCurrentStep(run)?.step_id, summary: "Mission started" });
  recordEvent({ type: "step.started", ts: new Date().toISOString(), project_id: mission.project_id, mission_id: mission.mission_id, run_id: run.run_id, step_id: getCurrentStep(run)?.step_id as `step_${string}` | undefined, payload: { step_kind: getCurrentStep(run)?.kind, state: getCurrentStep(run)?.state } as any });
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
  if (run.status === "paused") return c.json({ error: "run paused" }, 409);
  if (["cancelled", "completed", "failed"].includes(run.status)) return c.json({ error: "run not executable" }, 409);
  const step = getCurrentStep(run);
  if (!step) return c.json({ error: "no current step" }, 400);

  const mission = getMissionForRun(run);
  let request: StepExecutionRequest;
  try {
    request = buildStepExecutionRequest(run, step, mission);
  } catch (error) {
    const summary = String(error instanceof Error ? error.message : error);
    recordEvent({ type: "policy.violation", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: step.step_id as `step_${string}`, execution_id: step.execution_id, payload: { reason: summary, violation_kind: "dispatch_envelope_invalid" } as any });
    await failRun(run, step.step_id, summary, step.execution_id ? { execution_id: step.execution_id, summary, confidence: 0, success: false, artifacts: [] } : null);
    return c.json({ run, error: summary }, 400);
  }

  startCurrentStep(run, request.execution_id);
  updateMissionState(mission, "running", `dispatching ${step.step_id}`, { run_id: run.run_id, step_id: step.step_id });
  recordRunStatusEvent(run, { step_id: step.step_id, execution_id: request.execution_id, summary: `dispatching ${step.step_id}` });
  recordEvent({ type: "step.started", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: step.step_id as `step_${string}`, execution_id: request.execution_id, payload: { step_kind: step.kind, envelope: summarizeEnvelope(request.envelope) } as any });
  await persist();

  let execution: WorkerExecution;
  try {
    execution = await fetchWorkerExecution(request);
  } catch (error) {
    const workerExecution = (error as Error & { workerExecution?: WorkerExecution }).workerExecution;
    for (const event of workerExecution?.step_events ?? []) {
      recordEvent(event);
    }
    const summary = String(error instanceof Error ? error.message : error);
    await failRun(run, step.step_id, summary, workerExecution ?? { execution_id: request.execution_id, summary, confidence: 0, success: false, artifacts: [] });
    return c.json({ run, error: summary, execution: workerExecution }, ((error as { statusCode?: number }).statusCode ?? 400) as 400);
  }

  for (let index = 0; index < execution.artifacts.length; index += 1) {
    const artifact = execution.artifacts[index]!;
    const artifactId = artifact.artifact_id ?? `art_${execution.execution_id}_${index + 1}`;
    const existing = run.steps.find((item) => item.step_id === step.step_id)?.artifacts.some((item) => item.artifact_id === artifactId);
    if (existing) continue;
    const artifactRef = { artifact_id: artifactId, type: artifact.type, uri: artifact.uri, content: artifact.content, metadata: artifact.metadata } as any;
    attachArtifact(run, step.step_id, artifactRef);
    recordEvent({ type: "artifact.created", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: step.step_id as `step_${string}`, execution_id: execution.execution_id, payload: { artifact_id: artifactId, kind: artifact.type, label: artifact.type, uri: artifact.uri, metadata: artifact.metadata } as any });
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
    recordEvent({ type: "policy.violation", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: step.step_id as `step_${string}`, execution_id: execution.execution_id, payload: { reason: policy.reason, violation_kind: "policy_engine_block" } as any });
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
    updateMissionState(mission, "awaiting_approval", approval.reason, { run_id: run.run_id, step_id: step.step_id });
    recordEvent({ type: "approval.requested", ts: requestedAt, mission_id: run.mission_id, run_id: run.run_id, step_id: step.step_id as `step_${string}`, execution_id: execution.execution_id, payload: approval as any });
    recordEvent({ type: "step.blocked", ts: requestedAt, mission_id: run.mission_id, run_id: run.run_id, step_id: step.step_id as `step_${string}`, execution_id: execution.execution_id, payload: { approval_id: approval.approval_id, reason: approval.reason } as any });
    await persist();
    return c.json({ run, approval, policy, execution, execution_result: executionResult });
  }

  markCurrentStepCompleted(run, execution.summary);
  await writebackStep(run, step.step_id, "success", execution.summary);
  updateMissionState(mission, run.status as Mission["status"], execution.summary, { run_id: run.run_id, step_id: step.step_id });
  recordEvent({ type: "step.completed", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: step.step_id as `step_${string}`, execution_id: execution.execution_id, payload: { policy, execution, execution_result: executionResult } as any });
  const next = getCurrentStep(run);
  if (next && run.status !== "completed") {
    startCurrentStep(run);
    recordRunStatusEvent(run, { step_id: next.step_id, summary: execution.summary });
    recordEvent({ type: "step.started", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: next.step_id as `step_${string}`, payload: { step_kind: next.kind, state: next.state } as any });
  } else {
    recordRunStatusEvent(run, { step_id: step.step_id, execution_id: execution.execution_id, summary: execution.summary });
    await recordEval(run, state.approvals.filter((item) => item.run_id === run.run_id));
    await cleanupExecutionWorkspace(run, mission, execution);
  }
  await persist();
  return c.json({ run, policy, execution, execution_result: executionResult });
});

app.post("/api/runs/:id/interrupt-step", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  await ensureLoaded();
  const run = state.runs.find((item) => item.run_id === c.req.param("id"));
  if (!run) return c.json({ error: "run not found" }, 404);
  const mission = getMissionForRun(run);
  const current = getCurrentStep(run);
  if (!current || current.state !== "running") return c.json({ error: "current step not running" }, 409);
  pauseCurrentStep(run, "operator interrupted current step");
  updateMissionState(mission, "paused", "operator interrupted current step", { run_id: run.run_id, step_id: current.step_id, actor: "operator" });
  recordRunStatusEvent(run, { step_id: current.step_id, actor: "operator", execution_id: current.execution_id, summary: "operator interrupted current step" });
  recordEvent({ type: "step.paused", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: current.step_id as `step_${string}`, actor: "operator", execution_id: current.execution_id, payload: { control_action: "interrupt", reason: "operator interrupted current step" } as any });
  await persist();
  return c.json({ run, mission });
});

app.post("/api/runs/:id/resume-step", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  await ensureLoaded();
  const run = state.runs.find((item) => item.run_id === c.req.param("id"));
  if (!run) return c.json({ error: "run not found" }, 404);
  const mission = getMissionForRun(run);
  const current = getCurrentStep(run);
  if (!current || current.state !== "paused" || run.status !== "paused") return c.json({ error: "current step not paused" }, 409);
  resumeCurrentStep(run, "operator resumed current step");
  updateMissionState(mission, "running", "operator resumed current step", { run_id: run.run_id, step_id: current.step_id, actor: "operator" });
  recordRunStatusEvent(run, { step_id: current.step_id, actor: "operator", execution_id: current.execution_id, summary: "operator resumed current step" });
  recordEvent({ type: "step.resumed", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: current.step_id as `step_${string}`, actor: "operator", execution_id: current.execution_id, payload: { resumed: true } as any });
  await persist();
  return c.json({ run, mission });
});

app.post("/api/runs/:id/retry-step", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  await ensureLoaded();
  const run = state.runs.find((item) => item.run_id === c.req.param("id"));
  if (!run) return c.json({ error: "run not found" }, 404);
  const mission = getMissionForRun(run);
  const current = getCurrentStep(run);
  if (!current || !["failed", "paused", "cancelled", "blocked", "awaiting_approval"].includes(current.state)) return c.json({ error: "current step not retryable" }, 409);
  const previousExecutionId = current.execution_id;
  retryCurrentStep(run, "operator retried current step");
  updateMissionState(mission, "running", "operator retried current step", { run_id: run.run_id, step_id: current.step_id, actor: "operator" });
  recordRunStatusEvent(run, { step_id: current.step_id, actor: "operator", summary: "operator retried current step" });
  recordEvent({ type: "step.retried", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: current.step_id as `step_${string}`, actor: "operator", execution_id: previousExecutionId, payload: { previous_execution_id: previousExecutionId } as any });
  await persist();
  return c.json({ run, mission });
});

app.post("/api/runs/:id/cancel-step", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  await ensureLoaded();
  const run = state.runs.find((item) => item.run_id === c.req.param("id"));
  if (!run) return c.json({ error: "run not found" }, 404);
  const mission = getMissionForRun(run);
  const current = getCurrentStep(run);
  if (!current || ["completed", "failed", "cancelled"].includes(current.state)) return c.json({ error: "current step not cancellable" }, 409);
  const approval = rejectPendingApprovalForCurrentStep(run);
  cancelCurrentStep(run, "operator cancelled current step");
  updateMissionState(mission, "cancelled", "operator cancelled current step", { run_id: run.run_id, step_id: current.step_id, actor: "operator" });
  recordRunStatusEvent(run, { step_id: current.step_id, actor: "operator", execution_id: current.execution_id, summary: "operator cancelled current step" });
  recordEvent({ type: "step.cancelled", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: current.step_id as `step_${string}`, actor: "operator", execution_id: current.execution_id, payload: { control_action: "cancel_step" } as any });
  await persist();
  return c.json({ run, mission, approval });
});

app.post("/api/runs/:id/cancel", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  await ensureLoaded();
  const run = state.runs.find((item) => item.run_id === c.req.param("id"));
  if (!run) return c.json({ error: "run not found" }, 404);
  if (["completed", "failed", "cancelled"].includes(run.status)) return c.json({ error: "run not cancellable" }, 409);
  const mission = getMissionForRun(run);
  const current = getCurrentStep(run);
  if (!current) return c.json({ error: "no current step" }, 400);
  const approval = rejectPendingApprovalForCurrentStep(run);
  cancelCurrentStep(run, "operator cancelled run");
  updateMissionState(mission, "cancelled", "operator cancelled run", { run_id: run.run_id, step_id: current.step_id, actor: "operator" });
  recordRunStatusEvent(run, { step_id: current.step_id, actor: "operator", execution_id: current.execution_id, summary: "operator cancelled run" });
  recordEvent({ type: "step.cancelled", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: current.step_id as `step_${string}`, actor: "operator", execution_id: current.execution_id, payload: { control_action: "cancel_run" } as any });
  await persist();
  return c.json({ run, mission, approval });
});

app.post("/api/runs/:id/artifacts", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  await ensureLoaded();
  const run = state.runs.find((item) => item.run_id === c.req.param("id"));
  if (!run) return c.json({ error: "run not found" }, 404);
  const body = await c.req.json<{ step_id: string; type: string; artifact_id?: string; content?: string; uri?: string; metadata?: Record<string, unknown> }>();
  const existing = run.steps.find((item) => item.step_id === body.step_id)?.artifacts.find((item) => item.artifact_id === body.artifact_id);
  if (existing) return c.json(existing);
  const artifact = { artifact_id: body.artifact_id ?? makeId("art"), type: body.type, kind: body.type, label: body.type, uri: body.uri ?? `artifact://${run.run_id}/${body.step_id}/${body.type}`, content: body.content, metadata: body.metadata };
  attachArtifact(run, body.step_id, artifact);
  recordEvent({ type: "artifact.created", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: body.step_id as `step_${string}`, payload: { artifact_id: artifact.artifact_id, kind: artifact.kind, label: artifact.label, uri: artifact.uri, metadata: artifact.metadata } as any });
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
    recordEvent({ type: "policy.violation", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: step.step_id as `step_${string}`, payload: { reason: policy.reason, violation_kind: "policy_engine_block" } as any });
    await failRun(run, step.step_id, policy.reason, null);
    return c.json({ run, policy }, 400);
  }
  if (policy.requires_approval) {
    const requestedAt = new Date().toISOString();
    const approval = normalizeApproval({ approval_id: makeId("approval") as `approval_${string}`, mission_id: run.mission_id, run_id: run.run_id, step_id: step.step_id, status: "pending", reason: policy.reason, decision_scope: "step", requested_at: requestedAt });
    state.approvals.unshift(approval);
    markCurrentStepAwaitingApproval(run, approval.approval_id, "step completed", policy.reason);
    const mission = getMissionForRun(run);
    updateMissionState(mission, "awaiting_approval", approval.reason, { run_id: run.run_id, step_id: step.step_id });
    recordEvent({ type: "approval.requested", ts: requestedAt, mission_id: run.mission_id, run_id: run.run_id, step_id: step.step_id as `step_${string}`, payload: approval as any });
    recordEvent({ type: "step.blocked", ts: requestedAt, mission_id: run.mission_id, run_id: run.run_id, step_id: step.step_id as `step_${string}`, payload: { approval_id: approval.approval_id, reason: approval.reason } as any });
    await persist();
    return c.json({ run, approval, policy });
  }
  markCurrentStepCompleted(run, "step completed");
  await writebackStep(run, step.step_id, "success", `Step ${step.step_id} completed successfully`);
  const mission = getMissionForRun(run);
  updateMissionState(mission, run.status as Mission["status"], "step completed", { run_id: run.run_id, step_id: step.step_id });
  recordEvent({ type: "step.completed", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: step.step_id as `step_${string}`, payload: { policy } as any });
  const next = getCurrentStep(run);
  if (next && run.status !== "completed") {
    startCurrentStep(run);
    recordRunStatusEvent(run, { step_id: next.step_id, summary: "step completed" });
    recordEvent({ type: "step.started", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: next.step_id as `step_${string}`, payload: { step_kind: next.kind, state: next.state } as any });
  } else {
    recordRunStatusEvent(run, { step_id: step.step_id, summary: "step completed" });
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
  recordEvent({ type: "approval.resolved", ts: approvalResult.resolved_at, mission_id: mission.mission_id, run_id: run.run_id, step_id: approval.step_id as `step_${string}`, actor: approval.resolved_by, payload: approvalResult as any });

  if (body.decision === "rejected") {
    markCurrentStepFailed(run, `Approval rejected for ${approval.step_id}`);
    updateMissionState(mission, "failed", `Approval rejected for ${approval.step_id}`, { run_id: run.run_id, step_id: approval.step_id, actor: approval.resolved_by });
    await writebackStep(run, approval.step_id, "failure", `Approval rejected for ${approval.step_id}`);
    recordEvent({ type: "step.failed", ts: new Date().toISOString(), mission_id: mission.mission_id, run_id: run.run_id, step_id: approval.step_id as `step_${string}`, actor: approval.resolved_by, payload: { approval_id: approval.approval_id, reason: approval.reason } as any });
    recordRunStatusEvent(run, { step_id: approval.step_id, actor: approval.resolved_by, summary: approval.reason });
    await recordEval(run, state.approvals.filter((item) => item.run_id === run.run_id));
    await cleanupExecutionWorkspace(run, mission, null);
    await persist();
    return c.json({ approval, run });
  }

  markCurrentStepCompleted(run, current.notes ?? `Approval granted for ${approval.step_id}`);
  await writebackStep(run, approval.step_id, "success", `Approval granted for ${approval.step_id}`);
  updateMissionState(mission, run.status as Mission["status"], current.notes ?? `Approval granted for ${approval.step_id}`, { run_id: run.run_id, step_id: approval.step_id, actor: approval.resolved_by });
  recordEvent({ type: "step.completed", ts: new Date().toISOString(), mission_id: mission.mission_id, run_id: run.run_id, step_id: approval.step_id as `step_${string}`, actor: approval.resolved_by, payload: { approval_id: approval.approval_id, decision: body.decision } as any });
  const next = getCurrentStep(run);
  const shouldStartNext = !!next && !["completed", "failed", "awaiting_approval", "cancelled"].includes(run.status);
  if (shouldStartNext && next) {
    startCurrentStep(run);
    recordRunStatusEvent(run, { step_id: next.step_id, actor: approval.resolved_by, summary: current.notes ?? `Approval granted for ${approval.step_id}` });
    recordEvent({ type: "step.started", ts: new Date().toISOString(), mission_id: mission.mission_id, run_id: run.run_id, step_id: next.step_id as `step_${string}`, payload: { step_kind: next.kind, state: next.state } as any });
  } else {
    recordRunStatusEvent(run, { step_id: approval.step_id, actor: approval.resolved_by, summary: current.notes ?? `Approval granted for ${approval.step_id}` });
    await recordEval(run, state.approvals.filter((item) => item.run_id === run.run_id));
    await cleanupExecutionWorkspace(run, mission, null);
  }
  await persist();
  return c.json({ approval, run });
});

if (!process.env.VITEST) {
  serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 4302) });
  console.log("orchestrator-api listening on http://localhost:4302");
  if (Number.isFinite(orphanSweepIntervalMs) && orphanSweepIntervalMs > 0) {
    const timer = setInterval(() => {
      void ensureLoaded()
        .then(() => sweepOrphanedExecutionWorkspaces())
        .then((result) => {
          if (result.removed_count > 0) console.log(`[orchestrator] orphan sweep removed ${result.removed_count} run workspace(s)`);
        })
        .catch((err) => console.error("[orchestrator] orphan sweep failed:", err instanceof Error ? err.message : err));
    }, orphanSweepIntervalMs);
    timer.unref?.();
    console.log(`[orchestrator] orphan sweep enabled every ${orphanSweepIntervalMs}ms`);
  }
}

export { app };
