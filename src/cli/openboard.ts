#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BOARD_SERVER_DEFAULTS,
} from "../shared/opencode-defaults";
import {
  CLI_COMMANDS,
  InstanceError,
  validateInstanceName,
  validatePort,
} from "../shared/instances";
import type {
  CliCommand,
  InstanceDefinition,
  InstanceRuntimeState,
} from "../shared/instances";
import type { BoardHealth } from "../shared/health";
import type { AcpConfigCatalog, RosterAgent, Task, TaskCausalityMap } from "../shared/task";
import type { RosterProvider } from "../shared/providers";
import { createDefaultProvider } from "./default-provider";
import type { InstanceLifecycleProvider, InstanceWorktreeSummary } from "./provider";

/** Attach context handed to the attach implementation. */
export interface AttachContext {
  repoRoot: string;
  definition: InstanceDefinition;
  runtime: InstanceRuntimeState;
}

export interface McpContext {
  repoRoot: string;
  definition?: InstanceDefinition;
  runtime?: InstanceRuntimeState;
}

/** Minimal output stream abstraction so tests do not need a real TTY. */
export interface OutStream {
  write(chunk: string): void;
}

export interface RunOptions {
  provider: InstanceLifecycleProvider;
  attach?: (ctx: AttachContext) => Promise<number>;
  mcp?: (ctx: McpContext) => Promise<number>;
  selector?: (ctx: { repoRoot: string }) => Promise<number>;
  stdout?: OutStream;
  stderr?: OutStream;
}

type ParsedCommand =
  | { command: "help" }
  | { command: "selector" }
  | { command: "list"; json: boolean }
  | {
      command: "add";
      name: string;
      workspace: string;
      port?: number;
      opencodePort?: number;
    }
  | { command: "remove"; name: string; force: boolean }
  | { command: "start"; name: string }
  | { command: "stop"; name: string }
  | { command: "attach"; name?: string }
  | { command: "mcp"; name?: string }
  | { command: "rename"; oldName: string; newName: string }
  | { command: "default"; action: "show" | "set" | "clear"; name?: string }
  | { command: "status"; name: string; json: boolean }
  | { command: "doctor"; name: string; json: boolean }
  | { command: "logs"; name: string; tail: number; follow: boolean }
  | { command: "harnesses"; name: string }
  | { command: "agents"; name: string }
  | { command: "providers"; name: string }
  | { command: "tasks"; name: string; review: boolean; running: boolean; json: boolean }
  | { command: "worktrees"; name: string }
  | { command: "restart"; name: string }
  | { command: "bare"; name?: string };

const DEFAULT_FIRST_PORT = BOARD_SERVER_DEFAULTS.port;

// ── Argument parsing ─────────────────────────────────────────────────────────

function isHelpFlag(arg: string): boolean {
  return arg === "-h" || arg === "--help";
}

function parseFlag(
  args: string[],
  index: number,
  flag: string,
  shorthand?: string,
): { value: string | undefined; nextIndex: number } {
  const arg = args[index];
  if (arg === undefined) return { value: undefined, nextIndex: index };

  for (const candidate of [flag, ...([shorthand].filter(Boolean) as string[])]) {
    if (arg === candidate) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error(`${candidate} requires a value`);
      }
      return { value, nextIndex: index + 2 };
    }
    if (arg.startsWith(`${candidate}=`)) {
      return { value: arg.slice(candidate.length + 1), nextIndex: index + 1 };
    }
  }
  return { value: undefined, nextIndex: index };
}

