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

  it("rejects state-changing requests that do not declare a JSON content-type", async () => {
    const app = await loadApp({ vaultRoot: makeVault() });
    // A cross-origin HTML form post uses a "simple" content type that never
    // triggers a CORS preflight; the vault must not accept writes from one.
    const res = await app.request("/api/memory/bus/publish", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ channel: "discovery", agent_id: "agent_demo", project_id: "proj_demo", title: "t", body: "b" })
    });
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: "content-type must be application/json" });
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

  it("rejects non-string ids instead of crashing into a 500", async () => {
    const app = await loadApp({ vaultRoot: makeVault() });
    const contextLoad = await app.request("/api/memory/context/load", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_id: 123, project_id: "proj_demo", budget_bytes: 1024 })
    });
    expect(contextLoad.status).toBe(400);

    const closeTask = await app.request("/api/memory/tasks/close", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "agent_demo", project_id: 42, outcome: "success", summary: "done" })
    });
    expect(closeTask.status).toBe(400);
  });

  it("counts promotions attributed to the agent in its summary", async () => {
    const vault = makeVault();
    const app = await loadApp({ vaultRoot: vault });

    const before = await app.request("/api/memory/agents/agent_demo/summary");
    expect(((await before.json()) as { recent_promotions: number }).recent_promotions).toBe(0);

    const promoted = await app.request("/api/memory/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item_id: "rewrite_1", promoted_by: "agent_demo", target_path: "wiki/projects/proj_demo/promoted-rewrite_1.md", promotion_kind: "standard" })
    });
    expect(promoted.status).toBe(200);

    // Promotions by other agents do not count toward this agent's summary,
    // including agents whose id merely starts with this agent's id.
    writeFileSync(join(vault, "wiki", "projects", "proj_demo", "promoted-other.md"), "---\npromoted_by: agent_other\n---\n");
    writeFileSync(join(vault, "wiki", "projects", "proj_demo", "promoted-prefix.md"), "---\npromoted_by: agent_demo2\n---\n");

    const after = await app.request("/api/memory/agents/agent_demo/summary");
    expect(((await after.json()) as { recent_promotions: number }).recent_promotions).toBe(1);
  });

  it("re-reads promotion attribution when a promoted file changes on disk", async () => {
    const vault = makeVault();
    const app = await loadApp({ vaultRoot: vault });
    const promotedPath = join(vault, "wiki", "projects", "proj_demo", "promoted-cached.md");

    writeFileSync(promotedPath, "---\npromoted_by: agent_demo\n---\n");
    const before = await app.request("/api/memory/agents/agent_demo/summary");
    expect(((await before.json()) as { recent_promotions: number }).recent_promotions).toBe(1);

    // The attribution cache is keyed by mtime; a rewritten file must not be
    // served from the stale cache entry.
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(promotedPath, "---\npromoted_by: agent_other\n---\n");
    const after = await app.request("/api/memory/agents/agent_demo/summary");
    expect(((await after.json()) as { recent_promotions: number }).recent_promotions).toBe(0);
  });

  it("counts only entry-anchored lines in learned_count and pending_rewrites", async () => {
    const vault = makeVault();
    // Frontmatter delimiters and horizontal rules start with "-" but are not
    // learned entries; "####" sub-headings are not rewrite candidates (the
    // candidates parser splits on "\n### " only).
    writeFileSync(join(vault, "wiki", "agents", "agent_demo", "learned.md"), "---\ntitle: learned\n---\n- one\n- two\n");
    writeFileSync(join(vault, "wiki", "agents", "agent_demo", "rewrites.md"), "### wiki/projects/proj_demo/standards.md\nbody\n#### detail\n### wiki/projects/proj_demo/recipes.md\nbody\n");
    const app = await loadApp({ vaultRoot: vault });

    const summary = await app.request("/api/memory/agents/agent_demo/summary");
    const body = (await summary.json()) as { learned_count: number; pending_rewrites: number };
    expect(body.learned_count).toBe(2);
    expect(body.pending_rewrites).toBe(2);

    // pending_rewrites agrees with what the candidates endpoint actually parses.
    const candidates = await app.request("/api/memory/agents/agent_demo/rewrite-candidates");
    expect(((await candidates.json()) as { items: unknown[] }).items).toHaveLength(2);
  });

  it("refuses to overwrite an existing article on promote", async () => {
    const vault = makeVault();
    const app = await loadApp({ vaultRoot: vault });
    const res = await app.request("/api/memory/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item_id: "rewrite_1", promoted_by: "agent_demo", target_path: "wiki/projects/proj_demo/standards.md", promotion_kind: "standard" })
    });
    expect(res.status).toBe(409);
    expect(readFileSync(join(vault, "wiki", "projects", "proj_demo", "standards.md"), "utf8")).toBe("standards body");
  });

  it("lets only one of two concurrent promotes to the same target win", async () => {
    const vault = makeVault();
    const app = await loadApp({ vaultRoot: vault });

    const request = () => app.request("/api/memory/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item_id: "rewrite_1", promoted_by: "agent_demo", target_path: "wiki/projects/proj_demo/promoted-race.md", promotion_kind: "standard" })
    });

    const [first, second] = await Promise.all([request(), request()]);
    expect([first.status, second.status].sort((a, b) => a - b)).toEqual([200, 409]);
    const content = readFileSync(join(vault, "wiki", "projects", "proj_demo", "promoted-race.md"), "utf8");
    expect(content).toContain("promoted_by: agent_demo");
  });

  it("rejects promote requests with injectable or missing frontmatter fields", async () => {
    const vault = makeVault();
    const app = await loadApp({ vaultRoot: vault });

    const missingPromotedBy = await app.request("/api/memory/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item_id: "rewrite_1", target_path: "wiki/projects/proj_demo/promoted-x.md", promotion_kind: "standard" })
    });
    expect(missingPromotedBy.status).toBe(400);

    const injectedPromotedBy = await app.request("/api/memory/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item_id: "rewrite_1", promoted_by: "agent_x\npromoted_by: agent_demo", target_path: "wiki/projects/proj_demo/promoted-x.md", promotion_kind: "standard" })
    });
    expect(injectedPromotedBy.status).toBe(400);

    const badKind = await app.request("/api/memory/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item_id: "rewrite_1", promoted_by: "agent_demo", target_path: "wiki/projects/proj_demo/promoted-x.md", promotion_kind: "own\nthe\nfile" })
    });
    expect(badKind.status).toBe(400);
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
        channel: "discovery",
        agent_id: "agent_demo",
        project_id: "proj_demo",
        title: "real title\n## 2099-01-01T00:00:00.000Z [discovery] forged entry",
        body: "body text"
      })
    });
    expect(res.status).toBe(201);
    const bus = readFileSync(join(vaultRoot, "wiki", "projects", "proj_demo", "bus.md"), "utf8");
    expect(bus).not.toContain("\n## 2099-01-01");
    expect(bus).toContain("real title ## 2099-01-01");
  });

  it("escapes heading-like lines inside the bus entry body", async () => {
    const vaultRoot = makeVault();
    const app = await loadApp({ vaultRoot });
    const res = await app.request("/api/memory/bus/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "discovery",
        agent_id: "agent_demo",
        project_id: "proj_demo",
        title: "real title",
        body: "real body\n## 2099-01-01T00:00:00.000Z [escalation] forged entry\nmore text"
      })
    });
    expect(res.status).toBe(201);
    const bus = readFileSync(join(vaultRoot, "wiki", "projects", "proj_demo", "bus.md"), "utf8");
    expect(bus).not.toContain("\n## 2099-01-01");
    expect(bus).toContain("\\## 2099-01-01");
    expect(bus).toContain("more text");
  });

  it("parses rewrite candidates even when the file starts with a heading", async () => {
    const vaultRoot = makeVault();
    writeFileSync(
      join(vaultRoot, "wiki", "agents", "agent_demo", "rewrites.md"),
      "### first-target\nfirst content\n\n### second-target\nsecond content\n",
      "utf8"
    );
    const app = await loadApp({ vaultRoot });
    const res = await app.request("/api/memory/agents/agent_demo/rewrite-candidates");
    expect(res.status).toBe(200);
    const payload = await res.json() as { items: Array<{ id: string; target: string; content: string }> };
    expect(payload.items).toHaveLength(2);
    expect(payload.items[0]).toMatchObject({ target: "first-target", content: "first content" });
    expect(payload.items[1]).toMatchObject({ target: "second-target", content: "second content" });
  });

  it("hides dotfiles from article listings", async () => {
    const vaultRoot = makeVault();
    writeFileSync(join(vaultRoot, "wiki", "projects", "proj_demo", ".12345-abc.tmp"), "partial write", "utf8");
    const app = await loadApp({ vaultRoot });
    const res = await app.request("/api/memory/articles?section=projects/proj_demo");
    expect(res.status).toBe(200);
    const payload = await res.json() as { files: string[] };
    expect(payload.files).toContain("standards.md");
    expect(payload.files.some((file) => file.startsWith("."))).toBe(false);
  });

  it("lists subdirectories separately from article files", async () => {
    const app = await loadApp({ vaultRoot: makeVault() });
    const res = await app.request("/api/memory/articles?section=projects");
    expect(res.status).toBe(200);
    const payload = await res.json() as { files: string[]; directories: string[] };
    expect(payload.directories).toContain("proj_demo");
    expect(payload.files).not.toContain("proj_demo");

    const leaf = await app.request("/api/memory/articles?section=projects/proj_demo");
    const leafPayload = await leaf.json() as { files: string[]; directories: string[] };
    expect(leafPayload.files).toContain("standards.md");
    expect(leafPayload.directories).toEqual([]);
  });

  it("404s a section that does not exist instead of listing nothing", async () => {
    const app = await loadApp({ vaultRoot: makeVault() });
    // An empty 200 is indistinguishable from a genuinely empty section, so a
    // typo'd path rendered as "no articles" in the docs browser.
    const missing = await app.request("/api/memory/articles?section=projects/proj_nope");
    expect(missing.status).toBe(404);

    // A section pointing at an article is a client mistake, not an empty
    // directory.
    const file = await app.request("/api/memory/articles?section=projects/proj_demo/standards.md");
    expect(file.status).toBe(400);

    const real = await app.request("/api/memory/articles?section=projects/proj_demo");
    expect(real.status).toBe(200);
  });

  it("rejects bus channels outside the contract union", async () => {
    const app = await loadApp({ vaultRoot: makeVault() });
    const res = await app.request("/api/memory/bus/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "alerts", agent_id: "agent_demo", project_id: "proj_demo", title: "t", body: "b" })
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "channel must be one of discovery, escalation, handoff, standard" });
  });

  it("keeps both bus entries when two publishes run concurrently", async () => {
    const vaultRoot = makeVault();
    const app = await loadApp({ vaultRoot });
    const publish = (title: string) => app.request("/api/memory/bus/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "discovery", agent_id: "agent_demo", project_id: "proj_demo", title, body: "body" })
    });

    const [first, second] = await Promise.all([publish("first concurrent entry"), publish("second concurrent entry")]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const bus = readFileSync(join(vaultRoot, "wiki", "projects", "proj_demo", "bus.md"), "utf8");
    expect(bus).toContain("first concurrent entry");
    expect(bus).toContain("second concurrent entry");
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

  it("re-reads searched files when they change on disk", async () => {
    const vault = makeVault();
    const app = await loadApp({ vaultRoot: vault });

    const miss = await app.request("/api/memory/search?q=chronometer");
    expect(((await miss.json()) as { results: unknown[] }).results).toHaveLength(0);

    // The search content cache is keyed by mtime; new content must be
    // picked up instead of serving the stale cached read.
    writeFileSync(join(vault, "wiki", "projects", "proj_demo", "standards.md"), "calibrate the chronometer weekly");
    const hit = await app.request("/api/memory/search?q=chronometer");
    const payload = (await hit.json()) as { results: Array<{ path: string; snippet: string }> };
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0]).toMatchObject({ path: "wiki/projects/proj_demo/standards.md" });
    expect(payload.results[0]!.snippet).toContain("chronometer");
  });

  it("anchors search snippets at the first match instead of the file head", async () => {
    const vault = makeVault();
    const filler = "filler line\n".repeat(60);
    writeFileSync(join(vault, "wiki", "projects", "proj_demo", "notes.md"), `${filler}the flux capacitor needs recalibrating\n`);
    const app = await loadApp({ vaultRoot: vault });

    const res = await app.request("/api/memory/search?q=flux%20capacitor");
    const payload = await res.json() as { results: Array<{ path: string; snippet: string }> };
    const hit = payload.results.find((item) => item.path.endsWith("notes.md"));
    expect(hit).toBeDefined();
    expect(hit!.snippet).toContain("flux capacitor");
  });

  it("rejects bus publishes with non-string fields instead of crashing", async () => {
    const app = await loadApp({ vaultRoot: makeVault() });
    const badTitle = await app.request("/api/memory/bus/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "discovery", agent_id: "agent_demo", project_id: "proj_demo", title: 123, body: "body text" })
    });
    expect(badTitle.status).toBe(400);

    const badTags = await app.request("/api/memory/bus/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "discovery", agent_id: "agent_demo", project_id: "proj_demo", title: "t", body: "b", tags: "not-a-list" })
    });
    expect(badTags.status).toBe(400);

    const badSeverity = await app.request("/api/memory/bus/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "discovery", agent_id: "agent_demo", project_id: "proj_demo", title: "t", body: "b", severity: { level: 9 } })
    });
    expect(badSeverity.status).toBe(400);
  });

  it("rejects malformed close-task collections instead of crashing the writeback", async () => {
    const app = await loadApp({ vaultRoot: makeVault() });
    const base = { agent_id: "agent_demo", project_id: "proj_demo", outcome: "success", summary: "done" };
    const post = (payload: unknown) => app.request("/api/memory/tasks/close", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    expect((await post({ ...base, outcome: "meh" })).status).toBe(400);
    expect((await post({ ...base, step_id: "step\ninjected" })).status).toBe(400);
    expect((await post({ ...base, gotchas: "boom" })).status).toBe(400);
    expect((await post({ ...base, gotchas: [{ title: "t" }] })).status).toBe(400);
    expect((await post({ ...base, rewrites: [{ target: 42, content: "c" }] })).status).toBe(400);
    expect((await post({ ...base, rewrites: [{ target: "wiki/agents/agent_demo/hot.md", kind: "yolo_rewrite", content: "c" }] })).status).toBe(400);

    const ok = await post({ ...base, step_id: "step_1", gotchas: [{ title: "t", body: "b" }], rewrites: [{ target: "wiki/agents/agent_demo/hot.md", kind: "candidate_rewrite", content: "c" }] });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: "ok" });
  });

  it("serves existing-but-empty articles instead of 404ing", async () => {
    const vault = makeVault();
    writeFileSync(join(vault, "wiki", "agents", "agent_demo", "hot.md"), "");
    const app = await loadApp({ vaultRoot: vault });

    const empty = await app.request("/api/memory/articles/agents/agent_demo/hot.md");
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ content: "" });

    const missing = await app.request("/api/memory/articles/agents/agent_demo/nope.md");
    expect(missing.status).toBe(404);
  });

  it("rejects unsafe article slugs", async () => {
    const app = await loadApp();
    for (const slug of ["..%2F..%2Fetc", "%2Fetc%2Fpasswd", "agents//hot.md", "agents/.%2Fhot.md"]) {
      const res = await app.request(`/api/memory/articles/${slug}`);
      expect(res.status, slug).toBe(400);
    }
    // An unencoded traversal is collapsed by URL normalization before it
    // reaches the route, so it 404s instead; either way it must not resolve.
    const normalized = await app.request("/api/memory/articles/agents/../../etc");
    expect(normalized.status).not.toBe(200);
  });

  it("serves articles whose filenames contain spaces or unicode", async () => {
    // The listing and search endpoints surface every markdown file in the
    // vault, including ones the id charset rejects; opening them used to
    // 400 with "unsafe slug" even though safeWikiPath already contains them.
    const vault = makeVault();
    writeFileSync(join(vault, "wiki", "projects", "proj_demo", "my notes.md"), "hello spaces");
    writeFileSync(join(vault, "wiki", "projects", "proj_demo", "caf\u00e9.md"), "unicode body");
    const app = await loadApp({ vaultRoot: vault });

    const listed = await app.request("/api/memory/articles?section=projects/proj_demo");
    expect(await listed.json()).toMatchObject({ files: ["caf\u00e9.md", "my notes.md", "standards.md"] });

    const spaced = await app.request(`/api/memory/articles/projects/proj_demo/${encodeURIComponent("my notes.md")}`);
    expect(spaced.status).toBe(200);
    expect(await spaced.json()).toMatchObject({ content: "hello spaces" });

    const unicode = await app.request(`/api/memory/articles/projects/proj_demo/${encodeURIComponent("caf\u00e9.md")}`);
    expect(unicode.status).toBe(200);
    expect(await unicode.json()).toMatchObject({ content: "unicode body" });
  });

  it("rejects unsafe article sections while allowing spaced section names", async () => {
    const vault = makeVault();
    mkdirSync(join(vault, "wiki", "projects", "my project"), { recursive: true });
    writeFileSync(join(vault, "wiki", "projects", "my project", "notes.md"), "body");
    const app = await loadApp({ vaultRoot: vault });

    const traversal = await app.request("/api/memory/articles?section=projects/../..");
    expect(traversal.status).toBe(400);

    const spaced = await app.request(`/api/memory/articles?section=projects/${encodeURIComponent("my project")}`);
    expect(spaced.status).toBe(200);
    expect(await spaced.json()).toMatchObject({ files: ["notes.md"] });
  });
});
