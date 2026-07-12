/**
 * Harness-neutral live-session activity backend core (FR09).
 *
 * Collects normalized, redaction-safe session events into an in-memory
 * per-task bounded ring buffer, fans out frames to subscribers, and enforces
 * run-identity ordering so late events from a replaced run are rejected.
 *
 * Never persists or exposes raw tool inputs/outputs, native provider IDs,
 * secrets, or arbitrary metadata. All public text and identifiers are
 * length-bounded. Numeric metadata is clamped to safe finite ranges.
 * Caller-owned mutable objects are cloned, not retained.
 */
import type {
  SessionActivityEvent,
  SessionActivityFrame,
  SessionActivityKind,
  SessionActivityRole,
  SessionActivityRun,
  SessionActivityToolStatus,
  SessionActivityTransport,
  TaskHarness,
} from "../shared";

// ── Sanitization constants ────────────────────────────────────────────────

const MAX_TEXT_LENGTH = 10_000;
const MAX_NAME_LENGTH = 256;
const MAX_ID_LENGTH = 256;
const TEXT_TRUNCATION_SENTINEL = "[...truncated]";
const SAFE_MAX_INT = Number.MAX_SAFE_INTEGER;

// ── Public types ──────────────────────────────────────────────────────────

export interface SessionActivityConfig {
  /** Maximum events per-task ring buffer. Clamped to integer >= 1. Default 1000. */
  maxEvents?: number;
  /** Injectable clock for deterministic tests. Default Date.now. */
  clock?: () => number;
}

/**
 * Normalized input for a session activity event. The collector fills in
 * seq, taskId, runStartedAt, and occurredAt.
 */
export interface SessionActivityEventInput {
  sessionId: string;
  rootSessionId: string;
  parentSessionId?: string | null;
  harness: TaskHarness;
  kind: SessionActivityKind;
  role?: SessionActivityRole;
  text?: string;
  tool?: {
    name: string;
    callId?: string;
    status: SessionActivityToolStatus;
    durationMs?: number;
    outputBytes?: number;
  };
}

/** Unsubscribe handle returned by subscribe(). */
export type Unsubscribe = () => void;

// ── Internal state ────────────────────────────────────────────────────────

interface RunState {
  /** Deep-cloned run metadata. */
  run: SessionActivityRun;
  /** Ring buffer of normalized events, newest at the end. */
  events: SessionActivityEvent[];
  /** The seq of the oldest event still in the buffer (0 if empty). */
  oldestSeq: number;
  /** Next seq to assign. */
  nextSeq: number;
  /** Current transport state. */
  transport: SessionActivityTransport;
  /** Whether this run has been terminated. */
  terminal: boolean;
  terminalStatus?: "complete" | "error" | "aborted";
}

interface SubscriberEntry {
  taskId: string;
  cursor: number;
  callback: (frame: SessionActivityFrame) => void;
}

// ── Sanitization helpers ──────────────────────────────────────────────────

function sanitizeText(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (raw.length <= MAX_TEXT_LENGTH) return raw;
  return raw.slice(0, MAX_TEXT_LENGTH - TEXT_TRUNCATION_SENTINEL.length) + TEXT_TRUNCATION_SENTINEL;
}

function sanitizeName(raw: string): string {
  if (raw.length <= MAX_NAME_LENGTH) return raw;
  return raw.slice(0, MAX_NAME_LENGTH);
}

/** Bound a public session identifier to MAX_ID_LENGTH (P3-2). */
function sanitizeId(raw: string): string {
  if (raw.length <= MAX_ID_LENGTH) return raw;
  return raw.slice(0, MAX_ID_LENGTH);
}

/** Bound an optional/null session identifier (P3-2). */
function sanitizeOptionalId(raw: string | null | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  return sanitizeId(raw);
}

function sanitizeNonNegInt(raw: number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!Number.isFinite(raw) || raw < 0) return 0;
  if (raw > SAFE_MAX_INT) return SAFE_MAX_INT;
  return Math.trunc(raw);
}

/** Deep-clone a session activity event so subscribers cannot mutate the ring (P3-4). */
function cloneEvent(event: SessionActivityEvent): SessionActivityEvent {
  return {
    ...event,
    tool: event.tool ? { ...event.tool } : undefined,
  };
}

