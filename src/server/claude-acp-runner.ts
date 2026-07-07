import { spawn as nodeSpawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_CLAUDE_CODE_PERMISSION_MODE, type ClaudeCodePermissionMode } from "../shared";
import type {
  ClaudeCodeRunInput,
  ClaudeCodeRunResult,
  ClaudeCodeRunnerDeps,
  ClaudeCodeRunnerLike,
  ClaudeCodeStatus,
} from "./claude-code-runner";

type Spawn = typeof nodeSpawn;
type SpawnedProcess = ReturnType<Spawn>;

type JsonRpcId = string | number;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface AcpToolCall {
  toolCallId?: string;
  title?: string;
  kind?: string;
  rawInput?: unknown;
  locations?: Array<{ path?: unknown }>;
  _meta?: Record<string, unknown>;
}

interface AcpPermissionParams {
  sessionId: string;
  toolCall: AcpToolCall;
  options: Array<{ optionId: string; kind: string }>;
}

interface AcpSessionState {
  child: SpawnedProcess;
  sessionId: string;
  sessionName: string;
  cwd: string;
  status: string;
  terminal: boolean;
  error?: string;
  buffer: string;
  nextId: number;
  pending: Map<JsonRpcId, PendingRequest>;
  permissionMode: ClaudeCodePermissionMode;
}

interface AcpRunnerServiceConfig {
  envCommand: string;
  fallbackCommand: string;
  packageName?: string;
  metaKeys: string[];
  contractName: string;
  sessionLabel: string;
  displayName: string;
  mcpCommandEnv?: string;
  omitModelIds?: readonly string[];
  extraMeta?: Record<string, unknown>;
}

export interface ClaudeAcpRunnerDeps extends ClaudeCodeRunnerDeps {
  spawn?: Spawn;
  commandArgs?: string[];
  service?: AcpRunnerServiceConfig;
  mcpCommand?: string;
}

const READ_TOOL_NAMES = new Set(["Read", "LS", "Glob", "Grep", "TodoRead", "TaskList", "TaskGet"]);
const OPENBOARD_REPORT_TOOLS = new Set([
  "mcp__openboard__complete_task",
  "mcp__openboard__block_task",
]);
const OPENBOARD_REPORT_TOOL_NAMES = new Set(["complete_task", "block_task"]);

const requireFromHere = createRequire(import.meta.url);

const CLAUDE_ACP_SERVICE: AcpRunnerServiceConfig = {
  envCommand: "OPENBOARD_CLAUDE_ACP_COMMAND",
  fallbackCommand: "claude-agent-acp",
  packageName: "@agentclientprotocol/claude-agent-acp",
  metaKeys: ["claudeCode"],
  contractName: "OPENBOARD CLAUDE ACP WORKER CONTRACT",
  sessionLabel: "Claude",
  displayName: "Claude ACP",
};

const CODEX_ACP_SERVICE: AcpRunnerServiceConfig = {
  envCommand: "OPENBOARD_CODEX_ACP_COMMAND",
  fallbackCommand: "codex-acp",
  packageName: "@agentclientprotocol/codex-agent-acp",
  metaKeys: ["codex", "openai"],
  contractName: "OPENBOARD CODEX ACP WORKER CONTRACT",
  sessionLabel: "Codex ACP",
  displayName: "Codex ACP",
};

const GEMINI_ACP_SERVICE: AcpRunnerServiceConfig = {
  envCommand: "OPENBOARD_GEMINI_ACP_COMMAND",
  fallbackCommand: "gemini-agent-acp",
  packageName: "@agentclientprotocol/gemini-agent-acp",
  metaKeys: ["gemini"],
  contractName: "OPENBOARD GEMINI ACP WORKER CONTRACT",
  sessionLabel: "Gemini ACP",
  displayName: "Gemini ACP",
};

const HERMES_ACP_SERVICE: AcpRunnerServiceConfig = {
  envCommand: "OPENBOARD_HERMES_ACP_COMMAND",
  fallbackCommand: "hermes-agent-acp",
  metaKeys: ["hermes"],
  contractName: "OPENBOARD HERMES ACP WORKER CONTRACT",
  sessionLabel: "Hermes ACP",
  displayName: "Hermes ACP",
  extraMeta: { openboard: { harness: "hermes" } },
};

