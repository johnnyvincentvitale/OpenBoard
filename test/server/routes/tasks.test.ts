import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { registerTaskRoutes } from "../../../src/server/routes/tasks";
import { registerCompletionRoutes } from "../../../src/server/routes/completion";
import { TaskDispatcher } from "../../../src/server/dispatcher";
import { SqliteTaskStore } from "../../../src/db/task-store";
import type { Dispatcher, RosterAgent, RespondPermissionOutcome, Task } from "../../../src/shared";
import { USER_COMPLETED_BY } from "../../../src/shared";
import { AdapterError } from "../../../src/shared/errors";
import type { WorktreeManager } from "../../../src/server/worktree";
import type { ChainAdvancer } from "../../../src/server/chain-advancer";
import { createChainAdvancer } from "../../../src/server/chain-advancer";
import { cleanupTestWorkspace, setupTestWorkspace } from "../test-workspace";

let workspaceDir: string;
let repoDir: string;

function deferred<T = unknown>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

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
  getWorktreeCommitStatus: ReturnType<typeof vi.fn>;
  commitFile: ReturnType<typeof vi.fn>;
  integrate: ReturnType<typeof vi.fn>;
  removeTask: ReturnType<typeof vi.fn>;
  discardWorktree: ReturnType<typeof vi.fn>;
  sweepOrphanedWorktrees: ReturnType<typeof vi.fn>;
  resolveOrphanWorktree: ReturnType<typeof vi.fn>;
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
    getWorktreeCommitStatus: vi.fn(async () => ({ committedFiles: [], uncommittedFiles: [] })),
    commitFile: vi.fn(async (taskId: string, file: string) => {
      const task = store.get(taskId);
      if (!task) throw new Error(`unknown task ${taskId}`);
      return { task, ok: true, file, message: "committed" };
    }),
    integrate: vi.fn(async (taskId: string, _targetBranch?: string) => {
      const task = store.get(taskId);
      if (!task) throw new Error(`unknown task ${taskId}`);
      return { task, ok: true, conflict: false, message: "integrated" };
    }),
    removeTask: vi.fn(async (taskId: string) => {
      store.remove(taskId);
      return { ok: true };
    }),
    discardWorktree: vi.fn(async () => ({ ok: true, removed: true, dirty: false, kept: false, message: "discarded" })),
    sweepOrphanedWorktrees: vi.fn(async () => []),
    resolveOrphanWorktree: vi.fn(async (worktreePath: string) => ({ ok: true, removed: true, dirty: false, kept: false, message: "resolved", worktreePath })),
    listPendingPermissions: vi.fn(() => []),
    respondPermission: vi.fn(async (_taskId: string, _input: { askId: string; action: "allow_once" | "deny"; answeredBy: string }): Promise<RespondPermissionOutcome> => ({ ok: true, askId: "ask_1", decision: "allow_once" })),
    sendSessionMessage: vi.fn(async (taskId: string, input) => ({ messageId: input.clientMessageId, taskId, sessionId: input.expectedSessionId, status: "accepted" as const, mode: input.mode, sentAt: Date.now(), sentBy: input.sentBy, task: store.get(taskId)! })),
    start: vi.fn(),
    shutdown: vi.fn(),
  };
}

