import { describe, expect, it, vi } from "vitest";
import { createTaskStore, type TaskClientLike, type ConnectFn } from "../../src/web/taskStore";
import type { RosterAgent, Task, TaskFrame } from "../../src/shared";

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: overrides.id,
    description: "do the thing",
    directory: "/tmp",
    column: "todo",
    position: 0,
    runState: "unstarted",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

interface FakeConnectHandle {
  handlers?: { onFrame: (f: TaskFrame) => void; onStatus: (s: "connecting" | "open" | "closed") => void };
  disconnect: ReturnType<typeof vi.fn<() => void>>;
}

function makeFakeConnect(): { connect: ConnectFn; handle: FakeConnectHandle } {
  const handle: FakeConnectHandle = { disconnect: vi.fn<() => void>() };
  const connect: ConnectFn = (handlers) => {
    handle.handlers = handlers;
    return () => handle.disconnect();
  };
  return { connect, handle };
}

function makeFakeClient(overrides: Partial<TaskClientLike> = {}): TaskClientLike {
  return {
    getTasks: vi.fn(async () => []),
    createTask: vi.fn(async () => makeTask({ id: "new" })),
    runTask: vi.fn(async () => makeTask({ id: "new", runState: "running" })),
    retryTask: vi.fn(async () => makeTask({ id: "new", runState: "running" })),
    abortTask: vi.fn(async () => makeTask({ id: "new", runState: "idle" })),
    moveTask: vi.fn(async () => []),
    removeTask: vi.fn(async () => {}),
    getAgents: vi.fn(async () => [{ id: "build", mode: "primary" as const }]),
    getHealth: vi.fn(async () => ({ opencode: "ok" as const })),
    initGitTask: vi.fn(async () => makeTask({ id: "new", runState: "running" })),
    syncTask: vi.fn(async () => ({
      task: makeTask({ id: "new" }),
      ok: true,
      conflict: false,
      message: "merged",
    })),
    integrateTask: vi.fn(async () => ({
      task: makeTask({ id: "new" }),
      ok: true,
      conflict: false,
      message: "integrated",
    })),
    getSettings: vi.fn(async () => ({ worktreeDefault: false })),
    updateSettings: vi.fn(async () => ({ worktreeDefault: true })),
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createTaskStore — frame folding", () => {
  it("folds snapshot then upsert then remove, sorted by column order then position", async () => {
    const { connect, handle } = makeFakeConnect();
    const client = makeFakeClient();
    const store = createTaskStore({ client, connect, healthPollMs: 1_000_000 });

    store.init();
    await flush();

    const taskA = makeTask({ id: "a", column: "in_progress", position: 1 });
    const taskB = makeTask({ id: "b", column: "todo", position: 5 });
    const taskC = makeTask({ id: "c", column: "todo", position: 1 });

    handle.handlers?.onFrame({ kind: "snapshot", seq: 1, tasks: [taskA, taskB, taskC] });

    let snapshot = store.getSnapshot();
    expect(snapshot.tasks.map((t) => t.id)).toEqual(["c", "b", "a"]);

    const taskAUpdated = makeTask({ id: "a", column: "todo", position: 0 });
    handle.handlers?.onFrame({ kind: "upsert", seq: 2, task: taskAUpdated });

    snapshot = store.getSnapshot();
    expect(snapshot.tasks.map((t) => t.id)).toEqual(["a", "c", "b"]);

    handle.handlers?.onFrame({ kind: "remove", seq: 3, taskId: "c" });

    snapshot = store.getSnapshot();
    expect(snapshot.tasks.map((t) => t.id)).toEqual(["a", "b"]);

    store.dispose();
  });

  it("sorts across all four columns in COLUMNS order", async () => {
    const { connect, handle } = makeFakeConnect();
    const client = makeFakeClient();
    const store = createTaskStore({ client, connect, healthPollMs: 1_000_000 });

    store.init();
    await flush();

    const tasks = [
      makeTask({ id: "done1", column: "done", position: 0 }),
      makeTask({ id: "review1", column: "review", position: 0 }),
      makeTask({ id: "inprog1", column: "in_progress", position: 0 }),
      makeTask({ id: "todo1", column: "todo", position: 0 }),
    ];
    handle.handlers?.onFrame({ kind: "snapshot", seq: 1, tasks });

    const snapshot = store.getSnapshot();
    expect(snapshot.tasks.map((t) => t.id)).toEqual(["todo1", "inprog1", "review1", "done1"]);

    store.dispose();
  });

  it("heartbeat frames do not change task state", async () => {
    const { connect, handle } = makeFakeConnect();
    const client = makeFakeClient();
    const store = createTaskStore({ client, connect, healthPollMs: 1_000_000 });

    store.init();
    await flush();

    handle.handlers?.onFrame({ kind: "snapshot", seq: 1, tasks: [makeTask({ id: "a" })] });
    const before = store.getSnapshot();

    handle.handlers?.onFrame({ kind: "heartbeat", seq: 2 });
    const after = store.getSnapshot();

    expect(after.tasks).toEqual(before.tasks);

    store.dispose();
  });
});

