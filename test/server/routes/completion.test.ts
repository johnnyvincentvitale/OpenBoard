import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { SqliteTaskStore } from "../../../src/db/task-store";
import { registerCompletionRoutes } from "../../../src/server/routes/completion";

const validBody = {
  summary: "implemented the change",
  changedFiles: ["src/file.ts"],
  verification: [{ command: "npm test", result: "passed" }],
  residualRisk: "none",
};

function appFor(store: SqliteTaskStore): Hono {
  const app = new Hono();
  registerCompletionRoutes(app, { store });
  return app;
}

describe("completion routes", () => {
  let store: SqliteTaskStore;

  beforeEach(() => {
    store = new SqliteTaskStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("POST /complete on a running task stores a reported completion and moves to review/idle", async () => {
    const task = store.create({ title: "A", description: "do it", directory: "/repo" });
    store.update(task.id, { runState: "running" });
    store.move(task.id, "in_progress", 0);
    const app = appFor(store);

    const res = await app.request(`/api/tasks/${task.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runState).toBe("idle");
    expect(body.column).toBe("review");
    expect(body.completionSource).toBe("reported");
    expect(body.completion).toMatchObject({ ...validBody, outcome: "complete" });
    expect(typeof body.completion.reportedAt).toBe("number");
  });

  it("POST /block on a running task stores a reported block and moves to review/error", async () => {
    const task = store.create({ title: "A", description: "do it", directory: "/repo" });
    store.update(task.id, { runState: "running" });
    store.move(task.id, "in_progress", 0);
    const app = appFor(store);

    const res = await app.request(`/api/tasks/${task.id}/block`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validBody, residualRisk: "needs human decision" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runState).toBe("error");
    expect(body.column).toBe("review");
    expect(body.error).toBe("needs human decision");
    expect(body.completionSource).toBe("reported");
    expect(body.completion).toMatchObject({ outcome: "blocked", residualRisk: "needs human decision" });
  });

  it("returns 409 for a non-running task", async () => {
    const task = store.create({ title: "A", description: "do it", directory: "/repo" });
    const app = appFor(store);

    const res = await app.request(`/api/tasks/${task.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(409);
  });

  it("upgrades an idle-fallback review task when the late /complete report arrives", async () => {
    const task = store.create({ title: "A", description: "do it", directory: "/repo" });
    store.update(task.id, {
      sessionId: "ses_1",
      runState: "idle",
      runStartedAt: 100,
      completion: null,
      completionSource: "idle-fallback",
    });
    store.move(task.id, "review", 0);
    const app = appFor(store);

    const res = await app.request(`/api/tasks/${task.id}/complete?runStartedAt=100`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.column).toBe("review");
    expect(body.position).toBe(0);
    expect(body.runState).toBe("idle");
    expect(body.completionSource).toBe("reported");
    expect(body.completion).toMatchObject({ ...validBody, outcome: "complete" });
  });

  it("upgrades an idle-fallback review task when the late /block report arrives", async () => {
    const task = store.create({ title: "A", description: "do it", directory: "/repo" });
    store.update(task.id, {
      sessionId: "ses_1",
      runState: "idle",
      runStartedAt: 100,
      completion: null,
      completionSource: "idle-fallback",
    });
    store.move(task.id, "review", 0);
    const app = appFor(store);

    const res = await app.request(`/api/tasks/${task.id}/block?runStartedAt=100`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validBody, residualRisk: "needs credentials" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.column).toBe("review");
    expect(body.runState).toBe("error");
    expect(body.error).toBe("needs credentials");
    expect(body.completionSource).toBe("reported");
    expect(body.completion).toMatchObject({ outcome: "blocked", residualRisk: "needs credentials" });
  });

  it("rejects an idle-fallback upgrade after the task has been re-dispatched", async () => {
    const task = store.create({ title: "A", description: "do it", directory: "/repo" });
    store.update(task.id, {
      sessionId: "ses_1",
      runState: "idle",
      runStartedAt: 100,
      completion: null,
      completionSource: "idle-fallback",
    });
    store.move(task.id, "review", 0);
    store.update(task.id, {
      runState: "running",
      runStartedAt: 200,
      completion: null,
      completionSource: null,
    });
    store.move(task.id, "in_progress", 0);
    const app = appFor(store);

    const res = await app.request(`/api/tasks/${task.id}/complete?runStartedAt=100`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toBe("Completion report is stale for this task run");
    expect(store.get(task.id)?.completionSource).toBeNull();
  });

  it("returns 400 for malformed bodies", async () => {
    const task = store.create({ title: "A", description: "do it", directory: "/repo" });
    store.update(task.id, { runState: "running" });
    const app = appFor(store);

    const res = await app.request(`/api/tasks/${task.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validBody, changedFiles: [1] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation");
  });

  it("returns 404 for an unknown task", async () => {
    const app = appFor(store);

    const res = await app.request("/api/tasks/task_missing/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(404);
  });
});
