import { useState, type CSSProperties, type ReactNode } from "react";
import { createTerminal } from "./api/terminalSocket";
import { archiveTask, getTasks, unarchiveTask } from "./api/taskClient";
import type { RosterAgent, Task } from "../shared";
import { useTaskStore } from "./taskStore";
import { TaskCard } from "./components/TaskCard";
import { TerminalDock } from "./components/TerminalDock";
import { NewTaskForm } from "./components/NewTaskForm";
import { TaskBoardSurface } from "./components/TaskBoardSurface";
import type { TerminalDockTab } from "./task-types";
import { t, outlineAction, LOGO_BOARD_COLOR } from "./theme";

/**
 * Root — OpenBoard (Nightshade design). Left rail (title, + New task, status,
 * agents, defaults, footer) + a textured 4-column board. The new-task panel
 * slides in over the board; sync/integrate results land as quiet inline card
 * notices instead of window.alert.
 */
export function App() {
  const store = useTaskStore();
  const { tasks, agents, status, settings, create, run, retry, abort, remove, move, initGit, sync, integrate, addLink, removeLink, setWorktreeDefault } = store;

  const [panelOpen, setPanelOpen] = useState(false);
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [dockOpen, setDockOpen] = useState(false);
  const [dockHeight, setDockHeight] = useState(260);
  const [terminalTabs, setTerminalTabs] = useState<TerminalDockTab[]>([]);
  const [activeTerminalTabId, setActiveTerminalTabId] = useState<string | null>(null);
  const [archivedView, setArchivedView] = useState(false);
  const [archivedTasks, setArchivedTasks] = useState<Task[]>([]);
  const [hiddenArchivedIds, setHiddenArchivedIds] = useState<string[]>([]);

  const notify = (id: string, msg: string) => {
    if (msg) setNotices((n) => ({ ...n, [id]: msg }));
  };
  const handleSync = (id: string) => void sync(id).then((m) => notify(id, m)).catch((e) => notify(id, String(e)));
  const handleIntegrate = (id: string) => void integrate(id).then((m) => notify(id, m)).catch((e) => notify(id, String(e)));
  const handleCreate = (fields: Parameters<typeof create>[0]) => void create(fields);

  const handleArchivedViewChange = async (next: boolean) => {
    setArchivedView(next);
    if (!next) return;
    const tasks = await getTasks({ archived: "true" });
    setArchivedTasks(tasks);
  };

  const handleArchive = async (taskId: string) => {
    await archiveTask(taskId);
    setHiddenArchivedIds((current) => (current.includes(taskId) ? current : [...current, taskId]));
  };

  const handleUnarchive = async (taskId: string) => {
    await unarchiveTask(taskId);
    setArchivedTasks((current) => current.filter((task) => task.id !== taskId));
    setHiddenArchivedIds((current) => current.filter((id) => id !== taskId));
  };

  const upsertTerminalTab = (tabId: string, update: (current: TerminalDockTab) => TerminalDockTab) => {
    setTerminalTabs((current) => current.map((tab) => (tab.id === tabId ? update(tab) : tab)));
  };

  const openShell = async (task?: Task, tabId?: string) => {
    const existingId = tabId ?? `terminal-${crypto.randomUUID()}`;
    const initialTab: TerminalDockTab = {
      id: existingId,
      taskId: task?.id,
      taskTitle: task?.title,
      cwdLabel: task ? `${task.title} · opening…` : "Workspace shell · opening…",
      createState: "creating",
      sessionVersion: terminalTabs.find((tab) => tab.id === existingId)?.sessionVersion ?? 0,
    };

    setDockOpen(true);
    setTerminalTabs((current) => {
      const others = current.filter((tab) => tab.id !== existingId);
      return [...others, initialTab];
    });
    setActiveTerminalTabId(existingId);

    try {
      const reservation = await createTerminal(task ? { taskId: task.id } : {});
      setTerminalTabs((current) => {
        const sameOriginCount = current.filter((tab) => (task ? tab.taskId === task.id : !tab.taskId) && tab.id !== existingId).length;
        const sequence = sameOriginCount + 1;
        const leaf = reservation.cwd.split("/").filter(Boolean).pop() ?? reservation.cwd;
        const labelBase = task ? `${task.title} · ${leaf}` : `Workspace · ${leaf}`;
        const cwdLabel = sequence > 1 ? `${labelBase} #${sequence}` : labelBase;

        return current.map((tab) => (tab.id === existingId
          ? {
              ...tab,
              cwd: reservation.cwd,
              cwdLabel,
              terminalId: reservation.id,
              token: reservation.token,
              createState: "ready",
              error: undefined,
              sessionVersion: tab.sessionVersion + 1,
            }
          : tab));
      });
    } catch (error) {
      upsertTerminalTab(existingId, (tab) => ({
        ...tab,
        createState: "error",
        error: error instanceof Error ? error.message : String(error),
        cwdLabel: task ? `${task.title} · shell error` : "Workspace shell · error",
      }));
    }
  };

  const handleCloseTerminalTab = (tabId: string) => {
    setTerminalTabs((current) => {
      const next = current.filter((tab) => tab.id !== tabId);
      setActiveTerminalTabId((active) => {
        if (active !== tabId) return active;
        const currentIndex = current.findIndex((tab) => tab.id === tabId);
        const fallback = next[Math.max(0, currentIndex - 1)] ?? next[0] ?? null;
        return fallback?.id ?? null;
      });
      return next;
    });
  };

  const runningAgents = new Set(tasks.filter((t2) => t2.runState === "running" && t2.agent).map((t2) => t2.agent as string));
  const runningCount = tasks.filter((t2) => t2.runState === "running").length;
  const lastUpdated = tasks.reduce((max, t2) => Math.max(max, t2.updatedAt), 0);
  const visibleTasks = archivedView
    ? archivedTasks
    : tasks.filter((task) => !hiddenArchivedIds.includes(task.id));

  return (
    <div style={styles.app}>
      <aside style={styles.rail}>
        {/* Brand */}
        <div>
          <div style={{ fontFamily: t.fontLogo, fontWeight: 400, fontSize: 28, letterSpacing: "0.05em", lineHeight: 1 }}>
            <span style={{ color: "#ffffff" }}>open</span>
            <span style={{ color: LOGO_BOARD_COLOR }}>board</span>
          </div>
          <div style={{ fontFamily: t.fontMono, fontSize: 10, color: t.dim, marginTop: 2 }}>~/code · agent board</div>
        </div>

        {/* Primary CTA */}
        <button type="button" style={styles.cta} onClick={() => setPanelOpen(true)}>
          + New Task
        </button>

        {/* Status */}
        <Section title="Status">
          <Row label="opencode" right={status.opencode === "ok" ? "● OK" : `● ${status.opencode.toUpperCase()}`} rightColor={status.opencode === "ok" ? t.accent : t.muted} />
          <Row label="live events" right={`▲ ${status.sse.toUpperCase()}`} rightColor={status.sse === "open" ? t.accent : t.muted} />
        </Section>

        {/* Agents */}
        <Section title="Agents">
          {agents.length === 0 ? (
            <div style={{ fontFamily: t.fontMono, fontSize: 11, color: t.dim, padding: "7px 0" }}>—</div>
          ) : (
            agents.map((a: RosterAgent) => {
              const isRunning = runningAgents.has(a.id);
              return (
                <div key={a.id} style={styles.row}>
                  <span style={{ fontFamily: t.fontMono, fontSize: 11.5, color: t.text, display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 9, color: isRunning ? t.accent : t.dim, ...(isRunning ? { animation: "ob-pulse 1.6s ease-in-out infinite" } : {}) }}>
                      {isRunning ? "●" : "○"}
                    </span>
                    {a.id}
                  </span>
                  <span style={{ fontFamily: t.fontMono, fontSize: 10, color: isRunning ? t.muted : t.dim }}>
                    {isRunning ? "running" : "idle"}
                  </span>
                </div>
              );
            })
          )}
        </Section>

        {/* Defaults */}
        <Section title="Defaults">
          <div style={styles.row}>
            <span style={{ fontFamily: t.fontSans, fontSize: 13, color: t.text }}>Worktree isolation</span>
            <button
              type="button"
              role="switch"
              aria-checked={settings.worktreeDefault}
              aria-label="Worktree isolation by default"
              onClick={() => void setWorktreeDefault(!settings.worktreeDefault)}
              style={{
                width: 28,
                height: 16,
                borderRadius: 999,
                border: "none",
                cursor: "pointer",
                background: settings.worktreeDefault ? t.accent : t.dim,
                position: "relative",
                padding: 0,
              }}
            >
              <span
                style={{
                  position: "absolute",
                  top: 2,
                  left: settings.worktreeDefault ? 14 : 2,
                  width: 12,
                  height: 12,
                  borderRadius: "50%",
                  background: t.text,
                  transition: "left 0.15s ease",
                }}
              />
            </button>
          </div>
        </Section>

        {/* Footer */}
        <div style={styles.railFooter}>
          <div>{tasks.length} TASKS · {agents.length} AGENTS</div>
          <div>{runningCount > 0 ? `${runningCount} RUNNING` : "IDLE"} · UPDATED {relTime(lastUpdated)}</div>
        </div>
      </aside>

      <main style={styles.main}>
        <div style={styles.boardScroll}>
          <TaskBoardSurface
            tasks={visibleTasks}
            agents={agents}
            archivedView={archivedView}
            onArchivedViewChange={(next) => void handleArchivedViewChange(next)}
            onMove={move}
            onUnarchive={(taskId) => void handleUnarchive(taskId)}
            renderTaskCard={(task: Task) => (
              <TaskCard
                task={task}
                tasks={tasks}
                agents={agents}
                onOpenShell={(taskToOpen) => void openShell(taskToOpen)}
                onRun={run}
                onRetry={retry}
                onAbort={abort}
                onDelete={remove}
                onInitGit={initGit}
                onSync={handleSync}
                onIntegrate={handleIntegrate}
                onArchive={(taskId) => void handleArchive(taskId)}
                onAddParent={addLink}
                onRemoveParent={removeLink}
                notice={notices[task.id]}
              />
            )}
          />
        </div>
        <TerminalDock
          open={dockOpen}
          height={dockHeight}
          tabs={terminalTabs}
          activeTabId={activeTerminalTabId}
          onToggleOpen={() => setDockOpen((value) => !value)}
          onHeightChange={setDockHeight}
          onActivateTab={setActiveTerminalTabId}
          onRequestWorkspaceShell={() => void openShell()}
          onCloseTab={handleCloseTerminalTab}
          onReopenTab={(tabId) => {
            const tab = terminalTabs.find((item) => item.id === tabId);
            const taskToOpen = tab?.taskId ? tasks.find((task) => task.id === tab.taskId) : undefined;
            void openShell(taskToOpen, tabId);
          }}
        />
        <NewTaskForm agents={agents} onCreate={handleCreate} open={panelOpen} onClose={() => setPanelOpen(false)} />
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={styles.sectionLabel}>{title}</div>
      {children}
    </div>
  );
}

