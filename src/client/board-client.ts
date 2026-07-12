import { stat as defaultStat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type {
  BoardDiagnostics,
  Column,
  CreateTaskInput,
  CompletionReport,
  CompletionSource,
  DiffResponse,
  DominantTaskState,
  FileCommitOutcome,
  MergeOutcome,
  ModelRef,
  AcpConfigCatalog,
  AcpModelCatalog,
  AcpOptions,
  AcpPermissionMode,
  PermissionOverrideAction,
  PermissionOverrideCategory,
  PermissionOverrides,
  BlockedAcceptance,
  BlockedAnswerContext,
  PendingPermissionAsk,
  RespondPermissionInput,
  RosterAgent,
  RosterProvider,
  SessionActivityFrame,
  SessionMessageInput,
  SessionMessageReceipt,
  Task,
  TaskContext,
  TaskHarness,
  TaskKind,
  TaskComment,
  TaskEvent,
  TaskIsolationMode,
  TaskType,
  ClaudeCodePermissionMode,
  UpdateTaskInput,
  WorktreeCommitStatus,
  WorktreeCleanupOutcome,
  BoardHealth,
  TaskCompareResponse,
} from "../shared";
import {
  AUTO_RUN_REQUIREMENT,
  buildTaskPath,
  canAutoRun,
  CLAUDE_CODE_MODEL_PROVIDER,
  CLAUDE_CODE_PERMISSION_MODES,
  CODEX_MODEL_PROVIDER,
  CURSOR_ACP_MODEL_PROVIDER,
  GEMINI_ACP_MODEL_PROVIDER,
  HERMES_MODEL_PROVIDER,
  PERMISSION_OVERRIDE_ACTIONS,
  PERMISSION_OVERRIDE_CATEGORIES,
  PI_CODING_AGENT_MODEL_PROVIDER,
  TASK_HARNESSES,
  TASK_ISOLATION_MODES,
  TASK_KINDS,
  blockedQuestion,
  dominantTaskState,
} from "../shared";

export type { BoardHealth } from "../shared/health";
export type { BoardDiagnostics } from "../shared/diagnostics";

export const DEFAULT_BOARD_URL = "http://127.0.0.1:4097";
export const BOARD_UNAVAILABLE_MESSAGE = "Open OpenBoard first or set OPENCODE_BOARD_URL.";
export const BOARD_URL_REQUIRED_MESSAGE =
  "Select an OpenBoard instance and set OPENCODE_BOARD_URL before using the OpenBoard MCP tools.";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type StatLike = (path: string) => Promise<{ isDirectory(): boolean }>;

export interface BoardClientOptions {
  boardUrl?: string;
  cwd?: string;
  fetch?: FetchLike;
  stat?: StatLike;
  env?: Partial<Pick<NodeJS.ProcessEnv, "OPENCODE_BOARD_URL" | "OPENBOARD_API_TOKEN" | "OPENBOARD_INSTANCE_NAME" | "OPENBOARD_INSTANCE_WORKSPACE" | "OPENBOARD_INSTANCE_DB_PATH" | "OPENBOARD_INSTANCE_PORT" | "OPENBOARD_SELECTION_SOURCE">>;
  requireExplicitBoardUrl?: boolean;
}

/** Compact blocked-information projection surfaced by toTaskSummary. Never contains raw answer text. */
export interface CompactBlockedProjection {
  /** The blocked completion report timestamp. */
  reportedAt: number;
  /** The question the agent asked (extracted from needsInput, residualRisk, or summary fallback). */
  question: string;
  /** The blocked completion report summary. */
  summary: string;
  /** The blocked completion report residual risk. */
  residualRisk: string;
  /** Completion source that produced the blocked report. */
  source: CompletionSource | null;
  /** True when there was a needsInput field explicitly set on the completion report. */
  hasExplicitQuestion?: boolean;
}

export interface TaskSummary {
  id: string;
  type: TaskType;
  taskKind?: TaskKind;
  harness?: TaskHarness;
  title: string;
  directory: string;
  column: Task["column"];
  runState: Task["runState"];
  agent?: string;
  permissionMode?: AcpPermissionMode;
  claudePermissionMode?: ClaudeCodePermissionMode;
  acpOptions?: AcpOptions;
  assignedTo?: string;
  model?: ModelRef;
  /** Fallback model for mid-run provider recovery, stored with the same ModelRef JSON shape as fallbackModel. */
  fallbackModel?: ModelRef | null;
  /** Model currently active for the run, stored with the same ModelRef JSON shape as activeModel. */
  activeModel?: ModelRef | null;
  /** Automatic retry count. Legacy rows hydrate as zero. */
  autoRetries?: number;
  isolation?: TaskIsolationMode;
  /** Unlike permissionOverrides (deliberately not projected), this is chain-planning metadata an orchestrator needs. */
  autoRun?: boolean;
  sessionId?: string;
  harnessSessionId?: string;
  harnessSessionName?: string;
  harnessStatus?: string;
  harnessCwd?: string;
  harnessBranch?: string;
  harnessCommit?: string;
  harnessWarning?: string;
  runStartedAt?: number;
  parentIds?: string[];
  completionLocation?: Task["completionLocation"];
  completedBy?: string | null;
  /** Compact blocked-information projection when the card is blocked. Never contains raw answer text. */
  blocked?: CompactBlockedProjection | null;
  /** Live pending permission asks on this task; empty when none or no broker is live. */
  pendingPermissions: PendingPermissionAsk[];
  /** True when this task has parent dependencies (lineage metadata available). */
  hasParentIds?: boolean;
  /** True when this task has a completion report (handoff evidence available). */
  hasCompletion?: boolean;
  /**
   * Single computed precedence winner from the shared `dominantTaskState`
   * projection (`src/shared/lifecycle.ts`) — the same precedence order the
   * TUI uses to pick a card's displayed state. Raw component fields above
   * (runState, column, completion, pendingPermissions) are preserved
   * unchanged; this is an additive projection, not a replacement.
   */
  dominantState: DominantTaskState;
}

export interface CreateBoardTaskInput {
  type?: TaskType;
  taskKind?: TaskKind;
  harness?: TaskHarness;
  title: string;
  description?: string;
  directory?: string;
  agent?: string;
  permissionMode?: string;
  claudePermissionMode?: string;
  acpOptions?: AcpOptions;
  assignedTo?: string;
  model?: string | ModelRef;
  fallbackModel?: string | ModelRef;
  isolation?: string;
  /** Only valid on worktree-isolated agent tasks. */
  autoRun?: boolean;
  /** Only valid for in-place (non-worktree) OpenCode agent tasks — see resolveOpenCodePermissionRules. */
  permissionOverrides?: PermissionOverrides;
  parentIds?: string[];
}

export type UpdateBoardTaskInput = Omit<
  Partial<CreateBoardTaskInput>,
  "taskKind" | "agent" | "permissionMode" | "claudePermissionMode" | "acpOptions" | "assignedTo" | "model" | "fallbackModel" | "isolation" | "permissionOverrides" | "parentIds"
> & {
  taskKind?: TaskKind | null;
  agent?: string | null;
  permissionMode?: string | null;
  claudePermissionMode?: string | null;
  acpOptions?: AcpOptions | null;
  assignedTo?: string | null;
  model?: string | ModelRef | null;
  fallbackModel?: string | ModelRef | null;
  isolation?: string | null;
  permissionOverrides?: PermissionOverrides | null;
  parentIds?: string[] | null;
};

export type CompletionInput = Omit<CompletionReport, "outcome" | "reportedAt">;
export type CompletionWithOutputInput = CompletionInput & { finalSessionOutput?: string | null };

/** Options for streaming session-activity events via SSE. */
export interface StreamSessionEventsOptions {
  /** Maximum buffered events for backfill (default 200, max 1000). */
  limit?: number;
  /** Resume cursor (the last received event seq) for Last-Event-ID. */
  cursor?: number;
  /** AbortSignal to cancel the stream. */
  signal?: AbortSignal;
  /**
   * Called once when the stream ends for any reason other than an explicit
   * client-side close() — server restart, socket reset, response end. Gives
   * the consumer a liveness signal to reconnect on; without it a dead stream
   * is indistinguishable from a healthy quiet one.
   */
  onEnd?: () => void;
}

/**
 * Callback for session activity frames streamed from the board's SSE endpoint.
 * `gap` frames signal ring-buffer eviction; the client must request historical
 * events or accept data loss. `terminal` frames signal run completion.
 */
export type SessionActivityFrameCallback = (frame: SessionActivityFrame) => void;

/**
 * Result of connecting to the session-events SSE stream.
 * `close()` tears down the connection and the SSE parser.
 */
export interface SessionEventsStream {
  /** Active until close() is called or the stream aborts on its own. */
  readonly active: boolean;
  /** Abort the underlying fetch and close the stream. Idempotent. */
  close(): void;
}

export interface BoardClient {
  readonly boardUrl: string;
  readonly cwd: string;
  listTasks(): Promise<Task[]>;
  listTaskSummaries(): Promise<TaskSummary[]>;
  listAgents(): Promise<RosterAgent[]>;
  listProviders(): Promise<RosterProvider[]>;
  listAcpConfig(): Promise<AcpConfigCatalog>;
  listAcpModels(): Promise<AcpModelCatalog>;
  createTask(input: CreateBoardTaskInput): Promise<Task>;
  createTasks(input: CreateBoardTaskInput[]): Promise<Task[]>;
  updateTask(id: string, input: UpdateBoardTaskInput): Promise<Task>;
  runTask(id: string): Promise<Task>;
  retryTask(id: string, feedback?: string, blockedAnswer?: BlockedAnswerContext): Promise<Task>;
  answerBlockedTask(id: string, answer: string, context: BlockedAnswerContext): Promise<Task>;
  abortTask(id: string): Promise<Task>;
  moveTask(id: string, column: Column, position: number, completedBy?: string | null, blockedAcceptance?: BlockedAcceptance): Promise<Task[]>;
  deleteTask(id: string, options?: { forceWorktree?: boolean; keepWorktree?: boolean }): Promise<{ ok: boolean; message?: string }>;
  initGitAndRun(id: string): Promise<Task>;
  syncTask(id: string): Promise<MergeOutcome>;
  getTaskCommitStatus(id: string, targetBranch?: string): Promise<WorktreeCommitStatus>;
  commitTaskFile(id: string, file: string, message?: string): Promise<FileCommitOutcome>;
  integrateTask(id: string, targetBranch?: string, options?: { commitRemaining?: boolean; blockedAcceptance?: BlockedAcceptance }): Promise<MergeOutcome>;
  discardWorktree(id: string, options?: { force?: boolean }): Promise<WorktreeCleanupOutcome>;
  resolveOrphanWorktree(worktreePath: string): Promise<WorktreeCleanupOutcome>;
  linkTasks(parentId: string, childId: string): Promise<Task>;
  unlinkTasks(parentId: string, childId: string): Promise<Task>;
  completeTask(id: string, report: CompletionWithOutputInput, runStartedAt?: number): Promise<Task>;
  blockTask(id: string, report: CompletionWithOutputInput, runStartedAt?: number): Promise<Task>;
  addComment(id: string, author: string, body: string, parentCommentId?: string | null): Promise<TaskComment>;
  listComments(id: string): Promise<TaskComment[]>;
  listTaskEvents(id: string): Promise<TaskEvent[]>;
  getTaskDiff(id: string): Promise<DiffResponse>;
  /** Compare two cards' durable code evidence via GET /api/tasks/:targetId/compare?baseTaskId=:baseTaskId. */
  getTaskCompare(targetId: string, baseTaskId: string): Promise<TaskCompareResponse>;
  getTaskContext(id: string): Promise<TaskContext>;
  /** Stream live session activity frames for a task via SSE. */
  streamSessionEvents(id: string, onFrame: SessionActivityFrameCallback, options?: StreamSessionEventsOptions): Promise<SessionEventsStream>;
  /**
   * Respond to a pending permission ask on a task. POST /api/tasks/:id/permission
   * returns the shared projected Task on success (see server/routes/permission.ts) —
   * not a RespondPermissionOutcome (that's the dispatcher's internal outcome shape).
   * Non-2xx responses throw via requestJson; callers should catch and inspect the
   * error message for a "(409)" status to detect a stale/already-resolved ask.
   */
  respondPermission(id: string, input: RespondPermissionInput): Promise<Task>;
  /** Send operator-authored chat input to the card's existing harness session. */
  sendSessionMessage(id: string, input: SessionMessageInput): Promise<SessionMessageReceipt>;
  getHealth(): Promise<BoardHealth>;
  getDiagnostics(): Promise<BoardDiagnostics>;
}

interface ResolvedOptions {
  boardUrl: string;
  cwd: string;
  fetch: FetchLike;
  stat: StatLike;
  boardToken?: string;
}

const VALID_ISOLATION = new Set<TaskIsolationMode>(TASK_ISOLATION_MODES);
const VALID_HARNESS = new Set<TaskHarness>(TASK_HARNESSES);
const VALID_TASK_KIND = new Set<TaskKind>(TASK_KINDS);
const VALID_CLAUDE_PERMISSION_MODE = new Set<ClaudeCodePermissionMode>(CLAUDE_CODE_PERMISSION_MODES);
const VALID_PERMISSION_OVERRIDE_CATEGORY = new Set<PermissionOverrideCategory>(PERMISSION_OVERRIDE_CATEGORIES);
const VALID_PERMISSION_OVERRIDE_ACTION = new Set<PermissionOverrideAction>(PERMISSION_OVERRIDE_ACTIONS);

function harnessList(): string {
  return TASK_HARNESSES.join(", ");
}

function modelProviderForHarness(harness: TaskHarness | undefined): string | null {
  switch (harness) {
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
    default:
      return null;
  }
}

function normalizePermissionOverrides(overrides: PermissionOverrides): PermissionOverrides {
  const result: PermissionOverrides = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (!VALID_PERMISSION_OVERRIDE_CATEGORY.has(key as PermissionOverrideCategory)) {
      throw new Error(`permissionOverrides key must be one of: ${PERMISSION_OVERRIDE_CATEGORIES.join(", ")}`);
    }
    if (!VALID_PERMISSION_OVERRIDE_ACTION.has(value as PermissionOverrideAction)) {
      throw new Error(`permissionOverrides.${key} must be one of: ${PERMISSION_OVERRIDE_ACTIONS.join(", ")}`);
    }
    result[key as PermissionOverrideCategory] = value as PermissionOverrideAction;
  }
  return result;
}

