/**
 * TaskCard — renders a single board Task: title, truncated description,
 * directory, an AGENT badge, the model id (if set), a runState pill, and
 * the Run/Stop/Retry/Delete action row. Distinct from SessionCard, which
 * renders a live OpenCode session Card, not a pre-run Task spec.
 */
import type { CSSProperties } from "react";
import type { TaskCardProps } from "../task-types";
import type { TaskRunState } from "../../shared";

const DESCRIPTION_MAX_LENGTH = 140;

const cardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  padding: 12,
  borderRadius: 10,
  border: "1px solid rgba(255, 255, 255, 0.1)",
  background: "rgba(255, 255, 255, 0.03)",
  color: "inherit",
  fontFamily: "inherit",
};

const headerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const titleStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  lineHeight: 1.3,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const descriptionStyle: CSSProperties = {
  fontSize: 12,
  opacity: 0.75,
  lineHeight: 1.4,
};

const directoryStyle: CSSProperties = {
  fontSize: 12,
  opacity: 0.6,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

const metaRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 12,
  opacity: 0.85,
  flexWrap: "wrap",
};

const modelStyle: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  opacity: 0.7,
};

const footerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};

const basePillStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "2px 8px",
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.03em",
  whiteSpace: "nowrap",
};

const AGENT_BADGE_COLORS: Record<string, { color: string; background: string }> = {
  build: { color: "#3fb950", background: "rgba(63, 185, 80, 0.12)" },
  plan: { color: "#58a6ff", background: "rgba(88, 166, 255, 0.12)" },
};

const DEFAULT_AGENT_BADGE_COLOR = { color: "#a371f7", background: "rgba(163, 113, 247, 0.12)" };

function agentBadgeColors(agent: string): { color: string; background: string } {
  return AGENT_BADGE_COLORS[agent] ?? DEFAULT_AGENT_BADGE_COLOR;
}

const RUN_STATE_COLORS: Record<TaskRunState, { color: string; background: string }> = {
  running: { color: "#3fb950", background: "rgba(63, 185, 80, 0.12)" },
  idle: { color: "#9198a1", background: "rgba(145, 152, 161, 0.12)" },
  error: { color: "#f85149", background: "rgba(248, 81, 73, 0.12)" },
  unstarted: { color: "#6e7681", background: "rgba(110, 118, 129, 0.12)" },
};

const RUN_STATE_LABELS: Record<TaskRunState, string> = {
  running: "Running",
  idle: "Idle",
  error: "Error",
  unstarted: "Unstarted",
};

const baseDotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "currentColor",
};

const pulseDotStyle: CSSProperties = {
  ...baseDotStyle,
  animation: "task-card-pulse 1.4s ease-in-out infinite",
};

const baseButtonStyle: CSSProperties = {
  flex: 1,
  padding: "6px 10px",
  fontSize: 12,
  fontWeight: 600,
  borderRadius: 6,
  border: "1px solid rgba(255, 255, 255, 0.12)",
  background: "rgba(255, 255, 255, 0.04)",
  color: "inherit",
  cursor: "pointer",
};

const deleteButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  flex: "initial",
  color: "#f85149",
};

const actionRowStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
};

const worktreeBadgeStyle: CSSProperties = {
  fontSize: 11,
  padding: "1px 7px",
  borderRadius: 999,
  color: "#58a6ff",
  background: "rgba(88, 166, 255, 0.12)",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  maxWidth: "100%",
};

const promptStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  padding: "6px 8px",
  borderRadius: 6,
  fontSize: 12,
  color: "#e3b341",
  background: "rgba(227, 179, 65, 0.1)",
  border: "1px solid rgba(227, 179, 65, 0.25)",
};

const PULSE_STYLE_ID = "task-card-pulse-keyframes";
const PULSE_KEYFRAMES = `
@keyframes task-card-pulse {
  0% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(1.4); }
  100% { opacity: 1; transform: scale(1); }
}
`;

