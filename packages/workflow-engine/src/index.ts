import {
  ApprovalMode,
  StepState,
  type ArtifactRef,
  type Run,
  type Step,
  type StepKind,
} from "@hermes-harness-with-missioncontrol/contracts";

export type StepStatus = StepState;

export interface WorkflowStepTemplate {
  id: string;
  title: string;
  kind: StepKind;
  risk: "low" | "medium" | "high";
}

export interface WorkflowArtifact extends ArtifactRef {
  type?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkflowRunStep extends Step {
  risk: "low" | "medium" | "high";
  artifacts: WorkflowArtifact[];
}

export interface WorkflowRun extends Run {
  workflow_id: string;
  current_step_index: number;
  steps: WorkflowRunStep[];
}

type StepTransition =
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked";

export const WORKFLOW_LIBRARY: Record<string, WorkflowStepTemplate[]> = {
  bugfix: [
    { id: "plan", title: "Plan fix", kind: "plan", risk: "low" },
    { id: "implement", title: "Implement patch", kind: "implement", risk: "medium" },
    { id: "test", title: "Run tests", kind: "test", risk: "low" },
    { id: "review", title: "Review diff", kind: "review", risk: "medium" },
    { id: "deploy", title: "Canary deploy", kind: "deploy", risk: "high" }
  ],
  dependency_upgrade: [
    { id: "plan", title: "Plan upgrade", kind: "plan", risk: "low" },
    { id: "implement", title: "Update dependency", kind: "implement", risk: "medium" },
    { id: "test", title: "Run regression tests", kind: "test", risk: "low" },
    { id: "review", title: "Review change", kind: "review", risk: "medium" }
  ]
};

function toApprovalMode(): ApprovalMode {
  return ApprovalMode.OnPolicyTrigger;
}

function buildStep(template: WorkflowStepTemplate): WorkflowRunStep {
  return {
    step_id: template.id,
    title: template.title,
    kind: template.kind,
    state: StepState.Pending,
    approval_mode: toApprovalMode(),
    risk: template.risk,
    artifacts: []
  };
}

export function createWorkflowRun(run_id: `run_${string}`, mission_id: `mis_${string}`, workflow_id: string): WorkflowRun {
  const now = new Date().toISOString();
  const template = WORKFLOW_LIBRARY[workflow_id] ?? WORKFLOW_LIBRARY.bugfix;
  const run: WorkflowRun = {
    run_id,
    mission_id,
    workflow_id,
    status: "pending",
    current_step_index: 0,
    current_step_id: template[0]?.id,
    steps: template.map(buildStep),
    created_at: now,
    updated_at: now
  };
  return syncRunState(run);
}

function syncRunState(run: WorkflowRun): WorkflowRun {
  const current = getCurrentStep(run);
  run.current_step_id = current?.step_id;

  const firstStarted = run.steps.find((step) => !!step.started_at)?.started_at;
  if (firstStarted) run.started_at ??= firstStarted;

  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
    const terminalStep = [...run.steps].reverse().find((step) => !!step.completed_at);
    run.completed_at = terminalStep?.completed_at ?? run.completed_at ?? new Date().toISOString();
  } else {
    run.completed_at = undefined;
  }

  const currentApproval = run.steps.find((step) => step.state === "awaiting_approval")?.approval_id;
  run.approval_id = currentApproval;

  const terminalStep = [...run.steps].reverse().find((step) => !!step.notes);
  run.summary = terminalStep?.notes ?? run.summary;
  return run;
}

export function getCurrentStep(run: WorkflowRun): WorkflowRunStep | undefined {
  return run.steps[run.current_step_index];
}

function transitionCurrentStep(
  run: WorkflowRun,
  state: StepTransition,
  options: {
    notes?: string;
    execution_id?: string;
    approval_id?: string;
    blocked_reason?: string;
  } = {}
): WorkflowRun {
  const current = getCurrentStep(run);
  if (!current) return run;

  const now = new Date().toISOString();
  current.state = state;
  if (options.execution_id) current.execution_id = options.execution_id;
  if (options.approval_id !== undefined) current.approval_id = options.approval_id;
  if (options.notes !== undefined) current.notes = options.notes;
  if (options.blocked_reason !== undefined) current.blocked_reason = options.blocked_reason;

  if (state === "running") {
    current.started_at ??= now;
    run.status = "running";
  } else if (state === "awaiting_approval") {
    run.status = "awaiting_approval";
  } else if (state === "completed") {
    current.completed_at = now;
    const nextIndex = run.current_step_index + 1;
    if (nextIndex >= run.steps.length) {
      run.status = "completed";
    } else {
      run.current_step_index = nextIndex;
      run.status = "running";
    }
  } else if (state === "cancelled") {
    current.completed_at = now;
    run.status = "cancelled";
  } else {
    current.completed_at = now;
    run.status = "failed";
  }

  run.updated_at = now;
  return syncRunState(run);
}

export function startCurrentStep(run: WorkflowRun, execution_id?: string): WorkflowRun {
  return transitionCurrentStep(run, "running", { execution_id });
}

export function markCurrentStepAwaitingApproval(run: WorkflowRun, approval_id: string, notes?: string): WorkflowRun {
  return transitionCurrentStep(run, "awaiting_approval", { approval_id, notes });
}

export function markCurrentStepCompleted(run: WorkflowRun, notes?: string): WorkflowRun {
  return transitionCurrentStep(run, "completed", { notes });
}

export function markCurrentStepFailed(run: WorkflowRun, notes?: string): WorkflowRun {
  return transitionCurrentStep(run, "failed", { notes });
}

export function markCurrentStepCancelled(run: WorkflowRun, notes?: string): WorkflowRun {
  return transitionCurrentStep(run, "cancelled", { notes });
}

export function markCurrentStepBlocked(run: WorkflowRun, blocked_reason: string, notes?: string): WorkflowRun {
  return transitionCurrentStep(run, "blocked", { blocked_reason, notes });
}

export function advanceRun(run: WorkflowRun, status: Extract<StepTransition, "completed" | "failed" | "awaiting_approval">, notes?: string): WorkflowRun {
  if (status === "completed") return markCurrentStepCompleted(run, notes);
  if (status === "awaiting_approval") return markCurrentStepAwaitingApproval(run, getCurrentStep(run)?.approval_id ?? "approval_pending", notes);
  return markCurrentStepFailed(run, notes);
}

export function attachArtifact(run: WorkflowRun, step_id: string, artifact: WorkflowArtifact): WorkflowRun {
  const step = run.steps.find((item) => item.step_id === step_id);
  if (step) {
    step.artifacts.push({
      ...artifact,
      kind: artifact.kind ?? artifact.type ?? "artifact",
      label: artifact.label ?? artifact.kind ?? artifact.type ?? "artifact"
    });
  }
  run.updated_at = new Date().toISOString();
  return run;
}
