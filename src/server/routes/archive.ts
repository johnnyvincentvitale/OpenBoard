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
}

export function registerArchiveRoutes(app: Hono, deps: ArchiveRouteDeps): void {
  const { store, globalArchiveStore, sourceInstance } = deps;

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
      if (!ARCHIVEABLE_COLUMNS.has(task.column)) {
        return c.json(
          AdapterError.validation("Only review or done tasks can be archived").toEnvelope(),
          409,
        );
      }
      const updated = store.setArchived(id, true);
      if (!updated) throw AdapterError.notFound(`Task not found: ${id}`);
      const diffSnapshot = await archiveDiffSnapshot(updated);
      try {
        globalArchiveStore.mirrorTask(updated, sourceInstance, Date.now(), store.listComments(id), diffSnapshot);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("failed to mirror archived task to global archive", { taskId: id, err });
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

async function archiveDiffSnapshot(task: Parameters<typeof computeDiff>[0]): Promise<Awaited<ReturnType<typeof computeDiff>>> {
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