export function parseArgs(argv: string[]): ParsedCommand {
  if (argv.length === 0) {
    // openboard is an app, not a util: bare invocation opens the instance
    // selector (launch view). Usage lives behind --help.
    return { command: "selector" };
  }
  if (isHelpFlag(argv[0])) {
    return { command: "help" };
  }

  const first = argv[0];

  if (isHelpFlag(first) || first === "help") {
    return { command: "help" };
  }

  if (!CLI_COMMANDS.includes(first as CliCommand)) {
    return { command: "bare", name: first };
  }

  const rest = argv.slice(1);

  switch (first) {
    case "list": {
      if (rest.some(isHelpFlag)) return { command: "help" };
      let json = false;
      for (const item of rest) {
        if (item === "--json") json = true;
        else throw new Error(`Unknown argument: ${item}`);
      }
      return { command: "list", json };
    }
    case "add": {
      if (rest.some(isHelpFlag)) return { command: "help" };
      let name: string | undefined;
      let workspace: string | undefined;
      let port: number | undefined;
      let opencodePort: number | undefined;
      for (let i = 0; i < rest.length; ) {
        const item = rest[i];
        if (item.startsWith("-")) {
          const workspaceFlag = parseFlag(rest, i, "--workspace", "-w");
          if (workspaceFlag.value !== undefined) {
            workspace = workspaceFlag.value;
            i = workspaceFlag.nextIndex;
            continue;
          }
          const portFlag = parseFlag(rest, i, "--port", "-p");
          if (portFlag.value !== undefined) {
            port = parsePortArg(portFlag.value, "--port");
            i = portFlag.nextIndex;
            continue;
          }
          const opencodePortFlag = parseFlag(rest, i, "--opencode-port");
          if (opencodePortFlag.value !== undefined) {
            opencodePort = parsePortArg(opencodePortFlag.value, "--opencode-port");
            i = opencodePortFlag.nextIndex;
            continue;
          }
          throw new Error(`Unknown argument: ${item}`);
        }
        if (name === undefined) {
          name = item;
          i += 1;
        } else {
          throw new Error(`Unexpected argument: ${item}`);
        }
      }
      if (name === undefined) {
        throw new Error("add requires an instance name");
      }
      if (workspace === undefined) {
        throw new Error("add requires --workspace <dir>");
      }
      return { command: "add", name, workspace, port, opencodePort };
    }
    case "remove": {
      if (rest.some(isHelpFlag)) return { command: "help" };
      let name: string | undefined;
      let force = false;
      for (const item of rest) {
        if (item === "--force" || item === "-f") {
          force = true;
        } else if (!item.startsWith("-")) {
          if (name !== undefined) {
            throw new Error(`Unexpected argument: ${item}`);
          }
          name = item;
        } else {
          throw new Error(`Unknown argument: ${item}`);
        }
      }
      if (name === undefined) {
        throw new Error("remove requires an instance name");
      }
      return { command: "remove", name, force };
    }
    case "start":
    case "stop": {
      if (rest.some(isHelpFlag)) return { command: "help" };
      if (rest.length === 0) {
        throw new Error(`${first} requires an instance name`);
      }
      if (rest.length > 1) {
        throw new Error(`${first} does not take extra arguments`);
      }
      return { command: first, name: rest[0] };
    }
    case "attach": {
      if (rest.some(isHelpFlag)) return { command: "help" };
      if (rest.length === 0) {
        return { command: "attach" };
      }
      if (rest.length > 1) {
        throw new Error("attach does not take extra arguments");
      }
      return { command: "attach", name: rest[0] };
    }
    case "mcp": {
      if (rest.some(isHelpFlag)) return { command: "help" };
      let name: string | undefined;
      for (let i = 0; i < rest.length; ) {
        const instanceFlag = parseFlag(rest, i, "--instance", "-i");
        if (instanceFlag.value !== undefined) {
          name = instanceFlag.value;
          i = instanceFlag.nextIndex;
          continue;
        }
        throw new Error(`Unknown argument: ${rest[i]}`);
      }
      return { command: "mcp", name };
    }
    case "rename": {
      if (rest.some(isHelpFlag)) return { command: "help" };
      if (rest.length < 2) {
        throw new Error("rename requires <old-name> and <new-name>");
      }
      if (rest.length > 2) {
        throw new Error("rename does not take extra arguments");
      }
      return { command: "rename", oldName: rest[0], newName: rest[1] };
    }
    case "default": {
      if (rest.some(isHelpFlag)) return { command: "help" };
      const action = rest[0];
      if (action === undefined) {
        throw new Error("default requires a subcommand: show, set, or clear");
      }
      if (action === "show" || action === "clear") {
        if (rest.length > 1) {
          throw new Error(`default ${action} does not take arguments`);
        }
        return { command: "default", action };
      }
      if (action === "set") {
        if (rest.length < 2) {
          throw new Error("default set requires an instance name");
        }
        if (rest.length > 2) {
          throw new Error("default set does not take extra arguments");
        }
        return { command: "default", action, name: rest[1] };
      }
      throw new Error(`Unknown default subcommand: ${action}`);
    }
    case "status": {
      if (rest.some(isHelpFlag)) return { command: "help" };
      const { name, json } = parseNamedReadCommand("status", rest, { json: true });
      return { command: "status", name, json };
    }
    case "doctor": {
      if (rest.some(isHelpFlag)) return { command: "help" };
      const { name, json } = parseNamedReadCommand("doctor", rest, { json: true });
      return { command: "doctor", name, json };
    }
    case "logs": {
      if (rest.some(isHelpFlag)) return { command: "help" };
      let name: string | undefined;
      let tail = 80;
      let follow = false;
      for (let i = 0; i < rest.length;) {
        const item = rest[i];
        const tailFlag = parseFlag(rest, i, "--tail", "-n");
        if (tailFlag.value !== undefined) {
          const parsed = Number(tailFlag.value);
          if (!Number.isInteger(parsed) || parsed < 0) throw new Error("--tail requires a non-negative integer");
          tail = parsed;
          i = tailFlag.nextIndex;
          continue;
        }
        if (item === "--follow" || item === "-f") {
          follow = true;
          i += 1;
          continue;
        }
        if (item.startsWith("-")) throw new Error(`Unknown argument: ${item}`);
        if (name !== undefined) throw new Error(`Unexpected argument: ${item}`);
        name = item;
        i += 1;
      }
      if (name === undefined) throw new Error("logs requires an instance name");
      return { command: "logs", name, tail, follow };
    }
    case "harnesses":
    case "agents":
    case "providers":
    case "worktrees":
    case "restart": {
      if (rest.some(isHelpFlag)) return { command: "help" };
      if (rest.length === 0) throw new Error(`${first} requires an instance name`);
      if (rest.length > 1) throw new Error(`${first} does not take extra arguments`);
      return { command: first, name: rest[0] } as ParsedCommand;
    }
    case "tasks": {
      if (rest.some(isHelpFlag)) return { command: "help" };
      let name: string | undefined;
      let review = false;
      let running = false;
      let json = false;
      for (const item of rest) {
        if (item === "--review") review = true;
        else if (item === "--running") running = true;
        else if (item === "--json") json = true;
        else if (!item.startsWith("-") && name === undefined) name = item;
        else if (item.startsWith("-")) throw new Error(`Unknown argument: ${item}`);
        else throw new Error(`Unexpected argument: ${item}`);
      }
      if (name === undefined) throw new Error("tasks requires an instance name");
      return { command: "tasks", name, review, running, json };
    }
    default: {
      // Exhaustive check; `first` is a CliCommand.
      throw new Error(`Unhandled command: ${first}`);
    }
  }
}

function parsePortArg(raw: string, label: string): number {
  const parsed = Number(raw);
  const result = validatePort(parsed);
  if (!result.ok) {
    throw new Error(`${label}: ${result.error}`);
  }
  return result.value;
}

function parseNamedReadCommand(
  command: string,
  rest: string[],
  options: { json?: boolean } = {},
): { name: string; json: boolean } {
  let name: string | undefined;
  let json = false;
  for (const item of rest) {
    if (options.json && item === "--json") {
      json = true;
    } else if (item.startsWith("-")) {
      throw new Error(`Unknown argument: ${item}`);
    } else if (name === undefined) {
      name = item;
    } else {
      throw new Error(`${command} does not take extra arguments`);
    }
  }
  if (name === undefined) throw new Error(`${command} requires an instance name`);
  return { name, json };
}

