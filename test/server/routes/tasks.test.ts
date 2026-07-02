import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { registerTaskRoutes } from "../../../src/server/routes/tasks";
import { SqliteTaskStore } from "../../../src/db/task-store";
import type { Dispatcher, Task } from "../../../src/shared";

// --- Fixtures --------------------------------------------------------------

/**
 * A hermetic fake Dispatcher. Doesn't touch OpenCode at all — just tracks
 * calls and returns/updates a task the way a real dispatcher would.
 */
function makeFakeDispatcher(store: SqliteTaskStore): Dispatcher & {
  run: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
} {
  return {
    run: vi.fn(async (taskId: string): Promise<Task> => {
      const updated = store.update(taskId, { runState: "running", column: "in_progress" });
      if (!updated) throw new Error(`unknown task ${taskId}`);
      return updated;
    }),
    retry: vi.fn(async (taskId: string, _feedback?: string): Promise<Task> => {
      const updated = store.update(taskId, { runState: "running" });
      if (!updated) throw new Error(`unknown task ${taskId}`);
      return updated;
    }),
    abort: vi.fn(async (taskId: string): Promise<void> => {
      store.update(taskId, { runState: "idle" });
    }),
    start: vi.fn(),
    shutdown: vi.fn(),
  };
}

function buildApp(store: SqliteTaskStore, dispatcher: Dispatcher): Hono {
  const app = new Hono();
  registerTaskRoutes(app, { store, dispatcher });
  return app;
}

// --- POST /api/tasks ---------------------------------------------------------

describe("POST /api/tasks", () => {
  let store: SqliteTaskStore;
  let dispatcher: ReturnType<typeof makeFakeDispatcher>;

  beforeEach(() => {
    store = new SqliteTaskStore(":memory:");
    dispatcher = makeFakeDispatcher(store);
  });

  afterEach(() => {
    store.close();
  });

  it("creates a task and responds 201 with the Task", async () => {
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Fix the bug",
        description: "There is a bug",
        directory: "/repo",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.title).toBe("Fix the bug");
    expect(body.description).toBe("There is a bug");
    expect(body.directory).toBe("/repo");
    expect(body.column).toBe("todo");
    expect(body.runState).toBe("unstarted");
    expect(typeof body.id).toBe("string");

    // Persisted in the store.
    expect(store.list()).toHaveLength(1);
  });

  it("responds 400 validation when title is missing/empty", async () => {
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "", description: "x", directory: "/repo" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation");
  });

  it("responds 400 validation when directory is missing/empty", async () => {
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Task", description: "x", directory: "" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation");
  });

  it("responds 400 validation when body is not valid JSON", async () => {
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation");
  });
});

// --- GET /api/tasks ------------------------------------------------------------

describe("GET /api/tasks", () => {
  let store: SqliteTaskStore;
  let dispatcher: ReturnType<typeof makeFakeDispatcher>;

  beforeEach(() => {
    store = new SqliteTaskStore(":memory:");
    dispatcher = makeFakeDispatcher(store);
  });

  afterEach(() => {
    store.close();
  });

  it("returns all tasks from the store", async () => {
    store.create({ title: "A", description: "", directory: "/repo" });
    store.create({ title: "B", description: "", directory: "/repo" });
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    expect(body.map((t: Task) => t.title).sort()).toEqual(["A", "B"]);
  });

  it("returns an empty array when there are no tasks", async () => {
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });
});

// --- POST /api/tasks/:id/run ---------------------------------------------------

