import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { access, readdir, readFile, stat, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { dirname, join, resolve, relative } from "node:path";
import { loadContextBundle, closeTask, promoteLearning } from "@hermes-harness-with-missioncontrol/memory-runtime";
import type { CloseTaskRequest, ContextRequest, PromoteLearningRequest, PublishBusRequest } from "@hermes-harness-with-missioncontrol/shared-types";

const app = new Hono();
const vaultRoot = process.env.HARNESS_VAULT_ROOT ?? resolve(process.cwd(), "../../vault/agentic-kb");
const operatorToken = process.env.HARNESS_OPERATOR_TOKEN;

// The console talks to these APIs via the Vite dev proxy (same-origin), so
// cross-origin access is only needed when the console is pointed directly at
// an API URL. A wildcard here would let any web page a local browser visits
// call these endpoints; allow only the console dev origins unless overridden.
const corsOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
  .split(",").map((origin) => origin.trim()).filter(Boolean);
app.use("*", cors({ origin: corsOrigins }));

// Request bodies land in memory and, for artifacts and markdown writes, on
// disk. c.req.json() buffers whatever arrives, so a single oversized POST
// could balloon process memory (and the persisted state file) unchecked.
// Reject a body that declares more than the limit before any handler reads
// it. Set MAX_REQUEST_BODY_BYTES to 0 to disable. This trusts Content-Length:
// a chunked request that omits the header still reaches json(), so it bounds
// honest clients and accidents rather than a determined attacker that has
// already cleared the operator-token boundary.
const maxRequestBodyBytes = Number(process.env.MAX_REQUEST_BODY_BYTES ?? String(2 * 1024 * 1024));

app.use("*", async (c, next) => {
  if (Number.isFinite(maxRequestBodyBytes) && maxRequestBodyBytes > 0) {
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > maxRequestBodyBytes) {
      return c.json({ error: "request body too large" }, 413);
    }
  }
  await next();
});

// Cross-origin CSRF guard. Browsers send form and no-cors POSTs (text/plain,
// form-encoded, or no content-type at all) without a preflight, and
// c.req.json() parses whatever arrives regardless of content-type. With no
// HARNESS_OPERATOR_TOKEN configured -- the documented local default -- any
// page the operator happened to visit could therefore drive this control
// plane from their browser. application/json is not a CORS "simple" content
// type, so requiring it on state-changing requests forces a preflight, which
// the origin allowlist above governs.
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

app.use("*", async (c, next) => {
  if (MUTATING_METHODS.has(c.req.method)) {
    const mediaType = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (mediaType !== "application/json") {
      return c.json({ error: "content-type must be application/json" }, 415);
    }
  }
  await next();
});



function isSafeId(value: unknown): value is string {
  // The regex would coerce non-strings (isSafeId(5) tests "5"), letting a
  // numeric agent_id/project_id through to path joins that then 500.
  if (typeof value !== "string") return false;
  return /^[a-zA-Z0-9_\-./]+$/.test(value) && !value.includes("..") && !value.startsWith("/");
}

function requireOperator(c: any) {
  if (!operatorToken) return null;
  const auth = Buffer.from(c.req.header("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${operatorToken}`);
  if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return c.json({ error: "unauthorized" }, 401);
  return null;
}

async function parseJsonBody<T>(c: any): Promise<T | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" ? (body as T) : null;
  } catch {
    return null;
  }
}

function safeWikiPath(...parts: string[]) {
  const root = resolve(join(vaultRoot, "wiki"));
  const full = resolve(join(root, ...parts));
  const rel = relative(root, full);
  if (rel.startsWith("..")) throw new Error("path escapes wiki root");
  return full;
}

async function listDir(path: string) {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

async function listDirEntries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readText(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function writeTextAtomically(path: string, content: string) {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, path);
  } catch (error) {
    // Do not leave orphaned .tmp files in the wiki when the write fails.
    await rm(tmp, { force: true });
    throw error;
  }
}

async function listProjectFiles(projectId: string) {
  return listDir(safeWikiPath("projects", projectId));
}

