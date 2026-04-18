import { describe, expect, it } from "vitest";
import {
  createWorkflowRun,
  startCurrentStep,
  advanceRun,
  markCurrentStepAwaitingApproval,
  markCurrentStepCompleted,
  pauseCurrentStep,
  resumeCurrentStep,
  retryCurrentStep,
  cancelCurrentStep,
} from "./index.js";

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

  it("pauses and resumes current step without losing execution context", () => {
    const run = createWorkflowRun("run_demo", "mis_demo", "bugfix");
    startCurrentStep(run, "exec_demo");

    pauseCurrentStep(run, "operator interrupt");
    expect(run.status).toBe("paused");
    expect(run.steps[0]).toMatchObject({
      state: "paused",
      execution_id: "exec_demo",
      notes: "operator interrupt"
    });

    resumeCurrentStep(run, "resume after interrupt");
    expect(run.status).toBe("running");
    expect(run.steps[0]).toMatchObject({
      state: "running",
      execution_id: "exec_demo",
      notes: "resume after interrupt"
    });
  });

  it("retries current step by clearing terminal blockers and returning to running", () => {
    const run = createWorkflowRun("run_demo", "mis_demo", "bugfix");
    startCurrentStep(run, "exec_demo");
    markCurrentStepAwaitingApproval(run, "approval_demo", "worker summary", "needs approval");

    retryCurrentStep(run, "retry requested");

    expect(run.status).toBe("running");
    expect(run.approval_id).toBeUndefined();
    expect(run.steps[0]).toMatchObject({
      state: "running",
      execution_id: "exec_demo",
      approval_id: undefined,
      blocked_reason: undefined,
      notes: "retry requested"
    });
  });

  it("cancels current step and run", () => {
    const run = createWorkflowRun("run_demo", "mis_demo", "bugfix");
    startCurrentStep(run, "exec_demo");

    cancelCurrentStep(run, "operator cancelled");

    expect(run.status).toBe("cancelled");
    expect(run.steps[0]).toMatchObject({
      state: "cancelled",
      notes: "operator cancelled"
    });
  });
});