function normalizeAcpOptions(options: AcpOptions): AcpOptions {
  const result: AcpOptions = {};
  for (const [key, value] of Object.entries(options)) {
    if (!key.trim()) throw new Error("acpOptions keys must be non-empty strings");
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error("acpOptions values must be strings, numbers, or booleans");
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("acpOptions number values must be finite");
    }
    result[key] = value;
  }
  return result;
}

export function createBoardClient(options: BoardClientOptions = {}): BoardClient {
  const resolved = resolveOptions(options);

  return {
    boardUrl: resolved.boardUrl,
    cwd: resolved.cwd,
    listTasks: () => requestJson<Task[]>(resolved, buildTaskPath.list(), { method: "GET" }),
    listTaskSummaries: async () => {
      const tasks = await requestJson<Task[]>(resolved, buildTaskPath.list(), { method: "GET" });
      return tasks.map(toTaskSummary);
    },
    listAgents: () => requestJson<RosterAgent[]>(resolved, "/api/agents", { method: "GET" }),
    listProviders: () => requestJson<RosterProvider[]>(resolved, "/api/providers", { method: "GET" }),
    listAcpConfig: () => requestJson<AcpConfigCatalog>(resolved, "/api/acp-config", { method: "GET" }),
    listAcpModels: () => requestJson<AcpModelCatalog>(resolved, "/api/acp-models", { method: "GET" }),
    createTask: async (input) => {
      const task = normalizeTaskInput(input, resolved.cwd);
      await assertExistingDirectory(task.directory, resolved.stat);
      return postJson<Task>(resolved, buildTaskPath.list(), task);
    },
    createTasks: async (input) => {
      const tasks = input.map((task) => normalizeTaskInput(task, resolved.cwd));
      for (const task of tasks) {
        await assertExistingDirectory(task.directory, resolved.stat);
      }

      const created: Task[] = [];
      for (const task of tasks) {
        created.push(await postJson<Task>(resolved, buildTaskPath.list(), task));
      }
      return created;
    },
    updateTask: async (id, input) => {
      const task = normalizeUpdateTaskInput(input, resolved.cwd);
      if (task.directory !== undefined) await assertExistingDirectory(task.directory, resolved.stat);
      return requestJson<Task>(resolved, buildTaskPath.update(id), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(task),
      });
    },
    runTask: (id) => postJson<Task>(resolved, buildTaskPath.run(id), {}),
    retryTask: (id, feedback, blockedAnswer) =>
      postJson<Task>(resolved, buildTaskPath.retry(id), { ...(feedback === undefined ? {} : { feedback }), ...(blockedAnswer === undefined ? {} : { blockedAnswer }) }),
    answerBlockedTask: (id, answer, context) =>
      postJson<Task>(resolved, buildTaskPath.retry(id), { feedback: answer, blockedAnswer: context }),
    abortTask: (id) => postJson<Task>(resolved, buildTaskPath.abort(id), {}),
    moveTask: (id, column, position, completedBy, blockedAcceptance) => {
      const body: { column: Column; position: number; completedBy?: string | null; blockedAcceptance?: BlockedAcceptance } = { column, position };
      if (completedBy !== undefined) body.completedBy = completedBy;
      if (blockedAcceptance !== undefined) body.blockedAcceptance = blockedAcceptance;
      return postJson<Task[]>(resolved, buildTaskPath.move(id), body);
    },
    deleteTask: (id, options) => {
      const params = new URLSearchParams();
      if (options?.forceWorktree) params.set("forceWorktree", "true");
      if (options?.keepWorktree) params.set("keepWorktree", "true");
      const suffix = params.toString();
      return requestJson<{ ok: boolean; message?: string }>(
        resolved,
        `${buildTaskPath.remove(id)}${suffix ? `?${suffix}` : ""}`,
        { method: "DELETE" },
      );
    },
    initGitAndRun: (id) => postJson<Task>(resolved, buildTaskPath.initGit(id), {}),
    syncTask: (id) => postJson<MergeOutcome>(resolved, buildTaskPath.sync(id), {}),
    getTaskCommitStatus: (id, targetBranch) => {
      const params = new URLSearchParams();
      if (targetBranch) params.set("targetBranch", targetBranch);
      const suffix = params.toString();
      return requestJson<WorktreeCommitStatus>(
        resolved,
        `${buildTaskPath.commitStatus(id)}${suffix ? `?${suffix}` : ""}`,
        { method: "GET" },
      );
    },
    commitTaskFile: (id, file, message) =>
      postJson<FileCommitOutcome>(
        resolved,
        buildTaskPath.commitFile(id),
        { file, ...(message !== undefined ? { message } : {}) },
      ),
    integrateTask: (id, targetBranch, options) =>
      postJson<MergeOutcome>(
        resolved,
        buildTaskPath.integrate(id),
        {
          ...(targetBranch === undefined ? {} : { targetBranch }),
          ...(options?.commitRemaining ? { commitRemaining: true } : {}),
          ...(options?.blockedAcceptance === undefined ? {} : { blockedAcceptance: options.blockedAcceptance }),
        },
      ),
    discardWorktree: (id, options) =>
      postJson<WorktreeCleanupOutcome>(resolved, buildTaskPath.discardWorktree(id), options ?? {}),
    resolveOrphanWorktree: (worktreePath) =>
      postJson<WorktreeCleanupOutcome>(resolved, "/api/worktrees/orphans/resolve", { worktreePath }),
    linkTasks: (parentId, childId) => postJson<Task>(resolved, buildTaskPath.links(childId), { parentId }),
    unlinkTasks: (parentId, childId) =>
      requestJson<Task>(resolved, buildTaskPath.unlink(childId, parentId), {
        method: "DELETE",
      }),
    completeTask: (id, report, runStartedAt) =>
      postJson<Task>(resolved, withRunStartedAt(`/api/tasks/${encodeURIComponent(id)}/complete`, runStartedAt), report),
    blockTask: (id, report, runStartedAt) =>
      postJson<Task>(resolved, withRunStartedAt(`/api/tasks/${encodeURIComponent(id)}/block`, runStartedAt), report),
    addComment: (id, author, body, parentCommentId) => postJson<TaskComment>(resolved, buildTaskPath.comments(id), { author, body, ...(parentCommentId !== undefined ? { parentCommentId } : {}) }),
    listComments: (id) => requestJson<TaskComment[]>(resolved, buildTaskPath.comments(id), { method: "GET" }),
    listTaskEvents: (id) => requestJson<TaskEvent[]>(resolved, buildTaskPath.taskEvents(id), { method: "GET" }),
    getTaskDiff: (id) => requestJson<DiffResponse>(resolved, buildTaskPath.diff(id), { method: "GET" }),
    getTaskCompare: (targetId, baseTaskId) =>
      requestJson<TaskCompareResponse>(resolved, buildTaskPath.compare(targetId, baseTaskId), { method: "GET" }),
    getTaskContext: (id) => requestJson<TaskContext>(resolved, buildTaskPath.context(id), { method: "GET" }),
    streamSessionEvents: (id, onFrame, options) => streamSessionEvents(resolved, id, onFrame, options),
    respondPermission: (id, input) =>
      postJson<Task>(resolved, buildTaskPath.permissionReply(id), input),
    sendSessionMessage: (id, input) =>
      postJson<SessionMessageReceipt>(resolved, buildTaskPath.sessionMessages(id), input),
    getHealth: () => requestJson<BoardHealth>(resolved, "/api/health", { method: "GET" }),
    getDiagnostics: () => requestJson<BoardDiagnostics>(resolved, "/api/diagnostics", { method: "GET" }),
  };
}

