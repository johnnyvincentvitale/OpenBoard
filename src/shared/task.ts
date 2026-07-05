import type { Column } from "./columns";

/**
 * The live execution state of a task, derived from its linked OpenCode session.
 * - unstarted: no session yet (a spec in To Do)
 * - running:   a session is actively working the task
 * - idle:      the session finished its turn (ready for Review)
 * - error:     the session's last step failed
 */
export const TASK_RUN_STATES = ["unstarted", "running", "idle", "error"] as const;
export type TaskRunState = (typeof TASK_RUN_STATES)[number];

/**
 * How a task's dispatched session is isolated:
 * - worktree: run in a dedicated `git worktree` cut from the task's repo, so
 *   concurrent agents never share a working tree.
 * - in-place: run directly in the task's directory (no isolation).
 * When a task leaves `isolation` unset, the board-level default applies.
 */
export const TASK_ISOLATION_MODES = ["worktree", "in-place"] as const;
export type TaskIsolationMode = (typeof TASK_ISOLATION_MODES)[number];

export const TASK_TYPES = ["manual", "agent"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export type TaskRunOutcome = "complete" | "blocked";

export interface CompletionVerification {
  command: string;
  result: string;
}

export interface CompletionReport {
  outcome: TaskRunOutcome;
  summary: string;
  changedFiles: string[];
  verification: CompletionVerification[];
  residualRisk: string;
  reportedAt: number;
}

export type CompletionSource = "reported" | "idle-fallback";

export interface InstanceConfig {
  port: number;
  dbPath: string;
  workspace: string;
  opencodePort?: number;
  /**
   * When true, task and terminal directories outside the board workspace are
   * allowed. This is unsafe for multi-agent/shared instances; only enable when
   * you intentionally want to run agents on external directories.
   */
  allowExternalDirectories?: boolean;
}

/**
 * A unit of work on the board — distinct from an OpenCode session. A Task in the
 * `todo` column is a spec with no session; running it dispatches a session that
 * executes `description` in `directory`, and the dispatcher auto-moves the card as
 * the session progresses.
 */
/** A model reference, matching OpenCode's ModelRef (provider + model id). */
export interface ModelRef {
  id: string;
  providerID: string;
  variant?: string;
}

export interface Task {
  id: string;
  /** Manual/PM cards are tracked but cannot be dispatched until converted to agent cards. */
  type?: TaskType;
  title: string;
  /** The prompt handed to the agent when the task is run. */
  description: string;
  /** Working directory the dispatched session runs in. */
  directory: string;
  /** Which OpenCode agent (roster entry) executes this task. */
  agent?: string;
  /** Human assignee for manual/PM cards. */
  assignedTo?: string;
  /** Model the dispatched session runs on. For new tasks with an assigned agent and no explicit model, the create route resolves this from the live roster. */
  model?: ModelRef;
  column: Column;
  /** Dense integer, unique within a column. */
  position: number;
  /** The OpenCode session executing this task, once run. */
  sessionId?: string;
  runState: TaskRunState;
  /** Epoch ms of the most recent transition into `running` (kept after the run ends). */
  runStartedAt?: number;
  error?: string;
  /** Per-task isolation override. Unset → the board-level default applies. */
  isolation?: TaskIsolationMode;
  /** Absolute path of the git worktree this task's session runs in (worktree mode, once run). */
  worktreePath?: string;
  /** The branch created for the worktree. */
  worktreeBranch?: string;
  /** The upstream branch the worktree was cut from (merge target on integrate). */
  baseBranch?: string;
  /** A decision the run is blocked on and the UI must resolve (e.g. "git-init" for a non-repo dir). */
  pending?: TaskPending;
  /** Hidden from active boards/lists when true; default false. */
  archived?: boolean;
  /** IDs of tasks that must precede this task. */
  parentIds?: string[];
  /** Structured final report from the task run, or null before completion/blocking is reported. */
  completion?: CompletionReport | null;
  /** Whether completion was agent-reported or synthesized from idle fallback. */
  completionSource?: CompletionSource | null;
  /**
   * Attribution for how the card reached Done: "User" when moved manually,
   * an agent identifier when moved by the orchestrator/dispatcher, or unset if
   * the task is still active or attribution is unknown.
   */
  completedBy?: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A sentinel value for manual (UI/CLI/API) task completion moves. */
export const USER_COMPLETED_BY = "User" as const;

export interface MoveTaskBody {
  column: Column;
  position: number;
  /**
   * Completion attribution. Explicit value is always honoured; omit to default
   * to `User` when moving to Done or to clear the value when moving elsewhere.
   */
  completedBy?: string | null;
}

/** A decision a run is waiting on the user to resolve before it can proceed. */
export const TASK_PENDING = ["git-init"] as const;
export type TaskPending = (typeof TASK_PENDING)[number];

export interface CreateTaskInput {
  type?: TaskType;
  title: string;
  description: string;
  directory: string;
  agent?: string;
  assignedTo?: string;
  model?: ModelRef;
  isolation?: TaskIsolationMode;
}

/** Board-level settings (persisted). */
export interface BoardSettings {
  /** Default isolation for runs when a task doesn't override it. */
  worktreeDefault: boolean;
}

/** A roster agent (OpenCode agent) the board can assign tasks to — from GET /api/agent. */
export interface RosterAgent {
  id: string;
  mode: "primary" | "subagent" | "all";
  description?: string;
  model?: ModelRef;
}

/** The permission ruleset that lets a dispatched session run unattended. */
export const UNATTENDED_PERMISSION = [
  { permission: "*", pattern: "**", action: "allow" },
] as const;

/** SSE frames the task board pushes to the browser. */
export type TaskFrame =
  | { kind: "snapshot"; seq: number; tasks: Task[] }
  | { kind: "upsert"; seq: number; task: Task }
  | { kind: "remove"; seq: number; taskId: string }
  | { kind: "heartbeat"; seq: number };

/** Task persistence (better-sqlite3, synchronous). Owns task rows + column/order. */
export interface TaskStore {
  list(): Task[];
  get(id: string): Task | undefined;
  /** Create a task in `todo` at the end of the column. */
  create(input: CreateTaskInput): Task;
  /** Patch mutable fields (column/position/sessionId/runState/error/title/…). */
  update(id: string, patch: Partial<Omit<Task, "id" | "createdAt">>): Task | undefined;
  /** Move to (column, position), reindexing siblings atomically. */
  move(id: string, column: Column, position: number): void;
  remove(id: string): void;
  setCompletion(id: string, report: CompletionReport, source: CompletionSource): Task | undefined;
  setArchived(id: string, archived: boolean): Task | undefined;
  addLink(parentId: string, childId: string): void;
  removeLink(parentId: string, childId: string): void;
  getParentIds(childId: string): string[];
  getChildIds(parentId: string): string[];
  /** Read the persisted board settings (defaults applied for a fresh store). */
  getSettings(): BoardSettings;
  /** Patch and persist board settings; returns the merged result. */
  updateSettings(patch: Partial<BoardSettings>): BoardSettings;
}

/**
 * The Push dispatcher — turns tasks into running OpenCode sessions and auto-moves
 * cards as those sessions progress. `start()` begins watching the /event stream.
 */
export interface Dispatcher {
  /** create session in task.directory → prompt with task.description → link + move to in_progress. */
  run(taskId: string): Promise<Task>;
  /** Send follow-up input (feedback) to the task's existing session and re-run. */
  retry(taskId: string, feedback?: string): Promise<Task>;
  /** Abort the task's running session. */
  abort(taskId: string): Promise<void>;
  /** `git init` + commit the task's directory (answering the non-repo prompt), then run it. */
  initGitAndRun(taskId: string): Promise<Task>;
  /** Merge the upstream base branch into the task's worktree branch. */
  syncUpstream(taskId: string): Promise<MergeOutcome>;
  /** Merge the task's worktree branch into `targetBranch`, remove the worktree, keep the branch. */
  integrate(taskId: string, targetBranch?: string): Promise<MergeOutcome>;
  /** Begin event-driven auto-transitions (running → review on idle, → error on failure). */
  start(): void;
  shutdown(): void;
}

/** Result of a worktree merge operation (sync/integrate), surfaced to the board. */
export interface MergeOutcome {
  task: Task;
  ok: boolean;
  conflict: boolean;
  message: string;
}

/** Canonical task REST + SSE routes. Namespace: /api/tasks. */
export const TASK_ROUTE_PATTERNS = {
  list: "/api/tasks",
  create: "/api/tasks",
  events: "/api/tasks/events",
  run: "/api/tasks/:id/run",
  retry: "/api/tasks/:id/retry",
  abort: "/api/tasks/:id/abort",
  move: "/api/tasks/:id/move",
  remove: "/api/tasks/:id",
  initGit: "/api/tasks/:id/init-git",
  sync: "/api/tasks/:id/sync",
  integrate: "/api/tasks/:id/integrate",
  settings: "/api/settings",
} as const;

export const buildTaskPath = {
  list: () => "/api/tasks",
  events: () => "/api/tasks/events",
  run: (id: string) => `/api/tasks/${encodeURIComponent(id)}/run`,
  retry: (id: string) => `/api/tasks/${encodeURIComponent(id)}/retry`,
  abort: (id: string) => `/api/tasks/${encodeURIComponent(id)}/abort`,
  move: (id: string) => `/api/tasks/${encodeURIComponent(id)}/move`,
  remove: (id: string) => `/api/tasks/${encodeURIComponent(id)}`,
  initGit: (id: string) => `/api/tasks/${encodeURIComponent(id)}/init-git`,
  sync: (id: string) => `/api/tasks/${encodeURIComponent(id)}/sync`,
  integrate: (id: string) => `/api/tasks/${encodeURIComponent(id)}/integrate`,
  settings: () => "/api/settings",
} as const;
