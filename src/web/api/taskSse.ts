/**
 * SSE connection to /api/tasks/events. Wraps EventSource (or an injectable
 * fake for tests), parses each message's `data` as a TaskFrame, and reports
 * connection status. Reconnection is handled natively by EventSource.
 */
import type { TaskFrame } from "../../shared";
import { buildTaskPath } from "../../shared";

/** Minimal EventSource surface we depend on — lets tests inject a fake. */
export interface EventSourceLike {
  onopen: ((ev: Event) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  close(): void;
}

export type TaskSseStatus = "connecting" | "open" | "closed";

export interface TaskSseHandlers {
  onFrame: (frame: TaskFrame) => void;
  onStatus: (status: TaskSseStatus) => void;
}

export interface TaskSseOptions {
  makeSource?: (url: string) => EventSourceLike;
}

function defaultMakeSource(url: string): EventSourceLike {
  return new EventSource(url) as unknown as EventSourceLike;
}

/**
 * Connects to the task SSE stream. Returns a disconnect function that closes
 * the underlying source and stops further callbacks.
 */
export function connectTaskSse(handlers: TaskSseHandlers, opts?: TaskSseOptions): () => void {
  const makeSource = opts?.makeSource ?? defaultMakeSource;
  const source = makeSource(buildTaskPath.events());
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
      const frame = JSON.parse(ev.data) as TaskFrame;
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
