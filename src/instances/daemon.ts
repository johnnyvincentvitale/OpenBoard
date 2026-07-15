/**
 * Daemon lifecycle — spawn, supervise, and terminate OpenBoard adapter
 * processes as background daemons.
 *
 * The daemon manages:
 * - Process spawning (node dist/server/serve.mjs, detached, with log capture).
 * - PID-file locking (prevents double-start).
 * - Health-probe polling against the adapter's /api/health endpoint.
 * - Graceful shutdown (SIGTERM → bounded wait → SIGKILL fallback).
 * - Status inspection (process-alive check + health probe).
 *
 * All filesystem paths are derived from {@link instanceDataDir} using a
 * caller-supplied `homeDir`. The openboard project root (for locating the
 * serve script) is derived from this module's location.
 */
import { ChildProcess, spawn } from "node:child_process";
import {
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  closeSync,
} from "node:fs";
import { request } from "node:http";
import { resolve, dirname, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import {
  InstanceError,
  InstanceSpawnError,
  instanceDataDir,
  type InstanceDefinition,
  type InstanceRuntimeState,
} from "../shared/instances";
import { acquireLockfile, LockfileBusyError, releaseLockfile, removeLockfileIfOwnerDead, type LockfileHandle } from "./lockfile";

// ── Constants ────────────────────────────────────────────────────────────────

/** Default hostname for health probes. */
const DEFAULT_HOSTNAME = "127.0.0.1";

/** Milliseconds to wait between health-check retries. */
const HEALTH_CHECK_INTERVAL_MS = 300;

/** Max number of health-check attempts before giving up. */
const HEALTH_CHECK_MAX_ATTEMPTS = 20;

/** Milliseconds to wait for a graceful SIGTERM shutdown before SIGKILL. */
const SIGTERM_GRACE_MS = 5000;

/** Polling interval for graceful-shutdown wait loop (ms). */
const STOP_POLL_INTERVAL_MS = 100;

/** Exclusive start lock filename in the instance data directory. */
const START_LOCK_FILE = "openboard.start.lock";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve the openboard project root from this module's location. */
function projectRoot(): string {
  const filePath = fileURLToPath(import.meta.url);
  // src/instances/daemon.ts → src/instances → src → project root
  return resolve(dirname(dirname(dirname(filePath))));
}

interface AdapterEnvOptions {
  processEnv?: NodeJS.ProcessEnv;
  nodeExec?: string;
  platform?: NodeJS.Platform;
}

/**
 * Build the environment object passed to the spawned adapter process.
 *
 * The OpenTUI renderer may run through a transient `npx node@26` wrapper while
 * the adapter intentionally runs under a native-dependency-compatible Node 22.
 * Keep the adapter's executable directory first on PATH so every child process
 * (including Git hooks) resolves the same node/npm toolchain as the adapter.
 * Renderer-only editor sentinels must not escape into adapter tests or shells.
 *
 * Maps InstanceDefinition fields to the env vars the adapter reads:
 * - port → OPENBOARD_PORT
 * - dbPath → OPENBOARD_DB
 * - workspace → BOARD_WORKSPACE
 * - opencodePort → OPENBOARD_OPENCODE_PORT
 */
export function buildAdapterEnv(def: InstanceDefinition, options: AdapterEnvOptions = {}): Record<string, string> {
  const processEnv = options.processEnv ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? win32 : posix;
  const nodeExec = options.nodeExec?.trim() || processEnv.OPENBOARD_NODE_EXEC?.trim() || process.execPath;
  const inheritedPathKey = platform === "win32"
    ? Object.keys(processEnv).find((key) => key.toLowerCase() === "path")
    : (Object.hasOwn(processEnv, "PATH") ? "PATH" : undefined);
  const pathKey = inheritedPathKey ?? (platform === "win32" ? "Path" : "PATH");
  const inheritedPath = inheritedPathKey ? processEnv[inheritedPathKey] ?? "" : "";
  const nodeDir = pathApi.isAbsolute(nodeExec) ? pathApi.dirname(nodeExec) : undefined;
  const normalizePathEntry = (entry: string): string => platform === "win32" ? entry.toLowerCase() : entry;
  const pathEntries = (inheritedPath ? inheritedPath.split(pathApi.delimiter) : [])
    .filter((entry) => !nodeDir || normalizePathEntry(entry) !== normalizePathEntry(nodeDir));

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(processEnv)) {
    if (typeof value === "string") env[key] = value;
  }
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path" && key !== pathKey) delete env[key];
  }
  env[pathKey] = [...(nodeDir ? [nodeDir] : []), ...pathEntries].join(pathApi.delimiter);
  delete env.OPENBOARD_USER_EDITOR;
  delete env.OPENBOARD_USER_VISUAL;

  Object.assign(env, {
    OPENBOARD_PORT: String(def.port),
    OPENBOARD_DB: def.dbPath,
    BOARD_WORKSPACE: def.workspace,
    OPENBOARD_INSTANCE_NAME: def.name,
  });
  if (def.opencodePort !== undefined) {
    env.OPENBOARD_OPENCODE_PORT = String(def.opencodePort);
  }
  if (def.boardToken !== undefined) {
    env.OPENBOARD_API_TOKEN = def.boardToken;
  }
  return env;
}

