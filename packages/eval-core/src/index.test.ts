import { describe, expect, it } from "vitest";
import { summarize } from "./index.js";
import { scoreRun } from "./scorer.js";
import type { WorkflowRun } from "@hermes-harness-with-missioncontrol/workflow-engine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  const now = new Date("2025-01-01T10:00:00Z");
  const later = new Date("2025-01-01T10:05:00Z"); // 5 min later
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
        id: "plan",     title: "Plan fix",         kind: "plan",      risk: "low",
        status: "completed",
        started_at:   new Date("2025-01-01T10:00:00Z").toISOString(),
        completed_at: new Date("2025-01-01T10:01:00Z").toISOString(),
        artifacts: [],
      },
      {
        id: "implement", title: "Implement patch",  kind: "implement", risk: "medium",
        status: "completed",
        started_at:   new Date("2025-01-01T10:01:00Z").toISOString(),
        completed_at: new Date("2025-01-01T10:03:00Z").toISOString(),
        artifacts: [{ artifact_id: "a1", type: "diff", uri: "patch.diff" }],
      },
      {
        id: "test",     title: "Run tests",         kind: "test",      risk: "low",
        status: "completed",
        started_at:   new Date("2025-01-01T10:03:00Z").toISOString(),
        completed_at: new Date("2025-01-01T10:04:00Z").toISOString(),
        artifacts: [],
      },
      {
        id: "review",   title: "Review diff",       kind: "review",    risk: "medium",
        status: "completed",
        started_at:   new Date("2025-01-01T10:04:00Z").toISOString(),
        completed_at: new Date("2025-01-01T10:04:30Z").toISOString(),
        artifacts: [],
      },
      {
        id: "deploy",   title: "Canary deploy",     kind: "deploy",    risk: "high",
        status: "completed",
        started_at:   new Date("2025-01-01T10:04:30Z").toISOString(),
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
    expect(result.average_confidence).toBe(0.5);
    expect(result.average_efficiency).toBe(0.4);
    expect(result.average_risk_score).toBe(0.75);
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
      approvals: [{ status: "approved" }], // 1 approved covers the 1 high-risk (deploy) step
    });
    expect(result.risk_score).toBe(1.0);
  });

  it("risk_score is 0 when high-risk step has no approvals", () => {
    const result = scoreRun({ run: makeRun(), approvals: [] });
    // 1 high-risk step, 0 approved → 0/1 = 0
    expect(result.risk_score).toBe(0);
  });

  it("parses confidence from step notes", () => {
    const run = makeRun();
    run.steps[0].notes = "Step complete. confidence: 0.95";
    const result = scoreRun({ run, approvals: [] });
    expect(result.confidence).toBeGreaterThan(0.8); // pulled from notes
  });

  it("counts artifacts across all steps", () => {
    const result = scoreRun({ run: makeRun(), approvals: [] });
    expect(result.artifact_count).toBe(1); // only implement step has 1 artifact
  });
});