function normalizeUpdateTaskInput(task: UpdateBoardTaskInput, cwd: string): UpdateTaskInput {
  const payload: UpdateTaskInput = {};
  if (task.type !== undefined) payload.type = task.type;
  if (task.taskKind !== undefined) {
    if (task.taskKind !== null && !VALID_TASK_KIND.has(task.taskKind as TaskKind)) {
      throw new Error(`taskKind must be one of: ${TASK_KINDS.join(", ")}`);
    }
    payload.taskKind = task.taskKind as TaskKind | null;
  }
  if (task.harness !== undefined) {
    if (!VALID_HARNESS.has(task.harness)) throw new Error(`harness must be one of: ${harnessList()}`);
    payload.harness = task.harness;
  }
  if (task.title !== undefined) {
    const title = task.title.trim();
    if (!title) throw new Error("title must be a non-empty string");
    payload.title = title;
  }
  if (task.description !== undefined) payload.description = task.description;
  if (task.directory !== undefined) payload.directory = resolveTaskDirectory(task.directory, cwd);
  if (task.agent !== undefined) payload.agent = typeof task.agent === "string" ? task.agent.trim() || null : null;
  if (task.assignedTo !== undefined) payload.assignedTo = typeof task.assignedTo === "string" ? task.assignedTo.trim() || null : null;
  if (task.claudePermissionMode !== undefined) {
    if (task.claudePermissionMode !== null && !VALID_CLAUDE_PERMISSION_MODE.has(task.claudePermissionMode as ClaudeCodePermissionMode)) {
      throw new Error("claudePermissionMode must be a supported Claude Code permission mode");
    }
    payload.claudePermissionMode = task.claudePermissionMode as ClaudeCodePermissionMode | null;
  }
  if (task.permissionMode !== undefined) {
    if (task.permissionMode !== null && !VALID_CLAUDE_PERMISSION_MODE.has(task.permissionMode as AcpPermissionMode)) {
      throw new Error("permissionMode must be a supported ACP permission mode");
    }
    payload.permissionMode = task.permissionMode as AcpPermissionMode | null;
  }
  if (task.acpOptions !== undefined) {
    payload.acpOptions = task.acpOptions === null ? null : normalizeAcpOptions(task.acpOptions);
  }
  if (task.model !== undefined) payload.model = task.model === null ? null : typeof task.model === "string" ? parseModelRef(task.model) : task.model;
  if (task.fallbackModel !== undefined) payload.fallbackModel = task.fallbackModel === null ? null : typeof task.fallbackModel === "string" ? parseModelRef(task.fallbackModel) : task.fallbackModel;
  if (task.isolation !== undefined) {
    if (task.isolation !== null && !VALID_ISOLATION.has(task.isolation as TaskIsolationMode)) throw new Error("isolation must be 'worktree' or 'in-place'");
    payload.isolation = task.isolation as TaskIsolationMode | null;
  }
  if (task.autoRun !== undefined) {
    if (typeof task.autoRun !== "boolean") throw new Error("autoRun must be a boolean");
    payload.autoRun = task.autoRun;
  }
  if (task.permissionOverrides !== undefined) {
    payload.permissionOverrides = task.permissionOverrides === null ? null : normalizePermissionOverrides(task.permissionOverrides);
  }
  if (task.parentIds !== undefined) payload.parentIds = task.parentIds === null ? null : normalizeParentIds(task.parentIds);
  return payload;
}

