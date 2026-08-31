import { describe, expect, it } from "vitest";
import {
  createWorkflowRun,
  startCurrentStep,
  advanceRun,
  markCurrentStepAwaitingApproval,
  markCurrentStepCancelled,
  markCurrentStepCompleted,
  markCurrentStepFailed,
  getCurrentStep,
  pauseCurrentStep,
  resumeCurrentStep,
  retryCurrentStep,
  cancelCurrentStep,
  markCurrentStepBlocked,
  attachArtifact,
  syncRunState,
  type WorkflowArtifact,
  type WorkflowRun,
} from "./index.js";

describe("workflow-engine", () => {
  it("falls back to bugfix for inherited object keys instead of throwing", () => {
    // WORKFLOW_LIBRARY[workflow_id] also resolves Object.prototype members,
    // so "toString" yielded a function that `?? bugfix` never replaced and
    // template.map() threw a bare TypeError.
    for (const inherited of ["toString", "constructor", "valueOf"]) {
      const run = createWorkflowRun("run_proto", "mis_proto", inherited);
      expect(run.steps.map((step) => step.step_id)).toEqual(["plan", "implement", "test", "review", "deploy"]);
    }
  });

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
      execution_id: undefined,
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

  it("blocks the current step with a reason and lets retry clear the blocker", () => {
    const run = createWorkflowRun("run_demo", "mis_demo", "bugfix");
    startCurrentStep(run, "exec_demo");

    markCurrentStepBlocked(run, "waiting on external dependency", "blocked by ops");

    // Blocked parks the run in paused (operator attention required) while
    // preserving why the step cannot proceed.
    expect(run.status).toBe("paused");
    expect(run.steps[0]).toMatchObject({
      state: "blocked",
      blocked_reason: "waiting on external dependency",
      notes: "blocked by ops"
    });
    expect(run.steps[0]?.started_at).toBeDefined();
    expect(run.steps[0]?.completed_at).toBeUndefined();

    retryCurrentStep(run, "dependency arrived");

    expect(run.status).toBe("running");
    expect(run.steps[0]).toMatchObject({
      state: "running",
      blocked_reason: undefined,
      execution_id: undefined,
      notes: "dependency arrived"
    });
  });

  it("attaches artifacts once per artifact_id and normalizes kind/label from type", () => {
    const run = createWorkflowRun("run_demo", "mis_demo", "bugfix");
    startCurrentStep(run, "exec_demo");

    // Callers (orchestrator, worker results) supply type-only artifacts;
    // attachArtifact fills kind/label.
    const artifact = { artifact_id: "art_1", type: "plan", uri: "file:///plan.md" } as WorkflowArtifact;
    attachArtifact(run, "plan", artifact);
    // Re-attaching the same artifact_id (orchestrator retries, event replays)
    // must not duplicate the artifact.
    attachArtifact(run, "plan", artifact);
    attachArtifact(run, "missing-step", { artifact_id: "art_2", type: "plan", uri: "file:///other.md" } as WorkflowArtifact);

    expect(run.steps[0].artifacts).toHaveLength(1);
    expect(run.steps[0].artifacts[0]).toMatchObject({ artifact_id: "art_1", kind: "plan", label: "plan", uri: "file:///plan.md" });
    // Unknown step ids attach nowhere.
    expect(run.steps.flatMap((step) => step.artifacts).map((artifact) => artifact.artifact_id)).toEqual(["art_1"]);
  });

  it("rebuilds derived run fields from step state after a JSON round-trip", () => {
    const run = createWorkflowRun("run_demo", "mis_demo", "bugfix");
    startCurrentStep(run, "exec_demo");
    markCurrentStepAwaitingApproval(run, "approval_demo", "worker summary", "needs approval");

    // Simulate persistence: derived fields dropped or stale on the loaded copy.
    const loaded = JSON.parse(JSON.stringify(run)) as WorkflowRun;
    loaded.current_step_id = undefined;
    loaded.approval_id = undefined;
    loaded.summary = undefined;

    const synced = syncRunState(loaded);
    expect(synced.current_step_id).toBe("plan");
    expect(synced.approval_id).toBe("approval_demo");
    expect(synced.summary).toBe("worker summary");
    // Non-terminal runs must not carry a completed_at.
    expect(synced.completed_at).toBeUndefined();
  });

  it("does not resurrect a completed run via start or block transitions", () => {
    const run = createWorkflowRun("run_demo", "mis_demo", "dependency_upgrade");
    for (const _step of run.steps) {
      startCurrentStep(run);
      markCurrentStepCompleted(run, "done");
    }
    expect(run.status).toBe("completed");
    const completedAt = run.completed_at;
    const lastStep = run.steps[run.steps.length - 1];

    startCurrentStep(run, "exec_zombie");
    expect(run.status).toBe("completed");
    expect(run.completed_at).toBe(completedAt);
    expect(lastStep.state).toBe("completed");
    expect(lastStep.execution_id).not.toBe("exec_zombie");

    markCurrentStepBlocked(run, "should not apply");
    expect(run.status).toBe("completed");
    expect(lastStep.state).toBe("completed");
    expect(lastStep.blocked_reason).toBeUndefined();
  });

  it("fails the current step and the run, stamping a completion time", () => {
    const run = createWorkflowRun("run_demo", "mis_demo", "bugfix");
    startCurrentStep(run, "exec_demo");

    markCurrentStepFailed(run, "compiler error");

    expect(run.steps[0]).toMatchObject({ state: "failed", notes: "compiler error" });
    expect(run.steps[0].completed_at).toBeTruthy();
    expect(run.status).toBe("failed");
    // A failed run is terminal, so syncRunState must publish a run-level
    // completed_at rather than leaving the run looking still in flight.
    expect(run.completed_at).toBe(run.steps[0].completed_at);
    // Failing does not advance: the failed step stays current so retry and
    // the operator read models still point at it.
    expect(run.current_step_index).toBe(0);
    expect(run.current_step_id).toBe("plan");
  });

  it("does not overwrite an already terminal step when failing again", () => {
    const run = createWorkflowRun("run_demo", "mis_demo", "bugfix");
    startCurrentStep(run);
    cancelCurrentStep(run, "operator cancelled");
    const cancelledAt = run.steps[0].completed_at;

    markCurrentStepFailed(run, "should not apply");

    expect(run.steps[0]).toMatchObject({ state: "cancelled", notes: "operator cancelled" });
    expect(run.steps[0].completed_at).toBe(cancelledAt);
    expect(run.status).toBe("cancelled");
  });

  it("routes advanceRun('failed') through the same failure transition", () => {
    const run = createWorkflowRun("run_demo", "mis_demo", "bugfix");
    startCurrentStep(run);

    advanceRun(run, "failed", "tests red");

    expect(run.steps[0]).toMatchObject({ state: "failed", notes: "tests red" });
    expect(run.status).toBe("failed");
  });

  it("markCurrentStepCancelled is an alias for cancelCurrentStep", () => {
    const viaAlias = createWorkflowRun("run_alias", "mis_demo", "bugfix");
    const viaDirect = createWorkflowRun("run_direct", "mis_demo", "bugfix");
    startCurrentStep(viaAlias);
    startCurrentStep(viaDirect);

    markCurrentStepCancelled(viaAlias, "stop");
    cancelCurrentStep(viaDirect, "stop");

    expect(viaAlias.steps[0].state).toBe(viaDirect.steps[0].state);
    expect(viaAlias.status).toBe(viaDirect.status);
    expect(viaAlias.steps[0].approval_id).toBe(viaDirect.steps[0].approval_id);
  });

  it("treats a current_step_index past the end of the steps array as no current step", () => {
    // Nothing validates current_step_index when a run is hydrated from a
    // persisted state file -- hydrateState only checks that `steps` is an
    // array -- so an index pointing past the end has to degrade to "no
    // current step" instead of throwing or mutating the wrong step.
    const run = createWorkflowRun("run_demo", "mis_demo", "bugfix");
    run.current_step_index = run.steps.length + 5;

    expect(getCurrentStep(run)).toBeUndefined();
    expect(syncRunState(run).current_step_id).toBeUndefined();

    const statesBefore = run.steps.map((step) => step.state);
    startCurrentStep(run, "exec_oob");
    markCurrentStepFailed(run, "oob");
    markCurrentStepCancelled(run, "oob");
    retryCurrentStep(run, "oob");
    expect(run.steps.map((step) => step.state)).toEqual(statesBefore);
  });
});
