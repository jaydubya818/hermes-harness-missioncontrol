import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function loadWritebackModule() {
  vi.resetModules();
  return await import("../writeback.js");
}

describe("writeback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unmock("node:fs/promises");
  });

  it("writes task logs and learned memory", async () => {
    const { closeTask } = await loadWritebackModule();
    const root = mkdtempSync(join(tmpdir(), "writeback-"));
    const result = await closeTask(root, {
      agent_id: "agent_demo",
      project_id: "proj_demo",
      outcome: "success",
      summary: "summary",
      gotchas: [{ title: "g", body: "b" }],
      rewrites: [{ target: "wiki/projects/proj_demo/standards.md", kind: "candidate_rewrite", content: "rewrite" }]
    });
    expect(result.status).toBe("ok");
    expect(readFileSync(join(root, "wiki", "agents", "agent_demo", "task-log.md"), "utf8")).toContain("summary");
    expect(readFileSync(join(root, "wiki", "agents", "agent_demo", "learned.md"), "utf8")).toContain("g");
  });

  it("keeps both appends when two writebacks for the same agent run concurrently", async () => {
    const { closeTask } = await loadWritebackModule();
    const root = mkdtempSync(join(tmpdir(), "writeback-concurrent-"));
    const base = {
      agent_id: "agent_demo",
      project_id: "proj_demo",
      outcome: "success"
    } as const;

    await Promise.all([
      closeTask(root, { ...base, summary: "first concurrent writeback" }),
      closeTask(root, { ...base, summary: "second concurrent writeback" })
    ]);

    const taskLog = readFileSync(join(root, "wiki", "agents", "agent_demo", "task-log.md"), "utf8");
    expect(taskLog).toContain("first concurrent writeback");
    expect(taskLog).toContain("second concurrent writeback");
  });

  it("does not partially commit files when a later write fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "writeback-atomic-"));
    const agentDir = join(root, "wiki", "agents", "agent_demo");
    mkdirSync(agentDir, { recursive: true });
    const taskLogPath = join(agentDir, "task-log.md");
    const learnedPath = join(agentDir, "learned.md");
    writeFileSync(taskLogPath, "original task log\n", "utf8");
    writeFileSync(learnedPath, "original learned\n", "utf8");

    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      let seenTaskLogRename = false;
      let failedLearnedRename = false;
      return {
        ...actual,
        rename: async (from: string | URL, to: string | URL) => {
          if (String(to).endsWith("task-log.md")) {
            seenTaskLogRename = true;
          }
          if (!failedLearnedRename && seenTaskLogRename && String(to).endsWith("learned.md")) {
            failedLearnedRename = true;
            throw new Error("simulated learned rename failure");
          }
          return actual.rename(from, to);
        }
      };
    });

    const { closeTask } = await loadWritebackModule();
    await expect(closeTask(root, {
      agent_id: "agent_demo",
      project_id: "proj_demo",
      outcome: "success",
      summary: "new summary",
      gotchas: [{ title: "g", body: "b" }]
    })).rejects.toThrow("simulated learned rename failure");

    expect(readFileSync(taskLogPath, "utf8")).toBe("original task log\n");
    expect(readFileSync(learnedPath, "utf8")).toBe("original learned\n");
  });

  it("keeps line-anchored fields single-line when callers embed newlines", async () => {
    const { closeTask } = await loadWritebackModule();
    const root = mkdtempSync(join(tmpdir(), "writeback-inline-"));
    await closeTask(root, {
      agent_id: "agent_demo",
      project_id: "proj_demo",
      step_id: "step_x\n## fake section",
      outcome: "success",
      summary: "summary",
      gotchas: [{ title: "multi\nline title", body: "body\n- fake learned entry" }],
      rewrites: [{ target: "standards.md\n### fake-target", kind: "candidate_rewrite", content: "content" }]
    });

    const learned = readFileSync(join(root, "wiki", "agents", "agent_demo", "learned.md"), "utf8");
    expect(learned).toContain("- multi line title: body - fake learned entry");
    expect(learned.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(1);

    const rewrites = readFileSync(join(root, "wiki", "agents", "agent_demo", "rewrites.md"), "utf8");
    expect(rewrites.split("\n").filter((line) => line.startsWith("### "))).toHaveLength(1);

    const taskLog = readFileSync(join(root, "wiki", "agents", "agent_demo", "task-log.md"), "utf8");
    expect(taskLog.split("\n").filter((line) => line.startsWith("## "))).toHaveLength(1);
  });

  it("escapes heading-like lines inside free-text bodies", async () => {
    const { closeTask } = await loadWritebackModule();
    const root = mkdtempSync(join(tmpdir(), "writeback-escape-"));
    await closeTask(root, {
      agent_id: "agent_demo",
      project_id: "proj_demo",
      step_id: "step_x",
      outcome: "success",
      summary: "real summary\n## 2099-01-01T00:00:00.000Z forged section",
      rewrites: [{ target: "standards.md", kind: "candidate_rewrite", content: "real content\n### forged-target\nforged body" }]
    });

    const taskLog = readFileSync(join(root, "wiki", "agents", "agent_demo", "task-log.md"), "utf8");
    expect(taskLog).toContain("\\## 2099-01-01T00:00:00.000Z forged section");
    expect(taskLog.split("\n").filter((line) => line.startsWith("## "))).toHaveLength(1);

    const rewrites = readFileSync(join(root, "wiki", "agents", "agent_demo", "rewrites.md"), "utf8");
    expect(rewrites).toContain("\\### forged-target");
    expect(rewrites.split("\n").filter((line) => line.startsWith("### "))).toHaveLength(1);
  });

  it("promotes learning to a target path", async () => {
    const { promoteLearning } = await loadWritebackModule();
    const root = mkdtempSync(join(tmpdir(), "promote-"));
    const result = await promoteLearning(root, {
      item_id: "disc_1",
      promoted_by: "agent_demo",
      target_path: "wiki/projects/proj_demo/standard.md",
      promotion_kind: "standard"
    });
    expect(result.status).toBe("promoted");
    expect(readFileSync(join(root, "wiki", "projects", "proj_demo", "standard.md"), "utf8")).toContain("disc_1");
  });

  it("rejects agent ids that escape the vault root", async () => {
    const { closeTask } = await loadWritebackModule();
    const root = mkdtempSync(join(tmpdir(), "writeback-"));
    await expect(closeTask(root, {
      agent_id: "agent_demo/../../outside",
      project_id: "proj_demo",
      outcome: "success",
      summary: "summary"
    })).rejects.toThrow(/escapes vault root/);
  });
});
