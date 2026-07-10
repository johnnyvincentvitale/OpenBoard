import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WatchdogConfig } from "../../src/server/config";
import { RunWatchdog, type WatchdogRetryDecision, type WatchdogRunIdentity } from "../../src/server/watchdog";

const baseConfig: WatchdogConfig = {
  enabled: true,
  timeoutMs: 100,
  sweepIntervalMs: 50,
  maxAutomaticRetries: 2,
};

const run0: WatchdogRunIdentity = { taskId: "task_1", runStartedAt: 1, sessionId: "ses_1", attempt: 0 };
const run1: WatchdogRunIdentity = { taskId: "task_1", runStartedAt: 2, sessionId: "ses_2", attempt: 1 };
const run2: WatchdogRunIdentity = { taskId: "task_1", runStartedAt: 3, sessionId: "ses_3", attempt: 2 };

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
  it("fires on the single liveness threshold, then waits one diagnostic sweep before termination", async () => {
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
    expect(watchdog.snapshot()).toMatchObject({ stage: "stalled", reason: "liveness-timeout", diagnosticDeadlineAt: 150 });
    expect(terminations).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(50);
    expect(terminations).toHaveLength(1);
    expect(decisions).toEqual([expect.objectContaining({ outcome: "retry", nextAttempt: 1, reason: "liveness-timeout" })]);
  });

  it("refreshes liveness for attributable root/descendant activity", async () => {
    const nudges: unknown[] = [];
    const watchdog = new RunWatchdog(baseConfig, { onNudge: (event) => nudges.push(event) }, clock());

    watchdog.startRun(run0, 0);
    await vi.advanceTimersByTimeAsync(80);
    expect(watchdog.recordActivity({ run: run0, occurredAt: 80 })).toBe(true);
    await vi.advanceTimersByTimeAsync(99);
    expect(nudges).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(nudges).toHaveLength(1);
  });

  it("does not let heartbeat-only noise refresh liveness", async () => {
    const decisions: WatchdogRetryDecision[] = [];
    const watchdog = new RunWatchdog(baseConfig, {
      onRetryDecision: (event) => decisions.push(event),
    }, clock());

    watchdog.startRun(run0, 0);
    await vi.advanceTimersByTimeAsync(80);
    expect(watchdog.recordActivity({ run: run0, noise: true, occurredAt: 80 })).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(watchdog.snapshot()).toMatchObject({ stage: "stalled", reason: "liveness-timeout" });
    await vi.advanceTimersByTimeAsync(50);
    expect(decisions[0]).toMatchObject({ outcome: "retry", reason: "liveness-timeout" });
  });

  it("attributable activity clears a diagnostic observation window before termination", async () => {
    const nudges: unknown[] = [];
    const terminations: unknown[] = [];
    const watchdog = new RunWatchdog(baseConfig, {
      onNudge: (event) => nudges.push(event),
      onTerminate: (event) => terminations.push(event),
    }, clock());

    watchdog.startRun(run0, 0);
    await vi.advanceTimersByTimeAsync(100);
    expect(nudges).toHaveLength(1);
    expect(watchdog.recordActivity({ run: run0, occurredAt: 120 })).toBe(true);
    expect(watchdog.snapshot()).toMatchObject({ stage: "healthy", reason: null });

    await vi.advanceTimersByTimeAsync(99);
    expect(terminations).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(21);
    expect(nudges).toHaveLength(2);
  });

  it("rejects stale run activity and stale timers after a fresh run identity starts", async () => {
    const decisions: WatchdogRetryDecision[] = [];
    const watchdog = new RunWatchdog(baseConfig, { onRetryDecision: (event) => decisions.push(event) }, clock());

    watchdog.startRun(run0, 0);
    await vi.advanceTimersByTimeAsync(40);
    watchdog.startRun(run1, 40);
    expect(watchdog.recordActivity({ run: run0, occurredAt: 50 })).toBe(false);

    await vi.advanceTimersByTimeAsync(99);
    expect(decisions).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(51);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].run).toEqual(run1);
  });

  it("cleans up timers on abort and completion", async () => {
    const terminations: unknown[] = [];
    const watchdog = new RunWatchdog(baseConfig, { onTerminate: (event) => terminations.push(event) }, clock());

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

  it("suspend() pauses the timer so a long observation gap alone never trips termination (P2-1 regression)", async () => {
    const terminations: unknown[] = [];
    const watchdog = new RunWatchdog(baseConfig, { onTerminate: (event) => terminations.push(event) }, clock());

    watchdog.startRun(run0, 0);
    watchdog.suspend(run0);
    expect(vi.getTimerCount()).toBe(0);

    // Far past timeoutMs + sweepIntervalMs — would have tripped long ago if
    // the timer were still running.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(terminations).toHaveLength(0);
    expect(watchdog.snapshot()).toMatchObject({ stage: "healthy", suspended: true });
  });

  it("resume() rebases the liveness clock so the suspended gap is never counted against the session", async () => {
    const nudges: unknown[] = [];
    const watchdog = new RunWatchdog(baseConfig, { onNudge: (event) => nudges.push(event) }, clock());

    watchdog.startRun(run0, 0);
    await vi.advanceTimersByTimeAsync(80);
    watchdog.suspend(run0);
    await vi.advanceTimersByTimeAsync(10_000); // long transport gap
    watchdog.resume(run0, 10_080);

    expect(watchdog.snapshot()).toMatchObject({ stage: "healthy", suspended: false, lastActivityAt: 10_080 });
    // A fresh full timeout from the resume point, not from the pre-suspend baseline.
    await vi.advanceTimersByTimeAsync(99);
    expect(nudges).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(nudges).toHaveLength(1);
  });

  it("resume() clears a suspected/stalled stage reached before the gap, so reconnecting doesn't retroactively terminate", async () => {
    const terminations: unknown[] = [];
    const watchdog = new RunWatchdog(baseConfig, { onTerminate: (event) => terminations.push(event) }, clock());

    watchdog.startRun(run0, 0);
    await vi.advanceTimersByTimeAsync(100); // reaches "stalled" via the sweep window
    expect(watchdog.snapshot().stage).toBe("stalled");
    watchdog.suspend(run0);
    await vi.advanceTimersByTimeAsync(10_000); // well past the diagnostic deadline
    expect(terminations).toHaveLength(0); // suspend froze it before the deadline could fire

    watchdog.resume(run0, 10_100);
    expect(watchdog.snapshot()).toMatchObject({ stage: "healthy", reason: null });
    // Immediately after resume it must not retroactively terminate for the
    // pre-suspend stall; a fresh full timeout is required before it can trip again.
    await vi.advanceTimersByTimeAsync(99);
    expect(terminations).toHaveLength(0);
  });

  it("suspend()/resume() are no-ops outside a matching, non-terminal run", async () => {
    const watchdog = new RunWatchdog(baseConfig, {}, clock());
    watchdog.startRun(run0, 0);
    watchdog.abort(run0);
    watchdog.suspend(run0); // already terminal (idle) — no-op
    expect(watchdog.snapshot().suspended).toBe(false);

    watchdog.startRun(run1, 100);
    watchdog.suspend(run0); // wrong identity — no-op
    expect(watchdog.snapshot().suspended).toBe(false);
    watchdog.resume(run1, 100); // never suspended — no-op
    expect(vi.getTimerCount()).toBe(1);
  });

  it("permits exactly two automatic retries before exhaustion with the default budget", async () => {
    const decisions: WatchdogRetryDecision[] = [];
    const watchdog = new RunWatchdog({ ...baseConfig, sweepIntervalMs: 0 }, {
      onRetryDecision: (event) => decisions.push(event),
    }, clock());

    watchdog.startRun(run0, 0);
    await vi.advanceTimersByTimeAsync(100);
    watchdog.startRun(run1, 100);
    await vi.advanceTimersByTimeAsync(100);
    watchdog.startRun(run2, 200);
    await vi.advanceTimersByTimeAsync(100);

    expect(decisions.map((decision) => [decision.outcome, decision.nextAttempt])).toEqual([
      ["retry", 1],
      ["retry", 2],
      ["exhausted", undefined],
    ]);
    expect(watchdog.snapshot().stage).toBe("exhausted");
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

    const after = new RunWatchdog(baseConfig, { onRetryDecision: (event) => decisions.push(event) }, clock(), snapshot);
    await vi.advanceTimersByTimeAsync(60);
    await vi.advanceTimersByTimeAsync(50);

    expect(after.snapshot().stage).toBe("terminated");
    expect(decisions).toEqual([expect.objectContaining({ outcome: "retry" })]);
  });

  it("restores a terminated retry-decision state without timers or duplicate callbacks", async () => {
    const originalDecisions: WatchdogRetryDecision[] = [];
    const before = new RunWatchdog({ ...baseConfig, sweepIntervalMs: 0 }, {
      onRetryDecision: (event) => originalDecisions.push(event),
    }, clock());

    before.startRun(run0, 0);
    await vi.advanceTimersByTimeAsync(100);
    const snapshot = before.snapshot();
    expect(snapshot.stage).toBe("terminated");
    expect(originalDecisions).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);

    const duplicateDecisions: WatchdogRetryDecision[] = [];
    const duplicateTerminations: unknown[] = [];
    const after = new RunWatchdog(baseConfig, {
      onTerminate: (event) => duplicateTerminations.push(event),
      onRetryDecision: (event) => duplicateDecisions.push(event),
    }, clock(), snapshot);

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(duplicateTerminations).toHaveLength(0);
    expect(duplicateDecisions).toHaveLength(0);

    after.startRun(run1, 10_100);
    expect(after.snapshot().stage).toBe("healthy");
    expect(vi.getTimerCount()).toBe(1);
  });
});
