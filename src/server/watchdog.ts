import type { WatchdogConfig } from "./config";

export interface WatchdogRunIdentity {
  taskId: string;
  runStartedAt: number;
  sessionId: string;
  /** Zero-based dispatch attempt for this task. */
  attempt: number;
}

export type WatchdogReason = "liveness-timeout";
export type WatchdogStage = "idle" | "healthy" | "suspected" | "stalled" | "terminated" | "exhausted";
export type WatchdogTerminalOutcome = "retry" | "exhausted" | "completed" | "aborted";

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
  outcome: "retry" | "exhausted";
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
  lastActivityAt: number | null;
  diagnosticDeadlineAt: number | null;
}

export interface WatchdogActivityInput {
  run: WatchdogRunIdentity;
  occurredAt?: number;
  /** Heartbeat-only board frames/noise do not refresh liveness. */
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
  private lastActivityAt: number | null = null;
  private diagnosticDeadlineAt: number | null = null;

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
    this.run = copyRun(run);
    this.stage = "healthy";
    this.reason = null;
    this.lastActivityAt = startedAt;
    this.diagnosticDeadlineAt = null;
    this.scheduleNext();
    return this.snapshot();
  }

  recordActivity(input: WatchdogActivityInput): boolean {
    if (!sameRun(this.run, input.run) || this.isTerminal()) return false;
    if (input.noise) return true;
    const occurredAt = input.occurredAt ?? this.clock.now();
    if (occurredAt < (this.lastActivityAt ?? 0)) return false;
    this.lastActivityAt = occurredAt;
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
    this.stop();
    return "completed";
  }

  abort(run: WatchdogRunIdentity): WatchdogTerminalOutcome | null {
    if (!sameRun(this.run, run)) return null;
    this.stop();
    return "aborted";
  }

  snapshot(): WatchdogSnapshot {
    return {
      run: this.run ? copyRun(this.run) : null,
      stage: this.stage,
      reason: this.reason,
      lastActivityAt: this.lastActivityAt,
      diagnosticDeadlineAt: this.diagnosticDeadlineAt,
    };
  }

  restore(snapshot: WatchdogSnapshot): void {
    this.clearTimer();
    this.run = snapshot.run ? copyRun(snapshot.run) : null;
    this.stage = snapshot.stage;
    this.reason = snapshot.reason;
    this.lastActivityAt = snapshot.lastActivityAt;
    this.diagnosticDeadlineAt = snapshot.diagnosticDeadlineAt;
    this.scheduleNext();
  }

  dispose(): void {
    this.clearTimer();
  }

  private evaluate(): void {
    if (!this.config.enabled || !this.run || this.isTerminal()) return;
    const now = this.clock.now();

    if (this.stage === "suspected" || this.stage === "stalled") {
      if (this.diagnosticDeadlineAt !== null && now >= this.diagnosticDeadlineAt) {
        this.terminate(now);
        return;
      }
      this.scheduleNext();
      return;
    }

    if (this.lastActivityAt !== null && now >= this.lastActivityAt + this.config.timeoutMs) {
      this.suspect(now);
    }
    this.scheduleNext();
  }

  private suspect(now: number): void {
    if (!this.run || this.stage !== "healthy") return;
    this.stage = "suspected";
    this.reason = "liveness-timeout";
    this.diagnosticDeadlineAt = now + this.config.sweepIntervalMs;
    this.callbacks.onNudge?.({ run: copyRun(this.run), reason: this.reason, observedAt: now, deadlineAt: this.diagnosticDeadlineAt });
    this.stage = "stalled";
    if (this.config.sweepIntervalMs === 0) this.terminate(now);
  }

  private terminate(now: number): void {
    if (!this.run || !this.reason || this.stage === "terminated") return;
    const run = copyRun(this.run);
    const reason = this.reason;
    this.stage = "terminated";
    this.clearTimer();
    this.callbacks.onTerminate?.({ run, reason, terminatedAt: now });
    const decision = run.attempt < this.config.maxAutomaticRetries
      ? { outcome: "retry" as const, nextAttempt: run.attempt + 1 }
      : { outcome: "exhausted" as const };
    if (decision.outcome === "exhausted") this.stage = "exhausted";
    this.callbacks.onRetryDecision?.({ run, reason, decidedAt: now, ...decision });
  }

  private scheduleNext(): void {
    this.clearTimer();
    if (!this.config.enabled || !this.run || this.isTerminal() || this.lastActivityAt === null) return;
    const due = this.diagnosticDeadlineAt ?? this.lastActivityAt + this.config.timeoutMs;
    const delay = Math.max(0, due - this.clock.now());
    const tokenRun = this.run;
    this.timer = this.clock.setTimeout(() => {
      if (sameRun(this.run, tokenRun)) this.evaluate();
    }, delay);
  }

  private isTerminal(): boolean {
    return this.stage === "exhausted" || this.stage === "idle";
  }

  private stop(): void {
    this.clearTimer();
    this.run = null;
    this.stage = "idle";
    this.reason = null;
    this.lastActivityAt = null;
    this.diagnosticDeadlineAt = null;
  }

  private clearTimer(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }
}