/** Ensure the pulse keyframe rule exists in the document exactly once. */
function ensurePulseKeyframes(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(PULSE_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = PULSE_STYLE_ID;
  style.textContent = PULSE_KEYFRAMES;
  document.head.appendChild(style);
}

function truncateDescription(description: string): string {
  if (description.length <= DESCRIPTION_MAX_LENGTH) return description;
  return `${description.slice(0, DESCRIPTION_MAX_LENGTH).trimEnd()}…`;
}

function RunStatePill({ runState }: { runState: TaskRunState }) {
  const colors = RUN_STATE_COLORS[runState];
  const pillStyle: CSSProperties = {
    ...basePillStyle,
    color: colors.color,
    background: colors.background,
  };
  const isRunning = runState === "running";

  return (
    <span style={pillStyle} data-testid="run-state-pill" data-run-state={runState}>
      <span
        style={isRunning ? pulseDotStyle : baseDotStyle}
        role={isRunning ? "status" : undefined}
        aria-label={isRunning ? "running" : undefined}
        data-testid={isRunning ? "pulse-dot" : undefined}
      />
      {RUN_STATE_LABELS[runState]}
    </span>
  );
}

export function TaskCard({
  task,
  agents,
  onRun,
  onRetry,
  onAbort,
  onDelete,
  onInitGit,
  onSync,
  onIntegrate,
}: TaskCardProps) {
  ensurePulseKeyframes();

  const directory = task.directory.split("/").filter(Boolean).pop() ?? task.directory;
  const running = task.runState === "running";
  const needsGitInit = task.pending === "git-init";
  const hasWorktree = Boolean(task.worktreeBranch);
  // Once the agent's turn is done (review/idle), the worktree is ready to integrate.
  const canIntegrate = hasWorktree && Boolean(task.worktreePath) && !running;
  const showRun = (task.runState === "unstarted" || task.column === "todo") && !needsGitInit;
  const showRetry = task.column === "review" || task.runState === "error";
  const rosterAgent = task.agent ? agents.find((agent) => agent.id === task.agent) : undefined;
  const agentLabel = rosterAgent?.id ?? task.agent;
  const agentBadgeStyle: CSSProperties = task.agent
    ? { ...basePillStyle, ...agentBadgeColors(task.agent) }
    : {};

  const handleDelete = () => {
    if (typeof window !== "undefined" && !window.confirm(`Delete task "${task.title}"?`)) {
      return;
    }
    onDelete(task.id);
  };

  return (
    <div style={cardStyle} data-testid="task-card" data-task-id={task.id}>
      <div style={headerStyle}>
        <div style={titleStyle} title={task.title}>
          {task.title}
        </div>
        <div style={descriptionStyle} data-testid="task-description">
          {truncateDescription(task.description)}
        </div>
        <div style={directoryStyle} title={task.directory}>
          {directory}
        </div>
      </div>

      <div style={metaRowStyle}>
        {task.agent ? (
          <span style={agentBadgeStyle} data-testid="agent-badge">
            {agentLabel}
          </span>
        ) : null}
        {task.model?.id ? (
          <span style={modelStyle} data-testid="model-id">
            {task.model.id}
          </span>
        ) : null}
        {hasWorktree ? (
          <span
            style={worktreeBadgeStyle}
            data-testid="worktree-branch"
            title={task.worktreePath ?? task.worktreeBranch}
          >
            ⑃ {task.worktreeBranch}
          </span>
        ) : null}
      </div>

      {needsGitInit ? (
        <div style={promptStyle} data-testid="git-init-prompt">
          <span>Not a git repo — initialize it to isolate this run?</span>
          <button
            type="button"
            style={{ ...baseButtonStyle, flex: "initial" }}
            onClick={() => onInitGit(task.id)}
          >
            Make repo &amp; run
          </button>
        </div>
      ) : null}

      <div style={footerStyle}>
        <RunStatePill runState={task.runState} />
        <div style={actionRowStyle} data-testid="task-actions">
          {showRun ? (
            <button type="button" style={baseButtonStyle} onClick={() => onRun(task.id)}>
              Run
            </button>
          ) : null}
          {running ? (
            <button type="button" style={baseButtonStyle} onClick={() => onAbort(task.id)}>
              Stop
            </button>
          ) : null}
          {showRetry ? (
            <button type="button" style={baseButtonStyle} onClick={() => onRetry(task.id)}>
              Retry
            </button>
          ) : null}
          {hasWorktree ? (
            <button
              type="button"
              style={baseButtonStyle}
              onClick={() => onSync(task.id)}
              title="Merge the upstream base branch into this worktree"
            >
              Sync
            </button>
          ) : null}
          {canIntegrate ? (
            <button
              type="button"
              style={baseButtonStyle}
              onClick={() => onIntegrate(task.id)}
              title="Merge this worktree's branch into the base branch and remove the worktree"
            >
              Integrate
            </button>
          ) : null}
          <button type="button" style={deleteButtonStyle} onClick={handleDelete}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
