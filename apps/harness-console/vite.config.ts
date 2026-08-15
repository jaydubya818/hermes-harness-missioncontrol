import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => {
  // `vite build` inlines every VITE_* variable into the emitted JS as clear
  // text. VITE_OPERATOR_TOKEN is the bearer token guarding every mutating
  // API, so baking it into a static bundle hands full control-plane access
  // to anyone who can fetch the console's assets. The dev server keeps the
  // convenience -- it never writes a bundle to disk -- and operators can
  // always paste the token into Settings, which stores it in localStorage.
  if (command === "build" && process.env.VITE_OPERATOR_TOKEN && process.env.ALLOW_OPERATOR_TOKEN_IN_BUNDLE !== "1") {
    throw new Error(
      "VITE_OPERATOR_TOKEN is set during `vite build`: it would be inlined into the console bundle in clear text. "
      + "Unset it and enter the token in the console's Settings tab instead, "
      + "or set ALLOW_OPERATOR_TOKEN_IN_BUNDLE=1 if you really intend to ship it."
    );
  }

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
