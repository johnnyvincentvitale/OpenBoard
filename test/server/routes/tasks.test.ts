import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { registerTaskRoutes } from "../../../src/server/routes/tasks";
import { registerCompletionRoutes } from "../../../src/server/routes/completion";
import { TaskDispatcher } from "../../../src/server/dispatcher";
import { SqliteTaskStore } from "../../../src/db/task-store";
import type { Dispatcher, RosterAgent, Task } from "../../../src/shared";
import { USER_COMPLETED_BY } from "../../../src/shared";
import { AdapterError } from "../../../src/shared/errors";
import type { WorktreeManager } from "../../../src/server/worktree";
import { cleanupTestWorkspace, setupTestWorkspace } from "../test-workspace";

let workspaceDir: string;
let repoDir: string;

beforeEach(() => {
  const ws = setupTestWorkspace();
  workspaceDir = ws.workspace;
  repoDir = ws.repoDir;
});

afterEach(() => {
  cleanupTestWorkspace();
});

// --- Fixtures --------------------------------------------------------------

/**
 * A hermetic fake Dispatcher. Doesn't touch OpenCode at all — just tracks
 * calls and returns/updates a task the way a real dispatcher would.
 */
function makeFakeDispatcher(store: SqliteTaskStore): Dispatcher & {
  run: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  initGitAndRun: ReturnType<typeof vi.fn>;
  syncUpstream: ReturnType<typeof vi.fn>;
  integrate: ReturnType<typeof vi.fn>;
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
    initGitAndRun: vi.fn(async (taskId: string): Promise<Task> => {
      const updated = store.update(taskId, {
        runState: "running",
        column: "in_progress",
        pending: undefined,
      });
      if (!updated) throw new Error(`unknown task ${taskId}`);
      return updated;
    }),
    syncUpstream: vi.fn(async (taskId: string) => {
      const task = store.get(taskId);
      if (!task) throw new Error(`unknown task ${taskId}`);
      return { task, ok: true, conflict: false, message: "merged" };
    }),
    integrate: vi.fn(async (taskId: string, _targetBranch?: string) => {
      const task = store.get(taskId);
      if (!task) throw new Error(`unknown task ${taskId}`);
      return { task, ok: true, conflict: false, message: "integrated" };
    }),
    start: vi.fn(),
    shutdown: vi.fn(),
  };
}

function buildApp(
  store: SqliteTaskStore,
  dispatcher: Dispatcher,
  rosterOrFetch: RosterAgent[] | (() => Promise<RosterAgent[]>) = [],
): Hono {
  const app = new Hono();
  const fetch = Array.isArray(rosterOrFetch) ? async () => rosterOrFetch : rosterOrFetch;
  registerTaskRoutes(app, {
    store,
    dispatcher,
    agentRoster: { fetch },
  });
  return app;
}

const BUILD_AGENT: RosterAgent = {
  id: "build",
  mode: "primary",
  model: { providerID: "opencode", id: "north-mini-code-free" },
};

const PLAN_AGENT: RosterAgent = {
  id: "plan",
  mode: "primary",
  model: { providerID: "openai", id: "gpt-5.5" },
};

const NO_MODEL_AGENT: RosterAgent = {
  id: "bare",
  mode: "subagent",
};

class FakeOpencodeClient {
  createCalls: unknown[] = [];
  promptCalls: Array<{ parts: unknown }> = [];
  nextSessionId = "ses_route";

  session = {
    create: async (params: unknown) => {
      this.createCalls.push(params);
      return { data: { id: this.nextSessionId }, error: undefined };
    },
    promptAsync: async (params: { parts: unknown }) => {
      this.promptCalls.push(params);
      return { data: undefined, error: undefined };
    },
    abort: async () => ({ data: {}, error: undefined }),
    messages: async () => ({ data: [], error: undefined }),
  };

  event = {
    subscribe: async () => ({ stream: (async function* () {})() }),
  };
}

class FakeWorktrees implements WorktreeManager {
  initRepoCalls: string[] = [];

  async isGitRepo(): Promise<boolean> {
    return true;
  }

