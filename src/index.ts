/**
 * OpenBoard — entry point / public surface.
 *
 * A local, Devin-style Kanban command center for OpenCode. Cards are OpenCode
 * sessions pulled live from the `opencode serve` HTTP API; columns are owned by
 * this app (OpenCode has no native column field) and stored in a SQLite sidecar.
 *
 * Canonical contracts live in `src/shared/*` and are re-exported here.
 */

export const APP_NAME = "openboard";

// Canonical frozen contracts.
export { COLUMNS, type Column } from "./shared/columns";
export { OPENCODE_DEFAULTS } from "./shared/opencode-defaults";
export type { Card } from "./shared/card";
export type { LiveState } from "./shared/live-state";
export type { ColumnStore, BoardRow } from "./shared/column-store";

export function health(): { ok: true; name: string } {
  return { ok: true, name: APP_NAME };
}