describe("POST /api/tasks/:id/run", () => {
  let store: SqliteTaskStore;
  let dispatcher: ReturnType<typeof makeFakeDispatcher>;

  beforeEach(() => {
    store = new SqliteTaskStore(":memory:");
    dispatcher = makeFakeDispatcher(store);
  });

  afterEach(() => {
    store.close();
  });

  it("calls dispatcher.run with the task id and responds 202 with the Task", async () => {
    const task = store.create({ title: "A", description: "do it", directory: "/repo" });
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${task.id}/run`, { method: "POST" });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.id).toBe(task.id);
    expect(body.runState).toBe("running");

    expect(dispatcher.run).toHaveBeenCalledTimes(1);
    expect(dispatcher.run).toHaveBeenCalledWith(task.id);
  });

  it("propagates a thrown AdapterError from the dispatcher", async () => {
    const { AdapterError } = await import("../../../src/shared/errors");
    dispatcher.run.mockImplementationOnce(async () => {
      throw AdapterError.notFound("no such task");
    });
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks/missing/run", { method: "POST" });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("session_not_found");
  });
});

// --- POST /api/tasks/:id/retry -------------------------------------------------

describe("POST /api/tasks/:id/retry", () => {
  let store: SqliteTaskStore;
  let dispatcher: ReturnType<typeof makeFakeDispatcher>;

  beforeEach(() => {
    store = new SqliteTaskStore(":memory:");
    dispatcher = makeFakeDispatcher(store);
  });

  afterEach(() => {
    store.close();
  });

  it("calls dispatcher.retry with the task id and feedback, responds 202", async () => {
    const task = store.create({ title: "A", description: "do it", directory: "/repo" });
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${task.id}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ feedback: "try again" }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.id).toBe(task.id);

    expect(dispatcher.retry).toHaveBeenCalledTimes(1);
    expect(dispatcher.retry).toHaveBeenCalledWith(task.id, "try again");
  });

  it("allows an empty body (feedback optional)", async () => {
    const task = store.create({ title: "A", description: "do it", directory: "/repo" });
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${task.id}/retry`, { method: "POST" });

    expect(res.status).toBe(202);
    expect(dispatcher.retry).toHaveBeenCalledWith(task.id, undefined);
  });
});

// --- POST /api/tasks/:id/abort -------------------------------------------------

describe("POST /api/tasks/:id/abort", () => {
  let store: SqliteTaskStore;
  let dispatcher: ReturnType<typeof makeFakeDispatcher>;

  beforeEach(() => {
    store = new SqliteTaskStore(":memory:");
    dispatcher = makeFakeDispatcher(store);
  });

  afterEach(() => {
    store.close();
  });

  it("calls dispatcher.abort with the task id and responds 200 with the updated Task", async () => {
    const task = store.create({ title: "A", description: "do it", directory: "/repo" });
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${task.id}/abort`, { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(task.id);
    expect(body.runState).toBe("idle");

    expect(dispatcher.abort).toHaveBeenCalledTimes(1);
    expect(dispatcher.abort).toHaveBeenCalledWith(task.id);
  });
});

// --- POST /api/tasks/:id/move --------------------------------------------------

describe("POST /api/tasks/:id/move", () => {
  let store: SqliteTaskStore;
  let dispatcher: ReturnType<typeof makeFakeDispatcher>;

  beforeEach(() => {
    store = new SqliteTaskStore(":memory:");
    dispatcher = makeFakeDispatcher(store);
  });

  afterEach(() => {
    store.close();
  });

  it("moves the task and responds 200 with the fresh task list", async () => {
    const a = store.create({ title: "A", description: "", directory: "/repo" });
    store.create({ title: "B", description: "", directory: "/repo" });
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${a.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ column: "in_progress", position: 0 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    const moved = body.find((t: Task) => t.id === a.id);
    expect(moved.column).toBe("in_progress");
    expect(moved.position).toBe(0);

    // Verify persisted in the store directly too.
    expect(store.get(a.id)?.column).toBe("in_progress");
  });

  it("responds 400 validation when column is invalid", async () => {
    const a = store.create({ title: "A", description: "", directory: "/repo" });
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${a.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ column: "not_a_real_column", position: 0 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation");
  });

  it("responds 400 validation when position is not a finite number", async () => {
    const a = store.create({ title: "A", description: "", directory: "/repo" });
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${a.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ column: "todo", position: "zero" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation");
  });
});

// --- DELETE /api/tasks/:id ------------------------------------------------------

describe("DELETE /api/tasks/:id", () => {
  let store: SqliteTaskStore;
  let dispatcher: ReturnType<typeof makeFakeDispatcher>;

  beforeEach(() => {
    store = new SqliteTaskStore(":memory:");
    dispatcher = makeFakeDispatcher(store);
  });

  afterEach(() => {
    store.close();
  });

  it("removes the task and responds 200 {ok:true}", async () => {
    const task = store.create({ title: "A", description: "", directory: "/repo" });
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${task.id}`, { method: "DELETE" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });

    expect(store.get(task.id)).toBeUndefined();
    expect(store.list()).toHaveLength(0);
  });
});
