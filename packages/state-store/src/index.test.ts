import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
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
