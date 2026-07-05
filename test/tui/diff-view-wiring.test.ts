import { describe, expect, it, vi } from "vitest";
import { handleKeypress, renderApp } from "../../src/tui/index";
import { createMockInstanceProvider, openDiffView } from "../../src/tui/model";
import type { Column, Task } from "../../src/shared";

function fakeUi() {
  return {
    TextAttributes: { BOLD: "bold" },
    Box: (props: Record<string, unknown>, ...children: unknown[]) => ({ type: "Box", props, children }),
    ScrollBox: (props: Record<string, unknown>, ...children: unknown[]) => ({ type: "ScrollBox", props, children }),
    Text: (props: Record<string, unknown>) => ({ type: "Text", props, children: [] }),
    DiffRenderable: class {},
    h: (_type: unknown, props: Record<string, unknown>) => ({ type: "Diff", props, children: [] }),
    fg: () => (value: unknown) => String(value),
  } as any;
}

function textOf(node: any): string {
  if (!node || typeof node !== "object") return "";
  const own = typeof node.props?.content === "string" ? node.props.content : "";
  return [own, ...(node.children ?? []).map(textOf)].filter(Boolean).join("\n");
}

function nodesByType(node: any, type: string): any[] {
  if (!node || typeof node !== "object") return [];
  const matches = node.type === type ? [node] : [];
  return [...matches, ...(node.children ?? []).flatMap((child: unknown) => nodesByType(child, type))];
}

