import type { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Dispatcher } from "../../shared";
import { AdapterError } from "../../shared";

export function registerWorktreeRoutes(app: Hono, deps: { dispatcher: Dispatcher }): void {
  app.post("/api/worktrees/orphans/diff", async (c) => {
    try {
      const worktreePath = await readWorktreePath(c);
      return c.json(await deps.dispatcher.getOrphanWorktreeDiff(worktreePath));
    } catch (err) {
      return respondWithError(c, err);
    }
  });

  app.post("/api/worktrees/orphans/resolve", async (c) => {
    try {
      const worktreePath = await readWorktreePath(c);
      const outcome = await deps.dispatcher.resolveOrphanWorktree(worktreePath);
      return c.json(outcome, outcome.ok ? 200 : 409);
    } catch (err) {
      return respondWithError(c, err);
    }
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

function respondWithError(c: Context, err: unknown): Response {
  const ae =
    err instanceof AdapterError
      ? err
      : AdapterError.internal(err instanceof Error ? err.message : "Unexpected error", err);
  return c.json(ae.toEnvelope(), ae.status as ContentfulStatusCode);
}
