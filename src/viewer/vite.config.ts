import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev proxies target the `npm run dev` server (CORTEX_VIEWER_PORT=3334).
// Build output is COMMITTED (served by src/mcp-server/api.ts as /viewer/*).
export default defineConfig({
  plugins: [react()],
  base: "/viewer/",
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/api": "http://localhost:3334",
      "/ws": { target: "ws://localhost:3334", ws: true },
    },
  },
});
