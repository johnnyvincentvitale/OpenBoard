import { stat as defaultStat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type {
  BoardSettings,
  Column,
  CreateTaskInput,
  MergeOutcome,
  ModelRef,
  RosterAgent,
  Task,
  TaskIsolationMode,
} from "../shared";
import { buildTaskPath, TASK_ISOLATION_MODES } from "../shared";

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
  env?: Partial<Pick<NodeJS.ProcessEnv, "OPENCODE_BOARD_URL" | "OPENBOARD_API_TOKEN">>;
  requireExplicitBoardUrl?: boolean;
}

export interface TaskSummary {
  id: string;
  title: string;
  directory: string;
  column: Task["column"];
  runState: Task["runState"];
  agent?: string;
  model?: ModelRef;
  isolation?: TaskIsolationMode;
  sessionId?: string;
}

export interface CreateBoardTaskInput {
  title: string;
  description?: string;
  directory?: string;
  agent?: string;
  model?: string | ModelRef;
  isolation?: string;
}

export interface BoardClient {
  readonly boardUrl: string;
  readonly cwd: string;
  listTasks(): Promise<Task[]>;
  listTaskSummaries(): Promise<TaskSummary[]>;
  listAgents(): Promise<RosterAgent[]>;
  createTask(input: CreateBoardTaskInput): Promise<Task>;
  createTasks(input: CreateBoardTaskInput[]): Promise<Task[]>;
  runTask(id: string): Promise<Task>;
  retryTask(id: string, feedback?: string): Promise<Task>;
  abortTask(id: string): Promise<Task>;
  moveTask(id: string, column: Column, position: number, completedBy?: string | null): Promise<Task[]>;
  deleteTask(id: string): Promise<{ ok: true }>;
  initGitAndRun(id: string): Promise<Task>;
  syncTask(id: string): Promise<MergeOutcome>;
  integrateTask(id: string, targetBranch?: string): Promise<MergeOutcome>;
  getSettings(): Promise<BoardSettings>;
  updateSettings(patch: Pick<BoardSettings, "worktreeDefault">): Promise<BoardSettings>;
}

interface ResolvedOptions {
  boardUrl: string;
  cwd: string;
  fetch: FetchLike;
  stat: StatLike;
  boardToken?: string;
}

const VALID_ISOLATION = new Set<TaskIsolationMode>(TASK_ISOLATION_MODES);

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
    getSettings: () => requestJson<BoardSettings>(resolved, buildTaskPath.settings(), { method: "GET" }),
    updateSettings: (patch) =>
      requestJson<BoardSettings>(resolved, buildTaskPath.settings(), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }),
  };
}

export function resolveBoardUrl(options: BoardClientOptions = {}): string {
  const raw = options.boardUrl ?? options.env?.OPENCODE_BOARD_URL ?? process.env.OPENCODE_BOARD_URL;
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
    title: task.title,
    directory: task.directory,
    column: task.column,
    runState: task.runState,
    ...(task.agent !== undefined ? { agent: task.agent } : {}),
    ...(task.model !== undefined ? { model: task.model } : {}),
    ...(task.isolation !== undefined ? { isolation: task.isolation } : {}),
    ...(task.sessionId !== undefined ? { sessionId: task.sessionId } : {}),
  };
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
    title,
    description: task.description ?? "",
    directory,
  };

  const agent = task.agent?.trim();
  if (agent) payload.agent = agent;

  if (task.model !== undefined) {
    payload.model = typeof task.model === "string" ? parseModelRef(task.model) : task.model;
  }

  if (task.isolation !== undefined) {
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
