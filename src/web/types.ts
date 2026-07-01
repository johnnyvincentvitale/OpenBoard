import type { ReactNode } from "react";
import type { Card, Column } from "../shared/index";

/**
 * Pinned frontend component contracts. Board (agent B), SessionCard (agent C), and the
 * store/client (agent A) all build against these — do not redefine. The integrator's
 * App.tsx wires them together (Board renders cards via a renderCard prop, so Board never
 * imports SessionCard directly — keeps B and C decoupled).
 */

export interface SessionCardProps {
  card: Card;
  onPrompt: (sessionId: string) => void;
  onInterrupt: (sessionId: string) => void;
  onDiff: (sessionId: string) => void;
}

export interface BoardProps {
  cards: Card[];
  /** Called when a card is dropped into a column at a target index. */
  onMove: (sessionId: string, column: Column, position: number) => void;
  /** Render a single card (App passes SessionCard bound to its handlers). */
  renderCard: (card: Card) => ReactNode;
}

/** Connection/health banner state surfaced by the store. */
export interface BoardStatus {
  opencode: "ok" | "unreachable" | "unknown";
  sse: "connecting" | "open" | "closed";
}
