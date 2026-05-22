import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTerminal, TerminalToolError } from "./index.js";

let workspace: string;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "terminal-tool-test-"));
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("terminal-tool", () => {
  it("runs a safe command inside the workspace and captures stdout", async () => {
    const result = await runTerminal({
      command: "echo hermes",
      cwd: workspace,
      workspaceRoot: workspace,
    });
    expect(result.exit_code).toBe(0);
    expect(result.stdout.trim()).toBe("hermes");
    expect(result.blocked_reason).toBeUndefined();
  });

  it("blocks dangerous commands and never spawns them", async () => {
    const result = await runTerminal({
      command: "rm -rf /",
      cwd: workspace,
      workspaceRoot: workspace,
    });
    expect(result.exit_code).toBe(-1);
    expect(result.blocked_reason).toContain("blocked pattern");
  });

  it("refuses cwd outside workspace root", async () => {
    await expect(
      runTerminal({ command: "ls", cwd: "/tmp", workspaceRoot: workspace })
    ).rejects.toBeInstanceOf(TerminalToolError);
  });

  it("returns timeout exit code 124 when command exceeds timeout", async () => {
    const result = await runTerminal({
      command: "sleep 5",
      cwd: workspace,
      workspaceRoot: workspace,
      timeoutMs: 50,
    });
    expect(result.exit_code).toBe(124);
    expect(result.stderr).toContain("timeout");
  });
});
