import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveTaskShortcut, boardApiFetchInit, handleKeypress, handlePaste, renderApp } from "../../src/tui/index";
import { createMockInstanceProvider, initialViewState, type InstanceListItem } from "../../src/tui/model";
import type { Column, Task } from "../../src/shared";

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

function boxesContaining(node: any, needle: string): any[] {
  if (!node || typeof node !== "object") return [];
  const matches = node.type === "Box" && textOf(node).includes(needle) ? [node] : [];
  return [...matches, ...(node.children ?? []).flatMap((child: unknown) => boxesContaining(child, needle))];
}

function textNodesContaining(node: any, needle: string): any[] {
  if (!node || typeof node !== "object") return [];
  const matches = node.type === "Text" && typeof node.props?.content === "string" && node.props.content.includes(needle) ? [node] : [];
  return [...matches, ...(node.children ?? []).flatMap((child: unknown) => textNodesContaining(child, needle))];
}

function nodesByType(node: any, type: string): any[] {
  if (!node || typeof node !== "object") return [];
  const matches = node.type === type ? [node] : [];
  return [...matches, ...(node.children ?? []).flatMap((child: unknown) => nodesByType(child, type))];
}

function nodeById(node: any, id: string): any | undefined {
  if (!node || typeof node !== "object") return undefined;
  if (node.props?.id === id) return node;
  for (const child of node.children ?? []) {
    const match = nodeById(child, id);
    if (match) return match;
  }
  return undefined;
}

function metaRowByLabel(node: any, label: string): any | undefined {
  return nodesByType(node, "Box")
    .find((candidate) =>
      candidate.props?.height === 1 &&
      candidate.props?.flexDirection === "row" &&
      candidate.children?.[0]?.props?.content === label &&
      candidate.children?.[0]?.props?.width === 13);
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function instance(name: string, status: InstanceListItem["runtime"]["status"], port: number, extra: Partial<InstanceListItem> = {}): InstanceListItem {
  return {
    definition: { name, port, workspace: `/work/${name}`, dbPath: `/data/${name}.sqlite` },
    runtime: { status, boardUrl: `http://127.0.0.1:${port}` },
    cardCount: null,
    ...extra,
  };
}

function task(id: string, column: Column): Task {
  return {
    id,
    title: id,
    description: "",
    directory: "/repo",
    column,
    position: 0,
    runState: "idle",
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
    viewState: initialViewState,
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

describe("TUI instance rendering", () => {
  it("mock provider rename updates instance state", async () => {
    const provider = createMockInstanceProvider();
    await provider.add("old-name", "/repo");
    await provider.start("old-name");

    const renamed = await provider.rename("old-name", "new-name");
    const entries = await provider.list();

    expect(renamed.name).toBe("new-name");
    expect(entries.map((entry) => entry.definition.name)).toEqual(["new-name"]);
    expect(entries[0]?.runtime.status).toBe("running");
  });

  it("renders launch rows for every runtime status", () => {
    const app = renderApp(fakeUi(), state({
      instanceList: [
        instance("alpha", "running", 4097, { cardCount: 3 }),
        instance("beta", "stopped", 4098),
        instance("gamma", "stale-pid", 4099),
        instance("delta", "unhealthy", 4100, { cardCountError: "timeout" }),
      ],
    }));

    const text = textOf(app);
    expect(text).not.toContain("OpenBoard Instances");
    expect(text).toContain("● alpha  RUNNING  :4097  /work/alpha · 3 cards");
    expect(text).toContain("○ beta  STOPPED  :4098  /work/beta");
    expect(text).toContain("⚠ gamma  STALE  :4099  /work/gamma");
    expect(text).toContain("! delta  UNHEALTHY  :4100  /work/delta · —");
  });

  it("renders vertical separation between the launch wordmark and instance rows", () => {
    const app = renderApp(fakeUi(), state({
      instanceList: [instance("alpha", "running", 4097, { cardCount: 3 })],
      terminalRows: 56,
    }));

    const wordmarkAndSpacer = (app as any).children[1].children.slice(0, 2);
    expect(wordmarkAndSpacer[0].props.height).toBe(6);
    expect(wordmarkAndSpacer[1].props.height).toBe(2);
  });

  it("shows a minimum-size screen instead of rendering cramped layout", () => {
    const app = renderApp(fakeUi(), state({
      terminalCols: 120,
      terminalRows: 24,
      instanceList: [instance("alpha", "running", 4097, { cardCount: 3 })],
    }));

    const text = textOf(app);
    expect(text).toContain("OpenBoard needs more room");
    expect(text).toContain("Current 120x24");
    expect(text).toContain("minimum 160x30");
    expect(text).not.toContain("● alpha");
  });

  it("validates add-instance names before calling the provider", async () => {
    const addInstance = vi.fn();
    const s = state({
      overlay: "addInstance",
      addInstance: { name: "Bad Name", workspace: "/repo", field: "name", submitting: false },
    });

    await handleKeypress({ name: "return", sequence: "\r" } as any, s, actions({ addInstance }));

    expect(addInstance).not.toHaveBeenCalled();
    expect(s.addInstance.error).toContain("lowercase kebab-case");
  });

  it("e key opens the rename overlay for the selected instance", async () => {
    const s = state({
      instanceList: [instance("alpha", "stopped", 4097)],
      selectedInstanceIndex: 0,
    });

    await handleKeypress({ name: "e", sequence: "e" } as any, s, actions());

    expect(s.overlay).toBe("renameInstance");
    expect(s.renameInstance.oldName).toBe("alpha");
  });

  it("rename overlay validates kebab-case names before calling the provider", async () => {
    const renameInstance = vi.fn();
    const s = state({
      overlay: "renameInstance",
      renameInstance: { oldName: "alpha", newName: "Bad Name", field: "newName", submitting: false },
    });

    await handleKeypress({ name: "return", sequence: "\r" } as any, s, actions({ renameInstance }));

    expect(renameInstance).not.toHaveBeenCalled();
    expect(s.renameInstance.error).toContain("lowercase kebab-case");
  });

  it("A key opens archive view from board view", async () => {
    const s = state({ viewState: { view: "board", previousView: "launch" } });

    await handleKeypress({ name: "A", sequence: "A" } as any, s, actions({
      openArchive: async () => {
        s.viewState = { view: "archive", previousView: "board" };
      },
    }));

    expect(s.viewState.view).toBe("archive");
  });

  it("A key opens archive view from launch view", async () => {
    const s = state({ viewState: initialViewState });

    await handleKeypress({ name: "A", sequence: "A" } as any, s, actions({
      openArchive: async () => {
        s.viewState = { view: "archive", previousView: "launch" };
      },
    }));

    expect(s.viewState.view).toBe("archive");
  });

  it("renders the switcher and reattached INSTANCE sidebar row", async () => {
    const alpha = instance("alpha", "running", 4097);
    const beta = instance("beta", "running", 4200);
    const s = state({
      viewState: { view: "switcher", previousView: "board" },
      instanceList: [alpha, beta],
      switcherSelectedIndex: 1,
      boardUrl: alpha.runtime.boardUrl,
      tasks: [task("done-card", "done")],
      selectedTaskId: "done-card",
    });

    expect(textOf(renderApp(fakeUi(), s))).toContain("Switch Instance");

    await handleKeypress({ name: "return", sequence: "\r" } as any, s, actions({
      attachInstance: async (item: InstanceListItem) => {
        s.boardUrl = item.runtime.boardUrl;
        s.cwd = item.definition.workspace;
      },
    }));

    const text = textOf(renderApp(fakeUi(), s));
    expect(s.viewState.view).toBe("board");
    expect(text).toContain("INSTANCE");
    expect(text).toContain("beta:4200");
  });
});

describe("TUI label cleanup", () => {
  it("launch view uses 'launch board', 'add board', and 'global archive' labels", () => {
    const app = renderApp(fakeUi(), state({
      instanceList: [instance("alpha", "running", 4097, { cardCount: 3 })],
    }));

    const text = textOf(app);
    expect(text).toContain("↵ launch board");
    expect(text).toContain("n add board");
    expect(text).toContain("q quit · A global archive");
    expect(countOccurrences(text, "↵ launch board")).toBe(1);
    expect(countOccurrences(text, "A global archive")).toBe(1);
    expect(text).not.toContain("enter attach");
    expect(text).not.toContain("n add · s stop");
  });

  it("launch view header no longer shows 'INSTANCES' label", () => {
    const app = renderApp(fakeUi(), state({ instanceList: [] }));

    const text = textOf(app);
    const lines = text.split("\n");
    // The header line text should be empty (not "INSTANCES")
    const headerTexts = lines.filter((l) => l.trim().length > 0);
    const instancesLabel = headerTexts.find((l) => l.includes("INSTANCES"));
    expect(instancesLabel).toBeUndefined();
  });

  it("board view command hints use 'switch board' and 'new task'", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("test-card", "todo")],
    }));

    const text = textOf(app);
    expect(text).toContain("esc instances");
    expect(text).toContain("b switch board");
    expect(text).toContain("n new task");
    expect(text).not.toContain("m move card");
    expect(text).not.toContain("b switch · n new");
  });

  it("q quits from launch view", async () => {
    const shutdown = vi.fn();
    const s = state({
      viewState: { view: "launch", previousView: null },
      instanceList: [instance("alpha", "running", 4097, { cardCount: 3 })],
    });

    await handleKeypress({ name: "q", sequence: "q" } as any, s, actions({ shutdown }));

    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("board header shows health/version without removing instance and task count", () => {
    const alpha = instance("alpha", "running", 4097);
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      instanceList: [alpha],
      boardUrl: alpha.runtime.boardUrl,
      tasks: [task("todo-card", "todo")],
      health: { adapter: "ok", opencode: { status: "ok", version: "1.2.3" } },
      lastRefresh: new Date("2026-07-04T12:00:00Z"),
    }));

    const text = textOf(app);
    expect(text).toContain("INSTANCE alpha:4097");
    expect(text).toContain("WORKSPACE /work/alpha");
    expect(text).toContain("1 TASK");
    expect(text).toContain("Board ok · OpenCode 1.2.3");
  });

  it("selected-card action hints are contextual for Done cards", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("done-card", "done")],
      selectedTaskId: "done-card",
    }));

    const text = textOf(app);
    expect(text).toContain("a archive · d delete");
    expect(text).toContain("m move · ↵ details");
    expect(text).not.toContain("r run · R retry");
    expect(text).not.toContain("s sync");
  });

  it("selected-card action hints are contextual for To Do cards", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
    }));

    const text = textOf(app);
    expect(text).toContain("r run · e edit · d delete");
    expect(text).toContain("m move · ↵ details");
    expect(text).not.toContain("R retry");
    expect(text).not.toContain("s sync");
    expect(text).not.toContain("i integrate");
  });

  it("selected-card action hints are contextual for In Progress cards", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [{ ...task("running-card", "in_progress"), runState: "running" }],
      selectedTaskId: "running-card",
    }));

    const text = textOf(app);
    expect(text).toContain("k abort · m move");
    expect(text).toContain("↵ details");
    expect(text).not.toContain("r run");
    expect(text).not.toContain("R retry");
    expect(text).not.toContain("a archive");
    expect(text).not.toContain("d delete");
  });

  it("selected-card action hints allow deleting Error cards", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [{ ...task("error-card", "in_progress"), runState: "error" }],
      selectedTaskId: "error-card",
    }));

    const text = textOf(app);
    expect(text).toContain("R retry · d delete");
    expect(text).toContain("m move · ↵ details");
    expect(text).not.toContain("r run");
    expect(text).not.toContain("k abort");
    expect(text).not.toContain("a archive");
  });

  it("selected-card action hints are contextual for Review cards", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("review-card", "review")],
      selectedTaskId: "review-card",
    }));

    const text = textOf(app);
    expect(text).toContain("v diff · i integrate · x done");
    expect(text).toContain("d delete · m move · ↵ details");
    expect(text).not.toContain("s sync");
    expect(text).not.toContain("r run");
    expect(text).not.toContain("R retry");
  });

  it("selected-card action hints are contextual for manual Review cards", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [{ ...task("review-card", "review"), type: "manual" }],
      selectedTaskId: "review-card",
    }));

    const text = textOf(app);
    expect(text).toContain("v diff · i integrate · x done");
    expect(text).toContain("d delete · m move · ↵ details");
    expect(text).not.toContain("s sync");
  });
});

