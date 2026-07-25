export const StepKind = {
  Plan: "plan",
  Implement: "implement",
  Test: "test",
  Review: "review",
  Deploy: "deploy",
} as const;

export type StepKind = (typeof StepKind)[keyof typeof StepKind];

export const StepState = {
  Pending: "pending",
  Ready: "ready",
  Running: "running",
  Blocked: "blocked",
  AwaitingApproval: "awaiting_approval",
  Paused: "paused",
  Failed: "failed",
  Completed: "completed",
  Cancelled: "cancelled",
} as const;

export type StepState = (typeof StepState)[keyof typeof StepState];

export const RunState = {
  Pending: "pending",
  Running: "running",
  AwaitingApproval: "awaiting_approval",
  Paused: "paused",
  Failed: "failed",
  Completed: "completed",
  Cancelled: "cancelled",
} as const;

export type RunState = (typeof RunState)[keyof typeof RunState];

export const MissionState = {
  Pending: "pending",
  Running: "running",
  AwaitingApproval: "awaiting_approval",
  Paused: "paused",
  Failed: "failed",
  Completed: "completed",
  Cancelled: "cancelled",
} as const;

export type MissionState = (typeof MissionState)[keyof typeof MissionState];

export const ApprovalMode = {
  Never: "never",
  OnPolicyTrigger: "on_policy_trigger",
  Always: "always",
} as const;

export type ApprovalMode = (typeof ApprovalMode)[keyof typeof ApprovalMode];

export const FinalOutcome = {
  Success: "success",
  Partial: "partial",
  Blocked: "blocked",
  Failed: "failed",
  Cancelled: "cancelled",
} as const;

export type FinalOutcome = (typeof FinalOutcome)[keyof typeof FinalOutcome];

export const EventSource = {
  Hermes: "hermes",
  MissionControl: "missioncontrol",
  Pi: "pi",
  Worker: "worker",
  GitHub: "github",
  Verifier: "verifier",
} as const;

export type EventSource = (typeof EventSource)[keyof typeof EventSource];

export const RiskLevel = {
  Low: "low",
  Medium: "medium",
  High: "high",
  Critical: "critical",
} as const;

export type RiskLevel = (typeof RiskLevel)[keyof typeof RiskLevel];

export const RiskDomain = {
  Ui: "ui",
  Copy: "copy",
  FormValidation: "form_validation",
  Accessibility: "accessibility",
  Tests: "tests",
  Logging: "logging",
  AdminUi: "admin_ui",
  SeedData: "seed_data",
  Refactor: "refactor",
  Auth: "auth",
  Authorization: "authorization",
  Payments: "payments",
  Database: "database",
  Infrastructure: "infrastructure",
  Secrets: "secrets",
  ExternalIntegrations: "external_integrations",
  SensitiveData: "sensitive_data",
  LegalFinancialClaims: "legal_financial_claims",
  Deployment: "deployment",
  Architecture: "architecture",
} as const;

export type RiskDomain = (typeof RiskDomain)[keyof typeof RiskDomain];

export const VerificationMethod = {
  DeterministicTest: "deterministic_test",
  Lint: "lint",
  Typecheck: "typecheck",
  Build: "build",
  StaticAnalysis: "static_analysis",
  BrowserSmoke: "browser_smoke",
  AccessibilityCheck: "accessibility_check",
  IndependentReview: "independent_review",
  ManualReview: "manual_review",
  ArtifactInspection: "artifact_inspection",
  Other: "other",
} as const;

export type VerificationMethod = (typeof VerificationMethod)[keyof typeof VerificationMethod];

export const SourceOfTruthKind = {
  Task: "task",
  Code: "code",
  Review: "review",
  ExecutionState: "execution_state",
  Artifacts: "artifacts",
  Learning: "learning",
  FinalDelivery: "final_delivery",
} as const;

export type SourceOfTruthKind = (typeof SourceOfTruthKind)[keyof typeof SourceOfTruthKind];

export const ExternalWorkItemSystem = {
  Jira: "jira",
  Linear: "linear",
  GitHub: "github",
  Manual: "manual",
} as const;

export type ExternalWorkItemSystem = (typeof ExternalWorkItemSystem)[keyof typeof ExternalWorkItemSystem];

export const ExternalWorkItemHierarchy = {
  Epic: "epic",
  Story: "story",
  Task: "task",
  Subtask: "subtask",
} as const;

export type ExternalWorkItemHierarchy = (typeof ExternalWorkItemHierarchy)[keyof typeof ExternalWorkItemHierarchy];

export const ConnectorOperation = {
  Read: "read",
  Create: "create",
  Update: "update",
  Comment: "comment",
  Transition: "transition",
  Delete: "delete",
} as const;

export type ConnectorOperation = (typeof ConnectorOperation)[keyof typeof ConnectorOperation];

export const FactoryLoopType = {
  TurnBased: "turn_based",
  GoalBased: "goal_based",
  TimeBased: "time_based",
  Proactive: "proactive",
} as const;

export type FactoryLoopType = (typeof FactoryLoopType)[keyof typeof FactoryLoopType];

export const LearningTrigger = {
  HumanReviewComment: "human_review_comment",
  ManualCodeChangeAfterAgentOutput: "manual_code_change_after_agent_output",
  FailedCi: "failed_ci",
  FailedVerifier: "failed_verifier",
  RepeatedWorkerRetries: "repeated_worker_retries",
  HumanTakeover: "human_takeover",
  MissingRepositoryContext: "missing_repository_context",
  MissingTools: "missing_tools",
  BrowserQaFailure: "browser_qa_failure",
  EscapedDefect: "escaped_defect",
  RepeatedTaskPattern: "repeated_task_pattern",
  Other: "other",
} as const;

export type LearningTrigger = (typeof LearningTrigger)[keyof typeof LearningTrigger];

export const LearningOutputType = {
  NewSkill: "new_skill",
  UpdatedSkill: "updated_skill",
  NewDeterministicTest: "new_deterministic_test",
  NewStaticRule: "new_static_rule",
  NewVerifier: "new_verifier",
  NewPolicy: "new_policy",
  NewRunbook: "new_runbook",
  NewRepositoryInstruction: "new_repository_instruction",
  NewAgenticKbPattern: "new_agentic_kb_pattern",
  AcceptedException: "accepted_exception",
  NoActionWithReason: "no_action_with_reason",
} as const;

export type LearningOutputType = (typeof LearningOutputType)[keyof typeof LearningOutputType];
