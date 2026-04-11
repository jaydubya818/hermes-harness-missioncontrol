import { describe, expect, it } from "vitest";
import { createWorkflowRun, startCurrentStep, advanceRun } from "./index.js";

describe("workflow-engine", () => {
  it("creates and advances a workflow", () => {
    const run = createWorkflowRun("run_demo", "mis_demo", "bugfix");
    expect(run.steps.length).toBeGreaterThan(0);
    startCurrentStep(run);
    expect(run.steps[0].status).toBe("running");
    advanceRun(run, "completed", "ok");
    expect(run.current_step_index).toBe(1);
  });
});