function task(id: string, column: Column, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: "",
    directory: "/repo",
    column,
    position: 0,
    runState: "idle",
    baseCommit: "abc123",
    dirtyAtDispatch: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function state(overrides: Record<string, unknown> = {}) {
  return {
    tasks: [],
    agents: [],
    boardUrl: "http://127.0.0.1:4097",
    selectedTaskId: undefined,
    status: "ready",
    refreshing: false,
    cwd: "/repo",
    overlay: "none",
    terminalCols: 180,
    terminalRows: 80,
    laneOffsets: { todo: 0, in_progress: 0, review: 0, done: 0 },
    detailScrollTop: {},
    viewState: { view: "board", previousView: "launch" },
    instanceProvider: createMockInstanceProvider(),
    instanceList: [],
    selectedInstanceIndex: 0,
    fetchingCardCounts: new Set<string>(),
    switcherSelectedIndex: 0,
    instanceActionState: {},
    workspaceGateInput: "",
    workspaceGateSubmitting: false,
    ...overrides,
  } as any;
}

function actions(overrides: Record<string, unknown> = {}) {
  return {
    refresh: vi.fn(async () => undefined),
    render: vi.fn(),
    shutdown: vi.fn(),
    runAction: vi.fn(async () => undefined),
    client: {
      getTaskDiff: vi.fn(async () => ({ kind: "diff", files: [], capped: false })),
      ...(overrides as any).client,
    },
    archiveTask: vi.fn(async () => undefined),
    attachInstance: vi.fn(async () => undefined),
    detachInstance: vi.fn(async () => undefined),
    startInstance: vi.fn(async () => undefined),
    stopInstance: vi.fn(async () => undefined),
    removeInstance: vi.fn(async () => undefined),
    addInstance: vi.fn(async () => undefined),
    renameInstance: vi.fn(async () => undefined),
    refreshInstanceList: vi.fn(async () => undefined),
    fetchCardCount: vi.fn(async () => undefined),
    openArchive: vi.fn(async () => undefined),
    closeArchive: vi.fn(),
    refreshArchive: vi.fn(async () => undefined),
    setupWorkspace: vi.fn(async () => undefined),
    ...overrides,
  } as any;
}

describe("TUI diff view entry (v)", () => {
  it("opens the full-screen diff view for a selected Review card and fetches its diff", async () => {
    const reviewTask = task("review-1", "review");
    const s = state({ tasks: [reviewTask], selectedTaskId: "review-1" });
    const getTaskDiff = vi.fn(async () => ({
      kind: "diff" as const,
      files: [{ file: "src/a.ts", additions: 2, deletions: 1, status: "modified" as const, patch: "@@ -1,1 +1,1 @@\n-a\n+b\n" }],
      capped: false,
    }));
    const a = actions({ client: { getTaskDiff } });

    await handleKeypress({ sequence: "v", name: "v" } as any, s, a);

    expect(s.viewState.view).toBe("diff");
    expect(s.diffView?.loading).toBe(false);
    expect(getTaskDiff).toHaveBeenCalledWith("review-1");
    expect(s.diffView?.files).toHaveLength(1);
  });

  it("does not open the diff view for To Do, In Progress, Done, or manual cards", async () => {
    const columns: Column[] = ["todo", "in_progress", "done"];
    for (const column of columns) {
      const t = task(`card-${column}`, column);
      const s = state({ tasks: [t], selectedTaskId: t.id });
      const a = actions();
      await handleKeypress({ sequence: "v", name: "v" } as any, s, a);
      expect(s.viewState.view).not.toBe("diff");
      expect(a.client.getTaskDiff).not.toHaveBeenCalled();
    }

    const manual = task("manual-1", "review", { type: "manual" });
    const s = state({ tasks: [manual], selectedTaskId: "manual-1" });
    const a = actions();
    await handleKeypress({ sequence: "v", name: "v" } as any, s, a);
    expect(s.viewState.view).not.toBe("diff");
    expect(a.client.getTaskDiff).not.toHaveBeenCalled();
  });

  it("renders a readable no-git message instead of crashing", async () => {
    const reviewTask = task("review-1", "review");
    const s = state({ tasks: [reviewTask], selectedTaskId: "review-1" });
    const a = actions({
      client: { getTaskDiff: vi.fn(async () => ({ kind: "no-git", reason: "not a git repository" })) },
    });

    await handleKeypress({ sequence: "v", name: "v" } as any, s, a);

    const tree = renderApp(fakeUi(), s);
    expect(textOf(tree)).toContain("not a git repository");
  });
});

describe("TUI diff view navigation and exit", () => {
  function openedState(): any {
    const reviewTask = task("review-1", "review");
    const s = state({ tasks: [reviewTask], selectedTaskId: "review-1" });
    s.viewState = openDiffView(s.viewState);
    s.diffView = {
      taskId: "review-1",
      sourceLabel: "working tree diff",
      dirtyAtDispatch: false,
      loading: false,
      kind: "diff",
      capped: false,
      files: [
        { file: "a.ts", additions: 3, deletions: 0, status: "modified", patch: "@@ -1,1 +1,1 @@\nx\n@@ -9,1 +9,1 @@\ny\n@@ -20,1 +20,1 @@\nz\n" },
        { file: "b.ts", additions: 1, deletions: 0, status: "modified", patch: "@@ -1,1 +1,1 @@\ny\n" },
      ],
      selectedFileIndex: 0,
      reviewedFiles: new Set(),
    };
    return s;
  }

  it("esc returns to the board with the prior card selection restored", async () => {
    const s = openedState();
    const a = actions();

    await handleKeypress({ name: "escape", sequence: "" } as any, s, a);

    expect(s.viewState.view).toBe("board");
    expect(s.selectedTaskId).toBe("review-1");
    expect(s.diffView).toBeUndefined();
  });

  it("q also returns to the board", async () => {
    const s = openedState();
    await handleKeypress({ sequence: "q", name: "q" } as any, s, actions());
    expect(s.viewState.view).toBe("board");
  });

  it("down/up move the selected file", async () => {
    const s = openedState();
    await handleKeypress({ name: "down", sequence: "[B" } as any, s, actions());
    expect(s.diffView.selectedFileIndex).toBe(1);
    await handleKeypress({ name: "up", sequence: "[A" } as any, s, actions());
    expect(s.diffView.selectedFileIndex).toBe(0);
  });

  it("left/right hunk navigation recognizes sequence-only arrows and keeps the selected file stable", async () => {
    const s = openedState();

    await handleKeypress({ sequence: "\u001b[C" } as any, s, actions());
    expect(s.diffView.selectedFileIndex).toBe(0);
    expect(s.diffView.selectedHunk).toEqual({ fileIndex: 0, hunkIndex: 0 });
    expect(s.detailScrollTop["diff-patch"]).toBe(0);

    await handleKeypress({ sequence: "\u001b[C" } as any, s, actions());
    expect(s.diffView.selectedFileIndex).toBe(0);
    expect(s.diffView.selectedHunk).toEqual({ fileIndex: 0, hunkIndex: 1 });
    expect(s.detailScrollTop["diff-patch"]).toBe(2);

    await handleKeypress({ sequence: "\u001b[C" } as any, s, actions());
    expect(s.diffView.selectedFileIndex).toBe(0);
    expect(s.diffView.selectedHunk).toEqual({ fileIndex: 0, hunkIndex: 2 });
    expect(s.detailScrollTop["diff-patch"]).toBe(4);

    await handleKeypress({ sequence: "\u001b[D" } as any, s, actions());
    expect(s.diffView.selectedFileIndex).toBe(0);
    expect(s.diffView.selectedHunk).toEqual({ fileIndex: 0, hunkIndex: 1 });
  });

  it("one-hunk files explain their hunk count without changing files", async () => {
    const s = openedState();
    s.diffView.selectedFileIndex = 1;

    await handleKeypress({ sequence: "\u001b[C" } as any, s, actions());
    expect(s.diffView.selectedFileIndex).toBe(1);
    expect(s.diffView.selectedHunk).toEqual({ fileIndex: 1, hunkIndex: 0 });

    const tree = renderApp(fakeUi(), s);
    expect(textOf(tree)).toContain("1 hunk");
  });

  it("m toggles the selected file's reviewed dimming state", async () => {
    const s = openedState();
    await handleKeypress({ sequence: "m", name: "m" } as any, s, actions());
    expect(s.diffView.reviewedFiles.has("a.ts")).toBe(true);
  });

  it("does not fall through to board-view shortcuts like d (delete) while the diff view is open", async () => {
    const s = openedState();
    const a = actions();
    await handleKeypress({ sequence: "d", name: "d" } as any, s, a);
    expect(a.runAction).not.toHaveBeenCalled();
    expect(s.viewState.view).toBe("diff");
  });
});
