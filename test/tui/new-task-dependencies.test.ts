import { describe, expect, it, vi } from "vitest";
import { handleKeypress } from "../../src/tui/index";
import { createMockInstanceProvider } from "../../src/tui/model";
import type { Task } from "../../src/shared";

function task(id: string, title = id): Task {
  return {
    id,
    title,
    description: "",
    directory: "/repo",
    column: "todo",
    position: 0,
    runState: "unstarted",
    baseCommit: null,
    dirtyAtDispatch: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function state(overrides: Record<string, unknown> = {}) {
  return {
    tasks: [],
    agents: [],
    providers: [],
    acpConfig: {},
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
      createTask: vi.fn(async (input: any) => ({ ...task("created", input.title), ...input })),
      updateTask: vi.fn(async (_id: string, input: any) => ({ ...task("edited", input.title), ...input })),
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
    editorSpawner: { runTerminalEditor: vi.fn(), spawnGuiEditor: vi.fn() },
    ...overrides,
  } as any;
}

describe("TUI new-task dependency picker", () => {
  it("selects multiple parent tasks from the dependency screen", async () => {
    const s = state({ tasks: [task("parent-1", "Parent One"), task("parent-2", "Parent Two")] });
    const a = actions();

    await handleKeypress({ sequence: "n", name: "n" } as any, s, a);
    s.newTask.step = "dependencies";
    s.newTask.field = "dependency";

    await handleKeypress({ sequence: " ", name: "space" } as any, s, a);
    await handleKeypress({ sequence: "\u001b[B", name: "down" } as any, s, a);
    await handleKeypress({ sequence: " ", name: "space" } as any, s, a);

    expect(s.newTask.parentIds).toEqual(["parent-1", "parent-2"]);
  });

  it("sends selected parentIds when creating a task", async () => {
    const createTask = vi.fn(async (input: any) => ({ ...task("created", input.title), ...input }));
    const s = state({ tasks: [task("parent-1"), task("parent-2")] });
    const a = actions({ client: { createTask } });

    await handleKeypress({ sequence: "n", name: "n" } as any, s, a);
    s.newTask.title = "Child task";
    s.newTask.step = "confirm";
    s.newTask.parentIds = ["parent-1", "parent-2"];

    await handleKeypress({ sequence: "\r", name: "return" } as any, s, a);

    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({
      title: "Child task",
      parentIds: ["parent-1", "parent-2"],
    }));
  });

  it("does not offer the edited task as its own dependency", async () => {
    const child = task("child", "Child");
    const parent = task("parent", "Parent");
    const s = state({ tasks: [child, parent], selectedTaskId: "child" });
    const a = actions();

    await handleKeypress({ sequence: "e", name: "e" } as any, s, a);
    s.newTask.step = "dependencies";
    s.newTask.field = "dependency";

    await handleKeypress({ sequence: " ", name: "space" } as any, s, a);

    expect(s.newTask.parentIds).toEqual(["parent"]);
  });
});
