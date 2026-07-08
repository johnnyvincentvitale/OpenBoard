#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { randomFillSync } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_BOARD_URL, resolveBoardUrl } from "../client/board-client";
import { BOARD_SERVER_DEFAULTS, OPENCODE_DEFAULTS } from "../shared/opencode-defaults";
import { isLocalBoardUrl } from "../shared/instances";

export { isLocalBoardUrl } from "../shared/instances";

const HEALTH_PATH = "/api/health";
const NODE_FFI_VERSION = "26.3.0";
const DEFAULT_HEALTH_ATTEMPTS = 80;
const DEFAULT_HEALTH_DELAY_MS = 500;
const DEFAULT_HEALTH_TIMEOUT_MS = 1_000;

interface RendererCommand {
  command: string;
  args: string[];
}

interface RuntimeVersions {
  node?: string;
  bun?: string;
}

interface HealthProbeOptions {
  attempts?: number;
  delayMs?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface StartAdapterOptions {
  boardUrl: string;
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  /** Pre-generated board API token to share with the adapter and renderer. */
  boardToken?: string;
}

interface AdapterProcess {
  child: ChildProcess;
  output: () => string;
}

export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export function repoRootFromModuleUrl(moduleUrl = import.meta.url): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), "../..");
}

export function boardPortFromUrl(boardUrl: string): number {
  const url = new URL(boardUrl);
  return Number.parseInt(url.port || String(BOARD_SERVER_DEFAULTS.port), 10);
}

export function defaultOpenBoardDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  if (env.OPENBOARD_DATA_DIR?.trim()) return env.OPENBOARD_DATA_DIR.trim();
  if (platform === "darwin") return join(home, "Library", "Application Support", "OpenBoard");
  if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "OpenBoard");
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "OpenBoard");
}

export function resolveRendererCommand(
  rendererPath: string,
  options: {
    versions?: RuntimeVersions;
    execPath?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): RendererCommand {
  const versions = options.versions ?? (process.versions as RuntimeVersions);
  const env = options.env ?? process.env;
  const nodeVersion = versions.node ?? "0.0.0";
  const [major = 0, minor = 0] = nodeVersion.split(".").map((part) => Number.parseInt(part, 10));
  const supportsFfi = major > 26 || (major === 26 && minor >= 3);
  const nodeArgs = ["--no-warnings", "--experimental-ffi", rendererPath];

  if (versions.bun) {
    return { command: "bun", args: [rendererPath] };
  }

  const explicitNode = env.OPENBOARD_TUI_NODE?.trim();
  if (explicitNode) {
    return { command: explicitNode, args: nodeArgs };
  }

  if (supportsFfi) {
    return { command: options.execPath ?? process.execPath, args: nodeArgs };
  }

  return {
    command: "npx",
    args: ["-y", `node@${NODE_FFI_VERSION}`, ...nodeArgs],
  };
}

export async function probeBoardHealth(
  boardUrl: string,
  options: Pick<HealthProbeOptions, "fetch" | "timeoutMs"> = {},
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS);
  try {
    const response = await (options.fetch ?? fetch)(`${boardUrl}${HEALTH_PATH}`, {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function waitForBoardHealth(
  boardUrl: string,
  options: HealthProbeOptions = {},
): Promise<boolean> {
  const attempts = options.attempts ?? DEFAULT_HEALTH_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await probeBoardHealth(boardUrl, options)) return true;
    await delay(options.delayMs ?? DEFAULT_HEALTH_DELAY_MS);
  }
  return false;
}

export function createAdapterEnv({
  boardUrl,
  repoRoot,
  env = process.env,
  platform = process.platform,
  home = homedir(),
  boardToken,
}: StartAdapterOptions): NodeJS.ProcessEnv {
  const dataDir = defaultOpenBoardDataDir(platform, env, home);
  mkdirSync(dataDir, { recursive: true });

  const resolved: NodeJS.ProcessEnv = {
    ...env,
    BOARD_PORT: String(boardPortFromUrl(boardUrl)),
    OPENCODE_PORT: env.OPENCODE_PORT ?? String(OPENCODE_DEFAULTS.port),
    BOARD_DB_PATH: env.BOARD_DB_PATH ?? join(dataDir, "board.sqlite"),
    BOARD_TASK_DB_PATH: env.BOARD_TASK_DB_PATH ?? join(dataDir, "board-tasks.sqlite"),
  };
  if (boardToken) resolved.OPENBOARD_API_TOKEN = boardToken;
  return resolved;
}

export function hasAttachTarget(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.OPENCODE_BOARD_URL?.trim() ||
      env.OPENBOARD_INSTANCE_NAME?.trim() ||
      env.OPENBOARD_INSTANCE_PORT?.trim() ||
      env.OPENBOARD_PORT?.trim(),
  );
}

export function hasConfiguredWorkspace(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.BOARD_WORKSPACE?.trim());
}

