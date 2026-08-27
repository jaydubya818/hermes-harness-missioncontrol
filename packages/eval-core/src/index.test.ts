import { describe, expect, it } from "vitest";
import { summarize } from "./index.js";
import { scoreRun } from "./scorer.js";
import type { WorkflowRun } from "@hermes-harness-with-missioncontrol/workflow-engine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  const now = new Date("2025-01-01T10:00:00Z");
  const later = new Date("2025-01-01T10:05:00Z");
  return {
    run_id: "run_test",
    mission_id: "mis_test",
    workflow_id: "bugfix",
    status: "completed",
    current_step_index: 4,
    created_at: now.toISOString(),
    updated_at: later.toISOString(),
    steps: [
      {
        step_id: "plan", title: "Plan fix", kind: "plan", risk: "low",
        approval_mode: "on_policy_trigger",
        state: "completed",
        started_at: new Date("2025-01-01T10:00:00Z").toISOString(),
        completed_at: new Date("2025-01-01T10:01:00Z").toISOString(),
        artifacts: [],
      },
      {
        step_id: "implement", title: "Implement patch", kind: "implement", risk: "medium",
        approval_mode: "on_policy_trigger",
        state: "completed",
        started_at: new Date("2025-01-01T10:01:00Z").toISOString(),
        completed_at: new Date("2025-01-01T10:03:00Z").toISOString(),
        artifacts: [{ artifact_id: "a1", kind: "diff", label: "diff", type: "diff", uri: "patch.diff" }],
      },
      {
        step_id: "test", title: "Run tests", kind: "test", risk: "low",
        approval_mode: "on_policy_trigger",
        state: "completed",
        started_at: new Date("2025-01-01T10:03:00Z").toISOString(),
        completed_at: new Date("2025-01-01T10:04:00Z").toISOString(),
        artifacts: [],
      },
      {
        step_id: "review", title: "Review diff", kind: "review", risk: "medium",
        approval_mode: "on_policy_trigger",
        state: "completed",
        started_at: new Date("2025-01-01T10:04:00Z").toISOString(),
        completed_at: new Date("2025-01-01T10:04:30Z").toISOString(),
        artifacts: [],
      },
      {
        step_id: "deploy", title: "Canary deploy", kind: "deploy", risk: "high",
        approval_mode: "on_policy_trigger",
        state: "completed",
        started_at: new Date("2025-01-01T10:04:30Z").toISOString(),
        completed_at: new Date("2025-01-01T10:05:00Z").toISOString(),
        artifacts: [],
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// summarize()
// ---------------------------------------------------------------------------

describe("summarize", () => {
  it("returns zeros for empty input", () => {
    const result = summarize([]);
    expect(result.total_runs).toBe(0);
    expect(result.success_rate).toBe(0);
    expect(result.average_cost_usd).toBe(0);
    expect(result.total_approvals).toBe(0);
  });

  it("aggregates a single success record", () => {
    const result = summarize([{
      mission_id: "m", run_id: "r", outcome: "success",
      cost_usd: 1, approval_count: 1, artifact_count: 2,
      created_at: new Date().toISOString(),
    }]);
    expect(result.total_runs).toBe(1);
    expect(result.success_rate).toBe(1);
    expect(result.failure_rate).toBe(0);
  });

  it("averages optional scoring fields when present", () => {
    const result = summarize([
      { mission_id: "m1", run_id: "r1", outcome: "success", cost_usd: 0.5,
        approval_count: 1, artifact_count: 1, created_at: new Date().toISOString(),
        confidence: 0.9, efficiency_score: 0.8, risk_score: 1.0 },
      { mission_id: "m2", run_id: "r2", outcome: "failure", cost_usd: 0.3,
        approval_count: 0, artifact_count: 0, created_at: new Date().toISOString(),
        confidence: 0.1, efficiency_score: 0.0, risk_score: 0.5 },
    ]);
    expect(result.total_runs).toBe(2);
    expect(result.total_approvals).toBe(1);
    expect(result.average_confidence).toBe(0.5);
    expect(result.average_efficiency).toBe(0.4);
    expect(result.average_risk_score).toBe(0.75);
  });

  it("ignores non-finite numerics instead of poisoning every average", () => {
    const result = summarize([
      { mission_id: "m1", run_id: "r1", outcome: "success", cost_usd: 0.5,
        approval_count: 1, artifact_count: 1, created_at: new Date().toISOString(),
        confidence: 0.9, efficiency_score: 0.8, risk_score: 1.0, duration_ms: 1000 },
      // A record persisted by an older build / hand-edited state file.
      { mission_id: "m2", run_id: "r2", outcome: "failure", cost_usd: "0.3" as unknown as number,
        approval_count: Number.NaN, artifact_count: 0, created_at: new Date().toISOString(),
        confidence: "high" as unknown as number, efficiency_score: Number.NaN,
        risk_score: Number.POSITIVE_INFINITY, duration_ms: null as unknown as number },
    ]);
    expect(result.total_runs).toBe(2);
    expect(result.total_cost_usd).toBe(0.5);
    expect(result.average_cost_usd).toBe(0.25);
    expect(result.total_approvals).toBe(1);
    expect(result.average_confidence).toBe(0.9);
    expect(result.average_efficiency).toBe(0.8);
    expect(result.average_risk_score).toBe(1);
    expect(result.average_duration_ms).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// scoreRun()
// ---------------------------------------------------------------------------

describe("scoreRun", () => {
  it("returns success outcome for completed run", () => {
    const result = scoreRun({ run: makeRun(), approvals: [{ status: "approved" }] });
    expect(result.outcome).toBe("success");
  });

  it("returns failure outcome for failed run", () => {
    const result = scoreRun({
      run: makeRun({ status: "failed" }),
      approvals: [],
    });
    expect(result.outcome).toBe("failure");
  });

  it("computes duration_ms from run timestamps", () => {
    const result = scoreRun({ run: makeRun(), approvals: [] });
    expect(result.duration_ms).toBe(5 * 60_000); // 5 minutes
  });

  it("computes cost based on step duration and kind", () => {
    const result = scoreRun({ run: makeRun(), approvals: [] });
    // plan: 1min*0.02=0.02, implement: 2min*0.08=0.16, test: 1min*0.04=0.04,
    // review: 0.5min*0.03=0.015, deploy: 0.5min*0.05=0.025 → total ~0.26
    expect(result.cost_usd).toBeGreaterThan(0);
    expect(result.cost_usd).toBeLessThan(1); // sanity bound
  });

  it("counts only approved approvals", () => {
    const result = scoreRun({
      run: makeRun(),
      approvals: [{ status: "approved" }, { status: "rejected" }, { status: "pending" }],
    });
    expect(result.approval_count).toBe(1);
  });

  it("efficiency_score is 1.0 for all-completed steps with no rejections", () => {
    const result = scoreRun({ run: makeRun(), approvals: [] });
    expect(result.efficiency_score).toBe(1.0);
  });

  it("efficiency_score is reduced by rejection penalty", () => {
    const clean   = scoreRun({ run: makeRun(), approvals: [] });
    const withRej = scoreRun({
      run: makeRun(),
      approvals: [{ status: "rejected" }, { status: "rejected" }],
    });
    expect(withRej.efficiency_score).toBeLessThan(clean.efficiency_score);
  });

  it("risk_score is 1.0 when high-risk step has an approval", () => {
    const result = scoreRun({
      run: makeRun(),
      // The approval on the high-risk step (deploy) covers the 1 high-risk step.
      approvals: [{ status: "approved", step_id: "deploy" }],
    });
    expect(result.risk_score).toBe(1.0);
  });

  it("risk_score is 0 when high-risk step has no approvals", () => {
    const result = scoreRun({ run: makeRun(), approvals: [] });
    // 1 high-risk step, 0 approved → 0/1 = 0
    expect(result.risk_score).toBe(0);
  });

  // risk_score claims to be "approval coverage of high-risk steps", but its
  // numerator was every approved approval in the run. policy-engine requests
  // an approval for any low-confidence step regardless of risk, so an
  // unrelated approval on a low-risk step inflated the coverage of a
  // high-risk step nobody had approved.
  it("risk_score ignores approvals granted on steps that are not high-risk", () => {
    const result = scoreRun({
      run: makeRun({ status: "failed" }),
      approvals: [
        // Low-confidence approval on the low-risk plan step: approved.
        { status: "approved", step_id: "plan" },
        // The only high-risk step (deploy) was explicitly refused.
        { status: "rejected", step_id: "deploy" },
      ],
    });
    // 1 high-risk step, 0 of them approved → 0/1 = 0, not 1.0.
    expect(result.risk_score).toBe(0);
  });

  it("risk_score counts an approval only once per high-risk step it covers", () => {
    const result = scoreRun({
      run: makeRun(),
      approvals: [
        { status: "approved", step_id: "plan" },
        { status: "approved", step_id: "implement" },
        { status: "approved", step_id: "deploy" },
      ],
    });
    // 3 approvals but only the deploy one covers the 1 high-risk step.
    expect(result.risk_score).toBe(1.0);
    // approval_count stays the run-wide count of approved approvals.
    expect(result.approval_count).toBe(3);
  });

  it("risk_score does not credit an approval with no step_id", () => {
    const result = scoreRun({
      run: makeRun(),
      // An approval that names no step cannot be shown to cover a high-risk one.
      approvals: [{ status: "approved" }],
    });
    expect(result.risk_score).toBe(0);
  });

  it("parses confidence from step notes", () => {
    const run = makeRun();
    run.steps[0].notes = "Step complete. confidence: 0.95";
    const result = scoreRun({ run, approvals: [] });
    expect(result.confidence).toBeGreaterThan(0.8); // pulled from notes
  });

  it("never produces negative or NaN cost/duration from corrupt timestamps", () => {
    const outOfOrder = makeRun();
    outOfOrder.created_at = "2025-01-01T10:05:00Z";
    outOfOrder.updated_at = "2025-01-01T10:00:00Z";
    outOfOrder.steps[0]!.started_at = "2025-01-01T10:03:00Z";
    outOfOrder.steps[0]!.completed_at = "2025-01-01T10:01:00Z";
    const scoredOutOfOrder = scoreRun({ run: outOfOrder, approvals: [] });
    expect(scoredOutOfOrder.duration_ms).toBe(0);
    expect(scoredOutOfOrder.cost_usd).toBeGreaterThanOrEqual(0);

    const unparseable = makeRun();
    unparseable.updated_at = "not-a-timestamp";
    unparseable.steps[0]!.completed_at = "not-a-timestamp";
    const scoredUnparseable = scoreRun({ run: unparseable, approvals: [] });
    expect(scoredUnparseable.duration_ms).toBe(0);
    expect(Number.isFinite(scoredUnparseable.cost_usd)).toBe(true);
    expect(scoredUnparseable.cost_usd).toBeGreaterThanOrEqual(0);
  });

  it("counts artifacts across all steps", () => {
    const result = scoreRun({ run: makeRun(), approvals: [] });
    expect(result.artifact_count).toBe(1); // only implement step has 1 artifact
  });

  it("scores the confidence the worker reported instead of a state constant", () => {
    // The worker's number used to reach the scorer only if it happened to
    // appear inside the free-text `notes`. It does not on the completed
    // path, so a 0.95 execution and a 0.25 execution both scored the
    // "completed" constant of 0.85 and the eval record published a number no
    // worker had produced.
    const scoreWith = (confidence: number | undefined) => {
      const run = makeRun();
      for (const step of run.steps) {
        step.state = "completed";
        step.worker_confidence = confidence;
        step.notes = "Executed repo-aware test command"; // worker prose, names no number
      }
      return scoreRun({ run, approvals: [] }).confidence;
    };

    expect(scoreWith(0.95)).toBe(0.95);
    expect(scoreWith(0.25)).toBe(0.25);
    expect(scoreWith(0.95)).not.toBe(scoreWith(0.25));
    // No reported confidence still falls back to the state constant rather
    // than inventing a number, so absent stays distinguishable.
    expect(scoreWith(undefined)).toBe(0.85);
  });

  it("ignores an unusable worker_confidence rather than scoring NaN", () => {
    // The field is persisted state and crosses a service boundary, so it can
    // arrive as a string, NaN or out of range from an older build or a
    // hand-edited state file.
    for (const bad of [Number.NaN, Infinity, -0.5, 1.5, "0.9" as unknown as number]) {
      const run = makeRun();
      for (const step of run.steps) {
        step.state = "completed";
        step.worker_confidence = bad;
      }
      const scored = scoreRun({ run, approvals: [] });
      expect(Number.isFinite(scored.confidence)).toBe(true);
      expect(scored.confidence).toBe(0.85);
    }
  });
});
