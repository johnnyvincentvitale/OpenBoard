import type { PendingPermissionAsk, Task } from "../shared";
import { formatElapsed } from "./model";

export interface PermissionAskSummary {
  count: number;
  oldest?: PendingPermissionAsk;
  countdownMs?: number;
  label: string;
  detail: string;
}

export function pendingPermissionAsks(task: Pick<Task, "pendingPermissions"> | undefined): PendingPermissionAsk[] {
  return [...(task?.pendingPermissions ?? [])].sort((a, b) => a.raisedAt - b.raisedAt || a.id.localeCompare(b.id));
}

export function permissionAskSummary(task: Pick<Task, "pendingPermissions"> | undefined, now = Date.now()): PermissionAskSummary | undefined {
  const asks = pendingPermissionAsks(task);
  if (asks.length === 0) return undefined;
  const oldest = asks[0];
  const countdownMs = Math.max(0, oldest.deadline - now);
  const count = asks.length;
  const noun = count === 1 ? "ask" : "asks";
  return {
    count,
    oldest,
    countdownMs,
    label: `NEEDS USER INPUT · ${count} ${noun}`,
    detail: `${oldest.summary} · ${formatElapsed(countdownMs)} left · y allow once / N deny`,
  };
}

export function permissionAskBoardLabel(task: Pick<Task, "pendingPermissions"> | undefined, now = Date.now()): string | undefined {
  const summary = permissionAskSummary(task, now);
  return summary ? `◆ ${summary.label}` : undefined;
}

export function permissionAskDetailRows(task: Pick<Task, "pendingPermissions"> | undefined, now = Date.now()): Array<{ label: string; value: string }> {
  const asks = pendingPermissionAsks(task);
  if (asks.length === 0) return [];
  const oldest = asks[0];
  return [
    { label: "INPUT", value: `${asks.length} pending permission ${asks.length === 1 ? "ask" : "asks"}` },
    { label: "OLDEST ASK", value: oldest.summary },
    { label: "COUNTDOWN", value: formatElapsed(Math.max(0, oldest.deadline - now)) },
    { label: "ANSWER", value: "y allow once · uppercase N deny" },
  ];
}

export function firstPendingPermissionAsk(task: Pick<Task, "pendingPermissions"> | undefined): PendingPermissionAsk | undefined {
  return pendingPermissionAsks(task)[0];
}

export function permissionInFlightKey(taskId: string, askId: string): string {
  return `${taskId}:${askId}`;
}

/** The specific task+ask a permission response is bound to (P3-8). */
export interface PermissionAskBinding {
  taskId: string;
  askId: string;
}

/** Bind to a task's current oldest pending ask, if any. */
export function bindPermissionAsk(task: Pick<Task, "id" | "pendingPermissions"> | undefined): PermissionAskBinding | undefined {
  if (!task) return undefined;
  const ask = firstPendingPermissionAsk(task);
  return ask ? { taskId: task.id, askId: ask.id } : undefined;
}

/**
 * Resolve a binding against the current task list. Returns undefined if the
 * bound task no longer exists or the bound ask is no longer pending on it —
 * callers must treat that as "not safe to answer silently", not as
 * permission to fall back to whatever is currently selected.
 */
export function resolveBoundPermissionAsk(
  binding: PermissionAskBinding | undefined,
  tasks: Pick<Task, "id" | "pendingPermissions">[],
): { task: Pick<Task, "id" | "pendingPermissions">; ask: PendingPermissionAsk } | undefined {
  if (!binding) return undefined;
  const task = tasks.find((candidate) => candidate.id === binding.taskId);
  if (!task) return undefined;
  const ask = pendingPermissionAsks(task).find((candidate) => candidate.id === binding.askId);
  if (!ask) return undefined;
  return { task, ask };
}
