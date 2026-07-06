/**
 * The Push dispatcher — turns Tasks into running OpenCode sessions and auto-moves
 * cards as those sessions progress.
 *
 * `run()` creates a session in the task's directory, kicks off an async prompt with
 * the task's description, links the session id onto the task, and moves it to
 * `in_progress`. `start()` consumes the global `/event` stream and reacts to
 * live-state changes on any session linked to a task: `running` keeps the task in
 * sync, text-ended events cache the latest useful assistant output, `idle`
 * triggers a completion check, and `error` records the failure without moving the
 * card. `retry()` re-prompts an existing session and
 * moves the task back to `in_progress`. `abort()` stops the task's session.
 * `shutdown()` stops consuming the event stream.
 */
import { basename, dirname, join, resolve } from "node:path";
import type { MergeOutcome, OpencodeEvent, Task, TaskStore } from "../shared";
import { AdapterError, UNATTENDED_PERMISSION, WRITE_FENCED_PERMISSION } from "../shared";
import type { Dispatcher } from "../shared";
import type { OpencodeHandle } from "./opencode";
import { detectBaseCheckoutEscape, snapshotBaseCheckout } from "./escape-detector";
import { eventLiveState, eventSessionId } from "./events/session-status";
import { createPermissionResponderPool, type PermissionResponderPool } from "./permission-responder";
import { GitWorktreeManager, type WorktreeManager } from "./worktree";
import { ClaudeCodeRunner, type ClaudeCodeRunnerLike } from "./claude-code-runner";
import { dirtyWarning, inspectGitDirectory, isWorkingTreeDirty, resolveHeadCommit } from "./git-inspect";
import {
  isExternalDirectoriesAllowed,
  isUnderWorkspace,
  resolveBoardWorkspace,
  resolveTaskDirectory,
  type ResolveTaskDirectoryOptions,
} from "./workspace";

export interface UnmetParentDependency {
  id: string;
  title: string;
  why: string;
}

export class DependencyGateError extends Error {
  readonly status = 409;
  readonly unmetParents: UnmetParentDependency[];

  constructor(unmetParents: UnmetParentDependency[]) {
    super(`Task has unmet parent dependencies: ${unmetParents.map((p) => p.title).join(", ")}`);
    this.name = "DependencyGateError";
    this.unmetParents = unmetParents;
  }
}

export class ArchivedTaskActionError extends AdapterError {
  constructor(action: "run" | "retry") {
    super("validation", `Cannot ${action} an archived task`);
    this.name = "ArchivedTaskActionError";
  }

  override get status(): number {
    return 409;
  }
}

export interface TaskDispatcherDeps {
  client: OpencodeHandle["client"];
  store: TaskStore;
  /** Base URL for this adapter, used in dispatched completion-report instructions. */
  adapterBaseUrl?: string;
  /** Board API token, used in dispatched completion-report instructions. */
  boardToken?: string;
  /** Claude Code background-session launcher for `claude-code` harness tasks. */
  claudeRunner?: ClaudeCodeRunnerLike;
  /** Git worktree engine for isolated runs. Defaults to a real GitWorktreeManager. */
  worktrees?: WorktreeManager;
  /**
   * Where a repo's worktrees live. Default: a sibling `.opencode-board-worktrees/<repo>`
   * dir next to the repo root, so worktrees never nest inside the main working tree.
   */
  worktreeBaseDir?: (repoRoot: string) => string;
  /**
   * The board instance's workspace root. Defaults to `BOARD_WORKSPACE` then the
   * user's home directory.
   */
  workspace?: string;
  /**
   * When true, directories outside the workspace are accepted. Unsafe for
   * shared instances; opt-in only.
   */
  allowExternalDirectories?: boolean;
  /**
   * Override directory canonicalization (tests). Receives the raw stored task
   * directory and must return an absolute, validated path.
   */
  resolveDirectory?: (raw: string) => string;
  /** Named OpenBoard instance to expose to spawned Claude Code sessions. */
  instanceName?: string;
  /** Override the stall-detection threshold (tests only; default DEFAULT_STALL_THRESHOLD_MS). */
  stallThresholdMs?: number;
}

/** Resolve the effective isolation for a task: its override, else the board default. */
function wantsWorktree(task: Task, store: TaskStore): boolean {
  if (task.isolation) return task.isolation === "worktree";
  return store.getSettings().worktreeDefault;
}

function unmetReason(parent: Task): string | null {
  if (parent.column === "done") return null;
  if (parent.completion?.outcome === "complete" && parent.completionSource === "reported") return null;
  if (parent.completion?.outcome === "blocked") return "parent reported blocked";
  if (parent.completionSource === "idle-fallback") return "parent went idle without a completion report";
  if (parent.column === "review") return "parent is in review, not done";
  if (parent.runState === "running") return "parent is still running";
  if (parent.runState === "error") return parent.error ? `parent is in error: ${parent.error}` : "parent is in error";
  return `parent is in ${parent.column}`;
}

/** Base/backoff tuning for reconnecting to the upstream OpenCode event stream. */
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 15000;
const COMPLETION_POLL_INTERVAL_MS = 1000;
const COMPLETION_WATCH_TIMEOUT_MS = 6 * 60 * 60 * 1000;
/** How long a session may sit at isStalledAfterToolCalls() with no new messages before nudging. */
const DEFAULT_STALL_THRESHOLD_MS = 45_000;
/** Consecutive nudges producing no new message before giving up — resets to 0 on any progress. */
const MAX_CONSECUTIVE_FUTILE_NUDGES = 2;
/** A denial older than this is treated as unrelated to the current stall (avoids citing stale info). */
const DENIAL_RECENCY_WINDOW_MS = 2 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** The session create response shape differs across OpenCode SDK surfaces. Unwrap defensively. */
function extractSessionId(data: unknown): string | undefined {
  const inner = (data as { data?: unknown })?.data ?? data;
  const id = (inner as { id?: unknown })?.id;
  return typeof id === "string" ? id : undefined;
}

/**
 * The non-v2 message endpoints use `modelID`, while the board stores OpenCode's
 * roster-shaped `ModelRef` as `{ providerID, id }`.
 */
function toPromptModel(
  model: Task["model"],
): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  return {
    providerID: model.providerID,
    modelID: model.id,
  };
}

