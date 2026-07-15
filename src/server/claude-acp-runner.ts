import { spawn as nodeSpawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ACP_PERMISSION_MODE, type AcpPermissionMode } from "../shared";
import type { AcpConfigOption, AcpConfigValueOption, AcpHarnessConfig, AcpModelOption, AcpOptionValue, AcpTaskHarness, PendingPermissionAsk, RespondPermissionInput, SessionActivityToolStatus } from "../shared";
import type {
  ClaudeCodeRunInput,
  ClaudeCodeRunResult,
  ClaudeCodeRunnerDeps,
  ClaudeCodeRunnerLike,
  ClaudeCodeStatus,
} from "./acp-runner";
import { completionHandoffGuidance } from "./completion-contract";
import { createPermissionBroker, PermissionActionUnsupportedError, type PermissionAskEvent, type PermissionBroker, type PermissionBrokerClock, type RespondOutcome } from "./permission-broker";
import type { SessionActivityEventInput } from "./session-activity";
import { DEFAULT_PERMISSION_TIMEOUT_MS } from "../shared/permission-settings";

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
  taskId: string;
  runStartedAt: number;
  harness: AcpTaskHarness;
  sessionId: string;
  sessionName: string;
  cwd: string;
  status: string;
  terminal: boolean;
  error?: string;
  buffer: string;
  nextId: number;
  pending: Map<JsonRpcId, PendingRequest>;
  permissionMode: AcpPermissionMode;
  activePrompt?: Promise<unknown>;
}

interface AcpRunnerServiceConfig {
  envCommand: string;
  commandArgs?: string[];
  permissionModeEnv?: string;
  defaultMode?: AcpPermissionMode;
  fallbackCommand: string;
  packageName?: string;
  metaKeys: string[];
  contractName: string;
  sessionLabel: string;
  displayName: string;
  mcpCommandEnv?: string;
  omitModelIds?: readonly string[];
  extraMeta?: Record<string, unknown>;
  configOptions?: boolean;
  setModel?: boolean;
}

export interface ClaudeAcpRunnerDeps extends ClaudeCodeRunnerDeps {
  spawn?: Spawn;
  commandArgs?: string[];
  service?: AcpRunnerServiceConfig;
  mcpCommand?: string;
  permissionGraceMs?: number | (() => number);
  permissionClock?: PermissionBrokerClock;
  /** Board-wide broker. When omitted, this runner owns a private broker. */
  permissionBroker?: PermissionBroker;
  onPermissionEvent?: (event: PermissionAskEvent) => void;
  onActivity?: (taskId: string, runStartedAt: number, input: SessionActivityEventInput) => void;
  onRunTerminal?: (taskId: string, runStartedAt: number, status: "complete" | "error" | "aborted") => void;
}

const SUMMARY_MAX = 240;
const READ_TOOL_NAMES = new Set(["Read", "LS", "Glob", "Grep", "TodoRead", "TaskList", "TaskGet"]);
const OPENBOARD_REPORT_TOOLS = new Set([
  "mcp__openboard__complete_task",
  "mcp__openboard__block_task",
]);
const OPENBOARD_REPORT_TOOL_NAMES = new Set(["complete_task", "block_task"]);

const requireFromHere = createRequire(import.meta.url);
const DEFAULT_MCP_COMMAND = fileURLToPath(new URL("../../dist/cli/openboard.mjs", import.meta.url));

const CLAUDE_ACP_SERVICE: AcpRunnerServiceConfig = {
  envCommand: "OPENBOARD_CLAUDE_ACP_COMMAND",
  permissionModeEnv: "OPENBOARD_CLAUDE_PERMISSION_MODE",
  fallbackCommand: "claude-agent-acp",
  packageName: "@agentclientprotocol/claude-agent-acp",
  metaKeys: ["claudeCode"],
  contractName: "OPENBOARD CLAUDE ACP WORKER CONTRACT",
  sessionLabel: "Claude",
  displayName: "Claude ACP",
};

const CODEX_ACP_SERVICE: AcpRunnerServiceConfig = {
  envCommand: "OPENBOARD_CODEX_ACP_COMMAND",
  defaultMode: "agent",
  fallbackCommand: "codex-acp",
  packageName: "@agentclientprotocol/codex-acp",
  metaKeys: [],
  contractName: "OPENBOARD CODEX ACP WORKER CONTRACT",
  sessionLabel: "Codex ACP",
  displayName: "Codex ACP",
  configOptions: true,
};

