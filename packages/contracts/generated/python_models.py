from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict

class MissionState(str, Enum):
    PENDING = 'pending'
    RUNNING = 'running'
    AWAITING_APPROVAL = 'awaiting_approval'
    PAUSED = 'paused'
    FAILED = 'failed'
    COMPLETED = 'completed'
    CANCELLED = 'cancelled'

class RunState(str, Enum):
    PENDING = 'pending'
    RUNNING = 'running'
    AWAITING_APPROVAL = 'awaiting_approval'
    PAUSED = 'paused'
    FAILED = 'failed'
    COMPLETED = 'completed'
    CANCELLED = 'cancelled'

class StepKind(str, Enum):
    PLAN = 'plan'
    IMPLEMENT = 'implement'
    TEST = 'test'
    REVIEW = 'review'
    DEPLOY = 'deploy'

class StepState(str, Enum):
    PENDING = 'pending'
    READY = 'ready'
    RUNNING = 'running'
    BLOCKED = 'blocked'
    AWAITING_APPROVAL = 'awaiting_approval'
    PAUSED = 'paused'
    FAILED = 'failed'
    COMPLETED = 'completed'
    CANCELLED = 'cancelled'

class ApprovalMode(str, Enum):
    NEVER = 'never'
    ON_POLICY_TRIGGER = 'on_policy_trigger'
    ALWAYS = 'always'

class FinalOutcome(str, Enum):
    SUCCESS = 'success'
    PARTIAL = 'partial'
    BLOCKED = 'blocked'
    FAILED = 'failed'
    CANCELLED = 'cancelled'

class EventSource(str, Enum):
    HERMES = 'hermes'
    MISSIONCONTROL = 'missioncontrol'
    PI = 'pi'
    WORKER = 'worker'
    GITHUB = 'github'
    VERIFIER = 'verifier'

class RiskLevel(str, Enum):
    LOW = 'low'
    MEDIUM = 'medium'
    HIGH = 'high'
    CRITICAL = 'critical'

class RiskDomain(str, Enum):
    UI = 'ui'
    COPY = 'copy'
    FORM_VALIDATION = 'form_validation'
    ACCESSIBILITY = 'accessibility'
    TESTS = 'tests'
    LOGGING = 'logging'
    ADMIN_UI = 'admin_ui'
    SEED_DATA = 'seed_data'
    REFACTOR = 'refactor'
    AUTH = 'auth'
    AUTHORIZATION = 'authorization'
    PAYMENTS = 'payments'
    DATABASE = 'database'
    INFRASTRUCTURE = 'infrastructure'
    SECRETS = 'secrets'
    EXTERNAL_INTEGRATIONS = 'external_integrations'
    SENSITIVE_DATA = 'sensitive_data'
    LEGAL_FINANCIAL_CLAIMS = 'legal_financial_claims'
    DEPLOYMENT = 'deployment'
    ARCHITECTURE = 'architecture'

class VerificationMethod(str, Enum):
    DETERMINISTIC_TEST = 'deterministic_test'
    LINT = 'lint'
    TYPECHECK = 'typecheck'
    BUILD = 'build'
    STATIC_ANALYSIS = 'static_analysis'
    BROWSER_SMOKE = 'browser_smoke'
    ACCESSIBILITY_CHECK = 'accessibility_check'
    INDEPENDENT_REVIEW = 'independent_review'
    MANUAL_REVIEW = 'manual_review'
    ARTIFACT_INSPECTION = 'artifact_inspection'
    OTHER = 'other'

class SourceOfTruthKind(str, Enum):
    TASK = 'task'
    CODE = 'code'
    REVIEW = 'review'
    EXECUTION_STATE = 'execution_state'
    ARTIFACTS = 'artifacts'
    LEARNING = 'learning'
    FINAL_DELIVERY = 'final_delivery'

class LearningTrigger(str, Enum):
    HUMAN_REVIEW_COMMENT = 'human_review_comment'
    MANUAL_CODE_CHANGE_AFTER_AGENT_OUTPUT = 'manual_code_change_after_agent_output'
    FAILED_CI = 'failed_ci'
    FAILED_VERIFIER = 'failed_verifier'
    REPEATED_WORKER_RETRIES = 'repeated_worker_retries'
    HUMAN_TAKEOVER = 'human_takeover'
    MISSING_REPOSITORY_CONTEXT = 'missing_repository_context'
    MISSING_TOOLS = 'missing_tools'
    BROWSER_QA_FAILURE = 'browser_qa_failure'
    ESCAPED_DEFECT = 'escaped_defect'
    REPEATED_TASK_PATTERN = 'repeated_task_pattern'
    OTHER = 'other'