describe("TUI new-task prompt editor", () => {
  function pasteEvent(text: string) {
    let prevented = false;
    return {
      bytes: Uint8Array.from(Buffer.from(text, "utf8")),
      preventDefault: () => {
        prevented = true;
      },
      get defaultPrevented() {
        return prevented;
      },
    } as any;
  }

  it("selects and deletes prompt text in the new task form", async () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      overlay: "newTask",
      newTask: {
        type: "agent",
        title: "",
        description: "delete me",
        directory: "/repo",
        harness: "opencode",
        agentId: "",
        claudePermissionMode: "bypassPermissions",
        assignedTo: "",
        isolation: "worktree",
        field: "description",
        submitting: false,
      },
    });

    await handleKeypress({ name: "a", sequence: "\u0001", ctrl: true } as any, s, actions());
    await handleKeypress({ name: "backspace", sequence: "\u007f" } as any, s, actions());

    expect(s.newTask.description).toBe("");
  });

  it("deletes prompt text at the cursor instead of only from the end", async () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      overlay: "newTask",
      newTask: {
        type: "agent",
        title: "",
        description: "abc",
        directory: "/repo",
        harness: "opencode",
        agentId: "",
        claudePermissionMode: "bypassPermissions",
        assignedTo: "",
        isolation: "worktree",
        field: "description",
        textCursors: { description: 1 },
        submitting: false,
      },
    });

    await handleKeypress({ name: "delete", sequence: "\u001b[3~" } as any, s, actions());

    expect(s.newTask.description).toBe("ac");
  });

  it("command-delete deletes the current prompt line", async () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      overlay: "newTask",
      newTask: {
        type: "agent",
        title: "",
        description: "first\nsecond\nthird",
        directory: "/repo",
        harness: "opencode",
        agentId: "",
        claudePermissionMode: "bypassPermissions",
        assignedTo: "",
        isolation: "worktree",
        field: "description",
        textCursors: { description: "first\nsec".length },
        submitting: false,
      },
    });

    await handleKeypress({ name: "delete", sequence: "\u001b[3~", meta: true } as any, s, actions());

    expect(s.newTask.description).toBe("first\nthird");
    expect(s.newTask.textCursors.description).toBe("first\n".length);
  });

  it("ctrl-u terminal mapping deletes the current prompt line", async () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      overlay: "newTask",
      newTask: {
        type: "agent",
        title: "",
        description: "first\nsecond\nthird",
        directory: "/repo",
        harness: "opencode",
        agentId: "",
        claudePermissionMode: "bypassPermissions",
        assignedTo: "",
        isolation: "worktree",
        field: "description",
        textCursors: { description: "first\nsec".length },
        submitting: false,
      },
    });

    await handleKeypress({ name: "u", sequence: "\u0015", ctrl: true } as any, s, actions());

    expect(s.newTask.description).toBe("first\nthird");
    expect(s.newTask.textCursors.description).toBe("first\n".length);
  });

  it("command-delete clears single-line new-task text fields", async () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      overlay: "newTask",
      newTask: {
        type: "agent",
        title: "dirty repo warning smoke",
        description: "",
        directory: "/repo",
        harness: "opencode",
        agentId: "",
        claudePermissionMode: "bypassPermissions",
        assignedTo: "",
        isolation: "worktree",
        field: "title",
        submitting: false,
      },
    });

    await handleKeypress({ name: "backspace", sequence: "\u007f", meta: true } as any, s, actions());

    expect(s.newTask.title).toBe("");
  });

  it("scrolls long prompt text inside the prompt field", async () => {
    const longPrompt = Array.from({ length: 80 }, (_, index) => `line-${index}`).join(" ");
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      overlay: "newTask",
      newTask: {
        type: "agent",
        title: "",
        description: longPrompt,
        directory: "/repo",
        harness: "opencode",
        agentId: "",
        claudePermissionMode: "bypassPermissions",
        assignedTo: "",
        isolation: "worktree",
        field: "description",
        textCursors: { description: 0 },
        textScrolls: { description: 0 },
        submitting: false,
      },
    });

    await handleKeypress({ name: "down", sequence: "\u001b[B" } as any, s, actions());

    expect(s.newTask.textScrolls.description).toBeGreaterThan(0);
    const text = textOf(renderApp(fakeUi(), s));
    expect(text).toContain("line-10");
  });

  it("pastes multi-line text into the focused prompt field", () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      overlay: "newTask",
      newTask: {
        type: "agent",
        title: "",
        description: "before\n",
        directory: "/repo",
        harness: "claude-code",
        agentId: "",
        claudePermissionMode: "bypassPermissions",
        assignedTo: "",
        isolation: "in-place",
        field: "description",
        textCursors: { description: "before\n".length },
        submitting: false,
      },
    });
    const event = pasteEvent("line one\nline two\n");

    handlePaste(event, s, actions());

    expect(event.defaultPrevented).toBe(true);
    expect(s.newTask.description).toBe("before\nline one\nline two\n");
  });

  it("pastes single-line-normalized text into title fields", () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      overlay: "newTask",
      newTask: {
        type: "agent",
        title: "",
        description: "",
        directory: "/repo",
        harness: "opencode",
        agentId: "",
        claudePermissionMode: "bypassPermissions",
        assignedTo: "",
        isolation: "worktree",
        field: "title",
        submitting: false,
      },
    });

    handlePaste(pasteEvent("dirty\nrepo\nsmoke\n"), s, actions());

    expect(s.newTask.title).toBe("dirty repo smoke");
  });
});

describe("TUI switcher start/stop controls", () => {
  it("renders start and stop controls plus transient lifecycle states", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "switcher", previousView: "board" },
      instanceList: [
        instance("alpha", "running", 4097),
        instance("beta", "stopped", 4098),
      ],
      instanceActionState: { beta: "starting" },
      switcherSelectedIndex: 1,
    }));

    const text = textOf(app);
    expect(text).toContain("alpha  RUNNING  :4097  s stop");
    expect(text).toContain("beta  STARTING  :4098  s start");
    expect(text).toContain("s start/stop");
  });

  it("s starts a stopped instance from the switcher", async () => {
    const startInstance = vi.fn(async () => undefined);
    const beta = instance("beta", "stopped", 4098);
    const s = state({
      viewState: { view: "switcher", previousView: "board" },
      instanceList: [beta],
      switcherSelectedIndex: 0,
    });

    await handleKeypress({ name: "s", sequence: "s" } as any, s, actions({ startInstance }));

    expect(startInstance).toHaveBeenCalledWith("beta");
  });

  it("s stops a running instance from the switcher", async () => {
    const stopInstance = vi.fn(async () => undefined);
    const alpha = instance("alpha", "running", 4097);
    const s = state({
      viewState: { view: "switcher", previousView: "board" },
      instanceList: [alpha],
      switcherSelectedIndex: 0,
    });

    await handleKeypress({ name: "s", sequence: "s" } as any, s, actions({ stopInstance }));

    expect(stopInstance).toHaveBeenCalledWith("alpha");
  });
});

describe("TUI archive shortcut", () => {
  it("posts archive for a selected Done card", async () => {
    const previousToken = process.env.OPENBOARD_API_TOKEN;
    delete process.env.OPENBOARD_API_TOKEN;
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const refresh = vi.fn(async () => undefined);
    const s = state({ tasks: [task("done-card", "done")], status: "ready" });

    try {
      await archiveTaskShortcut(s, "http://127.0.0.1:4097", "done-card", vi.fn(), refresh, fetchImpl as any);
    } finally {
      if (previousToken === undefined) delete process.env.OPENBOARD_API_TOKEN;
      else process.env.OPENBOARD_API_TOKEN = previousToken;
    }

    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:4097/api/tasks/done-card/archive", { method: "POST" });
    expect(refresh).toHaveBeenCalled();
    expect(s.status).toBe("archived: done-card");
  });

  it("sends the board API token on raw TUI fetches", () => {
    const previousToken = process.env.OPENBOARD_API_TOKEN;
    process.env.OPENBOARD_API_TOKEN = "test-token";

    try {
      const init = boardApiFetchInit({ method: "POST" });
      const headers = init.headers;

      expect(init.method).toBe("POST");
      expect(headers).toBeInstanceOf(Headers);
      expect((headers as Headers).get("Authorization")).toBe("Bearer test-token");
    } finally {
      if (previousToken === undefined) delete process.env.OPENBOARD_API_TOKEN;
      else process.env.OPENBOARD_API_TOKEN = previousToken;
    }
  });

  it("does not request archive for non-Done cards", async () => {
    const fetchImpl = vi.fn();
    const s = state({ tasks: [task("todo-card", "todo")], status: "ready" });

    await archiveTaskShortcut(s, "http://127.0.0.1:4097", "todo-card", vi.fn(), vi.fn(), fetchImpl as any);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(s.status).toBe("Archive: only Done cards");
  });
});

