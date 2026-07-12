import type { ModelRef, TaskEvent } from "./task";

export interface WatchdogAttemptEntry {
  attempt: number;
  sessionId?: string;
  previousSessionId?: string;
  nextSessionId?: string;
  runStartedAt?: number;
  model?: ModelRef | null;
  provider?: string;
  reason?: string;
  outcome: string;
  eventType: string;
  createdAt: number;
}

const WATCHDOG_EVENT_PREFIX = "task_watchdog_";

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function modelValue(value: unknown): ModelRef | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as { providerID?: unknown; id?: unknown; variant?: unknown };
  if (typeof candidate.providerID !== "string" || typeof candidate.id !== "string") return undefined;
  return {
    providerID: candidate.providerID,
    id: candidate.id,
    ...(typeof candidate.variant === "string" ? { variant: candidate.variant } : {}),
  };
}

function fallbackOutcome(type: string): string {
  switch (type) {
    case "task_watchdog_busy_wait":
    case "task_watchdog_permission_wait":
      return "deferred";
    case "task_watchdog_tripped":
      return "tripped";
    case "task_watchdog_retry":
      return "retry-starting";
    case "task_watchdog_fallback":
      return "fallback-starting";
    case "task_watchdog_retry_started":
      return "retry-started";
    case "task_watchdog_retry_failed":
      return "start-failed";
    case "task_watchdog_abort_unconfirmed":
      return "abort-unconfirmed";
    case "task_watchdog_exhausted":
      return "exhausted";
    default:
      return type.replace(WATCHDOG_EVENT_PREFIX, "").replaceAll("_", "-");
  }
}

export function projectWatchdogAttempts(events: readonly TaskEvent[]): WatchdogAttemptEntry[] {
  const attempts = new Map<number, WatchdogAttemptEntry>();
  for (const event of [...events].filter((candidate) => candidate.type.startsWith(WATCHDOG_EVENT_PREFIX)).sort((a, b) => a.createdAt - b.createdAt)) {
    const body = event.body ?? {};
    const attempt = numberValue(body.attempt) ?? 0;
    const model = modelValue(body.model);
    const provider = stringValue(body.provider) ?? model?.providerID;
    const existing = attempts.get(attempt);
    attempts.set(attempt, {
      attempt,
      sessionId: stringValue(body.sessionId) ?? stringValue(body.nextSessionId) ?? existing?.sessionId,
      previousSessionId: stringValue(body.previousSessionId) ?? existing?.previousSessionId,
      nextSessionId: stringValue(body.nextSessionId) ?? existing?.nextSessionId,
      runStartedAt: numberValue(body.runStartedAt) ?? existing?.runStartedAt,
      model: model !== undefined ? model : existing?.model,
      provider: provider ?? existing?.provider,
      reason: stringValue(body.reason) ?? existing?.reason,
      outcome: stringValue(body.outcome) ?? fallbackOutcome(event.type),
      eventType: event.type,
      createdAt: event.createdAt,
    });
  }
  return [...attempts.values()].sort((a, b) => a.attempt - b.attempt || a.createdAt - b.createdAt);
}
