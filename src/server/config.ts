/**
 * Adapter configuration — parses environment variables into a typed config
 * describing how to reach (or spawn) the OpenCode server and where the
 * board's own Hono server should listen.
 *
 * Multi-instance support: two or more independent OpenBoard instances can run
 * on one machine, each driven by its own env, as long as each sets disjoint
 * values for `OPENBOARD_PORT` (adapter port), `OPENBOARD_DB` (task DB path —
 * the board column-store DB is derived from it), and (optionally)
 * `OPENBOARD_OPENCODE_PORT` (the spawned `opencode serve` port). See the
 * README's "Running multiple instances" section for a worked example.
 */
import { createServer } from "node:net";
import { homedir } from "node:os";
import { format, parse } from "node:path";
import { OPENCODE_DEFAULTS, BOARD_SERVER_DEFAULTS } from "../shared/opencode-defaults";
import type { InstanceConfig } from "../shared/task";
import { isExternalDirectoriesAllowed } from "./workspace";

/** Resolved adapter configuration. */
export interface AdapterConfig {
  /** "connect" when OPENCODE_BASE_URL is set (attach to an existing server); "spawn" otherwise. */
  mode: "connect" | "spawn";
  /** Explicit base URL to connect to. Only set in "connect" mode. */
  baseUrl?: string;
  /** Whether this process should manage (spawn/own the lifecycle of) the OpenCode server process. */
  manageProcess: boolean;
  /** Hostname to bind/spawn the OpenCode server on (spawn mode). */
  hostname: string;
  /** Port to bind/spawn the OpenCode server on (spawn mode). */
  port: number;
  /** Port the board's own Hono server listens on. */
  boardPort: number;
  /** Health-check retry/backoff tuning for startOrConnect(). */
  healthCheck: {
    /** Max number of health-check attempts before giving up. */
    attempts: number;
    /** Per-attempt request timeout in milliseconds. */
    timeoutMs: number;
    /** Base delay in milliseconds between attempts (linear backoff). */
    delayMs: number;
  };
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return fallback;
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Thrown by strict, instance-config port/value parsing — carries a clear, user-facing message. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Parses a port value strictly: unset/blank -> undefined (caller falls back);
 * anything else must be an integer in [1, 65535] or this throws ConfigError
 * naming the offending env var and the bad value, so a typo never silently
 * falls back to some other instance's port.
 */
function parseStrictPort(value: string | undefined, varName: string): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535 || !/^\d+$/.test(trimmed)) {
    throw new ConfigError(
      `${varName} must be an integer port between 1 and 65535, got: "${value}"`,
    );
  }
  return parsed;
}

