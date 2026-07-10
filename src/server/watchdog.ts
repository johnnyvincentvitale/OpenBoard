import type { WatchdogConfig } from "./config";

export interface WatchdogRunIdentity {
  taskId: string;
  runStartedAt: number;
  sessionId: string;
  /** Zero-based dispatch attempt for this task. */
  attempt: number;
}

export type WatchdogReason = "provider-silence" | "task-inactivity";
export type WatchdogStage = "idle" | "healthy" | "suspected" | "stalled" | "terminated" | "exhausted" | "circuit-open";
export type WatchdogTerminalOutcome = "retry" | "exhausted" | "circuit-open" | "completed" | "aborted";

export interface WatchdogNudge {
  run: WatchdogRunIdentity;
  reason: WatchdogReason;
  observedAt: number;
  deadlineAt: number;
}

export interface WatchdogTermination {
  run: WatchdogRunIdentity;
  reason: WatchdogReason;
  terminatedAt: number;
}

export interface WatchdogRetryDecision {
  run: WatchdogRunIdentity;
  reason: WatchdogReason;
  decidedAt: number;
  outcome: "retry" | "exhausted" | "circuit-open";
  nextAttempt?: number;
}

export interface WatchdogCallbacks {
  onNudge?: (nudge: WatchdogNudge) => void;
  onTerminate?: (termination: WatchdogTermination) => void;
  onRetryDecision?: (decision: WatchdogRetryDecision) => void;
}

export interface WatchdogClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface WatchdogSnapshot {
  run: WatchdogRunIdentity | null;
  stage: WatchdogStage;
  reason: WatchdogReason | null;
  lastProviderActivityAt: number | null;
  lastMeaningfulActivityAt: number | null;
  diagnosticDeadlineAt: number | null;
  consecutiveFailures: number;
  circuitOpenedAt: number | null;
}

export interface WatchdogActivityInput {
  run: WatchdogRunIdentity;
  occurredAt?: number;
  meaningful?: boolean;
  noise?: boolean;
}

const DEFAULT_CLOCK: WatchdogClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

function sameRun(a: WatchdogRunIdentity | null, b: WatchdogRunIdentity): boolean {
  return !!a && a.taskId === b.taskId && a.runStartedAt === b.runStartedAt && a.sessionId === b.sessionId && a.attempt === b.attempt;
}

function copyRun(run: WatchdogRunIdentity): WatchdogRunIdentity {
  return { ...run };
}

export class RunWatchdog {
  private timer: unknown | null = null;
  private run: WatchdogRunIdentity | null = null;
  private stage: WatchdogStage = "idle";
  private reason: WatchdogReason | null = null;
  private lastProviderActivityAt: number | null = null;
  private lastMeaningfulActivityAt: number | null = null;
  private diagnosticDeadlineAt: number | null = null;
  private consecutiveFailures = 0;
  private circuitOpenedAt: number | null = null;

  constructor(
    private readonly config: WatchdogConfig,
    private readonly callbacks: WatchdogCallbacks = {},
    private readonly clock: WatchdogClock = DEFAULT_CLOCK,
    snapshot?: WatchdogSnapshot,
  ) {
    if (snapshot) this.restore(snapshot);
  }

  startRun(run: WatchdogRunIdentity, startedAt = this.clock.now()): WatchdogSnapshot {
    this.clearTimer();
    this.maybeResetCircuit(startedAt);
    this.run = copyRun(run);
    this.stage = this.isCircuitOpen(startedAt) ? "circuit-open" : "healthy";
    this.reason = null;
    this.lastProviderActivityAt = startedAt;
    this.lastMeaningfulActivityAt = startedAt;
    this.diagnosticDeadlineAt = null;
    this.scheduleNext();
    return this.snapshot();
  }

  recordActivity(input: WatchdogActivityInput): boolean {
    if (!sameRun(this.run, input.run) || this.isTerminal()) return false;
    const occurredAt = input.occurredAt ?? this.clock.now();
    if (occurredAt < (this.lastProviderActivityAt ?? 0)) return false;
    this.lastProviderActivityAt = occurredAt;
    if (input.meaningful && !input.noise) this.lastMeaningfulActivityAt = occurredAt;
    if (this.stage === "suspected" || this.stage === "stalled") {
      this.stage = "healthy";
      this.reason = null;
      this.diagnosticDeadlineAt = null;
    }
    this.scheduleNext();
    return true;
  }

  complete(run: WatchdogRunIdentity): WatchdogTerminalOutcome | null {
    if (!sameRun(this.run, run)) return null;
    this.consecutiveFailures = 0;
    this.stop("completed");
    return "completed";
  }

  abort(run: WatchdogRunIdentity): WatchdogTerminalOutcome | null {
    if (!sameRun(this.run, run)) return null;
    this.stop("aborted");
    return "aborted";
  }

  snapshot(): WatchdogSnapshot {
    return {
      run: this.run ? copyRun(this.run) : null,
      stage: this.stage,
      reason: this.reason,
      lastProviderActivityAt: this.lastProviderActivityAt,
      lastMeaningfulActivityAt: this.lastMeaningfulActivityAt,
      diagnosticDeadlineAt: this.diagnosticDeadlineAt,
      consecutiveFailures: this.consecutiveFailures,
      circuitOpenedAt: this.circuitOpenedAt,
    };
  }

