import { defineConfig } from "vitest/config";

// Note: test-file selection (excluding test/integration) is done via the CLI --exclude
// flag in the `test` script, NOT here — so `test:integration` can still target that dir.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/web/main.tsx", "src/server/serve.ts", "src/index.ts", "**/*.d.ts"],
      reporter: ["text-summary"],
      thresholds: { statements: 78, branches: 70, functions: 78, lines: 80 },
    },
  },
});
