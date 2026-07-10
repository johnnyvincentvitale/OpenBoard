import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { registerTaskContextRoutes } from "../../../src/server/routes/task-context";
import { SqliteTaskStore } from "../../../src/db/task-store";
import { requireBoardToken } from "../../../src/server/auth";

const TEST_TOKEN = "test-token-ctx";

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_TOKEN}` };
}

describe("GET /api/tasks/:id/context", () => {
  let store: SqliteTaskStore;
  let app: Hono;
  let clock: number;
  let idCounter: number;

  beforeEach(() => {
    clock = 1000;
    idCounter = 0;
    store = new SqliteTaskStore(":memory:", {
      now: () => clock,
      genId: () => `task_${++idCounter}`,
    });

    const hono = new Hono();
    hono.use("*", cors({ origin: "*" }));
    hono.use("/api/*", requireBoardToken(TEST_TOKEN));
    registerTaskContextRoutes(hono, { store });
    app = hono;
  });

  function createTask(opts: {
    title?: string;
    description?: string;
    taskKind?: string;
    column?: string;
  } = {}) {
    clock += 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = store.create({
      title: opts.title ?? "Task",
      description: opts.description ?? "desc",
      directory: "/repo",
      taskKind: (opts.taskKind as any) ?? "none",
    });
    if (opts.column && opts.column !== "todo") {
      store.move(t.id, opts.column as any, 0);
    }
    return t;
  }

  it("returns 401 without auth", async () => {
    const res = await app.request("/api/tasks/task_1/context");
    expect(res.status).toBe(401);
  });

  it("returns 401 with wrong token", async () => {
    const res = await app.request("/api/tasks/task_1/context", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 with target task context including description for an orphan task", async () => {
    const task = createTask({ title: "Lone Task", description: "Go it alone" });

    const res = await app.request(`/api/tasks/${task.id}/context`, {
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.taskId).toBe(task.id);
    expect(body.title).toBe("Lone Task");
    expect(body.description).toBe("Go it alone");
    expect(body.taskKind).toBe("none");
    expect(body.hasStructuredHandoff).toBe(false);
    expect(body.directParents).toEqual([]);
    expect(body.inheritedParents).toEqual([]);
    expect(body.codeAncestors).toEqual([]);
    expect(body.completionSource).toBeNull();
    expect(body.completionLocation).toBeNull();
    expect(body.outcome).toBeNull();
    // No _summary field.
    expect(body).not.toHaveProperty("_summary");
    // Untruncated lineage must report truncated=false, not omit the field.
    expect(body.truncated).toBe(false);
  });

  it("surfaces truncated=true on the route response when the lineage traversal hits the depth bound", async () => {
    const CHAIN_LENGTH = 25;
    let prev = createTask({ title: "root" });
    for (let i = 1; i < CHAIN_LENGTH; i++) {
      const next = createTask({ title: `link-${i}` });
      store.addLink(prev.id, next.id);
      prev = next;
    }
    const child = createTask({ title: "Child" });
    store.addLink(prev.id, child.id);

    const res = await app.request(`/api/tasks/${child.id}/context`, {
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.truncated).toBe(true);
  });

  it("returns structured lineage with direct parents", async () => {
    const parent = createTask({ title: "Parent", taskKind: "research" });
    const child = createTask({ title: "Child", taskKind: "build" });

    store.addLink(parent.id, child.id);

    const res = await app.request(`/api/tasks/${child.id}/context`, {
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.taskId).toBe(child.id);
    expect(body.directParents).toHaveLength(1);
    expect(body.directParents[0]).toMatchObject({
      kind: "direct-parent",
      parentId: parent.id,
      taskId: parent.id,
      title: "Parent",
      description: "desc",
    });
    expect(body.inheritedParents).toEqual([]);
  });

  it("returns inherited parents for deeper lineage", async () => {
    const gp = createTask({ title: "Grandparent", taskKind: "research" });
    const parent = createTask({ title: "Parent", taskKind: "synthesis" });
    const child = createTask({ title: "Child", taskKind: "build" });

    store.addLink(gp.id, parent.id);
    store.addLink(parent.id, child.id);

    const res = await app.request(`/api/tasks/${child.id}/context`, {
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.directParents).toHaveLength(1);
    expect(body.inheritedParents).toHaveLength(1);
    expect(body.inheritedParents[0]).toMatchObject({
      kind: "inherited-parent",
      taskId: gp.id,
      title: "Grandparent",
      taskKind: "research",
      depth: 2,
    });
  });

  it("returns code ancestor candidates", async () => {
    const buildDone = createTask({ title: "Build Done", taskKind: "build", column: "done" });
    store.setCompletion(buildDone.id, {
      outcome: "complete",
      summary: "Built",
      changedFiles: ["src/mod.ts"],
      verification: [],
      residualRisk: "none",
      reportedAt: 2000,
    }, "reported");
    const child = createTask({ title: "Child", taskKind: "fix" });

    store.addLink(buildDone.id, child.id);

    const res = await app.request(`/api/tasks/${child.id}/context`, {
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.codeAncestors).toHaveLength(1);
    expect(body.codeAncestors[0]).toMatchObject({
      taskId: buildDone.id,
      title: "Build Done",
      taskKind: "build",
      column: "done",
      changedFiles: ["src/mod.ts"],
      hasStructuredHandoff: true,
    });
  });

  it("returns completionSource and completionLocation on target", async () => {
    const task = createTask({ title: "Completed Task" });
    store.update(task.id, {
      completionSource: "reported",
      completionLocation: "task-directory",
    });

    const res = await app.request(`/api/tasks/${task.id}/context`, {
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.completionSource).toBe("reported");
    expect(body.completionLocation).toBe("task-directory");
  });

  it("returns no raw transcripts in response", async () => {
    const task = createTask({ title: "Task with session output" });
    store.update(task.id, { finalSessionOutput: "raw transcript here" });

    const res = await app.request(`/api/tasks/${task.id}/context`, {
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).not.toHaveProperty("finalSessionOutput");
    expect(body).not.toHaveProperty("rawTranscript");
    expect(JSON.stringify(body)).not.toContain("raw transcript here");
  });

  it("returns 404 for unknown task", async () => {
    const res = await app.request("/api/tasks/task_nonexistent/context", {
      headers: authHeaders(),
    });

    expect(res.status).toBe(404);
  });

  it("handles diamond patterns through the route", async () => {
    const root = createTask({ title: "Root", taskKind: "research" });
    const left = createTask({ title: "Left", taskKind: "research" });
    const right = createTask({ title: "Right", taskKind: "synthesis" });
    const child = createTask({ title: "Child", taskKind: "build" });

    store.addLink(root.id, left.id);
    store.addLink(root.id, right.id);
    store.addLink(left.id, child.id);
    store.addLink(right.id, child.id);

    const res = await app.request(`/api/tasks/${child.id}/context`, {
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.directParents).toHaveLength(2);
    expect(body.inheritedParents).toHaveLength(1);
    expect(body.inheritedParents[0].taskId).toBe(root.id);
    expect(body.inheritedParents[0].viaParentIds.sort()).toEqual(
      [left.id, right.id].sort(),
    );
  });
});
