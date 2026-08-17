import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

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

// Writes to one state file are not atomic against each other: each call
// stringifies, writes a uniquely named temp file, then renames it over the
// target. Two overlapping saves therefore race on the rename, and the one
// that started first can land last -- publishing its older snapshot and
// silently dropping whatever the newer save had already recorded (a mission
// event, an eval record). The services call this after every mutation
// without awaiting each other, so serialize per path: queued saves still
// stringify at write time, so the last one to run always publishes current
// state.
const saveQueues = new Map<string, Promise<unknown>>();

export function saveJsonFile<T>(path: string, value: T): Promise<void> {
  const key = resolve(path);
  const previous = saveQueues.get(key) ?? Promise.resolve();
  const save = previous.then(() => writeJsonFile(path, value));
  const queued = save.catch(() => undefined).then(() => {
    // Drop the entry once this is the tail, so the map cannot grow with
    // every distinct state file a long-lived process touches.
    if (saveQueues.get(key) === queued) saveQueues.delete(key);
  });
  saveQueues.set(key, queued);
  return save;
}

async function writeJsonFile<T>(path: string, value: T): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmpPath = join(dir, `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  try {
    // write-then-rename is only atomic against a *reader*: without an fsync
    // the rename can reach disk before the data does, so a crash or power
    // loss leaves a valid-looking but truncated state file. loadJsonFile then
    // falls back to empty state and the next save overwrites it -- the whole
    // mission history disappears silently. Flush the contents before the
    // rename publishes them, then flush the directory entry itself.
    const handle = await open(tmpPath, "w");
    try {
      await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpPath, path);
    const dirHandle = await open(dir, "r").catch(() => null);
    if (dirHandle) {
      // Directory fsync is unsupported on some platforms (notably Windows);
      // the file contents are already durable, so a failure here is benign.
      await dirHandle.sync().catch(() => undefined);
      await dirHandle.close();
    }
  } catch (error) {
    // A failed write/rename must not leave orphaned .tmp files accumulating
    // next to the state file.
    await rm(tmpPath, { force: true });
    throw error;
  }
}