const PI_ACP_SERVICE: AcpRunnerServiceConfig = {
  envCommand: "OPENBOARD_PI_ACP_COMMAND",
  fallbackCommand: "pi-coding-agent-acp",
  metaKeys: ["piCodingAgent"],
  contractName: "OPENBOARD PI CODING AGENT ACP WORKER CONTRACT",
  sessionLabel: "Pi Coding Agent",
  displayName: "Pi ACP",
  omitModelIds: ["default"],
};

const CURSOR_ACP_SERVICE: AcpRunnerServiceConfig = {
  envCommand: "OPENBOARD_CURSOR_ACP_COMMAND",
  fallbackCommand: "cursor-agent-acp",
  metaKeys: ["cursor"],
  contractName: "OPENBOARD CURSOR ACP WORKER CONTRACT",
  sessionLabel: "Cursor ACP",
  displayName: "Cursor ACP",
  mcpCommandEnv: "OPENBOARD_CURSOR_ACP_MCP_COMMAND",
};

function defaultCommand(service: AcpRunnerServiceConfig, env: NodeJS.ProcessEnv): { command: string; args: string[] } {
  const configured = env[service.envCommand]?.trim();
  if (configured) return { command: configured, args: [] };

  if (service.packageName) {
    try {
      const packageJsonPath = requireFromHere.resolve(`${service.packageName}/package.json`);
      return {
        command: process.execPath,
        args: [join(dirname(packageJsonPath), "dist/index.js")],
      };
    } catch {
      // Fall through to the adapter binary name.
    }
  }
  return { command: service.fallbackCommand, args: [] };
}

function normalizeMode(mode: ClaudeCodePermissionMode): string {
  return mode === "manual" ? "default" : mode;
}

function isPathUnder(candidate: string, root: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(root, candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}/`);
}

function valuesFromInput(value: unknown, keys: Set<string>, output: string[] = []): string[] {
  if (value === null || value === undefined) return output;
  if (typeof value !== "object") return output;
  if (Array.isArray(value)) {
    for (const item of value) valuesFromInput(item, keys, output);
    return output;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (keys.has(key) && typeof item === "string" && item.trim()) output.push(item);
    else valuesFromInput(item, keys, output);
  }
  return output;
}

function absolutePathsInCommand(command: string): string[] {
  const matches = command.match(/(?<![\w.-])\/(?:[^\s'"`;$|&<>\\]|\\.)+/g);
  return matches ?? [];
}

function commandLooksOutsideFence(command: string, cwd: string): boolean {
  for (const absolutePath of absolutePathsInCommand(command)) {
    if (!isPathUnder(absolutePath, cwd)) return true;
  }
  return false;
}

function toolName(toolCall: AcpToolCall): string | undefined {
  const raw = toolCall.rawInput;
  if (raw !== null && typeof raw === "object") {
    const name = (raw as Record<string, unknown>).toolName ?? (raw as Record<string, unknown>).tool_name ?? (raw as Record<string, unknown>).name;
    if (typeof name === "string" && name) return name;
  }
  for (const value of Object.values(toolCall._meta ?? {})) {
    if (value !== null && typeof value === "object") {
      const name = (value as Record<string, unknown>).toolName ?? (value as Record<string, unknown>).tool_name;
      if (typeof name === "string" && name) return name;
    }
  }
  return undefined;
}

function isOpenBoardReportToolName(name: string): boolean {
  if (OPENBOARD_REPORT_TOOLS.has(name)) return true;
  const parts = name.trim().split(/__|[.:/]/).filter(Boolean);
  const last = parts[parts.length - 1] ?? name;
  if (!OPENBOARD_REPORT_TOOL_NAMES.has(last)) return false;
  return parts.length === 1 || parts.includes("openboard");
}