const GEMINI_ACP_SERVICE: AcpRunnerServiceConfig = {
  envCommand: "OPENBOARD_GEMINI_ACP_COMMAND",
  // OpenBoard already provides the isolation and permission boundary. Gemini's
  // folder-trust gate otherwise blocks injected stdio MCP servers and refuses
  // autoEdit/yolo in managed task worktrees.
  commandArgs: ["--acp", "--skip-trust"],
  defaultMode: "default",
  fallbackCommand: "gemini",
  metaKeys: [],
  contractName: "OPENBOARD GEMINI ACP WORKER CONTRACT",
  sessionLabel: "Gemini ACP",
  displayName: "Gemini ACP",
  setModel: true,
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

function acpServiceForHarness(harness: AcpTaskHarness): AcpRunnerServiceConfig {
  switch (harness) {
    case "claude-code":
      return CLAUDE_ACP_SERVICE;
    case "codex":
      return CODEX_ACP_SERVICE;
    case "gemini-acp":
      return GEMINI_ACP_SERVICE;
    case "hermes":
      return HERMES_ACP_SERVICE;
    case "pi-coding-agent":
      return PI_ACP_SERVICE;
    case "cursor-acp":
      return CURSOR_ACP_SERVICE;
  }
}

function defaultCommand(service: AcpRunnerServiceConfig, env: NodeJS.ProcessEnv): { command: string; args: string[] } {
  const configured = env[service.envCommand]?.trim();
  if (configured) return { command: configured, args: service.commandArgs ?? [] };

  if (service.packageName) {
    try {
      const packageJsonPath = requireFromHere.resolve(`${service.packageName}/package.json`);
      return {
        command: process.execPath,
        args: [join(dirname(packageJsonPath), "dist/index.js"), ...(service.commandArgs ?? [])],
      };
    } catch {
      // Fall through to the adapter binary name.
    }
  }
  return { command: service.fallbackCommand, args: service.commandArgs ?? [] };
}

function normalizeMode(mode: AcpPermissionMode): string {
  return mode === "manual" ? "default" : mode;
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
  // Some ACP adapters put the fully-qualified MCP tool name only in title.
  // Trust that surface solely for the two exact OpenBoard report tools; never
  // treat an arbitrary human-readable title as a privileged tool identity.
  if (typeof toolCall.title === "string" && OPENBOARD_REPORT_TOOLS.has(toolCall.title)) return toolCall.title;
  const geminiOpenBoardTool = typeof toolCall.title === "string"
    ? /^(complete_task|block_task) \(openboard MCP Server\)$/.exec(toolCall.title)
    : null;
  if (geminiOpenBoardTool) return `openboard.${geminiOpenBoardTool[1]}`;
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
  permissionMode: AcpPermissionMode,
): "allow" | "ask" | "deny" {
  if (permissionMode === "bypassPermissions" || permissionMode === "yolo") return "allow";

  const call = params.toolCall;
  const name = toolName(call);
  if (name && (READ_TOOL_NAMES.has(name) || isOpenBoardReportToolName(name))) return "allow";

  const kind = call.kind;
  if (kind === "read" || kind === "search" || kind === "fetch" || kind === "think") return "allow";

  // Command strings and lexical paths are not containment boundaries:
  // redirects, interpreters, expansion, traversal, and symlinks can escape
  // them. Autonomous modes remain explicit compatibility choices. Manual is
  // interactive-strict; dontAsk/plan fail closed for every mutating or unknown
  // operation.
  if (permissionMode === "autoEdit" && kind === "edit") return "allow";
  if (permissionMode === "acceptEdits" || permissionMode === "auto") return "allow";
  if (permissionMode === "dontAsk" || permissionMode === "plan") return "deny";
  return "ask";
}

function truncate(value: string, max = SUMMARY_MAX): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(max - 1, 0))}…`;
}

function chooseOption(options: AcpPermissionParams["options"], decision: "allow" | "reject"): string | undefined {
  const preferred =
    decision === "allow"
      ? ["allow_once", "once"]
      : ["reject", "reject_once", "reject_always"];
  for (const id of preferred) {
    const match = options.find((option) => option.optionId === id || option.kind === id);
    if (match) return match.optionId;
  }
  return undefined;
}

function errorFromRpc(error: unknown): Error {
  if (error !== null && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return new Error(message);
  }
  return new Error("ACP request failed");
}

function flattenConfigSelectOptions(options: unknown): AcpConfigValueOption[] {
  if (!Array.isArray(options)) return [];
  const output: AcpConfigValueOption[] = [];
  for (const item of options) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const value = typeof record.value === "string" ? record.value : typeof record.id === "string" ? record.id : undefined;
    if (value) {
      output.push({
        value,
        ...(typeof record.name === "string" ? { name: record.name } : {}),
        ...(typeof record.description === "string" ? { description: record.description } : {}),
      });
      continue;
    }
    output.push(...flattenConfigSelectOptions(record.options));
  }
  return output;
}

function modelOptionsFromSessionNew(value: unknown, omitModelIds: readonly string[] = []): AcpModelOption[] {
  if (value === null || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const omit = new Set(["default", ...omitModelIds]);
  const modelsRecord = record.models;
  const standardModels = modelsRecord !== null && typeof modelsRecord === "object"
    ? (modelsRecord as Record<string, unknown>).availableModels
    : undefined;
  if (Array.isArray(standardModels)) {
    return standardModels.flatMap((item) => {
      if (item === null || typeof item !== "object") return [];
      const model = item as Record<string, unknown>;
      const id = typeof model.modelId === "string" ? model.modelId.trim() : "";
      return id && !omit.has(id) ? [{
        id,
        ...(typeof model.name === "string" ? { name: model.name } : {}),
        ...(typeof model.description === "string" ? { description: model.description } : {}),
      }] : [];
    });
  }
  const configOptions = record.configOptions;
  if (!Array.isArray(configOptions)) return [];
  const modelOption = configOptions.find((option) => {
    if (option === null || typeof option !== "object") return false;
    const record = option as Record<string, unknown>;
    return record.category === "model" || record.id === "model";
  });
  if (modelOption === null || typeof modelOption !== "object") return [];
  const seen = new Set<string>();
  const models: AcpModelOption[] = [];
  for (const option of flattenConfigSelectOptions((modelOption as Record<string, unknown>).options)) {
    const id = option.value.trim();
    if (!id || omit.has(id) || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      ...(option.name ? { name: option.name } : {}),
      ...(option.description ? { description: option.description } : {}),
    });
  }
  return models;
}

function configValue(value: unknown): AcpOptionValue | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
}

function acpConfigFromSessionNew(value: unknown, omitModelIds: readonly string[] = []): AcpHarnessConfig {
  const models = modelOptionsFromSessionNew(value, omitModelIds);
  if (value === null || typeof value !== "object") return { available: true, modes: [], models, options: [] };
  const record = value as Record<string, unknown>;
  const modesRecord = record.modes;
  const modes =
    modesRecord !== null && typeof modesRecord === "object"
      ? flattenConfigSelectOptions((modesRecord as Record<string, unknown>).availableModes)
      : [];
  const configOptions = Array.isArray(record.configOptions) ? record.configOptions : [];
  const options: AcpConfigOption[] = [];
  for (const item of configOptions) {
    if (item === null || typeof item !== "object") continue;
    const option = item as Record<string, unknown>;
    const id = typeof option.id === "string" ? option.id.trim() : "";
    const type = option.type;
    if (!id || (type !== "select" && type !== "boolean")) continue;
    const category = typeof option.category === "string" ? option.category : undefined;
    if (category === "model" || category === "mode" || id === "model" || id === "mode") continue;
    const parsed: AcpConfigOption = {
      id,
      name: typeof option.name === "string" && option.name.trim() ? option.name : id,
      type,
      ...(typeof option.description === "string" ? { description: option.description } : {}),
      ...(category ? { category } : {}),
      ...(configValue(option.currentValue) !== undefined ? { currentValue: configValue(option.currentValue) } : {}),
    };
    if (type === "select") parsed.options = flattenConfigSelectOptions(option.options);
    options.push(parsed);
  }
  return { available: true, modes, models, options };
}

export async function discoverAcpModelOptions(
  harness: AcpTaskHarness,
  options: { cwd: string; env?: NodeJS.ProcessEnv; spawn?: Spawn; timeoutMs?: number },
): Promise<AcpModelOption[]> {
  const service = acpServiceForHarness(harness);
  return withDiscoverySession(service, options, (created) => modelOptionsFromSessionNew(created, service.omitModelIds));
}

export async function discoverAcpConfig(
  harness: AcpTaskHarness,
  options: { cwd: string; env?: NodeJS.ProcessEnv; spawn?: Spawn; timeoutMs?: number },
): Promise<AcpHarnessConfig> {
  const service = acpServiceForHarness(harness);
  return withDiscoverySession(service, options, (created) => acpConfigFromSessionNew(created, service.omitModelIds));
}

async function withDiscoverySession<T>(
  service: AcpRunnerServiceConfig,
  options: { cwd: string; env?: NodeJS.ProcessEnv; spawn?: Spawn; timeoutMs?: number },
  parse: (sessionNewResult: unknown) => T,
): Promise<T> {
  const env = options.env ?? process.env;
  const spawn = options.spawn ?? nodeSpawn;
  const command = defaultCommand(service, env);
  const detached = process.platform !== "win32";
  const child = spawn(command.command, command.args, {
    cwd: options.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached,
  });
  let buffer = "";
  let nextId = 1;
  const pending = new Map<JsonRpcId, PendingRequest>();
  let sessionId: string | undefined;

  const cleanup = (): void => {
    child.stdout.off("data", onStdout);
    if (detached && child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
        return;
      } catch {
        // The wrapper may already have exited; fall back to the direct handle.
      }
    }
    child.kill();
  };

  const failAll = (error: Error): void => {
    for (const pendingRequest of pending.values()) pendingRequest.reject(error);
    pending.clear();
  };

  const onStdout = (chunk: Buffer): void => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const raw = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (raw) {
        try {
          const message = JSON.parse(raw) as { id?: JsonRpcId; result?: unknown; error?: unknown };
          if (message.id !== undefined && pending.has(message.id)) {
            const request = pending.get(message.id) as PendingRequest;
            pending.delete(message.id);
            if (message.error) request.reject(errorFromRpc(message.error));
            else request.resolve(message.result);
          }
        } catch {
          // Ignore non-JSON adapter chatter.
        }
      }
      newline = buffer.indexOf("\n");
    }
  };

  child.stdout.on("data", onStdout);
  child.once("error", failAll);
  child.once("exit", () => failAll(new Error(`${service.displayName} exited before config discovery completed`)));

  const request = (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`${service.displayName} config discovery timed out`)), options.timeoutMs ?? 5000).unref();
  });

  try {
    return await Promise.race([
      (async () => {
        await request("initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            _meta: { terminal_output: true },
          },
        });
        const created = await request("session/new", {
          cwd: options.cwd,
          mcpServers: [],
          _meta: {},
        });
        const rawSessionId = (created as { sessionId?: unknown } | null)?.sessionId;
        if (typeof rawSessionId === "string") sessionId = rawSessionId;
        return parse(created);
      })(),
      timeout,
    ]);
  } finally {
    if (sessionId) request("session/close", { sessionId }).catch(() => {});
    cleanup();
  }
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
  private readonly permissionMode: AcpPermissionMode;
  private readonly permissionGraceMs: () => number;
  private readonly permissionNow: () => number;
  private readonly service: AcpRunnerServiceConfig;
  private readonly broker: PermissionBroker;
  private readonly ownsBroker: boolean;
  private readonly onActivity?: (taskId: string, runStartedAt: number, input: SessionActivityEventInput) => void;
  private readonly onRunTerminal?: (taskId: string, runStartedAt: number, status: "complete" | "error" | "aborted") => void;
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
    this.mcpCommand = (deps.mcpCommand ?? (this.service.mcpCommandEnv ? this.env[this.service.mcpCommandEnv]?.trim() : undefined)) || DEFAULT_MCP_COMMAND;
    const envPermissionMode = this.service.permissionModeEnv ? this.env[this.service.permissionModeEnv]?.trim() : undefined;
    this.permissionMode = deps.permissionMode ?? envPermissionMode ?? this.service.defaultMode ?? DEFAULT_ACP_PERMISSION_MODE;
    const configuredPermissionGraceMs = deps.permissionGraceMs;
    this.permissionGraceMs = typeof configuredPermissionGraceMs === "function"
      ? configuredPermissionGraceMs
      : () => configuredPermissionGraceMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
    this.permissionNow = deps.permissionClock?.now ?? (() => Date.now());
    this.ownsBroker = deps.permissionBroker === undefined;
    this.broker = deps.permissionBroker ?? createPermissionBroker({ clock: deps.permissionClock, onEvent: deps.onPermissionEvent });
    this.onActivity = deps.onActivity;
    this.onRunTerminal = deps.onRunTerminal;
  }

  run(input: ClaudeCodeRunInput): Promise<ClaudeCodeRunResult> {
    return this.start(input);
  }

  retry(input: ClaudeCodeRunInput): Promise<ClaudeCodeRunResult> {
    return this.start(input);
  }

  runPrepared(input: ClaudeCodeRunInput, onReady: (result: ClaudeCodeRunResult) => void | Promise<void>): Promise<ClaudeCodeRunResult> {
    return this.start(input, onReady);
  }

  retryPrepared(input: ClaudeCodeRunInput, onReady: (result: ClaudeCodeRunResult) => void | Promise<void>): Promise<ClaudeCodeRunResult> {
    return this.start(input, onReady);
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
    this.clearRun(session, "aborted");
    session.child.kill();
  }

  async sendMessage(
    sessionName: string,
    text: string,
    options: { mode: "queue" | "interrupt"; runStartedAt: number },
  ): Promise<void> {
    const session = this.sessions.get(sessionName);
    if (!session) throw new Error(`${this.service.displayName} session is no longer resumable`);

    if (session.activePrompt) {
      if (options.mode === "interrupt") {
        this.sendNotification(session, "session/cancel", { sessionId: session.sessionId });
      }
      await session.activePrompt.catch(() => undefined);
    }

    session.runStartedAt = options.runStartedAt;
    session.status = "running";
    session.terminal = false;
    session.error = undefined;
    this.beginPrompt(session, text);
  }

  shutdown(): void {
    for (const session of this.sessions.values()) {
      if (session.activePrompt) this.sendNotification(session, "session/cancel", { sessionId: session.sessionId });
      session.terminal = true;
      this.broker.clearRun(session.sessionId, session.harness, "shutdown");
      session.child.kill();
    }
    this.sessions.clear();
    if (this.ownsBroker) this.broker.stop();
  }

  listPendingPermissions(sessionName: string): PendingPermissionAsk[] {
    const session = this.sessions.get(sessionName);
    return session ? this.broker.listPending(session.sessionId, session.harness) : [];
  }

  respondPermission(sessionName: string, input: RespondPermissionInput): Promise<RespondOutcome> {
    const session = this.sessions.get(sessionName);
    if (!session || !this.broker.listPending(session.sessionId, session.harness).some((ask) => ask.id === input.askId)) {
      return Promise.resolve({ ok: false, askId: input.askId, conflict: "not-found" });
    }
    return this.broker.respond(input);
  }

  private async start(
    input: ClaudeCodeRunInput,
    onReady?: (result: ClaudeCodeRunResult) => void | Promise<void>,
  ): Promise<ClaudeCodeRunResult> {
    const sessionName = `openboard-${input.task.id}-${input.runStartedAt}`;
    const permissionMode = input.task.permissionMode ?? input.task.claudePermissionMode ?? this.permissionMode;
    const child = this.spawn(this.command, this.commandArgs, {
      cwd: input.directory,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const state: AcpSessionState = {
      child,
      taskId: input.task.id,
      runStartedAt: input.runStartedAt,
      harness: (input.task.harness ?? "claude-code") as AcpTaskHarness,
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
      mcpServers: this.mcpServers(input.task.id),
      _meta: this.sessionMeta(input),
    });
    const sessionId = (created as { sessionId?: unknown })?.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      throw new Error(`${this.service.displayName} session/new returned no sessionId`);
    }
    state.sessionId = sessionId;

    await this.trySetMode(state, permissionMode);
    if (this.service.setModel && input.task.model?.id) {
      await this.request(state, "session/set_model", {
        sessionId: state.sessionId,
        modelId: input.task.model.id,
      });
    }
    if (this.service.configOptions) await this.setConfigOptions(state, input);

    state.status = "running";
    const result = { sessionId, sessionName, status: "running" };
    // The dispatcher uses this two-stage hook to persist task/run/session
    // ownership before session/prompt can produce an immediate permission ask.
    await onReady?.(result);
    this.beginPrompt(state, this.withWorkerContract(input));

    return result;
  }

  private beginPrompt(state: AcpSessionState, text: string): void {
    const prompt = this.request(state, "session/prompt", {
      sessionId: state.sessionId,
      prompt: [{ type: "text", text }],
    });
    state.activePrompt = prompt;
    void prompt.then(
      (result) => {
        const stopReason = (result as { stopReason?: unknown })?.stopReason;
        state.status = stopReason === "cancelled" ? "cancelled" : "idle";
        state.terminal = true;
        if (stopReason === "cancelled") state.error = "cancelled";
        this.clearRun(state, stopReason === "cancelled" ? "aborted" : "complete");
      },
      (error) => {
        state.status = "error";
        state.terminal = true;
        state.error = error.message;
        this.clearRun(state, "error");
      },
    ).finally(() => {
      if (state.activePrompt === prompt) state.activePrompt = undefined;
    });
  }

  private sessionMeta(input: ClaudeCodeRunInput): Record<string, unknown> {
    const model = input.task.model?.id && !this.service.omitModelIds?.includes(input.task.model.id)
      ? { model: input.task.model.id }
      : {};
    const taskMetadata = {
      ...(input.task.permissionMode ? { permissionMode: input.task.permissionMode } : {}),
      ...(input.task.acpOptions ? { acpOptions: input.task.acpOptions } : {}),
    };
    const meta: Record<string, unknown> = { ...(this.service.extraMeta ?? {}) };
    if (Object.keys(taskMetadata).length > 0) {
      meta.openboard = {
        ...((meta.openboard !== null && typeof meta.openboard === "object" && !Array.isArray(meta.openboard)) ? meta.openboard : {}),
        ...taskMetadata,
      };
    }
    for (const key of this.service.metaKeys) {
      meta[key] = {
        options: {
          ...model,
          ...(input.task.acpOptions ?? {}),
        },
      };
    }
    return meta;
  }

  private async trySetMode(state: AcpSessionState, mode: AcpPermissionMode): Promise<void> {
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

  private async setConfigOptions(state: AcpSessionState, input: ClaudeCodeRunInput): Promise<void> {
    const options = {
      ...(input.task.model?.id ? { model: input.task.model.id } : {}),
      ...(input.task.acpOptions ?? {}),
    };
    for (const [configId, value] of Object.entries(options)) {
      await this.request(state, "session/set_config_option", {
        sessionId: state.sessionId,
        configId,
        value,
        ...(typeof value === "boolean" ? { type: "boolean" } : {}),
      });
    }
  }

  private mcpServers(taskId: string): Array<{ name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }> {
    if (this.instanceName) {
      return [
        {
          name: "openboard",
          command: this.mcpCommand,
          args: ["mcp", "--worker", "--task-id", taskId, "--instance", this.instanceName],
          env: [],
        },
      ];
    }

    return [
      {
        name: "openboard",
        command: this.mcpCommand,
        args: ["mcp", "--worker", "--task-id", taskId],
        env: [
          { name: "OPENCODE_BOARD_URL", value: this.adapterBaseUrl },
          ...(this.boardToken ? [{ name: "OPENBOARD_API_TOKEN", value: this.boardToken }] : []),
        ],
      },
    ];
  }

  private withWorkerContract(input: ClaudeCodeRunInput): string {
    return `${input.prompt}\n\n---\n${this.service.contractName}\nTask id: ${input.task.id}\nWorking directory: ${input.directory}\n\nUse the OpenBoard MCP tools loaded in this ${this.service.sessionLabel} session. If you change directories, create a worktree, or commit to a branch, include the actual cwd, branch, and commit in your summary or residual risk.\n\n${completionHandoffGuidance(input.task.taskKind, { hasParents: (input.task.parentIds ?? []).length > 0 })}\n\nWhen all work and verification are complete, call exactly one of these MCP tools as your final action:\n\n- complete_task with { taskId: "${input.task.id}", runStartedAt: ${input.runStartedAt}, report: { summary, changedFiles, verification, residualRisk } }\n- block_task with { taskId: "${input.task.id}", runStartedAt: ${input.runStartedAt}, report: { summary, changedFiles, verification, residualRisk } }\n\nWhen blocking on a question the operator must answer before you can continue, also include needsInput with the direct question.\n\nDo not just describe completion in chat. Do not move the card to Done. The OpenBoard orchestrator will review and integrate the work.`;
  }

  private request(state: AcpSessionState, method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = state.nextId++;
    const response = new Promise((resolve, reject) => {
      state.pending.set(id, { resolve, reject });
    });
    // Register before writing so an adapter that responds synchronously cannot
    // beat the pending-map insertion and orphan its response.
    void this.write(state, { jsonrpc: "2.0", id, method, params }).catch((error) => {
      const pending = state.pending.get(id);
      if (!pending) return;
      state.pending.delete(id);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    });
    return response;
  }

  private sendNotification(state: AcpSessionState, method: string, params: Record<string, unknown>): void {
    void this.write(state, { jsonrpc: "2.0", method, params }).catch((error) => {
      this.failSession(state, error instanceof Error ? error : new Error(String(error)));
    });
  }

  private write(state: AcpSessionState, message: Record<string, unknown>): Promise<void> {
    const stdin = state.child.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded || !stdin.writable) {
      return Promise.reject(new Error(`${this.service.displayName} stdin is not writable`));
    }
    return new Promise((resolveWrite, rejectWrite) => {
      stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) rejectWrite(error);
        else resolveWrite();
      });
    });
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
      void this.handleRequest(state, id, message.method, message.params).catch(async (error) => {
        try {
          await this.write(state, {
            jsonrpc: "2.0",
            id,
            error: { code: -32001, message: error instanceof Error ? error.message : String(error) },
          });
        } catch {
          this.failSession(state, error instanceof Error ? error : new Error(String(error)));
        }
      });
      return;
    }
    if (typeof message.method === "string" && id === undefined) {
      this.handleNotification(state, message.method, message.params);
    }
  }

  private async handleRequest(
    state: AcpSessionState,
    id: JsonRpcId,
    method: string,
    params: unknown,
  ): Promise<void> {
    if (method !== "session/request_permission") {
      await this.write(state, { jsonrpc: "2.0", id, error: { code: -32601, message: `Unsupported client method: ${method}` } });
      return;
    }
    const permission = normalizePermissionParams(params);
    if (!permission) {
      await this.write(state, { jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid ACP permission request" } });
      return;
    }
    if (permission.sessionId !== state.sessionId) {
      await this.write(state, { jsonrpc: "2.0", id, error: { code: -32000, message: "Stale ACP permission request" } });
      return;
    }
    if (state.permissionMode === "bypassPermissions") {
      await this.writePermissionResponse(state, id, permission, "allow_once");
      return;
    }
    const policy = decideClaudeAcpPermission(permission, state.cwd, state.permissionMode);
    if (policy === "allow") {
      // Policy already allows this request (e.g. an edit inside the task's cwd) — reply
      // immediately, matching pre-FR08 base behavior. Only requests the write-fence policy
      // would otherwise reject are held for the operator broker below, so a normal in-cwd
      // session is not stalled for the configured operator window per tool call.
      await this.writePermissionResponse(state, id, permission, "allow_once");
      return;
    }
    if (policy === "deny") {
      await this.writePermissionResponse(state, id, permission, "deny");
      return;
    }
    const nativeId = String(id);
    this.broker.submitAsk({
      runId: state.sessionId,
      taskId: state.taskId,
      runStartedAt: state.runStartedAt,
      providerSessionId: permission.sessionId,
      nativeId,
      harness: state.harness,
      source: "acp",
      permission: permission.toolCall.kind ?? toolName(permission.toolCall) ?? "tool",
      tool: toolName(permission.toolCall) ?? permission.toolCall.title,
      summary: summarizePermission(permission),
      patterns: summarizeLocations(permission),
      deadline: this.permissionNow() + Math.max(0, this.permissionGraceMs()),
      timeoutDecision: "deny",
      reopenOnReplyFailure: true,
      replyToProvider: async (decision) => this.writePermissionResponse(state, id, permission, decision),
    });
  }

  private async writePermissionResponse(state: AcpSessionState, id: JsonRpcId, permission: AcpPermissionParams, decision: RespondPermissionInput["action"]): Promise<void> {
    const rpcDecision = decision === "allow_once" ? "allow" : "reject";
    let optionId = chooseOption(permission.options ?? [], rpcDecision);
    if (!optionId) throw new PermissionActionUnsupportedError("ACP permission request does not offer a supported option");
    await this.write(state, {
      jsonrpc: "2.0",
      id,
      result: {
        outcome: {
          outcome: "selected",
          optionId,
        },
      },
    });
  }

  private handleNotification(state: AcpSessionState, method: string, params: unknown): void {
    if (!["session/update", "session/notification", "session/event"].includes(method)) return;
    const event = normalizeAcpActivity(params);
    if (!event) return;
    if (event.sessionId !== state.sessionId && event.sessionId !== state.sessionName) return;
    if (event.status) state.status = event.status;
    this.onActivity?.(state.taskId, state.runStartedAt, {
      sessionId: state.sessionId,
      rootSessionId: state.sessionId,
      harness: state.harness,
      ...event.activity,
    });
  }

  private clearRun(state: AcpSessionState, status: "complete" | "error" | "aborted"): void {
    this.broker.clearRun(state.sessionId, state.harness, "run-cleared");
    this.onRunTerminal?.(state.taskId, state.runStartedAt, status);
  }

  private failSession(state: AcpSessionState, error: Error): void {
    state.status = "error";
    state.terminal = true;
    state.error = error.message;
    for (const pending of state.pending.values()) pending.reject(error);
    state.pending.clear();
    this.clearRun(state, "error");
  }
}

function normalizePermissionParams(params: unknown): AcpPermissionParams | null {
  if (params === null || typeof params !== "object") return null;
  const record = params as Record<string, unknown>;
  const sessionId = typeof record.sessionId === "string" ? record.sessionId : "";
  const toolCall = record.toolCall;
  const options = record.options;
  if (!sessionId || toolCall === null || typeof toolCall !== "object" || !Array.isArray(options)) return null;
  return { sessionId, toolCall: toolCall as AcpToolCall, options: options as AcpPermissionParams["options"] };
}

function summarizePermission(params: AcpPermissionParams): string {
  const tool = toolName(params.toolCall) ?? params.toolCall.title ?? "tool";
  const kind = params.toolCall.kind ?? "unknown";
  const locations = summarizeLocations(params).join(", ");
  return truncate([tool, kind, locations].filter(Boolean).join(" · "));
}

function summarizeLocations(params: AcpPermissionParams): string[] {
  const values = [
    ...valuesFromInput(params.toolCall.rawInput, new Set(["file_path", "path", "notebook_path"])),
    ...(params.toolCall.locations ?? []).flatMap((location) => (typeof location.path === "string" ? [location.path] : [])),
  ];
  return [...new Set(values)].slice(0, 8).map((value) => truncate(value));
}

function normalizeAcpActivity(params: unknown): { sessionId: string; status?: string; activity: Omit<SessionActivityEventInput, "sessionId" | "rootSessionId" | "harness"> } | null {
  if (params === null || typeof params !== "object") return null;
  const record = params as Record<string, unknown>;
  const sessionId = typeof record.sessionId === "string" ? record.sessionId : typeof record.session_id === "string" ? record.session_id : "";
  if (!sessionId) return null;

  // Primary path: the real ACP `session/update` envelope, `{ sessionId, update: { sessionUpdate, ... } }`.
  // Shape confirmed against @agentclientprotocol/sdk schema/schema.json ($defs.SessionNotification /
  // $defs.SessionUpdate) shipped with the @agentclientprotocol/claude-agent-acp dependency.
  const update = record.update;
  if (update !== null && typeof update === "object") {
    const activity = activityFromSessionUpdate(update as Record<string, unknown>);
    if (activity) return { sessionId, activity };
  }

  // Legacy/back-compat: flat notification shape used by older fixtures and non-spec harnesses.
  const status = typeof record.status === "string" ? record.status : typeof record.state === "string" ? record.state : undefined;
  const role = record.role === "assistant" || record.role === "user" || record.role === "system" ? record.role : undefined;
  const text = textValue(record.message) ?? textValue(record.content) ?? textValue(record.text);
  if (text) return { sessionId, status, activity: { kind: "text", role: role ?? "assistant", text: truncate(text, 10_000) } };
  const tool = toolActivity(record);
  if (tool) return { sessionId, status, activity: { kind: "tool", tool } };
  if (status) return { sessionId, status, activity: { kind: "status", text: truncate(status) } };
  return null;
}

function activityFromSessionUpdate(update: Record<string, unknown>): Omit<SessionActivityEventInput, "sessionId" | "rootSessionId" | "harness"> | null {
  const sessionUpdate = update.sessionUpdate;
  if (sessionUpdate === "agent_message_chunk" || sessionUpdate === "agent_thought_chunk") {
    const text = textValue(update.content);
    if (!text) return null;
    return { kind: "text", role: "assistant", text: truncate(text, 10_000) };
  }
  if (sessionUpdate === "tool_call" || sessionUpdate === "tool_call_update") {
    const tool = toolActivityFromToolCall(update);
    if (!tool) return null;
    return { kind: "tool", tool };
  }
  return null;
}

function toolActivityFromToolCall(update: Record<string, unknown>): SessionActivityEventInput["tool"] | null {
  const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
  const name = typeof update.title === "string" ? update.title : typeof update.kind === "string" ? update.kind : undefined;
  if (!name && !toolCallId) return null;
  return {
    name: truncate(name ?? "tool"),
    callId: toolCallId ? truncate(toolCallId) : undefined,
    status: mapToolCallStatus(update.status),
  };
}

function mapToolCallStatus(value: unknown): SessionActivityToolStatus {
  switch (value) {
    case "pending":
      return "started";
    case "in_progress":
      return "running";
    case "completed":
      return "complete";
    case "failed":
      return "error";
    default:
      return "running";
  }
}

function textValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return textValue(record.text) ?? textValue(record.content);
  }
  return undefined;
}

function toolActivity(record: Record<string, unknown>): SessionActivityEventInput["tool"] | null {
  const raw = record.toolCall ?? record.tool_call ?? record.tool;
  if (raw === null || typeof raw !== "object") return null;
  const tool = raw as Record<string, unknown>;
  const name = typeof tool.name === "string" ? tool.name : typeof tool.title === "string" ? tool.title : typeof tool.kind === "string" ? tool.kind : "tool";
  const callId = typeof tool.toolCallId === "string" ? tool.toolCallId : typeof tool.id === "string" ? tool.id : undefined;
  const status = tool.status === "complete" || tool.status === "error" || tool.status === "running" || tool.status === "started" ? tool.status : "running";
  return { name: truncate(name), callId: callId ? truncate(callId) : undefined, status };
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