function Row({ label, right, rightColor }: { label: string; right: string; rightColor: string }) {
  return (
    <div style={styles.row}>
      <span style={{ fontFamily: t.fontMono, fontSize: 11.5, color: t.text }}>{label}</span>
      <span style={{ fontFamily: t.fontMono, fontSize: 10, color: rightColor, letterSpacing: "0.06em" }}>{right}</span>
    </div>
  );
}

/** Coarse relative time for the rail footer (updates on each SSE-driven render). */
function relTime(ts: number): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s AGO`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m AGO`;
  return `${Math.round(m / 60)}h AGO`;
}

const styles: Record<string, CSSProperties> = {
  app: {
    display: "grid",
    gridTemplateColumns: "236px 1fr",
    minHeight: "100vh",
    background: t.ground,
    color: t.text,
    fontFamily: t.fontSans,
  },
  rail: {
    display: "flex",
    flexDirection: "column",
    gap: 22,
    padding: "22px 18px",
    borderRight: `1px solid ${t.border}`,
    background: t.ground,
  },
  cta: {
    ...outlineAction,
    width: "100%",
    padding: "10px 14px",
    borderRadius: 4,
    fontSize: 13,
    cursor: "pointer",
  },
  sectionLabel: {
    fontFamily: t.fontSans,
    fontWeight: 300,
    fontSize: 11,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: t.muted,
    marginBottom: 4,
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: "7px 0",
    borderTop: `1px solid ${t.border}`,
  },
  railFooter: {
    marginTop: "auto",
    borderTop: `1px solid ${t.border}`,
    paddingTop: 12,
    display: "flex",
    flexDirection: "column",
    gap: 4,
    fontFamily: t.fontMono,
    fontSize: 10,
    color: t.dim,
  },
  main: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    overflow: "hidden",
    padding: "22px 24px 0",
    minWidth: 0,
  },
  boardScroll: { position: "relative", flex: 1, overflow: "auto", minHeight: 0, paddingBottom: 30 },
};
