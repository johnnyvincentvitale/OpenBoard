import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { SqliteTaskStore } from "../../../src/db/task-store";
import { registerPermissionRoutes } from "../../../src/server/routes/permission";
import type { Dispatcher, Task } from "../../../src/shared";

function makeFakeDispatcher(askId: string, outcome: { ok: true; askId: string; decision: "allow_once" | "deny" } | { ok: false; askId: string; conflict: "not-found" | "already-resolved" | "reply-failed"; error?: string }) {
  return {
    listPendingPermissions: vi.fn(() => []),
    respondPermission: vi.fn(async () => outcome),
  } as unknown as Dispatcher & { respondPermission: ReturnType<typeof vi.fn> };
}

function makeTask(store: SqliteTaskStore): Task {
  const task = store.create({ title: "Test", description: "", directory: "/test" })!;
  store.update(task.id, { sessionId: "sess_1", runState: "running", runStartedAt: 100, harness: "opencode" });
  return store.get(task.id)!;
}

function appFor(store: SqliteTaskStore, dispatcher: Dispatcher): Hono {
  const app = new Hono();
  registerPermissionRoutes(app, { store, dispatcher });
  return app;
}

describe("permission route", () => {
  let store: SqliteTaskStore;

  beforeEach(() => {
    store = new SqliteTaskStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("returns 404 when task does not exist", async () => {
    const dispatcher = makeFakeDispatcher("ask_1", { ok: true, askId: "ask_1", decision: "allow_once" });
    const app = appFor(store, dispatcher);

    const res = await app.request("/api/tasks/nonexistent/permission", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ askId: "ask_1", action: "allow_once", answeredBy: "operator" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("session_not_found");
  });

  it("returns 400 when body is missing required fields", async () => {
    const task = makeTask(store);
    const dispatcher = makeFakeDispatcher("ask_1", { ok: true, askId: "ask_1", decision: "allow_once" });
    const app = appFor(store, dispatcher);

    const res = await app.request(`/api/tasks/${task.id}/permission`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when answeredBy exceeds max length", async () => {
    const task = makeTask(store);
    const dispatcher = makeFakeDispatcher("ask_1", { ok: true, askId: "ask_1", decision: "allow_once" });
    const app = appFor(store, dispatcher);

    const res = await app.request(`/api/tasks/${task.id}/permission`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ askId: "ask_1", action: "deny", answeredBy: "a".repeat(201) }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("200");
  });

  it("returns 200 with projected task on successful allow_once", async () => {
    const task = makeTask(store);
    const dispatcher = makeFakeDispatcher("ask_1", { ok: true, askId: "ask_1", decision: "allow_once" });
    const app = appFor(store, dispatcher);

    const res = await app.request(`/api/tasks/${task.id}/permission`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ askId: "ask_1", action: "allow_once", answeredBy: "operator" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(task.id);
  });

  it("returns 409 when ask is already resolved (stale/claimed)", async () => {
    const task = makeTask(store);
    const dispatcher = makeFakeDispatcher("ask_1", { ok: false, askId: "ask_1", conflict: "already-resolved" });
    const app = appFor(store, dispatcher);

    const res = await app.request(`/api/tasks/${task.id}/permission`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ askId: "ask_1", action: "deny", answeredBy: "operator" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toContain("already resolved");
  });

  it("returns 409 when ask is not found (stale/wrong-task)", async () => {
    const task = makeTask(store);
    const dispatcher = makeFakeDispatcher("ask_1", { ok: false, askId: "ask_1", conflict: "not-found" });
    const app = appFor(store, dispatcher);

    const res = await app.request(`/api/tasks/${task.id}/permission`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ askId: "ask_1", action: "deny", answeredBy: "operator" }),
    });
    expect(res.status).toBe(409);
  });

  it("returns 502 when provider reply failed", async () => {
    const task = makeTask(store);
    const dispatcher = makeFakeDispatcher("ask_1", { ok: false, askId: "ask_1", conflict: "reply-failed", error: "provider unreachable" });
    const app = appFor(store, dispatcher);

    const res = await app.request(`/api/tasks/${task.id}/permission`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ askId: "ask_1", action: "allow_once", answeredBy: "operator" }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.message).toContain("reply failed");
  });

  it("validates action must be allow_once or deny", async () => {
    const task = makeTask(store);
    const dispatcher = makeFakeDispatcher("ask_1", { ok: true, askId: "ask_1", decision: "allow_once" });
    const app = appFor(store, dispatcher);

    const res = await app.request(`/api/tasks/${task.id}/permission`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ askId: "ask_1", action: "invalid", answeredBy: "operator" }),
    });
    expect(res.status).toBe(400);
  });
});