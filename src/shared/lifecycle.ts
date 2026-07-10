/**
 * Shared computed dominant-state projection for tasks.
 *
 * This is the single source of truth for the precedence order used by both
 * the TUI and the MCP surface. It derives a single `DominantTaskState` from
 * the raw component fields (runState, column, pending, completion,
 * pendingPermissions) so an orchestrator cannot pick a different winner than
 * the TUI for the same row.
 *
 * Precedence (highest first):
 *   permission > blocked-review > accepted-blocked-done >
 *   running > error > pending(git) > review > done > idle > queued
 *
 * Raw component fields are preserved by the caller — this projection never
 * mutates or discards them. It only adds a computed dominant state.
 */
import type { Task } from "./task";

export const DOMINANT_TASK_STATES = [
  "needs-user-input",
  "blocked",
  "accepted-blocked",
  "running",
  "error",
  "pending",
  "review",
  "done",
  "idle",
  "queued",
] as const;

export type DominantTaskState = (typeof DOMINANT_TASK_STATES)[number];

/**
 * The minimal task shape the dominant-state projection needs to inspect.
 * Matches the TUI's `TaskLifecycleInput` pick so both surfaces read the
 * same fields.
 */
export type DominantTaskStateInput = Pick<
  Task,
  "runState" | "column" | "pending" | "completion" | "pendingPermissions"
>;

/**
 * Resolve the single dominant state for a task.
 *
 * This is a pure projection: it returns plain data and never reads clocks.
 * The permission check is time-independent (it only checks for the
 * presence of pending permission asks, not their deadlines) so the MCP and
 * TUI always agree on the winner — deadline countdowns are a display
 * concern handled by the TUI.
 */
export function dominantTaskState(task: DominantTaskStateInput): DominantTaskState {
  // 1. Permission — highest precedence.
  if (task.pendingPermissions && task.pendingPermissions.length > 0) {
    return "needs-user-input";
  }

  // 2. Blocked review (completion outcome blocked, in review column).
  if (task.column === "review" && task.completion?.outcome === "blocked") {
    return "blocked";
  }

  // 3. Accepted-blocked done (completion outcome blocked, in done column).
  if (task.column === "done" && task.completion?.outcome === "blocked") {
    return "accepted-blocked";
  }

  // 4. Running.
  if (task.runState === "running") {
    return "running";
  }

  // 5. Error.
  if (task.runState === "error") {
    return "error";
  }

  // 6. Pending (git-init, base-checkout-escape, rebase-conflict).
  if (
    task.pending === "git-init" ||
    task.pending === "base-checkout-escape" ||
    task.pending === "rebase-conflict"
  ) {
    return "pending";
  }

  // 7. Review (any other review-column state).
  if (task.column === "review") {
    return "review";
  }

  // 8. Done.
  if (task.column === "done") {
    return "done";
  }

  // 9. Idle.
  if (task.runState === "idle") {
    return "idle";
  }

  // 10. Queued (default for unstarted/todo tasks).
  return "queued";
}
