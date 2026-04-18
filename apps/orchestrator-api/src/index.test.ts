import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type MockResponseInit = {
  ok?: boolean;
  status?: number;
  body?: unknown;
};

function jsonResponse({ ok = true, status = 200, body = {} }: MockResponseInit = {}) {
  return {
    ok,
    status,
    json: async () => body
  } as Response;
}

async function loadApp(stateFile?: string) {
  vi.resetModules();
  process.env.VITEST = "1";
  process.env.ORCHESTRATOR_STATE_FILE = stateFile ?? join(mkdtempSync(join(tmpdir(), "orch-state-")), "state.json");
  const module = await import("./index.js");
  return module.app;
}

describe("orchestrator-api", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ORCHESTRATOR_STATE_FILE;
    process.env.VITEST = "1";
  });

  it("creates a contract-shaped mission payload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const app = await loadApp();
    const response = await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Contracts", project_id: "proj_demo", workflow_id: "bugfix", repo_path: "/repo" })
    });

    const mission = await response.json() as {
      mission_id: string;
      title: string;
      objective?: string;
      workflow: string;
      project_id: string;
      repo_path?: string;
      active_run_id?: string;
      status: string;
      created_at: string;
      updated_at: string;
    };

    expect(response.status).toBe(201);
    expect(mission).toMatchObject({
      title: "Contracts",
      objective: "Contracts",
      workflow: "bugfix",
      project_id: "proj_demo",
      repo_path: "/repo",
      status: "pending"
    });
    expect(mission.active_run_id).toBeUndefined();
  });

  it("returns a TaskExecutionResult-shaped execution_result payload", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/execute-step")) {
        return jsonResponse({
          body: {
            success: true,
            summary: "implemented change",
            confidence: 0.91,
            artifacts: [
              {
                type: "diff",
                uri: "file:///tmp/patch.diff",
                metadata: { changed_files: ["apps/orchestrator-api/src/index.ts"] }
              }
            ]
          }
        });
      }
      return jsonResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = await loadApp();
    const createMission = await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Contracts", project_id: "proj_demo", workflow_id: "bugfix" })
    });
    const mission = await createMission.json() as { mission_id: string };

    const startRun = await app.request(`/api/missions/${mission.mission_id}/start`, { method: "POST" });
    const run = await startRun.json() as { run_id: string };

    const execute = await app.request(`/api/runs/${run.run_id}/execute-current`, { method: "POST" });
    const payload = await execute.json() as {
      execution_result?: {
        execution_id: string;
        final_outcome: string;
        artifacts: Array<{ kind: string; label: string }>;
        changed_files: string[];
      };
    };

    expect(execute.status).toBe(200);
    expect(payload.execution_result).toBeDefined();
    expect(payload.execution_result?.execution_id).toMatch(/^exec_/);
    expect(payload.execution_result?.final_outcome).toBe("success");
    expect(payload.execution_result?.artifacts[0]).toMatchObject({ kind: "diff", label: "diff" });
    expect(payload.execution_result?.changed_files).toContain("apps/orchestrator-api/src/index.ts");
  });

  it("ingests worker step events into orchestrator event stream", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/execute-step")) {
        return jsonResponse({
          body: {
            success: true,
            summary: "implemented change",
            confidence: 0.91,
            artifacts: [],
            step_events: [
              {
                schema_version: "v1",
                event_id: "evt_worker_1",
                timestamp: "2026-04-18T18:00:00Z",
                sequence: 1,
                source: "hermes",
                type: "step.progress",
                mission_id: "mis_placeholder",
                run_id: "run_placeholder",
                step_id: "plan",
                execution_id: "exec_worker_1",
                payload: { message: "thinking" }
              }
            ]
          }
        });
      }
      return jsonResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = await loadApp();
    const createMission = await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Events", project_id: "proj_demo", workflow_id: "bugfix" })
    });
    const mission = await createMission.json() as { mission_id: string };

    const startRun = await app.request(`/api/missions/${mission.mission_id}/start`, { method: "POST" });
    const run = await startRun.json() as { run_id: string };

    const execute = await app.request(`/api/runs/${run.run_id}/execute-current`, { method: "POST" });
    expect(execute.status).toBe(200);

    const eventsResponse = await app.request("/api/events");
    const eventsPayload = await eventsResponse.json() as { events: Array<{ source?: string; type: string; execution_id?: string }> };
    expect(eventsPayload.events.some((event) => event.source === "hermes" && event.type === "step.progress" && event.execution_id === "exec_worker_1")).toBe(true);
  });

  it("fails the run when worker execution returns success false", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/execute-step")) {
        return jsonResponse({
          body: {
            success: false,
            summary: "tests failed",
            confidence: 0.2,
            artifacts: []
          }
        });
      }
      return jsonResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = await loadApp();
    const createMission = await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Regression", project_id: "proj_demo", workflow_id: "bugfix" })
    });
    const mission = await createMission.json() as { mission_id: string };

    const startRun = await app.request(`/api/missions/${mission.mission_id}/start`, { method: "POST" });
    const run = await startRun.json() as { run_id: string };

    const execute = await app.request(`/api/runs/${run.run_id}/execute-current`, { method: "POST" });
    const payload = await execute.json() as { run: { status: string; steps: Array<{ step_id: string; notes?: string; state?: string }> } };

    expect(execute.status).toBe(400);
    expect(payload.run.status).toBe("failed");
    expect(payload.run.steps[0]).toMatchObject({ step_id: "plan", notes: "tests failed", state: "failed" });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/cleanup-run"),
      expect.any(Object)
    );
  });

  it("records approval.requested and links step approval as primary truth", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-approval-request-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [{
        mission_id: "mis_demo",
        title: "Approval flow",
        objective: "Approval flow",
        project_id: "proj_demo",
        workflow: "bugfix",
        status: "running",
        active_run_id: "run_demo",
        summary: "Mission started",
        created_at: "2026-04-11T00:00:00.000Z",
        updated_at: "2026-04-11T00:00:00.000Z"
      }],
      runs: [{
        run_id: "run_demo",
        mission_id: "mis_demo",
        workflow_id: "bugfix",
        status: "running",
        current_step_index: 4,
        current_step_id: "deploy",
        created_at: "2026-04-11T00:00:00.000Z",
        updated_at: "2026-04-11T00:00:00.000Z",
        steps: [
          { step_id: "plan", title: "Plan fix", kind: "plan", risk: "low", approval_mode: "on_policy_trigger", state: "completed", artifacts: [], completed_at: "2026-04-11T00:00:00.000Z" },
          { step_id: "implement", title: "Implement patch", kind: "implement", risk: "medium", approval_mode: "on_policy_trigger", state: "completed", artifacts: [], completed_at: "2026-04-11T00:00:00.000Z" },
          { step_id: "test", title: "Run tests", kind: "test", risk: "low", approval_mode: "on_policy_trigger", state: "completed", artifacts: [], completed_at: "2026-04-11T00:00:00.000Z" },
          { step_id: "review", title: "Review diff", kind: "review", risk: "medium", approval_mode: "on_policy_trigger", state: "completed", artifacts: [{ artifact_id: "art_review", kind: "diff", label: "diff", uri: "file:///tmp/review.diff" }], completed_at: "2026-04-11T00:00:00.000Z" },
          { step_id: "deploy", title: "Canary deploy", kind: "deploy", risk: "high", approval_mode: "on_policy_trigger", state: "running", artifacts: [], started_at: "2026-04-11T00:00:00.000Z" }
        ]
      }],
      approvals: [],
      events: [],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const response = await app.request("/api/runs/run_demo/steps/deploy/complete", { method: "POST" });
    const payload = await response.json() as {
      run: { status: string; approval_id?: string; steps: Array<{ step_id: string; state: string; approval_id?: string }> };
      approval: { approval_id: string; status: string };
    };

    expect(response.status).toBe(200);
    expect(payload.approval.status).toBe("pending");
    expect(payload.run.status).toBe("awaiting_approval");
    expect(payload.run.approval_id).toBe(payload.approval.approval_id);
    expect(payload.run.steps.find((step) => step.step_id === "deploy")).toMatchObject({
      step_id: "deploy",
      state: "awaiting_approval",
      approval_id: payload.approval.approval_id
    });

    const eventsResponse = await app.request("/api/events");
    const eventsPayload = await eventsResponse.json() as { events: Array<{ type: string; payload?: { approval_id?: string } }> };
    expect(eventsPayload.events.some((event) => event.type === "approval.requested" && event.payload?.approval_id === payload.approval.approval_id)).toBe(true);
  });

  it("records approval.resolved for approved decisions and clears active run approval visibility", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-approval-approved-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [{
        mission_id: "mis_demo",
        title: "Approval flow",
        objective: "Approval flow",
        project_id: "proj_demo",
        workflow: "bugfix",
        status: "awaiting_approval",
        active_run_id: "run_demo",
        summary: "high-risk action requires approval",
        created_at: "2026-04-11T00:00:00.000Z",
        updated_at: "2026-04-11T00:00:00.000Z"
      }],
      runs: [{
        run_id: "run_demo",
        mission_id: "mis_demo",
        workflow_id: "bugfix",
        status: "awaiting_approval",
        current_step_index: 4,
        current_step_id: "deploy",
        approval_id: "approval_demo",
        created_at: "2026-04-11T00:00:00.000Z",
        updated_at: "2026-04-11T00:00:00.000Z",
        steps: [
          { step_id: "plan", title: "Plan fix", kind: "plan", risk: "low", approval_mode: "on_policy_trigger", state: "completed", artifacts: [], completed_at: "2026-04-11T00:00:00.000Z" },
          { step_id: "implement", title: "Implement patch", kind: "implement", risk: "medium", approval_mode: "on_policy_trigger", state: "completed", artifacts: [], completed_at: "2026-04-11T00:00:00.000Z" },
          { step_id: "test", title: "Run tests", kind: "test", risk: "low", approval_mode: "on_policy_trigger", state: "completed", artifacts: [], completed_at: "2026-04-11T00:00:00.000Z" },
          { step_id: "review", title: "Review diff", kind: "review", risk: "medium", approval_mode: "on_policy_trigger", state: "completed", artifacts: [{ artifact_id: "art_review", kind: "diff", label: "diff", uri: "file:///tmp/review.diff" }], completed_at: "2026-04-11T00:00:00.000Z" },
          { step_id: "deploy", title: "Canary deploy", kind: "deploy", risk: "high", approval_mode: "on_policy_trigger", state: "awaiting_approval", approval_id: "approval_demo", artifacts: [{ artifact_id: "art_deploy", kind: "deploy-note", label: "deploy-note", uri: "file:///tmp/deploy.txt" }], started_at: "2026-04-11T00:00:00.000Z", notes: "deploy prepared", blocked_reason: "high-risk action requires approval" }
        ]
      }],
      approvals: [{
        approval_id: "approval_demo",
        mission_id: "mis_demo",
        run_id: "run_demo",
        step_id: "deploy",
        status: "pending",
        reason: "high-risk action requires approval",
        created_at: "2026-04-11T00:00:00.000Z"
      }],
      events: [],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const response = await app.request("/api/approvals/approval_demo/respond", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved" })
    });
    const payload = await response.json() as {
      approval: { approval_id: string; status: string; resolved_at?: string };
      run: { status: string; approval_id?: string; steps: Array<{ step_id: string; state: string; approval_id?: string }> };
    };

    expect(response.status).toBe(200);
    expect(payload.approval.status).toBe("approved");
    expect(payload.approval.resolved_at).toBeDefined();
    expect(payload.run.status).toBe("completed");
    expect(payload.run.approval_id).toBeUndefined();
    expect(payload.run.steps.find((step) => step.step_id === "deploy")).toMatchObject({
      step_id: "deploy",
      state: "completed",
      approval_id: "approval_demo"
    });

    const eventsResponse = await app.request("/api/events");
    const eventsPayload = await eventsResponse.json() as { events: Array<{ type: string; payload?: { approval_id?: string; decision?: string } }> };
    expect(eventsPayload.events.some((event) => event.type === "approval.resolved" && event.payload?.approval_id === "approval_demo" && event.payload?.decision === "approved")).toBe(true);
  });

  it("records approval.resolved for rejected decisions and fails the run", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-approval-rejected-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [{
        mission_id: "mis_demo",
        title: "Approval flow",
        objective: "Approval flow",
        project_id: "proj_demo",
        workflow: "bugfix",
        status: "awaiting_approval",
        active_run_id: "run_demo",
        summary: "high-risk action requires approval",
        created_at: "2026-04-11T00:00:00.000Z",
        updated_at: "2026-04-11T00:00:00.000Z"
      }],
      runs: [{
        run_id: "run_demo",
        mission_id: "mis_demo",
        workflow_id: "bugfix",
        status: "awaiting_approval",
        current_step_index: 4,
        current_step_id: "deploy",
        approval_id: "approval_demo",
        created_at: "2026-04-11T00:00:00.000Z",
        updated_at: "2026-04-11T00:00:00.000Z",
        steps: [
          { step_id: "plan", title: "Plan fix", kind: "plan", risk: "low", approval_mode: "on_policy_trigger", state: "completed", artifacts: [], completed_at: "2026-04-11T00:00:00.000Z" },
          { step_id: "implement", title: "Implement patch", kind: "implement", risk: "medium", approval_mode: "on_policy_trigger", state: "completed", artifacts: [], completed_at: "2026-04-11T00:00:00.000Z" },
          { step_id: "test", title: "Run tests", kind: "test", risk: "low", approval_mode: "on_policy_trigger", state: "completed", artifacts: [], completed_at: "2026-04-11T00:00:00.000Z" },
          { step_id: "review", title: "Review diff", kind: "review", risk: "medium", approval_mode: "on_policy_trigger", state: "completed", artifacts: [{ artifact_id: "art_review", kind: "diff", label: "diff", uri: "file:///tmp/review.diff" }], completed_at: "2026-04-11T00:00:00.000Z" },
          { step_id: "deploy", title: "Canary deploy", kind: "deploy", risk: "high", approval_mode: "on_policy_trigger", state: "awaiting_approval", approval_id: "approval_demo", artifacts: [{ artifact_id: "art_deploy", kind: "deploy-note", label: "deploy-note", uri: "file:///tmp/deploy.txt" }], started_at: "2026-04-11T00:00:00.000Z", notes: "deploy prepared", blocked_reason: "high-risk action requires approval" }
        ]
      }],
      approvals: [{
        approval_id: "approval_demo",
        mission_id: "mis_demo",
        run_id: "run_demo",
        step_id: "deploy",
        status: "pending",
        reason: "high-risk action requires approval",
        created_at: "2026-04-11T00:00:00.000Z"
      }],
      events: [],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const response = await app.request("/api/approvals/approval_demo/respond", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "rejected" })
    });
    const payload = await response.json() as {
      approval: { approval_id: string; status: string; resolved_at?: string };
      run: { status: string; approval_id?: string; steps: Array<{ step_id: string; state: string; approval_id?: string }> };
    };

    expect(response.status).toBe(200);
    expect(payload.approval.status).toBe("rejected");
    expect(payload.approval.resolved_at).toBeDefined();
    expect(payload.run.status).toBe("failed");
    expect(payload.run.approval_id).toBeUndefined();
    expect(payload.run.steps.find((step) => step.step_id === "deploy")).toMatchObject({
      step_id: "deploy",
      state: "failed",
      approval_id: "approval_demo"
    });

    const eventsResponse = await app.request("/api/events");
    const eventsPayload = await eventsResponse.json() as { events: Array<{ type: string; payload?: { approval_id?: string; decision?: string } }> };
    expect(eventsPayload.events.some((event) => event.type === "approval.resolved" && event.payload?.approval_id === "approval_demo" && event.payload?.decision === "rejected")).toBe(true);
    expect(eventsPayload.events.some((event) => event.type === "step.failed")).toBe(true);
  });

  it("builds overview read model for console summary", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-overview-read-model-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [
        {
          mission_id: "mis_open",
          title: "Open mission",
          objective: "Open mission",
          project_id: "proj_demo",
          workflow: "bugfix",
          status: "awaiting_approval",
          active_run_id: "run_open",
          summary: "Waiting on deploy approval",
          created_at: "2026-04-11T00:00:00.000Z",
          updated_at: "2026-04-11T00:00:00.000Z"
        },
        {
          mission_id: "mis_failed",
          title: "Failed mission",
          objective: "Failed mission",
          project_id: "proj_demo",
          workflow: "bugfix",
          status: "failed",
          active_run_id: "run_failed",
          summary: "Tests failed",
          created_at: "2026-04-11T00:00:00.000Z",
          updated_at: "2026-04-11T00:00:00.000Z"
        }
      ],
      runs: [],
      approvals: [{
        approval_id: "approval_demo",
        mission_id: "mis_open",
        run_id: "run_open",
        step_id: "deploy",
        status: "pending",
        reason: "high-risk action requires approval",
        decision_scope: "step",
        requested_at: "2026-04-11T00:00:00.000Z"
      }],
      events: [],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const response = await app.request("/api/read-models/overview");
    const payload = await response.json() as {
      metrics: {
        open_missions: number;
        pending_approvals: number;
        failed_missions: number;
      };
    };

    expect(response.status).toBe(200);
    expect(payload.metrics).toEqual({
      open_missions: 2,
      pending_approvals: 1,
      failed_missions: 1
    });
  });

  it("builds missions read model with presentation-shaped run cards", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-missions-read-model-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [{
        mission_id: "mis_demo",
        title: "Approval flow",
        objective: "Approval flow",
        project_id: "proj_demo",
        workflow: "bugfix",
        status: "awaiting_approval",
        active_run_id: "run_demo",
        summary: "Waiting on deploy approval",
        repo_path: "/repo",
        created_at: "2026-04-11T00:00:00.000Z",
        updated_at: "2026-04-11T00:00:00.000Z"
      }],
      runs: [{
        run_id: "run_demo",
        mission_id: "mis_demo",
        workflow_id: "bugfix",
        status: "awaiting_approval",
        current_step_index: 4,
        current_step_id: "deploy",
        approval_id: "approval_demo",
        summary: "deploy prepared",
        created_at: "2026-04-11T00:00:00.000Z",
        updated_at: "2026-04-11T00:00:00.000Z",
        steps: [
          { step_id: "plan", title: "Plan fix", kind: "plan", risk: "low", approval_mode: "on_policy_trigger", state: "completed", artifacts: [], completed_at: "2026-04-11T00:00:00.000Z" },
          { step_id: "implement", title: "Implement patch", kind: "implement", risk: "medium", approval_mode: "on_policy_trigger", state: "completed", artifacts: [], completed_at: "2026-04-11T00:00:00.000Z" },
          { step_id: "test", title: "Run tests", kind: "test", risk: "low", approval_mode: "on_policy_trigger", state: "completed", artifacts: [], completed_at: "2026-04-11T00:00:00.000Z" },
          { step_id: "review", title: "Review diff", kind: "review", risk: "medium", approval_mode: "on_policy_trigger", state: "completed", artifacts: [{ artifact_id: "art_review", kind: "diff", label: "diff", uri: "file:///tmp/review.diff" }], completed_at: "2026-04-11T00:00:00.000Z" },
          { step_id: "deploy", title: "Canary deploy", kind: "deploy", risk: "high", approval_mode: "on_policy_trigger", state: "awaiting_approval", approval_id: "approval_demo", artifacts: [{ artifact_id: "art_deploy", kind: "deploy-note", label: "deploy-note", uri: "file:///tmp/deploy.txt" }], started_at: "2026-04-11T00:00:00.000Z", notes: "deploy prepared", blocked_reason: "high-risk action requires approval" }
        ]
      }],
      approvals: [{
        approval_id: "approval_demo",
        mission_id: "mis_demo",
        run_id: "run_demo",
        step_id: "deploy",
        status: "pending",
        reason: "high-risk action requires approval",
        decision_scope: "step",
        requested_at: "2026-04-11T00:00:00.000Z"
      }],
      events: [],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const response = await app.request("/api/read-models/missions");
    const payload = await response.json() as {
      mission_queue: Array<{ mission_id: string; status: string; active_run_id?: string }>;
      approval_queue: Array<{ approval_id: string; step_id: string; status: string; requested_at: string }>;
      run_cards: Array<{
        run_id: string;
        workflow_id: string;
        status: string;
        current_step_id?: string;
        steps: Array<{
          step_id: string;
          state: string;
          artifacts_count: number;
          latest_artifact_uri?: string;
          blocked_reason?: string;
        }>;
      }>;
    };

    expect(response.status).toBe(200);
    expect(payload.mission_queue[0]).toMatchObject({ mission_id: "mis_demo", status: "awaiting_approval", active_run_id: "run_demo" });
    expect(payload.approval_queue[0]).toMatchObject({ approval_id: "approval_demo", step_id: "deploy", status: "pending", requested_at: "2026-04-11T00:00:00.000Z" });
    expect(payload.run_cards[0]).toMatchObject({ run_id: "run_demo", workflow_id: "bugfix", status: "awaiting_approval", current_step_id: "deploy" });
    expect(payload.run_cards[0].steps.find((step) => step.step_id === "deploy")).toMatchObject({
      step_id: "deploy",
      state: "awaiting_approval",
      artifacts_count: 1,
      latest_artifact_uri: "file:///tmp/deploy.txt",
      blocked_reason: "high-risk action requires approval"
    });
  });

  it("builds approval queue and history read models for operator views", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-approval-read-models-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [{
        mission_id: "mis_demo",
        title: "Approval flow",
        objective: "Approval flow",
        project_id: "proj_demo",
        workflow: "bugfix",
        status: "awaiting_approval",
        active_run_id: "run_demo",
        summary: "Waiting on deploy approval",
        created_at: "2026-04-11T00:00:00.000Z",
        updated_at: "2026-04-11T00:00:00.000Z"
      }],
      runs: [{
        run_id: "run_demo",
        mission_id: "mis_demo",
        workflow_id: "bugfix",
        status: "awaiting_approval",
        current_step_index: 4,
        current_step_id: "deploy",
        approval_id: "approval_pending",
        created_at: "2026-04-11T00:00:00.000Z",
        updated_at: "2026-04-11T00:00:00.000Z",
        steps: [
          { step_id: "plan", title: "Plan fix", kind: "plan", risk: "low", approval_mode: "on_policy_trigger", state: "completed", artifacts: [], completed_at: "2026-04-11T00:00:00.000Z" },
          { step_id: "implement", title: "Implement patch", kind: "implement", risk: "medium", approval_mode: "on_policy_trigger", state: "completed", artifacts: [], completed_at: "2026-04-11T00:00:00.000Z" },
          { step_id: "test", title: "Run tests", kind: "test", risk: "low", approval_mode: "on_policy_trigger", state: "completed", artifacts: [], completed_at: "2026-04-11T00:00:00.000Z" },
          { step_id: "review", title: "Review diff", kind: "review", risk: "medium", approval_mode: "on_policy_trigger", state: "completed", artifacts: [], completed_at: "2026-04-11T00:00:00.000Z" },
          { step_id: "deploy", title: "Canary deploy", kind: "deploy", risk: "high", approval_mode: "on_policy_trigger", state: "awaiting_approval", approval_id: "approval_pending", artifacts: [], started_at: "2026-04-11T00:00:00.000Z", blocked_reason: "high-risk action requires approval" }
        ]
      }],
      approvals: [
        {
          approval_id: "approval_pending",
          mission_id: "mis_demo",
          run_id: "run_demo",
          step_id: "deploy",
          status: "pending",
          reason: "high-risk action requires approval",
          decision_scope: "step",
          requested_at: "2026-04-11T00:00:00.000Z"
        },
        {
          approval_id: "approval_done",
          mission_id: "mis_demo",
          run_id: "run_demo",
          step_id: "review",
          status: "approved",
          reason: "review confidence low",
          decision_scope: "step",
          requested_at: "2026-04-10T00:00:00.000Z",
          resolved_at: "2026-04-10T01:00:00.000Z",
          resolved_by: "jay"
        }
      ],
      events: [],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const queueResponse = await app.request("/api/read-models/approvals");
    const queuePayload = await queueResponse.json() as {
      pending_approvals: Array<{ approval_id: string; actor: string; outcome: string; requested_at: string }>;
      history: Array<{ approval_id: string; actor: string; outcome: string; resolved_at?: string }>;
    };

    expect(queueResponse.status).toBe(200);
    expect(queuePayload.pending_approvals[0]).toMatchObject({
      approval_id: "approval_pending",
      actor: "system",
      outcome: "pending",
      requested_at: "2026-04-11T00:00:00.000Z"
    });
    expect(queuePayload.history[0]).toMatchObject({
      approval_id: "approval_done",
      actor: "jay",
      outcome: "approved",
      resolved_at: "2026-04-10T01:00:00.000Z"
    });

    const historyResponse = await app.request("/api/read-models/approval-history");
    const historyPayload = await historyResponse.json() as {
      approvals: Array<{ approval_id: string; actor: string; outcome: string; mission_id: string; run_id: string; step_id: string }>;
    };
    expect(historyResponse.status).toBe(200);
    expect(historyPayload.approvals[0]).toMatchObject({
      approval_id: "approval_done",
      actor: "jay",
      outcome: "approved",
      mission_id: "mis_demo",
      run_id: "run_demo",
      step_id: "review"
    });
  });

  it("builds audit timeline read model without exposing raw event internals", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-audit-read-model-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [{
        mission_id: "mis_demo",
        title: "Approval flow",
        objective: "Approval flow",
        project_id: "proj_demo",
        workflow: "bugfix",
        status: "awaiting_approval",
        active_run_id: "run_demo",
        summary: "Waiting on deploy approval",
        created_at: "2026-04-11T00:00:00.000Z",
        updated_at: "2026-04-11T00:00:00.000Z"
      }],
      runs: [{
        run_id: "run_demo",
        mission_id: "mis_demo",
        workflow_id: "bugfix",
        status: "awaiting_approval",
        current_step_index: 4,
        current_step_id: "deploy",
        approval_id: "approval_pending",
        created_at: "2026-04-11T00:00:00.000Z",
        updated_at: "2026-04-11T00:00:00.000Z",
        steps: []
      }],
      approvals: [{
        approval_id: "approval_pending",
        mission_id: "mis_demo",
        run_id: "run_demo",
        step_id: "deploy",
        status: "pending",
        reason: "high-risk action requires approval",
        decision_scope: "step",
        requested_at: "2026-04-11T00:00:00.000Z"
      }],
      events: [
        { type: "step.started", ts: "2026-04-11T00:00:00.000Z", mission_id: "mis_demo", run_id: "run_demo", step_id: "deploy", payload: { noisy: true } },
        { type: "approval.requested", ts: "2026-04-11T00:01:00.000Z", mission_id: "mis_demo", run_id: "run_demo", step_id: "deploy", payload: { approval_id: "approval_pending", noisy: true } },
        { type: "approval.resolved", ts: "2026-04-11T00:02:00.000Z", mission_id: "mis_demo", run_id: "run_demo", step_id: "deploy", payload: { approval_id: "approval_pending", decision: "approved", noisy: true } }
      ],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const response = await app.request("/api/read-models/audit");
    const payload = await response.json() as {
      timeline: Array<{ kind: string; title: string; occurred_at: string; mission_id?: string; run_id?: string; step_id?: string }>;
    };

    expect(response.status).toBe(200);
    expect(payload.timeline[0]).toMatchObject({ kind: "approval", title: "Approval resolved", occurred_at: "2026-04-11T00:02:00.000Z", mission_id: "mis_demo", run_id: "run_demo", step_id: "deploy" });
    expect(payload.timeline[1]).toMatchObject({ kind: "approval", title: "Approval requested", occurred_at: "2026-04-11T00:01:00.000Z" });
    expect(payload.timeline[2]).toMatchObject({ kind: "step", title: "Step started", occurred_at: "2026-04-11T00:00:00.000Z" });
  });

  it("filters and sorts approval history read model", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-approval-history-filters-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [
        { mission_id: "mis_demo", title: "Approval flow", objective: "Approval flow", project_id: "proj_demo", workflow: "bugfix", status: "awaiting_approval", active_run_id: "run_demo", summary: "Waiting on deploy approval", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z" },
        { mission_id: "mis_other", title: "Other flow", objective: "Other flow", project_id: "proj_demo", workflow: "bugfix", status: "completed", active_run_id: "run_other", summary: "Done", created_at: "2026-04-09T00:00:00.000Z", updated_at: "2026-04-09T00:00:00.000Z" }
      ],
      runs: [],
      approvals: [
        { approval_id: "approval_rejected", mission_id: "mis_demo", run_id: "run_demo", step_id: "deploy", status: "rejected", reason: "too risky", decision_scope: "step", requested_at: "2026-04-11T00:00:00.000Z", resolved_at: "2026-04-11T02:00:00.000Z", resolved_by: "alex" },
        { approval_id: "approval_approved", mission_id: "mis_demo", run_id: "run_demo", step_id: "review", status: "approved", reason: "looks good", decision_scope: "step", requested_at: "2026-04-10T00:00:00.000Z", resolved_at: "2026-04-10T02:00:00.000Z", resolved_by: "jay" },
        { approval_id: "approval_other", mission_id: "mis_other", run_id: "run_other", step_id: "deploy", status: "approved", reason: "other flow", decision_scope: "step", requested_at: "2026-04-09T00:00:00.000Z", resolved_at: "2026-04-09T02:00:00.000Z", resolved_by: "jay" }
      ],
      events: [],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const response = await app.request("/api/read-models/approval-history?mission_id=mis_demo&sort=rejected_first");
    const payload = await response.json() as {
      approvals: Array<{ approval_id: string; actor: string; outcome: string; mission_id: string }>;
    };

    expect(response.status).toBe(200);
    expect(payload.approvals).toHaveLength(2);
    expect(payload.approvals[0]).toMatchObject({ approval_id: "approval_rejected", actor: "alex", outcome: "rejected", mission_id: "mis_demo" });
    expect(payload.approvals[1]).toMatchObject({ approval_id: "approval_approved", actor: "jay", outcome: "approved", mission_id: "mis_demo" });
  });

  it("filters and sorts audit timeline read model", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-audit-filters-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [{ mission_id: "mis_demo", title: "Approval flow", objective: "Approval flow", project_id: "proj_demo", workflow: "bugfix", status: "awaiting_approval", active_run_id: "run_demo", summary: "Waiting on deploy approval", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z" }],
      runs: [{ run_id: "run_demo", mission_id: "mis_demo", workflow_id: "bugfix", status: "awaiting_approval", current_step_index: 4, current_step_id: "deploy", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z", steps: [] }],
      approvals: [],
      events: [
        { type: "step.started", ts: "2026-04-11T00:00:00.000Z", mission_id: "mis_demo", run_id: "run_demo", step_id: "deploy", payload: {} },
        { type: "approval.requested", ts: "2026-04-11T00:01:00.000Z", mission_id: "mis_demo", run_id: "run_demo", step_id: "deploy", payload: { approval_id: "approval_pending" } },
        { type: "approval.resolved", ts: "2026-04-11T00:02:00.000Z", mission_id: "mis_demo", run_id: "run_demo", step_id: "deploy", payload: { approval_id: "approval_pending", decision: "approved" } },
        { type: "approval.resolved", ts: "2026-04-09T00:02:00.000Z", mission_id: "mis_demo", run_id: "run_old", step_id: "review", payload: { approval_id: "approval_old", decision: "rejected" } }
      ],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const response = await app.request("/api/read-models/audit?event_type=approval.resolved&run_id=run_demo&from=2026-04-11T00:00:00.000Z&sort=oldest");
    const payload = await response.json() as {
      timeline: Array<{ title: string; occurred_at: string; run_id?: string }>;
    };

    expect(response.status).toBe(200);
    expect(payload.timeline).toHaveLength(1);
    expect(payload.timeline[0]).toMatchObject({ title: "Approval resolved", occurred_at: "2026-04-11T00:02:00.000Z", run_id: "run_demo" });
  });

  it("builds mission detail read model with approval, artifact, and timeline summaries", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-mission-detail-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [{ mission_id: "mis_demo", title: "Approval flow", objective: "Approval flow", project_id: "proj_demo", workflow: "bugfix", status: "awaiting_approval", active_run_id: "run_demo", summary: "Waiting on deploy approval", repo_path: "/repo", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z" }],
      runs: [{
        run_id: "run_demo", mission_id: "mis_demo", workflow_id: "bugfix", status: "awaiting_approval", current_step_index: 4, current_step_id: "deploy", approval_id: "approval_demo", summary: "deploy prepared", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z",
        steps: [
          { step_id: "plan", title: "Plan fix", kind: "plan", risk: "low", approval_mode: "on_policy_trigger", state: "completed", artifacts: [{ artifact_id: "art_plan", kind: "note", label: "note", uri: "file:///tmp/plan.txt" }], completed_at: "2026-04-11T00:00:00.000Z" },
          { step_id: "deploy", title: "Canary deploy", kind: "deploy", risk: "high", approval_mode: "on_policy_trigger", state: "awaiting_approval", approval_id: "approval_demo", artifacts: [{ artifact_id: "art_deploy", kind: "deploy-note", label: "deploy-note", uri: "file:///tmp/deploy.txt" }], started_at: "2026-04-11T00:00:00.000Z", blocked_reason: "high-risk action requires approval" }
        ]
      }],
      approvals: [{ approval_id: "approval_demo", mission_id: "mis_demo", run_id: "run_demo", step_id: "deploy", status: "pending", reason: "high-risk action requires approval", decision_scope: "step", requested_at: "2026-04-11T00:00:00.000Z" }],
      events: [
        { type: "mission.created", ts: "2026-04-11T00:00:00.000Z", mission_id: "mis_demo", payload: {} },
        { type: "run.started", ts: "2026-04-11T00:01:00.000Z", mission_id: "mis_demo", run_id: "run_demo", payload: {} },
        { type: "approval.requested", ts: "2026-04-11T00:02:00.000Z", mission_id: "mis_demo", run_id: "run_demo", step_id: "deploy", payload: { approval_id: "approval_demo" } }
      ],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const response = await app.request("/api/read-models/missions/mis_demo");
    const payload = await response.json() as {
      mission: { mission_id: string; active_run_id?: string };
      approval_summary: { pending: number; approved: number; rejected: number };
      artifact_summary: { total_artifacts: number };
      timeline_summary: { total_events: number; recent: Array<{ title: string }> };
    };

    expect(response.status).toBe(200);
    expect(payload.mission).toMatchObject({ mission_id: "mis_demo", active_run_id: "run_demo" });
    expect(payload.approval_summary).toEqual({ pending: 1, approved: 0, rejected: 0 });
    expect(payload.artifact_summary.total_artifacts).toBe(2);
    expect(payload.timeline_summary.total_events).toBe(3);
    expect(payload.timeline_summary.recent[0]).toMatchObject({ title: "Approval requested" });
  });

  it("builds run detail read model with steps, approvals, artifacts, and timeline summaries", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-run-detail-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [{ mission_id: "mis_demo", title: "Approval flow", objective: "Approval flow", project_id: "proj_demo", workflow: "bugfix", status: "awaiting_approval", active_run_id: "run_demo", summary: "Waiting on deploy approval", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z" }],
      runs: [{
        run_id: "run_demo", mission_id: "mis_demo", workflow_id: "bugfix", status: "awaiting_approval", current_step_index: 1, current_step_id: "deploy", approval_id: "approval_demo", summary: "deploy prepared", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z",
        steps: [
          { step_id: "plan", title: "Plan fix", kind: "plan", risk: "low", approval_mode: "on_policy_trigger", state: "completed", artifacts: [{ artifact_id: "art_plan", kind: "note", label: "note", uri: "file:///tmp/plan.txt" }], completed_at: "2026-04-11T00:00:00.000Z" },
          { step_id: "deploy", title: "Canary deploy", kind: "deploy", risk: "high", approval_mode: "on_policy_trigger", state: "awaiting_approval", approval_id: "approval_demo", artifacts: [{ artifact_id: "art_deploy", kind: "deploy-note", label: "deploy-note", uri: "file:///tmp/deploy.txt" }], started_at: "2026-04-11T00:00:00.000Z", blocked_reason: "high-risk action requires approval" }
        ]
      }],
      approvals: [{ approval_id: "approval_demo", mission_id: "mis_demo", run_id: "run_demo", step_id: "deploy", status: "pending", reason: "high-risk action requires approval", decision_scope: "step", requested_at: "2026-04-11T00:00:00.000Z" }],
      events: [
        { type: "run.started", ts: "2026-04-11T00:01:00.000Z", mission_id: "mis_demo", run_id: "run_demo", payload: {} },
        { type: "step.started", ts: "2026-04-11T00:02:00.000Z", mission_id: "mis_demo", run_id: "run_demo", step_id: "deploy", payload: {} },
        { type: "approval.requested", ts: "2026-04-11T00:03:00.000Z", mission_id: "mis_demo", run_id: "run_demo", step_id: "deploy", payload: { approval_id: "approval_demo" } }
      ],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const response = await app.request("/api/read-models/runs/run_demo");
    const payload = await response.json() as {
      run: { run_id: string; mission_id: string; current_step_id?: string };
      steps: Array<{ step_id: string; artifacts_count: number; latest_artifact_uri?: string }>;
      approval_summary: { pending: number; approved: number; rejected: number };
      artifact_summary: { total_artifacts: number };
      timeline_summary: { total_events: number; recent: Array<{ title: string }> };
    };

    expect(response.status).toBe(200);
    expect(payload.run).toMatchObject({ run_id: "run_demo", mission_id: "mis_demo", current_step_id: "deploy" });
    expect(payload.steps.find((step) => step.step_id === "deploy")).toMatchObject({ step_id: "deploy", artifacts_count: 1, latest_artifact_uri: "file:///tmp/deploy.txt" });
    expect(payload.approval_summary).toEqual({ pending: 1, approved: 0, rejected: 0 });
    expect(payload.artifact_summary.total_artifacts).toBe(2);
    expect(payload.timeline_summary.total_events).toBe(3);
    expect(payload.timeline_summary.recent[0]).toMatchObject({ title: "Approval requested" });
  });

  it("builds step detail read model with approval, artifact, and timeline summaries", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-step-detail-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [{ mission_id: "mis_demo", title: "Approval flow", objective: "Approval flow", project_id: "proj_demo", workflow: "bugfix", status: "awaiting_approval", active_run_id: "run_demo", summary: "Waiting on deploy approval", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z" }],
      runs: [{
        run_id: "run_demo", mission_id: "mis_demo", workflow_id: "bugfix", status: "awaiting_approval", current_step_index: 1, current_step_id: "deploy", approval_id: "approval_demo", summary: "deploy prepared", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z",
        steps: [
          { step_id: "plan", title: "Plan fix", kind: "plan", risk: "low", approval_mode: "on_policy_trigger", state: "completed", artifacts: [], completed_at: "2026-04-11T00:00:00.000Z" },
          { step_id: "deploy", title: "Canary deploy", kind: "deploy", risk: "high", approval_mode: "on_policy_trigger", state: "awaiting_approval", approval_id: "approval_demo", execution_id: "exec_demo", notes: "deploy prepared", blocked_reason: "high-risk action requires approval", artifacts: [{ artifact_id: "art_deploy", kind: "deploy-note", label: "deploy-note", uri: "file:///tmp/deploy.txt", metadata: { eval_id: "eval_123" } }], started_at: "2026-04-11T00:00:00.000Z" }
        ]
      }],
      approvals: [{ approval_id: "approval_demo", mission_id: "mis_demo", run_id: "run_demo", step_id: "deploy", status: "pending", reason: "high-risk action requires approval", decision_scope: "step", requested_at: "2026-04-11T00:00:00.000Z" }],
      events: [
        { type: "step.started", ts: "2026-04-11T00:02:00.000Z", mission_id: "mis_demo", run_id: "run_demo", step_id: "deploy", payload: {} },
        { type: "approval.requested", ts: "2026-04-11T00:03:00.000Z", mission_id: "mis_demo", run_id: "run_demo", step_id: "deploy", payload: { approval_id: "approval_demo" } }
      ],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const response = await app.request("/api/read-models/runs/run_demo/steps/deploy");
    const payload = await response.json() as {
      step: { step_id: string; execution_id?: string; blocked_reason?: string };
      approval: { approval_id: string; outcome: string } | null;
      artifacts: Array<{ artifact_id: string; eval_linkage?: string }>;
      execution_result_summary: { execution_id?: string; summary?: string; outcome: string };
      timeline_summary: { total_events: number; recent: Array<{ title: string }> };
    };

    expect(response.status).toBe(200);
    expect(payload.step).toMatchObject({ step_id: "deploy", execution_id: "exec_demo", blocked_reason: "high-risk action requires approval" });
    expect(payload.approval).toMatchObject({ approval_id: "approval_demo", outcome: "pending" });
    expect(payload.artifacts[0]).toMatchObject({ artifact_id: "art_deploy", eval_linkage: "eval_123" });
    expect(payload.execution_result_summary).toMatchObject({ execution_id: "exec_demo", summary: "deploy prepared", outcome: "pending" });
    expect(payload.timeline_summary.total_events).toBe(2);
    expect(payload.timeline_summary.recent[0]).toMatchObject({ title: "Approval requested" });
  });

  it("builds artifact read model with filters and pagination", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-artifact-read-model-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [{ mission_id: "mis_demo", title: "Approval flow", objective: "Approval flow", project_id: "proj_demo", workflow: "bugfix", status: "running", active_run_id: "run_demo", summary: "In progress", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z" }],
      runs: [{
        run_id: "run_demo", mission_id: "mis_demo", workflow_id: "bugfix", status: "running", current_step_index: 1, current_step_id: "deploy", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z",
        steps: [
          { step_id: "plan", title: "Plan fix", kind: "plan", risk: "low", approval_mode: "on_policy_trigger", state: "completed", artifacts: [{ artifact_id: "art_plan", kind: "note", label: "plan note", uri: "file:///tmp/plan.txt" }], completed_at: "2026-04-11T00:00:00.000Z" },
          { step_id: "deploy", title: "Canary deploy", kind: "deploy", risk: "high", approval_mode: "on_policy_trigger", state: "running", artifacts: [{ artifact_id: "art_deploy", kind: "deploy-note", label: "deploy note", uri: "file:///tmp/deploy.txt", metadata: { eval_id: "eval_123", created_by: "worker" } }, { artifact_id: "art_diff", kind: "diff", label: "diff", uri: "file:///tmp/patch.diff" }], started_at: "2026-04-11T00:00:00.000Z" }
        ]
      }],
      approvals: [],
      events: [],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const response = await app.request("/api/read-models/artifacts?run_id=run_demo&step_id=deploy&limit=1&offset=0");
    const payload = await response.json() as {
      artifacts: Array<{ artifact_id: string; artifact_type: string; source_step: string; created_by: string; eval_linkage?: string }>;
      pagination: { total: number; limit: number; offset: number; has_more: boolean };
    };

    expect(response.status).toBe(200);
    expect(payload.artifacts).toHaveLength(1);
    expect(payload.artifacts[0]).toMatchObject({ artifact_id: "art_deploy", artifact_type: "deploy-note", source_step: "deploy", created_by: "worker", eval_linkage: "eval_123" });
    expect(payload.pagination).toEqual({ total: 2, limit: 1, offset: 0, has_more: true });
  });

  it("adds pagination metadata to approval history and audit read models", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-pagination-read-models-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [{ mission_id: "mis_demo", title: "Approval flow", objective: "Approval flow", project_id: "proj_demo", workflow: "bugfix", status: "completed", active_run_id: "run_demo", summary: "Done", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z" }],
      runs: [{ run_id: "run_demo", mission_id: "mis_demo", workflow_id: "bugfix", status: "completed", current_step_index: 0, current_step_id: "plan", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z", steps: [] }],
      approvals: [
        { approval_id: "approval_1", mission_id: "mis_demo", run_id: "run_demo", step_id: "plan", status: "approved", reason: "ok", decision_scope: "step", requested_at: "2026-04-11T00:00:00.000Z", resolved_at: "2026-04-11T00:10:00.000Z", resolved_by: "jay" },
        { approval_id: "approval_2", mission_id: "mis_demo", run_id: "run_demo", step_id: "deploy", status: "rejected", reason: "no", decision_scope: "step", requested_at: "2026-04-11T00:20:00.000Z", resolved_at: "2026-04-11T00:30:00.000Z", resolved_by: "jay" }
      ],
      events: [
        { type: "mission.created", ts: "2026-04-11T00:00:00.000Z", mission_id: "mis_demo", payload: {} },
        { type: "run.started", ts: "2026-04-11T00:01:00.000Z", mission_id: "mis_demo", run_id: "run_demo", payload: {} },
        { type: "run.completed", ts: "2026-04-11T00:40:00.000Z", mission_id: "mis_demo", run_id: "run_demo", payload: {} }
      ],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const historyResponse = await app.request("/api/read-models/approval-history?limit=1&offset=1");
    const historyPayload = await historyResponse.json() as { pagination: { total: number; limit: number; offset: number; has_more: boolean } };
    expect(historyResponse.status).toBe(200);
    expect(historyPayload.pagination).toEqual({ total: 2, limit: 1, offset: 1, has_more: false });

    const auditResponse = await app.request("/api/read-models/audit?limit=2&offset=0");
    const auditPayload = await auditResponse.json() as { pagination: { total: number; limit: number; offset: number; has_more: boolean } };
    expect(auditResponse.status).toBe(200);
    expect(auditPayload.pagination).toEqual({ total: 3, limit: 2, offset: 0, has_more: true });
  });

  it("interrupts current step and pauses run + mission", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-interrupt-step-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [{ mission_id: "mis_demo", title: "Interrupt flow", objective: "Interrupt flow", project_id: "proj_demo", workflow: "bugfix", status: "running", active_run_id: "run_demo", summary: "Mission started", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z" }],
      runs: [{ run_id: "run_demo", mission_id: "mis_demo", workflow_id: "bugfix", status: "running", current_step_index: 0, current_step_id: "plan", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z", steps: [{ step_id: "plan", title: "Plan fix", kind: "plan", risk: "low", approval_mode: "on_policy_trigger", state: "running", execution_id: "exec_demo", artifacts: [], started_at: "2026-04-11T00:00:00.000Z" }] }],
      approvals: [], events: [], audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const response = await app.request("/api/runs/run_demo/interrupt-step", { method: "POST" });
    const payload = await response.json() as { run: { status: string; steps: Array<{ state: string; notes?: string }> }; mission: { status: string } };

    expect(response.status).toBe(200);
    expect(payload.run.status).toBe("paused");
    expect(payload.mission.status).toBe("paused");
    expect(payload.run.steps[0]).toMatchObject({ state: "paused", notes: "operator interrupted current step" });
  });

  it("resumes paused current step", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-resume-step-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [{ mission_id: "mis_demo", title: "Resume flow", objective: "Resume flow", project_id: "proj_demo", workflow: "bugfix", status: "paused", active_run_id: "run_demo", summary: "Paused", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z" }],
      runs: [{ run_id: "run_demo", mission_id: "mis_demo", workflow_id: "bugfix", status: "paused", current_step_index: 0, current_step_id: "plan", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z", steps: [{ step_id: "plan", title: "Plan fix", kind: "plan", risk: "low", approval_mode: "on_policy_trigger", state: "paused", execution_id: "exec_demo", notes: "operator interrupted current step", artifacts: [], started_at: "2026-04-11T00:00:00.000Z" }] }],
      approvals: [], events: [], audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const response = await app.request("/api/runs/run_demo/resume-step", { method: "POST" });
    const payload = await response.json() as { run: { status: string; steps: Array<{ state: string; notes?: string }> }; mission: { status: string } };

    expect(response.status).toBe(200);
    expect(payload.run.status).toBe("running");
    expect(payload.mission.status).toBe("running");
    expect(payload.run.steps[0]).toMatchObject({ state: "running", notes: "operator resumed current step" });
  });

  it("retries failed current step and returns run to running", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-retry-step-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [{ mission_id: "mis_demo", title: "Retry flow", objective: "Retry flow", project_id: "proj_demo", workflow: "bugfix", status: "failed", active_run_id: "run_demo", summary: "tests failed", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z" }],
      runs: [{ run_id: "run_demo", mission_id: "mis_demo", workflow_id: "bugfix", status: "failed", current_step_index: 0, current_step_id: "plan", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z", steps: [{ step_id: "plan", title: "Plan fix", kind: "plan", risk: "low", approval_mode: "on_policy_trigger", state: "failed", execution_id: "exec_demo", notes: "tests failed", artifacts: [], started_at: "2026-04-11T00:00:00.000Z", completed_at: "2026-04-11T00:01:00.000Z" }] }],
      approvals: [], events: [], audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const response = await app.request("/api/runs/run_demo/retry-step", { method: "POST" });
    const payload = await response.json() as { run: { status: string; steps: Array<{ state: string; notes?: string; execution_id?: string }> }; mission: { status: string } };

    expect(response.status).toBe(200);
    expect(payload.run.status).toBe("running");
    expect(payload.mission.status).toBe("running");
    expect(payload.run.steps[0]).toMatchObject({ state: "running", notes: "operator retried current step", execution_id: "exec_demo" });
  });

  it("cancels run and resolves pending approval", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-cancel-run-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [{ mission_id: "mis_demo", title: "Cancel flow", objective: "Cancel flow", project_id: "proj_demo", workflow: "bugfix", status: "awaiting_approval", active_run_id: "run_demo", summary: "waiting approval", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z" }],
      runs: [{ run_id: "run_demo", mission_id: "mis_demo", workflow_id: "bugfix", status: "awaiting_approval", current_step_index: 0, current_step_id: "deploy", approval_id: "approval_demo", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z", steps: [{ step_id: "deploy", title: "Canary deploy", kind: "deploy", risk: "high", approval_mode: "on_policy_trigger", state: "awaiting_approval", approval_id: "approval_demo", notes: "waiting approval", blocked_reason: "needs approval", artifacts: [], started_at: "2026-04-11T00:00:00.000Z" }] }],
      approvals: [{ approval_id: "approval_demo", mission_id: "mis_demo", run_id: "run_demo", step_id: "deploy", status: "pending", reason: "needs approval", decision_scope: "step", requested_at: "2026-04-11T00:00:00.000Z" }], events: [], audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const response = await app.request("/api/runs/run_demo/cancel", { method: "POST" });
    const payload = await response.json() as { run: { status: string; steps: Array<{ state: string }> }; mission: { status: string }; approval?: { status: string; resolved_by?: string } };

    expect(response.status).toBe(200);
    expect(payload.run.status).toBe("cancelled");
    expect(payload.mission.status).toBe("cancelled");
    expect(payload.run.steps[0]).toMatchObject({ state: "cancelled" });
    expect(payload.approval).toMatchObject({ status: "rejected", resolved_by: "operator" });
  });

  it("keeps approval pending when a stale approval response is rejected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-stale-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [{
        mission_id: "mis_demo",
        title: "Approval flow",
        objective: "Approval flow",
        project_id: "proj_demo",
        workflow: "bugfix",
        status: "running",
        active_run_id: "run_demo",
        summary: "Mission started",
        created_at: "2026-04-11T00:00:00.000Z",
        updated_at: "2026-04-11T00:00:00.000Z"
      }],
      runs: [{
        run_id: "run_demo",
        mission_id: "mis_demo",
        workflow_id: "bugfix",
        status: "running",
        current_step_index: 2,
        current_step_id: "test",
        created_at: "2026-04-11T00:00:00.000Z",
        updated_at: "2026-04-11T00:00:00.000Z",
        steps: [
          { step_id: "plan", title: "Plan fix", kind: "plan", risk: "low", approval_mode: "on_policy_trigger", state: "completed", artifacts: [], completed_at: "2026-04-11T00:00:00.000Z" },
          { step_id: "implement", title: "Implement patch", kind: "implement", risk: "medium", approval_mode: "on_policy_trigger", state: "completed", artifacts: [], completed_at: "2026-04-11T00:00:00.000Z" },
          { step_id: "test", title: "Run tests", kind: "test", risk: "low", approval_mode: "on_policy_trigger", state: "awaiting_approval", approval_id: "approval_demo", execution_id: "exec_demo", artifacts: [], started_at: "2026-04-11T00:00:00.000Z" },
          { step_id: "review", title: "Review diff", kind: "review", risk: "medium", approval_mode: "on_policy_trigger", state: "pending", artifacts: [] },
          { step_id: "deploy", title: "Canary deploy", kind: "deploy", risk: "high", approval_mode: "on_policy_trigger", state: "pending", artifacts: [] }
        ]
      }],
      approvals: [{
        approval_id: "approval_demo",
        mission_id: "mis_demo",
        run_id: "run_demo",
        step_id: "deploy",
        status: "pending",
        reason: "high-risk action requires approval",
        created_at: "2026-04-11T00:00:00.000Z"
      }],
      events: [],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const staleResponse = await app.request("/api/approvals/approval_demo/respond", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved" })
    });

    expect(staleResponse.status).toBe(409);

    const approvalsResponse = await app.request("/api/approvals");
    const approvalsPayload = await approvalsResponse.json() as { approvals: Array<{ approval_id: string; status: string }> };
    expect(approvalsPayload.approvals[0]).toMatchObject({
      approval_id: "approval_demo",
      status: "pending"
    });
  });
});
