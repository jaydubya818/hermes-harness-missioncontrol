import { describe, expect, it } from "vitest";
import { createWorkflowRun, startCurrentStep, advanceRun, markCurrentStepAwaitingApproval, markCurrentStepCompleted } from "./index.js";

describe("workflow-engine", () => {
  it("creates contract-shaped steps and advances a workflow", () => {
    const run = createWorkflowRun("run_demo", "mis_demo", "bugfix");
    expect(run.steps.length).toBeGreaterThan(0);
    expect(run.steps[0]).toMatchObject({ step_id: "plan", state: "pending", approval_mode: "on_policy_trigger" });

    startCurrentStep(run, "exec_demo");
    expect(run.steps[0]).toMatchObject({ state: "running", execution_id: "exec_demo" });

    advanceRun(run, "completed", "ok");
    expect(run.current_step_index).toBe(1);
    expect(run.steps[0].state).toBe("completed");
  });

  it("normalizes awaiting approval through one transition helper", () => {
    const run = createWorkflowRun("run_demo", "mis_demo", "bugfix");
    startCurrentStep(run, "exec_demo");

    markCurrentStepAwaitingApproval(run, "approval_demo", "worker summary", "needs approval");

    expect(run.status).toBe("awaiting_approval");
    expect(run.approval_id).toBe("approval_demo");
    expect(run.steps[0]).toMatchObject({
      step_id: "plan",
      state: "awaiting_approval",
      approval_id: "approval_demo",
      notes: "worker summary",
      blocked_reason: "needs approval",
      execution_id: "exec_demo"
    });
  });

  it("clears run-level approval visibility once approval-gated step completes", () => {
    const run = createWorkflowRun("run_demo", "mis_demo", "bugfix");
    startCurrentStep(run, "exec_demo");
    markCurrentStepAwaitingApproval(run, "approval_demo", "worker summary", "needs approval");

    markCurrentStepCompleted(run, "worker summary approved");

    expect(run.approval_id).toBeUndefined();
    expect(run.status).toBe("running");
    expect(run.steps[0]).toMatchObject({
      state: "completed",
      approval_id: "approval_demo",
      notes: "worker summary approved",
      blocked_reason: undefined
    });
  });
});
