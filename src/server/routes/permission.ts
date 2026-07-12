/**
 * Permission response route — POST /api/tasks/:id/permission.
 *
 * Validates task/ask ownership, accepts `allow_once` or `deny` decisions with
 * a bounded non-empty `answeredBy` attribution, delegates to the dispatcher's
 * `respondPermission`, and returns the shared projected Task on success.
 *
 * 400: validation (missing fields, overlong answeredBy).
 * 404: task or ask not found.
 * 409: ask already resolved/claimed.
 * 422: provider does not support the requested action.
 * 502: provider reply failure (the reply to OpenCode's permission.reply API failed).
 */
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Dispatcher, RespondPermissionInput, TaskStore } from "../../shared";
import { TASK_ROUTE_PATTERNS } from "../../shared";
import { AdapterError } from "../../shared/errors";
import { projectPendingPermissions } from "../dto";

const MAX_ANSWERED_BY_LENGTH = 200;

export interface PermissionRouteDeps {
  store: TaskStore;
  dispatcher: Dispatcher;
}

export function registerPermissionRoutes(app: Hono, deps: PermissionRouteDeps): void {
  app.post(TASK_ROUTE_PATTERNS.permissionReply, async (c: Context) => {
    const taskId = c.req.param("id");
    if (!taskId) {
      return c.json(
        { error: { code: "validation", message: "Missing task id" } },
        400 as ContentfulStatusCode,
      );
    }

    try {
      const task = deps.store.get(taskId);
      if (!task) {
        return c.json(
          { error: { code: "permission_ask_not_found", message: `Task not found: ${taskId}` } },
          404 as ContentfulStatusCode,
        );
      }

      let body: Record<string, unknown>;
      try {
        body = (await c.req.json()) ?? {};
      } catch {
        throw AdapterError.validation("Request body must be valid JSON");
      }

      const { askId, action, answeredBy } = body;

      if (typeof askId !== "string" || askId.trim().length === 0) {
        throw AdapterError.validation("askId must be a non-empty string");
      }
      if (action !== "allow_once" && action !== "deny") {
        throw AdapterError.validation("action must be 'allow_once' or 'deny'");
      }
      if (typeof answeredBy !== "string" || answeredBy.trim().length === 0) {
        throw AdapterError.validation("answeredBy must be a non-empty string");
      }
      if (answeredBy.length > MAX_ANSWERED_BY_LENGTH) {
        throw AdapterError.validation(
          `answeredBy must be at most ${MAX_ANSWERED_BY_LENGTH} characters`,
        );
      }
      const cleanAnsweredBy = answeredBy.trim();

      const input: RespondPermissionInput = {
        askId: askId.trim(),
        action,
        answeredBy: cleanAnsweredBy,
      };

      const outcome = await deps.dispatcher.respondPermission(taskId, input);

      if (!outcome.ok) {
        // not-found means the ask doesn't exist or doesn't belong to this task.
        if (outcome.conflict === "not-found") {
          return c.json(
            {
              error: {
                code: "permission_ask_not_found",
                message: `Permission ask not found or does not belong to this task: ${outcome.askId}`,
              },
            },
            404 as ContentfulStatusCode,
          );
        }

        if (outcome.conflict === "unsupported-action") {
          return c.json(
            { error: { code: "permission_action_unsupported", message: outcome.error ?? `Permission action is unsupported: ${outcome.askId}` } },
            422 as ContentfulStatusCode,
          );
        }

        if (outcome.conflict === "stale") {
          return c.json(
            { error: { code: "permission_ask_stale", message: `Permission ask is stale: ${outcome.askId}` } },
            409 as ContentfulStatusCode,
          );
        }

        if (outcome.conflict === "reply-failed") {
          return c.json(
            {
              error: {
                code: "permission_reply_failed",
                message: `Permission reply failed: ${outcome.error ?? "unknown error"}`,
              },
            },
            502 as ContentfulStatusCode,
          );
        }

        // already-resolved (stale/claimed)
        return c.json(
          {
            error: {
              code: "permission_already_claimed",
              message: `Permission ask already resolved: ${outcome.askId}`,
            },
          },
          409 as ContentfulStatusCode,
        );
      }

      // Return the shared projected Task on success — the resolved ask is
      // removed from pendingPermissions by the dispatcher, so re-reading
      // the task and projecting gives the accurate post-resolution state.
      const fresh = deps.store.get(taskId);
      if (!fresh) throw AdapterError.notFound(`Task not found: ${taskId}`);
      const projected = projectPendingPermissions([fresh], deps.dispatcher)[0];
      return c.json(projected, 200);
    } catch (err) {
      return respondWithError(c, err);
    }
  });
}

function respondWithError(c: Context, err: unknown): Response {
  const adapterError = err instanceof AdapterError ? err : AdapterError.internal("Unexpected error", err);
  return c.json(adapterError.toEnvelope(), adapterError.status as ContentfulStatusCode);
}