export function resolveBoardUrl(options: BoardClientOptions = {}): string {
  const raw =
    options.boardUrl ??
    (options.env === undefined ? process.env.OPENCODE_BOARD_URL : options.env.OPENCODE_BOARD_URL);
  if (options.requireExplicitBoardUrl && !raw?.trim()) {
    throw new Error(BOARD_URL_REQUIRED_MESSAGE);
  }
  const candidate = raw?.trim() || DEFAULT_BOARD_URL;
  const url = new URL(candidate);
  return url.toString().replace(/\/$/, "");
}

export function parseModelRef(model: string): ModelRef {
  const trimmed = model.trim();
  const slash = trimmed.indexOf("/");
  const providerID = slash > 0 ? trimmed.slice(0, slash).trim() : "";
  const id = slash > 0 ? trimmed.slice(slash + 1).trim() : "";

  if (!providerID || !id || id.split("/").some((segment) => segment.trim().length === 0)) {
    throw new Error('model must use "provider/model-id"');
  }

  return { providerID, id };
}

export function toTaskSummary(task: Task): TaskSummary {
  const blocked = task.completion?.outcome === "blocked"
    ? {
        reportedAt: task.completion.reportedAt,
        question: blockedQuestion(task.completion),
        summary: task.completion.summary,
        residualRisk: task.completion.residualRisk,
        source: task.completionSource ?? null,
        ...(task.completion.needsInput?.trim() ? { hasExplicitQuestion: true } : {}),
      }
    : null;

  const hasParentIds = Boolean(task.parentIds && task.parentIds.length > 0);
  const hasCompletion = task.completion !== null && task.completion !== undefined;

  return {
    id: task.id,
    type: task.type ?? "agent",
    ...(task.taskKind != null ? { taskKind: task.taskKind } : {}),
    ...(task.harness !== undefined ? { harness: task.harness } : {}),
    title: task.title,
    directory: task.directory,
    column: task.column,
    runState: task.runState,
    ...(task.agent != null ? { agent: task.agent } : {}),
    ...(task.permissionMode != null ? { permissionMode: task.permissionMode } : {}),
    ...(task.claudePermissionMode != null ? { claudePermissionMode: task.claudePermissionMode } : {}),
    ...(task.acpOptions != null ? { acpOptions: task.acpOptions } : {}),
    ...(task.assignedTo != null ? { assignedTo: task.assignedTo } : {}),
    ...(task.model != null ? { model: task.model } : {}),
    ...(task.fallbackModel != null ? { fallbackModel: task.fallbackModel } : {}),
    ...(task.activeModel != null ? { activeModel: task.activeModel } : {}),
    ...(task.autoRetries != null ? { autoRetries: task.autoRetries } : {}),
    ...(task.isolation != null ? { isolation: task.isolation } : {}),
    ...(task.autoRun !== undefined ? { autoRun: task.autoRun } : {}),
    ...(task.sessionId !== undefined ? { sessionId: task.sessionId } : {}),
    ...(task.harnessSessionId !== undefined ? { harnessSessionId: task.harnessSessionId } : {}),
    ...(task.harnessSessionName !== undefined ? { harnessSessionName: task.harnessSessionName } : {}),
    ...(task.harnessStatus !== undefined ? { harnessStatus: task.harnessStatus } : {}),
    ...(task.harnessCwd !== undefined ? { harnessCwd: task.harnessCwd } : {}),
    ...(task.harnessBranch !== undefined ? { harnessBranch: task.harnessBranch } : {}),
    ...(task.harnessCommit !== undefined ? { harnessCommit: task.harnessCommit } : {}),
    ...(task.harnessWarning !== undefined ? { harnessWarning: task.harnessWarning } : {}),
    ...(task.runStartedAt !== undefined ? { runStartedAt: task.runStartedAt } : {}),
    ...(task.parentIds !== undefined ? { parentIds: task.parentIds } : {}),
    ...(task.completionLocation !== undefined ? { completionLocation: task.completionLocation } : {}),
    ...(task.completedBy !== undefined ? { completedBy: task.completedBy } : {}),
    ...(blocked !== null ? { blocked } : {}),
    pendingPermissions: task.pendingPermissions ?? [],
    ...(hasParentIds ? { hasParentIds: true } : {}),
    ...(hasCompletion ? { hasCompletion: true } : {}),
    dominantState: dominantTaskState(task),
  };
}