describe("TUI archive detail cleanup", () => {
  it("detail block does not render SUMMARY, CHANGED FILES, VERIFICATION, or RESIDUAL RISK in the top detail block", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "archive", previousView: "launch" },
      archive: archiveState(archiveRecord("task-1", "2026-07-03 12:00", JSON.stringify({
        outcome: "complete",
        summary: "Fixed the bug",
        changedFiles: ["src/a.ts"],
        verification: [{ command: "npm test", result: "passed" }],
        residualRisk: "none",
      }))),
    }));

    const text = textOf(app);

    // The detail block should NOT contain these labels (they moved to the Handoff tab)
    // Check by scanning the Detail panel section for these labels
    expect(text).toContain("Prompt");
    expect(text).toContain("Handoff");
    expect(text).not.toContain("SUMMARY");
    expect(text).not.toContain("CHANGED FILES");
    expect(text).not.toContain("VERIFICATION");
    expect(text).not.toContain("RESIDUAL RISK");
    expect(text).not.toContain("Fixed the bug");
    expect(text).not.toContain("src/a.ts");
    expect(text).not.toContain("npm test → passed");

    // The detail labels should include the selected-card fields plus archive context.
    expect(text).toContain("STATE");
    expect(text).toContain("INSTANCE");
    expect(text).toContain("TYPE");
    expect(text).toContain("LANE");
    expect(text).toContain("AGENT");
    expect(text).toContain("MODEL");
    expect(text).toContain("DIR");
    expect(text).toContain("ISO");
    expect(text).toContain("TASK ID");
    expect(text).toContain("WORKSPACE");
    expect(text).toContain("ARCHIVED");
  });

  it("handoff tab renders completion info when completion is present", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "archive", previousView: "launch" },
      archive: archiveState(archiveRecord("task-1", "2026-07-03 12:00", JSON.stringify({
        outcome: "complete",
        summary: "Fixed the bug",
        changedFiles: ["src/a.ts", "src/b.ts"],
        verification: [{ command: "npm test", result: "passed" }],
        residualRisk: "none",
      })), "handoff"),
    }));

    const text = textOf(app);
    // Handoff tab should render the completion info
    expect(text).toContain("SUMMARY");
    expect(text).toContain("Fixed the bug");
    expect(text).toContain("CHANGED FILES");
    expect(text).toContain("src/a.ts, src/b.ts");
    expect(text).toContain("VERIFICATION");
    expect(text).toContain("npm test → passed");
    expect(text).toContain("RESIDUAL RISK");
    expect(text).toContain("none");
  });

  it("archive detail tabs render in stable manual viewports without ScrollBox chrome", () => {
    const s = state({
      detailScrollTop: { "archive-detail-prompt-task-1": 9 },
      viewState: { view: "archive", previousView: "launch" },
      archive: archiveState(archiveRecord("task-1", "2026-07-03 12:00", null), "prompt"),
    });
    const promptApp = renderApp(fakeUi(), state({
      viewState: { view: "archive", previousView: "launch" },
      archive: archiveState(archiveRecord("task-1", "2026-07-03 12:00", null), "prompt"),
    }));
    const handoffApp = renderApp(fakeUi(), state({
      viewState: { view: "archive", previousView: "launch" },
      archive: archiveState(archiveRecord("task-1", "2026-07-03 12:00", JSON.stringify({
        outcome: "complete",
        summary: "Fixed the bug",
        changedFiles: ["src/a.ts"],
        verification: [],
        residualRisk: "none",
      })), "handoff"),
    }));

    expect(nodesByType(promptApp, "ScrollBox").map((node) => node.props.id)).not.toContain("archive-detail-prompt-task-1");
    expect(nodesByType(handoffApp, "ScrollBox").map((node) => node.props.id)).not.toContain("archive-detail-handoff-task-1");
    expect(nodeById(promptApp, "archive-detail-prompt-task-1")?.props).toMatchObject({ overflow: "hidden", minHeight: 0 });
    expect(nodeById(handoffApp, "archive-detail-handoff-task-1")?.props).toMatchObject({ overflow: "hidden", minHeight: 0 });
    expect(textOf(promptApp)).toContain("Output");
    expect(textOf(promptApp)).toContain("Comments");
    expect(nodeById(renderApp(fakeUi(), s), "archive-detail-prompt-task-1-content")?.props.top).toBe(-9);
  });

  it("archive detail manual viewports save wheel offsets for remounts", () => {
    const s = state({
      viewState: { view: "archive", previousView: "launch" },
      archive: archiveState(archiveRecord("task-1", "2026-07-03 12:00", null), "prompt"),
    });
    const app = renderApp(fakeUi(), s);
    const viewport = nodeById(app, "archive-detail-prompt-task-1");
    const content = nodeById(app, "archive-detail-prompt-task-1-content");
    content.height = 40;
    const requestRender = vi.fn();
    const event = { scroll: { direction: "down" }, preventDefault: vi.fn(), stopPropagation: vi.fn() };

    viewport?.props.onMouseScroll.call({ height: 10, findDescendantById: () => content, requestRender }, event);

    expect(s.detailScrollTop["archive-detail-prompt-task-1"]).toBe(3);
    expect(content.top).toBe(-3);
    expect(requestRender).toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it("handoff tab renders empty state when completion is null", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "archive", previousView: "launch" },
      archive: archiveState(archiveRecord("task-1", "2026-07-03 12:00", null), "handoff"),
    }));

    const text = textOf(app);
    expect(text).toContain("No completion report available");
  });

  it("handoff tab renders empty state when completion is empty object", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "archive", previousView: "launch" },
      archive: archiveState(archiveRecord("task-1", "2026-07-03 12:00", "{}"), "handoff"),
    }));

    const text = textOf(app);
    expect(text).toContain("No completion report available");
  });

  it("prompt tab renders the original description", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "archive", previousView: "launch" },
      archive: archiveState(archiveRecord("task-1", "2026-07-03 12:00", null), "prompt"),
    }));

    const text = textOf(app);
    expect(text).toContain("Fix the login bug"); // from archiveRecord default description
  });

  it("detail metadata uses selected-card spacing and includes card fields", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "archive", previousView: "launch" },
      archive: archiveState(archiveRecord("task-1", "2026-07-03 12:00", null, {
        task_type: "agent",
        completed_by: "User",
        session_id: "ses_123",
        worktree_path: "/repo/.openboard-worktrees/example_123_reported_complete",
        worktree_branch: "board/task-1",
        base_branch: "main",
      }), "prompt"),
    }));

    for (const label of ["STATE", "INSTANCE", "TYPE", "ACCEPTED BY", "LANE", "AGENT", "MODEL", "DIR", "ISO", "WORKTREE", "SESSION", "BRANCH", "BASE", "TASK ID"]) {
      const row = metaRowByLabel(app, label);
      expect(row?.children[0].props.width).toBe(13);
      expect(row?.children[1].props.fg).toBe("#ffffff");
    }

    const text = textOf(app);
    expect(text).toContain("agent");
    expect(text).toContain("User");
    expect(text).toContain("example_123_reported_complete");
    expect(text).toContain("ses_123");
    expect(text).toContain("board/task-1");
    expect(text).toContain("main");
    expect(text).toContain("task-1");
  });

  it("output tab renders archived final session output", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "archive", previousView: "launch" },
      archive: archiveState(archiveRecord("task-1", "2026-07-03 12:00", null, {
        final_session_output: "archived assistant output",
      }), "output"),
    }));

    expect(textOf(app)).toContain("archived assistant output");
    expect(nodeById(app, "archive-detail-output-task-1")).toBeDefined();
    expect(nodesByType(app, "ScrollBox").map((node) => node.props.id)).not.toContain("archive-detail-output-task-1");
  });

  it("comments tab renders archived comments and replies", () => {
    const comments = [
      { id: "c1", taskId: "task-1", parentCommentId: null, author: "User", body: "top-level note", createdAt: 1 },
      { id: "c2", taskId: "task-1", parentCommentId: "c1", author: "Agent", body: "reply note", createdAt: 2 },
    ];
    const app = renderApp(fakeUi(), state({
      viewState: { view: "archive", previousView: "launch" },
      archive: archiveState(archiveRecord("task-1", "2026-07-03 12:00", null, {
        comments: JSON.stringify(comments),
      }), "comments"),
    }));

    const text = textOf(app);
    expect(text).toContain("top-level note");
    expect(text).toContain("reply note");
    expect(nodeById(app, "archive-detail-comments-task-1")).toBeDefined();
    expect(nodesByType(app, "ScrollBox").map((node) => node.props.id)).not.toContain("archive-detail-comments-task-1");
  });

  it("prompt tab renders empty prompt message when description is empty", () => {
    const record = archiveRecord("task-1", "2026-07-03 12:00", null);
    record.description = "";
    const app = renderApp(fakeUi(), state({
      viewState: { view: "archive", previousView: "launch" },
      archive: archiveState(record, "prompt"),
    }));

    const text = textOf(app);
    expect(text).toContain("(empty prompt)");
  });
});

describe("TUI archive search mode indicator", () => {
  it("shows search mode indicator with Enter hint when search mode is active", () => {
    const records = [archiveRecord("task-1", "2026-07-03 12:00", null)];
    const app = renderApp(fakeUi(), state({
      viewState: { view: "archive", previousView: "launch" },
      archive: {
        ...archiveState(records, "prompt"),
        searchMode: true,
        searchQuery: "login",
      },
    }));

    const text = textOf(app);
    expect(text).toContain("⌕ / search: login▍");
    expect(text).toContain("enter to exit");
  });

  it("shows plain filter label when search mode is inactive", () => {
    const records = [archiveRecord("task-1", "2026-07-03 12:00", null)];
    const app = renderApp(fakeUi(), state({
      viewState: { view: "archive", previousView: "launch" },
      archive: {
        ...archiveState(records, "prompt"),
        searchMode: false,
        searchQuery: "",
      },
    }));

    const text = textOf(app);
    expect(text).not.toContain("⌕ / search:");
    expect(text).toContain("all archived tasks");
  });

  it("search mode Exit via Enter key", async () => {
    const s = state({
      viewState: { view: "archive", previousView: "launch" },
      archive: {
        ...archiveState([archiveRecord("task-1", "2026-07-03 12:00", null)], "prompt"),
        searchMode: true,
        searchQuery: "test",
      },
    });

    expect(s.archive.searchMode).toBe(true);

    await handleKeypress({ name: "return", sequence: "\r" } as any, s, actions());

    expect(s.archive.searchMode).toBe(false);
    // Search query is preserved (not cleared on Enter exit)
    expect(s.archive.searchQuery).toBe("test");
  });
});

