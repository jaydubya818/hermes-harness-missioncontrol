import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { mkdir, writeFile, access, rm, readFile, symlink, unlink, readdir } from "node:fs/promises";
import { resolve, join, relative, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadJsonFile, saveJsonFile } from "@hermes-harness-with-missioncontrol/state-store";
import { EventSource, type EventEnvelope, type ExecutionEnvelope, type StepExecutionRequest } from "@hermes-harness-with-missioncontrol/contracts";

const execFileAsync = promisify(execFile);
const app = new Hono();
const runsRoot = process.env.WORKER_RUNTIME_ROOT ?? resolve(process.cwd(), "../../data/worker-runs");
const worktreesRoot = process.env.WORKTREE_ROOT ?? resolve(process.cwd(), "../../data/worktrees");
const cacheFile = process.env.WORKSPACE_CACHE_FILE ?? resolve(process.cwd(), "../../data/workspace-cache.json");
const allowedRepoRoot = resolve(process.env.ALLOWED_REPO_ROOT ?? "/Users/jaywest/projects");
const deployAdapterEnv = process.env.DEPLOY_ADAPTER ?? "auto";
const deployBaseUrl = process.env.DEPLOY_BASE_URL ?? "https://staging.example.internal";
const operatorToken = process.env.HARNESS_OPERATOR_TOKEN;

type StepRequest = StepExecutionRequest;

type StepArtifact = {
  artifact_id?: string;
  type: string;
  uri: string;
  content?: string;
  metadata?: Record<string, unknown>;
};

type StepResult = {
  summary: string;
  confidence: number;
  success: boolean;
  artifacts: StepArtifact[];
  step_events?: EventEnvelope[];
};

type WorkspaceContext = {
  workdir: string;
  repoWorkspace: string;
  sourceRepo?: string;
  worktreePath?: string;
  branchName?: string;
  envelope: ExecutionEnvelope;
  sandbox_cache?: {
    cache_key: string;
    commit: string;
    hydrated_at: string;
    reused: boolean;
  };
};

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type BootstrapCacheEntry = {
  repo_path: string;
  commit: string;
  hydrated_at: string;
  package_manager: string;
};

type BootstrapCache = Record<string, BootstrapCacheEntry>;

type TestCommand = {
  cmd: string;
  args: string[];
  label: string;
  framework: string;
};

type DeployPlan = {
  provider: string;
  mode: "plan_only" | "canary";
  canary_target: string;
  deploy_command: string;
  rollback_command: string;
  requires_approval: boolean;
};

class WorkerExecutionError extends Error {
  statusCode: number;
  eventType?: EventEnvelope["type"];
  payload: Record<string, unknown>;
  started: boolean;

  constructor(
    message: string,
    options: {
      statusCode?: number;
      eventType?: EventEnvelope["type"];
      payload?: Record<string, unknown>;
      started?: boolean;
    } = {}
  ) {
    super(message);
    this.name = "WorkerExecutionError";
    this.statusCode = options.statusCode ?? 400;
    this.eventType = options.eventType;
    this.payload = options.payload ?? {};
    this.started = options.started ?? false;
  }
}

function assertSafeSegment(value: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("unsafe path segment");
}

function isWriteKind(kind: string) {
  return ["implement"].includes(kind);
}

function requiresGitRepo(kind: string) {
  return ["plan", "implement", "review", "deploy"].includes(kind);
}

function actionForKind(kind: string) {
  if (kind === "plan") return "plan";
  if (kind === "implement") return "write_repo";
  if (kind === "test") return "run_tests";
  if (kind === "review") return "review_repo";
  return "deploy";
}

function requiredToolsForKind(kind: string) {
  if (kind === "test") return ["process", "filesystem"];
  if (kind === "deploy") return ["process", "filesystem", "git"];
  return ["filesystem", "git"];
}

function toolNameForKind(kind: string) {
  if (kind === "plan") return "workspace.plan";
  if (kind === "implement") return "workspace.implement";
  if (kind === "test") return "workspace.test";
  if (kind === "review") return "workspace.review";
  return "workspace.deploy";
}

function normalizeArtifactId(req: StepRequest, artifact: StepArtifact, index: number) {
  return artifact.artifact_id ?? `art_${req.execution_id}_${index + 1}`;
}

function estimateOutputBytes(result: StepResult) {
  return Buffer.byteLength(JSON.stringify({
    summary: result.summary,
    artifacts: result.artifacts.map((artifact) => ({
      artifact_id: artifact.artifact_id,
      type: artifact.type,
      uri: artifact.uri,
      content: artifact.content,
      metadata: artifact.metadata,
    })),
  }), "utf8");
}

