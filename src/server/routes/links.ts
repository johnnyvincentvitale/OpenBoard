import type { Hono } from "hono";
import type { AddTaskLinkBody, TaskStore } from "../../shared";
import { AdapterError } from "../../shared/errors";

export function registerTaskLinkRoutes(app: Hono, deps: { store: TaskStore }): void {
  const { store } = deps;

  app.post("/api/tasks/:id/links", async (c) => {
    const childId = c.req.param("id");
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
    store.addEvent({ taskId: childId, type: "task_linked", body: { parentId } });

    const updated = store.get(childId);
    if (!updated) throw AdapterError.notFound(`Task not found: ${childId}`);
    return c.json(updated, 200);
  });

  app.delete("/api/tasks/:id/links/:parentId", (c) => {
    const childId = c.req.param("id");
    const parentId = c.req.param("parentId");
    if (!store.get(childId)) throw AdapterError.notFound(`Task not found: ${childId}`);
    if (!store.get(parentId)) throw AdapterError.notFound(`Task not found: ${parentId}`);

    store.removeLink(parentId, childId);
    store.addEvent({ taskId: childId, type: "task_unlinked", body: { parentId } });
    const updated = store.get(childId);
    if (!updated) throw AdapterError.notFound(`Task not found: ${childId}`);
    return c.json(updated, 200);
  });
}

function validateLink(store: TaskStore, parentId: string, childId: string): void {
  if (!store.get(childId)) throw AdapterError.notFound(`Task not found: ${childId}`);
  if (!store.get(parentId)) throw AdapterError.notFound(`Task not found: ${parentId}`);
  if (parentId === childId) throw conflict("Task cannot depend on itself");
  if (store.getParentIds(childId).includes(parentId)) {
    throw conflict(`Task link already exists: ${parentId} -> ${childId}`);
  }
  if (isReachable(store, childId, parentId)) {
    throw conflict(`Task link would create a cycle: ${parentId} -> ${childId}`);
  }
}

/**
 * Checks whether `targetId` is reachable from `fromId` by following child
 * edges only. When adding `parent → child`, this detects whether `parent`
 * is already reachable from `child` through the existing dependency graph —
 * which would complete a cycle. Following parent edges is NOT done here
 * because that would create false positives: it traverses "upstream" through
 * unrelated dependency chains and would reject valid DAG configurations
 * like A→C and B→C then adding A→B.
 */
function isReachable(store: TaskStore, fromId: string, targetId: string): boolean {
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
