import { execFile as nodeExecFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CLAUDE_CODE_PERMISSION_MODE } from "../shared";
import type { Task } from "../shared";

type ExecFile = typeof nodeExecFile;

const OPENBOARD_CLAUDE_ALLOWED_TOOLS = "mcp__openboard__complete_task,mcp__openboard__block_task";

export interface ClaudeCodeRunInput {
  task: Task;
  directory: string;
  prompt: string;
  runStartedAt: number;
}

export interface ClaudeCodeRunResult {
  sessionId: string;
  sessionName: string;
  status: string;
}

export interface ClaudeCodeStatus {
  status: string;
  terminal: boolean;
  cwd?: string;
  error?: string;
}

export interface ClaudeCodeRunnerLike {
  run(input: ClaudeCodeRunInput): Promise<ClaudeCodeRunResult>;
  retry(input: ClaudeCodeRunInput): Promise<ClaudeCodeRunResult>;
  poll(sessionName: string): Promise<ClaudeCodeStatus | undefined>;
  abort(sessionName: string): Promise<void>;
}

export interface ClaudeCodeRunnerDeps {
  adapterBaseUrl: string;
  boardToken?: string;
  instanceName?: string;
  command?: string;
  pluginDir?: string;
  permissionMode?: string;
  execFile?: ExecFile;
  env?: NodeJS.ProcessEnv;
}

function execFileText(
  execFile: ExecFile,
  file: string,
  args: string[],
  options: Parameters<ExecFile>[2],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({
        stdout: typeof stdout === "string" ? stdout : stdout?.toString("utf8") ?? "",
        stderr: typeof stderr === "string" ? stderr : stderr?.toString("utf8") ?? "",
      });
    });
  });
}

function extractSessionId(output: string, fallback: string): string {
  const uuid = output.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
  return uuid ?? fallback;
}

