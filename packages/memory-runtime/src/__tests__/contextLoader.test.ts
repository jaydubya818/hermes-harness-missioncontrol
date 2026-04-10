import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadContextBundle } from "../contextLoader.js";

describe("loadContextBundle", () => {
  it("loads files within budget", async () => {
    const root = mkdtempSync(join(tmpdir(), "memrt-"));
    mkdirSync(join(root, "wiki", "agents", "agent_demo"), { recursive: true });
    mkdirSync(join(root, "wiki", "projects", "proj_demo"), { recursive: true });
    writeFileSync(join(root, "wiki", "agents", "agent_demo", "profile.md"), "profile");
    writeFileSync(join(root, "wiki", "agents", "agent_demo", "hot.md"), "hot");
    writeFileSync(join(root, "wiki", "projects", "proj_demo", "standards.md"), "std");
    const res = await loadContextBundle(root, { agent_id: "agent_demo", agent_role: "coder", project_id: "proj_demo", budget_bytes: 1000 });
    expect(res.files.length).toBeGreaterThan(0);
  });
});
