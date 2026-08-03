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
  // Ids gate replay dedupe (event_id) and address approvals/runs/evals, so
  // use crypto-strength randomness: Math.random's ~41 bits could collide,
  // and a colliding event_id is silently dropped by the orchestrator.
  // Fall back for non-secure browser contexts where randomUUID is absent.
  const uuid = globalThis.crypto?.randomUUID?.();
  const suffix = uuid ? uuid.replace(/-/g, "").slice(0, 16) : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${suffix}` as `${T}_${string}`;
}
