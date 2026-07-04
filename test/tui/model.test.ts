import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  TUI_LAYOUT,
  closeSwitcher,
  formatElapsed,
  initialViewState,
  laneCapacity,
  laneInnerHeight,
  closeArchive,
  nearestTaskInColumn,
  nextTaskId,
  openArchive,
  openSwitcher,
  orderedTasks,
  reconcileLaneOffset,
  runStateGlyph,
  runStateLabel,
  selectInstanceInSwitcher,
  shortPath,
  sidebarDetailMode,
  tasksByColumn,
  truncateText,
  transitionView,
  validateWorkspacePath,
  isProjectLike,
  workspaceToInstanceName,
} from "../../src/tui/model";
import type { Column, Task } from "../../src/shared";

function task(id: string, column: Column, position: number): Task {
  return {
    id,
    title: id,
    description: "",
    directory: "/repo",
    column,
    position,
    runState: "unstarted",
    createdAt: position,
    updatedAt: position,
  };
}

describe("TUI task model", () => {
  const tasks = [
    task("review-1", "review", 0),
    task("todo-2", "todo", 1),
    task("todo-1", "todo", 0),
    task("done-1", "done", 0),
  ];

  it("groups and orders tasks by board column", () => {
    expect(tasksByColumn(tasks).todo.map((item) => item.id)).toEqual(["todo-1", "todo-2"]);
    expect(orderedTasks(tasks).map((item) => item.id)).toEqual([
      "todo-1",
      "todo-2",
      "review-1",
      "done-1",
    ]);
  });

  it("navigates within and across columns", () => {
    expect(nextTaskId(tasks, "todo-1", 1)).toBe("todo-2");
    expect(nextTaskId(tasks, "todo-1", -1)).toBe("done-1");
    expect(nearestTaskInColumn(tasks, "todo-1", 1)).toBe("review-1");
    expect(nearestTaskInColumn(tasks, "review-1", -1)).toBe("todo-1");
  });

  it("formats labels for compact terminal display", () => {
    expect(runStateLabel("idle")).toBe("READY");
    expect(runStateGlyph("running")).toBe("●");
    expect(shortPath("/home/example/code/openboard", "/home/example")).toBe(
      "~/code/openboard",
    );
    expect(truncateText("OpenBoard", 5)).toBe("Open…");
  });

  it("formats elapsed run time in the design mock's style", () => {
    expect(formatElapsed(42_000)).toBe("42s");
    // The two durations shown in the locked mock.
    expect(formatElapsed((4 * 60 + 12) * 1000)).toBe("4m 12s");
    expect(formatElapsed((12 * 60 + 3) * 1000)).toBe("12m 03s");
    expect(formatElapsed((64 * 60 + 30) * 1000)).toBe("1h 04m");
    expect(formatElapsed(-5_000)).toBe("0s");
  });
});

describe("instance view state", () => {
  it("transitions launch → board → switcher → board", () => {
    const board = transitionView(initialViewState, "board");
    expect(board).toEqual({ view: "board", previousView: "launch" });

    const switcher = openSwitcher(board);
    expect(switcher).toEqual({ view: "switcher", previousView: "board" });

    expect(selectInstanceInSwitcher(switcher)).toEqual({ view: "board", previousView: null });
  });

  it("closes the switcher back to its previous view", () => {
    expect(closeSwitcher(openSwitcher(initialViewState))).toEqual({ view: "launch", previousView: null });
  });

  it("opens archive view and preserves the previous view", () => {
    const board = transitionView(initialViewState, "board");
    expect(openArchive(board)).toEqual({ view: "archive", previousView: "board" });
  });

  it("closes archive back to its previous view", () => {
    expect(closeArchive({ view: "archive", previousView: "launch" })).toEqual({ view: "launch", previousView: null });
  });

  it("closes archive to board when no previous view is available", () => {
    expect(closeArchive({ view: "archive", previousView: null })).toEqual({ view: "board", previousView: null });
  });
});

