import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { SqliteTaskStore } from "../../../src/db/task-store";
import { registerTaskLinkRoutes } from "../../../src/server/routes/links";
import { respondWithAppError } from "../../../src/server/app";

function appFor(store: SqliteTaskStore): Hono {
  const app = new Hono();
  app.onError(respondWithAppError);
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

  it("allows one parent to have multiple children", async () => {
    const parent = store.create({ title: "Parent", description: "", directory: "/repo" });
    const child1 = store.create({ title: "Child1", description: "", directory: "/repo" });
    const child2 = store.create({ title: "Child2", description: "", directory: "/repo" });
    const child3 = store.create({ title: "Child3", description: "", directory: "/repo" });
    const app = appFor(store);

    for (const child of [child1, child2, child3]) {
      const res = await app.request(`/api/tasks/${child.id}/links`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parentId: parent.id }),
      });
      expect(res.status).toBe(200);
    }

    const childIds = store.getChildIds(parent.id).sort();
    const expected = [child1.id, child2.id, child3.id].sort();
    expect(childIds).toEqual(expected);
  });

  it("allows one child to have multiple parents", async () => {
    const parent1 = store.create({ title: "Parent1", description: "", directory: "/repo" });
    const parent2 = store.create({ title: "Parent2", description: "", directory: "/repo" });
    const child = store.create({ title: "Child", description: "", directory: "/repo" });
    const app = appFor(store);

    await app.request(`/api/tasks/${child.id}/links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentId: parent1.id }),
    });
    const res2 = await app.request(`/api/tasks/${child.id}/links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentId: parent2.id }),
    });

    expect(res2.status).toBe(200);
    const parentIds = (await res2.json()).parentIds as string[];
    expect(parentIds.sort()).toEqual([parent1.id, parent2.id].sort());
    expect(store.getParentIds(child.id).sort()).toEqual([parent1.id, parent2.id].sort());
  });

  it("allows a valid DAG link when two parents share a child and one parent depends on the other", async () => {
    // A -> C, B -> C. Then A -> B. No cycle: A -> B -> C, and A -> C is still fine.
    const a = store.create({ title: "A", description: "", directory: "/repo" });
    const b = store.create({ title: "B", description: "", directory: "/repo" });
    const c = store.create({ title: "C", description: "", directory: "/repo" });
    const app = appFor(store);

    store.addLink(a.id, c.id); // a -> c
    store.addLink(b.id, c.id); // b -> c

    // Adding A -> B (parent=A, child=B) must be allowed — no cycle.
    const res = await app.request(`/api/tasks/${b.id}/links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentId: a.id }),
    });

    expect(res.status).toBe(200);
    expect(store.getParentIds(b.id)).toEqual([a.id]);
    // B -> C, A -> C still intact
    expect(store.getParentIds(c.id).sort()).toEqual([a.id, b.id].sort());
  });
});