describe("createTaskStore — init()", () => {
  it("loads tasks and agents via the client on init", async () => {
    const { connect } = makeFakeConnect();
    const roster: RosterAgent[] = [{ id: "build", mode: "primary" }];
    const client = makeFakeClient({
      getTasks: vi.fn(async () => [makeTask({ id: "a" })]),
      getAgents: vi.fn(async () => roster),
    });
    const store = createTaskStore({ client, connect, healthPollMs: 1_000_000 });

    store.init();
    await flush();

    const snapshot = store.getSnapshot();
    expect(snapshot.tasks.map((t) => t.id)).toEqual(["a"]);
    expect(snapshot.agents).toEqual(roster);
    expect(client.getTasks).toHaveBeenCalledTimes(1);
    expect(client.getAgents).toHaveBeenCalledTimes(1);
    expect(client.getHealth).toHaveBeenCalledTimes(1);

    store.dispose();
  });
});

describe("createTaskStore — create/run/retry/abort/remove", () => {
  it("create() calls client.createTask and upserts the returned task", async () => {
    const { connect } = makeFakeConnect();
    const created = makeTask({ id: "new-task", title: "Ship it" });
    const client = makeFakeClient({ createTask: vi.fn(async () => created) });
    const store = createTaskStore({ client, connect, healthPollMs: 1_000_000 });

    store.init();
    await flush();

    await store.create({ title: "Ship it", description: "desc", directory: "/tmp" });

    expect(client.createTask).toHaveBeenCalledWith({
      title: "Ship it",
      description: "desc",
      directory: "/tmp",
    });
    const snapshot = store.getSnapshot();
    expect(snapshot.tasks.map((t) => t.id)).toEqual(["new-task"]);
  });

  it("run() calls client.runTask with the task id and updates state", async () => {
    const { connect, handle } = makeFakeConnect();
    const ran = makeTask({ id: "a", runState: "running" });
    const client = makeFakeClient({ runTask: vi.fn(async () => ran) });
    const store = createTaskStore({ client, connect, healthPollMs: 1_000_000 });

    store.init();
    await flush();
    handle.handlers?.onFrame({ kind: "snapshot", seq: 1, tasks: [makeTask({ id: "a" })] });

    await store.run("a");

    expect(client.runTask).toHaveBeenCalledWith("a");
    const snapshot = store.getSnapshot();
    expect(snapshot.tasks[0]?.runState).toBe("running");
  });

  it("retry() calls client.retryTask with the task id", async () => {
    const { connect } = makeFakeConnect();
    const client = makeFakeClient();
    const store = createTaskStore({ client, connect, healthPollMs: 1_000_000 });

    store.init();
    await flush();

    await store.retry("a");
    expect(client.retryTask).toHaveBeenCalledWith("a");
  });

  it("abort() calls client.abortTask with the task id and upserts the returned Task", async () => {
    const { connect, handle } = makeFakeConnect();
    const aborted = makeTask({ id: "a", runState: "idle", column: "in_progress" });
    const client = makeFakeClient({ abortTask: vi.fn(async () => aborted) });
    const store = createTaskStore({ client, connect, healthPollMs: 1_000_000 });

    store.init();
    await flush();
    handle.handlers?.onFrame({
      kind: "snapshot",
      seq: 1,
      tasks: [makeTask({ id: "a", runState: "running", column: "in_progress" })],
    });

    await store.abort("a");

    expect(client.abortTask).toHaveBeenCalledWith("a");
    expect(store.getSnapshot().tasks).toEqual([aborted]);
  });

  it("remove() calls client.removeTask and drops the task from state", async () => {
    const { connect, handle } = makeFakeConnect();
    const client = makeFakeClient();
    const store = createTaskStore({ client, connect, healthPollMs: 1_000_000 });

    store.init();
    await flush();
    handle.handlers?.onFrame({ kind: "snapshot", seq: 1, tasks: [makeTask({ id: "a" })] });

    await store.remove("a");

    expect(client.removeTask).toHaveBeenCalledWith("a");
    expect(store.getSnapshot().tasks).toEqual([]);
  });
});

