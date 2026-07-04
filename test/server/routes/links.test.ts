import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { SqliteTaskStore } from "../../../src/db/task-store";
import { registerTaskLinkRoutes } from "../../../src/server/routes/links";

function appFor(store: SqliteTaskStore): Hono {
  const app = new Hono();
  registerTaskLinkRoutes(app, { store });
  return app;
}

describe("task dependency link routes", () => {
  let store: SqliteTaskStore;

  beforeEach(() => {
    store = new SqliteTaskStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("creates and removes a parent link, returning the refreshed child Task DTO", async () => {
    const parent = store.create({ title: "Parent", description: "", directory: "/repo" });
    const child = store.create({ title: "Child", description: "", directory: "/repo" });
    const app = appFor(store);

    const add = await app.request(`/api/tasks/${child.id}/links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentId: parent.id }),
    });

    expect(add.status).toBe(200);
    expect((await add.json()).parentIds).toEqual([parent.id]);
    expect(store.getParentIds(child.id)).toEqual([parent.id]);

    const remove = await app.request(`/api/tasks/${child.id}/links/${parent.id}`, { method: "DELETE" });

    expect(remove.status).toBe(200);
    expect((await remove.json()).parentIds).toEqual([]);
    expect(store.getParentIds(child.id)).toEqual([]);
  });

  it("returns 404 for unknown child or parent tasks", async () => {
    const parent = store.create({ title: "Parent", description: "", directory: "/repo" });
    const child = store.create({ title: "Child", description: "", directory: "/repo" });
    const app = appFor(store);

    const unknownChild = await app.request("/api/tasks/missing/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentId: parent.id }),
    });
    expect(unknownChild.status).toBe(404);

    const unknownParent = await app.request(`/api/tasks/${child.id}/links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentId: "missing" }),
    });
    expect(unknownParent.status).toBe(404);
  });

  it("rejects self links with 409", async () => {
    const task = store.create({ title: "Task", description: "", directory: "/repo" });
    const app = appFor(store);

    const res = await app.request(`/api/tasks/${task.id}/links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentId: task.id }),
    });

    expect(res.status).toBe(409);
  });

  it("rejects duplicate links with 409", async () => {
    const parent = store.create({ title: "Parent", description: "", directory: "/repo" });
    const child = store.create({ title: "Child", description: "", directory: "/repo" });
    const app = appFor(store);

    await app.request(`/api/tasks/${child.id}/links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentId: parent.id }),
    });
    const duplicate = await app.request(`/api/tasks/${child.id}/links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentId: parent.id }),
    });

    expect(duplicate.status).toBe(409);
  });

  it("rejects a direct cycle with 409", async () => {
    const a = store.create({ title: "A", description: "", directory: "/repo" });
    const b = store.create({ title: "B", description: "", directory: "/repo" });
    const app = appFor(store);

    store.addLink(a.id, b.id);
    const res = await app.request(`/api/tasks/${a.id}/links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentId: b.id }),
    });

    expect(res.status).toBe(409);
  });

  it("rejects a transitive 3-node cycle with 409", async () => {
    const a = store.create({ title: "A", description: "", directory: "/repo" });
    const b = store.create({ title: "B", description: "", directory: "/repo" });
    const c = store.create({ title: "C", description: "", directory: "/repo" });
    const app = appFor(store);

    store.addLink(a.id, b.id);
    store.addLink(b.id, c.id);
    const res = await app.request(`/api/tasks/${a.id}/links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentId: c.id }),
    });

    expect(res.status).toBe(409);
  });
});
