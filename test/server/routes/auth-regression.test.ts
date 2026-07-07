/**
 * Auth regression tests — prove every sensitive route category requires the
 * board API token. These tests use createApp() exactly as serve.ts does, with
 * real auth middleware, so a missing or wrong token is always rejected.
 *
 * Route categories tested:
 *  - Task CRUD (create / list / delete / move)
 *  - Task dispatch (run / retry / abort)
 *  - Git operations (init-git / sync / integrate)
 *  - Board routes (list / move card)
 *  - Card actions (prompt / interrupt / diff)
 *  - Archive (list / archive / unarchive)
 *  - Completion (complete / block)
 *  - Task links
 *  - Agent roster
 *  - Board settings
 *  - Terminals (create + WebSocket attach)
 *  - Health (always unauthenticated — sanity only)
 *
 * Every dangerous route is tested for:
 *   1. Missing token → 401
 *   2. Wrong token  → 401
 *   3. Correct token → expected success status
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { WebSocket, WebSocketServer } from "ws";
import { SqliteColumnStore } from "../../../src/db/board-store";
import { SqliteTaskStore } from "../../../src/db/task-store";
import { GlobalArchiveStore } from "../../../src/db/global-archive-store";
import { EventBridge } from "../../../src/server/event-bridge";
import { createApp } from "../../../src/server/app";
import { registerTerminalRoutes } from "../../../src/server/routes/terminals";
import { requireBoardToken } from "../../../src/server/auth";
import { PtyManager, type PtyProcess } from "../../../src/server/terminal/pty-manager";
import { setupTestWorkspace, cleanupTestWorkspace } from "../test-workspace";

const TEST_TOKEN = "test-token-64_______________________________________________";
const WRONG_TOKEN = "wrong-token-64______________________________________________";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_TOKEN}` };
}

function wrongAuthHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${WRONG_TOKEN}` };
}

function jsonHeaders(token?: "correct" | "wrong"): Record<string, string> {
  const base: Record<string, string> = { "content-type": "application/json" };
  if (token === "correct") return { ...base, ...authHeaders() };
  if (token === "wrong") return { ...base, ...wrongAuthHeaders() };
  return base;
}

type OpencodeSessions = ReturnType<typeof makeSession>[];

function makeSession(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    slug: id,
    projectID: "global",
    directory: "/tmp/proj",
    title: `title ${id}`,
    version: "1.17.12",
    time: { created: 1, updated: 2 },
    summary: { additions: 1, deletions: 2, files: 3 },
    cost: 0,
    ...over,
  };
}

interface FakeClient {
  global: { health: () => Promise<{ data: { healthy: boolean; version: string }; error: undefined }> };
  session: {
    list: () => Promise<{ data: OpencodeSessions; error: undefined }>;
    status: () => Promise<{ data: Record<string, unknown>; error: undefined }>;
    get: (params: { sessionID: string }) => Promise<{ data: OpencodeSessions[number] | undefined; error?: { name: string } }>;
    promptAsync: (params: { sessionID: string; parts?: unknown[] }) => Promise<{ data: { ok: boolean }; error: undefined }>;
    abort: (params: { sessionID: string }) => Promise<{ data: boolean; error: undefined }>;
    diff: () => Promise<{ data: unknown[]; error: undefined }>;
  };
  event: { subscribe: () => Promise<{ stream: AsyncGenerator<never> }> };
}

function fakeClient(sessions: OpencodeSessions = []): FakeClient {
  return {
    global: {
      health: async () => ({ data: { healthy: true, version: "1.17.12" }, error: undefined }),
    },
    session: {
      list: async () => ({ data: sessions, error: undefined }),
      status: async () => ({ data: {}, error: undefined }),
      get: async ({ sessionID }: { sessionID: string }) => {
        const s = sessions.find((x) => x.id === sessionID);
        return s ? { data: s, error: undefined } : { data: undefined, error: { name: "NotFoundError" } };
      },
      promptAsync: async () => ({ data: { ok: true }, error: undefined }),
      abort: async () => ({ data: true, error: undefined }),
      diff: async () => ({ data: [], error: undefined }),
    },
    event: { subscribe: async () => ({ stream: (async function* () {})() }) },
  };
}

/**
 * Build the full createApp() with real auth middleware, faked deps, and a repo
 * subdirectory ready for task creation. This matches how serve.ts wires the app.
 */
function makeAuthedApp(sessions: OpencodeSessions = []) {
  const client = fakeClient(sessions) as unknown as Parameters<typeof createApp>[0]["client"];
  const store = new SqliteColumnStore(":memory:");
  const bridge = new EventBridge({ client, store });
  const taskStore = new SqliteTaskStore(":memory:");
  const dispatcher = {
    run: vi.fn(async (taskId: string) => {
      const t = taskStore.get(taskId);
      if (!t) return null;
      return taskStore.update(taskId, { runState: "running", column: "in_progress" }) ?? t;
    }),
    retry: vi.fn(async (taskId: string) => {
      const t = taskStore.get(taskId);
      if (!t) return null;
      return taskStore.update(taskId, { runState: "running" }) ?? t;
    }),
    abort: vi.fn(async (taskId: string) => {
      taskStore.update(taskId, { runState: "idle" });
    }),
    initGitAndRun: vi.fn(async (taskId: string) => {
      const t = taskStore.get(taskId);
      if (!t) return null;
      return taskStore.update(taskId, { runState: "running", pending: undefined }) ?? t;
    }),
    syncUpstream: vi.fn(async (taskId: string) => {
      const t = taskStore.get(taskId);
      return { task: t, ok: true, conflict: false, message: "merged" };
    }),
    integrate: vi.fn(async (taskId: string) => {
      const t = taskStore.get(taskId);
      return { task: t, ok: true, conflict: false, message: "integrated" };
    }),
    removeTask: vi.fn(async (taskId: string) => {
      taskStore.remove(taskId);
      return { ok: true };
    }),
    discardWorktree: vi.fn(async () => ({ ok: true, removed: true, dirty: false, kept: false, message: "discarded" })),
    sweepOrphanedWorktrees: vi.fn(async () => []),
    start: vi.fn(),
    shutdown: vi.fn(),
  } as unknown as Parameters<typeof createApp>[0]["dispatcher"];
  return {
    app: createApp({
      client,
      store,
      bridge,
      taskStore,
      dispatcher,
      opencodeBaseUrl: "http://127.0.0.1:0",
      globalArchiveStore: new GlobalArchiveStore(":memory:"),
      sourceInstance: { port: 0, workspace: "/test", dbPath: ":memory:" },
      boardToken: TEST_TOKEN,
    }),
    store,
    taskStore,
    dispatcher,
  };
}

