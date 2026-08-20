import { afterEach, describe, expect, it } from "vitest";
import { access, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { app, assertAllowedRepoWrite, assertSafeRepoPath, bootstrapWorkspaceDependencies, cleanupRun, detectTestCommand, ensureWorkspace, parseChangedFiles, sanitizedChildEnv } from "./index.js";

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

  it("rejects non-numeric resource budgets that would disable budget enforcement", async () => {
    for (const resource_budget of [
      { token_budget: "lots", max_artifacts: 5, max_output_bytes: 1024 },
      { token_budget: 1000, max_artifacts: Number.NaN, max_output_bytes: 1024 },
      { token_budget: 1000, max_artifacts: 5 }
    ]) {
      const response = await app.request("/api/execute-step", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mission_id: "mis_contracts",
          run_id: "run_contracts",
          step_id: "step_plan",
          execution_id: "exec_contracts",
          kind: "plan",
          envelope: buildEnvelope({ resource_budget })
        })
      });
      const payload = await response.json() as { summary?: string };
      expect(response.status).toBe(400);
      expect(payload.summary).toMatch(/resource_budget invalid/i);
    }
  });

  it("rejects envelope timeouts beyond Node's 32-bit timer range", async () => {
    // setTimeout clamps delays past 2^31-1 ms to 1 ms, so such a timeout
    // would instantly 408 every step instead of never firing.
    const response = await app.request("/api/execute-step", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mission_id: "mis_contracts",
        run_id: "run_contracts",
        step_id: "step_plan",
        execution_id: "exec_contracts",
        kind: "plan",
        envelope: buildEnvelope({ timeout_seconds: 2_147_484 })
      })
    });

    const payload = await response.json() as { summary?: string; step_events?: Array<{ type: string; payload?: { violation_kind?: string } }> };
    expect(response.status).toBe(400);
    expect(payload.summary).toMatch(/timeout_seconds must be at most/i);
    expect(payload.step_events?.some((event) => event.type === "policy.violation" && event.payload?.violation_kind === "invalid_timeout")).toBe(true);
  });

  it("reports policy violations for missing repo_scope or non-string envelope paths", async () => {
    for (const overrides of [
      { repo_scope: undefined },
      { repo_scope: { writable_paths: ["."] } },
      { repo_scope: { root_path: allowedRepoRoot, writable_paths: "." } },
      { output_dir: 42 },
      { worktree_path: null }
    ]) {
      const response = await app.request("/api/execute-step", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mission_id: "mis_contracts",
          run_id: "run_contracts",
          step_id: "step_plan",
          execution_id: "exec_contracts",
          kind: "plan",
          envelope: buildEnvelope(overrides as Record<string, unknown>)
        })
      });
      const payload = await response.json() as { summary?: string; step_events?: Array<{ type: string }> };
      expect(response.status).toBe(400);
      expect(payload.summary).toMatch(/invalid execution envelope/i);
      expect(payload.step_events?.some((event) => event.type === "policy.violation")).toBe(true);
    }
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

  it("strips operator credentials from spawned command environments", () => {
    const env = sanitizedChildEnv({
      PATH: "/usr/bin",
      HARNESS_OPERATOR_TOKEN: "prod-secret",
      VITE_OPERATOR_TOKEN: "prod-secret",
      UNRELATED: "keep-me",
    });
    expect(env.HARNESS_OPERATOR_TOKEN).toBeUndefined();
    expect(env.VITE_OPERATOR_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.UNRELATED).toBe("keep-me");
    // The default source must not be mutated.
    const before = process.env.HARNESS_OPERATOR_TOKEN;
    sanitizedChildEnv();
    expect(process.env.HARNESS_OPERATOR_TOKEN).toBe(before);
  });

  it("strips credential-shaped variables from the child environment", () => {
    // Test/install scripts in the sandboxed repo are repo-controlled code;
    // every credential the operator exported is as reachable as the operator
    // token was.
    const env = sanitizedChildEnv({
      PATH: "/usr/bin",
      HOME: "/home/operator",
      CI: "1",
      GITHUB_TOKEN: "ghp_secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      AWS_ACCESS_KEY_ID: "aws-id",
      OPENAI_API_KEY: "sk-secret",
      DB_PASSWORD: "hunter2",
      SSH_PRIVATE_KEY: "-----BEGIN",
      NPM_TOKEN: "npm-secret",
      // Not credential-shaped: substrings alone must not trip the filter.
      TOKENIZER_CACHE: "/tmp/tok",
      SECRETARIAT: "keep-me",
    });
    for (const stripped of ["GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "OPENAI_API_KEY", "DB_PASSWORD", "SSH_PRIVATE_KEY", "NPM_TOKEN"]) {
      expect(env[stripped]).toBeUndefined();
    }
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/operator");
    expect(env.CI).toBe("1");
    expect(env.TOKENIZER_CACHE).toBe("/tmp/tok");
    expect(env.SECRETARIAT).toBe("keep-me");
  });

  it("strips credential-bearing variables that are not credential-shaped", () => {
    // Naming conventions miss the worst ones: a forwarded ssh/gpg agent
    // socket lets a repo-controlled test script use the operator's keys, and
    // KUBECONFIG / NETRC point straight at credential files.
    const env = sanitizedChildEnv({
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      GPG_AGENT_INFO: "/tmp/gpg",
      KUBECONFIG: "/home/operator/.kube/config",
      NETRC: "/home/operator/.netrc",
      AWS_SHARED_CREDENTIALS_FILE: "/home/operator/.aws/credentials",
      DOCKER_HOST: "unix:///var/run/docker.sock",
    });
    for (const stripped of ["SSH_AUTH_SOCK", "GPG_AGENT_INFO", "KUBECONFIG", "NETRC", "AWS_SHARED_CREDENTIALS_FILE", "DOCKER_HOST"]) {
      expect(env[stripped]).toBeUndefined();
    }
    expect(env.PATH).toBe("/usr/bin");

    // Unlike the operator token these are real build inputs for some
    // pipelines, so the allow list still applies.
    const allowed = sanitizedChildEnv({ SSH_AUTH_SOCK: "/tmp/ssh-agent.sock" }, new Set(["SSH_AUTH_SOCK"]));
    expect(allowed.SSH_AUTH_SOCK).toBe("/tmp/ssh-agent.sock");
  });

  it("honours the child-env allow list but never for the operator token", () => {
    const env = sanitizedChildEnv(
      { NPM_TOKEN: "npm-secret", GITHUB_TOKEN: "ghp_secret", HARNESS_OPERATOR_TOKEN: "prod-secret" },
      new Set(["NPM_TOKEN", "HARNESS_OPERATOR_TOKEN"])
    );
    expect(env.NPM_TOKEN).toBe("npm-secret");
    expect(env.GITHUB_TOKEN).toBeUndefined();
    // The operator token guards this service's own API; it is not an
    // opt-in-able pipeline credential.
    expect(env.HARNESS_OPERATOR_TOKEN).toBeUndefined();
  });

  it("rejects repo paths outside the allowed root", () => {
    expect(() => assertSafeRepoPath(join(allowedRepoRoot, "..", "not-allowed"))).toThrow(/allowed root/);
  });

  it("parses changed files from git status without mangling uppercase or renamed paths", () => {
    const parsed = parseChangedFiles('?? README.md\n M Makefile\nA  src/app.ts\nR  old.ts -> new.ts\n?? "has space.txt"\n');
    expect(parsed).toEqual(["README.md", "Makefile", "src/app.ts", "new.ts", "has space.txt"]);
  });

  it("decodes git's C-style escapes in quoted status paths", () => {
    // git renders café as "caf\303\251" (octal UTF-8 bytes) and escapes
    // quotes/backslashes; the decoded path is what changed_files consumers
    // (review artifacts, writable-path checks) should see.
    const parsed = parseChangedFiles('?? "caf\\303\\251 menu.md"\n M "quote\\"name.md"\n?? "tab\\tname.md"\n');
    expect(parsed).toEqual(["café menu.md", 'quote"name.md', "tab\tname.md"]);
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
      body: JSON.stringify({ run_id: "run_evil", source_repo: join(allowedRepoRoot, "..", "some-other-repo"), branch_name: "hermes/run_evil" })
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

    // Branch deletion is namespaced: cleanup must never delete a branch the
    // worker did not create (e.g. main).
    const foreignBranch = await app.request("/api/cleanup-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_id: "run_cleanup", source_repo: allowedRepoRoot, branch_name: "main" })
    });
    expect(foreignBranch.status).toBe(400);
    const payload = await foreignBranch.json() as { error?: string };
    expect(payload.error).toMatch(/hermes\//);
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

  it("surfaces unexpected git cleanup failures as warnings instead of a silent ok", async () => {
    const run = promisify(execFile);
    const runId = "run_cleanup_warning";
    const branchName = `hermes/${runId}`;
    const repo = join(sandboxRoot, "cleanup-warning-repo");
    await mkdir(repo, { recursive: true });
    await run("git", ["-C", repo, "init", "-q"]);
    await writeFile(join(repo, "file.txt"), "content", "utf8");
    await run("git", ["-C", repo, "add", "."]);
    await run("git", ["-C", repo, "-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-q", "-m", "init"]);

    // The run branch is checked out in a worktree cleanup does not manage,
    // so `git branch -D` fails for a reason other than "not found".
    const foreignWorktree = join(sandboxRoot, "cleanup-warning-foreign-worktree");
    await run("git", ["-C", repo, "worktree", "add", "-B", branchName, foreignWorktree, "HEAD"]);

    const result = await cleanupRun(runId, repo, branchName) as { ok: boolean; warnings?: string[] };
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toMatch(/branch -D/);

    // The stale branch really is still there for an operator to act on.
    const branches = await run("git", ["-C", repo, "branch", "--list", branchName]);
    expect(branches.stdout.trim()).not.toBe("");
  });

  it("reports no warnings when the run branch was simply never created", async () => {
    const run = promisify(execFile);
    const runId = "run_cleanup_no_branch";
    const repo = join(sandboxRoot, "cleanup-no-branch-repo");
    await mkdir(repo, { recursive: true });
    await run("git", ["-C", repo, "init", "-q"]);
    await writeFile(join(repo, "file.txt"), "content", "utf8");
    await run("git", ["-C", repo, "add", "."]);
    await run("git", ["-C", repo, "-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-q", "-m", "init"]);

    const result = await cleanupRun(runId, repo, `hermes/${runId}`) as { ok: boolean; warnings?: string[] };
    expect(result.ok).toBe(true);
    expect(result.warnings).toBeUndefined();
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

  it("keeps both cache entries when two workspaces bootstrap concurrently", async () => {
    const run = promisify(execFile);
    const repos: string[] = [];
    const workspaces: string[] = [];
    for (const name of ["concurrent-repo-a", "concurrent-repo-b"]) {
      const repo = join(sandboxRoot, name);
      await mkdir(repo, { recursive: true });
      await writeFile(join(repo, "package.json"), JSON.stringify({ name }), "utf8");
      await run("git", ["-C", repo, "init", "-q"]);
      await run("git", ["-C", repo, "add", "package.json"]);
      await run("git", ["-C", repo, "-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-q", "-m", "init"]);
      const workspace = join(sandboxRoot, `${name}-workspace`);
      await mkdir(workspace, { recursive: true });
      repos.push(repo);
      workspaces.push(workspace);
    }

    // Both bootstraps read-modify-write the shared cache file; without the
    // serialized update queue the later write could drop the earlier entry.
    await Promise.all(repos.map((repo, index) => bootstrapWorkspaceDependencies(workspaces[index]!, repo)));

    const cache = JSON.parse(await readFile(process.env.WORKSPACE_CACHE_FILE!, "utf8")) as Record<string, { repo_path: string }>;
    for (const repo of repos) {
      expect(cache[Buffer.from(repo).toString("base64url")]).toMatchObject({ repo_path: repo });
    }
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

  it("aborts workspace bootstrap when the envelope timeout fires", { timeout: 20_000 }, async () => {
    const run = promisify(execFile);
    const runId = "run_slow_bootstrap";
    const repo = join(sandboxRoot, "slow-bootstrap-repo");
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "slow-repo" }), "utf8");
    await writeFile(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await run("git", ["-C", repo, "init", "-q"]);
    await run("git", ["-C", repo, "add", "."]);
    await run("git", ["-C", repo, "-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-q", "-m", "init"]);

    // A pnpm that hangs far longer than the envelope allows. Workspace
    // bootstrap runs it during dependency hydration; unless setup executes
    // inside the timeout/abort scope, this request blocks for the full
    // sleep instead of failing at timeout_seconds.
    const binDir = join(sandboxRoot, "slow-bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, "pnpm"), "#!/bin/sh\nsleep 120\n", { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath}`;
    const worktree = join(process.cwd(), "../../data/worktrees", runId);
    try {
      const response = await app.request("/api/execute-step", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mission_id: "mis_slow_bootstrap",
          run_id: runId,
          step_id: "step_plan",
          execution_id: "exec_slow_bootstrap",
          kind: "plan",
          repo_path: repo,
          envelope: buildEnvelope({
            timeout_seconds: 1,
            worktree_path: worktree,
            output_dir: join(process.cwd(), "../../data/worker-runs", runId, "step_plan"),
            repo_scope: { root_path: repo, writable_paths: [] }
          })
        })
      });

      const payload = await response.json() as { summary?: string; error_code?: string };
      expect(response.status).toBe(408);
      expect(payload.error_code).toBe("execution.timeout");
      expect(payload.summary).toMatch(/timed out/i);
    } finally {
      process.env.PATH = originalPath;
      await rm(worktree, { recursive: true, force: true });
    }
  });

  it("aborts an in-flight execution when the abort endpoint is called", { timeout: 20_000 }, async () => {
    const repo = join(sandboxRoot, "abortable-repo");
    await mkdir(repo, { recursive: true });
    // Non-git repo is fine for test steps; the test script hangs far longer
    // than the abort should take to settle the request.
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "abortable", scripts: { test: "sleep 60" } }), "utf8");

    const responsePromise = app.request("/api/execute-step", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mission_id: "mis_abort",
        run_id: "run_abort",
        step_id: "step_test",
        execution_id: "exec_abort",
        kind: "test",
        repo_path: repo,
        envelope: buildEnvelope({
          timeout_seconds: 60,
          allowed_actions: ["run_tests"],
          worktree_path: join(process.cwd(), "../../data/worktrees/run_abort"),
          output_dir: join(process.cwd(), "../../data/worker-runs/run_abort/step_test"),
          repo_scope: { root_path: repo, writable_paths: [] }
        })
      })
    });
    // Let the dispatch register and start its test command.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const abort = await app.request("/api/abort-execution", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ execution_id: "exec_abort", reason: "operator interrupted current step" })
    });
    expect(abort.status).toBe(200);

    const response = await responsePromise;
    const payload = await response.json() as { summary?: string; step_events?: Array<{ type: string }> };
    expect(response.status).toBe(409);
    expect(payload.summary).toMatch(/aborted by operator: operator interrupted current step/);
    expect(payload.step_events?.some((event) => event.type === "step.failed")).toBe(true);

    // Settled executions are unregistered: a second abort finds nothing.
    const again = await app.request("/api/abort-execution", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ execution_id: "exec_abort" })
    });
    expect(again.status).toBe(404);
  });

  it("rejects dispatches beyond the concurrent execution cap", { timeout: 30_000 }, async () => {
    const repo = join(sandboxRoot, "capacity-repo");
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "capacity", scripts: { test: "sleep 60" } }), "utf8");

    const request = (suffix: string) => app.request("/api/execute-step", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mission_id: "mis_capacity",
        run_id: `run_capacity_${suffix}`,
        step_id: "step_test",
        execution_id: `exec_capacity_${suffix}`,
        kind: "test",
        repo_path: repo,
        envelope: buildEnvelope({
          timeout_seconds: 60,
          allowed_actions: ["run_tests"],
          worktree_path: join(process.cwd(), `../../data/worktrees/run_capacity_${suffix}`),
          output_dir: join(process.cwd(), `../../data/worker-runs/run_capacity_${suffix}/step_test`),
          repo_scope: { root_path: repo, writable_paths: [] }
        })
      })
    });

    // WORKER_MAX_CONCURRENT_EXECUTIONS is 2 in vitest.config.ts.
    const first = request("a");
    const second = request("b");
    await new Promise((resolve) => setTimeout(resolve, 500));

    const third = await request("c");
    expect(third.status).toBe(429);
    const rejected = await third.json() as { error?: string; in_flight?: number; max_concurrent?: number };
    expect(rejected.error).toMatch(/worker at capacity/);
    expect(rejected.max_concurrent).toBe(2);

    for (const suffix of ["a", "b"]) {
      await app.request("/api/abort-execution", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ execution_id: `exec_capacity_${suffix}` })
      });
    }
    expect((await first).status).toBe(409);
    expect((await second).status).toBe(409);

    // Aborted executions release their slots: a plan step (which settles on
    // its own) gets through instead of another 429.
    const afterDrain = await app.request("/api/execute-step", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mission_id: "mis_capacity",
        run_id: "run_capacity_d",
        step_id: "step_plan",
        execution_id: "exec_capacity_d",
        kind: "plan",
        envelope: buildEnvelope({
          worktree_path: join(process.cwd(), "../../data/worktrees/run_capacity_d"),
          output_dir: join(process.cwd(), "../../data/worker-runs/run_capacity_d/step_plan")
        })
      })
    });
    expect(afterDrain.status).toBe(200);

    for (const suffix of ["a", "b", "c", "d"]) {
      await cleanupRun(`run_capacity_${suffix}`, undefined, undefined, true);
    }
  });

  it("rejects a duplicate dispatch for a still-running execution id", { timeout: 20_000 }, async () => {
    const repo = join(sandboxRoot, "duplicate-dispatch-repo");
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "duplicate", scripts: { test: "sleep 60" } }), "utf8");

    const request = () => app.request("/api/execute-step", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mission_id: "mis_duplicate",
        run_id: "run_duplicate",
        step_id: "step_test",
        execution_id: "exec_duplicate",
        kind: "test",
        repo_path: repo,
        envelope: buildEnvelope({
          timeout_seconds: 60,
          allowed_actions: ["run_tests"],
          worktree_path: join(process.cwd(), "../../data/worktrees/run_duplicate"),
          output_dir: join(process.cwd(), "../../data/worker-runs/run_duplicate/step_test"),
          repo_scope: { root_path: repo, writable_paths: [] }
        })
      })
    });

    const firstPromise = request();
    await new Promise((resolve) => setTimeout(resolve, 300));

    // A second dispatch reusing the live execution id would orphan the
    // first registration and run two executions against one worktree.
    const second = await request();
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error?: string }).error).toMatch(/already in flight/);

    const abort = await app.request("/api/abort-execution", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ execution_id: "exec_duplicate" })
    });
    expect(abort.status).toBe(200);
    expect((await firstPromise).status).toBe(409);
  });

  it("returns 404 for aborts targeting unknown executions and 400 for bad payloads", async () => {
    const unknown = await app.request("/api/abort-execution", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ execution_id: "exec_never_dispatched" })
    });
    expect(unknown.status).toBe(404);

    const missingId = await app.request("/api/abort-execution", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "no id" })
    });
    expect(missingId.status).toBe(400);
  });

  it("cleans up run directories even without git metadata", async () => {
    const runId = "run_cleanup";
    const target = join(process.cwd(), "../../data/worktrees", runId);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "marker.txt"), "ok", "utf8");

    await expect(cleanupRun(runId)).resolves.toMatchObject({ ok: true });
  });

  it("emits a single tool.failed event for generic execution errors", async () => {
    const runId = "run_generic_fail";
    const outputDir = join(process.cwd(), "../../data/worker-runs", runId, "step_plan");
    // A regular file where the output directory should go makes workspace
    // setup throw a plain Error (not a WorkerExecutionError), exercising the
    // generic wrap path in the execute-step catch handler.
    await mkdir(dirname(outputDir), { recursive: true });
    await writeFile(outputDir, "not a directory", "utf8");
    try {
      const response = await app.request("/api/execute-step", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mission_id: "mis_generic",
          run_id: runId,
          step_id: "step_plan",
          execution_id: "exec_generic",
          kind: "plan",
          envelope: buildEnvelope({ output_dir: outputDir })
        })
      });

      const payload = await response.json() as { success?: boolean; step_events?: Array<{ type: string }> };
      expect(response.status).toBe(400);
      expect(payload.success).toBe(false);
      const toolFailedEvents = payload.step_events?.filter((event) => event.type === "tool.failed") ?? [];
      expect(toolFailedEvents).toHaveLength(1);
      expect(payload.step_events?.[payload.step_events.length - 1]).toMatchObject({ type: "step.failed" });
    } finally {
      await rm(join(process.cwd(), "../../data/worker-runs", runId), { recursive: true, force: true });
    }
  });

  it("rejects flag-like or non-hermes branch names before any git command runs", async () => {
    for (const branch_name of ["-D", "  ", 42, "main"]) {
      const response = await app.request("/api/execute-step", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mission_id: "mis_branch",
          run_id: "run_branch",
          step_id: "step_plan",
          execution_id: "exec_branch",
          kind: "plan",
          branch_name,
          envelope: buildEnvelope()
        })
      });
      const payload = await response.json() as { summary?: string; step_events?: Array<{ type: string; payload?: { violation_kind?: string } }> };
      expect(response.status).toBe(400);
      expect(payload.summary).toMatch(/branch_name/i);
      expect(payload.step_events?.some((event) => event.type === "policy.violation" && event.payload?.violation_kind === "invalid_branch_name")).toBe(true);
    }
  });

  it("reports non-string identifiers and repo_path as policy violations", async () => {
    // A truthy non-string got past the identifier guard and only failed later
    // inside resolve()/assertSafeSegment, surfacing a raw Node TypeError
    // ("the \"paths[0]\" argument must be of type string") as the step summary
    // with error_code tool.failed instead of a policy violation.
    const cases: Array<{ overrides: Record<string, unknown>; violation_kind: string }> = [
      { overrides: { run_id: { evil: true } }, violation_kind: "missing_execution_identifiers" },
      { overrides: { step_id: 7 }, violation_kind: "missing_execution_identifiers" },
      { overrides: { repo_path: { evil: true } }, violation_kind: "invalid_repo_path" },
      { overrides: { repo_path: 42 }, violation_kind: "invalid_repo_path" },
    ];

    for (const { overrides, violation_kind } of cases) {
      const response = await app.request("/api/execute-step", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mission_id: "mis_types",
          run_id: "run_types",
          step_id: "step_plan",
          execution_id: "exec_types",
          kind: "plan",
          branch_name: "hermes/run_types",
          envelope: buildEnvelope(),
          ...overrides
        })
      });
      const payload = await response.json() as { summary?: string; error_code?: string; step_events?: Array<{ type: string; payload?: { violation_kind?: string } }> };
      expect(response.status).toBe(400);
      expect(payload.error_code).toBe("policy.violation");
      expect(payload.summary).not.toMatch(/paths\[0\]/);
      expect(payload.step_events?.some((event) => event.type === "policy.violation" && event.payload?.violation_kind === violation_kind)).toBe(true);
    }
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