// Promotions land as promoted-*.md files under project wikis with a
// `promoted_by:` frontmatter line; count the ones attributed to this agent.
const PROMOTION_SCAN_MAX_FILES = 500;

// The console polls agent summaries every few seconds and each poll used to
// re-read every promoted file. Promotions are effectively write-once (the
// promote endpoint refuses to overwrite), so cache each file's attribution
// keyed by mtime and only re-read files that actually changed.
const promotionAttributionCache = new Map<string, { mtimeMs: number; promotedBy: string | null }>();

async function readPromotedBy(path: string): Promise<string | null> {
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    promotionAttributionCache.delete(path);
    return null;
  }
  const cached = promotionAttributionCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached.promotedBy;
  const content = await readText(path);
  // Line-anchored match: matching anywhere in the line would credit agent_1
  // with promotions made by agent_10.
  const line = content?.split("\n").map((item) => item.trim()).find((item) => item.startsWith("promoted_by: "));
  const promotedBy = line ? line.slice("promoted_by: ".length) : null;
  promotionAttributionCache.set(path, { mtimeMs, promotedBy });
  return promotedBy;
}

async function countAgentPromotions(agentId: string) {
  const projectsRoot = safeWikiPath("projects");
  let scanned = 0;
  let count = 0;
  for (const project of await listDir(projectsRoot)) {
    for (const file of await listDir(join(projectsRoot, project))) {
      if (!file.startsWith("promoted-") || !file.endsWith(".md")) continue;
      if (scanned >= PROMOTION_SCAN_MAX_FILES) return count;
      scanned += 1;
      if (await readPromotedBy(join(projectsRoot, project, file)) === agentId) count += 1;
    }
  }
  return count;
}

app.get("/health", (c) => c.json({ ok: true, service: "memory-api" }));

app.post("/api/memory/context/load", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  const body = await parseJsonBody<ContextRequest>(c);
  if (!body) return c.json({ error: "invalid JSON body" }, 400);
  if (!body.agent_id || !body.project_id) return c.json({ error: "agent_id, project_id, budget_bytes required" }, 400);
  if (typeof body.budget_bytes !== "number" || !Number.isFinite(body.budget_bytes) || body.budget_bytes <= 0) {
    return c.json({ error: "budget_bytes must be a positive number" }, 400);
  }
  if (!isSafeId(body.agent_id) || !isSafeId(body.project_id)) return c.json({ error: "unsafe id" }, 400);
  const result = await loadContextBundle(vaultRoot, body);
  return c.json(result);
});

app.post("/api/memory/tasks/close", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  const body = await parseJsonBody<CloseTaskRequest>(c);
  if (!body) return c.json({ error: "invalid JSON body" }, 400);
  if (!body.agent_id || !body.project_id || !body.outcome || !body.summary) return c.json({ error: "agent_id, project_id, outcome, summary required" }, 400);
  if (!isSafeId(body.agent_id) || !isSafeId(body.project_id)) return c.json({ error: "unsafe id" }, 400);
  if (!["success", "failure", "partial"].includes(body.outcome)) {
    return c.json({ error: "outcome must be one of success, failure, partial" }, 400);
  }
  if (typeof body.summary !== "string") return c.json({ error: "summary must be a string" }, 400);
  // step_id is interpolated into a task-log markdown heading; a newline there
  // injects arbitrary headings into the agent's task log.
  if (body.step_id !== undefined && (typeof body.step_id !== "string" || !isSafeId(body.step_id))) {
    return c.json({ error: "unsafe step_id" }, 400);
  }
  // The writeback iterates these collections with .map; a non-array value (or
  // non-string note fields) would crash the handler into a 500 mid-write.
  for (const field of ["discoveries", "gotchas"] as const) {
    const notes = body[field];
    if (notes === undefined) continue;
    if (!Array.isArray(notes) || notes.some((note) => !note || typeof note !== "object" || typeof note.title !== "string" || typeof note.body !== "string")) {
      return c.json({ error: `${field} must be an array of { title, body } string pairs` }, 400);
    }
  }
  if (body.rewrites !== undefined && (!Array.isArray(body.rewrites) || body.rewrites.some((rewrite) => !rewrite || typeof rewrite !== "object" || typeof rewrite.target !== "string" || typeof rewrite.content !== "string"))) {
    return c.json({ error: "rewrites must be an array of { target, content } string pairs" }, 400);
  }
  // kind is a closed union in the RewriteProposal contract.
  if (Array.isArray(body.rewrites) && body.rewrites.some((rewrite) => !["candidate_rewrite", "standard_update"].includes(rewrite.kind))) {
    return c.json({ error: "rewrite kind must be one of candidate_rewrite, standard_update" }, 400);
  }
  const result = await closeTask(vaultRoot, body);
  return c.json(result);
});

