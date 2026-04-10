import type { AgentId, BundleId, MissionId, ProjectId, PromotionId, RewriteId, RunId, StepId } from "./ids.js";

export type MemoryClass = "profile" | "hot" | "working" | "learned" | "rewrite" | "bus";
export type RiskTier = "low" | "medium" | "high" | "critical";

export interface ContextRequest {
  agent_id: AgentId;
  agent_role: string;
  project_id: ProjectId;
  mission_id?: MissionId;
  run_id?: RunId;
  step_id?: StepId;
  task_type?: string;
  task_summary?: string;
  risk_tier?: RiskTier;
  budget_bytes: number;
  needed_capabilities?: string[];
}

export interface ContextFile {
  path: string;
  memory_class: MemoryClass;
  priority: number;
  reason: string;
  content: string;
}

export interface ContextTraceEntry {
  path: string;
  class?: MemoryClass;
  reason: string;
  bytes?: number;
  priority?: number;
}

export interface ContextResponse {
  bundle_id: BundleId;
  truncated: boolean;
  budget_used: number;
  files: ContextFile[];
  trace: {
    included: ContextTraceEntry[];
    excluded: ContextTraceEntry[];
  };
}

export interface KnowledgeNote {
  title: string;
  body: string;
}

export interface ArtifactRef {
  type: string;
  uri: string;
}

export interface RewriteProposal {
  target: string;
  kind: "candidate_rewrite" | "standard_update";
  content: string;
}

export interface CloseTaskRequest {
  agent_id: AgentId;
  project_id: ProjectId;
  mission_id?: MissionId;
  run_id?: RunId;
  step_id?: StepId;
  outcome: "success" | "failure" | "partial";
  summary: string;
  discoveries?: KnowledgeNote[];
  gotchas?: KnowledgeNote[];
  rewrites?: RewriteProposal[];
  artifacts?: ArtifactRef[];
}

export interface CloseTaskResponse {
  writeback_id: string;
  status: "ok";
  writes: Array<{ path: string; memory_class: MemoryClass }>;
  promotion_candidates: Array<{ item_id: string; reason: string }>;
  trace: { duration_ms: number };
}

export interface PublishBusRequest {
  channel: "discovery" | "escalation" | "handoff" | "standard";
  agent_id: AgentId;
  project_id: ProjectId;
  mission_id?: MissionId;
  run_id?: RunId;
  title: string;
  body: string;
  severity?: string;
  tags?: string[];
}

export interface PromoteLearningRequest {
  item_id: string;
  promoted_by: AgentId | string;
  target_path: string;
  promotion_kind: "standard" | "recipe" | "project_note";
}

export interface PromoteLearningResponse {
  promotion_id: PromotionId;
  rewrite_id?: RewriteId;
  target_path: string;
  status: "promoted";
}

export interface AgentMemorySummary {
  agent_id: AgentId;
  profile_path: string;
  hot_path: string;
  working_path: string;
  learned_count: number;
  pending_rewrites: number;
  recent_promotions: number;
}

export interface ProjectMemorySummary {
  project_id: ProjectId;
  standards: string[];
  active_rewrites: string[];
  recent_postmortems: string[];
  recipes: string[];
}
