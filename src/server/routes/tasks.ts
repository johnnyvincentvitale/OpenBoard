/**
 * Task REST routes — CRUD + run/retry/abort/move for the task-board Push
 * model. Distinct from the session-board card routes: tasks are specs that
 * a Dispatcher turns into OpenCode sessions.
 */
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  CLAUDE_CODE_MODEL_PROVIDER,
  CLAUDE_CODE_PERMISSION_MODES,
  CODEX_MODEL_PROVIDER,
  CURSOR_ACP_MODEL_PROVIDER,
  GEMINI_ACP_MODEL_PROVIDER,
  HERMES_MODEL_PROVIDER,
  PERMISSION_OVERRIDE_ACTIONS,
  PERMISSION_OVERRIDE_CATEGORIES,
  PI_CODING_AGENT_MODEL_PROVIDER,
  TASK_ROUTE_PATTERNS,
  TASK_HARNESSES,
  TASK_ISOLATION_MODES,
  TASK_KINDS,
  TASK_TYPES,
  USER_COMPLETED_BY,
  isColumn,
} from "../../shared";
import type { AcpOptions, AcpPermissionMode, ClaudeCodePermissionMode, CreateTaskInput, Dispatcher, ModelRef, PermissionOverrides, RosterAgent, TaskHarness, TaskIsolationMode, TaskKind, TaskStore, UpdateTaskInput } from "../../shared";
import { AdapterError } from "../../shared/errors";
import { ArchivedTaskActionError, DependencyGateError } from "../dispatcher";
import { isExternalDirectoriesAllowed, resolveBoardWorkspace, resolveTaskDirectory } from "../workspace";
import { computeDiff } from "../diff-engine";

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

/** Guard error: GET /api/tasks/:id/diff is only valid for Review cards. */
class NonReviewDiffError extends Error {
  readonly status = 409;

  constructor() {
    super("Diff is only available for Review cards");
    this.name = "NonReviewDiffError";
  }
}

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

function isTaskKind(value: unknown): value is TaskKind {
  return typeof value === "string" && (TASK_KINDS as readonly string[]).includes(value);
}

function isTaskHarness(value: unknown): value is TaskHarness {
  return typeof value === "string" && (TASK_HARNESSES as readonly string[]).includes(value);
}

function isClaudePermissionMode(value: unknown): value is ClaudeCodePermissionMode {
  return typeof value === "string" && (CLAUDE_CODE_PERMISSION_MODES as readonly string[]).includes(value);
}

function isAcpPermissionMode(value: unknown): value is AcpPermissionMode {
  return isClaudePermissionMode(value);
}

function isAcpHarness(harness: TaskHarness): boolean {
  return harness !== "opencode";
}

function harnessLabel(harness: TaskHarness): string {
  return harness;
}

function modelProviderForHarness(harness: TaskHarness): string | null {
  switch (harness) {
    case "opencode":
      return null;
    case "claude-code":
      return CLAUDE_CODE_MODEL_PROVIDER;
    case "codex":
      return CODEX_MODEL_PROVIDER;
    case "gemini-acp":
      return GEMINI_ACP_MODEL_PROVIDER;
    case "hermes":
      return HERMES_MODEL_PROVIDER;
    case "pi-coding-agent":
      return PI_CODING_AGENT_MODEL_PROVIDER;
    case "cursor-acp":
      return CURSOR_ACP_MODEL_PROVIDER;
  }
}

function isPermissionOverrides(value: unknown): value is PermissionOverrides {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([key, action]) =>
      (PERMISSION_OVERRIDE_CATEGORIES as readonly string[]).includes(key) &&
      (PERMISSION_OVERRIDE_ACTIONS as readonly string[]).includes(action as string),
  );
}