/**
 * Perform a single HTTP health check against `http://hostname:port/api/health`.
 * Returns true if the adapter responds with 2xx.
 */
function healthProbe(
  hostname: string,
  port: number,
  timeoutMs = 2000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      {
        hostname,
        port,
        path: "/api/health",
        method: "GET",
        timeout: timeoutMs,
      },
      (res) => {
        // Consume the body so the socket can be reused.
        res.resume();
        resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function readLogTail(logFile: string): string {
  try {
    const content = readFileSync(logFile, "utf-8");
    return content.slice(-2000) || "(empty)";
  } catch {
    return "(log file empty or unreadable)";
  }
}

/**
 * Poll /api/health with bounded attempts and interval.
 * Returns the board URL on success, or throws on failure.
 */
async function waitForHealthy(
  hostname: string,
  port: number,
  logFile: string,
  instanceName: string,
  opts?: { onCheck?: () => void },
): Promise<string> {
  for (let i = 0; i < HEALTH_CHECK_MAX_ATTEMPTS; i++) {
    // Run early-failure check before each health probe.
    if (opts?.onCheck) {
      opts.onCheck();
    }
    const ok = await healthProbe(hostname, port);
    if (ok) {
      return `http://${hostname}:${port}`;
    }
    if (i < HEALTH_CHECK_MAX_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, HEALTH_CHECK_INTERVAL_MS));
    }
  }

  // Read tail of log for diagnostics.
  const logTail = readLogTail(logFile);

  throw new InstanceSpawnError(
    instanceName,
    new Error(
      `Health check failed after ${HEALTH_CHECK_MAX_ATTEMPTS} attempts on port ${port}. Log tail:\n${logTail}`,
    ),
  );
}

/** Check if a process with the given pid is alive. */
function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 is a null signal — it checks existence without killing.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as NodeJS.ErrnoException).code === code;
}

