import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Event as OpencodeEvent } from "@opencode-ai/sdk/v2/types";
import type { Task, TaskKind } from "../../src/shared";
import { SqliteTaskStore } from "../../src/db/task-store";
import { TaskDispatcher } from "../../src/server/dispatcher";
import { SessionActivityCollector } from "../../src/server/session-activity";
import type { SessionActivityFrame } from "../../src/shared";
import type { ClaudeCodeRunnerLike } from "../../src/server/claude-code-runner";
import { cleanupTestWorkspace, setupTestWorkspace } from "./test-workspace";

async function* makeAsyncGenerator<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

/**
 * A copy of the process env with all `GIT_*` vars stripped. Git exports
 * `GIT_DIR`/`GIT_INDEX_FILE` (relative paths) into hook environments, so under a
 * pre-commit hook an inherited-env `git` call in a temp repo would resolve those
 * against the wrong repo and fail with `.git/index: ... Not a directory`.
 */
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  return env;
}

/** Init a real git repo with one commit, so worktree isolation (`isGitRepo`) is satisfied. */
function makeGitRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  const run = (args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      env: {
        ...env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@localhost",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@localhost",
      },
    });
  run(["init", "-b", "main"]);
  writeFileSync(join(root, "file.txt"), "base\n");
  run(["add", "-A"]);
  run(["commit", "--no-gpg-sign", "-m", "base"]);
}

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("waitFor timed out"));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

function deferred<T = unknown>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * Fake OpenCode client. `session.create` returns a fixed fresh session id (or a
 * queued override), `promptAsync`/`abort` are spies, and `event.subscribe()` yields
 * a scripted async generator per call so tests can control what each "connection"
 * (including reconnects) delivers.
 */
class FakeOpencodeClient {
  createCalls: Array<{
    agent?: string;
    model?: unknown;
    directory?: string;
    permission?: unknown;
  }> = [];
  promptCalls: Array<{ sessionID: string; agent?: string; model?: unknown; parts: unknown }> = [];
  abortCalls: Array<{ sessionID: string }> = [];
  abortShouldError: { error: unknown } | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  abortDeferred: { promise: Promise<any>; resolve: (value: any) => void } | null = null;
  messageResponses: unknown[] = [];
  /** When set, every messages() call returns this same value (not consumed) — for simulating
   * many polling ticks observing an unchanged, stable session state (e.g. a stall). */
  stableMessagesResponse: unknown[] | null = null;
  messagesNeverResolves = false;

  nextSessionId = "ses_x";
  createShouldError: { error: unknown } | null = null;
  promptShouldError: { error: unknown } | null = null;
  /** When > 0, the next N session.create() calls fail (decrementing), independent of
   * the persistent createShouldError flag — for simulating a bounded run of failures
   * (e.g. one failed watchdog retry attempt followed by a successful one). */
  createShouldErrorCount = 0;
  createShouldThrowCount = 0;
  /** Same as createShouldErrorCount but for promptAsync(). */
  promptShouldErrorCount = 0;
  childrenResponses = new Map<string, unknown[]>();
  childrenShouldError: { error: unknown } | null = null;
  childrenNeverResolves = false;
  childrenCalls: Array<{ sessionID: string }> = [];
  sessionStatus: Record<string, unknown> = {};
  statusShouldError: { error: unknown } | null = null;
  statusNeverResolves = false;
  statusCalls = 0;

  private scripts: OpencodeEvent[][] = [];
  subscribeCallCount = 0;
  /** When true, subscribe() never yields/completes on its own — only the abort signal ends it. */
  hangSubscribe = false;
  lastSubscribeSignal: AbortSignal | null = null;

  queueScript(events: OpencodeEvent[]): void {
    this.scripts.push(events);
  }

  session = {
    create: async (params: {
      agent?: string;
      model?: unknown;
      directory?: string;
      permission?: unknown;
    }) => {
      this.createCalls.push(params);
      if (this.createShouldThrowCount > 0) {
        this.createShouldThrowCount -= 1;
        throw new Error("session create transport failed");
      }
      if (this.createShouldErrorCount > 0) {
        this.createShouldErrorCount -= 1;
        return { data: undefined, error: this.createShouldError?.error ?? { message: "session create failed" } };
      }
      if (this.createShouldError) {
        return { data: undefined, error: this.createShouldError.error };
      }
      this.sessionStatus[this.nextSessionId] ??= "busy";
      return {
        data: { id: this.nextSessionId, agent: params.agent, model: params.model },
        error: undefined,
      };
    },
    promptAsync: async (params: {
      sessionID: string;
      agent?: string;
      model?: unknown;
      parts: unknown;
    }) => {
      this.promptCalls.push(params);
      if (this.promptShouldErrorCount > 0) {
        this.promptShouldErrorCount -= 1;
        return { data: undefined, error: this.promptShouldError?.error ?? { message: "prompt failed" } };
      }
      if (this.promptShouldError) {
        return { data: undefined, error: this.promptShouldError.error };
      }
      return { data: undefined, error: undefined };
    },
    abort: async (params: { sessionID: string }) => {
      this.abortCalls.push(params);
      if (this.abortDeferred) return this.abortDeferred.promise;
      if (this.abortShouldError) return { data: undefined, error: this.abortShouldError.error };
      return { data: {}, error: undefined };
    },
    children: async (params: { sessionID: string }) => {
      this.childrenCalls.push(params);
      if (this.childrenNeverResolves) return new Promise(() => undefined);
      if (this.childrenShouldError) return { data: undefined, error: this.childrenShouldError.error };
      return { data: this.childrenResponses.get(params.sessionID) ?? [], error: undefined };
    },
    status: async () => {
      this.statusCalls += 1;
      if (this.statusNeverResolves) return new Promise(() => undefined);
      if (this.statusShouldError) return { data: undefined, error: this.statusShouldError.error };
      return { data: this.sessionStatus, error: undefined };
    },
    messages: async () => {
      if (this.messagesNeverResolves) return new Promise(() => undefined);
      if (this.stableMessagesResponse !== null) {
        return { data: this.stableMessagesResponse, error: undefined };
      }
      return { data: this.messageResponses.shift() ?? [], error: undefined };
    },
  };

  event = {
    subscribe: async (_params?: unknown, options?: { signal?: AbortSignal }) => {
      this.lastSubscribeSignal = options?.signal ?? null;
      this.subscribeCallCount += 1;
      if (this.hangSubscribe) {
        const signal = options?.signal;
        return {
          stream: (async function* (): AsyncGenerator<OpencodeEvent> {
            await new Promise<never>((_resolve, reject) => {
              if (signal?.aborted) {
                reject(new Error("aborted"));
                return;
              }
              signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            });
          })(),
        };
      }
      const script = this.scripts[this.subscribeCallCount - 1] ?? [];
      return { stream: makeAsyncGenerator(script) };
    },
  };

  permissionListCalls: Array<{ directory?: string }> = [];
  permissionReplyCalls: Array<{ requestID: string; directory?: string; reply: string }> = [];
  permissionReplyShouldError: { error: unknown } | null = null;
  permissionListShouldErrorCount = 0;
  /** Pending requests permission.list() returns every call (not consumed) — for
   * making the real permission-responder pool actually deny something in a test. */
  pendingPermissionRequests: unknown[] = [];

  permission = {
    list: async (params: { directory?: string }) => {
      this.permissionListCalls.push(params);
      if (this.permissionListShouldErrorCount > 0) {
        this.permissionListShouldErrorCount -= 1;
        return { data: undefined, error: { message: "opencode unreachable" } };
      }
      return { data: this.pendingPermissionRequests, error: undefined };
    },
    reply: async (params: { requestID: string; directory?: string; reply: string }) => {
      this.permissionReplyCalls.push(params);
      if (this.permissionReplyShouldError) return { data: undefined, error: this.permissionReplyShouldError.error };
      return { data: true, error: undefined };
    },
  };
}

function makeClaudeRunner(): ClaudeCodeRunnerLike & {
  run: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
  poll: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  return {
    run: vi.fn(async () => ({
      sessionId: "claude-session-1",
      sessionName: "openboard-task-claude",
      status: "running",
    })),
    retry: vi.fn(async () => ({
      sessionId: "claude-session-2",
      sessionName: "openboard-task-claude-retry",
      status: "running",
    })),
    poll: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => undefined),
  };
}