describe("TUI archive list windowing", () => {
  it("renders a selected-row window with overflow indicators for long archive lists", () => {
    const records = Array.from({ length: 30 }, (_, index) =>
      archiveRecord(`task-${String(index).padStart(2, "0")}`, "2026-07-03 12:00", null),
    );
    const app = renderApp(fakeUi(), state({
      viewState: { view: "archive", previousView: "launch" },
      terminalRows: 30,
      archive: {
        ...archiveState(records),
        selectedIndex: 20,
      },
    }));

    const text = textOf(app);
    expect(text).toContain("▸ 2026-07-03 · test-instance · Task task-20");
    expect(text).toContain("↑ ");
    expect(text).toContain("↓ ");
    expect(text).not.toContain("Task task-00");
  });
});

describe("TUI archive tab navigation", () => {
  it("renders Prompt tab as active by default", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "archive", previousView: "launch" },
      archive: archiveState(archiveRecord("task-1", "2026-07-03 12:00", null)),
    }));

    const text = textOf(app);
    // All detail tabs should render.
    expect(text).toContain("Prompt");
    expect(text).toContain("Handoff");
    expect(text).toContain("Output");
    expect(text).toContain("Comments");
    // Prompt should be active (showing the description)
    expect(text).toContain("Fix the login bug");
  });

  it("left/right arrow key switches tab", async () => {
    const s = state({
      viewState: { view: "archive", previousView: "launch" },
      archive: archiveState(archiveRecord("task-1", "2026-07-03 12:00", null), "prompt"),
    });

    expect(s.archive.detailTab).toBe("prompt");

    await handleKeypress({ name: "right", sequence: "\u001b[C" } as any, s, actions());
    expect(s.archive.detailTab).toBe("handoff");

    await handleKeypress({ name: "left", sequence: "\u001b[D" } as any, s, actions());
    expect(s.archive.detailTab).toBe("prompt");
  });

  it("tab key cycles through all archive detail tabs", async () => {
    const s = state({
      viewState: { view: "archive", previousView: "launch" },
      archive: archiveState(archiveRecord("task-1", "2026-07-03 12:00", null), "prompt"),
    });

    expect(s.archive.detailTab).toBe("prompt");

    await handleKeypress({ name: "tab", sequence: "\t" } as any, s, actions());
    expect(s.archive.detailTab).toBe("handoff");

    await handleKeypress({ name: "tab", sequence: "\t" } as any, s, actions());
    expect(s.archive.detailTab).toBe("output");

    await handleKeypress({ name: "tab", sequence: "\t" } as any, s, actions());
    expect(s.archive.detailTab).toBe("comments");

    await handleKeypress({ name: "tab", sequence: "\t" } as any, s, actions());
    expect(s.archive.detailTab).toBe("prompt");
  });

  it("tab navigation does not activate in search mode", async () => {
    const s = state({
      viewState: { view: "archive", previousView: "launch" },
      archive: {
        ...archiveState(archiveRecord("task-1", "2026-07-03 12:00", null), "prompt"),
        searchMode: true,
        searchQuery: "test",
      },
    });

    await handleKeypress({ name: "right", sequence: "\u001b[C" } as any, s, actions());
    // Search mode appends printable chars; "right" key has a multi-char sequence
    // that doesn't match printable patterns, so it should be a no-op
    // The key is consumed by search mode but doesn't change tab
    expect(s.archive.detailTab).toBe("prompt");
  });

  it("footer text includes tab navigation discovery", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "archive", previousView: "launch" },
      archive: archiveState(archiveRecord("task-1", "2026-07-03 12:00", null), "prompt"),
    }));

    const text = textOf(app);
    expect(text).toContain("←/→ tabs: Prompt/Handoff");
  });
});

describe("TUI board view command strip", () => {
  it("board view command strip includes A global archive after q quit", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("test-card", "todo")],
    }));

    const text = textOf(app);
    expect(text).not.toContain("m move card");
    expect(text).toContain("q quit · A global archive");
  });

  it("board view puts the connection header below the menu and removes duplicate task refresh labels from the menu", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("test-card", "todo")],
      status: "1 task",
      lastRefresh: new Date("2026-07-04T12:00:00Z"),
    }));

    const text = textOf(app);
    expect(text.indexOf("q quit · A global archive")).toBeLessThan(text.indexOf("CONNECTED"));
    expect(text).toContain("1 TASK");

    const commandStrip = nodesByType(app, "Box")
      .find((node) => node.props?.border === true && textOf(node).includes("q quit · A global archive"));
    expect(commandStrip).toBeTruthy();
    expect(textOf(commandStrip)).not.toContain("1 task");
    expect(textOf(commandStrip)).not.toContain("last refresh");
  });

  it("launch view command strip already includes A global archive", () => {
    const app = renderApp(fakeUi(), state({
      instanceList: [instance("alpha", "running", 4097)],
    }));

    const text = textOf(app);
    expect(text).toContain("q quit · A global archive");
  });
});

describe("TUI Enter key shows inline selected-card details", () => {
  it("Enter on a selected card shows prompt tab in the Selected column", async () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
    });

    await handleKeypress({ name: "return", sequence: "\r" } as any, s, actions());

    expect(s.overlay).toBe("none");
    expect(s.detailTab).toBe("prompt");
  });

  it("Enter with no selection does not show inline detail tabs", async () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: undefined,
    });

    await handleKeypress({ name: "return", sequence: "\r" } as any, s, actions());

    expect(s.overlay).not.toBe("detail");
    expect(s.detailTab).toBeUndefined();
  });

  it("Selected column renders Prompt and Handoff tabs when inline detail is active", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
      detailTab: "prompt",
    }));

    const text = textOf(app);
    expect(text).toContain("Prompt");
    expect(text).toContain("Handoff");
  });

  it("Selected column grows on wider terminals", () => {
    const narrow = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      terminalCols: 160,
      tasks: [task("todo-card", "todo")],
      selectedTaskId: undefined,
    }));
    const wide = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      terminalCols: 210,
      tasks: [task("todo-card", "todo")],
      selectedTaskId: undefined,
    }));

    const narrowSelected = boxesContaining(narrow, "No cards yet")
      .find((node) => node.props?.title === "Selected");
    const wideSelected = boxesContaining(wide, "No cards yet")
      .find((node) => node.props?.title === "Selected");

    expect(narrowSelected?.props.width).toBe(44);
    expect(wideSelected?.props.width).toBeGreaterThan(44);
  });

  it("Selected column reserves one row per inline detail metadata item", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
      detailTab: "prompt",
    }));

    const metadataBox = boxesContaining(app, "STATE")
      .find((node) => textOf(node).includes("TASK ID") && textOf(node).includes("TYPE") && textOf(node).includes("LANE") && textOf(node).includes("AGENT") && node.props?.height === 5);

    expect(metadataBox).toBeTruthy();
  });

  it("Selected column shows STATE above TYPE", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      terminalRows: 30,
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
    }));

    const text = textOf(app);
    expect(text.indexOf("STATE")).toBeGreaterThan(-1);
    expect(text.indexOf("TYPE")).toBeGreaterThan(-1);
    expect(text.indexOf("STATE")).toBeLessThan(text.indexOf("TYPE"));
  });

  it("Selected column shows STATE above INSTANCE before opening details", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      terminalRows: 30,
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
    }));

    const text = textOf(app);
    expect(text.indexOf("STATE")).toBeGreaterThan(-1);
    expect(text.indexOf("INSTANCE")).toBeGreaterThan(-1);
    expect(text.indexOf("STATE")).toBeLessThan(text.indexOf("INSTANCE"));
  });

  it("Selected column shows TASK ID for normal and inline detail views", () => {
    const normal = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      terminalRows: 56,
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
    }));
    const inline = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      terminalRows: 56,
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
      detailTab: "prompt",
    }));

    expect(textOf(normal)).toContain("TASK ID");
    expect(textOf(normal)).toContain("todo-card");
    expect(textOf(inline)).toContain("TASK ID");
    expect(textOf(inline)).toContain("todo-card");
  });

  it("Selected column places TASK ID at the bottom of metadata", () => {
    const selectedTask = {
      ...task("task-bottom", "done"),
      isolation: "worktree" as const,
      worktreePath: "/repo/.worktrees/task-bottom",
      sessionId: "ses_bottom",
    };
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      terminalRows: 80,
      tasks: [selectedTask],
      selectedTaskId: "task-bottom",
    }));
    const text = textOf(app);

    expect(text.indexOf("WORKTREE")).toBeGreaterThan(-1);
    expect(text.indexOf("SESSION")).toBeGreaterThan(-1);
    expect(text.indexOf("TASK ID")).toBeGreaterThan(text.indexOf("WORKTREE"));
    expect(text.indexOf("TASK ID")).toBeGreaterThan(text.indexOf("SESSION"));
  });

  it("Selected column compact metadata has a wider gutter and white values", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      terminalRows: 30,
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
    }));

    for (const label of ["INSTANCE", "STATE", "TYPE", "LANE", "DIR"]) {
      const row = metaRowByLabel(app, label);
      expect(row?.children[0].props.width).toBe(13);
      expect(row?.children[1].props.fg).toBe("#ffffff");
    }
  });

  it("inline error detail uses compact error notice at short heights", () => {
    const errorTask = {
      ...task("error-card", "review"),
      runState: "error" as const,
      error: "long prompt layout smoke failure",
      description: "Long prompt text ".repeat(80),
    };
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      terminalRows: 30,
      tasks: [errorTask],
      selectedTaskId: "error-card",
      detailTab: "prompt",
    }));

    const errorBox = boxesContaining(app, "! ERROR")
      .find((node) => textOf(node).includes("long prompt layout smoke failure") && node.props?.height === 3);

    expect(errorBox).toBeTruthy();
  });

  it("selected error notice hugs short error text at normal heights", () => {
    const errorTask = {
      ...task("error-card", "review"),
      runState: "error" as const,
      error: "long prompt layout smoke failure",
    };
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      terminalRows: 56,
      tasks: [errorTask],
      selectedTaskId: "error-card",
      detailTab: "prompt",
    }));

    const errorBox = nodesByType(app, "Box")
      .find((node) => node.props?.id === "selected-error-box");

    expect(errorBox?.props.height).toBe(5);
  });

  it("error card selected view uses expanded label-over-value metadata at normal heights", () => {
    const errorTask = {
      ...task("error-card", "review"),
      runState: "error" as const,
      error: "long prompt layout smoke failure",
      isolation: "worktree" as const,
      worktreePath: "/repo/.worktrees/error-card",
      sessionId: "ses_error_card",
    };
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      terminalRows: 56,
      tasks: [errorTask],
      selectedTaskId: "error-card",
    }));

    const stateLabel = textNodesContaining(app, "STATE")[0];
    const taskIdLabel = textNodesContaining(app, "TASK ID")[0];
    const errorText = textOf(app);

    expect(stateLabel?.props.width).toBeUndefined();
    expect(taskIdLabel?.props.width).toBeUndefined();
    expect(errorText).toContain("error-card");
    expect(errorText).toContain("long prompt layout smoke failure");
    expect(nodesByType(app, "Box").some((node) => node.props?.id === "selected-error-box")).toBe(false);
  });

  it("inline detail mode closes with esc key", async () => {
    const detachInstance = vi.fn(async () => undefined);
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
      detailTab: "prompt",
    });

    await handleKeypress({ name: "escape", sequence: "\u001b" } as any, s, actions({ detachInstance }));

    expect(s.overlay).toBe("none");
    expect(s.detailTab).toBeUndefined();
    expect(detachInstance).not.toHaveBeenCalled();
  });

  it.each([
    ["a", "archive", task("done-card", "done")],
    ["d", "delete", task("todo-card", "todo")],
    ["x", "move-to-done", task("review-card", "review")],
  ] as const)("esc cancels %s confirmation without opening instances", async (keySequence, expectedAction, selected) => {
    const detachInstance = vi.fn(async () => undefined);
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [selected],
      selectedTaskId: selected.id,
    });
    const a = actions({ detachInstance });

    await handleKeypress({ name: keySequence, sequence: keySequence } as any, s, a);
    expect(s.pendingConfirmation).toEqual({ action: expectedAction, taskId: selected.id });

    await handleKeypress({ name: "escape", sequence: "\u001b" } as any, s, a);

    expect(s.pendingConfirmation).toBeUndefined();
    expect(s.viewState.view).toBe("board");
    expect(s.status).toBe("cancelled");
    expect(detachInstance).not.toHaveBeenCalled();
  });

  it("inline detail tab switches with left/right arrow keys", async () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
      detailTab: "prompt",
    });

    await handleKeypress({ name: "right", sequence: "\u001b[C" } as any, s, actions());
    expect(s.detailTab).toBe("handoff");

    await handleKeypress({ name: "left", sequence: "\u001b[D" } as any, s, actions());
    expect(s.detailTab).toBe("prompt");
  });

  it("inline detail tab cycles forward through all four tabs with tab key", async () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
      detailTab: "prompt",
    });
    const a = actions();

    await handleKeypress({ name: "tab", sequence: "\t" } as any, s, a);
    expect(s.detailTab).toBe("handoff");

    await handleKeypress({ name: "tab", sequence: "\t" } as any, s, a);
    expect(s.detailTab).toBe("output");

    await handleKeypress({ name: "tab", sequence: "\t" } as any, s, a);
    expect(s.detailTab).toBe("comments");

    await handleKeypress({ name: "tab", sequence: "\t" } as any, s, a);
    expect(s.detailTab).toBe("prompt");
  });

  it("inline detail mode m key shows move options in Selected column", async () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
      detailTab: "prompt",
    });

    await handleKeypress({ name: "m", sequence: "m" } as any, s, actions());

    expect(s.overlay).toBe("none");
    expect(s.detailTab).toBeUndefined();
    expect(s.moveTargetColumn).toBe("todo");
  });

  it("Enter toggles inline detail mode off", async () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
      detailTab: "prompt",
    });

    await handleKeypress({ name: "return", sequence: "\r" } as any, s, actions());

    expect(s.overlay).toBe("none");
    expect(s.detailTab).toBeUndefined();
  });
});

