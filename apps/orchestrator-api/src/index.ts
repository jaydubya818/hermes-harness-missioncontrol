import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { relative, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { readdir } from "node:fs/promises";
import { attachArtifact, createWorkflowRun, getCurrentStep, startCurrentStep, markCurrentStepAwaitingApproval, markCurrentStepCompleted, markCurrentStepFailed, pauseCurrentStep, resumeCurrentStep, retryCurrentStep, cancelCurrentStep, syncRunState, WORKFLOW_LIBRARY, type WorkflowArtifact, type WorkflowRun } from "@hermes-harness-with-missioncontrol/workflow-engine";
import { evaluateStepPolicy } from "@hermes-harness-with-missioncontrol/policy-engine";
import { loadJsonFile, saveJsonFile } from "@hermes-harness-with-missioncontrol/state-store";
import { makeId, type HarnessEvent } from "@hermes-harness-with-missioncontrol/shared-types";
import { scoreRun, type EvalRecord } from "@hermes-harness-with-missioncontrol/eval-core";
import { FinalOutcome, type ApprovalRequest, type ApprovalResult, type ArtifactRef, type ExecutionEnvelope, type StepExecutionRequest, type TaskExecutionResult } from "@hermes-harness-with-missioncontrol/contracts";

const app = new Hono();
const stateFile = process.env.ORCHESTRATOR_STATE_FILE ?? resolve(process.cwd(), "../../data/orchestrator-state.json");
const memoryApi = process.env.MEMORY_API_URL ?? "http://localhost:4301";
const evalApi = process.env.EVAL_API_URL ?? "http://localhost:4303";
const workerApi = process.env.WORKER_API_URL ?? "http://localhost:4304";
const workerRunsRoot = resolve(process.env.WORKER_RUNTIME_ROOT ?? resolve(process.cwd(), "../../data/worker-runs"));
const workerWorktreesRoot = resolve(process.env.WORKTREE_ROOT ?? resolve(process.cwd(), "../../data/worktrees"));
const orphanSweepIntervalMs = Number(process.env.ORPHAN_SWEEP_INTERVAL_MS ?? "0");
// SSE comment frames keep idle streams alive through proxies/load balancers
// that drop quiet connections. Set to 0 to disable.
const sseHeartbeatMs = Number(process.env.SSE_HEARTBEAT_MS ?? "25000");
// Every open stream pins a ReadableStream controller plus a heartbeat timer
// and is fanned out to on every recorded event. Nothing closed the door on
// how many a client could open, so a loop of EventSource connections (or a
// client that reconnects without closing) grows the subscriber map without
// bound and multiplies per-event work. Set to 0 to disable the cap.
const sseMaxSubscribers = Number(process.env.SSE_MAX_SUBSCRIBERS ?? "64");
const allowedRepoRoot = resolve(process.env.ALLOWED_REPO_ROOT ?? "/Users/jaywest/projects");
const operatorToken = process.env.HARNESS_OPERATOR_TOKEN;
// Sidecar calls run inside lifecycle handlers; without a bound, one
// unresponsive service hangs the mission forever. Failures are already
// caught and logged by each caller.
const SIDECAR_TIMEOUT_MS = 10_000;
const CLEANUP_TIMEOUT_MS = 60_000;

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

  // Recommend the run's actual next step: a hardcoded "test" recommended
  // re-running tests after the test/review steps and recommended a next step
  // even when the workflow just finished on its last step.
  const stepIndex = run.steps.findIndex((step) => step.step_id === stepId);
  const nextStepKind = stepIndex === -1 ? undefined : run.steps[stepIndex + 1]?.kind;

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
    recommended_next_step: approvalNeeded ? undefined : nextStepKind,
    confidence: execution.confidence,
  };
}

const state: OrchestratorState = { missions: [], runs: [], approvals: [], events: [], audit: [], processed_event_ids: [] };
let initialized = false;
// O(1) companions to state.processed_event_ids / state.events so hot-path
// event recording does not scan arrays (2000-entry includes() per event).
const processedEventIdSet = new Set<string>();
let maxEventSequence = 0;

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
  const rel = relative(resolve(root), resolve(path));
  if (rel.startsWith("..")) throw new Error("path escapes allowed root");
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
  return maxEventSequence + 1;
}

