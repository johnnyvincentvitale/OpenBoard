/**
 * Harness-neutral live-session activity backend core (FR09).
 *
 * Collects normalized, redaction-safe session events into an in-memory
 * per-task bounded ring buffer, fans out frames to subscribers, and enforces
 * run-identity ordering so late events from a replaced run are rejected.
 *
 * Never persists or exposes raw tool inputs/outputs, native provider IDs,
 * secrets, or arbitrary metadata.
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

// ── Public types ──────────────────────────────────────────────────────────

export interface SessionActivityConfig {
  /** Maximum events per-task ring buffer. Default 1000. */
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
  run: SessionActivityRun;
  /** Ring buffer of events, newest at the end. */
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

// ── Collector ─────────────────────────────────────────────────────────────

export class SessionActivityCollector {
  private readonly maxEvents: number;
  private readonly clock: () => number;
  /** Per-task run state, keyed by taskId. */
  private readonly runs = new Map<string, RunState>();
  /** Active subscribers, each scoped to a taskId + cursor. */
  private readonly subscribers = new Set<SubscriberEntry>();

  constructor(config: SessionActivityConfig = {}) {
    this.maxEvents = config.maxEvents ?? 1000;
    this.clock = config.clock ?? (() => Date.now());
  }

  // ── Run lifecycle ────────────────────────────────────────────────────

  /** Start tracking a new run, discarding any previous run for the same taskId. */
  startRun(run: SessionActivityRun): void {
    this.runs.set(run.taskId, {
      run,
      events: [],
      oldestSeq: 0,
      nextSeq: 1,
      transport: "live",
      terminal: false,
    });
  }

  /**
   * Record a normalized event into the ring buffer for the given task+run.
   * Returns the assigned seq, or null if the run identity does not match
   * (stale/replaced run) or the run has already been terminated.
   */
  recordEvent(
    taskId: string,
    runStartedAt: number,
    input: SessionActivityEventInput,
  ): number | null {
    const runState = this.runs.get(taskId);
    if (!runState) return null;
    if (runState.run.runStartedAt !== runStartedAt) return null; // stale run
    if (runState.terminal) return null; // cannot record after terminal

    const seq = runState.nextSeq++;
    const event: SessionActivityEvent = {
      seq,
      taskId,
      runStartedAt,
      sessionId: input.sessionId,
      rootSessionId: input.rootSessionId,
      parentSessionId: input.parentSessionId,
      harness: input.harness,
      occurredAt: this.clock(),
      kind: input.kind,
      role: input.role,
      text: input.text,
      tool: input.tool,
    };

    // Ring buffer eviction: drop oldest when full.
    if (runState.events.length >= this.maxEvents) {
      runState.events.shift();
      runState.oldestSeq = runState.events[0]?.seq ?? 0;
    } else if (runState.events.length === 0) {
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
   * 2. A snapshot frame with all events after the cursor.
   * 3. A heartbeat frame with the current transport state.
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

    // If no run is active, just send a heartbeat with static transport.
    if (!runState) {
      callback({
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
      callback({
        kind: "gap",
        afterSeq: cursor,
        reason: `Events before seq ${runState.oldestSeq} have been evicted from the ring buffer`,
      });
    }

    // Snapshot: all events after cursor.
    const events = runState.events.filter((e) => e.seq > cursor);
    if (events.length > 0) {
      callback({
        kind: "snapshot",
        run: runState.run,
        events,
        lastEventAt: events[events.length - 1].occurredAt,
        transport: runState.transport,
      });
    }

    // Heartbeat with current transport.
    callback({
      kind: "heartbeat",
      lastEventAt: events.length > 0 ? events[events.length - 1].occurredAt : null,
      transport: runState.transport,
    });

    // If the run is already terminal, send the terminal frame.
    if (runState.terminal && runState.terminalStatus) {
      callback({
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

    const lastEvent = runState.events[runState.events.length - 1];
    const frame: SessionActivityFrame = {
      kind: "heartbeat",
      lastEventAt: lastEvent?.occurredAt ?? null,
      transport,
    };
    for (const sub of this.subscribers) {
      if (sub.taskId === taskId) {
        sub.callback(frame);
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
        sub.callback(frame);
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

  private fanoutAppend(taskId: string, event: SessionActivityEvent): void {
    const frame: SessionActivityFrame = { kind: "append", event };
    for (const sub of this.subscribers) {
      if (sub.taskId === taskId) {
        sub.callback(frame);
      }
    }
  }
}