function withRunStartedAt(path: string, runStartedAt: number | undefined): string {
  return runStartedAt === undefined ? path : `${path}?runStartedAt=${encodeURIComponent(String(runStartedAt))}`;
}

function resolveOptions(options: BoardClientOptions): ResolvedOptions {
  return {
    boardUrl: resolveBoardUrl(options),
    cwd: resolve(options.cwd ?? process.cwd()),
    fetch: options.fetch ?? fetch,
    stat: options.stat ?? defaultStat,
    boardToken: (options.env?.OPENBOARD_API_TOKEN ?? process.env.OPENBOARD_API_TOKEN)?.trim() || undefined,
  };
}

function normalizeTaskInput(task: CreateBoardTaskInput, cwd: string): CreateTaskInput {
  const title = task.title.trim();
  if (title.length === 0) {
    throw new Error("title must be a non-empty string");
  }
  if (task.taskKind !== undefined && !VALID_TASK_KIND.has(task.taskKind as TaskKind)) {
    throw new Error(`taskKind must be one of: ${TASK_KINDS.join(", ")}`);
  }

  const directory = resolveTaskDirectory(task.directory, cwd);
  const payload: CreateTaskInput = {
    type: task.type ?? "agent",
    title,
    description: task.description ?? "",
    directory,
  };
  if (task.taskKind !== undefined) payload.taskKind = task.taskKind;
  if (payload.type === "agent" && task.harness !== undefined) {
    if (!VALID_HARNESS.has(task.harness)) {
      throw new Error(`harness must be one of: ${harnessList()}`);
    }
    payload.harness = task.harness;
  }

  const agent = task.agent?.trim();
  if (payload.type === "agent" && (payload.harness === undefined || payload.harness === "opencode") && agent) payload.agent = agent;

  const claudePermissionMode = task.claudePermissionMode?.trim();
  if (claudePermissionMode) {
    if (payload.type !== "agent" || payload.harness !== "claude-code") {
      throw new Error("claudePermissionMode can only be set for claude-code agent tasks");
    }
    if (!VALID_CLAUDE_PERMISSION_MODE.has(claudePermissionMode as ClaudeCodePermissionMode)) {
      throw new Error("claudePermissionMode must be a supported Claude Code permission mode");
    }
    payload.claudePermissionMode = claudePermissionMode as ClaudeCodePermissionMode;
  }

  const permissionMode = task.permissionMode?.trim();
  if (permissionMode) {
    if (payload.type !== "agent" || payload.harness === undefined || payload.harness === "opencode") {
      throw new Error("permissionMode can only be set for ACP agent tasks");
    }
    if (!VALID_CLAUDE_PERMISSION_MODE.has(permissionMode as AcpPermissionMode)) {
      throw new Error("permissionMode must be a supported ACP permission mode");
    }
    payload.permissionMode = permissionMode as AcpPermissionMode;
  }

  if (payload.permissionMode && payload.claudePermissionMode && payload.permissionMode !== payload.claudePermissionMode) {
    throw new Error("permissionMode and claudePermissionMode must match when both are provided");
  }

  if (task.acpOptions !== undefined) {
    if (payload.type !== "agent" || payload.harness === undefined || payload.harness === "opencode") {
      throw new Error("acpOptions can only be set for ACP agent tasks");
    }
    payload.acpOptions = normalizeAcpOptions(task.acpOptions);
  }

  const assignedTo = task.assignedTo?.trim();
  if (payload.type === "manual" && assignedTo) payload.assignedTo = assignedTo;

  if (payload.type === "agent" && task.model !== undefined) {
    const model = typeof task.model === "string" ? parseModelRef(task.model) : task.model;
    const expectedProvider = modelProviderForHarness(payload.harness);
    if (expectedProvider && model.providerID !== expectedProvider) {
      throw new Error(`${payload.harness} task model must use "${expectedProvider}/model-id"`);
    }
    payload.model = model;
  }

  if (payload.type === "agent" && task.fallbackModel !== undefined) {
    const fallbackModel = typeof task.fallbackModel === "string" ? parseModelRef(task.fallbackModel) : task.fallbackModel;
    payload.fallbackModel = fallbackModel;
  }

  if (payload.type === "agent" && task.isolation !== undefined) {
    if (!VALID_ISOLATION.has(task.isolation as TaskIsolationMode)) {
      throw new Error("isolation must be 'worktree' or 'in-place'");
    }
    payload.isolation = task.isolation as TaskIsolationMode;
  }

  if (task.permissionOverrides !== undefined) {
    if (payload.type !== "agent" || (payload.harness !== undefined && payload.harness !== "opencode") || payload.isolation !== "in-place") {
      throw new Error("permissionOverrides can only be set for in-place OpenCode agent tasks");
    }
    payload.permissionOverrides = normalizePermissionOverrides(task.permissionOverrides);
  }

  // Evaluated after permissionOverrides lands on the payload — the fenced
  // in-place shape (edit+bash denied) is part of what canAutoRun checks.
  if (task.autoRun !== undefined) {
    if (typeof task.autoRun !== "boolean") throw new Error("autoRun must be a boolean");
    if (task.autoRun === true && !canAutoRun(payload)) {
      throw new Error(AUTO_RUN_REQUIREMENT);
    }
    payload.autoRun = task.autoRun;
  }

  if (task.parentIds !== undefined) payload.parentIds = normalizeParentIds(task.parentIds);

  return payload;
}