describe("createTaskStore — move()", () => {
  it("optimistically updates then reconciles with the returned board", async () => {
    const { connect, handle } = makeFakeConnect();
    let resolveMove: (tasks: Task[]) => void = () => {};
    const movePromise = new Promise<Task[]>((resolve) => {
      resolveMove = resolve;
    });
    const client = makeFakeClient({
      moveTask: vi.fn(() => movePromise),
    });
    const store = createTaskStore({ client, connect, healthPollMs: 1_000_000 });

    store.init();
    await flush();

    const taskA = makeTask({ id: "a", column: "todo", position: 0 });
    handle.handlers?.onFrame({ kind: "snapshot", seq: 1, tasks: [taskA] });

    store.move("a", "in_progress", 3);

    // Optimistic update should be visible immediately, before the client call resolves.
    let snapshot = store.getSnapshot();
    expect(snapshot.tasks[0]).toMatchObject({ id: "a", column: "in_progress", position: 3 });
    expect(client.moveTask).toHaveBeenCalledWith("a", "in_progress", 3);

    // Server reconciliation: returns a fresh board that differs from the optimistic guess.
    const reconciledTask = makeTask({ id: "a", column: "in_progress", position: 0 });
    resolveMove([reconciledTask]);
    await movePromise;
    await Promise.resolve();

    snapshot = store.getSnapshot();
    expect(snapshot.tasks).toEqual([reconciledTask]);

    store.dispose();
  });

  it("does nothing optimistically for an unknown task id but still calls client.moveTask", async () => {
    const { connect } = makeFakeConnect();
    const client = makeFakeClient({ moveTask: vi.fn(async () => []) });
    const store = createTaskStore({ client, connect, healthPollMs: 1_000_000 });

    store.init();
    await flush();

    store.move("missing", "done", 0);
    expect(client.moveTask).toHaveBeenCalledWith("missing", "done", 0);

    store.dispose();
  });
});

