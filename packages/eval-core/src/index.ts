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

  // Records reach summarize() from persisted state and from the eval-api
  // request body. Validation only runs on the POST path, so a state file
  // written by an older build (or hand-edited) can carry a string or NaN
  // here, and one such record turned every cost/average in the summary into
  // NaN -- serialized as null, which the console renders as $0.00 with no
  // hint that the numbers are wrong. Ignore non-finite values instead, and
  // for the optional fields average only over records that carry a usable
  // number (`!= null` alone let a string or NaN through).
  //
  // The console polls /api/evals every few seconds and the record log only
  // grows, so accumulate every tally in one pass instead of the eleven
  // separate traversals (three filters, two reduces, four filters, four
  // averaging reduces) this used to make over the full set.
  let successes = 0;
  let failures = 0;
  let cost = 0;
  let approvals = 0;
  let confidenceSum = 0;
  let confidenceCount = 0;
  let efficiencySum = 0;
  let efficiencyCount = 0;
  let riskSum = 0;
  let riskCount = 0;
  let durationSum = 0;
  let durationCount = 0;

  for (const record of records) {
    if (record.outcome === "success") successes += 1;
    else if (record.outcome === "failure") failures += 1;
    if (isFiniteNumber(record.cost_usd)) cost += record.cost_usd;
    if (isFiniteNumber(record.approval_count)) approvals += record.approval_count;
    if (isFiniteNumber(record.confidence)) { confidenceSum += record.confidence; confidenceCount += 1; }
    if (isFiniteNumber(record.efficiency_score)) { efficiencySum += record.efficiency_score; efficiencyCount += 1; }
    if (isFiniteNumber(record.risk_score)) { riskSum += record.risk_score; riskCount += 1; }
    if (isFiniteNumber(record.duration_ms)) { durationSum += record.duration_ms; durationCount += 1; }
  }

  const avg = (sum: number, count: number) => count === 0 ? 0 : sum / count;

  return {
    total_runs:          total,
    success_rate:        successes / total,
    failure_rate:        failures  / total,
    total_approvals:     approvals,
    total_cost_usd:      Math.round(cost * 1000) / 1000,
    average_cost_usd:    Math.round((cost / total) * 1000) / 1000,
    average_confidence:  Math.round(avg(confidenceSum, confidenceCount) * 100) / 100,
    average_efficiency:  Math.round(avg(efficiencySum, efficiencyCount) * 100) / 100,
    average_risk_score:  Math.round(avg(riskSum,       riskCount)       * 100) / 100,
    average_duration_ms: Math.round(avg(durationSum,   durationCount)),
  };
}
