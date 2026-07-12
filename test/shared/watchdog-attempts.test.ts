import { describe, expect, it } from "vitest";
import { projectWatchdogAttempts } from "../../src/shared/watchdog-attempts";
import type { TaskEvent } from "../../src/shared";

function event(id: string, type: string, body: TaskEvent["body"], createdAt: number): TaskEvent {
  return { id, taskId: "task_watchdog", type, body, createdAt };
}

describe("projectWatchdogAttempts", () => {
  it("reconstructs one attempt record from heterogeneous events for each watchdog attempt", () => {
    const projected = projectWatchdogAttempts([
      event("e1", "task_watchdog_tripped", {
        attempt: 0,
        runStartedAt: 10,
        sessionId: "ses_original",
        model: { providerID: "openai", id: "gpt-5.5" },
        provider: "openai",
        reason: "liveness-timeout",
        outcome: "tripped",
      }, 1),
      event("e2", "task_watchdog_retry", {
        attempt: 1,
        runStartedAt: 10,
        sessionId: "ses_original",
        previousSessionId: "ses_original",
        model: { providerID: "openai", id: "gpt-5.5" },
        provider: "openai",
        reason: "liveness-timeout",
        outcome: "retry-starting",
      }, 2),
      event("e3", "task_watchdog_retry_started", {
        attempt: 1,
        runStartedAt: 20,
        sessionId: "ses_retry_1",
        previousSessionId: "ses_original",
        nextSessionId: "ses_retry_1",
        model: { providerID: "openai", id: "gpt-5.5" },
        provider: "openai",
        reason: "liveness-timeout",
        outcome: "retry-started",
      }, 3),
      event("e4", "task_watchdog_fallback", {
        attempt: 2,
        runStartedAt: 20,
        sessionId: "ses_retry_1",
        previousSessionId: "ses_retry_1",
        model: { providerID: "anthropic", id: "sonnet" },
        provider: "anthropic",
        reason: "liveness-timeout",
        outcome: "fallback-starting",
      }, 4),
      event("e5", "task_watchdog_retry_failed", {
        attempt: 2,
        runStartedAt: 20,
        sessionId: "ses_retry_1",
        previousSessionId: "ses_retry_1",
        model: { providerID: "anthropic", id: "sonnet" },
        provider: "anthropic",
        reason: "liveness-timeout",
        outcome: "start-failed",
      }, 5),
      event("e6", "task_updated", {}, 6),
    ]);

    expect(projected).toEqual([
      expect.objectContaining({
        attempt: 0,
        runStartedAt: 10,
        sessionId: "ses_original",
        model: { providerID: "openai", id: "gpt-5.5" },
        provider: "openai",
        reason: "liveness-timeout",
        outcome: "tripped",
      }),
      expect.objectContaining({
        attempt: 1,
        runStartedAt: 20,
        sessionId: "ses_retry_1",
        previousSessionId: "ses_original",
        nextSessionId: "ses_retry_1",
        model: { providerID: "openai", id: "gpt-5.5" },
        provider: "openai",
        reason: "liveness-timeout",
        outcome: "retry-started",
      }),
      expect.objectContaining({
        attempt: 2,
        runStartedAt: 20,
        sessionId: "ses_retry_1",
        previousSessionId: "ses_retry_1",
        model: { providerID: "anthropic", id: "sonnet" },
        provider: "anthropic",
        reason: "liveness-timeout",
        outcome: "start-failed",
      }),
    ]);
  });

  it("keeps legacy watchdog events readable without inventing model or session values", () => {
    expect(projectWatchdogAttempts([
      event("legacy", "task_watchdog_retry", { attempt: 1, model: { providerID: "openai", id: "gpt" } }, 1),
    ])).toEqual([
      expect.objectContaining({
        attempt: 1,
        sessionId: undefined,
        runStartedAt: undefined,
        model: { providerID: "openai", id: "gpt" },
        provider: "openai",
        outcome: "retry-starting",
      }),
    ]);
  });
});