function normalizeEventRecord(event: HarnessEvent | Record<string, unknown>) {
  const now = new Date().toISOString();
  const raw = event as any;
  return {
    schema_version: raw.schema_version ?? "v1",
    event_id: raw.event_id ?? makeId("evt"),
    timestamp: raw.timestamp ?? raw.ts ?? now,
    ts: raw.ts ?? raw.timestamp ?? now,
    // Sequences come from external sources too (worker step_events, persisted
    // state). Any finite number used to pass, so one negative, fractional, or
    // absurdly large value (e.g. 1e308) permanently poisoned maxEventSequence
    // and every internally minted sequence after it. Accept only positive
    // integers in the safe range; reassign anything else.
    sequence: Number.isInteger(raw.sequence) && raw.sequence > 0 && Number.isSafeInteger(raw.sequence) ? raw.sequence : nextEventSequence(),
    source: raw.source === "hermes" ? "hermes" : "missioncontrol",
    type: normalizeEventType(raw.type),
    project_id: raw.project_id,
    agent_id: raw.agent_id,
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
  const auth = Buffer.from(c.req.header("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${operatorToken}`);
  if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return c.json({ error: "unauthorized" }, 401);
  return null;
}

// EventSource cannot set request headers, so the SSE endpoint also accepts the
// operator token as a `token` query parameter.
function requireOperatorForStream(c: any) {
  if (!operatorToken) return null;
  const headerAuth = Buffer.from(c.req.header("authorization") ?? "");
  const expectedHeader = Buffer.from(`Bearer ${operatorToken}`);
  if (headerAuth.length === expectedHeader.length && timingSafeEqual(headerAuth, expectedHeader)) return null;
  const queryToken = Buffer.from(c.req.query("token") ?? "");
  const expectedToken = Buffer.from(operatorToken);
  if (queryToken.length === expectedToken.length && timingSafeEqual(queryToken, expectedToken)) return null;
  return c.json({ error: "unauthorized" }, 401);
}

async function parseJsonBody<T>(c: any): Promise<T | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" ? (body as T) : null;
  } catch {
    return null;
  }
}

let hydration: Promise<void> | null = null;

async function ensureLoaded() {
  if (initialized) return;
  // Hydration is not reentrant: two concurrent first requests would both
  // run the replay below, and the second one re-clears the dedupe set and
  // re-broadcasts replayed events to any SSE subscriber registered in
  // between. Run it once and share the in-flight promise.
  hydration ??= hydrateState().finally(() => {
    hydration = null;
  });
  await hydration;
}

async function hydrateState() {
  if (initialized) return;
  const loaded = await loadJsonFile<OrchestratorState>(stateFile, state);
  state.missions.splice(0, state.missions.length, ...(loaded.missions ?? []));
  state.runs.splice(0, state.runs.length, ...((loaded.runs ?? []).map((run) => syncRunState(run as WorkflowRun))));
  state.approvals.splice(0, state.approvals.length, ...((loaded.approvals ?? []).map((approval) => normalizeApproval(approval as Approval))));
  state.events.splice(0, state.events.length);
  state.audit.splice(0, state.audit.length);
  state.processed_event_ids.splice(0, state.processed_event_ids.length);
  processedEventIdSet.clear();
  maxEventSequence = 0;

  const normalizedEvents = (loaded.events ?? [])
    .flatMap((event) => {
      try {
        return [normalizeEventRecord(event)];
      } catch (err) {
        // ensureLoaded runs on every request, so one unrecognized persisted
        // event (e.g. written by a newer version) must not turn the whole
        // service into a 500 loop. Drop it and keep the rest of the state.
        console.warn("[orchestrator] skipping unrecognized persisted event:", err instanceof Error ? err.message : err);
        return [];
      }
    })
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const byTs = (a.event.ts ?? a.event.timestamp ?? "").localeCompare(b.event.ts ?? b.event.timestamp ?? "");
      // state.events persists newest-first, so within one timestamp the
      // higher persisted index is the older event. Without this tie-break a
      // stable ascending sort replays same-millisecond events newest-first,
      // and recordEvent's unshift then leaves them reversed in the retained
      // window (the older event surfaces as the latest in read models).
      return byTs !== 0 ? byTs : b.index - a.index;
    })
    .map(({ event }) => event);
  for (const event of normalizedEvents) {
    recordEvent(event);
  }

  // Replay above only repopulates ids for the retained event window (500
  // events), but processed ids persist up to 2000. Merge the older persisted
  // ids back in so replays of already-ingested events stay deduplicated
  // across restarts.
  if (Array.isArray(loaded.processed_event_ids)) {
    for (const eventId of loaded.processed_event_ids) {
      if (typeof eventId !== "string" || !eventId || processedEventIdSet.has(eventId)) continue;
      state.processed_event_ids.push(eventId);
      processedEventIdSet.add(eventId);
    }
    if (state.processed_event_ids.length > 2000) {
      for (const dropped of state.processed_event_ids.splice(2000)) processedEventIdSet.delete(dropped);
    }
  }

  // Replaying events above regenerates audit entries with fresh audit_ids
  // and can only rebuild the retained event window (500 events), while the
  // audit trail persists up to 1000 entries. Restore the persisted trail so
  // audit ids stay stable and older entries survive restarts.
  if (Array.isArray(loaded.audit) && loaded.audit.length > 0) {
    state.audit.splice(0, state.audit.length, ...loaded.audit.slice(0, 1000));
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

// Runs whose current step dispatch is currently in flight. A second
// concurrent execute-current for the same run would double-dispatch the
// worker and advance the workflow twice off a single real execution.
const inFlightDispatches = new Set<string>();

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

// Standard EventSource reconnects resend the last received `id:` via the
// Last-Event-ID header. Replaying everything after that id (instead of a
// fixed count) lets reconnecting consoles resume without dropping or
// duplicating events. Returns null when the id has already been evicted
// from the retained window, so callers can fall back to count-based replay.
function getReplayEventsSince(filters: EventStreamFilters, lastEventId: string) {
  const index = state.events.findIndex((event) => event.event_id === lastEventId);
  if (index === -1) return null;
  return state.events
    .slice(0, index)
    .filter((event) => eventMatchesFilters(event, filters))
    .reverse();
}

function recordEvent(event: HarnessEvent | Record<string, unknown>) {
  const normalized = normalizeEventRecord(event) as any;
  if (normalized.event_id && processedEventIdSet.has(normalized.event_id)) return false;
  if (normalized.event_id) {
    state.processed_event_ids.unshift(normalized.event_id);
    processedEventIdSet.add(normalized.event_id);
    if (state.processed_event_ids.length > 2000) {
      for (const dropped of state.processed_event_ids.splice(2000)) processedEventIdSet.delete(dropped);
    }
  }
  maxEventSequence = Math.max(maxEventSequence, Number(normalized.sequence) || 0);
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

// Worker step_events cross a service boundary. recordEvent throws on
// unrecognized event types, and one bad event from the worker must not 500
// the dispatch after the step already executed (stranding the run
// mid-step); drop the event and keep the lifecycle moving.
function recordExternalEvent(event: HarnessEvent | Record<string, unknown>) {
  try {
    return recordEvent(event);
  } catch (err) {
    console.warn("[orchestrator] skipping unrecognized worker event:", err instanceof Error ? err.message : err);
    return false;
  }
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
      // Failed is terminal too; counting failed missions as open double-counts
      // them against the separate failed_missions metric.
      open_missions: state.missions.filter((mission) => !["completed", "cancelled", "failed"].includes(mission.status)).length,
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
      // Missions choose a workflow at creation; without it here the console
      // cannot tell which workflow a queued mission will run.
      workflow: mission.workflow,
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
  const parsedLimit = Number(query.limit);
  const rawLimit = query.limit && Number.isFinite(parsedLimit) ? parsedLimit : (items.length || 1);
  const limit = Math.max(1, Math.min(100, Math.floor(rawLimit)));
  const parsedOffset = Number(query.offset ?? 0);
  const offset = Number.isFinite(parsedOffset) ? Math.max(0, Math.floor(parsedOffset)) : 0;
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

// Static event-type presentation metadata for the audit timeline. Hoisted:
// the console polls the audit read model every few seconds, and rebuilding
// this map on every call (five times per mission/run/step detail request)
// is pure allocation churn.
const AUDIT_EVENT_TITLES: Record<string, { kind: string; title: string }> = {
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
  "eval.started": { kind: "eval", title: "Eval started" },
  "eval.completed": { kind: "eval", title: "Eval completed" },
  "eval.failed": { kind: "eval", title: "Eval failed" },
  "policy.violation": { kind: "policy", title: "Policy violation" },
  "execution.timeout": { kind: "execution", title: "Execution timeout" },
  "execution.budget_exceeded": { kind: "execution", title: "Execution budget exceeded" }
};

function buildAuditReadModel(query: Record<string, string | undefined> = {}) {
  const timeline = state.events.map((event: any) => {
    const meta = AUDIT_EVENT_TITLES[event.type] ?? { kind: "event", title: String(event.type ?? "Event") };
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
  const { timeline, pagination: timelinePagination } = buildAuditReadModel({ mission_id: missionId });
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
      // The timeline above is a page (default cap 100); pagination.total is
      // the real event count for this scope.
      total_events: timelinePagination.total,
      recent: timeline.slice(0, 10)
    }
  };
}

function buildRunDetailReadModel(runId: string) {
  const run = state.runs.find((item) => item.run_id === runId);
  if (!run) return null;

  const mission = state.missions.find((item) => item.mission_id === run.mission_id);
  const approvals = state.approvals.filter((approval) => approval.run_id === runId);
  const { timeline, pagination: timelinePagination } = buildAuditReadModel({ run_id: runId });
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
      // The timeline above is a page (default cap 100); pagination.total is
      // the real event count for this scope.
      total_events: timelinePagination.total,
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
  const { timeline, pagination: timelinePagination } = buildAuditReadModel({ run_id: runId, step_id: stepId });

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
      // The timeline above is a page (default cap 100); pagination.total is
      // the real event count for this scope.
      total_events: timelinePagination.total,
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
      signal: AbortSignal.timeout(SIDECAR_TIMEOUT_MS),
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
  // Attribute the writeback to the mission's real project so memory lands
  // in the right wiki section instead of always polluting proj_demo.
  const projectId = getMissionForRun(run)?.project_id ?? "proj_demo";
  try {
    await fetch(`${memoryApi}/api/memory/tasks/close`, {
      method: "POST",
      headers: authHeaders(),
      signal: AbortSignal.timeout(SIDECAR_TIMEOUT_MS),
      body: JSON.stringify({
        agent_id: "agent_demo",
        project_id: projectId,
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
  const projectId = getMissionForRun(run)?.project_id ?? "proj_demo";
  try {
    await fetch(`${memoryApi}/api/memory/bus/publish`, {
      method: "POST",
      headers: authHeaders(),
      signal: AbortSignal.timeout(SIDECAR_TIMEOUT_MS),
      body: JSON.stringify({
        channel: "discovery",
        agent_id: "agent_demo",
        project_id: projectId,
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

async function requestWorkerCleanup(runId: `run_${string}` | string, mission?: Mission, execution?: WorkerExecution | null, removeOutputs = false) {
  const sourceRepo = execution?.sourceRepo ?? execution?.source_repo ?? mission?.repo_path;
  const branchName = execution?.branchName ?? execution?.branch_name ?? `hermes/${runId}`;
  const response = await fetch(`${workerApi}/api/cleanup-run`, {
    method: "POST",
    headers: authHeaders(),
    signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
    body: JSON.stringify({ run_id: runId, source_repo: sourceRepo, branch_name: branchName, remove_outputs: removeOutputs })
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
  const failed_run_ids: Array<{ run_id: string; error: string }> = [];

  for (const runId of candidateRunIds) {
    if (protectedRunIds.has(runId)) {
      skipped_run_ids.push(runId);
      continue;
    }

    const run = runsById.get(runId);
    const mission = run ? getMissionForRun(run) : undefined;
    try {
      // Orphans are gone from active use, so ask the worker to prune the
      // run output root too (normal terminal cleanup keeps it because
      // recorded artifacts reference files inside it).
      await requestWorkerCleanup(runId, mission, null, true);
      removed_run_ids.push(runId);
    } catch (err) {
      // One broken workspace must not abort the rest of the sweep.
      failed_run_ids.push({ run_id: runId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    scanned_run_ids: candidateRunIds,
    removed_run_ids,
    skipped_run_ids,
    failed_run_ids,
    removed_count: removed_run_ids.length,
    skipped_count: skipped_run_ids.length,
    failed_count: failed_run_ids.length,
  };
}

async function cleanupExecutionWorkspace(run: WorkflowRun, mission?: Mission, execution?: WorkerExecution | null) {
  try {
    await requestWorkerCleanup(run.run_id, mission, execution ?? null);
  } catch (err) {
    console.error("[orchestrator] cleanupExecutionWorkspace failed (worker-api unavailable):", err instanceof Error ? err.message : err);
  }
}

// Best-effort: tell the worker to abort an in-flight execution's child
// commands when the operator interrupts/cancels/retries the step. Without
// this the worker keeps mutating the worktree until the envelope timeout,
// and the result is only discarded after the fact. 404 (already settled)
// and transport failures are fine -- the stale-dispatch guard remains the
// authoritative protection.
async function requestWorkerAbort(executionId: string | undefined, reason: string) {
  if (!executionId) return;
  try {
    await fetch(`${workerApi}/api/abort-execution`, {
      method: "POST",
      headers: authHeaders(),
      signal: AbortSignal.timeout(SIDECAR_TIMEOUT_MS),
      body: JSON.stringify({ execution_id: executionId, reason })
    });
  } catch (err) {
    console.error("[orchestrator] requestWorkerAbort failed (worker-api unavailable):", err instanceof Error ? err.message : err);
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
    // The worker enforces the envelope timeout itself; the margin covers
    // workspace bootstrap and cleanup around the step execution.
    signal: AbortSignal.timeout((request.envelope.timeout_seconds + 60) * 1000),
    body: JSON.stringify(request)
  });
  let payload: WorkerExecution & { error?: string; error_code?: string };
  try {
    payload = await response.json() as WorkerExecution & { error?: string; error_code?: string };
  } catch {
    // A crashed worker or intermediary (proxy 502 page, empty body) answers
    // with non-JSON; surface the HTTP status instead of a bare JSON parse
    // error and keep the status code for the dispatch response.
    const error = new Error(`worker execution failed with status ${response.status} (non-JSON response)`) as Error & { statusCode?: number };
    error.statusCode = response.ok ? 502 : response.status;
    throw error;
  }
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


app.get("/health", async (c) => {
  await ensureLoaded();
  return c.json({ ok: true, service: "orchestrator-api", persisted_missions: state.missions.length });
});

app.get("/api/missions", async (c) => { const authError = requireOperator(c); if (authError) return authError; await ensureLoaded(); return c.json({ missions: state.missions }); });
app.get("/api/runs", async (c) => { const authError = requireOperator(c); if (authError) return authError; await ensureLoaded(); return c.json({ runs: state.runs }); });
app.get("/api/approvals", async (c) => { const authError = requireOperator(c); if (authError) return authError; await ensureLoaded(); return c.json({ approvals: state.approvals }); });
app.get("/api/events", async (c) => { const authError = requireOperator(c); if (authError) return authError; await ensureLoaded(); return c.json({ events: state.events }); });
app.get("/api/events/stream", async (c) => {
  const authError = requireOperatorForStream(c);
  if (authError) return authError;
  if (Number.isFinite(sseMaxSubscribers) && sseMaxSubscribers > 0 && eventSubscribers.size >= sseMaxSubscribers) {
    return c.json({ error: "too many concurrent event streams" }, 503);
  }
  await ensureLoaded();
  const filters = normalizeSseFilters(c.req.query());
  const lastEventId = c.req.header("last-event-id") ?? c.req.query("last_event_id");
  const replay = (lastEventId ? getReplayEventsSince(filters, lastEventId) : null)
    ?? getReplayEvents(filters, parseLastEventCount(c.req.query("last")));
  const subscriberId = makeId("sub");
  const encoder = new TextEncoder();
  let closed = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let heartbeat: NodeJS.Timeout | undefined;

  const close = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
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
      if (Number.isFinite(sseHeartbeatMs) && sseHeartbeatMs > 0) {
        heartbeat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(": keep-alive\n\n"));
          } catch {
            close();
          }
        }, sseHeartbeatMs);
        heartbeat.unref?.();
      }
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
app.get("/api/audit", async (c) => { const authError = requireOperator(c); if (authError) return authError; await ensureLoaded(); return c.json({ audit: state.audit }); });
app.get("/api/read-models/overview", async (c) => { const authError = requireOperator(c); if (authError) return authError; await ensureLoaded(); return c.json(buildOverviewReadModel()); });
app.get("/api/read-models/missions", async (c) => { const authError = requireOperator(c); if (authError) return authError; await ensureLoaded(); return c.json(buildMissionsReadModel()); });
app.get("/api/read-models/missions/:id", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  await ensureLoaded();
  const payload = buildMissionDetailReadModel(c.req.param("id"));
  if (!payload) return c.json({ error: "mission not found" }, 404);
  return c.json(payload);
});
app.get("/api/read-models/runs/:id", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  await ensureLoaded();
  const payload = buildRunDetailReadModel(c.req.param("id"));
  if (!payload) return c.json({ error: "run not found" }, 404);
  return c.json(payload);
});
app.get("/api/read-models/runs/:runId/steps/:stepId", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  await ensureLoaded();
  const payload = buildStepDetailReadModel(c.req.param("runId"), c.req.param("stepId"));
  if (!payload) return c.json({ error: "step not found" }, 404);
  return c.json(payload);
});
// The workflow catalog: mission creation validates workflow_id against
// this library, so operators (and the console's mission form) need a way to
// discover the valid ids and what each workflow runs.
app.get("/api/read-models/workflows", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  return c.json({
    workflows: Object.entries(WORKFLOW_LIBRARY).map(([workflow_id, steps]) => ({
      workflow_id,
      steps: steps.map((step) => ({ id: step.id, title: step.title, kind: step.kind, risk: step.risk }))
    }))
  });
});
app.get("/api/read-models/artifacts", async (c) => { const authError = requireOperator(c); if (authError) return authError; await ensureLoaded(); return c.json(buildArtifactsReadModel(c.req.query())); });
app.get("/api/read-models/approvals", async (c) => { const authError = requireOperator(c); if (authError) return authError; await ensureLoaded(); return c.json(buildApprovalsReadModel(c.req.query())); });
app.get("/api/read-models/approval-history", async (c) => { const authError = requireOperator(c); if (authError) return authError; await ensureLoaded(); return c.json(buildApprovalHistoryReadModel(c.req.query())); });
app.get("/api/read-models/audit", async (c) => { const authError = requireOperator(c); if (authError) return authError; await ensureLoaded(); return c.json(buildAuditReadModel(c.req.query())); });

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
  const body = await parseJsonBody<{ title: string; objective?: string; project_id: `proj_${string}`; workflow_id?: string; repo_path?: string; policy_ref?: string; profile_ref?: string; workspace_root?: string }>(c);
  if (!body) return c.json({ error: "invalid JSON body" }, 400);
  if (typeof body.title !== "string" || !body.title.trim()) return c.json({ error: "title required" }, 400);
  if (typeof body.project_id !== "string" || !body.project_id.startsWith("proj_")) return c.json({ error: "project_id must start with proj_" }, 400);
  // createWorkflowRun silently falls back to the bugfix workflow for unknown
  // ids, so a typo here would run the wrong workflow without any signal.
  if (body.workflow_id !== undefined && (typeof body.workflow_id !== "string" || !(body.workflow_id in WORKFLOW_LIBRARY))) {
    return c.json({ error: `workflow_id must be one of: ${Object.keys(WORKFLOW_LIBRARY).join(", ")}` }, 400);
  }
  // repo_path/workspace_root feed resolve() when the execution envelope is
  // built, so a non-string here creates a mission doomed to fail its first
  // dispatch with a TypeError-derived policy violation instead of a clear
  // 400 at creation time.
  for (const field of ["objective", "repo_path", "workspace_root", "policy_ref", "profile_ref"] as const) {
    const value = body[field];
    if (value !== undefined && (typeof value !== "string" || !value.trim())) {
      return c.json({ error: `${field} must be a non-empty string when provided` }, 400);
    }
  }
  // A repo_path/workspace_root outside ALLOWED_REPO_ROOT can never build a
  // valid execution envelope, so the mission would only exist to fail its
  // first dispatch with a policy violation. Reject it with a clear 400 at
  // creation instead; dispatch still re-validates as defense in depth for
  // missions hydrated from older persisted state.
  for (const field of ["repo_path", "workspace_root"] as const) {
    const value = body[field];
    if (typeof value !== "string") continue;
    try {
      relativeWithin(allowedRepoRoot, value);
    } catch {
      return c.json({ error: `${field} must resolve inside the allowed repo root` }, 400);
    }
  }
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

// Operator controls (interrupt/cancel/retry) and approval decisions can land
// while the worker call for a step is still in flight (up to the envelope
// timeout). Applying the worker's result afterwards would silently override
// the operator's decision -- e.g. mark a step the operator just paused or
// cancelled as completed and advance the run. A dispatch is stale when the
// run has moved past the dispatched step, the step left the running state,
// or a retry re-issued it under a new execution id.
function isDispatchStale(run: WorkflowRun, step: WorkflowRun["steps"][number], executionId: string) {
  return getCurrentStep(run) !== step || step.state !== "running" || step.execution_id !== executionId;
}

async function discardStaleDispatch(run: WorkflowRun, step: WorkflowRun["steps"][number], executionId: string, execution: WorkerExecution | undefined, c: any) {
  const summary = `worker result for ${step.step_id} discarded: run state changed during dispatch (step now ${step.state}${step.execution_id === executionId ? "" : ", execution superseded"})`;
  for (const event of execution?.step_events ?? []) {
    recordExternalEvent(event);
  }
  recordEvent({ type: "step.progress", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: step.step_id as `step_${string}`, execution_id: executionId, payload: { message: summary, discarded_execution_id: executionId, step_state: step.state } as any });
  // The discarded execution is dead. If the paused step still carries its id
  // (i.e. it was not already superseded by a retry), clear it so a later
  // resume + execute-current mints a fresh execution id: reusing the dead id
  // would make the new execution's worker events collide with the event_ids
  // recorded above and be silently dropped by replay dedupe.
  if (step.execution_id === executionId && step.state === "paused") {
    step.execution_id = undefined;
  }
  await persist();
  return c.json({ run, execution, error: summary }, 409);
}

app.post("/api/runs/:id/execute-current", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  await ensureLoaded();
  const run = state.runs.find((item) => item.run_id === c.req.param("id"));
  if (!run) return c.json({ error: "run not found" }, 404);
  if (run.status === "awaiting_approval") return c.json({ error: "run awaiting approval" }, 409);
  if (run.status === "paused") return c.json({ error: "run paused" }, 409);
  if (["cancelled", "completed", "failed"].includes(run.status)) return c.json({ error: "run not executable" }, 409);
  if (inFlightDispatches.has(run.run_id)) return c.json({ error: "step dispatch already in progress for this run" }, 409);
  inFlightDispatches.add(run.run_id);
  try {
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
    if (isDispatchStale(run, step, request.execution_id)) {
      return discardStaleDispatch(run, step, request.execution_id, workerExecution, c);
    }
    for (const event of workerExecution?.step_events ?? []) {
      recordExternalEvent(event);
    }
    const summary = String(error instanceof Error ? error.message : error);
    await failRun(run, step.step_id, summary, workerExecution ?? { execution_id: request.execution_id, summary, confidence: 0, success: false, artifacts: [] });
    return c.json({ run, error: summary, execution: workerExecution }, ((error as { statusCode?: number }).statusCode ?? 400) as 400);
  }

  if (isDispatchStale(run, step, request.execution_id)) {
    return discardStaleDispatch(run, step, request.execution_id, execution, c);
  }

  for (let index = 0; index < execution.artifacts.length; index += 1) {
    const artifact = execution.artifacts[index]!;
    const artifactId = artifact.artifact_id ?? `art_${execution.execution_id}_${index + 1}`;
    const existing = run.steps.find((item) => item.step_id === step.step_id)?.artifacts.some((item) => item.artifact_id === artifactId);
    if (existing) continue;
    // Stamp attach time: read models sort artifacts by created_at, and the
    // step-timestamp fallback gives every artifact of a step the same value.
    const artifactRef = { artifact_id: artifactId, type: artifact.type, uri: artifact.uri, content: artifact.content, metadata: artifact.metadata, created_at: new Date().toISOString() } as any;
    attachArtifact(run, step.step_id, artifactRef);
    recordEvent({ type: "artifact.created", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: step.step_id as `step_${string}`, execution_id: execution.execution_id, payload: { artifact_id: artifactId, kind: artifact.type, label: artifact.type, uri: artifact.uri, metadata: artifact.metadata } as any });
  }
  for (const event of execution.step_events ?? []) {
    recordExternalEvent(event);
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
  } finally {
    inFlightDispatches.delete(run.run_id);
  }
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
  const interruptedExecutionId = current.execution_id;
  pauseCurrentStep(run, "operator interrupted current step");
  await requestWorkerAbort(interruptedExecutionId, "operator interrupted current step");
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
  // Retrying an awaiting-approval step supersedes its pending approval;
  // without resolving it, the approval sits in the operator queue forever
  // (any later respond hits the staleness guard).
  const approval = rejectPendingApprovalForCurrentStep(run, "operator");
  const previousExecutionId = current.execution_id;
  retryCurrentStep(run, "operator retried current step");
  await requestWorkerAbort(previousExecutionId, "operator retried current step");
  updateMissionState(mission, "running", "operator retried current step", { run_id: run.run_id, step_id: current.step_id, actor: "operator" });
  recordRunStatusEvent(run, { step_id: current.step_id, actor: "operator", summary: "operator retried current step" });
  recordEvent({ type: "step.retried", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: current.step_id as `step_${string}`, actor: "operator", execution_id: previousExecutionId, payload: { previous_execution_id: previousExecutionId } as any });
  await persist();
  return c.json({ run, mission, approval });
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
  const cancelledExecutionId = current.execution_id;
  cancelCurrentStep(run, "operator cancelled current step");
  await requestWorkerAbort(cancelledExecutionId, "operator cancelled current step");
  updateMissionState(mission, "cancelled", "operator cancelled current step", { run_id: run.run_id, step_id: current.step_id, actor: "operator" });
  recordRunStatusEvent(run, { step_id: current.step_id, actor: "operator", execution_id: current.execution_id, summary: "operator cancelled current step" });
  recordEvent({ type: "step.cancelled", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: current.step_id as `step_${string}`, actor: "operator", execution_id: current.execution_id, payload: { control_action: "cancel_step" } as any });
  // Cancel is terminal like fail/complete: record the eval and release the
  // run's worktree/branch instead of leaving them for the orphan sweep.
  await recordEval(run, state.approvals.filter((item) => item.run_id === run.run_id));
  await cleanupExecutionWorkspace(run, mission, null);
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
  const cancelledExecutionId = current.execution_id;
  cancelCurrentStep(run, "operator cancelled run");
  await requestWorkerAbort(cancelledExecutionId, "operator cancelled run");
  updateMissionState(mission, "cancelled", "operator cancelled run", { run_id: run.run_id, step_id: current.step_id, actor: "operator" });
  recordRunStatusEvent(run, { step_id: current.step_id, actor: "operator", execution_id: current.execution_id, summary: "operator cancelled run" });
  recordEvent({ type: "step.cancelled", ts: new Date().toISOString(), mission_id: run.mission_id, run_id: run.run_id, step_id: current.step_id as `step_${string}`, actor: "operator", execution_id: current.execution_id, payload: { control_action: "cancel_run" } as any });
  // Cancel is terminal like fail/complete: record the eval and release the
  // run's worktree/branch instead of leaving them for the orphan sweep.
  await recordEval(run, state.approvals.filter((item) => item.run_id === run.run_id));
  await cleanupExecutionWorkspace(run, mission, null);
  await persist();
  return c.json({ run, mission, approval });
});

app.post("/api/runs/:id/artifacts", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  await ensureLoaded();
  const run = state.runs.find((item) => item.run_id === c.req.param("id"));
  if (!run) return c.json({ error: "run not found" }, 404);
  // Terminal runs are read-only history everywhere else (not cancellable,
  // not executable); attaching artifacts after the fact would mutate the
  // recorded outcome and fire artifact.created events on a closed run.
  if (isTerminalRun(run)) return c.json({ error: "run is terminal; artifacts cannot be attached" }, 409);
  const body = await parseJsonBody<{ step_id: string; type: string; artifact_id?: string; content?: string; uri?: string; metadata?: Record<string, unknown> }>(c);
  if (!body) return c.json({ error: "invalid JSON body" }, 400);
  const step = run.steps.find((item) => item.step_id === body.step_id);
  if (!step) return c.json({ error: "step not found" }, 404);
  if (typeof body.type !== "string" || !body.type.trim()) return c.json({ error: "type required" }, 400);
  // artifact_id keys idempotent re-attachment and read-model lookups; uri
  // and content land in read models and events. Non-string values here
  // would poison dedupe (every retry attaches a fresh copy) or crash
  // consumers that expect strings.
  if (body.artifact_id !== undefined && (typeof body.artifact_id !== "string" || !body.artifact_id.trim())) {
    return c.json({ error: "artifact_id must be a non-empty string when provided" }, 400);
  }
  for (const field of ["uri", "content"] as const) {
    if (body[field] !== undefined && typeof body[field] !== "string") {
      return c.json({ error: `${field} must be a string when provided` }, 400);
    }
  }
  if (body.metadata !== undefined && (typeof body.metadata !== "object" || body.metadata === null || Array.isArray(body.metadata))) {
    return c.json({ error: "metadata must be an object when provided" }, 400);
  }
  const existing = step.artifacts.find((item) => item.artifact_id === body.artifact_id);
  if (existing) return c.json(existing);
  const artifact = { artifact_id: body.artifact_id ?? makeId("art"), type: body.type, kind: body.type, label: body.type, uri: body.uri ?? `artifact://${run.run_id}/${body.step_id}/${body.type}`, content: body.content, metadata: body.metadata, created_at: new Date().toISOString() };
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
  // Only a running step is manually completable. Completing an
  // awaiting-approval step would re-run the policy gate below and mint a
  // second pending approval while the first sits in the operator queue
  // forever (any respond hits the staleness guard); completing a paused or
  // cancelled step would bypass resume/retry, and on a terminal run the
  // policy gate could still push a fresh approval and flip the mission back
  // to awaiting_approval.
  if (current.state !== "running") {
    return c.json({ error: `current step is ${current.state}, not running; respond to its approval or use resume/retry instead` }, 409);
  }
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
  const body = await parseJsonBody<{ decision: "approved" | "rejected"; actor?: string }>(c);
  if (!body) return c.json({ error: "invalid JSON body" }, 400);
  if (body.decision !== "approved" && body.decision !== "rejected") {
    return c.json({ error: "decision must be \"approved\" or \"rejected\"" }, 400);
  }
  // body.actor?.trim() below throws on non-strings, turning a malformed
  // payload into a 500 after the decision already validated.
  if (body.actor !== undefined && typeof body.actor !== "string") {
    return c.json({ error: "actor must be a string" }, 400);
  }
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
  const port = Number(process.env.PORT ?? 4302);
  // @hono/node-server binds 0.0.0.0 when no hostname is given, silently
  // exposing this operator-trust API to the local network. Default to
  // loopback; set HOST explicitly to opt into wider exposure.
  const hostname = process.env.HOST ?? "127.0.0.1";
  serve({ fetch: app.fetch, port, hostname });
  console.log(`orchestrator-api listening on http://${hostname}:${port}`);
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
