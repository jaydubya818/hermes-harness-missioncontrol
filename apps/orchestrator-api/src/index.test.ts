import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

// Reads SSE chunks off a stream response until `expectedEvents` framed
// events have arrived, then cancels the stream. Replay chunks are enqueued
// synchronously at subscribe time, so reads resolve immediately.
async function readSseEvents(response: Response, expectedEvents: number) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while ((text.match(/^event: /gm) ?? []).length < expectedEvents) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  await reader.cancel();
  return text;
}

describe("orchestrator-api", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ORCHESTRATOR_STATE_FILE;
    delete process.env.WORKTREE_ROOT;
    delete process.env.WORKER_RUNTIME_ROOT;
    delete process.env.ORPHAN_SWEEP_INTERVAL_MS;
    delete process.env.ALLOWED_REPO_ROOT;
    delete process.env.HARNESS_OPERATOR_TOKEN;
    delete process.env.SSE_HEARTBEAT_MS;
    delete process.env.SSE_MAX_SUBSCRIBERS;
    delete process.env.SSE_MAX_QUEUED_EVENTS;
    delete process.env.MAX_REQUEST_BODY_BYTES;
    delete process.env.MAX_ARTIFACT_CONTENT_BYTES;
    process.env.VITEST = "1";
  });

  it("creates a contract-shaped mission payload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    process.env.ALLOWED_REPO_ROOT = "/repo";
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

  it("rejects mission payloads missing a title or a proj_-scoped project_id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const app = await loadApp();
    const missingTitle = await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: "proj_demo" })
    });
    expect(missingTitle.status).toBe(400);

    const blankTitle = await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "   ", project_id: "proj_demo" })
    });
    expect(blankTitle.status).toBe(400);

    const badProject = await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Contracts", project_id: "demo" })
    });
    expect(badProject.status).toBe(400);

    // repo_path/workspace_root feed resolve() at dispatch time, so
    // non-string values must be rejected when the mission is created.
    for (const body of [
      { title: "Contracts", project_id: "proj_demo", repo_path: 42 },
      { title: "Contracts", project_id: "proj_demo", workspace_root: ["nope"] },
      { title: "Contracts", project_id: "proj_demo", objective: 7 },
      { title: "Contracts", project_id: "proj_demo", repo_path: "   " }
    ]) {
      const badField = await app.request("/api/missions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      expect(badField.status).toBe(400);
    }

    // createWorkflowRun silently substitutes bugfix for unknown workflows,
    // so an unrecognized workflow_id must be rejected at mission creation.
    const badWorkflow = await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Contracts", project_id: "proj_demo", workflow_id: "does_not_exist" })
    });
    expect(badWorkflow.status).toBe(400);

    // WORKFLOW_LIBRARY is a plain object, so an `in` check also accepted
    // Object.prototype members; the mission was created and its first start
    // then 500'd on `template.map is not a function`.
    for (const inherited of ["toString", "constructor", "valueOf", "__proto__"]) {
      const prototypeWorkflow = await app.request("/api/missions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Prototype", project_id: "proj_demo", workflow_id: inherited })
      });
      expect(prototypeWorkflow.status).toBe(400);
    }

    const missions = await app.request("/api/missions");
    const missionsPayload = await missions.json() as { missions: unknown[] };
    expect(missionsPayload.missions).toHaveLength(0);
  });

  it("rejects a second start for an already-started mission but allows a restart after failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const app = await loadApp();
    const createMission = await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Start guard", project_id: "proj_demo", workflow_id: "bugfix" })
    });
    const mission = await createMission.json() as { mission_id: string };

    const firstStart = await app.request(`/api/missions/${mission.mission_id}/start`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(firstStart.status).toBe(201);
    const firstRun = await firstStart.json() as { run_id: string };

    // Starting again while the run is live would fork a second concurrent run.
    const secondStart = await app.request(`/api/missions/${mission.mission_id}/start`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(secondStart.status).toBe(409);

    // Fail the live run via a rejected worker execution, then a restart is allowed.
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/api/execute-step")) {
        return jsonResponse({ body: { execution_id: "exec_fail", summary: "worker exploded", confidence: 0.1, success: false, artifacts: [] } });
      }
      return jsonResponse();
    }));
    const execute = await app.request(`/api/runs/${firstRun.run_id}/execute-current`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(execute.status).toBe(400);

    const restart = await app.request(`/api/missions/${mission.mission_id}/start`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(restart.status).toBe(201);
    const restartedRun = await restart.json() as { run_id: string };
    expect(restartedRun.run_id).not.toBe(firstRun.run_id);

    const missionsAfter = await app.request("/api/missions");
    const missionsPayload = await missionsAfter.json() as { missions: Array<{ mission_id: string; status: string; active_run_id?: string }> };
    expect(missionsPayload.missions[0]).toMatchObject({ mission_id: mission.mission_id, status: "running", active_run_id: restartedRun.run_id });
  });

  it("returns 400 instead of 500 for malformed JSON bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const app = await loadApp();
    for (const path of ["/api/missions", "/api/runs/run_x/artifacts", "/api/approvals/approval_x/respond"]) {
      const response = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json"
      });
      expect([400, 404]).toContain(response.status);
      expect(response.status).not.toBe(500);
    }

    const malformedMission = await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json"
    });
    expect(malformedMission.status).toBe(400);
    const payload = await malformedMission.json() as { error: string };
    expect(payload.error).toBe("invalid JSON body");
  });

  it("lists the workflow library with per-step metadata", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));
    const app = await loadApp();

    const response = await app.request("/api/read-models/workflows");
    expect(response.status).toBe(200);
    const payload = await response.json() as { workflows: Array<{ workflow_id: string; steps: Array<{ id: string; kind: string; risk: string }> }> };
    const ids = payload.workflows.map((workflow) => workflow.workflow_id);
    expect(ids).toContain("bugfix");
    expect(ids).toContain("dependency_upgrade");
    const bugfix = payload.workflows.find((workflow) => workflow.workflow_id === "bugfix")!;
    expect(bugfix.steps.map((step) => step.id)).toEqual(["plan", "implement", "test", "review", "deploy"]);
    expect(bugfix.steps[4]).toMatchObject({ kind: "deploy", risk: "high" });
  });

  it("requires the operator token on read endpoints when configured", async () => {
    process.env.HARNESS_OPERATOR_TOKEN = "secret-token";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));
    const app = await loadApp();

    for (const path of ["/api/missions", "/api/runs", "/api/approvals", "/api/events", "/api/audit", "/api/read-models/overview", "/api/read-models/missions", "/api/read-models/workflows", "/api/read-models/artifacts", "/api/read-models/approvals", "/api/read-models/approval-history", "/api/read-models/audit"]) {
      const denied = await app.request(path);
      expect(denied.status, path).toBe(401);
      const allowed = await app.request(path, { headers: { authorization: "Bearer secret-token" } });
      expect(allowed.status, path).toBe(200);
    }

    const health = await app.request("/health");
    expect(health.status).toBe(200);

    const streamDenied = await app.request("/api/events/stream?last=0");
    expect(streamDenied.status).toBe(401);
    const streamWrongToken = await app.request("/api/events/stream?last=0&token=secret-tokem");
    expect(streamWrongToken.status).toBe(401);
    const streamWithToken = await app.request("/api/events/stream?last=0&token=secret-token");
    expect(streamWithToken.status).toBe(200);
    expect(streamWithToken.headers.get("content-type")).toContain("text/event-stream");
    await streamWithToken.body?.cancel();
    const streamWithHeader = await app.request("/api/events/stream?last=0", { headers: { authorization: "Bearer secret-token" } });
    expect(streamWithHeader.status).toBe(200);
    await streamWithHeader.body?.cancel();
  });

  it("replays recent events with SSE framing and honors stream filters", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));
    process.env.SSE_HEARTBEAT_MS = "0";
    const app = await loadApp();

    const first = await (await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Stream A", project_id: "proj_demo" })
    })).json() as { mission_id: string };
    const second = await (await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Stream B", project_id: "proj_demo" })
    })).json() as { mission_id: string };

    const replayAll = await app.request("/api/events/stream?last=10");
    const allText = await readSseEvents(replayAll, 2);
    expect(allText).toContain(`id: `);
    expect(allText).toContain("event: mission.created");
    expect(allText).toContain(first.mission_id);
    expect(allText).toContain(second.mission_id);
    // Replay is oldest-first so EventSource consumers rebuild in order.
    expect(allText.indexOf(first.mission_id)).toBeLessThan(allText.indexOf(second.mission_id));

    const filtered = await app.request(`/api/events/stream?last=10&mission_id=${second.mission_id}`);
    const filteredText = await readSseEvents(filtered, 1);
    expect(filteredText).toContain(second.mission_id);
    expect(filteredText).not.toContain(first.mission_id);

    // Every data frame is parseable JSON with a canonical type.
    for (const line of filteredText.split("\n").filter((item) => item.startsWith("data: "))) {
      const event = JSON.parse(line.slice("data: ".length)) as { type: string; mission_id?: string };
      expect(event.type).toBe("mission.created");
      expect(event.mission_id).toBe(second.mission_id);
    }
  });

  it("resumes the stream from Last-Event-ID instead of count-based replay", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));
    process.env.SSE_HEARTBEAT_MS = "0";
    const app = await loadApp();

    const first = await (await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Resume A", project_id: "proj_demo" })
    })).json() as { mission_id: string };
    const second = await (await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Resume B", project_id: "proj_demo" })
    })).json() as { mission_id: string };

    const { events } = await (await app.request("/api/events")).json() as { events: Array<{ event_id: string; payload: { mission_id?: string } }> };
    // events are newest-first; resume from the older mission.created.
    const olderEventId = events[events.length - 1]!.event_id;

    const resumed = await app.request("/api/events/stream", { headers: { "last-event-id": olderEventId } });
    const resumedText = await readSseEvents(resumed, 1);
    expect(resumedText).toContain(second.mission_id);
    expect(resumedText).not.toContain(first.mission_id);

    // An evicted/unknown id falls back to count-based replay.
    const fallback = await app.request("/api/events/stream?last=10", { headers: { "last-event-id": "evt_gone" } });
    const fallbackText = await readSseEvents(fallback, 2);
    expect(fallbackText).toContain(first.mission_id);
    expect(fallbackText).toContain(second.mission_id);
  });

  it("delivers live events to connected stream subscribers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));
    process.env.SSE_HEARTBEAT_MS = "0";
    const app = await loadApp();

    const stream = await app.request("/api/events/stream?last=0&event_type=mission.created");
    expect(stream.status).toBe(200);

    const created = await (await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Live mission", project_id: "proj_demo" })
    })).json() as { mission_id: string };

    const text = await readSseEvents(stream, 1);
    expect(text).toContain("event: mission.created");
    expect(text).toContain(created.mission_id);
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

    const startRun = await app.request(`/api/missions/${mission.mission_id}/start`, { method: "POST", headers: { "content-type": "application/json" } });
    const run = await startRun.json() as { run_id: string };

    const execute = await app.request(`/api/runs/${run.run_id}/execute-current`, { method: "POST", headers: { "content-type": "application/json" } });
    const payload = await execute.json() as {
      execution_result?: {
        execution_id: string;
        final_outcome: string;
        artifacts: Array<{ kind: string; label: string }>;
        changed_files: string[];
        recommended_next_step?: string;
      };
    };

    expect(execute.status).toBe(200);
    expect(payload.execution_result).toBeDefined();
    expect(payload.execution_result?.execution_id).toMatch(/^exec_/);
    expect(payload.execution_result?.final_outcome).toBe("success");
    expect(payload.execution_result?.artifacts[0]).toMatchObject({ kind: "diff", label: "diff" });
    expect(payload.execution_result?.changed_files).toContain("apps/orchestrator-api/src/index.ts");
    // The executed step was "plan"; the bugfix workflow's next step is
    // "implement", not a hardcoded "test".
    expect(payload.execution_result?.recommended_next_step).toBe("implement");
  });

  it("rejects mission creation for repo paths outside the allowed root even when they embed it as a substring", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));
    const allowedRoot = mkdtempSync(join(tmpdir(), "orch-allowed-"));
    process.env.ALLOWED_REPO_ROOT = allowedRoot;
    // e.g. /tmp/elsewhere/tmp/orch-allowed-x/evil embeds the allowed root but lives outside it
    const evilRepo = join(tmpdir(), "elsewhere", allowedRoot, "evil");

    const app = await loadApp();
    for (const body of [
      { title: "Escape", project_id: "proj_demo", workflow_id: "bugfix", repo_path: evilRepo },
      { title: "Escape", project_id: "proj_demo", workflow_id: "bugfix", workspace_root: join(tmpdir(), "outside-root") }
    ]) {
      const createMission = await app.request("/api/missions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = await createMission.json() as { error?: string };
      expect(createMission.status).toBe(400);
      expect(payload.error).toMatch(/allowed repo root/);
    }

    // A path inside the allowed root is still accepted.
    const okMission = await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Inside", project_id: "proj_demo", workflow_id: "bugfix", repo_path: join(allowedRoot, "repo") })
    });
    expect(okMission.status).toBe(201);
  });

  it("still rejects out-of-root repo paths at dispatch for missions hydrated from older persisted state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));
    const allowedRoot = mkdtempSync(join(tmpdir(), "orch-allowed-"));
    process.env.ALLOWED_REPO_ROOT = allowedRoot;
    const evilRepo = join(tmpdir(), "elsewhere", allowedRoot, "evil");

    // Persisted before creation-time validation existed: the mission carries
    // an out-of-root repo_path, so the dispatch-time guard is the backstop.
    const stateFile = join(mkdtempSync(join(tmpdir(), "orch-state-")), "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [{ mission_id: "mis_legacy", title: "Legacy escape", objective: "Legacy escape", project_id: "proj_demo", workflow: "bugfix", repo_path: evilRepo, status: "pending", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z" }],
      runs: [], approvals: [], events: [], audit: [], processed_event_ids: []
    }));

    const app = await loadApp(stateFile);
    const startRun = await app.request("/api/missions/mis_legacy/start", { method: "POST", headers: { "content-type": "application/json" } });
    const run = await startRun.json() as { run_id: string };

    const execute = await app.request(`/api/runs/${run.run_id}/execute-current`, { method: "POST", headers: { "content-type": "application/json" } });
    const payload = await execute.json() as { error?: string };

    expect(execute.status).toBe(400);
    expect(payload.error).toMatch(/escapes allowed root/);
  });

  it("fails the run with the worker's HTTP status when the worker returns a non-JSON response", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/execute-step")) {
        return {
          ok: false,
          status: 502,
          json: async () => { throw new SyntaxError("Unexpected token '<'"); }
        } as unknown as Response;
      }
      return jsonResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = await loadApp();
    const createMission = await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Bad gateway", project_id: "proj_demo", workflow_id: "bugfix" })
    });
    const mission = await createMission.json() as { mission_id: string };

    const startRun = await app.request(`/api/missions/${mission.mission_id}/start`, { method: "POST", headers: { "content-type": "application/json" } });
    const run = await startRun.json() as { run_id: string };

    const execute = await app.request(`/api/runs/${run.run_id}/execute-current`, { method: "POST", headers: { "content-type": "application/json" } });
    const payload = await execute.json() as { error?: string; run?: { status: string } };

    expect(execute.status).toBe(502);
    expect(payload.error).toMatch(/status 502/);
    expect(payload.run?.status).toBe("failed");
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

    const startRun = await app.request(`/api/missions/${mission.mission_id}/start`, { method: "POST", headers: { "content-type": "application/json" } });
    const run = await startRun.json() as { run_id: string };

    const execute = await app.request(`/api/runs/${run.run_id}/execute-current`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(execute.status).toBe(200);

    const eventsResponse = await app.request("/api/events");
    const eventsPayload = await eventsResponse.json() as { events: Array<{ source?: string; type: string; execution_id?: string; project_id?: string; mission_id?: string; run_id?: string }> };
    // Worker-chosen scoping ids ("mis_placeholder"/"run_placeholder") are
    // replaced with the dispatch's own, so the event lands on the right run.
    const ingested = eventsPayload.events.find((event) => event.source === "hermes" && event.type === "step.progress");
    expect(ingested).toBeDefined();
    expect(ingested?.mission_id).toBe(mission.mission_id);
    expect(ingested?.run_id).toBe(run.run_id);
    expect(ingested?.execution_id).not.toBe("exec_worker_1");
    expect(eventsPayload.events.some((event) => event.mission_id === "mis_placeholder" || event.run_id === "run_placeholder")).toBe(false);
    // ...and it cannot surface in a foreign mission's audit timeline.
    const foreignTimeline = await app.request("/api/read-models/audit?mission_id=mis_placeholder");
    expect((await foreignTimeline.json() as { timeline: unknown[] }).timeline).toHaveLength(0);
    // Lifecycle events recorded with a project_id must not lose it during normalization.
    expect(eventsPayload.events.some((event) => event.type === "mission.created" && event.project_id === "proj_demo")).toBe(true);
  });

  it("completes the dispatch even when the worker sends an unrecognized step event type", async () => {
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
                event_id: "evt_worker_ok",
                timestamp: "2026-04-18T18:00:00Z",
                sequence: 1,
                source: "hermes",
                type: "step.progress",
                payload: { message: "thinking" }
              },
              {
                schema_version: "v1",
                event_id: "evt_worker_unknown",
                timestamp: "2026-04-18T18:00:01Z",
                sequence: 2,
                source: "hermes",
                type: "step.telemetry_v2",
                payload: { message: "future event shape" }
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
      body: JSON.stringify({ title: "Unknown worker event", project_id: "proj_demo", workflow_id: "bugfix" })
    });
    const mission = await createMission.json() as { mission_id: string };
    const startRun = await app.request(`/api/missions/${mission.mission_id}/start`, { method: "POST", headers: { "content-type": "application/json" } });
    const run = await startRun.json() as { run_id: string };

    const execute = await app.request(`/api/runs/${run.run_id}/execute-current`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(execute.status).toBe(200);
    const executePayload = await execute.json() as { run: { steps: Array<{ step_id: string; state: string }> } };
    expect(executePayload.run.steps.find((step) => step.step_id === "plan")?.state).toBe("completed");

    const eventsResponse = await app.request("/api/events");
    const eventsPayload = await eventsResponse.json() as { events: Array<{ event_id?: string }> };
    expect(eventsPayload.events.some((event) => event.event_id === "evt_worker_ok")).toBe(true);
    expect(eventsPayload.events.some((event) => event.event_id === "evt_worker_unknown")).toBe(false);
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

    const startRun = await app.request(`/api/missions/${mission.mission_id}/start`, { method: "POST", headers: { "content-type": "application/json" } });
    const run = await startRun.json() as { run_id: string };

    const execute = await app.request(`/api/runs/${run.run_id}/execute-current`, { method: "POST", headers: { "content-type": "application/json" } });
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
    const response = await app.request("/api/runs/run_demo/steps/deploy/complete", { method: "POST", headers: { "content-type": "application/json" } });
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

  it("rejects manual step-complete while the step awaits approval instead of minting a duplicate approval", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-complete-awaiting-"));
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
          { step_id: "deploy", title: "Canary deploy", kind: "deploy", risk: "high", approval_mode: "on_policy_trigger", state: "awaiting_approval", approval_id: "approval_demo", artifacts: [], started_at: "2026-04-11T00:00:00.000Z", blocked_reason: "high-risk action requires approval" }
        ]
      }],
      approvals: [{ approval_id: "approval_demo", mission_id: "mis_demo", run_id: "run_demo", step_id: "deploy", status: "pending", reason: "high-risk action requires approval", requested_at: "2026-04-11T00:00:00.000Z" }],
      events: [],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const response = await app.request("/api/runs/run_demo/steps/deploy/complete", { method: "POST", headers: { "content-type": "application/json" } });
    expect(response.status).toBe(409);
    const payload = await response.json() as { error: string };
    expect(payload.error).toMatch(/awaiting_approval/);

    // The original approval must remain the only (still pending) approval.
    const approvalsResponse = await app.request("/api/approvals");
    const approvalsPayload = await approvalsResponse.json() as { approvals: Array<{ approval_id: string; status: string }> };
    expect(approvalsPayload.approvals).toHaveLength(1);
    expect(approvalsPayload.approvals[0]).toMatchObject({ approval_id: "approval_demo", status: "pending" });

    // Responding to that approval still works (it was not superseded).
    const respond = await app.request("/api/approvals/approval_demo/respond", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved" })
    });
    expect(respond.status).toBe(200);
  });

  it("rejects manual step-complete for a cancelled step instead of resurrecting the run through the policy gate", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-complete-cancelled-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [{
        mission_id: "mis_demo",
        title: "Cancelled",
        objective: "Cancelled",
        project_id: "proj_demo",
        workflow: "bugfix",
        status: "cancelled",
        active_run_id: "run_demo",
        summary: "operator cancelled run",
        created_at: "2026-04-11T00:00:00.000Z",
        updated_at: "2026-04-11T00:00:00.000Z"
      }],
      runs: [{
        run_id: "run_demo",
        mission_id: "mis_demo",
        workflow_id: "bugfix",
        status: "cancelled",
        current_step_index: 0,
        current_step_id: "plan",
        created_at: "2026-04-11T00:00:00.000Z",
        updated_at: "2026-04-11T00:00:00.000Z",
        steps: [
          { step_id: "plan", title: "Plan fix", kind: "plan", risk: "low", approval_mode: "on_policy_trigger", state: "cancelled", artifacts: [], started_at: "2026-04-11T00:00:00.000Z", completed_at: "2026-04-11T00:01:00.000Z" },
          { step_id: "implement", title: "Implement patch", kind: "implement", risk: "medium", approval_mode: "on_policy_trigger", state: "pending", artifacts: [] },
          { step_id: "test", title: "Run tests", kind: "test", risk: "low", approval_mode: "on_policy_trigger", state: "pending", artifacts: [] },
          { step_id: "review", title: "Review diff", kind: "review", risk: "medium", approval_mode: "on_policy_trigger", state: "pending", artifacts: [] },
          { step_id: "deploy", title: "Canary deploy", kind: "deploy", risk: "high", approval_mode: "on_policy_trigger", state: "pending", artifacts: [] }
        ]
      }],
      approvals: [],
      events: [],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const response = await app.request("/api/runs/run_demo/steps/plan/complete", { method: "POST", headers: { "content-type": "application/json" } });
    expect(response.status).toBe(409);

    // No approval minted, mission still cancelled.
    const approvalsResponse = await app.request("/api/approvals");
    expect((await approvalsResponse.json() as { approvals: unknown[] }).approvals).toHaveLength(0);
    const missionsResponse = await app.request("/api/missions");
    const missionsPayload = await missionsResponse.json() as { missions: Array<{ status: string }> };
    expect(missionsPayload.missions[0]?.status).toBe("cancelled");
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

  it("rejects unknown approval decisions instead of treating them as approvals", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-approval-invalid-"));
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
          { step_id: "review", title: "Review diff", kind: "review", risk: "medium", approval_mode: "on_policy_trigger", state: "completed", artifacts: [], completed_at: "2026-04-11T00:00:00.000Z" },
          { step_id: "deploy", title: "Canary deploy", kind: "deploy", risk: "high", approval_mode: "on_policy_trigger", state: "awaiting_approval", approval_id: "approval_demo", artifacts: [], started_at: "2026-04-11T00:00:00.000Z", blocked_reason: "high-risk action requires approval" }
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
      body: JSON.stringify({ decision: "escalate" })
    });

    expect(response.status).toBe(400);

    // A non-string actor used to throw at body.actor?.trim() and 500 after
    // the decision had already validated.
    const badActor = await app.request("/api/approvals/approval_demo/respond", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved", actor: 42 })
    });
    expect(badActor.status).toBe(400);

    const approvalsResponse = await app.request("/api/approvals");
    const approvalsPayload = await approvalsResponse.json() as { approvals: Array<{ approval_id: string; status: string }> };
    expect(approvalsPayload.approvals.find((item) => item.approval_id === "approval_demo")?.status).toBe("pending");

    const runsResponse = await app.request("/api/runs");
    const runsPayload = await runsResponse.json() as { runs: Array<{ run_id: string; status: string }> };
    expect(runsPayload.runs.find((run) => run.run_id === "run_demo")?.status).toBe("awaiting_approval");
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
      open_missions: 1,
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
      mission_queue: Array<{ mission_id: string; status: string; active_run_id?: string; workflow?: string }>;
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
    expect(payload.mission_queue[0]).toMatchObject({ mission_id: "mis_demo", status: "awaiting_approval", active_run_id: "run_demo", workflow: "bugfix" });
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

  it("treats a date-only `to` filter as inclusive of that whole day", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-date-only-to-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [],
      runs: [],
      approvals: [],
      events: [
        { event_id: "evt_in_range", type: "step.started", ts: "2026-04-11T09:30:00.000Z", mission_id: "mis_demo", run_id: "run_demo", payload: {} },
        { event_id: "evt_next_day", type: "step.completed", ts: "2026-04-12T00:00:01.000Z", mission_id: "mis_demo", run_id: "run_demo", payload: {} }
      ],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const response = await app.request("/api/read-models/audit?from=2026-04-11&to=2026-04-11");
    const payload = await response.json() as { timeline: Array<{ occurred_at: string }> };

    expect(response.status).toBe(200);
    expect(payload.timeline.map((item) => item.occurred_at)).toEqual(["2026-04-11T09:30:00.000Z"]);

    // Full timestamps keep their exact-bound semantics.
    const exact = await app.request("/api/read-models/audit?to=2026-04-11T09:00:00.000Z");
    const exactPayload = await exact.json() as { timeline: Array<{ occurred_at: string }> };
    expect(exactPayload.timeline).toHaveLength(0);
  });

  it("keeps a record with no resolvable timestamp in the unfiltered read model", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    // Persisted before artifacts carried created_at, on a step that never
    // started, in a run with no updated_at: every fallback the artifacts read
    // model tries resolves to undefined. The date-range predicate runs on
    // every request, so an undefined timestamp used to hide the artifact from
    // the unfiltered view rather than only from a date-filtered one.
    const stateFile = join(mkdtempSync(join(tmpdir(), "orch-no-ts-")), "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [{ mission_id: "mis_legacy", title: "Legacy", project_id: "proj_demo", workflow: "bugfix", status: "running", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z" }],
      runs: [{
        run_id: "run_legacy", mission_id: "mis_legacy", workflow_id: "bugfix", status: "running",
        created_at: "2026-04-11T00:00:00.000Z",
        steps: [{ step_id: "step_legacy", kind: "implement", risk: "low", state: "pending", artifacts: [{ artifact_id: "art_legacy", kind: "diff", label: "diff", uri: "artifact://legacy" }] }]
      }],
      approvals: [], events: [], audit: [], processed_event_ids: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const unfiltered = await app.request("/api/read-models/artifacts");
    const payload = await unfiltered.json() as { artifacts: Array<{ artifact_id: string }> };

    expect(unfiltered.status).toBe(200);
    expect(payload.artifacts.map((item) => item.artifact_id)).toEqual(["art_legacy"]);

    // An explicit bound still excludes it: a record with no timestamp cannot
    // be shown to fall inside the requested window.
    const filtered = await app.request("/api/read-models/artifacts?from=2026-04-11");
    const filteredPayload = await filtered.json() as { artifacts: unknown[] };
    expect(filteredPayload.artifacts).toHaveLength(0);
  });

  it("drops SSE subscribers that stop draining their stream", async () => {
    process.env.SSE_MAX_QUEUED_EVENTS = "2";
    // One slot only, so the reconnect below also proves the dropped
    // subscriber released it instead of wedging the cap.
    process.env.SSE_MAX_SUBSCRIBERS = "1";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const app = await loadApp();
    const stream = await app.request("/api/events/stream?last=0");
    expect(stream.status).toBe(200);

    // Never read the body: without a backlog cap every recorded event just
    // piles up in this subscriber's queue forever.
    for (let index = 0; index < 8; index += 1) {
      const created = await app.request("/api/missions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: `Backlog ${index}`, project_id: "proj_demo", workflow_id: "bugfix" })
      });
      expect(created.status).toBe(201);
    }

    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    const delivered = (text.match(/^event: /gm) ?? []).length;
    expect(delivered).toBeGreaterThan(0);
    expect(delivered).toBeLessThan(8);

    const reconnect = await app.request("/api/events/stream?last=0");
    expect(reconnect.status).toBe(200);
    await reconnect.body!.cancel();
  });

  it("fails the run when the worker returns a malformed execution result", async () => {
    // The shape checks run after the step already executed, so a bare 500
    // here left the run `running` with no step.failed, no eval and no
    // worktree cleanup -- unrecoverable short of an operator interrupt.
    const malformedBodies = [
      { success: true, summary: "planned", confidence: 0.95 },
      { success: true, summary: "planned", confidence: 0.95, artifacts: [null] },
      { success: true, summary: "planned", confidence: 0.95, artifacts: [{ type: "plan" }] },
      { success: true, summary: "planned", confidence: 0.95, artifacts: [], step_events: "not-an-array" },
    ];

    for (const body of malformedBodies) {
      const cleanupCalls: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        if (url.includes("/api/cleanup-run")) cleanupCalls.push(url);
        return url.includes("/api/execute-step") ? jsonResponse({ body }) : jsonResponse();
      }));

      const app = await loadApp();
      const mission = await (await app.request("/api/missions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Malformed worker", project_id: "proj_demo", workflow_id: "bugfix" })
      })).json();
      const run = await (await app.request(`/api/missions/${mission.mission_id}/start`, { method: "POST", headers: { "content-type": "application/json" } })).json();

      const dispatched = await app.request(`/api/runs/${run.run_id}/execute-current`, { method: "POST", headers: { "content-type": "application/json" } });
      expect(dispatched.status).toBe(502);
      expect((await dispatched.json()).error).toMatch(/malformed execution result/);

      const stored = (await (await app.request("/api/runs")).json()).runs.find((item: any) => item.run_id === run.run_id);
      expect(stored.status).toBe("failed");
      expect(stored.steps[0].state).toBe("failed");
      expect(cleanupCalls.length).toBeGreaterThan(0);
    }
  });

  it("bounds inlined artifact content so persisted state cannot grow without limit", async () => {
    process.env.MAX_ARTIFACT_CONTENT_BYTES = "64";
    const oversized = "x".repeat(4096);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/execute-step")) {
        return jsonResponse({
          body: {
            success: true,
            summary: "planned",
            confidence: 0.95,
            artifacts: [{ artifact_id: "art_big", type: "plan", uri: "file:///tmp/plan.md", content: oversized }]
          }
        });
      }
      return jsonResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = await loadApp();
    const mission = await (await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Bound artifact content", project_id: "proj_demo", workflow_id: "bugfix" })
    })).json();
    const run = await (await app.request(`/api/missions/${mission.mission_id}/start`, { method: "POST", headers: { "content-type": "application/json" } })).json();
    const dispatched = await app.request(`/api/runs/${run.run_id}/execute-current`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(dispatched.status).toBe(200);

    const stored = (await (await app.request("/api/runs")).json()).runs
      .find((item: any) => item.run_id === run.run_id)
      .steps.find((step: any) => step.step_id === "plan")
      .artifacts[0];
    expect(stored.uri).toBe("file:///tmp/plan.md");
    expect(stored.content.length).toBeLessThan(oversized.length);
    expect(stored.content).toContain("[truncated:");

    // The duplicate copy inside the step.completed event payload is bounded
    // too: that is the one the audit trail retains 1000 of.
    const events = (await (await app.request("/api/events")).json()).events;
    const completed = events.find((event: any) => event.type === "step.completed");
    expect(completed.payload.execution.artifacts[0].content).toBe(stored.content);

    delete process.env.MAX_ARTIFACT_CONTENT_BYTES;
  });

  it("keeps artifact content intact when the bound is disabled", async () => {
    process.env.MAX_ARTIFACT_CONTENT_BYTES = "0";
    const app = await loadApp();
    const mission = await (await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Unbounded artifact content", project_id: "proj_demo", workflow_id: "bugfix" })
    })).json();
    const run = await (await app.request(`/api/missions/${mission.mission_id}/start`, { method: "POST", headers: { "content-type": "application/json" } })).json();
    const content = "y".repeat(4096);
    const attached = await app.request(`/api/runs/${run.run_id}/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ step_id: "plan", type: "diff", content })
    });
    expect(attached.status).toBe(201);
    expect((await attached.json()).content).toBe(content);
    delete process.env.MAX_ARTIFACT_CONTENT_BYTES;
  });

  it("releases the SSE slot when the request aborted before the stream started", async () => {
    // ensureLoaded() reads the state file before the stream is constructed,
    // so a client that disconnects in that window leaves an already-aborted
    // request signal. addEventListener never fires on one, so the subscriber
    // used to stay registered forever and burn a slot against the cap.
    process.env.SSE_MAX_SUBSCRIBERS = "1";
    process.env.SSE_HEARTBEAT_MS = "0";
    const app = await loadApp();

    const aborted = new AbortController();
    aborted.abort();
    const dropped = await app.request("/api/events/stream?last=0", { signal: aborted.signal });
    expect(dropped.status).toBe(200);

    // No cancel() here: nothing consumes the body of a request whose client
    // already went away, so only the abort handling can free the slot.
    const reconnect = await app.request("/api/events/stream?last=0");
    expect(reconnect.status).toBe(200);
    await reconnect.body!.cancel();
  });

  it("refuses worker event ids that would forge extra SSE frames", async () => {
    // event_id lands verbatim in the SSE `id:` line, so a newline inside one
    // used to let the worker append arbitrary frames of its own.
    const forged = "evt_ok\nevent: mission.completed\ndata: {\"forged\":true}\n";
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/execute-step")) {
        return jsonResponse({
          body: {
            success: true,
            summary: "planned",
            confidence: 0.95,
            artifacts: [],
            step_events: [
              { schema_version: "v1", event_id: forged, timestamp: "2026-04-18T18:00:00Z", sequence: 1, source: "hermes", type: "step.progress", payload: { message: "thinking" } }
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
      body: JSON.stringify({ title: "Forged frames", project_id: "proj_demo", workflow_id: "bugfix" })
    });
    const mission = await createMission.json() as { mission_id: string };
    const startRun = await app.request(`/api/missions/${mission.mission_id}/start`, { method: "POST", headers: { "content-type": "application/json" } });
    const run = await startRun.json() as { run_id: string };
    const execute = await app.request(`/api/runs/${run.run_id}/execute-current`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(execute.status).toBe(200);

    const eventsResponse = await app.request("/api/events");
    const eventsPayload = await eventsResponse.json() as { events: Array<{ event_id?: string; type: string }> };
    const ingested = eventsPayload.events.find((event) => event.type === "step.progress");
    expect(ingested?.event_id).not.toBe(forged);
    expect(ingested?.event_id).toMatch(/^evt_[A-Za-z0-9]+$/);

    // The framed stream must not contain a second, worker-authored frame.
    const stream = await app.request(`/api/events/stream?run_id=${run.run_id}&last=100`);
    const text = await readSseEvents(stream, 1);
    expect(text).not.toContain("\"forged\"");
    expect(text.match(/^event: mission\.completed$/gm)).toBeNull();
  });

  it("refuses worker events that claim an operator actor", async () => {
    // `actor` is what the audit timeline attributes an entry to and what the
    // approval/SSE actor filters key on, so a worker stamping actor:"operator"
    // onto its own step events forged operator-attributed governance history.
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/execute-step")) {
        return jsonResponse({
          body: {
            success: true,
            summary: "planned",
            confidence: 0.95,
            artifacts: [],
            step_events: [
              { schema_version: "v1", event_id: "evt_worker_actor", timestamp: "2026-04-18T18:00:00Z", sequence: 1, source: "hermes", type: "step.progress", actor: "operator", payload: { message: "thinking" } }
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
      body: JSON.stringify({ title: "Forged actor", project_id: "proj_demo", workflow_id: "bugfix" })
    });
    const mission = await createMission.json() as { mission_id: string };
    const startRun = await app.request(`/api/missions/${mission.mission_id}/start`, { method: "POST", headers: { "content-type": "application/json" } });
    const run = await startRun.json() as { run_id: string };
    expect((await app.request(`/api/runs/${run.run_id}/execute-current`, { method: "POST", headers: { "content-type": "application/json" } })).status).toBe(200);

    const eventsResponse = await app.request("/api/events");
    const eventsPayload = await eventsResponse.json() as { events: Array<{ event_id?: string; type: string; actor?: string }> };
    const ingested = eventsPayload.events.find((event) => event.event_id === "evt_worker_actor");
    expect(ingested?.type).toBe("step.progress");
    expect(ingested?.actor).toBeUndefined();

    // ...and it must not surface under an operator-filtered audit query.
    const audit = await app.request("/api/read-models/audit?actor=operator");
    expect(audit.status).toBe(200);
    const stream = await app.request(`/api/events/stream?actor=operator&run_id=${run.run_id}&last=100`);
    expect(await readSseEvents(stream, 0)).not.toContain("evt_worker_actor");
  });

  it("hydrates persisted events whose timestamps are not strings", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-numeric-ts-"));
    const stateFile = join(stateDir, "state.json");
    // A worker step event with an epoch-number ts used to be persisted as-is;
    // hydration then called localeCompare on that number and threw, so every
    // request after the next restart 500ed.
    writeFileSync(stateFile, JSON.stringify({
      missions: [],
      runs: [],
      approvals: [],
      events: [
        { event_id: "evt_string", type: "step.started", ts: "2026-04-11T00:00:00.000Z", mission_id: "mis_demo", run_id: "run_demo", payload: {} },
        { event_id: "evt_numeric", type: "step.progress", ts: 1776124800000, mission_id: "mis_demo", run_id: "run_demo", payload: {} }
      ],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const response = await app.request("/api/events");
    const payload = await response.json() as { events: Array<{ event_id?: string; ts?: unknown; timestamp?: unknown }> };

    expect(response.status).toBe(200);
    const numeric = payload.events.find((event) => event.event_id === "evt_numeric");
    expect(typeof numeric?.ts).toBe("string");
    expect(typeof numeric?.timestamp).toBe("string");
    expect(numeric?.ts).toBe(new Date(1776124800000).toISOString());
    expect(payload.events.some((event) => event.event_id === "evt_string")).toBe(true);
  });

  it("drops unusable persisted missions, runs and approvals instead of 500ing every request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-bad-records-"));
    const stateFile = join(stateDir, "state.json");
    // ensureLoaded() runs on every request, so a state file written by an
    // older build -- a run with no `steps` array, a null approval entry --
    // used to throw during hydration and 500 the whole service forever.
    writeFileSync(stateFile, JSON.stringify({
      missions: [
        null,
        { mission_id: "mis_good", title: "Good", project_id: "proj_demo", workflow: "bugfix", status: "pending", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z" }
      ],
      runs: [
        { run_id: "run_broken", mission_id: "mis_good", workflow_id: "bugfix", status: "running", current_step_index: 0 },
        { run_id: "run_good", mission_id: "mis_good", workflow_id: "bugfix", status: "running", current_step_index: 0, steps: [], created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z" }
      ],
      approvals: [
        null,
        { approval_id: "approval_good", mission_id: "mis_good", run_id: "run_good", step_id: "plan", status: "pending", reason: "needs review" }
      ],
      events: [],
      audit: [],
      processed_event_ids: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);

    const missions = await app.request("/api/missions");
    expect(missions.status).toBe(200);
    expect((await missions.json()).missions.map((mission: any) => mission.mission_id)).toEqual(["mis_good"]);

    const runs = await app.request("/api/runs");
    expect(runs.status).toBe(200);
    expect((await runs.json()).runs.map((run: any) => run.run_id)).toEqual(["run_good"]);

    const approvals = await app.request("/api/approvals");
    expect(approvals.status).toBe(200);
    expect((await approvals.json()).approvals.map((approval: any) => approval.approval_id)).toEqual(["approval_good"]);
  });

  it("hydrates persisted state exactly once for concurrent first requests", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-concurrent-hydrate-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [],
      runs: [],
      approvals: [],
      events: [
        { event_id: "evt_a", type: "step.progress", ts: "2026-04-11T00:00:00.000Z", payload: {} },
        { event_id: "evt_b", type: "step.progress", ts: "2026-04-11T00:00:01.000Z", payload: {} },
        { event_id: "evt_c", type: "step.progress", ts: "2026-04-11T00:00:02.000Z", payload: {} }
      ],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const [first, second] = await Promise.all([
      app.request("/api/events"),
      app.request("/api/events")
    ]);
    const firstPayload = await first.json() as { events: Array<{ event_id: string }> };
    const secondPayload = await second.json() as { events: Array<{ event_id: string }> };
    expect(firstPayload.events).toHaveLength(3);
    expect(secondPayload.events).toHaveLength(3);
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

  it("reports the true event total in detail read models when the timeline exceeds a page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-timeline-total-"));
    const stateFile = join(stateDir, "state.json");
    const now = "2026-04-11T00:00:00.000Z";
    writeFileSync(stateFile, JSON.stringify({
      missions: [{ mission_id: "mis_busy", title: "Busy", project_id: "proj_demo", workflow: "bugfix", status: "running", created_at: now, updated_at: now }],
      runs: [],
      approvals: [],
      events: Array.from({ length: 120 }, (_, index) => ({
        event_id: `evt_busy_${index}`,
        type: "step.progress",
        ts: `2026-04-11T00:00:${String(index % 60).padStart(2, "0")}.${String(index).padStart(3, "0")}Z`,
        mission_id: "mis_busy",
        payload: {}
      })),
      audit: []
    }), "utf8");

    const app = await loadApp(stateFile);
    const detail = await (await app.request("/api/read-models/missions/mis_busy")).json() as { timeline_summary: { total_events: number } };

    // The audit read model pages at 100 items; total_events must reflect the
    // real count, not the page size.
    expect(detail.timeline_summary.total_events).toBe(120);
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

  it("falls back to sane pagination when limit/offset are not numeric", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const app = await loadApp();
    const response = await app.request("/api/read-models/audit?limit=abc&offset=oops");
    const payload = await response.json() as { timeline: unknown[]; pagination: { total: number; limit: number; offset: number; has_more: boolean } };

    expect(response.status).toBe(200);
    expect(payload.timeline).toEqual([]);
    expect(payload.pagination).toEqual({ total: 0, limit: 1, offset: 0, has_more: false });
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
    const response = await app.request("/api/runs/run_demo/interrupt-step", { method: "POST", headers: { "content-type": "application/json" } });
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
    const response = await app.request("/api/runs/run_demo/resume-step", { method: "POST", headers: { "content-type": "application/json" } });
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
    const response = await app.request("/api/runs/run_demo/retry-step", { method: "POST", headers: { "content-type": "application/json" } });
    const payload = await response.json() as { run: { status: string; steps: Array<{ state: string; notes?: string; execution_id?: string }> }; mission: { status: string } };

    expect(response.status).toBe(200);
    expect(payload.run.status).toBe("running");
    expect(payload.mission.status).toBe("running");
    expect(payload.run.steps[0]).toMatchObject({ state: "running", notes: "operator retried current step" });

    const eventsResponse = await app.request("/api/events");
    const eventsPayload = await eventsResponse.json() as { events: Array<{ type: string }> };
    expect(eventsPayload.events.some((event) => event.type === "step.retried")).toBe(true);
  });

  it("cancels run and resolves pending approval", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => { void input; return jsonResponse(); });
    vi.stubGlobal("fetch", fetchMock);

    const stateDir = mkdtempSync(join(tmpdir(), "orch-cancel-run-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [{ mission_id: "mis_demo", title: "Cancel flow", objective: "Cancel flow", project_id: "proj_demo", workflow: "bugfix", status: "awaiting_approval", active_run_id: "run_demo", summary: "waiting approval", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z" }],
      runs: [{ run_id: "run_demo", mission_id: "mis_demo", workflow_id: "bugfix", status: "awaiting_approval", current_step_index: 0, current_step_id: "deploy", approval_id: "approval_demo", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z", steps: [{ step_id: "deploy", title: "Canary deploy", kind: "deploy", risk: "high", approval_mode: "on_policy_trigger", state: "awaiting_approval", approval_id: "approval_demo", notes: "waiting approval", blocked_reason: "needs approval", artifacts: [], started_at: "2026-04-11T00:00:00.000Z" }] }],
      approvals: [{ approval_id: "approval_demo", mission_id: "mis_demo", run_id: "run_demo", step_id: "deploy", status: "pending", reason: "needs approval", decision_scope: "step", requested_at: "2026-04-11T00:00:00.000Z" }], events: [], audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const response = await app.request("/api/runs/run_demo/cancel", { method: "POST", headers: { "content-type": "application/json" } });
    const payload = await response.json() as { run: { status: string; steps: Array<{ state: string }> }; mission: { status: string }; approval?: { status: string; resolved_by?: string } };

    expect(response.status).toBe(200);
    expect(payload.run.status).toBe("cancelled");
    expect(payload.mission.status).toBe("cancelled");
    expect(payload.run.steps[0]).toMatchObject({ state: "cancelled" });
    expect(payload.approval).toMatchObject({ status: "rejected", resolved_by: "operator" });

    // Cancel is terminal: the workspace is released and an eval is recorded,
    // matching the fail/complete/approval-reject transitions.
    const calls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calls.some((url) => url.includes("/api/cleanup-run"))).toBe(true);
    expect(calls.some((url) => url.includes("/api/evals"))).toBe(true);
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

  it("deduplicates replayed events when loading persisted state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-event-dedupe-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [],
      runs: [],
      approvals: [],
      events: [
        { event_id: "evt_dup", type: "mission.created", ts: "2026-04-11T00:00:00.000Z", mission_id: "mis_demo", payload: {} },
        { event_id: "evt_dup", type: "mission.created", ts: "2026-04-11T00:00:00.000Z", mission_id: "mis_demo", payload: {} }
      ],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const response = await app.request("/api/events");
    const payload = await response.json() as { events: Array<{ event_id?: string }> };

    expect(response.status).toBe(200);
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0]?.event_id).toBe("evt_dup");
  });

  it("rejects artifact attachment to terminal runs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-artifact-terminal-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [{ mission_id: "mis_demo", title: "Done", objective: "Done", project_id: "proj_demo", workflow: "bugfix", status: "cancelled", active_run_id: "run_demo", summary: "operator cancelled run", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z" }],
      runs: [{ run_id: "run_demo", mission_id: "mis_demo", workflow_id: "bugfix", status: "cancelled", current_step_index: 0, current_step_id: "plan", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z", steps: [{ step_id: "plan", title: "Plan fix", kind: "plan", risk: "low", approval_mode: "on_policy_trigger", state: "cancelled", artifacts: [], started_at: "2026-04-11T00:00:00.000Z", completed_at: "2026-04-11T00:01:00.000Z" }] }],
      approvals: [],
      events: [],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const response = await app.request("/api/runs/run_demo/artifacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ step_id: "plan", type: "diff", content: "late artifact" })
    });
    expect(response.status).toBe(409);

    const runsResponse = await app.request("/api/runs");
    const runsPayload = await runsResponse.json() as { runs: Array<{ steps: Array<{ artifacts: unknown[] }> }> };
    expect(runsPayload.runs[0]?.steps[0]?.artifacts).toHaveLength(0);
  });

  it("treats artifact creation as idempotent when artifact_id repeats", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-artifact-idempotent-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [{ mission_id: "mis_demo", title: "Artifact flow", objective: "Artifact flow", project_id: "proj_demo", workflow: "bugfix", status: "running", active_run_id: "run_demo", summary: "Running", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z" }],
      runs: [{ run_id: "run_demo", mission_id: "mis_demo", workflow_id: "bugfix", status: "running", current_step_index: 0, current_step_id: "plan", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z", steps: [{ step_id: "plan", title: "Plan fix", kind: "plan", risk: "low", approval_mode: "on_policy_trigger", state: "running", artifacts: [] }] }],
      approvals: [],
      events: [],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const first = await app.request("/api/runs/run_demo/artifacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ step_id: "plan", type: "plan", artifact_id: "art_repeat", uri: "file:///tmp/plan.md" })
    });
    const second = await app.request("/api/runs/run_demo/artifacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ step_id: "plan", type: "plan", artifact_id: "art_repeat", uri: "file:///tmp/plan.md" })
    });

    expect(first.status).toBe(201);
    const created = await first.json() as { created_at?: string };
    expect(typeof created.created_at).toBe("string");
    expect(second.status).toBe(200);
    const eventsResponse = await app.request("/api/events");
    const eventsPayload = await eventsResponse.json() as { events: Array<{ type: string; payload?: { artifact_id?: string } }> };
    expect(eventsPayload.events.filter((event) => event.type === "artifact.created" && event.payload?.artifact_id === "art_repeat")).toHaveLength(1);
  });

  it("rejects artifact attachments for unknown steps or missing type", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-artifact-invalid-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [{ mission_id: "mis_demo", title: "Artifact flow", objective: "Artifact flow", project_id: "proj_demo", workflow: "bugfix", status: "running", active_run_id: "run_demo", summary: "Running", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z" }],
      runs: [{ run_id: "run_demo", mission_id: "mis_demo", workflow_id: "bugfix", status: "running", current_step_index: 0, current_step_id: "plan", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z", steps: [{ step_id: "plan", title: "Plan fix", kind: "plan", risk: "low", approval_mode: "on_policy_trigger", state: "running", artifacts: [] }] }],
      approvals: [],
      events: [],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const unknownStep = await app.request("/api/runs/run_demo/artifacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ step_id: "nope", type: "plan", uri: "file:///tmp/plan.md" })
    });
    expect(unknownStep.status).toBe(404);

    const missingType = await app.request("/api/runs/run_demo/artifacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ step_id: "plan", uri: "file:///tmp/plan.md" })
    });
    expect(missingType.status).toBe(400);

    // Non-string artifact_id/uri and non-object metadata poison idempotent
    // re-attachment and read-model consumers; they must 400, not attach.
    for (const invalid of [
      { step_id: "plan", type: "plan", artifact_id: 42 },
      { step_id: "plan", type: "plan", artifact_id: "  " },
      { step_id: "plan", type: "plan", uri: 42 },
      { step_id: "plan", type: "plan", content: { nested: true } },
      { step_id: "plan", type: "plan", metadata: ["not", "an", "object"] }
    ]) {
      const response = await app.request("/api/runs/run_demo/artifacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(invalid)
      });
      expect(response.status).toBe(400);
    }

    const eventsResponse = await app.request("/api/events");
    const eventsPayload = await eventsResponse.json() as { events: Array<{ type: string }> };
    expect(eventsPayload.events.filter((event) => event.type === "artifact.created")).toHaveLength(0);
  });

  it("records eval.started and eval.completed when eval persistence succeeds", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
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
      if (url.includes("/api/evals")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        return jsonResponse({ status: 201, body: { ok: true, record: { eval_id: "eval_123", ...body } } });
      }
      if (url.includes("/api/cleanup-run")) return jsonResponse({ body: { ok: true } });
      return jsonResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = await loadApp();
    const createMission = await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Eval success", project_id: "proj_demo", workflow_id: "bugfix" })
    });
    const mission = await createMission.json() as { mission_id: string };
    const startRun = await app.request(`/api/missions/${mission.mission_id}/start`, { method: "POST", headers: { "content-type": "application/json" } });
    const run = await startRun.json() as { run_id: string };

    const execute = await app.request(`/api/runs/${run.run_id}/execute-current`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(execute.status).toBe(400);

    const eventsResponse = await app.request("/api/events");
    const eventsPayload = await eventsResponse.json() as { events: Array<{ type: string; payload?: { eval_id?: string } }> };
    expect(eventsPayload.events.some((event) => event.type === "eval.started")).toBe(true);
    expect(eventsPayload.events.some((event) => event.type === "eval.completed" && event.payload?.eval_id === "eval_123")).toBe(true);

    // Eval lifecycle events must land in the audit timeline under their own
    // kind instead of the anonymous "event" fallback.
    const auditResponse = await app.request("/api/read-models/audit?kind=eval");
    const auditPayload = await auditResponse.json() as { timeline: Array<{ kind: string; title: string; event_type: string }> };
    expect(auditPayload.timeline.length).toBeGreaterThan(0);
    expect(auditPayload.timeline.every((item) => item.kind === "eval")).toBe(true);
    expect(auditPayload.timeline.some((item) => item.title === "Eval completed")).toBe(true);
  });

  it("records eval.failed when eval persistence fails", async () => {
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
      if (url.includes("/api/evals")) throw new Error("eval-api offline");
      if (url.includes("/api/cleanup-run")) return jsonResponse({ body: { ok: true } });
      return jsonResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = await loadApp();
    const createMission = await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Eval failure", project_id: "proj_demo", workflow_id: "bugfix" })
    });
    const mission = await createMission.json() as { mission_id: string };
    const startRun = await app.request(`/api/missions/${mission.mission_id}/start`, { method: "POST", headers: { "content-type": "application/json" } });
    const run = await startRun.json() as { run_id: string };

    const execute = await app.request(`/api/runs/${run.run_id}/execute-current`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(execute.status).toBe(400);

    const eventsResponse = await app.request("/api/events");
    const eventsPayload = await eventsResponse.json() as { events: Array<{ type: string; payload?: { error?: string } }> };
    expect(eventsPayload.events.some((event) => event.type === "eval.started")).toBe(true);
    expect(eventsPayload.events.some((event) => event.type === "eval.failed" && event.payload?.error === "eval-api offline")).toBe(true);
  });

  it("sweeps orphaned execution workspaces for unknown and terminal runs", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ body: { ok: true } }));
    vi.stubGlobal("fetch", fetchMock);

    const stateDir = mkdtempSync(join(tmpdir(), "orch-sweep-orphans-"));
    const stateFile = join(stateDir, "state.json");
    const worktreesRoot = join(stateDir, "worktrees");
    const runsRoot = join(stateDir, "worker-runs");
    process.env.WORKTREE_ROOT = worktreesRoot;
    process.env.WORKER_RUNTIME_ROOT = runsRoot;

    mkdirSync(join(worktreesRoot, "run_done"), { recursive: true });
    mkdirSync(join(worktreesRoot, "run_live"), { recursive: true });
    mkdirSync(join(worktreesRoot, "run_orphan"), { recursive: true });
    mkdirSync(join(runsRoot, "run_done", "plan"), { recursive: true });
    mkdirSync(join(runsRoot, "run_live", "plan"), { recursive: true });
    mkdirSync(join(runsRoot, "run_orphan", "plan"), { recursive: true });

    writeFileSync(stateFile, JSON.stringify({
      missions: [
        { mission_id: "mis_done", title: "Done", objective: "Done", project_id: "proj_demo", workflow: "bugfix", repo_path: "/repo/done", status: "completed", active_run_id: "run_done", summary: "done", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z" },
        { mission_id: "mis_live", title: "Live", objective: "Live", project_id: "proj_demo", workflow: "bugfix", repo_path: "/repo/live", status: "running", active_run_id: "run_live", summary: "running", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z" }
      ],
      runs: [
        { run_id: "run_done", mission_id: "mis_done", workflow_id: "bugfix", status: "completed", current_step_index: 0, current_step_id: "deploy", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z", steps: [{ step_id: "deploy", title: "Deploy", kind: "deploy", risk: "high", approval_mode: "on_policy_trigger", state: "completed", artifacts: [] }] },
        { run_id: "run_live", mission_id: "mis_live", workflow_id: "bugfix", status: "running", current_step_index: 0, current_step_id: "plan", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z", steps: [{ step_id: "plan", title: "Plan", kind: "plan", risk: "low", approval_mode: "on_policy_trigger", state: "running", artifacts: [], execution_id: "exec_live" }] }
      ],
      approvals: [],
      events: [],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const response = await app.request("/api/maintenance/sweep-orphans", { method: "POST", headers: { "content-type": "application/json" } });
    const payload = await response.json() as { removed_run_ids: string[]; skipped_run_ids: string[]; removed_count: number };

    expect(response.status).toBe(200);
    expect(payload.removed_count).toBe(2);
    expect(payload.removed_run_ids).toEqual(["run_done", "run_orphan"]);
    expect(payload.skipped_run_ids).toEqual(["run_live"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("/api/cleanup-run"),
      expect.objectContaining({ body: JSON.stringify({ run_id: "run_done", source_repo: "/repo/done", branch_name: "hermes/run_done", remove_outputs: true }) })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("/api/cleanup-run"),
      expect.objectContaining({ body: JSON.stringify({ run_id: "run_orphan", source_repo: undefined, branch_name: "hermes/run_orphan", remove_outputs: true }) })
    );
  });

  it("keeps the run output root when a swept terminal run still has recorded artifacts", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ body: { ok: true } }));
    vi.stubGlobal("fetch", fetchMock);

    const stateDir = mkdtempSync(join(tmpdir(), "orch-sweep-artifacts-"));
    const stateFile = join(stateDir, "state.json");
    const worktreesRoot = join(stateDir, "worktrees");
    const runsRoot = join(stateDir, "worker-runs");
    process.env.WORKTREE_ROOT = worktreesRoot;
    process.env.WORKER_RUNTIME_ROOT = runsRoot;

    mkdirSync(join(worktreesRoot, "run_kept"), { recursive: true });
    mkdirSync(join(runsRoot, "run_kept", "plan"), { recursive: true });

    writeFileSync(stateFile, JSON.stringify({
      missions: [{ mission_id: "mis_kept", title: "Kept", objective: "Kept", project_id: "proj_demo", workflow: "bugfix", repo_path: "/repo/kept", status: "completed", active_run_id: "run_kept", summary: "done", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z" }],
      runs: [{
        run_id: "run_kept", mission_id: "mis_kept", workflow_id: "bugfix", status: "completed", current_step_index: 0, current_step_id: "plan",
        created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z",
        steps: [{ step_id: "plan", title: "Plan", kind: "plan", risk: "low", approval_mode: "on_policy_trigger", state: "completed", artifacts: [{ artifact_id: "art_1", kind: "plan", label: "plan", uri: `file://${join(runsRoot, "run_kept", "plan", "plan.md")}` }] }]
      }],
      approvals: [],
      events: [],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const response = await app.request("/api/maintenance/sweep-orphans", { method: "POST", headers: { "content-type": "application/json" } });
    const payload = await response.json() as { removed_run_ids: string[] };

    expect(response.status).toBe(200);
    expect(payload.removed_run_ids).toEqual(["run_kept"]);
    // The worktree and branch are dead, but the artifacts read model still
    // links into the output root, so it must survive the sweep.
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/cleanup-run"),
      expect.objectContaining({ body: JSON.stringify({ run_id: "run_kept", source_repo: "/repo/kept", branch_name: "hermes/run_kept", remove_outputs: false }) })
    );

    const artifacts = await app.request("/api/read-models/artifacts");
    const artifactsPayload = await artifacts.json() as { artifacts: Array<{ ref: string }> };
    expect(artifactsPayload.artifacts).toHaveLength(1);
  });

  it("continues sweeping remaining orphans when one cleanup fails", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) as { run_id?: string } : {};
      if (body.run_id === "run_broken") return jsonResponse({ ok: false, status: 500 });
      return jsonResponse({ body: { ok: true } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const stateDir = mkdtempSync(join(tmpdir(), "orch-sweep-partial-"));
    const stateFile = join(stateDir, "state.json");
    const worktreesRoot = join(stateDir, "worktrees");
    const runsRoot = join(stateDir, "worker-runs");
    process.env.WORKTREE_ROOT = worktreesRoot;
    process.env.WORKER_RUNTIME_ROOT = runsRoot;

    mkdirSync(join(worktreesRoot, "run_broken"), { recursive: true });
    mkdirSync(join(worktreesRoot, "run_orphan"), { recursive: true });

    writeFileSync(stateFile, JSON.stringify({ missions: [], runs: [], approvals: [], events: [], audit: [] }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const response = await app.request("/api/maintenance/sweep-orphans", { method: "POST", headers: { "content-type": "application/json" } });
    const payload = await response.json() as { removed_run_ids: string[]; failed_run_ids: Array<{ run_id: string; error: string }>; removed_count: number; failed_count: number };

    expect(response.status).toBe(200);
    expect(payload.removed_run_ids).toEqual(["run_orphan"]);
    expect(payload.failed_count).toBe(1);
    expect(payload.failed_run_ids[0]).toMatchObject({ run_id: "run_broken" });
    expect(payload.failed_run_ids[0]?.error).toContain("500");
  });

  it("does not sweep active non-terminal run workspaces", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ body: { ok: true } }));
    vi.stubGlobal("fetch", fetchMock);

    const stateDir = mkdtempSync(join(tmpdir(), "orch-sweep-protect-"));
    const stateFile = join(stateDir, "state.json");
    const worktreesRoot = join(stateDir, "worktrees");
    const runsRoot = join(stateDir, "worker-runs");
    process.env.WORKTREE_ROOT = worktreesRoot;
    process.env.WORKER_RUNTIME_ROOT = runsRoot;

    mkdirSync(join(worktreesRoot, "run_live"), { recursive: true });
    mkdirSync(join(runsRoot, "run_live", "plan"), { recursive: true });

    writeFileSync(stateFile, JSON.stringify({
      missions: [{ mission_id: "mis_live", title: "Live", objective: "Live", project_id: "proj_demo", workflow: "bugfix", repo_path: "/repo/live", status: "running", active_run_id: "run_live", summary: "running", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z" }],
      runs: [{ run_id: "run_live", mission_id: "mis_live", workflow_id: "bugfix", status: "running", current_step_index: 0, current_step_id: "plan", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z", steps: [{ step_id: "plan", title: "Plan", kind: "plan", risk: "low", approval_mode: "on_policy_trigger", state: "running", artifacts: [], execution_id: "exec_live" }] }],
      approvals: [],
      events: [],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const response = await app.request("/api/maintenance/sweep-orphans", { method: "POST", headers: { "content-type": "application/json" } });
    const payload = await response.json() as { removed_run_ids: string[]; skipped_run_ids: string[]; removed_count: number };

    expect(response.status).toBe(200);
    expect(payload.removed_count).toBe(0);
    expect(payload.removed_run_ids).toEqual([]);
    expect(payload.skipped_run_ids).toEqual(["run_live"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("emits SSE keep-alive comments so idle streams survive proxies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));
    process.env.SSE_HEARTBEAT_MS = "20";

    const app = await loadApp();
    const response = await app.request("/api/events/stream?last=0");
    expect(response.status).toBe(200);

    const reader = response.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain(": keep-alive");
    await reader.cancel();
  });

  it("rejects state-changing requests that do not declare a JSON content-type", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const app = await loadApp();
    // What a cross-origin HTML form post looks like: a "simple" content type
    // that never triggers a CORS preflight, carrying a JSON body that
    // c.req.json() would otherwise happily parse.
    const formPost = await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ title: "csrf", project_id: "proj_demo" })
    });
    expect(formPost.status).toBe(415);
    expect(await formPost.json()).toEqual({ error: "content-type must be application/json" });

    // A bodiless action POST is equally reachable from a cross-origin form,
    // so it must carry the header too.
    const bodiless = await app.request("/api/missions/mis_nope/start", { method: "POST" });
    expect(bodiless.status).toBe(415);

    // Charset parameters are still acceptable.
    const withCharset = await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ title: "ok", project_id: "proj_demo" })
    });
    expect(withCharset.status).toBe(201);

    // Reads are unaffected.
    expect((await app.request("/api/missions")).status).toBe(200);
  });

  it("rejects request bodies larger than the configured limit with 413", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));
    process.env.MAX_REQUEST_BODY_BYTES = "200";

    const app = await loadApp();
    const oversized = JSON.stringify({ title: "x".repeat(500), project_id: "proj_demo" });
    // The Request constructor does not derive content-length from a string
    // body, so set it explicitly here. Over the wire @hono/node-server copies
    // the header off the incoming message, which is what the guard reads.
    const rejected = await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(oversized.length) },
      body: oversized
    });
    expect(rejected.status).toBe(413);
    expect(await rejected.json()).toEqual({ error: "request body too large" });

    // A body under the limit still goes through.
    const small = JSON.stringify({ title: "small", project_id: "proj_demo" });
    const accepted = await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(small.length) },
      body: small
    });
    expect(accepted.status).toBe(201);
  });

  it("caps concurrent SSE subscribers and frees a slot when a stream closes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));
    process.env.SSE_MAX_SUBSCRIBERS = "2";

    const app = await loadApp();
    const first = await app.request("/api/events/stream?last=0");
    const second = await app.request("/api/events/stream?last=0");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const rejected = await app.request("/api/events/stream?last=0");
    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toEqual({ error: "too many concurrent event streams" });

    // Closing a stream releases its slot.
    await first.body!.cancel();
    const readmitted = await app.request("/api/events/stream?last=0");
    expect(readmitted.status).toBe(200);

    await second.body!.cancel();
    await readmitted.body!.cancel();
  });

  it("streams recent events over SSE with filters", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-stream-backlog-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [],
      runs: [],
      approvals: [],
      events: [
        { event_id: "evt_old", type: "mission.created", ts: "2026-04-11T00:00:00.000Z", mission_id: "mis_old", payload: {} },
        { event_id: "evt_keep", type: "mission.updated", ts: "2026-04-11T00:01:00.000Z", mission_id: "mis_demo", payload: { status: "running" } }
      ],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const response = await app.request("/api/events/stream?mission_id=mis_demo&last=1");
    const reader = response.body?.getReader();
    const first = reader ? await reader.read() : { value: undefined, done: true };
    await reader?.cancel();
    const chunk = first.value ? new TextDecoder().decode(first.value) : "";

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(chunk).toContain("event: mission.updated");
    expect(chunk).toContain('"event_id":"evt_keep"');
    expect(chunk).not.toContain("evt_old");
  });

  it("pushes newly recorded events to SSE subscribers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const app = await loadApp();
    const response = await app.request("/api/events/stream?last=0");
    const reader = response.body?.getReader();

    await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Live stream", project_id: "proj_demo", workflow_id: "bugfix" })
    });

    const first = reader ? await reader.read() : { value: undefined, done: true };
    await reader?.cancel();
    const chunk = first.value ? new TextDecoder().decode(first.value) : "";

    expect(response.status).toBe(200);
    expect(chunk).toContain("event: mission.created");
    expect(chunk).toContain('"type":"mission.created"');
  });

  it("keeps persisted processed event ids beyond the retained event window across restarts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-processed-ids-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [],
      runs: [{
        run_id: "run_demo", mission_id: "mis_demo", workflow_id: "bugfix", status: "running", current_step_index: 0, current_step_id: "plan", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z",
        steps: [{ step_id: "plan", title: "Plan fix", kind: "plan", risk: "low", approval_mode: "on_policy_trigger", state: "running", artifacts: [], started_at: "2026-04-11T00:00:00.000Z" }]
      }],
      approvals: [],
      events: [
        { event_id: "evt_recent", type: "mission.created", ts: "2026-04-11T00:00:00.000Z", mission_id: "mis_demo", payload: {} }
      ],
      audit: [],
      // Simulates an id whose event has already been evicted from the
      // retained event window but must stay deduplicated after restart.
      processed_event_ids: ["evt_evicted"]
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    await app.request("/health");
    const before = await (await app.request("/api/events")).json() as { events: Array<{ event_id?: string }> };
    expect(before.events.some((event) => event.event_id === "evt_evicted")).toBe(false);

    // Trigger a mutation so state is persisted again, then assert the
    // evicted id survived the load/persist round trip.
    await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Restart", project_id: "proj_demo" })
    });
    const persisted = JSON.parse(readFileSync(stateFile, "utf8")) as { processed_event_ids: string[] };
    expect(persisted.processed_event_ids).toContain("evt_evicted");
    expect(persisted.processed_event_ids).toContain("evt_recent");
  });

  it("restores the persisted audit trail with stable audit ids across restarts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-audit-restore-"));
    const stateFile = join(stateDir, "state.json");

    const app = await loadApp(stateFile);
    await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Audit trail", project_id: "proj_demo" })
    });
    const before = await (await app.request("/api/audit")).json() as { audit: Array<{ audit_id?: string; type?: string }> };
    expect(before.audit.length).toBeGreaterThan(0);

    const reloaded = await loadApp(stateFile);
    await reloaded.request("/health");
    const after = await (await reloaded.request("/api/audit")).json() as { audit: Array<{ audit_id?: string; type?: string }> };

    // Replay must not regenerate audit ids or drop persisted entries.
    expect(after.audit.map((entry) => entry.audit_id)).toEqual(before.audit.map((entry) => entry.audit_id));
  });

  it("preserves the order of same-timestamp events across hydration replay", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-event-order-"));
    const stateFile = join(stateDir, "state.json");
    // state.events persists newest-first; both events share one timestamp,
    // as step.started/step.completed pairs recorded in the same millisecond do.
    writeFileSync(stateFile, JSON.stringify({
      missions: [],
      runs: [],
      approvals: [],
      events: [
        { event_id: "evt_newer", type: "step.completed", ts: "2026-04-11T00:00:00.000Z", mission_id: "mis_demo", run_id: "run_demo", payload: {} },
        { event_id: "evt_older", type: "step.started", ts: "2026-04-11T00:00:00.000Z", mission_id: "mis_demo", run_id: "run_demo", payload: {} }
      ],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const payload = await (await app.request("/api/events")).json() as { events: Array<{ event_id?: string }> };

    // Newest-first read model: the completed event must still lead.
    expect(payload.events.map((event) => event.event_id)).toEqual(["evt_newer", "evt_older"]);
  });

  it("reassigns out-of-range event sequences instead of poisoning the sequence counter", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-bad-sequence-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [],
      runs: [],
      approvals: [],
      events: [
        { event_id: "evt_huge", type: "step.progress", ts: "2026-04-11T00:00:00.000Z", sequence: 1e308, mission_id: "mis_demo", run_id: "run_demo", payload: {} },
        { event_id: "evt_frac", type: "step.progress", ts: "2026-04-11T00:01:00.000Z", sequence: -2.5, mission_id: "mis_demo", run_id: "run_demo", payload: {} }
      ],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Sequence sanity", project_id: "proj_demo" })
    });

    const payload = await (await app.request("/api/events")).json() as { events: Array<{ sequence: number }> };
    // Every sequence must be a positive safe integer: the 1e308 replay must
    // not leak through, and the mission.created event minted afterwards must
    // not inherit a poisoned counter (1e308 + 1 === 1e308).
    for (const event of payload.events) {
      expect(Number.isSafeInteger(event.sequence)).toBe(true);
      expect(event.sequence).toBeGreaterThan(0);
    }
  });

  it("skips unrecognized persisted events instead of failing every request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const stateDir = mkdtempSync(join(tmpdir(), "orch-bad-event-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [],
      runs: [],
      approvals: [],
      events: [
        { event_id: "evt_bad", type: "mission.exploded", ts: "2026-04-11T00:00:00.000Z", mission_id: "mis_demo", payload: {} },
        { event_id: "evt_good", type: "mission.created", ts: "2026-04-11T00:01:00.000Z", mission_id: "mis_demo", payload: {} }
      ],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const response = await app.request("/api/events");
    const payload = await response.json() as { events: Array<{ event_id?: string; type: string }> };

    expect(response.status).toBe(200);
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0]).toMatchObject({ event_id: "evt_good", type: "mission.created" });
    expect(warn).toHaveBeenCalled();
  });

  it("rejects a second execute-current dispatch while one is already in flight", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/execute-step")) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return jsonResponse({ body: { success: true, summary: "planned", confidence: 0.95, artifacts: [{ type: "plan", uri: "file:///tmp/plan.md" }] } });
      }
      return jsonResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = await loadApp();
    const createMission = await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Concurrent dispatch", project_id: "proj_demo", workflow_id: "bugfix" })
    });
    const mission = await createMission.json() as { mission_id: string };
    const startRun = await app.request(`/api/missions/${mission.mission_id}/start`, { method: "POST", headers: { "content-type": "application/json" } });
    const run = await startRun.json() as { run_id: string };

    const [first, second] = await Promise.all([
      app.request(`/api/runs/${run.run_id}/execute-current`, { method: "POST", headers: { "content-type": "application/json" } }),
      app.request(`/api/runs/${run.run_id}/execute-current`, { method: "POST", headers: { "content-type": "application/json" } })
    ]);

    expect([first.status, second.status].sort((a, b) => a - b)).toEqual([200, 409]);
    const workerCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes("/api/execute-step"));
    expect(workerCalls).toHaveLength(1);
  });

  it("signals the worker to abort the in-flight execution when the operator interrupts", async () => {
    let releaseWorker: (() => void) | undefined;
    const workerGate = new Promise<void>((resolve) => { releaseWorker = resolve; });
    let dispatchedExecutionId: string | undefined;
    const abortCalls: Array<{ execution_id?: string; reason?: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/execute-step")) {
        dispatchedExecutionId = (JSON.parse(String(init?.body ?? "{}")) as { execution_id?: string }).execution_id;
        await workerGate;
        return jsonResponse({ body: { success: true, summary: "planned", confidence: 0.95, artifacts: [] } });
      }
      if (url.includes("/api/abort-execution")) {
        abortCalls.push(JSON.parse(String(init?.body ?? "{}")) as { execution_id?: string; reason?: string });
        return jsonResponse({ body: { ok: true } });
      }
      return jsonResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = await loadApp();
    const createMission = await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Abort in-flight execution", project_id: "proj_demo", workflow_id: "bugfix" })
    });
    const mission = await createMission.json() as { mission_id: string };
    const startRun = await app.request(`/api/missions/${mission.mission_id}/start`, { method: "POST", headers: { "content-type": "application/json" } });
    const run = await startRun.json() as { run_id: string };

    const executePromise = app.request(`/api/runs/${run.run_id}/execute-current`, { method: "POST", headers: { "content-type": "application/json" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const interrupt = await app.request(`/api/runs/${run.run_id}/interrupt-step`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(interrupt.status).toBe(200);

    // The interrupt must reach the worker's abort endpoint with the
    // dispatched execution id so its child commands stop, instead of only
    // discarding the result after the worker finishes on its own.
    expect(abortCalls).toHaveLength(1);
    expect(abortCalls[0]).toMatchObject({ execution_id: dispatchedExecutionId, reason: "operator interrupted current step" });

    releaseWorker?.();
    const execute = await executePromise;
    expect(execute.status).toBe(409);
  });

  it("does not call the worker abort endpoint when no execution is in flight", async () => {
    const abortCalls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/abort-execution")) abortCalls.push(url);
      return jsonResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = await loadApp();
    const createMission = await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "No abort without execution", project_id: "proj_demo", workflow_id: "bugfix" })
    });
    const mission = await createMission.json() as { mission_id: string };
    const startRun = await app.request(`/api/missions/${mission.mission_id}/start`, { method: "POST", headers: { "content-type": "application/json" } });
    const run = await startRun.json() as { run_id: string };

    // The step is running (started at mission start) but was never
    // dispatched, so it has no execution id to abort.
    const interrupt = await app.request(`/api/runs/${run.run_id}/interrupt-step`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(interrupt.status).toBe(200);
    expect(abortCalls).toHaveLength(0);
  });

  it("discards a worker result that lands after the operator interrupted the step", async () => {
    let releaseWorker: (() => void) | undefined;
    const workerGate = new Promise<void>((resolve) => { releaseWorker = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/execute-step")) {
        await workerGate;
        return jsonResponse({ body: { success: true, summary: "planned", confidence: 0.95, artifacts: [{ type: "plan", uri: "file:///tmp/plan.md" }] } });
      }
      return jsonResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = await loadApp();
    const createMission = await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Interrupt mid-dispatch", project_id: "proj_demo", workflow_id: "bugfix" })
    });
    const mission = await createMission.json() as { mission_id: string };
    const startRun = await app.request(`/api/missions/${mission.mission_id}/start`, { method: "POST", headers: { "content-type": "application/json" } });
    const run = await startRun.json() as { run_id: string };

    const executePromise = app.request(`/api/runs/${run.run_id}/execute-current`, { method: "POST", headers: { "content-type": "application/json" } });
    // Let the dispatch reach the in-flight worker call before interrupting.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const interrupt = await app.request(`/api/runs/${run.run_id}/interrupt-step`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(interrupt.status).toBe(200);

    releaseWorker?.();
    const execute = await executePromise;
    const payload = await execute.json() as { run: { status: string; steps: Array<{ step_id: string; state: string }> }; error?: string };

    expect(execute.status).toBe(409);
    expect(payload.error).toMatch(/discarded/);
    expect(payload.run.status).toBe("paused");
    expect(payload.run.steps.find((step) => step.step_id === "plan")?.state).toBe("paused");

    const events = await app.request("/api/events");
    const eventsPayload = await events.json() as { events: Array<{ type: string; step_id?: string }> };
    expect(eventsPayload.events.some((event) => event.type === "step.completed" && event.step_id === "plan")).toBe(false);
  });

  it("mints a fresh execution id for the re-dispatch after a discarded interrupt", async () => {
    let releaseWorker: (() => void) | undefined;
    const workerGate = new Promise<void>((resolve) => { releaseWorker = resolve; });
    const executionIds: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/execute-step")) {
        const request = JSON.parse(String(init?.body ?? "{}")) as { mission_id: string; run_id: string; step_id: string; execution_id: string };
        executionIds.push(request.execution_id);
        const stepEvent = {
          schema_version: "v1",
          event_id: `${request.execution_id}_1`,
          sequence: 1,
          timestamp: new Date().toISOString(),
          source: "hermes",
          type: "tool.started",
          mission_id: request.mission_id,
          run_id: request.run_id,
          step_id: request.step_id,
          execution_id: request.execution_id,
          payload: { tool_name: "workspace.plan" }
        };
        if (executionIds.length === 1) {
          await workerGate;
          return jsonResponse({ body: { success: true, summary: "planned (stale)", confidence: 0.95, artifacts: [], step_events: [stepEvent] } });
        }
        return jsonResponse({ body: { success: true, summary: "planned", confidence: 0.95, artifacts: [{ type: "plan", uri: "file:///tmp/plan.md" }], step_events: [stepEvent] } });
      }
      return jsonResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = await loadApp();
    const createMission = await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Fresh id after discard", project_id: "proj_demo", workflow_id: "bugfix" })
    });
    const mission = await createMission.json() as { mission_id: string };
    const startRun = await app.request(`/api/missions/${mission.mission_id}/start`, { method: "POST", headers: { "content-type": "application/json" } });
    const run = await startRun.json() as { run_id: string };

    const executePromise = app.request(`/api/runs/${run.run_id}/execute-current`, { method: "POST", headers: { "content-type": "application/json" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await app.request(`/api/runs/${run.run_id}/interrupt-step`, { method: "POST", headers: { "content-type": "application/json" } });
    releaseWorker?.();
    const discarded = await executePromise;
    expect(discarded.status).toBe(409);

    const resume = await app.request(`/api/runs/${run.run_id}/resume-step`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(resume.status).toBe(200);

    const second = await app.request(`/api/runs/${run.run_id}/execute-current`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(second.status).toBe(200);

    // The discarded execution's events were already recorded; reusing its id
    // would make the re-dispatched execution's events (same `${id}_N`
    // event_ids) vanish into replay dedupe.
    expect(executionIds).toHaveLength(2);
    expect(executionIds[1]).not.toBe(executionIds[0]);

    const events = await app.request("/api/events");
    const eventsPayload = await events.json() as { events: Array<{ type: string; execution_id?: string }> };
    expect(eventsPayload.events.some((event) => event.type === "tool.started" && event.execution_id === executionIds[1])).toBe(true);
  });

  it("discards a worker result that lands after the operator cancelled the step", async () => {
    let releaseWorker: (() => void) | undefined;
    const workerGate = new Promise<void>((resolve) => { releaseWorker = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/execute-step")) {
        await workerGate;
        return jsonResponse({ body: { success: true, summary: "planned", confidence: 0.95, artifacts: [{ type: "plan", uri: "file:///tmp/plan.md" }] } });
      }
      return jsonResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = await loadApp();
    const createMission = await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Cancel mid-dispatch", project_id: "proj_demo", workflow_id: "bugfix" })
    });
    const mission = await createMission.json() as { mission_id: string };
    const startRun = await app.request(`/api/missions/${mission.mission_id}/start`, { method: "POST", headers: { "content-type": "application/json" } });
    const run = await startRun.json() as { run_id: string };

    const executePromise = app.request(`/api/runs/${run.run_id}/execute-current`, { method: "POST", headers: { "content-type": "application/json" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const cancel = await app.request(`/api/runs/${run.run_id}/cancel-step`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(cancel.status).toBe(200);

    releaseWorker?.();
    const execute = await executePromise;
    const payload = await execute.json() as { run: { status: string; steps: Array<{ step_id: string; state: string }> }; error?: string };

    expect(execute.status).toBe(409);
    expect(payload.run.status).toBe("cancelled");
    expect(payload.run.steps.find((step) => step.step_id === "plan")?.state).toBe("cancelled");

    const missions = await app.request("/api/missions");
    const missionsPayload = await missions.json() as { missions: Array<{ mission_id: string; status: string }> };
    expect(missionsPayload.missions.find((item) => item.mission_id === mission.mission_id)?.status).toBe("cancelled");
  });

  it("resumes the SSE stream after the Last-Event-ID on reconnect", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-stream-resume-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [],
      runs: [],
      approvals: [],
      events: [
        { event_id: "evt_1", type: "mission.created", ts: "2026-04-11T00:00:00.000Z", mission_id: "mis_demo", payload: {} },
        { event_id: "evt_2", type: "mission.updated", ts: "2026-04-11T00:01:00.000Z", mission_id: "mis_demo", payload: {} },
        { event_id: "evt_3", type: "mission.running", ts: "2026-04-11T00:02:00.000Z", mission_id: "mis_demo", payload: {} }
      ],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    // `last=1` would replay a single event; Last-Event-ID must win and
    // replay everything recorded after evt_1 instead.
    const response = await app.request("/api/events/stream?last=1", { headers: { "last-event-id": "evt_1" } });
    expect(response.status).toBe(200);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let chunk = decoder.decode((await reader.read()).value);
    if (!chunk.includes("evt_3")) {
      chunk += decoder.decode((await reader.read()).value);
    }
    await reader.cancel();

    expect(chunk).toContain('"event_id":"evt_2"');
    expect(chunk).toContain('"event_id":"evt_3"');
    expect(chunk).not.toContain('"event_id":"evt_1"');
  });

  it("falls back to count-based replay when the Last-Event-ID is unknown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-stream-resume-unknown-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [],
      runs: [],
      approvals: [],
      events: [
        { event_id: "evt_1", type: "mission.created", ts: "2026-04-11T00:00:00.000Z", mission_id: "mis_demo", payload: {} },
        { event_id: "evt_2", type: "mission.updated", ts: "2026-04-11T00:01:00.000Z", mission_id: "mis_demo", payload: {} }
      ],
      audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const response = await app.request("/api/events/stream?last=1", { headers: { "last-event-id": "evt_evicted" } });
    expect(response.status).toBe(200);

    const reader = response.body!.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();

    expect(chunk).toContain('"event_id":"evt_2"');
    expect(chunk).not.toContain('"event_id":"evt_1"');
  });

  it("attributes memory writebacks to the mission's project instead of proj_demo", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/execute-step")) {
        return jsonResponse({ body: { success: true, summary: "planned", confidence: 0.95, artifacts: [{ type: "plan", uri: "file:///tmp/plan.md" }] } });
      }
      return jsonResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = await loadApp();
    const createMission = await app.request("/api/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Attribution", project_id: "proj_alpha", workflow_id: "bugfix" })
    });
    const mission = await createMission.json() as { mission_id: string };
    const startRun = await app.request(`/api/missions/${mission.mission_id}/start`, { method: "POST", headers: { "content-type": "application/json" } });
    const run = await startRun.json() as { run_id: string };

    const execute = await app.request(`/api/runs/${run.run_id}/execute-current`, { method: "POST", headers: { "content-type": "application/json" } });
    expect(execute.status).toBe(200);

    const writebackCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/api/memory/tasks/close"));
    expect(writebackCall).toBeDefined();
    const body = JSON.parse(String(writebackCall![1]?.body)) as { project_id: string; agent_id: string };
    expect(body.project_id).toBe("proj_alpha");
  });

  it("rejects the pending approval when an awaiting-approval step is retried", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse()));

    const stateDir = mkdtempSync(join(tmpdir(), "orch-retry-approval-"));
    const stateFile = join(stateDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({
      missions: [{ mission_id: "mis_demo", title: "Retry approval flow", objective: "Retry approval flow", project_id: "proj_demo", workflow: "bugfix", status: "awaiting_approval", active_run_id: "run_demo", summary: "waiting approval", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z" }],
      runs: [{ run_id: "run_demo", mission_id: "mis_demo", workflow_id: "bugfix", status: "awaiting_approval", current_step_index: 0, current_step_id: "deploy", approval_id: "approval_demo", created_at: "2026-04-11T00:00:00.000Z", updated_at: "2026-04-11T00:00:00.000Z", steps: [{ step_id: "deploy", title: "Canary deploy", kind: "deploy", risk: "high", approval_mode: "on_policy_trigger", state: "awaiting_approval", approval_id: "approval_demo", notes: "waiting approval", blocked_reason: "needs approval", artifacts: [], started_at: "2026-04-11T00:00:00.000Z" }] }],
      approvals: [{ approval_id: "approval_demo", mission_id: "mis_demo", run_id: "run_demo", step_id: "deploy", status: "pending", reason: "needs approval", decision_scope: "step", requested_at: "2026-04-11T00:00:00.000Z" }], events: [], audit: []
    }, null, 2), "utf8");

    const app = await loadApp(stateFile);
    const response = await app.request("/api/runs/run_demo/retry-step", { method: "POST", headers: { "content-type": "application/json" } });
    const payload = await response.json() as { run: { status: string }; approval?: { status: string; resolved_by?: string } };

    expect(response.status).toBe(200);
    expect(payload.run.status).toBe("running");
    expect(payload.approval).toMatchObject({ status: "rejected", resolved_by: "operator" });

    const approvals = await (await app.request("/api/approvals")).json() as { approvals: Array<{ approval_id: string; status: string }> };
    expect(approvals.approvals.find((item) => item.approval_id === "approval_demo")?.status).toBe("rejected");
  });
});
