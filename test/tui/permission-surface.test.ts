import { describe, expect, it } from "vitest";
import { firstPendingPermissionAsk, permissionAskBoardLabel, permissionAskDetailRows, permissionInFlightKey } from "../../src/tui/permission-surface";
import type { Task } from "../../src/shared";

const now = 1_000_000;

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Needs input",
    description: "",
    directory: "/repo",
    column: "in_progress",
    position: 0,
    runState: "running",
    baseCommit: null,
    dirtyAtDispatch: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("permission TUI surface", () => {
  it("labels pending permission asks before ordinary running state", () => {
    const selected = task({
      pendingPermissions: [
        { id: "ask-2", harness: "opencode", source: "worktree-fence", permission: "bash", summary: "Run tests", raisedAt: now - 10, deadline: now + 15_000 },
        { id: "ask-1", harness: "opencode", source: "worktree-fence", permission: "edit", summary: "Edit file", raisedAt: now - 20, deadline: now + 5_000 },
      ],
    });

    expect(firstPendingPermissionAsk(selected)?.id).toBe("ask-1");
    expect(permissionAskBoardLabel(selected, now)).toBe("◆ NEEDS USER INPUT · 2 asks");
    expect(permissionAskDetailRows(selected, now)).toEqual([
      { label: "INPUT", value: "2 pending permission asks" },
      { label: "OLDEST ASK", value: "Edit file" },
      { label: "COUNTDOWN", value: "5s" },
      { label: "ANSWER", value: "y allow once · uppercase N deny" },
    ]);
  });

  it("uses task/ask scoped de-dupe keys", () => {
    expect(permissionInFlightKey("task-1", "ask-1")).toBe("task-1:ask-1");
  });
});