  async initRepo(dir: string): Promise<void> {
    this.initRepoCalls.push(dir);
  }

  async repoRoot(dir: string): Promise<string> {
    return dir;
  }

  async currentBranch(): Promise<string> {
    return "main";
  }

  async createWorktree(_dir: string, branch: string, worktreePath: string) {
    return { branch, worktreePath, baseBranch: "main" };
  }

  async syncUpstream() {
    return { ok: true, conflict: false, message: "merged" };
  }

  async integrate() {
    return { ok: true, conflict: false, message: "integrated" };
  }

  async removeWorktree(): Promise<void> {}
}

function buildRealDispatchApp(store: SqliteTaskStore, dispatcher: Dispatcher, roster: RosterAgent[] = []): Hono {
  const app = new Hono();
  registerCompletionRoutes(app, { store });
  registerTaskRoutes(app, {
    store,
    dispatcher,
    agentRoster: { fetch: async () => roster },
  });
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
        directory: repoDir,
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.title).toBe("Fix the bug");
    expect(body.type).toBe("agent");
    expect(body.description).toBe("There is a bug");
    expect(body.directory).toBe(repoDir);
    expect(body.column).toBe("todo");
    expect(body.runState).toBe("unstarted");
    expect(typeof body.id).toBe("string");

    // Persisted in the store.
    expect(store.list()).toHaveLength(1);
  });

  it("creates a manual task with an assignee and no agent metadata", async () => {
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "manual",
        title: "PM signoff",
        description: "Review the copy",
        directory: repoDir,
        assignedTo: "Johnny",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.type).toBe("manual");
    expect(body.assignedTo).toBe("Johnny");
    expect(body.agent).toBeUndefined();
    expect(body.model).toBeUndefined();
    expect(store.get(body.id)?.type).toBe("manual");
  });

  it("rejects manual tasks with agent metadata", async () => {
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "manual",
        title: "Bad manual card",
        directory: repoDir,
        agent: "build",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("manual tasks cannot define agent");
  });

  it("responds 400 validation when title is missing/empty", async () => {
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "", description: "x", directory: repoDir }),
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

  it("materializes the agent's roster model when no explicit model is provided", async () => {
    const app = buildApp(store, dispatcher, [BUILD_AGENT, PLAN_AGENT]);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Fix the bug",
        description: "There is a bug",
        directory: repoDir,
        agent: "build",
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Task;
    expect(body.agent).toBe("build");
    expect(body.model).toEqual({ providerID: "opencode", id: "north-mini-code-free" });

    const persisted = store.get(body.id);
    expect(persisted?.model).toEqual({ providerID: "opencode", id: "north-mini-code-free" });
  });

  it("preserves an explicit model and does not overwrite it", async () => {
    const app = buildApp(store, dispatcher, [BUILD_AGENT]);

    const explicitModel = { providerID: "custom", id: "my-model" };
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Use explicit model",
        description: "",
        directory: repoDir,
        agent: "build",
        model: explicitModel,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Task;
    expect(body.model).toEqual(explicitModel);

    const persisted = store.get(body.id);
    expect(persisted?.model).toEqual(explicitModel);
  });

  it("preserves a valid explicit model with variant unchanged", async () => {
    const app = buildApp(store, dispatcher, [BUILD_AGENT]);

    const explicitModel = { providerID: "openai", id: "gpt-5.5", variant: "reasoning" };
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Use variant model",
        description: "",
        directory: repoDir,
        agent: "build",
        model: explicitModel,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Task;
    expect(body.model).toEqual(explicitModel);
    expect(store.get(body.id)?.model).toEqual(explicitModel);
  });

  it("rejects malformed explicit model objects", async () => {
    const app = buildApp(store, dispatcher, [BUILD_AGENT]);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Bad model",
        description: "",
        directory: repoDir,
        agent: "build",
        model: { providerID: "openai" },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation");
    expect(body.error.message).toContain("model.id");
    expect(store.list()).toHaveLength(0);
  });

  it("rejects non-object explicit model values", async () => {
    const app = buildApp(store, dispatcher, [BUILD_AGENT]);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Bad model string",
        description: "",
        directory: repoDir,
        agent: "build",
        model: "openai/gpt-5.5",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation");
    expect(body.error.message).toContain("model must be an object");
    expect(store.list()).toHaveLength(0);
  });

  it("rejects an unknown agent with no explicit model", async () => {
    const app = buildApp(store, dispatcher, [BUILD_AGENT]);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Unknown agent",
        description: "",
        directory: repoDir,
        agent: "ghost-agent",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation");
    expect(body.error.message).toContain("Unknown agent");
    expect(store.list()).toHaveLength(0);
  });

  it("reports roster fetch failure as OpenCode unreachable instead of unknown agent", async () => {
    const app = buildApp(store, dispatcher, async () => {
      throw AdapterError.unreachable("OpenCode agent roster is unreachable");
    });

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Needs roster",
        description: "",
        directory: repoDir,
        agent: "build",
      }),
    });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("opencode_unreachable");
    expect(body.error.message).toContain("roster");
    expect(body.error.message).not.toContain("Unknown agent");
    expect(store.list()).toHaveLength(0);
  });

  it("rejects an agent that has no configured model", async () => {
    const app = buildApp(store, dispatcher, [BUILD_AGENT, NO_MODEL_AGENT]);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "No model agent",
        description: "",
        directory: repoDir,
        agent: "bare",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation");
    expect(body.error.message).toContain("has no configured model");
    expect(store.list()).toHaveLength(0);
  });

  it("creates a task without an agent and leaves model unset", async () => {
    const app = buildApp(store, dispatcher, [BUILD_AGENT]);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Unassigned task",
        description: "",
        directory: repoDir,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Task;
    expect(body.agent).toBeUndefined();
    expect(body.model).toBeUndefined();
    expect(store.get(body.id)?.model).toBeUndefined();
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
    store.create({ title: "A", description: "", directory: repoDir });
    store.create({ title: "B", description: "", directory: repoDir });
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    expect(body.map((t: Task) => t.title).sort()).toEqual(["A", "B"]);
  });

  it("excludes archived tasks by default", async () => {
    store.create({ title: "Active", description: "", directory: repoDir });
    const archived = store.create({ title: "Archived", description: "", directory: repoDir });
    store.setArchived(archived.id, true);
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks");

    expect(res.status).toBe(200);
    const body = (await res.json()) as Task[];
    expect(body).toHaveLength(1);
    expect(body[0]?.title).toBe("Active");
  });

  it("returns only archived tasks for archived=true", async () => {
    store.create({ title: "Active", description: "", directory: repoDir });
    const archived = store.create({ title: "Archived", description: "", directory: repoDir });
    store.setArchived(archived.id, true);
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks?archived=true");

    expect(res.status).toBe(200);
    const body = (await res.json()) as Task[];
    expect(body).toHaveLength(1);
    expect(body[0]?.id).toBe(archived.id);
  });

  it("returns active and archived tasks for archived=all", async () => {
    const active = store.create({ title: "Active", description: "", directory: repoDir });
    const archived = store.create({ title: "Archived", description: "", directory: repoDir });
    store.setArchived(archived.id, true);
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks?archived=all");

    expect(res.status).toBe(200);
    const body = (await res.json()) as Task[];
    expect(body.map((task) => task.id)).toEqual([active.id, archived.id]);
  });

  it("rejects an invalid archived query value", async () => {
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks?archived=nope");

    expect(res.status).toBe(400);
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
    const task = store.create({ title: "A", description: "do it", directory: repoDir });
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${task.id}/run`, { method: "POST" });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.id).toBe(task.id);
    expect(body.runState).toBe("running");

    expect(dispatcher.run).toHaveBeenCalledTimes(1);
    expect(dispatcher.run).toHaveBeenCalledWith(task.id);
  });

  it("returns 409 and does not dispatch run for an archived task", async () => {
    const task = store.create({ title: "Archived", description: "do it", directory: repoDir });
    store.setArchived(task.id, true);
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${task.id}/run`, { method: "POST" });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toBe("Cannot run an archived task");
    expect(dispatcher.run).not.toHaveBeenCalled();
  });

  it("returns 400 and does not dispatch run for a manual task", async () => {
    const task = store.create({ type: "manual", title: "Manual", description: "review it", directory: repoDir });
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${task.id}/run`, { method: "POST" });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("Manual tasks cannot run");
    expect(dispatcher.run).not.toHaveBeenCalled();
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

  it("returns 409 with unmet parent details until the parent reports completion", async () => {
    const parent = store.create({ title: "Parent", description: "", directory: repoDir });
    const child = store.create({ title: "Child", description: "", directory: repoDir });
    store.addLink(parent.id, child.id);
    const client = new FakeOpencodeClient();
    const realDispatcher = new TaskDispatcher({ client: client as never, store });
    const app = buildRealDispatchApp(store, realDispatcher);

    const blocked = await app.request(`/api/tasks/${child.id}/run`, { method: "POST" });
    expect(blocked.status).toBe(409);
    const blockedBody = await blocked.json();
    expect(blockedBody.error.unmetParents).toEqual([
      { id: parent.id, title: "Parent", why: "parent is in todo" },
    ]);

    store.update(parent.id, { runState: "running" });
    await app.request(`/api/tasks/${parent.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        summary: "done",
        changedFiles: [],
        verification: [],
        residualRisk: "none",
      }),
    });

    const allowed = await app.request(`/api/tasks/${child.id}/run`, { method: "POST" });
    expect(allowed.status).toBe(202);
    expect((await allowed.json()).runState).toBe("running");
  });

  it("allows dispatch after a parent is manually moved to done without a report", async () => {
    const parent = store.create({ title: "Manual Parent", description: "", directory: repoDir });
    const child = store.create({ title: "Child", description: "", directory: repoDir });
    store.addLink(parent.id, child.id);
    store.move(parent.id, "done", 0);
    const client = new FakeOpencodeClient();
    const realDispatcher = new TaskDispatcher({ client: client as never, store });
    const app = buildRealDispatchApp(store, realDispatcher);

    const res = await app.request(`/api/tasks/${child.id}/run`, { method: "POST" });

    expect(res.status).toBe(202);
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
    const task = store.create({ title: "A", description: "do it", directory: repoDir });
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
    const task = store.create({ title: "A", description: "do it", directory: repoDir });
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${task.id}/retry`, { method: "POST" });

    expect(res.status).toBe(202);
    expect(dispatcher.retry).toHaveBeenCalledWith(task.id, undefined);
  });

  it("returns 409 and does not dispatch retry for an archived task", async () => {
    const task = store.create({ title: "Archived", description: "do it", directory: repoDir });
    store.setArchived(task.id, true);
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${task.id}/retry`, { method: "POST" });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toBe("Cannot retry an archived task");
    expect(dispatcher.retry).not.toHaveBeenCalled();
  });

  it("returns 400 and does not dispatch retry for a manual task", async () => {
    const task = store.create({ type: "manual", title: "Manual", description: "review it", directory: repoDir });
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${task.id}/retry`, { method: "POST" });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("Manual tasks cannot retry");
    expect(dispatcher.retry).not.toHaveBeenCalled();
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
    const task = store.create({ title: "A", description: "do it", directory: repoDir });
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
    const a = store.create({ title: "A", description: "", directory: repoDir });
    store.create({ title: "B", description: "", directory: repoDir });
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
    const a = store.create({ title: "A", description: "", directory: repoDir });
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
    const a = store.create({ title: "A", description: "", directory: repoDir });
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

  it("sets completedBy to User when moving to Done without explicit attribution", async () => {
    const a = store.create({ title: "A", description: "", directory: repoDir });
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${a.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ column: "done", position: 0 }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Task[];
    const moved = body.find((t) => t.id === a.id)!;
    expect(moved.column).toBe("done");
    expect(moved.completedBy).toBe(USER_COMPLETED_BY);
    expect(store.get(a.id)?.completedBy).toBe(USER_COMPLETED_BY);
  });

  it("preserves sessionId, worktree metadata, completion report, and error when moving", async () => {
    const report = {
      outcome: "complete" as const,
      summary: "done",
      changedFiles: ["src/a.ts"],
      verification: [{ command: "npm test", result: "passed" }],
      residualRisk: "low",
      reportedAt: 9_000,
    };
    const a = store.create({ title: "A", description: "", directory: repoDir });
    store.update(a.id, {
      sessionId: "ses_123",
      runState: "idle",
      runStartedAt: 1_000,
      error: "old error",
      worktreePath: "/worktrees/a",
      worktreeBranch: "task/a",
      baseBranch: "main",
      completion: report,
      completionSource: "reported",
    });

    const app = buildApp(store, dispatcher);
    const res = await app.request(`/api/tasks/${a.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ column: "done", position: 0 }),
    });

    expect(res.status).toBe(200);
    const moved = store.get(a.id)!;
    expect(moved.sessionId).toBe("ses_123");
    expect(moved.runStartedAt).toBe(1_000);
    expect(moved.error).toBe("old error");
    expect(moved.worktreePath).toBe("/worktrees/a");
    expect(moved.worktreeBranch).toBe("task/a");
    expect(moved.baseBranch).toBe("main");
    expect(moved.completion).toEqual(report);
    expect(moved.completionSource).toBe("reported");
  });

  it("does not set completedBy when moving to a non-Done column", async () => {
    const a = store.create({ title: "A", description: "", directory: repoDir });
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${a.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ column: "in_progress", position: 0 }),
    });

    expect(res.status).toBe(200);
    const moved = (await res.json()) as Task[];
    expect(moved.find((t) => t.id === a.id)!.completedBy).toBeNull();
    expect(store.get(a.id)?.completedBy).toBeNull();
  });

  it("honours an explicit completedBy override including on non-Done columns", async () => {
    const a = store.create({ title: "A", description: "", directory: repoDir });
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${a.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ column: "review", position: 0, completedBy: "plan-agent" }),
    });

    expect(res.status).toBe(200);
    const moved = (await res.json()) as Task[];
    expect(moved.find((t) => t.id === a.id)!.completedBy).toBe("plan-agent");
    expect(store.get(a.id)?.completedBy).toBe("plan-agent");
  });

  it("clears completedBy when moving away from Done without explicit attribution", async () => {
    const a = store.create({ title: "A", description: "", directory: repoDir });
    store.update(a.id, { column: "done", position: 0, completedBy: USER_COMPLETED_BY });
    expect(store.get(a.id)?.completedBy).toBe(USER_COMPLETED_BY);
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${a.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ column: "review", position: 0 }),
    });

    expect(res.status).toBe(200);
    const moved = (await res.json()) as Task[];
    expect(moved.find((t) => t.id === a.id)!.completedBy).toBeNull();
    expect(store.get(a.id)?.completedBy).toBeNull();
  });

  it("rejects a non-string/non-null completedBy with 400", async () => {
    const a = store.create({ title: "A", description: "", directory: repoDir });
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${a.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ column: "done", position: 0, completedBy: 123 }),
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
    const task = store.create({ title: "A", description: "", directory: repoDir });
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${task.id}`, { method: "DELETE" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });

    expect(store.get(task.id)).toBeUndefined();
    expect(store.list()).toHaveLength(0);
  });
});

// --- Worktree isolation endpoints -------------------------------------------

describe("worktree isolation routes", () => {
  let store: SqliteTaskStore;
  let dispatcher: ReturnType<typeof makeFakeDispatcher>;

  beforeEach(() => {
    store = new SqliteTaskStore(":memory:");
    dispatcher = makeFakeDispatcher(store);
  });

  afterEach(() => {
    store.close();
  });

  it("accepts an isolation override on create", async () => {
    const app = buildApp(store, dispatcher);
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "A", directory: repoDir, isolation: "worktree" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { isolation?: string };
    expect(body.isolation).toBe("worktree");
  });

  it("rejects an invalid isolation value with 400", async () => {
    const app = buildApp(store, dispatcher);
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "A", directory: repoDir, isolation: "nope" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /init-git delegates to the dispatcher and returns 202", async () => {
    const task = store.create({ title: "A", description: "", directory: repoDir });
    const app = buildApp(store, dispatcher);
    const res = await app.request(`/api/tasks/${task.id}/init-git`, { method: "POST" });
    expect(res.status).toBe(202);
    expect(dispatcher.initGitAndRun).toHaveBeenCalledWith(task.id);
  });

  it("POST /init-git returns 409 and does not dispatch a session for an archived task", async () => {
    const task = store.create({ title: "Archived", description: "", directory: repoDir });
    store.setArchived(task.id, true);
    const client = new FakeOpencodeClient();
    const realDispatcher = new TaskDispatcher({
      client: client as never,
      store,
      worktrees: new FakeWorktrees(),
    });
    const app = buildApp(store, realDispatcher);

    const res = await app.request(`/api/tasks/${task.id}/init-git`, { method: "POST" });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toBe("Cannot run an archived task");
    expect(client.createCalls).toHaveLength(0);
  });

  it("POST /sync returns 200 on a clean merge", async () => {
    const task = store.create({ title: "A", description: "", directory: repoDir });
    const app = buildApp(store, dispatcher);
    const res = await app.request(`/api/tasks/${task.id}/sync`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("POST /sync returns 409 when the merge conflicts", async () => {
    const task = store.create({ title: "A", description: "", directory: repoDir });
    dispatcher.syncUpstream.mockResolvedValueOnce({
      task: store.get(task.id),
      ok: false,
      conflict: true,
      message: "conflict",
    });
    const app = buildApp(store, dispatcher);
    const res = await app.request(`/api/tasks/${task.id}/sync`, { method: "POST" });
    expect(res.status).toBe(409);
  });

  it("POST /integrate passes an explicit targetBranch through", async () => {
    const task = store.create({ title: "A", description: "", directory: repoDir });
    const app = buildApp(store, dispatcher);
    const res = await app.request(`/api/tasks/${task.id}/integrate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetBranch: "dev" }),
    });
    expect(res.status).toBe(200);
    expect(dispatcher.integrate).toHaveBeenCalledWith(task.id, "dev");
  });

  it("GET /api/settings returns defaults; PUT updates them", async () => {
    const app = buildApp(store, dispatcher);

    const get1 = await app.request("/api/settings");
    expect(get1.status).toBe(200);
    expect(await get1.json()).toEqual({ worktreeDefault: false });

    const put = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worktreeDefault: true }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ worktreeDefault: true });

    const get2 = await app.request("/api/settings");
    expect(await get2.json()).toEqual({ worktreeDefault: true });
  });

  it("PUT /api/settings rejects a non-boolean with 400", async () => {
    const app = buildApp(store, dispatcher);
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worktreeDefault: "yes" }),
    });
    expect(res.status).toBe(400);
  });
});

