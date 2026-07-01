/**
 * opencode-board — entry point.
 *
 * A local, Devin-style Kanban command center for OpenCode. Cards are OpenCode
 * sessions pulled live from the `opencode serve` HTTP API; columns are owned by
 * this app (OpenCode has no native column field) and stored in a SQLite sidecar.
 *
 * This file is a scaffold placeholder — the Hono adapter and board wiring land
 * on the `dev` branch as the first real features.
 */

export const APP_NAME = "opencode-board";

/** OpenCode server defaults (verified against opencode v1.17.12, 2026-07-01). */
export const OPENCODE_DEFAULTS = {
  hostname: "127.0.0.1",
  port: 4096,
} as const;

/** The workflow columns a session card can live in. */
export const COLUMNS = ["todo", "in_progress", "review", "done"] as const;
export type Column = (typeof COLUMNS)[number];

export function health(): { ok: true; name: string } {
  return { ok: true, name: APP_NAME };
}