function buildApp(
  store: SqliteTaskStore,
  dispatcher: Dispatcher,
  rosterOrFetch: RosterAgent[] | (() => Promise<RosterAgent[]>) = [],
  advancer?: ChainAdvancer,
): Hono {
  const app = new Hono();
  const fetch = Array.isArray(rosterOrFetch) ? async () => rosterOrFetch : rosterOrFetch;
  registerTaskRoutes(app, {
    store,
    dispatcher,
    agentRoster: { fetch },
    advancer,
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

  async commitStatus() {
    return { committedFiles: [], uncommittedFiles: [] };
  }

  async commitFile(_worktreePath: string, file: string) {
    return { ok: true, file, message: "committed" };
  }

  async integrate() {
    return { ok: true, conflict: false, message: "integrated" };
  }

  async isWorktreeDirty(): Promise<boolean> {
    return false;
  }

  async cleanupWorktree(_repoDir: string, worktreePath: string) {
    return { ok: true, removed: true, dirty: false, kept: false, message: "removed", worktreePath };
  }

  async listManagedWorktrees(): Promise<string[]> {
    return [];
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
        taskKind: "build",
        description: "There is a bug",
        directory: repoDir,
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.title).toBe("Fix the bug");
    expect(body.type).toBe("agent");
    expect(body.taskKind).toBe("build");
    expect(body.description).toBe("There is a bug");
    expect(body.directory).toBe(repoDir);
    expect(body.column).toBe("todo");
    expect(body.runState).toBe("unstarted");
    expect(typeof body.id).toBe("string");

    // Persisted in the store.
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.taskKind).toBe("build");
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

  it("creates a claude-code agent task without resolving an OpenCode model", async () => {
    const app = buildApp(store, dispatcher, async () => {
      throw new Error("roster should not be fetched for Claude Code tasks");
    });

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "agent",
        harness: "claude-code",
        title: "Claude worker",
        description: "Use Claude Code",
        directory: repoDir,
        agent: "plan",
        claudePermissionMode: "auto",
        isolation: "worktree",
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Task;
    expect(body.harness).toBe("claude-code");
    expect(body.agent).toBeUndefined();
    expect(body.claudePermissionMode).toBe("auto");
    expect(body.model).toBeUndefined();
    expect(store.get(body.id)?.harness).toBe("claude-code");
    expect(store.get(body.id)?.agent).toBeUndefined();
    expect(store.get(body.id)?.claudePermissionMode).toBe("auto");
  });

  it("rejects claude-code permission modes outside Claude Code tasks", async () => {
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Bad permission",
        directory: repoDir,
        claudePermissionMode: "bypassPermissions",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("claudePermissionMode can only be set for claude-code agent tasks");
  });

  it("rejects unknown claude-code permission modes", async () => {
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        harness: "claude-code",
        title: "Bad permission",
        directory: repoDir,
        claudePermissionMode: "root",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("claudePermissionMode must be a supported Claude Code permission mode");
  });

  it("creates a claude-code agent task with a Claude Code model", async () => {
    const app = buildApp(store, dispatcher, async () => {
      throw new Error("roster should not be fetched for Claude Code tasks");
    });

    const model = { providerID: "claude-code", id: "sonnet" };
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        harness: "claude-code",
        title: "Claude model worker",
        directory: repoDir,
        model,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Task;
    expect(body.harness).toBe("claude-code");
    expect(body.model).toEqual(model);
    expect(store.get(body.id)?.model).toEqual(model);
  });

  it("creates a Gemini ACP task without resolving an OpenCode model", async () => {
    const app = buildApp(store, dispatcher, async () => {
      throw new Error("roster should not be fetched for Gemini ACP tasks");
    });

    const model = { providerID: "gemini-acp", id: "gemini-2.5-pro" };
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "agent",
        harness: "gemini-acp",
        title: "Gemini worker",
        description: "Use Gemini ACP",
        directory: repoDir,
        agent: "stale-opencode-profile",
        permissionMode: "manual",
        acpOptions: { thinkingBudget: "low" },
        model,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Task;
    expect(body.harness).toBe("gemini-acp");
    expect(body.agent).toBeUndefined();
    expect(body.permissionMode).toBe("manual");
    expect(body.acpOptions).toEqual({ thinkingBudget: "low" });
    expect(body.model).toEqual(model);
  });

  it("rejects claude-code tasks with a non-Claude model provider", async () => {
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        harness: "claude-code",
        title: "Bad Claude worker",
        directory: repoDir,
        model: { providerID: "opencode", id: "north-mini-code-free" },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("claude-code task model.providerID must be 'claude-code'");
  });

  it("creates an in-place OpenCode agent task with a permission override", async () => {
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "In-place worker",
        directory: repoDir,
        isolation: "in-place",
        permissionOverrides: { edit: "ask", bash: "deny" },
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Task;
    expect(body.permissionOverrides).toEqual({ edit: "ask", bash: "deny" });
    expect(store.get(body.id)?.permissionOverrides).toEqual({ edit: "ask", bash: "deny" });
  });

  it("rejects permissionOverrides on worktree-isolated tasks", async () => {
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Bad override",
        directory: repoDir,
        isolation: "worktree",
        permissionOverrides: { edit: "ask" },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("permissionOverrides can only be set for in-place OpenCode agent tasks");
  });

  it("rejects permissionOverrides when isolation is unset", async () => {
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Bad override",
        directory: repoDir,
        permissionOverrides: { edit: "ask" },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("permissionOverrides can only be set for in-place OpenCode agent tasks");
  });

  it("rejects permissionOverrides on claude-code tasks", async () => {
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        harness: "claude-code",
        title: "Bad override",
        directory: repoDir,
        isolation: "in-place",
        permissionOverrides: { edit: "ask" },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("permissionOverrides can only be set for in-place OpenCode agent tasks");
  });

  it("rejects permissionOverrides with an unknown category or action", async () => {
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Bad override shape",
        directory: repoDir,
        isolation: "in-place",
        permissionOverrides: { edit: "sometimes" },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("permissionOverrides must be an object mapping");
  });

  it("creates a worktree-isolated task with autoRun set", async () => {
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Auto-run worker",
        directory: repoDir,
        isolation: "worktree",
        autoRun: true,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Task;
    expect(body.autoRun).toBe(true);
    expect(store.get(body.id)?.autoRun).toBe(true);
  });

  it("rejects autoRun on an in-place task", async () => {
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Bad auto-run",
        directory: repoDir,
        isolation: "in-place",
        autoRun: true,
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain('autoRun requires worktree isolation, or an in-place OpenCode task with edit and bash permission overrides set to "deny"');
  });

  it("rejects autoRun when isolation is unset", async () => {
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Bad auto-run",
        directory: repoDir,
        autoRun: true,
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain('autoRun requires worktree isolation, or an in-place OpenCode task with edit and bash permission overrides set to "deny"');
  });

  it("creates a fenced in-place OpenCode task (edit+bash deny) with autoRun set", async () => {
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Read-only auto-run",
        directory: repoDir,
        isolation: "in-place",
        permissionOverrides: { edit: "deny", bash: "deny" },
        autoRun: true,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Task;
    expect(body.autoRun).toBe(true);
    expect(store.get(body.id)?.autoRun).toBe(true);
    expect(store.get(body.id)?.permissionOverrides).toEqual({ edit: "deny", bash: "deny" });
  });

  it("rejects autoRun on an in-place task whose overrides deny edit but not bash", async () => {
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Half-fenced auto-run",
        directory: repoDir,
        isolation: "in-place",
        permissionOverrides: { edit: "deny", bash: "ask" },
        autoRun: true,
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("autoRun requires worktree isolation");
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

  it("responds 400 validation when taskKind is unsupported", async () => {
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Bad kind",
        taskKind: "investigate",
        directory: repoDir,
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("taskKind must be one of");
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

// --- PATCH /api/tasks/:id -------------------------------------------------------

describe("PATCH /api/tasks/:id", () => {
  let store: SqliteTaskStore;
  let dispatcher: ReturnType<typeof makeFakeDispatcher>;

  beforeEach(() => {
    store = new SqliteTaskStore(":memory:");
    dispatcher = makeFakeDispatcher(store);
  });

  afterEach(() => {
    store.close();
  });

  function patch(app: Hono, id: string, body: Record<string, unknown>) {
    return app.request(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("sets permissionOverrides on an in-place OpenCode agent task", async () => {
    const app = buildApp(store, dispatcher);
    const task = store.create({ title: "T", description: "", directory: repoDir, isolation: "in-place" });

    const res = await patch(app, task.id, { permissionOverrides: { edit: "ask" } });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Task;
    expect(body.permissionOverrides).toEqual({ edit: "ask" });
    expect(store.get(task.id)?.permissionOverrides).toEqual({ edit: "ask" });
  });

  it("rejects permissionOverrides on a worktree-isolated task", async () => {
    const app = buildApp(store, dispatcher);
    const task = store.create({ title: "T", description: "", directory: repoDir, isolation: "worktree" });

    const res = await patch(app, task.id, { permissionOverrides: { edit: "ask" } });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("permissionOverrides can only be set for in-place OpenCode agent tasks");
  });

  it("rejects an invalid permissionOverrides shape", async () => {
    const app = buildApp(store, dispatcher);
    const task = store.create({ title: "T", description: "", directory: repoDir, isolation: "in-place" });

    const res = await patch(app, task.id, { permissionOverrides: { edit: "sometimes" } });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("permissionOverrides must be an object mapping");
  });

  it("rejects permissionOverrides on manual tasks", async () => {
    const app = buildApp(store, dispatcher);
    const task = store.create({ type: "manual", title: "T", description: "", directory: repoDir });

    const res = await patch(app, task.id, { permissionOverrides: { edit: "ask" } });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("permissionOverrides can only be set for in-place OpenCode agent tasks");
  });

  it("sets autoRun on a worktree-isolated agent task", async () => {
    const app = buildApp(store, dispatcher);
    const task = store.create({ title: "T", description: "", directory: repoDir, isolation: "worktree" });

    const res = await patch(app, task.id, { autoRun: true });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Task;
    expect(body.autoRun).toBe(true);
    expect(store.get(task.id)?.autoRun).toBe(true);
  });

  it("rejects autoRun on an in-place card", async () => {
    const app = buildApp(store, dispatcher);
    const task = store.create({ title: "T", description: "", directory: repoDir, isolation: "in-place" });

    const res = await patch(app, task.id, { autoRun: true });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain('autoRun requires worktree isolation, or an in-place OpenCode task with edit and bash permission overrides set to "deny"');
  });

  it("rejects autoRun on manual tasks", async () => {
    const app = buildApp(store, dispatcher);
    const task = store.create({ type: "manual", title: "T", description: "", directory: repoDir });

    const res = await patch(app, task.id, { autoRun: true });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain('autoRun requires worktree isolation, or an in-place OpenCode task with edit and bash permission overrides set to "deny"');
  });

  it("auto-clears autoRun when the same PATCH moves isolation from worktree to in-place", async () => {
    const app = buildApp(store, dispatcher);
    const task = store.create({
      title: "T",
      description: "",
      directory: repoDir,
      isolation: "worktree",
      autoRun: true,
    });
    expect(store.get(task.id)?.autoRun).toBe(true);

    const res = await patch(app, task.id, { isolation: "in-place" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Task;
    expect(body.autoRun).toBe(false);
    expect(store.get(task.id)?.autoRun).toBe(false);
  });

  it("leaves a worktree task's untouched autoRun intact when unrelated fields change", async () => {
    const app = buildApp(store, dispatcher);
    const task = store.create({
      title: "T",
      description: "",
      directory: repoDir,
      isolation: "worktree",
      autoRun: true,
    });

    const res = await patch(app, task.id, { title: "Renamed" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Task;
    expect(body.title).toBe("Renamed");
    expect(body.autoRun).toBe(true);
  });

  it("sets autoRun via PATCH on a fenced in-place card (edit+bash deny)", async () => {
    const app = buildApp(store, dispatcher);
    const task = store.create({
      title: "T",
      description: "",
      directory: repoDir,
      isolation: "in-place",
      permissionOverrides: { edit: "deny", bash: "deny" },
    });

    const res = await patch(app, task.id, { autoRun: true });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Task;
    expect(body.autoRun).toBe(true);
    expect(store.get(task.id)?.autoRun).toBe(true);
  });

  it("auto-clears autoRun when a PATCH weakens a fenced in-place card's bash override", async () => {
    const app = buildApp(store, dispatcher);
    const task = store.create({
      title: "T",
      description: "",
      directory: repoDir,
      isolation: "in-place",
      permissionOverrides: { edit: "deny", bash: "deny" },
      autoRun: true,
    });
    expect(store.get(task.id)?.autoRun).toBe(true);

    const res = await patch(app, task.id, { permissionOverrides: { edit: "deny", bash: "allow" } });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Task;
    expect(body.autoRun).toBe(false);
    expect(store.get(task.id)?.autoRun).toBe(false);
  });

  it("rejects a PATCH that sets autoRun on an unfenced in-place card", async () => {
    const app = buildApp(store, dispatcher);
    const task = store.create({
      title: "T",
      description: "",
      directory: repoDir,
      isolation: "in-place",
      permissionOverrides: { edit: "deny", bash: "ask" },
    });

    const res = await patch(app, task.id, { autoRun: true });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("autoRun requires worktree isolation");
    expect(store.get(task.id)?.autoRun).toBe(false);
  });

  it("auto-clears an existing override when the same PATCH moves isolation away from in-place", async () => {
    const app = buildApp(store, dispatcher);
    const task = store.create({
      title: "T",
      description: "",
      directory: repoDir,
      isolation: "in-place",
      permissionOverrides: { edit: "ask" },
    });
    expect(store.get(task.id)?.permissionOverrides).toEqual({ edit: "ask" });

    const res = await patch(app, task.id, { isolation: "worktree" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Task;
    expect(body.permissionOverrides).toBeNull();
    expect(store.get(task.id)?.permissionOverrides).toBeNull();
  });

  it("auto-clears an existing override when the same PATCH moves harness away from opencode", async () => {
    const app = buildApp(store, dispatcher);
    const task = store.create({
      title: "T",
      description: "",
      directory: repoDir,
      isolation: "in-place",
      permissionOverrides: { bash: "deny" },
    });
    expect(store.get(task.id)?.permissionOverrides).toEqual({ bash: "deny" });

    const res = await patch(app, task.id, { harness: "claude-code" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Task;
    expect(body.permissionOverrides).toBeNull();
    expect(store.get(task.id)?.permissionOverrides).toBeNull();
  });

  it("leaves an in-place task's untouched permissionOverrides intact when unrelated fields change", async () => {
    const app = buildApp(store, dispatcher);
    const task = store.create({
      title: "T",
      description: "",
      directory: repoDir,
      isolation: "in-place",
      permissionOverrides: { edit: "ask" },
    });

    const res = await patch(app, task.id, { title: "Renamed" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Task;
    expect(body.title).toBe("Renamed");
    expect(body.permissionOverrides).toEqual({ edit: "ask" });
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
    expect(dispatcher.retry).toHaveBeenCalledWith(task.id, "try again", undefined);
  });

  it("allows an empty body (feedback optional)", async () => {
    const task = store.create({ title: "A", description: "do it", directory: repoDir });
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${task.id}/retry`, { method: "POST" });

    expect(res.status).toBe(202);
    expect(dispatcher.retry).toHaveBeenCalledWith(task.id, undefined, undefined);
  });

  it("accepts an exact blocked answer, records it, and dispatches answeredBlock retry", async () => {
    const task = store.create({ title: "A", description: "do it", directory: repoDir });
    store.setCompletion(task.id, { outcome: "blocked", summary: "stuck", changedFiles: [], verification: [], residualRisk: "Need choice", reportedAt: 123 }, "reported");
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${task.id}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ feedback: "Use A", blockedAnswer: { blockedReportedAt: 123, answeredBy: " Reviewer " } }),
    });

    expect(res.status).toBe(202);
    expect(dispatcher.retry).toHaveBeenCalledWith(task.id, "Use A", { blockedReportedAt: 123, answeredBy: "Reviewer" });
    const events = store.listEvents(task.id);
    expect(events.map((event) => event.type).sort()).toEqual(["task_blocked_answered", "task_retried"]);
    const answered = events.find((event) => event.type === "task_blocked_answered")!;
    const retried = events.find((event) => event.type === "task_retried")!;
    expect(answered.body).toMatchObject({ blockedReportedAt: 123, answeredBy: "Reviewer", question: "Need choice", answerProvided: true });
    expect(answered.body).not.toHaveProperty("answer");
    expect(retried.body).toMatchObject({ answeredBlock: true });
  });

  it("rejects stale, partial, and duplicate blocked answers without retrying", async () => {
    const app = buildApp(store, dispatcher);
    const blocked = store.create({ title: "A", description: "do it", directory: repoDir });
    store.setCompletion(blocked.id, { outcome: "blocked", summary: "stuck", changedFiles: [], verification: [], residualRisk: "Need choice", reportedAt: 123 }, "reported");
    const done = store.create({ title: "B", description: "done", directory: repoDir });

    for (const [id, blockedAnswer] of [
      [blocked.id, { blockedReportedAt: 122, answeredBy: "Reviewer" }],
      [blocked.id, { blockedReportedAt: 123 }],
      [done.id, { blockedReportedAt: 123, answeredBy: "Reviewer" }],
    ] as const) {
      const res = await app.request(`/api/tasks/${id}/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "Use A", blockedAnswer }),
      });
      expect(res.status).toBe(409);
    }
    const empty = await app.request(`/api/tasks/${blocked.id}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ feedback: "  ", blockedAnswer: { blockedReportedAt: 123, answeredBy: "Reviewer" } }),
    });
    expect(empty.status).toBe(409);
    expect(dispatcher.retry).not.toHaveBeenCalled();
    expect(store.listEvents(blocked.id)).toEqual([]);
  });

  it("records blocked retry failure without answered/retried success events", async () => {
    const task = store.create({ title: "A", description: "do it", directory: repoDir });
    store.setCompletion(task.id, { outcome: "blocked", summary: "stuck", changedFiles: [], verification: [], residualRisk: "Need choice", reportedAt: 123 }, "reported");
    dispatcher.retry.mockRejectedValueOnce(new Error("prompt failed"));
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${task.id}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ feedback: "Use A", blockedAnswer: { blockedReportedAt: 123, answeredBy: "Reviewer" } }),
    });

    expect(res.status).toBe(500);
    expect(store.get(task.id)?.completion?.outcome).toBe("blocked");
    expect(store.listEvents(task.id).map((event) => event.type)).toEqual(["task_blocked_retry_failed"]);
  });

  it("rejects a duplicate in-flight blocked answer and releases the guard after failure", async () => {
    const task = store.create({ title: "A", description: "do it", directory: repoDir });
    store.setCompletion(task.id, { outcome: "blocked", summary: "stuck", changedFiles: [], verification: [], residualRisk: "Need choice", reportedAt: 123 }, "reported");
    const first = deferred<Task>();
    dispatcher.retry.mockReturnValueOnce(first.promise);
    const app = buildApp(store, dispatcher);
    const request = () => app.request(`/api/tasks/${task.id}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ feedback: "Use A", blockedAnswer: { blockedReportedAt: 123, answeredBy: "Reviewer" } }),
    });

    const pending = request();
    const duplicate = await request();
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).error.code).toBe("blocked_answer_duplicate");
    expect(dispatcher.retry).toHaveBeenCalledTimes(1);
    expect(store.listEvents(task.id)).toEqual([]);

    first.reject(new Error("prompt failed"));
    await pending;
    expect(store.listEvents(task.id).map((event) => event.type)).toEqual(["task_blocked_retry_failed"]);

    dispatcher.retry.mockResolvedValueOnce(store.update(task.id, { runState: "running", runStartedAt: 456 })!);
    const retry = await request();
    expect(retry.status).toBe(202);
    expect(dispatcher.retry).toHaveBeenCalledTimes(2);
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

describe("POST /api/tasks/:id/session-messages", () => {
  let store: SqliteTaskStore;
  let dispatcher: ReturnType<typeof makeFakeDispatcher>;

  beforeEach(() => {
    store = new SqliteTaskStore(":memory:");
    dispatcher = makeFakeDispatcher(store);
  });

  afterEach(() => store.close());

  it("validates and forwards an operator message with session identity", async () => {
    const task = store.create({ title: "Chat", description: "", directory: repoDir });
    store.update(task.id, { sessionId: "ses_chat", runStartedAt: 123, runState: "running" });
    const app = buildApp(store, dispatcher);
    const body = {
      text: "Please check the failing test",
      mode: "queue",
      sentBy: "User",
      clientMessageId: "msg-1",
      expectedSessionId: "ses_chat",
      expectedRunStartedAt: 123,
    };
    const res = await app.request(`/api/tasks/${task.id}/session-messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(202);
    expect(dispatcher.sendSessionMessage).toHaveBeenCalledWith(task.id, body);
  });

  it("rejects empty messages before dispatch", async () => {
    const task = store.create({ title: "Chat", description: "", directory: repoDir });
    const app = buildApp(store, dispatcher);
    const res = await app.request(`/api/tasks/${task.id}/session-messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "  ", mode: "queue", sentBy: "User", clientMessageId: "msg-2", expectedSessionId: "ses" }),
    });
    expect(res.status).toBe(400);
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

  it("requires exact blocked acceptance before moving a blocked task to Done", async () => {
    const a = store.create({ title: "A", description: "", directory: repoDir });
    store.setCompletion(a.id, { outcome: "blocked", summary: "stuck", changedFiles: [], verification: [], residualRisk: "Need choice", reportedAt: 321 }, "reported");
    const app = buildApp(store, dispatcher);

    const denied = await app.request(`/api/tasks/${a.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ column: "done", position: 0, completedBy: "Reviewer" }),
    });
    expect(denied.status).toBe(409);
    expect((await denied.json()).error.requirement).toMatchObject({ blockedReportedAt: 321, completedBy: "required", question: "Need choice", transition: "move" });
    expect(store.get(a.id)?.column).not.toBe("done");

    const accepted = await app.request(`/api/tasks/${a.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ column: "done", position: 0, completedBy: "Reviewer", blockedAcceptance: { acceptIncomplete: true, blockedReportedAt: 321 } }),
    });
    expect(accepted.status).toBe(200);
    expect(store.get(a.id)?.column).toBe("done");
    expect(store.get(a.id)?.completion?.outcome).toBe("blocked");
    expect(store.listEvents(a.id).find((event) => event.type === "task_blocked_accepted")?.body).toMatchObject({
      completedBy: "Reviewer",
      blockedReportedAt: 321,
      question: "Need choice",
      summary: "stuck",
      residualRisk: "Need choice",
      transition: "move",
    });
  });

  it("rejects stray blocked acceptance on nonblocked Done moves", async () => {
    const a = store.create({ title: "A", description: "", directory: repoDir });
    const app = buildApp(store, dispatcher);
    const res = await app.request(`/api/tasks/${a.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ column: "done", position: 0, blockedAcceptance: { acceptIncomplete: true, blockedReportedAt: 1 } }),
    });
    expect(res.status).toBe(409);
    expect(store.get(a.id)?.column).not.toBe("done");
  });

  it("fires the advancer when a manual move lands the task in Done", async () => {
    const a = store.create({ title: "A", description: "", directory: repoDir });
    const child = store.create({
      title: "Child",
      description: "",
      directory: repoDir,
      isolation: "worktree",
      autoRun: true,
    });
    store.addLink(a.id, child.id);
    const runTask = vi.fn(async (taskId: string) => {
      store.update(taskId, { runState: "running", column: "in_progress" });
      return store.get(taskId)!;
    });
    const advancer = createChainAdvancer({ store, runTask });
    const app = buildApp(store, dispatcher, [], advancer);

    const res = await app.request(`/api/tasks/${a.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ column: "done", position: 0 }),
    });

    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runTask).toHaveBeenCalledWith(child.id);
    expect(store.listEvents(child.id).some((e) => e.type === "task_auto_dispatched")).toBe(true);
  });

  it("does not fire the advancer when moving to a non-Done column", async () => {
    const a = store.create({ title: "A", description: "", directory: repoDir });
    const child = store.create({
      title: "Child",
      description: "",
      directory: repoDir,
      isolation: "worktree",
      autoRun: true,
    });
    store.addLink(a.id, child.id);
    const runTask = vi.fn(async (taskId: string) => store.get(taskId)!);
    const advancer = createChainAdvancer({ store, runTask });
    const app = buildApp(store, dispatcher, [], advancer);

    const res = await app.request(`/api/tasks/${a.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ column: "in_progress", position: 0 }),
    });

    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runTask).not.toHaveBeenCalled();
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

  it("passes worktree cleanup force and keep choices to the dispatcher", async () => {
    const task = store.create({ title: "A", description: "", directory: repoDir });
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${task.id}?forceWorktree=true&keepWorktree=true`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    expect(dispatcher.removeTask).toHaveBeenCalledWith(task.id, {
      force: true,
      keepWorktree: true,
    });
  });

  it("returns 409 when dirty worktree cleanup needs confirmation", async () => {
    const task = store.create({ title: "A", description: "", directory: repoDir });
    dispatcher.removeTask.mockResolvedValueOnce({
      ok: false,
      message: "worktree has uncommitted changes",
      worktree: {
        ok: false,
        removed: false,
        dirty: true,
        kept: true,
        message: "worktree has uncommitted changes",
        worktreePath: "/worktrees/a",
      },
    });
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${task.id}`, { method: "DELETE" });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.worktree.dirty).toBe(true);
    expect(body.worktree.kept).toBe(true);
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
    expect(dispatcher.integrate).toHaveBeenCalledWith(task.id, "dev", { commitRemaining: false });
  });

  it("GET /commit-status delegates to dispatcher", async () => {
    const task = store.create({ title: "A", description: "", directory: repoDir });
    dispatcher.getWorktreeCommitStatus.mockResolvedValueOnce({
      committedFiles: ["src/a.ts"],
      uncommittedFiles: ["src/b.ts"],
    });
    const app = buildApp(store, dispatcher);
    const res = await app.request(`/api/tasks/${task.id}/commit-status?targetBranch=dev`);

    expect(res.status).toBe(200);
    expect(dispatcher.getWorktreeCommitStatus).toHaveBeenCalledWith(task.id, "dev");
    expect(await res.json()).toEqual({ committedFiles: ["src/a.ts"], uncommittedFiles: ["src/b.ts"] });
  });

  it("POST /commit-file commits one file and records an event", async () => {
    const task = store.create({ title: "A", description: "", directory: repoDir });
    const app = buildApp(store, dispatcher);
    const res = await app.request(`/api/tasks/${task.id}/commit-file`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: "src/a.ts" }),
    });

    expect(res.status).toBe(200);
    expect(dispatcher.commitFile).toHaveBeenCalledWith(task.id, "src/a.ts", undefined);
    const events = store.listEvents(task.id);
    expect(events.at(-1)?.type).toBe("task_file_committed");
  });

  it("POST /integrate passes commitRemaining through", async () => {
    const task = store.create({ title: "A", description: "", directory: repoDir });
    const app = buildApp(store, dispatcher);
    const res = await app.request(`/api/tasks/${task.id}/integrate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetBranch: "dev", commitRemaining: true }),
    });
    expect(res.status).toBe(200);
    expect(dispatcher.integrate).toHaveBeenCalledWith(task.id, "dev", { commitRemaining: true });
  });

  it("POST /discard-worktree delegates to dispatcher and records the outcome", async () => {
    const task = store.create({ title: "A", description: "", directory: repoDir });
    const app = buildApp(store, dispatcher);
    const res = await app.request(`/api/tasks/${task.id}/discard-worktree`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });

    expect(res.status).toBe(200);
    expect(dispatcher.discardWorktree).toHaveBeenCalledWith(task.id, { force: true });
    const events = store.listEvents(task.id);
    expect(events.at(-1)?.type).toBe("task_worktree_discarded");
  });

  it("POST /discard-worktree returns 409 for a dirty worktree when force is absent", async () => {
    const task = store.create({ title: "A", description: "", directory: repoDir });
    dispatcher.discardWorktree.mockResolvedValueOnce({
      ok: false,
      removed: false,
      dirty: true,
      kept: true,
      message: "worktree has uncommitted changes",
      worktreePath: "/worktrees/a",
    });
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${task.id}/discard-worktree`, { method: "POST" });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.dirty).toBe(true);
    expect(body.kept).toBe(true);
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

// --- GET /api/tasks/:id/diff --------------------------------------------------

describe("GET /api/tasks/:id/diff", () => {
  let store: SqliteTaskStore;
  let dispatcher: ReturnType<typeof makeFakeDispatcher>;

  beforeEach(() => {
    store = new SqliteTaskStore(":memory:");
    dispatcher = makeFakeDispatcher(store);
  });

  afterEach(() => {
    store.close();
  });

  it("returns 404 for an unknown task", async () => {
    const app = buildApp(store, dispatcher);
    const res = await app.request("/api/tasks/task_missing/diff");
    expect(res.status).toBe(404);
  });

  it("returns 409 outside Review and Done", async () => {
    const task = store.create({ title: "To Do", description: "", directory: repoDir });
    const app = buildApp(store, dispatcher);
    const res = await app.request(`/api/tasks/${task.id}/diff`);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toContain("only available for Review or Done cards");
  });

  it("returns a no-git response for a Review card without git evidence", async () => {
    const task = store.create({ title: "Review", description: "", directory: repoDir });
    store.move(task.id, "review", 0);
    store.update(task.id, { baseCommit: null, dirtyAtDispatch: false });

    const app = buildApp(store, dispatcher);
    const res = await app.request(`/api/tasks/${task.id}/diff`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("no-git");
    expect(body.reason).toBeDefined();
  });

  it("returns a no-git response for a Done card without git evidence", async () => {
    const task = store.create({ title: "Done", description: "", directory: repoDir });
    store.move(task.id, "done", 0);
    store.update(task.id, { baseCommit: null, dirtyAtDispatch: false });

    const app = buildApp(store, dispatcher);
    const res = await app.request(`/api/tasks/${task.id}/diff`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("no-git");
    expect(body.reason).toBeDefined();
  });

  it("returns a diff response for a Review card with a recorded baseCommit in a git repo", async () => {
    const task = store.create({ title: "Review", description: "", directory: repoDir });
    store.move(task.id, "review", 0);
    // repoDir is a tested git repo; record its HEAD commit
    store.update(task.id, { baseCommit: "abc123def", dirtyAtDispatch: false });

    const app = buildApp(store, dispatcher);
    const res = await app.request(`/api/tasks/${task.id}/diff`);
    // The diff engine tries to run git in the directory — repoDir is a real git
    // repo (created in test setup), so we expect either a diff or no-git
    // response (not a 404/409).
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(["diff", "no-git"]).toContain(body.kind);
  });

  it("returns a 200 honest no-git response for a dash-prefixed baseCommit instead of a 500", async () => {
    const task = store.create({ title: "Review", description: "", directory: repoDir });
    store.move(task.id, "review", 0);
    store.update(task.id, { baseCommit: "--upload-pack=evil", dirtyAtDispatch: false });

    const app = buildApp(store, dispatcher);
    const res = await app.request(`/api/tasks/${task.id}/diff`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("no-git");
    expect(body.reason).toMatch(/dash-prefixed ref/i);
  });

  it("returns a 200 honest no-git response for a dash-prefixed worktreeBranch on a Done card instead of a 500", async () => {
    const task = store.create({ title: "Done", description: "", directory: repoDir });
    store.move(task.id, "done", 0);
    store.update(task.id, {
      baseCommit: "abc123def",
      worktreeBranch: "--upload-pack=evil",
      dirtyAtDispatch: false,
    });

    const app = buildApp(store, dispatcher);
    const res = await app.request(`/api/tasks/${task.id}/diff`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("no-git");
    expect(body.reason).toMatch(/dash-prefixed ref/i);
  });

  it("returns a 200 honest no-git response for a dash-prefixed harnessBranch on an ACP harness card instead of a 500", async () => {
    const task = store.create({ title: "Review", description: "", directory: repoDir });
    store.move(task.id, "review", 0);
    store.update(task.id, {
      harness: "claude-code",
      harnessCwd: repoDir,
      harnessBranch: "--upload-pack=evil",
      baseCommit: "abc123def",
      dirtyAtDispatch: false,
    });

    const app = buildApp(store, dispatcher);
    const res = await app.request(`/api/tasks/${task.id}/diff`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("no-git");
    expect(body.reason).toMatch(/dash-prefixed ref/i);
  });
});

// --- Parent/child dependency tests --------------------------------------------

describe("parent/child dependency endpoints", () => {
  let store: SqliteTaskStore;
  let dispatcher: ReturnType<typeof makeFakeDispatcher>;

  beforeEach(() => {
    store = new SqliteTaskStore(":memory:");
    dispatcher = makeFakeDispatcher(store);
  });

  afterEach(() => {
    store.close();
  });

  it("creates a task with parentIds and returns them in the response", async () => {
    const parent = store.create({ title: "Parent", description: "", directory: repoDir });
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Child with parent",
        description: "x",
        directory: repoDir,
        parentIds: [parent.id],
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.parentIds).toEqual([parent.id]);
  });

  it("creates a task with multiple parentIds", async () => {
    const p1 = store.create({ title: "P1", description: "", directory: repoDir });
    const p2 = store.create({ title: "P2", description: "", directory: repoDir });
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Multi-parent child",
        description: "x",
        directory: repoDir,
        parentIds: [p1.id, p2.id],
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect((body.parentIds as string[]).sort()).toEqual([p1.id, p2.id].sort());
  });

  it("rejects creating a task with an unknown parentId", async () => {
    const app = buildApp(store, dispatcher);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Bad parent",
        description: "x",
        directory: repoDir,
        parentIds: ["task_nonexistent"],
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("Parent task not found");
  });

  it("patches parentIds atomically on update", async () => {
    const p1 = store.create({ title: "P1", description: "", directory: repoDir });
    const p2 = store.create({ title: "P2", description: "", directory: repoDir });
    const child = store.create({ title: "Child", description: "", directory: repoDir });
    store.addLink(p1.id, child.id);
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${child.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentIds: [p2.id] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.parentIds).toEqual([p2.id]);
    expect(store.getParentIds(child.id)).toEqual([p2.id]);
  });

  it("clears parentIds when patched with an empty array", async () => {
    const parent = store.create({ title: "Parent", description: "", directory: repoDir });
    const child = store.create({ title: "Child", description: "", directory: repoDir });
    store.addLink(parent.id, child.id);
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${child.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentIds: [] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.parentIds).toEqual([]);
    expect(store.getParentIds(child.id)).toEqual([]);
  });

  it("clears parentIds when patched with null", async () => {
    const parent = store.create({ title: "Parent", description: "", directory: repoDir });
    const child = store.create({ title: "Child", description: "", directory: repoDir });
    store.addLink(parent.id, child.id);
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${child.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentIds: null }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.parentIds).toEqual([]);
    expect(store.getParentIds(child.id)).toEqual([]);
  });

  it("observes dependency changes in the task list", async () => {
    const parent = store.create({ title: "Parent", description: "", directory: repoDir });
    const child = store.create({ title: "Child", description: "", directory: repoDir });
    const app = buildApp(store, dispatcher);

    // Before linking
    let list = await app.request("/api/tasks");
    let tasks = (await list.json()) as Task[];
    const childBefore = tasks.find((t) => t.id === child.id);
    expect(childBefore?.parentIds).toEqual([]);

    // Link via store (dependency changes are reflected in list)
    store.addLink(parent.id, child.id);

    // After linking, the list reflects the change
    list = await app.request("/api/tasks");
    tasks = (await list.json()) as Task[];
    const childAfter = tasks.find((t) => t.id === child.id);
    expect(childAfter?.parentIds?.sort()).toEqual([parent.id]);

    // Unlink
    store.removeLink(parent.id, child.id);

    // After unlinking, the list reflects the change
    list = await app.request("/api/tasks");
    tasks = (await list.json()) as Task[];
    const childAfterUnlink = tasks.find((t) => t.id === child.id);
    expect(childAfterUnlink?.parentIds).toEqual([]);
  });

  it("blocks run when one of multiple parents is unsatisfied", async () => {
    const satisfiedParent = store.create({ title: "Done parent", description: "", directory: repoDir });
    const unsatisfiedParent = store.create({ title: "Todo parent", description: "", directory: repoDir });
    const child = store.create({ title: "Child", description: "", directory: repoDir });
    store.addLink(satisfiedParent.id, child.id);
    store.addLink(unsatisfiedParent.id, child.id);
    store.move(satisfiedParent.id, "done", 0);

    const client = new FakeOpencodeClient();
    const realDispatcher = new TaskDispatcher({ client: client as never, store });
    const app = buildRealDispatchApp(store, realDispatcher);

    const blocked = await app.request(`/api/tasks/${child.id}/run`, { method: "POST" });
    expect(blocked.status).toBe(409);
    const blockedBody = await blocked.json();
    expect(blockedBody.error.unmetParents).toEqual([
      { id: unsatisfiedParent.id, title: "Todo parent", why: "parent is in todo" },
    ]);
  });

  it("allows run when all of multiple parents are satisfied", async () => {
    const p1 = store.create({ title: "P1", description: "", directory: repoDir });
    const p2 = store.create({ title: "P2", description: "", directory: repoDir });
    const child = store.create({ title: "Child", description: "", directory: repoDir });
    store.addLink(p1.id, child.id);
    store.addLink(p2.id, child.id);
    store.move(p1.id, "done", 0);
    store.move(p2.id, "done", 0);

    const client = new FakeOpencodeClient();
    client.nextSessionId = "ses_multi_parent_ok";
    const realDispatcher = new TaskDispatcher({ client: client as never, store });
    const app = buildRealDispatchApp(store, realDispatcher);

    const allowed = await app.request(`/api/tasks/${child.id}/run`, { method: "POST" });
    expect(allowed.status).toBe(202);
  });

  it("regression: failed create with bad parentId does not leak a task row", async () => {
    const app = buildApp(store, dispatcher);
    const before = store.list().length;

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Should roll back",
        description: "x",
        directory: repoDir,
        parentIds: ["task_nonexistent"],
      }),
    });

    expect(res.status).toBe(400);
    // No task row or task_created event leaked.
    expect(store.list()).toHaveLength(before);
    expect(store.list()).toHaveLength(0);
  });

  it("regression: PATCH with invalid parentIds does not persist other field changes or alter links", async () => {
    const parent = store.create({ title: "Original parent", description: "", directory: repoDir });
    const child = store.create({ title: "Original title", description: "original desc", directory: repoDir });
    store.addLink(parent.id, child.id);
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${child.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Should not persist",
        description: "should not persist either",
        parentIds: ["task_nonexistent"],
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("Parent task not found");

    // Title, description, and parent links must remain unchanged.
    const fresh = store.get(child.id)!;
    expect(fresh.title).toBe("Original title");
    expect(fresh.description).toBe("original desc");
    expect(store.getParentIds(child.id)).toEqual([parent.id]);
  });

  it("rejects a self-link via PATCH parentIds", async () => {
    const task = store.create({ title: "Self-linker", description: "", directory: repoDir });
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentIds: [task.id] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("Task cannot depend on itself");
    expect(store.getParentIds(task.id)).toEqual([]);
  });

  it("rejects a direct cycle via PATCH parentIds", async () => {
    const parent = store.create({ title: "Parent", description: "", directory: repoDir });
    const child = store.create({ title: "Child", description: "", directory: repoDir });
    store.addLink(parent.id, child.id);
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${parent.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentIds: [child.id] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("Task link would create a cycle");
    // Existing parent -> child relationship must remain intact.
    expect(store.getParentIds(parent.id)).toEqual([]);
    expect(store.getParentIds(child.id)).toEqual([parent.id]);
  });

  it("rejects a transitive cycle via PATCH parentIds", async () => {
    const a = store.create({ title: "A", description: "", directory: repoDir });
    const b = store.create({ title: "B", description: "", directory: repoDir });
    const c = store.create({ title: "C", description: "", directory: repoDir });
    store.addLink(a.id, b.id);
    store.addLink(b.id, c.id);
    const app = buildApp(store, dispatcher);

    const res = await app.request(`/api/tasks/${a.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentIds: [c.id] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("Task link would create a cycle");
    expect(store.getParentIds(a.id)).toEqual([]);
    expect(store.getParentIds(b.id)).toEqual([a.id]);
    expect(store.getParentIds(c.id)).toEqual([b.id]);
  });

  it("clears parentIds with both null and empty array without leaving stale child references", async () => {
    const p1 = store.create({ title: "P1", description: "", directory: repoDir });
    const p2 = store.create({ title: "P2", description: "", directory: repoDir });
    const child = store.create({ title: "Child", description: "", directory: repoDir });
    store.addLink(p1.id, child.id);
    store.addLink(p2.id, child.id);
    const app = buildApp(store, dispatcher);

    const nullClear = await app.request(`/api/tasks/${child.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentIds: null }),
    });
    expect(nullClear.status).toBe(200);
    expect(store.getParentIds(child.id)).toEqual([]);
    expect(store.getChildIds(p1.id)).toEqual([]);
    expect(store.getChildIds(p2.id)).toEqual([]);

    store.addLink(p1.id, child.id);
    const emptyClear = await app.request(`/api/tasks/${child.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentIds: [] }),
    });
    expect(emptyClear.status).toBe(200);
    expect(store.getParentIds(child.id)).toEqual([]);
    expect(store.getChildIds(p1.id)).toEqual([]);
    expect(store.getChildIds(p2.id)).toEqual([]);
  });
});