app.post("/api/memory/promote", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  const body = await parseJsonBody<PromoteLearningRequest>(c);
  if (!body) return c.json({ error: "invalid JSON body" }, 400);
  if (!body.item_id || !body.target_path || !body.promotion_kind) return c.json({ error: "item_id, target_path, promotion_kind required" }, 400);
  // item_id, promoted_by and promotion_kind are interpolated into the
  // promoted file's frontmatter; a newline there injects arbitrary
  // frontmatter lines, and a missing promoted_by writes "undefined" and
  // breaks promotion attribution in agent summaries.
  if (typeof body.item_id !== "string" || !isSafeId(body.item_id)) return c.json({ error: "unsafe item_id" }, 400);
  if (typeof body.promoted_by !== "string" || !isSafeId(body.promoted_by)) return c.json({ error: "promoted_by must be a safe agent id" }, 400);
  if (!["standard", "recipe", "project_note"].includes(body.promotion_kind)) {
    return c.json({ error: "promotion_kind must be one of standard, recipe, project_note" }, 400);
  }
  if (typeof body.target_path !== "string" || !isSafeId(body.target_path)) return c.json({ error: "unsafe target_path" }, 400);
  // promoteLearning replaces the whole target file, so a promote aimed at an
  // existing article (standards.md, another promotion, an agent's task log)
  // would destroy its content. Promotions only ever create new artifacts.
  // The existence check and the write run inside a serialized queue: two
  // concurrent promotes to the same target would otherwise both pass the
  // check before either writes, and the loser would silently overwrite the
  // winner.
  const promote = promotionQueue.then(async () => {
    try {
      await access(resolve(join(vaultRoot, body.target_path)));
      return null;
    } catch {
      // target does not exist: safe to create
    }
    return promoteLearning(vaultRoot, body);
  });
  promotionQueue = promote.catch(() => undefined);
  const result = await promote;
  if (result === null) return c.json({ error: "target_path already exists; promotions must not overwrite existing articles" }, 409);
  return c.json(result);
});

let busPublishQueue: Promise<unknown> = Promise.resolve();
let promotionQueue: Promise<unknown> = Promise.resolve();

app.post("/api/memory/bus/publish", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  const body = await parseJsonBody<PublishBusRequest>(c);
  if (!body) return c.json({ error: "invalid JSON body" }, 400);
  // These fields are interpolated into markdown below; a non-string value
  // (or a non-array tags field) would crash the handler into a 500.
  for (const field of ["channel", "agent_id", "project_id", "title", "body"] as const) {
    if (typeof body[field] !== "string" || !body[field].trim()) {
      return c.json({ error: "channel, agent_id, project_id, title, body must be non-empty strings" }, 400);
    }
  }
  // Channel is a closed union in the PublishBusRequest contract; junk values
  // would land in bus.md headings and break consumers filtering by channel.
  if (!["discovery", "escalation", "handoff", "standard"].includes(body.channel)) {
    return c.json({ error: "channel must be one of discovery, escalation, handoff, standard" }, 400);
  }
  if (body.severity !== undefined && typeof body.severity !== "string") return c.json({ error: "severity must be a string" }, 400);
  if (body.tags !== undefined && (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== "string"))) {
    return c.json({ error: "tags must be an array of strings" }, 400);
  }
  if (!isSafeId(body.agent_id) || !isSafeId(body.project_id)) return c.json({ error: "unsafe id" }, 400);
  const busPath = safeWikiPath("projects", body.project_id, "bus.md");
  const inline = (value: string) => value.replace(/[\r\n]+/g, " ").trim();
  // Bus entries are bounded by "## " headings; escape heading-like lines in
  // the free-text body so a publish cannot forge extra bus entries.
  const escapeHeadingLines = (value: string) => value.replace(/^(#{2,6} )/gm, "\\$1");
  const entry = `\n## ${new Date().toISOString()} [${inline(body.channel)}] ${inline(body.title)}\nAgent: ${body.agent_id}\nSeverity: ${inline(body.severity ?? "n/a")}\nTags: ${(body.tags ?? []).map(inline).join(", ")}\n\n${escapeHeadingLines(body.body)}\n`;
  // Appending is read-modify-write; two concurrent publishes that both read
  // before either commits would drop one entry, so appends are serialized.
  const publish = busPublishQueue.then(async () => {
    const existing = (await readText(busPath)) ?? "";
    await writeTextAtomically(busPath, `${existing}${entry}`);
  });
  busPublishQueue = publish.catch(() => undefined);
  await publish;
  return c.json({ ok: true, path: `wiki/projects/${body.project_id}/bus.md` }, 201);
});

