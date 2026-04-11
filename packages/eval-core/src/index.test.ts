import { describe, expect, it } from "vitest";
import { summarize } from "./index.js";

describe("eval-core", () => {
  it("summarizes run outcomes", () => {
    const result = summarize([{ mission_id: "m", run_id: "r", outcome: "success", cost_usd: 1, approval_count: 1, artifact_count: 2, created_at: new Date().toISOString() }]);
    expect(result.total_runs).toBe(1);
    expect(result.success_rate).toBe(1);
  });
});