export function decideClaudeAcpPermission(
  params: AcpPermissionParams,
  cwd: string,
  permissionMode: ClaudeCodePermissionMode,
): "allow" | "reject" {
  if (permissionMode === "bypassPermissions") return "allow";

  const call = params.toolCall;
  const name = toolName(call);
  if (name && (READ_TOOL_NAMES.has(name) || isOpenBoardReportToolName(name))) return "allow";

  const kind = call.kind;
  if (kind === "read" || kind === "search" || kind === "fetch" || kind === "think") return "allow";

  if (name === "Bash" || kind === "execute") {
    const command = valuesFromInput(call.rawInput, new Set(["command"]))[0];
    if (!command) return "reject";
    return commandLooksOutsideFence(command, cwd) ? "reject" : "allow";
  }

  if (kind === "edit" || kind === "delete" || kind === "move" || name === "Write" || name === "Edit" || name === "MultiEdit") {
    const paths = [
      ...valuesFromInput(call.rawInput, new Set(["file_path", "path", "notebook_path"])),
      ...(call.locations ?? []).flatMap((location) => (typeof location.path === "string" ? [location.path] : [])),
    ];
    if (paths.length === 0) return "reject";
    return paths.every((path) => isPathUnder(path, cwd)) ? "allow" : "reject";
  }

  return "reject";
}

function chooseOption(options: AcpPermissionParams["options"], decision: "allow" | "reject"): string {
  const preferred =
    decision === "allow"
      ? ["allow", "allow_once", "once", "allow_always"]
      : ["reject", "reject_once", "reject_always"];
  for (const id of preferred) {
    const match = options.find((option) => option.optionId === id || option.kind === id);
    if (match) return match.optionId;
  }
  if (decision === "allow") return options[0]?.optionId ?? "allow";
  return "reject";
}

function errorFromRpc(error: unknown): Error {
  if (error !== null && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return new Error(message);
  }
  return new Error("ACP request failed");
}

export class ClaudeAcpRunner implements ClaudeCodeRunnerLike {
  private readonly adapterBaseUrl: string;
  private readonly boardToken?: string;
  private readonly instanceName?: string;
  private readonly spawn: Spawn;
  private readonly env: NodeJS.ProcessEnv;
  private readonly command: string;
  private readonly commandArgs: string[];
  private readonly mcpCommand: string;
  private readonly permissionMode: ClaudeCodePermissionMode;
  private readonly service: AcpRunnerServiceConfig;
  private readonly sessions = new Map<string, AcpSessionState>();

  constructor(deps: ClaudeAcpRunnerDeps) {
    this.adapterBaseUrl = deps.adapterBaseUrl;
    this.boardToken = deps.boardToken;
    this.instanceName = deps.instanceName;
    this.spawn = deps.spawn ?? nodeSpawn;
    this.env = deps.env ?? process.env;
    this.service = deps.service ?? CLAUDE_ACP_SERVICE;
    const command = deps.command ? { command: deps.command, args: deps.commandArgs ?? [] } : defaultCommand(this.service, this.env);
    this.command = command.command;
    this.commandArgs = command.args;
    this.mcpCommand = (deps.mcpCommand ?? (this.service.mcpCommandEnv ? this.env[this.service.mcpCommandEnv]?.trim() : undefined)) || "openboard";
    const envPermissionMode = this.env.OPENBOARD_CLAUDE_PERMISSION_MODE?.trim();
    this.permissionMode = (deps.permissionMode as ClaudeCodePermissionMode | undefined) ?? (envPermissionMode as ClaudeCodePermissionMode | undefined) ?? DEFAULT_CLAUDE_CODE_PERMISSION_MODE;
  }

  run(input: ClaudeCodeRunInput): Promise<ClaudeCodeRunResult> {
    return this.start(input);
  }

  retry(input: ClaudeCodeRunInput): Promise<ClaudeCodeRunResult> {
    return this.start(input);
  }

  async poll(sessionName: string): Promise<ClaudeCodeStatus | undefined> {
    const session = this.sessions.get(sessionName);
    if (!session) return undefined;
    return {
      status: session.status,
      terminal: session.terminal,
      cwd: session.cwd,
      ...(session.error ? { error: session.error } : {}),
    };
  }

