export interface EvalRecord {
  mission_id: string;
  run_id: string;
  outcome: "success" | "failure" | "partial";
  cost_usd: number;
  approval_count: number;
  artifact_count: number;
  created_at: string;
}

export function summarize(records: EvalRecord[]) {
  const total = records.length;
  const successes = records.filter((r) => r.outcome === "success").length;
  const failures = records.filter((r) => r.outcome === "failure").length;
  const cost = records.reduce((sum, item) => sum + item.cost_usd, 0);
  return {
    total_runs: total,
    success_rate: total === 0 ? 0 : successes / total,
    failure_rate: total === 0 ? 0 : failures / total,
    total_cost_usd: cost,
    average_cost_usd: total === 0 ? 0 : cost / total
  };
}
