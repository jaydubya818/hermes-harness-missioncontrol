import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, assertSafeRepoPath, cleanupRun, detectTestCommand, ensureWorkspace } from "./index.js";

const sandboxRoot = "/Users/jaywest/projects/hermes-worker-runtime-test";

function buildEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    worktree_path: join(process.cwd(), "../../data/worktrees/run_contracts"),
    workspace_root: "/Users/jaywest/projects",
    repo_scope: {
      root_path: "/Users/jaywest/projects",
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

  it("rejects repo paths outside the allowed root", () => {
    expect(() => assertSafeRepoPath("/tmp/not-allowed")).toThrow(/allowed root/);
  });

  it("detects pnpm test commands from package metadata", async () => {
    const repo = join(sandboxRoot, "repo-a");
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }), "utf8");
    await writeFile(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

    await expect(detectTestCommand(repo)).resolves.toEqual({ cmd: "pnpm", args: ["test"], label: "pnpm test", framework: "node-pnpm" });
  });

  it("refuses write-capable steps for non-git repos", async () => {
    const repo = join(sandboxRoot, "repo-b");
    await mkdir(repo, { recursive: true });
    const envelope = buildEnvelope({ output_dir: join(process.cwd(), "../../data/worker-runs/run_safe/implement") }) as any;

    await expect(ensureWorkspace({ mission_id: "mis_safe", run_id: "run_safe", step_id: "implement", execution_id: "exec_safe", kind: "implement", repo_path: repo, envelope } as any, envelope)).rejects.toThrow(/git repo/);
  });

  it("cleans up run directories even without git metadata", async () => {
    const runId = "run_cleanup";
    const target = join(process.cwd(), "../../data/worktrees", runId);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "marker.txt"), "ok", "utf8");

    await expect(cleanupRun(runId)).resolves.toMatchObject({ ok: true });
  });
});
