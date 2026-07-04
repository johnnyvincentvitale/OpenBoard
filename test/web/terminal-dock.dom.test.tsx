// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TerminalDockProps } from "../../src/web/task-types";

const { fitSpy, writeSpy, openSpy, disposeSpy, connectTerminalSocketMock, terminalOptions } = vi.hoisted(() => ({
  fitSpy: vi.fn(),
  writeSpy: vi.fn(),
  openSpy: vi.fn(),
  disposeSpy: vi.fn(),
  connectTerminalSocketMock: vi.fn(),
  terminalOptions: [] as unknown[],
}));

class FakeTerminal {
  cols = 80;
  rows = 24;
  constructor(options: unknown) {
    terminalOptions.push(options);
  }
  loadAddon() {}
  onData = vi.fn();
  open = openSpy;
  write = writeSpy;
  dispose = disposeSpy;
}

vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit = fitSpy; } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

vi.mock("../../src/web/api/terminalSocket", () => ({ connectTerminalSocket: connectTerminalSocketMock }));

let TerminalDock: typeof import("../../src/web/components/TerminalDock").TerminalDock;

class FakeResizeObserver {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe() {}
  disconnect() {}
}

beforeEach(async () => {
  cleanup();
  vi.clearAllMocks();
  connectTerminalSocketMock.mockReset();
  terminalOptions.length = 0;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  ({ TerminalDock } = await import("../../src/web/components/TerminalDock"));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderDock(overrides: Partial<TerminalDockProps> = {}) {
  const props: TerminalDockProps = {
    open: true,
    height: 240,
    activeTabId: "tab-1",
    tabs: [
      { id: "tab-1", cwdLabel: "Task · repo", cwd: "/repo", terminalId: "terminal-1", token: "tok", createState: "ready", sessionVersion: 1 },
      { id: "tab-2", cwdLabel: "Workspace · repo2", cwd: "/repo2", terminalId: "terminal-2", token: "tok2", createState: "ready", sessionVersion: 1 },
    ],
    onToggleOpen: vi.fn(),
    onHeightChange: vi.fn(),
    onActivateTab: vi.fn(),
    onRequestWorkspaceShell: vi.fn(),
    onCloseTab: vi.fn(),
    onReopenTab: vi.fn(),
    ...overrides,
  };

  if (!connectTerminalSocketMock.getMockImplementation()) {
    connectTerminalSocketMock.mockReturnValue({ input: vi.fn(), resize: vi.fn(), close: vi.fn() });
  }
  render(<TerminalDock {...props} />);
  return props;
}

describe("TerminalDock", () => {
  it("renders empty state and new-shell action", async () => {
    const props = renderDock({ tabs: [], activeTabId: null });
    await userEvent.click(screen.getByRole("button", { name: "New workspace shell" }));
    expect(props.onRequestWorkspaceShell).toHaveBeenCalled();
    expect(screen.getByText("No shell sessions")).toBeInTheDocument();
  });

  it("keeps inactive panes mounted without display:none and switches tabs with arrow keys", async () => {
    const props = renderDock();
    const inactivePane = screen.getByTestId("terminal-pane-tab-2");
    expect(inactivePane).toHaveStyle({ visibility: "hidden", pointerEvents: "none", position: "absolute" });

    const firstTab = screen.getByRole("tab", { name: "Task · repo" });
    firstTab.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(props.onActivateTab).toHaveBeenCalledWith("tab-2");
  });

  it("refits when the active tab changes", () => {
    const props: TerminalDockProps = {
      open: true,
      height: 240,
      activeTabId: "tab-1",
      tabs: [
        { id: "tab-1", cwdLabel: "Task · repo", cwd: "/repo", terminalId: "terminal-1", token: "tok", createState: "ready", sessionVersion: 1 },
        { id: "tab-2", cwdLabel: "Workspace · repo2", cwd: "/repo2", terminalId: "terminal-2", token: "tok2", createState: "ready", sessionVersion: 1 },
      ],
      onToggleOpen: vi.fn(),
      onHeightChange: vi.fn(),
      onActivateTab: vi.fn(),
      onRequestWorkspaceShell: vi.fn(),
      onCloseTab: vi.fn(),
      onReopenTab: vi.fn(),
    };
    const { rerender } = render(<TerminalDock {...props} />);
    const fitCount = fitSpy.mock.calls.length;

    rerender(<TerminalDock {...props} activeTabId="tab-2" />);
    expect(fitSpy.mock.calls.length).toBeGreaterThan(fitCount);
  });

  it("opens xterm only for the active pane, fits active pane, and keeps sessions through collapse", () => {
    const props = {
      open: true,
      height: 240,
      activeTabId: "tab-1",
      tabs: [
        { id: "tab-1", cwdLabel: "Task · repo", cwd: "/repo", terminalId: "terminal-1", token: "tok", createState: "ready" as const, sessionVersion: 1 },
      ],
      onToggleOpen: vi.fn(),
      onHeightChange: vi.fn(),
      onActivateTab: vi.fn(),
      onRequestWorkspaceShell: vi.fn(),
      onCloseTab: vi.fn(),
      onReopenTab: vi.fn(),
    };
    const { rerender } = render(<TerminalDock {...props} />);
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(fitSpy).toHaveBeenCalled();
    expect(terminalOptions[0]).toEqual(expect.objectContaining({ fontSize: 12, lineHeight: 1.15 }));
    expect(connectTerminalSocketMock).toHaveBeenCalledTimes(1);

    rerender(<TerminalDock {...props} open={false} />);
    expect(screen.queryByText("No shell sessions")).not.toBeInTheDocument();
    expect(disposeSpy).not.toHaveBeenCalled();
  });

  it("shows loading, error, and exit states with reopen", async () => {
    const onReopenTab = vi.fn();
    const socketHandlers: Array<{ onData: (data: string) => void; onExit: (code: number | null) => void }> = [];
    connectTerminalSocketMock.mockImplementation((_id, _token, handlers) => {
      socketHandlers.push(handlers);
      return { input: vi.fn(), resize: vi.fn(), close: vi.fn() };
    });

    const { rerender } = render(
      <TerminalDock
        open
        height={240}
        activeTabId="tab-1"
        tabs={[{ id: "tab-1", cwdLabel: "Task · repo", createState: "creating", sessionVersion: 1 }]}
        onToggleOpen={vi.fn()}
        onHeightChange={vi.fn()}
        onActivateTab={vi.fn()}
        onRequestWorkspaceShell={vi.fn()}
        onCloseTab={vi.fn()}
        onReopenTab={onReopenTab}
      />,
    );

    expect(screen.getByText("Connecting…")).toBeInTheDocument();

    rerender(
      <TerminalDock
        open
        height={240}
        activeTabId="tab-1"
        tabs={[{ id: "tab-1", cwdLabel: "Task · repo", terminalId: "terminal-1", token: "tok", createState: "ready", sessionVersion: 2 }]}
        onToggleOpen={vi.fn()}
        onHeightChange={vi.fn()}
        onActivateTab={vi.fn()}
        onRequestWorkspaceShell={vi.fn()}
        onCloseTab={vi.fn()}
        onReopenTab={onReopenTab}
      />,
    );

    socketHandlers[0].onData("prompt$ ");
    expect(writeSpy).toHaveBeenCalledWith("prompt$ ");
    socketHandlers[0].onExit(7);
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining("Process exited (code 7)"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Reopen" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(onReopenTab).toHaveBeenCalledWith("tab-1");
  });

  it("recreates a terminal after sessionVersion changes so new socket data still writes", () => {
    const socketHandlers: Array<{ onData: (data: string) => void }> = [];
    connectTerminalSocketMock.mockImplementation((_id, _token, handlers) => {
      socketHandlers.push(handlers);
      return { input: vi.fn(), resize: vi.fn(), close: vi.fn() };
    });

    const props: TerminalDockProps = {
      open: true,
      height: 240,
      activeTabId: "tab-1",
      tabs: [{ id: "tab-1", cwdLabel: "Task · repo", terminalId: "terminal-1", token: "tok", createState: "ready", sessionVersion: 1 }],
      onToggleOpen: vi.fn(),
      onHeightChange: vi.fn(),
      onActivateTab: vi.fn(),
      onRequestWorkspaceShell: vi.fn(),
      onCloseTab: vi.fn(),
      onReopenTab: vi.fn(),
    };

    const { rerender } = render(<TerminalDock {...props} />);
    expect(openSpy).toHaveBeenCalledTimes(1);

    rerender(
      <TerminalDock
        {...props}
        tabs={[{ id: "tab-1", cwdLabel: "Task · repo", terminalId: "terminal-1", token: "tok", createState: "ready", sessionVersion: 2 }]}
      />,
    );

    expect(disposeSpy).toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledTimes(2);
    socketHandlers.at(-1)?.onData("after reopen");
    expect(writeSpy).toHaveBeenCalledWith("after reopen");
  });

  it("sends the fitted size when the terminal socket opens", () => {
    let onOpen: (() => void) | undefined;
    const resize = vi.fn();
    connectTerminalSocketMock.mockImplementation((_id, _token, handlers) => {
      onOpen = handlers.onOpen;
      return { input: vi.fn(), resize, close: vi.fn() };
    });

    renderDock({
      tabs: [{ id: "tab-1", cwdLabel: "Task · repo", cwd: "/repo", terminalId: "terminal-1", token: "tok", createState: "ready", sessionVersion: 1 }],
    });

    expect(resize).not.toHaveBeenCalled();
    onOpen?.();
    expect(fitSpy).toHaveBeenCalled();
    expect(resize).toHaveBeenCalledWith(80, 24);
  });

  it("wires close and resize controls", async () => {
    const props = renderDock();
    await userEvent.click(screen.getByRole("button", { name: "Close Task · repo" }));
    expect(props.onCloseTab).toHaveBeenCalledWith("tab-1");

    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize terminal dock" }), { key: "ArrowUp" });
    expect(props.onHeightChange).toHaveBeenCalled();
  });
});
