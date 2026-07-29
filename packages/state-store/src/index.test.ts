import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadJsonFile, saveJsonFile } from "./index.js";

describe("state-store", () => {
  it("persists json data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "state-store-"));
    const file = join(dir, "state.json");
    await saveJsonFile(file, { ok: true });
    const value = await loadJsonFile(file, { ok: false });
    expect(value.ok).toBe(true);
  });

  it("removes the temp file when the atomic save fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "state-store-"));
    // Renaming a file over an existing directory fails, simulating a failed
    // final rename step.
    const target = join(dir, "state.json");
    mkdirSync(target);

    await expect(saveJsonFile(target, { ok: true })).rejects.toThrow();
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toHaveLength(0);
  });

  it("returns fallback and warns when the state file is corrupt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), "state-store-"));
    const file = join(dir, "state.json");
    writeFileSync(file, "{ not json", "utf8");

    const value = await loadJsonFile(file, { ok: false });
    expect(value).toEqual({ ok: false });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("returns fallback without warning when the state file is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), "state-store-"));

    const value = await loadJsonFile(join(dir, "missing.json"), { ok: false });
    expect(value).toEqual({ ok: false });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