/**
 * Load adapter configuration from environment variables.
 *
 * - OPENCODE_BASE_URL set  -> "connect" mode (attach to an already-running server at that URL).
 * - OPENCODE_BASE_URL unset -> "spawn" mode (this process spawns its own `opencode serve`),
 *   using OPENCODE_HOSTNAME / OPENCODE_PORT (defaulting to OPENCODE_DEFAULTS).
 * - OPENCODE_MANAGE_PROCESS ('true'/'false') overrides whether the lifecycle is managed by us.
 *   Defaults to true when no base url is given (spawn mode implies management), false otherwise.
 * - BOARD_PORT sets the board's own Hono server port (defaults to BOARD_SERVER_DEFAULTS.port).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdapterConfig {
  const baseUrl = env.OPENCODE_BASE_URL?.trim() || undefined;
  const mode: AdapterConfig["mode"] = baseUrl ? "connect" : "spawn";

  const manageProcess = parseBoolean(env.OPENCODE_MANAGE_PROCESS, mode === "spawn");

  const hostname = env.OPENCODE_HOSTNAME?.trim() || OPENCODE_DEFAULTS.hostname;
  const port = parsePort(env.OPENCODE_PORT, OPENCODE_DEFAULTS.port);
  const boardPort = parsePort(env.BOARD_PORT, BOARD_SERVER_DEFAULTS.port);

  const healthCheck = {
    attempts: parsePort(env.OPENCODE_HEALTHCHECK_ATTEMPTS, 5),
    timeoutMs: parsePort(env.OPENCODE_HEALTHCHECK_TIMEOUT_MS, 2000),
    delayMs: parsePort(env.OPENCODE_HEALTHCHECK_DELAY_MS, 250),
  };

  return {
    mode,
    baseUrl,
    manageProcess,
    hostname,
    port,
    boardPort,
    healthCheck,
  };
}

/**
 * Resolve this process's {@link InstanceConfig} from environment variables,
 * so two or more independent OpenBoard instances can run on one machine.
 *
 * Precedence per field (explicit new env > existing/legacy env > default):
 * - `port` (adapter/board port): `OPENBOARD_PORT` > `BOARD_PORT` > 4097.
 * - `dbPath`: `OPENBOARD_DB` > "board.sqlite" (current default location).
 *   Callers should derive both the column-store and task-store file paths
 *   from this single value via {@link deriveStorePaths} — see that function
 *   for the legacy `BOARD_DB_PATH` / `BOARD_TASK_DB_PATH` escape hatches.
 * - `workspace`: `BOARD_WORKSPACE` (unchanged, existing env) > the caller's
 *   home directory (resolved by consumers, e.g. `resolveBoardWorkspace`).
 * - `opencodePort`: `OPENBOARD_OPENCODE_PORT` > `OPENCODE_PORT` > `undefined`
 *   (undefined means "auto-select a free port" — see `findFreePort` — rather
 *   than hardcoding 4096, so a second instance never silently fights the
 *   first for the same spawned OpenCode server port).
 *
 * `OPENBOARD_PORT`, `OPENBOARD_DB`, and `OPENBOARD_OPENCODE_PORT` are parsed
 * strictly: an unparsable/out-of-range value throws {@link ConfigError} with
 * a message naming the offending variable, instead of silently falling back
 * to a default and masking a typo as "it just picked another instance's port".
 */
export function resolveInstanceConfig(env: NodeJS.ProcessEnv = process.env): InstanceConfig {
  const port =
    parseStrictPort(env.OPENBOARD_PORT, "OPENBOARD_PORT") ??
    parsePort(env.BOARD_PORT, BOARD_SERVER_DEFAULTS.port);

  if (env.OPENBOARD_DB !== undefined && env.OPENBOARD_DB.trim() === "") {
    throw new ConfigError("OPENBOARD_DB must not be an empty string");
  }
  const dbPath = env.OPENBOARD_DB?.trim() || "board.sqlite";

  const workspace = env.BOARD_WORKSPACE?.trim() || homedir();
  const allowExternalDirectories = isExternalDirectoriesAllowed(env);

  const opencodePort =
    parseStrictPort(env.OPENBOARD_OPENCODE_PORT, "OPENBOARD_OPENCODE_PORT") ??
    (env.OPENCODE_PORT !== undefined && env.OPENCODE_PORT.trim() !== ""
      ? parsePort(env.OPENCODE_PORT, OPENCODE_DEFAULTS.port)
      : undefined);

  return {
    port,
    dbPath,
    workspace,
    allowExternalDirectories,
    ...(opencodePort !== undefined ? { opencodePort } : {}),
  };
}

/** Resolved on-disk paths for the two SQLite sidecars an instance owns. */
export interface StorePaths {
  /** The legacy column-store DB (sessions/cards, `board_row` table). */
  boardDbPath: string;
  /** The Push task-store DB (`task` table). */
  taskDbPath: string;
}

/**
 * Derive a sibling path next to `dbPath` by appending `suffix` to its
 * filename (before the extension) — e.g. ("board.sqlite", "-tasks") ->
 * "board-tasks.sqlite". Used so one `OPENBOARD_DB` value gives each instance
 * two disjoint, co-located sidecar files without two stores ever opening
 * the same underlying file.
 */
function siblingPath(dbPath: string, suffix: string): string {
  const parsed = parse(dbPath);
  return format({ ...parsed, base: undefined, name: `${parsed.name}${suffix}` });
}