describe("createTaskStore — subscribe/getSnapshot", () => {
  it("notifies subscribers on state changes and stops after unsubscribe", async () => {
    const { connect, handle } = makeFakeConnect();
    const client = makeFakeClient();
    const store = createTaskStore({ client, connect, healthPollMs: 1_000_000 });

    store.init();
    await flush();

    const cb = vi.fn();
    const unsubscribe = store.subscribe(cb);

    handle.handlers?.onFrame({ kind: "snapshot", seq: 1, tasks: [makeTask({ id: "a" })] });
    expect(cb).toHaveBeenCalledTimes(1);

    unsubscribe();
    handle.handlers?.onFrame({ kind: "upsert", seq: 2, task: makeTask({ id: "b" }) });
    expect(cb).toHaveBeenCalledTimes(1);

    store.dispose();
  });

  it("dispose() calls the sse disconnect function", async () => {
    const { connect, handle } = makeFakeConnect();
    const client = makeFakeClient();
    const store = createTaskStore({ client, connect, healthPollMs: 1_000_000 });

    store.init();
    await flush();

    store.dispose();
    expect(handle.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("createTaskStore — worktree actions + settings", () => {
  it("loads board settings on init", async () => {
    const { connect } = makeFakeConnect();
    const client = makeFakeClient({ getSettings: vi.fn(async () => ({ worktreeDefault: true })) });
    const store = createTaskStore({ client, connect, healthPollMs: 1_000_000 });
    store.init();
    await flush();
    expect(store.getSnapshot().settings).toEqual({ worktreeDefault: true });
  });

  it("initGit folds the returned task into state", async () => {
    const { connect } = makeFakeConnect();
    const client = makeFakeClient({
      initGitTask: vi.fn(async () => makeTask({ id: "g", runState: "running", column: "in_progress" })),
    });
    const store = createTaskStore({ client, connect, healthPollMs: 1_000_000 });
    store.init();
    await flush();
    await store.initGit("g");
    expect(store.getSnapshot().tasks.find((t) => t.id === "g")?.runState).toBe("running");
  });

  it("sync returns the merge message and folds the task", async () => {
    const { connect } = makeFakeConnect();
    const synced = makeTask({ id: "s" });
    const client = makeFakeClient({
      syncTask: vi.fn(async () => ({ task: synced, ok: false, conflict: true, message: "conflict!" })),
    });
    const store = createTaskStore({ client, connect, healthPollMs: 1_000_000 });
    store.init();
    await flush();
    const message = await store.sync("s");
    expect(message).toBe("conflict!");
    expect(store.getSnapshot().tasks.find((t) => t.id === "s")).toBeTruthy();
  });

  it("setWorktreeDefault persists via the client and updates the snapshot", async () => {
    const { connect } = makeFakeConnect();
    const updateSettings = vi.fn(async () => ({ worktreeDefault: true }));
    const client = makeFakeClient({ updateSettings });
    const store = createTaskStore({ client, connect, healthPollMs: 1_000_000 });
    store.init();
    await flush();
    await store.setWorktreeDefault(true);
    expect(updateSettings).toHaveBeenCalledWith({ worktreeDefault: true });
    expect(store.getSnapshot().settings.worktreeDefault).toBe(true);
  });
});

describe("createTaskStore — agent roster loading (retry on cold opencode)", () => {
  it("retries the roster fetch while it comes back empty, then populates", async () => {
    vi.useFakeTimers();
    try {
      const { connect } = makeFakeConnect();
      const roster = [
        { id: "build", mode: "primary" as const },
        { id: "plan", mode: "primary" as const },
      ];
      const getAgents = vi
        .fn()
        .mockResolvedValueOnce([]) // opencode still booting
        .mockResolvedValueOnce([]) // still booting
        .mockResolvedValue(roster); // ready
      const client = makeFakeClient({ getAgents });
      const store = createTaskStore({
        client,
        connect,
        healthPollMs: 1_000_000,
        agentRetryMs: 100,
      });
      store.init();

      await vi.advanceTimersByTimeAsync(0); // first fetch → []
      expect(store.getSnapshot().agents).toEqual([]);
      await vi.advanceTimersByTimeAsync(100); // retry → []
      expect(store.getSnapshot().agents).toEqual([]);
      await vi.advanceTimersByTimeAsync(100); // retry → roster
      expect(store.getSnapshot().agents).toEqual(roster);
      expect(getAgents).toHaveBeenCalledTimes(3);

      // Once populated, it stops retrying.
      await vi.advanceTimersByTimeAsync(1000);
      expect(getAgents).toHaveBeenCalledTimes(3);
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after agentMaxRetries (initial + N)", async () => {
    vi.useFakeTimers();
    try {
      const { connect } = makeFakeConnect();
      const getAgents = vi.fn().mockResolvedValue([]);
      const client = makeFakeClient({ getAgents });
      const store = createTaskStore({
        client,
        connect,
        healthPollMs: 1_000_000,
        agentRetryMs: 50,
        agentMaxRetries: 3,
      });
      store.init();

      await vi.advanceTimersByTimeAsync(0); // initial
      await vi.advanceTimersByTimeAsync(500); // burn through all retries
      expect(getAgents).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refetches the roster when opencode recovers and the roster is still empty", async () => {
    vi.useFakeTimers();
    try {
      const { connect } = makeFakeConnect();
      const roster = [{ id: "build", mode: "primary" as const }];
      const getAgents = vi.fn().mockResolvedValue([]);
      let healthOk = false;
      const getHealth = vi.fn(async () => ({
        opencode: (healthOk ? "ok" : "unreachable") as "ok" | "unreachable",
      }));
      const client = makeFakeClient({ getAgents, getHealth });
      const store = createTaskStore({
        client,
        connect,
        healthPollMs: 100,
        agentRetryMs: 1_000_000,
        agentMaxRetries: 0, // no self-retry — only health recovery can refetch
      });
      store.init();

      await vi.advanceTimersByTimeAsync(0); // initial fetch → [] , no retry (max 0)
      expect(store.getSnapshot().agents).toEqual([]);

      // opencode comes up; next health poll should trigger a roster refetch.
      getAgents.mockResolvedValue(roster);
      healthOk = true;
      await vi.advanceTimersByTimeAsync(100); // health poll → recovered → loadAgents
      await vi.advanceTimersByTimeAsync(0);
      expect(store.getSnapshot().agents).toEqual(roster);
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
