import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { assertOperatorTokenNotBundled } from "./src/operatorTokenGuard.js";

export default defineConfig(({ command, mode }) => {
  // loadEnv() rather than process.env: it returns the same union Vite itself
  // inlines -- the .env files for this mode plus any VITE_* already in the
  // process environment -- so a token supplied through a .env file cannot
  // slip past the guard. envDir mirrors Vite's own default (config.root,
  // which defaults to cwd) so the two stay in lockstep.
  assertOperatorTokenNotBundled(
    command,
    loadEnv(mode, process.cwd()),
    process.env.ALLOW_OPERATOR_TOKEN_IN_BUNDLE
  );

  return {
    plugins: [react()],
    server: {
      proxy: {
        "/orchestrator": {
          target: "http://localhost:4302",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/orchestrator/, "")
        },
        "/memory": {
          target: "http://localhost:4301",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/memory/, "")
        },
        "/eval": {
          target: "http://localhost:4303",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/eval/, "")
        }
      }
    }
  };
});
