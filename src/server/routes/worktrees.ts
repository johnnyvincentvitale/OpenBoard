import type { Hono } from "hono";
import type { Context } from "hono";
import type { Dispatcher } from "../../shared";
import { AdapterError } from "../../shared";

export function registerWorktreeRoutes(app: Hono, deps: { dispatcher: Dispatcher }): void {
  app.post("/api/worktrees/orphans/diff", async (c) => {
    const worktreePath = await readWorktreePath(c);
    return c.json(await deps.dispatcher.getOrphanWorktreeDiff(worktreePath));
  });

  app.post("/api/worktrees/orphans/resolve", async (c) => {
    const worktreePath = await readWorktreePath(c);
    const outcome = await deps.dispatcher.resolveOrphanWorktree(worktreePath);
    return c.json(outcome, outcome.ok ? 200 : 409);
  });
}

async function readWorktreePath(c: Context): Promise<string> {
  let body: { worktreePath?: unknown };
  try {
    body = await c.req.json();
  } catch {
    throw AdapterError.validation("Request body must be valid JSON");
  }
  if (typeof body.worktreePath !== "string" || !body.worktreePath.startsWith("/")) {
    throw AdapterError.validation("worktreePath must be an absolute path");
  }
  return body.worktreePath;
}
