import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { OpencodeEvent, Task } from "../../src/shared";
import { SqliteTaskStore } from "../../src/db/task-store";
import { TaskDispatcher } from "../../src/server/dispatcher";

async function* makeAsyncGenerator<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("waitFor timed out"));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

/**
 * Fake OpenCode client. `session.create` returns a fixed fresh session id (or a
 * queued override), `promptAsync`/`abort` are spies, and `event.subscribe()` yields
 * a scripted async generator per call so tests can control what each "connection"
 * (including reconnects) delivers.
 */
class FakeOpencodeClient {
  createCalls: Array<{ directory?: string; title?: string }> = [];
  promptAsyncCalls: Array<{ sessionID: string; parts: unknown }> = [];
  abortCalls: Array<{ sessionID: string }> = [];

  nextSessionId = "ses_x";
  createShouldError: { error: unknown } | null = null;

  private scripts: OpencodeEvent[][] = [];
  subscribeCallCount = 0;

  queueScript(events: OpencodeEvent[]): void {
    this.scripts.push(events);
  }

  session = {
    create: async (params: { directory?: string; title?: string }) => {
      this.createCalls.push(params);
      if (this.createShouldError) {
        return { data: undefined, error: this.createShouldError.error };
      }
      return {
        data: { id: this.nextSessionId, directory: params.directory, title: params.title },
        error: undefined,
      };
    },
    promptAsync: async (params: { sessionID: string; parts: unknown }) => {
      this.promptAsyncCalls.push(params);
      return { data: {}, error: undefined };
    },
    abort: async (params: { sessionID: string }) => {
      this.abortCalls.push(params);
      return { data: {}, error: undefined };
    },
  };

  event = {
    subscribe: async () => {
      const script = this.scripts[this.subscribeCallCount] ?? [];
      this.subscribeCallCount += 1;
      return { stream: makeAsyncGenerator(script) };
    },
  };
}

