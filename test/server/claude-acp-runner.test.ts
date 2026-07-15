import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { ClaudeAcpRunner, CodexAcpRunner, CursorAcpRunner, GeminiAcpRunner, decideClaudeAcpPermission, discoverAcpConfig } from "../../src/server/claude-acp-runner";
import type { Task } from "../../src/shared";
import type { PermissionAskEvent, PermissionBrokerClock } from "../../src/server/permission-broker";
import type { SessionActivityEventInput } from "../../src/server/session-activity";

const DEFAULT_MCP_COMMAND = fileURLToPath(new URL("../../dist/cli/openboard.mjs", import.meta.url));

const task: Task = {
  id: "task_1",
  type: "agent",
  taskKind: "research",
  harness: "claude-code",
  agent: "build",
  title: "Claude task",
  description: "Do the work",
  directory: "/repo",
  model: { providerID: "claude-code", id: "sonnet" },
  column: "todo",
  position: 0,
  runState: "unstarted",
  baseCommit: null,
  dirtyAtDispatch: false,
  createdAt: 1,
  updatedAt: 1,
};

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => {
    this.emit("close", 0, null);
    return true;
  });
}

interface HarnessMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

function makeAcpHarness() {
  const child = new FakeChild();
  const messages: HarnessMessage[] = [];
  const waiters: Array<() => void> = [];
  let buffer = "";

  child.stdin.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) messages.push(JSON.parse(line) as HarnessMessage);
      newline = buffer.indexOf("\n");
    }
    while (waiters.length) waiters.shift()?.();
  });

  async function nextMessage(method?: string): Promise<HarnessMessage> {
    for (;;) {
      const index = method === undefined ? 0 : messages.findIndex((message) => message.method === method);
      if (index >= 0) return messages.splice(index, 1)[0];
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  }

  function respond(message: HarnessMessage, result: Record<string, unknown>): void {
    child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
  }

  function requestPermission(params: Record<string, unknown>, id: number | string = 99): number | string {
    child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "session/request_permission", params })}\n`);
    return id;
  }

  function notify(method: string, params: Record<string, unknown>): void {
    child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  function queuedMessages(): HarnessMessage[] {
    return messages;
  }

  const spawn = vi.fn(() => child as never);
  return { child, nextMessage, requestPermission, notify, queuedMessages, respond, spawn };
}

function manualClock(start = 1_000): PermissionBrokerClock & { tick(ms: number): void } {
  let now = start;
  const timers: Array<{ at: number; callback: () => void; active: boolean }> = [];
  return {
    now: () => now,
    setTimer(callback, delayMs) {
      const timer = { at: now + delayMs, callback, active: true };
      timers.push(timer);
      return timer;
    },
    clearTimer(handle) {
      (handle as { active?: boolean }).active = false;
    },
    tick(ms) {
      now += ms;
      for (const timer of timers) {
        if (timer.active && timer.at <= now) {
          timer.active = false;
          timer.callback();
        }
      }
    },
  };
}

async function expectNoMessage(harness: ReturnType<typeof makeAcpHarness>): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(harness.queuedMessages()).toEqual([]);
}

async function launchRunner(harness = makeAcpHarness(), runTask: Task = task, deps: Partial<ConstructorParameters<typeof ClaudeAcpRunner>[0]> = {}) {
  const runner = new ClaudeAcpRunner({
    adapterBaseUrl: "http://127.0.0.1:4097",
    boardToken: "token",
    instanceName: "alpha",
    command: "claude-acp",
    commandArgs: ["--stdio"],
    spawn: harness.spawn as never,
    env: {},
    ...deps,
  });

  const runPromise = runner.run({
    task: runTask,
    directory: "/repo",
    prompt: "Do the work",
    runStartedAt: 123,
  });

  const initialize = await harness.nextMessage("initialize");
  harness.respond(initialize, { protocolVersion: 1 });
  const sessionNew = await harness.nextMessage("session/new");
  harness.respond(sessionNew, { sessionId: "acp-session-1" });
  const setMode = await harness.nextMessage("session/set_mode");
  harness.respond(setMode, {});
  const prompt = await harness.nextMessage("session/prompt");
  const result = await runPromise;

  return { harness, prompt, result, runner, sessionNew, setMode };
}

describe("ClaudeAcpRunner", () => {
  it("pauses a prepared launch until task/session ownership is registered", async () => {
    const harness = makeAcpHarness();
    const runner = new ClaudeAcpRunner({
      adapterBaseUrl: "http://127.0.0.1:4097",
      command: "claude-acp",
      commandArgs: ["--stdio"],
      spawn: harness.spawn as never,
      env: {},
    });
    let releaseReady!: () => void;
    const readyReleased = new Promise<void>((resolve) => { releaseReady = resolve; });
    let markReady!: () => void;
    const readyEntered = new Promise<void>((resolve) => { markReady = resolve; });

    const runPromise = runner.runPrepared({
      task,
      directory: "/repo",
      prompt: "Do the work",
      runStartedAt: 123,
    }, async (result) => {
      expect(result).toMatchObject({ sessionId: "acp-session-1", status: "running" });
      markReady();
      await readyReleased;
    });

    const initialize = await harness.nextMessage("initialize");
    harness.respond(initialize, { protocolVersion: 1 });
    const sessionNew = await harness.nextMessage("session/new");
    harness.respond(sessionNew, { sessionId: "acp-session-1" });
    const setMode = await harness.nextMessage("session/set_mode");
    harness.respond(setMode, {});

    await readyEntered;
    await expectNoMessage(harness);
    releaseReady();
    await harness.nextMessage("session/prompt");
    await expect(runPromise).resolves.toMatchObject({ sessionId: "acp-session-1" });
    runner.shutdown();
  });

  it("starts a Claude ACP session with OpenBoard MCP and bypass mode", async () => {
    const { harness, prompt, result, sessionNew, setMode } = await launchRunner();

    expect(result).toEqual({
      sessionId: "acp-session-1",
      sessionName: "openboard-task_1-123",
      status: "running",
    });
    expect(harness.spawn).toHaveBeenCalledWith("claude-acp", ["--stdio"], {
      cwd: "/repo",
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(sessionNew.params).toEqual({
      cwd: "/repo",
      mcpServers: [
        {
          name: "openboard",
          command: DEFAULT_MCP_COMMAND,
          args: ["mcp", "--worker", "--task-id", "task_1", "--instance", "alpha"],
          env: [],
        },
      ],
      _meta: { claudeCode: { options: { model: "sonnet" } } },
    });
    expect(setMode.params).toEqual({ sessionId: "acp-session-1", modeId: "bypassPermissions" });
    expect(prompt.params?.sessionId).toBe("acp-session-1");
    const promptText = ((prompt.params?.prompt as Array<{ text?: string }> | undefined)?.[0]?.text) ?? "";
    expect(promptText).toContain("OPENBOARD CLAUDE ACP WORKER CONTRACT");
    expect(promptText).toContain("Task type: research");
    expect(promptText).toContain("factual findings, sources inspected, repo areas read, or evidence gathered");
    expect(promptText).toContain("not applicable: research only");
    expect(promptText).not.toContain("parent handoffs/raw files read");
    expect(promptText).toContain('complete_task with { taskId: "task_1", runStartedAt: 123');
    expect(promptText).not.toContain("Board URL:");
    expect(promptText).toContain("When blocking on a question the operator must answer before you can continue, also include needsInput with the direct question.");
  });

  it("keeps URL/token binding while task-scoping an instance-less worker MCP", async () => {
    const { sessionNew, runner } = await launchRunner(makeAcpHarness(), task, { instanceName: undefined });

    expect(sessionNew.params).toEqual({
      cwd: "/repo",
      mcpServers: [{
        name: "openboard",
        command: DEFAULT_MCP_COMMAND,
        args: ["mcp", "--worker", "--task-id", "task_1"],
        env: [
          { name: "OPENCODE_BOARD_URL", value: "http://127.0.0.1:4097" },
          { name: "OPENBOARD_API_TOKEN", value: "token" },
        ],
      }],
      _meta: { claudeCode: { options: { model: "sonnet" } } },
    });
    runner.shutdown();
  });

  it("uses parent handoff guidance for linked tasks", async () => {
    const { prompt } = await launchRunner(makeAcpHarness(), {
      ...task,
      taskKind: "synthesis",
      parentIds: ["task_parent"],
    });

    const promptText = ((prompt.params?.prompt as Array<{ text?: string }> | undefined)?.[0]?.text) ?? "";
    expect(promptText).toContain("evaluation of parent findings");
    expect(promptText).toContain("parent handoffs/raw files read");
  });

  it("keeps the ACP process alive and resumable when a prompt turn completes", async () => {
    const { harness, prompt, result, runner } = await launchRunner();

    harness.respond(prompt, { stopReason: "end_turn" });
    await Promise.resolve();

    await expect(runner.poll(result.sessionName)).resolves.toEqual({
      status: "idle",
      terminal: true,
      cwd: "/repo",
    });
    expect(harness.child.kill).not.toHaveBeenCalled();
  });

  it("sends a second prompt through the same ACP session", async () => {
    const { harness, prompt, result, runner } = await launchRunner();
    harness.respond(prompt, { stopReason: "end_turn" });
    await Promise.resolve();

    await runner.sendMessage(result.sessionName, "Please refine that", { mode: "queue", runStartedAt: 456 });
    const followup = await harness.nextMessage("session/prompt");
    expect(followup.params).toEqual({
      sessionId: "acp-session-1",
      prompt: [{ type: "text", text: "Please refine that" }],
    });
    expect(harness.spawn).toHaveBeenCalledTimes(1);
    await expect(runner.poll(result.sessionName)).resolves.toMatchObject({ status: "running", terminal: false });
  });

  it("cancels the active ACP turn before an interrupt message", async () => {
    const { harness, prompt, result, runner } = await launchRunner();
    const send = runner.sendMessage(result.sessionName, "Change direction", { mode: "interrupt", runStartedAt: 789 });
    const cancel = await harness.nextMessage("session/cancel");
    expect(cancel.params).toEqual({ sessionId: "acp-session-1" });
    harness.respond(prompt, { stopReason: "cancelled" });
    await send;
    const replacement = await harness.nextMessage("session/prompt");
    expect(replacement.params?.prompt).toEqual([{ type: "text", text: "Change direction" }]);
    expect(harness.spawn).toHaveBeenCalledTimes(1);
  });

  it("cancels the ACP session on abort", async () => {
    const { harness, result, runner } = await launchRunner();

    await runner.abort(result.sessionName);
    const cancel = await harness.nextMessage("session/cancel");

    expect(cancel).toEqual({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "acp-session-1" },
    });
    await expect(runner.poll(result.sessionName)).resolves.toEqual({
      status: "aborted",
      terminal: true,
      cwd: "/repo",
      error: "aborted",
    });
  });

  it("answers ACP permission requests with the configured fence policy", async () => {
    const harness = makeAcpHarness();
    const { runner } = await launchRunner(harness);

    harness.requestPermission({
      sessionId: "acp-session-1",
      toolCall: {
        kind: "edit",
        rawInput: { file_path: "/outside/file.ts" },
      },
      options: [{ optionId: "allow_once", kind: "allow_once" }, { optionId: "reject", kind: "reject" }],
    });
    const response = await harness.nextMessage();

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 99,
      result: { outcome: { outcome: "selected", optionId: "allow_once" } },
    });
    await expect(runner.poll("openboard-task_1-123")).resolves.toMatchObject({ status: "running" });
  });

  it("routes id-bearing permission requests through the broker and waits for operator decision", async () => {
    const harness = makeAcpHarness();
    const events: PermissionAskEvent[] = [];
    const { runner } = await launchRunner(harness, { ...task, permissionMode: "manual" }, { onPermissionEvent: (event) => events.push(event) });

    harness.requestPermission({
      sessionId: "acp-session-1",
      toolCall: { kind: "edit", title: "Edit", rawInput: { file_path: "/outside/secret-token.txt", content: "PRIVATE" } },
      options: [{ optionId: "allow_once", kind: "allow_once" }, { optionId: "reject", kind: "reject" }],
    });
    await expectNoMessage(harness);

    expect(runner.listPendingPermissions("openboard-task_1-123")).toEqual([expect.objectContaining({
      harness: "claude-code",
      source: "acp",
      permission: "edit",
      tool: "Edit",
      patterns: ["/outside/secret-token.txt"],
    })]);
    expect(JSON.stringify(runner.listPendingPermissions("openboard-task_1-123"))).not.toContain("PRIVATE");

    const askId = runner.listPendingPermissions("openboard-task_1-123")[0].id;
    await expect(runner.respondPermission("openboard-task_1-123", { askId, action: "allow_once", answeredBy: "Operator" })).resolves.toMatchObject({ ok: true });
    expect(await harness.nextMessage()).toEqual({ jsonrpc: "2.0", id: 99, result: { outcome: { outcome: "selected", optionId: "allow_once" } } });
    expect(events.map((event) => event.type)).toEqual(["permission_asked", "permission_answered"]);
  });

  it("never maps operator allow to allow_always and keeps the ask pending for later deny", async () => {
    const harness = makeAcpHarness();
    const events: PermissionAskEvent[] = [];
    const { runner } = await launchRunner(harness, { ...task, permissionMode: "manual" }, { onPermissionEvent: (event) => events.push(event) });
    harness.requestPermission({
      sessionId: "acp-session-1",
      toolCall: { kind: "edit", rawInput: { file_path: "/outside/file.ts" } },
      options: [{ optionId: "allow_always", kind: "allow_always" }, { optionId: "reject", kind: "reject" }],
    });
    const askId = runner.listPendingPermissions("openboard-task_1-123")[0].id;
    await expect(runner.respondPermission("openboard-task_1-123", { askId, action: "allow_once", answeredBy: "Operator" })).resolves.toMatchObject({ ok: false, conflict: "unsupported-action" });
    await expectNoMessage(harness);
    expect(runner.listPendingPermissions("openboard-task_1-123").map((ask) => ask.id)).toEqual([askId]);
    expect(events.at(-1)).toMatchObject({ type: "permission_reply_failed", decision: "allow_once" });

    await expect(runner.respondPermission("openboard-task_1-123", { askId, action: "deny", answeredBy: "Operator" })).resolves.toMatchObject({ ok: true });
    expect(await harness.nextMessage()).toMatchObject({ result: { outcome: { optionId: "reject" } } });
  });

  it("holds mutating manual-mode ACP requests for the operator", async () => {
    const harness = makeAcpHarness();
    const events: PermissionAskEvent[] = [];
    const { runner } = await launchRunner(harness, { ...task, permissionMode: "manual" }, { onPermissionEvent: (event) => events.push(event) });

    harness.requestPermission({
      sessionId: "acp-session-1",
      toolCall: { kind: "edit", rawInput: { file_path: "/repo/file.ts" } },
      options: [{ optionId: "allow_once", kind: "allow_once" }, { optionId: "reject", kind: "reject" }],
    });

    await expectNoMessage(harness);
    expect(runner.listPendingPermissions("openboard-task_1-123")).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it("uses the existing permission policy on timeout", async () => {
    const clock = manualClock();
    const harness = makeAcpHarness();
    await launchRunner(harness, { ...task, permissionMode: "manual" }, { permissionClock: clock, permissionGraceMs: 10 });
    harness.requestPermission({
      sessionId: "acp-session-1",
      toolCall: { kind: "edit", rawInput: { file_path: "/outside/file.ts" } },
      options: [{ optionId: "allow_once", kind: "allow_once" }, { optionId: "reject", kind: "reject" }],
    });
    await expectNoMessage(harness);
    clock.tick(10);
    expect(await harness.nextMessage()).toMatchObject({ result: { outcome: { optionId: "reject" } } });
  });

  it("reads the live timeout supplier when each new ACP ask is raised", async () => {
    const clock = manualClock();
    const harness = makeAcpHarness();
    let graceMs = 10;
    const { runner } = await launchRunner(harness, { ...task, permissionMode: "manual" }, {
      permissionClock: clock,
      permissionGraceMs: () => graceMs,
    });

    harness.requestPermission({
      sessionId: "acp-session-1",
      toolCall: { kind: "edit", rawInput: { file_path: "/outside/one.ts" } },
      options: [{ optionId: "allow_once", kind: "allow_once" }, { optionId: "reject", kind: "reject" }],
    }, 99);
    await expectNoMessage(harness);
    const first = runner.listPendingPermissions("openboard-task_1-123")[0];
    expect(first.deadline - first.raisedAt).toBe(10);
    await runner.respondPermission("openboard-task_1-123", { askId: first.id, action: "deny", answeredBy: "Operator" });
    await harness.nextMessage();

    graceMs = 25;
    harness.requestPermission({
      sessionId: "acp-session-1",
      toolCall: { kind: "edit", rawInput: { file_path: "/outside/two.ts" } },
      options: [{ optionId: "allow_once", kind: "allow_once" }, { optionId: "reject", kind: "reject" }],
    }, 100);
    await expectNoMessage(harness);
    const second = runner.listPendingPermissions("openboard-task_1-123")[0];
    expect(second.deadline - second.raisedAt).toBe(25);
  });

  it("keeps a failed operator reply pending until the still-live deadline applies policy, without looping", async () => {
    const clock = manualClock();
    const harness = makeAcpHarness();
    const events: PermissionAskEvent[] = [];
    const { runner } = await launchRunner(harness, { ...task, permissionMode: "manual" }, { permissionClock: clock, permissionGraceMs: 10, onPermissionEvent: (event) => events.push(event) });
    harness.requestPermission({
      sessionId: "acp-session-1",
      toolCall: { kind: "edit", rawInput: { file_path: "/outside/file.ts" } },
      options: [{ optionId: "allow_always", kind: "allow_always" }, { optionId: "reject", kind: "reject" }],
    });
    const askId = runner.listPendingPermissions("openboard-task_1-123")[0].id;

    await expect(runner.respondPermission("openboard-task_1-123", { askId, action: "allow_once", answeredBy: "Operator" })).resolves.toMatchObject({ ok: false, conflict: "unsupported-action" });
    expect(events.filter((event) => event.type === "permission_reply_failed")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "permission_reply_failed", reason: "operator", decision: "allow_once" });
    expect(runner.listPendingPermissions("openboard-task_1-123").map((ask) => ask.id)).toEqual([askId]);

    clock.tick(10);
    await Promise.resolve();
    expect(await harness.nextMessage()).toMatchObject({ result: { outcome: { optionId: "reject" } } });
    expect(events.filter((event) => event.type === "permission_reply_failed")).toHaveLength(1);
    expect(runner.listPendingPermissions("openboard-task_1-123")).toEqual([]);
  });

  it("surfaces provider reply failure without dropping ACP asks", async () => {
    const harness = makeAcpHarness();
    const events: PermissionAskEvent[] = [];
    const { runner } = await launchRunner(harness, { ...task, permissionMode: "manual" }, { onPermissionEvent: (event) => events.push(event) });
    harness.requestPermission({ sessionId: "acp-session-1", toolCall: { kind: "edit", rawInput: { file_path: "/outside/file.ts" } }, options: [{ optionId: "allow_always", kind: "allow_always" }] });
    const askId = runner.listPendingPermissions("openboard-task_1-123")[0].id;
    await expect(runner.respondPermission("openboard-task_1-123", { askId, action: "allow_once", answeredBy: "Operator" })).resolves.toMatchObject({ ok: false, conflict: "unsupported-action" });
    expect(events.at(-1)).toMatchObject({ type: "permission_reply_failed", decision: "allow_once" });
    expect(runner.listPendingPermissions("openboard-task_1-123").map((ask) => ask.id)).toEqual([askId]);
  });

  it("clears exact-run asks on prompt terminal closure", async () => {
    const harness = makeAcpHarness();
    const { prompt, runner } = await launchRunner(harness, { ...task, permissionMode: "manual" });
    harness.requestPermission({ sessionId: "acp-session-1", toolCall: { kind: "edit", rawInput: { file_path: "/outside/file.ts" } }, options: [{ optionId: "reject", kind: "reject" }] });
    expect(runner.listPendingPermissions("openboard-task_1-123")).toHaveLength(1);
    harness.respond(prompt, { stopReason: "end_turn" });
    await Promise.resolve();
    expect(runner.listPendingPermissions("openboard-task_1-123")).toEqual([]);
  });

  it("normalizes id-less ACP notifications into redacted activity and ignores unknown notifications", async () => {
    const harness = makeAcpHarness();
    const activity: Array<{ taskId: string; runStartedAt: number; input: SessionActivityEventInput }> = [];
    await launchRunner(harness, task, { onActivity: (taskId, runStartedAt, input) => activity.push({ taskId, runStartedAt, input }) });
    harness.notify("session/update", { sessionId: "acp-session-1", role: "assistant", message: { text: "hello" }, rawInput: { secret: "PRIVATE" } });
    harness.notify("session/update", { sessionId: "acp-session-1", toolCall: { name: "Bash", id: "call_1", rawInput: { command: "secret" } } });
    harness.notify("unknown/notice", { sessionId: "acp-session-1", text: "ignored" });

    expect(activity).toEqual([
      expect.objectContaining({ taskId: "task_1", runStartedAt: 123, input: expect.objectContaining({ kind: "text", role: "assistant", text: "hello" }) }),
      expect.objectContaining({ input: expect.objectContaining({ kind: "tool", tool: expect.objectContaining({ name: "Bash", callId: "call_1", status: "running" }) }) }),
    ]);
    expect(JSON.stringify(activity)).not.toContain("PRIVATE");
    expect(JSON.stringify(activity)).not.toContain("secret");
  });

  it("normalizes the real ACP session/update envelope (sessionUpdate discriminator) into activity", async () => {
    const harness = makeAcpHarness();
    const activity: Array<{ taskId: string; runStartedAt: number; input: SessionActivityEventInput }> = [];
    await launchRunner(harness, task, { onActivity: (taskId, runStartedAt, input) => activity.push({ taskId, runStartedAt, input }) });

    harness.notify("session/update", {
      sessionId: "acp-session-1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reading the file now." } },
    });
    harness.notify("session/update", {
      sessionId: "acp-session-1",
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "I should check the tests first." } },
    });
    harness.notify("session/update", {
      sessionId: "acp-session-1",
      update: { sessionUpdate: "tool_call", toolCallId: "call_1", title: "Read file.ts", kind: "read", status: "pending", rawInput: { file_path: "/repo/file.ts" } },
    });
    harness.notify("session/update", {
      sessionId: "acp-session-1",
      update: { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "in_progress" },
    });
    harness.notify("session/update", {
      sessionId: "acp-session-1",
      update: { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed" },
    });
    harness.notify("session/update", {
      sessionId: "acp-session-1",
      update: { sessionUpdate: "tool_call_update", toolCallId: "call_2", title: "Bash", status: "failed" },
    });
    // A recognized-but-unmapped sessionUpdate variant (e.g. "plan") must not surface as activity.
    harness.notify("session/update", { sessionId: "acp-session-1", update: { sessionUpdate: "plan", entries: [] } });

    expect(activity).toEqual([
      expect.objectContaining({ taskId: "task_1", runStartedAt: 123, input: expect.objectContaining({ kind: "text", role: "assistant", text: "Reading the file now." }) }),
      expect.objectContaining({ input: expect.objectContaining({ kind: "text", role: "assistant", text: "I should check the tests first." }) }),
      expect.objectContaining({ input: expect.objectContaining({ kind: "tool", tool: expect.objectContaining({ name: "Read file.ts", callId: "call_1", status: "started" }) }) }),
      expect.objectContaining({ input: expect.objectContaining({ kind: "tool", tool: expect.objectContaining({ callId: "call_1", status: "running" }) }) }),
      expect.objectContaining({ input: expect.objectContaining({ kind: "tool", tool: expect.objectContaining({ callId: "call_1", status: "complete" }) }) }),
      expect.objectContaining({ input: expect.objectContaining({ kind: "tool", tool: expect.objectContaining({ name: "Bash", callId: "call_2", status: "error" }) }) }),
    ]);
  });

  it("defines strict and autonomous ACP permission modes explicitly", () => {
    const permission = (toolCall: Record<string, unknown>) => ({
      sessionId: "s1",
      toolCall,
      options: [{ optionId: "allow", kind: "allow" }, { optionId: "reject", kind: "reject" }],
    });

    expect(decideClaudeAcpPermission(permission({ kind: "edit", rawInput: { file_path: "/repo/src/file.ts" } }), "manual")).toBe("ask");
    expect(decideClaudeAcpPermission(permission({ kind: "edit", rawInput: { file_path: "/tmp/file.ts" } }), "manual")).toBe("ask");
    expect(decideClaudeAcpPermission(permission({ _meta: { claudeCode: { toolName: "Bash" } }, rawInput: { command: "npm test" } }), "manual")).toBe("ask");
    expect(decideClaudeAcpPermission(permission({ _meta: { claudeCode: { toolName: "Bash" } }, rawInput: { command: "cat /tmp/secret" } }), "manual")).toBe("ask");
    expect(decideClaudeAcpPermission(permission({ kind: "edit" }), "acceptEdits")).toBe("allow");
    expect(decideClaudeAcpPermission(permission({ kind: "execute" }), "auto")).toBe("allow");
    expect(decideClaudeAcpPermission(permission({ kind: "edit" }), "autoEdit")).toBe("allow");
    expect(decideClaudeAcpPermission(permission({ kind: "execute" }), "autoEdit")).toBe("ask");
    expect(decideClaudeAcpPermission(permission({ kind: "execute" }), "yolo")).toBe("allow");
    expect(decideClaudeAcpPermission(permission({ kind: "edit" }), "dontAsk")).toBe("deny");
    expect(decideClaudeAcpPermission(permission({ kind: "execute" }), "plan")).toBe("deny");
    expect(decideClaudeAcpPermission(permission({ _meta: { claudeCode: { toolName: "mcp__openboard__complete_task" } }, rawInput: {} }), "manual")).toBe("allow");
    expect(decideClaudeAcpPermission(permission({ kind: "edit", rawInput: { file_path: "/tmp/file.ts" } }), "bypassPermissions")).toBe("allow");
  });

  it.each([
    ["traversal redirect", { kind: "execute", rawInput: { command: "echo x > ../escaped.txt" } }],
    ["directory traversal", { kind: "execute", rawInput: { command: "cd .. && touch escaped.txt" } }],
    ["interpreter write", { kind: "execute", rawInput: { command: "python -c 'open(\"../escaped.txt\",\"w\").write(\"x\")'" } }],
    ["environment expansion", { kind: "execute", rawInput: { command: "echo x > $HOME/escaped.txt" } }],
    ["command substitution", { kind: "execute", rawInput: { command: "touch $(cat /tmp/path)" } }],
    ["missing path", { kind: "edit", rawInput: { file_path: "/repo/missing/../file.ts" } }],
    ["symlink-shaped path", { kind: "edit", rawInput: { file_path: "/repo/link/outside.ts" } }],
  ])("never auto-allows %s in manual mode", (_label, toolCall) => {
    const request = { sessionId: "s1", toolCall, options: [{ optionId: "allow_once", kind: "allow_once" }, { optionId: "reject", kind: "reject" }] };
    expect(decideClaudeAcpPermission(request, "manual")).toBe("ask");
  });

  it("reports a provider reply failure when ACP stdin is closed", async () => {
    const harness = makeAcpHarness();
    const { runner } = await launchRunner(harness, { ...task, permissionMode: "manual" });
    harness.requestPermission({
      sessionId: "acp-session-1",
      toolCall: { kind: "edit", rawInput: { file_path: "/repo/file.ts" } },
      options: [{ optionId: "allow_once", kind: "allow_once" }, { optionId: "reject", kind: "reject" }],
    });
    const askId = runner.listPendingPermissions("openboard-task_1-123")[0].id;
    harness.child.stdin.destroy();
    await expect(runner.respondPermission("openboard-task_1-123", { askId, action: "allow_once", answeredBy: "Operator" })).resolves.toMatchObject({
      ok: false,
      conflict: "reply-failed",
      error: expect.stringContaining("stdin is not writable"),
    });
  });
});

describe("CodexAcpRunner", () => {
  it("discovers bare Codex model IDs separately from reasoning effort", async () => {
    const harness = makeAcpHarness();
    const discovery = discoverAcpConfig("codex", { cwd: "/repo", env: {}, spawn: harness.spawn as never });

    harness.respond(await harness.nextMessage("initialize"), { protocolVersion: 1 });
    harness.respond(await harness.nextMessage("session/new"), {
      sessionId: "codex-discovery-1",
      models: {
        availableModels: [
          { modelId: "gpt-5.6-sol[high]", name: "GPT-5.6 SOL (high)" },
          { modelId: "gpt-5.6-sol[xhigh]", name: "GPT-5.6 SOL (xhigh)" },
        ],
      },
      configOptions: [
        {
          id: "model",
          category: "model",
          type: "select",
          options: [{ value: "gpt-5.6-sol", name: "GPT-5.6 SOL" }],
        },
        {
          id: "reasoning_effort",
          name: "Reasoning effort",
          type: "select",
          currentValue: "xhigh",
          options: [{ value: "high", name: "High" }, { value: "xhigh", name: "Extra high" }],
        },
      ],
    });

    await expect(discovery).resolves.toMatchObject({
      available: true,
      models: [{ id: "gpt-5.6-sol", name: "GPT-5.6 SOL" }],
      options: [{
        id: "reasoning_effort",
        currentValue: "xhigh",
        options: [{ value: "high", name: "High" }, { value: "xhigh", name: "Extra high" }],
      }],
    });
  });

  it("configures a Codex ACP session through the adapter's native protocol", async () => {
    const harness = makeAcpHarness();
    const runner = new CodexAcpRunner({
      adapterBaseUrl: "http://127.0.0.1:4097",
      boardToken: "token",
      instanceName: "alpha",
      command: "codex-acp",
      commandArgs: ["--stdio"],
      spawn: harness.spawn as never,
      env: {},
    });
    const codexTask: Task = {
      ...task,
      harness: "codex",
      permissionMode: "agent-full-access",
      acpOptions: { reasoning_effort: "high", "fast-mode": "on" },
      model: { providerID: "codex", id: "gpt-5.4" },
    };

    const runPromise = runner.run({ task: codexTask, directory: "/repo", prompt: "Do Codex work", runStartedAt: 456 });
    harness.respond(await harness.nextMessage("initialize"), { protocolVersion: 1 });
    const sessionNew = await harness.nextMessage("session/new");
    harness.respond(sessionNew, { sessionId: "codex-session-1" });
    const setMode = await harness.nextMessage("session/set_mode");
    harness.respond(setMode, {});
    const setModel = await harness.nextMessage("session/set_config_option");
    harness.respond(setModel, { configOptions: [] });
    const setReasoning = await harness.nextMessage("session/set_config_option");
    harness.respond(setReasoning, { configOptions: [] });
    const setFastMode = await harness.nextMessage("session/set_config_option");
    harness.respond(setFastMode, { configOptions: [] });
    const prompt = await harness.nextMessage("session/prompt");
    const result = await runPromise;

    expect(result).toEqual({ sessionId: "codex-session-1", sessionName: "openboard-task_1-456", status: "running" });
    expect(harness.spawn).toHaveBeenCalledWith("codex-acp", ["--stdio"], {
      cwd: "/repo",
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(sessionNew.params).toEqual({
      cwd: "/repo",
      mcpServers: [{ name: "openboard", command: DEFAULT_MCP_COMMAND, args: ["mcp", "--worker", "--task-id", "task_1", "--instance", "alpha"], env: [] }],
      _meta: {
        openboard: { permissionMode: "agent-full-access", acpOptions: { reasoning_effort: "high", "fast-mode": "on" } },
      },
    });
    expect(setMode.params).toEqual({ sessionId: "codex-session-1", modeId: "agent-full-access" });
    expect(setModel.params).toEqual({ sessionId: "codex-session-1", configId: "model", value: "gpt-5.4" });
    expect(setReasoning.params).toEqual({ sessionId: "codex-session-1", configId: "reasoning_effort", value: "high" });
    expect(setFastMode.params).toEqual({ sessionId: "codex-session-1", configId: "fast-mode", value: "on" });
    const promptText = ((prompt.params?.prompt as Array<{ text?: string }> | undefined)?.[0]?.text) ?? "";
    expect(promptText).toContain("OPENBOARD CODEX ACP WORKER CONTRACT");
    expect(promptText).not.toContain("reasoning_effort");
    expect(promptText).toContain('complete_task with { taskId: "task_1", runStartedAt: 456');
  });

  it("allows OpenBoard report tools by bare or namespaced ACP tool name", () => {
    const request = (toolCall: Record<string, unknown>) => ({
      sessionId: "session",
      toolCall,
      options: [{ optionId: "allow", kind: "allow" }, { optionId: "reject", kind: "reject" }],
    });

    expect(decideClaudeAcpPermission(request({ rawInput: { toolName: "complete_task" } }), "manual")).toBe("allow");
    expect(decideClaudeAcpPermission(request({ rawInput: { toolName: "openboard.block_task" } }), "manual")).toBe("allow");
    expect(decideClaudeAcpPermission(request({ title: "mcp__openboard__block_task" }), "manual")).toBe("allow");
    expect(decideClaudeAcpPermission(request({ title: "complete_task (openboard MCP Server)" }), "manual")).toBe("allow");
    expect(decideClaudeAcpPermission(request({ title: "block_task (openboard MCP Server)" }), "plan")).toBe("allow");
    expect(decideClaudeAcpPermission(request({ title: "complete_task (other MCP Server)" }), "manual")).toBe("ask");
    expect(decideClaudeAcpPermission(request({ rawInput: { toolName: "other.complete_task" } }), "manual")).toBe("ask");
  });

  it("inherits brokered permissions and notification activity in ACP subclasses", async () => {
    const harness = makeAcpHarness();
    const activity: Array<{ taskId: string; runStartedAt: number; input: SessionActivityEventInput }> = [];
    const runner = new CursorAcpRunner({
      adapterBaseUrl: "http://127.0.0.1:4097",
      boardToken: "token",
      instanceName: "alpha",
      command: "cursor-acp",
      commandArgs: ["--stdio"],
      spawn: harness.spawn as never,
      env: {},
      onActivity: (taskId, runStartedAt, input) => activity.push({ taskId, runStartedAt, input }),
    });
    const cursorTask: Task = { ...task, harness: "cursor-acp", permissionMode: "manual", model: { providerID: "cursor-acp", id: "default" } };

    const runPromise = runner.run({ task: cursorTask, directory: "/repo", prompt: "Do Cursor work", runStartedAt: 789 });
    harness.respond(await harness.nextMessage("initialize"), { protocolVersion: 1 });
    harness.respond(await harness.nextMessage("session/new"), { sessionId: "cursor-session-1" });
    harness.respond(await harness.nextMessage("session/set_mode"), {});
    await harness.nextMessage("session/prompt");
    const result = await runPromise;

    harness.requestPermission({ sessionId: "cursor-session-1", toolCall: { kind: "edit", rawInput: { file_path: "/outside/file.ts" } }, options: [{ optionId: "allow_once", kind: "allow_once" }] });
    expect(runner.listPendingPermissions(result.sessionName)).toEqual([expect.objectContaining({ harness: "cursor-acp", source: "acp" })]);
    harness.notify("session/update", { sessionId: "cursor-session-1", status: "working" });
    expect(activity).toEqual([expect.objectContaining({ taskId: "task_1", runStartedAt: 789, input: expect.objectContaining({ harness: "cursor-acp", kind: "status", text: "working" }) })]);
  });
});

describe("GeminiAcpRunner", () => {
  it("uses Gemini CLI's native ACP mode, permissions, and model control", async () => {
    const harness = makeAcpHarness();
    const runner = new GeminiAcpRunner({
      adapterBaseUrl: "http://127.0.0.1:4097",
      boardToken: "token",
      instanceName: "alpha",
      spawn: harness.spawn as never,
      env: {},
    });
    const geminiTask: Task = {
      ...task,
      harness: "gemini-acp",
      model: { providerID: "gemini-acp", id: "gemini-3.1-pro-preview" },
    };

    const runPromise = runner.run({ task: geminiTask, directory: "/repo", prompt: "Do Gemini work", runStartedAt: 789 });
    harness.respond(await harness.nextMessage("initialize"), { protocolVersion: 1 });
    const sessionNew = await harness.nextMessage("session/new");
    harness.respond(sessionNew, { sessionId: "gemini-session-1" });
    const setMode = await harness.nextMessage("session/set_mode");
    harness.respond(setMode, {});
    const setModel = await harness.nextMessage("session/set_model");
    harness.respond(setModel, {});
    const prompt = await harness.nextMessage("session/prompt");
    await runPromise;

    expect(harness.spawn).toHaveBeenCalledWith("gemini", ["--acp", "--skip-trust"], {
      cwd: "/repo",
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(sessionNew.params).toEqual({
      cwd: "/repo",
      mcpServers: [{ name: "openboard", command: DEFAULT_MCP_COMMAND, args: ["mcp", "--worker", "--task-id", "task_1", "--instance", "alpha"], env: [] }],
      _meta: {},
    });
    expect(setMode.params).toEqual({ sessionId: "gemini-session-1", modeId: "default" });
    expect(setModel.params).toEqual({ sessionId: "gemini-session-1", modelId: "gemini-3.1-pro-preview" });
    expect(((prompt.params?.prompt as Array<{ text?: string }>)[0]?.text) ?? "").toContain("OPENBOARD GEMINI ACP WORKER CONTRACT");
    runner.shutdown();
  });

  it("discovers standard ACP modes and models from Gemini CLI", async () => {
    const harness = makeAcpHarness();
    const discovery = discoverAcpConfig("gemini-acp", { cwd: "/repo", env: {}, spawn: harness.spawn as never });

    harness.respond(await harness.nextMessage("initialize"), { protocolVersion: 1 });
    harness.respond(await harness.nextMessage("session/new"), {
      sessionId: "gemini-discovery-1",
      modes: { availableModes: [{ id: "default", name: "Default" }, { id: "yolo", name: "YOLO" }] },
      models: { availableModels: [{ modelId: "auto-gemini-3", name: "Auto" }, { modelId: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro" }] },
      configOptions: [{
        id: "model",
        category: "model",
        type: "select",
        options: [{ value: "config-option-model", name: "Config option model" }],
      }],
    });

    await expect(discovery).resolves.toMatchObject({
      available: true,
      modes: [{ value: "default", name: "Default" }, { value: "yolo", name: "YOLO" }],
      models: [{ id: "auto-gemini-3", name: "Auto" }, { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro" }],
    });
    expect(harness.spawn).toHaveBeenCalledWith("gemini", ["--acp", "--skip-trust"], {
      cwd: "/repo",
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    expect(harness.child.kill).toHaveBeenCalledOnce();
  });
});
