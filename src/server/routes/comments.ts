import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { TaskStore } from "../../shared";
import { TASK_ROUTE_PATTERNS } from "../../shared";
import { AdapterError } from "../../shared/errors";

export function registerTaskCommentRoutes(app: Hono, deps: { store: TaskStore }): void {
  const { store } = deps;

  app.get(TASK_ROUTE_PATTERNS.comments, (c) => {
    const taskId = c.req.param("id");
    try {
      assertTask(store, taskId);
      return c.json(store.listComments(taskId), 200);
    } catch (err) {
      return respondWithError(c, err);
    }
  });

  app.post(TASK_ROUTE_PATTERNS.comments, async (c) => {
    const taskId = c.req.param("id");
    try {
      assertTask(store, taskId);
      let body: Record<string, unknown>;
      try {
        body = (await c.req.json()) ?? {};
      } catch {
        throw AdapterError.validation("Request body must be valid JSON");
      }

      const author = typeof body.author === "string" ? body.author.trim() : "";
      const commentBody = typeof body.body === "string" ? body.body.trim() : "";
      if (!author) throw AdapterError.validation("author must be a non-empty string");
      if (!commentBody) throw AdapterError.validation("body must be a non-empty string");

      const comment = store.addComment({ taskId, author, body: commentBody });
      store.addEvent({ taskId, type: "comment_added", body: { commentId: comment.id, author } });
      return c.json(comment, 201);
    } catch (err) {
      return respondWithError(c, err);
    }
  });
}

function assertTask(store: TaskStore, taskId: string): void {
  if (!store.get(taskId)) throw AdapterError.notFound(`Task not found: ${taskId}`);
}

function respondWithError(c: Context, err: unknown): Response {
  const adapterError = err instanceof AdapterError ? err : AdapterError.internal("Unexpected error", err);
  return c.json(adapterError.toEnvelope(), adapterError.status as ContentfulStatusCode);
}
