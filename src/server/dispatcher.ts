/**
 * The Push dispatcher — turns Tasks into running OpenCode sessions and auto-moves
 * cards as those sessions progress.
 *
 * `run()` creates a session in the task's directory, kicks off an async prompt with
 * the task's description, links the session id onto the task, and moves it to
 * `in_progress`. `start()` consumes the global `/event` stream and reacts to
 * live-state changes on any session linked to a task: `running` keeps the task in
 * sync, `idle` auto-advances the task to `review` (the session finished its turn),
 * and `error` records the failure without moving the card. `retry()` re-prompts an
 * existing session and moves the task back to `in_progress`. `abort()` stops the
 * task's session. `shutdown()` stops consuming the event stream.
 */
import { basename, dirname, join } from "node:path";
import type { MergeOutcome, OpencodeEvent, Task, TaskStore } from "../shared";
import { AdapterError, UNATTENDED_PERMISSION } from "../shared";
import type { Dispatcher } from "../shared";
import type { OpencodeHandle } from "./opencode";
import { eventLiveState, eventSessionId } from "./events/session-status";
import { GitWorktreeManager, type WorktreeManager } from "./worktree";

export interface TaskDispatcherDeps {
  client: OpencodeHandle["client"];
  store: TaskStore;
  /** Git worktree engine for isolated runs. Defaults to a real GitWorktreeManager. */
  worktrees?: WorktreeManager;
  /**
   * Where a repo's worktrees live. Default: a sibling `.opencode-board-worktrees/<repo>`
   * dir next to the repo root, so worktrees never nest inside the main working tree.
   */
  worktreeBaseDir?: (repoRoot: string) => string;
}

/** Resolve the effective isolation for a task: its override, else the board default. */
function wantsWorktree(task: Task, store: TaskStore): boolean {
  if (task.isolation) return task.isolation === "worktree";
  return store.getSettings().worktreeDefault;
}

/** Base/backoff tuning for reconnecting to the upstream OpenCode event stream. */
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 15000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The v2 session create response body is double-nested: the SDK's {data,error}
 * wrapper wraps the endpoint's own {data: session}. Unwrap defensively.
 */
