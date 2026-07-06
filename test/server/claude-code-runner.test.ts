import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ClaudeCodeRunner } from "../../src/server/claude-code-runner";
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

describe("ClaudeCodeRunner", () => {
  it("launches a named background Claude Code session with OpenBoard MCP instructions", async () => {
    const execFile = vi.fn((file, args, _options, callback) => {
      callback(null, "started 11111111-1111-4111-8111-111111111111", "");
    });
    const runner = new ClaudeCodeRunner({
      adapterBaseUrl: "http://127.0.0.1:4097",
      boardToken: "token",
      instanceName: "alpha",
      pluginDir: "/plugins/openboard",
      execFile: execFile as never,
      env: {},
    });

    const result = await runner.run({
      task,
      directory: "/repo",
      prompt: "Do the work",
      runStartedAt: 123,
    });

    expect(result).toEqual({
      sessionId: "11111111-1111-4111-8111-111111111111",
      sessionName: "openboard-task_1-123",
      status: "running",
    });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0][0]).toBe("claude");
    expect(execFile.mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        "--bg",
        "--plugin-dir",
        "/plugins/openboard",
        "--allowedTools",
        "mcp__openboard__complete_task,mcp__openboard__block_task",
        "--name",
        "openboard-task_1-123",
        "--permission-mode",
        "bypassPermissions",
        "--model",
        "sonnet",
      ]),
    );
    expect(execFile.mock.calls[0][1]).not.toContain("--cwd");
    expect(execFile.mock.calls[0][1]).not.toContain("--agent");
    expect(execFile.mock.calls[0][1]).not.toContain("build");
    const args = execFile.mock.calls[0][1] as string[];
    const mcpConfigPath = args[args.indexOf("--mcp-config") + 1];
    const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf8")) as {
      mcpServers: { openboard: { type: string; command: string; args: string[] } };
    };
    expect(mcpConfig.mcpServers.openboard).toEqual({
      type: "stdio",
      command: "openboard",
      args: ["mcp", "--instance", "alpha"],
    });
    expect(execFile.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        cwd: "/repo",
      }),
    );
    expect(execFile.mock.calls[0][1].at(-1)).toContain("OPENBOARD CLAUDE CODE WORKER CONTRACT");
    expect(execFile.mock.calls[0][1].at(-1)).toContain('complete_task with { taskId: "task_1", runStartedAt: 123');
  });

  it("writes an unbound env-backed MCP config when no instance name is available", async () => {
    const execFile = vi.fn((file, args, _options, callback) => {
      callback(null, "started", "");
    });
    const runner = new ClaudeCodeRunner({
      adapterBaseUrl: "http://127.0.0.1:4097",
      boardToken: "token",
      pluginDir: "/plugins/openboard",
      execFile: execFile as never,
      env: {},
    });

    await runner.run({
      task,
      directory: "/repo",
      prompt: "Do the work",
      runStartedAt: 124,
    });

    const args = execFile.mock.calls[0][1] as string[];
    const mcpConfigPath = args[args.indexOf("--mcp-config") + 1];
    const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf8")) as {
      mcpServers: {
        openboard: {
          type: string;
          command: string;
          args: string[];
          env: Record<string, string>;
        };
      };
    };
    expect(mcpConfig.mcpServers.openboard).toEqual({
      type: "stdio",
      command: "openboard",
      args: ["mcp"],
      env: {
        OPENCODE_BOARD_URL: "http://127.0.0.1:4097",
        OPENBOARD_API_TOKEN: "token",
      },
    });
  });

  it("polls all background agents so completed sessions remain visible", async () => {
    const execFile = vi.fn((file, args, _options, callback) => {
      callback(null, JSON.stringify([{ name: "openboard-task_1-123", status: "completed", cwd: "/repo/.claude/worktrees/task-1" }]), "");
    });
    const runner = new ClaudeCodeRunner({
      adapterBaseUrl: "http://127.0.0.1:4097",
      execFile: execFile as never,
      env: {},
    });

    await expect(runner.poll("openboard-task_1-123")).resolves.toEqual({
      status: "completed",
      terminal: true,
      cwd: "/repo/.claude/worktrees/task-1",
    });
    expect(execFile).toHaveBeenCalledWith(
      "claude",
      ["agents", "--json", "--all"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("uses the task permission mode when one is selected on the card", async () => {
    const execFile = vi.fn((file, args, _options, callback) => {
      callback(null, "started", "");
    });
    const runner = new ClaudeCodeRunner({
      adapterBaseUrl: "http://127.0.0.1:4097",
      pluginDir: "/plugins/openboard",
      permissionMode: "bypassPermissions",
      execFile: execFile as never,
      env: {},
    });

    await runner.run({
      task: { ...task, claudePermissionMode: "manual" },
      directory: "/repo",
      prompt: "Do the work",
      runStartedAt: 456,
    });

    expect(execFile.mock.calls[0][1]).toEqual(
      expect.arrayContaining(["--permission-mode", "manual"]),
    );
  });
});
