import { describe, expect, it } from "vitest";
import { evaluateStepPolicy } from "./index.js";

describe("policy-engine", () => {
  it("requires approval for high-risk deploys", () => {
    const result = evaluateStepPolicy({ kind: "deploy", risk: "high" });
    expect(result.requires_approval).toBe(true);
  });
});
