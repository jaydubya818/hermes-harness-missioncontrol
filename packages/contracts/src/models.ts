import type {
  ApprovalMode,
  FinalOutcome,
  MissionState,
  RunState,
  StepKind,
  StepState,
} from "./enums.js";

export interface Mission {
  mission_id: string;
  title: string;
  objective?: string;
  workflow: string;
  project_id: string;
  policy_ref?: string;
  profile_ref?: string;
  repo_path?: string;
  workspace_root?: string;
  status: MissionState;
  active_run_id?: string;
  summary?: string;
  created_at: string;
  updated_at: string;
}

export interface Run {
  run_id: string;
  mission_id: string;
  status: RunState;
  current_step_id?: string;
  started_at?: string;
  completed_at?: string;
  approval_id?: string;
  summary?: string;
  created_at: string;
  updated_at: string;
}

export interface Step {
  step_id: string;
  kind: StepKind;
  title: string;
  state: StepState;
  approval_mode: ApprovalMode;
  risk?: "low" | "medium" | "high";
  execution_id?: string;
  approval_id?: string;
  started_at?: string;
  completed_at?: string;
  blocked_reason?: string;
  notes?: string;
  artifacts: ArtifactRef[];
}

export interface ArtifactRef {
  artifact_id: string;
  kind: string;
  uri: string;
  label: string;
  content_type?: string;
  created_at?: string;
  metadata?: Record<string, unknown>;
}

export interface ApprovalRequest {
  approval_id: string;
  mission_id: string;
  run_id: string;
  step_id: string;
  reason: string;
  decision_scope: "step" | "run";
  requested_at: string;
}

export interface ApprovalResult {
  approval_id: string;
  decision: "approved" | "rejected";
  resolved_at: string;
  resolved_by?: string;
}

export interface TaskExecutionResult {
  execution_id: string;
  mission_id: string;
  run_id: string;
  step_id: string;
  final_outcome: FinalOutcome;
  summary: string;
  artifacts: ArtifactRef[];
  changed_files: string[];
  issues: string[];
  approval_needed: boolean;
  recommended_next_step?: StepKind;
  confidence?: number;
  command_refs?: Array<{
    kind: string;
    label: string;
    ref: string;
  }>;
}

export interface StartStepAccepted {
  execution_id: string;
  accepted: boolean;
  status: "running" | "queued";
  stream_url?: string;
}
