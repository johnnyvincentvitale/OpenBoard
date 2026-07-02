import type { CSSProperties } from "react";
import type { Task } from "../shared";
import { useTaskStore } from "./taskStore";
import { TaskBoard } from "./components/TaskBoard";
import { TaskCard } from "./components/TaskCard";
import { NewTaskForm } from "./components/NewTaskForm";

/**
 * Root: the functional task board. Post a task assigned to an OpenCode agent, run it,
 * and the dispatcher drives a real session while the card auto-advances through the
 * columns. Wires the task store to the board, the new-task form, and the card.
 */
export function App() {
  const {
    tasks,
    agents,
    status,
    settings,
    create,
    run,
    retry,
    abort,
    remove,
    move,
    initGit,
    sync,
    integrate,
    setWorktreeDefault,
  } = useTaskStore();
  const ocOk = status.opencode === "ok";

  // sync/integrate resolve to a human-readable message (e.g. a merge conflict);
  // surface it so the user sees the result of the git operation.
  const notify = (message: string) => {
    if (message && typeof window !== "undefined") window.alert(message);
  };
  const handleSync = (id: string) => void sync(id).then(notify).catch((e) => notify(String(e)));
  const handleIntegrate = (id: string) =>
    void integrate(id).then(notify).catch((e) => notify(String(e)));

  return (
    <div style={styles.app}>
      <header style={styles.header}>
        <h1 style={styles.title}>opencode-board</h1>
        <div style={styles.badges}>
          <label style={styles.toggle} title="Isolate runs in a git worktree by default">
            <input
              type="checkbox"
              checked={settings.worktreeDefault}
              onChange={(event) => void setWorktreeDefault(event.target.checked)}
              aria-label="Worktree isolation by default"
            />
            worktree default
          </label>
          <span
            style={{
              ...styles.badge,
              background: ocOk ? "#132d1c" : "#3a1620",
              color: ocOk ? "#4ade80" : "#f87171",
            }}
          >
            opencode: {status.opencode}
          </span>
          <span style={{ ...styles.badge, opacity: status.sse === "open" ? 1 : 0.6 }}>
            live: {status.sse}
          </span>
          <span style={styles.count}>
            {tasks.length} task{tasks.length === 1 ? "" : "s"} · {agents.length} agents
          </span>
        </div>
      </header>

      <div style={styles.formWrap}>
        <NewTaskForm agents={agents} onCreate={create} />
      </div>

      <main style={styles.main}>
        <TaskBoard
          tasks={tasks}
          onMove={move}
          renderCard={(task: Task) => (
            <TaskCard
              task={task}
              agents={agents}
              onRun={run}
              onRetry={retry}
              onAbort={abort}
              onDelete={remove}
              onInitGit={initGit}
              onSync={handleSync}
              onIntegrate={handleIntegrate}
            />
          )}
        />
      </main>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  app: {
    minHeight: "100vh",
    background: "#0b0d10",
    color: "#e6e8eb",
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "14px 20px",
    borderBottom: "1px solid #1c2128",
  },
  title: { margin: 0, fontSize: 18, fontWeight: 650, letterSpacing: "-0.01em" },
  badges: { display: "flex", alignItems: "center", gap: 10 },
  badge: {
    fontSize: 12,
    padding: "3px 9px",
    borderRadius: 999,
    background: "#161b22",
    border: "1px solid #232a33",
  },
  count: { fontSize: 12, color: "#8b949e" },
  toggle: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12,
    color: "#8b949e",
    cursor: "pointer",
  },
  formWrap: { padding: "16px 20px 0" },
  main: { padding: 20 },
};
