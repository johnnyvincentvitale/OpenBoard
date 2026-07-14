/**
 * Task REST routes — CRUD + run/retry/abort/move for the task-board Push
 * model. Distinct from the session-board card routes: tasks are specs that
 * a Dispatcher turns into OpenCode sessions.
 */
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  AUTO_RUN_REQUIREMENT,
  CLAUDE_CODE_MODEL_PROVIDER,
  CLAUDE_CODE_PERMISSION_MODES,
  CODEX_MODEL_PROVIDER,
  CURSOR_ACP_MODEL_PROVIDER,
  GEMINI_ACP_MODEL_PROVIDER,
  HERMES_MODEL_PROVIDER,
  INTEGRATED_COMPLETED_BY,
  PERMISSION_OVERRIDE_ACTIONS,
  PERMISSION_OVERRIDE_CATEGORIES,
  PI_CODING_AGENT_MODEL_PROVIDER,
  TASK_ROUTE_PATTERNS,
  TASK_HARNESSES,
  TASK_ISOLATION_MODES,
  TASK_KINDS,
  SESSION_MESSAGE_MODES,
  TASK_TYPES,
  USER_COMPLETED_BY,
  blockedQuestion,
  canAutoRun,
  type BlockedAcceptance,
  type BlockedAnswerContext,
  isColumn,
  isAcpPermissionMode,
} from "../../shared";
import type { AcpOptions, ClaudeCodePermissionMode, CompletionReport, CreateTaskInput, Dispatcher, ModelRef, PermissionOverrides, RosterAgent, SessionMessageInput, SessionMessageReceipt, Task, TaskHarness, TaskIsolationMode, TaskKind, TaskStore, UpdateTaskInput } from "../../shared";
import { AdapterError } from "../../shared/errors";
import { ArchivedTaskActionError, DependencyGateError } from "../dispatcher";
import { isExternalDirectoriesAllowed, resolveBoardWorkspace, resolveTaskDirectory } from "../workspace";
import { computeDiff } from "../diff-engine";
import { fireChainAdvance, type ChainAdvancer } from "../chain-advancer";
import { projectPendingPermissions } from "../dto";
import { evaluateDonePolicy } from "../done-policy";

const BLOCKED_ANSWER_MAX_LENGTH = 2000;
const BLOCKED_ATTRIBUTION_MAX_LENGTH = 200;
const inFlightBlockedAnswers = new Set<string>();
const sessionMessageReceipts = new Map<string, SessionMessageReceipt>();
const SESSION_MESSAGE_MAX_LENGTH = 12_000;

class ConflictRouteError extends Error {
  readonly status = 409;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ConflictRouteError";
    this.code = code;
    this.details = details;
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

/** Guard error: GET /api/tasks/:id/diff is only valid for Review or Done cards. */
class NonDiffableColumnError extends Error {
  readonly status = 409;