/** Deep-clone a run so subscribers cannot mutate the stored run (P3-4). */
function cloneRun(run: SessionActivityRun): SessionActivityRun {
  return { ...run };
}

// ── Collector ─────────────────────────────────────────────────────────────

export class SessionActivityCollector {
  private readonly maxEvents: number;
  private readonly clock: () => number;
  /** Per-task run state, keyed by taskId. */
  private readonly runs = new Map<string, RunState>();
  /** Active subscribers, each scoped to a taskId + cursor. */
  private readonly subscribers = new Set<SubscriberEntry>();

  constructor(config: SessionActivityConfig = {}) {
    const raw = config.maxEvents ?? 1000;
    // Clamp: must be a safe integer >= 1.
    this.maxEvents = Number.isFinite(raw) && raw >= 1 ? Math.trunc(raw) : 1000;
    this.clock = config.clock ?? (() => Date.now());
  }

  // ── Run lifecycle ────────────────────────────────────────────────────

  /**
   * Start tracking a new run. Replaces any previous run for the same taskId.
   * Existing subscribers for this task receive a gap frame indicating the
   * old run was replaced, followed by a snapshot of the fresh (empty) run.
   */
  startRun(run: SessionActivityRun): void {
    // Deep-clone run to avoid retaining caller-owned mutable objects.
    // Bound public identifiers to MAX_ID_LENGTH (P3-2).
    const cloned: SessionActivityRun = {
      taskId: run.taskId,
      runStartedAt: run.runStartedAt,
      sessionId: sanitizeId(run.sessionId),
      rootSessionId: sanitizeId(run.rootSessionId),
      parentSessionId: sanitizeOptionalId(run.parentSessionId),
      harness: run.harness,
    };

    const oldRun = this.runs.get(cloned.taskId);

    const newState: RunState = {
      run: cloned,
      events: [],
      oldestSeq: 0,
      nextSeq: 1,
      transport: "live",
      terminal: false,
    };

    this.runs.set(cloned.taskId, newState);

    // Notify existing subscribers that the old run was replaced.
    if (oldRun) {
      const gapFrame: SessionActivityFrame = {
        kind: "gap",
        afterSeq: oldRun.nextSeq - 1,
        reason: `Run replaced (new runStartedAt=${cloned.runStartedAt})`,
      };
      for (const sub of this.subscribers) {
        if (sub.taskId === cloned.taskId) {
          this.safeCall(sub.callback, gapFrame);
        }
      }
    }

    // Always emit a fresh-run snapshot to existing subscribers.
    // Defensively copy the run per subscriber so one cannot mutate another (P3-4).
    for (const sub of this.subscribers) {
      if (sub.taskId === cloned.taskId) {
        const snapshotFrame: SessionActivityFrame = {
          kind: "snapshot",
          run: cloneRun(cloned),
          events: [],
          lastEventAt: null,
          transport: "live",
        };
        this.safeCall(sub.callback, snapshotFrame);
      }
    }
  }