describe("TUI accepted-by display", () => {
  it("sidebar shows ACCEPTED BY when task has completedBy attribute", () => {
    const doneCard = { ...task("done-card", "done"), completedBy: "User" };
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [doneCard],
      selectedTaskId: "done-card",
    }));

    const text = textOf(app);
    expect(text).toContain("ACCEPTED BY");
    expect(text).toContain("User");
  });

  it("sidebar does NOT show ACCEPTED BY when task has no completedBy", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
    }));

    const text = textOf(app);
    expect(text).not.toContain("ACCEPTED BY");
  });

  it("done agent-reported cards show the agent but manual done cards do not", () => {
    const agentDone = {
      ...task("agent-done", "done"),
      type: "agent" as const,
      agent: "build",
      completedBy: "User",
      completionSource: "reported" as const,
      completion: {
        outcome: "complete" as const,
        summary: "done",
        changedFiles: [],
        verification: [],
        residualRisk: "none",
        reportedAt: 1,
      },
    };
    const manualDone = {
      ...task("manual-done", "done"),
      type: "manual" as const,
      assignedTo: "Johnny",
      completedBy: "User",
    };

    const agentText = textOf(renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [agentDone],
      selectedTaskId: "agent-done",
    })));
    expect(agentText).toContain("AGENT");
    expect(agentText).toContain("build");
    expect(agentText).toContain("ACCEPTED BY");

    const manualText = textOf(renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [manualDone],
      selectedTaskId: "manual-done",
    })));
    expect(manualText).toContain("ASSIGNED TO");
    expect(manualText).not.toContain("AGENT");
  });

});

describe("TUI worktree metadata", () => {
  it("shows worktree id below ISO and above SESSION for worktree-isolated cards", () => {
    const worktreeTask = {
      ...task("worktree-card", "review"),
      isolation: "worktree" as const,
      worktreePath: "/repo/.opencode-board-worktrees/openboard/task_abc123",
      sessionId: "ses_123",
    };
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [worktreeTask],
      selectedTaskId: "worktree-card",
      terminalRows: 80,
    }));

    const text = textOf(app);
    expect(text).toContain("ISO");
    expect(text).toContain("WORKTREE");
    expect(text).toContain("task_abc123");
    expect(text).toContain("SESSION");
    expect(text.indexOf("ISO")).toBeLessThan(text.indexOf("WORKTREE"));
    expect(text.indexOf("WORKTREE")).toBeLessThan(text.indexOf("SESSION"));
  });

  it("falls back to task id for worktree cards without a stored worktree path", () => {
    const exampleDone = {
      ...task("example_reported_complete", "done"),
      isolation: "worktree" as const,
      sessionId: "ses_123",
    };
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [exampleDone],
      selectedTaskId: "example_reported_complete",
      terminalRows: 80,
    }));

    const text = textOf(app);
    expect(text).toContain("WORKTREE");
    expect(text).toContain("example_reported_complete");
    expect(text.indexOf("WORKTREE")).toBeLessThan(text.indexOf("SESSION"));
  });
});

describe("TUI edit mode (e)", () => {
  it("e on a selected To Do card opens the task form pre-populated for editing", async () => {
    const todoTask = { ...task("todo-card", "todo"), title: "Fix the login bug", description: "Investigate the 500", agent: "build" };
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [todoTask],
      selectedTaskId: "todo-card",
    });

    await handleKeypress({ name: "e", sequence: "e" } as any, s, actions());

    expect(s.newTask?.editingTaskId).toBe("todo-card");
    expect(s.newTask?.title).toBe("Fix the login bug");
    expect(s.newTask?.description).toBe("Investigate the 500");
    expect(s.overlay).toBe("none");
  });

  it.each(["in_progress", "review", "done"] as const)("e on a selected %s card does not open edit mode", async (column) => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("card-1", column)],
      selectedTaskId: "card-1",
    });

    await handleKeypress({ name: "e", sequence: "e" } as any, s, actions());

    expect(s.newTask).toBeUndefined();
    expect(s.status).toBe("only To Do cards can be edited");
  });

  it("saving an edit calls updateTask (not createTask) and does not create a new card", async () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      newTask: {
        type: "agent",
        title: "Renamed title",
        description: "desc",
        directory: "/repo",
        harness: "opencode",
        agentId: "build",
        claudePermissionMode: "bypassPermissions",
        assignedTo: "",
        isolation: "worktree",
        field: "title",
        submitting: false,
        editingTaskId: "todo-card",
      },
    });
    const updateTask = vi.fn(async (id: string) => task(id, "todo"));
    const createTask = vi.fn(async () => task("new-card", "todo"));
    const a = actions({ client: { moveTask: vi.fn(), updateTask, createTask, listComments: vi.fn(), addComment: vi.fn() } });

    await handleKeypress({ name: "return", sequence: "\r" } as any, s, a);

    expect(updateTask).toHaveBeenCalledWith("todo-card", expect.objectContaining({ title: "Renamed title" }));
    expect(createTask).not.toHaveBeenCalled();
    expect(s.newTask).toBeUndefined();
  });
});

