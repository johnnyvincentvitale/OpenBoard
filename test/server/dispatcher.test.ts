import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OpencodeEvent, Task } from "../../src/shared";
import { SqliteTaskStore } from "../../src/db/task-store";
import { TaskDispatcher } from "../../src/server/dispatcher";
import type { ClaudeCodeRunnerLike } from "../../src/server/claude-code-runner";
import { cleanupTestWorkspace, setupTestWorkspace } from "./test-workspace";

async function* makeAsyncGenerator<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
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
  messageResponses: unknown[] = [];

  nextSessionId = "ses_x";
  createShouldError: { error: unknown } | null = null;
  promptShouldError: { error: unknown } | null = null;

  private scripts: OpencodeEvent[][] = [];
  subscribeCallCount = 0;

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
      if (this.createShouldError) {
        return { data: undefined, error: this.createShouldError.error };
      }
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
      if (this.promptShouldError) {
        return { data: undefined, error: this.promptShouldError.error };
      }
      return { data: undefined, error: undefined };
    },
    abort: async (params: { sessionID: string }) => {
      this.abortCalls.push(params);
      return { data: {}, error: undefined };
    },
    messages: async () => {
      return { data: this.messageResponses.shift() ?? [], error: undefined };
    },
  };

  event = {
    subscribe: async () => {
      const script = this.scripts[this.subscribeCallCount] ?? [];
      this.subscribeCallCount += 1;
      return { stream: makeAsyncGenerator(script) };
    },
  };

  permissionListCalls: Array<{ directory?: string }> = [];
  permissionReplyCalls: Array<{ requestID: string; directory?: string; reply: string }> = [];
  permissionListShouldErrorCount = 0;

  permission = {
    list: async (params: { directory?: string }) => {
      this.permissionListCalls.push(params);
      if (this.permissionListShouldErrorCount > 0) {
        this.permissionListShouldErrorCount -= 1;
        return { data: undefined, error: { message: "opencode unreachable" } };
      }
      return { data: [], error: undefined };
    },
    reply: async (params: { requestID: string; directory?: string; reply: string }) => {
      this.permissionReplyCalls.push(params);
      return { data: true, error: undefined };
    },
  };
}

function makeClaudeRunner(): ClaudeCodeRunnerLike & {
  run: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
  poll: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
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

  function createTask(overrides: Partial<{ title: string; description: string; directory: string }> = {}) {
    return store.create({
      title: overrides.title ?? "Fix the bug",
      description: overrides.description ?? "Please fix the bug in foo.ts",
      directory: overrides.directory ?? projectDir,
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
      const task = createTask({ description: "Do scoped work" });
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
      expect(text).toContain(`http://127.0.0.1:5123/api/tasks/${task.id}/complete`);
      expect(text).toContain(`http://127.0.0.1:5123/api/tasks/${task.id}/block`);
      expect(text).toContain("Call /complete or /block exactly once");
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

    it("injects satisfied parent handoffs before the completion-contract footer", async () => {
      const parent = createTask({ title: "Parent task", description: "parent" });
      const child = createTask({ title: "Child task", description: "child work" });
      store.addLink(parent.id, child.id);
      store.setCompletion(
        parent.id,
        {
          outcome: "complete",
          summary: "parent summary",
          changedFiles: ["src/parent.ts"],
          verification: [{ command: "npm test", result: "passed" }],
          residualRisk: "none",
          reportedAt: 123,
        },
        "reported",
      );
      dispatcher = new TaskDispatcher({ client: client as never, store });

      await dispatcher.run(child.id);

      const text = (client.promptCalls[0]?.parts as Array<{ text: string }>)[0]?.text;
      expect(text).toContain("PARENT HANDOFFS");
      expect(text).toContain(`Parent: Parent task (${parent.id})`);
      expect(text).toContain("Summary: parent summary");
      expect(text).toContain("Changed files: src/parent.ts");
      expect(text).toContain("- npm test: passed");
      expect(text).toContain("Residual risk: none");
      expect(text.indexOf("PARENT HANDOFFS")).toBeLessThan(
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
      expect(text).toContain("Parent: Manual parent");
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
      store.updateSettings({ worktreeDefault: true });
      const task = createTask({ directory: gitProjectDir });
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

    it("retry() restarts the permission responder for a worktree-isolated task", async () => {
      store.updateSettings({ worktreeDefault: true });
      const task = createTask({ directory: gitProjectDir });
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
      store.updateSettings({ worktreeDefault: true });
      const task = createTask({ directory: gitProjectDir });
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
      store.updateSettings({ worktreeDefault: true });
      const gitProjectDir2 = join(workspace, "git-project-2");
      makeGitRepo(gitProjectDir2);
      const taskA = createTask({ directory: gitProjectDir, title: "Task A" });
      const taskB = createTask({ directory: gitProjectDir2, title: "Task B" });
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
      store.updateSettings({ worktreeDefault: true });
      const task = createTask({ directory: gitProjectDir });
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
      store.updateSettings({ worktreeDefault: true });
      const task = createTask({ directory: gitProjectDir });
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
      store.updateSettings({ worktreeDefault: true });
      const task = createTask({ directory: gitProjectDir });
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
      store.updateSettings({ worktreeDefault: true });
      const task = createTask({ directory: gitProjectDir });
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

    it("a normal worktree task (base checkout untouched) still reaches review", async () => {
      store.updateSettings({ worktreeDefault: true });
      const task = createTask({ directory: gitProjectDir });
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
      store.updateSettings({ worktreeDefault: true });
      const task = createTask({ directory: gitProjectDir });
      client.nextSessionId = "ses_integrate_escape";
      dispatcher = new TaskDispatcher({
        client: client as never,
        store,
        worktreeBaseDir: () => join(workspace, "worktrees-escape"),
      });

      const ran = await dispatcher.run(task.id);
      const wtPath = ran.worktreePath!;
      writeFileSync(join(wtPath, "feature.txt"), "work\n");

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
});
