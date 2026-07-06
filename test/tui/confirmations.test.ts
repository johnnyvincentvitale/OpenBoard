import { describe, expect, it } from "vitest";
import {
  buildConfirmationCopy,
  buildRunConfidenceDetails,
  clearConfirmation,
  clearOnDifferentCommand,
  clearOnSelectionChange,
  confirmationStatus,
  CONFIRMABLE_ACTIONS,
  formatConfidenceDetail,
  isConfirmationPending,
  requestConfirmation,
  runConfidenceOk,
  targetColumnForAction,
} from "../../src/tui/confirmations";
import type { Task } from "../../src/shared";
import type { ConfirmableAction, TuiConfirmState } from "../../src/tui/confirmations";

const pending = (action: ConfirmableAction, taskId: string): TuiConfirmState => ({
  pendingConfirmation: { action, taskId },
});

function otherThan(action: ConfirmableAction): ConfirmableAction {
  return CONFIRMABLE_ACTIONS.find((a) => a !== action) ?? "run";
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Test task",
    description: "Implement the widget component with full test coverage",
    directory: "/repo",
    column: "todo",
    position: 0,
    runState: "unstarted",
    agent: "coder",
    baseCommit: null,
    dirtyAtDispatch: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("confirmation state helpers", () => {
  it("requests a confirmation when none is pending", () => {
    const result = requestConfirmation({}, "run", "task-1");

    expect(result.execute).toBe(false);
    expect(result.state).toEqual({ pendingConfirmation: { action: "run", taskId: "task-1" } });
  });

  it("confirms when the same action is requested on the same task", () => {
    const state = pending("run", "task-1");

    const result = requestConfirmation(state, "run", "task-1");

    expect(result.execute).toBe(true);
    expect(result.state).toEqual(state);
  });

  it.each(CONFIRMABLE_ACTIONS)("requests a different confirmation for %s when a pending one exists", (action) => {
    const state = pending(otherThan(action), "task-1");

    const result = requestConfirmation(state, action, "task-1");

    expect(result.execute).toBe(false);
    expect(result.state).toEqual(pending(action, "task-1"));
  });

  it("clears a pending confirmation explicitly", () => {
    const state = pending("delete", "task-1");

    const result = clearConfirmation(state);

    expect(result).toEqual({});
  });

  it("clearConfirmation is a no-op when nothing is pending", () => {
    expect(clearConfirmation({})).toEqual({});
    expect(clearConfirmation(undefined)).toEqual({});
  });

  it("clears confirmation when the selected task changes", () => {
    const state = pending("run", "task-1");

    expect(clearOnSelectionChange(state, "task-2")).toEqual({});
  });

  it("keeps confirmation when the selected task is unchanged", () => {
    const state = pending("run", "task-1");

    expect(clearOnSelectionChange(state, "task-1")).toEqual(state);
  });

  it("keeps confirmation when selection is empty and nothing is pending", () => {
    expect(clearOnSelectionChange({}, undefined)).toEqual({});
  });

  it("clears confirmation when a different command is issued", () => {
    const state = pending("run", "task-1");

    expect(clearOnDifferentCommand(state, "delete", "task-1")).toEqual({});
  });

  it("keeps confirmation when the same command is issued on the same task", () => {
    const state = pending("run", "task-1");

    expect(clearOnDifferentCommand(state, "run", "task-1")).toEqual(state);
  });

  it("reports whether a confirmation is pending for an action/task", () => {
    const state = pending("delete", "task-1");

    expect(isConfirmationPending(state, "delete", "task-1")).toBe(true);
    expect(isConfirmationPending(state, "delete", "task-2")).toBe(false);
    expect(isConfirmationPending(state, "run", "task-1")).toBe(false);
    expect(isConfirmationPending(undefined, "run", "task-1")).toBe(false);
  });
});

describe("confirmation copy builders", () => {
  it.each([
    ["run", "Running this card?", "Press r again to run."],
    ["retry", "Retrying this card?", "Press R again to retry."],
    ["abort", "Aborting this card?", "Press k again to abort."],
    ["move-to-done", "Move this card to Done?", "Press x again to move to Done."],
    ["archive", "Archiving this card?", "Press a again to archive."],
    ["delete", "Deleting this card?", "Press d again to delete."],
    ["discard-worktree", "Discard this worktree?", "Press D again to discard worktree."],
  ] as const)("builds copy for %s", (action, expectedTitle, expectedHint) => {
    const copy = buildConfirmationCopy(action, { title: "Widget work" });

    expect(copy.title).toBe(expectedTitle);
    expect(copy.body[0]).toContain("Widget work");
    expect(copy.confirmHint).toBe(expectedHint);
  });

  it("includes reported completion context before move-to-done signoff", () => {
    const copy = buildConfirmationCopy("move-to-done", {
      title: "UX polish",
      completionSource: "reported",
      completion: {
        outcome: "complete",
        summary: "done",
        changedFiles: [],
        verification: [
          { command: "typecheck", result: "passed" },
          { command: "tests", result: "passed" },
        ],
        residualRisk: "none reported",
        reportedAt: 1,
      },
    });

    expect(copy.body).toContain("Completion: reported complete");
    expect(copy.body).toContain("Verification: typecheck passed, tests passed");
    expect(copy.body).toContain("Residual risk: none reported");
    expect(copy.body).toContain("Source: agent-reported");
  });
});

describe("pre-run confidence details", () => {
  it("returns all-ok details for a well-formed ready task", () => {
    const details = buildRunConfidenceDetails(task());

    expect(details.every((d) => d.ok)).toBe(true);
    expect(details).toContainEqual({ ok: true, label: "Agent", message: "coder" });
    expect(details).toContainEqual({ ok: true, label: "Prompt", message: "54 chars" });
    expect(details).toContainEqual({ ok: true, label: "Directory", message: "/repo" });
  });

  it("flags missing agent, short prompt, and missing directory", () => {
    const details = buildRunConfidenceDetails(
      task({ agent: undefined, description: "hi", directory: "" }),
    );

    const agent = details.find((d) => d.label === "Agent");
    const prompt = details.find((d) => d.label === "Prompt");
    const dir = details.find((d) => d.label === "Directory");

    expect(agent?.ok).toBe(false);
    expect(prompt?.ok).toBe(false);
    expect(prompt?.message).toContain("Very short");
    expect(dir?.ok).toBe(false);
  });

  it("flags running and error run states", () => {
    expect(buildRunConfidenceDetails(task({ runState: "running" })).find((d) => d.label === "Run state")).toEqual({
      ok: false,
      label: "Run state",
      message: "Already running",
    });
    expect(buildRunConfidenceDetails(task({ runState: "error" })).find((d) => d.label === "Run state")).toEqual({
      ok: false,
      label: "Run state",
      message: "Previous run failed",
    });
  });

  it("flags pending decisions", () => {
    const details = buildRunConfidenceDetails(task({ pending: "git-init" }));

    expect(details.find((d) => d.label === "Pending")).toEqual({
      ok: false,
      label: "Pending",
      message: "Blocked: git-init",
    });
  });

  it("summarises overall confidence", () => {
    expect(runConfidenceOk(task())).toBe(true);
    expect(runConfidenceOk(task({ agent: undefined }))).toBe(false);
  });

  it("formats confidence details compactly", () => {
    expect(formatConfidenceDetail({ ok: true, label: "Agent", message: "coder" })).toBe("○ Agent: coder");
    expect(formatConfidenceDetail({ ok: false, label: "Prompt", message: "Empty" })).toBe("! Prompt: Empty");
  });
});

describe("confirmation status and action metadata", () => {
  it("produces a status line for the command strip", () => {
    expect(confirmationStatus("delete", { title: "Widget work" })).toBe(
      'Deleting "Widget work"? Press d again to confirm.',
    );
  });

  it("maps move-to-done to the done column", () => {
    expect(targetColumnForAction("move-to-done")).toBe("done");
  });

  it.each(["run", "retry", "archive", "delete", "discard-worktree"] as const)("leaves target column undefined for %s", (action) => {
    expect(targetColumnForAction(action)).toBeUndefined();
  });
});