// --- Directory containment ---------------------------------------------------

describe("POST /api/tasks directory containment", () => {
  let store: SqliteTaskStore;
  let dispatcher: ReturnType<typeof makeFakeDispatcher>;

  beforeEach(() => {
    store = new SqliteTaskStore(":memory:");
    dispatcher = makeFakeDispatcher(store);
  });

  afterEach(() => {
    store.close();
  });

  it("rejects a directory outside the workspace", async () => {
    const outside = join(workspaceDir, "..", "outside");
    mkdirSync(outside, { recursive: true });
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Escape", description: "x", directory: outside }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation");
    expect(body.error.message).toContain("outside the board workspace");
    expect(store.list()).toHaveLength(0);
  });

  it("rejects a missing directory", async () => {
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Missing", description: "x", directory: join(workspaceDir, "missing") }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation");
    expect(body.error.message).toContain("Directory does not exist");
    expect(store.list()).toHaveLength(0);
  });

  it("allows an external directory when OPENBOARD_ALLOW_EXTERNAL_DIRECTORIES is set", async () => {
    const outside = join(workspaceDir, "..", "allowed-outside");
    mkdirSync(outside, { recursive: true });
    process.env.OPENBOARD_ALLOW_EXTERNAL_DIRECTORIES = "true";
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Allowed", description: "x", directory: outside }),
    });

    expect(res.status).toBe(201);
    expect(store.list()).toHaveLength(1);
  });
});