function isAcpOptions(value: unknown): value is AcpOptions {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([key, option]) =>
      key.trim().length > 0 &&
      (typeof option === "string" || typeof option === "number" || typeof option === "boolean") &&
      (typeof option !== "number" || Number.isFinite(option)),
  );
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
    return resolveAcpModel("claude-code", explicitModel);
  }

  function resolveAcpModel(harness: TaskHarness, explicitModel: unknown): ModelRef | undefined {
    const providerID = modelProviderForHarness(harness);
    if (explicitModel === undefined || providerID === null) return undefined;
    const model = validateExplicitModel(explicitModel);
    if (model.providerID !== providerID) {
      throw AdapterError.validation(`${harnessLabel(harness)} task model.providerID must be '${providerID}'`);
    }
    if (model.variant !== undefined) {
      throw AdapterError.validation(`${harnessLabel(harness)} task models cannot define variant`);
    }
    return model;
  }

  function compatibleAcpModel(model: ModelRef | null | undefined, harness: TaskHarness): ModelRef | null {
    const providerID = modelProviderForHarness(harness);
    if (providerID === null) return null;
    return model?.providerID === providerID && model.variant === undefined ? model : null;
  }

  app.post(TASK_ROUTE_PATTERNS.create, async (c) => {
    try {
      let body: Partial<CreateTaskInput>;
      try {
        body = await c.req.json();
      } catch {
        throw AdapterError.validation("Request body must be valid JSON");
      }

      const { title, description, directory, agent, model, isolation, assignedTo, permissionMode, claudePermissionMode, acpOptions, permissionOverrides, parentIds } = body;
      const taskType = body.type ?? "agent";
      const taskKind = body.taskKind ?? "none";
      const harness = body.harness ?? "opencode";
      const effectivePermissionMode = permissionMode ?? claudePermissionMode;

      if (typeof title !== "string" || title.trim().length === 0) {
        throw AdapterError.validation("title must be a non-empty string");
      }
      if (!isTaskType(taskType)) {
        throw AdapterError.validation("type must be 'manual' or 'agent'");
      }
      if (!isTaskKind(taskKind)) {
        throw AdapterError.validation(`taskKind must be one of: ${TASK_KINDS.join(", ")}`);
      }
      if (!isTaskHarness(harness)) {
        throw AdapterError.validation(`harness must be one of: ${TASK_HARNESSES.join(", ")}`);
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
      if (permissionMode !== undefined && !isAcpPermissionMode(permissionMode)) {
        throw AdapterError.validation("permissionMode must be a supported ACP permission mode");
      }
      if (permissionMode !== undefined && (taskType !== "agent" || !isAcpHarness(harness))) {
        throw AdapterError.validation("permissionMode can only be set for ACP agent tasks");
      }
      if (permissionMode !== undefined && claudePermissionMode !== undefined && permissionMode !== claudePermissionMode) {
        throw AdapterError.validation("permissionMode and claudePermissionMode must match when both are provided");
      }
      if (acpOptions !== undefined && !isAcpOptions(acpOptions)) {
        throw AdapterError.validation("acpOptions must be an object of provider-specific string, number, or boolean values");
      }
      if (acpOptions !== undefined && (taskType !== "agent" || !isAcpHarness(harness))) {
        throw AdapterError.validation("acpOptions can only be set for ACP agent tasks");
      }
      if (permissionOverrides !== undefined && !isPermissionOverrides(permissionOverrides)) {
        throw AdapterError.validation(
          `permissionOverrides must be an object mapping ${PERMISSION_OVERRIDE_CATEGORIES.join("/")} to ${PERMISSION_OVERRIDE_ACTIONS.join("/")}`,
        );
      }
      if (permissionOverrides !== undefined && (taskType !== "agent" || harness !== "opencode" || isolation !== "in-place")) {
        throw AdapterError.validation("permissionOverrides can only be set for in-place OpenCode agent tasks");
      }

      if (parentIds !== undefined) {
        if (!Array.isArray(parentIds)) {
          throw AdapterError.validation("parentIds must be an array of task ID strings");
        }
        for (const pid of parentIds) {
          if (typeof pid !== "string" || pid.trim().length === 0) {
            throw AdapterError.validation("each parentId must be a non-empty string");
          }
        }
        // Validate all parents exist before creating the task, so a bad
        // parentId never leaves a partial task row behind.
        const uniqueParentIds = [...new Set(parentIds)];
        for (const pid of uniqueParentIds) {
          if (!store.get(pid)) throw AdapterError.validation(`Parent task not found: ${pid}`);
        }
      }

      const workspace = resolveBoardWorkspace();
      const allowExternal = isExternalDirectoriesAllowed();
      const canonicalDirectory = resolveTaskDirectory(directory, workspace, {
        allowExternal,
      });

      const resolvedModel = taskType === "agent"
        ? harness === "opencode"
          ? await resolveModel(agent, model)
          : resolveAcpModel(harness, model)
        : undefined;

      const task = store.create({
        type: taskType,
        taskKind,
        ...(taskType === "agent" ? { harness } : {}),
        title,
        description: typeof description === "string" ? description : "",
        directory: canonicalDirectory,
        ...(taskType === "agent" && harness === "opencode" && typeof agent === "string" ? { agent } : {}),
        ...(taskType === "agent" && isAcpHarness(harness) && isAcpPermissionMode(effectivePermissionMode) ? { permissionMode: effectivePermissionMode } : {}),
        ...(taskType === "agent" && harness === "claude-code" && isClaudePermissionMode(effectivePermissionMode) ? { claudePermissionMode: effectivePermissionMode } : {}),
        ...(taskType === "agent" && isAcpHarness(harness) && isAcpOptions(acpOptions) ? { acpOptions } : {}),
        ...(taskType === "manual" && typeof assignedTo === "string" && assignedTo.trim() ? { assignedTo: assignedTo.trim() } : {}),
        ...(resolvedModel ? { model: resolvedModel } : {}),
        ...(taskType === "agent" && isIsolationMode(isolation) ? { isolation } : {}),
        ...(taskType === "agent" && harness === "opencode" && isolation === "in-place" && isPermissionOverrides(permissionOverrides) ? { permissionOverrides } : {}),
      });
      store.addEvent({ taskId: task.id, type: "task_created", body: { type: task.type ?? "agent" } });

      if (parentIds && parentIds.length > 0) {
        const uniqueParentIds = [...new Set(parentIds)];
        for (const pid of uniqueParentIds) {
          store.addLink(pid, task.id);
          store.addEvent({ taskId: task.id, type: "task_linked", body: { parentId: pid } });
        }
      }

      const fresh = store.get(task.id);
      return c.json(fresh, 201);
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
      // Strip parentIds from the patch since they are stored in task_links, not the task row.
      const { parentIds: _parentIds, ...taskPatch } = patch;

      // Validate parentIds BEFORE mutating the task row or links, so a 400
      // never leaves partial state.
      if (body.parentIds !== undefined) {
        const parentIds = body.parentIds;
        if (!Array.isArray(parentIds) && parentIds !== null) {
          throw AdapterError.validation("parentIds must be an array of task ID strings or null");
        }
        const ids: string[] = parentIds === null ? [] : [...new Set(parentIds as string[])];
        for (const pid of ids) {
          if (typeof pid !== "string" || pid.trim().length === 0) {
            throw AdapterError.validation("each parentId must be a non-empty string");
          }
          if (!store.get(pid)) {
            throw AdapterError.validation(`Parent task not found: ${pid}`);
          }
          if (pid === id) {
            throw AdapterError.validation("Task cannot depend on itself");
          }
        }
        // Pre-validate every link (cycle/duplicate) before any mutation.
        for (const pid of ids) {
          if (isReachableViaChildren(store, id, pid)) {
            throw AdapterError.validation(`Task link would create a cycle: ${pid} -> ${id}`);
          }
        }
      }

      const updated = store.update(id, taskPatch);
      if (!updated) throw AdapterError.notFound(`Task not found: ${id}`);
      store.addEvent({ taskId: id, type: "task_updated", body: { fields: Object.keys(patch) } });

      if (body.parentIds !== undefined) {
        const ids: string[] = body.parentIds === null ? [] : [...new Set(body.parentIds as string[])];
        // Remove existing links, then set the new ones — all pre-validated above.
        for (const pid of store.getParentIds(id)) {
          store.removeLink(pid, id);
        }
        for (const pid of ids) {
          store.addLink(pid, id);
        }
      }

      const refreshed = store.get(id);
      if (!refreshed) throw AdapterError.notFound(`Task not found: ${id}`);
      return c.json(refreshed, 200);
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

  app.delete(TASK_ROUTE_PATTERNS.remove, async (c) => {
    const id = c.req.param("id");

    try {
      const outcome = await dispatcher.removeTask(id, {
        force: c.req.query("forceWorktree") === "true",
        keepWorktree: c.req.query("keepWorktree") === "true",
      });
      if (!outcome.ok) {
        return c.json(outcome, 409);
      }
      return c.json(outcome, 200);
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
      "taskKind",
      "assignedTo",
      "isolation",
      "harness",
      "permissionMode",
      "claudePermissionMode",
      "acpOptions",
      "permissionOverrides",
      "parentIds",
    ]);
    for (const key of Object.keys(body)) {
      if (!allowed.has(key)) throw AdapterError.validation(`Unsupported task update field: ${key}`);
    }
    if (!existing) throw AdapterError.notFound("Task not found");

    const nextType = body.type === undefined ? (existing.type ?? "agent") : body.type;
    const nextTaskKind = body.taskKind === undefined ? (existing.taskKind ?? "none") : body.taskKind;
    const nextHarness = body.harness === undefined ? (existing.harness ?? "opencode") : body.harness;
    if (!isTaskType(nextType)) throw AdapterError.validation("type must be 'manual' or 'agent'");
    if (nextTaskKind !== null && !isTaskKind(nextTaskKind)) throw AdapterError.validation(`taskKind must be one of: ${TASK_KINDS.join(", ")}`);
    if (!isTaskHarness(nextHarness)) throw AdapterError.validation(`harness must be one of: ${TASK_HARNESSES.join(", ")}`);

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
    patch.taskKind = nextTaskKind ?? "none";
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
    if (body.permissionMode !== undefined) {
      if (body.permissionMode !== null && !isAcpPermissionMode(body.permissionMode)) {
        throw AdapterError.validation("permissionMode must be a supported ACP permission mode or null");
      }
      patch.permissionMode = body.permissionMode ?? null;
    }
    if (patch.permissionMode !== undefined && patch.claudePermissionMode !== undefined && patch.permissionMode !== patch.claudePermissionMode) {
      throw AdapterError.validation("permissionMode and claudePermissionMode must match when both are provided");
    }

    if (body.acpOptions !== undefined) {
      if (body.acpOptions !== null && !isAcpOptions(body.acpOptions)) {
        throw AdapterError.validation("acpOptions must be an object of provider-specific string, number, or boolean values, or null");
      }
      patch.acpOptions = body.acpOptions ?? null;
    }

    if (body.permissionOverrides !== undefined && body.permissionOverrides !== null && !isPermissionOverrides(body.permissionOverrides)) {
      throw AdapterError.validation(
        `permissionOverrides must be an object mapping ${PERMISSION_OVERRIDE_CATEGORIES.join("/")} to ${PERMISSION_OVERRIDE_ACTIONS.join("/")}`,
      );
    }

    if (body.parentIds !== undefined && body.parentIds !== null && !Array.isArray(body.parentIds)) {
      throw AdapterError.validation("parentIds must be an array of task ID strings or null");
    }

    // Effective isolation after this patch: the patched value if this PATCH touches it, else whatever is already on the row.
    const effectiveIsolation: TaskIsolationMode | null = patch.isolation !== undefined ? patch.isolation : (existing.isolation ?? null);

    if (nextType === "manual") {
      if (body.agent !== undefined && body.agent !== null) throw AdapterError.validation("manual tasks cannot define agent");
      if (body.model !== undefined && body.model !== null) throw AdapterError.validation("manual tasks cannot define model");
      if (nextHarness !== "opencode") throw AdapterError.validation("manual tasks cannot define harness");
      if (body.claudePermissionMode !== undefined && body.claudePermissionMode !== null) {
        throw AdapterError.validation("claudePermissionMode can only be set for claude-code agent tasks");
      }
      if (body.permissionMode !== undefined && body.permissionMode !== null) {
        throw AdapterError.validation("permissionMode can only be set for ACP agent tasks");
      }
      if (body.acpOptions !== undefined && body.acpOptions !== null) {
        throw AdapterError.validation("acpOptions can only be set for ACP agent tasks");
      }
      if (body.permissionOverrides !== undefined && body.permissionOverrides !== null) {
        throw AdapterError.validation("permissionOverrides can only be set for in-place OpenCode agent tasks");
      }
      patch.agent = null;
      patch.model = null;
      patch.permissionMode = null;
      patch.claudePermissionMode = null;
      patch.acpOptions = null;
      patch.permissionOverrides = null;
      return patch;
    }

    if (patch.permissionMode !== undefined && patch.permissionMode !== null && !isAcpHarness(patch.harness)) {
      throw AdapterError.validation("permissionMode can only be set for ACP agent tasks");
    }
    if (patch.claudePermissionMode !== undefined && patch.claudePermissionMode !== null && patch.harness !== "claude-code") {
      throw AdapterError.validation("claudePermissionMode can only be set for claude-code agent tasks");
    }

    if (isAcpHarness(patch.harness)) {
      if (body.agent !== undefined && body.agent !== null) throw AdapterError.validation(`${harnessLabel(patch.harness)} tasks cannot define agent`);
      // permissionOverrides is OpenCode-only — a task moving to (or staying on) an ACP
      // harness always drops any override, same as claudePermissionMode drops for opencode below.
      if (body.permissionOverrides !== undefined && body.permissionOverrides !== null) {
        throw AdapterError.validation("permissionOverrides can only be set for in-place OpenCode agent tasks");
      }
      if (patch.harness !== "claude-code" && body.claudePermissionMode !== undefined && body.claudePermissionMode !== null) {
        throw AdapterError.validation("claudePermissionMode can only be set for claude-code agent tasks");
      }
      patch.agent = null;
      patch.model = body.model === undefined ? compatibleAcpModel(existing.model, patch.harness) : body.model === null ? null : resolveAcpModel(patch.harness, body.model);
      patch.acpOptions = body.acpOptions === undefined ? existing.acpOptions ?? null : body.acpOptions === null ? null : body.acpOptions;
      if (patch.harness === "claude-code") {
        const nextMode = patch.permissionMode ?? patch.claudePermissionMode;
        if (nextMode !== undefined) {
          patch.permissionMode = nextMode;
          patch.claudePermissionMode = nextMode;
        }
      } else {
        patch.claudePermissionMode = null;
      }
      patch.permissionOverrides = null;
    } else {
      if (body.acpOptions !== undefined && body.acpOptions !== null) {
        throw AdapterError.validation("acpOptions can only be set for ACP agent tasks");
      }
      patch.acpOptions = null;
      if (body.permissionMode !== undefined && body.permissionMode !== null) {
        throw AdapterError.validation("permissionMode can only be set for ACP agent tasks");
      }
      patch.permissionMode = null;
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

      // permissionOverrides only ever applies to in-place (non-worktree) runs — see
      // resolveOpenCodePermissionRules. Any patch that leaves isolation at worktree
      // (or unset) auto-clears a stale override instead of silently keeping it.
      if (effectiveIsolation !== "in-place") {
        if (body.permissionOverrides !== undefined && body.permissionOverrides !== null) {
          throw AdapterError.validation("permissionOverrides can only be set for in-place OpenCode agent tasks");
        }
        patch.permissionOverrides = null;
      } else if (body.permissionOverrides !== undefined) {
        patch.permissionOverrides = body.permissionOverrides === null ? null : (body.permissionOverrides as PermissionOverrides);
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

  app.get(TASK_ROUTE_PATTERNS.commitStatus, async (c) => {
    const id = c.req.param("id");
    try {
      const targetBranch = c.req.query("targetBranch") || undefined;
      const status = await dispatcher.getWorktreeCommitStatus(id, targetBranch);
      return c.json(status);
    } catch (err) {
      return respondWithError(c, err);
    }
  });

  app.post(TASK_ROUTE_PATTERNS.commitFile, async (c) => {
    const id = c.req.param("id");
    try {
      let body: { file?: unknown; message?: unknown };
      try {
        body = await c.req.json();
      } catch {
        throw AdapterError.validation("Request body must be valid JSON");
      }
      if (typeof body.file !== "string" || body.file.trim().length === 0) {
        throw AdapterError.validation("file must be a non-empty string");
      }
      const message = typeof body.message === "string" && body.message.trim().length > 0
        ? body.message
        : undefined;
      const outcome = await dispatcher.commitFile(id, body.file, message);
      store.addEvent({ taskId: id, type: "task_file_committed", body: { ok: outcome.ok, file: outcome.file, message: outcome.message, commit: outcome.commit } });
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
      let commitRemaining = false;
      try {
        const body = (await c.req.json()) as { targetBranch?: unknown; commitRemaining?: unknown };
        if (typeof body?.targetBranch === "string") target = body.targetBranch;
        commitRemaining = body?.commitRemaining === true;
      } catch {
        // Body optional — integrate falls back to the task's recorded base branch.
      }
      const outcome = await dispatcher.integrate(id, target, { commitRemaining });
      store.addEvent({
        taskId: id,
        type: "task_integrated",
        body: {
          ok: outcome.ok,
          conflict: outcome.conflict,
          message: outcome.message,
          targetBranch: target,
          needsCommit: outcome.needsCommit,
          column: outcome.task.column,
          completedBy: outcome.task.completedBy,
        },
      });
      return c.json(outcome, outcome.ok ? 200 : 409);
    } catch (err) {
      return respondWithError(c, err);
    }
  });

  app.post(TASK_ROUTE_PATTERNS.discardWorktree, async (c) => {
    const id = c.req.param("id");
    try {
      let force = false;
      try {
        const body = (await c.req.json()) as { force?: unknown };
        force = body?.force === true;
      } catch {
        // Body optional.
      }
      const outcome = await dispatcher.discardWorktree(id, { force });
      store.addEvent({ taskId: id, type: "task_worktree_discarded", body: { ...outcome } });
      return c.json(outcome, outcome.ok ? 200 : 409);
    } catch (err) {
      return respondWithError(c, err);
    }
  });

  // Diff view (Review cards only) — token-authenticated like all /api/* routes.
  app.get(TASK_ROUTE_PATTERNS.diff, async (c) => {
    const id = c.req.param("id");
    try {
      const task = store.get(id);
      if (!task) throw AdapterError.notFound(`Task not found: ${id}`);
      if (task.column !== "review") {
        throw new NonReviewDiffError();
      }
      const diff = await computeDiff(task);
      return c.json(diff, 200);
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
      let body: { bashSandbox?: unknown };
      try {
        body = await c.req.json();
      } catch {
        throw AdapterError.validation("Request body must be valid JSON");
      }
      if (body.bashSandbox === undefined) {
        throw AdapterError.validation("Request body must contain bashSandbox");
      }
      if (body.bashSandbox !== undefined && typeof body.bashSandbox !== "boolean") {
        throw AdapterError.validation("bashSandbox must be a boolean");
      }
      const settings = store.updateSettings({ bashSandbox: body.bashSandbox });
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
  if (err instanceof NonReviewDiffError) {
    return c.json(
      { error: { code: "validation", message: err.message } },
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