describe("TUI filter mode (f)", () => {
  it("f opens the global category picker from the selected card", async () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
    });

    await handleKeypress({ name: "f", sequence: "f" } as any, s, actions());

    expect(s.filterMode).toEqual({ column: "todo", step: "category", selectedIndex: 0 });
  });

  it("renders the filter picker in the details panel without replacing a lane", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
      filterMode: { column: "todo", step: "category", selectedIndex: 0 },
    }));

    const text = textOf(app);
    expect(text).toContain("todo-card");
    expect(text).toContain("Global Filter");
    expect(text).toContain("Filter by:");
  });

  it("selecting a category then a value applies the board filter and exits filter mode", async () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [
        { ...task("a1", "todo"), harness: "claude-code" },
        { ...task("a2", "in_progress"), harness: "opencode", agent: "build" },
      ],
      selectedTaskId: "a1",
      filterMode: { column: "todo", step: "category", selectedIndex: 0 },
    });
    const a = actions();

    // categories are [worktree, manual, agent]; move down twice to "agent"
    await handleKeypress({ name: "down", sequence: "[B" } as any, s, a);
    await handleKeypress({ name: "down", sequence: "[B" } as any, s, a);
    await handleKeypress({ name: "return", sequence: "\r" } as any, s, a);
    expect(s.filterMode?.step).toBe("value");
    expect(s.filterMode?.category).toBe("agent");

    await handleKeypress({ name: "return", sequence: "\r" } as any, s, a);

    expect(s.filterMode).toBeUndefined();
    expect(s.boardFilter).toEqual({ kind: "agent", value: "build" });
  });

  it("pressing f again while a filter is active clears it", async () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
      boardFilter: { kind: "agent", value: "build" },
    });

    await handleKeypress({ name: "f", sequence: "f" } as any, s, actions());

    expect(s.boardFilter).toBeUndefined();
    expect(s.filterMode).toBeUndefined();
    expect(s.status).toBe("filter cleared");
  });

  it("esc steps back from value to category, then cancels filter mode entirely", async () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
      filterMode: { column: "todo", step: "value", category: "agent", selectedIndex: 0 },
    });

    await handleKeypress({ name: "escape", sequence: "" } as any, s, actions());
    expect(s.filterMode).toEqual({ column: "todo", step: "category", selectedIndex: 0 });

    await handleKeypress({ name: "escape", sequence: "" } as any, s, actions());
    expect(s.filterMode).toBeUndefined();
  });

  it("filtered board only renders matching cards", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [
        { ...task("claude-card", "todo"), harness: "claude-code" },
        { ...task("opencode-card", "todo"), harness: "opencode", agent: "build" },
      ],
      boardFilter: { kind: "agent", value: "claude-code" },
    }));

    const text = textOf(app);
    expect(text).toContain("claude-card");
    expect(text).not.toContain("opencode-card");
  });

  it("applying a filter that hides the current selection reselects a visible card", async () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [
        { ...task("a1", "todo"), harness: "claude-code" },
        { ...task("a2", "in_progress"), harness: "opencode", agent: "build" },
      ],
      selectedTaskId: "a1",
      filterMode: { column: "todo", step: "value", category: "agent", selectedIndex: 0 },
    });
    // "agent" values sorted: ["build", "claude-code"] — index 0 is "build", which a1 (claude-code) does not match.
    const a = actions();

    await handleKeypress({ name: "return", sequence: "\r" } as any, s, a);

    expect(s.boardFilter).toEqual({ kind: "agent", value: "build" });
    expect(s.selectedTaskId).toBe("a2");
  });

  it("arrow-key navigation skips cards hidden by the active filter", async () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [
        { ...task("a1", "todo"), harness: "claude-code" },
        { ...task("a2", "in_progress"), harness: "opencode", agent: "build" },
        { ...task("a3", "review"), harness: "opencode", agent: "build" },
      ],
      selectedTaskId: "a1",
      boardFilter: { kind: "agent", value: "claude-code" },
    });

    await handleKeypress({ name: "right", sequence: "[C" } as any, s, actions());

    // a2/a3 are hidden by the filter (opencode/"build"), so a1 (the only visible
    // card, claude-code) is the only valid target and selection stays put.
    expect(s.selectedTaskId).toBe("a1");
  });
});

describe("TUI comments tab", () => {
  it("cycling to the comments tab loads the thread for the selected task", async () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("review-card", "review")],
      selectedTaskId: "review-card",
      detailTab: "output",
    });
    const listComments = vi.fn(async () => [
      { id: "c1", taskId: "review-card", author: "User", body: "Looks good", createdAt: 1, parentCommentId: null },
    ]);
    const a = actions({ client: { moveTask: vi.fn(), updateTask: vi.fn(), listComments, addComment: vi.fn() } });

    await handleKeypress({ name: "right", sequence: "[C" } as any, s, a);

    expect(s.detailTab).toBe("comments");
    expect(listComments).toHaveBeenCalledWith("review-card");
    expect(s.comments?.items).toHaveLength(1);
  });

  it("c on a Review card starts a new top-level comment draft", async () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("review-card", "review")],
      selectedTaskId: "review-card",
      detailTab: "comments",
      comments: { taskId: "review-card", items: [], loading: false, selectedIndex: 0 },
    });

    await handleKeypress({ name: "c", sequence: "c" } as any, s, actions());

    expect(s.commentDraft).toEqual({ taskId: "review-card", parentCommentId: null, text: "" });
  });

  it("c on a To Do card is refused since comments require Review or Done", async () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
      detailTab: "comments",
      comments: { taskId: "todo-card", items: [], loading: false, selectedIndex: 0 },
    });

    await handleKeypress({ name: "c", sequence: "c" } as any, s, actions());

    expect(s.commentDraft).toBeUndefined();
    expect(s.status).toBe("comments are only available on Review or Done cards");
  });

  it("submitting a comment draft persists it through addComment and reloads the thread", async () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("done-card", "done")],
      selectedTaskId: "done-card",
      detailTab: "comments",
      commentDraft: { taskId: "done-card", parentCommentId: null, text: "Shipped it" },
    });
    const addComment = vi.fn(async () => ({ id: "c2", taskId: "done-card", author: "User", body: "Shipped it", createdAt: 2, parentCommentId: null }));
    const listComments = vi.fn(async () => [{ id: "c2", taskId: "done-card", author: "User", body: "Shipped it", createdAt: 2, parentCommentId: null }]);
    const a = actions({ client: { moveTask: vi.fn(), updateTask: vi.fn(), listComments, addComment } });

    await handleKeypress({ name: "return", sequence: "\r" } as any, s, a);

    expect(addComment).toHaveBeenCalledWith("done-card", "User", "Shipped it", null);
    expect(s.commentDraft).toBeUndefined();
    expect(listComments).toHaveBeenCalledWith("done-card");
  });

  it("r replies to the selected comment, threading it under the parent", async () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("done-card", "done")],
      selectedTaskId: "done-card",
      detailTab: "comments",
      comments: {
        taskId: "done-card",
        items: [{ id: "c1", taskId: "done-card", author: "User", body: "first", createdAt: 1, parentCommentId: null }],
        loading: false,
        selectedIndex: 0,
      },
    });

    await handleKeypress({ name: "r", sequence: "r" } as any, s, actions());

    expect(s.commentDraft).toEqual({ taskId: "done-card", parentCommentId: "c1", text: "" });
  });

  it("esc while composing cancels the draft without closing the detail view", async () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("done-card", "done")],
      selectedTaskId: "done-card",
      detailTab: "comments",
      commentDraft: { taskId: "done-card", parentCommentId: null, text: "wip" },
    });

    await handleKeypress({ name: "escape", sequence: "" } as any, s, actions());

    expect(s.commentDraft).toBeUndefined();
    expect(s.detailTab).toBe("comments");
  });

  it("replying to a reply attaches the new comment to the root, not the reply", async () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("done-card", "done")],
      selectedTaskId: "done-card",
      detailTab: "comments",
      comments: {
        taskId: "done-card",
        items: [
          { id: "c1", taskId: "done-card", author: "User", body: "root", createdAt: 1, parentCommentId: null },
          { id: "c2", taskId: "done-card", author: "User", body: "reply", createdAt: 2, parentCommentId: "c1" },
        ],
        loading: false,
        selectedIndex: 1, // flattened order is [c1, c2] -- index 1 is the reply c2
      },
    });

    await handleKeypress({ name: "r", sequence: "r" } as any, s, actions());

    // Threading is one level deep, so replying to c2 (itself a reply to c1) must
    // attach to the root c1 -- otherwise it renders detached at the end of the thread.
    expect(s.commentDraft).toEqual({ taskId: "done-card", parentCommentId: "c1", text: "" });
  });

  it("q quits while browsing (not composing) the Comments tab", async () => {
    const shutdown = vi.fn(async () => undefined);
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("done-card", "done")],
      selectedTaskId: "done-card",
      detailTab: "comments",
      comments: { taskId: "done-card", items: [], loading: false, selectedIndex: 0 },
    });

    await handleKeypress({ name: "q", sequence: "q" } as any, s, actions({ shutdown }));

    expect(shutdown).toHaveBeenCalled();
  });
});

describe("TUI output tab", () => {
  it("shows the task's final session output", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [{ ...task("done-card", "done"), finalSessionOutput: "Ran the tests, all green." }],
      selectedTaskId: "done-card",
      detailTab: "output",
    }));

    expect(textOf(app)).toContain("Ran the tests, all green.");
  });

  it("shows a placeholder when no final session output is available", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("done-card", "done")],
      selectedTaskId: "done-card",
      detailTab: "output",
    }));

    expect(textOf(app)).toContain("No final session output available");
  });
});

