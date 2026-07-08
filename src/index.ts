/**
 * OpenBoard — entry point / public surface.
 *
 * A local task board for OpenCode and ACP agents.
 */

export const APP_NAME = "openboard";

// Canonical frozen contracts.
export { COLUMNS, type Column } from "./shared/columns";
export { OPENCODE_DEFAULTS } from "./shared/opencode-defaults";
export type { LiveState } from "./shared/live-state";
export type { Task, TaskStore } from "./shared/task";

export function health(): { ok: true; name: string } {
  return { ok: true, name: APP_NAME };
}
