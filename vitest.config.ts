import { defineConfig } from "vitest/config";

// Note: test-file selection (excluding test/integration) is done via the CLI --exclude
// flag in the `test` script, NOT here — so `test:integration` can still target that dir.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: [
        "src/index.ts",
        "src/server/serve.ts",
        "src/server/routes/board-events.ts",
        "src/server/routes/task-events.ts",
        "src/mcp/server.ts",
        "src/web/main.tsx",
        "src/web/App.tsx",
        "src/web/api/taskSse.ts",
        "src/tui/index.ts",
        "src/tui/launcher.ts",
        "**/*.d.ts",
      ],
      reporter: ["text-summary"],
      thresholds: { statements: 78, branches: 70, functions: 78, lines: 80 },
    },
  },
});