function cliRepoRoot(): string {
  const cliPath = realpathSync(fileURLToPath(import.meta.url));
  return resolve(dirname(cliPath), "../..");
}

// ── Default port assignment ──────────────────────────────────────────────────

function defaultPort(usedPorts: number[]): number {
  let port = DEFAULT_FIRST_PORT;
  const set = new Set(usedPorts);
  while (set.has(port)) {
    port += 1;
  }
  return port;
}

// ── Table output ───────────────────────────────────────────────────────────────

function printTable(
  entries: Array<{ definition: InstanceDefinition; runtime: InstanceRuntimeState }>,
  stdout: OutStream,
): void {
  if (entries.length === 0) {
    stdout.write("No instances registered.\n");
    return;
  }
  const headers = ["NAME", "STATUS", "BOARD URL", "WORKSPACE", "DB PATH"];
  const rows = entries.map(({ definition, runtime }) => [
    definition.name,
    runtime.status,
    runtime.boardUrl,
    definition.workspace,
    definition.dbPath,
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  stdout.write(`${line(headers)}\n`);
  for (const row of rows) {
    stdout.write(`${line(row)}\n`);
  }
}

function writeJson(value: unknown, stdout: OutStream): void {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

interface UnsafeRunningTask {
  id: string;
  title: string;
  reason: string;
}

interface TaskDiagnostics {
  status: "ok" | "unavailable";
  unsafeRunningTasks: UnsafeRunningTask[];
  detail?: string;
}

interface TaskCausalityLoadResult {
  causality: TaskCausalityMap;
  failure?: string;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function okTaskDiagnostics(tasks: Task[]): TaskDiagnostics {
  return { status: "ok", unsafeRunningTasks: unsafeRunningTasks(tasks) };
}

function unavailableTaskDiagnostics(error: unknown): TaskDiagnostics {
  return {
    status: "unavailable",
    unsafeRunningTasks: [],
    detail: formatErrorMessage(error),
  };
}

function unsafeRunningTasks(tasks: Task[]): UnsafeRunningTask[] {
  return tasks.flatMap((task) => {
    if (task.runState !== "running") return [];
    const reasons: string[] = [];
    if (task.column !== "in_progress") reasons.push(`RUNNING while in ${task.column} lane`);
    if (!task.sessionId && !task.harnessSessionId) reasons.push("RUNNING with no linked session");
    if (reasons.length === 0) return [];
    return [{ id: task.id, title: task.title, reason: reasons.join("; ") }];
  });
}

function formatUnsafeRunningSummary(issues: UnsafeRunningTask[], instanceName: string): string {
  const count = issues.length;
  const cards = issues.map((issue) => `${issue.id} (${issue.reason})`).join(", ");
  return `${count} unsafe RUNNING card${count === 1 ? "" : "s"}: ${cards}. Cannot trust AUTO/RUNNING state; run openboard restart ${instanceName}, then retry/abort from the TUI or inspect the task events.`;
}

async function loadTaskCausality(
  provider: InstanceLifecycleProvider,
  name: string,
): Promise<TaskCausalityLoadResult> {
  try {
    return { causality: await provider.getTaskCausality(name) };
  } catch (error) {
    return { causality: {}, failure: formatErrorMessage(error) };
  }
}

function printDefaultInfo(
  info: Awaited<ReturnType<InstanceLifecycleProvider["getDefaultInfo"]>>,
  stdout: OutStream,
): void {
  if (info.kind === "explicit") {
    stdout.write(`Default instance: ${info.definition.name} (explicit)\n`);
    stdout.write(`openboard attach will use "${info.definition.name}" when no name is provided.\n`);
    return;
  }
  if (info.kind === "inferred") {
    stdout.write(`Default instance: ${info.definition.name} (inferred: only registered instance)\n`);
    stdout.write("No explicit default is set; openboard attach will infer the only instance.\n");
    return;
  }
  if (info.instanceCount === 0) {
    stdout.write("No default instance is set and no instances are registered.\n");
    stdout.write("Add one with: openboard add <name> --workspace <dir>\n");
    return;
  }
  stdout.write("No default instance is set.\n");
  stdout.write("Set one with: openboard default set <name>\n");
  stdout.write("Or attach explicitly with: openboard attach <name>\n");
}

function printDefaultClearInfo(
  info: Awaited<ReturnType<InstanceLifecycleProvider["clearDefault"]>>,
  stdout: OutStream,
): void {
  stdout.write("Cleared explicit default instance.\n");
  if (info.kind === "inferred") {
    stdout.write(`openboard attach will infer "${info.definition.name}" because it is the only registered instance.\n`);
    return;
  }
  stdout.write("openboard attach will require a name until you set a default with: openboard default set <name>\n");
}

function formatBuild(build: BoardHealth["build"] | undefined): string {
  if (!build || (!build.version && !build.commit && !build.build)) return "unavailable";
  return [
    build.version ? `version ${build.version}` : undefined,
    build.commit ? `commit ${build.commit}` : undefined,
    build.build ? `build ${build.build}` : undefined,
  ].filter(Boolean).join(", ");
}

function formatOpencodeBackend(definition: InstanceDefinition, health: BoardHealth | undefined): string {
  if (health?.identity?.opencodeUrl) return health.identity.opencodeUrl;
  if (definition.opencodePort !== undefined) return `http://127.0.0.1:${definition.opencodePort} (registry)`;
  return "auto-assigned when running (live status required)";
}

function printStatus(
  definition: InstanceDefinition,
  runtime: InstanceRuntimeState,
  health: BoardHealth | undefined,
  stdout: OutStream,
  taskDiagnostics: TaskDiagnostics = { status: "ok", unsafeRunningTasks: [] },
): void {
  stdout.write(`Instance: ${definition.name}\n`);
  stdout.write(`Runtime: ${runtime.status}\n`);
  stdout.write(`Board URL: ${runtime.boardUrl}\n`);
  stdout.write(`Board port: ${definition.port}\n`);
  stdout.write(`Workspace: ${definition.workspace}\n`);
  stdout.write(`Task DB path: ${definition.dbPath}\n`);
  stdout.write(`OpenCode backend: ${formatOpencodeBackend(definition, health)}\n`);
  stdout.write(`Board token: ${definition.boardToken?.trim() ? "present" : "absent"}\n`);

  if (taskDiagnostics.status === "unavailable") {
    stdout.write(`Task diagnostics: unavailable (${taskDiagnostics.detail ?? "unknown error"})\n`);
  } else if (taskDiagnostics.unsafeRunningTasks.length > 0) {
    stdout.write(`Task diagnostics: ${formatUnsafeRunningSummary(taskDiagnostics.unsafeRunningTasks, definition.name)}\n`);
  } else if (runtime.status === "running") {
    stdout.write("Task diagnostics: no unsafe RUNNING cards detected\n");
  }

  if (!health) {
    stdout.write("Live identity: unavailable (start the instance to query /api/health)\n");
    stdout.write("Adapter build: unavailable\n");
    stdout.write("OpenCode health: unavailable\n");
    return;
  }

  stdout.write(`Live instance name: ${health.identity?.instanceName ?? "unavailable"}\n`);
  stdout.write(`Live board URL: ${health.identity?.boardUrl ?? "unavailable"}\n`);
  stdout.write(`Live workspace: ${health.identity?.workspace ?? "unavailable"}\n`);
  stdout.write(`Live task DB path: ${health.identity?.dbPath ?? "unavailable"}\n`);
  stdout.write(`Live board token: ${health.identity?.boardTokenPresent ? "present" : "absent"}\n`);
  stdout.write(`Adapter build: ${formatBuild(health.build)}\n`);
  if (health.opencode.status === "ok") {
    stdout.write(`OpenCode health: ok (${health.opencode.version})\n`);
  } else {
    stdout.write("OpenCode health: unreachable\n");
  }
}

function statusPayload(
  definition: InstanceDefinition,
  runtime: InstanceRuntimeState,
  health: BoardHealth | undefined,
  taskDiagnostics: TaskDiagnostics = { status: "ok", unsafeRunningTasks: [] },
): Record<string, unknown> {
  return {
    name: definition.name,
    registry: {
      port: definition.port,
      workspace: definition.workspace,
      dbPath: definition.dbPath,
      opencodePort: definition.opencodePort,
      boardTokenPresent: Boolean(definition.boardToken?.trim()),
    },
    runtime,
    health: health ?? null,
    taskDiagnostics,
  };
}

function instancePayload(definition: InstanceDefinition): Record<string, unknown> {
  return {
    name: definition.name,
    port: definition.port,
    workspace: definition.workspace,
    dbPath: definition.dbPath,
    opencodePort: definition.opencodePort,
    boardTokenPresent: Boolean(definition.boardToken?.trim()),
  };
}

async function buildDoctorPayload(
  provider: InstanceLifecycleProvider,
  name: string,
): Promise<Record<string, unknown>> {
  const definition = await provider.get(name);
  const runtime = await provider.getRuntime(name);
  const health = await provider.getHealth(name);
  const checks: Array<{ name: string; status: "ok" | "warn" | "fail"; detail: string }> = [];
  checks.push({ name: "registry", status: "ok", detail: `${definition.name} on ${definition.port}` });
  checks.push({ name: "daemon", status: runtime.status === "running" ? "ok" : "warn", detail: runtime.status });
  checks.push({ name: "token", status: definition.boardToken?.trim() ? "ok" : "fail", detail: definition.boardToken?.trim() ? "present" : "absent" });
  checks.push({ name: "health", status: health ? "ok" : "warn", detail: health ? "reachable" : "unavailable" });
  checks.push({ name: "workspace", status: existsSync(definition.workspace) ? "ok" : "fail", detail: definition.workspace });
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: definition.workspace,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    checks.push({ name: "git", status: "ok", detail: "workspace is a git work tree" });
  } catch {
    checks.push({ name: "git", status: "warn", detail: "workspace is not a readable git work tree" });
  }
  if (health?.identity) {
    checks.push({
      name: "build-mismatch",
      status: health.identity.port === definition.port && health.identity.workspace === definition.workspace ? "ok" : "fail",
      detail: `live port ${health.identity.port}, workspace ${health.identity.workspace}`,
    });
  }
  if (health?.opencode.status === "ok") checks.push({ name: "opencode", status: "ok", detail: health.opencode.version });
  else checks.push({ name: "opencode", status: "warn", detail: "unreachable or not queried" });

  if (runtime.status === "running") {
    const [agentsResult, providersResult, acpResult, tasksResult, worktreesResult, logResult] = await Promise.allSettled([
      provider.listAgents(name),
      provider.listProviders(name),
      provider.getAcpConfig(name),
      provider.listTasks(name),
      provider.listWorktrees(name),
      provider.readLog(name, 20),
    ]);

    if (agentsResult.status === "fulfilled") {
      checks.push({ name: "roster", status: agentsResult.value.length > 0 ? "ok" : "warn", detail: `${agentsResult.value.length} agents` });
    } else {
      checks.push({ name: "roster", status: "warn", detail: formatErrorMessage(agentsResult.reason) });
    }

    if (providersResult.status === "fulfilled") {
      checks.push({ name: "provider", status: providersResult.value.length > 0 ? "ok" : "warn", detail: `${providersResult.value.length} providers` });
    } else {
      checks.push({ name: "provider", status: "warn", detail: formatErrorMessage(providersResult.reason) });
    }

    if (acpResult.status === "fulfilled") {
      const acpAvailable = Object.values(acpResult.value).filter((config) => config?.available).length;
      checks.push({ name: "acp", status: acpAvailable > 0 ? "ok" : "warn", detail: `${acpAvailable} harnesses available` });
    } else {
      checks.push({ name: "acp", status: "warn", detail: formatErrorMessage(acpResult.reason) });
    }

    if (tasksResult.status === "fulfilled") {
      const runningIssues = unsafeRunningTasks(tasksResult.value);
      checks.push({ name: "tasks", status: "ok", detail: `${tasksResult.value.length} active tasks` });
      checks.push({
        name: "running-cards",
        status: runningIssues.length > 0 ? "fail" : "ok",
        detail: runningIssues.length > 0
          ? formatUnsafeRunningSummary(runningIssues, name)
          : "no unsafe RUNNING cards detected",
      });
    } else {
      const detail = formatErrorMessage(tasksResult.reason);
      checks.push({ name: "tasks", status: "warn", detail });
      checks.push({ name: "running-cards", status: "fail", detail: `task diagnostics unavailable: ${detail}` });
    }

    if (worktreesResult.status === "fulfilled") {
      checks.push({ name: "worktrees", status: worktreesResult.value.some((w) => w.orphanCandidate) ? "warn" : "ok", detail: `${worktreesResult.value.length} managed worktrees` });
    } else {
      checks.push({ name: "worktrees", status: "warn", detail: formatErrorMessage(worktreesResult.reason) });
    }

    if (logResult.status === "fulfilled") {
      checks.push({ name: "startup-log", status: logResult.value.missing ? "warn" : "ok", detail: logResult.value.missing ? "missing" : logResult.value.path });
    } else {
      checks.push({ name: "startup-log", status: "warn", detail: formatErrorMessage(logResult.reason) });
    }
  }
  return { name, runtime: runtime.status, boardUrl: runtime.boardUrl, build: health?.build ?? null, checks };
}

function printDoctor(payload: Record<string, unknown>, stdout: OutStream): void {
  stdout.write(`Doctor: ${payload.name}\n`);
  stdout.write(`Runtime: ${payload.runtime} (${payload.boardUrl})\n`);
  const checks = payload.checks as Array<{ name: string; status: string; detail: string }>;
  for (const check of checks) {
    const marker = check.status === "ok" ? "✓" : check.status === "warn" ? "!" : "✗";
    stdout.write(`${marker} ${check.name}: ${check.detail}\n`);
  }
}

function printHarnesses(catalog: AcpConfigCatalog, stdout: OutStream): void {
  const entries = Object.entries(catalog);
  if (entries.length === 0) {
    stdout.write("No ACP harnesses reported.\n");
    return;
  }
  for (const [name, config] of entries) {
    stdout.write(`${name}: ${config?.available ? "available" : "unavailable"}`);
    if (config?.error) stdout.write(` (${config.error})`);
    stdout.write("\n");
    stdout.write(`  modes: ${config?.modes.map((m) => m.value).join(", ") || "none"}\n`);
    stdout.write(`  models: ${config?.models.length ?? 0}\n`);
    stdout.write(`  options: ${config?.options.length ?? 0}\n`);
  }
}

function printAgents(agents: RosterAgent[], stdout: OutStream): void {
  stdout.write(`Agents: ${agents.length}\n`);
  for (const agent of agents) {
    const model = agent.model ? `${agent.model.providerID}/${agent.model.id}` : "profile default/unset";
    stdout.write(`- ${agent.id} (${agent.mode}) model: ${model}\n`);
  }
  stdout.write("Restart guidance: OpenCode agent/profile changes require openboard restart <name>.\n");
}

function printProviders(providers: RosterProvider[], stdout: OutStream): void {
  stdout.write(`Providers: ${providers.length}\n`);
  for (const provider of providers) {
    stdout.write(`- ${provider.id} (${provider.name}): ${provider.models.length} models`);
    if (provider.defaultModelId) stdout.write(`, default ${provider.defaultModelId}`);
    stdout.write("\n");
  }
  stdout.write("Restart guidance: provider auth/model changes may require restarting OpenCode via openboard restart <name>.\n");
}

function taskCausalityFields(task: Task, load: TaskCausalityLoadResult): Record<string, unknown> {
  const autoDispatchedBy = load.causality[task.id]?.autoDispatchedBy;
  if (autoDispatchedBy) return { causality: { type: "task_auto_dispatched", autoDispatchedBy } };
  if (load.failure) return { causalityUnavailable: load.failure };
  return {};
}

function summarizeTasks(tasks: Task[], causality: TaskCausalityLoadResult = { causality: {} }): Record<string, unknown> {
  const byColumn: Record<string, number> = {};
  const byRunState: Record<string, number> = {};
  for (const task of tasks) {
    byColumn[task.column] = (byColumn[task.column] ?? 0) + 1;
    byRunState[task.runState] = (byRunState[task.runState] ?? 0) + 1;
  }
  return {
    total: tasks.length,
    byColumn,
    byRunState,
    tasks: tasks.map((task) => ({ ...task, ...taskCausalityFields(task, causality) })),
  };
}

function printTasks(
  tasks: Task[],
  stdout: OutStream,
  causality: TaskCausalityLoadResult = { causality: {} },
): void {
  const summary = summarizeTasks(tasks, causality) as { total: number; byColumn: Record<string, number>; byRunState: Record<string, number> };
  stdout.write(`Tasks: ${summary.total}\n`);
  stdout.write(`Columns: ${Object.entries(summary.byColumn).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}\n`);
  stdout.write(`Run states: ${Object.entries(summary.byRunState).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}\n`);
  for (const task of tasks) {
    const parentId = causality.causality[task.id]?.autoDispatchedBy;
    const cause = causality.failure
      ? ` · causality unavailable: ${causality.failure}`
      : typeof parentId === "string"
        ? ` · task_auto_dispatched: auto-dispatched by parent ${parentId}`
        : "";
    stdout.write(`- ${task.id} [${task.column}/${task.runState}] ${task.title}${cause}\n`);
  }
}

function printWorktrees(items: InstanceWorktreeSummary[], stdout: OutStream): void {
  if (items.length === 0) {
    stdout.write("No managed worktrees found in active/archive tasks.\n");
    return;
  }
  for (const item of items) {
    stdout.write(`- ${item.taskId} ${item.worktreeBranch ?? "(no branch)"} ${item.exists ? "exists" : "missing"} dirty=${item.dirty} ${item.orphanCandidate ? "orphan-candidate" : ""}\n`);
    stdout.write(`  ${item.title}\n`);
    if (item.worktreePath) stdout.write(`  path: ${item.worktreePath}\n`);
  }
}

// ── Attach implementation ────────────────────────────────────────────────────

function signalNumber(signal: NodeJS.Signals): number {
  const signals: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGILL: 4,
    SIGTRAP: 5,
    SIGABRT: 6,
    SIGBUS: 7,
    SIGFPE: 8,
    SIGKILL: 9,
    SIGUSR1: 10,
    SIGSEGV: 11,
    SIGUSR2: 12,
    SIGPIPE: 13,
    SIGALRM: 14,
    SIGTERM: 15,
  };
  return signals[signal] ?? 0;
}

/** Default selector behavior: spawn the TUI launcher in selector mode — no
 * board is resolved or started; the renderer opens the instance launch view. */
export async function defaultSelector(ctx: { repoRoot: string }): Promise<number> {
  const launcherPath = join(ctx.repoRoot, "dist", "tui", "launcher.mjs");
  if (!existsSync(launcherPath)) {
    throw new InstanceError(
      `TUI launcher not found: ${launcherPath}. Run npm run build:tui first.`,
    );
  }
  const child = spawn(process.execPath, [launcherPath], {
    cwd: ctx.repoRoot,
    env: { ...process.env, OPENBOARD_SELECTOR: "1" },
    stdio: "inherit",
  });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        resolve(128 + signalNumber(signal));
      } else {
        resolve(code ?? 0);
      }
    });
  });
}