describe("TUI manual task creation", () => {
  it("n opens the new task form in the Selected column with CARD TYPE focused", async () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
    });

    await handleKeypress({ name: "n", sequence: "n" } as any, s, actions());

    expect(s.overlay).toBe("none");
    expect(s.newTask.field).toBe("type");

    const app = renderApp(fakeUi(), s);
    const selected = boxesContaining(app, "New Task")
      .find((node) => node.props?.title === "Selected");
    const text = textOf(app);
    expect(selected).toBeTruthy();
    expect(text).toContain("CARD TYPE");
    expect(text).toContain("Create agent task");
  });

  it("renders manual card fields without agent-only controls", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      newTask: {
        type: "manual",
        title: "PM review",
        description: "Check the copy",
        directory: "/repo",
        harness: "opencode",
        agentId: "build",
        claudePermissionMode: "bypassPermissions",
        assignedTo: "Johnny",
        isolation: "worktree",
        field: "assignedTo",
        submitting: false,
      },
    }));

    const text = textOf(app);
    expect(text).toContain("CARD TYPE");
    expect(text).toContain("manual");
    expect(text).toContain("NOTES");
    expect(text).toContain("ASSIGNED TO");
    expect(text).toContain("Create manual task");
    expect(text).not.toContain("AGENT");
    expect(text).not.toContain("MODEL");
    expect(text).not.toContain("ISOLATION");
  });

  it("renders and submits Claude Code cards with a selected model", async () => {
    const createTask = vi.fn(async (payload: unknown) => ({
      ...task("claude-card", "todo"),
      ...(payload as object),
      id: "claude-card",
    }));
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      newTask: {
        type: "agent",
        title: "Claude work",
        description: "Run headlessly",
        directory: "/repo",
        harness: "claude-code",
        agentId: "plan",
        claudePermissionMode: "bypassPermissions",
        assignedTo: "",
        model: { providerID: "claude-code", id: "opus" },
        isolation: "worktree",
        field: "model",
        submitting: false,
      },
    });

    const text = textOf(renderApp(fakeUi(), s));
    expect(text).toContain("HARNESS");
    expect(text).toContain("Claude Code");
    expect(text).toContain("PERMS");
    expect(text).toContain("bypassPermissions");
    expect(text).toContain("MODEL");
    expect(text).toContain("opus");
    expect(text).not.toContain("AGENT");

    await handleKeypress({ name: "return", sequence: "\r" } as any, s, actions({
      client: { createTask },
    }));

    expect(createTask).toHaveBeenCalledWith({
      type: "agent",
      harness: "claude-code",
      title: "Claude work",
      description: "Run headlessly",
      directory: "/repo",
      claudePermissionMode: "bypassPermissions",
      model: { providerID: "claude-code", id: "opus" },
      isolation: "worktree",
    });
  });

  it("submits manual cards with type and assignee", async () => {
    const createTask = vi.fn(async (payload: unknown) => ({
      ...task("manual-card", "todo"),
      ...(payload as object),
      id: "manual-card",
    }));
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      newTask: {
        type: "manual",
        title: "PM review",
        description: "Check the copy",
        directory: "/repo",
        harness: "opencode",
        agentId: "build",
        claudePermissionMode: "bypassPermissions",
        assignedTo: "Johnny",
        isolation: "worktree",
        field: "assignedTo",
        submitting: false,
      },
    });

    await handleKeypress({ name: "return", sequence: "\r" } as any, s, actions({
      client: { createTask },
    }));

    expect(createTask).toHaveBeenCalledWith({
      type: "manual",
      title: "PM review",
      description: "Check the copy",
      directory: "/repo",
      assignedTo: "Johnny",
    });
    expect(s.overlay).toBe("none");
    expect(s.newTask).toBeUndefined();
    expect(s.selectedTaskId).toBe("manual-card");
  });

  it("does not run manual cards from the board", async () => {
    const runTask = vi.fn(async () => task("manual-card", "todo"));
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [{ ...task("manual-card", "todo"), type: "manual", assignedTo: "Johnny" }],
      selectedTaskId: "manual-card",
    });

    await handleKeypress({ name: "r", sequence: "r" } as any, s, actions({
      client: { runTask },
    }));

    expect(runTask).not.toHaveBeenCalled();
    expect(s.status).toContain("manual cards are not runnable");
  });

  it("does not run In Progress cards from the board shortcut", async () => {
    const runTask = vi.fn(async () => task("running-card", "in_progress"));
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [{ ...task("running-card", "in_progress"), runState: "running" }],
      selectedTaskId: "running-card",
    });

    await handleKeypress({ name: "r", sequence: "r" } as any, s, actions({
      client: { runTask },
    }));

    expect(runTask).not.toHaveBeenCalled();
    expect(s.status).toBe("run is only available for To Do agent cards");
  });

  it("does not retry non-error cards from the board shortcut", async () => {
    const retryTask = vi.fn(async () => task("review-card", "review"));
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("review-card", "review")],
      selectedTaskId: "review-card",
    });

    await handleKeypress({ name: "R", sequence: "R" } as any, s, actions({
      client: { retryTask },
    }));

    expect(retryTask).not.toHaveBeenCalled();
    expect(s.status).toBe("retry is only available for error cards");
  });

  it("deletes Error cards from the board shortcut", async () => {
    const deleteTask = vi.fn(async () => undefined);
    const runAction = vi.fn(async (_label: string, _action: (t: Task) => Promise<unknown>) => {});
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [{ ...task("error-card", "in_progress"), runState: "error" }],
      selectedTaskId: "error-card",
    });

    await handleKeypress({ name: "d", sequence: "d" } as any, s, actions({
      client: { deleteTask },
      runAction,
    }));

    expect(deleteTask).not.toHaveBeenCalled();
    expect(runAction).not.toHaveBeenCalled();
    expect(s.pendingConfirmation).toEqual({ action: "delete", taskId: "error-card" });

    await handleKeypress({ name: "d", sequence: "d" } as any, s, actions({
      client: { deleteTask },
      runAction,
    }));

    expect(runAction).toHaveBeenCalledTimes(1);
    expect(runAction.mock.calls[0]?.[0]).toBe("delete");
    const callback = runAction.mock.calls[0]?.[1] as (t: Task) => Promise<unknown>;
    await callback({ ...task("error-card", "in_progress"), runState: "error" });
    expect(deleteTask).toHaveBeenCalledWith("error-card");
  });

  it("k aborts In Progress cards", async () => {
    const abortTask = vi.fn(async () => ({ ...task("running-card", "in_progress"), runState: "error" as const }));
    const runAction = vi.fn(async (_label: string, _action: (t: Task) => Promise<unknown>) => {});
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [{ ...task("running-card", "in_progress"), runState: "running" }],
      selectedTaskId: "running-card",
    });

    await handleKeypress({ name: "k", sequence: "k" } as any, s, actions({
      client: { abortTask },
      runAction,
    }));

    expect(runAction).not.toHaveBeenCalled();
    expect(s.pendingConfirmation).toEqual({ action: "abort", taskId: "running-card" });

    await handleKeypress({ name: "k", sequence: "k" } as any, s, actions({
      client: { abortTask },
      runAction,
    }));

    expect(runAction).toHaveBeenCalledTimes(1);
    expect(runAction.mock.calls[0]?.[0]).toBe("abort");
    const callback = runAction.mock.calls[0]?.[1] as (t: Task) => Promise<unknown>;
    await callback({ ...task("running-card", "in_progress"), runState: "running" });
    expect(abortTask).toHaveBeenCalledWith("running-card");
  });

  it("s no longer syncs Review cards from the board shortcut", async () => {
    const syncTask = vi.fn(async () => ({ ok: true }));
    const runAction = vi.fn(async (_label: string, _action: (t: Task) => Promise<unknown>) => {});
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("review-card", "review")],
      selectedTaskId: "review-card",
    });

    await handleKeypress({ name: "s", sequence: "s" } as any, s, actions({
      client: { syncTask },
      runAction,
    }));

    expect(syncTask).not.toHaveBeenCalled();
    expect(runAction).not.toHaveBeenCalled();
  });
});

describe("TUI inline manual move", () => {
  it("m key shows move options in Selected column for selected card", async () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
    });

    await handleKeypress({ name: "m", sequence: "m" } as any, s, actions());

    expect(s.overlay).toBe("none");
    expect(s.moveTargetColumn).toBe("todo");
  });

  it("m key with no selection shows status message", async () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: undefined,
    });

    await handleKeypress({ name: "m", sequence: "m" } as any, s, actions());

    expect(s.overlay).toBe("none");
    expect(s.status).toBe("no task selected to move");
  });

  it("Selected column renders lane options with numbers in move mode", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
      moveTargetColumn: "todo",
    }));

    const text = textOf(app);
    expect(text).toContain("Move Card");
    expect(text).toContain("1. To-Do");
    expect(text).toContain("2. In-Progress");
    expect(text).toContain("3. Review");
    expect(text).toContain("4. Done");
    expect(text).toContain("↑/↓ or 1-4 select lane");
  });

  it("move to Done shows accepted-by User hint", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
      moveTargetColumn: "done",
    }));

    const text = textOf(app);
    expect(text).toContain("accepted by User");
  });

  it("move target navigates with up/down arrows", async () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
      moveTargetColumn: "todo",
    });

    await handleKeypress({ name: "down", sequence: "\u001b[B" } as any, s, actions());
    expect(s.moveTargetColumn).toBe("in_progress");

    await handleKeypress({ name: "down", sequence: "\u001b[B" } as any, s, actions());
    expect(s.moveTargetColumn).toBe("review");

    await handleKeypress({ name: "up", sequence: "\u001b[A" } as any, s, actions());
    expect(s.moveTargetColumn).toBe("in_progress");
  });

  it("move target navigates with number keys 1-4", async () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
      moveTargetColumn: "todo",
    });

    await handleKeypress({ name: "4", sequence: "4" } as any, s, actions());
    expect(s.moveTargetColumn).toBe("done");

    await handleKeypress({ name: "1", sequence: "1" } as any, s, actions());
    expect(s.moveTargetColumn).toBe("todo");
  });

  it("move esc closes inline move mode without moving", async () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
      moveTargetColumn: "done",
    });

    await handleKeypress({ name: "escape", sequence: "\u001b" } as any, s, actions());

    expect(s.overlay).toBe("none");
    expect(s.moveTargetColumn).toBeUndefined();
  });

  it("move enter to same lane closes inline move mode without API call", async () => {
    const moveTask = vi.fn(async () => []);
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
      moveTargetColumn: "todo",
    });

    await handleKeypress({ name: "return", sequence: "\r" } as any, s, actions({
      client: { moveTask },
    }));

    expect(s.overlay).toBe("none");
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("move to Done requires enter twice and calls client.moveTask with completedBy 'User'", async () => {
    const moveTask = vi.fn(async () => [{ ...task("todo-card", "done"), completedBy: "User" }]);
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
      moveTargetColumn: "done",
    });

    await handleKeypress({ name: "return", sequence: "\r" } as any, s, actions({
      client: { moveTask },
    }));

    expect(moveTask).not.toHaveBeenCalled();
    expect(s.pendingConfirmation).toEqual({ action: "move-to-done", taskId: "todo-card" });
    expect(s.status).toContain("Press enter again");

    await handleKeypress({ name: "return", sequence: "\r" } as any, s, actions({
      client: { moveTask },
    }));

    expect(moveTask).toHaveBeenCalledWith("todo-card", "done", 0, "User");
    expect(s.overlay).toBe("none");
    expect(s.moveTargetColumn).toBeUndefined();
    expect(s.status).toContain("moved todo-card to Done");
  });

  it("move to non-Done calls client.moveTask with completedBy null", async () => {
    const moveTask = vi.fn(async () => [task("todo-card", "in_progress")]);
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
      moveTargetColumn: "in_progress",
    });

    await handleKeypress({ name: "return", sequence: "\r" } as any, s, actions({
      client: { moveTask },
    }));

    expect(moveTask).toHaveBeenCalledWith("todo-card", "in_progress", 0, null);
    expect(s.overlay).toBe("none");
  });

  it("move API rejection keeps tasks and reports move failed", async () => {
    const originalTasks = [task("todo-card", "todo")];
    const moveTask = vi.fn(async () => {
      throw new Error("server rejected move");
    });
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: originalTasks,
      selectedTaskId: "todo-card",
      moveTargetColumn: "review",
    });

    await handleKeypress({ name: "return", sequence: "\r" } as any, s, actions({
      client: { moveTask },
    }));

    expect(moveTask).toHaveBeenCalledWith("todo-card", "review", 0, null);
    expect(s.tasks).toBe(originalTasks);
    expect(s.error).toBe("server rejected move");
    expect(s.status).toBe("move failed");
  });

  it("x key arms then moves to Done with completedBy 'User'", async () => {
    const moveTask = vi.fn(async () => [{ ...task("review-card", "done"), completedBy: "User" }]);
    const runAction = vi.fn(async (_label: string, _action: (t: Task) => Promise<unknown>) => {});
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("review-card", "review")],
      selectedTaskId: "review-card",
    });

    await handleKeypress({ name: "x", sequence: "x" } as any, s, actions({
      client: { moveTask },
      runAction,
    }));

    expect(runAction).not.toHaveBeenCalled();
    expect(s.pendingConfirmation).toEqual({ action: "move-to-done", taskId: "review-card" });

    await handleKeypress({ name: "x", sequence: "x" } as any, s, actions({
      client: { moveTask },
      runAction,
    }));

    // Second press calls runAction with label "move done" and a callback
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(runAction.mock.calls[0]?.[0]).toBe("move done");
    expect(typeof runAction.mock.calls[0]?.[1]).toBe("function");

    // Invoke the callback to verify completedBy is passed
    const callback = runAction.mock.calls[0]?.[1] as (t: Task) => Promise<unknown>;
    if (callback) {
      await callback(task("review-card", "review"));
      expect(moveTask).toHaveBeenCalledWith("review-card", "done", 0, "User");
    }
  });
});

