import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ClaudeAcpRunner, CodexAcpRunner, decideClaudeAcpPermission } from "../../src/server/claude-acp-runner";
import type { Task } from "../../src/shared";

const task: Task = {
  id: "task_1",
  type: "agent",
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

  function requestPermission(params: Record<string, unknown>): number {
    child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 99, method: "session/request_permission", params })}\n`);
    return 99;
  }

  const spawn = vi.fn(() => child as never);
  return { child, nextMessage, requestPermission, respond, spawn };
}

async function launchRunner(harness = makeAcpHarness()) {
  const runner = new ClaudeAcpRunner({
    adapterBaseUrl: "http://127.0.0.1:4097",
    boardToken: "token",
    instanceName: "alpha",
    command: "claude-acp",
    commandArgs: ["--stdio"],
    spawn: harness.spawn as never,
    env: {},
  });

  const runPromise = runner.run({
    task,
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
          command: "openboard",
          args: ["mcp", "--instance", "alpha"],
          env: [],
        },
      ],
      _meta: { claudeCode: { options: { model: "sonnet" } } },
    });
    expect(setMode.params).toEqual({ sessionId: "acp-session-1", modeId: "bypassPermissions" });
    expect(prompt.params?.sessionId).toBe("acp-session-1");
    const promptText = ((prompt.params?.prompt as Array<{ text?: string }> | undefined)?.[0]?.text) ?? "";
    expect(promptText).toContain("OPENBOARD CLAUDE ACP WORKER CONTRACT");
    expect(promptText).toContain('complete_task with { taskId: "task_1", runStartedAt: 123');
  });

  it("marks the in-memory session idle when the prompt completes", async () => {
    const { harness, prompt, result, runner } = await launchRunner();

    harness.respond(prompt, { stopReason: "end_turn" });
    await Promise.resolve();

    await expect(runner.poll(result.sessionName)).resolves.toEqual({
      status: "idle",
      terminal: true,
      cwd: "/repo",
    });
    expect(harness.child.kill).toHaveBeenCalledTimes(1);
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
      options: [{ optionId: "allow", kind: "allow" }, { optionId: "reject", kind: "reject" }],
    });
    const response = await harness.nextMessage();

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 99,
      result: { outcome: { outcome: "selected", optionId: "allow" } },
    });
    await expect(runner.poll("openboard-task_1-123")).resolves.toMatchObject({ status: "running" });
  });

  it("keeps default/manual permission decisions inside the task directory", () => {
    const permission = (toolCall: Record<string, unknown>) => ({
      sessionId: "s1",
      toolCall,
      options: [{ optionId: "allow", kind: "allow" }, { optionId: "reject", kind: "reject" }],
    });

    expect(decideClaudeAcpPermission(permission({ kind: "edit", rawInput: { file_path: "/repo/src/file.ts" } }), "/repo", "manual")).toBe("allow");
    expect(decideClaudeAcpPermission(permission({ kind: "edit", rawInput: { file_path: "/tmp/file.ts" } }), "/repo", "manual")).toBe("reject");
    expect(decideClaudeAcpPermission(permission({ _meta: { claudeCode: { toolName: "Bash" } }, rawInput: { command: "npm test" } }), "/repo", "manual")).toBe("allow");
    expect(decideClaudeAcpPermission(permission({ _meta: { claudeCode: { toolName: "Bash" } }, rawInput: { command: "cat /tmp/secret" } }), "/repo", "manual")).toBe("reject");
    expect(decideClaudeAcpPermission(permission({ _meta: { claudeCode: { toolName: "mcp__openboard__complete_task" } }, rawInput: {} }), "/repo", "manual")).toBe("allow");
    expect(decideClaudeAcpPermission(permission({ kind: "edit", rawInput: { file_path: "/tmp/file.ts" } }), "/repo", "bypassPermissions")).toBe("allow");
  });
});

describe("CodexAcpRunner", () => {
  it("starts a Codex ACP session with OpenBoard MCP and Codex/OpenAI model metadata", async () => {
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
      permissionMode: "manual",
      acpOptions: { reasoningEffort: "low" },
      model: { providerID: "codex", id: "gpt-5-codex" },
    };

    const runPromise = runner.run({ task: codexTask, directory: "/repo", prompt: "Do Codex work", runStartedAt: 456 });
    harness.respond(await harness.nextMessage("initialize"), { protocolVersion: 1 });
    const sessionNew = await harness.nextMessage("session/new");
    harness.respond(sessionNew, { sessionId: "codex-session-1" });
    const setMode = await harness.nextMessage("session/set_mode");
    harness.respond(setMode, {});
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
      mcpServers: [{ name: "openboard", command: "openboard", args: ["mcp", "--instance", "alpha"], env: [] }],
      _meta: {
        openboard: { permissionMode: "manual", acpOptions: { reasoningEffort: "low" } },
        codex: { options: { model: "gpt-5-codex", reasoningEffort: "low" } },
        openai: { options: { model: "gpt-5-codex", reasoningEffort: "low" } },
      },
    });
    expect(setMode.params).toEqual({ sessionId: "codex-session-1", modeId: "default" });
    const promptText = ((prompt.params?.prompt as Array<{ text?: string }> | undefined)?.[0]?.text) ?? "";
    expect(promptText).toContain("OPENBOARD CODEX ACP WORKER CONTRACT");
    expect(promptText).not.toContain("reasoningEffort");
    expect(promptText).toContain('complete_task with { taskId: "task_1", runStartedAt: 456');
  });

  it("allows OpenBoard report tools by bare or namespaced ACP tool name", () => {
    const request = (toolCall: Record<string, unknown>) => ({
      sessionId: "session",
      toolCall,
      options: [{ optionId: "allow", kind: "allow" }, { optionId: "reject", kind: "reject" }],
    });

    expect(decideClaudeAcpPermission(request({ rawInput: { toolName: "complete_task" } }), "/repo", "manual")).toBe("allow");
    expect(decideClaudeAcpPermission(request({ rawInput: { toolName: "openboard.block_task" } }), "/repo", "manual")).toBe("allow");
    expect(decideClaudeAcpPermission(request({ rawInput: { toolName: "other.complete_task" } }), "/repo", "manual")).toBe("reject");
  });
});
