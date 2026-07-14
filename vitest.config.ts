import { configDefaults, defineConfig } from "vitest/config";

// Note: test-file selection (excluding test/integration) is done via the CLI --exclude
// flag in the `test` script, NOT here — so `test:integration` can still target that dir.
// Agent-generated worktrees can be nested under the repo root during agent runs;
// exclude them centrally so root-level test and coverage discovery do not collect
// duplicate tests or native-module installs from those generated checkouts.
export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      "**/.opencode-board-worktrees/**",
      "**/.claude/worktrees/**",
    ],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: [
        "src/server/serve.ts",
        "src/server/routes/task-events.ts",
        "src/mcp/server.ts",
        "src/tui/index.ts",
        "src/tui/launcher.ts",
        "**/*.d.ts",
      ],
      reporter: ["text-summary"],
      thresholds: { statements: 78, branches: 70, functions: 78, lines: 80 },
    },
  },
});