// ---------------------------------------------------------------------------
// Fake PTY process for terminal auth tests
// ---------------------------------------------------------------------------

class FakePtyProcess implements PtyProcess {
  writes: string[] = [];
  killCount = 0;
  private dataListeners = new Set<(data: string) => void>();
  private exitListeners = new Set<(event: { exitCode: number }) => void>();

  onData(listener: (data: string) => void) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }
  onExit(listener: (event: { exitCode: number }) => void) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }
  write(data: string) { this.writes.push(data); }
  resize() {}
  kill() { this.killCount += 1; }
}

function makeTerminalApp() {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "ocb-auth-term-")));
  const spawn = vi.fn(() => new FakePtyProcess());
  const manager = new PtyManager({
    processEnv: { BOARD_WORKSPACE: workspace } as NodeJS.ProcessEnv,
    loadPtyModule: async () => ({ spawn }),
  });
  const app = new Hono();
  // Mirror the createApp() auth pattern: health is unauthenticated, then
  // all /api/* routes require the board token.
  app.get("/api/health", (c) => c.json({ adapter: "ok", opencode: { status: "ok" } } as never));
  app.use("/api/*", requireBoardToken(TEST_TOKEN));
  registerTerminalRoutes(app, { manager });
  return { app, manager, workspace };
}

// ---------------------------------------------------------------------------
// Auth regression tests
// ---------------------------------------------------------------------------

