/**
 * Task REST routes — CRUD + run/retry/abort/move for the task-board Push
 * model. Distinct from the session-board card routes: tasks are specs that
 * a Dispatcher turns into OpenCode sessions.
 */
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { TASK_ROUTE_PATTERNS, TASK_ISOLATION_MODES, USER_COMPLETED_BY, isColumn } from "../../shared";
import type { CreateTaskInput, Dispatcher, ModelRef, RosterAgent, TaskIsolationMode, TaskStore } from "../../shared";
import { AdapterError } from "../../shared/errors";
import { ArchivedTaskActionError, DependencyGateError } from "../dispatcher";
import { isExternalDirectoriesAllowed, resolveBoardWorkspace, resolveTaskDirectory } from "../workspace";

type TaskListStore = TaskStore & {
  list(filter?: { archived?: "exclude" | "only" | "all" }): ReturnType<TaskStore["list"]>;
};

interface AgentRosterDep {
  fetch: () => Promise<RosterAgent[]>;
}

function isIsolationMode(value: unknown): value is TaskIsolationMode {
  return typeof value === "string" && (TASK_ISOLATION_MODES as readonly string[]).includes(value);
}

interface RetryTaskBody {
  feedback?: unknown;
}

/**
 * Registers the /api/tasks REST routes (create, list, run, retry, abort,
 * move, remove) on the given Hono app.
 */
export function registerTaskRoutes(
  app: Hono,
  deps: { store: TaskListStore; dispatcher: Dispatcher; agentRoster?: AgentRosterDep },
): void {
  const { store, dispatcher } = deps;
  const agentRoster = deps.agentRoster ?? { fetch: async () => [] as RosterAgent[] };

  async function resolveModel(agent: unknown, explicitModel: unknown): Promise<ModelRef | undefined> {
    if (explicitModel !== undefined) {
      return validateExplicitModel(explicitModel);
    }
    if (typeof agent !== "string") return undefined;

    const roster = await agentRoster.fetch();
    const matched = roster.find((a) => a.id === agent);
    if (!matched) {
      throw AdapterError.validation(`Unknown agent: ${agent}`);
    }
    if (!matched.model) {
      throw AdapterError.validation(`Agent ${agent} has no configured model`);
    }
    return matched.model;
  }

  app.post(TASK_ROUTE_PATTERNS.create, async (c) => {
    try {
      let body: Partial<CreateTaskInput>;
      try {
        body = await c.req.json();
      } catch {
        throw AdapterError.validation("Request body must be valid JSON");
      }

      const { title, description, directory, agent, model, isolation } = body;

      if (typeof title !== "string" || title.trim().length === 0) {
        throw AdapterError.validation("title must be a non-empty string");
      }
      if (typeof directory !== "string" || directory.trim().length === 0) {
        throw AdapterError.validation("directory must be a non-empty string");
      }
      if (isolation !== undefined && !isIsolationMode(isolation)) {
        throw AdapterError.validation("isolation must be 'worktree' or 'in-place'");
      }

      const workspace = resolveBoardWorkspace();
      const allowExternal = isExternalDirectoriesAllowed();
      const canonicalDirectory = resolveTaskDirectory(directory, workspace, {
        allowExternal,
      });

      const resolvedModel = await resolveModel(agent, model);

      const task = store.create({
        title,
        description: typeof description === "string" ? description : "",
        directory: canonicalDirectory,
        ...(typeof agent === "string" ? { agent } : {}),
        ...(resolvedModel ? { model: resolvedModel } : {}),
        ...(isIsolationMode(isolation) ? { isolation } : {}),
      });

      return c.json(task, 201);
    } catch (err) {
      return respondWithError(c, err);
    }
  });

  app.get(TASK_ROUTE_PATTERNS.list, (c) => {
    try {
      const archived = c.req.query("archived");
      if (archived !== undefined && archived !== "false" && archived !== "true" && archived !== "all") {
        throw AdapterError.validation("archived must be 'true', 'false', or 'all'");
      }
      const tasks = store.list({
        archived: archived === "true" ? "only" : archived === "all" ? "all" : "exclude",
      });
      return c.json(tasks, 200);
    } catch (err) {
      return respondWithError(c, err);
    }
  });

  app.post(TASK_ROUTE_PATTERNS.run, async (c) => {
    const id = c.req.param("id");

    try {
      assertRunnableActiveTask(store, id, "run");
      const task = await dispatcher.run(id);
      return c.json(task, 202);
    } catch (err) {
      return respondWithError(c, err);
    }
  });

  app.post(TASK_ROUTE_PATTERNS.retry, async (c) => {
    const id = c.req.param("id");

    try {
      assertRunnableActiveTask(store, id, "retry");
      let body: RetryTaskBody = {};
      try {
        body = (await c.req.json()) ?? {};
      } catch {
        // Retry accepts an empty/missing body — feedback is optional.
        body = {};
      }

      const feedback = typeof body.feedback === "string" ? body.feedback : undefined;

      const task = await dispatcher.retry(id, feedback);
      return c.json(task, 202);
    } catch (err) {
      return respondWithError(c, err);
    }
  });

  app.post(TASK_ROUTE_PATTERNS.abort, async (c) => {
    const id = c.req.param("id");

    try {
      await dispatcher.abort(id);
      const task = store.get(id);
      if (!task) {
        throw AdapterError.notFound(`Task not found: ${id}`);
      }
      return c.json(task, 200);
    } catch (err) {
      return respondWithError(c, err);
    }
  });

  app.post(TASK_ROUTE_PATTERNS.move, async (c) => {
    const id = c.req.param("id");

    try {
      let body: Record<string, unknown>;
      try {
        body = (await c.req.json()) ?? {};
      } catch {
        throw AdapterError.validation("Request body must be valid JSON");
      }

      const { column, position, completedBy } = body;

      if (!isColumn(column)) {
        throw AdapterError.validation(`Invalid column: ${String(column)}`);
      }
      if (typeof position !== "number" || !Number.isFinite(position)) {
        throw AdapterError.validation("position must be a finite number");
      }
      if (completedBy !== undefined && completedBy !== null && typeof completedBy !== "string") {
        throw AdapterError.validation("completedBy must be a string or null");
      }

      store.move(id, column, position);

      const nextCompletedBy: string | null =
        completedBy !== undefined ? (completedBy as string | null) : column === "done" ? USER_COMPLETED_BY : null;

      store.update(id, { completedBy: nextCompletedBy });

      const tasks = store.list();
      return c.json(tasks, 200);
    } catch (err) {
      return respondWithError(c, err);
    }
  });

  app.delete(TASK_ROUTE_PATTERNS.remove, (c) => {
    const id = c.req.param("id");

    try {
      store.remove(id);
      return c.json({ ok: true }, 200);
    } catch (err) {
      return respondWithError(c, err);
    }
  });

  // Answer the "make this directory a git repo?" prompt: init + commit, then run.
  app.post(TASK_ROUTE_PATTERNS.initGit, async (c) => {
    const id = c.req.param("id");
    try {
      const task = await dispatcher.initGitAndRun(id);
      return c.json(task, 202);
    } catch (err) {
      return respondWithError(c, err);
    }
  });

  // Merge the upstream base branch into the task's worktree branch.
  app.post(TASK_ROUTE_PATTERNS.sync, async (c) => {
    const id = c.req.param("id");
    try {
      const outcome = await dispatcher.syncUpstream(id);
      return c.json(outcome, outcome.ok ? 200 : 409);
    } catch (err) {
      return respondWithError(c, err);
    }
  });

  // Merge the worktree branch into the target (base) branch, remove the worktree, keep the branch.
  app.post(TASK_ROUTE_PATTERNS.integrate, async (c) => {
    const id = c.req.param("id");
    try {
      let target: string | undefined;
      try {
        const body = (await c.req.json()) as { targetBranch?: unknown };
        if (typeof body?.targetBranch === "string") target = body.targetBranch;
      } catch {
        // Body optional — integrate falls back to the task's recorded base branch.
      }
      const outcome = await dispatcher.integrate(id, target);
      return c.json(outcome, outcome.ok ? 200 : 409);
    } catch (err) {
      return respondWithError(c, err);
    }
  });

  app.get(TASK_ROUTE_PATTERNS.settings, (c) => {
    try {
      return c.json(store.getSettings(), 200);
    } catch (err) {
      return respondWithError(c, err);
    }
  });

  app.put(TASK_ROUTE_PATTERNS.settings, async (c) => {
    try {
      let body: { worktreeDefault?: unknown };
      try {
        body = await c.req.json();
      } catch {
        throw AdapterError.validation("Request body must be valid JSON");
      }
      if (typeof body.worktreeDefault !== "boolean") {
        throw AdapterError.validation("worktreeDefault must be a boolean");
      }
      const settings = store.updateSettings({ worktreeDefault: body.worktreeDefault });
      return c.json(settings, 200);
    } catch (err) {
      return respondWithError(c, err);
    }
  });
}