  async abort(sessionName: string): Promise<void> {
    const session = this.sessions.get(sessionName);
    if (!session) return;
    this.sendNotification(session, "session/cancel", { sessionId: session.sessionId });
    session.status = "aborted";
    session.terminal = true;
    session.error = "aborted";
    session.child.kill();
  }

  private async start(input: ClaudeCodeRunInput): Promise<ClaudeCodeRunResult> {
    const sessionName = `openboard-${input.task.id}-${input.runStartedAt}`;
    const permissionMode = input.task.claudePermissionMode ?? this.permissionMode;
    const child = this.spawn(this.command, this.commandArgs, {
      cwd: input.directory,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const state: AcpSessionState = {
      child,
      sessionId: sessionName,
      sessionName,
      cwd: input.directory,
      status: "starting",
      terminal: false,
      buffer: "",
      nextId: 1,
      pending: new Map(),
      permissionMode,
    };
    this.sessions.set(sessionName, state);
    this.attachProcessHandlers(state);

    await this.request(state, "initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        _meta: { terminal_output: true },
      },
    });

    const created = await this.request(state, "session/new", {
      cwd: input.directory,
      mcpServers: this.mcpServers(),
      _meta: this.sessionMeta(input),
    });
    const sessionId = (created as { sessionId?: unknown })?.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      throw new Error(`${this.service.displayName} session/new returned no sessionId`);
    }
    state.sessionId = sessionId;

    await this.trySetMode(state, permissionMode);

