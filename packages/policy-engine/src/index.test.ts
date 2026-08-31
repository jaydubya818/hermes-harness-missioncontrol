import { describe, expect, it } from "vitest";
import { evaluateStepPolicy } from "./index.js";

describe("policy-engine", () => {
  it("requires approval for high-risk deploys", () => {
    const result = evaluateStepPolicy({ kind: "deploy", risk: "high" });
    expect(result.requires_approval).toBe(true);
  });

  it("blocks review steps that have no artifacts", () => {
    const result = evaluateStepPolicy({ kind: "review", risk: "medium", artifactCount: 0 });
    expect(result.allowed).toBe(false);
    expect(result.policy_id).toBe("review-needs-artifact");
  });

  it("requires approval when worker confidence is low", () => {
    const result = evaluateStepPolicy({ kind: "implement", risk: "medium", workerConfidence: 0.3 });
    expect(result.requires_approval).toBe(true);
    expect(result.policy_id).toBe("approval-low-confidence");
  });

  it("treats non-finite confidence as untrusted instead of bypassing the gate", () => {
    const result = evaluateStepPolicy({ kind: "implement", risk: "medium", workerConfidence: Number.NaN });
    expect(result.requires_approval).toBe(true);
    expect(result.confidence_score).toBe(0.5);
  });

  it("allows confident low-risk steps without approval", () => {
    const result = evaluateStepPolicy({ kind: "test", risk: "low", workerConfidence: 0.9 });
    expect(result.allowed).toBe(true);
    expect(result.requires_approval).toBe(false);
    expect(result.policy_id).toBe("allow-default");
  });

  it("requires approval for a deploy of any risk tier", () => {
    // The deploy gate is on `kind`, not `risk`: a deploy labelled low-risk
    // must not fall through to the confidence check.
    for (const risk of ["low", "medium", "high"] as const) {
      const result = evaluateStepPolicy({ kind: "deploy", risk, workerConfidence: 0.99 });
      expect(result.policy_id).toBe("approval-high-risk");
      expect(result.requires_approval).toBe(true);
    }
  });

  it("defaults a missing confidence to 0.5, which is below the approval threshold", () => {
    const result = evaluateStepPolicy({ kind: "implement", risk: "medium" });
    expect(result.confidence_score).toBe(0.5);
    expect(result.policy_id).toBe("approval-low-confidence");
  });

  it("clamps an out-of-range confidence into 0-1 before comparing it", () => {
    expect(evaluateStepPolicy({ kind: "test", risk: "low", workerConfidence: 4 })).toMatchObject({
      confidence_score: 1,
      policy_id: "allow-default",
    });
    // A negative value clamps to 0 rather than staying negative, so it still
    // trips the low-confidence gate instead of reading as "no opinion".
    expect(evaluateStepPolicy({ kind: "test", risk: "low", workerConfidence: -3 })).toMatchObject({
      confidence_score: 0,
      policy_id: "approval-low-confidence",
    });
  });

  it("treats 0.6 as confident enough and anything below it as not", () => {
    expect(evaluateStepPolicy({ kind: "test", risk: "low", workerConfidence: 0.6 }).requires_approval).toBe(false);
    expect(evaluateStepPolicy({ kind: "test", risk: "low", workerConfidence: 0.59 }).requires_approval).toBe(true);
  });

  it("reports a denied step as requires_approval: false, so callers must read `allowed`", () => {
    // The two flags are independent: a denial is not an approval request, and
    // reading only `requires_approval` would let a denied review through.
    const result = evaluateStepPolicy({ kind: "review", risk: "high", artifactCount: 0 });
    expect(result.allowed).toBe(false);
    expect(result.requires_approval).toBe(false);
    // The artifact rule is evaluated before the high-risk rule, so a
    // high-risk review with no artifacts is denied rather than gated.
    expect(result.policy_id).toBe("review-needs-artifact");
  });

  it("does not gate a risk value outside the low/medium/high union", () => {
    // Characterization of a real gap, not an endorsement. `risk` is a
    // compile-time union only: the orchestrator passes `step.risk` straight
    // through from a persisted run, and hydrateState validates nothing below
    // `Array.isArray(run.steps)`. A state file carrying any other string
    // therefore reaches here, misses `risk === "high"`, and a confident step
    // is auto-allowed with no approval.
    const result = evaluateStepPolicy({
      kind: "implement",
      risk: "critical" as unknown as "high",
      workerConfidence: 0.95,
    });
    expect(result.policy_id).toBe("allow-default");
    expect(result.requires_approval).toBe(false);
  });

  it("does not block a review whose artifact count is NaN or negative", () => {
    // Same class: `(artifactCount ?? 0) === 0` is an equality test, so NaN
    // (from a corrupt count) and a negative number both pass the gate that
    // exists to prove a review had something to review.
    for (const artifactCount of [Number.NaN, -1]) {
      const result = evaluateStepPolicy({ kind: "review", risk: "medium", artifactCount, workerConfidence: 0.9 });
      expect(result.allowed).toBe(true);
      expect(result.policy_id).toBe("allow-default");
    }
  });
});