describe("TaskDispatcher", () => {
  let client: FakeOpencodeClient;
  let store: SqliteTaskStore;
  let dispatcher: TaskDispatcher;

  beforeEach(() => {
    client = new FakeOpencodeClient();
    store = new SqliteTaskStore(":memory:");
  });

  afterEach(() => {
    dispatcher?.shutdown();
    store.close();
  });

  function createTask(overrides: Partial<{ title: string; description: string; directory: string }> = {}) {
    return store.create({
      title: overrides.title ?? "Fix the bug",
      description: overrides.description ?? "Please fix the bug in foo.ts",
      directory: overrides.directory ?? "/tmp/project",
    });
  }

  describe("run()", () => {
    it("throws AdapterError.notFound when the task doesn't exist", async () => {
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await expect(dispatcher.run("task_missing")).rejects.toMatchObject({
        code: "session_not_found",
      });
    });

    it("throws AdapterError.unreachable when session.create errors", async () => {
      const task = createTask();
      client.createShouldError = { error: { message: "boom" } };
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await expect(dispatcher.run(task.id)).rejects.toMatchObject({
        code: "opencode_unreachable",
      });
    });

    it("creates a session in task.directory, prompts with task.description, links + moves to in_progress", async () => {
      const task = createTask({ directory: "/tmp/my-project", title: "Fix the bug" });
      client.nextSessionId = "ses_abc123";
      dispatcher = new TaskDispatcher({ client: client as never, store });

      const result = await dispatcher.run(task.id);

      expect(client.createCalls).toEqual([{ directory: "/tmp/my-project", title: "Fix the bug" }]);
      expect(client.promptAsyncCalls).toEqual([
        { sessionID: "ses_abc123", parts: [{ type: "text", text: task.description }] },
      ]);

      expect(result.sessionId).toBe("ses_abc123");
      expect(result.runState).toBe("running");
      expect(result.column).toBe("in_progress");

      const persisted = store.get(task.id);
      expect(persisted?.sessionId).toBe("ses_abc123");
      expect(persisted?.runState).toBe("running");
      expect(persisted?.column).toBe("in_progress");
    });

    it("lands the task at the end of in_progress when other tasks are already there", async () => {
      const other = createTask({ title: "Other task" });
      store.move(other.id, "in_progress", 0);

      const task = createTask({ title: "New task" });
      client.nextSessionId = "ses_new";
      dispatcher = new TaskDispatcher({ client: client as never, store });

      const result = await dispatcher.run(task.id);

      expect(result.column).toBe("in_progress");
      const inProgress = store.list().filter((t) => t.column === "in_progress");
      expect(inProgress.map((t) => t.id)).toEqual([other.id, task.id]);
      expect(result.position).toBe(1);
    });
  });

  describe("start() — event-driven auto-transitions", () => {
    it("moves a task to 'review' with runState 'idle' on a session.idle event for its session", async () => {
      const task = createTask();
      client.nextSessionId = "ses_live";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      const ran = await dispatcher.run(task.id);
      expect(ran.column).toBe("in_progress");

      client.queueScript([
        {
          id: "evt_1",
          type: "session.idle",
          properties: { sessionID: "ses_live" },
        } as unknown as OpencodeEvent,
      ]);

      dispatcher.start();

      await waitFor(() => store.get(task.id)?.column === "review");

      const updated = store.get(task.id);
      expect(updated?.column).toBe("review");
      expect(updated?.runState).toBe("idle");
    });

    it("sets runState 'running' on a running-signal event without moving the task", async () => {
      const task = createTask();
      client.nextSessionId = "ses_running";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);

      client.queueScript([
        {
          id: "evt_1",
          type: "session.next.step.started",
          properties: { sessionID: "ses_running" },
        } as unknown as OpencodeEvent,
      ]);

      dispatcher.start();

      await waitFor(() => {
        const t = store.get(task.id);
        return t?.runState === "running";
      });

      const updated = store.get(task.id);
      expect(updated?.runState).toBe("running");
      expect(updated?.column).toBe("in_progress");
    });

    it("sets runState 'error' and records the message on a session.error event", async () => {
      const task = createTask();
      client.nextSessionId = "ses_err";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);

      client.queueScript([
        {
          id: "evt_1",
          type: "session.error",
          properties: {
            sessionID: "ses_err",
            error: { name: "UnknownError", data: { message: "Something broke" } },
          },
        } as unknown as OpencodeEvent,
      ]);

      dispatcher.start();

      await waitFor(() => store.get(task.id)?.runState === "error");

      const updated = store.get(task.id);
      expect(updated?.runState).toBe("error");
      expect(updated?.error).toBeTruthy();
      // Error event does not auto-move the card.
      expect(updated?.column).toBe("in_progress");
    });

    it("sets runState 'error' via step.failed event", async () => {
      const task = createTask();
      client.nextSessionId = "ses_step_fail";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);

      client.queueScript([
        {
          id: "evt_1",
          type: "session.next.step.failed",
          properties: { sessionID: "ses_step_fail" },
        } as unknown as OpencodeEvent,
      ]);

      dispatcher.start();

      await waitFor(() => store.get(task.id)?.runState === "error");
      expect(store.get(task.id)?.runState).toBe("error");
    });

    it("ignores events for sessions with no linked task", async () => {
      client.queueScript([
        {
          id: "evt_1",
          type: "session.idle",
          properties: { sessionID: "ses_unlinked" },
        } as unknown as OpencodeEvent,
      ]);

      dispatcher = new TaskDispatcher({ client: client as never, store });
      dispatcher.start();

      // Give the loop a tick to process the (ignored) event; nothing should throw
      // and no tasks should exist/change.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(store.list()).toEqual([]);
    });

    it("does not re-move a task already past in_progress (e.g. already in review)", async () => {
      const task = createTask();
      client.nextSessionId = "ses_already_review";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);

      // Simulate the task having already been moved on to 'done' by a user/other flow.
      store.move(task.id, "done", 0);

      client.queueScript([
        {
          id: "evt_1",
          type: "session.idle",
          properties: { sessionID: "ses_already_review" },
        } as unknown as OpencodeEvent,
      ]);

      dispatcher.start();

      await waitFor(() => store.get(task.id)?.runState === "idle");

      // runState still updates, but the column must not be forced back to review.
      expect(store.get(task.id)?.column).toBe("done");
    });

    it("auto-reconnects with backoff after the stream ends, and keeps handling events", async () => {
      const task = createTask();
      client.nextSessionId = "ses_reconnect";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);

      // First "connection" yields nothing and ends; second connection delivers idle.
      client.queueScript([]);
      client.queueScript([
        {
          id: "evt_1",
          type: "session.idle",
          properties: { sessionID: "ses_reconnect" },
        } as unknown as OpencodeEvent,
      ]);

      vi.useFakeTimers();
      dispatcher.start();

      // Let the first (empty) stream resolve.
      await vi.advanceTimersByTimeAsync(0);
      // Advance past the reconnect backoff delay.
      await vi.advanceTimersByTimeAsync(1000);
      vi.useRealTimers();

      await waitFor(() => store.get(task.id)?.column === "review");
      expect(client.subscribeCallCount).toBeGreaterThanOrEqual(2);
      expect(store.get(task.id)?.column).toBe("review");
    });
  });

  describe("retry()", () => {
    it("prompts the existing session with feedback and moves back to in_progress", async () => {
      const task = createTask();
      client.nextSessionId = "ses_retry";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);
      store.move(task.id, "review", 0);
      store.update(task.id, { runState: "idle" });

      const result = await dispatcher.retry(task.id, "Please also fix the typo");

      expect(client.promptAsyncCalls[client.promptAsyncCalls.length - 1]).toEqual({
        sessionID: "ses_retry",
        parts: [{ type: "text", text: "Please also fix the typo" }],
      });
      expect(result.runState).toBe("running");
      expect(result.column).toBe("in_progress");
    });

    it("falls back to task.description when no feedback is given", async () => {
      const task = createTask({ description: "Original description" });
      client.nextSessionId = "ses_retry2";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);

      await dispatcher.retry(task.id);

      expect(client.promptAsyncCalls[client.promptAsyncCalls.length - 1]).toEqual({
        sessionID: "ses_retry2",
        parts: [{ type: "text", text: "Original description" }],
      });
    });

    it("throws AdapterError.notFound when the task doesn't exist", async () => {
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await expect(dispatcher.retry("task_missing")).rejects.toMatchObject({
        code: "session_not_found",
      });
    });
  });

  describe("abort()", () => {
    it("calls client.session.abort with the task's sessionID", async () => {
      const task = createTask();
      client.nextSessionId = "ses_abort";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);

      await dispatcher.abort(task.id);

      expect(client.abortCalls).toEqual([{ sessionID: "ses_abort" }]);
    });

    it("is a no-op when the task has no linked session", async () => {
      const task = createTask();
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await dispatcher.abort(task.id);

      expect(client.abortCalls).toEqual([]);
    });

    it("is a no-op when the task doesn't exist", async () => {
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await expect(dispatcher.abort("task_missing")).resolves.toBeUndefined();
    });
  });

  describe("shutdown()", () => {
    it("stops consuming further events", async () => {
      const task = createTask();
      client.nextSessionId = "ses_shutdown";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);

      client.queueScript([]);
      dispatcher.start();
      await new Promise((resolve) => setTimeout(resolve, 10));

      dispatcher.shutdown();

      // A second start() after shutdown should be able to begin a fresh generation.
      client.queueScript([
        {
          id: "evt_1",
          type: "session.idle",
          properties: { sessionID: "ses_shutdown" },
        } as unknown as OpencodeEvent,
      ]);
      dispatcher.start();

      await waitFor(() => store.get(task.id)?.column === "review");
      expect(store.get(task.id)?.column).toBe("review");
    });
  });
});
