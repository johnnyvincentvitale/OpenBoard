/**
 * SSE connection to /api/board/events. Wraps EventSource (or an injectable
 * fake for tests), parses each message's `data` as a BoardFrame, and reports
 * connection status. Reconnection is handled natively by EventSource.
 */
import type { BoardFrame } from "../../shared";
import { buildPath } from "../../shared";

/** Minimal EventSource surface we depend on — lets tests inject a fake. */
export interface EventSourceLike {
  onopen: ((ev: Event) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  close(): void;
}

export type BoardSseStatus = "connecting" | "open" | "closed";

export interface BoardSseHandlers {
  onFrame: (frame: BoardFrame) => void;
  onStatus: (status: BoardSseStatus) => void;
}

export interface BoardSseOptions {
  makeSource?: (url: string) => EventSourceLike;
}

function defaultMakeSource(url: string): EventSourceLike {
  return new EventSource(url) as unknown as EventSourceLike;
}

/**
 * Connects to the board SSE stream. Returns a disconnect function that closes
 * the underlying source and stops further callbacks.
 */
export function connectBoardSse(handlers: BoardSseHandlers, opts?: BoardSseOptions): () => void {
  const makeSource = opts?.makeSource ?? defaultMakeSource;
  const source = makeSource(buildPath.boardEvents());
  let disconnected = false;

  handlers.onStatus("connecting");

  source.onopen = () => {
    if (disconnected) return;
    handlers.onStatus("open");
  };

  source.onerror = () => {
    if (disconnected) return;
    // EventSource retries natively; surface the interim state as connecting
    // unless we've been explicitly closed.
    handlers.onStatus("connecting");
  };

  source.onmessage = (ev: MessageEvent) => {
    if (disconnected) return;
    try {
      const frame = JSON.parse(ev.data) as BoardFrame;
      handlers.onFrame(frame);
    } catch {
      // Ignore malformed frames.
    }
  };

  return () => {
    if (disconnected) return;
    disconnected = true;
    source.close();
    handlers.onStatus("closed");
  };
}