    state.status = "running";
    void this.request(state, "session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: this.withWorkerContract(input) }],
    }).then(
      (result) => {
        const stopReason = (result as { stopReason?: unknown })?.stopReason;
        state.status = stopReason === "cancelled" ? "cancelled" : "idle";
        state.terminal = true;
        if (stopReason === "cancelled") state.error = "cancelled";
        state.child.kill();
      },
      (error) => {
        state.status = "error";
        state.terminal = true;
        state.error = error.message;
        state.child.kill();
      },
    );

    return { sessionId, sessionName, status: "running" };
  }

  private sessionMeta(input: ClaudeCodeRunInput): Record<string, unknown> {
    const model = input.task.model?.id && !this.service.omitModelIds?.includes(input.task.model.id)
      ? { model: input.task.model.id }
      : {};
    const meta: Record<string, unknown> = { ...(this.service.extraMeta ?? {}) };
    for (const key of this.service.metaKeys) {
      meta[key] = {
        options: {
          ...model,
        },
      };
    }
    return meta;
  }

  private async trySetMode(state: AcpSessionState, mode: ClaudeCodePermissionMode): Promise<void> {
    try {
      await this.request(state, "session/set_mode", {
        sessionId: state.sessionId,
        modeId: normalizeMode(mode),
      });
    } catch {
      // Older adapters or unavailable modes should not prevent dispatch. The
      // adapter still runs with its configured default mode.
    }
  }

  private mcpServers(): Array<{ name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }> {
    if (this.instanceName) {
      return [
        {
          name: "openboard",
          command: this.mcpCommand,
          args: ["mcp", "--instance", this.instanceName],
          env: [],
        },
      ];
    }

    return [
      {
        name: "openboard",
        command: this.mcpCommand,
        args: ["mcp"],
        env: [
          { name: "OPENCODE_BOARD_URL", value: this.adapterBaseUrl },
          ...(this.boardToken ? [{ name: "OPENBOARD_API_TOKEN", value: this.boardToken }] : []),
        ],
      },
    ];
  }

  private withWorkerContract(input: ClaudeCodeRunInput): string {
    return `${input.prompt}\n\n---\n${this.service.contractName}\nTask id: ${input.task.id}\nBoard URL: ${this.adapterBaseUrl}\nWorking directory: ${input.directory}\n\nUse the OpenBoard MCP tools loaded in this ${this.service.sessionLabel} session. If you change directories, create a worktree, or commit to a branch, include the actual cwd, branch, and commit in your summary or residual risk. When all work and verification are complete, call exactly one of these MCP tools as your final action:\n\n- complete_task with { taskId: "${input.task.id}", runStartedAt: ${input.runStartedAt}, report: { summary, changedFiles, verification, residualRisk } }\n- block_task with { taskId: "${input.task.id}", runStartedAt: ${input.runStartedAt}, report: { summary, changedFiles, verification, residualRisk } }\n\nDo not just describe completion in chat. Do not move the card to Done. The OpenBoard orchestrator will review and integrate the work.`;
  }

  private request(state: AcpSessionState, method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = state.nextId++;
    this.write(state, { jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      state.pending.set(id, { resolve, reject });
    });
  }

  private sendNotification(state: AcpSessionState, method: string, params: Record<string, unknown>): void {
    this.write(state, { jsonrpc: "2.0", method, params });
  }

  private write(state: AcpSessionState, message: Record<string, unknown>): void {
    state.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private attachProcessHandlers(state: AcpSessionState): void {
    state.child.stdout?.on("data", (chunk) => this.consume(state, chunk.toString("utf8")));
    state.child.stderr?.on("data", (chunk) => {
      if (!state.error) state.error = chunk.toString("utf8").trim() || undefined;
    });
    state.child.on("error", (error) => this.failSession(state, error));
    state.child.on("close", () => {
      if (!state.terminal) {
        this.failSession(state, new Error(state.error ?? `${this.service.displayName} process exited`));
      }
    });
  }

  private consume(state: AcpSessionState, chunk: string): void {
    state.buffer += chunk;
    let newline = state.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = state.buffer.slice(0, newline).trim();
      state.buffer = state.buffer.slice(newline + 1);
      if (line) this.handleMessage(state, line);
      newline = state.buffer.indexOf("\n");
    }
  }

  private handleMessage(state: AcpSessionState, line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = message.id as JsonRpcId | undefined;
    if (id !== undefined && (Object.prototype.hasOwnProperty.call(message, "result") || Object.prototype.hasOwnProperty.call(message, "error"))) {
      const pending = state.pending.get(id);
      if (!pending) return;
      state.pending.delete(id);
      if (message.error) pending.reject(errorFromRpc(message.error));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === "string" && id !== undefined) {
      void this.handleRequest(state, id, message.method, message.params);
    }
  }

  private async handleRequest(
    state: AcpSessionState,
    id: JsonRpcId,
    method: string,
    params: unknown,
  ): Promise<void> {
    if (method !== "session/request_permission") {
      this.write(state, { jsonrpc: "2.0", id, error: { code: -32601, message: `Unsupported client method: ${method}` } });
      return;
    }
    const permission = params as AcpPermissionParams;
    const decision = decideClaudeAcpPermission(permission, state.cwd, state.permissionMode);
    this.write(state, {
      jsonrpc: "2.0",
      id,
      result: {
        outcome: {
          outcome: "selected",
          optionId: chooseOption(permission.options ?? [], decision),
        },
      },
    });
  }

  private failSession(state: AcpSessionState, error: Error): void {
    state.status = "error";
    state.terminal = true;
    state.error = error.message;
    for (const pending of state.pending.values()) pending.reject(error);
    state.pending.clear();
  }
}

export class CodexAcpRunner extends ClaudeAcpRunner {
  constructor(deps: Omit<ClaudeAcpRunnerDeps, "service">) {
    super({ ...deps, service: CODEX_ACP_SERVICE });
  }
}

export class GeminiAcpRunner extends ClaudeAcpRunner {
  constructor(deps: Omit<ClaudeAcpRunnerDeps, "service">) {
    super({ ...deps, service: GEMINI_ACP_SERVICE });
  }
}

export class HermesAcpRunner extends ClaudeAcpRunner {
  constructor(deps: Omit<ClaudeAcpRunnerDeps, "service">) {
    super({ ...deps, service: HERMES_ACP_SERVICE });
  }
}

export class PiAcpRunner extends ClaudeAcpRunner {
  constructor(deps: Omit<ClaudeAcpRunnerDeps, "service">) {
    super({ ...deps, service: PI_ACP_SERVICE });
  }
}

export class CursorAcpRunner extends ClaudeAcpRunner {
  constructor(deps: Omit<ClaudeAcpRunnerDeps, "service">) {
    super({ ...deps, service: CURSOR_ACP_SERVICE });
  }
}