function estimateTokenUsage(result: StepResult) {
  const text = [
    result.summary,
    ...result.artifacts.map((artifact) => JSON.stringify({
      type: artifact.type,
      uri: artifact.uri,
      content: artifact.content,
      metadata: artifact.metadata,
    })),
  ].join("\n");
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}

function enforceBudget(req: StepRequest, result: StepResult) {
  const maxArtifacts = req.envelope.resource_budget.max_artifacts;
  if (result.artifacts.length > maxArtifacts) {
    throw new WorkerExecutionError(`artifact budget exceeded: produced ${result.artifacts.length}, allowed ${maxArtifacts}`, {
      statusCode: 400,
      eventType: "execution.budget_exceeded",
      payload: { budget: "max_artifacts", produced: result.artifacts.length, allowed: maxArtifacts },
      started: true,
    });
  }

  const outputBytes = estimateOutputBytes(result);
  if (outputBytes > req.envelope.resource_budget.max_output_bytes) {
    throw new WorkerExecutionError(`output budget exceeded: produced ${outputBytes} bytes, allowed ${req.envelope.resource_budget.max_output_bytes}`, {
      statusCode: 400,
      eventType: "execution.budget_exceeded",
      payload: { budget: "max_output_bytes", produced: outputBytes, allowed: req.envelope.resource_budget.max_output_bytes },
      started: true,
    });
  }

  const estimatedTokens = estimateTokenUsage(result);
  if (estimatedTokens > req.envelope.resource_budget.token_budget) {
    throw new WorkerExecutionError(`token budget exceeded: estimated ${estimatedTokens}, allowed ${req.envelope.resource_budget.token_budget}`, {
      statusCode: 400,
      eventType: "execution.budget_exceeded",
      payload: { budget: "token_budget", produced: estimatedTokens, allowed: req.envelope.resource_budget.token_budget },
      started: true,
    });
  }
}

function assertAllowedRepoWrite(workspace: WorkspaceContext, targetPath: string) {
  const relPath = safeRelativePath(relative(workspace.repoWorkspace, targetPath));
  const allowed = workspace.envelope.repo_scope.writable_paths.some((allowedPath) => {
    if (allowedPath === ".") return true;
    const normalized = safeRelativePath(allowedPath);
    return relPath === normalized || relPath.startsWith(`${normalized}/`);
  });
  if (!allowed) {
    throw new WorkerExecutionError(`write path not allowed by execution envelope: ${relPath}`, {
      statusCode: 400,
      eventType: "policy.violation",
      payload: {
        violation_kind: "write_path_outside_repo_scope",
        target_path: relPath,
        writable_paths: workspace.envelope.repo_scope.writable_paths,
      },
      started: true,
    });
  }
}