app.get("/api/memory/agents/:id/summary", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  const agentId = c.req.param("id");
  if (!isSafeId(agentId)) return c.json({ error: "unsafe id" }, 400);
  const learned = await readText(safeWikiPath("agents", agentId, "learned.md"));
  const rewrites = await readText(safeWikiPath("agents", agentId, "rewrites.md"));
  return c.json({
    agent_id: agentId,
    profile_path: `wiki/agents/${agentId}/profile.md`,
    hot_path: `wiki/agents/${agentId}/hot.md`,
    working_path: `wiki/agents/${agentId}/task-log.md`,
    // Anchor on "- " / "### " entry markers: a bare startsWith("-") also
    // counts frontmatter/horizontal-rule "---" lines, and startsWith("###")
    // counts "####" sub-headings that the rewrite-candidates parser (which
    // splits on "\n### ") does not treat as candidates.
    learned_count: learned ? learned.split("\n").filter((line) => line.trim().startsWith("- ")).length : 0,
    pending_rewrites: rewrites ? rewrites.split("\n").filter((line) => /^### /.test(line.trim())).length : 0,
    recent_promotions: await countAgentPromotions(agentId)
  });
});

app.get("/api/memory/agents/:id/rewrite-candidates", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  const agentId = c.req.param("id");
  if (!isSafeId(agentId)) return c.json({ error: "unsafe id" }, 400);
  const rewrites = await readText(safeWikiPath("agents", agentId, "rewrites.md"));
  const items = (rewrites ?? "")
    .split("\n### ")
    .map((chunk) => chunk.trim())
    // When the file starts with a heading at position 0 (hand-edited files
    // have no leading newline), the first chunk keeps its "### " prefix;
    // strip it so the target parses consistently.
    .map((chunk) => chunk.startsWith("### ") ? chunk.slice(4) : chunk)
    .filter(Boolean)
    .map((chunk, index) => {
      const [target, ...rest] = chunk.split("\n");
      return { id: `rewrite_${index + 1}`, target, content: rest.join("\n").trim() };
    });
  return c.json({ agent_id: agentId, items });
});

app.get("/api/memory/projects/:id/summary", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  const projectId = c.req.param("id");
  if (!isSafeId(projectId)) return c.json({ error: "unsafe id" }, 400);
  const files = await listProjectFiles(projectId);
  return c.json({
    project_id: projectId,
    standards: files.filter((file) => file.includes("standards") || file.startsWith("promoted-")),
    active_rewrites: [],
    recent_postmortems: files.filter((file) => file.includes("postmortem")),
    recipes: files.filter((file) => file.includes("recipe") || file.includes("recipes")),
    promoted: files.filter((file) => file.startsWith("promoted-"))
  });
});

// Search walks the whole wiki (bounded) instead of a hardcoded demo file
// list, so memory written for non-demo agents/projects is discoverable.
const SEARCH_MAX_FILES = 200;
const SEARCH_MAX_RESULTS = 20;