  /**
   * Record a normalized event into the ring buffer for the given task+run.
   * Returns the assigned seq, or null if the run identity does not match
   * (stale/replaced run), the run has been terminated, or the input fails
   * sanitization (impossible shape).
   */
  recordEvent(
    taskId: string,
    runStartedAt: number,
    input: SessionActivityEventInput,
  ): number | null {
    const runState = this.runs.get(taskId);
    if (!runState) return null;
    if (runState.run.runStartedAt !== runStartedAt) return null;
    if (runState.terminal) return null;

    // Validate and normalize the input shape.
    const normalized = this.normalize(input);
    if (!normalized) return null;

    // OpenCode can emit the same assistant text once in a tool-calls turn
    // and again in the post-tool stop turn. Within one operator turn, keep
    // the first identical assistant reply. A user text event resets the
    // boundary, so equal answers to separate user messages remain visible.
    if (normalized.kind === "text" && normalized.role === "assistant" && normalized.text?.trim()) {
      const candidate = normalized.text.trim();
      for (let index = runState.events.length - 1; index >= 0; index -= 1) {
        const prior = runState.events[index]!;
        if (prior.kind === "text" && prior.role === "user") break;
        if (prior.kind === "text" && prior.role === "assistant" && prior.text?.trim() === candidate) return null;
      }
    }

    const seq = runState.nextSeq++;

    const event: SessionActivityEvent = {
      seq,
      taskId,
      runStartedAt,
      sessionId: sanitizeId(normalized.sessionId),
      rootSessionId: sanitizeId(normalized.rootSessionId),
      parentSessionId: sanitizeOptionalId(normalized.parentSessionId),
      harness: normalized.harness,
      occurredAt: this.clock(),
      kind: normalized.kind,
      role: normalized.role,
      text: sanitizeText(normalized.text),
      tool: normalized.tool
        ? {
            name: sanitizeName(normalized.tool.name),
            callId: normalized.tool.callId !== undefined ? sanitizeName(normalized.tool.callId) : undefined,
            status: normalized.tool.status,
            durationMs: sanitizeNonNegInt(normalized.tool.durationMs),
            outputBytes: sanitizeNonNegInt(normalized.tool.outputBytes),
          }
        : undefined,
    };

    // Ring buffer eviction: drop oldest when full.
    if (runState.events.length >= this.maxEvents) {
      runState.events.shift();
      // After shift, if the array is empty (maxEvents=1 edge case),
      // oldestSeq is set below after push. Otherwise use the new head.
      runState.oldestSeq = runState.events[0]?.seq ?? 0;
    }

    if (runState.events.length === 0) {
      runState.oldestSeq = seq;
    }
    runState.events.push(event);

    // Fanout to task-scoped subscribers.
    this.fanoutAppend(taskId, event);

    return seq;
  }

  // ── Subscriber management ────────────────────────────────────────────

  /**
   * Subscribe to frames for a specific task after the given sequence cursor.
   *
   * On connect the subscriber receives:
   * 1. A gap frame if the cursor is behind the oldest buffered event.
   * 2. Always a snapshot frame (even if empty) for an active run.
   * 3. A heartbeat frame with the run's latest event timestamp.
   * 4. A terminal frame if the run has already ended.
   *
   * After connect, new events are delivered as append frames.
   * Returns an unsubscribe function.
   */
  subscribe(
    taskId: string,
    cursor: number,
    callback: (frame: SessionActivityFrame) => void,
  ): Unsubscribe {
    const entry: SubscriberEntry = { taskId, cursor, callback };
    this.subscribers.add(entry);

    const runState = this.runs.get(taskId);

    // No run active: static heartbeat only.
    if (!runState) {
      this.safeCall(callback, {
        kind: "heartbeat",
        lastEventAt: null,
        transport: "static",
      });
      return () => {
        this.subscribers.delete(entry);
      };
    }

    // Gap: cursor is behind the oldest buffered event.
    if (cursor > 0 && runState.oldestSeq > 0 && cursor < runState.oldestSeq) {
      this.safeCall(callback, {
        kind: "gap",
        afterSeq: cursor,
        reason: `Events before seq ${runState.oldestSeq} have been evicted from the ring buffer`,
      });
    }

    // Gap: cursor is beyond the current run's entire sequence range (P3-3).
    // seq resets to 1 on each startRun, so a cursor from a replaced run is
    // always >= nextSeq. Emit an explicit gap/reset rather than an ambiguous
    // empty snapshot.
    if (cursor > 0 && cursor >= runState.nextSeq) {
      this.safeCall(callback, {
        kind: "gap",
        afterSeq: cursor,
        reason: `Sequence reset: cursor ${cursor} is beyond the current run's range (nextSeq=${runState.nextSeq}); the run may have been replaced`,
      });
    }

    // Snapshot: always sent for an active run.
    // lastEventAt reflects the run's latest buffered event, not only those after cursor.
    // Defensively copy the run and events so subscribers cannot mutate the ring (P3-4).
    const latestEvent = runState.events[runState.events.length - 1];
    const eventsAfterCursor = runState.events
      .filter((e) => e.seq > cursor)
      .map((e) => cloneEvent(e));
    this.safeCall(callback, {
      kind: "snapshot",
      run: cloneRun(runState.run),
      events: eventsAfterCursor,
      lastEventAt: latestEvent?.occurredAt ?? null,
      transport: runState.transport,
    });

    // Heartbeat with the run's latest event timestamp.
    this.safeCall(callback, {
      kind: "heartbeat",
      lastEventAt: latestEvent?.occurredAt ?? null,
      transport: runState.transport,
    });

    // Terminal frame if already ended.
    if (runState.terminal && runState.terminalStatus) {
      this.safeCall(callback, {
        kind: "terminal",
        status: runState.terminalStatus,
      });
    }

    return () => {
      this.subscribers.delete(entry);
    };
  }

