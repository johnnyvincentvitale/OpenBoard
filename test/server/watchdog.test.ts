import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WatchdogConfig } from "../../src/server/config";
import { RunWatchdog, type WatchdogRetryDecision, type WatchdogRunIdentity } from "../../src/server/watchdog";

const baseConfig: WatchdogConfig = {
  enabled: true,
  providerSilenceMs: 100,
  taskInactivityMs: 300,
  diagnosticWindowMs: 50,
  maxRetries: 1,
  circuitBreaker: { failureThreshold: 0, resetMs: 0 },
};

const run0: WatchdogRunIdentity = { taskId: "task_1", runStartedAt: 1, sessionId: "ses_1", attempt: 0 };
const run1: WatchdogRunIdentity = { taskId: "task_1", runStartedAt: 2, sessionId: "ses_2", attempt: 1 };

function clock() {
  return {
    now: () => Date.now(),
    setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clearTimeout: (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RunWatchdog", () => {
  it("fires exactly on provider silence threshold, after one diagnostic window", async () => {
    const nudges: unknown[] = [];
    const terminations: unknown[] = [];
    const decisions: WatchdogRetryDecision[] = [];
    const watchdog = new RunWatchdog(baseConfig, {
      onNudge: (event) => nudges.push(event),
      onTerminate: (event) => terminations.push(event),
      onRetryDecision: (event) => decisions.push(event),
    }, clock());

    watchdog.startRun(run0, 0);
    await vi.advanceTimersByTimeAsync(99);
    expect(nudges).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(nudges).toHaveLength(1);
    expect(watchdog.snapshot()).toMatchObject({ stage: "stalled", reason: "provider-silence", diagnosticDeadlineAt: 150 });
    expect(terminations).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(50);
    expect(terminations).toHaveLength(1);
    expect(decisions).toEqual([expect.objectContaining({ outcome: "retry", nextAttempt: 1, reason: "provider-silence" })]);
  });

  it("resets provider silence on heartbeat/noise but does not reset task inactivity", async () => {
    const decisions: WatchdogRetryDecision[] = [];
    const watchdog = new RunWatchdog({ ...baseConfig, providerSilenceMs: 1_000 }, {
      onRetryDecision: (event) => decisions.push(event),
    }, clock());

    watchdog.startRun(run0, 0);
    await vi.advanceTimersByTimeAsync(250);
    expect(watchdog.recordActivity({ run: run0, noise: true, occurredAt: 250 })).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(watchdog.snapshot()).toMatchObject({ stage: "stalled", reason: "task-inactivity" });
    await vi.advanceTimersByTimeAsync(50);
    expect(decisions[0]).toMatchObject({ outcome: "retry", reason: "task-inactivity" });
  });

  it("meaningful activity clears a diagnostic observation window before termination", async () => {
    const nudges: unknown[] = [];
    const terminations: unknown[] = [];
    const watchdog = new RunWatchdog(baseConfig, {
      onNudge: (event) => nudges.push(event),
      onTerminate: (event) => terminations.push(event),
    }, clock());

    watchdog.startRun(run0, 0);
    await vi.advanceTimersByTimeAsync(100);
    expect(nudges).toHaveLength(1);
    expect(watchdog.recordActivity({ run: run0, meaningful: true, occurredAt: 120 })).toBe(true);
    expect(watchdog.snapshot()).toMatchObject({ stage: "healthy", reason: null });

    await vi.advanceTimersByTimeAsync(119);
    expect(terminations).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(nudges).toHaveLength(2);
  });

  it("rejects stale run activity and stale timers after a fresh run identity starts", async () => {
    const decisions: WatchdogRetryDecision[] = [];
    const watchdog = new RunWatchdog(baseConfig, {
      onRetryDecision: (event) => decisions.push(event),
    }, clock());

    watchdog.startRun(run0, 0);
    await vi.advanceTimersByTimeAsync(40);
    watchdog.startRun(run1, 40);
    expect(watchdog.recordActivity({ run: run0, meaningful: true, occurredAt: 50 })).toBe(false);

    await vi.advanceTimersByTimeAsync(99);
    expect(decisions).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(51);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].run).toEqual(run1);
  });

  it("cleans up timers on abort and completion", async () => {
    const terminations: unknown[] = [];
    const watchdog = new RunWatchdog(baseConfig, {
      onTerminate: (event) => terminations.push(event),
    }, clock());

    watchdog.startRun(run0, 0);
    expect(vi.getTimerCount()).toBe(1);
    expect(watchdog.abort(run0)).toBe("aborted");
    expect(vi.getTimerCount()).toBe(0);

    watchdog.startRun(run1, 10);
    expect(vi.getTimerCount()).toBe(1);
    expect(watchdog.complete(run1)).toBe("completed");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(terminations).toHaveLength(0);
  });

  it("exhausts when the strict attempt cap is reached", async () => {
    const decisions: WatchdogRetryDecision[] = [];
    const watchdog = new RunWatchdog({ ...baseConfig, maxRetries: 0, diagnosticWindowMs: 0 }, {
      onRetryDecision: (event) => decisions.push(event),
    }, clock());

    watchdog.startRun(run0, 0);
    await vi.advanceTimersByTimeAsync(100);
    expect(decisions).toEqual([expect.objectContaining({ outcome: "exhausted" })]);
    expect(decisions[0]).not.toHaveProperty("nextAttempt");
    expect(watchdog.snapshot().stage).toBe("exhausted");
  });

  it("opens the circuit exactly once after configured watchdog failures", async () => {
    const decisions: WatchdogRetryDecision[] = [];
    const watchdog = new RunWatchdog({ ...baseConfig, diagnosticWindowMs: 0, maxRetries: 5, circuitBreaker: { failureThreshold: 2, resetMs: 0 } }, {
      onRetryDecision: (event) => decisions.push(event),
    }, clock());

    watchdog.startRun(run0, 0);
    await vi.advanceTimersByTimeAsync(100);
    watchdog.startRun(run1, 100);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(decisions.map((decision) => decision.outcome)).toEqual(["retry", "circuit-open"]);
    expect(watchdog.snapshot().stage).toBe("circuit-open");
  });

  it("is inert when configuration is disabled", async () => {
    const watchdog = new RunWatchdog({ ...baseConfig, enabled: false }, {
      onTerminate: () => { throw new Error("disabled watchdog should not terminate"); },
    }, clock());

    watchdog.startRun(run0, 0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(watchdog.snapshot().stage).toBe("healthy");
  });

  it("restores restart-safe handoff state and continues pending timers", async () => {
    const decisions: WatchdogRetryDecision[] = [];
    const before = new RunWatchdog(baseConfig, {}, clock());
    before.startRun(run0, 0);
    await vi.advanceTimersByTimeAsync(40);
    const snapshot = before.snapshot();
    before.dispose();

    const after = new RunWatchdog(baseConfig, {
      onRetryDecision: (event) => decisions.push(event),
    }, clock(), snapshot);
    await vi.advanceTimersByTimeAsync(60);
    await vi.advanceTimersByTimeAsync(50);

    expect(after.snapshot().stage).toBe("terminated");
    expect(decisions).toEqual([expect.objectContaining({ outcome: "retry" })]);
  });
});
