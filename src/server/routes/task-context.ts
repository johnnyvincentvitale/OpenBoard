/**
 * Task context route — GET /api/tasks/:id/context.
 *
 * Returns the full resolved task lineage: target task handoff (including
 * description), direct-parent handoffs, inherited-ancestor metadata, and
 * code-evidence candidates. Raw transcripts are excluded. No write
 * side-effects.
 *
 * Registered behind the board-token auth middleware.
 */
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { TaskStore } from "../../shared";
import { resolveTaskLineage } from "../task-lineage";

export interface TaskContextRouteDeps {
  store: TaskStore;
}

export function registerTaskContextRoutes(app: Hono, deps: TaskContextRouteDeps): void {
  app.get("/api/tasks/:id/context", async (c: Context) => {
    const taskId = c.req.param("id");
    if (!taskId) {
      return c.json(
        { error: { code: "bad_request", message: "Missing task id" } },
        400 as ContentfulStatusCode,
      );
    }

    const task = deps.store.get(taskId);
    if (!task) {
      return c.json(
        { error: { code: "not_found", message: `Task ${taskId} not found` } },
        404 as ContentfulStatusCode,
      );
    }

    const lineage = resolveTaskLineage(taskId, deps.store);
    if (!lineage) {
      return c.json(
        { error: { code: "internal", message: "Failed to resolve task lineage" } },
        500 as ContentfulStatusCode,
      );
    }

    // Build the response body: structured lineage minus raw transcripts.
    const body = {
      taskId: lineage.task.taskId,
      title: lineage.task.title,
      description: lineage.task.description,
      taskKind: lineage.task.taskKind,
      column: lineage.task.column,
      completion: lineage.task.completion,
      completionSource: task.completionSource ?? null,
      completionLocation: task.completionLocation ?? null,
      outcome: lineage.task.completion?.outcome ?? null,
      changedFiles: lineage.task.changedFiles,
      verification: lineage.task.verification,
      residualRisk: lineage.task.residualRisk,
      hasStructuredHandoff: lineage.task.hasStructuredHandoff,
      directParents: lineage.directParents,
      inheritedParents: lineage.inheritedParents,
      codeAncestors: lineage.codeAncestors,
      // Consumers must not assume the lineage is exhaustive when this is
      // true — a depth/count/via-parent bound omitted ancestors.
      truncated: lineage.truncated ?? false,
    };

    return c.json(body, 200);
  });
}