/** Default attach behavior: spawn the built TUI launcher with instance env. */
export async function defaultAttach(ctx: AttachContext): Promise<number> {
  const { repoRoot, definition, runtime } = ctx;
  const launcherPath = join(repoRoot, "dist", "tui", "launcher.mjs");
  if (!existsSync(launcherPath)) {
    throw new InstanceError(
      `TUI launcher not found: ${launcherPath}. Run npm run build:tui first.`,
    );
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCODE_BOARD_URL: runtime.boardUrl,
    OPENBOARD_INSTANCE_NAME: definition.name,
    OPENBOARD_INSTANCE_WORKSPACE: definition.workspace,
    OPENBOARD_INSTANCE_PORT: String(definition.port),
    OPENBOARD_INSTANCE_STATUS: runtime.status,
  };
  if (definition.opencodePort !== undefined) {
    env.OPENBOARD_OPENCODE_PORT = String(definition.opencodePort);
  }
  if (definition.boardToken !== undefined) {
    env.OPENBOARD_API_TOKEN = definition.boardToken;
  }

  const child = spawn(process.execPath, [launcherPath], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        resolve(128 + signalNumber(signal));
      } else {
        resolve(code ?? 0);
      }
    });
  });
}

/** Default MCP behavior: spawn the built MCP server, optionally pre-bound to a running instance. */
export async function defaultMcp(ctx: McpContext): Promise<number> {
  const { repoRoot, definition, runtime } = ctx;
  const mcpPath = join(repoRoot, "dist", "mcp", "server.mjs");
  if (!existsSync(mcpPath)) {
    throw new InstanceError(`MCP server not found: ${mcpPath}. Run npm run build:mcp first.`);
  }

  const env: NodeJS.ProcessEnv = { ...process.env };

  if (definition !== undefined && runtime !== undefined) {
    if (runtime.status !== "running") {
      throw new InstanceError(
        `Instance "${definition.name}" is ${runtime.status}. Start it with: openboard start ${definition.name}`,
      );
    }
    if (!definition.boardToken?.trim()) {
      throw new InstanceError(`Instance "${definition.name}" is missing a board token; restart or recreate the instance.`);
    }

    Object.assign(env, {
      OPENCODE_BOARD_URL: runtime.boardUrl,
      OPENBOARD_API_TOKEN: definition.boardToken,
      OPENBOARD_INSTANCE_NAME: definition.name,
      OPENBOARD_INSTANCE_WORKSPACE: definition.workspace,
      OPENBOARD_INSTANCE_DB_PATH: definition.dbPath,
      OPENBOARD_INSTANCE_PORT: String(definition.port),
      OPENBOARD_INSTANCE_STATUS: runtime.status,
      OPENBOARD_SELECTION_SOURCE: "cli --instance",
    });
  }

  const child = spawn(process.execPath, [mcpPath], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        resolve(128 + signalNumber(signal));
      } else {
        resolve(code ?? 0);
      }
    });
  });
}

