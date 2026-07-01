import type { Column } from "./columns";
import type { LiveState } from "./live-state";

/**
 * The canonical Card DTO the adapter returns and the frontend renders. Frozen contract.
 * Every field here is derivable from an OpenCode Session + its SessionStatus + the
 * board's column row. `sessionId` is the one and only id field name.
 */
export interface Card {
  sessionId: string;
  title: string;
  directory: string;
  agent?: string;
  model?: { id: string; providerID: string };
  cost: number;
  additions: number;
  deletions: number;
  files: number;
  column: Column;
  /** Dense integer, unique within a column, ascending = top-to-bottom. */
  position: number;
  liveState: LiveState;
  /** Session.time.updated (epoch ms). */
  updatedAt: number;
}
