import { describe, expect, it, vi } from "vitest";
import { handleKeypress, renderApp } from "../../src/tui/index";
import { createMockInstanceProvider } from "../../src/tui/model";
import { TASK_KINDS, type RespondPermissionOutcome, type Task } from "../../src/shared";

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

function fakeUi() {
  return {
    TextAttributes: { BOLD: "bold" },
    Box: (props: Record<string, unknown>, ...children: unknown[]) => ({ type: "Box", props, children }),
    ScrollBox: (props: Record<string, unknown>, ...children: unknown[]) => ({ type: "ScrollBox", props, children }),
    Text: (props: Record<string, unknown>) => ({ type: "Text", props, children: [] }),
    fg: () => (value: unknown) => String(value),
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((out, part, index) => `${out}${part}${index < values.length ? String(values[index]) : ""}`, ""),
  } as any;
}

function textOf(node: any): string {
  if (!node || typeof node !== "object") return "";
  const own = typeof node.props?.content === "string" ? node.props.content : "";
  return [own, ...(node.children ?? []).map(textOf)].filter(Boolean).join("\n");
}

function newTaskDraft(overrides: Record<string, unknown> = {}) {
  return {
    type: "agent" as const,
    taskKind: "none" as const,
    title: "",
    description: "",
    directory: "/repo",
    harness: "opencode" as const,
    providerId: "",
    agentId: "",
    permissionMode: "bypassPermissions",
    acpOptions: {},
    assignedTo: "",
    model: undefined,
    isolation: "worktree" as const,
    permissionOverrides: { edit: "allow", bash: "allow", webfetch: "allow" },
    parentIds: [] as string[],
    dependencyIndex: 0,
    step: "identity" as const,
    field: "type" as const,
    textCursors: {},
    textScrolls: {},
    submitting: false,
    ...overrides,
  };
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

  describe("task-kind cycling", () => {
    it("advances through all six task kinds and wraps to none", async () => {
      const s = state({ tasks: [] });
      s.newTask = newTaskDraft({ title: "Test", step: "harness", field: "taskKind" });
      const a = actions();

      const labels: string[] = [];
      // initial + six right presses covers the full cycle, ending back at none
      for (let i = 0; i <= TASK_KINDS.length; i += 1) {
        labels.push(textOf(renderApp(fakeUi(), s)));
        await handleKeypress({ sequence: "\u001b[C", name: "right" } as any, s, a);
      }

      const expectedOrder = ["None", "Research", "Synthesis", "Build", "Audit", "Fix", "None"];
      const expectedUseFor = [
        "Use for ordinary cards that do not need a workflow role.",
        "Use for gathering facts, sources, and constraints without changing code.",
        "Use for turning evidence or prior work into a plan, recommendation, or next card graph.",
        "Use for creating or changing implementation, docs, tests, or artifacts.",
        "Use for reviewing work and reporting findings without fixing them.",
        "Use for resolving a known finding or defect with targeted changes.",
        "Use for ordinary cards that do not need a workflow role.",
      ];
      for (let i = 0; i < expectedOrder.length; i += 1) {
        expect(labels[i]).toContain("TASK TYPE");
        expect(labels[i]).toContain(expectedOrder[i]);
        expect(labels[i]).toContain(expectedUseFor[i]);
      }
    });
  });

  describe("dependency picker edge cases", () => {
    it("renders an empty-state when no candidates exist", () => {
      const s = state({ tasks: [] });
      s.newTask = newTaskDraft({ step: "dependencies", field: "dependency" });
      const rendered = renderApp(fakeUi(), s);
      expect(textOf(rendered)).toContain("No existing tasks available");
    });

    it("windows candidate list and moves the selection without exceeding bounds", async () => {
      const candidates = Array.from({ length: 12 }, (_, i) => task(`p-${i}`, `Parent ${i}`));
      const s = state({ tasks: candidates });
      s.newTask = newTaskDraft({ step: "dependencies", field: "dependency", dependencyIndex: 0 });
      const a = actions();

      // initial render should show first 8 candidates
      const first = textOf(renderApp(fakeUi(), s));
      expect(first).toContain("Parent 0");
      expect(first).toContain("Parent 7");
      expect(first).not.toContain("Parent 8");

      // move down to wrap past bottom boundary
      for (let i = 0; i < candidates.length; i += 1) {
        await handleKeypress({ sequence: "\u001b[B", name: "down" } as any, s, a);
      }
      expect(s.newTask.dependencyIndex).toBe(0);

      // moving up across top boundary wraps to the last candidate
      await handleKeypress({ sequence: "\u001b[A", name: "up" } as any, s, a);
      expect(s.newTask.dependencyIndex).toBe(candidates.length - 1);
    });

    it("_preserves selected dependencies across windowing", async () => {
      const candidates = Array.from({ length: 10 }, (_, i) => task(`p-${i}`, `Parent ${i}`));
      const s = state({ tasks: candidates });
      s.newTask = newTaskDraft({ step: "dependencies", field: "dependency", dependencyIndex: 0, parentIds: ["p-0"] });
      const a = actions();

      const first = textOf(renderApp(fakeUi(), s));
      expect(first).toContain("☑ Parent 0");

      // scroll well past the selected item
      for (let i = 0; i < 8; i += 1) {
        await handleKeypress({ sequence: "\u001b[B", name: "down" } as any, s, a);
      }
      await handleKeypress({ sequence: " ", name: "space" } as any, s, a);
      expect(s.newTask.parentIds).toContain("p-0");
      expect(s.newTask.parentIds).toContain(`p-${(0 + 8) % candidates.length}`);
    });
  });

  describe("confirm step PARENTS summary", () => {
    it("renders selected parent titles on the confirm screen", () => {
      const parents = [
        task("parent-1", "Backend refactor"),
        task("parent-2", "API contract"),
      ];
      const s = state({ tasks: parents });
      s.newTask = newTaskDraft({
        step: "confirm",
        field: "confirm",
        title: "Implement endpoints",
        parentIds: ["parent-1", "parent-2"],
      });
      const rendered = textOf(renderApp(fakeUi(), s));
      expect(rendered).toContain("PARENTS");
      expect(rendered).toContain("Backend refactor");
      expect(rendered).toContain("API contract");
    });

    it("renders None under PARENTS when no parents are selected", () => {
      const s = state({ tasks: [] });
      s.newTask = newTaskDraft({ step: "confirm", field: "confirm", title: "Solo task", parentIds: [] });
      const rendered = textOf(renderApp(fakeUi(), s));
      expect(rendered).toContain("PARENTS");
      expect(rendered).toContain("None");
    });
  });
});
