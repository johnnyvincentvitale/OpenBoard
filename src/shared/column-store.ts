import type { Column } from "./columns";

/**
 * A persisted board row: which column a session sits in and where. Positions are
 * dense integers, unique within a column (UNIQUE(column, position)), reindexed
 * atomically on move.
 */
export interface BoardRow {
  sessionId: string;
  column: Column;
  position: number;
  createdAt: number;
  updatedAt: number;
}

/** Minimal live-session reference the store reconciles the board against. */
export interface SessionRef {
  sessionId: string;
  /** True while the session is actively running — used for the auto promote-to-in_progress rule. */
  running?: boolean;
}

/**
 * The board's column/ordering store. SYNCHRONOUS (better-sqlite3) — no promises.
 * The sole owner of column state; OpenCode has no native column concept.
 */
export interface ColumnStore {
  /** All rows, ready to merge with live sessions. */
  getBoard(): BoardRow[];
  getRow(sessionId: string): BoardRow | undefined;
  /**
   * Ensure every live session has a row (new ones land in DEFAULT_COLUMN at the end),
   * apply the auto "running -> in_progress on first sighting" rule, and drop rows for
   * sessions no longer present. Idempotent.
   */
  reconcile(live: SessionRef[]): void;
  /** Ensure a single session has a row, creating it in DEFAULT_COLUMN if absent. */
  reconcileOne(sessionId: string): BoardRow;
  /** Move a card to (column, position), reindexing siblings atomically. */
  moveCard(sessionId: string, column: Column, position: number): void;
  /** Move a card to the end of in_progress if it is not already past todo. */
  promoteToInProgress(sessionId: string): void;
  /** Delete rows whose session id is not in the live set. */
  purgeOrphans(live: SessionRef[]): void;
}
