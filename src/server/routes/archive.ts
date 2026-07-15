import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { mapTaskToDto } from "../dto";
import type { TaskStore } from "../../shared";
import { AdapterError } from "../../shared";
import type { GlobalArchiveStore, SourceInstanceInfo } from "../../db/global-archive-store";
import { computeDiff } from "../diff-engine";

const ARCHIVEABLE_COLUMNS = new Set(["review", "done"]);

export interface ArchiveRouteDeps {
  store: TaskStore;
  globalArchiveStore: GlobalArchiveStore;
  sourceInstance: SourceInstanceInfo;
  archiveDiffSnapshot?: typeof computeArchiveDiffSnapshot;
}

export function registerArchiveRoutes(app: Hono, deps: ArchiveRouteDeps): void {
  const {
    store,
    globalArchiveStore,
    sourceInstance,
    archiveDiffSnapshot = computeArchiveDiffSnapshot,
  } = deps;

  app.get("/api/archive", (c) => {
    try {
      return c.json(globalArchiveStore.listAll(), 200);
    } catch (err) {
      return respondWithError(c, err);
    }
  });

  app.post("/api/tasks/:id/archive", async (c) => {
    try {
      const id = c.req.param("id");
      const task = store.get(id);
      if (!task) throw AdapterError.notFound(`Task not found: ${id}`);
      if (!isArchiveEligible(task)) {
        return c.json(
          AdapterError.validation("Only non-running review or done tasks can be archived").toEnvelope(),
          409,
        );
      }
      // Gather every fallible async input before hiding the local card. The
      // local flag, mirror write, and any rollback below are then synchronous,
      // so another request cannot observe or interleave a half-archive.
      const diffSnapshot = await archiveDiffSnapshot(task);
      const current = store.get(id);
      if (!current) throw AdapterError.notFound(`Task not found: ${id}`);
      if (!isArchiveEligible(current) || !sameArchiveCandidate(task, current)) {
        return c.json(
          AdapterError.validation("Task changed while preparing the archive; retry after the current run finishes").toEnvelope(),
          409,
        );
      }
      const comments = store.listComments(id);
      const wasArchived = current.archived === true;
      const updated = store.setArchived(id, true);
      if (!updated) throw AdapterError.notFound(`Task not found: ${id}`);
      try {
        globalArchiveStore.mirrorTask(updated, sourceInstance, Date.now(), comments, diffSnapshot);
      } catch (err) {
        try {
          const rolledBack = store.setArchived(id, wasArchived);
          if (!rolledBack) throw new Error(`Task disappeared during archive rollback: ${id}`);
        } catch (rollbackError) {
          throw AdapterError.internal(
            "Global archive mirror failed and the local archive rollback also failed",
            { mirrorError: err, rollbackError },
          );
        }
        throw AdapterError.internal("Failed to mirror task to the global archive; local archive was rolled back", err);
      }

      return c.json(mapTaskToDto(updated), 200);
    } catch (err) {
      return respondWithError(c, err);
    }
  });

  app.post("/api/tasks/:id/unarchive", (c) => {
    try {
      const id = c.req.param("id");
      const task = store.get(id);
      if (!task) throw AdapterError.notFound(`Task not found: ${id}`);
      const updated = store.setArchived(id, false);
      if (!updated) throw AdapterError.notFound(`Task not found: ${id}`);
      return c.json(mapTaskToDto(updated), 200);
    } catch (err) {
      return respondWithError(c, err);
    }
  });
}

function isArchiveEligible(task: Parameters<typeof computeDiff>[0]): boolean {
  return ARCHIVEABLE_COLUMNS.has(task.column) && task.runState !== "running";
}

function sameArchiveCandidate(
  before: Parameters<typeof computeDiff>[0],
  after: Parameters<typeof computeDiff>[0],
): boolean {
  return before.updatedAt === after.updatedAt &&
    before.column === after.column &&
    before.runState === after.runState &&
    before.runStartedAt === after.runStartedAt &&
    before.sessionId === after.sessionId &&
    before.harnessSessionId === after.harnessSessionId &&
    before.harnessSessionName === after.harnessSessionName &&
    before.archived === after.archived &&
    before.pending === after.pending &&
    before.completionSource === after.completionSource &&
    before.completion?.reportedAt === after.completion?.reportedAt &&
    before.worktreePath === after.worktreePath &&
    before.baseCommit === after.baseCommit;
}

async function computeArchiveDiffSnapshot(task: Parameters<typeof computeDiff>[0]): Promise<Awaited<ReturnType<typeof computeDiff>>> {
  try {
    return await computeDiff(task);
  } catch (error) {
    return {
      kind: "no-git",
      reason: `Archive-time task_diff failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function respondWithError(c: Context, err: unknown): Response {
  const adapterError = toAdapterError(err);
  return c.json(adapterError.toEnvelope(), adapterError.status as ContentfulStatusCode);
}

function toAdapterError(err: unknown): AdapterError {
  if (err instanceof AdapterError) return err;
  return AdapterError.internal("Unexpected error", err);
}