function normalizeParentIds(parentIds: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of parentIds) {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function resolveTaskDirectory(directory: string | undefined, cwd: string): string {
  if (directory === undefined) return cwd;

  const trimmed = directory.trim();
  if (trimmed.length === 0) {
    throw new Error("directory must be a non-empty string");
  }

  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
}

async function assertExistingDirectory(directory: string, stat: StatLike): Promise<void> {
  let info: { isDirectory(): boolean };
  try {
    info = await stat(directory);
  } catch {
    throw new Error(`directory does not exist: ${directory}`);
  }

  if (!info.isDirectory()) {
    throw new Error(`directory is not a directory: ${directory}`);
  }
}

async function postJson<T>(options: ResolvedOptions, path: string, body: unknown): Promise<T> {
  return requestJson<T>(options, path, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(options) },
    body: JSON.stringify(body),
  });
}

async function requestJson<T>(options: ResolvedOptions, path: string, init: RequestInit): Promise<T> {
  const tokenHeaders = authHeaders(options);
  const existingHeaders = init.headers as Record<string, string> | undefined;
  const headers = tokenHeaders.Authorization
    ? { ...existingHeaders, ...tokenHeaders }
    : (existingHeaders ?? undefined);
  let response: Response;
  try {
    response = await options.fetch(`${options.boardUrl}${path}`, {
      ...init,
      ...(headers !== undefined ? { headers } : {}),
    });
  } catch {
    throw new Error(BOARD_UNAVAILABLE_MESSAGE);
  }

  if (!response.ok) {
    const detail = await safeResponseText(response);
    const suffix = detail ? `: ${detail}` : "";
    throw new Error(`OpenBoard request failed (${response.status})${suffix}`);
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new Error("OpenBoard returned invalid JSON");
  }
}