function validateEnvelope(req: StepRequest) {
  const envelope = req.envelope;
  if (!req.mission_id || !req.run_id || !req.step_id || !req.execution_id) {
    throw new WorkerExecutionError("invalid execution envelope: mission_id, run_id, step_id, and execution_id are required", {
      statusCode: 400,
      eventType: "policy.violation",
      payload: { violation_kind: "missing_execution_identifiers" },
    });
  }
  if (!envelope) throw new WorkerExecutionError("invalid execution envelope: envelope missing", { statusCode: 400, eventType: "policy.violation", payload: { violation_kind: "missing_envelope" } });
  if (!Array.isArray(envelope.allowed_tools) || envelope.allowed_tools.length === 0) throw new WorkerExecutionError("invalid execution envelope: allowed_tools required", { statusCode: 400, eventType: "policy.violation", payload: { violation_kind: "missing_allowed_tools" } });
  if (!Array.isArray(envelope.allowed_actions) || envelope.allowed_actions.length === 0) throw new WorkerExecutionError("invalid execution envelope: allowed_actions required", { statusCode: 400, eventType: "policy.violation", payload: { violation_kind: "missing_allowed_actions" } });
  if (!envelope.allowed_actions.includes(actionForKind(req.kind))) throw new WorkerExecutionError("invalid execution envelope: action not allowed", { statusCode: 400, eventType: "policy.violation", payload: { violation_kind: "action_not_allowed", attempted_action: actionForKind(req.kind), allowed_actions: envelope.allowed_actions } });
  for (const tool of requiredToolsForKind(req.kind)) {
    if (!envelope.allowed_tools.includes(tool)) {
      throw new WorkerExecutionError(`invalid execution envelope: missing required tool ${tool}`, {
        statusCode: 400,
        eventType: "policy.violation",
        payload: { violation_kind: "tool_not_allowed", required_tool: tool, allowed_tools: envelope.allowed_tools },
      });
    }
  }
  if (!Number.isInteger(envelope.timeout_seconds) || envelope.timeout_seconds <= 0) throw new WorkerExecutionError("invalid execution envelope: timeout_seconds must be positive integer", { statusCode: 400, eventType: "policy.violation", payload: { violation_kind: "invalid_timeout" } });
  if (!envelope.resource_budget || envelope.resource_budget.max_artifacts <= 0 || envelope.resource_budget.max_output_bytes <= 0 || envelope.resource_budget.token_budget <= 0) {
    throw new WorkerExecutionError("invalid execution envelope: resource_budget invalid", { statusCode: 400, eventType: "policy.violation", payload: { violation_kind: "invalid_resource_budget" } });
  }
  if (!envelope.environment_classification) throw new WorkerExecutionError("invalid execution envelope: environment_classification required", { statusCode: 400, eventType: "policy.violation", payload: { violation_kind: "missing_environment_classification" } });
  const outputDir = resolve(envelope.output_dir);
  try {
    relativeWithin(runsRoot, outputDir);
  } catch {
    throw new WorkerExecutionError("invalid execution envelope: output_dir outside worker run root", { statusCode: 400, eventType: "policy.violation", payload: { violation_kind: "output_dir_outside_root", output_dir: outputDir } });
  }
  const worktreePath = resolve(envelope.worktree_path);
  try {
    relativeWithin(worktreesRoot, worktreePath);
  } catch {
    throw new WorkerExecutionError("invalid execution envelope: worktree_path outside worktree root", { statusCode: 400, eventType: "policy.violation", payload: { violation_kind: "worktree_path_outside_root", worktree_path: worktreePath } });
  }
  const workspaceRoot = resolve(envelope.workspace_root);
  try {
    relativeWithin(allowedRepoRoot, workspaceRoot);
  } catch {
    throw new WorkerExecutionError("invalid execution envelope: workspace_root outside allowed repo root", { statusCode: 400, eventType: "policy.violation", payload: { violation_kind: "workspace_root_outside_root", workspace_root: workspaceRoot } });
  }
  const repoRoot = resolve(envelope.repo_scope.root_path);
  try {
    relativeWithin(allowedRepoRoot, repoRoot);
  } catch {
    throw new WorkerExecutionError("invalid execution envelope: repo_scope.root_path outside allowed repo root", { statusCode: 400, eventType: "policy.violation", payload: { violation_kind: "repo_scope_outside_root", repo_scope_root: repoRoot } });
  }
  for (const writablePath of envelope.repo_scope.writable_paths) {
    if (!writablePath || writablePath.startsWith("/")) throw new WorkerExecutionError("invalid execution envelope: writable_paths must be relative", { statusCode: 400, eventType: "policy.violation", payload: { violation_kind: "absolute_writable_path", writable_path: writablePath } });
    try {
      relativeWithin(repoRoot, resolve(repoRoot, writablePath));
    } catch {
      throw new WorkerExecutionError("invalid execution envelope: writable path escapes repo scope", { statusCode: 400, eventType: "policy.violation", payload: { violation_kind: "writable_path_outside_repo_scope", writable_path: writablePath } });
    }
  }
  if (req.repo_path) {
    const repoPath = resolve(req.repo_path);
    try {
      relativeWithin(repoRoot, repoPath);
    } catch {
      throw new WorkerExecutionError("invalid execution envelope: repo_path outside repo_scope", { statusCode: 400, eventType: "policy.violation", payload: { violation_kind: "repo_path_outside_repo_scope", repo_path: repoPath, repo_scope_root: repoRoot } });
    }
  }
  return {
    ...envelope,
    output_dir: outputDir,
    worktree_path: worktreePath,
    workspace_root: workspaceRoot,
    repo_scope: {
      ...envelope.repo_scope,
      root_path: repoRoot
    }
  } satisfies ExecutionEnvelope;
}

