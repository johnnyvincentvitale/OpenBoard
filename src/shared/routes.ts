/**
 * Canonical REST + SSE route contract. Namespace: /api/board. Frozen.
 * ROUTE_PATTERNS are Hono path patterns (server); buildPath.* are client helpers.
 */
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
