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
    const payload = await execute.json() as { run: { status: string; steps: Array<{ id: string; notes?: string }> } };

    expect(execute.status).toBe(400);
    expect(payload.run.status).toBe("failed");
    expect(payload.run.steps[0]).toMatchObject({ id: "plan", notes: "tests failed" });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/cleanup-run"),
      expect.any(Object)
    );
  });

  it("keeps approval pending when a stale approval response is rejected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-stale-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [{
        mission_id: "mis_demo",
        title: "Approval flow",
        project_id: "proj_demo",
        workflow_id: "bugfix",
        status: "running",
        run_id: "run_demo",
        approval_id: "approval_demo"
      }],
      runs: [{
        run_id: "run_demo",
        mission_id: "mis_demo",
        workflow_id: "bugfix",
        status: "running",
        current_step_index: 2,
        created_at: "2026-04-11T00:00:00.000Z",
        updated_at: "2026-04-11T00:00:00.000Z",
        steps: [
          { id: "plan", title: "Plan fix", kind: "plan", risk: "low", status: "completed", artifacts: [], completed_at: "2026-04-11T00:00:00.000Z" },
          { id: "implement", title: "Implement patch", kind: "implement", risk: "medium", status: "completed", artifacts: [], completed_at: "2026-04-11T00:00:00.000Z" },
          { id: "test", title: "Run tests", kind: "test", risk: "low", status: "running", artifacts: [], started_at: "2026-04-11T00:00:00.000Z" },
          { id: "review", title: "Review diff", kind: "review", risk: "medium", status: "pending", artifacts: [] },
          { id: "deploy", title: "Canary deploy", kind: "deploy", risk: "high", status: "pending", artifacts: [] }
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