function readPidFile(pidFile: string): number | undefined {
  try {
    const raw = readFileSync(pidFile, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function startLockPath(dataDir: string): string {
  return resolve(dataDir, START_LOCK_FILE);
}

function acquireStartLock(dataDir: string, instanceName: string): LockfileHandle {
  const path = resolve(dataDir, START_LOCK_FILE);
  try {
    return acquireLockfile(path);
  } catch (err) {
    if (err instanceof LockfileBusyError) {
      throw new InstanceError(`Instance "${instanceName}" is already starting`);
    }
    throw err;
  }
}

function releaseStartLock(lock: LockfileHandle): void {
  releaseLockfile(lock);
}

function signalProcessGroupWithFallback(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    if (isErrno(err, "ESRCH")) {
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        return false;
      }
    }
    throw err;
  }
}

// ── Daemon ───────────────────────────────────────────────────────────────────

/**
 * Daemon controller for named OpenBoard instances.
 *
 * Create a daemon bound to a specific home directory (for dataDir paths)
 * and a registry (for resolving instance definitions by name).
 *
 * ```ts
 * import { homedir } from "node:os";
 * const daemon = createInstanceDaemon(homedir());
 * ```
 */
export interface InstanceDaemon {
  /**
   * Start an instance as a background daemon.
   *
   * 1. Creates the instance's data directory.
   * 2. Spawns `node dist/server/serve.mjs` with the instance's env vars.
   * 3. Writes the child's PID to the pidFile.
   * 4. Redirects stdout/stderr to the logFile.
   * 5. Polls /api/health with a bounded timeout.
   * 6. Returns the runtime state (running + boardUrl).
   *
   * On failure: kills the child process and throws InstanceSpawnError
   * with the log tail for diagnostics.
   */
  start(def: InstanceDefinition): Promise<InstanceRuntimeState>;

  /**
   * Stop a running instance.
   *
   * 1. Reads the PID from the pidFile.
   * 2. Sends SIGTERM, waits up to {@link SIGTERM_GRACE_MS}.
   * 3. Falls back to SIGKILL if still alive.
   * 4. Removes the pidFile.
   */
  stop(def: InstanceDefinition): Promise<void>;

  /**
   * Inspect the current status of an instance.
   *
   * Checks the pidFile and process liveness, then performs a health probe.
   * Returns one of:
   * - `running`:   pid alive + health probe succeeds.
   * - `stopped`:   no pidFile and no process.
   * - `stale-pid`: pidFile exists but process is dead (cleans up the stale file).
   * - `unhealthy`: pid alive but health probe fails.
   */
  status(def: InstanceDefinition): Promise<InstanceRuntimeState>;
}

export function createInstanceDaemon(
  homeDir: string,
  options: { serveScript?: string; closeFd?: (fd: number) => void } = {},
): InstanceDaemon {
  const root = projectRoot();
  const serveScript = options.serveScript ?? resolve(root, "dist", "server", "serve.mjs");
  const closeFd = options.closeFd ?? closeSync;

  const start = async (
    def: InstanceDefinition,
  ): Promise<InstanceRuntimeState> => {
    const dirs = instanceDataDir(homeDir, def.name);
    mkdirSync(dirs.dataDir, { recursive: true });

    const lock = acquireStartLock(dirs.dataDir, def.name);

    try {
      const existingPid = readPidFile(dirs.pidFile);
      if (existingPid !== undefined) {
        if (isProcessAlive(existingPid)) {
          throw new InstanceError(`Instance "${def.name}" is already running or unhealthy (pid ${existingPid})`);
        }
        // Remove any stale pidFile from a previous unclean shutdown.
        try {
          unlinkSync(dirs.pidFile);
        } catch {
          /* ignore — file may not exist */
        }
      }

      // Open log file for append
      let logFd: number | undefined = openSync(dirs.logFile, "a");
      // Truncate log for clean start? No — per the contract, keep appending.
      // But let's add a start marker.
      writeFileSync(
        logFd,
        `--- OpenBoard instance "${def.name}" starting at ${new Date().toISOString()} ---\n`,
      );

      let child: ChildProcess;
      try {
        // Adapter node resolution: OPENBOARD_NODE_EXEC (recorded by the TUI
        // launcher, whose own runtime is ABI-compatible with node_modules'
        // native deps) beats process.execPath — the TUI renderer runs under a
        // newer FFI Node whose ABI cannot load better-sqlite3. Never bare
        // "node": PATH resolution is terminal-dependent.
        const nodeExec = process.env.OPENBOARD_NODE_EXEC?.trim() || process.execPath;
        const env = buildAdapterEnv(def, { nodeExec });
        child = spawn(nodeExec, [serveScript], {
          env,
          detached: true,
          stdio: ["ignore", logFd, logFd],
        });
      } catch (err) {
        try {
          closeFd(logFd);
        } catch {
          /* ignore */
        }
        logFd = undefined;
        throw new InstanceSpawnError(def.name, err);
      }

      try {
        closeFd(logFd);
      } catch {
        /* ignore */
      }
      logFd = undefined;

      // Write the PID file.
      if (child.pid !== undefined) {
        writeFileSync(dirs.pidFile, String(child.pid), "utf-8");
      }

      // Detach the child so it survives the parent.
      child.unref();

    // Monitor the child for early failure so we can fail the health check
    // immediately instead of waiting for the full timeout.
      let childDiedEarly: { code: number | null; signal: NodeJS.Signals | null } | null = null;
      let childError: Error | null = null;
      child.on("error", (err) => {
        childError = err;
      });
      child.on("exit", (code, signal) => {
        childDiedEarly = { code, signal };
      });

    // Wait for health check.
      try {
        const boardUrl = await waitForHealthy(
          DEFAULT_HOSTNAME,
          def.port,
          dirs.logFile,
          def.name,
          { onCheck: () => {
            // If the child died or errored while we wait, fail fast.
            if (childError) {
              throw new InstanceSpawnError(def.name, childError);
            }
            if (childDiedEarly) {
              throw new InstanceSpawnError(
                def.name,
                new Error(
                  `Child process exited early with code ${childDiedEarly.code}, signal ${childDiedEarly.signal}. Log tail:\n${readLogTail(dirs.logFile)}`,
                ),
              );
            }
          } },
        );
        return {
          status: "running",
          pid: child.pid,
          boardUrl,
          startedAt: Date.now(),
        };
      } catch (err) {
        // Health check failed — kill the child and clean up.
        if (child.pid) {
          try {
            signalProcessGroupWithFallback(child.pid, "SIGTERM");
          } catch {
            try {
              process.kill(child.pid, "SIGKILL");
            } catch {
              /* process already dead */
            }
          }
        }
        // Remove pidFile since the process is gone.
        try {
          unlinkSync(dirs.pidFile);
        } catch {
          /* ignore */
        }
        if (logFd !== undefined) {
          try {
            closeFd(logFd);
          } catch {
            /* ignore */
          }
        }
        throw err;
      }
    } finally {
      releaseStartLock(lock);
    }
  };

  const stop = async (def: InstanceDefinition): Promise<void> => {
    const dirs = instanceDataDir(homeDir, def.name);
    removeLockfileIfOwnerDead(startLockPath(dirs.dataDir));

    // Read PID
    let pid: number;
    try {
      const raw = readFileSync(dirs.pidFile, "utf-8").trim();
      pid = Number.parseInt(raw, 10);
      if (!Number.isFinite(pid) || pid <= 0) {
        // Malformed pidFile — remove it and treat as stopped.
        try {
          unlinkSync(dirs.pidFile);
        } catch {
          /* ignore */
        }
        return;
      }
    } catch {
      // No pidFile → already stopped.
      return;
    }

    // Check if process is alive
    if (!isProcessAlive(pid)) {
      // Stale pidFile — clean up.
      try {
        unlinkSync(dirs.pidFile);
      } catch {
        /* ignore */
      }
      return;
    }

    // Send SIGTERM to the daemon process group; detached starts make the child
    // the group leader, so grandchildren die with the adapter.
    try {
      signalProcessGroupWithFallback(pid, "SIGTERM");
    } catch {
      // Process died between check and kill — clean up.
      try {
        unlinkSync(dirs.pidFile);
      } catch {
        /* ignore */
      }
      return;
    }

    // Wait for graceful shutdown
    const deadline = Date.now() + SIGTERM_GRACE_MS;
    while (Date.now() < deadline) {
      if (!isProcessAlive(pid)) {
        try {
          unlinkSync(dirs.pidFile);
        } catch {
          /* ignore */
        }
        return;
      }
      await new Promise((r) => setTimeout(r, STOP_POLL_INTERVAL_MS));
    }

    // Still alive → SIGKILL
    try {
      signalProcessGroupWithFallback(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
    try {
      unlinkSync(dirs.pidFile);
    } catch {
      /* ignore */
    }
  };

  const status = async (
    def: InstanceDefinition,
  ): Promise<InstanceRuntimeState> => {
    const dirs = instanceDataDir(homeDir, def.name);

    // Read PID
    let pid: number | undefined;
    try {
      const raw = readFileSync(dirs.pidFile, "utf-8").trim();
      pid = Number.parseInt(raw, 10);
      if (!Number.isFinite(pid) || pid <= 0) {
        pid = undefined;
      }
    } catch {
      pid = undefined;
    }

    const boardUrl = `http://${DEFAULT_HOSTNAME}:${def.port}`;

    if (pid === undefined) {
      return { status: "stopped", boardUrl };
    }

    if (!isProcessAlive(pid)) {
      // Stale pidFile — clean up.
      try {
        unlinkSync(dirs.pidFile);
      } catch {
        /* ignore */
      }
      return { status: "stale-pid", boardUrl };
    }

    // Process is alive — check health.
    const healthy = await healthProbe(DEFAULT_HOSTNAME, def.port);
    if (healthy) {
      return { status: "running", pid, boardUrl };
    }
    return { status: "unhealthy", pid, boardUrl };
  };

  return { start, stop, status };
}