  restore(snapshot: WatchdogSnapshot): void {
    this.clearTimer();
    this.run = snapshot.run ? copyRun(snapshot.run) : null;
    this.stage = snapshot.stage;
    this.reason = snapshot.reason;
    this.lastProviderActivityAt = snapshot.lastProviderActivityAt;
    this.lastMeaningfulActivityAt = snapshot.lastMeaningfulActivityAt;
    this.diagnosticDeadlineAt = snapshot.diagnosticDeadlineAt;
    this.consecutiveFailures = snapshot.consecutiveFailures;
    this.circuitOpenedAt = snapshot.circuitOpenedAt;
    this.scheduleNext();
  }

  dispose(): void {
    this.clearTimer();
  }

  private evaluate(): void {
    if (!this.config.enabled || !this.run || this.isTerminal()) return;
    const now = this.clock.now();
    this.maybeResetCircuit(now);
    if (this.isCircuitOpen(now)) {
      this.stage = "circuit-open";
      this.clearTimer();
      return;
    }

    if (this.stage === "suspected" || this.stage === "stalled") {
      if (this.diagnosticDeadlineAt !== null && now >= this.diagnosticDeadlineAt) {
        this.terminate(now);
        return;
      }
      this.scheduleNext();
      return;
    }

    const reason = this.thresholdReason(now);
    if (reason) this.suspect(reason, now);
    this.scheduleNext();
  }

  private thresholdReason(now: number): WatchdogReason | null {
    const providerDue = this.config.providerSilenceMs > 0 && this.lastProviderActivityAt !== null
      ? this.lastProviderActivityAt + this.config.providerSilenceMs
      : Number.POSITIVE_INFINITY;
    const taskDue = this.config.taskInactivityMs > 0 && this.lastMeaningfulActivityAt !== null
      ? this.lastMeaningfulActivityAt + this.config.taskInactivityMs
      : Number.POSITIVE_INFINITY;
    const due = Math.min(providerDue, taskDue);
    if (now < due) return null;
    return providerDue <= taskDue ? "provider-silence" : "task-inactivity";
  }

  private suspect(reason: WatchdogReason, now: number): void {
    if (!this.run || this.stage !== "healthy") return;
    this.stage = "suspected";
    this.reason = reason;
    this.diagnosticDeadlineAt = now + this.config.diagnosticWindowMs;
    this.callbacks.onNudge?.({ run: copyRun(this.run), reason, observedAt: now, deadlineAt: this.diagnosticDeadlineAt });
    this.stage = "stalled";
    if (this.config.diagnosticWindowMs === 0) this.terminate(now);
  }

  private terminate(now: number): void {
    if (!this.run || !this.reason || this.stage === "terminated") return;
    const run = copyRun(this.run);
    const reason = this.reason;
    this.stage = "terminated";
    this.clearTimer();
    this.callbacks.onTerminate?.({ run, reason, terminatedAt: now });
    this.consecutiveFailures += 1;
    const outcome = this.decideRetry(now, run);
    this.callbacks.onRetryDecision?.({ run, reason, decidedAt: now, ...outcome });
  }

  private decideRetry(now: number, run: WatchdogRunIdentity): Pick<WatchdogRetryDecision, "outcome" | "nextAttempt"> {
    const threshold = this.config.circuitBreaker.failureThreshold;
    if (threshold > 0 && this.consecutiveFailures >= threshold) {
      this.circuitOpenedAt = now;
      this.stage = "circuit-open";
      return { outcome: "circuit-open" };
    }
    if (run.attempt < this.config.maxRetries) {
      return { outcome: "retry", nextAttempt: run.attempt + 1 };
    }
    this.stage = "exhausted";
    return { outcome: "exhausted" };
  }

  private scheduleNext(): void {
    this.clearTimer();
    if (!this.config.enabled || !this.run || this.isTerminal()) return;
    const now = this.clock.now();
    const dueTimes = [
      this.config.providerSilenceMs > 0 && this.lastProviderActivityAt !== null ? this.lastProviderActivityAt + this.config.providerSilenceMs : null,
      this.config.taskInactivityMs > 0 && this.lastMeaningfulActivityAt !== null ? this.lastMeaningfulActivityAt + this.config.taskInactivityMs : null,
      this.diagnosticDeadlineAt,
    ].filter((value): value is number => value !== null);
    if (dueTimes.length === 0) return;
    const delay = Math.max(0, Math.min(...dueTimes) - now);
    const tokenRun = this.run;
    this.timer = this.clock.setTimeout(() => {
      if (sameRun(this.run, tokenRun)) this.evaluate();
    }, delay);
  }

  private maybeResetCircuit(now: number): void {
    if (this.circuitOpenedAt === null || this.config.circuitBreaker.resetMs === 0) return;
    if (now - this.circuitOpenedAt >= this.config.circuitBreaker.resetMs) {
      this.circuitOpenedAt = null;
      this.consecutiveFailures = 0;
      if (this.stage === "circuit-open") this.stage = this.run ? "healthy" : "idle";
    }
  }

  private isCircuitOpen(now: number): boolean {
    this.maybeResetCircuit(now);
    return this.circuitOpenedAt !== null;
  }

  private isTerminal(): boolean {
    return this.stage === "exhausted" || this.stage === "circuit-open" || this.stage === "idle";
  }

  private stop(stage: "completed" | "aborted"): void {
    void stage;
    this.clearTimer();
    this.run = null;
    this.stage = "idle";
    this.reason = null;
    this.lastProviderActivityAt = null;
    this.lastMeaningfulActivityAt = null;
    this.diagnosticDeadlineAt = null;
  }

  private clearTimer(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }
}
