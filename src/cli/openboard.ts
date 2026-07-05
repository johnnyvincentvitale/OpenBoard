#!/usr/bin/env node
import { spawn } from "node:child_process";
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
import { createDefaultProvider } from "./default-provider";
import type { InstanceLifecycleProvider } from "./provider";

/** Attach context handed to the attach implementation. */
export interface AttachContext {
  repoRoot: string;
  definition: InstanceDefinition;
  runtime: InstanceRuntimeState;
}

export interface McpContext extends AttachContext {}

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
  | { command: "list" }
  | {
      command: "add";
      name: string;
      workspace: string;
      port?: number;
      opencodePort?: number;
      noStart?: boolean;
    }
  | { command: "remove"; name: string; force: boolean }
  | { command: "start"; name: string }
  | { command: "stop"; name: string }
  | { command: "attach"; name?: string }
  | { command: "mcp"; name: string }
  | { command: "rename"; oldName: string; newName: string }
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
      if (rest.length > 0) {
        throw new Error(`list does not take arguments, got: ${rest.join(" ")}`);
      }
      return { command: "list" };
    }
    case "add": {
      if (rest.some(isHelpFlag)) return { command: "help" };
      let name: string | undefined;
      let workspace: string | undefined;
      let port: number | undefined;
      let opencodePort: number | undefined;
      let noStart = false;
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
          if (item === "--no-start") {
            noStart = true;
            i += 1;
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
      return { command: "add", name, workspace, port, opencodePort, noStart };
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
      if (name === undefined) {
        throw new Error("mcp requires --instance <name>");
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
  const headers = ["NAME", "STATUS", "PORT", "WORKSPACE"];
  const rows = entries.map(({ definition, runtime }) => [
    definition.name,
    runtime.status,
    String(definition.port),
    definition.workspace,
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

/** Default MCP behavior: spawn the built MCP server bound to one running instance. */
export async function defaultMcp(ctx: McpContext): Promise<number> {
  const { repoRoot, definition, runtime } = ctx;
  const mcpPath = join(repoRoot, "dist", "mcp", "server.mjs");
  if (!existsSync(mcpPath)) {
    throw new InstanceError(`MCP server not found: ${mcpPath}. Run npm run build:mcp first.`);
  }

  if (runtime.status !== "running") {
    throw new InstanceError(
      `Instance "${definition.name}" is ${runtime.status}. Start it with: openboard start ${definition.name}`,
    );
  }
  if (!definition.boardToken?.trim()) {
    throw new InstanceError(`Instance "${definition.name}" is missing a board token; restart or recreate the instance.`);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCODE_BOARD_URL: runtime.boardUrl,
    OPENBOARD_API_TOKEN: definition.boardToken,
    OPENBOARD_INSTANCE_NAME: definition.name,
    OPENBOARD_INSTANCE_WORKSPACE: definition.workspace,
    OPENBOARD_INSTANCE_DB_PATH: definition.dbPath,
    OPENBOARD_INSTANCE_PORT: String(definition.port),
    OPENBOARD_INSTANCE_STATUS: runtime.status,
    OPENBOARD_SELECTION_SOURCE: "cli --instance",
  };

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
  list                                    Show registered instances
  add <name> --workspace <dir> [--port N] [--no-start]
                                            Register a new instance
  remove <name> [--force]                 Unregister an instance
  start <name>                            Start an instance daemon
  stop <name>                             Stop an instance daemon
  rename <old> <new>                      Rename an instance (stops/restarts if
                                           running)
  attach [name]                           Attach the TUI to an instance
  mcp --instance <name>                    Start MCP bound to a running instance
  <name>                                  Start-if-stopped, then attach the TUI

Options:
  -h, --help                              Show this message
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
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
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
        printTable(entries, stdout);
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
        stdout.write(`Removed instance "${parsed.name}"\n`);
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
      case "mcp": {
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
        const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
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
              "Error: No default instance configured. Provide a name or set a default.\n",
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

        const repoRoot = resolve(
          dirname(fileURLToPath(import.meta.url)),
          "../..",
        );
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
