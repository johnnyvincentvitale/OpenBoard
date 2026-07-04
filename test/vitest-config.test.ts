import { describe, expect, it } from "vitest";

import vitestConfig from "../vitest.config";

describe("vitest config", () => {
  it("excludes OpenBoard-generated worktrees from normal discovery", () => {
    const exclude = vitestConfig.test?.exclude ?? [];

    expect(exclude).toContain("**/.opencode-board-worktrees/**");
  });
});
