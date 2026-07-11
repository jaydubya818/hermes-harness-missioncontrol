import type { EventSource } from "./enums.js";

export type CanonicalEventType =
  | "mission.created"
  | "mission.updated"
  | "mission.paused"
  | "mission.running"
  | "mission.cancelled"
  | "mission.completed"
  | "run.started"
  | "run.running"
  | "run.paused"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "step.started"
  | "step.progress"
  | "step.paused"
  | "step.resumed"
  | "step.blocked"
  | "step.completed"
  | "step.failed"
  | "step.cancelled"
  | "step.retried"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "artifact.created"
  | "approval.requested"
  | "approval.resolved"
  | "eval.started"
  | "eval.completed"
  | "eval.failed"
  | "policy.violation"
  | "policy.evaluated"
  | "work_order.created"
  | "work_order.amended"
  | "factory.eligibility_evaluated"
  | "verification.started"
  | "verification.completed"
  | "verification.failed"
  | "outcome_metrics.recorded"
  | "learning_candidate.created"
  | "github.pr_created"
  | "github.pr_updated"
  | "github.pr_merged"
  | "manual.takeover_requested"
  | "manual.takeover_completed"
  | "execution.timeout"
  | "execution.budget_exceeded";

export interface EventEnvelope<T = Record<string, unknown>> {
  schema_version: "v1";
  event_id: string;
  timestamp: string;
  sequence: number;
  source: EventSource;
  type: CanonicalEventType;
  mission_id: string;
  run_id?: string;
  step_id?: string;
  execution_id?: string;
  actor?: string;
  payload: T;
}

export type FactoryEvent<T = Record<string, unknown>> = EventEnvelope<T>;