  constructor() {
    super("Diff is only available for Review or Done cards");
    this.name = "NonDiffableColumnError";
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

function validOpenCodeOverridesForIsolation(overrides: PermissionOverrides, isolation: TaskIsolationMode | null | undefined): boolean {
  if (isolation === "in-place") return true;
  if (isolation !== "worktree") return false;
  return Object.entries(overrides).every(([category, action]) => category === "bash" && (action === "ask" || action === "deny"));
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
  blockedAnswer?: unknown;
}

function parseSessionMessageBody(value: unknown): SessionMessageInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw AdapterError.validation("session message body must be an object");
  }
  const body = value as Record<string, unknown>;
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const sentBy = typeof body.sentBy === "string" ? body.sentBy.trim() : "";
  const clientMessageId = typeof body.clientMessageId === "string" ? body.clientMessageId.trim() : "";
  const expectedSessionId = typeof body.expectedSessionId === "string" ? body.expectedSessionId.trim() : "";
  if (text.length < 1 || text.length > SESSION_MESSAGE_MAX_LENGTH) throw AdapterError.validation(`text must be 1..${SESSION_MESSAGE_MAX_LENGTH} characters`);
  if (!(SESSION_MESSAGE_MODES as readonly unknown[]).includes(body.mode)) throw AdapterError.validation("mode must be queue or interrupt");
  if (sentBy.length < 1 || sentBy.length > 200) throw AdapterError.validation("sentBy must be 1..200 characters");
  if (clientMessageId.length < 1 || clientMessageId.length > 200) throw AdapterError.validation("clientMessageId must be 1..200 characters");
  if (expectedSessionId.length < 1 || expectedSessionId.length > 500) throw AdapterError.validation("expectedSessionId must be 1..500 characters");
  if (body.expectedRunStartedAt !== undefined && (typeof body.expectedRunStartedAt !== "number" || !Number.isFinite(body.expectedRunStartedAt))) {
    throw AdapterError.validation("expectedRunStartedAt must be a finite number");
  }
  if (body.blockedReportedAt !== undefined && (typeof body.blockedReportedAt !== "number" || !Number.isFinite(body.blockedReportedAt))) {
    throw AdapterError.validation("blockedReportedAt must be a finite number");
  }
  return {
    text,
    mode: body.mode as SessionMessageInput["mode"],
    sentBy,
    clientMessageId,
    expectedSessionId,
    ...(body.expectedRunStartedAt === undefined ? {} : { expectedRunStartedAt: body.expectedRunStartedAt as number }),
    ...(body.blockedReportedAt === undefined ? {} : { blockedReportedAt: body.blockedReportedAt as number }),
  };
}

/**
 * Registers the /api/tasks REST routes (create, list, run, retry, abort,
 * move, remove) on the given Hono app.
 */
export function registerTaskRoutes(
  app: Hono,
  deps: { store: TaskListStore; dispatcher: Dispatcher; agentRoster?: AgentRosterDep; advancer?: ChainAdvancer },
): void {
  const { store, dispatcher } = deps;
  const agentRoster = deps.agentRoster ?? { fetch: async () => [] as RosterAgent[] };
  const projectTask = (task: Task): Task => projectPendingPermissions([task], dispatcher)[0] ?? task;

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
      throw AdapterError.validation(missingAgentModelRecoveryMessage(agent));
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

      const { title, description, directory, agent, model, fallbackModel, isolation, assignedTo, permissionMode, claudePermissionMode, acpOptions, permissionOverrides, autoRun, parentIds } = body;
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
      if (taskType === "manual" && fallbackModel !== undefined) {
        throw AdapterError.validation("manual tasks cannot define fallbackModel");
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
      if (harness === "claude-code" && permissionMode !== undefined && !isClaudePermissionMode(permissionMode)) {
        throw AdapterError.validation("permissionMode must be a supported Claude Code permission mode for claude-code tasks");
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
      if (permissionOverrides !== undefined && (taskType !== "agent" || harness !== "opencode" || !validOpenCodeOverridesForIsolation(permissionOverrides, isolation))) {
        throw AdapterError.validation("permissionOverrides require an in-place OpenCode task, or a worktree OpenCode task with only bash: ask|deny");
      }
      if (autoRun !== undefined && typeof autoRun !== "boolean") {
        throw AdapterError.validation("autoRun must be a boolean");
      }
      const autoRunAccepted =
        autoRun === true &&
        canAutoRun({
          type: taskType,
          harness,
          isolation: isIsolationMode(isolation) ? isolation : null,
          permissionOverrides: isPermissionOverrides(permissionOverrides) ? permissionOverrides : null,
        });
      if (autoRun === true && !autoRunAccepted) {
        throw AdapterError.validation(AUTO_RUN_REQUIREMENT);
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
      const resolvedFallbackModel = resolveFallbackModel(taskType, harness, fallbackModel, resolvedModel);

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
        ...(resolvedFallbackModel ? { fallbackModel: resolvedFallbackModel } : {}),
        ...(taskType === "agent" && isIsolationMode(isolation) ? { isolation } : {}),
        ...(autoRunAccepted ? { autoRun: true } : {}),
        ...(taskType === "agent" && harness === "opencode" && isPermissionOverrides(permissionOverrides) && validOpenCodeOverridesForIsolation(permissionOverrides, isolation) ? { permissionOverrides } : {}),
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
      return c.json(fresh ? projectTask(fresh) : fresh, 201);
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
      const projected = projectPendingPermissions(tasks, dispatcher);
      return c.json(projected, 200);
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
      return c.json(projectTask(refreshed), 200);
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
      return c.json(projectTask(task), 202);
    } catch (err) {
      return respondWithError(c, err);
    }
  });

  app.post(TASK_ROUTE_PATTERNS.retry, async (c) => {
    const id = c.req.param("id");
    let blockedAnswerKey: string | undefined;

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
      const current = store.get(id);
      if (!current) throw AdapterError.notFound(`Task not found: ${id}`);
      const blockedAnswer = parseBlockedAnswer(body.blockedAnswer, current, feedback);
      blockedAnswerKey = blockedAnswer ? `${id}:${blockedAnswer.blockedReportedAt}` : undefined;
      if (blockedAnswerKey) {
        if (inFlightBlockedAnswers.has(blockedAnswerKey)) {
          throw new ConflictRouteError("blocked_answer_duplicate", "Blocked answer submission is already in flight");
        }
        inFlightBlockedAnswers.add(blockedAnswerKey);
      }
      const oldSessionId = current.sessionId ?? current.harnessSessionId;
      const oldRunStartedAt = current.runStartedAt;
      const question = current.completion ? blockedQuestion(current.completion) : undefined;

      let task: Task;
      try {
        task = await dispatcher.retry(id, feedback, blockedAnswer);
      } catch (err) {
        if (blockedAnswer) {
          store.addEvent({ taskId: id, type: "task_blocked_retry_failed", body: { blockedReportedAt: blockedAnswer.blockedReportedAt, answeredBy: blockedAnswer.answeredBy, question, error: err instanceof Error ? err.message : String(err) } });
        }
        throw err;
      }
      if (blockedAnswer) {
        const newSessionId = task.sessionId ?? task.harnessSessionId;
        const resumeMode = task.blockedAnswerResumeDecision?.mode ?? (oldSessionId && oldSessionId === newSessionId ? "same-session" : "fresh-session");
        const resumeEvidence = task.blockedAnswerResumeDecision?.evidence;
        store.addEvent({ taskId: id, type: "task_blocked_answered", body: { blockedReportedAt: blockedAnswer.blockedReportedAt, answeredBy: blockedAnswer.answeredBy, question, answerProvided: true, resumeMode, ...(resumeEvidence ? { resumeEvidence } : {}) } });
        store.addEvent({ taskId: id, type: "task_retried", body: { oldSessionId, oldRunStartedAt, newSessionId, runStartedAt: task.runStartedAt, feedbackProvided: true, answeredBlock: true } });
      } else {
        store.addEvent({ taskId: id, type: "task_retried", body: { sessionId: task.sessionId ?? task.harnessSessionId, runStartedAt: task.runStartedAt, feedbackProvided: feedback !== undefined } });
      }
      return c.json(projectTask(task), 202);
    } catch (err) {
      return respondWithError(c, err);
    } finally {
      if (blockedAnswerKey) inFlightBlockedAnswers.delete(blockedAnswerKey);
    }
  });

