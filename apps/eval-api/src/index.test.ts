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
});
