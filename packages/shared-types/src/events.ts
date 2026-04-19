import type { AgentId, MissionId, ProjectId, RunId, StepId } from "./ids.js";

export type HarnessEventName =
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
  | "step.blocked"
  | "step.paused"
  | "step.resumed"
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
  | "policy.violation"
  | "execution.timeout"
  | "execution.budget_exceeded";

export interface HarnessEvent<T = Record<string, unknown>> {
  type: HarnessEventName;
  ts: string;
  project_id?: ProjectId;
  mission_id?: MissionId;
  run_id?: RunId;
  step_id?: StepId;
  agent_id?: AgentId;
  actor?: string;
  execution_id?: string;
  event_id?: string;
  timestamp?: string;
  schema_version?: "v1";
  sequence?: number;
  source?: "missioncontrol" | "hermes";
  payload: T;
}
