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
    return (
      new Date(step.completed_at).getTime() -
      new Date(step.started_at).getTime()
    );
  }
  return FALLBACK_STEP_MINUTES * 60_000;
}

function stepCost(step: WorkflowRun["steps"][number]): number {
  const rate = STEP_KIND_RATE_PER_MIN[step.kind] ?? FALLBACK_RATE_PER_MIN;
  return (stepDurationMs(step) / 60_000) * rate;
}

/** Extract confidence from step notes ("confidence: 0.85") or estimate from state. */
function stepConfidence(step: WorkflowRun["steps"][number]): number {
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
  const duration_ms =
    run.created_at && run.updated_at
      ? new Date(run.updated_at).getTime() - new Date(run.created_at).getTime()
      : 0;

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
  const highRiskCount = run.steps.filter((s) => s.risk === "high").length;
  const risk_score = round2(
    highRiskCount === 0
      ? (outcome === "success" ? 1.0 : 0.5)
      : Math.min(1, approvedCount / highRiskCount)
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