describe("TaskDispatcher", () => {
  let client: FakeOpencodeClient;
  let store: SqliteTaskStore;
  let dispatcher: TaskDispatcher;
  let workspace: string;
  let projectDir: string;
  let myProjectDir: string;

  beforeEach(() => {
    ({ workspace } = setupTestWorkspace());
    projectDir = join(workspace, "project");
    myProjectDir = join(workspace, "my-project");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(myProjectDir, { recursive: true });
    client = new FakeOpencodeClient();
    store = new SqliteTaskStore(":memory:");
  });

  afterEach(() => {
    dispatcher?.shutdown();
    store.close();
    cleanupTestWorkspace();
  });

  function createTask(
    overrides: Partial<{
      title: string;
      description: string;
      directory: string;
      taskKind: TaskKind;
      isolation: "worktree" | "in-place";
      permissionOverrides: Record<string, "allow" | "ask" | "deny">;
    }> = {},
  ) {
    return store.create({
      title: overrides.title ?? "Fix the bug",
      ...(overrides.taskKind !== undefined ? { taskKind: overrides.taskKind } : {}),
      description: overrides.description ?? "Please fix the bug in foo.ts",
      directory: overrides.directory ?? projectDir,
      ...(overrides.isolation !== undefined ? { isolation: overrides.isolation } : {}),
      ...(overrides.permissionOverrides !== undefined ? { permissionOverrides: overrides.permissionOverrides } : {}),
    });
  }

  describe("run()", () => {
    it("throws AdapterError.notFound when the task doesn't exist", async () => {
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await expect(dispatcher.run("task_missing")).rejects.toMatchObject({
        code: "session_not_found",
      });
    });

    it("throws 409 and does not create a session when the task is archived", async () => {
      const task = createTask();
      store.setArchived(task.id, true);
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await expect(dispatcher.run(task.id)).rejects.toMatchObject({
        code: "validation",
        status: 409,
        message: "Cannot run an archived task",
      });
      expect(client.createCalls).toHaveLength(0);
    });

    it("throws AdapterError.unreachable when session.create errors", async () => {
      const task = createTask();
      client.createShouldError = { error: { message: "boom" } };
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await expect(dispatcher.run(task.id)).rejects.toMatchObject({
        code: "opencode_unreachable",
      });
    });

    it("refuses to start a second writer session on a task that is already running (P3-11 regression)", async () => {
      const task = createTask();
      client.nextSessionId = "ses_first_writer";
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await dispatcher.run(task.id);
      expect(store.get(task.id)?.runState).toBe("running");
      expect(client.createCalls).toHaveLength(1);

      client.nextSessionId = "ses_second_writer";
      await expect(dispatcher.run(task.id)).rejects.toMatchObject({ code: "validation", status: 400 });

      // No second OpenCode session was created, and the original session/run
      // record is untouched — the guard fires before any dispatch work.
      expect(client.createCalls).toHaveLength(1);
      expect(store.get(task.id)).toMatchObject({ sessionId: "ses_first_writer", runState: "running" });
    });

    it("allows run() again once the prior run has left the running state (abort-then-run)", async () => {
      const task = createTask();
      client.nextSessionId = "ses_before_abort";
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await dispatcher.run(task.id);
      await dispatcher.abort(task.id);
      expect(store.get(task.id)?.runState).toBe("idle");

      client.nextSessionId = "ses_after_abort";
      await dispatcher.run(task.id);

      expect(client.createCalls).toHaveLength(2);
      expect(store.get(task.id)).toMatchObject({ sessionId: "ses_after_abort", runState: "running" });
    });

    it("does not treat the chain-advancer's pre-dispatch runState claim (no session yet) as a second writer (P3-11 regression)", async () => {
      // chain-advancer.ts synchronously sets runState: "running" on a child
      // *before* calling run(), purely to claim the slot against a second
      // near-simultaneous advance — no session exists yet at that point. The
      // second-writer guard must key off an actual live session, not bare
      // runState, or it would break every auto-dispatched child.
      const task = createTask();
      store.update(task.id, { runState: "running" });
      expect(store.get(task.id)?.sessionId).toBeFalsy();

      client.nextSessionId = "ses_claimed_dispatch";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);

      expect(client.createCalls).toHaveLength(1);
      expect(store.get(task.id)).toMatchObject({ sessionId: "ses_claimed_dispatch", runState: "running" });
    });

    it("creates a session in task.directory, prompts with task.description, links + moves to in_progress", async () => {
      const task = store.create({
        title: "Fix the bug",
        description: "Please fix the bug in foo.ts",
        directory: myProjectDir,
        agent: "build",
        model: { providerID: "opencode", id: "north-mini-code-free" },
      });
      client.nextSessionId = "ses_abc123";
      dispatcher = new TaskDispatcher({ client: client as never, store });

      const result = await dispatcher.run(task.id);

      expect(client.createCalls).toHaveLength(1);
      expect(client.createCalls[0]?.directory).toBe(myProjectDir);
      expect(client.createCalls[0]?.permission).toBeTruthy();
      expect(client.promptCalls).toHaveLength(1);
      expect(client.promptCalls[0]).toMatchObject({
        sessionID: "ses_abc123",
        agent: "build",
        model: { providerID: "opencode", modelID: "north-mini-code-free" },
      });
      expect(client.promptCalls[0]?.parts).toEqual([
        { type: "text", text: expect.stringContaining(task.description) },
      ]);

      expect(result.sessionId).toBe("ses_abc123");
      expect(result.runState).toBe("running");
      expect(result.column).toBe("in_progress");

      const persisted = store.get(task.id);
      expect(persisted?.sessionId).toBe("ses_abc123");
      expect(persisted?.runState).toBe("running");
      expect(persisted?.column).toBe("in_progress");
    });

    it("registers in-place ask rules before prompt admission and projects broker-only pending asks oldest-first", async () => {
      const task = createTask({ isolation: "in-place", permissionOverrides: { bash: "ask" } });
      client.nextSessionId = "ses_ask";
      client.stableMessagesResponse = [{ info: { id: "msg1" }, parts: [{ type: "tool", callID: "call1", tool: "bash" }] }];
      client.pendingPermissionRequests = [
        { id: "native_newer", sessionID: "ses_ask", permission: "bash", tool: { messageID: "msg1", callID: "call1" } },
        { id: "native_second", sessionID: "ses_ask", permission: "edit", tool: { messageID: "msg1", callID: "call1" } },
      ];
      dispatcher = new TaskDispatcher({ client: client as never, store, permissionGraceMs: 60_000 });

      await dispatcher.run(task.id);
      await waitFor(() => (dispatcher as never as { listPendingPermissions(id: string): unknown[] }).listPendingPermissions(task.id).length === 2);

      const pending = (dispatcher as never as { listPendingPermissions(id: string): Array<Record<string, unknown>> }).listPendingPermissions(task.id);
      expect(pending.map((ask) => ask.id)).toEqual(["ask_1", "ask_2"]);
      expect(pending[0]).toMatchObject({ harness: "opencode", source: "in-place-override", permission: "bash", tool: "bash" });
      expect(pending[0]).not.toHaveProperty("nativeId");
      expect(pending[0]).not.toHaveProperty("requestID");
      expect(store.get(task.id)?.pendingPermissions).toBeUndefined();
      expect(client.promptCalls).toHaveLength(1);
    });

    it("responds to a task-owned ask atomically through the dispatcher broker and records bounded events", async () => {
      const task = createTask({ isolation: "in-place", permissionOverrides: { bash: "ask" } });
      client.nextSessionId = "ses_answer";
      client.stableMessagesResponse = [{ info: { id: "msg1" }, parts: [{ type: "tool", callID: "call1", tool: "bash" }] }];
      client.pendingPermissionRequests = [
        { id: "native_req", sessionID: "ses_answer", permission: "bash", patterns: ["**"], tool: { messageID: "msg1", callID: "call1" } },
      ];
      dispatcher = new TaskDispatcher({ client: client as never, store, permissionGraceMs: 60_000 });

      await dispatcher.run(task.id);
      await waitFor(() => (dispatcher as never as { listPendingPermissions(id: string): unknown[] }).listPendingPermissions(task.id).length === 1);
      const askId = (dispatcher as never as { listPendingPermissions(id: string): Array<{ id: string }> }).listPendingPermissions(task.id)[0]!.id;

      const [first, second] = await Promise.all([
        (dispatcher as never as { respondPermission(id: string, input: unknown): Promise<unknown> }).respondPermission(task.id, { askId, action: "allow_once", answeredBy: "Operator" }),
        (dispatcher as never as { respondPermission(id: string, input: unknown): Promise<unknown> }).respondPermission(task.id, { askId, action: "deny", answeredBy: "Operator" }),
      ]);

      expect([first, second].filter((outcome) => (outcome as { ok?: boolean }).ok)).toHaveLength(1);
      expect(client.permissionReplyCalls).toEqual([{ requestID: "native_req", directory: projectDir, reply: "once" }]);
      const events = store.listEvents(task.id);
      expect(events.map((event) => event.type)).toContain("task_permission_asked");
      expect(events.map((event) => event.type)).toContain("task_permission_answered");
      const asked = events.find((event) => event.type === "task_permission_asked")!;
      expect(asked.body).toEqual({
        askId,
        harness: "opencode",
        source: "in-place-override",
        permission: "bash",
        summary: 'Tool "bash" requested a permission this worktree fence denies by default.',
        tool: "bash",
        raisedAt: expect.any(Number),
        deadline: expect.any(Number),
        patterns: ["**"],
      });
      expect(asked.body).not.toHaveProperty("resolution");
      const answered = events.find((event) => event.type === "task_permission_answered")!;
      expect(answered.body).toEqual({
        askId,
        harness: "opencode",
        source: "in-place-override",
        permission: "bash",
        summary: 'Tool "bash" requested a permission this worktree fence denies by default.',
        resolution: "operator",
        tool: "bash",
        action: "allow_once",
        answeredBy: "Operator",
        latencyMs: expect.any(Number),
      });
      expect(answered.body).not.toHaveProperty("nativeId");
      expect(answered.body).not.toHaveProperty("policy");
    });

    it("cleans up pending asks when prompt admission fails", async () => {
      const task = createTask({ isolation: "in-place", permissionOverrides: { bash: "ask" } });
      client.nextSessionId = "ses_fail_prompt";
      client.promptShouldError = { error: { message: "prompt rejected" } };
      dispatcher = new TaskDispatcher({ client: client as never, store, permissionGraceMs: 60_000 });

      await dispatcher.run(task.id);

      expect((dispatcher as never as { listPendingPermissions(id: string): unknown[] }).listPendingPermissions(task.id)).toEqual([]);
    });

    it("records reply failures and lets a later poll re-project a fresh broker ask", async () => {
      const task = createTask({ isolation: "in-place", permissionOverrides: { bash: "ask" } });
      client.nextSessionId = "ses_reply_fail";
      client.stableMessagesResponse = [{ info: { id: "msg1" }, parts: [{ type: "tool", callID: "call1", tool: "bash" }] }];
      client.pendingPermissionRequests = [
        { id: "native_req", sessionID: "ses_reply_fail", permission: "bash", tool: { messageID: "msg1", callID: "call1" } },
      ];
      client.permissionReplyShouldError = { error: { message: "reply failed" } };
      dispatcher = new TaskDispatcher({ client: client as never, store, permissionGraceMs: 60_000 });

      await dispatcher.run(task.id);
      await waitFor(() => (dispatcher as never as { listPendingPermissions(id: string): unknown[] }).listPendingPermissions(task.id).length === 1);
      const askId = (dispatcher as never as { listPendingPermissions(id: string): Array<{ id: string }> }).listPendingPermissions(task.id)[0]!.id;
      const outcome = await (dispatcher as never as { respondPermission(id: string, input: unknown): Promise<unknown> }).respondPermission(task.id, { askId, action: "deny", answeredBy: "Operator" });

      expect(outcome).toMatchObject({ ok: false, conflict: "reply-failed" });
      const failed = store.listEvents(task.id).find((event) => event.type === "task_permission_reply_failed")!;
      expect(failed.body).toEqual({
        askId,
        harness: "opencode",
        source: "in-place-override",
        permission: "bash",
        summary: 'Tool "bash" requested a permission this worktree fence denies by default.',
        resolution: "operator",
        tool: "bash",
        action: "deny",
        answeredBy: "Operator",
        error: "reply failed",
        latencyMs: expect.any(Number),
      });
      expect(failed.body).not.toHaveProperty("policy");
      expect(failed.body).not.toHaveProperty("nativeId");
      client.permissionReplyShouldError = null;
      await waitFor(() => (dispatcher as never as { listPendingPermissions(id: string): Array<{ id: string }> }).listPendingPermissions(task.id).some((ask) => ask.id !== askId));
    });

    it("rejects stale answers after retry replacement clears the old run ask", async () => {
      const task = createTask({ isolation: "in-place", permissionOverrides: { bash: "ask" } });
      client.nextSessionId = "ses_stale";
      client.stableMessagesResponse = [{ info: { id: "msg1" }, parts: [{ type: "tool", callID: "call1", tool: "bash" }] }];
      client.pendingPermissionRequests = [
        { id: "native_req", sessionID: "ses_stale", permission: "bash", tool: { messageID: "msg1", callID: "call1" } },
      ];
      dispatcher = new TaskDispatcher({ client: client as never, store, permissionGraceMs: 60_000 });

      await dispatcher.run(task.id);
      await waitFor(() => (dispatcher as never as { listPendingPermissions(id: string): unknown[] }).listPendingPermissions(task.id).length === 1);
      const staleAskId = (dispatcher as never as { listPendingPermissions(id: string): Array<{ id: string }> }).listPendingPermissions(task.id)[0]!.id;
      client.pendingPermissionRequests = [];
      await dispatcher.retry(task.id, "try again");

      const outcome = await (dispatcher as never as { respondPermission(id: string, input: unknown): Promise<unknown> }).respondPermission(task.id, { askId: staleAskId, action: "deny", answeredBy: "Operator" });
      expect(outcome).toEqual({ ok: false, askId: staleAskId, conflict: "not-found" });
      expect(client.permissionReplyCalls).toEqual([]);
      expect((dispatcher as unknown as { permissionAskMeta: Map<string, unknown> }).permissionAskMeta.has(staleAskId)).toBe(false);
    });

    it("cleans pending permission timing metadata on abort", async () => {
      const task = createTask({ isolation: "in-place", permissionOverrides: { bash: "ask" } });
      client.nextSessionId = "ses_abort_permission";
      client.stableMessagesResponse = [{ info: { id: "msg1" }, parts: [{ type: "tool", callID: "call1", tool: "bash" }] }];
      client.pendingPermissionRequests = [
        { id: "native_req", sessionID: "ses_abort_permission", permission: "bash", tool: { messageID: "msg1", callID: "call1" } },
      ];
      dispatcher = new TaskDispatcher({ client: client as never, store, permissionGraceMs: 60_000 });

      await dispatcher.run(task.id);
      await waitFor(() => (dispatcher as never as { listPendingPermissions(id: string): unknown[] }).listPendingPermissions(task.id).length === 1);
      const askId = (dispatcher as never as { listPendingPermissions(id: string): Array<{ id: string }> }).listPendingPermissions(task.id)[0]!.id;
      expect((dispatcher as unknown as { permissionAskMeta: Map<string, unknown> }).permissionAskMeta.has(askId)).toBe(true);

      await dispatcher.abort(task.id);

      expect((dispatcher as never as { listPendingPermissions(id: string): unknown[] }).listPendingPermissions(task.id)).toEqual([]);
      expect((dispatcher as unknown as { permissionAskMeta: Map<string, unknown> }).permissionAskMeta.has(askId)).toBe(false);
    });

    it("records ACP permission event metadata from the task-scoped pending projection", () => {
      const task = store.create({
        title: "ACP permission",
        description: "Use ACP",
        directory: myProjectDir,
        harness: "claude-code",
      });
      store.update(task.id, {
        harnessSessionId: "acp-session-1",
        harnessSessionName: "openboard-task-acp",
        runState: "running",
        runStartedAt: 1_000,
      });
      const claudeRunner = {
        ...makeClaudeRunner(),
        listPendingPermissions: vi.fn(() => [{
          id: "ask_acp",
          harness: "claude-code" as const,
          source: "acp" as const,
          permission: "edit",
          tool: "Edit",
          summary: "Edit · edit · /repo/file.ts",
          patterns: ["/repo/file.ts"],
          raisedAt: 1_010,
          deadline: 2_010,
        }]),
      };
      dispatcher = new TaskDispatcher({ client: client as never, store, claudeRunner });

      const handle = (dispatcher as unknown as { handlePermissionEvent(event: unknown): void }).handlePermissionEvent.bind(dispatcher);
      handle({
        type: "permission_asked",
        askId: "ask_acp",
        runId: "acp-session-1",
        harness: "claude-code",
        source: "acp",
        permission: "edit",
        tool: "Edit",
        summary: "Edit · edit · /repo/file.ts",
        occurredAt: 1_010,
      });
      handle({
        type: "permission_answered",
        askId: "ask_acp",
        runId: "acp-session-1",
        harness: "claude-code",
        source: "acp",
        permission: "edit",
        tool: "Edit",
        summary: "Edit · edit · /repo/file.ts",
        occurredAt: 1_125,
        decision: "allow_once",
        reason: "operator",
        answeredBy: "Operator",
      });

      const events = store.listEvents(task.id);
      const asked = events.find((event) => event.type === "task_permission_asked")!;
      expect(asked.body).toMatchObject({
        askId: "ask_acp",
        harness: "claude-code",
        source: "acp",
        permission: "edit",
        tool: "Edit",
        summary: "Edit · edit · /repo/file.ts",
        raisedAt: 1_010,
        deadline: 2_010,
        patterns: ["/repo/file.ts"],
      });
      const answered = events.find((event) => event.type === "task_permission_answered")!;
      expect(answered.body).toMatchObject({
        askId: "ask_acp",
        resolution: "operator",
        action: "allow_once",
        answeredBy: "Operator",
        latencyMs: 115,
      });
    });

    it("launches claude-code tasks through the Claude runner instead of OpenCode sessions", async () => {
      const task = store.create({
        title: "Claude lane",
        description: "Use Claude Code",
        directory: myProjectDir,
        harness: "claude-code",
        agent: "plan",
      });
      const claudeRunner = makeClaudeRunner();
      dispatcher = new TaskDispatcher({ client: client as never, store, claudeRunner });

      const result = await dispatcher.run(task.id);

      expect(client.createCalls).toHaveLength(0);
      expect(client.promptCalls).toHaveLength(0);
      expect(claudeRunner.run).toHaveBeenCalledWith({
        task: expect.objectContaining({ id: task.id, harness: "claude-code" }),
        directory: myProjectDir,
        prompt: "Use Claude Code",
        runStartedAt: expect.any(Number),
      });
      expect(result).toMatchObject({
        id: task.id,
        column: "in_progress",
        runState: "running",
        harnessSessionId: "claude-session-1",
        harnessSessionName: "openboard-task-claude",
        harnessStatus: "running",
      });
      expect(result.sessionId).toBeUndefined();
    });

    it("passes the stored task.model to both session.create and session.prompt", async () => {
      const task = store.create({
        title: "Model passthrough",
        description: "Verify dispatch uses the stored model",
        directory: projectDir,
        agent: "explore",
        model: { providerID: "openai", id: "gpt-5.5", variant: "reasoning" },
      });
      client.nextSessionId = "ses_model_shape";
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await dispatcher.run(task.id);

      expect(client.createCalls).toHaveLength(1);
      expect(client.createCalls[0]).toMatchObject({
        agent: "explore",
        model: { providerID: "openai", id: "gpt-5.5", variant: "reasoning" },
        directory: projectDir,
      });
      expect(client.promptCalls[0]).toMatchObject({
        sessionID: "ses_model_shape",
        agent: "explore",
        model: { providerID: "openai", modelID: "gpt-5.5" },
        variant: "reasoning",
      });
    });

    it("appends the completion-contract footer with task id and adapter URL", async () => {
      const task = createTask({ description: "Do scoped work", taskKind: "build" });
      client.nextSessionId = "ses_contract";
      dispatcher = new TaskDispatcher({
        client: client as never,
        store,
        adapterBaseUrl: "http://127.0.0.1:5123",
      });

      await dispatcher.run(task.id);

      const text = (client.promptCalls[0]?.parts as Array<{ text: string }>)[0]?.text;
      expect(text).toContain("Do scoped work");
      expect(text).toContain("OPENBOARD COMPLETION CONTRACT");
      expect(text).toContain(`Task id: ${task.id}`);
      expect(text).toContain("OPENBOARD HANDOFF GUIDANCE");
      expect(text).toContain("Task type: build");
      expect(text).toContain("- summary: implementation completed and behavior changed.");
      expect(text).toContain("- changedFiles: actual touched files.");
      expect(text).toContain(`complete_task with { taskId: "${task.id}"`);
      expect(text).toContain(`block_task with { taskId: "${task.id}"`);
      expect(text).toContain(`http://127.0.0.1:5123/api/tasks/${task.id}/complete`);
      expect(text).toContain(`http://127.0.0.1:5123/api/tasks/${task.id}/block`);
      expect(text).toContain("Call complete_task/block_task or /complete or /block exactly once");
    });

    it("includes a shell-escaped board token in completion-contract curl commands", async () => {
      const task = createTask({ description: "Do authenticated work" });
      dispatcher = new TaskDispatcher({
        client: client as never,
        store,
        adapterBaseUrl: "http://127.0.0.1:5123",
        boardToken: "tok'en",
      });

      await dispatcher.run(task.id);

      const text = (client.promptCalls[0]?.parts as Array<{ text: string }>)[0]?.text;
      expect(text).toContain("-H 'Authorization: Bearer tok'\\''en'");
      expect(text.match(/Authorization: Bearer/g)).toHaveLength(2);
    });

    it("includes synthesis-specific handoff guidance in completion contracts", async () => {
      const task = createTask({ description: "Synthesize research", taskKind: "synthesis" });
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await dispatcher.run(task.id);

      const text = (client.promptCalls[0]?.parts as Array<{ text: string }>)[0]?.text;
      expect(text).toContain("Task type: synthesis");
      expect(text).toContain("evaluation of the requested material");
      expect(text).toContain("files/sources read");
      expect(text).not.toContain("parent handoffs/raw files read");
      expect(text).toContain("ideas to avoid, questions for human");
      expect(text).toContain("proposed build/audit graph");
    });

    it("uses linked synthesis handoff guidance when parents are linked", async () => {
      const parent = createTask({ title: "Research parent", description: "parent" });
      const child = createTask({ description: "Synthesize research", taskKind: "synthesis" });
      store.addLink(parent.id, child.id);
      store.move(parent.id, "done", 0);
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await dispatcher.run(child.id);

      const text = (client.promptCalls[0]?.parts as Array<{ text: string }>)[0]?.text;
      expect(text).toContain("evaluation of parent findings");
      expect(text).toContain("parent handoffs/raw files read");
    });

    it("injects task execution context before parent handoffs and the completion contract", async () => {
      const parent = createTask({ title: "Audit source", description: "parent" });
      const child = createTask({ title: "Child task", description: "Audit the parent", taskKind: "audit" });
      store.addLink(parent.id, child.id);
      store.move(parent.id, "done", 0);
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await dispatcher.run(child.id);

      const text = (client.promptCalls[0]?.parts as Array<{ text: string }>)[0]?.text;
      expect(text).toContain("Audit the parent");
      expect(text).toContain("OPENBOARD TASK CONTEXT");
      expect(text).toContain("Task type: audit");
      expect(text).toContain("Inspect only unless explicitly told otherwise.");
      expect(text).toContain("Do not fix issues.");
      expect(text).toContain("Inspect parent code changes with the openboard task_diff MCP tool first; use read-only parent worktree inspection as the fallback.");
      expect(text).toContain("Review diffs, tests, and behavior.");
      expect(text).toContain("Produce findings with severity/confidence and residual risk.");
      expect(text).toContain("Keep output finding-oriented.");
      expect(text.indexOf("Audit the parent")).toBeLessThan(text.indexOf("OPENBOARD TASK CONTEXT"));
      expect(text.indexOf("OPENBOARD TASK CONTEXT")).toBeLessThan(text.indexOf("PARENT CONTEXT"));
      expect(text.indexOf("PARENT CONTEXT")).toBeLessThan(text.indexOf("OPENBOARD COMPLETION CONTRACT"));
    });

    it("injects standalone task execution context without parent wording when no parents are linked", async () => {
      const task = createTask({ description: "Audit standalone code", taskKind: "audit" });
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await dispatcher.run(task.id);

      const text = (client.promptCalls[0]?.parts as Array<{ text: string }>)[0]?.text;
      expect(text).toContain("OPENBOARD TASK CONTEXT");
      expect(text).toContain("Review the requested files, diffs, tests, and behavior in cwd.");
      expect(text).not.toContain("PARENT CONTEXT");
      expect(text).not.toContain("parent worktrees");
    });

    it("includes task execution context for research cards", async () => {
      const task = createTask({ description: "Research only", taskKind: "research" });
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await dispatcher.run(task.id);

      const text = (client.promptCalls[0]?.parts as Array<{ text: string }>)[0]?.text;
      expect(text).toContain("OPENBOARD TASK CONTEXT");
      expect(text).toContain("Task type: research");
      expect(text).toContain("For research, the mode is:");
      expect(text).toContain("OPENBOARD HANDOFF GUIDANCE");
    });

    it("omits task execution context for none cards", async () => {
      const task = createTask({ description: "No kind", taskKind: "none" });
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await dispatcher.run(task.id);

      const text = (client.promptCalls[0]?.parts as Array<{ text: string }>)[0]?.text;
      expect(text).not.toContain("OPENBOARD TASK CONTEXT");
      expect(text).toContain("OPENBOARD HANDOFF GUIDANCE");
    });

    it("injects task execution context into ACP prompts", async () => {
      const task = store.create({
        title: "Fix lane",
        description: "Fix the audited issue",
        directory: myProjectDir,
        harness: "claude-code",
        taskKind: "fix",
      });
      const claudeRunner = makeClaudeRunner();
      dispatcher = new TaskDispatcher({ client: client as never, store, claudeRunner });

      await dispatcher.run(task.id);

      const call = claudeRunner.run.mock.calls[0]?.[0];
      expect(call).toBeDefined();
      const prompt = call?.prompt ?? "";
      expect(prompt).toContain("Fix the audited issue");
      expect(prompt).toContain("OPENBOARD TASK CONTEXT");
      expect(prompt).toContain("Task type: fix");
      expect(prompt).toContain("Resolve specific findings described in the card prompt or current cwd.");
      expect(prompt).toContain("Tie each change back to the finding or defect it addresses.");
      expect(prompt.indexOf("Fix the audited issue")).toBeLessThan(
        prompt.indexOf("OPENBOARD TASK CONTEXT"),
      );
    });

    it("continues a live ACP card through the existing harness session", async () => {
      const task = store.create({ title: "Claude chat", description: "Start", directory: myProjectDir, harness: "claude-code" });
      const claudeRunner = makeClaudeRunner();
      dispatcher = new TaskDispatcher({ client: client as never, store, claudeRunner });
      await dispatcher.run(task.id);
      const current = store.get(task.id)!;

      const receipt = await dispatcher.sendSessionMessage(task.id, {
        text: "Now focus on the API test",
        mode: "queue",
        sentBy: "User",
        clientMessageId: "msg-acp",
        expectedSessionId: "claude-session-1",
        expectedRunStartedAt: current.runStartedAt,
      });

      expect(claudeRunner.sendMessage).toHaveBeenCalledWith(
        "openboard-task-claude",
        expect.stringContaining("Now focus on the API test"),
        expect.objectContaining({ mode: "queue" }),
      );
      expect(receipt.task.harnessSessionId).toBe("claude-session-1");
      expect(claudeRunner.run).toHaveBeenCalledTimes(1);
    });

    it("injects satisfied parent handoffs before the completion-contract footer", async () => {
      const parent = createTask({ title: "Parent task", description: "parent" });
      const child = createTask({ title: "Child task", description: "child work" });
      const parentWorktreePath = `/tmp/openboard-test/worktrees/${parent.id}`;
      store.addLink(parent.id, child.id);
      store.update(parent.id, {
        worktreePath: parentWorktreePath,
        worktreeBranch: `board/${parent.id}`,
      });
      store.setCompletion(
        parent.id,
        {
          outcome: "complete",
          summary: "parent summary",
          changedFiles: ["src/parent.ts", `${parentWorktreePath}/test/parent.test.ts`],
          verification: [{ command: "npm test", result: "passed" }],
          residualRisk: "none",
          reportedAt: 123,
        },
        "reported",
      );
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await dispatcher.run(child.id);

      const text = (client.promptCalls[0]?.parts as Array<{ text: string }>)[0]?.text;
      expect(text).toContain("PARENT CONTEXT");
      expect(text).toContain("PARENT-000: Parent task");
      expect(text).toContain("To inspect a parent's code changes, first call the openboard MCP tool task_diff with that parent's task id (listed below).");
      expect(text).toContain("If task_diff is unavailable, errors, or returns no-git evidence, fall back to the parent worktree with read/grep/glob/list tools only.");
      expect(text).toContain("Parent task worktrees are read-only. Do not use bash, git -C, wc, shell grep, tests, or mutating commands against parent or sibling worktrees.");
      expect(text).toContain("Board tools are limited to task_diff, task_context, and task_compare for inspection and complete_task/block_task for your final report. Never call other board tools (run/move/create/link/retry/abort/integrate).");
      expect(text).toContain("Your cwd starts from the base branch: parent changes are NOT present in your cwd unless they were already integrated.");
      expect(text).toContain(`PARENT-000 WORKTREE: ${parentWorktreePath}`);
      expect(text).toContain(`PARENT-000 TASK ID: ${parent.id}`);
      expect(text).toContain(`PARENT-000 BRANCH: board/${parent.id}`);
      expect(text).toContain("PARENT-000 SUMMARY: parent summary");
      expect(text).toContain("PARENT-000 Changed files:");
      expect(text).toContain("- src/parent.ts");
      expect(text).toContain("- test/parent.test.ts");
      expect(text).not.toContain(`${parentWorktreePath}/test/parent.test.ts`);
      expect(text).toContain("- npm test: passed");
      expect(text).toContain("PARENT-000 Residual risk: none");
      expect(text).toContain("If a parent changed file also exists in your cwd, inspect the parent copy only to understand intent, then open/edit/test the cwd copy.");
      expect(text.indexOf("PARENT CONTEXT")).toBeLessThan(
        text.indexOf("OPENBOARD COMPLETION CONTRACT"),
      );
      expect(text.trim().endsWith("Do not continue working after reporting.")).toBe(true);
    });

    it("injects a manual-done parent note when no structured handoff exists", async () => {
      const parent = createTask({ title: "Manual parent" });
      const child = createTask({ description: "child work" });
      store.addLink(parent.id, child.id);
      store.move(parent.id, "done", 0);
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await dispatcher.run(child.id);

      const text = (client.promptCalls[0]?.parts as Array<{ text: string }>)[0]?.text;
      expect(text).toContain("PARENT-000: Manual parent");
      expect(text).toContain("No structured handoff exists; parent is manually marked Done.");
    });

    it("rejects dispatch when a parent dependency is not satisfied", async () => {
      const parent = createTask({ title: "Unfinished parent" });
      const child = createTask({ title: "Child" });
      store.addLink(parent.id, child.id);
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await expect(dispatcher.run(child.id)).rejects.toMatchObject({
        status: 409,
        unmetParents: [{ id: parent.id, title: "Unfinished parent", why: "parent is in todo" }],
      });
      expect(client.createCalls).toHaveLength(0);
    });

    it("clears stale completion when dispatching a task again", async () => {
      const task = createTask();
      store.setCompletion(
        task.id,
        {
          outcome: "complete",
          summary: "old",
          changedFiles: [],
          verification: [],
          residualRisk: "none",
          reportedAt: 1,
        },
        "reported",
      );
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await dispatcher.run(task.id);

      expect(store.get(task.id)?.completion).toBeNull();
      expect(store.get(task.id)?.completionSource).toBeNull();
    });

    it("clears stale finalSessionOutput when dispatching a task again", async () => {
      const task = createTask();
      store.update(task.id, { finalSessionOutput: "old output text" });
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await dispatcher.run(task.id);

      expect(store.get(task.id)?.finalSessionOutput).toBeNull();
    });

    it("lands the task at the end of in_progress when other tasks are already there", async () => {
      const other = createTask({ title: "Other task" });
      store.move(other.id, "in_progress", 0);

      const task = createTask({ title: "New task" });
      client.nextSessionId = "ses_new";
      dispatcher = new TaskDispatcher({ client: client as never, store });

      const result = await dispatcher.run(task.id);

      expect(result.column).toBe("in_progress");
      const inProgress = store.list().filter((t) => t.column === "in_progress");
      expect(inProgress.map((t) => t.id)).toEqual([other.id, task.id]);
      expect(result.position).toBe(1);
    });

    it("records prompt failures without moving the task to in_progress", async () => {
      const task = createTask({ directory: myProjectDir });
      client.nextSessionId = "ses_prompt_fail";
      client.promptShouldError = { error: { message: "provider unavailable" } };
      dispatcher = new TaskDispatcher({ client: client as never, store });

      const result = await dispatcher.run(task.id);

      expect(result.sessionId).toBe("ses_prompt_fail");
      expect(result.runState).toBe("error");
      expect(result.error).toBe("provider unavailable");
      expect(result.column).toBe("todo");
      expect(store.get(task.id)?.column).toBe("todo");
      expect(store.get(task.id)?.runState).toBe("error");
    });

    it("binds the OpenCode root run to activity before promptAsync", async () => {
      const activity = new SessionActivityCollector();
      const task = createTask({ directory: myProjectDir });
      client.nextSessionId = "ses_activity_before_prompt";
      client.promptShouldError = { error: { message: "prompt failed after create" } };
      dispatcher = new TaskDispatcher({ client: client as never, store, activity });

      await dispatcher.run(task.id);

      const frames: SessionActivityFrame[] = [];
      activity.subscribe(task.id, 0, (frame) => frames.push(frame));
      expect(frames.find((frame) => frame.kind === "snapshot")).toMatchObject({
        kind: "snapshot",
        run: expect.objectContaining({
          taskId: task.id,
          sessionId: "ses_activity_before_prompt",
          rootSessionId: "ses_activity_before_prompt",
          harness: "opencode",
        }),
      });
    });

    it("attributes root, child, and grandchild activity using actual info.parentID session.created shape", async () => {
      const activity = new SessionActivityCollector({ clock: () => 42 });
      const frames: SessionActivityFrame[] = [];
      const task = createTask({ directory: myProjectDir });
      client.nextSessionId = "ses_root";
      client.queueScript([
        {
          type: "session.created",
          properties: { info: { id: "ses_child", parentID: "ses_root" } },
        } as unknown as OpencodeEvent,
        {
          type: "session.created",
          properties: { info: { id: "ses_grandchild", parentID: "ses_child" } },
        } as unknown as OpencodeEvent,
        {
          type: "session.next.text.ended",
          properties: { sessionID: "ses_grandchild", text: "grandchild output" },
        } as unknown as OpencodeEvent,
      ]);
      dispatcher = new TaskDispatcher({ client: client as never, store, activity });

      await dispatcher.run(task.id);
      activity.subscribe(task.id, 0, (frame) => frames.push(frame));
      dispatcher.start();

      await waitFor(() => frames.some((frame) => frame.kind === "append" && frame.event.sessionId === "ses_grandchild" && frame.event.text === "grandchild output"));
      expect(frames.filter((frame) => frame.kind === "append").map((frame) => frame.event.sessionId)).toContain("ses_child");
      expect(frames.filter((frame) => frame.kind === "append").map((frame) => frame.event.sessionId)).toContain("ses_grandchild");
      await waitFor(() => frames.some((frame) => frame.kind === "heartbeat" && frame.transport === "reconnecting"));
    });

    it("caps descendant binding at 256 sessions and ignores cycle duplicates", async () => {
      const activity = new SessionActivityCollector();
      const frames: SessionActivityFrame[] = [];
      const task = createTask({ directory: myProjectDir });
      client.nextSessionId = "ses_cap_root";
      const events: OpencodeEvent[] = [];
      for (let i = 0; i < 260; i += 1) {
        events.push({ type: "session.created", properties: { info: { id: `ses_child_${i}`, parentID: i === 0 ? "ses_cap_root" : `ses_child_${i - 1}` } } } as unknown as OpencodeEvent);
      }
      events.push({ type: "session.created", properties: { info: { id: "ses_child_1", parentID: "ses_child_2" } } } as unknown as OpencodeEvent);
      events.push({ type: "session.next.text.ended", properties: { sessionID: "ses_child_259", text: "too deep" } } as unknown as OpencodeEvent);
      client.queueScript(events);
      dispatcher = new TaskDispatcher({ client: client as never, store, activity });

      await dispatcher.run(task.id);
      activity.subscribe(task.id, 0, (frame) => frames.push(frame));
      dispatcher.start();
      await waitFor(() => client.subscribeCallCount > 0);
      await new Promise((r) => setTimeout(r, 20));

      expect(frames.some((frame) => frame.kind === "append" && frame.event.sessionId === "ses_child_254")).toBe(true);
      expect(frames.some((frame) => frame.kind === "append" && frame.event.sessionId === "ses_child_255")).toBe(false);
      expect(frames.some((frame) => frame.kind === "append" && frame.event.text === "too deep")).toBe(false);
    });

    it("rebuilds child trees before declaring reconnect live and keeps blind failures reconnecting", async () => {
      const activity = new SessionActivityCollector();
      const frames: SessionActivityFrame[] = [];
      const task = createTask({ directory: myProjectDir });
      client.nextSessionId = "ses_rebuild_root";
      dispatcher = new TaskDispatcher({ client: client as never, store, activity });
      await dispatcher.run(task.id);
      activity.subscribe(task.id, 0, (frame) => frames.push(frame));
      (dispatcher as unknown as { markRunsReconnecting(): void }).markRunsReconnecting();
      client.childrenResponses.set("ses_rebuild_root", [{ info: { id: "ses_rebuilt_child" } }]);
      client.childrenResponses.set("ses_rebuilt_child", [{ info: { id: "ses_rebuilt_grandchild" } }]);
      client.sessionStatus = { ses_rebuild_root: "busy" };

      await (dispatcher as unknown as { rebuildRunsBeforeLive(): Promise<void> }).rebuildRunsBeforeLive();
      (dispatcher as unknown as { handleEvent(event: OpencodeEvent): void }).handleEvent({ type: "session.next.text.ended", properties: { sessionID: "ses_rebuilt_grandchild", text: "rebuilt live" } } as unknown as OpencodeEvent);

      expect(frames.some((frame) => frame.kind === "heartbeat" && frame.transport === "live")).toBe(true);
      expect(frames.some((frame) => frame.kind === "append" && frame.event.text === "rebuilt live")).toBe(true);

      client.childrenShouldError = { error: { message: "transport blind" } };
      client.statusShouldError = { error: { message: "status unavailable" } };
      (dispatcher as unknown as { markRunsReconnecting(): void }).markRunsReconnecting();
      const liveCountBeforeBlind = frames.filter((frame) => frame.kind === "heartbeat" && frame.transport === "live").length;
      await (dispatcher as unknown as { rebuildRunsBeforeLive(): Promise<void> }).rebuildRunsBeforeLive();
      expect(frames.at(-1)).toMatchObject({ kind: "heartbeat", transport: "reconnecting" });
      expect(frames.filter((frame) => frame.kind === "heartbeat" && frame.transport === "live")).toHaveLength(liveCountBeforeBlind);
    });

    it("suspends the run's watchdog on reconnect and resumes it once transport is confirmed live (P2-1 regression)", async () => {
      const task = createTask({ directory: myProjectDir });
      client.nextSessionId = "ses_watchdog_suspend";
      dispatcher = new TaskDispatcher({ client: client as never, store, watchdogConfig: { enabled: true, timeoutMs: 60_000, sweepIntervalMs: 30_000, maxAutomaticRetries: 2 } });
      await dispatcher.run(task.id);

      const runs = (dispatcher as unknown as { openCodeRunsByTask: Map<string, { watchdog: { snapshot(): { suspended?: boolean; stage: string } } }> }).openCodeRunsByTask;
      expect(runs.get(task.id)!.watchdog.snapshot().suspended).toBe(false);

      (dispatcher as unknown as { markRunsReconnecting(): void }).markRunsReconnecting();
      expect(runs.get(task.id)!.watchdog.snapshot()).toMatchObject({ suspended: true, stage: "healthy" });

      client.sessionStatus = { ses_watchdog_suspend: "busy" };
      await (dispatcher as unknown as { rebuildRunsBeforeLive(): Promise<void> }).rebuildRunsBeforeLive();

      expect(runs.get(task.id)!.watchdog.snapshot()).toMatchObject({ suspended: false, stage: "healthy" });
    });

    it("does not orphan or trip on a genuinely blind observation gap until the bounded recovery threshold, then resumes honestly (P2-1 regression)", async () => {
      const task = createTask({ directory: myProjectDir });
      client.nextSessionId = "ses_bounded_blind";
      dispatcher = new TaskDispatcher({ client: client as never, store, watchdogConfig: { enabled: true, timeoutMs: 60_000, sweepIntervalMs: 30_000, maxAutomaticRetries: 2 } });
      await dispatcher.run(task.id);

      // Zero visibility: children() errors (non-404) and status() errors too.
      client.childrenShouldError = { error: { message: "transport blind" } };
      client.statusShouldError = { error: { message: "status unavailable" } };

      const runs = (dispatcher as unknown as { openCodeRunsByTask: Map<string, { watchdog: { snapshot(): { suspended?: boolean } }; blindReconnectAttempts?: number; transportLive: boolean }> }).openCodeRunsByTask;
      const rebuild = (dispatcher as unknown as { rebuildRunsBeforeLive(): Promise<void> }).rebuildRunsBeforeLive.bind(dispatcher);
      const markReconnecting = (dispatcher as unknown as { markRunsReconnecting(): void }).markRunsReconnecting.bind(dispatcher);

      // BLIND_RECONNECT_BOUND is 3 — the first two blind cycles must stay
      // honestly silent: no orphan, no forced resume.
      for (let cycle = 0; cycle < 2; cycle += 1) {
        markReconnecting();
        await rebuild();
        expect(store.get(task.id)?.runState).toBe("running");
        expect(store.listEvents(task.id).map((e) => e.type)).not.toContain("task_watchdog_orphan");
        expect(runs.get(task.id)!.watchdog.snapshot().suspended).toBe(true);
        expect(runs.get(task.id)!.transportLive).toBe(false);
      }

      // Third consecutive blind cycle crosses the bound: fall back to pure
      // liveness-timeout detection instead of staying blind forever.
      markReconnecting();
      await rebuild();

      expect(store.get(task.id)).toMatchObject({ runState: "running" });
      const events = store.listEvents(task.id).map((e) => e.type);
      expect(events).not.toContain("task_watchdog_orphan");
      expect(events).toContain("task_watchdog_blind_recovery");
      expect(runs.get(task.id)!.watchdog.snapshot().suspended).toBe(false);
    });

    it("does not false-orphan a root on an unrecognized/forward-compat status string when the session tree confirms it exists (P3-10 regression)", async () => {
      const activity = new SessionActivityCollector();
      const frames: SessionActivityFrame[] = [];
      const task = createTask({ directory: myProjectDir });
      client.nextSessionId = "ses_unknown_status";
      dispatcher = new TaskDispatcher({ client: client as never, store, activity });
      await dispatcher.run(task.id);
      activity.subscribe(task.id, 0, (frame) => frames.push(frame));

      (dispatcher as unknown as { markRunsReconnecting(): void }).markRunsReconnecting();
      // children() succeeds (root confirmed to exist), but status() reports a
      // forward-compat status string this build doesn't recognize.
      client.childrenResponses.set("ses_unknown_status", []);
      client.sessionStatus = { ses_unknown_status: "quantum-flux" };

      await (dispatcher as unknown as { rebuildRunsBeforeLive(): Promise<void> }).rebuildRunsBeforeLive();

      expect(store.listEvents(task.id).map((e) => e.type)).not.toContain("task_watchdog_orphan");
      expect(store.get(task.id)?.runState).not.toBe("error");
      expect(frames.some((frame) => frame.kind === "heartbeat" && frame.transport === "live")).toBe(true);
    });

    it("does not false-orphan a root when status() fails but the session tree independently confirms it exists (P3-10 regression)", async () => {
      const task = createTask({ directory: myProjectDir });
      client.nextSessionId = "ses_status_down";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);

      (dispatcher as unknown as { markRunsReconnecting(): void }).markRunsReconnecting();
      client.childrenResponses.set("ses_status_down", []);
      client.statusShouldError = { error: { message: "status endpoint down" } };

      await (dispatcher as unknown as { rebuildRunsBeforeLive(): Promise<void> }).rebuildRunsBeforeLive();

      expect(store.listEvents(task.id).map((e) => e.type)).not.toContain("task_watchdog_orphan");
      expect(store.get(task.id)?.runState).not.toBe("error");
      const runs = (dispatcher as unknown as { openCodeRunsByTask: Map<string, { transportLive: boolean }> }).openCodeRunsByTask;
      expect(runs.get(task.id)!.transportLive).toBe(true);
    });

    it("reconciles a root that became idle during a blind reconnect gap without a new event", async () => {
      vi.useFakeTimers();
      const task = createTask({ directory: myProjectDir });
      client.nextSessionId = "ses_blind_idle";
      client.messageResponses = [[{ info: { role: "assistant" }, parts: [{ type: "step-finish", reason: "stop" }] }]];
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);
      (dispatcher as unknown as { markRunsReconnecting(): void }).markRunsReconnecting();
      client.sessionStatus = { ses_blind_idle: { type: "idle" } };

      await (dispatcher as unknown as { rebuildRunsBeforeLive(): Promise<void> }).rebuildRunsBeforeLive();
      await vi.advanceTimersByTimeAsync(1000);

      expect(store.get(task.id)).toMatchObject({ column: "review", runState: "idle", completionSource: "idle-fallback" });
      vi.useRealTimers();
    });

    it("calls reconnect status and children as bound SDK instance methods", async () => {
      const task = createTask({ directory: myProjectDir });
      client.nextSessionId = "ses_bound_root";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);
      const sessionWithThis = client.session as unknown as {
        boundMarker?: true;
        status(): Promise<unknown>;
        children(input: { sessionID: string }): Promise<unknown>;
      };
      sessionWithThis.boundMarker = true;
      sessionWithThis.status = async function status(this: typeof sessionWithThis) {
        if (!this.boundMarker) throw new Error("unbound status");
        return { data: { ses_bound_root: "busy" }, error: undefined };
      };
      sessionWithThis.children = async function children(this: typeof sessionWithThis, input: { sessionID: string }) {
        if (!this.boundMarker) throw new Error("unbound children");
        return { data: input.sessionID === "ses_bound_root" ? [{ info: { id: "ses_bound_child" } }] : [], error: undefined };
      };
      (dispatcher as unknown as { markRunsReconnecting(): void }).markRunsReconnecting();

      await (dispatcher as unknown as { rebuildRunsBeforeLive(): Promise<void> }).rebuildRunsBeforeLive();
      (dispatcher as unknown as { handleEvent(event: OpencodeEvent): void }).handleEvent({ type: "message.part.updated", properties: { sessionID: "ses_bound_child", part: { type: "text", text: "bound child text" } } } as unknown as OpencodeEvent);

      expect(store.get(task.id)?.runState).toBe("running");
    });

    it("only explicit not-found children errors orphan a missing root", async () => {
      const task = createTask({ directory: myProjectDir });
      client.nextSessionId = "ses_missing_root";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);
      client.childrenShouldError = { error: { status: 404, message: "session not found" } };

      await (dispatcher as unknown as { rebuildRunsBeforeLive(): Promise<void> }).rebuildRunsBeforeLive();

      expect(store.get(task.id)).toMatchObject({ runState: "error", error: expect.stringContaining("root session missing") });
      expect(store.listEvents(task.id).map((event) => event.type)).toContain("task_watchdog_orphan");
    });

    it("normalizes SDK message.part.updated tool/retry/text activity without raw bodies or token deltas", async () => {
      const activity = new SessionActivityCollector();
      const frames: SessionActivityFrame[] = [];
      const task = createTask({ directory: myProjectDir });
      client.nextSessionId = "ses_tools";
      dispatcher = new TaskDispatcher({ client: client as never, store, activity });
      await dispatcher.run(task.id);
      activity.subscribe(task.id, 0, (frame) => frames.push(frame));
      const handle = (dispatcher as unknown as { handleEvent(event: OpencodeEvent): void }).handleEvent.bind(dispatcher);

      handle({ type: "message.part.updated", properties: { sessionID: "ses_tools", delta: "t", part: { type: "text", text: "partial token" } } } as unknown as OpencodeEvent);
      handle({ type: "message.part.updated", properties: { sessionID: "ses_tools", part: { type: "text", text: "coalesced text" } } } as unknown as OpencodeEvent);
      handle({ type: "message.part.updated", properties: { sessionID: "ses_tools", part: { type: "tool", tool: "x".repeat(300), callID: "c".repeat(300), state: { status: "pending", input: "SECRET_INPUT" } } } } as unknown as OpencodeEvent);
      handle({ type: "message.part.updated", properties: { sessionID: "ses_tools", part: { type: "tool", tool: "edit", callID: "call-1", state: { status: "running", time: { start: 10, end: 22 }, input: "SECRET_INPUT" } } } } as unknown as OpencodeEvent);
      handle({ type: "message.part.updated", properties: { sessionID: "ses_tools", part: { type: "tool", tool: "edit", callID: "call-1", state: { status: "completed", time: { start: 30, end: 25 }, output: "SECRET_OUTPUT" } } } } as unknown as OpencodeEvent);
      handle({ type: "message.part.updated", properties: { sessionID: "ses_tools", part: { type: "tool", tool: "edit", callID: "call-2", state: { status: "error", time: { start: 1, end: 4 }, error: "SECRET_ERROR" } } } } as unknown as OpencodeEvent);
      handle({ type: "message.part.updated", properties: { sessionID: "ses_tools", part: { type: "retry" } } } as unknown as OpencodeEvent);

      const appendEvents = frames.filter((frame) => frame.kind === "append").map((frame) => frame.event);
      expect(appendEvents.some((event) => event.text === "partial token")).toBe(false);
      expect(appendEvents.some((event) => event.text === "coalesced text")).toBe(true);
      expect(JSON.stringify(appendEvents)).not.toContain("SECRET");
      expect(appendEvents.find((event) => event.kind === "tool" && event.tool?.status === "started")?.tool).toMatchObject({ name: "x".repeat(256), callId: "c".repeat(256), status: "started" });
      expect(appendEvents.find((event) => event.kind === "tool" && event.tool?.status === "running")?.tool).toMatchObject({ name: "edit", callId: "call-1", durationMs: 12 });
      expect(appendEvents.find((event) => event.kind === "tool" && event.tool?.status === "complete")?.tool).toMatchObject({ name: "edit", callId: "call-1", durationMs: 0, outputBytes: "SECRET_OUTPUT".length });
      expect(appendEvents.find((event) => event.kind === "tool" && event.tool?.status === "error")?.tool).toMatchObject({ name: "edit", callId: "call-2", durationMs: 3 });
      expect(appendEvents.some((event) => event.kind === "status" && event.text === "retrying")).toBe(true);
    });

    it("ends the old activity run before binding a watchdog retry replacement", async () => {
      const activity = new SessionActivityCollector();
      const frames: SessionActivityFrame[] = [];
      const task = createTask({ directory: myProjectDir });
      client.nextSessionId = "ses_watchdog_old";
      dispatcher = new TaskDispatcher({ client: client as never, store, activity });
      await dispatcher.run(task.id);
      activity.subscribe(task.id, 0, (frame) => frames.push(frame));

      const firstRunStartedAt = store.get(task.id)?.runStartedAt;
      expect(firstRunStartedAt).toBeTypeOf("number");
      client.nextSessionId = "ses_watchdog_retry";
      await (dispatcher as unknown as {
        applyWatchdogRetryDecision(event: {
          run: { taskId: string; runStartedAt: number; sessionId: string; attempt: number };
          reason: "liveness-timeout";
          decidedAt: number;
          outcome: "retry";
          nextAttempt: number;
        }): Promise<void>;
      }).applyWatchdogRetryDecision({
        run: { taskId: task.id, runStartedAt: firstRunStartedAt!, sessionId: "ses_watchdog_old", attempt: 0 },
        reason: "liveness-timeout",
        decidedAt: Date.now(),
        outcome: "retry",
        nextAttempt: 1,
      });

      const terminalIndex = frames.findIndex((frame) => frame.kind === "terminal" && frame.status === "aborted");
      const retrySnapshotIndex = frames.findIndex((frame) => frame.kind === "snapshot" && frame.run.sessionId === "ses_watchdog_retry");
      expect(terminalIndex).toBeGreaterThan(-1);
      expect(retrySnapshotIndex).toBeGreaterThan(terminalIndex);
      expect(store.get(task.id)).toMatchObject({
        sessionId: "ses_watchdog_retry",
        runState: "running",
        autoRetries: 1,
      });
    });

    it("does not create a watchdog retry writer until old root abort resolves", async () => {
      const task = createTask({ directory: myProjectDir });
      client.nextSessionId = "ses_abort_pending_old";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);
      const runStartedAt = store.get(task.id)?.runStartedAt;
      const gate = deferred<{ data: unknown; error: undefined }>();
      client.abortDeferred = gate;
      client.nextSessionId = "ses_abort_pending_new";

      const retryPromise = (dispatcher as unknown as {
        applyWatchdogRetryDecision(event: { run: { taskId: string; runStartedAt: number; sessionId: string; attempt: number }; reason: "liveness-timeout"; decidedAt: number; outcome: "retry"; nextAttempt: number }): Promise<void>;
      }).applyWatchdogRetryDecision({
        run: { taskId: task.id, runStartedAt: runStartedAt!, sessionId: "ses_abort_pending_old", attempt: 0 },
        reason: "liveness-timeout",
        decidedAt: Date.now(),
        outcome: "retry",
        nextAttempt: 1,
      });

      await Promise.resolve();
      expect(client.abortCalls).toEqual([{ sessionID: "ses_abort_pending_old" }]);
      expect(client.createCalls.map((call) => call.directory)).toHaveLength(1);
      gate.resolve({ data: {}, error: undefined });
      await retryPromise;

      expect(client.createCalls).toHaveLength(2);
      expect(client.createCalls[1]?.directory).toBe(myProjectDir);
      expect(store.get(task.id)).toMatchObject({ sessionId: "ses_abort_pending_new", autoRetries: 1, runState: "running" });
    });

    it("suppresses watchdog abort/retry while an operator permission ask is still within grace", async () => {
      const task = createTask({ isolation: "in-place", permissionOverrides: { bash: "ask" } });
      client.nextSessionId = "ses_watchdog_permission";
      client.stableMessagesResponse = [{ info: { id: "msg1" }, parts: [{ type: "tool", callID: "call1", tool: "bash" }] }];
      client.pendingPermissionRequests = [
        { id: "native_req", sessionID: "ses_watchdog_permission", permission: "bash", tool: { messageID: "msg1", callID: "call1" } },
      ];
      dispatcher = new TaskDispatcher({ client: client as never, store, permissionGraceMs: 60_000, watchdogConfig: { enabled: true, timeoutMs: 60_000, sweepIntervalMs: 0, maxAutomaticRetries: 2 } });

      await dispatcher.run(task.id);
      await waitFor(() => (dispatcher as never as { listPendingPermissions(id: string): unknown[] }).listPendingPermissions(task.id).length === 1);
      const runStartedAt = store.get(task.id)?.runStartedAt;
      const ask = (dispatcher as never as { listPendingPermissions(id: string): Array<{ id: string; deadline: number }> }).listPendingPermissions(task.id)[0]!;

      (dispatcher as unknown as { handleWatchdogTermination(event: { run: { taskId: string; runStartedAt: number; sessionId: string; attempt: number }; reason: "liveness-timeout"; terminatedAt: number }): void }).handleWatchdogTermination({
        run: { taskId: task.id, runStartedAt: runStartedAt!, sessionId: "ses_watchdog_permission", attempt: 0 },
        reason: "liveness-timeout",
        terminatedAt: ask.deadline - 1,
      });

      expect(client.abortCalls).toEqual([]);
      expect(client.createCalls).toHaveLength(1);
      expect(store.get(task.id)?.runState).toBe("running");
      expect(store.listEvents(task.id).find((event) => event.type === "task_watchdog_permission_wait")?.body).toMatchObject({
        askId: ask.id,
        sessionId: "ses_watchdog_permission",
        deadline: ask.deadline,
      });
    });

    it("suppresses the paired onRetryDecision from the same terminate() call during live permission grace (P1 regression)", async () => {
      const task = createTask({ isolation: "in-place", permissionOverrides: { bash: "ask" } });
      client.nextSessionId = "ses_paired";
      client.stableMessagesResponse = [{ info: { id: "msg1" }, parts: [{ type: "tool", callID: "call1", tool: "bash" }] }];
      client.pendingPermissionRequests = [
        { id: "native_req_paired", sessionID: "ses_paired", permission: "bash", tool: { messageID: "msg1", callID: "call1" } },
      ];
      dispatcher = new TaskDispatcher({ client: client as never, store, permissionGraceMs: 60_000, watchdogConfig: { enabled: true, timeoutMs: 60_000, sweepIntervalMs: 0, maxAutomaticRetries: 2 } });

      await dispatcher.run(task.id);
      await waitFor(() => (dispatcher as never as { listPendingPermissions(id: string): unknown[] }).listPendingPermissions(task.id).length === 1);
      const runStartedAt = store.get(task.id)?.runStartedAt;
      const ask = (dispatcher as never as { listPendingPermissions(id: string): Array<{ id: string; deadline: number }> }).listPendingPermissions(task.id)[0]!;

      const dispatcherInternal = dispatcher as unknown as {
        handleWatchdogTermination(event: { run: { taskId: string; runStartedAt: number; sessionId: string; attempt: number }; reason: "liveness-timeout"; terminatedAt: number }): void;
        handleWatchdogRetryDecision(event: { run: { taskId: string; runStartedAt: number; sessionId: string; attempt: number }; reason: "liveness-timeout"; decidedAt: number; outcome: "retry"; nextAttempt: number }): void;
      };

      // Faithfully replay RunWatchdog.terminate()'s synchronous callback
      // contract: onTerminate fires first, then onRetryDecision fires in the
      // same synchronous call — both with the same run identity.
      dispatcherInternal.handleWatchdogTermination({
        run: { taskId: task.id, runStartedAt: runStartedAt!, sessionId: "ses_paired", attempt: 0 },
        reason: "liveness-timeout",
        terminatedAt: ask.deadline - 1,
      });
      dispatcherInternal.handleWatchdogRetryDecision({
        run: { taskId: task.id, runStartedAt: runStartedAt!, sessionId: "ses_paired", attempt: 0 },
        reason: "liveness-timeout",
        decidedAt: ask.deadline - 1,
        outcome: "retry",
        nextAttempt: 1,
      });

      // Give the fire-and-forget applyWatchdogRetryDecision promise a chance to
      // settle so we can prove it no-op'd instead of aborting/starting a writer.
      await new Promise((r) => setTimeout(r, 50));

      const events = store.listEvents(task.id).map((event) => event.type);

      // No abort of the live root session.
      expect(client.abortCalls).toEqual([]);
      // No fresh session/writer created — still the original single create call.
      expect(client.createCalls).toHaveLength(1);
      // The task is still running, not errored or retried.
      expect(store.get(task.id)?.runState).toBe("running");
      // The suppression event was emitted.
      expect(events).toContain("task_watchdog_permission_wait");
      // No retry, fallback, or tripped event leaked through from the paired decision.
      expect(events).not.toContain("task_watchdog_retry");
      expect(events).not.toContain("task_watchdog_fallback");
      expect(events).not.toContain("task_watchdog_tripped");
      // The watchdog was rearmed (a new run record with a fresh watchdog exists).
      const runRecord = (dispatcher as never as { openCodeRunsByTask: Map<string, { watchdog: { snapshot: () => { stage: string } } }> }).openCodeRunsByTask.get(task.id);
      expect(runRecord).toBeDefined();
      expect(runRecord!.watchdog.snapshot().stage).toBe("healthy");
    });

    it("blocks watchdog retry when old root abort fails", async () => {
      const task = createTask({ directory: myProjectDir });
      client.nextSessionId = "ses_abort_failed_old";
      client.abortShouldError = { error: { message: "abort refused" } };
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);
      const runStartedAt = store.get(task.id)?.runStartedAt;
      client.nextSessionId = "ses_abort_failed_new";

      await (dispatcher as unknown as {
        applyWatchdogRetryDecision(event: { run: { taskId: string; runStartedAt: number; sessionId: string; attempt: number }; reason: "liveness-timeout"; decidedAt: number; outcome: "retry"; nextAttempt: number }): Promise<void>;
      }).applyWatchdogRetryDecision({
        run: { taskId: task.id, runStartedAt: runStartedAt!, sessionId: "ses_abort_failed_old", attempt: 0 },
        reason: "liveness-timeout",
        decidedAt: Date.now(),
        outcome: "retry",
        nextAttempt: 1,
      });

      expect(client.createCalls).toHaveLength(1);
      expect(store.get(task.id)).toMatchObject({ runState: "error", error: expect.stringContaining("abort was not confirmed") });
      expect(store.listEvents(task.id).map((event) => event.type)).toContain("task_watchdog_abort_failed");
      expect(store.listEvents(task.id).map((event) => event.type)).toContain("task_watchdog_abort_unconfirmed");
    });

    it("uses fallback only on second retry with a different provider and exhausts on third trip", async () => {
      const task = createTask({ directory: myProjectDir });
      store.update(task.id, { model: { providerID: "primary", id: "p1" }, fallbackModel: { providerID: "fallback", id: "f1" } });
      client.nextSessionId = "ses_retry_0";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);

      for (const [attempt, oldSession, newSession] of [[0, "ses_retry_0", "ses_retry_1"], [1, "ses_retry_1", "ses_retry_2"]] as const) {
        const current = store.get(task.id)!;
        client.nextSessionId = newSession;
        await (dispatcher as unknown as {
          applyWatchdogRetryDecision(event: { run: { taskId: string; runStartedAt: number; sessionId: string; attempt: number }; reason: "liveness-timeout"; decidedAt: number; outcome: "retry"; nextAttempt: number }): Promise<void>;
        }).applyWatchdogRetryDecision({
          run: { taskId: task.id, runStartedAt: current.runStartedAt!, sessionId: oldSession, attempt },
          reason: "liveness-timeout",
          decidedAt: Date.now(),
          outcome: "retry",
          nextAttempt: attempt + 1,
        });
      }
      expect(store.get(task.id)?.activeModel).toEqual({ providerID: "fallback", id: "f1" });
      const second = store.get(task.id)!;
      await (dispatcher as unknown as {
        applyWatchdogRetryDecision(event: { run: { taskId: string; runStartedAt: number; sessionId: string; attempt: number }; reason: "liveness-timeout"; decidedAt: number; outcome: "exhausted" }): Promise<void>;
      }).applyWatchdogRetryDecision({
        run: { taskId: task.id, runStartedAt: second.runStartedAt!, sessionId: "ses_retry_2", attempt: 2 },
        reason: "liveness-timeout",
        decidedAt: Date.now(),
        outcome: "exhausted",
      });

      expect(store.get(task.id)).toMatchObject({ column: "review", runState: "error", completionSource: "watchdog" });
      expect(store.get(task.id)?.completion).toMatchObject({ outcome: "blocked", needsInput: expect.stringContaining("Review the partial") });
      expect(store.listEvents(task.id).map((event) => event.type)).toEqual(expect.arrayContaining(["task_watchdog_retry", "task_watchdog_fallback", "task_watchdog_exhausted"]));
    });

    it("emits task_watchdog_retry (not fallback) when no fallback model is set (P3 regression)", async () => {
      const task = createTask({ directory: myProjectDir });
      // No model, no fallbackModel — both resolve to null.
      client.nextSessionId = "ses_no_fallback";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);

      const current = store.get(task.id)!;
      client.nextSessionId = "ses_no_fallback_retry";
      await (dispatcher as unknown as {
        applyWatchdogRetryDecision(event: { run: { taskId: string; runStartedAt: number; sessionId: string; attempt: number }; reason: "liveness-timeout"; decidedAt: number; outcome: "retry"; nextAttempt: number }): Promise<void>;
      }).applyWatchdogRetryDecision({
        run: { taskId: task.id, runStartedAt: current.runStartedAt!, sessionId: "ses_no_fallback", attempt: 0 },
        reason: "liveness-timeout",
        decidedAt: Date.now(),
        outcome: "retry",
        nextAttempt: 1,
      });

      const events = store.listEvents(task.id).map((event) => event.type);
      expect(events).toContain("task_watchdog_retry");
      expect(events).not.toContain("task_watchdog_fallback");
    });

    it("emits task_watchdog_retry (not fallback) on first retry even with a configured fallback model (P3 regression)", async () => {
      const task = createTask({ directory: myProjectDir });
      store.update(task.id, { model: { providerID: "primary", id: "p1" }, fallbackModel: { providerID: "fallback", id: "f1" } });
      client.nextSessionId = "ses_first_retry";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);

      const current = store.get(task.id)!;
      client.nextSessionId = "ses_first_retry_new";
      await (dispatcher as unknown as {
        applyWatchdogRetryDecision(event: { run: { taskId: string; runStartedAt: number; sessionId: string; attempt: number }; reason: "liveness-timeout"; decidedAt: number; outcome: "retry"; nextAttempt: number }): Promise<void>;
      }).applyWatchdogRetryDecision({
        run: { taskId: task.id, runStartedAt: current.runStartedAt!, sessionId: "ses_first_retry", attempt: 0 },
        reason: "liveness-timeout",
        decidedAt: Date.now(),
        outcome: "retry",
        nextAttempt: 1,
      });

      const events = store.listEvents(task.id).map((event) => event.type);
      expect(events).toContain("task_watchdog_retry");
      expect(events).not.toContain("task_watchdog_fallback");
    });

    it("emits task_watchdog_fallback only on the actual second retry selecting a different-provider fallback (P3 regression)", async () => {
      const task = createTask({ directory: myProjectDir });
      store.update(task.id, { model: { providerID: "primary", id: "p1" }, fallbackModel: { providerID: "fallback", id: "f1" } });
      client.nextSessionId = "ses_fallback_0";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);

      // First retry (nextAttempt=1) — should emit task_watchdog_retry, not fallback.
      const first = store.get(task.id)!;
      client.nextSessionId = "ses_fallback_1";
      await (dispatcher as unknown as {
        applyWatchdogRetryDecision(event: { run: { taskId: string; runStartedAt: number; sessionId: string; attempt: number }; reason: "liveness-timeout"; decidedAt: number; outcome: "retry"; nextAttempt: number }): Promise<void>;
      }).applyWatchdogRetryDecision({
        run: { taskId: task.id, runStartedAt: first.runStartedAt!, sessionId: "ses_fallback_0", attempt: 0 },
        reason: "liveness-timeout",
        decidedAt: Date.now(),
        outcome: "retry",
        nextAttempt: 1,
      });

      // Second retry (nextAttempt=2) with different provider — should emit task_watchdog_fallback.
      const second = store.get(task.id)!;
      client.nextSessionId = "ses_fallback_2";
      await (dispatcher as unknown as {
        applyWatchdogRetryDecision(event: { run: { taskId: string; runStartedAt: number; sessionId: string; attempt: number }; reason: "liveness-timeout"; decidedAt: number; outcome: "retry"; nextAttempt: number }): Promise<void>;
      }).applyWatchdogRetryDecision({
        run: { taskId: task.id, runStartedAt: second.runStartedAt!, sessionId: "ses_fallback_1", attempt: 1 },
        reason: "liveness-timeout",
        decidedAt: Date.now(),
        outcome: "retry",
        nextAttempt: 2,
      });

      const taskEvents = store.listEvents(task.id);
      const events = taskEvents.map((event) => event.type);
      expect(events).toContain("task_watchdog_retry");
      expect(events).toContain("task_watchdog_fallback");
      // Exactly one of each.
      expect(events.filter((e) => e === "task_watchdog_retry")).toHaveLength(1);
      expect(events.filter((e) => e === "task_watchdog_fallback")).toHaveLength(1);
      expect(taskEvents.find((event) => event.type === "task_watchdog_retry")?.body).toEqual(expect.objectContaining({
        attempt: 1,
        runStartedAt: first.runStartedAt,
        sessionId: "ses_fallback_0",
        previousSessionId: "ses_fallback_0",
        model: { providerID: "primary", id: "p1" },
        provider: "primary",
        reason: "liveness-timeout",
        outcome: "retry-starting",
      }));
      expect(taskEvents.find((event) => event.type === "task_watchdog_retry_started")?.body).toEqual(expect.objectContaining({
        attempt: 1,
        sessionId: "ses_fallback_1",
        previousSessionId: "ses_fallback_0",
        nextSessionId: "ses_fallback_1",
        model: { providerID: "primary", id: "p1" },
        provider: "primary",
        reason: "liveness-timeout",
        outcome: "retry-started",
      }));
      expect(taskEvents.find((event) => event.type === "task_watchdog_fallback")?.body).toEqual(expect.objectContaining({
        attempt: 2,
        runStartedAt: second.runStartedAt,
        sessionId: "ses_fallback_1",
        previousSessionId: "ses_fallback_1",
        model: { providerID: "fallback", id: "f1" },
        provider: "fallback",
        reason: "liveness-timeout",
        outcome: "fallback-starting",
      }));
    });

    it("session-create failure on a watchdog retry consumes the next attempt slot and succeeds (P1 regression)", async () => {
      const task = createTask({ directory: myProjectDir });
      client.nextSessionId = "ses_create_fail_0";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);
      const runStartedAt = store.get(task.id)?.runStartedAt;

      // The first watchdog-retry attempt (attempt 1) fails to create a session;
      // the second (attempt 2) succeeds.
      client.createShouldErrorCount = 1;
      client.nextSessionId = "ses_create_fail_2";
      await (dispatcher as unknown as {
        applyWatchdogRetryDecision(event: { run: { taskId: string; runStartedAt: number; sessionId: string; attempt: number }; reason: "liveness-timeout"; decidedAt: number; outcome: "retry"; nextAttempt: number }): Promise<void>;
      }).applyWatchdogRetryDecision({
        run: { taskId: task.id, runStartedAt: runStartedAt!, sessionId: "ses_create_fail_0", attempt: 0 },
        reason: "liveness-timeout",
        decidedAt: Date.now(),
        outcome: "retry",
        nextAttempt: 1,
      });

      // Two create calls were attempted for the retry: the failed attempt 1 and
      // the successful attempt 2.
      expect(client.createCalls).toHaveLength(3);
      // The card is running again on the fresh session, not stranded on the dead one.
      expect(store.get(task.id)).toMatchObject({ sessionId: "ses_create_fail_2", runState: "running", autoRetries: 2 });
      const events = store.listEvents(task.id).map((event) => event.type);
      expect(events).toContain("task_watchdog_retry_failed");
      expect(events).toContain("task_watchdog_retry");
      expect(events).not.toContain("task_watchdog_exhausted");
      // A fresh watchdog is armed on the new run.
      const runRecord = (dispatcher as never as { openCodeRunsByTask: Map<string, { rootSessionId: string; watchdog: { snapshot: () => { stage: string } } }> }).openCodeRunsByTask.get(task.id);
      expect(runRecord?.rootSessionId).toBe("ses_create_fail_2");
      expect(runRecord?.watchdog.snapshot().stage).toBe("healthy");
    });

    it("thrown session-create failures stay inside watchdog recovery instead of escaping fire-and-forget", async () => {
      const task = createTask({ directory: myProjectDir });
      client.nextSessionId = "ses_create_throw_0";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);
      const runStartedAt = store.get(task.id)?.runStartedAt;

      client.createShouldThrowCount = 1;
      client.nextSessionId = "ses_create_throw_2";
      await (dispatcher as unknown as {
        applyWatchdogRetryDecision(event: { run: { taskId: string; runStartedAt: number; sessionId: string; attempt: number }; reason: "liveness-timeout"; decidedAt: number; outcome: "retry"; nextAttempt: number }): Promise<void>;
      }).applyWatchdogRetryDecision({
        run: { taskId: task.id, runStartedAt: runStartedAt!, sessionId: "ses_create_throw_0", attempt: 0 },
        reason: "liveness-timeout",
        decidedAt: Date.now(),
        outcome: "retry",
        nextAttempt: 1,
      });

      expect(store.get(task.id)).toMatchObject({ sessionId: "ses_create_throw_2", runState: "running", autoRetries: 2 });
      expect(store.listEvents(task.id).find((event) => event.type === "task_watchdog_retry_failed")?.body).toMatchObject({
        attempt: 1,
        stage: "session-create",
        error: "session create transport failed",
        outcome: "start-failed",
      });
    });

    it("session-create failure that exhausts the retry budget system-blocks the task (P1 regression)", async () => {
      const task = createTask({ directory: myProjectDir });
      client.nextSessionId = "ses_create_exhaust_0";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);
      const runStartedAt = store.get(task.id)?.runStartedAt;

      // Both remaining automatic-retry attempts (1 and 2) fail to create a session.
      client.createShouldErrorCount = 2;
      await (dispatcher as unknown as {
        applyWatchdogRetryDecision(event: { run: { taskId: string; runStartedAt: number; sessionId: string; attempt: number }; reason: "liveness-timeout"; decidedAt: number; outcome: "retry"; nextAttempt: number }): Promise<void>;
      }).applyWatchdogRetryDecision({
        run: { taskId: task.id, runStartedAt: runStartedAt!, sessionId: "ses_create_exhaust_0", attempt: 0 },
        reason: "liveness-timeout",
        decidedAt: Date.now(),
        outcome: "retry",
        nextAttempt: 1,
      });

      // Only the two failing create calls happened — no third attempt beyond the cap.
      expect(client.createCalls).toHaveLength(3);
      expect(store.get(task.id)).toMatchObject({ column: "review", runState: "error", completionSource: "watchdog" });
      expect(store.get(task.id)?.completion).toMatchObject({ outcome: "blocked", needsInput: expect.stringContaining("Review the partial") });
      const events = store.listEvents(task.id).map((event) => event.type);
      expect(events.filter((e) => e === "task_watchdog_retry_failed")).toHaveLength(2);
      expect(events).toContain("task_watchdog_exhausted");
      // The dangling run record from the aborted root is cleaned up, not left running forever.
      expect((dispatcher as never as { openCodeRunsByTask: Map<string, unknown> }).openCodeRunsByTask.has(task.id)).toBe(false);
    });

    it("prompt-admission failure on a watchdog retry consumes the next attempt slot and succeeds (P2 regression)", async () => {
      const task = createTask({ directory: myProjectDir });
      client.nextSessionId = "ses_prompt_fail_0";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);
      const runStartedAt = store.get(task.id)?.runStartedAt;

      // Attempt 1 creates a session but fails to admit the prompt; attempt 2 succeeds fully.
      client.promptShouldErrorCount = 1;
      client.nextSessionId = "ses_prompt_fail_1";
      await (dispatcher as unknown as {
        applyWatchdogRetryDecision(event: { run: { taskId: string; runStartedAt: number; sessionId: string; attempt: number }; reason: "liveness-timeout"; decidedAt: number; outcome: "retry"; nextAttempt: number }): Promise<void>;
      }).applyWatchdogRetryDecision({
        run: { taskId: task.id, runStartedAt: runStartedAt!, sessionId: "ses_prompt_fail_0", attempt: 0 },
        reason: "liveness-timeout",
        decidedAt: Date.now(),
        outcome: "retry",
        nextAttempt: 1,
      });

      // Two session creates for the retry: attempt 1 (prompt fails) and attempt 2 (succeeds).
      expect(client.createCalls).toHaveLength(3);
      expect(store.get(task.id)).toMatchObject({ sessionId: "ses_prompt_fail_1", runState: "running", autoRetries: 2 });
      const events = store.listEvents(task.id).map((event) => event.type);
      expect(events).toContain("task_watchdog_retry_failed");
      expect(events).not.toContain("task_watchdog_exhausted");
      const runRecord = (dispatcher as never as { openCodeRunsByTask: Map<string, { rootSessionId: string }> }).openCodeRunsByTask.get(task.id);
      expect(runRecord?.rootSessionId).toBe("ses_prompt_fail_1");
    });

    it("prompt-admission failure that exhausts the retry budget system-blocks the task (P2 regression)", async () => {
      const task = createTask({ directory: myProjectDir });
      client.nextSessionId = "ses_prompt_exhaust_0";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);
      const runStartedAt = store.get(task.id)?.runStartedAt;

      // Both remaining automatic-retry attempts (1 and 2) create sessions fine but
      // fail prompt admission every time.
      client.promptShouldErrorCount = 2;
      await (dispatcher as unknown as {
        applyWatchdogRetryDecision(event: { run: { taskId: string; runStartedAt: number; sessionId: string; attempt: number }; reason: "liveness-timeout"; decidedAt: number; outcome: "retry"; nextAttempt: number }): Promise<void>;
      }).applyWatchdogRetryDecision({
        run: { taskId: task.id, runStartedAt: runStartedAt!, sessionId: "ses_prompt_exhaust_0", attempt: 0 },
        reason: "liveness-timeout",
        decidedAt: Date.now(),
        outcome: "retry",
        nextAttempt: 1,
      });

      expect(store.get(task.id)).toMatchObject({ column: "review", runState: "error", completionSource: "watchdog" });
      expect(store.get(task.id)?.completion).toMatchObject({ outcome: "blocked", needsInput: expect.stringContaining("Review the partial") });
      const events = store.listEvents(task.id).map((event) => event.type);
      expect(events.filter((e) => e === "task_watchdog_retry_failed")).toHaveLength(2);
      expect(events).toContain("task_watchdog_exhausted");
      expect((dispatcher as never as { openCodeRunsByTask: Map<string, unknown> }).openCodeRunsByTask.has(task.id)).toBe(false);
    });

    it("same-session retry watcher cleanup cannot tear down the replacement run", async () => {
      vi.useFakeTimers();
      try {
        const task = createTask({ directory: myProjectDir });
        client.nextSessionId = "ses_same_reused";
        client.stableMessagesResponse = [{ info: { role: "assistant" }, parts: [{ type: "tool", callID: "call1", tool: "bash", state: { status: "running" } }] }];
        dispatcher = new TaskDispatcher({ client: client as never, store });

        await dispatcher.run(task.id);
        const firstRunStartedAt = store.get(task.id)?.runStartedAt;
        expect(firstRunStartedAt).toBeTypeOf("number");
        await vi.advanceTimersByTimeAsync(1);
        await dispatcher.retry(task.id, "continue in the same session");
        const retryRunStartedAt = store.get(task.id)?.runStartedAt;
        expect(retryRunStartedAt).toBeGreaterThan(firstRunStartedAt!);

        // Lets the cancelled first watcher wake and run its finally block.
        await vi.advanceTimersByTimeAsync(1000);
        await Promise.resolve();

        const runs = (dispatcher as never as { openCodeRunsByTask: Map<string, { runStartedAt: number; rootSessionId: string }> }).openCodeRunsByTask;
        expect(runs.get(task.id)).toMatchObject({ runStartedAt: retryRunStartedAt, rootSessionId: "ses_same_reused" });
        expect(store.get(task.id)).toMatchObject({ sessionId: "ses_same_reused", runState: "running", runStartedAt: retryRunStartedAt });
      } finally {
        vi.useRealTimers();
      }
    });

    it("empty status map plus active tool messages re-arms before aborting with bounded budget", async () => {
      const task = createTask({ directory: myProjectDir });
      client.nextSessionId = "ses_active_tool_probe";
      client.stableMessagesResponse = [{ info: { role: "assistant" }, parts: [{ type: "tool", callID: "call1", tool: "bash", state: { status: "running" } }] }];
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);
      client.sessionStatus = {};
      const runStartedAt = store.get(task.id)?.runStartedAt;
      const internal = dispatcher as unknown as {
        handleWatchdogTermination(event: { run: { taskId: string; runStartedAt: number; sessionId: string; attempt: number }; reason: "liveness-timeout"; terminatedAt: number }): void;
      };
      const trip = () => internal.handleWatchdogTermination({
        run: { taskId: task.id, runStartedAt: runStartedAt!, sessionId: "ses_active_tool_probe", attempt: 0 },
        reason: "liveness-timeout",
        terminatedAt: Date.now(),
      });

      trip();
      await waitFor(() => store.listEvents(task.id).filter((event) => event.type === "task_watchdog_busy_wait").length === 1);
      expect(client.abortCalls).toEqual([]);
      trip();
      await waitFor(() => store.listEvents(task.id).filter((event) => event.type === "task_watchdog_busy_wait").length === 2);
      expect(client.abortCalls).toEqual([]);
      trip();
      await waitFor(() => store.listEvents(task.id).some((event) => event.type === "task_watchdog_tripped"));
      expect(client.abortCalls).toEqual([{ sessionID: "ses_active_tool_probe" }]);
    });

    it("watchdog trip on a still-busy session tree re-arms instead of aborting (long quiet tool call)", async () => {
      const task = createTask({ directory: myProjectDir });
      client.nextSessionId = "ses_busy_probe";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);
      client.sessionStatus = { ses_busy_probe: "busy" };
      const runStartedAt = store.get(task.id)?.runStartedAt;

      (dispatcher as unknown as {
        handleWatchdogTermination(event: { run: { taskId: string; runStartedAt: number; sessionId: string; attempt: number }; reason: "liveness-timeout"; terminatedAt: number }): void;
      }).handleWatchdogTermination({
        run: { taskId: task.id, runStartedAt: runStartedAt!, sessionId: "ses_busy_probe", attempt: 0 },
        reason: "liveness-timeout",
        terminatedAt: Date.now(),
      });

      await waitFor(() => store.listEvents(task.id).some((event) => event.type === "task_watchdog_busy_wait"));
      expect(client.abortCalls).toEqual([]);
      expect(store.get(task.id)?.runState).toBe("running");
      expect(store.listEvents(task.id).some((event) => event.type === "task_watchdog_tripped")).toBe(false);
    });

    it("busy re-arm budget is bounded: a session wedged in status busy still trips after MAX re-arms", async () => {
      const task = createTask({ directory: myProjectDir });
      client.nextSessionId = "ses_busy_wedged";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);
      client.sessionStatus = { ses_busy_wedged: "busy" };
      const runStartedAt = store.get(task.id)?.runStartedAt;
      const internal = dispatcher as unknown as {
        handleWatchdogTermination(event: { run: { taskId: string; runStartedAt: number; sessionId: string; attempt: number }; reason: "liveness-timeout"; terminatedAt: number }): void;
      };
      const trip = () => internal.handleWatchdogTermination({
        run: { taskId: task.id, runStartedAt: runStartedAt!, sessionId: "ses_busy_wedged", attempt: 0 },
        reason: "liveness-timeout",
        terminatedAt: Date.now(),
      });

      trip();
      await waitFor(() => store.listEvents(task.id).filter((event) => event.type === "task_watchdog_busy_wait").length === 1);
      trip();
      await waitFor(() => store.listEvents(task.id).filter((event) => event.type === "task_watchdog_busy_wait").length === 2);
      trip();
      await waitFor(() => store.listEvents(task.id).some((event) => event.type === "task_watchdog_tripped"));
      expect(client.abortCalls).toEqual([{ sessionID: "ses_busy_wedged" }]);
    });

    it("watchdog trip on an idle session tree aborts without a busy re-arm", async () => {
      const task = createTask({ directory: myProjectDir });
      client.nextSessionId = "ses_idle_probe";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);
      client.sessionStatus = { ses_idle_probe: "idle" };
      const runStartedAt = store.get(task.id)?.runStartedAt;

      (dispatcher as unknown as {
        handleWatchdogTermination(event: { run: { taskId: string; runStartedAt: number; sessionId: string; attempt: number }; reason: "liveness-timeout"; terminatedAt: number }): void;
      }).handleWatchdogTermination({
        run: { taskId: task.id, runStartedAt: runStartedAt!, sessionId: "ses_idle_probe", attempt: 0 },
        reason: "liveness-timeout",
        terminatedAt: Date.now(),
      });

      await waitFor(() => store.listEvents(task.id).some((event) => event.type === "task_watchdog_tripped"));
      expect(store.listEvents(task.id).some((event) => event.type === "task_watchdog_busy_wait")).toBe(false);
      expect(client.abortCalls).toEqual([{ sessionID: "ses_idle_probe" }]);
    });

    it("manual retry resets the breaker surface (autoRetries and fallback activeModel)", async () => {
      const task = createTask({ directory: myProjectDir });
      store.update(task.id, { model: { providerID: "openai", id: "gpt-5.5" } });
      client.nextSessionId = "ses_retry_reset";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);
      // Simulate a prior watchdog fallback escalation left on the record.
      store.update(task.id, { autoRetries: 2, activeModel: { providerID: "openrouter", id: "fallback-model" } });

      await dispatcher.retry(task.id);

      expect(store.get(task.id)).toMatchObject({
        autoRetries: 0,
        activeModel: { providerID: "openai", id: "gpt-5.5" },
        runState: "running",
      });
    });


    it("uses message evidence to keep blocked answers in the same OpenCode session when status is empty", async () => {
      const task = createTask({ directory: myProjectDir });
      client.nextSessionId = "ses_blocked_messages";
      client.stableMessagesResponse = [{ info: { role: "assistant" }, parts: [{ type: "step-finish", reason: "stop" }] }];
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);
      store.move(task.id, "review", 0);
      store.update(task.id, {
        runState: "idle",
        completionSource: "reported",
        completion: { outcome: "blocked", summary: "Need input", changedFiles: [], verification: [], residualRisk: "Pick A or B", reportedAt: 123 },
      });
      client.sessionStatus = {};

      const result = await dispatcher.retry(task.id, "Pick A", { blockedReportedAt: 123, answeredBy: "User" });

      expect(result.blockedAnswerResumeDecision).toEqual({ mode: "same-session", evidence: "messages" });
      expect(client.createCalls).toHaveLength(1);
      expect(client.promptCalls.at(-1)?.sessionID).toBe("ses_blocked_messages");
      expect(store.get(task.id)).toMatchObject({ sessionId: "ses_blocked_messages", runState: "running" });
    });

    it("starts a fresh session for blocked answers when the prior completion is not a reported block", async () => {
      const task = createTask({ directory: myProjectDir });
      client.nextSessionId = "ses_watchdog_old";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);
      store.move(task.id, "review", 0);
      store.update(task.id, {
        runState: "idle",
        completionSource: "watchdog",
        completion: { outcome: "blocked", summary: "Watchdog stopped", changedFiles: [], verification: [], residualRisk: "Review partial work", reportedAt: 123 },
      });
      client.nextSessionId = "ses_watchdog_fresh";

      const result = await dispatcher.retry(task.id, "Continue safely", { blockedReportedAt: 123, answeredBy: "User" });

      expect(result.blockedAnswerResumeDecision).toEqual({ mode: "fresh-session", evidence: "not-resumable" });
      expect(client.createCalls).toHaveLength(2);
      expect(client.promptCalls.at(-1)?.sessionID).toBe("ses_watchdog_fresh");
      expect(store.get(task.id)).toMatchObject({ sessionId: "ses_watchdog_fresh", runState: "running" });
    });

    it("watchdog fresh attempts carry a retry-context preamble naming the prior stalled attempt", async () => {
      const task = createTask({ directory: myProjectDir });
      client.nextSessionId = "ses_preamble_0";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);
      const runStartedAt = store.get(task.id)?.runStartedAt;
      client.nextSessionId = "ses_preamble_1";

      await (dispatcher as unknown as {
        applyWatchdogRetryDecision(event: { run: { taskId: string; runStartedAt: number; sessionId: string; attempt: number }; reason: "liveness-timeout"; decidedAt: number; outcome: "retry"; nextAttempt: number }): Promise<void>;
      }).applyWatchdogRetryDecision({
        run: { taskId: task.id, runStartedAt: runStartedAt!, sessionId: "ses_preamble_0", attempt: 0 },
        reason: "liveness-timeout",
        decidedAt: Date.now(),
        outcome: "retry",
        nextAttempt: 1,
      });

      const retryPrompt = JSON.stringify(client.promptCalls.at(-1)?.parts ?? "");
      expect(retryPrompt).toContain("WATCHDOG RETRY CONTEXT (attempt 1)");
      expect(retryPrompt).toContain("preserve work already done");
      // The original dispatch prompt must NOT carry the preamble.
      expect(JSON.stringify(client.promptCalls[0]?.parts ?? "")).not.toContain("WATCHDOG RETRY CONTEXT");
    });
  });

  describe("run() — worktree write-fencing", () => {
    let gitProjectDir: string;

    beforeEach(() => {
      gitProjectDir = join(workspace, "git-project");
      makeGitRepo(gitProjectDir);
    });

    it("in-place tasks (default isolation) get UNATTENDED_PERMISSION and no permission responder", async () => {
      const task = createTask({ directory: myProjectDir });
      client.nextSessionId = "ses_inplace";
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await dispatcher.run(task.id);

      expect(client.createCalls[0]?.permission).toEqual([{ permission: "*", pattern: "**", action: "allow" }]);
      // Give any (incorrectly-started) responder a chance to poll before asserting it didn't.
      await new Promise((r) => setTimeout(r, 30));
      expect(client.permissionListCalls).toHaveLength(0);
    });

    it("worktree-isolated tasks get WRITE_FENCED_PERMISSION and start a permission responder", async () => {
      const task = createTask({ isolation: "worktree", directory: gitProjectDir });
      client.nextSessionId = "ses_fenced";
      dispatcher = new TaskDispatcher({
        client: client as never,
        store,
        worktreeBaseDir: () => join(workspace, "worktrees"),
      });

      await dispatcher.run(task.id);

      expect(client.createCalls[0]?.permission).toEqual([
        { permission: "*", pattern: "**", action: "allow" },
        { permission: "external_directory", pattern: "**", action: "ask" },
      ]);

      await waitFor(() => client.permissionListCalls.length > 0);
      expect(client.permissionListCalls[0]?.directory).toBe(store.get(task.id)?.worktreePath);
    });

    it("in-place tasks with a permissionOverrides layer non-allow categories after the base allow-all rule", async () => {
      const task = createTask({ permissionOverrides: { edit: "ask", bash: "deny" } });
      client.nextSessionId = "ses_override";
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await dispatcher.run(task.id);

      expect(client.createCalls[0]?.permission).toEqual([
        { permission: "*", pattern: "**", action: "allow" },
        { permission: "edit", pattern: "**", action: "ask" },
        { permission: "bash", pattern: "**", action: "deny" },
      ]);
    });

    it("in-place tasks with an all-allow permissionOverrides produce the same ruleset as no override", async () => {
      const task = createTask({ permissionOverrides: { edit: "allow", bash: "allow", webfetch: "allow" } });
      client.nextSessionId = "ses_allow";
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await dispatcher.run(task.id);

      expect(client.createCalls[0]?.permission).toEqual([{ permission: "*", pattern: "**", action: "allow" }]);
    });

    it("SAFETY: a worktree-isolated task with a permissionOverrides on its row still gets WRITE_FENCED_PERMISSION unchanged", async () => {
      const task = createTask({ isolation: "worktree", directory: gitProjectDir });
      // Simulate an override somehow ending up on a worktree-isolated row (stale
      // isolation flip, direct DB edit, bug elsewhere) — the dispatcher must never
      // honor it once the run is worktree-isolated, regardless of how it got there.
      store.update(task.id, { permissionOverrides: { edit: "allow", bash: "allow", webfetch: "allow" } });
      client.nextSessionId = "ses_fenced_override";
      dispatcher = new TaskDispatcher({
        client: client as never,
        store,
        worktreeBaseDir: () => join(workspace, "worktrees"),
      });

      await dispatcher.run(task.id);

      expect(client.createCalls[0]?.permission).toEqual([
        { permission: "*", pattern: "**", action: "allow" },
        { permission: "external_directory", pattern: "**", action: "ask" },
      ]);
    });

    it("worktree-isolated tasks get the isolation preamble, before parent handoffs and the completion contract", async () => {
      const task = createTask({ isolation: "worktree", directory: gitProjectDir, description: "Fix the widget" });
      client.nextSessionId = "ses_preamble";
      dispatcher = new TaskDispatcher({
        client: client as never,
        store,
        worktreeBaseDir: () => join(workspace, "worktrees"),
      });

      await dispatcher.run(task.id);

      const text = (client.promptCalls[0]?.parts as Array<{ text: string }>)[0]?.text;
      const worktreePath = store.get(task.id)?.worktreePath;
      expect(worktreePath).toBeTruthy();
      expect(text).toContain("OPENBOARD WORKTREE ISOLATION");
      expect(text).toContain(worktreePath!);
      expect(text).not.toContain(gitProjectDir);
      expect(text).toContain("Run edits, tests, builds, and shell commands from cwd using relative paths.");
      expect(text).toContain("Do not use bash, git -C, wc, shell grep, tests, or mutating commands against the original checkout or sibling task worktrees.");
      expect(text).toContain("If the task explicitly asks for read-only outside-cwd inspection, use read/grep/glob/list tools instead of bash.");
      expect(text).toContain("Read context from cwd first: CLAUDE.md, AGENTS.md, README.md, src/..., test/...");
      expect(text).toContain("If an outside-cwd write is denied, switch back to cwd-relative paths or report blocked.");
      expect(text).toContain("Do not try chmod, symlinks, npm install, or temp-dir workarounds");
      expect(text.indexOf("OPENBOARD WORKTREE ISOLATION")).toBeLessThan(text.indexOf("Fix the widget"));
      expect(text.indexOf("Fix the widget")).toBeLessThan(text.indexOf("OPENBOARD COMPLETION CONTRACT"));
    });

    it("in-place tasks get no worktree-isolation preamble", async () => {
      const task = createTask({ directory: myProjectDir, description: "Fix the widget" });
      client.nextSessionId = "ses_no_preamble";
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await dispatcher.run(task.id);

      const text = (client.promptCalls[0]?.parts as Array<{ text: string }>)[0]?.text;
      expect(text).not.toContain("OPENBOARD WORKTREE ISOLATION");
      expect(text).not.toContain("READ-ONLY");
    });

    it("retry() re-injects the worktree-isolation preamble with the live worktree path", async () => {
      const task = createTask({ isolation: "worktree", directory: gitProjectDir, description: "Fix the widget" });
      client.nextSessionId = "ses_preamble_retry";
      dispatcher = new TaskDispatcher({
        client: client as never,
        store,
        worktreeBaseDir: () => join(workspace, "worktrees"),
      });
      await dispatcher.run(task.id);
      const worktreePath = store.get(task.id)?.worktreePath;
      store.move(task.id, "review", 0);
      store.update(task.id, { runState: "idle" });

      await dispatcher.retry(task.id, "keep going");

      const text = (client.promptCalls[1]?.parts as Array<{ text: string }>)[0]?.text;
      expect(text).toContain("OPENBOARD WORKTREE ISOLATION");
      expect(text).toContain(worktreePath!);
      expect(text).not.toContain(gitProjectDir);
      expect(text).toContain("Run edits, tests, builds, and shell commands from cwd using relative paths.");
      expect(text).toContain("Do not use bash, git -C, wc, shell grep, tests, or mutating commands against the original checkout or sibling task worktrees.");
      expect(text).toContain("If the task explicitly asks for read-only outside-cwd inspection, use read/grep/glob/list tools instead of bash.");
      expect(text).toContain("Read context from cwd first: CLAUDE.md, AGENTS.md, README.md, src/..., test/...");
      expect(text).toContain("If an outside-cwd write is denied, switch back to cwd-relative paths or report blocked.");
      expect(text).toContain("Do not try chmod, symlinks, npm install, or temp-dir workarounds");
      expect(text.indexOf("OPENBOARD WORKTREE ISOLATION")).toBeLessThan(text.indexOf("keep going"));
    });

    it("retry()'s preamble reflects the live task record's worktree path, not a value cached from run()-time", async () => {
      // Proves retry() re-reads task.worktreePath from the store at retry-time
      // rather than closing over a stale value from run(). Note this does NOT by
      // itself prove retry() avoids calling ensureWorktree() again — ensureWorktree()
      // short-circuits to the exact same stored value once worktreePath/worktreeBranch
      // are set, so that specific mutation is behaviorally a no-op and this sentinel
      // can't distinguish it (verified live). The next test closes that gap directly
      // by spying on ensureWorktree() itself.
      const task = createTask({ isolation: "worktree", directory: gitProjectDir, description: "Fix the widget" });
      client.nextSessionId = "ses_preamble_retry_record";
      dispatcher = new TaskDispatcher({
        client: client as never,
        store,
        worktreeBaseDir: () => join(workspace, "worktrees"),
      });
      await dispatcher.run(task.id);
      store.move(task.id, "review", 0);
      store.update(task.id, { runState: "idle" });
      const sentinelWorktreePath = join(workspace, "sentinel-worktree-path-from-record");
      mkdirSync(sentinelWorktreePath, { recursive: true });
      store.update(task.id, { worktreePath: sentinelWorktreePath });

      await dispatcher.retry(task.id, "keep going");

      const text = (client.promptCalls[1]?.parts as Array<{ text: string }>)[0]?.text;
      expect(text).toContain(sentinelWorktreePath);
      expect(text).not.toContain(gitProjectDir);
    });

    it("retry() does not call ensureWorktree() again to source the preamble's worktree path", async () => {
      // ensureWorktree() re-cuts a worktree (or, once one exists, only reconfirms
      // it) — retry()'s worktree path must come off the already-persisted
      // task.worktreePath field instead, matching the code's own stated intent.
      const task = createTask({ isolation: "worktree", directory: gitProjectDir, description: "Fix the widget" });
      client.nextSessionId = "ses_preamble_retry_no_ensure";
      dispatcher = new TaskDispatcher({
        client: client as never,
        store,
        worktreeBaseDir: () => join(workspace, "worktrees"),
      });
      await dispatcher.run(task.id);
      store.move(task.id, "review", 0);
      store.update(task.id, { runState: "idle" });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ensureWorktreeSpy = vi.spyOn(dispatcher as any, "ensureWorktree");

      await dispatcher.retry(task.id, "keep going");

      expect(ensureWorktreeSpy).not.toHaveBeenCalled();
    });

    it("retry() gets no worktree-isolation preamble for an in-place task", async () => {
      const task = createTask({ directory: myProjectDir, description: "Fix the widget" });
      client.nextSessionId = "ses_no_preamble_retry";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);
      store.move(task.id, "review", 0);
      store.update(task.id, { runState: "idle" });

      await dispatcher.retry(task.id, "keep going");

      const text = (client.promptCalls[1]?.parts as Array<{ text: string }>)[0]?.text;
      expect(text).not.toContain("OPENBOARD WORKTREE ISOLATION");
    });

    it("retry() restarts the permission responder for a worktree-isolated task", async () => {
      const task = createTask({ isolation: "worktree", directory: gitProjectDir });
      client.nextSessionId = "ses_fenced_retry";
      dispatcher = new TaskDispatcher({
        client: client as never,
        store,
        worktreeBaseDir: () => join(workspace, "worktrees"),
      });
      await dispatcher.run(task.id);
      store.move(task.id, "review", 0);
      store.update(task.id, { runState: "idle" });
      client.permissionListCalls = [];

      await dispatcher.retry(task.id, "keep going");

      await waitFor(() => client.permissionListCalls.length > 0);
      expect(client.permissionListCalls[0]?.directory).toBe(store.get(task.id)?.worktreePath);
    });

    it("a persistently failing permission-responder list() call surfaces a task_warning event", async () => {
      const task = createTask({ isolation: "worktree", directory: gitProjectDir });
      client.nextSessionId = "ses_fenced_failing";
      client.permissionListShouldErrorCount = 3;
      dispatcher = new TaskDispatcher({
        client: client as never,
        store,
        worktreeBaseDir: () => join(workspace, "worktrees"),
      });

      await dispatcher.run(task.id);
      // Let it fail a few times, then recover (permissionListShouldErrorCount
      // is exhausted after 3 calls) and keep polling normally. Default poll
      // interval is 250ms, so 5 ticks needs real time to elapse.
      await waitFor(() => client.permissionListCalls.length >= 5, 3000);

      const events = store.listEvents(task.id).filter((e) => e.type === "task_warning");
      expect(events).toHaveLength(1);
      expect(String(events[0]?.body.warning)).toContain("Permission auto-responder list call is failing");
    });

    it("dispatcher registers concurrent worktree-isolated tasks with the same responder pool", async () => {
      // permission-responder.test.ts proves a single pool serves multiple
      // registered targets from one shared loop; this proves the dispatcher
      // actually registers both sessions with its one pool instance rather
      // than needing (or creating) a second one.
      const gitProjectDir2 = join(workspace, "git-project-2");
      makeGitRepo(gitProjectDir2);
      const taskA = createTask({ isolation: "worktree", directory: gitProjectDir, title: "Task A" });
      const taskB = createTask({ isolation: "worktree", directory: gitProjectDir2, title: "Task B" });
      dispatcher = new TaskDispatcher({
        client: client as never,
        store,
        worktreeBaseDir: () => join(workspace, "worktrees"),
      });

      client.nextSessionId = "ses_a";
      await dispatcher.run(taskA.id);
      client.nextSessionId = "ses_b";
      await dispatcher.run(taskB.id);

      const dirA = store.get(taskA.id)?.worktreePath;
      const dirB = store.get(taskB.id)?.worktreePath;
      await waitFor(
        () =>
          client.permissionListCalls.some((c) => c.directory === dirA) &&
          client.permissionListCalls.some((c) => c.directory === dirB),
      );

      expect(client.permissionListCalls.some((c) => c.directory === dirA)).toBe(true);
      expect(client.permissionListCalls.some((c) => c.directory === dirB)).toBe(true);
    });

    it("abort() stops the permission responder for a worktree-isolated task", async () => {
      const task = createTask({ isolation: "worktree", directory: gitProjectDir });
      client.nextSessionId = "ses_fenced_abort";
      dispatcher = new TaskDispatcher({
        client: client as never,
        store,
        worktreeBaseDir: () => join(workspace, "worktrees"),
      });
      await dispatcher.run(task.id);
      await waitFor(() => client.permissionListCalls.length > 0);

      await dispatcher.abort(task.id);
      const countAtAbort = client.permissionListCalls.length;

      await new Promise((r) => setTimeout(r, 300));
      expect(client.permissionListCalls.length).toBe(countAtAbort);
    });

    it("a normal idle-fallback completion stops the permission responder", async () => {
      const task = createTask({ isolation: "worktree", directory: gitProjectDir });
      client.nextSessionId = "ses_fenced_idle";
      dispatcher = new TaskDispatcher({
        client: client as never,
        store,
        worktreeBaseDir: () => join(workspace, "worktrees"),
      });
      await dispatcher.run(task.id);
      await waitFor(() => client.permissionListCalls.length > 0);

      client.messageResponses = [
        [
          {
            info: { role: "assistant" },
            parts: [{ type: "step-finish", reason: "stop" }],
          },
        ],
      ];
      await waitFor(() => store.get(task.id)?.column === "review", 3000);
      const countAtCompletion = client.permissionListCalls.length;

      // If the responder were still polling, this would keep growing.
      await new Promise((r) => setTimeout(r, 300));
      expect(client.permissionListCalls.length).toBe(countAtCompletion);
    });

    it("an agent-reported completion (runState flipped outside the dispatcher) stops the permission responder", async () => {
      // Mirrors what src/server/routes/completion.ts does on POST /complete or
      // /block: it flips runState directly on the store, with no reference to
      // the dispatcher or its permissionResponders map at all. The dispatcher's
      // own watchCompletion loop must be the one to notice and stop the
      // responder — this simulates that path without wiring up the full route.
      const task = createTask({ isolation: "worktree", directory: gitProjectDir });
      client.nextSessionId = "ses_fenced_reported";
      dispatcher = new TaskDispatcher({
        client: client as never,
        store,
        worktreeBaseDir: () => join(workspace, "worktrees"),
      });
      await dispatcher.run(task.id);
      await waitFor(() => client.permissionListCalls.length > 0);

      store.update(task.id, { runState: "idle", completionSource: "reported" });
      store.move(task.id, "review", 0);

      // Give the watcher's next poll tick a chance to observe the state
      // change and stop the responder.
      await new Promise((r) => setTimeout(r, 1300));
      const countAfterSettle = client.permissionListCalls.length;

      await new Promise((r) => setTimeout(r, 300));
      expect(client.permissionListCalls.length).toBe(countAfterSettle);
    });
  });

  describe("base-checkout escape detection", () => {
    let gitProjectDir: string;

    beforeEach(() => {
      gitProjectDir = join(workspace, "git-project-escape");
      makeGitRepo(gitProjectDir);
    });

    function queueFinishedTurn(sessionSlot = 0) {
      const responses: unknown[][] = [];
      responses[sessionSlot] = [
        {
          info: { role: "assistant" },
          parts: [{ type: "step-finish", reason: "stop" }],
        },
      ];
      client.messageResponses = responses;
    }

    it("blocks a worktree task at completion when the base checkout was mutated during the run", async () => {
      const task = createTask({ isolation: "worktree", directory: gitProjectDir });
      client.nextSessionId = "ses_escape";
      dispatcher = new TaskDispatcher({
        client: client as never,
        store,
        worktreeBaseDir: () => join(workspace, "worktrees-escape"),
      });

      await dispatcher.run(task.id);
      expect(store.get(task.id)?.baseCheckoutSnapshot).toBe("");

      // Simulate a bash-based escape: a write that lands directly in the base
      // checkout, bypassing the worktree entirely (no permission ask at all).
      writeFileSync(join(gitProjectDir, "escaped.txt"), "escaped write\n");

      queueFinishedTurn();
      await waitFor(() => store.get(task.id)?.runState !== "running", 3000);

      const blocked = store.get(task.id);
      expect(blocked?.column).toBe("in_progress");
      expect(blocked?.pending).toBe("base-checkout-escape");
      expect(blocked?.escapeDetectedPaths).toEqual(["escaped.txt"]);
      expect(blocked?.runState).toBe("idle");
    });

    it("uses isolationAtDispatch when blocking an escaped OpenCode run", async () => {
      const task = createTask({ isolation: "worktree", directory: gitProjectDir });
      client.nextSessionId = "ses_escape_isolation_snapshot";
      dispatcher = new TaskDispatcher({
        client: client as never,
        store,
        worktreeBaseDir: () => join(workspace, "worktrees-escape-default-drift"),
      });

      await dispatcher.run(task.id);
      expect(store.get(task.id)?.isolationAtDispatch).toBe("worktree");

      writeFileSync(join(gitProjectDir, "escaped-after-default-flip.txt"), "escaped write\n");

      queueFinishedTurn();
      await waitFor(() => store.get(task.id)?.runState !== "running", 3000);

      const blocked = store.get(task.id);
      expect(blocked?.column).toBe("in_progress");
      expect(blocked?.pending).toBe("base-checkout-escape");
      expect(blocked?.escapeDetectedPaths).toEqual(["escaped-after-default-flip.txt"]);
    });

    it("blocks a Claude Code worktree task at idle fallback when the base checkout was mutated", async () => {
      const task = store.create({ isolation: "worktree",
        title: "Claude isolated escape",
        description: "mutate base",
        directory: gitProjectDir,
        harness: "claude-code",
      });
      const claudeRunner = makeClaudeRunner();
      claudeRunner.poll.mockResolvedValue({ status: "idle", error: undefined, terminal: true });
      dispatcher = new TaskDispatcher({
        client: client as never,
        store,
        claudeRunner,
        worktreeBaseDir: () => join(workspace, "worktrees-claude-escape"),
      });

      await dispatcher.run(task.id);
      expect(store.get(task.id)?.isolationAtDispatch).toBe("worktree");
      writeFileSync(join(gitProjectDir, "claude-escaped.txt"), "escaped write\n");

      await waitFor(() => store.get(task.id)?.runState !== "running", 3000);

      const blocked = store.get(task.id);
      expect(blocked?.column).toBe("in_progress");
      expect(blocked?.pending).toBe("base-checkout-escape");
      expect(blocked?.escapeDetectedPaths).toEqual(["claude-escaped.txt"]);
      expect(blocked?.completionSource).toBeNull();
    });

    it("does not treat a Claude-managed worktreePath on an in-place task as a base-checkout escape", async () => {
      const claudeWorktree = join(workspace, "claude-managed-worktree");
      execFileSync("git", ["worktree", "add", "-b", "claude/self-isolated", claudeWorktree, "HEAD"], {
        cwd: gitProjectDir,
        env: cleanGitEnv(),
      });
      const task = store.create({
        title: "Claude in-place self isolate",
        description: "self isolate",
        directory: gitProjectDir,
        harness: "claude-code",
        isolation: "in-place",
      });
      const claudeRunner = makeClaudeRunner();
      claudeRunner.poll.mockResolvedValue({
        status: "idle",
        error: undefined,
        terminal: true,
        cwd: claudeWorktree,
      });
      dispatcher = new TaskDispatcher({ client: client as never, store, claudeRunner });

      await dispatcher.run(task.id);
      expect(store.get(task.id)?.isolationAtDispatch).toBe("in-place");
      writeFileSync(join(gitProjectDir, "expected-in-place-base-write.txt"), "expected\n");

      await waitFor(() => store.get(task.id)?.column === "review", 3000);

      const finished = store.get(task.id);
      expect(finished?.pending).toBeUndefined();
      expect(finished?.worktreePath).toBe(claudeWorktree);
      expect(finished?.completionSource).toBe("idle-fallback");
    });

    it("a normal worktree task (base checkout untouched) still reaches review", async () => {
      const task = createTask({ isolation: "worktree", directory: gitProjectDir });
      client.nextSessionId = "ses_clean";
      dispatcher = new TaskDispatcher({
        client: client as never,
        store,
        worktreeBaseDir: () => join(workspace, "worktrees-escape"),
      });

      await dispatcher.run(task.id);

      queueFinishedTurn();
      await waitFor(() => store.get(task.id)?.column === "review", 3000);

      const finished = store.get(task.id);
      expect(finished?.column).toBe("review");
      expect(finished?.pending).toBeUndefined();
      expect(finished?.completionSource).toBe("idle-fallback");
    });

    it("integrate() refuses when the base checkout escaped and succeeds when clean", async () => {
      const task = createTask({ isolation: "worktree", directory: gitProjectDir });
      client.nextSessionId = "ses_integrate_escape";
      dispatcher = new TaskDispatcher({
        client: client as never,
        store,
        worktreeBaseDir: () => join(workspace, "worktrees-escape"),
      });

      const ran = await dispatcher.run(task.id);
      const wtPath = ran.worktreePath!;
      writeFileSync(join(wtPath, "feature.txt"), "work\n");
      execFileSync("git", ["add", "feature.txt"], { cwd: wtPath, env: cleanGitEnv() });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "--no-gpg-sign", "-m", "feature"], {
        cwd: wtPath,
        env: cleanGitEnv(),
      });

      // integrate() refuses to run against a still-running session (TOCTOU
      // guard), so let the run reach its normal idle/review completion first
      // — Integrate is only ever reachable from the UI once idle anyway.
      queueFinishedTurn();
      await waitFor(() => store.get(task.id)?.runState !== "running", 3000);

      writeFileSync(join(gitProjectDir, "escaped.txt"), "escaped write\n");

      const blockedOutcome = await dispatcher.integrate(task.id);
      expect(blockedOutcome.ok).toBe(false);
      expect(blockedOutcome.conflict).toBe(false);
      expect(blockedOutcome.message).toContain("escaped.txt");
      expect(store.get(task.id)?.pending).toBe("base-checkout-escape");
      expect(store.get(task.id)?.worktreePath).toBe(wtPath);

      // Clean up the escape and retry — integrate should now succeed.
      execFileSync("rm", [join(gitProjectDir, "escaped.txt")]);
      store.update(task.id, { pending: undefined, escapeDetectedPaths: undefined });

      const okOutcome = await dispatcher.integrate(task.id);
      expect(okOutcome.ok).toBe(true);
      expect(store.get(task.id)?.worktreePath).toBeUndefined();
    });

    it("integrate() emits exactly one full blocked acceptance evidence event", async () => {
      const task = createTask({ isolation: "worktree", directory: gitProjectDir });
      client.nextSessionId = "ses_integrate_blocked";
      dispatcher = new TaskDispatcher({
        client: client as never,
        store,
        worktreeBaseDir: () => join(workspace, "worktrees-blocked-integrate"),
      });

      const ran = await dispatcher.run(task.id);
      const wtPath = ran.worktreePath!;
      writeFileSync(join(wtPath, "blocked.txt"), "accepted partial work\n");
      execFileSync("git", ["add", "blocked.txt"], { cwd: wtPath, env: cleanGitEnv() });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "--no-gpg-sign", "-m", "blocked partial"], { cwd: wtPath, env: cleanGitEnv() });
      queueFinishedTurn();
      await waitFor(() => store.get(task.id)?.runState !== "running", 3000);
      store.setCompletion(task.id, { outcome: "blocked", summary: "Partial work exists", changedFiles: ["blocked.txt"], verification: [], residualRisk: "Need human acceptance", needsInput: "Accept incomplete work?", reportedAt: 99 }, "reported");

      const outcome = await dispatcher.integrate(task.id, undefined, { blockedAcceptance: { acceptIncomplete: true, blockedReportedAt: 99 } });

      expect(outcome.ok).toBe(true);
      const events = store.listEvents(task.id).filter((event) => event.type === "task_blocked_accepted");
      expect(events).toHaveLength(1);
      expect(events[0]?.body).toEqual({
        completedBy: "Integrated by User",
        blockedReportedAt: 99,
        question: "Accept incomplete work?",
        summary: "Partial work exists",
        residualRisk: "Need human acceptance",
        transition: "integrate",
      });
    });

    it("a sibling worktree task created after this task's dispatch does not falsely block it (concurrent nested worktrees)", async () => {
      const taskA = createTask({ isolation: "worktree", directory: gitProjectDir, title: "Task A" });
      // Nest worktrees inside the repo (the isUnderWorkspace fallback layout,
      // not the sibling-outside-the-repo default) — the real bug only fires
      // in this layout.
      dispatcher = new TaskDispatcher({
        client: client as never,
        store,
        worktreeBaseDir: () => join(gitProjectDir, ".opencode-board-worktrees", "repo"),
      });

      client.nextSessionId = "ses_task_a";
      await dispatcher.run(taskA.id); // taskA's baseCheckoutSnapshot is captured now.

      const taskB = createTask({ isolation: "worktree", directory: gitProjectDir, title: "Task B" });
      client.nextSessionId = "ses_task_b";
      await dispatcher.run(taskB.id); // taskB's worktree appears after A's snapshot.

      // Both sessions finish their turn; whichever poll consumes an entry
      // first, both get an equivalent finished response.
      const finishedTurn = { info: { role: "assistant" }, parts: [{ type: "step-finish", reason: "stop" }] };
      client.messageResponses = [[finishedTurn], [finishedTurn]];

      await waitFor(() => store.get(taskA.id)?.runState !== "running" && store.get(taskB.id)?.runState !== "running", 3000);

      expect(store.get(taskA.id)?.column).toBe("review");
      expect(store.get(taskA.id)?.pending).toBeUndefined();
      expect(store.get(taskB.id)?.column).toBe("review");
      expect(store.get(taskB.id)?.pending).toBeUndefined();
    });

    it("still catches a base-checkout escape when the task's directory is a repo subdirectory, not the root", async () => {
      // git status / git worktree list both report root-relative paths and
      // the repo root itself regardless of invocation cwd — if the task's
      // directory (a repo subdirectory here) is used unnormalized, the real
      // root leaks into the "registered worktree" exclusion list and every
      // changed path reads as "inside" it: escaped:false unconditionally,
      // no matter what actually changed at the true root.
      const subdir = join(gitProjectDir, "subdir");
      mkdirSync(subdir, { recursive: true });
      writeFileSync(join(subdir, "nested.txt"), "nested\n");
      execFileSync("git", ["add", "-A"], { cwd: gitProjectDir, env: cleanGitEnv() });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "--no-gpg-sign", "-m", "add subdir"], {
        cwd: gitProjectDir,
        env: cleanGitEnv(),
      });

      const task = createTask({ isolation: "worktree", directory: subdir });
      client.nextSessionId = "ses_subdir_escape";
      dispatcher = new TaskDispatcher({
        client: client as never,
        store,
        worktreeBaseDir: () => join(workspace, "worktrees-escape-subdir"),
      });

      await dispatcher.run(task.id);

      // The escape lands at the true repo ROOT, not inside the task's
      // subdirectory — exactly the shape a bash escape targeting an absolute
      // base-checkout path would produce.
      writeFileSync(join(gitProjectDir, "escaped-from-root.txt"), "escaped write at root\n");

      queueFinishedTurn();
      await waitFor(() => store.get(task.id)?.runState !== "running", 3000);

      const blocked = store.get(task.id);
      expect(blocked?.column).toBe("in_progress");
      expect(blocked?.pending).toBe("base-checkout-escape");
      expect(blocked?.escapeDetectedPaths).toEqual(["escaped-from-root.txt"]);
    });
  });

  describe("stall detection and recovery nudges", () => {
    let gitProjectDir: string;

    beforeEach(() => {
      gitProjectDir = join(workspace, "git-project-stall");
      makeGitRepo(gitProjectDir);
    });

    const toolRunning = {
      info: { role: "assistant" },
      parts: [{ type: "tool", tool: "bash", state: { status: "running" } }],
    };
    const stuckAfterToolCalls = {
      info: { role: "assistant" },
      parts: [
        { type: "tool", tool: "bash", state: { status: "success" } },
        { type: "step-finish", reason: "tool-calls" },
      ],
    };
    const finishedTurn = {
      info: { role: "assistant" },
      parts: [{ type: "step-finish", reason: "stop" }],
    };

    it("never nudges a genuinely still-running tool call (no false positive on a long tool execution)", async () => {
      const task = createTask({ directory: gitProjectDir });
      client.nextSessionId = "ses_running_tool";
      client.stableMessagesResponse = [toolRunning];
      dispatcher = new TaskDispatcher({
        client: client as never,
        store,
        worktreeBaseDir: () => join(workspace, "worktrees-stall"),
        stallThresholdMs: 10,
        permissionGraceMs: 0,
      });

      await dispatcher.run(task.id);
      await new Promise((r) => setTimeout(r, 2500));

      expect(client.promptCalls).toHaveLength(1); // only the original dispatch prompt
      expect(store.get(task.id)?.runState).toBe("running");
    });

    it("nudges with denial-aware guidance when the permission-responder recorded a recent deny", async () => {
      const task = createTask({ isolation: "worktree", directory: gitProjectDir });
      client.nextSessionId = "ses_stall_denial";
      // A tool part the permission-responder can resolve (call_1 -> apply_patch)
      // and deny (not read-class), matched by the same messages() the
      // completion watcher's stall check observes.
      client.stableMessagesResponse = [
        {
          info: { id: "msg_1", role: "assistant" },
          parts: [
            { type: "tool", callID: "call_1", tool: "apply_patch", state: { status: "error" } },
            { type: "step-finish", reason: "tool-calls" },
          ],
        },
      ];
      client.pendingPermissionRequests = [
        { id: "req_1", sessionID: "ses_stall_denial", tool: { messageID: "msg_1", callID: "call_1" } },
      ];
      dispatcher = new TaskDispatcher({
        client: client as never,
        store,
        worktreeBaseDir: () => join(workspace, "worktrees-stall"),
        stallThresholdMs: 10,
        permissionGraceMs: 0,
      });

      await dispatcher.run(task.id);
      await waitFor(() => client.promptCalls.length > 1, 3000);

      const nudgeText = String((client.promptCalls[1]?.parts as Array<{ text?: string }>)?.[0]?.text ?? "");
      expect(nudgeText).toContain("apply_patch");
      expect(nudgeText).toContain("outside your assigned working directory");

      const warnings = store.listEvents(task.id).filter((e) => e.type === "task_warning");
      expect(warnings.length).toBeGreaterThan(0);
      expect(String(warnings[0]?.body.warning)).toContain("apply_patch");
    });

    it("resets the futile-nudge streak on progress, so recovering after a nudge reaches review normally", async () => {
      const task = createTask({ directory: gitProjectDir });
      client.nextSessionId = "ses_stall_recover";
      client.stableMessagesResponse = [stuckAfterToolCalls];
      dispatcher = new TaskDispatcher({
        client: client as never,
        store,
        worktreeBaseDir: () => join(workspace, "worktrees-stall"),
        stallThresholdMs: 10,
        permissionGraceMs: 0,
      });

      await dispatcher.run(task.id);
      await waitFor(() => client.promptCalls.length > 1, 3000); // one nudge sent

      // Simulate recovery: the agent continues and finishes normally.
      client.stableMessagesResponse = null;
      client.messageResponses = [[finishedTurn], [finishedTurn], [finishedTurn]];

      await waitFor(() => store.get(task.id)?.column === "review", 3000);

      expect(store.get(task.id)?.runState).not.toBe("error");
      expect(client.promptCalls).toHaveLength(2); // dispatch + exactly one nudge, no more
    });

    it("gives up after MAX_CONSECUTIVE_FUTILE_NUDGES with a generic message when no denial was recorded", async () => {
      const task = createTask({ directory: gitProjectDir });
      client.nextSessionId = "ses_stall_giveup";
      client.stableMessagesResponse = [stuckAfterToolCalls]; // never changes — no recovery, no known denial
      dispatcher = new TaskDispatcher({
        client: client as never,
        store,
        worktreeBaseDir: () => join(workspace, "worktrees-stall"),
        stallThresholdMs: 10,
        permissionGraceMs: 0,
      });

      await dispatcher.run(task.id);
      await waitFor(() => store.get(task.id)?.runState === "error", 5000);

      expect(client.promptCalls).toHaveLength(3); // dispatch + 2 nudges, then give up
      expect(store.get(task.id)?.error).toContain("2 automatic recovery nudges");
      expect(store.get(task.id)?.error).toContain("no permission denial was recorded");

      const warnings = store.listEvents(task.id).filter((e) => e.type === "task_warning");
      expect(warnings).toHaveLength(2);
    });

    it("gives up citing the denial when the session never recovers after a denial-aware nudge", async () => {
      const task = createTask({ isolation: "worktree", directory: gitProjectDir });
      client.nextSessionId = "ses_stall_giveup_denial";
      client.stableMessagesResponse = [
        {
          info: { id: "msg_1", role: "assistant" },
          parts: [
            { type: "tool", callID: "call_1", tool: "apply_patch", state: { status: "error" } },
            { type: "step-finish", reason: "tool-calls" },
          ],
        },
      ];
      client.pendingPermissionRequests = [
        { id: "req_1", sessionID: "ses_stall_giveup_denial", tool: { messageID: "msg_1", callID: "call_1" } },
      ];
      dispatcher = new TaskDispatcher({
        client: client as never,
        store,
        worktreeBaseDir: () => join(workspace, "worktrees-stall"),
        stallThresholdMs: 10,
        permissionGraceMs: 0,
      });

      await dispatcher.run(task.id);
      await waitFor(() => store.listEvents(task.id).some((event) => event.type === "task_permission_answered"), 3000);
      await waitFor(() => store.get(task.id)?.runState === "error", 5000);

      expect(store.get(task.id)?.error).toContain("apply_patch");
      expect(store.get(task.id)?.error).toContain("did not recover on its own");
    });
  });

  describe("start() — event-driven auto-transitions", () => {
    it("uses session.idle as a completion check trigger, not a direct review move", async () => {
      vi.useFakeTimers();
      const task = createTask();
      client.nextSessionId = "ses_live";
      client.messageResponses = [
        [
          {
            info: { role: "assistant" },
            parts: [{ type: "step-finish", reason: "tool-calls" }],
          },
        ],
        [
          {
            info: { role: "assistant" },
            parts: [{ type: "step-finish", reason: "stop" }],
          },
        ],
      ];
      dispatcher = new TaskDispatcher({ client: client as never, store });
      const ran = await dispatcher.run(task.id);
      expect(ran.column).toBe("in_progress");

      client.queueScript([
        {
          id: "evt_1",
          type: "session.idle",
          properties: { sessionID: "ses_live" },
        } as unknown as OpencodeEvent,
      ]);

      dispatcher.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(store.get(task.id)?.column).toBe("in_progress");
      expect(store.get(task.id)?.runState).toBe("running");

      await vi.advanceTimersByTimeAsync(1000);
      expect(store.get(task.id)?.column).toBe("in_progress");
      expect(store.get(task.id)?.runState).toBe("running");

      await vi.advanceTimersByTimeAsync(1000);

      const updated = store.get(task.id);
      expect(updated?.column).toBe("review");
      expect(updated?.runState).toBe("idle");
      expect(updated?.completion).toBeNull();
      expect(updated?.completionSource).toBe("idle-fallback");
      vi.useRealTimers();
    });

    it("does not clobber a reported completion when the idle watcher observes the run later", async () => {
      vi.useFakeTimers();
      const task = createTask();
      client.nextSessionId = "ses_reported";
      client.messageResponses = [
        [
          {
            info: { role: "assistant" },
            parts: [{ type: "step-finish", reason: "stop" }],
          },
        ],
      ];
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);
      const report = {
        outcome: "complete" as const,
        summary: "reported done",
        changedFiles: ["a.ts"],
        verification: [{ command: "npm test", result: "passed" }],
        residualRisk: "none",
        reportedAt: 123,
      };
      store.setCompletion(task.id, report, "reported");
      store.update(task.id, { runState: "idle" });
      store.move(task.id, "review", 0);

      await vi.advanceTimersByTimeAsync(1000);

      expect(store.get(task.id)?.completion).toEqual(report);
      expect(store.get(task.id)?.completionSource).toBe("reported");
      expect(store.get(task.id)?.column).toBe("review");
      vi.useRealTimers();
    });

    it("sets runState 'running' on a running-signal event without moving the task", async () => {
      const task = createTask();
      client.nextSessionId = "ses_running";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);

      client.queueScript([
        {
          id: "evt_1",
          type: "session.next.step.started",
          properties: { sessionID: "ses_running" },
        } as unknown as OpencodeEvent,
      ]);

      dispatcher.start();

      await waitFor(() => {
        const t = store.get(task.id);
        return t?.runState === "running";
      });

      const updated = store.get(task.id);
      expect(updated?.runState).toBe("running");
      expect(updated?.column).toBe("in_progress");
    });

    it("sets runState 'error' and records the message on a session.error event", async () => {
      const task = createTask();
      client.nextSessionId = "ses_err";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);

      client.queueScript([
        {
          id: "evt_1",
          type: "session.error",
          properties: {
            sessionID: "ses_err",
            error: { name: "UnknownError", data: { message: "Something broke" } },
          },
        } as unknown as OpencodeEvent,
      ]);

      dispatcher.start();

      await waitFor(() => store.get(task.id)?.runState === "error");

      const updated = store.get(task.id);
      expect(updated?.runState).toBe("error");
      expect(updated?.error).toBeTruthy();
      // Error event does not auto-move the card.
      expect(updated?.column).toBe("in_progress");
    });

    it("sets runState 'error' via step.failed event", async () => {
      const task = createTask();
      client.nextSessionId = "ses_step_fail";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);

      client.queueScript([
        {
          id: "evt_1",
          type: "session.next.step.failed",
          properties: { sessionID: "ses_step_fail" },
        } as unknown as OpencodeEvent,
      ]);

      dispatcher.start();

      await waitFor(() => store.get(task.id)?.runState === "error");
      expect(store.get(task.id)?.runState).toBe("error");
    });

    it("does not auto-review on intermediate tool-call step finishes", async () => {
      vi.useFakeTimers();
      const task = createTask();
      client.nextSessionId = "ses_watch";
      client.messageResponses = [
        [
          {
            info: { role: "assistant" },
            parts: [{ type: "step-finish", reason: "tool-calls" }],
          },
        ],
        [
          {
            info: { role: "assistant" },
            parts: [{ type: "step-finish", reason: "stop" }],
          },
        ],
      ];
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await dispatcher.run(task.id);

      await vi.advanceTimersByTimeAsync(1000);
      expect(store.get(task.id)?.column).toBe("in_progress");
      expect(store.get(task.id)?.runState).toBe("running");

      await vi.advanceTimersByTimeAsync(1000);
      expect(store.get(task.id)?.column).toBe("review");
      expect(store.get(task.id)?.runState).toBe("idle");
      vi.useRealTimers();
    });

    it("ignores events for sessions with no linked task", async () => {
      client.queueScript([
        {
          id: "evt_1",
          type: "session.idle",
          properties: { sessionID: "ses_unlinked" },
        } as unknown as OpencodeEvent,
      ]);

      dispatcher = new TaskDispatcher({ client: client as never, store });
      dispatcher.start();

      // Give the loop a tick to process the (ignored) event; nothing should throw
      // and no tasks should exist/change.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(store.list()).toEqual([]);
    });

    it("does not re-move a task already past in_progress (e.g. already in review)", async () => {
      vi.useFakeTimers();
      const task = createTask();
      client.nextSessionId = "ses_already_review";
      client.messageResponses = [
        [
          {
            info: { role: "assistant" },
            parts: [{ type: "step-finish", reason: "stop" }],
          },
        ],
      ];
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);

      // Simulate the task having already been moved on to 'done' by a user/other flow.
      store.move(task.id, "done", 0);

      client.queueScript([
        {
          id: "evt_1",
          type: "session.idle",
          properties: { sessionID: "ses_already_review" },
        } as unknown as OpencodeEvent,
      ]);

      dispatcher.start();

      await vi.advanceTimersByTimeAsync(1000);

      // runState still updates, but the column must not be forced back to review.
      expect(store.get(task.id)?.column).toBe("done");
      expect(store.get(task.id)?.runState).toBe("idle");
      vi.useRealTimers();
    });

    it("auto-reconnects with backoff after the stream ends, and keeps handling events", async () => {
      vi.useFakeTimers();
      const task = createTask();
      client.nextSessionId = "ses_reconnect";
      client.messageResponses = [
        [
          {
            info: { role: "assistant" },
            parts: [{ type: "step-finish", reason: "stop" }],
          },
        ],
      ];
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);

      // First "connection" yields nothing and ends; second connection delivers idle.
      client.queueScript([]);
      client.queueScript([
        {
          id: "evt_1",
          type: "session.idle",
          properties: { sessionID: "ses_reconnect" },
        } as unknown as OpencodeEvent,
      ]);

      dispatcher.start();

      // Let the first (empty) stream resolve.
      await vi.advanceTimersByTimeAsync(0);
      // Advance past the reconnect backoff delay.
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);

      expect(client.subscribeCallCount).toBeGreaterThanOrEqual(2);
      expect(store.get(task.id)?.column).toBe("review");
      vi.useRealTimers();
    });

    it("aborts an idle upstream subscription on shutdown instead of leaving it to linger (P3-9 regression)", async () => {
      const task = createTask();
      client.nextSessionId = "ses_abort_upstream";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);

      // Never yields or completes on its own — only shutdown()'s abort can end it.
      client.hangSubscribe = true;
      dispatcher.start();
      await waitFor(() => client.subscribeCallCount > 0);
      expect(client.lastSubscribeSignal?.aborted).toBe(false);

      const loopPromise = (dispatcher as unknown as { consumeLoopPromise: Promise<void> | null }).consumeLoopPromise;
      expect(loopPromise).not.toBeNull();
      dispatcher.shutdown();

      expect(client.lastSubscribeSignal?.aborted).toBe(true);
      // The old consume loop must actually exit (not hang forever holding the
      // upstream stream open) once shutdown() aborts it.
      await expect(
        Promise.race([
          loopPromise,
          new Promise((_resolve, reject) => setTimeout(() => reject(new Error("consume loop did not exit after shutdown")), 500)),
        ]),
      ).resolves.toBeUndefined();
    });

    it("persists the latest useful text-ended event as finalSessionOutput", async () => {
      vi.useFakeTimers();
      const task = createTask();
      client.nextSessionId = "ses_output_cap";
      client.messageResponses = [
        [
          {
            info: { role: "assistant" },
            parts: [{ type: "step-finish", reason: "stop" }],
          },
        ],
      ];
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);

      client.queueScript([
        {
          id: "evt_text_1",
          type: "session.next.text.ended",
          properties: {
            sessionID: "ses_output_cap",
            assistantMessageID: "msg_useful",
            textID: "txt_useful",
            text: "The bug was in foo.ts line 42.\nI fixed it by updating the parameter type.",
          },
        } as unknown as OpencodeEvent,
        {
          id: "evt_text_2",
          type: "session.next.text.ended",
          properties: {
            sessionID: "ses_output_cap",
            assistantMessageID: "msg_report",
            textID: "txt_report",
            text: "Task complete. Here's the handoff:\n\n---\nSTEP COMPLETE: implementation",
          },
        } as unknown as OpencodeEvent,
        {
          id: "evt_1",
          type: "session.idle",
          properties: { sessionID: "ses_output_cap" },
        } as unknown as OpencodeEvent,
      ]);

      dispatcher.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);

      const updated = store.get(task.id);
      expect(updated?.runState).toBe("idle");
      expect(updated?.finalSessionOutput).toBe(
        "The bug was in foo.ts line 42.\nI fixed it by updating the parameter type.",
      );
      vi.useRealTimers();
    });

    it("falls back to the latest useful assistant message when the final message is a report wrapper", async () => {
      vi.useFakeTimers();
      const task = createTask();
      client.nextSessionId = "ses_output_scan";
      client.messageResponses = [
        [
          {
            info: { role: "assistant" },
            parts: [
              { type: "text", text: "I found the issue in dispatcher.ts and verified the fix." },
              { type: "step-finish", reason: "stop" },
            ],
          },
          {
            info: { role: "assistant" },
            parts: [
              { type: "text", text: "Audit complete. Reported via `/complete`.\n\n## Summary\nHandoff metadata." },
              { type: "step-finish", reason: "stop" },
            ],
          },
        ],
      ];
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);

      client.queueScript([
        {
          id: "evt_1",
          type: "session.idle",
          properties: { sessionID: "ses_output_scan" },
        } as unknown as OpencodeEvent,
      ]);

      dispatcher.start();
      await vi.advanceTimersByTimeAsync(1000);

      expect(store.get(task.id)?.finalSessionOutput).toBe(
        "I found the issue in dispatcher.ts and verified the fix.",
      );
      vi.useRealTimers();
    });

    it("stores null finalSessionOutput when the last assistant message has no text parts", async () => {
      vi.useFakeTimers();
      const task = createTask();
      client.nextSessionId = "ses_no_text";
      client.messageResponses = [
        [
          {
            info: { role: "assistant" },
            parts: [{ type: "step-finish", reason: "stop" }],
          },
        ],
      ];
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);

      client.queueScript([
        {
          id: "evt_1",
          type: "session.idle",
          properties: { sessionID: "ses_no_text" },
        } as unknown as OpencodeEvent,
      ]);

      dispatcher.start();
      await vi.advanceTimersByTimeAsync(1000);

      expect(store.get(task.id)?.finalSessionOutput).toBeNull();
      vi.useRealTimers();
    });

    it("leaves finalSessionOutput as null for claude-code tasks", async () => {
      const task = store.create({
        title: "Claude output",
        description: "Claude work",
        directory: projectDir,
        harness: "claude-code",
      });
      const claudeRunner = makeClaudeRunner();
      claudeRunner.poll.mockResolvedValue({ status: "idle", error: undefined, terminal: true });
      dispatcher = new TaskDispatcher({ client: client as never, store, claudeRunner });
      await dispatcher.run(task.id);

      // Give the Claude watcher one poll cycle.
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const updated = store.get(task.id);
      expect(updated?.runState).toBe("idle");
      expect(updated?.finalSessionOutput).toBeNull();
    });
  });

  describe("retry()", () => {
    it("prompts the existing session with feedback and moves back to in_progress", async () => {
      const task = createTask();
      client.nextSessionId = "ses_retry";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);
      store.move(task.id, "review", 0);
      store.update(task.id, { runState: "idle" });

      const result = await dispatcher.retry(task.id, "Please also fix the typo");

      expect(client.promptCalls[client.promptCalls.length - 1]).toMatchObject({
        sessionID: "ses_retry",
      });
      expect(client.promptCalls[client.promptCalls.length - 1]?.parts).toEqual([
        { type: "text", text: expect.stringContaining("Please also fix the typo") },
      ]);
      expect(result.runState).toBe("running");
      expect(result.column).toBe("in_progress");
    });

    it("falls back to task.description when no feedback is given", async () => {
      const task = createTask({ description: "Original description" });
      client.nextSessionId = "ses_retry2";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);

      await dispatcher.retry(task.id);

      expect(client.promptCalls[client.promptCalls.length - 1]).toMatchObject({
        sessionID: "ses_retry2",
      });
      expect(client.promptCalls[client.promptCalls.length - 1]?.parts).toEqual([
        { type: "text", text: expect.stringContaining("Original description") },
      ]);
    });

    it("clears stale completion when retrying", async () => {
      const task = createTask();
      client.nextSessionId = "ses_retry_clear";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);
      store.setCompletion(
        task.id,
        {
          outcome: "blocked",
          summary: "old block",
          changedFiles: [],
          verification: [],
          residualRisk: "old risk",
          reportedAt: 1,
        },
        "reported",
      );
      store.update(task.id, { finalSessionOutput: "old output text" });

      await dispatcher.retry(task.id, "try again");

      expect(store.get(task.id)?.completion).toBeNull();
      expect(store.get(task.id)?.completionSource).toBeNull();
      expect(store.get(task.id)?.finalSessionOutput).toBeNull();
    });

    it("answered agent-reported blocked retry reuses the same OpenCode session when status map contains idle", async () => {
      const task = createTask();
      store.update(task.id, { sessionId: "ses_live", baseCommit: "original-base", baseCheckoutSnapshot: "original-snapshot" });
      store.setCompletion(task.id, { outcome: "blocked", summary: "Need input", changedFiles: [], verification: [], residualRisk: "Which option?", reportedAt: 10 }, "reported");
      client.sessionStatus = { ses_live: "idle" };
      dispatcher = new TaskDispatcher({ client: client as never, store });

      const result = await dispatcher.retry(task.id, "Use option A", { blockedReportedAt: 10, answeredBy: "Reviewer" });

      expect(client.statusCalls).toBe(1);
      expect(client.createCalls).toHaveLength(0);
      expect(client.promptCalls.at(-1)).toMatchObject({ sessionID: "ses_live" });
      expect(String((client.promptCalls.at(-1)?.parts as Array<{ text: string }>)[0]?.text)).toContain("OPERATOR ANSWER TO BLOCKED QUESTION");
      expect(result.sessionId).toBe("ses_live");
      expect(store.get(task.id)?.baseCommit).toBe("original-base");
      expect(store.get(task.id)?.baseCheckoutSnapshot).toBe("original-snapshot");
      expect(store.get(task.id)?.completion).toBeNull();
    });

    it("answered blocked retry reuses the same session from message evidence when OpenCode status is absent", async () => {
      for (const [label, sessionStatus] of Object.entries({ missing: {} })) {
        store.close();
        store = new SqliteTaskStore(":memory:");
        client = new FakeOpencodeClient();
        const worktreePath = join(projectDir, `wt-${label}`);
        mkdirSync(worktreePath, { recursive: true });
        const task = createTask({ isolation: "worktree" });
        store.update(task.id, { sessionId: "ses_old", worktreePath, baseCommit: "original-base", baseCheckoutSnapshot: `original-snapshot-${label}` });
        store.setCompletion(task.id, { outcome: "blocked", summary: "Need input", changedFiles: [], verification: [], residualRisk: "Which option?", reportedAt: 20 }, "reported");
        client.sessionStatus = sessionStatus;
        client.nextSessionId = `ses_new_${label}`;
        dispatcher = new TaskDispatcher({ client: client as never, store });

        const result = await dispatcher.retry(task.id, "Use option B", { blockedReportedAt: 20, answeredBy: "Reviewer" });

        expect(client.statusCalls).toBe(1);
        expect(client.createCalls).toHaveLength(0);
        expect(client.promptCalls.at(-1)).toMatchObject({ sessionID: "ses_old" });
        expect(result.sessionId).toBe("ses_old");
        expect(result.blockedAnswerResumeDecision).toEqual({ mode: "same-session", evidence: "messages" });
        expect(store.get(task.id)?.baseCommit).toBe("original-base");
        expect(store.get(task.id)?.baseCheckoutSnapshot).toBe(`original-snapshot-${label}`);
        expect(store.get(task.id)?.completion).toBeNull();
      }
    });

    it("bounds a hanging status probe and continues with message evidence", async () => {
      const task = createTask();
      store.update(task.id, { sessionId: "ses_hanging_status", baseCommit: "original-base" });
      store.setCompletion(task.id, { outcome: "blocked", summary: "Need input", changedFiles: [], verification: [], residualRisk: "Which option?", reportedAt: 20 }, "reported");
      client.statusNeverResolves = true;
      client.stableMessagesResponse = [];
      dispatcher = new TaskDispatcher({ client: client as never, store, blockedResumeProbeTimeoutMs: 10 });

      const result = await Promise.race([
        dispatcher.retry(task.id, "Use option B", { blockedReportedAt: 20, answeredBy: "Reviewer" }),
        new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 200)),
      ]);

      expect(result).not.toBe("timed-out");
      expect(result).toMatchObject({
        sessionId: "ses_hanging_status",
        blockedAnswerResumeDecision: { mode: "same-session", evidence: "messages" },
      });
      expect(client.statusCalls).toBe(1);
      expect(client.abortCalls).toEqual([]);
      expect(client.createCalls).toHaveLength(0);
    });

    it("answered watchdog blocked retry starts fresh even when the old session is busy", async () => {
      const worktreePath = join(projectDir, "wt-watchdog");
      mkdirSync(worktreePath, { recursive: true });
      const task = createTask({ isolation: "worktree" });
      store.update(task.id, { sessionId: "ses_watchdog", worktreePath, baseCommit: "original-base" });
      store.setCompletion(task.id, { outcome: "blocked", summary: "Watchdog blocked", changedFiles: [], verification: [], residualRisk: "Need review", reportedAt: 21 }, "watchdog");
      client.sessionStatus = { ses_watchdog: "busy" };
      client.nextSessionId = "ses_watchdog_fresh";
      dispatcher = new TaskDispatcher({ client: client as never, store });

      const result = await dispatcher.retry(task.id, "Continue", { blockedReportedAt: 21, answeredBy: "Reviewer" });

      expect(client.statusCalls).toBe(0);
      expect(client.createCalls).toHaveLength(1);
      expect(client.createCalls[0]?.directory).toBe(worktreePath);
      expect(client.promptCalls.at(-1)).toMatchObject({ sessionID: "ses_watchdog_fresh" });
      expect(result.sessionId).toBe("ses_watchdog_fresh");
    });

    it("fences the old session before falling back fresh when resume eligibility probes time out", async () => {
      const task = createTask();
      store.update(task.id, { sessionId: "ses_stalled", baseCommit: "original-base" });
      store.setCompletion(task.id, { outcome: "blocked", summary: "Need input", changedFiles: [], verification: [], residualRisk: "Which option?", reportedAt: 25 }, "reported");
      client.sessionStatus = {};
      client.messagesNeverResolves = true;
      client.childrenNeverResolves = true;
      client.nextSessionId = "ses_fresh_after_probe_timeout";
      dispatcher = new TaskDispatcher({ client: client as never, store, blockedResumeProbeTimeoutMs: 10 });

      const result = await Promise.race([
        dispatcher.retry(task.id, "Use option B", { blockedReportedAt: 25, answeredBy: "Reviewer" }),
        new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 200)),
      ]);

      expect(result).not.toBe("timed-out");
      expect(result).toMatchObject({
        sessionId: "ses_fresh_after_probe_timeout",
        blockedAnswerResumeDecision: { mode: "fresh-session", evidence: "not-resumable" },
      });
      expect(client.abortCalls).toEqual([{ sessionID: "ses_stalled" }]);
      expect(client.createCalls).toHaveLength(1);
      expect(client.promptCalls.at(-1)).toMatchObject({ sessionID: "ses_fresh_after_probe_timeout" });
    });

    it("does not start a fresh writer when an inconclusive blocked-answer session cannot be fenced", async () => {
      const task = createTask();
      store.move(task.id, "review", 0);
      store.update(task.id, { sessionId: "ses_unfenced", runState: "idle", baseCommit: "original-base" });
      store.setCompletion(task.id, { outcome: "blocked", summary: "Need input", changedFiles: [], verification: [], residualRisk: "Which option?", reportedAt: 26 }, "reported");
      client.sessionStatus = {};
      client.messagesNeverResolves = true;
      client.childrenNeverResolves = true;
      client.abortShouldError = { error: { message: "abort refused" } };
      client.nextSessionId = "ses_must_not_start";
      dispatcher = new TaskDispatcher({ client: client as never, store, blockedResumeProbeTimeoutMs: 10 });

      await expect(dispatcher.retry(task.id, "Use option B", { blockedReportedAt: 26, answeredBy: "Reviewer" })).rejects.toMatchObject({
        code: "opencode_unreachable",
        message: expect.stringContaining("blocked report was preserved"),
      });

      expect(client.abortCalls).toEqual([{ sessionID: "ses_unfenced" }]);
      expect(client.createCalls).toHaveLength(0);
      expect(store.get(task.id)).toMatchObject({
        column: "review",
        sessionId: "ses_unfenced",
        runState: "idle",
        completionSource: "reported",
        completion: { outcome: "blocked", reportedAt: 26 },
      });
    });

    it("bounds a hanging blocked-answer fence and preserves the reported block", async () => {
      const task = createTask();
      store.move(task.id, "review", 0);
      store.update(task.id, { sessionId: "ses_abort_hangs", runState: "idle" });
      store.setCompletion(task.id, { outcome: "blocked", summary: "Need input", changedFiles: [], verification: [], residualRisk: "Which option?", reportedAt: 27 }, "reported");
      client.sessionStatus = {};
      client.messagesNeverResolves = true;
      client.childrenNeverResolves = true;
      client.abortDeferred = deferred();
      client.nextSessionId = "ses_must_not_start_after_abort_timeout";
      dispatcher = new TaskDispatcher({ client: client as never, store, blockedResumeProbeTimeoutMs: 10 });

      await expect(dispatcher.retry(task.id, "Use option B", { blockedReportedAt: 27, answeredBy: "Reviewer" })).rejects.toMatchObject({
        code: "opencode_unreachable",
        message: expect.stringContaining("blocked report was preserved"),
      });

      expect(client.abortCalls).toEqual([{ sessionID: "ses_abort_hangs" }]);
      expect(client.createCalls).toHaveLength(0);
      expect(store.get(task.id)).toMatchObject({
        column: "review",
        sessionId: "ses_abort_hangs",
        runState: "idle",
        completionSource: "reported",
        completion: { outcome: "blocked", reportedAt: 27 },
      });
    });

    it("answered blocked retry prompt failure retains the current block", async () => {
      const task = createTask();
      store.update(task.id, { sessionId: "ses_live" });
      store.setCompletion(task.id, { outcome: "blocked", summary: "Need input", changedFiles: [], verification: [], residualRisk: "Which option?", reportedAt: 30 }, "reported");
      client.sessionStatus = { ses_live: "busy" };
      client.promptShouldError = { error: { message: "prompt failed" } };
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await expect(dispatcher.retry(task.id, "Use option C", { blockedReportedAt: 30, answeredBy: "Reviewer" })).rejects.toMatchObject({ code: "opencode_unreachable" });

      expect(store.get(task.id)?.completion).toMatchObject({ outcome: "blocked", reportedAt: 30 });
      expect(store.get(task.id)?.completionSource).toBe("reported");
    });

    it("answered ACP retry launch failure retains the current block", async () => {
      const task = store.create({ title: "Claude blocked", description: "Original", directory: projectDir, harness: "claude-code" });
      store.setCompletion(task.id, { outcome: "blocked", summary: "Need input", changedFiles: [], verification: [], residualRisk: "Which option?", reportedAt: 40 }, "reported");
      const claudeRunner = makeClaudeRunner();
      claudeRunner.retry.mockRejectedValueOnce(new Error("launch failed"));
      dispatcher = new TaskDispatcher({ client: client as never, store, claudeRunner });

      await expect(dispatcher.retry(task.id, "Use option D", { blockedReportedAt: 40, answeredBy: "Reviewer" })).rejects.toMatchObject({ code: "opencode_unreachable" });

      expect(store.get(task.id)?.completion).toMatchObject({ outcome: "blocked", reportedAt: 40 });
      expect(store.get(task.id)?.completionSource).toBe("reported");
    });

    it("relaunches claude-code tasks through the Claude runner retry hook", async () => {
      const task = store.create({
        title: "Claude retry",
        description: "Original Claude work",
        directory: projectDir,
        harness: "claude-code",
        agent: "plan",
      });
      store.move(task.id, "review", 0);
      store.update(task.id, {
        runState: "idle",
        harnessSessionId: "old-claude-session",
        harnessSessionName: "old-claude-name",
      });
      const claudeRunner = makeClaudeRunner();
      dispatcher = new TaskDispatcher({ client: client as never, store, claudeRunner });

      const result = await dispatcher.retry(task.id, "Retry in Claude");

      expect(client.promptCalls).toHaveLength(0);
      expect(claudeRunner.retry).toHaveBeenCalledWith({
        task: expect.objectContaining({ id: task.id, harness: "claude-code" }),
        directory: projectDir,
        prompt: "Retry in Claude",
        runStartedAt: expect.any(Number),
      });
      expect(result).toMatchObject({
        column: "in_progress",
        runState: "running",
        harnessSessionId: "claude-session-2",
        harnessSessionName: "openboard-task-claude-retry",
      });
    });

    it("throws AdapterError.notFound when the task doesn't exist", async () => {
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await expect(dispatcher.retry("task_missing")).rejects.toMatchObject({
        code: "session_not_found",
      });
    });

    it("throws 409 and does not prompt when the task is archived", async () => {
      const task = createTask();
      store.update(task.id, { sessionId: "ses_archived" });
      store.setArchived(task.id, true);
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await expect(dispatcher.retry(task.id, "try again")).rejects.toMatchObject({
        code: "validation",
        status: 409,
        message: "Cannot retry an archived task",
      });
      expect(client.promptCalls).toHaveLength(0);
    });
  });

  describe("abort()", () => {
    it("calls client.session.abort with the task's sessionID", async () => {
      const task = createTask();
      client.nextSessionId = "ses_abort";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);

      await dispatcher.abort(task.id);

      expect(client.abortCalls).toEqual([{ sessionID: "ses_abort" }]);
    });

    it("is a no-op when the task has no linked session", async () => {
      const task = createTask();
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await dispatcher.abort(task.id);

      expect(client.abortCalls).toEqual([]);
    });

    it("aborts claude-code tasks through the Claude runner", async () => {
      const task = store.create({
        title: "Claude abort",
        description: "Stop Claude",
        directory: projectDir,
        harness: "claude-code",
      });
      store.update(task.id, {
        runState: "running",
        harnessSessionName: "openboard-task-claude",
        harnessStatus: "running",
      });
      const claudeRunner = makeClaudeRunner();
      dispatcher = new TaskDispatcher({ client: client as never, store, claudeRunner });

      await dispatcher.abort(task.id);

      expect(client.abortCalls).toEqual([]);
      expect(claudeRunner.abort).toHaveBeenCalledWith("openboard-task-claude");
      expect(store.get(task.id)).toMatchObject({
        runState: "idle",
        harnessStatus: "aborted",
      });
    });

    it("is a no-op when the task doesn't exist", async () => {
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await expect(dispatcher.abort("task_missing")).resolves.toBeUndefined();
    });
  });

  describe("shutdown()", () => {
    it("stops consuming further events", async () => {
      vi.useFakeTimers();
      const task = createTask();
      client.nextSessionId = "ses_shutdown";
      client.messageResponses = [
        [
          {
            info: { role: "assistant" },
            parts: [{ type: "step-finish", reason: "stop" }],
          },
        ],
      ];
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);

      client.queueScript([]);
      dispatcher.start();
      await vi.advanceTimersByTimeAsync(10);

      dispatcher.shutdown();

      // A second start() after shutdown should be able to begin a fresh generation.
      client.queueScript([
        {
          id: "evt_1",
          type: "session.idle",
          properties: { sessionID: "ses_shutdown" },
        } as unknown as OpencodeEvent,
      ]);
      dispatcher.start();

      await vi.advanceTimersByTimeAsync(1000);
      expect(store.get(task.id)?.column).toBe("review");
      vi.useRealTimers();
    });
  });

  describe("multi-parent and multi-child dependencies", () => {
    it("injects all multiple parent handoffs into the prompt", async () => {
      const p1 = createTask({ title: "Parent alpha", description: "" });
      const p2 = createTask({ title: "Parent beta", description: "" });
      const child = createTask({ title: "Child", description: "child work" });
      store.addLink(p1.id, child.id);
      store.addLink(p2.id, child.id);
      store.update(p1.id, {
        worktreePath: `/tmp/openboard-test/worktrees/${p1.id}`,
        worktreeBranch: `board/${p1.id}`,
      });
      store.update(p2.id, {
        worktreePath: `/tmp/openboard-test/worktrees/${p2.id}`,
        worktreeBranch: `board/${p2.id}`,
      });
      store.setCompletion(
        p1.id,
        {
          outcome: "complete",
          summary: "alpha summary",
          changedFiles: ["src/alpha.ts"],
          verification: [{ command: "npm test", result: "passed" }],
          residualRisk: "none",
          reportedAt: 1,
        },
        "reported",
      );
      store.setCompletion(
        p2.id,
        {
          outcome: "complete",
          summary: "beta summary",
          changedFiles: ["src/beta.ts"],
          verification: [],
          residualRisk: "low",
          reportedAt: 2,
        },
        "reported",
      );
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await dispatcher.run(child.id);

      const text = (client.promptCalls[0]?.parts as Array<{ text: string }>)[0]?.text;
      expect(text).toContain("PARENT CONTEXT");
      const alphaLabel = text.includes("PARENT-000: Parent alpha") ? "PARENT-000" : "PARENT-001";
      const betaLabel = alphaLabel === "PARENT-000" ? "PARENT-001" : "PARENT-000";
      expect(text).toContain(`${alphaLabel}: Parent alpha`);
      expect(text).toContain(`${alphaLabel} SUMMARY: alpha summary`);
      expect(text).toContain(`${betaLabel}: Parent beta`);
      expect(text).toContain(`${betaLabel} SUMMARY: beta summary`);
      expect(text).toContain(`${betaLabel} Residual risk: low`);
      expect(text).toContain(`${alphaLabel} WORKTREE: /tmp/openboard-test/worktrees/${p1.id}`);
      expect(text).toContain(`${alphaLabel} TASK ID: ${p1.id}`);
      expect(text).toContain(`${alphaLabel} BRANCH: board/${p1.id}`);
      expect(text).toContain("- src/alpha.ts");
      expect(text).toContain(`${betaLabel} WORKTREE: /tmp/openboard-test/worktrees/${p2.id}`);
      expect(text).toContain(`${betaLabel} TASK ID: ${p2.id}`);
      expect(text).toContain(`${betaLabel} BRANCH: board/${p2.id}`);
      expect(text).toContain("- src/beta.ts");
      expect(text.match(/If a parent changed file also exists in your cwd/g)).toHaveLength(1);
      // Completion contract should come after all parent context.
      expect(text.lastIndexOf("PARENT CONTEXT")).toBeLessThan(
        text.indexOf("OPENBOARD COMPLETION CONTRACT"),
      );
    });

    it("injects parent handoffs that include a mix of structured reports and manual Done parents", async () => {
      const p1 = createTask({ title: "Structured parent" });
      const p2 = createTask({ title: "Manual parent" });
      const child = createTask({ description: "child work" });
      store.addLink(p1.id, child.id);
      store.addLink(p2.id, child.id);
      store.setCompletion(
        p1.id,
        {
          outcome: "complete",
          summary: "structured summary",
          changedFiles: [],
          verification: [],
          residualRisk: "none",
          reportedAt: 1,
        },
        "reported",
      );
      store.move(p2.id, "done", 0);
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await dispatcher.run(child.id);

      const text = (client.promptCalls[0]?.parts as Array<{ text: string }>)[0]?.text;
      const structuredLabel = text.includes("PARENT-000: Structured parent") ? "PARENT-000" : "PARENT-001";
      expect(text).toContain(`${structuredLabel} SUMMARY: structured summary`);
      expect(text).toContain("No structured handoff exists; parent is manually marked Done.");
    });

    it("rejects run when any of multiple parents is unsatisfied", async () => {
      const satisfied = createTask({ title: "Done parent" });
      const unsatisfied = createTask({ title: "Running parent" });
      const child = createTask({ title: "Child" });
      store.addLink(satisfied.id, child.id);
      store.addLink(unsatisfied.id, child.id);
      store.move(satisfied.id, "done", 0);
      store.update(unsatisfied.id, { runState: "running" });
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await expect(dispatcher.run(child.id)).rejects.toMatchObject({
        status: 409,
        unmetParents: [{ id: unsatisfied.id, title: "Running parent", why: "parent is still running" }],
      });
      expect(client.createCalls).toHaveLength(0);
    });

    it("allows run when all of multiple parents are satisfied", async () => {
      const p1 = createTask({ title: "P1" });
      const p2 = createTask({ title: "P2" });
      const p3 = createTask({ title: "P3" });
      const child = createTask({ title: "Child" });
      store.addLink(p1.id, child.id);
      store.addLink(p2.id, child.id);
      store.addLink(p3.id, child.id);
      store.move(p1.id, "done", 0);
      store.move(p2.id, "done", 0);
      store.move(p3.id, "done", 0);
      dispatcher = new TaskDispatcher({ client: client as never, store });

      const result = await dispatcher.run(child.id);
      expect(result.column).toBe("in_progress");
      expect(result.runState).toBe("running");
      expect(client.createCalls).toHaveLength(1);
    });

    it("allows run when parent is satisfied via completion report in review column", async () => {
      const parent = createTask({ title: "Reported parent" });
      const child = createTask({ title: "Child" });
      store.addLink(parent.id, child.id);
      store.setCompletion(
        parent.id,
        {
          outcome: "complete",
          summary: "done",
          changedFiles: [],
          verification: [],
          residualRisk: "none",
          reportedAt: 1,
        },
        "reported",
      );
      store.move(parent.id, "review", 0);
      dispatcher = new TaskDispatcher({ client: client as never, store });

      const result = await dispatcher.run(child.id);
      expect(result.column).toBe("in_progress");
      expect(client.createCalls).toHaveLength(1);
    });

    it("rejects retry when any of multiple parents is unsatisfied", async () => {
      const satisfied = createTask({ title: "Done parent" });
      const unsatisfied = createTask({ title: "Running parent" });
      const child = createTask({ title: "Child" });
      store.addLink(satisfied.id, child.id);
      store.addLink(unsatisfied.id, child.id);
      store.move(satisfied.id, "done", 0);
      store.update(unsatisfied.id, { runState: "running" });
      store.update(child.id, { sessionId: "ses_existing" });
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await expect(dispatcher.retry(child.id)).rejects.toMatchObject({
        status: 409,
      });
      expect(client.promptCalls).toHaveLength(0);
    });

    it("rejects run when parent reported blocked", async () => {
      const parent = createTask({ title: "Blocked parent" });
      const child = createTask({ title: "Child" });
      store.addLink(parent.id, child.id);
      store.setCompletion(
        parent.id,
        {
          outcome: "blocked",
          summary: "stuck on permissions",
          changedFiles: [],
          verification: [],
          residualRisk: "blocked",
          reportedAt: 1,
        },
        "reported",
      );
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await expect(dispatcher.run(child.id)).rejects.toMatchObject({
        status: 409,
        unmetParents: [{ id: parent.id, title: "Blocked parent", why: "parent reported blocked" }],
      });
      expect(client.createCalls).toHaveLength(0);
    });

    it("rejects run when parent went idle without a completion report", async () => {
      const parent = createTask({ title: "Idle parent" });
      const child = createTask({ title: "Child" });
      store.addLink(parent.id, child.id);
      store.setCompletion(
        parent.id,
        {
          outcome: "complete",
          summary: "auto-detected idle",
          changedFiles: [],
          verification: [],
          residualRisk: "unknown",
          reportedAt: 1,
        },
        "idle-fallback",
      );
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await expect(dispatcher.run(child.id)).rejects.toMatchObject({
        status: 409,
        unmetParents: [{ id: parent.id, title: "Idle parent", why: "parent went idle without a completion report" }],
      });
      expect(client.createCalls).toHaveLength(0);
    });

    it("rejects run when parent is in review but not reported complete", async () => {
      const parent = createTask({ title: "Review parent" });
      const child = createTask({ title: "Child" });
      store.addLink(parent.id, child.id);
      store.move(parent.id, "review", 0);
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await expect(dispatcher.run(child.id)).rejects.toMatchObject({
        status: 409,
        unmetParents: [{ id: parent.id, title: "Review parent", why: "parent is in review, not done" }],
      });
      expect(client.createCalls).toHaveLength(0);
    });

    it("rejects run when parent is in error", async () => {
      const parent = createTask({ title: "Error parent" });
      const child = createTask({ title: "Child" });
      store.addLink(parent.id, child.id);
      store.update(parent.id, { runState: "error", error: "OpenCode unreachable" });
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await expect(dispatcher.run(child.id)).rejects.toMatchObject({
        status: 409,
        unmetParents: [{ id: parent.id, title: "Error parent", why: "parent is in error: OpenCode unreachable" }],
      });
      expect(client.createCalls).toHaveLength(0);
    });

    it("retry prompt includes task-context, parent-context, and completion-contract chain", async () => {
      const parent = createTask({ title: "Done parent" });
      const child = store.create({
        title: "Retry context child",
        description: "keep working",
        directory: myProjectDir,
        taskKind: "build",
      });
      store.addLink(parent.id, child.id);
      store.move(parent.id, "done", 0);
      store.setCompletion(
        parent.id,
        {
          outcome: "complete",
          summary: "parent work done",
          changedFiles: ["src/parent.ts"],
          verification: [{ command: "npm test", result: "passed" }],
          residualRisk: "none",
          reportedAt: 1,
        },
        "reported",
      );

      client.nextSessionId = "ses_retry_ctx";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(child.id);

      store.move(child.id, "review", 0);
      store.update(child.id, { runState: "idle" });

      await dispatcher.retry(child.id, "try once more");

      const retryText = (client.promptCalls[client.promptCalls.length - 1]?.parts as Array<{ text: string }>)[0]?.text;
      expect(retryText).toContain("try once more");
      expect(retryText).toContain("OPENBOARD TASK CONTEXT");
      expect(retryText).toContain("Task type: build");
      expect(retryText).toContain("PARENT CONTEXT");
      expect(retryText).toContain("PARENT-000: Done parent");
      expect(retryText).toContain("OPENBOARD COMPLETION CONTRACT");

      // Verify ordering: task-context before parent-context before completion-contract
      const taskCtxIdx = retryText.indexOf("OPENBOARD TASK CONTEXT");
      const parentCtxIdx = retryText.indexOf("PARENT CONTEXT");
      const contractIdx = retryText.indexOf("OPENBOARD COMPLETION CONTRACT");
      expect(taskCtxIdx).toBeGreaterThan(-1);
      expect(parentCtxIdx).toBeGreaterThan(-1);
      expect(contractIdx).toBeGreaterThan(-1);
      expect(taskCtxIdx).toBeLessThan(parentCtxIdx);
      expect(parentCtxIdx).toBeLessThan(contractIdx);
    });

    it("chats over a Review card through the same OpenCode session without replacing lifecycle evidence", async () => {
      const task = createTask({ title: "Chat continuation" });
      client.nextSessionId = "ses_chat_same";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);
      const baseline = store.get(task.id)?.baseCommit;
      store.setCompletion(task.id, { outcome: "complete", summary: "first turn", changedFiles: [], verification: [], residualRisk: "none", reportedAt: 10 }, "reported");
      store.move(task.id, "review", 0);
      store.update(task.id, { runState: "idle" });

      const receipt = await dispatcher.sendSessionMessage(task.id, {
        text: "Please explain the remaining risk",
        mode: "queue",
        sentBy: "User",
        clientMessageId: "msg-review",
        expectedSessionId: "ses_chat_same",
        expectedRunStartedAt: store.get(task.id)?.runStartedAt,
      });

      expect(receipt.status).toBe("accepted");
      expect(receipt.task).toMatchObject({ sessionId: "ses_chat_same", column: "review", runState: "running", completion: { summary: "first turn" }, baseCommit: baseline });
      expect(client.createCalls).toHaveLength(1);
      expect(client.promptCalls).toHaveLength(2);
      const chatPrompt = String((client.promptCalls.at(-1)?.parts as Array<{ text: string }>)[0]?.text);
      expect(chatPrompt).toContain("OPENBOARD SESSION CHAT");
      expect(chatPrompt).toContain("Do not call complete_task or block_task");
      expect(chatPrompt).not.toContain("OPENBOARD COMPLETION CONTRACT");
    });

    it("interrupts only the active OpenCode turn before sending a replacement message", async () => {
      const task = createTask({ title: "Chat redirect" });
      client.nextSessionId = "ses_chat_interrupt";
      dispatcher = new TaskDispatcher({ client: client as never, store });
      await dispatcher.run(task.id);
      const active = store.get(task.id)!;

      const receipt = await dispatcher.sendSessionMessage(task.id, {
        text: "Stop and use the smaller fixture",
        mode: "interrupt",
        sentBy: "User",
        clientMessageId: "msg-interrupt",
        expectedSessionId: "ses_chat_interrupt",
        expectedRunStartedAt: active.runStartedAt,
      });

      expect(client.abortCalls).toContainEqual({ sessionID: "ses_chat_interrupt" });
      expect(receipt.task.sessionId).toBe("ses_chat_interrupt");
      expect(client.createCalls).toHaveLength(1);
      expect(client.promptCalls).toHaveLength(2);
    });
  });
});
