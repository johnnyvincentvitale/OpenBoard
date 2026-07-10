import type { Column } from "./columns";
import type { WorktreeOrphan } from "./diagnostics";

/** A single file in a task diff response. Mirrors OpenCode's server diff contract. */
export interface DiffFile {
  file: string;
  patch?: string;
  additions: number;
  deletions: number;
  status: "added" | "deleted" | "modified";
}

/** File-level commit state for a Review worktree before integration. */
export interface WorktreeCommitStatus {
  committedFiles: string[];
  uncommittedFiles: string[];
}

/** Result of committing one changed file on a task worktree branch. */
export interface FileCommitOutcome {
  task: Task;
  ok: boolean;
  file: string;
  message: string;
  commit?: string;
  remainingUncommittedFiles?: string[];
}

/**
 * Structured diff response from GET /api/tasks/:id/diff.
 * - `kind: "diff"` carries the file-level patches. `capped` is true when
 *   the total patch bytes exceeded the ~2 MB cap and some file patches
 *   were dropped (file metadata + stats are still present). `root` is the
 *   absolute filesystem path of the tree the diff was computed against —
 *   the task worktree for worktree-isolated cards, or the task directory
 *   for in-place cards — so consumers (e.g. the editor-open feature) know
 *   where on disk `files[].file` (repo-relative) actually resolves. Done
 *   worktree cards whose checkout was removed are diffed from their retained
 *   branch and omit `root` because no matching live tree exists. It remains
 *   typed optional for that case and for older test fixtures.
 * - `kind: "no-git"` is a non-crash sentinel for when git evidence is
 *   missing (non-git dir, deleted branch, etc.). The reason string is a
 *   human-readable message destined for the TUI header/detail pane.
 */
export type DiffResponse =
  | { kind: "diff"; files: DiffFile[]; capped: boolean; root?: string }
  | { kind: "no-git"; reason: string };

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

export const TASK_KINDS = ["none", "research", "synthesis", "build", "audit", "fix"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const TASK_HARNESSES = ["opencode", "claude-code", "codex", "gemini-acp", "hermes", "pi-coding-agent", "cursor-acp"] as const;
export type TaskHarness = (typeof TASK_HARNESSES)[number];
export type AcpTaskHarness = Exclude<TaskHarness, "opencode">;

export const CLAUDE_CODE_MODEL_PROVIDER = "claude-code" as const;
export const CLAUDE_CODE_MODEL_IDS = ["sonnet", "opus", "fable"] as const;
export type ClaudeCodeModelId = (typeof CLAUDE_CODE_MODEL_IDS)[number];

export const CODEX_MODEL_PROVIDER = "codex" as const;
export const CODEX_MODEL_IDS = ["gpt-5.1-codex", "gpt-5-codex"] as const;
export type CodexModelId = (typeof CODEX_MODEL_IDS)[number];

export const GEMINI_ACP_MODEL_PROVIDER = "gemini-acp" as const;
export const GEMINI_ACP_MODEL_IDS = ["gemini-2.5-pro", "gemini-2.5-flash"] as const;
export type GeminiAcpModelId = (typeof GEMINI_ACP_MODEL_IDS)[number];

export const HERMES_MODEL_PROVIDER = "hermes" as const;
export const PI_CODING_AGENT_MODEL_PROVIDER = "pi-coding-agent" as const;
export const PI_CODING_AGENT_MODEL_IDS = ["default"] as const;
export type PiCodingAgentModelId = (typeof PI_CODING_AGENT_MODEL_IDS)[number];
export const CURSOR_ACP_MODEL_PROVIDER = "cursor-acp" as const;

export const CLAUDE_CODE_PERMISSION_MODES = ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"] as const;
export type ClaudeCodePermissionMode = (typeof CLAUDE_CODE_PERMISSION_MODES)[number];
export const DEFAULT_CLAUDE_CODE_PERMISSION_MODE: ClaudeCodePermissionMode = "bypassPermissions";
export const ACP_PERMISSION_MODES = CLAUDE_CODE_PERMISSION_MODES;
export type AcpPermissionMode = ClaudeCodePermissionMode;
export const DEFAULT_ACP_PERMISSION_MODE: AcpPermissionMode = DEFAULT_CLAUDE_CODE_PERMISSION_MODE;

export type AcpOptionValue = string | number | boolean;
export type AcpOptions = Record<string, AcpOptionValue>;

export interface AcpModelOption {
  id: string;
  name?: string;
  description?: string;
}

export type AcpModelCatalog = Partial<Record<AcpTaskHarness, AcpModelOption[]>>;

export interface AcpConfigValueOption {
  value: string;
  name?: string;
  description?: string;
}

export interface AcpConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: "select" | "boolean";
  currentValue?: AcpOptionValue;
  options?: AcpConfigValueOption[];
}

