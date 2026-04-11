import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeTask, promoteLearning } from "../writeback.js";

describe("writeback", () => {
  it("writes task logs and learned memory", async () => {
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

  it("promotes learning to a target path", async () => {
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
});