describe("auth regression — route categories", () => {
  // -- Task CRUD ---------------------------------------------------------------

  describe("POST /api/tasks (create)", () => {
    let ws: ReturnType<typeof setupTestWorkspace>;
    let repoDir: string;

    beforeEach(() => {
      ws = setupTestWorkspace();
      repoDir = ws.repoDir;
    });
    afterEach(() => {
      cleanupTestWorkspace();
    });

    it("rejects with 401 when no token is provided", async () => {
      const { app } = makeAuthedApp();
      const res = await app.request("/api/tasks", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ title: "Test", description: "", directory: repoDir }),
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("unauthorized");
    });

    it("rejects with 401 when the token is wrong", async () => {
      const { app } = makeAuthedApp();
      const res = await app.request("/api/tasks", {
        method: "POST",
        headers: jsonHeaders("wrong"),
        body: JSON.stringify({ title: "Test", description: "", directory: repoDir }),
      });
      expect(res.status).toBe(401);
    });

    it("accepts with 201 when the correct token is provided", async () => {
      const { app } = makeAuthedApp();
      const res = await app.request("/api/tasks", {
        method: "POST",
        headers: jsonHeaders("correct"),
        body: JSON.stringify({ title: "Test", description: "", directory: repoDir }),
      });
      expect(res.status).toBe(201);
    });
  });

  describe("GET /api/tasks (list)", () => {
    it("rejects with 401 when no token is provided", async () => {
      const { app } = makeAuthedApp();
      const res = await app.request("/api/tasks");
      expect(res.status).toBe(401);
    });

    it("rejects with 401 when the token is wrong", async () => {
      const { app } = makeAuthedApp();
      const res = await app.request("/api/tasks", { headers: wrongAuthHeaders() });
      expect(res.status).toBe(401);
    });

    it("returns 200 with the correct token", async () => {
      const { app } = makeAuthedApp();
      const res = await app.request("/api/tasks", { headers: authHeaders() });
      expect(res.status).toBe(200);
    });
  });

  describe("DELETE /api/tasks/:id (remove)", () => {
    let ws: ReturnType<typeof setupTestWorkspace>;
    let repoDir: string;

    beforeEach(() => {
      ws = setupTestWorkspace();
      repoDir = ws.repoDir;
    });
    afterEach(() => {
      cleanupTestWorkspace();
    });

    it("rejects with 401 when no token is provided", async () => {
      const { app, taskStore } = makeAuthedApp();
      const task = taskStore.create({ title: "T", description: "", directory: repoDir });
      const res = await app.request(`/api/tasks/${task.id}`, { method: "DELETE" });
      expect(res.status).toBe(401);
    });

    it("rejects with 401 when the token is wrong", async () => {
      const { app, taskStore } = makeAuthedApp();
      const task = taskStore.create({ title: "T", description: "", directory: repoDir });
      const res = await app.request(`/api/tasks/${task.id}`, {
        method: "DELETE",
        headers: wrongAuthHeaders(),
      });
      expect(res.status).toBe(401);
    });

    it("returns 200 with the correct token", async () => {
      const { app, taskStore } = makeAuthedApp();
      const task = taskStore.create({ title: "T", description: "", directory: repoDir });
      const res = await app.request(`/api/tasks/${task.id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
    });
  });

  describe("POST /api/tasks/:id/move", () => {
    let ws: ReturnType<typeof setupTestWorkspace>;
    let repoDir: string;

    beforeEach(() => {
      ws = setupTestWorkspace();
      repoDir = ws.repoDir;
    });
    afterEach(() => {
      cleanupTestWorkspace();
    });

    it("rejects with 401 when no token is provided", async () => {
      const { app, taskStore } = makeAuthedApp();
      const task = taskStore.create({ title: "T", description: "", directory: repoDir });
      const res = await app.request(`/api/tasks/${task.id}/move`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ column: "in_progress", position: 0 }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects with 401 when the token is wrong", async () => {
      const { app, taskStore } = makeAuthedApp();
      const task = taskStore.create({ title: "T", description: "", directory: repoDir });
      const res = await app.request(`/api/tasks/${task.id}/move`, {
        method: "POST",
        headers: jsonHeaders("wrong"),
        body: JSON.stringify({ column: "in_progress", position: 0 }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 200 with the correct token", async () => {
      const { app, taskStore } = makeAuthedApp();
      const task = taskStore.create({ title: "T", description: "", directory: repoDir });
      const res = await app.request(`/api/tasks/${task.id}/move`, {
        method: "POST",
        headers: jsonHeaders("correct"),
        body: JSON.stringify({ column: "in_progress", position: 0 }),
      });
      expect(res.status).toBe(200);
    });
  });

  // -- Task dispatch (run / retry / abort) ------------------------------------

  describe("POST /api/tasks/:id/run", () => {
    let ws: ReturnType<typeof setupTestWorkspace>;
    let repoDir: string;

    beforeEach(() => {
      ws = setupTestWorkspace();
      repoDir = ws.repoDir;
    });
    afterEach(() => {
      cleanupTestWorkspace();
    });

    it("rejects with 401 when no token is provided", async () => {
      const { app, taskStore } = makeAuthedApp();
      const task = taskStore.create({ title: "T", description: "", directory: repoDir });
      const res = await app.request(`/api/tasks/${task.id}/run`, { method: "POST" });
      expect(res.status).toBe(401);
    });

    it("rejects with 401 when the token is wrong", async () => {
      const { app, taskStore } = makeAuthedApp();
      const task = taskStore.create({ title: "T", description: "", directory: repoDir });
      const res = await app.request(`/api/tasks/${task.id}/run`, {
        method: "POST",
        headers: wrongAuthHeaders(),
      });
      expect(res.status).toBe(401);
    });

    it("returns 202 with the correct token", async () => {
      const { app, taskStore, dispatcher } = makeAuthedApp();
      const task = taskStore.create({ title: "T", description: "", directory: repoDir });
      const res = await app.request(`/api/tasks/${task.id}/run`, {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(202);
      expect(dispatcher.run).toHaveBeenCalledWith(task.id);
    });
  });

  describe("POST /api/tasks/:id/retry", () => {
    let ws: ReturnType<typeof setupTestWorkspace>;
    let repoDir: string;

    beforeEach(() => {
      ws = setupTestWorkspace();
      repoDir = ws.repoDir;
    });
    afterEach(() => {
      cleanupTestWorkspace();
    });

    it("rejects with 401 when no token is provided", async () => {
      const { app, taskStore } = makeAuthedApp();
      const task = taskStore.create({ title: "T", description: "", directory: repoDir });
      const res = await app.request(`/api/tasks/${task.id}/retry`, { method: "POST" });
      expect(res.status).toBe(401);
    });

    it("rejects with 401 when the token is wrong", async () => {
      const { app, taskStore } = makeAuthedApp();
      const task = taskStore.create({ title: "T", description: "", directory: repoDir });
      const res = await app.request(`/api/tasks/${task.id}/retry`, {
        method: "POST",
        headers: wrongAuthHeaders(),
      });
      expect(res.status).toBe(401);
    });

    it("returns 202 with the correct token", async () => {
      const { app, taskStore, dispatcher } = makeAuthedApp();
      const task = taskStore.create({ title: "T", description: "", directory: repoDir });
      const res = await app.request(`/api/tasks/${task.id}/retry`, {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(202);
      expect(dispatcher.retry).toHaveBeenCalledWith(task.id, undefined);
    });
  });

  describe("POST /api/tasks/:id/abort", () => {
    let ws: ReturnType<typeof setupTestWorkspace>;
    let repoDir: string;

    beforeEach(() => {
      ws = setupTestWorkspace();
      repoDir = ws.repoDir;
    });
    afterEach(() => {
      cleanupTestWorkspace();
    });

    it("rejects with 401 when no token is provided", async () => {
      const { app, taskStore } = makeAuthedApp();
      const task = taskStore.create({ title: "T", description: "", directory: repoDir });
      const res = await app.request(`/api/tasks/${task.id}/abort`, { method: "POST" });
      expect(res.status).toBe(401);
    });

    it("rejects with 401 when the token is wrong", async () => {
      const { app, taskStore } = makeAuthedApp();
      const task = taskStore.create({ title: "T", description: "", directory: repoDir });
      const res = await app.request(`/api/tasks/${task.id}/abort`, {
        method: "POST",
        headers: wrongAuthHeaders(),
      });
      expect(res.status).toBe(401);
    });

    it("returns 200 with the correct token", async () => {
      const { app, taskStore, dispatcher } = makeAuthedApp();
      const task = taskStore.create({ title: "T", description: "", directory: repoDir });
      const res = await app.request(`/api/tasks/${task.id}/abort`, {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      expect(dispatcher.abort).toHaveBeenCalledWith(task.id);
    });
  });

  // -- Git operations (init-git / sync / integrate) ----------------------------

  describe("POST /api/tasks/:id/init-git", () => {
    let ws: ReturnType<typeof setupTestWorkspace>;
    let repoDir: string;

    beforeEach(() => {
      ws = setupTestWorkspace();
      repoDir = ws.repoDir;
    });
    afterEach(() => {
      cleanupTestWorkspace();
    });

    it("rejects with 401 when no token is provided", async () => {
      const { app, taskStore } = makeAuthedApp();
      const task = taskStore.create({ title: "T", description: "", directory: repoDir });
      const res = await app.request(`/api/tasks/${task.id}/init-git`, { method: "POST" });
      expect(res.status).toBe(401);
    });

    it("rejects with 401 when the token is wrong", async () => {
      const { app, taskStore } = makeAuthedApp();
      const task = taskStore.create({ title: "T", description: "", directory: repoDir });
      const res = await app.request(`/api/tasks/${task.id}/init-git`, {
        method: "POST",
        headers: wrongAuthHeaders(),
      });
      expect(res.status).toBe(401);
    });

    it("returns 202 with the correct token", async () => {
      const { app, taskStore, dispatcher } = makeAuthedApp();
      const task = taskStore.create({ title: "T", description: "", directory: repoDir });
      const res = await app.request(`/api/tasks/${task.id}/init-git`, {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(202);
      expect(dispatcher.initGitAndRun).toHaveBeenCalledWith(task.id);
    });
  });

  describe("POST /api/tasks/:id/sync", () => {
    let ws: ReturnType<typeof setupTestWorkspace>;
    let repoDir: string;

    beforeEach(() => {
      ws = setupTestWorkspace();
      repoDir = ws.repoDir;
    });
    afterEach(() => {
      cleanupTestWorkspace();
    });

    it("rejects with 401 when no token is provided", async () => {
      const { app, taskStore } = makeAuthedApp();
      const task = taskStore.create({ title: "T", description: "", directory: repoDir });
      const res = await app.request(`/api/tasks/${task.id}/sync`, { method: "POST" });
      expect(res.status).toBe(401);
    });

    it("rejects with 401 when the token is wrong", async () => {
      const { app, taskStore } = makeAuthedApp();
      const task = taskStore.create({ title: "T", description: "", directory: repoDir });
      const res = await app.request(`/api/tasks/${task.id}/sync`, {
        method: "POST",
        headers: wrongAuthHeaders(),
      });
      expect(res.status).toBe(401);
    });

    it("returns 200 with the correct token", async () => {
      const { app, taskStore, dispatcher } = makeAuthedApp();
      const task = taskStore.create({ title: "T", description: "", directory: repoDir });
      const res = await app.request(`/api/tasks/${task.id}/sync`, {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      expect(dispatcher.syncUpstream).toHaveBeenCalledWith(task.id);
    });
  });

  describe("POST /api/tasks/:id/integrate", () => {
    let ws: ReturnType<typeof setupTestWorkspace>;
    let repoDir: string;

    beforeEach(() => {
      ws = setupTestWorkspace();
      repoDir = ws.repoDir;
    });
    afterEach(() => {
      cleanupTestWorkspace();
    });

    it("rejects with 401 when no token is provided", async () => {
      const { app, taskStore } = makeAuthedApp();
      const task = taskStore.create({ title: "T", description: "", directory: repoDir });
      const res = await app.request(`/api/tasks/${task.id}/integrate`, { method: "POST" });
      expect(res.status).toBe(401);
    });

    it("rejects with 401 when the token is wrong", async () => {
      const { app, taskStore } = makeAuthedApp();
      const task = taskStore.create({ title: "T", description: "", directory: repoDir });
      const res = await app.request(`/api/tasks/${task.id}/integrate`, {
        method: "POST",
        headers: wrongAuthHeaders(),
      });
      expect(res.status).toBe(401);
    });

    it("returns 200 with the correct token", async () => {
      const { app, taskStore, dispatcher } = makeAuthedApp();
      const task = taskStore.create({ title: "T", description: "", directory: repoDir });
      const res = await app.request(`/api/tasks/${task.id}/integrate`, {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      expect(dispatcher.integrate).toHaveBeenCalledWith(task.id, undefined, { commitRemaining: false });
    });
  });

  // -- Board routes ------------------------------------------------------------

  describe("GET /api/board", () => {
    it("rejects with 401 when no token is provided", async () => {
      const { app } = makeAuthedApp([makeSession("ses_1")]);
      const res = await app.request("/api/board");
      expect(res.status).toBe(401);
    });

    it("rejects with 401 when the token is wrong", async () => {
      const { app } = makeAuthedApp([makeSession("ses_1")]);
      const res = await app.request("/api/board", { headers: wrongAuthHeaders() });
      expect(res.status).toBe(401);
    });

    it("returns 200 with the correct token", async () => {
      const { app } = makeAuthedApp([makeSession("ses_1")]);
      const res = await app.request("/api/board", { headers: authHeaders() });
      expect(res.status).toBe(200);
    });
  });

  describe("POST /api/board/cards/:id/move", () => {
    it("rejects with 401 when no token is provided", async () => {
      const { app } = makeAuthedApp([makeSession("ses_1")]);
      await app.request("/api/board", { headers: authHeaders() }); // seed
      const res = await app.request("/api/board/cards/ses_1/move", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ column: "review", position: 0 }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects with 401 when the token is wrong", async () => {
      const { app } = makeAuthedApp([makeSession("ses_1")]);
      await app.request("/api/board", { headers: authHeaders() }); // seed
      const res = await app.request("/api/board/cards/ses_1/move", {
        method: "POST",
        headers: jsonHeaders("wrong"),
        body: JSON.stringify({ column: "review", position: 0 }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 200 with the correct token", async () => {
      const { app } = makeAuthedApp([makeSession("ses_1")]);
      await app.request("/api/board", { headers: authHeaders() }); // seed
      const res = await app.request("/api/board/cards/ses_1/move", {
        method: "POST",
        headers: jsonHeaders("correct"),
        body: JSON.stringify({ column: "review", position: 0 }),
      });
      expect(res.status).toBe(200);
    });
  });

  // -- Card actions ------------------------------------------------------------

  describe("POST /api/board/cards/:id/prompt", () => {
    it("rejects with 401 when no token is provided", async () => {
      const { app } = makeAuthedApp([makeSession("ses_1")]);
      const res = await app.request("/api/board/cards/ses_1/prompt", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ text: "hello" }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects with 401 when the token is wrong", async () => {
      const { app } = makeAuthedApp([makeSession("ses_1")]);
      const res = await app.request("/api/board/cards/ses_1/prompt", {
        method: "POST",
        headers: jsonHeaders("wrong"),
        body: JSON.stringify({ text: "hello" }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 202 with the correct token", async () => {
      const { app } = makeAuthedApp([makeSession("ses_1")]);
      const res = await app.request("/api/board/cards/ses_1/prompt", {
        method: "POST",
        headers: jsonHeaders("correct"),
        body: JSON.stringify({ text: "hello" }),
      });
      expect(res.status).toBe(202);
    });
  });

  describe("POST /api/board/cards/:id/interrupt", () => {
    it("rejects with 401 when no token is provided", async () => {
      const { app } = makeAuthedApp([makeSession("ses_1")]);
      const res = await app.request("/api/board/cards/ses_1/interrupt", { method: "POST" });
      expect(res.status).toBe(401);
    });

    it("rejects with 401 when the token is wrong", async () => {
      const { app } = makeAuthedApp([makeSession("ses_1")]);
      const res = await app.request("/api/board/cards/ses_1/interrupt", {
        method: "POST",
        headers: wrongAuthHeaders(),
      });
      expect(res.status).toBe(401);
    });

    it("returns 200 with the correct token", async () => {
      const { app } = makeAuthedApp([makeSession("ses_1")]);
      const res = await app.request("/api/board/cards/ses_1/interrupt", {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
    });
  });

  describe("GET /api/board/cards/:id/diff", () => {
    it("rejects with 401 when no token is provided", async () => {
      const { app } = makeAuthedApp([makeSession("ses_1")]);
      const res = await app.request("/api/board/cards/ses_1/diff");
      expect(res.status).toBe(401);
    });

    it("rejects with 401 when the token is wrong", async () => {
      const { app } = makeAuthedApp([makeSession("ses_1")]);
      const res = await app.request("/api/board/cards/ses_1/diff", { headers: wrongAuthHeaders() });
      expect(res.status).toBe(401);
    });

    it("returns 200 with the correct token", async () => {
      const { app } = makeAuthedApp([makeSession("ses_1")]);
      const res = await app.request("/api/board/cards/ses_1/diff", { headers: authHeaders() });
      expect(res.status).toBe(200);
    });
  });

  // -- Board events (SSE) -----------------------------------------------------

  describe("GET /api/board/events (SSE)", () => {
    it("rejects with 401 when no token is provided", async () => {
      const { app } = makeAuthedApp();
      const res = await app.request("/api/board/events");
      expect(res.status).toBe(401);
    });

    it("rejects with 401 when the token is wrong", async () => {
      const { app } = makeAuthedApp();
      const res = await app.request("/api/board/events", { headers: wrongAuthHeaders() });
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/tasks/events (SSE)", () => {
    it("rejects with 401 when no token is provided", async () => {
      const { app } = makeAuthedApp();
      const res = await app.request("/api/tasks/events");
      expect(res.status).toBe(401);
    });

    it("rejects with 401 when the token is wrong", async () => {
      const { app } = makeAuthedApp();
      const res = await app.request("/api/tasks/events", { headers: wrongAuthHeaders() });
      expect(res.status).toBe(401);
    });
  });

  // -- Archive routes ----------------------------------------------------------

  describe("archive routes", () => {
    let ws: ReturnType<typeof setupTestWorkspace>;
    let repoDir: string;

    beforeEach(() => {
      ws = setupTestWorkspace();
      repoDir = ws.repoDir;
    });
    afterEach(() => {
      cleanupTestWorkspace();
    });

    describe("GET /api/archive (list)", () => {
      it("rejects with 401 when no token is provided", async () => {
        const { app } = makeAuthedApp();
        const res = await app.request("/api/archive");
        expect(res.status).toBe(401);
      });

      it("rejects with 401 when the token is wrong", async () => {
        const { app } = makeAuthedApp();
        const res = await app.request("/api/archive", { headers: wrongAuthHeaders() });
        expect(res.status).toBe(401);
      });

      it("returns 200 with the correct token", async () => {
        const { app } = makeAuthedApp();
        const res = await app.request("/api/archive", { headers: authHeaders() });
        expect(res.status).toBe(200);
      });
    });

    describe("POST /api/tasks/:id/archive", () => {
      it("rejects with 401 when no token is provided", async () => {
        const { app, taskStore } = makeAuthedApp();
        const task = taskStore.create({ title: "T", description: "", directory: repoDir });
        taskStore.move(task.id, "review", 0);
        const res = await app.request(`/api/tasks/${task.id}/archive`, { method: "POST" });
        expect(res.status).toBe(401);
      });

      it("rejects with 401 when the token is wrong", async () => {
        const { app, taskStore } = makeAuthedApp();
        const task = taskStore.create({ title: "T", description: "", directory: repoDir });
        taskStore.move(task.id, "review", 0);
        const res = await app.request(`/api/tasks/${task.id}/archive`, {
          method: "POST",
          headers: wrongAuthHeaders(),
        });
        expect(res.status).toBe(401);
      });

      it("returns 200 with the correct token", async () => {
        const { app, taskStore } = makeAuthedApp();
        const task = taskStore.create({ title: "T", description: "", directory: repoDir });
        taskStore.move(task.id, "review", 0);
        const res = await app.request(`/api/tasks/${task.id}/archive`, {
          method: "POST",
          headers: authHeaders(),
        });
        expect(res.status).toBe(200);
      });
    });

    describe("POST /api/tasks/:id/unarchive", () => {
      it("rejects with 401 when no token is provided", async () => {
        const { app, taskStore } = makeAuthedApp();
        const task = taskStore.create({ title: "T", description: "", directory: repoDir });
        const res = await app.request(`/api/tasks/${task.id}/unarchive`, { method: "POST" });
        expect(res.status).toBe(401);
      });

      it("rejects with 401 when the token is wrong", async () => {
        const { app, taskStore } = makeAuthedApp();
        const task = taskStore.create({ title: "T", description: "", directory: repoDir });
        const res = await app.request(`/api/tasks/${task.id}/unarchive`, {
          method: "POST",
          headers: wrongAuthHeaders(),
        });
        expect(res.status).toBe(401);
      });

      it("returns 200 with the correct token", async () => {
        const { app, taskStore } = makeAuthedApp();
        const task = taskStore.create({ title: "T", description: "", directory: repoDir });
        taskStore.move(task.id, "done", 0);
        taskStore.setArchived(task.id, true);
        const res = await app.request(`/api/tasks/${task.id}/unarchive`, {
          method: "POST",
          headers: authHeaders(),
        });
        expect(res.status).toBe(200);
      });
    });
  });

  // -- Completion routes -------------------------------------------------------

  describe("completion routes", () => {
    let ws: ReturnType<typeof setupTestWorkspace>;
    let repoDir: string;

    beforeEach(() => {
      ws = setupTestWorkspace();
      repoDir = ws.repoDir;
    });
    afterEach(() => {
      cleanupTestWorkspace();
    });

    describe("POST /api/tasks/:id/complete", () => {
      it("rejects with 401 when no token is provided", async () => {
        const { app, taskStore } = makeAuthedApp();
        const task = taskStore.create({ title: "T", description: "", directory: repoDir });
        const res = await app.request(`/api/tasks/${task.id}/complete`, {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({ summary: "ok", changedFiles: [], verification: [], residualRisk: "none" }),
        });
        expect(res.status).toBe(401);
      });

      it("rejects with 401 when the token is wrong", async () => {
        const { app, taskStore } = makeAuthedApp();
        const task = taskStore.create({ title: "T", description: "", directory: repoDir });
        const res = await app.request(`/api/tasks/${task.id}/complete`, {
          method: "POST",
          headers: jsonHeaders("wrong"),
          body: JSON.stringify({ summary: "ok", changedFiles: [], verification: [], residualRisk: "none" }),
        });
        expect(res.status).toBe(401);
      });

      it("accepts with the correct token (200 or 202 depending on state)", async () => {
        const { app, taskStore } = makeAuthedApp();
        const task = taskStore.create({ title: "T", description: "", directory: repoDir });
        // complete on an unstarted task returns 409 but it's NOT an auth reject
        const res = await app.request(`/api/tasks/${task.id}/complete`, {
          method: "POST",
          headers: jsonHeaders("correct"),
          body: JSON.stringify({ summary: "ok", changedFiles: [], verification: [], residualRisk: "none" }),
        });
        // 409 is a validation error (state mismatch), not auth — proves auth passed
        expect(res.status).toBe(409);
      });
    });

    describe("POST /api/tasks/:id/block", () => {
      it("rejects with 401 when no token is provided", async () => {
        const { app, taskStore } = makeAuthedApp();
        const task = taskStore.create({ title: "T", description: "", directory: repoDir });
        const res = await app.request(`/api/tasks/${task.id}/block`, {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({ summary: "blocked", changedFiles: [], verification: [], residualRisk: "blocked" }),
        });
        expect(res.status).toBe(401);
      });

      it("rejects with 401 when the token is wrong", async () => {
        const { app, taskStore } = makeAuthedApp();
        const task = taskStore.create({ title: "T", description: "", directory: repoDir });
        const res = await app.request(`/api/tasks/${task.id}/block`, {
          method: "POST",
          headers: jsonHeaders("wrong"),
          body: JSON.stringify({ summary: "blocked", changedFiles: [], verification: [], residualRisk: "blocked" }),
        });
        expect(res.status).toBe(401);
      });

      it("accepts with the correct token (non-401 response)", async () => {
        const { app, taskStore } = makeAuthedApp();
        const task = taskStore.create({ title: "T", description: "", directory: repoDir });
        const res = await app.request(`/api/tasks/${task.id}/block`, {
          method: "POST",
          headers: jsonHeaders("correct"),
          body: JSON.stringify({ summary: "blocked", changedFiles: [], verification: [], residualRisk: "blocked" }),
        });
        // 409 is a validation error (state mismatch), not auth
        expect(res.status).toBe(409);
      });
    });
  });

  // -- Task links --------------------------------------------------------------

  describe("task link routes", () => {
    let ws: ReturnType<typeof setupTestWorkspace>;
    let repoDir: string;

    beforeEach(() => {
      ws = setupTestWorkspace();
      repoDir = ws.repoDir;
    });
    afterEach(() => {
      cleanupTestWorkspace();
    });

    describe("POST /api/tasks/:id/links", () => {
      it("rejects with 401 when no token is provided", async () => {
        const { app, taskStore } = makeAuthedApp();
        const task = taskStore.create({ title: "T", description: "", directory: repoDir });
        const res = await app.request(`/api/tasks/${task.id}/links`, {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({ parentId: "some-parent" }),
        });
        expect(res.status).toBe(401);
      });

      it("rejects with 401 when the token is wrong", async () => {
        const { app, taskStore } = makeAuthedApp();
        const task = taskStore.create({ title: "T", description: "", directory: repoDir });
        const res = await app.request(`/api/tasks/${task.id}/links`, {
          method: "POST",
          headers: jsonHeaders("wrong"),
          body: JSON.stringify({ parentId: "some-parent" }),
        });
        expect(res.status).toBe(401);
      });

      it("returns 200 with the correct token", async () => {
        const { app, taskStore } = makeAuthedApp();
        const parent = taskStore.create({ title: "P", description: "", directory: repoDir });
        const child = taskStore.create({ title: "C", description: "", directory: repoDir });
        const res = await app.request(`/api/tasks/${child.id}/links`, {
          method: "POST",
          headers: jsonHeaders("correct"),
          body: JSON.stringify({ parentId: parent.id }),
        });
        expect(res.status).toBe(200);
      });
    });

    describe("DELETE /api/tasks/:id/links/:parentId", () => {
      it("rejects with 401 when no token is provided", async () => {
        const { app, taskStore } = makeAuthedApp();
        const task = taskStore.create({ title: "T", description: "", directory: repoDir });
        const res = await app.request(`/api/tasks/${task.id}/links/parent`, { method: "DELETE" });
        expect(res.status).toBe(401);
      });

      it("rejects with 401 when the token is wrong", async () => {
        const { app, taskStore } = makeAuthedApp();
        const task = taskStore.create({ title: "T", description: "", directory: repoDir });
        const res = await app.request(`/api/tasks/${task.id}/links/parent`, {
          method: "DELETE",
          headers: wrongAuthHeaders(),
        });
        expect(res.status).toBe(401);
      });

      it("returns 200 with the correct token", async () => {
        const { app, taskStore } = makeAuthedApp();
        const parent = taskStore.create({ title: "P", description: "", directory: repoDir });
        const child = taskStore.create({ title: "C", description: "", directory: repoDir });
        taskStore.addLink(parent.id, child.id);
        const res = await app.request(`/api/tasks/${child.id}/links/${parent.id}`, {
          method: "DELETE",
          headers: authHeaders(),
        });
        expect(res.status).toBe(200);
      });
    });
  });

  // -- Agent roster ------------------------------------------------------------

  describe("GET /api/agents", () => {
    it("rejects with 401 when no token is provided", async () => {
      const { app } = makeAuthedApp();
      const res = await app.request("/api/agents");
      expect(res.status).toBe(401);
    });

    it("rejects with 401 when the token is wrong", async () => {
      const { app } = makeAuthedApp();
      const res = await app.request("/api/agents", { headers: wrongAuthHeaders() });
      expect(res.status).toBe(401);
    });
  });

  // -- Board settings ----------------------------------------------------------

  describe("board settings routes", () => {
    describe("GET /api/settings", () => {
      it("rejects with 401 when no token is provided", async () => {
        const { app } = makeAuthedApp();
        const res = await app.request("/api/settings");
        expect(res.status).toBe(401);
      });

      it("rejects with 401 when the token is wrong", async () => {
        const { app } = makeAuthedApp();
        const res = await app.request("/api/settings", { headers: wrongAuthHeaders() });
        expect(res.status).toBe(401);
      });

      it("returns 200 with the correct token", async () => {
        const { app } = makeAuthedApp();
        const res = await app.request("/api/settings", { headers: authHeaders() });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ worktreeDefault: false });
      });
    });

    describe("PUT /api/settings", () => {
      it("rejects with 401 when no token is provided", async () => {
        const { app } = makeAuthedApp();
        const res = await app.request("/api/settings", {
          method: "PUT",
          headers: jsonHeaders(),
          body: JSON.stringify({ worktreeDefault: true }),
        });
        expect(res.status).toBe(401);
      });

      it("rejects with 401 when the token is wrong", async () => {
        const { app } = makeAuthedApp();
        const res = await app.request("/api/settings", {
          method: "PUT",
          headers: jsonHeaders("wrong"),
          body: JSON.stringify({ worktreeDefault: true }),
        });
        expect(res.status).toBe(401);
      });

      it("returns 200 with the correct token", async () => {
        const { app } = makeAuthedApp();
        const res = await app.request("/api/settings", {
          method: "PUT",
          headers: jsonHeaders("correct"),
          body: JSON.stringify({ worktreeDefault: true }),
        });
        expect(res.status).toBe(200);
      });
    });
  });

  // -- Terminal routes (board token + local-only + reservation token) ----------

  describe("terminal routes", () => {
    const dirs: string[] = [];

    afterEach(() => {
      while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
    });

    afterAll(() => {
      vi.restoreAllMocks();
    });

    it("POST /api/terminals rejects with 401 when board token is missing", async () => {
      const { app, workspace } = makeTerminalApp();
      dirs.push(workspace);
      const res = await app.request("/api/terminals", {
        method: "POST",
        headers: { host: "127.0.0.1:4097", origin: "http://localhost:5173", "content-type": "application/json" },
        body: JSON.stringify({ cwd: workspace }),
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("unauthorized");
    });

    it("POST /api/terminals rejects with 401 when board token is wrong", async () => {
      const { app, workspace } = makeTerminalApp();
      dirs.push(workspace);
      const res = await app.request("/api/terminals", {
        method: "POST",
        headers: {
          host: "127.0.0.1:4097",
          origin: "http://localhost:5173",
          "content-type": "application/json",
          Authorization: `Bearer ${WRONG_TOKEN}`,
        },
        body: JSON.stringify({ cwd: workspace }),
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("unauthorized");
    });

    it("POST /api/terminals accepts with correct board token + local origin", async () => {
      const { app, workspace } = makeTerminalApp();
      dirs.push(workspace);
      const res = await app.request("/api/terminals", {
        method: "POST",
        headers: {
          host: "127.0.0.1:4097",
          origin: "http://localhost:5173",
          "content-type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({ cwd: workspace }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toMatchObject({ cwd: workspace, id: expect.any(String), token: expect.any(String) });
    });

    it("WebSocket attach rejects with 401 when board token query param is missing", async () => {
      const { app, workspace, manager } = makeTerminalApp();
      dirs.push(workspace);

      // Create a reservation first (needs correct board token)
      const reserveRes = await app.request("/api/terminals", {
        method: "POST",
        headers: {
          host: "127.0.0.1:4097",
          origin: "http://localhost:5173",
          "content-type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({ cwd: workspace }),
      });
      const reservation = (await reserveRes.json()) as { id: string; token: string };

      // Now try WebSocket without board token (no ?board_token= query param)
      const wss = new WebSocketServer({ noServer: true });
      let port = 0;
      const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
        const listening = serve(
          { fetch: app.fetch, port: 0, hostname: "127.0.0.1", websocket: { server: wss } },
          (info) => {
            port = info.port;
            resolve(listening);
          },
        );
      });

      try {
        const noBoardTokenSocket = new WebSocket(
          `ws://127.0.0.1:${port}/api/terminals/${reservation.id}/socket?token=${reservation.token}`,
          { headers: { Origin: "http://localhost:5173" } },
        );
        await expect(
          new Promise((resolve) => {
            noBoardTokenSocket.once("unexpected-response", (_req, response) => resolve(response.statusCode));
          }),
        ).resolves.toBe(401);
      } finally {
        manager.cleanupReservations();
        manager.killAll();
        server.close();
      }
    });

    it("WebSocket attach accepts with board token query param + reservation token + local origin", async () => {
      const { app, workspace, manager } = makeTerminalApp();
      dirs.push(workspace);

      const reserveRes = await app.request("/api/terminals", {
        method: "POST",
        headers: {
          host: "127.0.0.1:4097",
          origin: "http://localhost:5173",
          "content-type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({ cwd: workspace }),
      });
      const reservation = (await reserveRes.json()) as { id: string; token: string };

      const wss = new WebSocketServer({ noServer: true });
      let port = 0;
      const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
        const listening = serve(
          { fetch: app.fetch, port: 0, hostname: "127.0.0.1", websocket: { server: wss } },
          (info) => {
            port = info.port;
            resolve(listening);
          },
        );
      });

      try {
        const ws = await new Promise<WebSocket>((resolve, reject) => {
          const socket = new WebSocket(
            `ws://127.0.0.1:${port}/api/terminals/${reservation.id}/socket?token=${reservation.token}&board_token=${TEST_TOKEN}`,
            { headers: { Origin: "http://localhost:5173" } },
          );
          socket.once("open", () => resolve(socket));
          socket.once("error", reject);
        });
        ws.close();
      } finally {
        manager.cleanupReservations();
        manager.killAll();
        server.close();
      }
    });

    it("WebSocket attach rejects with 401 when board token query param is wrong", async () => {
      const { app, workspace, manager } = makeTerminalApp();
      dirs.push(workspace);

      const reserveRes = await app.request("/api/terminals", {
        method: "POST",
        headers: {
          host: "127.0.0.1:4097",
          origin: "http://localhost:5173",
          "content-type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({ cwd: workspace }),
      });
      const reservation = (await reserveRes.json()) as { id: string; token: string };

      const wss = new WebSocketServer({ noServer: true });
      let port = 0;
      const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
        const listening = serve(
          { fetch: app.fetch, port: 0, hostname: "127.0.0.1", websocket: { server: wss } },
          (info) => {
            port = info.port;
            resolve(listening);
          },
        );
      });

      try {
        const wrongTokenSocket = new WebSocket(
          `ws://127.0.0.1:${port}/api/terminals/${reservation.id}/socket?token=${reservation.token}&board_token=${WRONG_TOKEN}`,
          { headers: { Origin: "http://localhost:5173" } },
        );
        await expect(
          new Promise((resolve) => {
            wrongTokenSocket.once("unexpected-response", (_req, response) => resolve(response.statusCode));
          }),
        ).resolves.toBe(401);
      } finally {
        manager.cleanupReservations();
        manager.killAll();
        server.close();
      }
    });
  });

  // -- Health is still unauthenticated (sanity check) --------------------------

  describe("GET /api/health (still unauthenticated)", () => {
    it("returns 200 without a token", async () => {
      const { app } = makeAuthedApp();
      const res = await app.request("/api/health");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.adapter).toBe("ok");
    });

    it("returns 200 even with a wrong token", async () => {
      const { app } = makeAuthedApp();
      const res = await app.request("/api/health", { headers: wrongAuthHeaders() });
      expect(res.status).toBe(200);
    });
  });
});

// ---------------------------------------------------------------------------
// Workspace boundary regression — git operations are gated on workspace
// containment even when auth passes.
// ---------------------------------------------------------------------------

describe("workspace boundary for git operations", () => {
  let workspaceDir: string;

  beforeEach(() => {
    const ws = setupTestWorkspace();
    workspaceDir = ws.workspace;
  });
  afterEach(() => {
    cleanupTestWorkspace();
  });

  it("POST /api/tasks rejects a directory outside the workspace", async () => {
    const { app } = makeAuthedApp();
    const outside = join(workspaceDir, "..", "outside-task");
    mkdirSync(outside, { recursive: true });
    dirsToClean.push(outside);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: jsonHeaders("correct"),
      body: JSON.stringify({ title: "Escape", description: "x", directory: outside }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation");
    expect(body.error.message).toContain("outside the board workspace");
  });
});

// Track dirs that need cleanup
const dirsToClean: string[] = [];
afterAll(() => {
  for (const dir of dirsToClean) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