// ── Main dispatch ────────────────────────────────────────────────────────────

function printUsage(out: OutStream): void {
  out.write(`Usage: openboard [command | <instance-name>]

Running openboard with no arguments opens the instance selector.

Commands:
  list                                    Show registered instances and identity
  list --json                             Show registered instances as JSON
  add <name> --workspace <dir> [--port N]
                                            Register a new instance
  remove <name> [--force]                 Unregister an instance (data directory retained)
  start <name>                            Start an instance daemon
  stop <name>                             Stop an instance daemon
  rename <old> <new>                      Rename an instance (stops/restarts if
                                           running)
  default show                            Show explicit/inferred/default state
  default set <name>                      Set the default instance
  default clear                           Clear the explicit default instance
  status <name> [--json]                  Show read-only instance diagnostics
  doctor <name> [--json]                  Run operator diagnostics
  logs <name> [--tail N] [--follow]       Show daemon logs
  harnesses <name>                        Summarize live ACP harness discovery
  agents <name>                           Show live OpenCode agent roster
  providers <name>                        Show live provider/model state
  tasks <name> [--review|--running|--json]
                                           Show read-only task summary
  worktrees <name>                        Show managed worktree summary
  restart <name>                          Stop/start and wait for health
  attach [name]                           Attach the TUI to an instance
  mcp [--instance <name>]                  Start MCP unbound, or bound to a running instance
  <name>                                  Start-if-stopped, then attach the TUI

Options:
  -h, --help                              Show this message

Notes:
  Browse the cross-instance global archive from the TUI with key A.
`);
}