describe("lane windowing", () => {
  it("derives lane inner height from the shared layout constants", () => {
    const rootChrome =
      2 * TUI_LAYOUT.rootPadding +
      2 * TUI_LAYOUT.rootGap +
      TUI_LAYOUT.headerHeight +
      TUI_LAYOUT.commandStripHeight;
    const laneChrome = 2 * (TUI_LAYOUT.laneBorder + TUI_LAYOUT.lanePadding);

    // Pin the current layout so an accidental TUI_LAYOUT edit is loud
    // (1-row header now that the wordmark moved to the launch view).
    expect(rootChrome + laneChrome).toBe(13);
    expect(laneInnerHeight(40)).toBe(27);
    expect(laneInnerHeight(80)).toBe(67);
  });

  // Cards are 8 rows + 1 gap; 3 cards need 3*9-1 = 26 rows.
  it("shows every card when the lane is tall enough", () => {
    expect(laneCapacity(26, 3, 8)).toBe(3);
    expect(laneCapacity(100, 3, 8)).toBe(3);
    expect(laneCapacity(26, 0, 8)).toBe(0);
  });

  it("reserves two overflow rows once cards no longer fit", () => {
    // 25 rows can't hold 3 full cards; minus the two indicator slots (2 rows +
    // 2 gaps) the budget holds 2 cards.
    expect(laneCapacity(25, 3, 8)).toBe(2);
    // Done · 7 in a lane that fits 4 flat: indicators shrink it to 3.
    expect(laneCapacity(35, 7, 8)).toBe(3);
  });

  it("never windows below one card", () => {
    expect(laneCapacity(5, 4, 8)).toBe(1);
  });

  it("keeps the selected card inside the window", () => {
    // selection moved below the window → slide down just far enough
    expect(reconcileLaneOffset(0, 4, 7, 4)).toBe(1);
    // selection moved above the window → snap to it
    expect(reconcileLaneOffset(3, 1, 7, 4)).toBe(1);
    // selection already visible → no movement
    expect(reconcileLaneOffset(1, 2, 7, 4)).toBe(1);
    // walking to the last card pins the window to the tail
    expect(reconcileLaneOffset(1, 6, 7, 4)).toBe(3);
  });

  it("clamps stale offsets even when the selection is in another lane", () => {
    expect(reconcileLaneOffset(5, -1, 7, 4)).toBe(3);
    expect(reconcileLaneOffset(-2, -1, 7, 4)).toBe(0);
    expect(reconcileLaneOffset(2, -1, 2, 4)).toBe(0);
  });
});

describe("sidebar detail mode", () => {
  // Expanded needs 3 rows per detail + 8 fixed (title 3, hints 2, gaps).
  it("stays expanded when the two-line style fits", () => {
    expect(sidebarDetailMode(26, 6, false)).toBe("expanded");
    // 80-row terminal (inner 63) fits even 8 details + an error box.
    expect(sidebarDetailMode(63, 8, true)).toBe("expanded");
  });

  it("compacts one row short of fitting", () => {
    expect(sidebarDetailMode(25, 6, false)).toBe("compact");
  });

  it("compacts a worktree card with an error at 40 terminal rows", () => {
    // The live crowding case: inner 23, 8 details (BRANCH+BASE) — expanded
    // needs 32 rows (43 with an error) and used to clip labels into values.
    expect(sidebarDetailMode(23, 8, false)).toBe("compact");
    expect(sidebarDetailMode(23, 8, true)).toBe("compact");
  });

  it("charges the error box against the expanded budget", () => {
    // 6 details fit at inner 26 (26 rows) but not with the 11-row error box.
    expect(sidebarDetailMode(26, 6, true)).toBe("compact");
    expect(sidebarDetailMode(37, 6, true)).toBe("expanded");
  });
});

describe("workspace gate validation", () => {
  const tempDirs: string[] = [];
  const makeTempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "openboard-ws-"));
    tempDirs.push(dir);
    return dir;
  };

  afterAll(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it("rejects empty, missing, files, and unsafe broad directories", () => {
    expect(validateWorkspacePath("", "/repo").ok).toBe(false);
    expect(validateWorkspacePath("/tmp/nonexistent-dir-openboard-ws", "/repo").ok).toBe(false);
    expect(validateWorkspacePath(__filename, __dirname).ok).toBe(false);
    expect(validateWorkspacePath(homedir(), homedir()).ok).toBe(false);
    expect(validateWorkspacePath("/", "/repo").ok).toBe(false);
    expect(validateWorkspacePath(join(homedir(), "Desktop"), homedir()).ok).toBe(false);
    expect(validateWorkspacePath(join(homedir(), "Downloads"), homedir()).ok).toBe(false);
  });

  it("accepts an existing safe directory and resolves relative paths against cwd", () => {
    const cwd = makeTempDir();
    const child = join(cwd, "project");
    mkdirSync(child);
    tempDirs.push(child);
    const result = validateWorkspacePath("project", cwd);
    expect(result.ok).toBe(true);
  });

  it("detects project-like directories but never treats home as project-like", () => {
    const dir = makeTempDir();
    expect(isProjectLike(dir)).toBe(false);
    writeFileSync(join(dir, "package.json"), "{}");
    expect(isProjectLike(dir)).toBe(true);
    expect(isProjectLike(homedir())).toBe(false);
  });

  it("derives a safe instance name from the workspace path", () => {
    expect(workspaceToInstanceName("/Users/example/code/My Repo")).toBe("my-repo");
    expect(workspaceToInstanceName("/")).toBe("openboard");
  });
});
