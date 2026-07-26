import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadApp(options: { vaultRoot?: string; operatorToken?: string } = {}) {
  vi.resetModules();
  process.env.VITEST = "1";
  process.env.HARNESS_VAULT_ROOT = options.vaultRoot ?? mkdtempSync(join(tmpdir(), "memory-vault-"));
  if (options.operatorToken) process.env.HARNESS_OPERATOR_TOKEN = options.operatorToken;
  else delete process.env.HARNESS_OPERATOR_TOKEN;
  const module = await import("./index.js");
  return module.app;
}

function makeVault() {
  const root = mkdtempSync(join(tmpdir(), "memory-vault-"));
  mkdirSync(join(root, "wiki", "agents", "agent_demo"), { recursive: true });
  mkdirSync(join(root, "wiki", "projects", "proj_demo"), { recursive: true });
  writeFileSync(join(root, "wiki", "agents", "agent_demo", "profile.md"), "profile body");
  writeFileSync(join(root, "wiki", "agents", "agent_demo", "learned.md"), "- one\n- two\n");
  writeFileSync(join(root, "wiki", "projects", "proj_demo", "standards.md"), "standards body");
  return root;
}

describe("memory-api", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.HARNESS_VAULT_ROOT;
    delete process.env.HARNESS_OPERATOR_TOKEN;
    process.env.VITEST = "1";
  });

  it("reports health", async () => {
    const app = await loadApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: "memory-api" });
  });

  it("rejects malformed JSON bodies with 400", async () => {
    const app = await loadApp();
    const res = await app.request("/api/memory/context/load", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json"
    });
    expect(res.status).toBe(400);
  });

  it("rejects non-numeric budget_bytes instead of disabling the budget", async () => {
    const app = await loadApp();
    const res = await app.request("/api/memory/context/load", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "agent_demo", project_id: "proj_demo", budget_bytes: "lots" })
    });
    expect(res.status).toBe(400);
  });

  it("rejects traversal ids", async () => {
    const app = await loadApp();
    const res = await app.request("/api/memory/context/load", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "../etc", project_id: "proj_demo", budget_bytes: 1000 })
    });
    expect(res.status).toBe(400);
  });

  it("loads context bundles and enforces the byte budget", async () => {
    const app = await loadApp({ vaultRoot: makeVault() });
    const res = await app.request("/api/memory/context/load", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "agent_demo", project_id: "proj_demo", budget_bytes: 12 })
    });
    expect(res.status).toBe(200);
    const payload = await res.json() as { truncated: boolean; budget_used: number; files: unknown[] };
    expect(payload.truncated).toBe(true);
    expect(payload.budget_used).toBeLessThanOrEqual(12);
  });

  it("requires the operator token on read endpoints when configured", async () => {
    const app = await loadApp({ vaultRoot: makeVault(), operatorToken: "secret" });
    const denied = await app.request("/api/memory/agents/agent_demo/summary");
    expect(denied.status).toBe(401);
    const allowed = await app.request("/api/memory/agents/agent_demo/summary", {
      headers: { authorization: "Bearer secret" }
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ agent_id: "agent_demo", learned_count: 2 });
  });

  it("keeps bus entry headers on a single line", async () => {
    const vaultRoot = makeVault();
    const app = await loadApp({ vaultRoot });
    const res = await app.request("/api/memory/bus/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "alerts",
        agent_id: "agent_demo",
        project_id: "proj_demo",
        title: "real title\n## 2099-01-01T00:00:00.000Z [alerts] forged entry",
        body: "body text"
      })
    });
    expect(res.status).toBe(201);
    const bus = readFileSync(join(vaultRoot, "wiki", "projects", "proj_demo", "bus.md"), "utf8");
    expect(bus).not.toContain("\n## 2099-01-01");
    expect(bus).toContain("real title ## 2099-01-01");
  });

  it("finds memory for non-demo agents and projects via search", async () => {
    const root = makeVault();
    mkdirSync(join(root, "wiki", "projects", "proj_real"), { recursive: true });
    writeFileSync(join(root, "wiki", "projects", "proj_real", "standards.md"), "zebra-pattern guidance");
    const app = await loadApp({ vaultRoot: root });
    const res = await app.request("/api/memory/search?q=zebra-pattern");
    expect(res.status).toBe(200);
    const payload = await res.json() as { results: Array<{ path: string; snippet: string }> };
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0]).toMatchObject({ path: "wiki/projects/proj_real/standards.md" });
    expect(payload.results[0]!.snippet).toContain("zebra-pattern");
  });

  it("rejects bus publishes with non-string fields instead of crashing", async () => {
    const app = await loadApp({ vaultRoot: makeVault() });
    const badTitle = await app.request("/api/memory/bus/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "alerts", agent_id: "agent_demo", project_id: "proj_demo", title: 123, body: "body text" })
    });
    expect(badTitle.status).toBe(400);

    const badTags = await app.request("/api/memory/bus/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "alerts", agent_id: "agent_demo", project_id: "proj_demo", title: "t", body: "b", tags: "not-a-list" })
    });
    expect(badTags.status).toBe(400);

    const badSeverity = await app.request("/api/memory/bus/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "alerts", agent_id: "agent_demo", project_id: "proj_demo", title: "t", body: "b", severity: { level: 9 } })
    });
    expect(badSeverity.status).toBe(400);
  });

  it("rejects unsafe article slugs", async () => {
    const app = await loadApp();
    const res = await app.request("/api/memory/articles/..%2F..%2Fetc");
    expect(res.status).toBe(400);
  });
});
