/**
 * Task REST routes — CRUD + run/retry/abort/move for the task-board Push
 * model. Distinct from the session-board card routes: tasks are specs that
 * a Dispatcher turns into OpenCode sessions.
 */
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { TASK_ROUTE_PATTERNS, isColumn } from "../../shared";
import type { CreateTaskInput, Dispatcher, TaskStore } from "../../shared";
import { AdapterError } from "../../shared/errors";

interface MoveTaskBody {
  column?: unknown;
  position?: unknown;
}

interface RetryTaskBody {
  feedback?: unknown;
}

/**
 * Registers the /api/tasks REST routes (create, list, run, retry, abort,
 * move, remove) on the given Hono app.
 */
export function registerTaskRoutes(
  app: Hono,
  deps: { store: TaskStore; dispatcher: Dispatcher },
): void {
  const { store, dispatcher } = deps;

  app.post(TASK_ROUTE_PATTERNS.create, async (c) => {
    try {
      let body: Partial<CreateTaskInput>;
      try {
        body = await c.req.json();
      } catch {
        throw AdapterError.validation("Request body must be valid JSON");
      }

      const { title, description, directory } = body;

      if (typeof title !== "string" || title.trim().length === 0) {
        throw AdapterError.validation("title must be a non-empty string");
      }
      if (typeof directory !== "string" || directory.trim().length === 0) {
        throw AdapterError.validation("directory must be a non-empty string");
      }

      const task = store.create({
        title,
        description: typeof description === "string" ? description : "",
        directory,
      });

      return c.json(task, 201);
    } catch (err) {
      return respondWithError(c, err);
    }
  });

  app.get(TASK_ROUTE_PATTERNS.list, (c) => {
    try {
      const tasks = store.list();
      return c.json(tasks, 200);
    } catch (err) {
      return respondWithError(c, err);
    }
  });

  app.post(TASK_ROUTE_PATTERNS.run, async (c) => {
    const id = c.req.param("id");

    try {
      const task = await dispatcher.run(id);
      return c.json(task, 202);
    } catch (err) {
      return respondWithError(c, err);
    }
  });

  app.post(TASK_ROUTE_PATTERNS.retry, async (c) => {
    const id = c.req.param("id");

    try {
      let body: RetryTaskBody = {};
      try {
        body = (await c.req.json()) ?? {};
      } catch {
        // Retry accepts an empty/missing body — feedback is optional.
        body = {};
      }

      const feedback = typeof body.feedback === "string" ? body.feedback : undefined;

      const task = await dispatcher.retry(id, feedback);
      return c.json(task, 202);
    } catch (err) {
      return respondWithError(c, err);
    }
  });

  app.post(TASK_ROUTE_PATTERNS.abort, async (c) => {
    const id = c.req.param("id");

    try {
      await dispatcher.abort(id);
      return c.json({ ok: true }, 200);
    } catch (err) {
      return respondWithError(c, err);
    }
  });

  app.post(TASK_ROUTE_PATTERNS.move, async (c) => {
    const id = c.req.param("id");

    try {
      let body: MoveTaskBody;
      try {
        body = await c.req.json();
      } catch {
        throw AdapterError.validation("Request body must be valid JSON");
      }

      const { column, position } = body;

      if (!isColumn(column)) {
        throw AdapterError.validation(`Invalid column: ${String(column)}`);
      }
      if (typeof position !== "number" || !Number.isFinite(position)) {
        throw AdapterError.validation("position must be a finite number");
      }

      store.move(id, column, position);

      const tasks = store.list();
      return c.json(tasks, 200);
    } catch (err) {
      return respondWithError(c, err);
    }
  });

  app.delete(TASK_ROUTE_PATTERNS.remove, (c) => {
    const id = c.req.param("id");

    try {
      store.remove(id);
      return c.json({ ok: true }, 200);
    } catch (err) {
      return respondWithError(c, err);
    }
  });
}

/** Translate a thrown value into the AdapterError JSON envelope + status. */
function respondWithError(c: Context, err: unknown): Response {
  const adapterError = toAdapterError(err);
  return c.json(adapterError.toEnvelope(), adapterError.status as ContentfulStatusCode);
}

/** Normalize any thrown value into an AdapterError, wrapping unexpected errors as internal. */
function toAdapterError(err: unknown): AdapterError {
  if (err instanceof AdapterError) return err;
  return AdapterError.internal("Unexpected error", err);
}
