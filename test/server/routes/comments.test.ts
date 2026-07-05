import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { SqliteTaskStore } from "../../../src/db/task-store";
import { registerTaskCommentRoutes } from "../../../src/server/routes/comments";
import { registerTaskEventsRoutes } from "../../../src/server/routes/task-events";

function appFor(store: SqliteTaskStore): Hono {
  const app = new Hono();
  registerTaskCommentRoutes(app, { store });
  registerTaskEventsRoutes(app, { store });
  return app;
}

describe("task comment and event routes", () => {
  let store: SqliteTaskStore;

  beforeEach(() => {
    store = new SqliteTaskStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("creates/list comments and records a durable task event", async () => {
    const task = store.create({ title: "A", description: "", directory: "/repo" });
    const app = appFor(store);

    const created = await app.request(`/api/tasks/${task.id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ author: "orchestrator", body: "Reviewed" }),
    });

    expect(created.status).toBe(201);
    const comment = await created.json();
    expect(comment).toMatchObject({ taskId: task.id, author: "orchestrator", body: "Reviewed" });

    const comments = await app.request(`/api/tasks/${task.id}/comments`);
    expect(comments.status).toBe(200);
    expect(await comments.json()).toMatchObject([{ id: comment.id, taskId: task.id }]);

    const events = await app.request(`/api/tasks/${task.id}/events`);
    expect(events.status).toBe(200);
    expect(await events.json()).toMatchObject([
      { taskId: task.id, type: "comment_added", body: { commentId: comment.id, author: "orchestrator" } },
    ]);
  });

  it("validates comment body and unknown tasks", async () => {
    const task = store.create({ title: "A", description: "", directory: "/repo" });
    const app = appFor(store);

    const badBody = await app.request(`/api/tasks/${task.id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ author: "orchestrator", body: "" }),
    });
    expect(badBody.status).toBe(400);

    const missing = await app.request("/api/tasks/missing/comments");
    expect(missing.status).toBe(404);

    const missingEvents = await app.request("/api/tasks/missing/events");
    expect(missingEvents.status).toBe(404);
  });
});
