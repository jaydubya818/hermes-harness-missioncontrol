import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
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
});
