import { describe, expect, it } from "vitest";
import { formatDiffStat } from "../../src/tui/diff-stat";
import type { DiffResponse } from "../../src/shared/task";

describe("formatDiffStat", () => {
  it("aggregates file count, additions, and deletions for a multi-file diff", () => {
    const response: DiffResponse = {
      kind: "diff",
      capped: false,
      root: "/tmp/test",
      files: [
        { file: "src/a.ts", additions: 5, deletions: 2, status: "modified" },
        { file: "src/b.ts", additions: 10, deletions: 3, status: "modified" },
        { file: "src/c.ts", additions: 0, deletions: 1, status: "deleted" },
      ],
    };
    expect(formatDiffStat(response)).toBe("3 files · +15 -6 ›");
  });

  it("renders an explicit zero/no-change state for an empty file list", () => {
    const response: DiffResponse = {
      kind: "diff",
      capped: false,
      root: "/tmp/test",
      files: [],
    };
    expect(formatDiffStat(response)).toBe("0 files · +0 -0 ›");
  });

  it("counts binary entries in the file total with zero additions and deletions", () => {
    const response: DiffResponse = {
      kind: "diff",
      capped: false,
      root: "/tmp/test",
      files: [
        { file: "img.png", additions: 0, deletions: 0, status: "modified" },
        { file: "src/a.ts", additions: 3, deletions: 1, status: "modified" },
      ],
    };
    expect(formatDiffStat(response)).toBe("2 files · +3 -1 ›");
  });

  it("counts rename-only entries in the file total with zero counts", () => {
    // Renames show as modified with zero additions/deletions (content unchanged).
    const response: DiffResponse = {
      kind: "diff",
      capped: false,
      root: "/tmp/test",
      files: [
        { file: "new.ts", additions: 0, deletions: 0, status: "modified" },
      ],
    };
    expect(formatDiffStat(response)).toBe("1 files · +0 -0 ›");
  });

  it("handles a mix of modified, added, and deleted files", () => {
    const response: DiffResponse = {
      kind: "diff",
      capped: false,
      root: "/tmp/test",
      files: [
        { file: "added.ts", additions: 12, deletions: 0, status: "added" },
        { file: "deleted.ts", additions: 0, deletions: 7, status: "deleted" },
        { file: "modified.ts", additions: 4, deletions: 3, status: "modified" },
      ],
    };
    expect(formatDiffStat(response)).toBe("3 files · +16 -10 ›");
  });

  it("returns an unavailable label for no-git responses", () => {
    const response: DiffResponse = {
      kind: "no-git",
      reason: "No git evidence available for this task.",
    };
    expect(formatDiffStat(response)).toBe("diff unavailable");
  });

  it("returns an unavailable label for no-git with any reason", () => {
    const response: DiffResponse = {
      kind: "no-git",
      reason: "Worktree diff failed: some error",
    };
    expect(formatDiffStat(response)).toBe("diff unavailable");
  });

  it("handles a single file correctly", () => {
    const response: DiffResponse = {
      kind: "diff",
      capped: false,
      root: "/tmp/test",
      files: [
        { file: "src/main.ts", additions: 42, deletions: 17, status: "modified" },
      ],
    };
    expect(formatDiffStat(response)).toBe("1 files · +42 -17 ›");
  });

  it("handles capped diff responses the same as uncapped", () => {
    const response: DiffResponse = {
      kind: "diff",
      capped: true,
      root: "/tmp/test",
      files: [
        { file: "src/x.ts", additions: 100, deletions: 50, status: "modified" },
        { file: "src/y.ts", additions: 200, deletions: 0, status: "added" },
      ],
    };
    // capped flag doesn't change the stat aggregation.
    expect(formatDiffStat(response)).toBe("2 files · +300 -50 ›");
  });
});