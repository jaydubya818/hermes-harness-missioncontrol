export type ProjectId = `proj_${string}`;
export type MissionId = `mis_${string}`;
export type RunId = `run_${string}`;
export type StepId = `step_${string}`;
export type AgentId = `agent_${string}`;
export type ArtifactId = `art_${string}`;
export type BundleId = `ctx_${string}`;
export type RewriteId = `rw_${string}`;
export type PromotionId = `promo_${string}`;

export function makeId<T extends string>(prefix: T): `${T}_${string}` {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}` as `${T}_${string}`;
}
