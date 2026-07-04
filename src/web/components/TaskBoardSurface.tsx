import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { RosterAgent, Task } from "../../shared";
import { t, outlineAction } from "../theme";
import { TaskBoard } from "./TaskBoard";

export interface TaskBoardSurfaceProps {
  tasks: Task[];
  agents: RosterAgent[];
  archivedView: boolean;
  onArchivedViewChange: (value: boolean) => void;
  onMove: (taskId: string, column: Task["column"], position: number) => void;
  onUnarchive: (taskId: string) => void;
  renderTaskCard: (task: Task) => ReactNode;
}

export function TaskBoardSurface({
  tasks,
  agents,
  archivedView,
  onArchivedViewChange,
  onMove,
  onUnarchive,
  renderTaskCard,
}: TaskBoardSurfaceProps) {
  const [titleFilter, setTitleFilter] = useState("");
  const [agentFilter, setAgentFilter] = useState("");

  const filteredTasks = useMemo(() => {
    const titleNeedle = titleFilter.trim().toLowerCase();
    return tasks.filter((task) => {
      if (titleNeedle && !task.title.toLowerCase().includes(titleNeedle)) return false;
      if (agentFilter && (task.agent ?? "") !== agentFilter) return false;
      return true;
    });
  }, [agentFilter, tasks, titleFilter]);

  return (
    <div style={surfaceStyle}>
      <div style={filterBarStyle}>
        <input
          aria-label="Filter tasks by title"
          data-testid="title-filter"
          placeholder="Filter by title"
          style={textInputStyle}
          value={titleFilter}
          onChange={(event) => setTitleFilter(event.target.value)}
        />
        <select
          aria-label="Filter tasks by agent"
          data-testid="agent-filter"
          style={selectStyle}
          value={agentFilter}
          onChange={(event) => setAgentFilter(event.target.value)}
        >
          <option value="">All agents</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.id}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-pressed={archivedView}
          data-testid="archived-toggle"
          style={toggleStyle(archivedView)}
          onClick={() => onArchivedViewChange(!archivedView)}
        >
          {archivedView ? "Showing Archived" : "Show Archived"}
        </button>
      </div>

      {archivedView ? (
        <div data-testid="archived-list" style={archivedListStyle}>
          {filteredTasks.length === 0 ? (
            <div style={emptyStyle}>No archived tasks match these filters.</div>
          ) : (
            filteredTasks.map((task) => (
              <article key={task.id} data-testid={`archived-task-${task.id}`} style={archivedCardStyle}>
                <div style={archivedHeaderStyle}>
                  <div>
                    <div style={archivedTitleStyle}>{task.title}</div>
                    <div style={archivedMetaStyle}>
                      {task.column.toUpperCase()} · {task.agent ?? "unassigned"} · {task.directory}
                    </div>
                  </div>
                  <button
                    type="button"
                    style={archiveButtonStyle}
                    onClick={() => onUnarchive(task.id)}
                  >
                    Unarchive
                  </button>
                </div>
              </article>
            ))
          )}
        </div>
      ) : (
        <TaskBoard tasks={filteredTasks} onMove={onMove} renderCard={renderTaskCard} />
      )}
    </div>
  );
}

const surfaceStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
};

const filterBarStyle: CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "center",
  flexWrap: "wrap",
};

const textInputStyle: CSSProperties = {
  flex: "1 1 240px",
  minWidth: 220,
  borderRadius: 4,
  border: `1px solid ${t.border}`,
  background: t.surface,
  color: t.text,
  padding: "9px 12px",
  fontFamily: t.fontSans,
  fontSize: 13,
};

const selectStyle: CSSProperties = {
  minWidth: 180,
  borderRadius: 4,
  border: `1px solid ${t.border}`,
  background: t.surface,
  color: t.text,
  padding: "9px 12px",
  fontFamily: t.fontSans,
  fontSize: 13,
};

const toggleStyle = (active: boolean): CSSProperties => ({
  ...outlineAction,
  opacity: active ? 1 : 0.85,
  padding: "9px 12px",
  borderRadius: 4,
  fontSize: 12,
  cursor: "pointer",
});

const archiveButtonStyle: CSSProperties = {
  ...outlineAction,
  borderRadius: 4,
  padding: "6px 10px",
  fontSize: 12,
  cursor: "pointer",
};

const archivedListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const archivedCardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  border: `1px solid ${t.border}`,
  borderRadius: 8,
  padding: "12px 14px",
  background: t.surface,
};

const archivedHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  alignItems: "center",
};

const archivedTitleStyle: CSSProperties = {
  fontFamily: t.fontMono,
  fontSize: 13,
  fontWeight: 700,
  color: t.text,
};

const archivedMetaStyle: CSSProperties = {
  fontFamily: t.fontMono,
  fontSize: 10,
  color: t.muted,
  marginTop: 4,
};

const emptyStyle: CSSProperties = {
  border: `1px dashed ${t.border}`,
  borderRadius: 8,
  padding: "18px 16px",
  color: t.dim,
  fontFamily: t.fontSans,
  fontSize: 13,
};
