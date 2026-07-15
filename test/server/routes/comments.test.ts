import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { SqliteTaskStore } from "../../../src/db/task-store";
import { registerTaskCommentRoutes } from "../../../src/server/routes/comments";
import { registerTaskEventsRoutes } from "../../../src/server/routes/task-events";
import { respondWithAppError } from "../../../src/server/app";

function appFor(store: SqliteTaskStore): Hono {
  const app = new Hono();
  app.onError(respondWithAppError);
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
    store.move(task.id, "review", 0);
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

  it("returns latest auto-dispatch causality for all tasks in one request", async () => {
    const child = store.create({ title: "Child", description: "", directory: "/repo" });
    const manual = store.create({ title: "Manual", description: "", directory: "/repo" });
    store.addEvent({ taskId: child.id, type: "task_auto_dispatched", body: { parentId: "parent-old" } });
    store.addEvent({ taskId: child.id, type: "task_auto_dispatched", body: { parentId: "parent-new" } });
    store.addEvent({ taskId: manual.id, type: "task_created" });
    const app = appFor(store);

    const response = await app.request("/api/tasks/causality");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      [child.id]: { autoDispatchedBy: "parent-new" },
    });
  });

  it("creates replies to existing comments", async () => {
    const task = store.create({ title: "A", description: "", directory: "/repo" });
    store.move(task.id, "review", 0);
    const app = appFor(store);

    const rootResponse = await app.request(`/api/tasks/${task.id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ author: "orchestrator", body: "Reviewed" }),
    });
    const root = await rootResponse.json();

    const replyResponse = await app.request(`/api/tasks/${task.id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ author: "reviewer", body: "Reply", parentCommentId: root.id }),
    });

    expect(replyResponse.status).toBe(201);
    expect(await replyResponse.json()).toMatchObject({
      taskId: task.id,
      author: "reviewer",
      body: "Reply",
      parentCommentId: root.id,
    });
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

  it("rejects comments before checking the column only after the body is valid", async () => {
    const task = store.create({ title: "A", description: "", directory: "/repo" });
    const app = appFor(store);

    const res = await app.request(`/api/tasks/${task.id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ author: "orchestrator", body: "Reviewed" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toBe("Comments can only be added to Review or Done tasks");
  });

  it("rejects missing or foreign parent comments with validation errors", async () => {
    const task = store.create({ title: "A", description: "", directory: "/repo" });
    const other = store.create({ title: "B", description: "", directory: "/repo" });
    store.move(task.id, "review", 0);
    store.move(other.id, "review", 1);
    const foreignParent = store.addComment({ taskId: other.id, author: "reviewer", body: "Other task" });
    const app = appFor(store);

    const missingParent = await app.request(`/api/tasks/${task.id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ author: "orchestrator", body: "Reply", parentCommentId: "comment_missing" }),
    });
    const foreignParentRes = await app.request(`/api/tasks/${task.id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ author: "orchestrator", body: "Reply", parentCommentId: foreignParent.id }),
    });

    expect(missingParent.status).toBe(400);
    expect(foreignParentRes.status).toBe(400);
    expect((await missingParent.json()).error.message).toBe("parentCommentId must reference a comment on this task");
    expect((await foreignParentRes.json()).error.message).toBe("parentCommentId must reference a comment on this task");
  });
});
