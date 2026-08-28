import type { WorkflowRun } from "@hermes-harness-with-missioncontrol/workflow-engine";

// -----------------------------------------------------------------------
// Cost rates — USD per minute of execution, by step kind.
// Approximate LLM + infra blended rates; tune as real cost data accrues.
// -----------------------------------------------------------------------
const STEP_KIND_RATE_PER_MIN: Record<string, number> = {
  plan:      0.02,
  implement: 0.08,
  test:      0.04,
  review:    0.03,
  deploy:    0.05,
};
const FALLBACK_RATE_PER_MIN = 0.05;
const FALLBACK_STEP_MINUTES = 2; // assumed duration when timestamps are absent

export interface ApprovalSummary {
  status: "pending" | "approved" | "rejected";
  reason?: string;
  /**
   * The step this approval was requested for. `risk_score` is a per-step
   * coverage metric, so it needs to know which step an approval settled. The
   * orchestrator already stamps this on every approval it creates (both
   * request sites set `step_id: step.step_id`) and passes the approval
   * records straight to `scoreRun`; it is optional here only so a caller
   * holding a summary without one still satisfies the type.
   */
  step_id?: string;
}

export interface ScoreInputs {
  run: WorkflowRun;
  approvals: ApprovalSummary[];
}

export interface ScoredEval {
  outcome: "success" | "failure" | "partial";
  cost_usd: number;
  approval_count: number;
  artifact_count: number;
  duration_ms: number;
  /** Aggregate confidence across steps (0–1). */
  confidence: number;
  /** Ratio of completed steps, penalised by approval rejections (0–1). */
  efficiency_score: number;
  /** Approval coverage of high-risk steps (0–1). */
  risk_score: number;
}

// -----------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------

function stepDurationMs(step: WorkflowRun["steps"][number]): number {
  if (step.started_at && step.completed_at) {
    const elapsed =
      new Date(step.completed_at).getTime() -
      new Date(step.started_at).getTime();
    // Guard against unparseable or out-of-order timestamps so corrupt state
    // can never produce NaN or negative costs.
    if (Number.isFinite(elapsed) && elapsed >= 0) return elapsed;
  }
  return FALLBACK_STEP_MINUTES * 60_000;
}

function stepCost(step: WorkflowRun["steps"][number]): number {
  const rate = STEP_KIND_RATE_PER_MIN[step.kind] ?? FALLBACK_RATE_PER_MIN;
  return (stepDurationMs(step) / 60_000) * rate;
}

/**
 * Confidence for a step, best source first.
 *
 * The worker reports a real number per execution (0.88 for a passing test
 * command, 0.25 for a failing one, ...). That number used to reach this
 * function only if it happened to appear inside `step.notes`, which holds the
 * worker's free-text summary -- and the summary names a confidence only on
 * the approval path. On every other path the regex missed and the state
 * constant below was used instead, so a 0.95 execution and a 0.25 execution
 * both scored 0.85 and `EvalRecord.confidence` reported a number no worker
 * had produced. The orchestrator now carries the value in its own field, so
 * read that first; the notes scrape stays as a fallback for runs persisted
 * before the field existed.
 */
function stepConfidence(step: WorkflowRun["steps"][number]): number {
  const reported = step.worker_confidence;
  if (typeof reported === "number" && Number.isFinite(reported) && reported >= 0 && reported <= 1) {
    return reported;
  }
  if (step.notes) {
    const match = step.notes.match(/confidence[:\s]+([0-9.]+)/i);
    if (match) {
      const parsed = parseFloat(match[1]);
      if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 1) return parsed;
    }
  }
  switch (step.state) {
    case "completed": return 0.85;
    case "failed":    return 0.10;
    default:          return 0.50;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// -----------------------------------------------------------------------
// Public scoring function
// -----------------------------------------------------------------------

export function scoreRun(inputs: ScoreInputs): ScoredEval {
  const { run, approvals } = inputs;

  // --- outcome ---
  const outcome: ScoredEval["outcome"] =
    run.status === "completed" ? "success"
    : run.status === "failed"  ? "failure"
    : "partial";

  // --- cost: duration-based, per step kind ---
  const cost_usd = round2(
    run.steps.reduce((sum, step) => sum + stepCost(step), 0)
  );

  // --- duration: wall-clock from run timestamps ---
  const rawDuration =
    run.created_at && run.updated_at
      ? new Date(run.updated_at).getTime() - new Date(run.created_at).getTime()
      : 0;
  const duration_ms = Number.isFinite(rawDuration) && rawDuration >= 0 ? rawDuration : 0;

  // --- artifacts ---
  const artifact_count = run.steps.reduce(
    (sum, step) => sum + step.artifacts.length,
    0
  );

  // --- approvals ---
  const approvedCount  = approvals.filter((a) => a.status === "approved").length;
  const rejectedCount  = approvals.filter((a) => a.status === "rejected").length;
  const totalApprovals = approvals.length;

  // --- confidence: aggregate across steps ---
  const confidence = round2(
    run.steps.length === 0
      ? (outcome === "success" ? 0.8 : 0.3)
      : run.steps.reduce((sum, s) => sum + stepConfidence(s), 0) / run.steps.length
  );

  // --- efficiency: step success rate, penalised by rejection ratio ---
  const completedSteps = run.steps.filter((s) => s.state === "completed").length;
  const stepSuccessRate =
    run.steps.length === 0 ? 0 : completedSteps / run.steps.length;
  const rejectionPenalty =
    totalApprovals === 0 ? 0 : (rejectedCount / totalApprovals) * 0.2;
  const efficiency_score = round2(Math.max(0, stepSuccessRate - rejectionPenalty));

  // --- risk: approval coverage of high-risk steps ---
  // Count only the approvals that actually settled a high-risk step. The
  // numerator used to be `approvedCount`, every approved approval in the run,
  // but approvals are not requested for high-risk steps alone: policy-engine
  // also raises one for any step whose worker confidence is below 0.6,
  // whatever its risk. So an approved low-confidence approval on a low-risk
  // step counted as coverage for a high-risk step nobody had approved -- a
  // run whose only high-risk deploy was *rejected* still scored a perfect
  // 1.0 because an earlier plan step had been approved. risk_score is the
  // governance metric here, so it has to answer the question it claims to.
  // An approval carrying no step_id cannot be shown to cover a high-risk
  // step, so it does not count -- the same rule the orchestrator's date
  // filter applies to a record with no timestamp.
  const highRiskSteps = run.steps.filter((s) => s.risk === "high");
  const highRiskCount = highRiskSteps.length;
  const highRiskStepIds = new Set(highRiskSteps.map((s) => s.step_id));
  const highRiskApprovedCount = approvals.filter(
    (a) => a.status === "approved" && !!a.step_id && highRiskStepIds.has(a.step_id)
  ).length;
  const risk_score = round2(
    highRiskCount === 0
      ? (outcome === "success" ? 1.0 : 0.5)
      : Math.min(1, highRiskApprovedCount / highRiskCount)
  );

  return {
    outcome,
    cost_usd,
    approval_count: approvedCount,
    artifact_count,
    duration_ms,
    confidence,
    efficiency_score,
    risk_score,
  };
}