function authHeaders(options: ResolvedOptions): Record<string, string> {
  if (!options.boardToken) return {};
  return { Authorization: `Bearer ${options.boardToken}` };
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}

/**
 * Connect to the board's session-events SSE endpoint and stream parsed
 * SessionActivityFrame objects to `onFrame`.
 *
 * Handles arbitrary chunk boundaries, UTF-8 decoding, CRLF/LF line endings,
 * multi-line data fields, resume via Last-Event-ID, and abort via the
 * provided AbortSignal.
 */
async function streamSessionEvents(
  resolved: ResolvedOptions,
  taskId: string,
  onFrame: SessionActivityFrameCallback,
  options?: StreamSessionEventsOptions,
): Promise<SessionEventsStream> {
  const limit = Math.min(Math.max(options?.limit ?? 200, 1), 1000);
  const cursor = options?.cursor ?? 0;

  const params = new URLSearchParams();
  params.set("limit", String(limit));
  if (resolved.boardToken) {
    params.set("board_token", resolved.boardToken);
  }

  const url = `${resolved.boardUrl}${buildTaskPath.sessionEvents(taskId)}?${params.toString()}`;

  const headers: Record<string, string> = {
    Accept: "text/event-stream",
  };
  if (cursor > 0) {
    headers["Last-Event-ID"] = String(cursor);
  }
  // Also send auth via Authorization header for non-query-param setups.
  if (resolved.boardToken) {
    headers["Authorization"] = `Bearer ${resolved.boardToken}`;
  }

  const signal = options?.signal;

  let response: Response;
  try {
    response = await resolved.fetch(url, {
      method: "GET",
      headers,
      signal,
    });
  } catch (err) {
    if (signal?.aborted) {
      throw new Error("Session events stream aborted before connecting");
    }
    throw new Error(BOARD_UNAVAILABLE_MESSAGE);
  }

  if (!response.ok) {
    const detail = await safeResponseText(response);
    const suffix = detail ? `: ${detail}` : "";
    throw new Error(`Session events stream request failed (${response.status})${suffix}`);
  }

  const body = response.body;
  if (!body) {
    throw new Error("Session events stream response has no readable body");
  }

  let active = true;
  let closed = false;
  let closedByClient = false;
  const decoder = new TextDecoder("utf-8");

  // SSE line-buffer: accumulated partial line bytes across chunk boundaries.
  let lineBuffer = "";
  // SSE data buffer: accumulated data lines for the current event.
  const dataLines: string[] = [];
  let eventType = "";

  function emitEvent(): void {
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    dataLines.length = 0;

    try {
      const frame = JSON.parse(data) as SessionActivityFrame;
      if (!closed) {
        onFrame(frame);
      }
    } catch {
      // Malformed frame — skip without breaking the stream.
    }
    eventType = "";
  }

  const reader = body.getReader();

  // Start the read loop in the background.
  void (async () => {
    try {
      while (active) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } catch {
          break; // Stream cancelled/errored — reader rejects.
        }

        if (result.done) break;

        const chunk = decoder.decode(result.value, { stream: true });
        lineBuffer += chunk;

        // Split on any CRLF or LF boundary, handling both.
        const lines = lineBuffer.split(/\r?\n/);
        // The last element is a partial line — keep it in the buffer.
        lineBuffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!active) break;

          if (line.startsWith(":")) {
            // SSE comment — ignore.
            continue;
          }

          if (line.startsWith("event:")) {
            eventType = line.slice(6).trim();
            continue;
          }

          if (line.startsWith("data:")) {
            // Leading single space after "data:" is optional per SSE spec.
            let data = line.slice(5);
            if (data.startsWith(" ")) data = data.slice(1);
            dataLines.push(data);
            continue;
          }

          // Empty line signals end of event.
          if (line.trim() === "") {
            emitEvent();
          }
        }
      }

      // Flush any remaining partial data after the stream ends.
      if (lineBuffer.trim()) {
        dataLines.push(lineBuffer);
        lineBuffer = "";
      }
      emitEvent();

      closed = true;
      active = false;
    } catch {
      // Stream aborted or errored — clean up silently.
      active = false;
      closed = true;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Reader may already be released.
      }
      if (!closedByClient) {
        try {
          options?.onEnd?.();
        } catch {
          // Consumer callback failures must not become unhandled rejections.
        }
      }
    }
  })();

  return {
    get active() {
      return active;
    },
    close() {
      active = false;
      closed = true;
      closedByClient = true;
      try {
        // reader.cancel() returns a promise that can reject asynchronously
        // (e.g. cancelling a reader whose stream already errored). The TUI
        // installs a fatal unhandledRejection handler that exits the process,
        // so the rejection must be consumed here — a bare try/catch only
        // covers the synchronous throw.
        void reader.cancel().catch(() => {
          // Reader may already be closed/errored — benign during teardown.
        });
      } catch {
        // Reader may already be released.
      }
    },
  };
}
