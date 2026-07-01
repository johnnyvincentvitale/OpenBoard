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
  const { tasks, agents, status, create, run, retry, abort, remove, move } = useTaskStore();
  const ocOk = status.opencode === "ok";

  return (
    <div style={styles.app}>
      <header style={styles.header}>
        <h1 style={styles.title}>opencode-board</h1>
        <div style={styles.badges}>
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
  formWrap: { padding: "16px 20px 0" },
  main: { padding: 20 },
};
