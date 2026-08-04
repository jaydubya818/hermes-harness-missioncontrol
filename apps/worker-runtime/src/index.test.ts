import { afterEach, describe, expect, it } from "vitest";
import { access, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { app, assertAllowedRepoWrite, assertSafeRepoPath, bootstrapWorkspaceDependencies, cleanupRun, detectTestCommand, ensureWorkspace } from "./index.js";

// Keep in sync with the ALLOWED_REPO_ROOT default in vitest.config.ts.
const allowedRepoRoot = resolve(process.env.ALLOWED_REPO_ROOT ?? "/Users/jaywest/projects");
const sandboxRoot = join(allowedRepoRoot, "hermes-worker-runtime-test");

function buildEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    worktree_path: join(process.cwd(), "../../data/worktrees/run_contracts"),
    workspace_root: allowedRepoRoot,
    repo_scope: {
      root_path: allowedRepoRoot,
      writable_paths: ["Hermes-harness-with-missioncontrol"]
    },
    allowed_tools: ["filesystem", "git", "process"],
    allowed_actions: ["plan", "read_repo"],
    approval_mode: "on_policy_trigger",
    timeout_seconds: 30,
    resource_budget: {
      token_budget: 1000,
      max_artifacts: 5,
      max_output_bytes: 1024 * 1024
    },
    output_dir: join(process.cwd(), "../../data/worker-runs/run_contracts/step_plan"),
    environment_classification: "sandbox",
    ...overrides
  };
}

afterEach(async () => {
  await rm(sandboxRoot, { recursive: true, force: true });
});