function extractSessionId(data: unknown): string | undefined {
  const inner = (data as { data?: unknown })?.data ?? data;
  const id = (inner as { id?: unknown })?.id;
  return typeof id === "string" ? id : undefined;
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

export class TaskDispatcher implements Dispatcher {
  private readonly client: OpencodeHandle["client"];
  private readonly store: TaskStore;
  private readonly worktrees: WorktreeManager;
  private readonly worktreeBaseDir: (repoRoot: string) => string;

  private running = false;
  /** Bumped on every stop()/restart so a stale consume loop knows to exit. */
  private generation = 0;
  private consumeLoopPromise: Promise<void> | null = null;

  constructor(deps: TaskDispatcherDeps) {
    this.client = deps.client;
    this.store = deps.store;
    this.worktrees = deps.worktrees ?? new GitWorktreeManager();
    this.worktreeBaseDir =
      deps.worktreeBaseDir ??
      ((repoRoot) => join(dirname(repoRoot), ".opencode-board-worktrees", basename(repoRoot)));
  }

  async run(taskId: string): Promise<Task> {
    const task = this.store.get(taskId);
    if (!task) {
      throw AdapterError.notFound(`Task not found: ${taskId}`);
    }

    // Resolve where the session actually runs. In worktree isolation the session
    // runs in a dedicated `git worktree`; a non-repo directory can't be isolated,
    // so we block the run and surface the "make it a git repo?" decision instead.
    let execDirectory = task.directory;
    if (wantsWorktree(task, this.store)) {
      if (!(await this.worktrees.isGitRepo(task.directory))) {
        const blocked = this.store.update(taskId, {
          pending: "git-init",
          runState: "unstarted",
          error: undefined,
        });
        if (!blocked) throw AdapterError.notFound(`Task not found: ${taskId}`);
        return blocked;
      }
      const wt = await this.ensureWorktree(task);
      execDirectory = wt.worktreePath;
    }

    // v2 session.create binds the agent + model + location, then v2
    // session.prompt admits the input and schedules the autonomous agent loop.
    // OpenCode 1.17.13 also accepts this permission field at runtime even
    // though the generated v2 SDK type has not caught up.
    const createInput = {
      agent: task.agent,
      model: task.model,
      location: { directory: execDirectory },
      permission: UNATTENDED_PERMISSION,
    };
    const created = await this.client.v2.session.create(createInput);
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

    const promptError = await this.prompt(sessionId, task.description);
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
      error: undefined,
      pending: undefined,
    });
    this.store.move(taskId, "in_progress", END_OF_COLUMN);

    const fresh = this.store.get(taskId);
    if (!fresh) {
      throw AdapterError.notFound(`Task not found: ${taskId}`);
    }
    return fresh;
  }

  /**
   * Get (or lazily create) the git worktree for an isolated task. Reuses an
   * already-created worktree so a re-run doesn't collide on the branch; otherwise
   * cuts `board/<taskId>` from the task directory's current branch and records the
   * worktree metadata on the task.
   */
  private async ensureWorktree(
    task: Task,
  ): Promise<{ worktreePath: string; branch: string; baseBranch: string }> {
    if (task.worktreePath && task.worktreeBranch) {
      return {
        worktreePath: task.worktreePath,
        branch: task.worktreeBranch,
        baseBranch: task.baseBranch ?? (await this.worktrees.currentBranch(task.directory)),
      };
    }
    const repoRoot = await this.worktrees.repoRoot(task.directory);
    const branch = `board/${task.id}`;
    const worktreePath = join(this.worktreeBaseDir(repoRoot), task.id);
    const info = await this.worktrees.createWorktree(task.directory, branch, worktreePath);
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
    try {
      await this.worktrees.initRepo(task.directory);
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
    const target = targetBranch ?? task.baseBranch;
    if (!target) throw AdapterError.validation("No target branch to integrate into");

    const repoRoot = await this.worktrees.repoRoot(task.directory);
    const result = await this.worktrees.integrate(
      repoRoot,
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

  private async prompt(sessionId: string, text: string): Promise<string | undefined> {
    try {
      const prompted = await this.client.v2.session.prompt({
        sessionID: sessionId,
        prompt: { text },
      });
      const error = (prompted as { error?: unknown }).error;
      return error ? errorMessage(error, "Failed to prompt OpenCode session") : undefined;
    } catch (err) {
      return errorMessage(err, "Failed to prompt OpenCode session");
    }
  }

  async retry(taskId: string, feedback?: string): Promise<Task> {
    const task = this.store.get(taskId);
    if (!task) {
      throw AdapterError.notFound(`Task not found: ${taskId}`);
    }
    if (!task.sessionId) {
      throw AdapterError.notFound(`Task has no session to retry: ${taskId}`);
    }

    const promptError = await this.prompt(task.sessionId, feedback ?? task.description);
    if (promptError) {
      const updated = this.store.update(taskId, { runState: "error", error: promptError });
      if (!updated) {
        throw AdapterError.notFound(`Task not found: ${taskId}`);
      }
      return updated;
    }

    this.store.update(taskId, { runState: "running", error: undefined });
    this.store.move(taskId, "in_progress", END_OF_COLUMN);

    const fresh = this.store.get(taskId);
    if (!fresh) {
      throw AdapterError.notFound(`Task not found: ${taskId}`);
    }
    return fresh;
  }

  async abort(taskId: string): Promise<void> {
    const task = this.store.get(taskId);
    if (!task || !task.sessionId) {
      return;
    }
    await this.client.session.abort({ sessionID: task.sessionId });
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
  }

  // ---- internals ----

  private handleEvent(event: OpencodeEvent): void {
    const sessionId = eventSessionId(event);
    if (!sessionId) return;

    const task = this.store.list().find((t) => t.sessionId === sessionId);
    if (!task) return;

    const liveState = eventLiveState(event);
    if (liveState === null) return;

    switch (liveState) {
      case "running":
        this.store.update(task.id, { runState: "running" });
        break;

      case "idle":
        this.store.update(task.id, { runState: "idle" });
        // Auto-advance to Review on the session finishing its turn — but guard
        // against re-moving a task that's already past in_progress (e.g. a user
        // already dragged it to review/done, or a late/duplicate idle event).
        if (task.column === "todo" || task.column === "in_progress") {
          const endOfReview = this.store.list().filter((t) => t.column === "review").length;
          this.store.move(task.id, "review", endOfReview);
        }
        break;

      case "error": {
        const message = this.extractErrorMessage(event);
        this.store.update(task.id, { runState: "error", error: message });
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