function buildStepEvents(req: StepRequest, result: StepResult): EventEnvelope[] {
  const executionId = req.execution_id;
  const timestamp = new Date().toISOString();
  const toolName = toolNameForKind(req.kind);
  const base = {
    schema_version: "v1" as const,
    timestamp,
    source: EventSource.Hermes,
    mission_id: req.mission_id,
    run_id: req.run_id,
    step_id: req.step_id,
    execution_id: executionId,
  };

  const events: EventEnvelope[] = [
    {
      ...base,
      event_id: `${executionId}_1`,
      sequence: 1,
      type: "step.started",
      payload: {
        step_kind: req.kind,
        approval_mode: req.envelope.approval_mode,
        envelope: {
          workspace_root: req.envelope.workspace_root,
          worktree_path: req.envelope.worktree_path,
          output_dir: req.envelope.output_dir,
          allowed_tools: req.envelope.allowed_tools,
          allowed_actions: req.envelope.allowed_actions,
          timeout_seconds: req.envelope.timeout_seconds,
          resource_budget: req.envelope.resource_budget,
          environment_classification: req.envelope.environment_classification,
        },
      },
    },
    {
      ...base,
      event_id: `${executionId}_2`,
      sequence: 2,
      type: "tool.started",
      payload: { tool_name: toolName, step_kind: req.kind },
    },
    {
      ...base,
      event_id: `${executionId}_3`,
      sequence: 3,
      type: "step.progress",
      payload: { message: result.summary, phase: req.kind },
    },
  ];

  let sequence = 4;
  for (let index = 0; index < result.artifacts.length; index += 1) {
    const artifact = result.artifacts[index]!;
    const createdAt = new Date().toISOString();
    const artifactId = normalizeArtifactId(req, artifact, index);
    artifact.artifact_id = artifactId;
    events.push({
      ...base,
      timestamp: createdAt,
      event_id: `${executionId}_${sequence}`,
      sequence,
      type: "artifact.created",
      payload: {
        artifact_id: artifactId,
        kind: artifact.type,
        label: artifact.type,
        uri: artifact.uri,
        created_at: createdAt,
        created_by: "worker-runtime",
        metadata: artifact.metadata,
      },
    });
    sequence += 1;
  }

  events.push({
    ...base,
    event_id: `${executionId}_${sequence}`,
    sequence,
    type: result.success ? "tool.completed" : "tool.failed",
    payload: { tool_name: toolName, step_kind: req.kind, summary: result.summary },
  });
  sequence += 1;

  events.push({
    ...base,
    event_id: `${executionId}_${sequence}`,
    sequence,
    type: result.success ? "step.completed" : "step.failed",
    payload: { summary: result.summary, confidence: result.confidence, final_outcome: result.success ? "success" : "failed" },
  });

  return events;
}

function buildFailureEvents(req: StepRequest, error: WorkerExecutionError): EventEnvelope[] {
  const timestamp = new Date().toISOString();
  const base = {
    schema_version: "v1" as const,
    timestamp,
    source: EventSource.Hermes,
    mission_id: req.mission_id,
    run_id: req.run_id,
    step_id: req.step_id,
    execution_id: req.execution_id,
  };
  const events: EventEnvelope[] = [];
  let sequence = 1;

  if (error.started) {
    events.push({
      ...base,
      event_id: `${req.execution_id}_${sequence}`,
      sequence,
      type: "tool.failed",
      payload: { tool_name: toolNameForKind(req.kind), step_kind: req.kind, summary: error.message },
    });
    sequence += 1;
  }

  if (error.eventType) {
    events.push({
      ...base,
      event_id: `${req.execution_id}_${sequence}`,
      sequence,
      type: error.eventType,
      payload: { reason: error.message, ...error.payload },
    });
    sequence += 1;
  }

  events.push({
    ...base,
    event_id: `${req.execution_id}_${sequence}`,
    sequence,
    type: "step.failed",
    payload: { summary: error.message, error_type: error.eventType ?? "worker.execution_error" },
  });

  return events;
}

function requireOperator(c: any) {
  if (!operatorToken) return null;
  const auth = c.req.header("authorization") ?? "";
  if (auth !== `Bearer ${operatorToken}`) return c.json({ error: "unauthorized" }, 401);
  return null;
}

function cacheKeyForRepo(repoPath: string) {
  return Buffer.from(repoPath).toString("base64url");
}

function relativeWithin(root: string, path: string) {
  const rel = relative(root, path);
  if (rel.startsWith("..") || rel === "") {
    if (resolve(path) !== resolve(root)) throw new Error("path escapes allowed root");
  }
  return rel;
}

function safeRelativePath(path: string) {
  return path.split("/").filter(Boolean).join("/");
}

async function selectDeployProvider(repoWorkspace: string) {
  if (deployAdapterEnv !== "auto") return deployAdapterEnv;
  if (await exists(join(repoWorkspace, "vercel.json"))) return "vercel";
  if (await exists(join(repoWorkspace, "render.yaml"))) return "render";
  return "noop-canary";
}