describe("TUI handoff text wrapping", () => {
  it("archive handoff tab uses wrapped text not truncation for SUMMARY", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "archive", previousView: "launch" },
      archive: archiveState(archiveRecord("task-1", "2026-07-03 12:00", JSON.stringify({
        outcome: "complete",
        summary: "This is a very long summary that should wrap properly across multiple lines",
        changedFiles: ["src/a.ts"],
        verification: [],
        residualRisk: "none",
      })), "handoff"),
    }));

    const text = textOf(app);
    expect(text).toContain("SUMMARY");
    expect(text).toContain("This is a very long summary");
  });

  it("board detail handoff tab uses wrapped text for completion fields", () => {
    const theTask = {
      ...task("done-card", "done"),
      completion: {
        outcome: "complete" as const,
        summary: "Fixed a very long summary that should wrap",
        changedFiles: ["src/client/board-client.ts", "src/tui/index.ts"],
        verification: [{ command: "npm run typecheck", result: "passed" }],
        residualRisk: "none",
        reportedAt: 1,
      },
    };
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [theTask],
      selectedTaskId: "done-card",
      detailTab: "handoff",
    }));

    const text = textOf(app);
    expect(text).toContain("SUMMARY");
    expect(text).toContain("Fixed a very long summary that should wrap");
    expect(text).toContain("CHANGED FILES");
    expect(text).toContain("src/client/board-client.ts, src/tui/index.ts");
    expect(text).toContain("VERIFICATION");
    expect(text).toContain("npm run typecheck → passed");
    expect(text).toContain("RESIDUAL RISK");

    // Sections grow to their content instead of clipping at a fixed few rows.
    // The enclosing manual viewport handles scrolling without ScrollBox chrome.
    const changedFilesText = textNodesContaining(app, "src/client/board-client.ts")[0];
    const verificationText = textNodesContaining(app, "npm run typecheck")[0];
    expect(changedFilesText.props).toMatchObject({ wrapMode: "char", width: "100%", minWidth: 0, flexShrink: 1 });
    expect(changedFilesText.props.height).toBeUndefined();
    expect(verificationText.props).toMatchObject({ wrapMode: "char", width: "100%", minWidth: 0, flexShrink: 1 });
    expect(verificationText.props.height).toBeUndefined();

    expect(nodeById(app, "board-detail-handoff-done-card")).toBeDefined();
    expect(nodesByType(app, "ScrollBox").map((node) => node.props.id)).not.toContain("board-detail-handoff-done-card");
  });

  it("board detail handoff tab shows empty state when no completion", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
      detailTab: "handoff",
    }));

    const text = textOf(app);
    expect(text).toContain("No completion report available");
  });

  it("board detail prompt tab renders task description", () => {
    const theTask = { ...task("todo-card", "todo"), description: "Fix the login bug" };
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [theTask],
      selectedTaskId: "todo-card",
      detailTab: "prompt",
      detailScrollTop: { "board-detail-prompt-todo-card": 11 },
    });
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [theTask],
      selectedTaskId: "todo-card",
      detailTab: "prompt",
    }));

    const text = textOf(app);
    expect(text).toContain("Fix the login bug");
    expect(nodeById(app, "board-detail-prompt-todo-card")?.props).toMatchObject({ overflow: "hidden", minHeight: 0 });
    expect(nodesByType(app, "ScrollBox").map((node) => node.props.id)).not.toContain("board-detail-prompt-todo-card");
    expect(nodeById(renderApp(fakeUi(), s), "board-detail-prompt-todo-card-content")?.props.top).toBe(-11);
  });

  it("board detail manual viewports save wheel offsets for remounts", () => {
    const theTask = { ...task("todo-card", "todo"), description: "Fix the login bug" };
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [theTask],
      selectedTaskId: "todo-card",
      detailTab: "prompt",
    });
    const app = renderApp(fakeUi(), s);
    const viewport = nodeById(app, "board-detail-prompt-todo-card");
    const content = nodeById(app, "board-detail-prompt-todo-card-content");
    content.height = 40;
    const requestRender = vi.fn();
    const event = { scroll: { direction: "down" }, preventDefault: vi.fn(), stopPropagation: vi.fn() };

    viewport?.props.onMouseScroll.call({ height: 10, findDescendantById: () => content, requestRender }, event);

    expect(s.detailScrollTop["board-detail-prompt-todo-card"]).toBe(3);
    expect(content.top).toBe(-3);
    expect(requestRender).toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it("board detail prompt tab shows empty state when description is empty", () => {
    const theTask = { ...task("todo-card", "todo"), description: "" };
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [theTask],
      selectedTaskId: "todo-card",
      detailTab: "prompt",
    }));

    const text = textOf(app);
    expect(text).toContain("(empty prompt)");
  });
});

describe("TUI workspace gate", () => {
  const tempDirs: string[] = [];
  const makeTempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "openboard-ws-"));
    tempDirs.push(dir);
    return dir;
  };

  afterAll(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it("renders a blocking setup view with directory prompt", () => {
    const app = renderApp(fakeUi(), state({ viewState: { view: "workspaceGate", previousView: "launch" } }));
    const text = textOf(app);
    expect(text).toContain("SETUP");
    expect(text).toContain("Workspace Required");
    expect(text).toContain("Please specify a directory path");
    expect(text).toContain("DIRECTORY");
    expect(text).toContain("type absolute path · enter confirm · esc quit");
  });

  it("shows current-project affordance only for project-like cwd", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "package.json"), "{}");
    const text = textOf(renderApp(fakeUi(), state({ viewState: { view: "workspaceGate", previousView: "launch" }, cwd: dir })));
    expect(text).toContain("current project");
  });

  it("workspace gate captures typed paths, supports backspace, and submits on enter", async () => {
    const setupWorkspace = vi.fn(async () => undefined);
    const s = state({ viewState: { view: "workspaceGate", previousView: "launch" } });
    await handleKeypress({ name: "/", sequence: "/" } as any, s, actions({ setupWorkspace }));
    await handleKeypress({ name: "t", sequence: "t" } as any, s, actions({ setupWorkspace }));
    await handleKeypress({ name: "backspace", sequence: "\u007f" } as any, s, actions({ setupWorkspace }));
    await handleKeypress({ name: "m", sequence: "m" } as any, s, actions({ setupWorkspace }));
    expect(s.workspaceGateInput).toBe("/m");
    await handleKeypress({ name: "return", sequence: "\r" } as any, s, actions({ setupWorkspace }));
    expect(setupWorkspace).toHaveBeenCalledTimes(1);
  });

  it("command-delete clears the workspace gate input", async () => {
    const s = state({
      viewState: { view: "workspaceGate", previousView: "launch" },
      workspaceGateInput: "/tmp/openboard-test",
    });

    await handleKeypress({ name: "backspace", sequence: "\u007f", meta: true } as any, s, actions());

    expect(s.workspaceGateInput).toBe("");
  });

  it("workspace gate disables run/task creation keys before a board is selected", async () => {
    const s = state({ viewState: { view: "workspaceGate", previousView: "launch" } });
    await handleKeypress({ name: "n", sequence: "n" } as any, s, actions());
    expect(s.overlay).toBe("none");
    expect(s.newTask).toBeUndefined();
  });

  it("existing named-instance launch view still renders attach controls", () => {
    const app = renderApp(fakeUi(), state({ instanceList: [instance("alpha", "running", 4097, { cardCount: 3 })] }));
    const text = textOf(app);
    expect(text).toContain("● alpha  RUNNING  :4097  /work/alpha · 3 cards");
    expect(text).toContain("↵ launch board");
    expect(text).not.toContain("Workspace Required");
  });
});

function archiveRecord(
  id: string,
  archivedAt: string,
  completion: string | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    source_instance_name: "test-instance",
    source_port: 4097,
    source_workspace: "/repo/test",
    source_db_path: "/data/test.sqlite",
    task_id: id,
    task_type: "agent",
    title: `Task ${id}`,
    description: "Fix the login bug",
    directory: "/repo/test",
    agent: "build",
    assigned_to: null,
    model: '{"providerID":"openai","id":"gpt-5.5"}',
    isolation: "worktree",
    column_name: "done",
    run_state: "idle",
    run_started_at: null,
    error: null,
    session_id: null,
    worktree_path: null,
    worktree_branch: null,
    base_branch: null,
    completion,
    final_session_output: null,
    completion_source: null,
    comments: null,
    completed_by: null,
    archived_at: new Date(archivedAt).getTime(),
    task_created_at: 1,
    task_updated_at: 1,
    mirrored_at: 1,
    ...overrides,
  };
}

function archiveState(records: ReturnType<typeof archiveRecord> | ReturnType<typeof archiveRecord>[], detailTab: "prompt" | "handoff" | "output" | "comments" = "prompt") {
  const list = Array.isArray(records) ? records : [records];
  return {
    records: list,
    selectedIndex: 0,
    searchQuery: "",
    searchMode: false,
    instanceFilter: null,
    laneFilter: null,
    refreshing: false,
    detailTab,
  };
}

function actions(overrides: Record<string, unknown> = {}) {
  return {
    refresh: vi.fn(async () => undefined),
    render: vi.fn(),
    shutdown: vi.fn(),
    runAction: vi.fn(async () => undefined),
    client: {
      moveTask: vi.fn(async () => []),
      updateTask: vi.fn(async (id: string) => ({ ...task(id, "todo"), id })),
      listComments: vi.fn(async () => []),
      addComment: vi.fn(async () => ({ id: "comment-1", taskId: "todo-card", author: "User", body: "", createdAt: 1 })),
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