function validateExplicitModel(value: unknown): ModelRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw AdapterError.validation("model must be an object with providerID and id strings");
  }

  const candidate = value as { providerID?: unknown; id?: unknown; variant?: unknown };
  if (typeof candidate.providerID !== "string" || candidate.providerID.trim().length === 0) {
    throw AdapterError.validation("model.providerID must be a non-empty string");
  }
  if (typeof candidate.id !== "string" || candidate.id.trim().length === 0) {
    throw AdapterError.validation("model.id must be a non-empty string");
  }
  if (candidate.variant !== undefined && typeof candidate.variant !== "string") {
    throw AdapterError.validation("model.variant must be a string when provided");
  }

  return value as ModelRef;
}

function assertRunnableActiveTask(store: TaskStore, id: string, action: "run" | "retry"): void {
  const task = store.get(id);
  if (!task) throw AdapterError.notFound(`Task not found: ${id}`);
  if (task.archived) throw new ArchivedTaskActionError(action);
}

/** Translate a thrown value into the AdapterError JSON envelope + status. */
function respondWithError(c: Context, err: unknown): Response {
  if (err instanceof DependencyGateError) {
    return c.json(
      {
        error: {
          code: "validation",
          message: err.message,
          unmetParents: err.unmetParents,
        },
      },
      err.status as ContentfulStatusCode,
    );
  }
  const adapterError = toAdapterError(err);
  return c.json(adapterError.toEnvelope(), adapterError.status as ContentfulStatusCode);
}

/** Normalize any thrown value into an AdapterError, wrapping unexpected errors as internal. */
function toAdapterError(err: unknown): AdapterError {
  if (err instanceof AdapterError) return err;
  return AdapterError.internal("Unexpected error", err);
}
