import { describe, expect, it } from "vitest";
import { dominantTaskState } from "../../src/shared/lifecycle";
import type { Task } from "../../src/shared";

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    type: "agent",
    title: "Test task",
    description: "Do something",
    directory: "/tmp/test",
    column: "todo",
    position: 0,
    runState: "unstarted",
    baseCommit: null,
    dirtyAtDispatch: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("dominantTaskState", () => {
  it("ranks a pending permission ask above everything else, including a running session", () => {
    const task = baseTask({
      column: "review",
      runState: "running",
      completion: { outcome: "blocked", summary: "s", changedFiles: [], verification: [], residualRisk: "r", reportedAt: 1 },
      pendingPermissions: [{ id: "ask", harness: "opencode", source: "worktree-fence", permission: "edit", summary: "Edit file", raisedAt: 1, deadline: 6_000 }],
    });
    expect(dominantTaskState(task)).toBe("needs-user-input");
  });

  it("ranks blocked review below permission but above running/error", () => {
    const task = baseTask({
      column: "review",
      runState: "error",
      completion: { outcome: "blocked", summary: "s", changedFiles: [], verification: [], residualRisk: "r", reportedAt: 1 },
    });
    expect(dominantTaskState(task)).toBe("blocked");
  });

  it("ranks accepted-blocked done above running/error", () => {
    const task = baseTask({
      column: "done",
      runState: "error",
      completion: { outcome: "blocked", summary: "s", changedFiles: [], verification: [], residualRisk: "r", reportedAt: 1 },
    });
    expect(dominantTaskState(task)).toBe("accepted-blocked");
  });

  it("returns running when a session is active", () => {
    expect(dominantTaskState(baseTask({ runState: "running" }))).toBe("running");
  });

  it("returns error when the run errored outside review/done", () => {
    expect(dominantTaskState(baseTask({ runState: "error" }))).toBe("error");
  });

  it("returns pending for git-init/base-checkout-escape/rebase-conflict", () => {
    expect(dominantTaskState(baseTask({ pending: "git-init" }))).toBe("pending");
    expect(dominantTaskState(baseTask({ pending: "base-checkout-escape" }))).toBe("pending");
    expect(dominantTaskState(baseTask({ pending: "rebase-conflict" }))).toBe("pending");
  });

  it("returns review for a card sitting in review without other signals", () => {
    expect(dominantTaskState(baseTask({ column: "review" }))).toBe("review");
  });

  it("returns done for a card sitting in done without a blocked outcome", () => {
    expect(dominantTaskState(baseTask({ column: "done" }))).toBe("done");
  });

  it("returns idle for an unstarted-but-idle task outside todo/review/done", () => {
    expect(dominantTaskState(baseTask({ runState: "idle" }))).toBe("idle");
  });

  it("defaults to queued for a fresh unstarted task", () => {
    expect(dominantTaskState(baseTask())).toBe("queued");
  });
});
