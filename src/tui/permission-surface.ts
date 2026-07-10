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
