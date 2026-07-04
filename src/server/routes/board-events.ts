/**
 * GET /api/board/events — the board's live SSE feed. Sends a full snapshot
 * frame first, then streams live frames from the EventBridge (honoring
 * `Last-Event-ID` / `?fromSeq` for replay-on-reconnect), plus periodic
 * heartbeat frames to keep the connection alive through proxies.
 */
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { BoardFrame } from "../../shared";
import { ROUTE_PATTERNS } from "../../shared";
import type { EventBridge } from "../event-bridge";

const HEARTBEAT_INTERVAL_MS = 15000;

export interface BoardEventsRouteDeps {
  bridge: EventBridge;
}

function parseFromSeq(lastEventIdHeader: string | undefined, fromSeqQuery: string | undefined): number | undefined {
  // Last-Event-ID (set automatically by EventSource on reconnect) takes
  // precedence over an explicit ?fromSeq query param.
  const raw = lastEventIdHeader ?? fromSeqQuery;
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function registerBoardEventsRoutes(app: Hono, deps: BoardEventsRouteDeps): void {
  const { bridge } = deps;

  app.get(ROUTE_PATTERNS.boardEvents, (c) => {
    const fromSeq = parseFromSeq(c.req.header("Last-Event-ID"), c.req.query("fromSeq"));

    return streamSSE(c, async (stream) => {
      let closed = false;
      stream.onAbort(() => {
        closed = true;
      });

      const writeFrame = async (frame: BoardFrame): Promise<void> => {
        if (closed || stream.aborted) return;
        await stream.writeSSE({
          data: JSON.stringify(frame),
          id: String(frame.seq),
        });
      };

      // 1. Snapshot frame, always sent first so a fresh client has full state.
      const snapshot = await bridge.snapshotFrame();
      await writeFrame(snapshot);

      // 2. Live frames, buffering anything emitted while we were building the
      // snapshot / haven't subscribed yet by queuing through a listener
      // registered immediately after.
      const pending: BoardFrame[] = [];
      let flushing = false;
      const flush = async () => {
        if (flushing) return;
        flushing = true;
        while (pending.length > 0) {
          const frame = pending.shift();
          if (frame) await writeFrame(frame);
        }
        flushing = false;
      };

      const unsubscribe = bridge.subscribe(fromSeq, (frame) => {
        pending.push(frame);
        void flush();
      });

      stream.onAbort(() => {
        unsubscribe();
      });

      // 3. Heartbeats so intermediary proxies/load balancers don't time out
      // an otherwise-idle connection.
      try {
        while (!closed && !stream.aborted) {
          await stream.sleep(HEARTBEAT_INTERVAL_MS);
          if (closed || stream.aborted) break;
          await writeFrame({ kind: "heartbeat", seq: bridge.currentSeq() });
        }
      } finally {
        unsubscribe();
      }
    });
  });
}
