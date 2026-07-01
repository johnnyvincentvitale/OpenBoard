/**
 * SessionCard — renders a single board Card: title, directory, agent/model,
 * cost, a +additions/-deletions (files) diff stat line, a liveState pill, and
 * the Prompt/Stop/Diff action row (via CardActions).
 */
import type { CSSProperties } from "react";
import type { SessionCardProps } from "../types";
import type { LiveState } from "../../shared";
import { CardActions } from "./CardActions";

const PULSE_STYLE_ID = "session-card-pulse-keyframes";
const PULSE_KEYFRAMES = `
@keyframes session-card-pulse {
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

const directoryStyle: CSSProperties = {
  fontSize: 12,
  opacity: 0.6,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

const metaRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  fontSize: 12,
  opacity: 0.85,
};

const agentModelStyle: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const costStyle: CSSProperties = {
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
};

const diffStatStyle: CSSProperties = {
  fontSize: 12,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  display: "flex",
  gap: 6,
  alignItems: "baseline",
};

const additionsStyle: CSSProperties = { color: "#3fb950" };
const deletionsStyle: CSSProperties = { color: "#f85149" };
const filesCountStyle: CSSProperties = { opacity: 0.6 };

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

const PILL_COLORS: Record<LiveState, { color: string; background: string }> = {
  running: { color: "#3fb950", background: "rgba(63, 185, 80, 0.12)" },
  idle: { color: "#9198a1", background: "rgba(145, 152, 161, 0.12)" },
  error: { color: "#f85149", background: "rgba(248, 81, 73, 0.12)" },
  retrying: { color: "#d29922", background: "rgba(210, 153, 34, 0.12)" },
  unknown: { color: "#6e7681", background: "rgba(110, 118, 129, 0.12)" },
};

const PILL_LABELS: Record<LiveState, string> = {
  running: "Running",
  idle: "Idle",
  error: "Error",
  retrying: "Retrying",
  unknown: "Unknown",
};

const baseDotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "currentColor",
};

const pulseDotStyle: CSSProperties = {
  ...baseDotStyle,
  animation: "session-card-pulse 1.4s ease-in-out infinite",
};

function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

function LiveStatePill({ liveState }: { liveState: LiveState }) {
  const colors = PILL_COLORS[liveState];
  const pillStyle: CSSProperties = {
    ...basePillStyle,
    color: colors.color,
    background: colors.background,
  };
  const isRunning = liveState === "running";

  return (
    <span
      style={pillStyle}
      data-testid="live-state-pill"
      data-live-state={liveState}
    >
      <span
        style={isRunning ? pulseDotStyle : baseDotStyle}
        role={isRunning ? "status" : undefined}
        aria-label={isRunning ? "running" : undefined}
        data-testid={isRunning ? "pulse-dot" : undefined}
      />
      {PILL_LABELS[liveState]}
    </span>
  );
}

export function SessionCard({ card, onPrompt, onInterrupt, onDiff }: SessionCardProps) {
  ensurePulseKeyframes();

  const directory = card.directory.split("/").filter(Boolean).pop() ?? card.directory;
  const modelId = card.model?.id;
  const agentModelParts = [card.agent, modelId].filter(Boolean);
  const running = card.liveState === "running";

  return (
    <div style={cardStyle} data-testid="session-card" data-session-id={card.sessionId}>
      <div style={headerStyle}>
        <div style={titleStyle} title={card.title}>
          {card.title}
        </div>
        <div style={directoryStyle} title={card.directory}>
          {directory}
        </div>
      </div>

      <div style={metaRowStyle}>
        <span style={agentModelStyle}>
          {agentModelParts.length > 0 ? agentModelParts.join(" · ") : "—"}
        </span>
        <span style={costStyle}>{formatCost(card.cost)}</span>
      </div>

      <div style={diffStatStyle} data-testid="diff-stat">
        <span style={additionsStyle}>+{card.additions}</span>
        <span style={deletionsStyle}>-{card.deletions}</span>
        <span style={filesCountStyle}>
          ({card.files} {card.files === 1 ? "file" : "files"})
        </span>
      </div>

      <div style={footerStyle}>
        <LiveStatePill liveState={card.liveState} />
        <CardActions
          sessionId={card.sessionId}
          running={running}
          onPrompt={onPrompt}
          onInterrupt={onInterrupt}
          onDiff={onDiff}
        />
      </div>
    </div>
  );
}
