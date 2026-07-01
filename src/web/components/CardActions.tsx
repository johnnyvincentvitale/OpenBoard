/**
 * Three-button action row for a session card: Prompt, Stop, Diff.
 * Extracted so SessionCard stays focused on layout/metadata; this owns the
 * action-button wiring only. Stop is disabled unless the session is running.
 */
import type { CSSProperties } from "react";

export interface CardActionsProps {
  sessionId: string;
  running: boolean;
  onPrompt: (sessionId: string) => void;
  onInterrupt: (sessionId: string) => void;
  onDiff: (sessionId: string) => void;
}

const rowStyle: CSSProperties = {
  display: "flex",
  gap: 8,
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

const disabledButtonStyle: CSSProperties = {
  ...baseButtonStyle,
  cursor: "not-allowed",
  opacity: 0.4,
};

export function CardActions({
  sessionId,
  running,
  onPrompt,
  onInterrupt,
  onDiff,
}: CardActionsProps) {
  return (
    <div style={rowStyle} data-testid="card-actions">
      <button
        type="button"
        style={baseButtonStyle}
        onClick={() => onPrompt(sessionId)}
      >
        Prompt
      </button>
      <button
        type="button"
        style={running ? baseButtonStyle : disabledButtonStyle}
        disabled={!running}
        onClick={() => onInterrupt(sessionId)}
      >
        Stop
      </button>
      <button
        type="button"
        style={baseButtonStyle}
        onClick={() => onDiff(sessionId)}
      >
        Diff
      </button>
    </div>
  );
}
