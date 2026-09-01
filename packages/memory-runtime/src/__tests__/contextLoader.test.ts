import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadContextBundle } from "../contextLoader.js";
import { MEMORY_CLASSES } from "../memoryClasses.js";
import type { ContextRequest } from "@hermes-harness-with-missioncontrol/shared-types";

const request: ContextRequest = { agent_id: "agent_demo", agent_role: "coder", project_id: "proj_demo", budget_bytes: 1000 };

function seedVault(root: string) {
  mkdirSync(join(root, "wiki", "agents", "agent_demo"), { recursive: true });
  mkdirSync(join(root, "wiki", "projects", "proj_demo"), { recursive: true });
  writeFileSync(join(root, "wiki", "agents", "agent_demo", "profile.md"), "profile");
  writeFileSync(join(root, "wiki", "agents", "agent_demo", "hot.md"), "hot");
  writeFileSync(join(root, "wiki", "projects", "proj_demo", "standards.md"), "std");
  writeFileSync(join(root, "wiki", "projects", "proj_demo", "recipes.md"), "recipes");
}

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

  it("classifies each candidate and accounts for the bytes it kept", async () => {
    const root = mkdtempSync(join(tmpdir(), "memrt-"));
    mkdirSync(join(root, "wiki", "agents", "agent_demo"), { recursive: true });
    mkdirSync(join(root, "wiki", "projects", "proj_demo"), { recursive: true });
    writeFileSync(join(root, "wiki", "agents", "agent_demo", "profile.md"), "profile");
    writeFileSync(join(root, "wiki", "agents", "agent_demo", "hot.md"), "hot");
    writeFileSync(join(root, "wiki", "projects", "proj_demo", "standards.md"), "std");
    writeFileSync(join(root, "wiki", "projects", "proj_demo", "recipes.md"), "recipes");

    const res = await loadContextBundle(root, { agent_id: "agent_demo", agent_role: "coder", project_id: "proj_demo", budget_bytes: 1000 });

    // memory-api hands this bundle straight to consumers, so the class of
    // each file (and the budget accounting behind it) is part of the
    // contract, not an implementation detail.
    expect(res.files.map((file) => file.memory_class)).toEqual(["profile", "hot", "learned", "learned"]);
    expect(res.budget_used).toBe("profile".length + "hot".length + "std".length + "recipes".length);
    expect(res.truncated).toBe(false);
    expect(res.trace.excluded).toEqual([]);
    // priority is 1-based and matches the order files were packed.
    expect(res.files.map((file) => file.priority)).toEqual([1, 2, 3, 4]);
    expect(res.trace.included.map((item) => item.priority)).toEqual([1, 2, 3, 4]);
    expect(res.bundle_id.startsWith("ctx_")).toBe(true);
  });

  it("marks the bundle truncated and records why each candidate was dropped", async () => {
    const root = mkdtempSync(join(tmpdir(), "memrt-"));
    mkdirSync(join(root, "wiki", "agents", "agent_demo"), { recursive: true });
    mkdirSync(join(root, "wiki", "projects", "proj_demo"), { recursive: true });
    writeFileSync(join(root, "wiki", "agents", "agent_demo", "profile.md"), "12345");
    writeFileSync(join(root, "wiki", "agents", "agent_demo", "hot.md"), "way too long for the budget");
    // standards.md is deliberately absent: "missing" and "budget" are
    // different exclusion reasons and consumers distinguish them.
    writeFileSync(join(root, "wiki", "projects", "proj_demo", "recipes.md"), "ok");

    const res = await loadContextBundle(root, { agent_id: "agent_demo", agent_role: "coder", project_id: "proj_demo", budget_bytes: 8 });

    expect(res.files.map((file) => file.path.split("/").pop())).toEqual(["profile.md", "recipes.md"]);
    expect(res.budget_used).toBe(7);
    expect(res.truncated).toBe(true);
    const reasons = Object.fromEntries(res.trace.excluded.map((item) => [item.path.split("/").pop(), item.reason]));
    expect(reasons["hot.md"]).toBe("budget");
    expect(reasons["standards.md"]).toBe("missing");
  });

  it("counts the budget in bytes, not characters", async () => {
    const root = mkdtempSync(join(tmpdir(), "memrt-"));
    mkdirSync(join(root, "wiki", "agents", "agent_demo"), { recursive: true });
    mkdirSync(join(root, "wiki", "projects", "proj_demo"), { recursive: true });
    // Four characters, ten UTF-8 bytes: a character-counted budget would
    // have let this through and blown past the caller's real limit.
    writeFileSync(join(root, "wiki", "agents", "agent_demo", "profile.md"), "\u00e9\u00e9\u00e9\u00e9\u00e9");

    const res = await loadContextBundle(root, { agent_id: "agent_demo", agent_role: "coder", project_id: "proj_demo", budget_bytes: 5 });

    expect(res.files).toEqual([]);
    expect(res.budget_used).toBe(0);
    expect(res.truncated).toBe(true);
  });

  it("rejects agent or project ids that escape the vault root", async () => {
    const root = mkdtempSync(join(tmpdir(), "memrt-"));
    await expect(loadContextBundle(root, { agent_id: "agent_demo/../../../etc", agent_role: "coder", project_id: "proj_demo", budget_bytes: 1000 }))
      .rejects.toThrow(/escapes vault root/);
    await expect(loadContextBundle(root, { agent_id: "agent_demo", agent_role: "coder", project_id: "proj_demo/../..", budget_bytes: 1000 }))
      .rejects.toThrow(/escapes vault root/);
  });

  // classify() matches on substrings of the path it is handed, and
  // loadContextBundle hands it the fully-resolved *host* path -- the same
  // absolute paths the open "stop returning absolute host paths" item is
  // about. The substrings it looks for ("rewrites", "task-log", "learned",
  // "/projects/") are vault-relative concepts, so any host directory that
  // happens to contain one of them silently reclassifies every project file
  // in the bundle. Pinned, not fixed: memory-api returns memory_class
  // verbatim to the console, so changing it is a response-behaviour change.
  it("classifies from the absolute host path, so the vault's own location changes the class", async () => {
    const neutral = mkdtempSync(join(tmpdir(), "memrt-neutral-"));
    seedVault(neutral);
    const neutralRes = await loadContextBundle(neutral, request);
    expect(neutralRes.files.map((file) => file.memory_class)).toEqual(["profile", "hot", "learned", "learned"]);

    // Identical vault contents, identical request -- only the directory the
    // vault sits in differs.
    const base = mkdtempSync(join(tmpdir(), "memrt-host-"));
    const nested = join(base, "rewrites", "vault");
    mkdirSync(nested, { recursive: true });
    seedVault(nested);
    const nestedRes = await loadContextBundle(nested, request);

    expect(nestedRes.files.map((file) => file.memory_class)).toEqual(["profile", "hot", "rewrite", "rewrite"]);
  });

  // MemoryClass reserves a "bus" class and MEMORY_CLASSES gives it a
  // bus.md default file, but loadContextBundle's candidate list is only
  // profile.md, hot.md, standards.md and recipes.md -- and every one of
  // those is caught by an earlier branch of classify(). The "bus" fallthrough
  // is therefore dead for every bundle this function can produce.
  it("never yields the \"bus\" class, even though MEMORY_CLASSES defines one", async () => {
    expect(MEMORY_CLASSES.bus).toEqual({ appendOnly: true, defaultFile: "bus.md" });

    const root = mkdtempSync(join(tmpdir(), "memrt-bus-"));
    seedVault(root);
    const res = await loadContextBundle(root, request);

    expect(res.files).toHaveLength(4);
    expect(res.files.map((file) => file.memory_class)).not.toContain("bus");
    expect(res.trace.included.map((item) => item.class)).not.toContain("bus");
  });
});
