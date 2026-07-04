/**
 * Canonical REST + SSE route contract. Namespace: /api/board. Frozen.
 * ROUTE_PATTERNS are Hono path patterns (server); buildPath.* are client helpers.
 */
import type { CompletionReport } from "./task";

export const ROUTE_PATTERNS = {
  health: "/api/health",
  board: "/api/board",
  boardEvents: "/api/board/events",
  cardMove: "/api/board/cards/:id/move",
  cardPrompt: "/api/board/cards/:id/prompt",
  cardInterrupt: "/api/board/cards/:id/interrupt",
  cardDiff: "/api/board/cards/:id/diff",
} as const;

export const buildPath = {
  health: () => "/api/health",
  board: () => "/api/board",
  boardEvents: () => "/api/board/events",
  cardMove: (id: string) => `/api/board/cards/${encodeURIComponent(id)}/move`,
  cardPrompt: (id: string) => `/api/board/cards/${encodeURIComponent(id)}/prompt`,
  cardInterrupt: (id: string) => `/api/board/cards/${encodeURIComponent(id)}/interrupt`,
  cardDiff: (id: string) => `/api/board/cards/${encodeURIComponent(id)}/diff`,
} as const;

/** POST /api/board/cards/:id/move body. */
export interface MoveCardBody {
  column: string;
  position: number;
}

/** POST /api/board/cards/:id/prompt body. */
export interface PromptBody {
  text: string;
}

/** POST /api/tasks/:id/complete body. Server supplies outcome="complete" and reportedAt. */
export type CompleteTaskBody = Omit<CompletionReport, "reportedAt" | "outcome">;

/** POST /api/tasks/:id/block body. Server supplies outcome="blocked" and reportedAt. */
export type BlockTaskBody = Omit<CompletionReport, "reportedAt" | "outcome">;

/** POST /api/tasks/:id/archive body. */
export type ArchiveTaskBody = Record<string, never>;

/** POST /api/tasks/:id/unarchive body. */
export type UnarchiveTaskBody = Record<string, never>;

/** GET /api/tasks?archived= query parameter. */
export interface ListTasksQuery {
  archived?: "true" | "false" | "all";
}

/** POST /api/tasks/:id/links body. */
export interface AddTaskLinkBody {
  parentId: string;
}

/** DELETE /api/tasks/:id/links/:parentId has no request body. */
export type RemoveTaskLinkBody = Record<string, never>;