class LearningOutputType(str, Enum):
    NEW_SKILL = 'new_skill'
    UPDATED_SKILL = 'updated_skill'
    NEW_DETERMINISTIC_TEST = 'new_deterministic_test'
    NEW_STATIC_RULE = 'new_static_rule'
    NEW_VERIFIER = 'new_verifier'
    NEW_POLICY = 'new_policy'
    NEW_RUNBOOK = 'new_runbook'
    NEW_REPOSITORY_INSTRUCTION = 'new_repository_instruction'
    NEW_AGENTIC_KB_PATTERN = 'new_agentic_kb_pattern'
    ACCEPTED_EXCEPTION = 'accepted_exception'
    NO_ACTION_WITH_REASON = 'no_action_with_reason'

class RiskClassification(BaseModel):
    model_config = ConfigDict(extra='forbid')
    level: RiskLevel
    domains: list[RiskDomain]
    rationale: str
    reversible: bool | None = None
    requires_human_approval: bool | None = None

class AcceptanceCriterion(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: str
    statement: str
    verification_method: VerificationMethod
    evidence_required: bool | None = None
    expected_evidence: list[str] | None = None

class SourceOfTruth(BaseModel):
    model_config = ConfigDict(extra='forbid')
    kind: SourceOfTruthKind
    system: str
    uri: str
    writeback_required: bool
    verification_required: bool
    metadata: dict[str, Any] | None = None

class WorkOrderAmendment(BaseModel):
    model_config = ConfigDict(extra='forbid')
    amendment_id: str
    amended_at: str
    amended_by: str
    reason: str
    changes: dict[str, Any]

class WorkOrderRepository(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str
    path: str
    remote: str | None = None
    default_branch: str | None = None

class WorkOrder(BaseModel):
    model_config = ConfigDict(extra='forbid')
    schema_version: str
    work_order_id: str
    title: str
    goal: str
    problem_statement: str
    desired_outcome: str
    repository: WorkOrderRepository
    base_ref: str
    acceptance_criteria: list[AcceptanceCriterion]
    allowed_paths: list[str]
    restricted_paths: list[str]
    risk_classification: RiskClassification
    required_human_approvals: list[str]
    worker_profile: str
    max_attempts: int
    max_runtime_seconds: int
    max_cost_usd: float
    network_policy: str
    required_checks: list[str]
    expected_artifacts: list[str]
    source_of_truths: list[SourceOfTruth]
    delivery_target: str
    auto_merge_eligible: bool
    initiator: str
    created_at: str
    amendments: list[WorkOrderAmendment]

class CheckResult(BaseModel):
    model_config = ConfigDict(extra='forbid')
    check_id: str
    status: str
    summary: str | None = None
    evidence_refs: list[str]

class AcceptanceVerificationResult(BaseModel):
    model_config = ConfigDict(extra='forbid')
    acceptance_criterion_id: str
    status: str
    method: VerificationMethod | None = None
    evidence_refs: list[str]
    notes: str | None = None

class VerificationReceipt(BaseModel):
    model_config = ConfigDict(extra='forbid')
    receipt_id: str
    mission_id: str
    run_id: str
    work_order_id: str | None = None
    generated_at: str
    verifier_id: str | None = None
    overall_status: str
    check_results: list[CheckResult]
    acceptance_results: list[AcceptanceVerificationResult]
    evidence_refs: list[str]
    limitations: list[str] | None = None

class ArtifactRef(BaseModel):
    model_config = ConfigDict(extra='forbid')
    artifact_id: str
    kind: str
    uri: str
    label: str
    content_type: str | None = None
    created_at: str | None = None
    metadata: dict[str, Any] | None = None

class ArtifactManifest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    manifest_id: str
    mission_id: str
    run_id: str
    execution_id: str | None = None
    work_order_id: str | None = None
    generated_at: str
    produced_by: str
    artifacts: list[ArtifactRef]
    trace_refs: list[str] | None = None
    completeness: str | None = None

class OutcomeMetrics(BaseModel):
    model_config = ConfigDict(extra='forbid')
    mission_id: str
    run_id: str
    work_order_id: str | None = None
    generated_at: str
    primary_outcome: str
    total_cycle_time_ms: int | None = None
    queue_time_ms: int | None = None
    execution_time_ms: int | None = None
    verification_time_ms: int | None = None
    human_approval_time_ms: int | None = None
    worker_attempts: int | None = None
    worker_retries: int | None = None
    human_review_comment_count: int | None = None
    human_takeover_required: bool | None = None
    checks_passed: int | None = None
    checks_failed: int | None = None
    verifier_failures: int | None = None
    acceptance_criteria_verified: int | None = None
    acceptance_criteria_total: int | None = None
    cost_by_model_or_worker: dict[str, Any] | None = None
    pull_request_created: bool | None = None
    pull_request_merged: bool | None = None
    reverted: bool | None = None
    escaped_defect: bool | None = None

class LearningCandidate(BaseModel):
    model_config = ConfigDict(extra='forbid')
    learning_candidate_id: str
    mission_id: str
    run_id: str
    work_order_id: str | None = None
    trigger: LearningTrigger
    observation: str
    category: str
    evidence_refs: list[str]
    frequency: int | None = None
    impact: str
    confidence: str
    recommended_action: str
    target: str
    proposed_output_type: LearningOutputType
    status: str | None = None
    created_at: str

class ApprovalRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    approval_id: str
    mission_id: str
    run_id: str
    step_id: str
    reason: str
    decision_scope: str
    requested_at: str

class ApprovalResult(BaseModel):
    model_config = ConfigDict(extra='forbid')
    approval_id: str
    decision: str
    resolved_at: str
    resolved_by: str | None = None

class ApprovalDecision(BaseModel):
    model_config = ConfigDict(extra='forbid')
    approval_id: str
    decision: str
    resolved_at: str
    resolved_by: str | None = None
    actor: str | None = None
    decision_rationale: str | None = None
    evidence_refs: list[str] | None = None

class RepoScope(BaseModel):
    model_config = ConfigDict(extra='forbid')
    root_path: str
    writable_paths: list[str]

class ResourceBudget(BaseModel):
    model_config = ConfigDict(extra='forbid')
    token_budget: int
    max_artifacts: int
    max_output_bytes: int

class ExecutionEnvelope(BaseModel):
    model_config = ConfigDict(extra='forbid')
    worktree_path: str
    workspace_root: str
    repo_scope: RepoScope
    allowed_tools: list[str]
    allowed_actions: list[str]
    approval_mode: ApprovalMode
    timeout_seconds: int
    resource_budget: ResourceBudget
    output_dir: str
    environment_classification: str
    work_order: WorkOrder | None = None
    source_of_truths: list[SourceOfTruth] | None = None

class Mission(BaseModel):
    model_config = ConfigDict(extra='forbid')
    mission_id: str
    title: str
    objective: str | None = None
    workflow: str
    project_id: str
    policy_ref: str | None = None
    profile_ref: str | None = None
    repo_path: str | None = None
    workspace_root: str | None = None
    status: MissionState
    active_run_id: str | None = None
    summary: str | None = None
    created_at: str
    updated_at: str

class Run(BaseModel):
    model_config = ConfigDict(extra='forbid')
    run_id: str
    mission_id: str
    status: RunState
    current_step_id: str | None = None
    work_order_id: str | None = None
    source_of_truths: list[SourceOfTruth] | None = None
    outcome_metrics: OutcomeMetrics | None = None
    learning_candidates: list[LearningCandidate] | None = None
    started_at: str | None = None
    completed_at: str | None = None
    approval_id: str | None = None
    summary: str | None = None
    created_at: str
    updated_at: str

class Step(BaseModel):
    model_config = ConfigDict(extra='forbid')
    step_id: str
    kind: StepKind
    title: str
    state: StepState
    approval_mode: ApprovalMode
    risk: str | None = None
    execution_id: str | None = None
    approval_id: str | None = None
    started_at: str | None = None
    completed_at: str | None = None
    blocked_reason: str | None = None
    notes: str | None = None
    artifacts: list[ArtifactRef]

class StepExecutionRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    mission_id: str
    run_id: str
    step_id: str
    execution_id: str
    kind: StepKind
    repo_path: str | None = None
    branch_name: str | None = None
    envelope: ExecutionEnvelope

class TaskExecutionResult(BaseModel):
    model_config = ConfigDict(extra='forbid')
    execution_id: str
    mission_id: str
    run_id: str
    step_id: str
    final_outcome: FinalOutcome
    summary: str
    artifacts: list[ArtifactRef]
    changed_files: list[str]
    issues: list[str]
    approval_needed: bool
    recommended_next_step: StepKind | None = None
    confidence: float | None = None
    artifact_manifest: ArtifactManifest | None = None
    verification_receipt: VerificationReceipt | None = None
    outcome_metrics: OutcomeMetrics | None = None
    learning_candidates: list[LearningCandidate] | None = None
    command_refs: list[dict[str, Any]] | None = None

class EventEnvelope(BaseModel):
    model_config = ConfigDict(extra='forbid')
    schema_version: str
    event_id: str
    timestamp: str
    sequence: int
    source: EventSource
    type: str
    mission_id: str
    run_id: str | None = None
    step_id: str | None = None
    execution_id: str | None = None
    actor: str | None = None
    payload: dict[str, Any]

class FactoryEvent(BaseModel):
    model_config = ConfigDict(extra='forbid')
    schema_version: str
    event_id: str
    timestamp: str
    sequence: int
    source: EventSource
    type: str
    mission_id: str
    run_id: str | None = None
    step_id: str | None = None
    execution_id: str | None = None
    actor: str | None = None
    payload: dict[str, Any]

class ContractError(BaseModel):
    model_config = ConfigDict(extra='forbid')
    error: dict[str, Any]

