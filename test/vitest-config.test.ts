import { describe, expect, it } from "vitest";

import vitestConfig from "../vitest.config";

describe("vitest config", () => {
  it("excludes nested agent worktrees from normal discovery", () => {
    const exclude = vitestConfig.test?.exclude ?? [];

    expect(exclude).toContain("**/.opencode-board-worktrees/**");
    expect(exclude).toContain("**/.claude/worktrees/**");
  });
});
