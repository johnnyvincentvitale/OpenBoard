import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { BOARD_SERVER_DEFAULTS } from "./src/shared/opencode-defaults";

const boardServer = `http://127.0.0.1:${BOARD_SERVER_DEFAULTS.port}`;

// Dev server proxies /api (REST + SSE) to the board's Hono server, so the browser
// talks same-origin and no CORS is involved.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: boardServer, changeOrigin: true },
    },
  },
  build: { outDir: "dist/web" },
});