function statusValue(record: Record<string, unknown>): string | undefined {
  for (const key of ["status", "state", "runState", "phase"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function isTerminalStatus(status: string): boolean {
  return ["completed", "complete", "done", "finished", "success", "failed", "error", "stopped", "cancelled", "canceled"].includes(status.toLowerCase());
}

function isErrorStatus(status: string): boolean {
  return ["failed", "error", "stopped", "cancelled", "canceled"].includes(status.toLowerCase());
}

export class ClaudeCodeRunner implements ClaudeCodeRunnerLike {
  private readonly adapterBaseUrl: string;
  private readonly boardToken?: string;
  private readonly instanceName?: string;
  private readonly command: string;
  private readonly pluginDir: string;
  private readonly permissionMode?: string;
  private readonly execFile: ExecFile;
  private readonly env: NodeJS.ProcessEnv;

  constructor(deps: ClaudeCodeRunnerDeps) {
    this.adapterBaseUrl = deps.adapterBaseUrl;
    this.boardToken = deps.boardToken;
    this.instanceName = deps.instanceName;
    this.command = deps.command ?? "claude";
    this.pluginDir = deps.pluginDir ?? process.env.OPENBOARD_CLAUDE_PLUGIN_DIR ?? "/Users/johnnyvitale/plugins/openboard";
    const envPermissionMode = process.env.OPENBOARD_CLAUDE_PERMISSION_MODE?.trim();
    this.permissionMode = deps.permissionMode ?? (envPermissionMode || DEFAULT_CLAUDE_CODE_PERMISSION_MODE);
    this.execFile = deps.execFile ?? nodeExecFile;
    this.env = deps.env ?? process.env;
  }

  run(input: ClaudeCodeRunInput): Promise<ClaudeCodeRunResult> {
    return this.spawnBackground(input);
  }

  retry(input: ClaudeCodeRunInput): Promise<ClaudeCodeRunResult> {
    return this.spawnBackground(input);
  }

  async poll(sessionName: string): Promise<ClaudeCodeStatus | undefined> {
    const result = await execFileText(this.execFile, this.command, ["agents", "--json", "--all"], {
      env: this.env,
      maxBuffer: 1024 * 1024,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return undefined;
    }
    if (!Array.isArray(parsed)) return undefined;
    const record = parsed.find((item) => {
      if (item === null || typeof item !== "object") return false;
      const candidate = item as Record<string, unknown>;
      return candidate.name === sessionName || candidate.sessionName === sessionName || candidate.id === sessionName || candidate.sessionId === sessionName;
    });
    if (record === null || typeof record !== "object") return undefined;
    const status = statusValue(record as Record<string, unknown>) ?? "unknown";
    const cwd = cwdValue(record as Record<string, unknown>);
    return {
      status,
      terminal: isTerminalStatus(status),
      ...(cwd ? { cwd } : {}),
      ...(isErrorStatus(status) ? { error: status } : {}),
    };
  }

  async abort(_sessionName: string): Promise<void> {
    throw new Error("Claude Code background abort is not supported by the detected Claude CLI");
  }

  private async spawnBackground(input: ClaudeCodeRunInput): Promise<ClaudeCodeRunResult> {
    const sessionName = `openboard-${input.task.id}-${input.runStartedAt}`;
    const mcpConfigDir = join(tmpdir(), "openboard-claude-mcp");
    await mkdir(mcpConfigDir, { recursive: true, mode: 0o700 });
    const mcpConfigPath = join(mcpConfigDir, `${sessionName}.json`);
    await writeFile(mcpConfigPath, JSON.stringify(this.mcpConfig(), null, 2), { mode: 0o600 });
    const permissionMode = input.task.claudePermissionMode ?? this.permissionMode;

    const args = [
      "--bg",
      "--plugin-dir",
      this.pluginDir,
      "--mcp-config",
      mcpConfigPath,
      "--allowedTools",
      OPENBOARD_CLAUDE_ALLOWED_TOOLS,
      "--name",
      sessionName,
      ...(permissionMode ? ["--permission-mode", permissionMode] : []),
      ...(input.task.model ? ["--model", input.task.model.id] : []),
      this.withWorkerContract(input),
    ];

    const result = await execFileText(this.execFile, this.command, args, {
      cwd: input.directory,
      env: this.env,
      maxBuffer: 1024 * 1024,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    return {
      sessionId: extractSessionId(output, sessionName),
      sessionName,
      status: "running",
    };
  }

  private mcpConfig(): Record<string, unknown> {
    if (this.instanceName) {
      return {
        mcpServers: {
          openboard: {
            type: "stdio",
            command: "openboard",
            args: ["mcp", "--instance", this.instanceName],
          },
        },
      };
    }

    return {
      mcpServers: {
        openboard: {
          type: "stdio",
          command: "openboard",
          args: ["mcp"],
          env: {
            OPENCODE_BOARD_URL: this.adapterBaseUrl,
            ...(this.boardToken ? { OPENBOARD_API_TOKEN: this.boardToken } : {}),
          },
        },
      },
    };
  }

  private withWorkerContract(input: ClaudeCodeRunInput): string {
    return `${input.prompt}\n\n---\nOPENBOARD CLAUDE CODE WORKER CONTRACT\nTask id: ${input.task.id}\nBoard URL: ${this.adapterBaseUrl}\nWorking directory: ${input.directory}\n\nUse the OpenBoard MCP tools loaded in this Claude Code session. If you change directories, create a worktree, or commit to a branch, include the actual cwd, branch, and commit in your summary or residual risk. When all work and verification are complete, call exactly one of these MCP tools as your final action:\n\n- complete_task with { taskId: "${input.task.id}", runStartedAt: ${input.runStartedAt}, report: { summary, changedFiles, verification, residualRisk } }\n- block_task with { taskId: "${input.task.id}", runStartedAt: ${input.runStartedAt}, report: { summary, changedFiles, verification, residualRisk } }\n\nDo not just describe completion in chat. Do not move the card to Done. The OpenBoard orchestrator will review and integrate the work.`;
  }
}

function cwdValue(record: Record<string, unknown>): string | undefined {
  for (const key of ["cwd", "directory", "workingDirectory"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}
