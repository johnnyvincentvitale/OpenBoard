import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { SqliteTaskStore } from "../../../src/db/task-store";
import { registerTaskCompareRoutes } from "../../../src/server/routes/task-compare";

function appFor(store: SqliteTaskStore): Hono {
  const app = new Hono();
  registerTaskCompareRoutes(app, { store });
  return app;
}

function storeCreate(store: SqliteTaskStore, title: string, directory: string) {
  return store.create({ title, description: "", directory });
}

describe("task compare route", () => {
  let store: SqliteTaskStore;

  beforeEach(() => {
    store = new SqliteTaskStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("returns 400 when baseTaskId is missing", async () => {
    const task = storeCreate(store, "Task", "/repo");
    const app = appFor(store);

    const res = await app.request(`/api/tasks/${task.id}/compare`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation");
    expect(body.error.message).toContain("baseTaskId");
  });

  it("returns 400 when baseTaskId equals targetId", async () => {
    const task = storeCreate(store, "Task", "/repo");
    const app = appFor(store);

    const res = await app.request(`/api/tasks/${task.id}/compare?baseTaskId=${encodeURIComponent(task.id)}`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("same as targetId");
  });

  it("returns 404 when target task does not exist", async () => {
    const base = storeCreate(store, "Base", "/repo");
    const app = appFor(store);

    const res = await app.request(`/api/tasks/missing/compare?baseTaskId=${encodeURIComponent(base.id)}`);
    expect(res.status).toBe(404);
  });

  it("returns 404 when base task does not exist", async () => {
    const target = storeCreate(store, "Target", "/repo");
    const app = appFor(store);

    const res = await app.request(`/api/tasks/${target.id}/compare?baseTaskId=missing`);
    expect(res.status).toBe(404);
  });

  it("returns 200 with a DiffResponse-style comparison result for two known tasks", async () => {
    const base = storeCreate(store, "Base", "/repo");
    const target = storeCreate(store, "Target", "/repo");
    const app = appFor(store);

    const res = await app.request(`/api/tasks/${target.id}/compare?baseTaskId=${encodeURIComponent(base.id)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("no-git"); // /repo is not a real git repo
    expect(body.baseTaskId).toBe(base.id);
    expect(body.targetTaskId).toBe(target.id);
    expect(body.reason).toBeTruthy();
  });

  it("URL-decodes task ids", async () => {
    const base = storeCreate(store, "Base", "/repo");
    const target = storeCreate(store, "Target", "/repo");
    const app = appFor(store);

    const res = await app.request(`/api/tasks/${encodeURIComponent(target.id)}/compare?baseTaskId=${encodeURIComponent(base.id)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.targetTaskId).toBe(target.id);
  });
});
