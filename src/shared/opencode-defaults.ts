/** OpenCode server defaults (verified against opencode v1.17.12, 2026-07-01). */
export const OPENCODE_DEFAULTS = {
  hostname: "127.0.0.1",
  port: 4096,
} as const;

/** The board's own Hono server default port (opencode default + 1). */
export const BOARD_SERVER_DEFAULTS = {
  hostname: "127.0.0.1",
  port: 4097,
} as const;
