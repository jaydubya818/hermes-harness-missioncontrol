import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeRepoPath, cleanupRun, detectTestCommand, ensureWorkspace } from "./index.js";

const sandboxRoot = "/Users/jaywest/projects/hermes-worker-runtime-test";

afterEach(async () => {
  await rm(sandboxRoot, { recursive: true, force: true });
});

describe("worker-runtime", () => {
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

    await expect(ensureWorkspace({ run_id: "run_safe", step_id: "implement", kind: "implement", repo_path: repo })).rejects.toThrow(/git repo/);
  });

  it("cleans up run directories even without git metadata", async () => {
    const runId = "run_cleanup";
    const target = join(process.cwd(), "../../data/worktrees", runId);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "marker.txt"), "ok", "utf8");

    await expect(cleanupRun(runId)).resolves.toMatchObject({ ok: true });
  });
});
