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
});
