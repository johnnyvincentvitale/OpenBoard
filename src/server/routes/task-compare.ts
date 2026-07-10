/**
 * GET /api/tasks/:targetId/compare?baseTaskId=:baseTaskId
 *
 * Read-only comparison of two cards' durable code evidence. Dispatched via
 * this module rather than app.ts so it can be wired into the server, MCP, and
 * TUI independently without touching the integration surface.
 */
import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { TaskStore } from "../../shared";
import { AdapterError } from "../../shared/errors";
import { compareTaskEvidence } from "../task-compare";

export function registerTaskCompareRoutes(app: Hono, deps: { store: TaskStore }): void {
  // The shared route pattern includes the query string as a URL template;
  // Hono matches the path part only. Use the literal path here so TypeScript
  // can infer the route parameter name.
  app.get("/api/tasks/:targetId/compare", async (c) => {
    try {
      const targetId = c.req.param("targetId");
      const baseTaskId = c.req.query("baseTaskId")?.trim();

      if (!baseTaskId) {
        throw AdapterError.validation("baseTaskId query parameter is required");
      }
      if (baseTaskId === targetId) {
        throw AdapterError.validation("baseTaskId cannot be the same as targetId");
      }

      const targetTask = deps.store.get(targetId);
      if (!targetTask) throw AdapterError.notFound(`Task not found: ${targetId}`);

      const baseTask = deps.store.get(baseTaskId);
      if (!baseTask) throw AdapterError.notFound(`Base task not found: ${baseTaskId}`);

      const result = await compareTaskEvidence(baseTask, targetTask);
      return c.json(result, 200);
    } catch (err) {
      const ae = err instanceof AdapterError
        ? err
        : AdapterError.internal(err instanceof Error ? err.message : "Unexpected error", err);
      return c.json(ae.toEnvelope(), ae.status as ContentfulStatusCode);
    }
  });
}
