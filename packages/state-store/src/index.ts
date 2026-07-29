import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function loadJsonFile<T>(path: string, fallback: T): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    // A missing file is expected on first run, but an unparseable file means
    // existing state would be silently discarded (and overwritten on the next
    // save). Surface that instead of hiding it.
    console.warn(`state-store: failed to parse ${path}; falling back to default state (${String(error)})`);
    return fallback;
  }
}

export async function saveJsonFile<T>(path: string, value: T): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = join(dirname(path), `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  try {
    await writeFile(tmpPath, JSON.stringify(value, null, 2), "utf8");
    await rename(tmpPath, path);
  } catch (error) {
    // A failed write/rename must not leave orphaned .tmp files accumulating
    // next to the state file.
    await rm(tmpPath, { force: true });
    throw error;
  }
}
