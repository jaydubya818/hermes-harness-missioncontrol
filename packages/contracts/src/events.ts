import type { EventSource } from "./enums.js";

// The single source of truth for the canonical event taxonomy. Kept as a
// runtime array (not just a type union) because the orchestrator validates
// incoming event types against it and the console has to register one SSE
// listener per type -- three hand-maintained copies meant adding an event
// type silently dropped it from the live feed until every copy was updated.
export const CANONICAL_EVENT_TYPES = [
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
] as const;

export type CanonicalEventType = (typeof CANONICAL_EVENT_TYPES)[number];

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