  app.post(TASK_ROUTE_PATTERNS.sessionMessages, async (c) => {
    const id = c.req.param("id");
    try {
      const input = parseSessionMessageBody(await c.req.json());
      const key = `${id}:${input.clientMessageId}`;
      const prior = sessionMessageReceipts.get(key);
      if (prior) return c.json(prior, 202);
      const receipt = await dispatcher.sendSessionMessage(id, input);
      sessionMessageReceipts.set(key, receipt);
      if (sessionMessageReceipts.size > 1_000) {
        const oldest = sessionMessageReceipts.keys().next().value;
        if (oldest) sessionMessageReceipts.delete(oldest);
      }
      return c.json({ ...receipt, task: projectTask(receipt.task) }, 202);
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
      return c.json(projectTask(task), 200);
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

      const task = store.get(id);
      if (!task) throw AdapterError.notFound(`Task not found: ${id}`);
      const isBlockedDone = column === "done" && task.completion?.outcome === "blocked";
      const isDoneReorder = column === "done" && task.column === "done";
      const nextCompletedBy: string | null = completedBy !== undefined
        ? (completedBy as string | null)
        : isDoneReorder
          ? task.completedBy ?? null
          : column === "done" && !isBlockedDone
            ? USER_COMPLETED_BY
            : null;

      if (column === "done") {
        await assertWorktreeDoneMoveResolved(dispatcher, task);
        const policy = evaluateDonePolicy({
          task,
          targetColumn: column,
          completedBy: nextCompletedBy,
          blockedAcceptance: parseBlockedAcceptanceValue(body.blockedAcceptance),
        });
        if (!policy.ok) throw blockedPolicyConflict(policy.error.code, policy.error.message, task, "move");
        if (policy.blockedAccepted) {
          store.addEvent({ taskId: id, type: "task_blocked_accepted", body: blockedAcceptanceEvidence(task, policy.acceptedBy, "move") });
        }
      } else if (body.blockedAcceptance !== undefined) {
        throw new ConflictRouteError("blocked_acceptance_unexpected", "Blocked acceptance is only valid when moving to Done");
      }

      store.move(id, column, position);

      store.update(id, { completedBy: nextCompletedBy });
      store.addEvent({ taskId: id, type: "task_moved", body: { column, position, completedBy: nextCompletedBy } });

      // Fire-and-forget: a manual move to Done satisfies this task as a
      // parent gate — check for autoRun children without delaying this
      // response on spawned child sessions.
      if (column === "done") {
        void fireChainAdvance(deps.advancer, store, id);
      }

      const tasks = projectPendingPermissions(store.list(), dispatcher);
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
      "fallbackModel",
      "type",
      "taskKind",
      "assignedTo",
      "isolation",
      "harness",
      "permissionMode",
      "claudePermissionMode",
      "acpOptions",
      "permissionOverrides",
      "autoRun",
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

    if (body.autoRun !== undefined && typeof body.autoRun !== "boolean") {
      throw AdapterError.validation("autoRun must be a boolean");
    }
    // autoRun only ever applies to shapes where unattended writes to the live
    // checkout are impossible — worktree isolation, or in-place OpenCode with
    // edit+bash overrides denied (see canAutoRun). Any patch that leaves the
    // task off those shapes (isolation, harness, type, or a weakened override)
    // auto-clears a stale flag instead of silently keeping it — same rule as
    // permissionOverrides below. Overrides are evaluated post-patch: the
    // patched value if this PATCH touches them, else the stored row's.
    const autoRunCapable = canAutoRun({
      type: nextType,
      harness: nextHarness,
      isolation: effectiveIsolation,
      permissionOverrides:
        body.permissionOverrides !== undefined
          ? (body.permissionOverrides as PermissionOverrides | null)
          : existing.permissionOverrides ?? null,
    });
    if (!autoRunCapable) {
      if (body.autoRun === true) {
        throw AdapterError.validation(AUTO_RUN_REQUIREMENT);
      }
      patch.autoRun = false;
    } else if (body.autoRun !== undefined) {
      patch.autoRun = body.autoRun as boolean;
    }

    if (nextType === "manual") {
      if (body.agent !== undefined && body.agent !== null) throw AdapterError.validation("manual tasks cannot define agent");
      if (body.model !== undefined && body.model !== null) throw AdapterError.validation("manual tasks cannot define model");
      if (body.fallbackModel !== undefined && body.fallbackModel !== null) throw AdapterError.validation("manual tasks cannot define fallbackModel");
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
      patch.fallbackModel = null;
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
      if (body.fallbackModel !== undefined && body.fallbackModel !== null) {
        throw AdapterError.validation("fallbackModel can only be set for OpenCode agent tasks");
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
          if (nextMode !== null && !isClaudePermissionMode(nextMode)) {
            throw AdapterError.validation("permissionMode must be a supported Claude Code permission mode for claude-code tasks");
          }
          patch.permissionMode = nextMode;
          patch.claudePermissionMode = nextMode;
        }
      } else {
        patch.claudePermissionMode = null;
      }
      patch.permissionOverrides = null;
      patch.fallbackModel = null;
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

      const effectiveOverrides = body.permissionOverrides !== undefined
        ? (body.permissionOverrides as PermissionOverrides | null)
        : existing.permissionOverrides ?? null;
      if (effectiveOverrides && !validOpenCodeOverridesForIsolation(effectiveOverrides, effectiveIsolation)) {
        if (body.permissionOverrides !== undefined) {
          throw AdapterError.validation("permissionOverrides require an in-place OpenCode task, or a worktree OpenCode task with only bash: ask|deny");
        }
        patch.permissionOverrides = null;
      }
      if (effectiveIsolation !== "in-place" && effectiveIsolation !== "worktree") {
        patch.permissionOverrides = null;
      } else if (body.permissionOverrides !== undefined) {
        patch.permissionOverrides = body.permissionOverrides === null ? null : (body.permissionOverrides as PermissionOverrides);
      }

      const effectivePrimary = patch.model !== undefined ? patch.model : existing.model;
      if (body.fallbackModel !== undefined) {
        patch.fallbackModel = body.fallbackModel === null ? null : resolveFallbackModel("agent", "opencode", body.fallbackModel, effectivePrimary);
      } else if (existing.fallbackModel && effectivePrimary?.providerID === existing.fallbackModel.providerID) {
        patch.fallbackModel = null;
      }
    }
    return patch;
  }

  // Answer the "make this directory a git repo?" prompt: init + commit, then run.
  app.post(TASK_ROUTE_PATTERNS.initGit, async (c) => {
    const id = c.req.param("id");
    try {
      const task = await dispatcher.initGitAndRun(id);
      return c.json(projectTask(task), 202);
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
      return c.json({ ...outcome, task: projectTask(outcome.task) }, outcome.ok ? 200 : 409);
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
      return c.json({ ...outcome, task: projectTask(outcome.task) }, outcome.ok ? 200 : 409);
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
      let blockedAcceptance: BlockedAcceptance | undefined;
      let rawBlockedAcceptance: unknown;
      try {
        const body = (await c.req.json()) as { targetBranch?: unknown; commitRemaining?: unknown; blockedAcceptance?: unknown };
        if (typeof body?.targetBranch === "string") target = body.targetBranch;
        commitRemaining = body?.commitRemaining === true;
        rawBlockedAcceptance = body?.blockedAcceptance;
      } catch {
        // Body optional — integrate falls back to the task's recorded base branch.
      }
      blockedAcceptance = parseBlockedAcceptanceValue(rawBlockedAcceptance);
      const task = store.get(id);
      if (!task) throw AdapterError.notFound(`Task not found: ${id}`);
      const policy = evaluateDonePolicy({ task, completedBy: INTEGRATED_COMPLETED_BY, blockedAcceptance });
      if (!policy.ok) throw blockedPolicyConflict(policy.error.code, policy.error.message, task, "integrate");
      const outcome = await dispatcher.integrate(id, target, { commitRemaining, blockedAcceptance });
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
      return c.json({ ...outcome, task: projectTask(outcome.task) }, outcome.ok ? 200 : 409);
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

  // Diff inspection (Review and Done cards) — token-authenticated like all /api/* routes.
  app.get(TASK_ROUTE_PATTERNS.diff, async (c) => {
    const id = c.req.param("id");
    try {
      const task = store.get(id);
      if (!task) throw AdapterError.notFound(`Task not found: ${id}`);
      if (task.column !== "review" && task.column !== "done") {
        throw new NonDiffableColumnError();
      }
      const diff = await computeDiff(task);
      return c.json(diff, 200);
    } catch (err) {
      return respondWithError(c, err);
    }
  });

}

function validateModelRef(value: unknown, field: "model" | "fallbackModel"): ModelRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw AdapterError.validation(`${field} must be an object with providerID and id strings`);
  }

  const candidate = value as { providerID?: unknown; id?: unknown; variant?: unknown };
  if (typeof candidate.providerID !== "string" || candidate.providerID.trim().length === 0) {
    throw AdapterError.validation(`${field}.providerID must be a non-empty string`);
  }
  if (typeof candidate.id !== "string" || candidate.id.trim().length === 0) {
    throw AdapterError.validation(`${field}.id must be a non-empty string`);
  }
  if (candidate.variant !== undefined && typeof candidate.variant !== "string") {
    throw AdapterError.validation(`${field}.variant must be a string when provided`);
  }

  return {
    providerID: candidate.providerID.trim(),
    id: candidate.id.trim(),
    ...(candidate.variant !== undefined ? { variant: candidate.variant } : {}),
  };
}

function validateExplicitModel(value: unknown): ModelRef {
  return validateModelRef(value, "model");
}

function missingAgentModelRecoveryMessage(agent: string): string {
  return `Agent profile "${agent}" does not have a usable default model; select a provider/model in the task wizard, or configure a default model for that OpenCode agent profile, then try again.`;
}

function resolveFallbackModel(
  taskType: CreateTaskInput["type"] | UpdateTaskInput["type"],
  harness: TaskHarness,
  value: unknown,
  primaryModel: ModelRef | null | undefined,
): ModelRef | undefined {
  if (value === undefined) return undefined;
  if (taskType === "manual") throw AdapterError.validation("manual tasks cannot define fallbackModel");
  if (harness !== "opencode") throw AdapterError.validation("fallbackModel can only be set for OpenCode agent tasks");
  const fallback = validateModelRef(value, "fallbackModel");
  if (!primaryModel) throw AdapterError.validation("fallbackModel requires a primary model");
  if (fallback.providerID === primaryModel.providerID) {
    throw AdapterError.validation("fallbackModel.providerID must differ from the primary model providerID");
  }
  return fallback;
}

function assertRunnableActiveTask(store: TaskStore, id: string, action: "run" | "retry"): void {
  const task = store.get(id);
  if (!task) throw AdapterError.notFound(`Task not found: ${id}`);
  if (task.archived) throw new ArchivedTaskActionError(action);
  if (task.type === "manual") throw AdapterError.validation(`Manual tasks cannot ${action}; convert it to an agent task first.`);
}

function parseBlockedAnswer(value: unknown, task: { completion?: CompletionReport | null; archived?: boolean }, feedback: string | undefined): BlockedAnswerContext | undefined {
  if (value === undefined) return undefined;
  if (task.archived) throw new ConflictRouteError("blocked_answer_archived", "Archived blocked tasks cannot be answered");
  if (!task.completion || task.completion.outcome !== "blocked") {
    throw new ConflictRouteError("blocked_answer_unexpected", "Blocked answer is only valid for the current blocked report");
  }
  if (value === null || typeof value !== "object") throw new ConflictRouteError("blocked_answer_incomplete", "blockedAnswer must be an object");
  const record = value as Record<string, unknown>;
  if (record.blockedReportedAt !== task.completion.reportedAt) {
    throw new ConflictRouteError("blocked_answer_stale", "Blocked answer does not match the current blocked report");
  }
  cleanBounded(feedback, "feedback", BLOCKED_ANSWER_MAX_LENGTH, "blocked_answer_incomplete");
  const answeredBy = cleanBounded(record.answeredBy, "answeredBy", BLOCKED_ATTRIBUTION_MAX_LENGTH, "blocked_answer_incomplete");
  return { blockedReportedAt: task.completion.reportedAt, answeredBy };
}

function parseBlockedAcceptanceValue(value: unknown): BlockedAcceptance | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") throw new ConflictRouteError("blocked_acceptance_incomplete", "blockedAcceptance must be an object");
  const record = value as Record<string, unknown>;
  if (record.acceptIncomplete !== true || typeof record.blockedReportedAt !== "number") {
    throw new ConflictRouteError("blocked_acceptance_incomplete", "Blocked acceptance must include acceptIncomplete=true and blockedReportedAt");
  }
  return { acceptIncomplete: true, blockedReportedAt: record.blockedReportedAt };
}

function cleanBounded(value: unknown, field: string, max: number, code: string): string {
  if (typeof value !== "string") throw new ConflictRouteError(code, `${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max) throw new ConflictRouteError(code, `${field} must be 1..${max} characters`);
  return trimmed;
}

async function assertWorktreeDoneMoveResolved(dispatcher: Dispatcher, task: Task): Promise<void> {
  if (task.column === "done") return;
  if (!task.worktreePath) return;

  if (task.runState === "running") {
    throw new ConflictRouteError(
      "worktree_session_running",
      "The task session is still running and may continue writing to its worktree. Stop the session before accepting Done.",
      {
        requirement: {
          transition: "move",
          taskId: task.id,
          action: "stop_session",
        },
      },
    );
  }

  let status: Awaited<ReturnType<Dispatcher["getWorktreeCommitStatus"]>>;
  try {
    if (!task.worktreeBranch) throw new Error("Task worktree branch is unavailable");
    status = await dispatcher.getWorktreeCommitStatus(task.id, undefined);
  } catch {
    throw new ConflictRouteError(
      "worktree_status_unavailable",
      "OpenBoard could not verify that the task worktree is resolved. Restore the worktree and its base reference, or explicitly discard or integrate it before accepting Done.",
      {
        requirement: {
          transition: "move",
          taskId: task.id,
          action: "restore_or_resolve_worktree",
        },
      },
    );
  }
  if (status.committedFiles.length === 0 && status.uncommittedFiles.length === 0) return;

  throw new ConflictRouteError(
    "unintegrated_worktree_changes",
    "Task worktree has unintegrated changes. Integrate the card, commit or discard remaining files, or explicitly resolve the worktree before accepting Done.",
    {
      requirement: {
        transition: "move",
        taskId: task.id,
        committedFiles: status.committedFiles,
        uncommittedFiles: status.uncommittedFiles,
      },
    },
  );
}

function blockedPolicyConflict(code: string, message: string, task: Task, transition: "move" | "integrate"): ConflictRouteError {
  const completion = task.completion;
  return new ConflictRouteError(code, message, completion?.outcome === "blocked" ? {
    requirement: {
      acceptIncomplete: true,
      blockedReportedAt: completion.reportedAt,
      completedBy: "required",
      question: blockedQuestion(completion),
      summary: completion.summary,
      residualRisk: completion.residualRisk,
      transition,
    },
  } : undefined);
}

function blockedAcceptanceEvidence(task: Task, completedBy: string | undefined, transition: "move" | "integrate"): Record<string, unknown> {
  const completion = task.completion;
  return {
    completedBy,
    blockedReportedAt: completion?.reportedAt,
    question: completion ? blockedQuestion(completion) : undefined,
    summary: completion?.summary,
    residualRisk: completion?.residualRisk,
    transition,
  };
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
  if (err instanceof NonDiffableColumnError) {
    return c.json(
      { error: { code: "validation", message: err.message } },
      err.status as ContentfulStatusCode,
    );
  }
  if (err instanceof ConflictRouteError) {
    return c.json({ error: { code: err.code, message: err.message, ...(err.details ?? {}) } }, err.status as ContentfulStatusCode);
  }
  const adapterError = toAdapterError(err);
  return c.json(adapterError.toEnvelope(), adapterError.status as ContentfulStatusCode);
}

/** Normalize any thrown value into an AdapterError, wrapping unexpected errors as internal. */
function toAdapterError(err: unknown): AdapterError {
  if (err instanceof AdapterError) return err;
  return AdapterError.internal("Unexpected error", err);
}