describe("worker-runtime", () => {
  it("returns contract-shaped step events for execute-step", async () => {
    const response = await app.request("/api/execute-step", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mission_id: "mis_contracts",
        run_id: "run_contracts",
        step_id: "step_plan",
        execution_id: "exec_contracts",
        kind: "plan",
        envelope: buildEnvelope()
      })
    });

    const payload = await response.json() as {
      step_events?: Array<{ type: string; source: string; mission_id: string; run_id: string; step_id: string; execution_id: string }>;
    };

    expect(response.status).toBe(200);
    expect(payload.step_events?.[0]).toMatchObject({
      type: "step.started",
      source: "hermes",
      mission_id: "mis_contracts",
      run_id: "run_contracts",
      step_id: "step_plan",
      execution_id: "exec_contracts"
    });
    expect(payload.step_events?.some((event) => event.type === "tool.started")).toBe(true);
    expect(payload.step_events?.some((event) => event.type === "tool.completed")).toBe(true);
    expect(payload.step_events?.[payload.step_events.length - 1]).toMatchObject({ type: "step.completed" });
  });

  it("returns 400 instead of 500 for malformed JSON bodies", async () => {
    const execute = await app.request("/api/execute-step", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json"
    });
    expect(execute.status).toBe(400);
    expect(await execute.json()).toEqual({ error: "invalid JSON body" });

    const cleanup = await app.request("/api/cleanup-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json"
    });
    expect(cleanup.status).toBe(400);

    const missingRunId = await app.request("/api/cleanup-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source_repo: "/tmp/somewhere" })
    });
    expect(missingRunId.status).toBe(400);
  });

  it("rejects unknown step kinds instead of running the deploy path", async () => {
    const response = await app.request("/api/execute-step", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mission_id: "mis_contracts",
        run_id: "run_contracts",
        step_id: "step_plan",
        execution_id: "exec_contracts",
        kind: "provision",
        envelope: buildEnvelope({ allowed_actions: ["deploy"] })
      })
    });

    const payload = await response.json() as { summary?: string; step_events?: Array<{ type: string; payload?: { violation_kind?: string } }> };
    expect(response.status).toBe(400);
    expect(payload.summary).toMatch(/unknown step kind/i);
    expect(payload.step_events?.some((event) => event.type === "policy.violation" && event.payload?.violation_kind === "unknown_step_kind")).toBe(true);
  });

  it("rejects invalid execution envelopes", async () => {
    const response = await app.request("/api/execute-step", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mission_id: "mis_contracts",
        run_id: "run_contracts",
        step_id: "step_plan",
        execution_id: "exec_contracts",
        kind: "plan",
        envelope: buildEnvelope({ allowed_actions: [] })
      })
    });

    const payload = await response.json() as { summary?: string; step_events?: Array<{ type: string }> };
    expect(response.status).toBe(400);
    expect(payload.summary).toMatch(/invalid execution envelope/i);
    expect(payload.step_events?.some((event) => event.type === "policy.violation")).toBe(true);
  });

  it("emits execution.budget_exceeded when the result exceeds the resource budget", async () => {
    const response = await app.request("/api/execute-step", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mission_id: "mis_budget",
        run_id: "run_budget",
        step_id: "step_plan",
        execution_id: "exec_budget",
        kind: "plan",
        envelope: buildEnvelope({ resource_budget: { token_budget: 1, max_artifacts: 5, max_output_bytes: 1024 * 1024 } })
      })
    });

    const payload = await response.json() as { summary?: string; step_events?: Array<{ type: string }> };
    expect(response.status).toBe(400);
    expect(payload.summary).toMatch(/budget exceeded/i);
    expect(payload.step_events?.some((event) => event.type === "execution.budget_exceeded")).toBe(true);
  });

  it("rejects repo writes that resolve outside the workspace even when writable_paths grants the whole repo", () => {
    const repoWorkspace = join(sandboxRoot, "repo");
    const workspace = {
      workdir: join(sandboxRoot, "out"),
      repoWorkspace,
      envelope: { repo_scope: { writable_paths: ["."] } }
    } as unknown as Parameters<typeof assertAllowedRepoWrite>[0];

    expect(() => assertAllowedRepoWrite(workspace, join(repoWorkspace, "src", "ok.ts"))).not.toThrow();
    expect(() => assertAllowedRepoWrite(workspace, join(sandboxRoot, "outside.txt"))).toThrow(/write path not allowed/);
    expect(() => assertAllowedRepoWrite(workspace, join(repoWorkspace, "..", "outside.txt"))).toThrow(/write path not allowed/);
    // the workspace root itself is a directory, not a writable file target
    expect(() => assertAllowedRepoWrite(workspace, repoWorkspace)).toThrow(/write path not allowed/);
  });

  it("rejects repo paths outside the allowed root", () => {
    expect(() => assertSafeRepoPath(join(allowedRepoRoot, "..", "not-allowed"))).toThrow(/allowed root/);
  });

  it("detects pnpm test commands from package metadata", async () => {
    const repo = join(sandboxRoot, "repo-a");
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }), "utf8");
    await writeFile(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

    await expect(detectTestCommand(repo)).resolves.toEqual({ cmd: "pnpm", args: ["test"], label: "pnpm test", framework: "node-pnpm" });
  });

  it("runs the package.json test script via bun run for bun repos", async () => {
    const repo = join(sandboxRoot, "repo-bun");
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }), "utf8");
    await writeFile(join(repo, "bun.lock"), "{}\n", "utf8");

    await expect(detectTestCommand(repo)).resolves.toEqual({ cmd: "bun", args: ["run", "test"], label: "bun run test", framework: "node-bun" });
  });

  it("refuses write-capable steps for non-git repos", async () => {
    const repo = join(sandboxRoot, "repo-b");
    await mkdir(repo, { recursive: true });
    const envelope = buildEnvelope({ output_dir: join(process.cwd(), "../../data/worker-runs/run_safe/implement") }) as any;

    await expect(ensureWorkspace({ mission_id: "mis_safe", run_id: "run_safe", step_id: "implement", execution_id: "exec_safe", kind: "implement", repo_path: repo, envelope } as any, envelope)).rejects.toThrow(/git repo/);
  });

  it("rejects cleanup requests targeting repos outside the allowed root", async () => {
    const response = await app.request("/api/cleanup-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_id: "run_evil", source_repo: join(allowedRepoRoot, "..", "some-other-repo"), branch_name: "main" })
    });

    expect(response.status).toBe(400);
    const payload = await response.json() as { error?: string };
    expect(payload.error).toMatch(/allowed root/);
  });

  it("rejects cleanup requests with unsafe run ids or flag-like branch names", async () => {
    const badRunId = await app.request("/api/cleanup-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_id: "../escape" })
    });
    expect(badRunId.status).toBe(400);

    const badBranch = await app.request("/api/cleanup-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_id: "run_cleanup", source_repo: allowedRepoRoot, branch_name: "-D" })
    });
    expect(badBranch.status).toBe(400);
  });

  it("deletes the stale run branch even when the worktree directory is already gone", async () => {
    const run = promisify(execFile);
    const runId = "run_stale_branch";
    const branchName = `hermes/${runId}`;
    const repo = join(sandboxRoot, "stale-branch-repo");
    const worktree = join(process.cwd(), "../../data/worktrees", runId);
    await mkdir(repo, { recursive: true });
    await run("git", ["-C", repo, "init", "-q"]);
    await writeFile(join(repo, "file.txt"), "content", "utf8");
    await run("git", ["-C", repo, "add", "."]);
    await run("git", ["-C", repo, "-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-q", "-m", "init"]);
    await run("git", ["-C", repo, "worktree", "add", "-B", branchName, worktree, "HEAD"]);

    // Simulate a partial cleanup: the worktree directory disappears but the
    // branch (and worktree bookkeeping) stay behind in the source repo.
    await rm(worktree, { recursive: true, force: true });

    await expect(cleanupRun(runId, repo, branchName)).resolves.toMatchObject({ ok: true });

    const branches = await run("git", ["-C", repo, "branch", "--list", branchName]);
    expect(branches.stdout.trim()).toBe("");
  });

  it("skips pnpm reinstall when the workspace is already hydrated at the cached commit", async () => {
    const run = promisify(execFile);
    const sourceRepo = join(sandboxRoot, "pnpm-cache-repo");
    await mkdir(sourceRepo, { recursive: true });
    // A dependency the stub lockfile cannot satisfy: any real
    // `pnpm install --frozen-lockfile` here fails fast, so this test only
    // passes when the hydrated workspace short-circuits the install.
    await writeFile(join(sourceRepo, "package.json"), JSON.stringify({ name: "cache-repo", dependencies: { "left-pad": "^1.3.0" } }), "utf8");
    await writeFile(join(sourceRepo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await run("git", ["-C", sourceRepo, "init", "-q"]);
    await run("git", ["-C", sourceRepo, "add", "."]);
    await run("git", ["-C", sourceRepo, "-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-q", "-m", "init"]);
    const commit = (await run("git", ["-C", sourceRepo, "rev-parse", "HEAD"])).stdout.trim();

    const workspace = join(sandboxRoot, "pnpm-cache-workspace");
    await mkdir(join(workspace, "node_modules"), { recursive: true });
    await writeFile(join(workspace, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

    const cacheFile = process.env.WORKSPACE_CACHE_FILE!;
    const cacheKey = Buffer.from(sourceRepo).toString("base64url");
    await mkdir(dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify({ [cacheKey]: { repo_path: sourceRepo, commit, hydrated_at: new Date().toISOString(), package_manager: "pnpm" } }), "utf8");

    await expect(bootstrapWorkspaceDependencies(workspace, sourceRepo)).resolves.toMatchObject({ reused: true, commit });
    // The pre-hydrated node_modules must survive (no unlink + reinstall).
    await expect(access(join(workspace, "node_modules"))).resolves.toBeUndefined();
  });

  it("hydrates workspaces whose node_modules symlink is dangling instead of crashing", async () => {
    const run = promisify(execFile);
    const sourceRepo = join(sandboxRoot, "dangling-source-repo");
    await mkdir(join(sourceRepo, "node_modules"), { recursive: true });
    await writeFile(join(sourceRepo, "package.json"), JSON.stringify({ name: "dangling-repo" }), "utf8");
    await run("git", ["-C", sourceRepo, "init", "-q"]);
    await run("git", ["-C", sourceRepo, "add", "package.json"]);
    await run("git", ["-C", sourceRepo, "-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-q", "-m", "init"]);

    const workspace = join(sandboxRoot, "dangling-workspace");
    await mkdir(workspace, { recursive: true });
    // A symlink whose target no longer exists: access() reports it missing,
    // but the directory entry is still there, so a blind symlink() throws
    // EEXIST and aborts hydration.
    await symlink(join(sandboxRoot, "no-such-target"), join(workspace, "node_modules"), "dir");

    await expect(bootstrapWorkspaceDependencies(workspace, sourceRepo)).resolves.toMatchObject({ reused: false });
  });

  it("cleans up run directories even without git metadata", async () => {
    const runId = "run_cleanup";
    const target = join(process.cwd(), "../../data/worktrees", runId);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "marker.txt"), "ok", "utf8");

    await expect(cleanupRun(runId)).resolves.toMatchObject({ ok: true });
  });

  it("removes the run output root only when remove_outputs is requested", async () => {
    const runId = "run_cleanup_outputs";
    const outputRoot = join(process.cwd(), "../../data/worker-runs", runId);
    await mkdir(join(outputRoot, "step_plan"), { recursive: true });
    await writeFile(join(outputRoot, "step_plan", "plan.md"), "plan", "utf8");

    const keep = await app.request("/api/cleanup-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_id: runId })
    });
    expect(keep.status).toBe(200);
    // Recorded artifacts reference files under the output root, so a normal
    // terminal cleanup must keep it.
    await expect(access(join(outputRoot, "step_plan", "plan.md"))).resolves.toBeUndefined();

    const sweep = await app.request("/api/cleanup-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_id: runId, remove_outputs: true })
    });
    expect(sweep.status).toBe(200);
    const payload = await sweep.json() as { removed_paths?: string[] };
    expect(payload.removed_paths).toContain(outputRoot);
    await expect(access(outputRoot)).rejects.toThrow();
  });
});
