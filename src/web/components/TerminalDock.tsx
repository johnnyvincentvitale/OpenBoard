import "@xterm/xterm/css/xterm.css";

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { connectTerminalSocket } from "../api/terminalSocket";
import type { TerminalDockProps, TerminalDockTab } from "../task-types";
import { t } from "../theme";

const MIN_DOCK_HEIGHT = 120;
const MAX_DOCK_HEIGHT = 600;
const HEADER_HEIGHT = 42;
const TERMINAL_FONT_SIZE = 12;
const TERMINAL_LINE_HEIGHT = 1.15;

export function TerminalDock(props: TerminalDockProps) {
  const { activeTabId, tabs, open } = props;
  const tabButtonRefs = useRef(new Map<string, HTMLButtonElement | null>());

  useEffect(() => {
    if (!open || !activeTabId) return;
    tabButtonRefs.current.get(activeTabId)?.focus();
  }, [activeTabId, open]);

  const resizeHandleProps = useDockResize(props.height, props.onHeightChange);

  return (
    <section
      aria-label="Terminal dock"
      style={{
        ...styles.shell,
        height: open ? props.height : HEADER_HEIGHT,
      }}
    >
      <div
        role="separator"
        aria-label="Resize terminal dock"
        aria-orientation="horizontal"
        tabIndex={0}
        onPointerDown={resizeHandleProps.onPointerDown}
        onKeyDown={resizeHandleProps.onKeyDown}
        style={styles.resizeHandle}
      />

      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <button
            type="button"
            aria-label={open ? "Collapse terminal dock" : "Expand terminal dock"}
            aria-expanded={open}
            onClick={props.onToggleOpen}
            style={styles.headerButton}
          >
            {open ? "▾" : "▸"}
          </button>
          <span style={styles.title}>Terminal</span>
          <span style={styles.help}>Esc returns focus to the active tab.</span>
        </div>

        <div style={styles.headerRight}>
          <button
            type="button"
            aria-label="Open new workspace shell"
            onClick={props.onRequestWorkspaceShell}
            style={styles.headerButton}
          >
            +
          </button>
        </div>
      </div>

      <div style={open ? styles.visibleSection : styles.hiddenSection}>
        <div role="tablist" aria-label="Shell sessions" style={styles.tabList}>
            {tabs.map((tab, index) => {
              const active = tab.id === activeTabId;
              return (
                <div key={tab.id} style={styles.tabWrap}>
                  <button
                    ref={(node) => {
                      tabButtonRefs.current.set(tab.id, node);
                    }}
                    id={`terminal-tab-${tab.id}`}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-controls={`terminal-panel-${tab.id}`}
                    tabIndex={active ? 0 : -1}
                    onClick={() => props.onActivateTab(tab.id)}
                    onKeyDown={(event) => {
                      if (tabs.length === 0) return;
                      let nextIndex = index;
                      if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
                      if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
                      if (event.key === "Home") nextIndex = 0;
                      if (event.key === "End") nextIndex = tabs.length - 1;
                      if (nextIndex !== index) {
                        event.preventDefault();
                        props.onActivateTab(tabs[nextIndex].id);
                        tabButtonRefs.current.get(tabs[nextIndex].id)?.focus();
                      }
                    }}
                    style={{
                      ...styles.tab,
                      ...(active ? styles.tabActive : null),
                    }}
                  >
                    <span style={styles.tabText} title={[tab.taskTitle, tab.cwd].filter(Boolean).join(" · ") || tab.cwdLabel}>
                      {tab.cwdLabel}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Close ${tab.cwdLabel}`}
                    onClick={() => props.onCloseTab(tab.id)}
                    style={styles.closeButton}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
        </div>

        <div style={styles.body}>
          {tabs.length === 0 ? (
            <div style={styles.emptyState}>
              <div style={styles.emptyTitle}>No shell sessions</div>
              <button type="button" style={styles.emptyButton} onClick={props.onRequestWorkspaceShell}>
                New workspace shell
              </button>
            </div>
          ) : (
            tabs.map((tab) => (
              <TerminalPane
                key={tab.id}
                tab={tab}
                active={tab.id === activeTabId}
                open={open}
                onEscapeFocus={() => tabButtonRefs.current.get(tab.id)?.focus()}
                onReopen={() => props.onReopenTab(tab.id)}
              />
            ))
          )}
        </div>
      </div>
    </section>
  );
}

function useDockResize(height: number, onHeightChange: (height: number) => void) {
  const dragStateRef = useRef<{ startY: number; startHeight: number } | null>(null);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!dragStateRef.current) return;
      const next = clampHeight(dragStateRef.current.startHeight + (dragStateRef.current.startY - event.clientY));
      onHeightChange(next);
    };
    const onUp = () => {
      dragStateRef.current = null;
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [onHeightChange]);

  return {
    onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
      dragStateRef.current = { startY: event.clientY, startHeight: height };
    },
    onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      onHeightChange(clampHeight(height + (event.key === "ArrowUp" ? 24 : -24)));
    },
  };
}

function clampHeight(height: number): number {
  return Math.min(MAX_DOCK_HEIGHT, Math.max(MIN_DOCK_HEIGHT, height));
}

interface TerminalPaneProps {
  tab: TerminalDockTab;
  active: boolean;
  open: boolean;
  onEscapeFocus: () => void;
  onReopen: () => void;
}

function TerminalPane({ tab, active, open, onEscapeFocus, onReopen }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<ReturnType<typeof connectTerminalSocket> | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const fitFrameRef = useRef<number | null>(null);
  const openedRef = useRef(false);
  const lastSessionVersionRef = useRef<number | null>(null);
  const lastSentResizeRef = useRef<string>("");
  const closeExpectedRef = useRef(false);
  const exitSeenRef = useRef(false);
  const socketOpenRef = useRef(false);
  const [hasReceivedData, setHasReceivedData] = useState(false);
  const [exitCode, setExitCode] = useState<number | null | undefined>(undefined);
  const [socketError, setSocketError] = useState<string | null>(null);

  const ensureTerminal = () => {
    if (terminalRef.current && fitRef.current) return { term: terminalRef.current, fit: fitRef.current };

    const term = new Terminal({
      fontFamily: t.fontMono,
      fontSize: TERMINAL_FONT_SIZE,
      lineHeight: TERMINAL_LINE_HEIGHT,
      screenReaderMode: true,
      theme: { background: t.ground, foreground: t.text, cursor: t.accent },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.onData((data) => socketRef.current?.input(data));
    terminalRef.current = term;
    fitRef.current = fit;
    return { term, fit };
  };

  useEffect(() => {
    if (lastSessionVersionRef.current === tab.sessionVersion) return;
    lastSessionVersionRef.current = tab.sessionVersion;
    closeExpectedRef.current = true;
    socketOpenRef.current = false;
    socketRef.current?.close();
    socketRef.current = null;
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current);
    fitFrameRef.current = null;
    terminalRef.current?.dispose();
    terminalRef.current = null;
    fitRef.current = null;
    openedRef.current = false;
    lastSentResizeRef.current = "";
    exitSeenRef.current = false;
    setHasReceivedData(false);
    setExitCode(undefined);
    setSocketError(null);
    closeExpectedRef.current = false;
  }, [tab.sessionVersion]);

  useEffect(() => {
    const { term } = ensureTerminal();

    return () => {
      closeExpectedRef.current = true;
      socketOpenRef.current = false;
      socketRef.current?.close();
      socketRef.current = null;
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current);
      fitFrameRef.current = null;
      terminalRef.current = null;
      fitRef.current = null;
      term.dispose();
    };
  }, []);

  useEffect(() => {
    if (!active || !open || !containerRef.current || openedRef.current) return;
    const { term } = ensureTerminal();
    term.open(containerRef.current);
    openedRef.current = true;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onEscapeFocus();
      }
    };

    containerRef.current.addEventListener("keydown", onKeyDown, true);
    return () => containerRef.current?.removeEventListener("keydown", onKeyDown, true);
  }, [active, onEscapeFocus, open]);

  const fitAndSendResize = () => {
    if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current);
    fitFrameRef.current = requestAnimationFrame(() => {
      fitFrameRef.current = null;
      fitRef.current?.fit();
      const term = terminalRef.current;
      const socket = socketRef.current;
      if (!term || !socket || !socketOpenRef.current || term.cols <= 0 || term.rows <= 0) return;
      const next = `${term.cols}x${term.rows}`;
      if (next === lastSentResizeRef.current) return;
      lastSentResizeRef.current = next;
      socket.resize(term.cols, term.rows);
    });
  };

  useEffect(() => {
    if (tab.createState !== "ready" || !tab.terminalId || !tab.token || socketRef.current) return;
    ensureTerminal();
    setSocketError(null);
    socketRef.current = connectTerminalSocket(tab.terminalId, tab.token, {
      onOpen() {
        socketOpenRef.current = true;
        fitAndSendResize();
      },
      onData(data) {
        terminalRef.current?.write(data);
        setHasReceivedData(true);
      },
      onExit(code) {
        exitSeenRef.current = true;
        setExitCode(code);
        setHasReceivedData(true);
        terminalRef.current?.write(`\r\n\u001b[2mProcess exited (code ${code ?? "null"})\u001b[0m\r\n`);
      },
      onError(message) {
        setSocketError(message);
      },
      onClose() {
        socketOpenRef.current = false;
        if (!closeExpectedRef.current && !exitSeenRef.current) setSocketError("Terminal disconnected");
      },
    });
    return () => {
      closeExpectedRef.current = true;
      socketOpenRef.current = false;
      socketRef.current?.close();
      socketRef.current = null;
      closeExpectedRef.current = false;
    };
  }, [tab.createState, tab.terminalId, tab.token]);

  useEffect(() => {
    if (!active || !open || !openedRef.current || !containerRef.current) return;
    fitAndSendResize();

    const observer = new ResizeObserver(() => {
      fitAndSendResize();
    });
    observer.observe(containerRef.current);
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = observer;

    return () => {
      observer.disconnect();
      if (resizeObserverRef.current === observer) resizeObserverRef.current = null;
      if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current);
      fitFrameRef.current = null;
    };
  }, [active, open, tab.id]);

  const showConnecting = tab.createState === "creating" || (tab.createState === "ready" && !hasReceivedData && !socketError && exitCode === undefined);
  const showError = tab.createState === "error" ? tab.error : socketError;

  return (
    <section
      id={`terminal-panel-${tab.id}`}
      role="tabpanel"
      aria-labelledby={`terminal-tab-${tab.id}`}
      style={{
        ...styles.panel,
        ...(active ? styles.panelActive : styles.panelInactive),
      }}
      data-testid={`terminal-pane-${tab.id}`}
    >
      <div ref={containerRef} style={styles.terminalSurface} />

      {showConnecting ? <PaneOverlay message="Connecting…" /> : null}
      {showError ? <PaneOverlay message={showError} actionLabel="Reopen" onAction={onReopen} /> : null}
      {exitCode !== undefined ? <PaneOverlay message={`Exited (${exitCode ?? "null"})`} actionLabel="Reopen" onAction={onReopen} /> : null}
    </section>
  );
}

function PaneOverlay({ message, actionLabel, onAction }: { message: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <div style={styles.overlay}>
      <div style={styles.overlayMessage}>{message}</div>
      {actionLabel && onAction ? (
        <button type="button" style={styles.overlayButton} onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  shell: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    borderTop: `1px solid ${t.border}`,
    background: t.ground,
    minHeight: HEADER_HEIGHT,
  },
  resizeHandle: {
    height: 6,
    cursor: "row-resize",
    background: "transparent",
    borderTop: `1px solid ${t.border}`,
    outline: "none",
  },
  header: {
    height: HEADER_HEIGHT,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 12px",
    borderBottom: `1px solid ${t.border}`,
    background: t.surface,
    gap: 12,
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    minWidth: 0,
  },
  headerRight: {
    display: "flex",
    alignItems: "center",
  },
  title: {
    fontFamily: t.fontMono,
    fontSize: 11,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: t.text,
  },
  help: {
    fontFamily: t.fontSans,
    fontSize: 11,
    color: t.dim,
    whiteSpace: "nowrap",
  },
  headerButton: {
    border: "none",
    background: "transparent",
    color: t.text,
    cursor: "pointer",
    fontSize: 14,
    padding: 4,
  },
  tabList: {
    display: "flex",
    alignItems: "stretch",
    gap: 6,
    padding: "8px 10px 0",
    overflowX: "auto",
    background: t.ground,
  },
  tabWrap: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    minWidth: 0,
  },
  tab: {
    border: `1px solid ${t.border}`,
    background: t.surface,
    color: t.muted,
    borderRadius: "6px 6px 0 0",
    fontFamily: t.fontMono,
    fontSize: 11,
    padding: "7px 10px",
    cursor: "pointer",
    minWidth: 0,
    maxWidth: 280,
  },
  tabActive: {
    color: t.text,
    borderColor: t.accent,
  },
  tabText: {
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  closeButton: {
    border: "none",
    background: "transparent",
    color: t.dim,
    cursor: "pointer",
    fontSize: 11,
    padding: "0 2px",
  },
  visibleSection: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minHeight: 0,
  },
  hiddenSection: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minHeight: 0,
    visibility: "hidden",
    pointerEvents: "none",
    overflow: "hidden",
  },
  body: {
    position: "relative",
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
  },
  emptyState: {
    height: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  emptyTitle: {
    color: t.dim,
    fontFamily: t.fontSans,
    fontSize: 13,
  },
  emptyButton: {
    border: `1px solid ${t.border}`,
    background: t.surface,
    color: t.text,
    borderRadius: 4,
    padding: "8px 12px",
    cursor: "pointer",
  },
  panel: {
    position: "absolute",
    inset: 0,
  },
  panelActive: {
    visibility: "visible",
    pointerEvents: "auto",
  },
  panelInactive: {
    visibility: "hidden",
    pointerEvents: "none",
  },
  terminalSurface: {
    position: "absolute",
    inset: 0,
    padding: 12,
  },
  overlay: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    background: "rgba(9, 10, 14, 0.72)",
    color: t.text,
    fontFamily: t.fontSans,
  },
  overlayMessage: {
    fontSize: 13,
  },
  overlayButton: {
    border: `1px solid ${t.border}`,
    background: t.surface,
    color: t.text,
    borderRadius: 4,
    padding: "8px 12px",
    cursor: "pointer",
  },
};
