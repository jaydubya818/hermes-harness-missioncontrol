import type { AgentId, MissionId, ProjectId, RunId, StepId } from "./ids.js";

export type HarnessEventName =
  | "mission.created"
  | "run.started"
  | "step.started"
  | "step.completed"
  | "step.failed"
  | "approval.granted"
  | "approval.rejected"
  | "deployment.completed"
  | "rollback.triggered"
  | "context.loaded"
  | "writeback.completed"
  | "learning.promoted";

export interface HarnessEvent<T = Record<string, unknown>> {
  type: HarnessEventName;
  ts: string;
  project_id?: ProjectId;
  mission_id?: MissionId;
  run_id?: RunId;
  step_id?: StepId;
  agent_id?: AgentId;
  payload: T;
}
