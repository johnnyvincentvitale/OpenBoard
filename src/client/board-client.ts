import { stat as defaultStat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type {
  BoardSettings,
  Column,
  CreateTaskInput,
  CompletionReport,
  MergeOutcome,
  ModelRef,
  RosterAgent,
  Task,
  TaskHarness,
  TaskComment,
  TaskEvent,
  TaskIsolationMode,
  TaskType,
  ClaudeCodePermissionMode,
  UpdateTaskInput,
} from "../shared";
import { buildTaskPath, CLAUDE_CODE_MODEL_PROVIDER, CLAUDE_CODE_PERMISSION_MODES, TASK_HARNESSES, TASK_ISOLATION_MODES } from "../shared";

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
  env?: Partial<Pick<NodeJS.ProcessEnv, "OPENCODE_BOARD_URL" | "OPENBOARD_API_TOKEN" | "OPENBOARD_INSTANCE_NAME" | "OPENBOARD_INSTANCE_WORKSPACE" | "OPENBOARD_INSTANCE_DB_PATH" | "OPENBOARD_SELECTION_SOURCE">>;
  requireExplicitBoardUrl?: boolean;
}

export interface TaskSummary {
  id: string;
  type: TaskType;
  harness?: TaskHarness;
  title: string;
  directory: string;
  column: Task["column"];
  runState: Task["runState"];
  agent?: string;
  claudePermissionMode?: ClaudeCodePermissionMode;
  assignedTo?: string;
  model?: ModelRef;
  isolation?: TaskIsolationMode;
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
}

export interface CreateBoardTaskInput {
  type?: TaskType;
  harness?: TaskHarness;
  title: string;
  description?: string;
  directory?: string;
  agent?: string;
  claudePermissionMode?: string;
  assignedTo?: string;
  model?: string | ModelRef;
  isolation?: string;
}

export type UpdateBoardTaskInput = Partial<Omit<CreateBoardTaskInput, "model">> & {
  agent?: string | null;
  claudePermissionMode?: string | null;
  assignedTo?: string | null;
  model?: string | ModelRef | null;
  isolation?: string | null;
};

/** GET /api/health response — adapter + OpenCode reachability and version. */
export interface BoardIdentity {
  instanceName?: string;
  boardUrl: string;
  port: number;
  workspace: string;
  dbPath: string;
  boardTokenPresent: boolean;
}

export interface BoardHealth {
  adapter: "ok";
  opencode: { status: "ok"; version: string } | { status: "unreachable" };
  identity?: BoardIdentity;
}

export type CompletionInput = Omit<CompletionReport, "outcome" | "reportedAt">;
export type CompletionWithOutputInput = CompletionInput & { finalSessionOutput?: string | null };

export interface BoardClient {
  readonly boardUrl: string;
  readonly cwd: string;
  listTasks(): Promise<Task[]>;
  listTaskSummaries(): Promise<TaskSummary[]>;
  listAgents(): Promise<RosterAgent[]>;
  createTask(input: CreateBoardTaskInput): Promise<Task>;
  createTasks(input: CreateBoardTaskInput[]): Promise<Task[]>;
  updateTask(id: string, input: UpdateBoardTaskInput): Promise<Task>;
  runTask(id: string): Promise<Task>;
  retryTask(id: string, feedback?: string): Promise<Task>;
  abortTask(id: string): Promise<Task>;
  moveTask(id: string, column: Column, position: number, completedBy?: string | null): Promise<Task[]>;
  deleteTask(id: string): Promise<{ ok: true }>;
  initGitAndRun(id: string): Promise<Task>;
  syncTask(id: string): Promise<MergeOutcome>;
  integrateTask(id: string, targetBranch?: string): Promise<MergeOutcome>;
  linkTasks(parentId: string, childId: string): Promise<Task>;
  unlinkTasks(parentId: string, childId: string): Promise<Task>;
  completeTask(id: string, report: CompletionWithOutputInput, runStartedAt?: number): Promise<Task>;
  blockTask(id: string, report: CompletionWithOutputInput, runStartedAt?: number): Promise<Task>;
  addComment(id: string, author: string, body: string, parentCommentId?: string | null): Promise<TaskComment>;
  listComments(id: string): Promise<TaskComment[]>;
  listTaskEvents(id: string): Promise<TaskEvent[]>;
  getSettings(): Promise<BoardSettings>;
  updateSettings(patch: Pick<BoardSettings, "worktreeDefault">): Promise<BoardSettings>;
  getHealth(): Promise<BoardHealth>;
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
const VALID_CLAUDE_PERMISSION_MODE = new Set<ClaudeCodePermissionMode>(CLAUDE_CODE_PERMISSION_MODES);

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
    retryTask: (id, feedback) =>
      postJson<Task>(resolved, buildTaskPath.retry(id), feedback === undefined ? {} : { feedback }),
    abortTask: (id) => postJson<Task>(resolved, buildTaskPath.abort(id), {}),
    moveTask: (id, column, position, completedBy) => {
      const body: { column: Column; position: number; completedBy?: string | null } = { column, position };
      if (completedBy !== undefined) body.completedBy = completedBy;
      return postJson<Task[]>(resolved, buildTaskPath.move(id), body);
    },
    deleteTask: (id) =>
      requestJson<{ ok: true }>(resolved, buildTaskPath.remove(id), { method: "DELETE" }),
    initGitAndRun: (id) => postJson<Task>(resolved, buildTaskPath.initGit(id), {}),
    syncTask: (id) => postJson<MergeOutcome>(resolved, buildTaskPath.sync(id), {}),
    integrateTask: (id, targetBranch) =>
      postJson<MergeOutcome>(
        resolved,
        buildTaskPath.integrate(id),
        targetBranch === undefined ? {} : { targetBranch },
      ),
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
    getSettings: () => requestJson<BoardSettings>(resolved, buildTaskPath.settings(), { method: "GET" }),
    updateSettings: (patch) =>
      requestJson<BoardSettings>(resolved, buildTaskPath.settings(), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }),
    getHealth: () => requestJson<BoardHealth>(resolved, "/api/health", { method: "GET" }),
  };
}

