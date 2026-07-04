/**
 * GET /api/tasks/events — the task board's live SSE feed. Polls the store
 * (task changes come from both the REST API and the dispatcher, so a
 * poll-and-diff loop is intentional rather than an in-process event bus)
 * and pushes a fresh snapshot frame whenever the serialized task list
 * changes, plus periodic heartbeats to keep the connection alive.
 */
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { TaskFrame, TaskStore } from "../../shared";
import { TASK_ROUTE_PATTERNS } from "../../shared";

const POLL_INTERVAL_MS = 800;
const HEARTBEAT_AFTER_UNCHANGED = 15; // ~15 * 800ms ≈ 12s of no changes before a heartbeat

export interface TaskEventsRouteDeps {
  store: TaskStore;
}

export function registerTaskEventsRoutes(app: Hono, deps: TaskEventsRouteDeps): void {
  const { store } = deps;

  app.get(TASK_ROUTE_PATTERNS.events, (c) => {
    return streamSSE(c, async (stream) => {
      let closed = false;
      stream.onAbort(() => {
        closed = true;
      });

      let seq = 0;
      const writeFrame = async (frame: TaskFrame): Promise<void> => {
        if (closed || stream.aborted) return;
        await stream.writeSSE({
          data: JSON.stringify(frame),
          id: String(frame.seq),
        });
      };

      // 1. Snapshot frame, always sent first so a fresh client has full state.
      let lastSerialized = JSON.stringify(store.list());
      await writeFrame({ kind: "snapshot", seq, tasks: store.list() });

      // 2. Poll the store; emit a fresh snapshot (with incremented seq)
      // whenever the serialized task list changes, else a heartbeat once
      // we've gone quiet for a while.
      let unchangedCount = 0;
      while (!closed && !stream.aborted) {
        await stream.sleep(POLL_INTERVAL_MS);
        if (closed || stream.aborted) break;

        const tasks = store.list();
        const serialized = JSON.stringify(tasks);

        if (serialized !== lastSerialized) {
          lastSerialized = serialized;
          unchangedCount = 0;
          seq += 1;
          await writeFrame({ kind: "snapshot", seq, tasks });
        } else {
          unchangedCount += 1;
          if (unchangedCount >= HEARTBEAT_AFTER_UNCHANGED) {
            unchangedCount = 0;
            seq += 1;
            await writeFrame({ kind: "heartbeat", seq });
          }
        }
      }
    });
  });
}
