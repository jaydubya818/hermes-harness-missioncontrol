import type {
  ApprovalMode,
  ConnectorOperation,
  ExternalWorkItemHierarchy,
  ExternalWorkItemSystem,
  FactoryLoopType,
  FinalOutcome,
  LearningOutputType,
  LearningTrigger,
  MissionState,
  RiskDomain,
  RiskLevel,
  RunState,
  SourceOfTruthKind,
  StepKind,
  StepState,
  VerificationMethod,
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
  work_order_id?: string;
  source_of_truths?: SourceOfTruth[];
  outcome_metrics?: OutcomeMetrics;
  learning_candidates?: LearningCandidate[];
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

export interface ApprovalDecision extends ApprovalResult {
  actor?: string;
  decision_rationale?: string;
  evidence_refs?: string[];
}

export interface RepoScope {
  root_path: string;
  writable_paths: string[];
}

export interface ResourceBudget {
  token_budget: number;
  max_artifacts: number;
  max_output_bytes: number;
}

export interface SourceOfTruth {
  kind: SourceOfTruthKind;
  system: string;
  uri: string;
  writeback_required: boolean;
  verification_required: boolean;
  metadata?: Record<string, unknown>;
}

export interface ExternalWorkItem {
  system: ExternalWorkItemSystem;
  external_id: string;
  external_key: string;
  url?: string;
  hierarchy: ExternalWorkItemHierarchy;
  parent_external_key?: string;
  title: string;
  description?: string;
  status: string;
  assignee?: string;
  team?: string;
  priority?: string;
  acceptance_criteria?: AcceptanceCriterion[];
  labels?: string[];
  components?: string[];
  sprint?: string;
  updated_at: string;
  metadata?: Record<string, unknown>;
}

export interface FactoryMissionBinding {
  binding_id: string;
  mission_id: string;
  run_id?: string;
  work_items: ExternalWorkItem[];
  context_packet_uri?: string;
  receipt_packet_uri?: string;
  created_at: string;
  updated_at?: string;
}

export interface FactoryThroughputMetric {
  metric_id: string;
  generated_at: string;
  window_start: string;
  window_end: string;
  team?: string;
  assignee?: string;
  agent_id?: string;
  stories_closed: number;
  tasks_closed: number;
  active_runs: number;
  blocked_runs: number;
  approval_wait_count: number;
  verifier_failure_count: number;
  average_cycle_time_ms?: number;
  estimated_cost_usd?: number;
}

export interface ConnectorCapabilityScope {
  connector: ExternalWorkItemSystem | string;
  scopes: string[];
  secret_ref?: string;
  allowed_operations: ConnectorOperation[];
  risk_level: RiskLevel;
  expires_at?: string;
  metadata?: Record<string, unknown>;
}

export interface LoopPolicy {
  loop_type: FactoryLoopType;
  evaluator: VerificationMethod;
  max_attempts: number;
  max_runtime_seconds: number;
  max_cost_usd?: number;
  human_approval_required_after_attempts?: number;
  stop_on_verifier_failure?: boolean;
  metadata?: Record<string, unknown>;
}

export interface RiskClassification {
  level: RiskLevel;
  domains: RiskDomain[];
  rationale: string;
  reversible?: boolean;
  requires_human_approval?: boolean;
}

export interface AcceptanceCriterion {
  id: string;
  statement: string;
  verification_method: VerificationMethod;
  evidence_required?: boolean;
  expected_evidence?: string[];
}

export interface WorkOrderRepository {
  name: string;
  path: string;
  remote?: string;
  default_branch?: string;
}

export interface WorkOrderAmendment {
  amendment_id: string;
  amended_at: string;
  amended_by: string;
  reason: string;
  changes: Record<string, unknown>;
}

export interface WorkOrder {
  schema_version: string;
  work_order_id: string;
  title: string;
  goal: string;
  problem_statement: string;
  desired_outcome: string;
  repository: WorkOrderRepository;
  base_ref: string;
  acceptance_criteria: AcceptanceCriterion[];
  allowed_paths: string[];
  restricted_paths: string[];
  risk_classification: RiskClassification;
  required_human_approvals: string[];
  worker_profile: string;
  max_attempts: number;
  max_runtime_seconds: number;
  max_cost_usd: number;
  network_policy: "none" | "restricted" | "approved_domains" | "unrestricted";
  required_checks: string[];
  expected_artifacts: string[];
  source_of_truths: SourceOfTruth[];
  delivery_target: string;
  auto_merge_eligible: boolean;
  initiator: string;
  created_at: string;
  amendments: WorkOrderAmendment[];
}

export interface ExecutionEnvelope {
  worktree_path: string;
  workspace_root: string;
  repo_scope: RepoScope;
  allowed_tools: string[];
  allowed_actions: string[];
  approval_mode: ApprovalMode;
  timeout_seconds: number;
  resource_budget: ResourceBudget;
  output_dir: string;
  environment_classification: "sandbox" | "staging" | "production" | "local";
  work_order?: WorkOrder;
  source_of_truths?: SourceOfTruth[];
  connector_scopes?: ConnectorCapabilityScope[];
  loop_policy?: LoopPolicy;
}

export interface StepExecutionRequest {
  mission_id: string;
  run_id: string;
  step_id: string;
  execution_id: string;
  kind: StepKind;
  repo_path?: string;
  branch_name?: string;
  preferred_model?: string;
  /** @deprecated Use connector_scopes/secret_ref-backed provider resolution instead of raw request keys. */
  api_key?: string;
  envelope: ExecutionEnvelope;
}

export interface CheckResult {
  check_id: string;
  status: "passed" | "failed" | "skipped" | "inconclusive";
  summary?: string;
  evidence_refs: string[];
}

export interface AcceptanceVerificationResult {
  acceptance_criterion_id: string;
  status: "verified" | "failed" | "unverified" | "not_applicable";
  method?: VerificationMethod;
  evidence_refs: string[];
  notes?: string;
}

export interface VerificationReceipt {
  receipt_id: string;
  mission_id: string;
  run_id: string;
  work_order_id?: string;
  generated_at: string;
  verifier_id?: string;
  overall_status: "passed" | "failed" | "inconclusive";
  check_results: CheckResult[];
  acceptance_results: AcceptanceVerificationResult[];
  evidence_refs: string[];
  limitations?: string[];
}

export interface ArtifactManifest {
  manifest_id: string;
  mission_id: string;
  run_id: string;
  execution_id?: string;
  work_order_id?: string;
  generated_at: string;
  produced_by: string;
  artifacts: ArtifactRef[];
  trace_refs?: string[];
  completeness?: "complete" | "partial" | "missing_required_artifacts";
}

export interface OutcomeMetrics {
  mission_id: string;
  run_id: string;
  work_order_id?: string;
  generated_at: string;
  primary_outcome: string;
  total_cycle_time_ms?: number;
  queue_time_ms?: number;
  execution_time_ms?: number;
  verification_time_ms?: number;
  human_approval_time_ms?: number;
  worker_attempts?: number;
  worker_retries?: number;
  human_review_comment_count?: number;
  human_takeover_required?: boolean;
  checks_passed?: number;
  checks_failed?: number;
  verifier_failures?: number;
  acceptance_criteria_verified?: number;
  acceptance_criteria_total?: number;
  cost_by_model_or_worker?: Record<string, number>;
  pull_request_created?: boolean;
  pull_request_merged?: boolean;
  reverted?: boolean;
  escaped_defect?: boolean;
}

export interface LearningCandidate {
  learning_candidate_id: string;
  mission_id: string;
  run_id: string;
  work_order_id?: string;
  trigger: LearningTrigger;
  observation: string;
  category: string;
  evidence_refs: string[];
  frequency?: number;
  impact: "low" | "medium" | "high" | "critical";
  confidence: "low" | "medium" | "high";
  recommended_action: string;
  target: string;
  proposed_output_type: LearningOutputType;
  status?: "proposed" | "accepted" | "rejected" | "implemented" | "no_action";
  created_at: string;
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
  artifact_manifest?: ArtifactManifest;
  verification_receipt?: VerificationReceipt;
  outcome_metrics?: OutcomeMetrics;
  learning_candidates?: LearningCandidate[];
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