  // ── Transport state ──────────────────────────────────────────────────

  /**
   * Update the transport state for a run. Emits a heartbeat frame to all
   * subscribers for that task. Rejects stale-run updates silently.
   */
  setTransport(
    taskId: string,
    runStartedAt: number,
    transport: SessionActivityTransport,
  ): void {
    const runState = this.runs.get(taskId);
    if (!runState || runState.run.runStartedAt !== runStartedAt) return;
    if (runState.terminal) return;

    runState.transport = transport;

    const latestEvent = runState.events[runState.events.length - 1];
    const frame: SessionActivityFrame = {
      kind: "heartbeat",
      lastEventAt: latestEvent?.occurredAt ?? null,
      transport,
    };
    for (const sub of this.subscribers) {
      if (sub.taskId === taskId) {
        this.safeCall(sub.callback, frame);
      }
    }
  }

  // ── Terminal ─────────────────────────────────────────────────────────

  /**
   * Mark a run as terminal. Emits a terminal frame to all subscribers for
   * that task. Subsequent recordEvent calls for this run are rejected.
   * Rejects stale-run updates silently.
   */
  endRun(
    taskId: string,
    runStartedAt: number,
    status: "complete" | "error" | "aborted",
  ): void {
    const runState = this.runs.get(taskId);
    if (!runState || runState.run.runStartedAt !== runStartedAt) return;
    if (runState.terminal) return;

    runState.terminal = true;
    runState.terminalStatus = status;

    const frame: SessionActivityFrame = { kind: "terminal", status };
    for (const sub of this.subscribers) {
      if (sub.taskId === taskId) {
        this.safeCall(sub.callback, frame);
      }
    }
  }

  // ── Reset ────────────────────────────────────────────────────────────

  /** Clear all state (runs and subscribers). For testing. */
  reset(): void {
    this.runs.clear();
    this.subscribers.clear();
  }

  // ── Internal helpers ─────────────────────────────────────────────────

  /**
   * Normalize and validate the event input. Returns a deep-cloned copy
   * (never retains caller-owned objects). Returns null for impossible
   * shape combinations.
   */
  private normalize(input: SessionActivityEventInput): SessionActivityEventInput | null {
    // Deep-clone to avoid caller-owned mutable object retention.
    const cloned: SessionActivityEventInput = {
      sessionId: input.sessionId,
      rootSessionId: input.rootSessionId,
      parentSessionId: input.parentSessionId,
      harness: input.harness,
      kind: input.kind,
      role: input.role,
      text: input.text,
      tool: input.tool
        ? {
            name: input.tool.name,
            callId: input.tool.callId,
            status: input.tool.status,
            durationMs: input.tool.durationMs,
            outputBytes: input.tool.outputBytes,
          }
        : undefined,
    };

    // Impossible shape: tool kind without tool data, or non-tool kind with tool data.
    if (cloned.kind === "tool" && !cloned.tool) return null;
    if (cloned.kind !== "tool" && cloned.tool) {
      // Drop the tool data for non-tool kinds rather than rejecting outright.
      cloned.tool = undefined;
    }

    return cloned;
  }

  /** Fan out an append frame to task-scoped subscribers, isolating throws. */
  private fanoutAppend(taskId: string, event: SessionActivityEvent): void {
    for (const sub of this.subscribers) {
      if (sub.taskId === taskId) {
        // Defensively copy the event so one subscriber cannot mutate the ring or other subscribers (P3-4).
        const frame: SessionActivityFrame = { kind: "append", event: cloneEvent(event) };
        this.safeCall(sub.callback, frame);
      }
    }
  }

  /** Invoke a subscriber callback, catching and discarding any thrown error. */
  private safeCall(callback: (frame: SessionActivityFrame) => void, frame: SessionActivityFrame): void {
    try {
      callback(frame);
    } catch {
      // Discard: one misbehaving subscriber must not break fanout.
    }
  }
}
