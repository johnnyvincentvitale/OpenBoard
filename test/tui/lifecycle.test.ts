import { describe, expect, it } from "vitest";
import { compactTaskBoardLabel, taskLifecycleDetailRows, taskLifecycleStatus } from "../../src/tui/lifecycle";
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

describe("task lifecycle helpers", () => {
  describe("running with elapsed", () => {
    const now = 1_000_000;
    const task = baseTask({
      column: "in_progress",
      runState: "running",
      runStartedAt: now - 252_000, // 4m 12s
    });

    it("reports running phase and elapsed detail", () => {
      const status = taskLifecycleStatus(task, now);
      expect(status.phase).toBe("running");
      expect(status.label).toBe("RUNNING");
      expect(status.glyph).toBe("●");
      expect(status.detail).toBe("4m 12s");
    });

    it("renders a compact board label with elapsed", () => {
      expect(compactTaskBoardLabel(task, now)).toBe("● RUNNING · 4m 12s");
    });

    it("includes STATE and ELAPSED detail rows", () => {
      const rows = taskLifecycleDetailRows(task, now);
      expect(rows).toEqual([
        { label: "STATE", value: "● RUNNING", role: "state" },
        { label: "ELAPSED", value: "4m 12s", role: "elapsed" },
      ]);
    });
  });

  describe("running without start time", () => {
    const task = baseTask({ column: "in_progress", runState: "running" });

    it("falls back to running-no-elapsed phase with empty detail", () => {
      const status = taskLifecycleStatus(task);
      expect(status.phase).toBe("running-no-elapsed");
      expect(status.detail).toBe("");
    });

    it("renders a board label without elapsed suffix", () => {
      expect(compactTaskBoardLabel(task)).toBe("● RUNNING");
    });
  });

  describe("review reported-complete", () => {
    const task = baseTask({
      column: "review",
      runState: "idle",
      completion: {
        outcome: "complete",
        summary: "Implemented helper",
        changedFiles: ["src/tui/lifecycle.ts"],
        verification: [{ command: "npm run typecheck", result: "passed" }],
        residualRisk: "none",
        reportedAt: 123,
      },
      completionSource: "reported",
    });

    it("reports review-reported-complete phase", () => {
      const status = taskLifecycleStatus(task);
      expect(status.phase).toBe("review-reported-complete");
      expect(status.label).toBe("REVIEW");
      expect(status.glyph).toBe("▲");
      expect(status.detail).toBe("COMPLETE");
    });

    it("renders a compact board label", () => {
      expect(compactTaskBoardLabel(task)).toBe("▲ REVIEW · COMPLETE");
    });

    it("returns state, outcome, and source rows", () => {
      expect(taskLifecycleDetailRows(task)).toEqual([
        { label: "STATE", value: "▲ REVIEW", role: "state" },
        { label: "OUTCOME", value: "COMPLETE", role: "outcome" },
        { label: "SOURCE", value: "reported", role: "source" },
      ]);
    });
  });

  describe("review blocked", () => {
    const task = baseTask({
      column: "review",
      runState: "idle",
      completion: {
        outcome: "blocked",
        summary: "Need credentials",
        changedFiles: [],
        verification: [],
        residualRisk: "blocked on secret",
        reportedAt: 456,
      },
      completionSource: "reported",
    });

    it("reports review-blocked phase", () => {
      const status = taskLifecycleStatus(task);
      expect(status.phase).toBe("review-blocked");
      expect(status.label).toBe("REVIEW");
      expect(status.detail).toBe("BLOCKED");
    });

    it("renders a compact board label", () => {
      expect(compactTaskBoardLabel(task)).toBe("▲ REVIEW · BLOCKED");
    });

    it("returns BLOCKED outcome row", () => {
      expect(taskLifecycleDetailRows(task)).toEqual([
        { label: "STATE", value: "▲ REVIEW", role: "state" },
        { label: "OUTCOME", value: "BLOCKED", role: "outcome" },
        { label: "SOURCE", value: "reported", role: "source" },
      ]);
    });
  });

  describe("review error", () => {
    const task = baseTask({
      column: "review",
      runState: "error",
      error: "build failed",
    });

    it("reports review-error phase", () => {
      const status = taskLifecycleStatus(task);
      expect(status.phase).toBe("review-error");
      expect(status.label).toBe("ERROR");
      expect(status.glyph).toBe("!");
      expect(status.detail).toBe("BUILD FAILED");
    });

    it("renders a compact board label with the error", () => {
      expect(compactTaskBoardLabel(task)).toBe("! ERROR · BUILD FAILED");
    });

    it("returns state and error rows", () => {
      expect(taskLifecycleDetailRows(task)).toEqual([
        { label: "STATE", value: "! ERROR", role: "state" },
        { label: "ERROR", value: "build failed", role: "error" },
      ]);
    });
  });

  describe("review unconfirmed idle fallback", () => {
    const task = baseTask({
      column: "review",
      runState: "idle",
      completion: {
        outcome: "complete",
        summary: "",
        changedFiles: [],
        verification: [],
        residualRisk: "",
        reportedAt: 789,
      },
      completionSource: "idle-fallback",
    });

    it("reports review-idle-fallback phase", () => {
      const status = taskLifecycleStatus(task);
      expect(status.phase).toBe("review-idle-fallback");
      expect(status.label).toBe("REVIEW");
      expect(status.detail).toBe("UNCONFIRMED");
    });

    it("renders a compact board label flagged as unconfirmed", () => {
      expect(compactTaskBoardLabel(task)).toBe("▲ REVIEW · UNCONFIRMED");
    });

    it("returns state, outcome, and idle-fallback source rows", () => {
      expect(taskLifecycleDetailRows(task)).toEqual([
        { label: "STATE", value: "▲ REVIEW", role: "state" },
        { label: "OUTCOME", value: "COMPLETE", role: "outcome" },
        { label: "SOURCE", value: "idle-fallback", role: "source" },
      ]);
    });
  });

  describe("done / user signoff", () => {
    const task = baseTask({
      column: "done",
      runState: "idle",
      completedBy: "User",
    });

    it("reports done-user phase", () => {
      const status = taskLifecycleStatus(task);
      expect(status.phase).toBe("done-user");
      expect(status.label).toBe("DONE");
      expect(status.glyph).toBe("○");
      expect(status.detail).toBe("User");
    });

    it("renders a compact board label with signoff attribution", () => {
      expect(compactTaskBoardLabel(task)).toBe("○ DONE · User");
    });

    it("returns state and completed-by rows", () => {
      expect(taskLifecycleDetailRows(task)).toEqual([
        { label: "STATE", value: "○ DONE", role: "state" },
        { label: "ACCEPTED BY", value: "User", role: "acceptedBy" },
      ]);
    });
  });

  describe("done without attribution", () => {
    const task = baseTask({ column: "done", runState: "idle" });

    it("reports done phase with empty detail", () => {
      const status = taskLifecycleStatus(task);
      expect(status.phase).toBe("done");
      expect(status.detail).toBe("");
    });

    it("renders a compact board label without suffix", () => {
      expect(compactTaskBoardLabel(task)).toBe("○ DONE");
    });
  });

  describe("review agent task without completion report", () => {
    const task = baseTask({ column: "review", runState: "idle", sessionId: "ses_1" });

    it("reports no-agent-report phase", () => {
      expect(taskLifecycleStatus(task).phase).toBe("review-no-agent-report");
      expect(compactTaskBoardLabel(task)).toBe("▲ REVIEW · NO AGENT REPORT");
      expect(taskLifecycleDetailRows(task)).toEqual([
        { label: "STATE", value: "▲ REVIEW", role: "state" },
        { label: "OUTCOME", value: "NO AGENT REPORT", role: "outcome" },
      ]);
    });
  });

  describe("review manual task", () => {
    const task = baseTask({ type: "manual", column: "review", runState: "idle", assignedTo: "Johnny" });

    it("reports manual phase", () => {
      expect(taskLifecycleStatus(task).phase).toBe("review-manual");
      expect(compactTaskBoardLabel(task)).toBe("▲ REVIEW · MANUAL");
      expect(taskLifecycleDetailRows(task)).toEqual([
        { label: "STATE", value: "▲ REVIEW", role: "state" },
        { label: "OUTCOME", value: "MANUAL", role: "outcome" },
      ]);
    });
  });

  describe("helpers never render terminal UI", () => {
    it("return plain data", () => {
      const rows = taskLifecycleDetailRows(baseTask({ runState: "error", error: "oops" }));
      for (const row of rows) {
        expect(typeof row.label).toBe("string");
        expect(typeof row.value).toBe("string");
      }
    });
  });
});