// The console polls search every few seconds and each poll used to re-read
// (and lowercase) every markdown file in the corpus. Wiki files change
// rarely; cache each file's content keyed by mtime, mirroring the promotion
// attribution cache above.
const searchContentCache = new Map<string, { mtimeMs: number; content: string; lower: string }>();

async function readSearchText(path: string) {
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    searchContentCache.delete(path);
    return null;
  }
  const cached = searchContentCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached;
  const content = await readText(path);
  if (content === null) {
    searchContentCache.delete(path);
    return null;
  }
  // Scans are capped at SEARCH_MAX_FILES, but renamed/deleted files outside
  // the scanned window are never re-stat'ed; bound the cache so churn cannot
  // grow it without limit.
  if (searchContentCache.size >= SEARCH_MAX_FILES * 4) searchContentCache.clear();
  const entry = { mtimeMs, content, lower: content.toLowerCase() };
  searchContentCache.set(path, entry);
  return entry;
}

async function listWikiMarkdownFiles(root: string) {
  const results: string[] = [];
  const queue: string[] = [""];
  while (queue.length > 0 && results.length < SEARCH_MAX_FILES) {
    const relDir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(join(root, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) queue.push(rel);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(rel);
        if (results.length >= SEARCH_MAX_FILES) break;
      }
    }
  }
  return results.sort();
}

app.get("/api/memory/search", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  const query = (c.req.query("q") ?? "").toLowerCase();
  const wikiRoot = safeWikiPath();
  const files = await listWikiMarkdownFiles(wikiRoot);
  const results = [] as Array<{ path: string; snippet: string }>;
  for (const rel of files) {
    if (results.length >= SEARCH_MAX_RESULTS) break;
    const path = `wiki/${rel}`;
    const entry = await readSearchText(join(wikiRoot, rel));
    if (!entry || !entry.content) continue;
    const matchIndex = query ? entry.lower.indexOf(query) : -1;
    if (query && matchIndex === -1 && !path.toLowerCase().includes(query)) continue;
    // Anchor the snippet at the first content match so the result shows why
    // the file matched instead of always echoing its first 240 characters.
    const start = matchIndex > 60 ? matchIndex - 60 : 0;
    results.push({ path, snippet: entry.content.slice(start, start + 240) });
  }
  return c.json({ query, results });
});

app.get("/api/memory/articles", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  const section = c.req.query("section");
  if (section && !isSafeId(section)) return c.json({ error: "unsafe section" }, 400);
  try {
    const base = section ? safeWikiPath(...section.split("/")) : safeWikiPath();
    // Hide dotfiles (in-flight atomic-write temp files, editor droppings)
    // from the docs browser, matching what search indexes. Subdirectories
    // are listed separately: they are sections to descend into, not
    // articles, and treating them as articles 404s in the docs browser.
    const entries = (await listDirEntries(base)).filter((entry) => !entry.name.startsWith("."));
    return c.json({
      section: section ?? "root",
      files: entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort(),
      directories: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    });
  } catch (error) {
    return c.json({ error: String(error) }, 400);
  }
});

app.get("/api/memory/articles/:slug{.+}", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  const slug = c.req.param("slug");
  if (!isSafeId(slug)) return c.json({ error: "unsafe slug" }, 400);
  try {
    const fullPath = safeWikiPath(...slug.split("/"));
    const content = await readText(fullPath);
    // readText yields null only when the file is unreadable; an existing but
    // empty article must not 404.
    if (content === null) return c.json({ slug, content: "Not found" }, 404);
    return c.json({ slug, content });
  } catch (error) {
    return c.json({ error: String(error) }, 400);
  }
});

if (!process.env.VITEST) {
  const port = Number(process.env.PORT ?? 4301);
  // @hono/node-server binds 0.0.0.0 when no hostname is given, silently
  // exposing this operator-trust API to the local network. Default to
  // loopback; set HOST explicitly to opt into wider exposure.
  const hostname = process.env.HOST ?? "127.0.0.1";
  serve({ fetch: app.fetch, port, hostname });
  console.log(`memory-api listening on http://${hostname}:${port}`);
}

export { app };