function hasAssistantTurnFinished(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;

  const latest = messages[messages.length - 1];
  if (latest === null || typeof latest !== "object") return false;

  const info = (latest as { info?: unknown }).info;
  const role =
    info !== null && typeof info === "object"
      ? (info as Record<string, unknown>).role
      : undefined;
  if (role !== "assistant") return false;

  const parts = (latest as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return false;

  const hasActiveTool = parts.some((part) => {
    if (part === null || typeof part !== "object") return false;
    const record = part as Record<string, unknown>;
    if (record.type !== "tool") return false;
    const state = record.state;
    if (state === null || typeof state !== "object") return false;
    const status = (state as Record<string, unknown>).status;
    return status === "pending" || status === "running";
  });
  if (hasActiveTool) return false;

  return parts.some((part) => {
    if (part === null || typeof part !== "object") return false;
    const record = part as Record<string, unknown>;
    return record.type === "step-finish" && record.reason !== "tool-calls";
  });
}

/**
 * True when the assistant's last step ended specifically because of a tool
 * call — the state OpenCode is supposed to auto-continue from within the
 * same turn, but a fenced denial has been observed to leave the session
 * sitting here indefinitely (Phase 0/live-proof finding). Deliberately the
 * mirror image of `hasAssistantTurnFinished`'s exclusions: a tool call still
 * actively running (`pending`/`running`) is a normal, possibly long-running
 * step and must never be mistaken for this — only a step that has already
 * *finished* with reason "tool-calls" and nothing new following it counts.
 */
function isStalledAfterToolCalls(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;

  const latest = messages[messages.length - 1];
  if (latest === null || typeof latest !== "object") return false;

  const info = (latest as { info?: unknown }).info;
  const role =
    info !== null && typeof info === "object"
      ? (info as Record<string, unknown>).role
      : undefined;
  if (role !== "assistant") return false;

  const parts = (latest as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return false;

  const hasActiveTool = parts.some((part) => {
    if (part === null || typeof part !== "object") return false;
    const record = part as Record<string, unknown>;
    if (record.type !== "tool") return false;
    const state = record.state;
    if (state === null || typeof state !== "object") return false;
    const status = (state as Record<string, unknown>).status;
    return status === "pending" || status === "running";
  });
  if (hasActiveTool) return false;

  return parts.some((part) => {
    if (part === null || typeof part !== "object") return false;
    const record = part as Record<string, unknown>;
    return record.type === "step-finish" && record.reason === "tool-calls";
  });
}

/** Per-session progress tracking used by trackStallAndMaybeNudge(), scoped to one watchCompletion call. */
interface StallTrackingState {
  lastMessageCount: number;
  lastProgressAt: number;
  /** Resets to 0 on any observed progress — a cap means "N in a row with nothing between them." */
  consecutiveFutileNudges: number;
}

function looksLikeCompletionReport(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return true;
  return (
    normalized.startsWith("task complete. here's the handoff") ||
    normalized.startsWith("audit complete. reported via") ||
    normalized.startsWith("reported via `/complete`") ||
    normalized.startsWith("reported via /complete") ||
    normalized.includes("let me submit the completion report") ||
    normalized.includes("submit the completion report") ||
    normalized.includes("call /complete") ||
    normalized.includes("called /complete") ||
    normalized.includes("reported via `/block`") ||
    normalized.includes("reported via /block")
  );
}

function usefulOutput(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed || looksLikeCompletionReport(trimmed)) return null;
  return trimmed;
}

function extractTextEndedOutput(event: OpencodeEvent): string | null {
  if ((event as { type?: unknown }).type !== "session.next.text.ended") return null;
  const properties = (event as { properties?: unknown }).properties;
  if (properties === null || typeof properties !== "object") return null;
  const text = (properties as Record<string, unknown>).text;
  return usefulOutput(typeof text === "string" ? text : null);
}

function assistantMessageText(message: unknown): string | null {
  if (message === null || typeof message !== "object") return null;

  const info = (message as { info?: unknown }).info;
  const role =
    info !== null && typeof info === "object"
      ? (info as Record<string, unknown>).role
      : undefined;
  if (role !== "assistant") return null;

  const parts = (message as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return null;

  const textParts: string[] = [];
  for (const part of parts) {
    if (part === null || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      textParts.push(record.text);
    }
  }

  return usefulOutput(textParts.join("\n"));
}

/**
 * Extract the final useful assistant text output from an OpenCode session
 * message list. Completion-report wrapper messages are skipped so the Output tab
 * does not duplicate the structured Handoff tab.
 */
function extractFinalOutput(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = assistantMessageText(messages[index]);
    if (text) return text;
  }

  return null;
}

/** Position value that always lands a move at the end of the target column. */
const END_OF_COLUMN = Number.POSITIVE_INFINITY;

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "string") return error;
  if (error !== null && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    const data = record.data;
    if (data !== null && typeof data === "object") {
      const message = (data as Record<string, unknown>).message;
      if (typeof message === "string") return message;
    }
    if (typeof record._tag === "string") return record._tag;
    if (typeof record.name === "string") return record.name;
  }
  return fallback;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class TaskDispatcher implements Dispatcher {
  private readonly client: OpencodeHandle["client"];
  private readonly store: TaskStore;
  private readonly worktrees: WorktreeManager;
  private readonly worktreeBaseDir: (repoRoot: string) => string;
  private readonly adapterBaseUrl: string;
  private readonly boardToken?: string;
  private readonly claudeRunner: ClaudeCodeRunnerLike;
  private readonly workspace: string;
  private readonly allowExternalDirectories: boolean;
  private readonly resolveDirectory: (raw: string) => string;
  private readonly stallThresholdMs: number;

  private running = false;
  /** Bumped on every stop()/restart so a stale consume loop knows to exit. */
  private generation = 0;
  private consumeLoopPromise: Promise<void> | null = null;
  private readonly completionWatchers = new Map<string, { cancelled: boolean }>();
  private readonly outputCandidates = new Map<string, string>();
  private readonly permissionResponderPool: PermissionResponderPool;

  constructor(deps: TaskDispatcherDeps) {
    this.client = deps.client;
    this.store = deps.store;
    // One shared poller for every worktree-isolated session, not one per
    // session — see permission-responder.ts. onError surfaces a persistent
    // list/reply failure as a task_warning event instead of retrying forever
    // in silence.
    this.permissionResponderPool = createPermissionResponderPool({
      client: this.client,
      onError: (sessionId, context, err) => this.handlePermissionResponderError(sessionId, context, err),
    });
    this.worktrees = deps.worktrees ?? new GitWorktreeManager();
    this.adapterBaseUrl = deps.adapterBaseUrl ?? "http://127.0.0.1:0";
    this.boardToken = deps.boardToken;
    const envInstanceName = process.env.OPENBOARD_INSTANCE_NAME?.trim();
    const instanceName = deps.instanceName ?? (envInstanceName || undefined);
    this.claudeRunner =
      deps.claudeRunner ??
      new ClaudeCodeRunner({
        adapterBaseUrl: this.adapterBaseUrl,
        boardToken: this.boardToken,
        instanceName,
      });
    this.workspace = deps.workspace ?? resolveBoardWorkspace();
    this.allowExternalDirectories = deps.allowExternalDirectories ?? isExternalDirectoriesAllowed();
    this.worktreeBaseDir =
      deps.worktreeBaseDir ??
      ((repoRoot) => {
        const sibling = join(dirname(repoRoot), ".opencode-board-worktrees", basename(repoRoot));
        // Keep isolated worktrees inside the configured workspace unless the
        // user explicitly opted in to external directories.
        if (
          this.allowExternalDirectories ||
          isUnderWorkspace(resolve(sibling), this.workspace)
        ) {
          return sibling;
        }
        return join(this.workspace, ".opencode-board-worktrees", basename(repoRoot));
      });
    this.resolveDirectory =
      deps.resolveDirectory ??
      ((raw) =>
        resolveTaskDirectory(raw, this.workspace, {
          allowExternal: this.allowExternalDirectories,
        }));
    this.stallThresholdMs = deps.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
  }

  async run(taskId: string): Promise<Task> {
    const task = this.store.get(taskId);
    if (!task) {
      throw AdapterError.notFound(`Task not found: ${taskId}`);
    }
    this.assertNotArchived(task, "run");
    this.assertParentsSatisfied(task);
    this.store.update(taskId, { completion: null, completionSource: null, finalSessionOutput: null });

    // Resolve and contain the execution directory before doing any git or
    // session work. This canonicalizes symlinks and rejects escapes from the
    // configured board workspace unless the user has explicitly opted in.
    let execDirectory = this.resolveDirectory(task.directory);
    // Captured before the worktree swap below — the Phase 3 preamble needs the
    // original (base repo) directory, not the worktree path execDirectory becomes.
    const baseRepoDirectory = execDirectory;

    // Resolve where the session actually runs. In worktree isolation the session
    // runs in a dedicated `git worktree`; a non-repo directory can't be isolated,
    // so we block the run and surface the "make it a git repo?" decision instead.
    if (wantsWorktree(task, this.store)) {
      if (!(await this.worktrees.isGitRepo(execDirectory))) {
        const blocked = this.store.update(taskId, {
          pending: "git-init",
          runState: "unstarted",
          error: undefined,
        });
        if (!blocked) throw AdapterError.notFound(`Task not found: ${taskId}`);
        return blocked;
      }
      const wt = await this.ensureWorktree(task, execDirectory);
      execDirectory = this.resolveDirectory(wt.worktreePath);
    }

    // Record git baseline at dispatch time for diff computation later. The
    // worktree lane's baseCommit is the main-repo HEAD (not the worktree
    // checkout), captured via the original execDirectory before the worktree
    // path swap above.
    const isolatedForSnapshot = wantsWorktree(task, this.store);
    const baseCommitDir = isolatedForSnapshot
      ? await this.resolveRepoRoot(this.resolveDirectory(task.directory))
      : execDirectory;
    const [baseCommit, dirty, baseCheckoutSnapshot] = await Promise.all([
      resolveHeadCommit(baseCommitDir),
      isWorkingTreeDirty(baseCommitDir),
      isolatedForSnapshot ? snapshotBaseCheckout(baseCommitDir) : Promise.resolve(null),
    ]);
    this.store.update(taskId, { baseCommit, dirtyAtDispatch: dirty, baseCheckoutSnapshot });

    if (task.harness === "claude-code") {
      return this.runClaudeTask(task, execDirectory, task.description, "run");
    }

    const isolatedRun = wantsWorktree(task, this.store);

    // The legacy session/message surface is the one that actually wakes the
    // agent in OpenCode 1.17.13. It also honors an agent's configured default
    // model when task.model is unset; the v2 prompt route can admit input
    // without producing a message turn.
    const createInput = {
      agent: task.agent ?? undefined,
      model: task.model ?? undefined,
      directory: execDirectory,
      permission: (isolatedRun ? WRITE_FENCED_PERMISSION : UNATTENDED_PERMISSION).map((rule) => ({
        ...rule,
      })),
    };
    const created = await this.client.session.create(createInput);
    if ((created as { error?: unknown }).error) {
      throw AdapterError.unreachable(
        "Failed to create OpenCode session",
        (created as { error?: unknown }).error,
      );
    }
    const sessionId = extractSessionId((created as { data?: unknown }).data);
    if (!sessionId) {
      throw AdapterError.unreachable("OpenCode session create returned no id");
    }

    const runStartedAt = Date.now();
    const taskPrompt = isolatedRun
      ? this.withWorktreeIsolationPreamble(execDirectory, baseRepoDirectory, task.description)
      : task.description;
    const promptError = await this.prompt(
      sessionId,
      this.withCompletionContract(task.id, this.withParentHandoffs(task, taskPrompt), runStartedAt),
      task.agent ?? undefined,
      task.model ?? undefined,
    );
    if (promptError) {
      const updated = this.store.update(taskId, {
        sessionId,
        runState: "error",
        error: promptError,
      });
      if (!updated) {
        throw AdapterError.notFound(`Task not found: ${taskId}`);
      }
      return updated;
    }

    this.store.update(taskId, {
      sessionId,
      runState: "running",
      runStartedAt,
      error: undefined,
      pending: undefined,
    });
    this.store.move(taskId, "in_progress", END_OF_COLUMN);
    this.startCompletionWatcher(taskId, sessionId);
    if (isolatedRun) {
      this.startPermissionResponder(sessionId, execDirectory);
    }

    const fresh = this.store.get(taskId);
    if (!fresh) {
      throw AdapterError.notFound(`Task not found: ${taskId}`);
    }
    return fresh;
  }

  private async runClaudeTask(
    task: Task,
    execDirectory: string,
    prompt: string,
    action: "run" | "retry",
  ): Promise<Task> {
    const runStartedAt = Date.now();
    const warning = await dirtyWarning(execDirectory);
    const gitInfo = await inspectGitDirectory(execDirectory);
    // Record git baseline at dispatch for diff computation.
    const baseCommit = gitInfo.isRepo
      ? (await resolveHeadCommit(execDirectory))
      : null;
    const dirty = gitInfo.dirtySummary !== undefined;
    this.store.update(task.id, { baseCommit, dirtyAtDispatch: dirty });
    try {
      const launched = await this.claudeRunner[action]({
        task,
        directory: execDirectory,
        prompt: this.withClaudePreflightContext(this.withParentHandoffs(task, prompt), warning),
        runStartedAt,
      });
      this.store.update(task.id, {
        sessionId: undefined,
        harnessSessionId: launched.sessionId,
        harnessSessionName: launched.sessionName,
        harnessStatus: launched.status,
        harnessCwd: execDirectory,
        harnessBranch: gitInfo.branch,
        harnessCommit: gitInfo.commit,
        harnessWarning: warning,
        runState: "running",
        runStartedAt,
        error: undefined,
        pending: undefined,
        completionLocation: undefined,
      });
      if (warning) {
        this.store.addEvent({ taskId: task.id, type: "task_warning", body: { warning } });
      }
      this.store.move(task.id, "in_progress", END_OF_COLUMN);
      this.startClaudeWatcher(task.id, launched.sessionName);
    } catch (err) {
      const updated = this.store.update(task.id, {
        runState: "error",
        error: errorMessage(err, "Failed to launch Claude Code background session"),
      });
      if (!updated) throw AdapterError.notFound(`Task not found: ${task.id}`);
      return updated;
    }

    const fresh = this.store.get(task.id);
    if (!fresh) throw AdapterError.notFound(`Task not found: ${task.id}`);
    return fresh;
  }

  /**
   * Resolve `dir` to its actual git repo root before any escape-detection
   * call. `git status`/`git worktree list` both report root-relative paths
   * and the repo root itself regardless of which subdirectory they're
   * invoked from — if a task's directory is a repo *subdirectory* rather
   * than its root, escape-detector.ts's main-checkout exclusion compares
   * against the wrong baseline, the real root leaks into its "registered
   * worktree" list, and every changed path ends up "inside" it: a silent,
   * unconditional `escaped: false` no matter what actually changed. Falls
   * back to `dir` itself if repoRoot() fails — escape detection must never
   * throw and hang a run because of this.
   */
  private async resolveRepoRoot(dir: string): Promise<string> {
    try {
      return await this.worktrees.repoRoot(dir);
    } catch {
      return dir;
    }
  }

  /**
   * Get (or lazily create) the git worktree for an isolated task. Reuses an
   * already-created worktree so a re-run doesn't collide on the branch; otherwise
   * cuts `board/<taskId>` from the task directory's current branch and records the
   * worktree metadata on the task.
   */
  private async ensureWorktree(
    task: Task,
    repoDir: string,
  ): Promise<{ worktreePath: string; branch: string; baseBranch: string }> {
    if (task.worktreePath && task.worktreeBranch) {
      return {
        worktreePath: task.worktreePath,
        branch: task.worktreeBranch,
        baseBranch: task.baseBranch ?? (await this.worktrees.currentBranch(repoDir)),
      };
    }
    const repoRoot = await this.worktrees.repoRoot(repoDir);
    const branch = `board/${task.id}`;
    const worktreePath = join(this.worktreeBaseDir(repoRoot), task.id);
    const info = await this.worktrees.createWorktree(repoDir, branch, worktreePath);
    this.store.update(task.id, {
      worktreePath: info.worktreePath,
      worktreeBranch: info.branch,
      baseBranch: info.baseBranch,
    });
    return info;
  }

  async initGitAndRun(taskId: string): Promise<Task> {
    const task = this.store.get(taskId);
    if (!task) throw AdapterError.notFound(`Task not found: ${taskId}`);
    const repoDir = this.resolveDirectory(task.directory);
    try {
      await this.worktrees.initRepo(repoDir);
    } catch (err) {
      const updated = this.store.update(taskId, {
        runState: "error",
        pending: undefined,
        error: errorMessage(err, "Failed to initialize git repository"),
      });
      if (!updated) throw AdapterError.notFound(`Task not found: ${taskId}`);
      return updated;
    }
    this.store.update(taskId, { pending: undefined });
    return this.run(taskId);
  }

  async syncUpstream(taskId: string): Promise<MergeOutcome> {
    const task = this.store.get(taskId);
    if (!task) throw AdapterError.notFound(`Task not found: ${taskId}`);
    if (!task.worktreePath || !task.baseBranch) {
      throw AdapterError.validation("Task has no worktree to sync");
    }
    const result = await this.worktrees.syncUpstream(task.worktreePath, task.baseBranch);
    return { task: this.store.get(taskId) ?? task, ...result };
  }

  async integrate(taskId: string, targetBranch?: string): Promise<MergeOutcome> {
    const task = this.store.get(taskId);
    if (!task) throw AdapterError.notFound(`Task not found: ${taskId}`);
    if (!task.worktreePath || !task.worktreeBranch) {
      throw AdapterError.validation("Task has no worktree to integrate");
    }
    // A still-running session may still be writing to the worktree/base
    // checkout via a bash escape (external_directory fencing never blocks
    // bash writes — see escape-detector.ts). The escape snapshot compare
    // below is a single check-then-act read; refusing to even start it while
    // the session is live closes most of that TOCTOU window instead of
    // racing a concurrent writer that this design already assumes exists.
    if (task.runState === "running") {
      throw AdapterError.validation("Cannot integrate a task while its session is still running");
    }
    const target = targetBranch ?? task.baseBranch;
    if (!target) throw AdapterError.validation("No target branch to integrate into");

    // Re-resolve the task directory to stay inside the workspace boundary even
    // after the worktree has been removed.
    const repoDir = this.resolveDirectory(task.directory);
    // The escape check specifically needs the repo root, not just any
    // directory inside it — see resolveRepoRoot(). git checkout/merge below
    // work fine from a subdirectory, so repoDir itself is left unchanged.
    const escapeCheckRoot = await this.resolveRepoRoot(repoDir);

    const escapeCheck = await detectBaseCheckoutEscape(escapeCheckRoot, task.baseCheckoutSnapshot ?? null);
    if (escapeCheck.escaped) {
      this.store.update(taskId, {
        pending: "base-checkout-escape",
        escapeDetectedPaths: escapeCheck.changedPaths,
      });
      return {
        task: this.store.get(taskId) ?? task,
        ok: false,
        conflict: false,
        message: `Refusing to integrate: base checkout changed outside the worktree (${escapeCheck.changedPaths.join(", ")})`,
      };
    }

    const result = await this.worktrees.integrate(
      repoDir,
      task.worktreeBranch,
      target,
      task.worktreePath,
    );
    // On success the worktree is gone (branch kept) — drop the stale path.
    if (result.ok) {
      this.store.update(taskId, { worktreePath: undefined });
    }
    return { task: this.store.get(taskId) ?? task, ...result };
  }

  private async prompt(
    sessionId: string,
    text: string,
    agent?: string,
    model?: Task["model"],
  ): Promise<string | undefined> {
    try {
      const promptModel = toPromptModel(model);
      const prompted = await this.client.session.promptAsync({
        sessionID: sessionId,
        ...(agent ? { agent } : {}),
        ...(promptModel ? { model: promptModel } : {}),
        ...(model?.variant ? { variant: model.variant } : {}),
        parts: [{ type: "text", text }],
      });
      const error = (prompted as { error?: unknown }).error;
      return error ? errorMessage(error, "Failed to prompt OpenCode session") : undefined;
    } catch (err) {
      return errorMessage(err, "Failed to prompt OpenCode session");
    }
  }

  private withCompletionContract(taskId: string, prompt: string, runStartedAt?: number): string {
    const taskPath = `/api/tasks/${encodeURIComponent(taskId)}`;
    const runQuery = runStartedAt === undefined ? "" : `?runStartedAt=${encodeURIComponent(String(runStartedAt))}`;
    const completeUrl = `${this.adapterBaseUrl}${taskPath}/complete${runQuery}`;
    const blockUrl = `${this.adapterBaseUrl}${taskPath}/block${runQuery}`;
    const authHeader = this.boardToken ? ` -H ${shellQuote(`Authorization: Bearer ${this.boardToken}`)}` : "";
    return `${prompt}\n\n---\nOPENBOARD COMPLETION CONTRACT\nTask id: ${taskId}\nWhen all work and verification are complete, call exactly one of these commands as your final action (replace JSON values with your actual report):\n\nComplete successfully:\ncurl -sS -X POST ${JSON.stringify(completeUrl)}${authHeader} -H 'content-type: application/json' -d '{"summary":"what changed","changedFiles":["path/to/file"],"verification":[{"command":"npm test","result":"passed"}],"residualRisk":"none"}'\n\nBlocked or incomplete:\ncurl -sS -X POST ${JSON.stringify(blockUrl)}${authHeader} -H 'content-type: application/json' -d '{"summary":"what was attempted","changedFiles":[],"verification":[{"command":"command run","result":"result or failure"}],"residualRisk":"what remains blocked"}'\n\nCall /complete or /block exactly once, and only as the final action. Do not continue working after reporting.`;
  }

  private withParentHandoffs(task: Task, prompt: string): string {
    const parentIds = task.parentIds ?? this.store.getParentIds(task.id);
    if (parentIds.length === 0) return prompt;

    const lines = [prompt, "", "---", "PARENT HANDOFFS"];
    for (const parentId of parentIds) {
      const parent = this.store.get(parentId);
      if (!parent) continue;
      lines.push(`Parent: ${parent.title} (${parent.id})`);
      if (parent.completion) {
        lines.push(`Summary: ${parent.completion.summary}`);
        lines.push(
          `Changed files: ${parent.completion.changedFiles.length > 0 ? parent.completion.changedFiles.join(", ") : "none"}`,
        );
        lines.push("Verification:");
        if (parent.completion.verification.length > 0) {
          for (const check of parent.completion.verification) {
            lines.push(`- ${check.command}: ${check.result}`);
          }
        } else {
          lines.push("- none reported");
        }
        lines.push(`Residual risk: ${parent.completion.residualRisk}`);
      } else {
        lines.push("No structured handoff exists; parent is manually marked Done.");
      }
      lines.push("");
    }

    return lines.join("\n").trimEnd();
  }

  /**
   * Boundary preamble for worktree-isolated task prompts — states the agent's actual
   * cwd, the base repo path it must not write to, and the relative-path recovery hint.
   * This is guidance/recovery only: `WRITE_FENCED_PERMISSION` + the permission-responder
   * pool are what actually block an absolute-path escape (worktree-isolation-plan.md
   * Phase 1). Telling the agent its boundaries upfront just makes it less likely to try
   * an absolute path in the first place, and gives it something to recover with if a
   * write is denied — it does not, on its own, un-stick an already-stalled session
   * (that's the dispatcher-side auto-nudge in trackStallAndMaybeNudge()).
   */
  private withWorktreeIsolationPreamble(worktreePath: string, baseRepoPath: string, prompt: string): string {
    return `OPENBOARD WORKTREE ISOLATION\nYour working directory (cwd): ${worktreePath}\nBase repo (READ-ONLY — do not write here): ${baseRepoPath}\nEdit only inside your worktree; use relative paths.\n---\n\n${prompt}`;
  }

  private withClaudePreflightContext(prompt: string, warning: string | undefined): string {
    if (!warning) return prompt;
    return `${prompt}\n\n---\nOPENBOARD PREFLIGHT WARNING\n${warning}\nIf you avoid the dirty target by using a Claude-managed worktree or branch, report the actual cwd, branch, and commit in your final OpenBoard report.`;
  }

  async retry(taskId: string, feedback?: string): Promise<Task> {
    const task = this.store.get(taskId);
    if (!task) {
      throw AdapterError.notFound(`Task not found: ${taskId}`);
    }
    this.assertNotArchived(task, "retry");
    if (task.harness === "claude-code") {
      this.assertParentsSatisfied(task);
      this.store.update(taskId, { completion: null, completionSource: null, finalSessionOutput: null });
      const execDirectory = this.resolveDirectory(task.worktreePath ?? task.directory);
      return this.runClaudeTask(task, execDirectory, feedback ?? task.description, "retry");
    }

    if (!task.sessionId) {
      throw AdapterError.notFound(`Task has no session to retry: ${taskId}`);
    }
    this.assertParentsSatisfied(task);
    this.store.update(taskId, { completion: null, completionSource: null, finalSessionOutput: null });
    this.outputCandidates.delete(task.sessionId);

    const runStartedAt = Date.now();
    // retry() re-prompts an existing session — the worktree already exists from
    // run(), so its path comes off the task record rather than ensureWorktree().
    const isolatedRetry = wantsWorktree(task, this.store);
    const retryPrompt = isolatedRetry
      ? this.withWorktreeIsolationPreamble(
          this.resolveDirectory(task.worktreePath ?? task.directory),
          this.resolveDirectory(task.directory),
          feedback ?? task.description,
        )
      : feedback ?? task.description;
    const promptError = await this.prompt(
      task.sessionId,
      this.withCompletionContract(task.id, this.withParentHandoffs(task, retryPrompt), runStartedAt),
      task.agent ?? undefined,
      task.model ?? undefined,
    );
    if (promptError) {
      const updated = this.store.update(taskId, { runState: "error", error: promptError });
      if (!updated) {
        throw AdapterError.notFound(`Task not found: ${taskId}`);
      }
      return updated;
    }

    this.store.update(taskId, { runState: "running", runStartedAt, error: undefined });
    this.store.move(taskId, "in_progress", END_OF_COLUMN);
    this.startCompletionWatcher(taskId, task.sessionId);
    if (wantsWorktree(task, this.store)) {
      this.startPermissionResponder(task.sessionId, this.resolveDirectory(task.worktreePath ?? task.directory));
    }

    const fresh = this.store.get(taskId);
    if (!fresh) {
      throw AdapterError.notFound(`Task not found: ${taskId}`);
    }
    return fresh;
  }

  private assertNotArchived(task: Task, action: "run" | "retry"): void {
    if (task.archived) throw new ArchivedTaskActionError(action);
  }

  private assertParentsSatisfied(task: Task): void {
    const parentIds = task.parentIds ?? this.store.getParentIds(task.id);
    if (parentIds.length === 0) return;

    const unmetParents = parentIds
      .map((parentId): UnmetParentDependency | null => {
        const parent = this.store.get(parentId);
        if (!parent) return { id: parentId, title: "Unknown parent", why: "parent task no longer exists" };
        const why = unmetReason(parent);
        return why ? { id: parent.id, title: parent.title, why } : null;
      })
      .filter((parent): parent is UnmetParentDependency => parent !== null);

    if (unmetParents.length > 0) {
      throw new DependencyGateError(unmetParents);
    }
  }

  async abort(taskId: string): Promise<void> {
    const task = this.store.get(taskId);
    if (task?.harness === "claude-code") {
      if (task.harnessSessionName) {
        this.cancelCompletionWatcher(task.harnessSessionName);
        try {
          await this.claudeRunner.abort(task.harnessSessionName);
        } catch (err) {
          this.store.update(taskId, {
            runState: "error",
            error: errorMessage(err, "Claude Code background abort failed"),
          });
          return;
        }
      }
      this.store.update(taskId, { runState: "idle", harnessStatus: "aborted" });
      return;
    }
    if (!task || !task.sessionId) {
      return;
    }
    await this.client.session.abort({ sessionID: task.sessionId });
    this.cancelCompletionWatcher(task.sessionId);
    this.stopPermissionResponder(task.sessionId);
    this.outputCandidates.delete(task.sessionId);
    this.store.update(taskId, { runState: "idle" });
  }

  /**
   * Begin consuming `client.event.subscribe()`. Safe to call once; a second call
   * while already running is a no-op. Auto-reconnects with backoff if the upstream
   * stream ends or errors, until `shutdown()` is called.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    const myGeneration = ++this.generation;
    this.consumeLoopPromise = this.runConsumeLoop(myGeneration);
  }

  /** Stop consuming the upstream event stream. Idempotent. */
  shutdown(): void {
    this.running = false;
    this.generation++;
    for (const watcher of this.completionWatchers.values()) {
      watcher.cancelled = true;
    }
    this.completionWatchers.clear();
    this.outputCandidates.clear();
    this.permissionResponderPool.stop();
  }

  // ---- internals ----

  private startCompletionWatcher(taskId: string, sessionId: string): void {
    this.cancelCompletionWatcher(sessionId);
    const watcher = { cancelled: false };
    this.completionWatchers.set(sessionId, watcher);
    void this.watchCompletion(taskId, sessionId, watcher);
  }

  private startClaudeWatcher(taskId: string, sessionName: string): void {
    this.cancelCompletionWatcher(sessionName);
    const watcher = { cancelled: false };
    this.completionWatchers.set(sessionName, watcher);
    void this.watchClaudeCompletion(taskId, sessionName, watcher);
  }

  private cancelCompletionWatcher(sessionId: string): void {
    const watcher = this.completionWatchers.get(sessionId);
    if (watcher) {
      watcher.cancelled = true;
      this.completionWatchers.delete(sessionId);
    }
  }

  /** Start (or restart) the external_directory ask auto-responder for a worktree session. */
  private startPermissionResponder(sessionId: string, directory: string): void {
    this.permissionResponderPool.register(sessionId, directory);
  }

  private stopPermissionResponder(sessionId: string): void {
    this.permissionResponderPool.unregister(sessionId);
  }

  /** Surface a persistently failing permission-responder list/reply call against its task. */
  private handlePermissionResponderError(
    sessionId: string,
    context: "list" | "reply",
    err: unknown,
  ): void {
    const task = this.listTasksForWatcher().find((t) => t.sessionId === sessionId);
    if (!task) return;
    const warning = `Permission auto-responder ${context} call is failing for this session: ${errorMessage(err, "unknown error")}`;
    this.store.addEvent({ taskId: task.id, type: "task_warning", body: { warning } });
  }

  private async watchCompletion(
    taskId: string,
    sessionId: string,
    watcher: { cancelled: boolean },
  ): Promise<void> {
    const startedAt = Date.now();
    const stallState: StallTrackingState = {
      lastMessageCount: 0,
      lastProgressAt: startedAt,
      consecutiveFutileNudges: 0,
    };

    try {
      while (!watcher.cancelled) {
        await sleep(COMPLETION_POLL_INTERVAL_MS);
        if (watcher.cancelled) return;

        const task = this.getTaskForWatcher(taskId);
        if (!task || task.sessionId !== sessionId || task.runState !== "running") return;

        if (Date.now() - startedAt > COMPLETION_WATCH_TIMEOUT_MS) {
          this.updateTaskForWatcher(taskId, {
            runState: "error",
            error: "Timed out waiting for OpenCode session completion",
          });
          return;
        }

        let messages: unknown;
        try {
          const result = await this.client.session.messages({ sessionID: sessionId });
          if ((result as { error?: unknown }).error) continue;
          messages = (result as { data?: unknown }).data;
        } catch {
          continue;
        }

        if (!hasAssistantTurnFinished(messages)) {
          const gaveUp = await this.trackStallAndMaybeNudge(taskId, sessionId, task, messages, stallState);
          if (gaveUp) return;
          continue;
        }

        const finalOutput = this.outputCandidates.get(sessionId) ?? extractFinalOutput(messages);

        const beforeFallback = this.getTaskForWatcher(taskId);
        if (!beforeFallback || beforeFallback.runState !== "running" || beforeFallback.completion) {
          return;
        }

        if (wantsWorktree(beforeFallback, this.store) && (await this.blockOnBaseCheckoutEscape(taskId, beforeFallback))) {
          return;
        }

        if (
          !this.updateTaskForWatcher(taskId, {
            runState: "idle",
            error: undefined,
            completion: null,
            completionSource: "idle-fallback",
            finalSessionOutput: finalOutput,
          })
        ) {
          return;
        }
        const fresh = this.getTaskForWatcher(taskId);
        if (fresh && (fresh.column === "todo" || fresh.column === "in_progress")) {
          const endOfReview = this.listTasksForWatcher().filter((t) => t.column === "review")
            .length;
          this.moveTaskForWatcher(taskId, "review", endOfReview);
        }
        return;
      }
    } finally {
      if (this.completionWatchers.get(sessionId) === watcher) {
        this.completionWatchers.delete(sessionId);
        this.outputCandidates.delete(sessionId);
      }
      // The permission responder must be stopped whenever this watcher stops
      // watching a worktree-isolated session, regardless of which exit path
      // got here — normal idle-fallback completion, timeout, escape
      // detection, or the task having already left "running" because the
      // agent itself reported completion via /complete or /block (those
      // routes flip runState directly on the store without touching the
      // dispatcher, so this finally block is the only place that reliably
      // observes every completion path for this sessionId).
      this.stopPermissionResponder(sessionId);
    }
  }

  /**
   * A fenced permission denial can leave a session sitting with its last
   * step finished for reason "tool-calls" and never continuing on its own
   * (live-proof finding — recovery-language in the original prompt did not
   * help). Detects that specific stall shape and sends up to
   * MAX_CONSECUTIVE_FUTILE_NUDGES automatic recovery nudges, giving the
   * agent denial-aware guidance when the responder pool recorded one.
   * `consecutiveFutileNudges` resets to 0 on any observed forward progress,
   * so the cap is "N nudges in a row with nothing in between," not a
   * lifetime budget — a prompt with several fenced paths should be able to
   * recover from each denial in turn without exhausting the budget on the
   * second one. Returns true when it gives up and transitions the task to
   * `runState: "error"`; the caller must stop watching in that case.
   */
  private async trackStallAndMaybeNudge(
    taskId: string,
    sessionId: string,
    task: Task,
    messages: unknown,
    stallState: StallTrackingState,
  ): Promise<boolean> {
    const currentCount = Array.isArray(messages) ? messages.length : 0;
    const now = Date.now();

    if (currentCount !== stallState.lastMessageCount) {
      stallState.lastMessageCount = currentCount;
      stallState.lastProgressAt = now;
      stallState.consecutiveFutileNudges = 0;
      return false;
    }

    // Not the specific stuck-after-tool-calls shape — e.g. a legitimately
    // long-running tool call (hasActiveTool) is still normal progress in
    // disguise, not a stall, and must never be nudged into.
    if (!isStalledAfterToolCalls(messages)) return false;

    if (now - stallState.lastProgressAt < this.stallThresholdMs) return false;

    const denial = this.permissionResponderPool.getLastDenial(sessionId);
    const recentDenial = denial && now - denial.deniedAt < DENIAL_RECENCY_WINDOW_MS ? denial : null;

    if (stallState.consecutiveFutileNudges >= MAX_CONSECUTIVE_FUTILE_NUDGES) {
      const error = recentDenial
        ? `Session stalled after ${MAX_CONSECUTIVE_FUTILE_NUDGES} automatic recovery nudges following a permission denial (tool: ${recentDenial.tool}); it did not recover on its own.`
        : `Session stalled after ${MAX_CONSECUTIVE_FUTILE_NUDGES} automatic recovery nudges with no progress; no permission denial was recorded as the cause.`;
      this.updateTaskForWatcher(taskId, { runState: "error", error });
      return true;
    }

    const nudgeText = recentDenial
      ? `Your last write was denied because it targeted a path outside your assigned working directory (tool: ${recentDenial.tool}). Redo it using a relative path inside your current working directory, or report via /block if you can't proceed.`
      : `You appear to have stalled. If your last action didn't complete, report what happened now and continue, or report via /complete or /block if you're done.`;

    const attempt = stallState.consecutiveFutileNudges + 1;
    const promptError = await this.prompt(sessionId, nudgeText, task.agent ?? undefined, task.model ?? undefined);
    stallState.consecutiveFutileNudges = attempt;
    stallState.lastProgressAt = now;

    // Re-baseline the message count to include the nudge's own injected
    // message, so the next tick's progress check requires the assistant to
    // actually respond beyond the nudge itself before resetting the streak.
    try {
      const result = await this.client.session.messages({ sessionID: sessionId });
      if (!(result as { error?: unknown }).error) {
        const freshMessages = (result as { data?: unknown }).data;
        if (Array.isArray(freshMessages)) stallState.lastMessageCount = freshMessages.length;
      }
    } catch {
      // Worst case the nudge's own message is mistaken for progress once —
      // costs one extra stall-threshold wait, not a correctness problem.
    }

    const warning = promptError
      ? `Auto-nudge attempt ${attempt}/${MAX_CONSECUTIVE_FUTILE_NUDGES} failed to send: ${promptError}`
      : recentDenial
        ? `Auto-nudged after a stall following a denied write (tool: ${recentDenial.tool}), attempt ${attempt}/${MAX_CONSECUTIVE_FUTILE_NUDGES}.`
        : `Auto-nudged after ${Math.round(this.stallThresholdMs / 1000)}s with no progress (no known denial cause), attempt ${attempt}/${MAX_CONSECUTIVE_FUTILE_NUDGES}.`;
    this.store.addEvent({ taskId, type: "task_warning", body: { warning } });

    return false;
  }

  /**
   * Re-check the base checkout against its dispatch-time snapshot for a
   * worktree-isolated task. If an escape is detected, marks the task blocked
   * (pending: "base-checkout-escape") with the changed paths instead of
   * letting the normal idle/review transition proceed, and returns true so
   * the caller stops there. Returns false (no state change) when the base
   * repo can't be resolved/checked or no escape is found.
   */
  private async blockOnBaseCheckoutEscape(taskId: string, task: Task): Promise<boolean> {
    try {
      const baseRepoDir = await this.resolveRepoRoot(this.resolveDirectory(task.directory));
      const { escaped, changedPaths } = await detectBaseCheckoutEscape(
        baseRepoDir,
        task.baseCheckoutSnapshot ?? null,
      );
      if (!escaped) return false;

      this.updateTaskForWatcher(taskId, {
        runState: "idle",
        pending: "base-checkout-escape",
        escapeDetectedPaths: changedPaths,
        completion: null,
        completionSource: null,
      });
      return true;
    } catch {
      // Detector failure shouldn't hang the run indefinitely — fall through
      // to the normal completion path rather than blocking forever on an
      // unrelated git error (e.g. the base repo dir vanished mid-run).
      return false;
    }
  }

  private async watchClaudeCompletion(
    taskId: string,
    sessionName: string,
    watcher: { cancelled: boolean },
  ): Promise<void> {
    const startedAt = Date.now();

    try {
      while (!watcher.cancelled) {
        await sleep(COMPLETION_POLL_INTERVAL_MS);
        if (watcher.cancelled) return;

        const task = this.getTaskForWatcher(taskId);
        if (!task || task.harness !== "claude-code" || task.harnessSessionName !== sessionName || task.runState !== "running") return;

        if (Date.now() - startedAt > COMPLETION_WATCH_TIMEOUT_MS) {
          this.updateTaskForWatcher(taskId, {
            runState: "error",
            error: "Timed out waiting for Claude Code background session completion",
          });
          return;
        }

        let status;
        try {
          status = await this.claudeRunner.poll(sessionName);
        } catch {
          continue;
        }
        if (!status) continue;

        const metadata: Partial<Omit<Task, "id" | "createdAt">> = {
          harnessStatus: status.status,
          ...(status.cwd ? { harnessCwd: status.cwd } : {}),
        };
        if (status.cwd) {
          const gitInfo = await inspectGitDirectory(status.cwd);
          if (gitInfo.branch) metadata.harnessBranch = gitInfo.branch;
          if (gitInfo.commit) metadata.harnessCommit = gitInfo.commit;
          if (status.cwd !== task.directory && gitInfo.isRepo && gitInfo.branch) {
            metadata.worktreePath = status.cwd;
            metadata.worktreeBranch = gitInfo.branch;
            if (!task.baseBranch) {
              const taskGitInfo = await inspectGitDirectory(task.directory);
              if (taskGitInfo.branch) metadata.baseBranch = taskGitInfo.branch;
            }
          }
        }
        this.updateTaskForWatcher(taskId, metadata);
        if (!status.terminal) continue;

        if (status.error) {
          this.updateTaskForWatcher(taskId, {
            runState: "error",
            error: `Claude Code session ended with status: ${status.error}`,
          });
          return;
        }

        const beforeFallback = this.getTaskForWatcher(taskId);
        if (!beforeFallback || beforeFallback.runState !== "running" || beforeFallback.completion) {
          return;
        }
        if (
          !this.updateTaskForWatcher(taskId, {
            runState: "idle",
            error: undefined,
            completion: null,
            completionSource: "idle-fallback",
            finalSessionOutput: null,
          })
        ) {
          return;
        }
        const fresh = this.getTaskForWatcher(taskId);
        if (fresh && (fresh.column === "todo" || fresh.column === "in_progress")) {
          const endOfReview = this.listTasksForWatcher().filter((t) => t.column === "review")
            .length;
          this.moveTaskForWatcher(taskId, "review", endOfReview);
        }
        return;
      }
    } finally {
      if (this.completionWatchers.get(sessionName) === watcher) {
        this.completionWatchers.delete(sessionName);
      }
    }
  }

  private getTaskForWatcher(taskId: string): Task | undefined {
    try {
      return this.store.get(taskId);
    } catch {
      return undefined;
    }
  }

  private listTasksForWatcher(): Task[] {
    try {
      return this.store.list();
    } catch {
      return [];
    }
  }

  private updateTaskForWatcher(
    taskId: string,
    patch: Partial<Omit<Task, "id" | "createdAt">>,
  ): Task | undefined {
    try {
      return this.store.update(taskId, patch);
    } catch {
      return undefined;
    }
  }

  private moveTaskForWatcher(taskId: string, column: Task["column"], position: number): void {
    try {
      this.store.move(taskId, column, position);
    } catch {
      // Store lifecycle races should end the watcher silently; foreground route
      // calls still surface their own errors.
    }
  }

  private handleEvent(event: OpencodeEvent): void {
    const sessionId = eventSessionId(event);
    if (!sessionId) return;

    const task = this.store.list().find((t) => t.sessionId === sessionId);
    if (!task) return;

    const textOutput = extractTextEndedOutput(event);
    if (textOutput) {
      this.outputCandidates.set(sessionId, textOutput);
    }

    const liveState = eventLiveState(event);
    if (liveState === null) return;

    switch (liveState) {
      case "running":
        // Only stamp the clock when actually transitioning into running —
        // live events re-assert "running" mid-run and must not reset it.
        this.store.update(
          task.id,
          task.runState === "running"
            ? { runState: "running" }
            : { runState: "running", runStartedAt: Date.now() },
        );
        break;

      case "idle":
        // OpenCode can report idle between tool-call steps. Keep the card
        // running until session.messages() shows a final assistant step.
        this.startCompletionWatcher(task.id, sessionId);
        break;

      case "error": {
        const message = this.extractErrorMessage(event);
        this.store.update(task.id, { runState: "error", error: message });
        this.outputCandidates.delete(sessionId);
        break;
      }

      default:
        break;
    }
  }

  private extractErrorMessage(event: OpencodeEvent): string {
    const properties = (event as { properties?: unknown }).properties;
    if (properties !== null && typeof properties === "object") {
      const props = properties as Record<string, unknown>;
      const error = props.error;
      if (typeof error === "string") return error;
      if (error !== null && typeof error === "object") {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === "string") return message;
      }
      const message = props.message;
      if (typeof message === "string") return message;
    }
    return "Session reported an error";
  }

  /**
   * Owns the lifetime of one upstream subscription attempt + its retry loop.
   * Exits cleanly once `generation` no longer matches (i.e. `shutdown()` was
   * called, or a newer `start()` superseded this loop).
   */
  private async runConsumeLoop(generation: number): Promise<void> {
    let attempt = 0;

    while (this.running && this.generation === generation) {
      try {
        const result = await this.client.event.subscribe();
        attempt = 0; // reset backoff once a connection succeeds

        for await (const event of result.stream) {
          if (!this.running || this.generation !== generation) return;
          try {
            this.handleEvent(event as OpencodeEvent);
          } catch {
            // A single bad event/store failure shouldn't kill the stream.
          }
        }
        // Stream ended normally (server closed it) — fall through to reconnect.
      } catch {
        // Stream errored — fall through to reconnect.
      }

      if (!this.running || this.generation !== generation) return;

      attempt += 1;
      const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1), RECONNECT_MAX_DELAY_MS);
      await sleep(delay);
    }
  }
}
