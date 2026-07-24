import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
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
  });
});
