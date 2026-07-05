/**
 * Task REST routes — CRUD + run/retry/abort/move for the task-board Push
 * model. Distinct from the session-board card routes: tasks are specs that
 * a Dispatcher turns into OpenCode sessions.
 */
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { CLAUDE_CODE_MODEL_PROVIDER, CLAUDE_CODE_PERMISSION_MODES, TASK_ROUTE_PATTERNS, TASK_HARNESSES, TASK_ISOLATION_MODES, TASK_TYPES, USER_COMPLETED_BY, isColumn } from "../../shared";
import type { ClaudeCodePermissionMode, CreateTaskInput, Dispatcher, ModelRef, RosterAgent, TaskHarness, TaskIsolationMode, TaskStore, UpdateTaskInput } from "../../shared";
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

function isTaskType(value: unknown): value is CreateTaskInput["type"] {
  return typeof value === "string" && (TASK_TYPES as readonly string[]).includes(value);
}

function isTaskHarness(value: unknown): value is TaskHarness {
  return typeof value === "string" && (TASK_HARNESSES as readonly string[]).includes(value);
}

function isClaudePermissionMode(value: unknown): value is ClaudeCodePermissionMode {
  return typeof value === "string" && (CLAUDE_CODE_PERMISSION_MODES as readonly string[]).includes(value);
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

  function resolveClaudeModel(explicitModel: unknown): ModelRef | undefined {
    if (explicitModel === undefined) return undefined;
    const model = validateExplicitModel(explicitModel);
    if (model.providerID !== CLAUDE_CODE_MODEL_PROVIDER) {
      throw AdapterError.validation(`claude-code task model.providerID must be '${CLAUDE_CODE_MODEL_PROVIDER}'`);
    }
    if (model.variant !== undefined) {
      throw AdapterError.validation("claude-code task models cannot define variant");
    }
    return model;
  }

  app.post(TASK_ROUTE_PATTERNS.create, async (c) => {
    try {
      let body: Partial<CreateTaskInput>;
      try {
        body = await c.req.json();
      } catch {
        throw AdapterError.validation("Request body must be valid JSON");
      }

      const { title, description, directory, agent, model, isolation, assignedTo, claudePermissionMode } = body;
      const taskType = body.type ?? "agent";
      const harness = body.harness ?? "opencode";

      if (typeof title !== "string" || title.trim().length === 0) {
        throw AdapterError.validation("title must be a non-empty string");
      }
      if (!isTaskType(taskType)) {
        throw AdapterError.validation("type must be 'manual' or 'agent'");
      }
      if (!isTaskHarness(harness)) {
        throw AdapterError.validation("harness must be 'opencode' or 'claude-code'");
      }
      if (typeof directory !== "string" || directory.trim().length === 0) {
        throw AdapterError.validation("directory must be a non-empty string");
      }
      if (assignedTo !== undefined && typeof assignedTo !== "string") {
        throw AdapterError.validation("assignedTo must be a string when provided");
      }
      if (isolation !== undefined && !isIsolationMode(isolation)) {
        throw AdapterError.validation("isolation must be 'worktree' or 'in-place'");
      }
      if (taskType === "manual" && (agent !== undefined || model !== undefined)) {
        throw AdapterError.validation("manual tasks cannot define agent or model");
      }
      if (taskType === "manual" && harness !== "opencode") {
        throw AdapterError.validation("manual tasks cannot define harness");
      }
      if (claudePermissionMode !== undefined && !isClaudePermissionMode(claudePermissionMode)) {
        throw AdapterError.validation("claudePermissionMode must be a supported Claude Code permission mode");
      }
      if (claudePermissionMode !== undefined && (taskType !== "agent" || harness !== "claude-code")) {
        throw AdapterError.validation("claudePermissionMode can only be set for claude-code agent tasks");
      }

      const workspace = resolveBoardWorkspace();
      const allowExternal = isExternalDirectoriesAllowed();
      const canonicalDirectory = resolveTaskDirectory(directory, workspace, {
        allowExternal,
      });

      const resolvedModel = taskType === "agent"
        ? harness === "opencode"
          ? await resolveModel(agent, model)
          : resolveClaudeModel(model)
        : undefined;

      const task = store.create({
        type: taskType,
        ...(taskType === "agent" ? { harness } : {}),
        title,
        description: typeof description === "string" ? description : "",
        directory: canonicalDirectory,
        ...(taskType === "agent" && harness === "opencode" && typeof agent === "string" ? { agent } : {}),
        ...(taskType === "agent" && harness === "claude-code" && isClaudePermissionMode(claudePermissionMode) ? { claudePermissionMode } : {}),
        ...(taskType === "manual" && typeof assignedTo === "string" && assignedTo.trim() ? { assignedTo: assignedTo.trim() } : {}),
        ...(resolvedModel ? { model: resolvedModel } : {}),
        ...(taskType === "agent" && isIsolationMode(isolation) ? { isolation } : {}),
      });
      store.addEvent({ taskId: task.id, type: "task_created", body: { type: task.type ?? "agent" } });

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

  app.patch(TASK_ROUTE_PATTERNS.update, async (c) => {
    const id = c.req.param("id");

    try {
      const existing = store.get(id);
      if (!existing) throw AdapterError.notFound(`Task not found: ${id}`);
      if (existing.column !== "todo") {
        throw AdapterError.validation("Only To Do tasks can be edited");
      }

      let body: Record<string, unknown>;
      try {
        body = (await c.req.json()) ?? {};
      } catch {
        throw AdapterError.validation("Request body must be valid JSON");
      }

      const patch = await validateUpdateBody(body, existing);
      const updated = store.update(id, patch);
      if (!updated) throw AdapterError.notFound(`Task not found: ${id}`);
      store.addEvent({ taskId: id, type: "task_updated", body: { fields: Object.keys(patch) } });
      return c.json(updated, 200);
    } catch (err) {
      return respondWithError(c, err);
    }
  });

  app.post(TASK_ROUTE_PATTERNS.run, async (c) => {
    const id = c.req.param("id");

    try {
      assertRunnableActiveTask(store, id, "run");
      const task = await dispatcher.run(id);
      store.addEvent({ taskId: id, type: "task_run", body: { sessionId: task.sessionId, runStartedAt: task.runStartedAt } });
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
      store.addEvent({ taskId: id, type: "task_retried", body: { sessionId: task.sessionId, runStartedAt: task.runStartedAt, feedbackProvided: feedback !== undefined } });
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
      store.addEvent({ taskId: id, type: "task_aborted", body: { sessionId: task.sessionId } });
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
      store.addEvent({ taskId: id, type: "task_moved", body: { column, position, completedBy: nextCompletedBy } });

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

  async function validateUpdateBody(body: Record<string, unknown>, existing: ReturnType<TaskStore["get"]>): Promise<UpdateTaskInput> {
    const allowed = new Set([
      "title",
      "description",
      "directory",
      "agent",
      "model",
      "type",
      "assignedTo",
      "isolation",
      "harness",
      "claudePermissionMode",
    ]);
    for (const key of Object.keys(body)) {
      if (!allowed.has(key)) throw AdapterError.validation(`Unsupported task update field: ${key}`);
    }
    if (!existing) throw AdapterError.notFound("Task not found");

    const nextType = body.type === undefined ? (existing.type ?? "agent") : body.type;
    const nextHarness = body.harness === undefined ? (existing.harness ?? "opencode") : body.harness;
    if (!isTaskType(nextType)) throw AdapterError.validation("type must be 'manual' or 'agent'");
    if (!isTaskHarness(nextHarness)) throw AdapterError.validation("harness must be 'opencode' or 'claude-code'");

    const patch: UpdateTaskInput = {};
    if (body.title !== undefined) {
      if (typeof body.title !== "string" || body.title.trim().length === 0) {
        throw AdapterError.validation("title must be a non-empty string");
      }
      patch.title = body.title.trim();
    }
    if (body.description !== undefined) {
      if (typeof body.description !== "string") throw AdapterError.validation("description must be a string");
      patch.description = body.description;
    }
    if (body.directory !== undefined) {
      if (typeof body.directory !== "string" || body.directory.trim().length === 0) {
        throw AdapterError.validation("directory must be a non-empty string");
      }
      patch.directory = resolveTaskDirectory(body.directory, resolveBoardWorkspace(), {
        allowExternal: isExternalDirectoriesAllowed(),
      });
    }

    patch.type = nextType;
    patch.harness = nextType === "agent" ? nextHarness : "opencode";

    if (body.assignedTo !== undefined) {
      if (body.assignedTo !== null && typeof body.assignedTo !== "string") {
        throw AdapterError.validation("assignedTo must be a string or null when provided");
      }
      patch.assignedTo = typeof body.assignedTo === "string" && body.assignedTo.trim() ? body.assignedTo.trim() : null;
    } else if (nextType === "agent") {
      patch.assignedTo = null;
    }

    if (body.isolation !== undefined) {
      if (body.isolation !== null && !isIsolationMode(body.isolation)) {
        throw AdapterError.validation("isolation must be 'worktree' or 'in-place' or null");
      }
      patch.isolation = body.isolation ?? null;
    } else if (nextType === "manual") {
      patch.isolation = null;
    }

    if (body.claudePermissionMode !== undefined) {
      if (body.claudePermissionMode !== null && !isClaudePermissionMode(body.claudePermissionMode)) {
        throw AdapterError.validation("claudePermissionMode must be a supported Claude Code permission mode or null");
      }
      patch.claudePermissionMode = body.claudePermissionMode ?? null;
    }

    if (nextType === "manual") {
      if (body.agent !== undefined && body.agent !== null) throw AdapterError.validation("manual tasks cannot define agent");
      if (body.model !== undefined && body.model !== null) throw AdapterError.validation("manual tasks cannot define model");
      if (nextHarness !== "opencode") throw AdapterError.validation("manual tasks cannot define harness");
      if (body.claudePermissionMode !== undefined && body.claudePermissionMode !== null) {
        throw AdapterError.validation("claudePermissionMode can only be set for claude-code agent tasks");
      }
      patch.agent = null;
      patch.model = null;
      patch.claudePermissionMode = null;
      return patch;
    }

    if (patch.claudePermissionMode !== undefined && patch.claudePermissionMode !== null && patch.harness !== "claude-code") {
      throw AdapterError.validation("claudePermissionMode can only be set for claude-code agent tasks");
    }

    if (patch.harness === "claude-code") {
      if (body.agent !== undefined && body.agent !== null) throw AdapterError.validation("claude-code tasks cannot define agent");
      patch.agent = null;
      patch.model = body.model === undefined ? existing.model : body.model === null ? null : resolveClaudeModel(body.model);
    } else {
      if (body.claudePermissionMode !== undefined && body.claudePermissionMode !== null) {
        throw AdapterError.validation("claudePermissionMode can only be set for claude-code agent tasks");
      }
      patch.claudePermissionMode = null;
      if (body.agent !== undefined) {
        if (body.agent !== null && typeof body.agent !== "string") throw AdapterError.validation("agent must be a string or null");
        const agent = typeof body.agent === "string" ? body.agent.trim() : "";
        patch.agent = agent || null;
      }
      if (body.model !== undefined) {
        patch.model = body.model === null ? null : validateExplicitModel(body.model);
      } else if (typeof patch.agent === "string") {
        patch.model = await resolveModel(patch.agent, undefined);
      }
    }
    return patch;
  }

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
      store.addEvent({ taskId: id, type: "task_synced", body: { ok: outcome.ok, conflict: outcome.conflict, message: outcome.message } });
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
      store.addEvent({ taskId: id, type: "task_integrated", body: { ok: outcome.ok, conflict: outcome.conflict, message: outcome.message, targetBranch: target } });
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
  if (task.type === "manual") throw AdapterError.validation(`Manual tasks cannot ${action}; convert it to an agent task first.`);
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
