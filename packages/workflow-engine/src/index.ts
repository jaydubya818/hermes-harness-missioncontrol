export type StepStatus = "pending" | "running" | "completed" | "failed" | "awaiting_approval";

export interface WorkflowStepTemplate {
  id: string;
  title: string;
  kind: "plan" | "implement" | "test" | "review" | "deploy";
  risk: "low" | "medium" | "high";
}

export interface WorkflowArtifact {
  artifact_id: string;
  type: string;
  uri: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkflowRunStep extends WorkflowStepTemplate {
  status: StepStatus;
  started_at?: string;
  completed_at?: string;
  artifacts: WorkflowArtifact[];
  notes?: string;
}

export interface WorkflowRun {
  run_id: `run_${string}`;
  mission_id: `mis_${string}`;
  workflow_id: string;
  status: "pending" | "running" | "completed" | "failed" | "awaiting_approval";
  current_step_index: number;
  steps: WorkflowRunStep[];
  created_at: string;
  updated_at: string;
}

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

export function createWorkflowRun(run_id: `run_${string}`, mission_id: `mis_${string}`, workflow_id: string): WorkflowRun {
  const now = new Date().toISOString();
  const template = WORKFLOW_LIBRARY[workflow_id] ?? WORKFLOW_LIBRARY.bugfix;
  return {
    run_id,
    mission_id,
    workflow_id,
    status: "pending",
    current_step_index: 0,
    steps: template.map((step) => ({ ...step, status: "pending", artifacts: [] })),
    created_at: now,
    updated_at: now
  };
}

export function getCurrentStep(run: WorkflowRun): WorkflowRunStep | undefined {
  return run.steps[run.current_step_index];
}

export function advanceRun(run: WorkflowRun, status: Extract<StepStatus, "completed" | "failed" | "awaiting_approval">, notes?: string): WorkflowRun {
  const current = getCurrentStep(run);
  if (!current) return run;
  const now = new Date().toISOString();
  current.status = status;
  current.completed_at = now;
  current.notes = notes;
  if (status === "completed") {
    const nextIndex = run.current_step_index + 1;
    if (nextIndex >= run.steps.length) {
      run.status = "completed";
    } else {
      run.current_step_index = nextIndex;
      run.status = "running";
    }
  } else if (status === "awaiting_approval") {
    run.status = "awaiting_approval";
  } else {
    run.status = "failed";
  }
  run.updated_at = now;
  return run;
}

export function startCurrentStep(run: WorkflowRun): WorkflowRun {
  const current = getCurrentStep(run);
  if (!current) return run;
  const now = new Date().toISOString();
  current.status = "running";
  current.started_at = now;
  run.status = "running";
  run.updated_at = now;
  return run;
}

export function attachArtifact(run: WorkflowRun, step_id: string, artifact: WorkflowArtifact): WorkflowRun {
  const step = run.steps.find((item) => item.id == step_id);
  if (step) step.artifacts.push(artifact);
  run.updated_at = new Date().toISOString();
  return run;
}
