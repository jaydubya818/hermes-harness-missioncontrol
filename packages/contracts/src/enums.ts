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
} as const;

export type EventSource = (typeof EventSource)[keyof typeof EventSource];
