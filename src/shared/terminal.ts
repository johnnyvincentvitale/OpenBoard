/** Canonical terminal REST + WebSocket contracts. Namespace: /api/terminals. */
export const TERMINAL_ROUTE_PATTERNS = {
  create: "/api/terminals",
  socket: "/api/terminals/:id/socket",
} as const;

export const buildTerminalPath = {
  create: () => "/api/terminals",
  socket: (id: string) => `/api/terminals/${encodeURIComponent(id)}/socket`,
} as const;

/** POST /api/terminals body. */
export interface CreateTerminalInput {
  taskId?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
}

/** 201 response from POST /api/terminals. */
export interface CreateTerminalResponse {
  id: string;
  token: string;
  cwd: string;
}

/** Client -> server terminal socket messages. */
export type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

/** Server -> client terminal socket messages. */
export type TerminalServerMessage =
  | { type: "data"; data: string }
  | { type: "exit"; code: number | null };