/**
 * Derive the board (column-store) and task-store SQLite paths for an
 * instance from its single `OPENBOARD_DB`-resolved `dbPath`. The task store
 * uses `dbPath` as-is (it's the primary, Push-layer store); the column store
 * uses a `-board` sibling file, so the two never open the same file from two
 * separate `better-sqlite3` connections. Legacy, more specific `BOARD_DB_PATH`
 * / `BOARD_TASK_DB_PATH` env vars — if set — win for their respective store
 * (back-compat escape hatch predating multi-instance support). When
 * `OPENBOARD_DB` itself is unset, this reproduces the pre-multi-instance
 * default paths exactly: "board.sqlite" and "board-tasks.sqlite".
 */
export function deriveStorePaths(
  instance: Pick<InstanceConfig, "dbPath">,
  env: NodeJS.ProcessEnv = process.env,
): StorePaths {
  const explicitDb = env.OPENBOARD_DB?.trim();
  const defaultBoardDb = explicitDb ? siblingPath(instance.dbPath, "-board") : "board.sqlite";
  const defaultTaskDb = explicitDb ? instance.dbPath : "board-tasks.sqlite";

  return {
    boardDbPath: env.BOARD_DB_PATH?.trim() || defaultBoardDb,
    taskDbPath: env.BOARD_TASK_DB_PATH?.trim() || defaultTaskDb,
  };
}

/**
 * Ask the OS for a free TCP port on `hostname` by binding to port 0 and
 * immediately releasing it. Used when no explicit OpenCode server port is
 * configured, so a second (or third...) OpenBoard instance never collides
 * with a sibling instance's spawned OpenCode server.
 */
export function findFreePort(hostname: string = OPENCODE_DEFAULTS.hostname): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, hostname, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new ConfigError("Could not determine a free port (unexpected socket address)"));
        return;
      }
      const { port } = address;
      server.close(() => resolvePromise(port));
    });
  });
}

/**
 * Verify `port` on `hostname` is free by briefly binding to it and releasing.
 * Throws {@link ConfigError} with a clear, actionable message on
 * `EADDRINUSE` (naming the port and suggesting another instance may already
 * own it) so a startup collision fails fast — before any child process
 * (OpenCode) is spawned — instead of leaving a half-started instance behind.
 * Other bind errors are rethrown as-is.
 */
export function assertPortFree(port: number, hostname: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new ConfigError(
            `Port ${port} on ${hostname} is already in use. Another OpenBoard (or OpenCode) ` +
              `instance may already be running there — choose a different port for this instance ` +
              `(see the README's "Running multiple instances" section) and try again.`,
          ),
        );
        return;
      }
      reject(err);
    });
    server.once("listening", () => {
      server.close(() => resolvePromise());
    });
    server.listen(port, hostname);
  });
}

/**
 * Resolve the full {@link AdapterConfig} this process should run with,
 * folding the multi-instance {@link InstanceConfig} (board/adapter port,
 * OpenCode port) on top of {@link loadConfig}'s env-derived defaults.
 *
 * - `boardPort` comes from the resolved instance config (`OPENBOARD_PORT` >
 *   `BOARD_PORT` > `BOARD_SERVER_DEFAULTS.port`).
 * - In "spawn" mode, `port` (the OpenCode server's port) is the resolved
 *   instance's `opencodePort` if set (`OPENBOARD_OPENCODE_PORT` >
 *   `OPENCODE_PORT`); otherwise a free port is auto-selected via
 *   {@link findFreePort} rather than hardcoding 4096, so two instances
 *   started with no OpenCode port configured never fight over the same
 *   spawned backend.
 * - In "connect" mode, no OpenCode process is spawned by this process, so
 *   `port` is left as `loadConfig`'s resolved value (informational only;
 *   `baseUrl` is what actually gets used).
 *
 * Accepts an already-resolved `instance` (from {@link resolveInstanceConfig})
 * to avoid re-parsing env twice when a caller (e.g. `serve.ts`) needs both
 * the instance config (for DB paths) and the adapter config.
 */
export async function resolveAdapterConfig(
  env: NodeJS.ProcessEnv = process.env,
  instance: InstanceConfig = resolveInstanceConfig(env),
): Promise<AdapterConfig> {
  const base = loadConfig(env);

  const port =
    base.mode === "spawn"
      ? (instance.opencodePort ?? (await findFreePort(base.hostname)))
      : base.port;

  return {
    ...base,
    port,
    boardPort: instance.port,
  };
}
