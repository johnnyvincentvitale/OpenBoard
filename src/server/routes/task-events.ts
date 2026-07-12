/**
 * GET /api/tasks/events — the task board's live SSE feed. Polls the store
 * (task changes come from both the REST API and the dispatcher, so a
 * poll-and-diff loop is intentional rather than an in-process event bus)
 * and pushes a fresh snapshot frame whenever the serialized task list
 * changes, plus periodic heartbeats to keep the connection alive.
 *
 * Each snapshot frame runs the shared pendingPermissions projector so
 * broker-only changes (new ask, operator response, policy timeout) cause
 * the next SSE snapshot to carry updated permissions without a store
 * mutation.
 */
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { streamSSE } from "hono/streaming";
import type { Dispatcher, TaskFrame, TaskStore } from "../../shared";
import { TASK_ROUTE_PATTERNS } from "../../shared";
import { AdapterError } from "../../shared/errors";
import { projectPendingPermissions } from "../dto";

const POLL_INTERVAL_MS = 800;
const HEARTBEAT_AFTER_UNCHANGED = 15; // ~15 * 800ms ≈ 12s of no changes before a heartbeat

export interface TaskEventsRouteDeps {
  store: TaskStore;
  /** Optional dispatcher for pendingPermissions projection. */
  dispatcher?: Dispatcher;
}

export function registerTaskEventsRoutes(app: Hono, deps: TaskEventsRouteDeps): void {
  const { store, dispatcher } = deps;

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
      const initialTasks = projectPendingPermissions(store.list(), dispatcher);
      let lastSerialized = JSON.stringify(initialTasks);
      await writeFrame({ kind: "snapshot", seq, tasks: initialTasks });

      // 2. Poll the store; emit a fresh snapshot (with incremented seq)
      // whenever the serialized task list changes, else a heartbeat once
      // we've gone quiet for a while.
      let unchangedCount = 0;
      while (!closed && !stream.aborted) {
        await stream.sleep(POLL_INTERVAL_MS);
        if (closed || stream.aborted) break;

        const tasks = projectPendingPermissions(store.list(), dispatcher);
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

  app.get(TASK_ROUTE_PATTERNS.taskEvents, (c) => {
    const taskId = c.req.param("id");
    try {
      if (!store.get(taskId)) throw AdapterError.notFound(`Task not found: ${taskId}`);
      return c.json(store.listEvents(taskId), 200);
    } catch (err) {
      return respondWithError(c, err);
    }
  });

  app.get(TASK_ROUTE_PATTERNS.taskCausality, (c) => {
    try {
      const causality: Record<string, { autoDispatchedBy: string }> = {};
      for (const task of store.list()) {
        const latest = store.listEvents(task.id)
          .filter((event) => event.type === "task_auto_dispatched")
          .at(-1);
        const parentId = latest?.body?.parentId;
        if (typeof parentId === "string" && parentId.trim()) {
          causality[task.id] = { autoDispatchedBy: parentId };
        }
      }
      return c.json(causality, 200);
    } catch (err) {
      return respondWithError(c, err);
    }
  });
}

function respondWithError(c: Context, err: unknown): Response {
  const adapterError = err instanceof AdapterError ? err : AdapterError.internal("Unexpected error", err);
  return c.json(adapterError.toEnvelope(), adapterError.status as ContentfulStatusCode);
}
