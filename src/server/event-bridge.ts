/**
 * Live event bridge — consumes the OpenCode global `/event` SSE stream,
 * classifies each frame via `classifyEvent`, reconciles it against the
 * board's merge service (`buildCardForSession` / `buildBoardSnapshot`), and
 * republishes board-shaped `BoardFrame`s to any number of subscribers
 * (typically the `/api/board/events` SSE route).
 *
 * Owns:
 * - a monotonic `seq` counter stamped on every emitted frame
 * - a ring buffer of the last N frames for replay-on-reconnect
 * - auto-reconnect with backoff around the upstream OpenCode event stream
 */
import type { Card, ColumnStore, OpencodeEvent, BoardFrame } from "../shared";
import { classifyEvent } from "./events/reducer";
import { buildBoardSnapshot, buildCardForSession, type OpencodeClientLike } from "./board-service";

export type BoardFrameListener = (frame: BoardFrame) => void;

/** Unsubscribe handle returned by `subscribe()`. Call to stop receiving live frames. */
export type Unsubscribe = () => void;

export interface EventBridgeDeps {
  client: OpencodeClientLike;
  store: ColumnStore;
  /** Ring buffer capacity for replay. Defaults to 256. */
  ringSize?: number;
}

const DEFAULT_RING_SIZE = 256;

/** Base/backoff tuning for reconnecting to the upstream OpenCode event stream. */
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 15000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Consumes `client.event.subscribe()`, turns raw OpenCode events into
 * `BoardFrame`s, and fans them out to subscribers while maintaining a replay
 * ring buffer keyed by monotonic `seq`.
 */
export class EventBridge {
  private readonly client: OpencodeClientLike;
  private readonly store: ColumnStore;
  private readonly ringSize: number;

  private readonly listeners = new Set<BoardFrameListener>();
  private readonly ring: BoardFrame[] = [];
  private seq = 0;

  private running = false;
  /** Bumped on every stop()/restart so a stale consume loop knows to exit. */
  private generation = 0;
  private consumeLoopPromise: Promise<void> | null = null;

  constructor(deps: EventBridgeDeps) {
    this.client = deps.client;
    this.store = deps.store;
    this.ringSize = deps.ringSize ?? DEFAULT_RING_SIZE;
  }

  /**
   * Begin consuming `client.event.subscribe()`. Safe to call once; a second
   * call while already running is a no-op. Auto-reconnects with backoff if
   * the upstream stream ends or errors, until `stop()` is called.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    const myGeneration = ++this.generation;
    this.consumeLoopPromise = this.runConsumeLoop(myGeneration);
  }

  /** Stop consuming the upstream event stream. Idempotent. */
  stop(): void {
    this.running = false;
    this.generation++;
  }

  /**
   * Register a listener for live frames, first replaying any buffered
   * frames with `seq > fromSeq` (if provided and still within the ring).
   * Returns an unsubscribe function.
   */
  subscribe(fromSeq?: number, listener?: BoardFrameListener): Unsubscribe {
    if (!listener) {
      throw new Error("EventBridge.subscribe requires a listener callback");
    }

    if (fromSeq !== undefined) {
      for (const frame of this.ring) {
        if (frame.seq > fromSeq) {
          listener(frame);
        }
      }
    }

    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Builds a fresh full-board snapshot frame, stamped with the next seq. */
  async snapshotFrame(): Promise<BoardFrame> {
    const cards = await buildBoardSnapshot(this.client, this.store);
    return { kind: "snapshot", seq: this.nextSeq(), cards };
  }

  /**
   * The most recently stamped seq (0 if nothing has been emitted yet). Used
   * by consumers (e.g. the SSE route) to stamp out-of-band frames, such as
   * heartbeats, with a monotonically sane id without disturbing the replay
   * ring buffer.
   */
  currentSeq(): number {
    return this.seq;
  }

  // ---- internals ----

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private emit(frame: BoardFrame): void {
    this.ring.push(frame);
    if (this.ring.length > this.ringSize) {
      this.ring.shift();
    }
    for (const listener of this.listeners) {
      listener(frame);
    }
  }

  private async handleEvent(event: OpencodeEvent): Promise<void> {
    const intent = classifyEvent(event);
    if (!intent) return;

    if (intent.kind === "deleted") {
      this.emit({ kind: "remove", seq: this.nextSeq(), sessionId: intent.sessionId });
      return;
    }

    // 'created' | 'updated' | 'live-state' all resolve to a fresh card fetch.
    const card: Card | null = await buildCardForSession(this.client, this.store, intent.sessionId);
    if (card === null) return;

    this.emit({ kind: "upsert", seq: this.nextSeq(), card });
  }

  /**
   * Owns the lifetime of one upstream subscription attempt + its retry loop.
   * Exits cleanly once `generation` no longer matches (i.e. `stop()` was
   * called, or a newer `start()` superseded this loop).
   */
  private async runConsumeLoop(generation: number): Promise<void> {
    let attempt = 0;

    while (this.running && this.generation === generation) {
      try {
        const result = await this.client.event.subscribe();
        attempt = 0; // reset backoff once a connection succeeds

        for await (const event of result.stream) {
          if (!this.running || this.generation !== generation) return;
          try {
            await this.handleEvent(event as OpencodeEvent);
          } catch {
            // A single bad event/card-build failure shouldn't kill the stream.
          }
        }
        // Stream ended normally (server closed it) — fall through to reconnect.
      } catch {
        // Stream errored — fall through to reconnect.
      }

      if (!this.running || this.generation !== generation) return;

      attempt += 1;
      const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1), RECONNECT_MAX_DELAY_MS);
      await sleep(delay);
    }
  }
}
