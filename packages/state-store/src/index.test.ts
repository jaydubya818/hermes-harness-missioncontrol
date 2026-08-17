import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadJsonFile, saveJsonFile } from "./index.js";

// Records which paths saveJsonFile fsyncs. ESM namespaces are not spy-able,
// so wrap open() at module-resolution time instead.
const syncedTargets: string[] = [];
// Lets one test hold the first rename open so an unserialized second save can
// overtake it; the publish race is otherwise timing-dependent.
const renameHooks: { delayFirstMs: number } = { delayFirstMs: 0 };
let renameCount = 0;
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      renameCount += 1;
      if (renameCount === 1 && renameHooks.delayFirstMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, renameHooks.delayFirstMs));
      }
      return actual.rename(from, to);
    },
    open: async (path: Parameters<typeof actual.open>[0], ...rest: unknown[]) => {
      const handle = await (actual.open as (...args: unknown[]) => Promise<Awaited<ReturnType<typeof actual.open>>>)(path, ...rest);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        syncedTargets.push(String(path));
        return sync();
      };
      return handle;
    },
  };
});

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

  it("flushes contents to disk before publishing the rename", async () => {
    const dir = mkdtempSync(join(tmpdir(), "state-store-"));
    const file = join(dir, "state.json");

    await saveJsonFile(file, { ok: true });

    // The temp file must be fsynced before the rename that publishes it, and
    // the directory entry fsynced after; otherwise a crash can leave a
    // valid-looking but truncated state file behind.
    expect(syncedTargets.some((target) => target.endsWith(".tmp"))).toBe(true);
    expect(syncedTargets.indexOf(dir)).toBeGreaterThan(syncedTargets.findIndex((target) => target.endsWith(".tmp")));
    expect(await loadJsonFile(file, { ok: false })).toEqual({ ok: true });
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toHaveLength(0);
  });

  it("publishes the newest snapshot when saves to one file overlap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "state-store-"));
    const file = join(dir, "state.json");
    renameCount = 0;
    renameHooks.delayFirstMs = 300;

    try {
      // Unserialized, the first save's rename can land after the second's and
      // publish its older snapshot, silently dropping the newer record.
      const first = saveJsonFile(file, [1]);
      const second = saveJsonFile(file, [1, 2]);
      await Promise.all([first, second]);
    } finally {
      renameHooks.delayFirstMs = 0;
    }

    expect(await loadJsonFile<number[]>(file, [])).toEqual([1, 2]);
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
