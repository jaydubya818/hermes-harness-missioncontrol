export { scoreRun } from "./scorer.js";
export type { ApprovalSummary, ScoreInputs, ScoredEval } from "./scorer.js";

export interface EvalRecord {
  eval_id?: string;
  mission_id: string;
  run_id: string;
  outcome: "success" | "failure" | "partial";
  cost_usd: number;
  approval_count: number;
  artifact_count: number;
  created_at: string;
  // Real scoring fields (present when scored via scoreRun())
  duration_ms?: number;
  confidence?: number;
  efficiency_score?: number;
  risk_score?: number;
}

export interface EvalSummary {
  total_runs: number;
  success_rate: number;
  failure_rate: number;
  total_approvals: number;
  total_cost_usd: number;
  average_cost_usd: number;
  average_confidence: number;
  average_efficiency: number;
  average_risk_score: number;
  average_duration_ms: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function summarize(records: EvalRecord[]): EvalSummary {
  const total = records.length;
  if (total === 0) {
    return {
      total_runs: 0,
      success_rate: 0,
      failure_rate: 0,
      total_approvals: 0,
      total_cost_usd: 0,
      average_cost_usd: 0,
      average_confidence: 0,
      average_efficiency: 0,
      average_risk_score: 0,
      average_duration_ms: 0,
    };
  }

  const successes = records.filter((r) => r.outcome === "success").length;
  const failures  = records.filter((r) => r.outcome === "failure").length;
  // Records reach summarize() from persisted state and from the eval-api
  // request body. Validation only runs on the POST path, so a state file
  // written by an older build (or hand-edited) can carry a string or NaN
  // here, and one such record turned every cost/average in the summary into
  // NaN -- serialized as null, which the console renders as $0.00 with no
  // hint that the numbers are wrong. Ignore non-finite values instead.
  const cost      = records.reduce((sum, r) => sum + (isFiniteNumber(r.cost_usd) ? r.cost_usd : 0), 0);
  const approvals = records.reduce((sum, r) => sum + (isFiniteNumber(r.approval_count) ? r.approval_count : 0), 0);

  // Optional fields: only average over records that carry a usable number.
  // `!= null` alone let a string or NaN through and poisoned the average.
  const withConfidence  = records.filter((r) => isFiniteNumber(r.confidence));
  const withEfficiency  = records.filter((r) => isFiniteNumber(r.efficiency_score));
  const withRisk        = records.filter((r) => isFiniteNumber(r.risk_score));
  const withDuration    = records.filter((r) => isFiniteNumber(r.duration_ms));

  function avg(arr: EvalRecord[], key: keyof EvalRecord): number {
    if (arr.length === 0) return 0;
    return arr.reduce((sum, r) => sum + (r[key] as number), 0) / arr.length;
  }

  return {
    total_runs:          total,
    success_rate:        successes / total,
    failure_rate:        failures  / total,
    total_approvals:     approvals,
    total_cost_usd:      Math.round(cost * 1000) / 1000,
    average_cost_usd:    Math.round((cost / total) * 1000) / 1000,
    average_confidence:  Math.round(avg(withConfidence, "confidence") * 100) / 100,
    average_efficiency:  Math.round(avg(withEfficiency, "efficiency_score") * 100) / 100,
    average_risk_score:  Math.round(avg(withRisk,       "risk_score")  * 100) / 100,
    average_duration_ms: Math.round(avg(withDuration,   "duration_ms")),
  };
}
