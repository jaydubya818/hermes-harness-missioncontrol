import { join } from "node:path";
import { tmpdir } from "node:os";
import { defineConfig } from "vitest/config";

// The worker reads ALLOWED_REPO_ROOT at module load. Default it to a
// writable temp directory so the suite is portable across machines/CI
// instead of assuming a specific developer home directory.
export default defineConfig({
  test: {
    env: {
      ALLOWED_REPO_ROOT: process.env.ALLOWED_REPO_ROOT ?? join(tmpdir(), "hermes-worker-runtime-allowed"),
      WORKSPACE_CACHE_FILE: process.env.WORKSPACE_CACHE_FILE ?? join(tmpdir(), "hermes-worker-runtime-cache.json"),
    },
  },
});
