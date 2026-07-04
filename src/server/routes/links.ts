import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AddTaskLinkBody, TaskStore } from "../../shared";
import { AdapterError } from "../../shared/errors";

export function registerTaskLinkRoutes(app: Hono, deps: { store: TaskStore }): void {
  const { store } = deps;

  app.post("/api/tasks/:id/links", async (c) => {
    const childId = c.req.param("id");
    try {
      let body: AddTaskLinkBody;
      try {
        body = await c.req.json();
      } catch {
        throw AdapterError.validation("Request body must be valid JSON");
      }

      if (typeof body.parentId !== "string" || body.parentId.trim().length === 0) {
        throw AdapterError.validation("parentId must be a non-empty string");
      }
      const parentId = body.parentId;

      validateLink(store, parentId, childId);
      store.addLink(parentId, childId);

      const updated = store.get(childId);
      if (!updated) throw AdapterError.notFound(`Task not found: ${childId}`);
      return c.json(updated, 200);
    } catch (err) {
      return respondWithError(c, err);
    }
  });

  app.delete("/api/tasks/:id/links/:parentId", (c) => {
    const childId = c.req.param("id");
    const parentId = c.req.param("parentId");
    try {
      if (!store.get(childId)) throw AdapterError.notFound(`Task not found: ${childId}`);
      if (!store.get(parentId)) throw AdapterError.notFound(`Task not found: ${parentId}`);

      store.removeLink(parentId, childId);
      const updated = store.get(childId);
      if (!updated) throw AdapterError.notFound(`Task not found: ${childId}`);
      return c.json(updated, 200);
    } catch (err) {
      return respondWithError(c, err);
    }
  });
}

function validateLink(store: TaskStore, parentId: string, childId: string): void {
  if (!store.get(childId)) throw AdapterError.notFound(`Task not found: ${childId}`);
  if (!store.get(parentId)) throw AdapterError.notFound(`Task not found: ${parentId}`);
  if (parentId === childId) throw conflict("Task cannot depend on itself");
  if (store.getParentIds(childId).includes(parentId)) {
    throw conflict(`Task link already exists: ${parentId} -> ${childId}`);
  }
  if (isReachableViaChildren(store, childId, parentId)) {
    throw conflict(`Task link would create a cycle: ${parentId} -> ${childId}`);
  }
}

function isReachableViaChildren(store: TaskStore, fromId: string, targetId: string): boolean {
  const visited = new Set<string>();
  const stack = [fromId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === targetId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const childId of store.getChildIds(current)) {
      stack.push(childId);
    }
  }
  return false;
}

function conflict(message: string): ResponseConflict {
  return new ResponseConflict(message);
}

class ResponseConflict extends Error {
  readonly status = 409;
  readonly code = "validation";
}

function respondWithError(c: Context, err: unknown): Response {
  if (err instanceof ResponseConflict) {
    return c.json(
      { error: { code: err.code, message: err.message } },
      err.status as ContentfulStatusCode,
    );
  }
  const adapterError = err instanceof AdapterError ? err : AdapterError.internal("Unexpected error", err);
  return c.json(adapterError.toEnvelope(), adapterError.status as ContentfulStatusCode);
}
