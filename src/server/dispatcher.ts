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
import type { OpencodeEvent, Task, TaskStore } from "../shared";
import { AdapterError, UNATTENDED_PERMISSION } from "../shared";
import type { Dispatcher } from "../shared";
import type { OpencodeHandle } from "./opencode";
import { eventLiveState, eventSessionId } from "./events/session-status";

export interface TaskDispatcherDeps {
  client: OpencodeHandle["client"];
  store: TaskStore;
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

export class TaskDispatcher implements Dispatcher {
  private readonly client: OpencodeHandle["client"];
  private readonly store: TaskStore;

  private running = false;
  /** Bumped on every stop()/restart so a stale consume loop knows to exit. */
  private generation = 0;
  private consumeLoopPromise: Promise<void> | null = null;

  constructor(deps: TaskDispatcherDeps) {
    this.client = deps.client;
    this.store = deps.store;
  }

  async run(taskId: string): Promise<Task> {
    const task = this.store.get(taskId);
    if (!task) {
      throw AdapterError.notFound(`Task not found: ${taskId}`);
    }

    // Verified recipe (empirically confirmed against opencode v1.17.13):
    // v2 session.create binds the agent + model + an allow-all permission ruleset
    // so the session runs UNATTENDED, then v2 session.prompt admits the input and
    // schedules the autonomous agent loop. `session.wait` is a stub in this version,
    // so completion is detected from the /event stream (see handleEvent). NB: v2
    // create runs the session in the opencode server's working directory.
    const created = await this.client.v2.session.create({
      agent: task.agent,
      model: task.model,
      permission: UNATTENDED_PERMISSION as never,
    } as never);
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

    await this.client.v2.session.prompt({
      sessionID: sessionId,
      prompt: { text: task.description },
    } as never);

    this.store.update(taskId, { sessionId, runState: "running" });
    this.store.move(taskId, "in_progress", END_OF_COLUMN);

    const fresh = this.store.get(taskId);
    if (!fresh) {
      throw AdapterError.notFound(`Task not found: ${taskId}`);
    }
    return fresh;
  }

  async retry(taskId: string, feedback?: string): Promise<Task> {
    const task = this.store.get(taskId);
    if (!task) {
      throw AdapterError.notFound(`Task not found: ${taskId}`);
    }
    if (!task.sessionId) {
      throw AdapterError.notFound(`Task has no session to retry: ${taskId}`);
    }

    await this.client.v2.session.prompt({
      sessionID: task.sessionId,
      prompt: { text: feedback ?? task.description },
    } as never);

    this.store.update(taskId, { runState: "running" });
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