function normalizeUpdateTaskInput(task: UpdateBoardTaskInput, cwd: string): UpdateTaskInput {
  const payload: UpdateTaskInput = {};
  if (task.type !== undefined) payload.type = task.type;
  if (task.harness !== undefined) {
    if (!VALID_HARNESS.has(task.harness)) throw new Error("harness must be 'opencode' or 'claude-code'");
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
  if (task.model !== undefined) payload.model = task.model === null ? null : typeof task.model === "string" ? parseModelRef(task.model) : task.model;
  if (task.isolation !== undefined) {
    if (task.isolation !== null && !VALID_ISOLATION.has(task.isolation as TaskIsolationMode)) throw new Error("isolation must be 'worktree' or 'in-place'");
    payload.isolation = task.isolation as TaskIsolationMode | null;
  }
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
  const parts = trimmed.split("/");

  if (parts.length !== 2 || parts[0].trim().length === 0 || parts[1].trim().length === 0) {
    throw new Error('model must use "provider/model-id"');
  }

  return { providerID: parts[0].trim(), id: parts[1].trim() };
}

export function toTaskSummary(task: Task): TaskSummary {
  return {
    id: task.id,
    type: task.type ?? "agent",
    ...(task.harness !== undefined ? { harness: task.harness } : {}),
    title: task.title,
    directory: task.directory,
    column: task.column,
    runState: task.runState,
    ...(task.agent != null ? { agent: task.agent } : {}),
    ...(task.claudePermissionMode != null ? { claudePermissionMode: task.claudePermissionMode } : {}),
    ...(task.assignedTo != null ? { assignedTo: task.assignedTo } : {}),
    ...(task.model != null ? { model: task.model } : {}),
    ...(task.isolation != null ? { isolation: task.isolation } : {}),
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

  const directory = resolveTaskDirectory(task.directory, cwd);
  const payload: CreateTaskInput = {
    type: task.type ?? "agent",
    title,
    description: task.description ?? "",
    directory,
  };
  if (payload.type === "agent" && task.harness !== undefined) {
    if (!VALID_HARNESS.has(task.harness)) {
      throw new Error("harness must be 'opencode' or 'claude-code'");
    }
    payload.harness = task.harness;
  }

  const agent = task.agent?.trim();
  if (payload.type === "agent" && payload.harness !== "claude-code" && agent) payload.agent = agent;

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

  const assignedTo = task.assignedTo?.trim();
  if (payload.type === "manual" && assignedTo) payload.assignedTo = assignedTo;

  if (payload.type === "agent" && task.model !== undefined) {
    const model = typeof task.model === "string" ? parseModelRef(task.model) : task.model;
    if (payload.harness === "claude-code" && model.providerID !== CLAUDE_CODE_MODEL_PROVIDER) {
      throw new Error(`claude-code task model must use "${CLAUDE_CODE_MODEL_PROVIDER}/model-id"`);
    }
    payload.model = model;
  }

  if (payload.type === "agent" && task.isolation !== undefined) {
    if (!VALID_ISOLATION.has(task.isolation as TaskIsolationMode)) {
      throw new Error("isolation must be 'worktree' or 'in-place'");
    }
    payload.isolation = task.isolation as TaskIsolationMode;
  }

  return payload;
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