export async function runOpenboard(
  argv: string[],
  options: RunOptions,
): Promise<number> {
  const provider = options.provider;
  const attach = options.attach ?? defaultAttach;
  const mcp = options.mcp ?? defaultMcp;
  const selector = options.selector ?? defaultSelector;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  let parsed: ParsedCommand;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    stderr.write(
      `Error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  if (parsed.command === "help") {
    printUsage(stdout);
    return 0;
  }

  if (parsed.command === "selector") {
    const repoRoot = cliRepoRoot();
    try {
      return await selector({ repoRoot });
    } catch (error) {
      stderr.write(
        `Error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
  }

  try {
    switch (parsed.command) {
      case "list": {
        const entries = await provider.list();
        if (parsed.json) writeJson(entries.map(({ definition, runtime }) => ({ instance: instancePayload(definition), runtime })), stdout);
        else printTable(entries, stdout);
        return 0;
      }
      case "add": {
        const nameResult = validateInstanceName(parsed.name);
        if (!nameResult.ok) {
          stderr.write(`Error: ${nameResult.error}\n`);
          return 1;
        }
        const workspace = parsed.workspace.trim();
        if (workspace.length === 0) {
          stderr.write("Error: workspace must not be empty\n");
          return 1;
        }

        let port: number;
        if (parsed.port === undefined) {
          const entries = await provider.list();
          port = defaultPort(entries.map((e) => e.definition.port));
        } else {
          const portResult = validatePort(parsed.port);
          if (!portResult.ok) {
            stderr.write(`Error: ${portResult.error}\n`);
            return 1;
          }
          port = portResult.value;
        }

        let opencodePort: number | undefined;
        if (parsed.opencodePort !== undefined) {
          const result = validatePort(parsed.opencodePort);
          if (!result.ok) {
            stderr.write(`Error: ${result.error}\n`);
            return 1;
          }
          opencodePort = result.value;
        }

        const definition = await provider.add({
          name: nameResult.value,
          port,
          workspace,
          opencodePort,
        });
        stdout.write(
          `Added instance "${definition.name}" on port ${definition.port} (${definition.workspace})\n`,
        );
        return 0;
      }
      case "remove": {
        if (!parsed.force) {
          const runtime = await provider.getRuntime(parsed.name);
          if (runtime.status === "running") {
            stderr.write(
              `Error: Instance "${parsed.name}" is running. Stop it first or use --force.\n`,
            );
            return 1;
          }
        } else {
          const runtime = await provider.getRuntime(parsed.name);
          if (runtime.status === "running") {
            await provider.stop(parsed.name);
          }
        }
        await provider.remove(parsed.name);
        stdout.write(`Unregistered instance "${parsed.name}"; data directory retained for manual cleanup/re-add. The global archive remains available across instances.\n`);
        return 0;
      }
      case "start": {
        const runtime = await provider.start(parsed.name);
        stdout.write(
          `Instance "${parsed.name}" is ${runtime.status} at ${runtime.boardUrl}\n`,
        );
        return 0;
      }
      case "stop": {
        const runtime = await provider.stop(parsed.name);
        stdout.write(
          `Instance "${parsed.name}" is ${runtime.status}\n`,
        );
        return 0;
      }
      case "rename": {
        const definition = await provider.rename(parsed.oldName, parsed.newName);
        // Check whether the instance is now running by getting its runtime state.
        const runtime = await provider.getRuntime(parsed.newName);
        const extra = runtime.status === "running"
          ? " and restarted it"
          : "";
        stdout.write(
          `Renamed instance "${parsed.oldName}" to "${parsed.newName}"${extra}\n`,
        );
        return 0;
      }
      case "default": {
        if (parsed.action === "show") {
          printDefaultInfo(await provider.getDefaultInfo(), stdout);
          return 0;
        }
        if (parsed.action === "set") {
          const name = parsed.name;
          if (name === undefined) {
            stderr.write("Error: default set requires an instance name\n");
            return 1;
          }
          const definition = await provider.setDefault(name);
          stdout.write(`Default instance set to "${definition.name}".\n`);
          stdout.write("openboard attach will use this instance when no name is provided.\n");
          return 0;
        }
        printDefaultClearInfo(await provider.clearDefault(), stdout);
        return 0;
      }
      case "status": {
        const definition = await provider.get(parsed.name);
        const runtime = await provider.getRuntime(parsed.name);
        const health = await provider.getHealth(parsed.name);
        let taskDiagnostics: TaskDiagnostics = { status: "ok", unsafeRunningTasks: [] };
        if (runtime.status === "running") {
          try {
            taskDiagnostics = okTaskDiagnostics(await provider.listTasks(parsed.name));
          } catch (error) {
            taskDiagnostics = unavailableTaskDiagnostics(error);
          }
        }
        if (parsed.json) writeJson(statusPayload(definition, runtime, health, taskDiagnostics), stdout);
        else printStatus(definition, runtime, health, stdout, taskDiagnostics);
        return 0;
      }
      case "doctor": {
        const payload = await buildDoctorPayload(provider, parsed.name);
        if (parsed.json) writeJson(payload, stdout);
        else printDoctor(payload, stdout);
        const checks = payload.checks as Array<{ name: string; status: string }>;
        return checks.some((check) => check.status === "fail") ? 1 : 0;
      }
      case "logs": {
        const log = await provider.readLog(parsed.name, parsed.tail);
        if (log.missing) {
          stdout.write(`Log file not found: ${log.path}\n`);
        } else {
          stdout.write(`==> ${log.path}${log.truncated ? ` (last ${parsed.tail} lines)` : ""} <==\n`);
          stdout.write(log.content.endsWith("\n") ? log.content : `${log.content}\n`);
        }
        if (parsed.follow) {
          let last = log.content;
          // Simple polling follower; intentionally no token/env output.
          for (;;) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            const next = await provider.readLog(parsed.name, parsed.tail);
            if (next.content !== last) {
              stdout.write(next.content.endsWith("\n") ? next.content : `${next.content}\n`);
              last = next.content;
            }
          }
        }
        return 0;
      }
      case "harnesses": {
        printHarnesses(await provider.getAcpConfig(parsed.name), stdout);
        return 0;
      }
      case "agents": {
        printAgents(await provider.listAgents(parsed.name), stdout);
        return 0;
      }
      case "providers": {
        printProviders(await provider.listProviders(parsed.name), stdout);
        return 0;
      }
      case "tasks": {
        let tasks = await provider.listTasks(parsed.name);
        if (parsed.review) tasks = tasks.filter((task) => task.column === "review");
        if (parsed.running) tasks = tasks.filter((task) => task.runState === "running" || task.column === "in_progress");
        const causality = await loadTaskCausality(provider, parsed.name);
        if (parsed.json) writeJson(summarizeTasks(tasks, causality), stdout);
        else printTasks(tasks, stdout, causality);
        return 0;
      }
      case "worktrees": {
        printWorktrees(await provider.listWorktrees(parsed.name), stdout);
        return 0;
      }
      case "restart": {
        stdout.write(`Stopping "${parsed.name}"...\n`);
        await provider.stop(parsed.name);
        stdout.write(`Starting "${parsed.name}"...\n`);
        const runtime = await provider.start(parsed.name);
        const health = await provider.getHealth(parsed.name);
        stdout.write(`Instance "${parsed.name}" is ${runtime.status} at ${runtime.boardUrl}\n`);
        stdout.write(`Health: ${health ? "ok" : "unavailable after start"}\n`);
        let restartFailed = runtime.status !== "running" || !health;
        if (runtime.status === "running") {
          try {
            const runningIssues = unsafeRunningTasks(await provider.listTasks(parsed.name));
            if (runningIssues.length > 0) {
              stdout.write(`Restart warning: ${formatUnsafeRunningSummary(runningIssues, parsed.name)}\n`);
              restartFailed = true;
            } else {
              stdout.write("Restart reconciliation: no unsafe RUNNING cards detected\n");
            }
          } catch (error) {
            stdout.write(`Restart reconciliation: task diagnostics unavailable (${error instanceof Error ? error.message : String(error)})\n`);
            restartFailed = true;
          }
        }
        return restartFailed ? 1 : 0;
      }
      case "mcp": {
        const repoRoot = cliRepoRoot();
        if (parsed.name === undefined) {
          return await mcp({ repoRoot });
        }
        const definition = await provider.get(parsed.name);
        const runtime = await provider.getRuntime(parsed.name);
        if (runtime.status !== "running") {
          stderr.write(
            `Error: Instance "${parsed.name}" is ${runtime.status}. Start it first with: openboard start ${parsed.name}\n`,
          );
          return 1;
        }
        if (!definition.boardToken?.trim()) {
          stderr.write(`Error: Instance "${parsed.name}" is missing a board token; restart or recreate it.\n`);
          return 1;
        }
        return await mcp({ repoRoot, definition, runtime });
      }
      case "attach":
      case "bare": {
        let name = parsed.name;
        let definition: InstanceDefinition;
        if (name === undefined) {
          const resolved = await provider.resolveDefault();
          if (resolved === undefined) {
            stderr.write(
              "Error: No default instance configured. Provide a name with: openboard attach <name>; or set one with: openboard default set <name>. Inspect with: openboard default show\n",
            );
            return 1;
          }
          definition = resolved;
          name = resolved.name;
        } else {
          definition = await provider.get(name);
        }

        let runtime = await provider.getRuntime(name);
        if (runtime.status !== "running" && parsed.command === "bare") {
          runtime = await provider.start(name);
        }

        const repoRoot = cliRepoRoot();
        return await attach({ repoRoot, definition, runtime });
      }
    }
  } catch (error) {
    if (error instanceof InstanceError) {
      stderr.write(`Error: ${formatInstanceError(error)}\n`);
      return 1;
    }
    if (error instanceof Error) {
      stderr.write(`Error: ${error.message}\n`);
      return 1;
    }
    stderr.write(`Error: ${String(error)}\n`);
    return 1;
  }
}

function formatInstanceError(error: InstanceError): string {
  const cause = error.cause;
  if (cause instanceof Error && cause.message.trim()) {
    return `${error.message}: ${cause.message}`;
  }
  if (typeof cause === "string" && cause.trim()) {
    return `${error.message}: ${cause}`;
  }
  return error.message;
}

async function main(): Promise<number> {
  const provider = createDefaultProvider();
  return runOpenboard(process.argv.slice(2), {
    provider,
    attach: defaultAttach,
  });
}

/** Resolve symlinks (npm-link/global bin shims) so the main-module guard
 * matches when the CLI is executed via `openboard` rather than a direct path. */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (isMainModule()) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
