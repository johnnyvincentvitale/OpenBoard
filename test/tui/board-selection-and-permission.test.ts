import { describe, expect, it, vi } from "vitest";
import { handleKeypress } from "../../src/tui/index";
import { createMockInstanceProvider } from "../../src/tui/model";
import type { Column, PendingPermissionAsk, RespondPermissionOutcome, Task } from "../../src/shared";

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

function ask(id: string, overrides: Partial<PendingPermissionAsk> = {}): PendingPermissionAsk {
  return {
    id,
    harness: "opencode",
    source: "worktree-fence",
    permission: "edit",
    summary: `ask ${id}`,
    raisedAt: 1,
    deadline: 1_000_000,
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
      respondPermission: vi.fn(
        async (_taskId: string, input: { askId: string; action: "allow_once" | "deny"; answeredBy: string }): Promise<RespondPermissionOutcome> => ({
          ok: true,
          askId: input.askId,
          decision: input.action,
        }),
      ),
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
    openSettings: vi.fn(async () => undefined),
    refreshSettings: vi.fn(async () => undefined),
    editorSpawner: {
      runTerminalEditor: vi.fn(async () => ({ code: 0 })),
      spawnGuiEditor: vi.fn(),
      ...(overrides as any).editorSpawner,
    },
    ...overrides,
  } as any;
}

describe("Files detail tab must not swallow card/permission actions (P3-6)", () => {
  it("answers a pending permission (y) while the Files tab is open instead of silently no-oping", async () => {
    const t = task("t1", "in_progress", { pendingPermissions: [ask("ask-1")] });
    const s = state({ tasks: [t], selectedTaskId: "t1", detailTab: "files" });
    const a = actions();

    await handleKeypress({ sequence: "y", name: "y" } as any, s, a);

    expect(a.client.respondPermission).toHaveBeenCalledWith("t1", { askId: "ask-1", action: "allow_once", answeredBy: "User" });
  });

  it("still handles Files-tab-local keys (Escape) without falling through", async () => {
    const t = task("t1", "review");
    const s = state({ tasks: [t], selectedTaskId: "t1", detailTab: "files" });
    const a = actions();

    await handleKeypress({ name: "escape", sequence: "" } as any, s, a);

    expect(s.detailTab).toBeUndefined();
  });
});

describe("Filtered-out selection is reconciled before navigation/actions (P3-7)", () => {
  it("reconciles selection to a visible card before answering a permission ask, rather than acting on a hidden card", async () => {
    const hidden = task("hidden", "in_progress", { agent: "agent-a", pendingPermissions: [ask("hidden-ask")] });
    const visible = task("visible", "in_progress", { agent: "agent-b", pendingPermissions: [ask("visible-ask")] });
    const s = state({
      tasks: [hidden, visible],
      selectedTaskId: "hidden",
      boardFilter: { kind: "agent", value: "agent-b" },
    });
    const a = actions();

    await handleKeypress({ sequence: "y", name: "y" } as any, s, a);

    expect(s.selectedTaskId).toBe("visible");
    expect(a.client.respondPermission).toHaveBeenCalledWith("visible", { askId: "visible-ask", action: "allow_once", answeredBy: "User" });
  });

  it("down-navigation from a filtered-out selection lands on the first visible card, not the second", async () => {
    const hidden = task("hidden", "todo", { agent: "agent-a" });
    const first = task("first", "todo", { agent: "agent-b", position: 0 });
    const second = task("second", "todo", { agent: "agent-b", position: 1 });
    const s = state({
      tasks: [hidden, first, second],
      selectedTaskId: "hidden",
      boardFilter: { kind: "agent", value: "agent-b" },
    });
    const a = actions();

    await handleKeypress({ name: "down", sequence: "" } as any, s, a);

    expect(s.selectedTaskId).toBe("first");
  });
});

describe("Permission response is bound to the ask/card actually shown (P3-8)", () => {
  it("refuses to silently answer a different card's ask after a background refresh reselects, and rebinds instead", async () => {
    const goneTaskAsk = ask("ask-A");
    const otherTask = task("other", "in_progress", { pendingPermissions: [ask("ask-B")] });
    const s = state({
      tasks: [otherTask], // "gone" has vanished from the task list, as if a poll reassigned selection
      selectedTaskId: "other",
      permissionAskBinding: { taskId: "gone", askId: goneTaskAsk.id }, // still bound to the vanished card's ask
    });
    const a = actions();

    await handleKeypress({ sequence: "y", name: "y" } as any, s, a);

    // Must NOT silently answer "other"'s ask-B just because it's now selected.
    expect(a.client.respondPermission).not.toHaveBeenCalled();
    expect(s.status).toContain("press again");
    // Rebinds to what's now shown, so a follow-up press acts deliberately.
    expect(s.permissionAskBinding).toEqual({ taskId: "other", askId: "ask-B" });

    await handleKeypress({ sequence: "y", name: "y" } as any, s, a);
    expect(a.client.respondPermission).toHaveBeenCalledWith("other", { askId: "ask-B", action: "allow_once", answeredBy: "User" });
  });

  it("answers immediately when there is no prior binding (first-ever press, e.g. app bootstrap)", async () => {
    const t = task("t1", "in_progress", { pendingPermissions: [ask("ask-1")] });
    const s = state({ tasks: [t], selectedTaskId: "t1" }); // permissionAskBinding never set
    const a = actions();

    await handleKeypress({ sequence: "y", name: "y" } as any, s, a);

    expect(a.client.respondPermission).toHaveBeenCalledWith("t1", { askId: "ask-1", action: "allow_once", answeredBy: "User" });
  });

  it("rebinds to the newly selected card's ask on explicit arrow navigation", async () => {
    const first = task("first", "todo", { position: 0, pendingPermissions: [ask("ask-1")] });
    const second = task("second", "todo", { position: 1, pendingPermissions: [ask("ask-2")] });
    const s = state({ tasks: [first, second], selectedTaskId: "first", permissionAskBinding: { taskId: "first", askId: "ask-1" } });
    const a = actions();

    await handleKeypress({ name: "down", sequence: "" } as any, s, a);

    expect(s.selectedTaskId).toBe("second");
    expect(s.permissionAskBinding).toEqual({ taskId: "second", askId: "ask-2" });
  });
});
