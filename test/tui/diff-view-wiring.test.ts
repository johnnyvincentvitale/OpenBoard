import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyDiffScrollTop, captureDiffScrollTop, handleKeypress, renderApp, shouldAutoRefresh } from "../../src/tui/index";
import { createMockInstanceProvider, openDiffView } from "../../src/tui/model";
import type { Column, RespondPermissionOutcome, Task } from "../../src/shared";

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
    listPendingPermissions: vi.fn(() => []),
    respondPermission: vi.fn(async (_taskId: string, _input: { askId: string; action: "allow_once" | "deny"; answeredBy: string }): Promise<RespondPermissionOutcome> => ({ ok: true, askId: "ask_1", decision: "allow_once" })),
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
    copyToClipboard: vi.fn(async () => undefined),
    editorSpawner: {
      runTerminalEditor: vi.fn(async () => ({ code: 0 })),
      spawnGuiEditor: vi.fn(),
      ...(overrides as any).editorSpawner,
    },
    ...overrides,
  } as any;
}

describe("TUI diff view entry (v)", () => {
  it("disables background board polling while the diff renderer owns scroll state", () => {
    expect(shouldAutoRefresh({ view: "diff", previousView: "board" })).toBe(false);
    // "follow" polls deliberately: permission asks raised mid-run must surface
    // in the follow view's banner before their deadline (scroll state lives in
    // followView, so the quiet refresh can't disturb the reading position).
    expect(shouldAutoRefresh({ view: "follow", previousView: "board" })).toBe(true);
    expect(shouldAutoRefresh({ view: "archive", previousView: "board" })).toBe(false);
    expect(shouldAutoRefresh({ view: "launch", previousView: "board" })).toBe(false);
    expect(shouldAutoRefresh({ view: "workspaceGate", previousView: "launch" })).toBe(false);
    expect(shouldAutoRefresh({ view: "board", previousView: "launch" })).toBe(true);
    expect(shouldAutoRefresh({ view: "switcher", previousView: "board" })).toBe(true);
  });

  it("does not write NaN scroll positions when a diff renderable omits maxScrollY", () => {
    const code = { scrollY: 0 };
    const s = state({
      detailScrollTop: { "diff-patch": 12 },
      diffView: {
        taskId: "review-1",
        taskTitle: "review-1",
        sourceLabel: "worktree diff",
        loading: false,
        kind: "diff",
        files: [{ file: "src/a.ts", additions: 1, deletions: 0, status: "modified", patch: "@@ -1 +1 @@\n-a\n+b\n" }],
        capped: false,
        selectedFileIndex: 0,
        reviewedFiles: new Set<string>(),
        fileSelectionLocked: true,
      },
    });

    applyDiffScrollTop(s, { root: { findDescendantById: () => code } } as any);

    expect(Number.isNaN(code.scrollY)).toBe(false);
    expect(Number.isNaN(s.detailScrollTop["diff-patch"])).toBe(false);
  });

  it("q in FollowView returns to the board and closes the stream without quitting", async () => {
    const close = vi.fn();
    const s = state({ viewState: { view: "follow", previousView: "board" }, followView: { taskId: "task-1", events: [], connection: "LIVE", autoFollow: true, scrollOffset: 0, lastRenderAt: 0, maxEvents: 100 }, followStream: { close } });
    const a = actions();

    await handleKeypress({ name: "q", sequence: "q" } as any, s, a as any);

    expect(close).toHaveBeenCalledOnce();
    expect(a.shutdown).not.toHaveBeenCalled();
    expect(s.viewState.view).toBe("board");
    expect(a.refresh).toHaveBeenCalledWith(true);
  });

  it("composes and sends a message from Session Chat against the bound session", async () => {
    const chatTask = task("task-1", "in_progress", { sessionId: "ses-1", runStartedAt: 123, runState: "running" });
    const followView = { taskId: "task-1", events: [], connection: "LIVE", autoFollow: true, scrollOffset: 0, lastRenderAt: 0, maxEvents: 100 };
    const s = state({ tasks: [chatTask], selectedTaskId: chatTask.id, viewState: { view: "follow", previousView: "board" }, followView });
    const sendSessionMessage = vi.fn(async (_id: string, input: any) => ({ messageId: input.clientMessageId, taskId: chatTask.id, sessionId: "ses-1", status: "queued", mode: input.mode, sentAt: 456, sentBy: "User", task: chatTask }));
    const a = actions({ client: { sendSessionMessage, streamSessionEvents: vi.fn(async () => ({ active: true, close: vi.fn() })) } });

    await handleKeypress({ name: "i", sequence: "i" } as any, s, a);
    for (const char of "hello") await handleKeypress({ name: char, sequence: char } as any, s, a);
    await handleKeypress({ name: "return", sequence: "\r" } as any, s, a);

    expect(sendSessionMessage).toHaveBeenCalledWith("task-1", expect.objectContaining({ text: "hello", mode: "queue", expectedSessionId: "ses-1", expectedRunStartedAt: 123 }));
    expect(s.sessionChatDraft).toBeUndefined();
    expect(s.status).toContain("queued");
  });

  it("renders the Follow surface as Session Chat", () => {
    const chatTask = task("task-1", "in_progress", { sessionId: "ses-1", runState: "running" });
    const s = state({ tasks: [chatTask], selectedTaskId: chatTask.id, viewState: { view: "follow", previousView: "board" }, followView: { taskId: "task-1", events: [], connection: "LIVE", autoFollow: true, scrollOffset: 0, lastRenderAt: 0, maxEvents: 100 } });
    expect(textOf(renderApp(fakeUi(), s))).toContain("Session Chat");
    expect(textOf(renderApp(fakeUi(), s))).toContain("Press i to message this session");
  });

  it("renders fenced code as a labelled copy box and copies the selected source", async () => {
    const chatTask = task("task-1", "review", { sessionId: "ses-1", runState: "idle" });
    const codeEvent = {
      seq: 7,
      taskId: "task-1",
      runStartedAt: 1,
      sessionId: "ses-1",
      rootSessionId: "ses-1",
      harness: "opencode",
      occurredAt: 7,
      kind: "text",
      role: "assistant",
      text: "To retest:\n\n```sh\nopenboard attach qa-wave\n```",
    };
    const s = state({
      tasks: [chatTask],
      selectedTaskId: chatTask.id,
      viewState: { view: "follow", previousView: "board" },
      followView: { taskId: "task-1", events: [codeEvent], connection: "STATIC", autoFollow: true, scrollOffset: 0, lastRenderAt: 0, maxEvents: 100 },
    });
    const copyToClipboard = vi.fn(async () => undefined);
    const rendered = renderApp(fakeUi(), s);

    expect(textOf(rendered)).toContain("sh · COPY c · SELECTED");
    expect(textOf(rendered)).toContain("openboard attach qa-wave");
    expect(nodesByType(rendered, "Box").some((node) => node.props.borderStyle === "rounded")).toBe(true);

    await handleKeypress({ name: "c", sequence: "c" } as any, s, actions({ copyToClipboard }));
    expect(copyToClipboard).toHaveBeenCalledWith("openboard attach qa-wave");
    expect(s.status).toBe("copied sh block to clipboard");
  });

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

  it("cycles Done diff evidence from inherited context codeAncestors and compares against Build", async () => {
    const fixTask = task("fix", "done", { taskKind: "fix", parentIds: ["audit"] });
    const s = state({ tasks: [fixTask], selectedTaskId: "fix" });
    const getTaskDiff = vi.fn(async () => ({ kind: "diff" as const, files: [], capped: false }));
    const getTaskCompare = vi.fn(async () => ({ kind: "diff" as const, files: [], capped: true }));
    const getTaskContext = vi.fn(async () => ({
      task: { taskId: "fix", title: "Fix", description: "", taskKind: "fix", column: "done", completion: null, changedFiles: [], verification: [], residualRisk: "", hasStructuredHandoff: false },
      directParents: [{ kind: "direct-parent", parentId: "audit", taskId: "audit", title: "Audit", description: "", taskKind: "audit", column: "done", completion: null, changedFiles: [], verification: [], residualRisk: "", hasStructuredHandoff: false }],
      inheritedParents: [{ kind: "inherited-parent", taskId: "build", title: "Build", taskKind: "build", column: "done", depth: 2, viaParentIds: ["audit"], summary: "built", hasStructuredHandoff: true }],
      codeAncestors: [{ taskId: "build", title: "Build", taskKind: "build", column: "done", branch: "board/build", changedFiles: ["src/a.ts"], hasStructuredHandoff: true }],
    }));

    await handleKeypress({ name: "v", sequence: "v" } as any, s, actions({ client: { getTaskDiff, getTaskCompare, getTaskContext } }) as any);
    expect(getTaskDiff).toHaveBeenCalledWith("fix");
    expect(s.diffLineage.codeAncestors.map((ancestor: any) => ancestor.taskId)).toEqual(["build"]);

    await handleKeypress({ name: "a", sequence: "a" } as any, s, actions({ client: { getTaskDiff, getTaskCompare, getTaskContext } }) as any);
    expect(getTaskCompare).toHaveBeenCalledWith("fix", "build");
    expect(s.diffView.sourceLabel).toContain("compare Build (build) · depth 2 via audit");
    expect(s.diffView.sourceLabel).toContain("capped");
  });

  it("opens a Done card's historical diff and blocks edit and commit actions", async () => {
    const doneTask = task("done-1", "done", { isolation: "worktree" });
    const s = state({ tasks: [doneTask], selectedTaskId: "done-1" });
    const getTaskDiff = vi.fn(async () => ({
      kind: "diff" as const,
      files: [{ file: "src/a.ts", additions: 2, deletions: 1, status: "modified" as const, patch: "@@ -1,1 +1,1 @@\n-a\n+b\n" }],
      capped: false,
      root: "/repo",
    }));
    const commitTaskFile = vi.fn();
    const a = actions({ client: { getTaskDiff, commitTaskFile } });

    await handleKeypress({ sequence: "v", name: "v" } as any, s, a);

    expect(s.viewState.view).toBe("diff");
    expect(s.diffView?.historical).toBe(true);
    expect(getTaskDiff).toHaveBeenCalledWith("done-1");
    expect(textOf(renderApp(fakeUi(), s))).toContain("historical worktree diff");
    expect(textOf(renderApp(fakeUi(), s))).not.toContain("e edit");
    expect(textOf(renderApp(fakeUi(), s))).not.toContain("c commit");

    await handleKeypress({ sequence: "e", name: "e" } as any, s, a);
    expect(a.editorSpawner.runTerminalEditor).not.toHaveBeenCalled();
    expect(a.editorSpawner.spawnGuiEditor).not.toHaveBeenCalled();
    expect(s.status).toBe("historical diff: files cannot be edited");

    await handleKeypress({ sequence: "c", name: "c" } as any, s, a);
    expect(commitTaskFile).not.toHaveBeenCalled();
    expect(s.status).toBe("historical diff: files cannot be committed");
  });

  it("does not open the diff view for To Do, In Progress, or manual cards", async () => {
    const columns: Column[] = ["todo", "in_progress"];
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

    const manualDone = task("manual-done", "done", { type: "manual" });
    const manualDoneState = state({ tasks: [manualDone], selectedTaskId: manualDone.id });
    const manualDoneActions = actions();
    await handleKeypress({ sequence: "v", name: "v" } as any, manualDoneState, manualDoneActions);
    expect(manualDoneState.viewState.view).not.toBe("diff");
    expect(manualDoneActions.client.getTaskDiff).not.toHaveBeenCalled();
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
  function openedState(diffViewOverrides: Record<string, unknown> = {}): any {
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
      root: "/repo",
      files: [
        { file: "a.ts", additions: 3, deletions: 0, status: "modified", patch: "@@ -1,1 +1,1 @@\nx\n@@ -9,1 +9,1 @@\ny\n@@ -20,1 +20,1 @@\nz\n" },
        { file: "b.ts", additions: 1, deletions: 0, status: "modified", patch: "@@ -1,1 +1,1 @@\ny\n" },
      ],
      selectedFileIndex: 0,
      fileSelectionLocked: false,
      reviewedFiles: new Set(),
      ...diffViewOverrides,
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

  it("b returns to the board", async () => {
    const s = openedState();
    await handleKeypress({ sequence: "b", name: "b" } as any, s, actions());
    expect(s.viewState.view).toBe("board");
  });

  it("b then v re-entering the diff view re-fetches current diff data via getTaskDiff", async () => {
    const reviewTask = task("review-1", "review");
    const s = state({ tasks: [reviewTask], selectedTaskId: "review-1" });
    const getTaskDiff = vi.fn(async () => ({
      kind: "diff" as const,
      files: [{ file: "src/a.ts", additions: 3, deletions: 0, status: "modified" as const, patch: "@@ -1,1 +1,1 @@\n-a\n+b\n" }],
      capped: false,
      root: "/repo",
    }));
    const a = actions({ client: { getTaskDiff } });

    // First entry via v
    await handleKeypress({ sequence: "v", name: "v" } as any, s, a);
    expect(s.viewState.view).toBe("diff");
    expect(getTaskDiff).toHaveBeenCalledTimes(1);

    // Exit via b
    await handleKeypress({ sequence: "b", name: "b" } as any, s, a);
    expect(s.viewState.view).toBe("board");

    // Re-entry via v must refetch
    await handleKeypress({ sequence: "v", name: "v" } as any, s, a);
    expect(s.viewState.view).toBe("diff");
    expect(getTaskDiff).toHaveBeenCalledTimes(2);
    expect(getTaskDiff).toHaveBeenLastCalledWith("review-1");
  });

  it("r refreshes the open diff view without leaving diff mode", async () => {
    const s = openedState();
    const getTaskDiff = vi.fn(async () => ({
      kind: "diff" as const,
      files: [{ file: "refreshed.ts", additions: 1, deletions: 0, status: "modified" as const, patch: "@@ -1,1 +1,1 @@\n-new\n+newer\n" }],
      capped: false,
      root: "/repo",
    }));
    const a = actions({ client: { getTaskDiff } });

    await handleKeypress({ sequence: "r", name: "r" } as any, s, a);

    expect(s.viewState.view).toBe("diff");
    expect(getTaskDiff).toHaveBeenCalledWith("review-1");
    expect(s.diffView.files.map((file: { file: string }) => file.file)).toEqual(["refreshed.ts"]);
  });

  it("q quits from the diff view", async () => {
    const s = openedState();
    const shutdown = vi.fn();
    await handleKeypress({ sequence: "q", name: "q" } as any, s, actions({ shutdown }));
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(s.viewState.view).toBe("diff");
  });

  it("enter toggles whether down/up move files or scroll the selected patch", async () => {
    const s = openedState();
    await handleKeypress({ name: "down", sequence: "[B" } as any, s, actions());
    expect(s.diffView.selectedFileIndex).toBe(1);
    await handleKeypress({ name: "up", sequence: "[A" } as any, s, actions());
    expect(s.diffView.selectedFileIndex).toBe(0);

    await handleKeypress({ name: "return", sequence: "\r" } as any, s, actions());
    expect(s.diffView.fileSelectionLocked).toBe(true);
    expect(s.detailScrollTop["diff-patch"]).toBe(0);

    await handleKeypress({ name: "down", sequence: "[B" } as any, s, actions());
    expect(s.diffView.selectedFileIndex).toBe(0);
    expect(s.detailScrollTop["diff-patch"]).toBe(1);

    await handleKeypress({ name: "up", sequence: "[A" } as any, s, actions());
    expect(s.diffView.selectedFileIndex).toBe(0);
    expect(s.detailScrollTop["diff-patch"]).toBe(0);

    await handleKeypress({ name: "return", sequence: "\r" } as any, s, actions());
    expect(s.diffView.fileSelectionLocked).toBe(false);
    await handleKeypress({ name: "down", sequence: "[B" } as any, s, actions());
    expect(s.diffView.selectedFileIndex).toBe(1);
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
    // Hunk nav now targets the hunk's header row in the whole patch (hunk 1 header at row 2),
    // which the viewport scrolls to — no longer a rotation-model 0.
    expect(s.detailScrollTop["diff-patch"]).toBe(2);

    await handleKeypress({ sequence: "\u001b[C" } as any, s, actions());
    expect(s.diffView.selectedFileIndex).toBe(0);
    expect(s.diffView.selectedHunk).toEqual({ fileIndex: 0, hunkIndex: 2 });
    expect(s.detailScrollTop["diff-patch"]).toBe(4); // hunk 2 header at row 4

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

describe("TUI diff view open-in-editor (e)", () => {
  const ENV_KEYS = ["OPENBOARD_EDITOR", "VISUAL", "EDITOR"] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  function openedState(diffViewOverrides: Record<string, unknown> = {}): any {
    const reviewTask = task("review-1", "review");
    const s = state({ tasks: [reviewTask], selectedTaskId: "review-1", boardUrl: "http://127.0.0.1:4097" });
    s.viewState = openDiffView(s.viewState);
    s.diffView = {
      taskId: "review-1",
      sourceLabel: "working tree diff",
      dirtyAtDispatch: false,
      loading: false,
      kind: "diff",
      capped: false,
      root: "/repo",
      files: [
        { file: "a.ts", additions: 3, deletions: 0, status: "modified", patch: "@@ -1,3 +10,3 @@\n ctx\n-old\n+new\n" },
        { file: "b.ts", additions: 1, deletions: 0, status: "modified", patch: "@@ -1,1 +1,1 @@\ny\n" },
      ],
      selectedFileIndex: 0,
      fileSelectionLocked: false,
      reviewedFiles: new Set(),
      ...diffViewOverrides,
    };
    return s;
  }

  it("terminal editor happy path (file-nav mode): suspend -> spawn -> resume -> diff re-fetched", async () => {
    process.env.EDITOR = "vim";
    const s = openedState();
    const runTerminalEditor = vi.fn(async () => ({ code: 0 }));
    const getTaskDiff = vi.fn(async () => ({
      kind: "diff" as const,
      files: [{ file: "a.ts", additions: 4, deletions: 0, status: "modified" as const, patch: "@@ -1,3 +10,3 @@\n ctx\n-old\n+new\n" }],
      capped: false,
      root: "/repo",
    }));
    const a = actions({ editorSpawner: { runTerminalEditor, spawnGuiEditor: vi.fn() }, client: { getTaskDiff } });

    await handleKeypress({ sequence: "e", name: "e" } as any, s, a);

    expect(runTerminalEditor).toHaveBeenCalledWith(["vim", "+10", "/repo/a.ts"], "/repo");
    expect(getTaskDiff).toHaveBeenCalledWith("review-1");
    expect(s.diffView.files).toHaveLength(1);
    expect(s.status).toContain("editor closed");
  });

  it("terminal editor happy path (locked-scroll mode) uses the live scroll value", async () => {
    process.env.EDITOR = "vim";
    const s = openedState({ fileSelectionLocked: true });
    // detailScrollTop is now a whole-patch scroll row. a.ts hunk 0's header is row 0, so its
    // body starts at row 1; row 2 (`-old`) is body offset 1 within the hunk.
    s.detailScrollTop = { "diff-patch": 2 };
    const runTerminalEditor = vi.fn(async () => ({ code: 0 }));
    const a = actions({ editorSpawner: { runTerminalEditor, spawnGuiEditor: vi.fn() } });

    await handleKeypress({ sequence: "e", name: "e" } as any, s, a);

    // hunk 0 new-start line 10 + body offset 1 (clamped into body length 3) = 11
    expect(runTerminalEditor).toHaveBeenCalledWith(["vim", "+11", "/repo/a.ts"], "/repo");
  });

  it("GUI editor happy path: no suspend, detached spawn, diff re-fetched", async () => {
    process.env.EDITOR = "code";
    const s = openedState();
    const runTerminalEditor = vi.fn(async () => ({ code: 0 }));
    const spawnGuiEditor = vi.fn();
    const getTaskDiff = vi.fn(async () => ({ kind: "diff" as const, files: s.diffView.files, capped: false, root: "/repo" }));
    const a = actions({ editorSpawner: { runTerminalEditor, spawnGuiEditor }, client: { getTaskDiff } });

    await handleKeypress({ sequence: "e", name: "e" } as any, s, a);

    expect(runTerminalEditor).not.toHaveBeenCalled();
    expect(spawnGuiEditor).toHaveBeenCalledWith(["code", "-g", "/repo/a.ts:10"], "/repo", expect.any(Function));
    expect(getTaskDiff).toHaveBeenCalledWith("review-1");
  });

  it("GUI editor spawn failure surfaces as a status message instead of crashing", async () => {
    process.env.EDITOR = "code";
    const s = openedState();
    const runTerminalEditor = vi.fn(async () => ({ code: 0 }));
    // Simulate the async ENOENT a missing editor binary produces: the real
    // spawner invokes onError from the child's "error" event.
    const spawnGuiEditor = vi.fn((argv: string[], cwd: string, onError?: (error: unknown) => void) => {
      onError?.(new Error("spawn code ENOENT"));
    });
    const getTaskDiff = vi.fn(async () => ({ kind: "diff" as const, files: s.diffView.files, capped: false, root: "/repo" }));
    const a = actions({ editorSpawner: { runTerminalEditor, spawnGuiEditor }, client: { getTaskDiff } });

    await handleKeypress({ sequence: "e", name: "e" } as any, s, a);

    expect(s.status).toContain("editor failed to launch");
    expect(s.status).toContain("ENOENT");
  });

  it("guard: remote board blocks with a status message and never fetches the diff", async () => {
    process.env.EDITOR = "vim";
    const s = openedState();
    s.boardUrl = "http://example.com:4097";
    const a = actions();

    await handleKeypress({ sequence: "e", name: "e" } as any, s, a);

    expect(a.client.getTaskDiff).not.toHaveBeenCalled();
    expect(a.editorSpawner.runTerminalEditor).not.toHaveBeenCalled();
    expect(s.status).toMatch(/local board/i);
  });

  it("guard: missing diff root blocks (no-git or missing root treated the same)", async () => {
    process.env.EDITOR = "vim";
    const s = openedState({ root: undefined });
    const a = actions();

    await handleKeypress({ sequence: "e", name: "e" } as any, s, a);

    expect(a.editorSpawner.runTerminalEditor).not.toHaveBeenCalled();
    expect(s.status).toBeTruthy();
  });

  it("guard: no-git diff kind blocks", async () => {
    process.env.EDITOR = "vim";
    const s = openedState({ kind: "no-git", root: undefined, files: [] });
    const a = actions();

    await handleKeypress({ sequence: "e", name: "e" } as any, s, a);

    expect(a.editorSpawner.runTerminalEditor).not.toHaveBeenCalled();
  });

  it("guard: blocked editor target (e.g. deleted file) surfaces its reason", async () => {
    process.env.EDITOR = "vim";
    const s = openedState({
      files: [{ file: "a.ts", additions: 0, deletions: 3, status: "deleted", patch: undefined }],
    });
    const a = actions();

    await handleKeypress({ sequence: "e", name: "e" } as any, s, a);

    expect(a.editorSpawner.runTerminalEditor).not.toHaveBeenCalled();
    expect(s.status).toMatch(/deleted/i);
  });

  it("guard: no editor configured surfaces the resolver's error", async () => {
    const s = openedState();
    const a = actions();

    await handleKeypress({ sequence: "e", name: "e" } as any, s, a);

    expect(a.editorSpawner.runTerminalEditor).not.toHaveBeenCalled();
    expect(s.status).toMatch(/no editor configured/i);
  });

  it("nonzero exit surfaces a status message instead of crashing", async () => {
    process.env.EDITOR = "vim";
    const s = openedState();
    const runTerminalEditor = vi.fn(async () => ({ code: 1 }));
    const a = actions({ editorSpawner: { runTerminalEditor, spawnGuiEditor: vi.fn() } });

    await handleKeypress({ sequence: "e", name: "e" } as any, s, a);

    expect(s.status).toContain("1");
    expect(s.viewState.view).toBe("diff");
  });

  it("resume/refresh path still runs when the spawn throws", async () => {
    process.env.EDITOR = "vim";
    const s = openedState();
    const runTerminalEditor = vi.fn(async () => {
      throw new Error("spawn ENOENT");
    });
    const getTaskDiff = vi.fn(async () => ({ kind: "diff" as const, files: s.diffView.files, capped: false, root: "/repo" }));
    const a = actions({ editorSpawner: { runTerminalEditor, spawnGuiEditor: vi.fn() }, client: { getTaskDiff } });

    await handleKeypress({ sequence: "e", name: "e" } as any, s, a);

    expect(runTerminalEditor).toHaveBeenCalledTimes(1);
    expect(s.status).toMatch(/spawn ENOENT|failed to launch/i);
    // the TUI must still refresh the diff (i.e. "still resumes") even though spawn threw
    expect(getTaskDiff).toHaveBeenCalledWith("review-1");
  });

  it("preserves the selected file by path after refresh, even if its index shifts", async () => {
    process.env.EDITOR = "vim";
    const s = openedState();
    s.diffView.selectedFileIndex = 1; // b.ts selected
    const runTerminalEditor = vi.fn(async () => ({ code: 0 }));
    // Refreshed diff reorders files so b.ts is now index 0.
    const getTaskDiff = vi.fn(async () => ({
      kind: "diff" as const,
      files: [
        { file: "b.ts", additions: 1, deletions: 0, status: "modified" as const, patch: "@@ -1,1 +1,1 @@\ny\n" },
        { file: "a.ts", additions: 3, deletions: 0, status: "modified" as const, patch: "@@ -1,3 +10,3 @@\n ctx\n-old\n+new\n" },
      ],
      capped: false,
      root: "/repo",
    }));
    const a = actions({ editorSpawner: { runTerminalEditor, spawnGuiEditor: vi.fn() }, client: { getTaskDiff } });

    // b.ts is selected, so the editor should open b.ts, not a.ts.
    await handleKeypress({ sequence: "e", name: "e" } as any, s, a);

    expect(runTerminalEditor).toHaveBeenCalledWith(["vim", "+1", "/repo/b.ts"], "/repo");
    expect(s.diffView.selectedFileIndex).toBe(0);
    expect(s.diffView.files[s.diffView.selectedFileIndex].file).toBe("b.ts");
  });

  it("falls back to a clamped index when the selected file vanished from the refreshed diff", async () => {
    process.env.EDITOR = "vim";
    const s = openedState();
    s.diffView.selectedFileIndex = 1; // b.ts selected
    const runTerminalEditor = vi.fn(async () => ({ code: 0 }));
    // Refreshed diff no longer contains b.ts at all.
    const getTaskDiff = vi.fn(async () => ({
      kind: "diff" as const,
      files: [{ file: "a.ts", additions: 3, deletions: 0, status: "modified" as const, patch: "@@ -1,3 +10,3 @@\n ctx\n-old\n+new\n" }],
      capped: false,
      root: "/repo",
    }));
    const a = actions({ editorSpawner: { runTerminalEditor, spawnGuiEditor: vi.fn() }, client: { getTaskDiff } });

    await handleKeypress({ sequence: "e", name: "e" } as any, s, a);

    expect(s.diffView.files).toHaveLength(1);
    expect(s.diffView.selectedFileIndex).toBe(0);
  });

  it("preserves the current keyboard mode (locked-scroll) across the refresh", async () => {
    process.env.EDITOR = "vim";
    const s = openedState({ fileSelectionLocked: true });
    const runTerminalEditor = vi.fn(async () => ({ code: 0 }));
    const getTaskDiff = vi.fn(async () => ({ kind: "diff" as const, files: s.diffView.files, capped: false, root: "/repo" }));
    const a = actions({ editorSpawner: { runTerminalEditor, spawnGuiEditor: vi.fn() }, client: { getTaskDiff } });

    await handleKeypress({ sequence: "e", name: "e" } as any, s, a);

    expect(s.diffView.fileSelectionLocked).toBe(true);
  });

  it("e is active in locked-scroll mode too (not swallowed by scroll handling)", async () => {
    process.env.EDITOR = "vim";
    const s = openedState({ fileSelectionLocked: true });
    const runTerminalEditor = vi.fn(async () => ({ code: 0 }));
    const a = actions({ editorSpawner: { runTerminalEditor, spawnGuiEditor: vi.fn() } });

    await handleKeypress({ sequence: "e", name: "e" } as any, s, a);

    expect(runTerminalEditor).toHaveBeenCalledTimes(1);
  });
});

describe("diff scroll capture/apply against the live renderable", () => {
  const DIFF_PATCH_SCROLL_ID = "diff-patch";

  function fakeCode(scrollY: number, maxScrollY: number) {
    return { scrollY, maxScrollY };
  }

  function fakeRenderer(byId: Record<string, unknown>) {
    return { root: { findDescendantById: (id: string) => byId[id] } };
  }

  function diffState(detailScrollTop: Record<string, number> = {}) {
    return { diffView: { kind: "diff" }, detailScrollTop } as any;
  }

  it("captures the live viewport scrollY into state (so mouse-wheel scroll survives a rebuild)", () => {
    const s = diffState({ [DIFF_PATCH_SCROLL_ID]: 0 });
    const renderer = fakeRenderer({ [`${DIFF_PATCH_SCROLL_ID}-left-code`]: fakeCode(7, 40) });
    captureDiffScrollTop(s, renderer as any);
    expect(s.detailScrollTop[DIFF_PATCH_SCROLL_ID]).toBe(7);
  });

  it("is a no-op when the diff pane is not mounted", () => {
    const s = diffState({ [DIFF_PATCH_SCROLL_ID]: 3 });
    captureDiffScrollTop(s, fakeRenderer({}) as any);
    expect(s.detailScrollTop[DIFF_PATCH_SCROLL_ID]).toBe(3);
  });

  it("applies the tracked scroll onto the code pane, clamped to maxScrollY, and writes the clamp back", () => {
    const code = fakeCode(0, 5);
    const s = diffState({ [DIFF_PATCH_SCROLL_ID]: 99 });
    applyDiffScrollTop(s, fakeRenderer({ [`${DIFF_PATCH_SCROLL_ID}-left-code`]: code }) as any);
    expect(code.scrollY).toBe(5);
    expect(s.detailScrollTop[DIFF_PATCH_SCROLL_ID]).toBe(5);
  });

  it("keeps split-view panes in sync by applying one position to both sides", () => {
    const left = fakeCode(0, 20);
    const right = fakeCode(0, 20);
    const s = diffState({ [DIFF_PATCH_SCROLL_ID]: 4 });
    applyDiffScrollTop(
      s,
      fakeRenderer({
        [`${DIFF_PATCH_SCROLL_ID}-left-code`]: left,
        [`${DIFF_PATCH_SCROLL_ID}-right-code`]: right,
      }) as any,
    );
    expect(left.scrollY).toBe(4);
    expect(right.scrollY).toBe(4);
  });

  it("skips non-diff views entirely", () => {
    const code = fakeCode(0, 5);
    const s = { diffView: { kind: "no-git" }, detailScrollTop: { [DIFF_PATCH_SCROLL_ID]: 2 } } as any;
    applyDiffScrollTop(s, fakeRenderer({ [`${DIFF_PATCH_SCROLL_ID}-left-code`]: code }) as any);
    expect(code.scrollY).toBe(0);
  });
});
