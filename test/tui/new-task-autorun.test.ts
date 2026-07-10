import { describe, expect, it, vi } from "vitest";
import { handleKeypress, renderApp } from "../../src/tui/index";
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

function textNodesContaining(node: any, needle: string): any[] {
  if (!node || typeof node !== "object") return [];
  const matches = node.type === "Text" && typeof node.props?.content === "string" && node.props.content.includes(needle) ? [node] : [];
  return [...matches, ...(node.children ?? []).flatMap((child: unknown) => textNodesContaining(child, needle))];
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
    autoRun: false,
    permissionOverrides: { edit: "allow", bash: "allow", webfetch: "allow" },
    parentIds: [] as string[],
    dependencyIndex: 0,
    step: "isolation" as const,
    field: "isolation" as const,
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

describe("TUI new-task AUTO-RUN toggle", () => {
  it("shows only the availability hint (no toggle) for an unfenced in_place draft", () => {
    const s = state();
    s.newTask = newTaskDraft({ isolation: "in-place" });

    const text = textOf(renderApp(fakeUi(), s));
    expect(text).toContain('AUTO-RUN: available for in_place cards when EDIT and BASH are "deny"');
    // No toggle: the warning can never render and Tab cycling never reaches autoRun.
    expect(text).not.toContain("Auto-run dispatches this card");
    const seen = new Set<string>();
    for (let i = 0; i < 8; i += 1) {
      seen.add(s.newTask.field);
      void handleKeypress({ name: "tab", sequence: "\t" } as any, s, actions());
    }
    expect(seen.has("autoRun")).toBe(false);
  });

  it("shows the toggle (no hint) for a fenced in_place draft (edit+bash deny)", () => {
    const s = state();
    s.newTask = newTaskDraft({
      isolation: "in-place",
      permissionOverrides: { edit: "deny", bash: "deny", webfetch: "allow" },
    });

    const text = textOf(renderApp(fakeUi(), s));
    expect(text).toContain("AUTO-RUN");
    expect(text).not.toContain("AUTO-RUN: available for in_place cards");
  });

  it("resets autoRun when a fenced in_place draft weakens bash off deny", async () => {
    const s = state();
    s.newTask = newTaskDraft({
      isolation: "in-place",
      permissionOverrides: { edit: "deny", bash: "deny", webfetch: "allow" },
      autoRun: true,
      field: "permBash",
    });
    const a = actions();

    await handleKeypress({ sequence: "[C", name: "right" } as any, s, a);

    expect(s.newTask.permissionOverrides.bash).not.toBe("deny");
    expect(s.newTask.autoRun).toBe(false);
  });

  it("is visible on the isolation screen when isolation is worktree", () => {
    const s = state();
    s.newTask = newTaskDraft({ isolation: "worktree" });

    const text = textOf(renderApp(fakeUi(), s));
    expect(text).toContain("AUTO-RUN");
  });

  it("is visible for non-OpenCode harnesses too, since autoRun does not depend on harness", () => {
    const s = state();
    s.newTask = newTaskDraft({ harness: "claude-code", isolation: "worktree" });

    const text = textOf(renderApp(fakeUi(), s));
    expect(text).toContain("AUTO-RUN");
  });

  it("toggles on via the field-cycle key", async () => {
    const s = state();
    s.newTask = newTaskDraft({ isolation: "worktree", field: "autoRun" });
    const a = actions();

    await handleKeypress({ sequence: "[C", name: "right" } as any, s, a);

    expect(s.newTask.autoRun).toBe(true);
  });

  it("resets to false when isolation flips away from worktree", async () => {
    const s = state();
    s.newTask = newTaskDraft({ isolation: "worktree", autoRun: true, field: "isolation" });
    const a = actions();

    await handleKeypress({ sequence: "[C", name: "right" } as any, s, a);

    expect(s.newTask.isolation).toBe("in-place");
    expect(s.newTask.autoRun).toBe(false);
  });

  it("does not reset when isolation flips from in_place back to worktree", async () => {
    const s = state();
    s.newTask = newTaskDraft({ isolation: "in-place", autoRun: false, field: "isolation" });
    const a = actions();

    await handleKeypress({ sequence: "[C", name: "right" } as any, s, a);

    expect(s.newTask.isolation).toBe("worktree");
    expect(s.newTask.autoRun).toBe(false);
  });

  it("renders the locked warning text when toggled on", () => {
    const s = state();
    s.newTask = newTaskDraft({ isolation: "worktree", autoRun: true });

    const app = renderApp(fakeUi(), s);
    const warningNode = textNodesContaining(app, "Auto-run dispatches this card as soon as its parents report complete")[0];
    expect(warningNode).toBeTruthy();
    expect(warningNode.props.content).toContain(
      "Downstream worktrees branch from base before parents are integrated, so later diffs can duplicate parent changes, blurring which card made which edit.",
    );
    // Locked copy must never be clipped to a fixed row count.
    expect(warningNode.props.height).toBeGreaterThan(2);
  });

  it("does not render the warning text when toggled off", () => {
    const s = state();
    s.newTask = newTaskDraft({ isolation: "worktree", autoRun: false });

    const text = textOf(renderApp(fakeUi(), s));
    expect(text).not.toContain("Auto-run dispatches this card");
  });

  describe("confirm screen", () => {
    it("shows the AUTO-RUN row in the isolation/permissions group when worktree-isolated", () => {
      const s = state();
      s.newTask = newTaskDraft({ step: "confirm", field: "confirm" as any, isolation: "worktree", autoRun: true });

      const text = textOf(renderApp(fakeUi(), s));
      expect(text).toContain("AUTO-RUN");
      expect(text).toContain("On");
    });

    it("omits the AUTO-RUN row for in_place isolation", () => {
      const s = state();
      s.newTask = newTaskDraft({ step: "confirm", field: "confirm" as any, isolation: "in-place", autoRun: false });

      const text = textOf(renderApp(fakeUi(), s));
      expect(text).not.toContain("AUTO-RUN");
    });
  });

  describe("editing an existing task", () => {
    it("pre-fills the toggle from the task's stored autoRun", async () => {
      const todoTask = { ...task("todo-card", "Chain child"), isolation: "worktree" as const, autoRun: true };
      const s = state({ tasks: [todoTask], selectedTaskId: "todo-card" });

      await handleKeypress({ name: "e", sequence: "e" } as any, s, actions());

      expect(s.newTask?.autoRun).toBe(true);
    });

    it("defaults to false when the task never set autoRun", async () => {
      const todoTask = task("todo-card", "Plain card");
      const s = state({ tasks: [todoTask], selectedTaskId: "todo-card" });

      await handleKeypress({ name: "e", sequence: "e" } as any, s, actions());

      expect(s.newTask?.autoRun).toBe(false);
    });
  });

  describe("create/update payloads", () => {
    it("carries autoRun on task creation", async () => {
      const createTask = vi.fn(async (payload: unknown) => ({ ...task("created", "Chain child"), ...(payload as object) }));
      const s = state();
      s.newTask = newTaskDraft({ step: "confirm", title: "Chain child", isolation: "worktree", autoRun: true });

      await handleKeypress({ name: "return", sequence: "\r" } as any, s, actions({ client: { createTask } }));

      expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ isolation: "worktree", autoRun: true }));
    });

    it("carries autoRun on task update (edit)", async () => {
      const updateTask = vi.fn(async (_id: string, payload: unknown) => ({ ...task("todo-card", "Chain child"), ...(payload as object) }));
      const s = state();
      s.newTask = newTaskDraft({
        step: "confirm",
        title: "Chain child",
        isolation: "worktree",
        autoRun: true,
        editingTaskId: "todo-card",
      });

      await handleKeypress({ name: "return", sequence: "\r" } as any, s, actions({ client: { updateTask } }));

      expect(updateTask).toHaveBeenCalledWith("todo-card", expect.objectContaining({ isolation: "worktree", autoRun: true }));
    });
  });
});

describe("TUI To Do card AUTO-RUN badge", () => {
  it("renders a chain badge on a To Do card with autoRun true", () => {
    const chainCard = { ...task("chain-card", "Chain child"), type: "agent" as const, isolation: "worktree" as const, autoRun: true };
    const s = state({ tasks: [chainCard] });

    const text = textOf(renderApp(fakeUi(), s));
    expect(text).toContain("auto");
  });

  it("does not render a chain badge for a To Do card without autoRun", () => {
    const plainCard = { ...task("plain-card", "Plain card"), type: "agent" as const };
    const s = state({ tasks: [plainCard] });

    const text = textOf(renderApp(fakeUi(), s));
    expect(text).not.toContain("⛓");
  });

  it("does not render a chain badge once an autoRun card leaves To Do", () => {
    const chainCard = { ...task("chain-card", "Chain child"), type: "agent" as const, isolation: "worktree" as const, autoRun: true, column: "in_progress" as const, runState: "running" as const };
    const s = state({ tasks: [chainCard] });

    const text = textOf(renderApp(fakeUi(), s));
    expect(text).not.toContain("⛓");
  });
});
