import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveTaskShortcut, boardApiFetchInit, handleKeypress, renderApp } from "../../src/tui/index";
import { createMockInstanceProvider, initialViewState, type InstanceListItem } from "../../src/tui/model";
import type { Column, Task } from "../../src/shared";

function fakeUi() {
  return {
    TextAttributes: { BOLD: "bold" },
    Box: (props: Record<string, unknown>, ...children: unknown[]) => ({ type: "Box", props, children }),
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
    terminalRows: 80,
    laneOffsets: { todo: 0, in_progress: 0, review: 0, done: 0 },
    viewState: initialViewState,
    instanceProvider: createMockInstanceProvider(),
    instanceList: [],
    selectedInstanceIndex: 0,
    fetchingCardCounts: new Set<string>(),
    switcherSelectedIndex: 0,
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
    expect(text).toContain("b switch board");
    expect(text).toContain("n new task");
    expect(text).toContain("m move card");
    expect(text).not.toContain("b switch · n new");
  });

  it("selected-card action hints use 'archive task'", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("done-card", "done")],
      selectedTaskId: "done-card",
    }));

    const text = textOf(app);
    expect(text).toContain("a archive task");
    expect(text).not.toContain("a archive · d delete");
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

    // The detail labels: INSTANCE, WORKSPACE, LANE, AGENT, MODEL, ARCHIVED should still appear
    expect(text).toContain("INSTANCE");
    expect(text).toContain("WORKSPACE");
    expect(text).toContain("LANE");
    expect(text).toContain("AGENT");
    expect(text).toContain("MODEL");
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

describe("TUI archive tab navigation", () => {
  it("renders Prompt tab as active by default", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "archive", previousView: "launch" },
      archive: archiveState(archiveRecord("task-1", "2026-07-03 12:00", null)),
    }));

    const text = textOf(app);
    // Both tabs should render
    expect(text).toContain("Prompt");
    expect(text).toContain("Handoff");
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

  it("tab key toggles between Prompt and Handoff", async () => {
    const s = state({
      viewState: { view: "archive", previousView: "launch" },
      archive: archiveState(archiveRecord("task-1", "2026-07-03 12:00", null), "prompt"),
    });

    expect(s.archive.detailTab).toBe("prompt");

    await handleKeypress({ name: "tab", sequence: "\t" } as any, s, actions());
    expect(s.archive.detailTab).toBe("handoff");

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
    expect(text).toContain("m move card");
    expect(text).toContain("q quit · A global archive");
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

  it("Selected column reserves one row per inline detail metadata item", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
      detailTab: "prompt",
    }));

    const metadataBox = boxesContaining(app, "STATE")
      .find((node) => textOf(node).includes("LANE") && textOf(node).includes("AGENT") && node.props?.height === 3);

    expect(metadataBox).toBeTruthy();
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

  it("inline detail tab toggles with tab key", async () => {
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
      detailTab: "prompt",
    });

    await handleKeypress({ name: "tab", sequence: "\t" } as any, s, actions());
    expect(s.detailTab).toBe("handoff");

    await handleKeypress({ name: "tab", sequence: "\t" } as any, s, actions());
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

describe("TUI completedBy display", () => {
  it("sidebar shows COMPLETED BY when task has completedBy attribute", () => {
    const doneCard = { ...task("done-card", "done"), completedBy: "User" };
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [doneCard],
      selectedTaskId: "done-card",
    }));

    const text = textOf(app);
    expect(text).toContain("COMPLETED BY");
    expect(text).toContain("User");
  });

  it("sidebar does NOT show COMPLETED BY when task has no completedBy", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
    }));

    const text = textOf(app);
    expect(text).not.toContain("COMPLETED BY");
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

  it("move to Done shows completedBy: User hint", () => {
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
      moveTargetColumn: "done",
    }));

    const text = textOf(app);
    expect(text).toContain("completedBy: User");
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

  it("move to Done calls client.moveTask with completedBy 'User'", async () => {
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

  it("x key moves to Done with completedBy 'User'", async () => {
    const moveTask = vi.fn(async () => [{ ...task("todo-card", "done"), completedBy: "User" }]);
    const runAction = vi.fn(async (_label: string, _action: (t: Task) => Promise<unknown>) => {});
    const s = state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [task("todo-card", "todo")],
      selectedTaskId: "todo-card",
    });

    await handleKeypress({ name: "x", sequence: "x" } as any, s, actions({
      client: { moveTask },
      runAction,
    }));

    // runAction is called with label "move done" and a callback
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(runAction.mock.calls[0]?.[0]).toBe("move done");
    expect(typeof runAction.mock.calls[0]?.[1]).toBe("function");

    // Invoke the callback to verify completedBy is passed
    const callback = runAction.mock.calls[0]?.[1] as (t: Task) => Promise<unknown>;
    if (callback) {
      await callback(task("todo-card", "todo"));
      expect(moveTask).toHaveBeenCalledWith("todo-card", "done", 0, "User");
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

    const changedFilesText = textNodesContaining(app, "src/client/board-client.ts")[0];
    const verificationText = textNodesContaining(app, "npm run typecheck")[0];
    expect(changedFilesText.props).toMatchObject({ wrapMode: "char", width: "100%", minWidth: 0, flexShrink: 1, height: 3 });
    expect(verificationText.props).toMatchObject({ wrapMode: "char", width: "100%", minWidth: 0, flexShrink: 1, height: 4 });
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
    const app = renderApp(fakeUi(), state({
      viewState: { view: "board", previousView: "launch" },
      tasks: [theTask],
      selectedTaskId: "todo-card",
      detailTab: "prompt",
    }));

    const text = textOf(app);
    expect(text).toContain("Fix the login bug");
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
    title: `Task ${id}`,
    description: "Fix the login bug",
    directory: "/repo/test",
    agent: "build",
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
    completion_source: null,
    archived_at: new Date(archivedAt).getTime(),
    task_created_at: 1,
    task_updated_at: 1,
    mirrored_at: 1,
    ...overrides,
  };
}

function archiveState(records: ReturnType<typeof archiveRecord> | ReturnType<typeof archiveRecord>[], detailTab: "prompt" | "handoff" = "prompt") {
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
    client: { moveTask: vi.fn(async () => []) },
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