export function assertSafeRepoPath(path: string) {
  const abs = resolve(path);
  relativeWithin(allowedRepoRoot, abs);
  return abs;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runCmd(cmd: string, args: string[], cwd: string): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { cwd, maxBuffer: 1024 * 1024 * 25 });
    return { stdout, stderr, exitCode: 0 };
  } catch (error: any) {
    return {
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? String(error?.message ?? error),
      exitCode: typeof error?.code === "number" ? error.code : 1
    };
  }
}

async function readCache(): Promise<BootstrapCache> {
  return loadJsonFile<BootstrapCache>(cacheFile, {});
}

async function writeCache(cache: BootstrapCache) {
  await saveJsonFile(cacheFile, cache);
}

async function assertGitRepo(path: string) {
  const probe = await runCmd("git", ["-C", path, "rev-parse", "--is-inside-work-tree"], path);
  return probe.exitCode === 0 && probe.stdout.trim() === "true";
}

async function currentCommit(path: string) {
  const probe = await runCmd("git", ["-C", path, "rev-parse", "HEAD"], path);
  if (probe.exitCode !== 0) throw new Error(`failed to resolve git commit: ${probe.stderr || probe.stdout}`);
  return probe.stdout.trim();
}

async function detectPackageManager(repoWorkspace: string) {
  if (await exists(join(repoWorkspace, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(join(repoWorkspace, "yarn.lock"))) return "yarn";
  if (await exists(join(repoWorkspace, "bun.lockb")) || await exists(join(repoWorkspace, "bun.lock"))) return "bun";
  return "npm";
}

async function symlinkIfMissing(sourcePath: string, targetPath: string) {
  if (!(await exists(sourcePath)) || await exists(targetPath)) return;
  await mkdir(dirname(targetPath), { recursive: true });
  await symlink(sourcePath, targetPath, "dir");
}

async function mirrorWorkspaceNodeModules(sourceRepo: string, repoWorkspace: string) {
  await symlinkIfMissing(join(sourceRepo, "node_modules"), join(repoWorkspace, "node_modules"));
  for (const bucket of ["packages", "apps"]) {
    const sourceBucket = join(sourceRepo, bucket);
    const targetBucket = join(repoWorkspace, bucket);
    if (!(await exists(sourceBucket)) || !(await exists(targetBucket))) continue;
    const entries = await readdir(sourceBucket, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      await symlinkIfMissing(join(sourceBucket, entry.name, "node_modules"), join(targetBucket, entry.name, "node_modules"));
    }
  }
}

async function mirrorBuildArtifacts(sourceRepo: string, repoWorkspace: string) {
  for (const bucket of ["packages", "apps"]) {
    const sourceBucket = join(sourceRepo, bucket);
    const targetBucket = join(repoWorkspace, bucket);
    if (!(await exists(sourceBucket)) || !(await exists(targetBucket))) continue;
    const entries = await readdir(sourceBucket, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      await symlinkIfMissing(join(sourceBucket, entry.name, "dist"), join(targetBucket, entry.name, "dist"));
    }
  }
}

async function bootstrapWorkspaceDependencies(repoWorkspace: string, sourceRepo: string) {
  const packageManager = await detectPackageManager(repoWorkspace);
  const commit = await currentCommit(sourceRepo);
  const cache = await readCache();
  const cacheKey = cacheKeyForRepo(sourceRepo);
  const cached = cache[cacheKey];
  const cacheHit = cached?.commit === commit;

  const targetNodeModules = join(repoWorkspace, "node_modules");
  if (packageManager === "pnpm") {
    if (await exists(targetNodeModules)) {
      try {
        await unlink(targetNodeModules);
      } catch {
        // existing non-symlink directory is fine
      }
    }
    const install = await runCmd("pnpm", ["install", "--frozen-lockfile"], repoWorkspace);
    if (install.exitCode !== 0) {
      throw new Error(`failed to bootstrap pnpm workspace: ${install.stderr || install.stdout}`);
    }
  } else {
    await mirrorWorkspaceNodeModules(sourceRepo, repoWorkspace);
  }

  await mirrorBuildArtifacts(sourceRepo, repoWorkspace);

  const hydrated_at = new Date().toISOString();
  cache[cacheKey] = { repo_path: sourceRepo, commit, hydrated_at, package_manager: packageManager };
  await writeCache(cache);

  return {
    cache_key: cacheKey,
    commit,
    hydrated_at,
    reused: cacheHit
  };
}

async function ensureWorkspace(req: StepRequest, envelope: ExecutionEnvelope): Promise<WorkspaceContext> {
  assertSafeSegment(req.run_id);
  assertSafeSegment(req.step_id);
  const workdir = resolve(envelope.output_dir);
  await mkdir(workdir, { recursive: true });

  if (!req.repo_path) return { workdir, repoWorkspace: workdir, envelope };

  const absRepo = assertSafeRepoPath(req.repo_path);
  const isGitRepo = await assertGitRepo(absRepo);
  if (!isGitRepo) {
    if (requiresGitRepo(req.kind)) {
      throw new WorkerExecutionError("repo_path must be a git repo for this step kind", {
        statusCode: 400,
        eventType: "policy.violation",
        payload: { violation_kind: "git_repo_required", step_kind: req.kind, repo_path: absRepo },
      });
    }
    return { workdir, repoWorkspace: absRepo, sourceRepo: absRepo, envelope };
  }

  const branchName = req.branch_name ?? `hermes/${req.run_id}`;
  const worktreePath = resolve(envelope.worktree_path);
  await mkdir(dirname(worktreePath), { recursive: true });

  if (!(await exists(worktreePath))) {
    const add = await runCmd("git", ["-C", absRepo, "worktree", "add", "-B", branchName, worktreePath, "HEAD"], absRepo);
    if (add.exitCode !== 0) {
      throw new WorkerExecutionError(`failed to create worktree: ${add.stderr || add.stdout}`, {
        statusCode: 400,
        eventType: "policy.violation",
        payload: { violation_kind: "worktree_creation_failed", repo_path: absRepo, worktree_path: worktreePath },
      });
    }
  }

  const sandbox_cache = await bootstrapWorkspaceDependencies(worktreePath, absRepo);
  return { workdir, repoWorkspace: worktreePath, sourceRepo: absRepo, worktreePath, branchName, envelope, sandbox_cache };
}

async function detectTestCommand(repoWorkspace: string): Promise<TestCommand | null> {
  const packageJsonPath = join(repoWorkspace, "package.json");
  if (await exists(packageJsonPath)) {
    try {
      const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as { scripts?: Record<string, string> };
      if (parsed.scripts?.test) {
        const packageManager = await detectPackageManager(repoWorkspace);
        if (packageManager === "pnpm") return { cmd: "pnpm", args: ["test"], label: "pnpm test", framework: "node-pnpm" };
        if (packageManager === "yarn") return { cmd: "yarn", args: ["test"], label: "yarn test", framework: "node-yarn" };
        if (packageManager === "bun") return { cmd: "bun", args: ["test"], label: "bun test", framework: "node-bun" };
        return { cmd: "npm", args: ["test"], label: "npm test", framework: "node-npm" };
      }
    } catch {
      // ignore parse failure
    }
  }

  if (await exists(join(repoWorkspace, "pytest.ini")) || await exists(join(repoWorkspace, "pyproject.toml"))) {
    return { cmd: "pytest", args: ["-q"], label: "pytest -q", framework: "python-pytest" };
  }
  if (await exists(join(repoWorkspace, "Cargo.toml"))) {
    return { cmd: "cargo", args: ["test"], label: "cargo test", framework: "rust-cargo" };
  }
  if (await exists(join(repoWorkspace, "go.mod"))) {
    return { cmd: "go", args: ["test", "./..."], label: "go test ./...", framework: "go-test" };
  }
  if (await exists(join(repoWorkspace, "Makefile"))) {
    return { cmd: "make", args: ["test"], label: "make test", framework: "make" };
  }
  return null;
}

async function createPlan(workspace: WorkspaceContext) {
  const status = await runCmd("git", ["status", "--short"], workspace.repoWorkspace);
  const commit = workspace.sourceRepo ? await currentCommit(workspace.sourceRepo).catch(() => "unknown") : "none";
  const content = `Plan for repo ${workspace.repoWorkspace}\n\nCommit: ${commit}\nSandbox cache: ${workspace.sandbox_cache?.cache_key ?? "none"}\n\nStatus:\n${(status.stdout || status.stderr || "(clean)").trim()}\n`;
  const artifactPath = join(workspace.workdir, "plan.md");
  await writeFile(artifactPath, content, "utf8");
  return {
    summary: "Generated repo-aware implementation plan",
    confidence: 0.95,
    success: true,
    artifacts: [{
      type: "plan",
      uri: `file://${artifactPath}`,
      content,
      metadata: {
        repo_workspace: workspace.repoWorkspace,
        source_repo: workspace.sourceRepo,
        branch_name: workspace.branchName,
        sandbox_cache: workspace.sandbox_cache
      }
    }]
  } satisfies StepResult;
}

async function createImplementation(workspace: WorkspaceContext, req: StepRequest) {
  const relPath = join(".hermes-harness", "runs", req.run_id, "implementation.json");
  const filePath = join(workspace.repoWorkspace, relPath);
  assertAllowedRepoWrite(workspace, filePath);
  await mkdir(dirname(filePath), { recursive: true });
  const content = JSON.stringify({
    run_id: req.run_id,
    step_id: req.step_id,
    generated_at: new Date().toISOString(),
    branch_name: workspace.branchName,
    repo_workspace: workspace.repoWorkspace,
    source_repo: workspace.sourceRepo,
    bootstrap_cache: workspace.sandbox_cache
  }, null, 2) + "\n";
  await writeFile(filePath, content, "utf8");
  const diff = await runCmd("git", ["diff", "--", relPath], workspace.repoWorkspace);
  const status = await runCmd("git", ["status", "--short", "--", relPath], workspace.repoWorkspace);
  const diffStat = await runCmd("git", ["diff", "--stat", "--", relPath], workspace.repoWorkspace);
  const patchPath = join(workspace.workdir, "patch.diff");
  const patchContent = [status.stdout.trim(), diff.stdout.trim(), content.trim()].filter(Boolean).join("\n\n") + "\n";
  await writeFile(patchPath, patchContent, "utf8");
  return {
    summary: "Created repo-isolated patch artifact from actual workspace mutation",
    confidence: 0.9,
    success: true,
    artifacts: [{
      artifact_id: `art_${req.execution_id}_1`,
      type: "diff",
      uri: `file://${patchPath}`,
      content: patchContent,
      metadata: {
        changed_files: [safeRelativePath(relPath)],
        diff_stat: (diffStat.stdout || diffStat.stderr || "").trim(),
        source_file: safeRelativePath(relPath)
      }
    }]
  } satisfies StepResult;
}

async function runTests(workspace: WorkspaceContext) {
  const detected = await detectTestCommand(workspace.repoWorkspace);
  let report = "";
  let success = false;
  let exitCode = 0;

  if (!detected) {
    report = "No known test runner detected.";
  } else {
    const result = await runCmd(detected.cmd, detected.args, workspace.repoWorkspace);
    report = [`Command: ${detected.label}`, "", result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    success = result.exitCode === 0;
    exitCode = result.exitCode;
  }

  const artifactPath = join(workspace.workdir, "test-report.txt");
  await writeFile(artifactPath, `${report}\n`, "utf8");
  return {
    summary: success ? "Executed repo-aware test command" : detected ? "Test command failed" : "No test command detected",
    confidence: success ? 0.88 : detected ? 0.25 : 0.4,
    success,
    artifacts: [{
      type: "test-report",
      uri: `file://${artifactPath}`,
      content: `${report}\n`,
      metadata: {
        framework: detected?.framework,
        command: detected?.label,
        exit_code: exitCode,
        repo_workspace: workspace.repoWorkspace,
        sandbox_cache: workspace.sandbox_cache
      }
    }]
  } satisfies StepResult;
}

async function review(workspace: WorkspaceContext) {
  const diff = await runCmd("git", ["diff", "--unified=0"], workspace.repoWorkspace);
  const stat = await runCmd("git", ["diff", "--stat"], workspace.repoWorkspace);
  const names = await runCmd("git", ["status", "--short"], workspace.repoWorkspace);
  const changedFiles = (names.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[A-Z? ]+/, "").trim())
    .filter(Boolean);
  const content = `Review for ${workspace.repoWorkspace}\n\nChanged files:\n${changedFiles.join("\n") || "(none)"}\n\nDiff stat:\n${(stat.stdout || stat.stderr || "No diff").trim()}\n\nPatch preview:\n${(diff.stdout || diff.stderr || "No diff").trim()}\n\nGit status:\n${(names.stdout || names.stderr || "clean").trim()}\n`;
  const artifactPath = join(workspace.workdir, "review.md");
  await writeFile(artifactPath, content, "utf8");
  return {
    summary: "Generated review from actual changed files and diff",
    confidence: changedFiles.length > 0 ? 0.86 : 0.5,
    success: changedFiles.length > 0,
    artifacts: [{
      type: "review",
      uri: `file://${artifactPath}`,
      content,
      metadata: {
        changed_files: changedFiles,
        diff_stat: (stat.stdout || stat.stderr || "").trim(),
        changed_file_count: changedFiles.length,
        git_status: (names.stdout || names.stderr || "").trim()
      }
    }]
  } satisfies StepResult;
}

async function buildDeployPlan(repoWorkspace: string): Promise<DeployPlan> {
  const provider = await selectDeployProvider(repoWorkspace);
  if (provider === "vercel") {
    return {
      provider,
      mode: "canary",
      canary_target: `${deployBaseUrl}/vercel-preview`,
      deploy_command: "vercel deploy --prebuilt",
      rollback_command: "vercel rollback",
      requires_approval: true
    };
  }
  if (provider === "render") {
    return {
      provider,
      mode: "canary",
      canary_target: `${deployBaseUrl}/render-canary`,
      deploy_command: "render deploys create",
      rollback_command: "render deploys rollback",
      requires_approval: true
    };
  }
  return {
    provider: "noop-canary",
    mode: "plan_only",
    canary_target: `${deployBaseUrl}/noop-canary`,
    deploy_command: "echo simulate canary deploy",
    rollback_command: "echo simulate rollback",
    requires_approval: true
  };
}

async function deploy(workspace: WorkspaceContext) {
  const plan = await buildDeployPlan(workspace.repoWorkspace);
  const content = `Deploy adapter: ${plan.provider}\nMode: ${plan.mode}\nCanary target: ${plan.canary_target}\nDeploy command: ${plan.deploy_command}\nRollback command: ${plan.rollback_command}\nApproval required: ${String(plan.requires_approval)}\n`;
  const artifactPath = join(workspace.workdir, "deploy.txt");
  await writeFile(artifactPath, content, "utf8");
  return {
    summary: "Prepared deploy plan artifact",
    confidence: 0.81,
    success: true,
    artifacts: [{
      type: "deploy-note",
      uri: `file://${artifactPath}`,
      content,
      metadata: plan
    }]
  } satisfies StepResult;
}

export async function cleanupRun(runId: string, sourceRepo?: string, branchName?: string) {
  assertSafeSegment(runId);
  const target = join(worktreesRoot, runId);
  if (sourceRepo && await assertGitRepo(sourceRepo) && await exists(target)) {
    await runCmd("git", ["-C", sourceRepo, "worktree", "remove", "--force", target], sourceRepo);
    await runCmd("git", ["-C", sourceRepo, "worktree", "prune"], sourceRepo);
    if (branchName) {
      await runCmd("git", ["-C", sourceRepo, "branch", "-D", branchName], sourceRepo);
    }
  }
  if (await exists(target)) await rm(target, { recursive: true, force: true });
  return { ok: true, removed: target };
}

app.use("*", cors());

app.get("/health", (c) => c.json({ ok: true, service: "worker-runtime", allowed_repo_root: allowedRepoRoot }));

app.post("/api/execute-step", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  const body = await c.req.json<StepRequest>();
  try {
    const envelope = validateEnvelope(body);
    const workspace = await ensureWorkspace(body, envelope);
    let result: StepResult;
    const execute = async () => {
      if (body.kind === "plan") return createPlan(workspace);
      if (body.kind === "implement") return createImplementation(workspace, body);
      if (body.kind === "test") return runTests(workspace);
      if (body.kind === "review") return review(workspace);
      return deploy(workspace);
    };
    result = await Promise.race([
      execute(),
      new Promise<StepResult>((_, reject) => setTimeout(() => reject(new WorkerExecutionError(`step execution timed out after ${envelope.timeout_seconds}s`, {
        statusCode: 408,
        eventType: "execution.timeout",
        payload: { timeout_seconds: envelope.timeout_seconds },
        started: true,
      })), envelope.timeout_seconds * 1000))
    ]);
    enforceBudget(body, result);
    const step_events = buildStepEvents(body, result);
    return c.json({ run_id: body.run_id, mission_id: body.mission_id, execution_id: body.execution_id, step_id: body.step_id, ...workspace, ...result, step_events });
  } catch (error) {
    const workerError = error instanceof WorkerExecutionError
      ? error
      : new WorkerExecutionError(String(error instanceof Error ? error.message : error), { started: true, eventType: "tool.failed" });
    return c.json({
      run_id: body.run_id,
      mission_id: body.mission_id,
      execution_id: body.execution_id,
      step_id: body.step_id,
      success: false,
      confidence: 0,
      summary: workerError.message,
      artifacts: [],
      error_code: workerError.eventType,
      step_events: buildFailureEvents(body, workerError)
    }, workerError.statusCode as 400 | 408);
  }
});

app.post("/api/cleanup-run", async (c) => {
  const authError = requireOperator(c);
  if (authError) return authError;
  const body = await c.req.json<{ run_id: string; source_repo?: string; branch_name?: string }>();
  const result = await cleanupRun(body.run_id, body.source_repo, body.branch_name);
  return c.json(result);
});

if (!process.env.VITEST) {
  serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 4304) });
  console.log("worker-runtime listening on http://localhost:4304");
}

export { app, ensureWorkspace, detectTestCommand, bootstrapWorkspaceDependencies };