export function startAdapter(options: StartAdapterOptions): AdapterProcess {
  const { repoRoot } = options;
  const env = options.env ?? process.env;
  const workspace = env.BOARD_WORKSPACE?.trim();
  if (!workspace) {
    throw new Error("Cannot start OpenBoard adapter: BOARD_WORKSPACE must be set to an existing directory.");
  }
  const distServer = join(repoRoot, "dist", "server", "serve.mjs");
  const sourceServer = join(repoRoot, "src", "server", "serve.ts");
  const tsxBin = join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");

  const command = existsSync(distServer) ? process.execPath : tsxBin;
  const args = existsSync(distServer) ? [distServer] : [sourceServer];
  if (!existsSync(distServer) && !existsSync(tsxBin)) {
    throw new Error("Cannot start OpenBoard adapter: build dist/server/serve.mjs or install dependencies first.");
  }

  const lines: string[] = [];
  const child = spawn(command, args, {
    cwd: workspace,
    env: createAdapterEnv({ ...options, env }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const capture = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      if (line.trim()) lines.push(line);
    }
    while (lines.length > 30) lines.shift();
  };

  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  return {
    child,
    output: () => lines.join("\n"),
  };
}

export async function runLauncher(): Promise<number> {
  const repoRoot = repoRootFromModuleUrl();
  const rendererPath = join(repoRoot, "dist", "tui", "index.mjs");
  // Selector mode (bare `openboard`): no board is resolved or spawned; the
  // renderer opens the instance launch view and daemons start on demand.
  const selectorMode =
    process.env.OPENBOARD_SELECTOR === "1" ||
    (!hasAttachTarget(process.env) && !hasConfiguredWorkspace(process.env));
  const boardUrl = selectorMode ? undefined : resolveBoardUrl();

  // Generate a shared board API token so the adapter and renderer can both
  // use it without manual copy-paste. If OPENBOARD_API_TOKEN is already set
  // (CI, pre-shared config), use it; otherwise generate a random one.
  const boardToken =
    process.env.OPENBOARD_API_TOKEN?.trim() || generateBoardToken();

  if (!existsSync(rendererPath)) {
    throw new Error("Cannot start OpenBoard TUI: dist/tui/index.mjs is missing. Run npm run build:tui first.");
  }

  let adapter: AdapterProcess | undefined;
  const alreadyRunning = boardUrl === undefined ? true : await probeBoardHealth(boardUrl);

  if (!alreadyRunning && boardUrl !== undefined) {
    if (!isLocalBoardUrl(boardUrl)) {
      throw new Error(`OpenBoard is not reachable at ${boardUrl}. Start it first or use ${DEFAULT_BOARD_URL}.`);
    }

    process.stderr.write(`Starting OpenBoard adapter at ${boardUrl}...\n`);
    adapter = startAdapter({ boardUrl, repoRoot, env: process.env, boardToken });
    const ready = await waitForBoardHealth(boardUrl);
    if (!ready) {
      stopAdapter(adapter.child);
      const output = adapter.output();
      throw new Error(`OpenBoard adapter did not become healthy.${output ? `\n${output}` : ""}`);
    }
  }

  const rendererCommand = resolveRendererCommand(rendererPath);
  const rendererEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_NO_WARNINGS: process.env.NODE_NO_WARNINGS ?? "1",
    // The renderer may run under a newer Node (FFI) whose ABI doesn't match
    // node_modules' native deps. Record the launcher's node — the one that
    // runs adapters — so daemons the renderer starts use a compatible runtime.
    OPENBOARD_NODE_EXEC: process.env.OPENBOARD_NODE_EXEC ?? process.execPath,
    OPENBOARD_API_TOKEN: boardToken,
    // npm exec (the FFI-node renderer wrapper) injects EDITOR=vi into child
    // env. Snapshot the user's real editor vars here — the launcher still runs
    // in the clean shell env — so open-in-editor never sees npm's fake value.
    // Empty string means "user has none set" (resolution treats it as unset).
    OPENBOARD_USER_EDITOR: process.env.EDITOR ?? "",
    OPENBOARD_USER_VISUAL: process.env.VISUAL ?? "",
  };
  if (boardUrl !== undefined) {
    rendererEnv.OPENCODE_BOARD_URL = boardUrl;
  } else {
    // Selector mode: the renderer must see NO attach target (including stray
    // shell env) so it opens the instance launch view.
    delete rendererEnv.OPENCODE_BOARD_URL;
    delete rendererEnv.OPENBOARD_INSTANCE_NAME;
    delete rendererEnv.OPENBOARD_INSTANCE_PORT;
    delete rendererEnv.OPENBOARD_PORT;
  }
  const renderer = spawn(rendererCommand.command, rendererCommand.args, {
    cwd: repoRoot,
    env: rendererEnv,
    stdio: "inherit",
  });

  const stopOwnedAdapter = () => {
    if (adapter) stopAdapter(adapter.child);
  };

  process.once("SIGINT", () => {
    renderer.kill("SIGINT");
    stopOwnedAdapter();
  });
  process.once("SIGTERM", () => {
    renderer.kill("SIGTERM");
    stopOwnedAdapter();
  });

  const exit = await waitForExit(renderer);
  restoreTerminalForShell();
  const message = formatRendererExit(exit);
  if (message) process.stderr.write(`${message}\n`);
  stopOwnedAdapter();
  return rendererExitCode(exit);
}

function stopAdapter(child: ChildProcess): void {
  if (!child.killed) child.kill();
}

function waitForExit(child: ChildProcess): Promise<ChildExit> {
  return new Promise((resolveExit) => {
    child.once("exit", (code, signal) => {
      resolveExit({ code, signal });
    });
  });
}

export function rendererExitCode(exit: ChildExit): number {
  if (exit.signal) return 128 + signalNumber(exit.signal);
  return exit.code ?? 0;
}

export function formatRendererExit(exit: ChildExit): string | undefined {
  if (exit.signal) return `OpenBoard TUI renderer exited from ${exit.signal}.`;
  if (exit.code && exit.code !== 0) return `OpenBoard TUI renderer exited with code ${exit.code}.`;
  return undefined;
}

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

function restoreTerminalForShell(): void {
  // Reset color, show cursor, leave alt screen, and disable the mouse-reporting
  // + bracketed-paste modes the renderer enables — a hard-crashed child can't.
  process.stdout.write("\x1b[0m\x1b[?25h\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/** Generate a random 64-char hex token for the board API. */
export function generateBoardToken(): string {
  const buffer = Buffer.alloc(32);
  randomFillSync(buffer);
  return buffer.toString("hex");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLauncher()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
