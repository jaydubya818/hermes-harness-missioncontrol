import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadApp(stateFile?: string) {
  vi.resetModules();
  process.env.VITEST = "1";
  process.env.EVAL_STATE_FILE = stateFile ?? join(mkdtempSync(join(tmpdir(), "eval-state-")), "state.json");
  const module = await import("./index.js");
  return module.app;
}

describe("eval-api", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.EVAL_STATE_FILE;
    delete process.env.HARNESS_OPERATOR_TOKEN;
    delete process.env.CORS_ALLOWED_ORIGINS;
    process.env.VITEST = "1";
  });

  it("assigns eval ids and supports filtered paginated reads", async () => {
    const app = await loadApp();

    const first = await app.request("/api/evals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mission_id: "mis_demo", run_id: "run_a", outcome: "success", cost_usd: 0.1, approval_count: 0, artifact_count: 2, created_at: "2026-04-18T19:00:00.000Z" })
    });
    const second = await app.request("/api/evals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mission_id: "mis_demo", run_id: "run_b", outcome: "failure", cost_usd: 0.2, approval_count: 1, artifact_count: 1, created_at: "2026-04-18T19:05:00.000Z" })
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const listing = await app.request("/api/evals?mission_id=mis_demo&run_id=run_b&limit=1&offset=0");
    const payload = await listing.json() as {
      records: Array<{ eval_id?: string; run_id: string }>;
      pagination: { total: number; limit: number; offset: number; has_more: boolean };
      summary: { total_runs: number; failure_rate: number };
    };

    expect(listing.status).toBe(200);
    expect(payload.records).toHaveLength(1);
    expect(payload.records[0]).toMatchObject({ run_id: "run_b" });
    expect(payload.records[0]?.eval_id).toMatch(/^eval_/);
    expect(payload.pagination).toEqual({ total: 1, limit: 1, offset: 0, has_more: false });
    expect(payload.summary).toMatchObject({ total_runs: 1, failure_rate: 1 });
  });

  it("returns newest records first when order=desc is requested", async () => {
    const app = await loadApp();
    for (const runId of ["run_a", "run_b", "run_c"]) {
      const created = await app.request("/api/evals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mission_id: "mis_demo", run_id: runId, outcome: "success", cost_usd: 0.1, approval_count: 0, artifact_count: 0, created_at: new Date().toISOString() })
      });
      expect(created.status).toBe(201);
    }

    const listing = await app.request("/api/evals?order=desc&limit=2");
    const payload = await listing.json() as { records: Array<{ run_id: string }>; pagination: { total: number; has_more: boolean } };
    expect(listing.status).toBe(200);
    expect(payload.records.map((record) => record.run_id)).toEqual(["run_c", "run_b"]);
    expect(payload.pagination).toMatchObject({ total: 3, has_more: true });
  });

  it("rejects eval records with missing or invalid fields", async () => {
    const app = await loadApp();

    const missingIds = await app.request("/api/evals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "success", cost_usd: 0.1 })
    });
    expect(missingIds.status).toBe(400);

    const badOutcome = await app.request("/api/evals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mission_id: "mis_demo", run_id: "run_a", outcome: "great", cost_usd: 0.1 })
    });
    expect(badOutcome.status).toBe(400);

    const badCost = await app.request("/api/evals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mission_id: "mis_demo", run_id: "run_a", outcome: "success" })
    });
    expect(badCost.status).toBe(400);

    const listing = await app.request("/api/evals");
    const payload = await listing.json() as { pagination: { total: number }; summary: { total_cost_usd: number } };
    expect(payload.pagination.total).toBe(0);
    expect(Number.isFinite(payload.summary.total_cost_usd)).toBe(true);
  });

  it("validates created_at and stamps receipt time when it is omitted", async () => {
    const app = await loadApp();

    const badCreatedAt = await app.request("/api/evals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mission_id: "mis_demo", run_id: "run_a", outcome: "success", cost_usd: 0.1, created_at: "not-a-date" })
    });
    expect(badCreatedAt.status).toBe(400);

    const omitted = await app.request("/api/evals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mission_id: "mis_demo", run_id: "run_a", outcome: "success", cost_usd: 0.1 })
    });
    expect(omitted.status).toBe(201);
    const payload = await omitted.json() as { record: { created_at?: string } };
    expect(typeof payload.record.created_at).toBe("string");
    expect(Number.isNaN(Date.parse(payload.record.created_at!))).toBe(false);
  });

  it("rejects non-string ids so records stay addressable by GET /api/evals/:id", async () => {
    const app = await loadApp();
    const numericEvalId = await app.request("/api/evals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eval_id: 42, mission_id: "mis_a", run_id: "run_a", outcome: "success", cost_usd: 1 })
    });
    expect(numericEvalId.status).toBe(400);

    const numericMissionId = await app.request("/api/evals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mission_id: 7, run_id: "run_a", outcome: "success", cost_usd: 1 })
    });
    expect(numericMissionId.status).toBe(400);
  });

  it("returns 400 for malformed JSON bodies and caps page size at 100", async () => {
    const app = await loadApp();

    const malformed = await app.request("/api/evals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json"
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid JSON body" });

    const listing = await app.request("/api/evals?limit=99999");
    const payload = await listing.json() as { pagination: { limit: number } };
    expect(payload.pagination.limit).toBe(100);
  });

  it("returns eval detail by id", async () => {
    const app = await loadApp();

    const create = await app.request("/api/evals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mission_id: "mis_demo", run_id: "run_detail", outcome: "success", cost_usd: 0.1, approval_count: 0, artifact_count: 2, created_at: "2026-04-18T19:00:00.000Z" })
    });
    const created = await create.json() as { record?: { eval_id?: string } };

    const detail = await app.request(`/api/evals/${created.record?.eval_id}`);
    const payload = await detail.json() as { record?: { eval_id?: string; run_id: string } };

    expect(detail.status).toBe(200);
    expect(payload.record).toMatchObject({ eval_id: created.record?.eval_id, run_id: "run_detail" });
  });

  it("tolerates a state file with the wrong JSON shape instead of failing every request", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stateFile = join(mkdtempSync(join(tmpdir(), "eval-state-bad-")), "state.json");
    writeFileSync(stateFile, JSON.stringify({ records: [] }), "utf8");

    const app = await loadApp(stateFile);
    const listing = await app.request("/api/evals");
    const payload = await listing.json() as { pagination: { total: number } };

    expect(listing.status).toBe(200);
    expect(payload.pagination.total).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it("deduplicates replayed submissions that carry an eval_id", async () => {
    const app = await loadApp();
    const record = { eval_id: "eval_replayed", mission_id: "mis_demo", run_id: "run_dup", outcome: "success", cost_usd: 0.1, approval_count: 0, artifact_count: 1, created_at: "2026-04-18T19:00:00.000Z" };

    const first = await app.request("/api/evals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(record)
    });
    expect(first.status).toBe(201);

    const replay = await app.request("/api/evals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...record, cost_usd: 99 })
    });
    const replayPayload = await replay.json() as { record?: { eval_id?: string; cost_usd?: number } };
    expect(replay.status).toBe(200);
    expect(replayPayload.record).toMatchObject({ eval_id: "eval_replayed", cost_usd: 0.1 });

    const listing = await app.request("/api/evals");
    const payload = await listing.json() as { pagination: { total: number } };
    expect(payload.pagination.total).toBe(1);
  });

  it("enforces the operator token on mutating requests when configured", async () => {
    process.env.HARNESS_OPERATOR_TOKEN = "secret-token";
    const app = await loadApp();
    const record = { mission_id: "mis_demo", run_id: "run_auth", outcome: "success", cost_usd: 0.1, approval_count: 0, artifact_count: 1, created_at: "2026-04-18T19:00:00.000Z" };

    const missing = await app.request("/api/evals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(record)
    });
    expect(missing.status).toBe(401);

    const wrong = await app.request("/api/evals", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret-tokem" },
      body: JSON.stringify(record)
    });
    expect(wrong.status).toBe(401);

    const right = await app.request("/api/evals", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret-token" },
      body: JSON.stringify(record)
    });
    expect(right.status).toBe(201);

    const readDenied = await app.request("/api/evals");
    expect(readDenied.status).toBe(401);
    const detailDenied = await app.request("/api/evals/eval_missing");
    expect(detailDenied.status).toBe(401);
    const readAllowed = await app.request("/api/evals", { headers: { authorization: "Bearer secret-token" } });
    expect(readAllowed.status).toBe(200);
    const health = await app.request("/health");
    expect(health.status).toBe(200);
  });

  it("rejects malformed scoring fields that would poison summary averages", async () => {
    const app = await loadApp();

    const stringConfidence = await app.request("/api/evals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mission_id: "mis_demo", run_id: "run_a", outcome: "success", cost_usd: 0.1, confidence: "high" })
    });
    expect(stringConfidence.status).toBe(400);

    const negativeDuration = await app.request("/api/evals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mission_id: "mis_demo", run_id: "run_a", outcome: "success", cost_usd: 0.1, duration_ms: -5 })
    });
    expect(negativeDuration.status).toBe(400);

    const valid = await app.request("/api/evals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mission_id: "mis_demo", run_id: "run_a", outcome: "success", cost_usd: 0.1, confidence: 0.9, duration_ms: 1200 })
    });
    expect(valid.status).toBe(201);

    const listing = await app.request("/api/evals");
    const payload = await listing.json() as { summary: { total_runs: number; average_confidence: number } };
    expect(payload.summary.total_runs).toBe(1);
    expect(payload.summary.average_confidence).toBe(0.9);
  });

  it("only reflects allowlisted origins in CORS headers", async () => {
    const app = await loadApp();

    const allowed = await app.request("/health", { headers: { origin: "http://localhost:5173" } });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");

    const denied = await app.request("/health", { headers: { origin: "https://evil.example" } });
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("honours CORS_ALLOWED_ORIGINS overrides", async () => {
    process.env.CORS_ALLOWED_ORIGINS = "https://console.internal.example";
    const app = await loadApp();

    const custom = await app.request("/health", { headers: { origin: "https://console.internal.example" } });
    expect(custom.headers.get("access-control-allow-origin")).toBe("https://console.internal.example");

    const defaultDev = await app.request("/health", { headers: { origin: "http://localhost:5173" } });
    expect(defaultDev.headers.get("access-control-allow-origin")).toBeNull();
  });
});