export interface AcpHarnessConfig {
  available: boolean;
  modes: AcpConfigValueOption[];
  models: AcpModelOption[];
  options: AcpConfigOption[];
  error?: string;
}

export type AcpConfigCatalog = Partial<Record<AcpTaskHarness, AcpHarnessConfig>>;

export const TASK_COMPLETION_LOCATIONS = ["task-directory", "harness-directory", "mixed", "missing", "none"] as const;
export type TaskCompletionLocation = (typeof TASK_COMPLETION_LOCATIONS)[number];

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

export interface TaskComment {
  id: string;
  taskId: string;
  parentCommentId?: string | null;
  author: string;
  body: string;
  createdAt: number;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  type: string;
  body: Record<string, unknown>;
  createdAt: number;
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

export const CLAUDE_CODE_MODELS: readonly ModelRef[] = CLAUDE_CODE_MODEL_IDS.map((id) => ({
  providerID: CLAUDE_CODE_MODEL_PROVIDER,
  id,
}));

export const CODEX_MODELS: readonly ModelRef[] = CODEX_MODEL_IDS.map((id) => ({
  providerID: CODEX_MODEL_PROVIDER,
  id,
}));

export const GEMINI_ACP_MODELS: readonly ModelRef[] = GEMINI_ACP_MODEL_IDS.map((id) => ({
  providerID: GEMINI_ACP_MODEL_PROVIDER,
  id,
}));

export const HERMES_MODELS: readonly ModelRef[] = [{ providerID: HERMES_MODEL_PROVIDER, id: "default" }];

export const PI_CODING_AGENT_MODELS: readonly ModelRef[] = PI_CODING_AGENT_MODEL_IDS.map((id) => ({
  providerID: PI_CODING_AGENT_MODEL_PROVIDER,
  id,
}));

export const CURSOR_ACP_MODELS: readonly ModelRef[] = [{ providerID: CURSOR_ACP_MODEL_PROVIDER, id: "default" }];

export interface Task {
  id: string;
  /** Manual/PM cards are tracked but cannot be dispatched until converted to agent cards. */
  type?: TaskType;
  /** Operator/orchestrator task intent. Currently metadata only; handoff/context semantics are layered on later. */
  taskKind?: TaskKind | null;
  title: string;
  /** The prompt handed to the agent when the task is run. */
  description: string;
  /** Working directory the dispatched session runs in. */
  directory: string;
  /** Which OpenCode agent (roster entry) executes this task. */
  agent?: string | null;
  /** Worker harness that launches agent tasks. Defaults to OpenCode for older rows. */
  harness?: TaskHarness;
  /** Generic ACP permission mode sent via session/set_mode. */
  permissionMode?: AcpPermissionMode | null;
  /** Claude Code permission mode for legacy Claude-harness callers. */
  claudePermissionMode?: ClaudeCodePermissionMode | null;
  /** Provider-specific ACP adapter options, interpreted only by the selected harness. */
  acpOptions?: AcpOptions | null;
  /** Human assignee for manual/PM cards. */
  assignedTo?: string | null;
  /** Model the dispatched session runs on. For new tasks with an assigned agent and no explicit model, the create route resolves this from the live roster. */
  model?: ModelRef | null;
  column: Column;
  /** Dense integer, unique within a column. */
  position: number;
  /** The OpenCode session executing this task, once run. */
  sessionId?: string;
  /** Harness-owned session identifier/name for non-OpenCode workers. */
  harnessSessionId?: string;
  harnessSessionName?: string;
  harnessStatus?: string;
  /** Actual runtime cwd reported by a non-OpenCode harness, which may differ from task.directory. */
  harnessCwd?: string;
  /** Branch/commit observed in the harness runtime cwd, when it is a git worktree. */
  harnessBranch?: string;
  harnessCommit?: string;
  /** Preflight/runtime warning from the harness, shown to the operator. */
  harnessWarning?: string;
  runState: TaskRunState;
  /** Epoch ms of the most recent transition into `running` (kept after the run ends). */
  runStartedAt?: number;
  error?: string;
  /** Per-task isolation. Unset is treated as in-place for legacy rows. */
  isolation?: TaskIsolationMode | null;
  /**
   * Opt-in auto-dispatch: when true, a future chain advancer may run this
   * task automatically once its parents are satisfied. Only valid on
   * worktree-isolated tasks (`isolation === "worktree"`) — unattended
   * dispatch must stay inside the write fence. Unset means false for
   * legacy rows.
   */
  autoRun?: boolean;
  /**
   * User-configured OpenCode permission override. Only ever honored for
   * in-place (non-worktree) OpenCode tasks — see
   * {@link resolveOpenCodePermissionRules}. Ignored (never read) for
   * worktree-isolated runs, regardless of any value stored here.
   */
  permissionOverrides?: PermissionOverrides | null;
  /** Absolute path of the git worktree this task's session runs in (worktree mode, once run). */
  worktreePath?: string;
  /** The branch created for the worktree. */
  worktreeBranch?: string;
  /** The upstream branch the worktree was cut from (merge target on integrate). */
  baseBranch?: string;
  /**
   * The HEAD commit SHA recorded at dispatch time. Used by the diff engine to
   * compute what the task changed vs the baseline. Null when not recorded
   * (pre-existing rows or dispatch before this field existed).
   */
  baseCommit: string | null;
  /**
   * True when the task's working directory had uncommitted changes at dispatch
   * time. Drives an honesty label in the diff view header. Default false.
   */
  dirtyAtDispatch: boolean;
  /**
   * Resolved isolation mode for the most recent dispatch/retry.
   */
  isolationAtDispatch?: TaskIsolationMode | null;
  /**
   * `git status --porcelain` of the BASE checkout (not the worktree) captured
   * at dispatch time, for worktree-isolated tasks only. Compared against the
   * same command re-run at completion/integrate time by the escape detector
   * (src/server/escape-detector.ts) to catch a session writing outside its
   * worktree. Null for in-place tasks or when not yet captured.
   */
  baseCheckoutSnapshot?: string | null;
  /** A decision the run is blocked on and the UI must resolve (e.g. "git-init" for a non-repo dir). */
  pending?: TaskPending;
  /** Base-checkout paths the escape detector found changed outside the worktree, when `pending` is "base-checkout-escape". */
  escapeDetectedPaths?: string[];
  /** Paths that stopped an integrate rebase inside the task worktree, when `pending` is "rebase-conflict". */
  rebaseConflictPaths?: string[];
  /** Hidden from active boards/lists when true; default false. */
  archived?: boolean;
  /** IDs of tasks that must precede this task. */
  parentIds?: string[];
  /** Structured final report from the task run, or null before completion/blocking is reported. */
  completion?: CompletionReport | null;
  /** Final OpenCode session output captured for task detail; null when unavailable (including Claude Code). */
  finalSessionOutput?: string | null;
  /** Whether completion was agent-reported or synthesized from idle fallback. */
  completionSource?: CompletionSource | null;
  /** Where the reported changed files were found when the completion report landed. */
  completionLocation?: TaskCompletionLocation | null;
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
/** Attribution used when Integrate successfully merges and cleans up a task. */
export const INTEGRATED_COMPLETED_BY = "Integrated by User" as const;

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
export const TASK_PENDING = ["git-init", "base-checkout-escape", "rebase-conflict"] as const;
export type TaskPending = (typeof TASK_PENDING)[number];

export interface CreateTaskInput {
  type?: TaskType;
  taskKind?: TaskKind;
  harness?: TaskHarness;
  title: string;
  description: string;
  directory: string;
  agent?: string;
  permissionMode?: AcpPermissionMode;
  claudePermissionMode?: ClaudeCodePermissionMode;
  acpOptions?: AcpOptions;
  assignedTo?: string;
  model?: ModelRef;
  isolation?: TaskIsolationMode;
  autoRun?: boolean;
  permissionOverrides?: PermissionOverrides;
  /** Parent task IDs for dependency links. Applied after the task is created. */
  parentIds?: string[];
}

export interface UpdateTaskInput {
  type?: TaskType;
  taskKind?: TaskKind | null;
  harness?: TaskHarness;
  title?: string;
  description?: string;
  directory?: string;
  agent?: string | null;
  permissionMode?: AcpPermissionMode | null;
  claudePermissionMode?: ClaudeCodePermissionMode | null;
  acpOptions?: AcpOptions | null;
  assignedTo?: string | null;
  model?: ModelRef | null;
  isolation?: TaskIsolationMode | null;
  autoRun?: boolean;
  permissionOverrides?: PermissionOverrides | null;
  /** Parent task IDs to set atomically on the child. Replaces all existing links. */
  parentIds?: string[] | null;
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

/**
 * The permission ruleset for worktree-isolated sessions. Per-session `edit`
 * pattern rules are broken in OpenCode 1.17.13 (whichever rule is last in the
 * array wins for every edit/write/patch call, regardless of pattern text —
 * see opencode-capabilities.md Phase 0), so this does not attempt path-based
 * edit fencing. Instead it puts OpenCode's built-in `external_directory`
 * Location boundary into "ask" mode; a live auto-responder (see
 * server/permission-responder.ts) then classifies and replies to each ask.
 * In-worktree edits stay inside Location and never trigger an ask at all.
 */
export const WRITE_FENCED_PERMISSION = [
  { permission: "*", pattern: "**", action: "allow" },
  { permission: "external_directory", pattern: "**", action: "ask" },
] as const;

/** Curated OpenCode permission categories exposed as a user-configurable override (in-place isolation only). */
export const PERMISSION_OVERRIDE_CATEGORIES = ["edit", "bash", "webfetch"] as const;
export type PermissionOverrideCategory = (typeof PERMISSION_OVERRIDE_CATEGORIES)[number];

/** OpenCode's per-tool permission action. */
export const PERMISSION_OVERRIDE_ACTIONS = ["allow", "ask", "deny"] as const;
export type PermissionOverrideAction = (typeof PERMISSION_OVERRIDE_ACTIONS)[number];

/**
 * A user-chosen override for one or more permission categories. Only ever
 * honored for in-place (non-worktree) OpenCode tasks — see
 * {@link resolveOpenCodePermissionRules}.
 */
export type PermissionOverrides = Partial<Record<PermissionOverrideCategory, PermissionOverrideAction>>;

export interface OpenCodePermissionRule {
  permission: string;
  pattern: string;
  action: PermissionOverrideAction;
}

/**
 * The single choke point for what permission ruleset a dispatched OpenCode
 * session runs with. Worktree-isolated runs ALWAYS get
 * `WRITE_FENCED_PERMISSION` unchanged — `overrides` is not read at all in
 * that branch — because the worktree safety stack (write-fencing, escape
 * detection, worktree-cwd prompt hygiene) must never be
 * weakened by a per-task override, regardless of how such data ended up on
 * the row. Only in-place tasks may layer category overrides, and only after
 * the base allow-all rule, since OpenCode 1.17.13 lets whichever rule is
 * last in the array win (see `WRITE_FENCED_PERMISSION`'s doc comment above).
 */
export function resolveOpenCodePermissionRules(
  isolatedRun: boolean,
  overrides?: PermissionOverrides | null,
): OpenCodePermissionRule[] {
  if (isolatedRun) return WRITE_FENCED_PERMISSION.map((rule) => ({ ...rule }));
  const rules: OpenCodePermissionRule[] = UNATTENDED_PERMISSION.map((rule) => ({ ...rule }));
  if (overrides) {
    for (const category of PERMISSION_OVERRIDE_CATEGORIES) {
      const action = overrides[category];
      if (action && action !== "allow") rules.push({ permission: category, pattern: "**", action });
    }
  }
  return rules;
}

/**
 * The single source of truth for whether a task's shape permits unattended
 * auto-dispatch (`autoRun`). Two shapes qualify:
 *
 * - Worktree isolation — the write fence, escape detector, and worktree-cwd
 *   prompt hygiene contain the run.
 * - An in-place OpenCode task whose permission overrides deny BOTH `edit`
 *   and `bash` — writes cannot land in the live checkout, while OpenCode's
 *   native read/grep/glob tools keep read-only work (research, synthesis,
 *   audit) viable. Completion still reports through the injected OpenBoard
 *   MCP `complete_task` tool, which needs neither edit nor bash.
 *
 * Shared by route/client validation and the chain advancer so eligibility
 * only has one definition, mirroring {@link resolveOpenCodePermissionRules}.
 */
export function canAutoRun(task: {
  type?: TaskType | null;
  harness?: TaskHarness;
  isolation?: TaskIsolationMode | null;
  permissionOverrides?: PermissionOverrides | null;
}): boolean {
  if ((task.type ?? "agent") !== "agent") return false;
  if (task.isolation === "worktree") return true;
  const opencode = task.harness === undefined || task.harness === "opencode";
  return (
    opencode &&
    task.isolation === "in-place" &&
    task.permissionOverrides?.edit === "deny" &&
    task.permissionOverrides?.bash === "deny"
  );
}

/** Shared validation message for a rejected autoRun value — keep route and client errors identical. */
export const AUTO_RUN_REQUIREMENT =
  'autoRun requires worktree isolation, or an in-place OpenCode task with edit and bash permission overrides set to "deny"';

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
  /** Remember a repo root that has had OpenBoard-managed worktrees. */
  rememberWorktreeRepoRoot(repoRoot: string): void;
  /** Repo roots with OpenBoard-managed worktree history, used for startup orphan sweeps. */
  listKnownWorktreeRepoRoots(): string[];
  /** Store the result of the last startup orphan worktree sweep. */
  setSweepResult(result: WorktreeSweepResult): void;
  /** Read the last stored orphan sweep result, or null. */
  getSweepResult(): WorktreeSweepResult | null;
  addComment(input: { taskId: string; author: string; body: string; parentCommentId?: string | null }): TaskComment;
  listComments(taskId: string): TaskComment[];
  addEvent(input: { taskId: string; type: string; body?: Record<string, unknown> }): TaskEvent;
  listEvents(taskId: string): TaskEvent[];
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
  /** File-level commit state for the task worktree. */
  getWorktreeCommitStatus(taskId: string, targetBranch?: string): Promise<WorktreeCommitStatus>;
  /** Commit one file's current worktree changes onto the task branch. */
  commitFile(taskId: string, file: string, message?: string): Promise<FileCommitOutcome>;
  /** Merge the task's worktree branch into `targetBranch`, remove the worktree, keep the branch. */
  integrate(taskId: string, targetBranch?: string, options?: { commitRemaining?: boolean }): Promise<MergeOutcome>;
  /** Delete a task and, when safe/confirmed, remove its worktree while keeping the branch. */
  removeTask(taskId: string, options?: { force?: boolean; keepWorktree?: boolean }): Promise<{ ok: boolean; worktree?: WorktreeCleanupOutcome; message?: string }>;
  /** Remove a Review card's worktree without merging; keeps the branch and card. */
  discardWorktree(taskId: string, options?: { force?: boolean }): Promise<WorktreeCleanupOutcome>;
  /** Best-effort startup sweep for board-owned worktrees no live task references. */
  sweepOrphanedWorktrees(): Promise<WorktreeCleanupOutcome[]>;
  /** Delete a dirty orphan worktree surfaced by the startup sweep. */
  resolveOrphanWorktree(worktreePath: string): Promise<WorktreeCleanupOutcome>;
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
  rebaseConflictPaths?: string[];
  needsCommit?: boolean;
  committedFiles?: string[];
  uncommittedFiles?: string[];
}

/** Result of a non-integrate worktree cleanup path. */
export interface WorktreeCleanupOutcome {
  ok: boolean;
  removed: boolean;
  dirty: boolean;
  kept: boolean;
  message: string;
  worktreePath?: string;
  dirtyFileCount?: number;
}

/** Stored result of the last startup orphan worktree sweep. */
export interface WorktreeSweepResult {
  sweptAt: number;
  removedCleanCount: number;
  keptDirtyCount: number;
  dirtyOrphans: WorktreeOrphan[];
}

/** Canonical task REST + SSE routes. Namespace: /api/tasks. */
export const TASK_ROUTE_PATTERNS = {
  list: "/api/tasks",
  create: "/api/tasks",
  update: "/api/tasks/:id",
  events: "/api/tasks/events",
  run: "/api/tasks/:id/run",
  retry: "/api/tasks/:id/retry",
  abort: "/api/tasks/:id/abort",
  move: "/api/tasks/:id/move",
  remove: "/api/tasks/:id",
  initGit: "/api/tasks/:id/init-git",
  sync: "/api/tasks/:id/sync",
  integrate: "/api/tasks/:id/integrate",
  commitStatus: "/api/tasks/:id/commit-status",
  commitFile: "/api/tasks/:id/commit-file",
  discardWorktree: "/api/tasks/:id/discard-worktree",
  diff: "/api/tasks/:id/diff",
  comments: "/api/tasks/:id/comments",
  taskEvents: "/api/tasks/:id/events",
} as const;

export const buildTaskPath = {
  list: () => "/api/tasks",
  events: () => "/api/tasks/events",
  run: (id: string) => `/api/tasks/${encodeURIComponent(id)}/run`,
  retry: (id: string) => `/api/tasks/${encodeURIComponent(id)}/retry`,
  abort: (id: string) => `/api/tasks/${encodeURIComponent(id)}/abort`,
  move: (id: string) => `/api/tasks/${encodeURIComponent(id)}/move`,
  update: (id: string) => `/api/tasks/${encodeURIComponent(id)}`,
  remove: (id: string) => `/api/tasks/${encodeURIComponent(id)}`,
  initGit: (id: string) => `/api/tasks/${encodeURIComponent(id)}/init-git`,
  sync: (id: string) => `/api/tasks/${encodeURIComponent(id)}/sync`,
  integrate: (id: string) => `/api/tasks/${encodeURIComponent(id)}/integrate`,
  commitStatus: (id: string) => `/api/tasks/${encodeURIComponent(id)}/commit-status`,
  commitFile: (id: string) => `/api/tasks/${encodeURIComponent(id)}/commit-file`,
  discardWorktree: (id: string) => `/api/tasks/${encodeURIComponent(id)}/discard-worktree`,
  diff: (id: string) => `/api/tasks/${encodeURIComponent(id)}/diff`,
  links: (id: string) => `/api/tasks/${encodeURIComponent(id)}/links`,
  unlink: (id: string, parentId: string) =>
    `/api/tasks/${encodeURIComponent(id)}/links/${encodeURIComponent(parentId)}`,
  comments: (id: string) => `/api/tasks/${encodeURIComponent(id)}/comments`,
  taskEvents: (id: string) => `/api/tasks/${encodeURIComponent(id)}/events`,
} as const;
