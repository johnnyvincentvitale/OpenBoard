/**
 * Adapter configuration — parses environment variables into a typed config
 * describing how to reach (or spawn) the OpenCode server and where the
 * board's own Hono server should listen.
 */
import { OPENCODE_DEFAULTS, BOARD_SERVER_DEFAULTS } from "../shared/opencode-defaults";

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
