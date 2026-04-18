import type { EventSource } from "./enums.js";

export type StepEventType =
  | "mission.created"
  | "run.started"
  | "step.started"
  | "step.progress"
  | "tool.started"
  | "tool.completed"
  | "artifact.created"
  | "approval.requested"
  | "approval.resolved"
  | "step.blocked"
  | "step.failed"
  | "step.completed"
  | "run.completed"
  | "run.cancelled";

export interface EventEnvelope<T = Record<string, unknown>> {
  schema_version: "v1";
  event_id: string;
  timestamp: string;
  sequence: number;
  source: EventSource;
  type: StepEventType;
  mission_id: string;
  run_id: string;
  step_id?: string;
  execution_id?: string;
  payload: T;
}
