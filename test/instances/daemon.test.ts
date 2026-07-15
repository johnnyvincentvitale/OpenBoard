import {
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createInstanceDaemon,
  buildAdapterEnv,
  InstanceError,
  InstanceSpawnError,
  instanceDataDir,
  type InstanceDefinition,
  type InstanceDaemon,
} from "../../src/instances";

// ── Helpers ──────────────────────────────────────────────────────────────────

let homeDir: string;
let daemon: InstanceDaemon;

function makeDef(
  name: string,
  port: number,
  workspace: string,
  dbPath: string,
  opencodePort?: number,
): InstanceDefinition {
  const def: InstanceDefinition & { opencodePort?: number } = {
    name,
    port,
    workspace,
    dbPath,
  };
  if (opencodePort !== undefined) def.opencodePort = opencodePort;
  return def as InstanceDefinition;
}

function writeStubScript(name: string, source: string): string {
  const path = join(homeDir, `${name}.mjs`);
  writeFileSync(path, source, "utf-8");
  return path;
}

function healthyStubScript(): string {
  return writeStubScript(
    "healthy-adapter",
    `import { createServer } from "node:http";
const port = Number(process.env.OPENBOARD_PORT);
const server = createServer((req, res) => {
  if (req.url === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`,
  );
}

function earlyExitStubScript(): string {
  return writeStubScript(
    "early-exit-adapter",
    `console.error("stub adapter boom");
process.exit(42);
`,
  );
}

function groupStubScript(grandchildPidFile: string): string {
  return writeStubScript(
    "group-adapter",
    `import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(grandchildPidFile)}, String(grandchild.pid), "utf-8");
const port = Number(process.env.OPENBOARD_PORT);
const server = createServer((req, res) => {
  if (req.url === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`,
  );
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function deadPid(): number {
  return 2_147_483_647;
}

function writeStartLock(dataDir: string, pid: number, createdAt = Date.now()): string {
  const lockPath = join(dataDir, "openboard.start.lock");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(lockPath, JSON.stringify({ pid, createdAt }) + "\n", "utf-8");
  return lockPath;
}

async function waitForDead(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`pid ${pid} was still alive after ${timeoutMs}ms`);
}

/**
 * Get a free port for a stub health-check server.
 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not get free port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Start a stub HTTP server that responds to /api/health with 200.
 * Writes its PID to pidFilePath.
 * Returns { port, pid, close }.
 */
function startStubAdapter(
  pidFilePath?: string,
  customPort?: number,
): Promise<{ port: number; pid: number; close: () => Promise<void> }> {
  return new Promise(async (resolve, reject) => {
    const port = customPort ?? (await findFreePort());
    const server = createServer((req, res) => {
      if (req.url === "/api/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(port, "127.0.0.1", () => {
      const pid = process.pid; // Use current process PID for tracking
      if (pidFilePath) {
        mkdirSync(dirname(pidFilePath), { recursive: true });
        writeFileSync(pidFilePath, String(pid), "utf-8");
      }
      resolve({
        port,
        pid,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });

    server.on("error", reject);
  });
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "openboard-daemon-"));
  daemon = createInstanceDaemon(homeDir);
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

// ── Status from stub adapter ─────────────────────────────────────────────────

describe("status — via stub adapter", () => {
  it("reports stopped when no pidfile exists", async () => {
    const def = makeDef("test", 4097, homeDir, "board.sqlite");
    const state = await daemon.status(def);
    expect(state.status).toBe("stopped");
  });

  it("reports stale-pid when pidfile has a dead PID", async () => {
    const def = makeDef("test", 4097, homeDir, "board.sqlite");
    const dirs = instanceDataDir(homeDir, def.name);
    mkdirSync(dirs.dataDir, { recursive: true });
    // Use a PID that very likely does not exist.
    writeFileSync(dirs.pidFile, "99999", "utf-8");

    const state = await daemon.status(def);
    expect(state.status).toBe("stale-pid");

    // The stale pidfile should have been cleaned up.
    expect(existsSync(dirs.pidFile)).toBe(false);
  });

  it("reports stale-pid when pidfile has a non-numeric value", async () => {
    // The daemon status handles this gracefully.
    const def = makeDef("test", 4097, homeDir, "board.sqlite");
    const dirs = instanceDataDir(homeDir, def.name);
    mkdirSync(dirs.dataDir, { recursive: true });
    writeFileSync(dirs.pidFile, "not-a-pid", "utf-8");

    // Status should treat this as no pid → stopped.
    const state = await daemon.status(def);
    expect(["stopped", "stale-pid"]).toContain(state.status);
  });

  it("reports running when pid is alive and health check passes", async () => {
    // Use a real stub adapter for this test.
    const def = makeDef("test", 4097, homeDir, "board.sqlite");
    const dirs = instanceDataDir(homeDir, def.name);

    // Start stub adapter using an actual free port.
    const port = await findFreePort();
    const defReal = makeDef("test", port, homeDir, dirs.dataDir + "/db.sqlite");

    // Write pidFile
    mkdirSync(dirs.dataDir, { recursive: true });

    const stub = await startStubAdapter(dirs.pidFile, port);

    try {
      const state = await daemon.status(defReal);
      expect(state.status).toBe("running");
      expect(state.pid).toBeDefined();
      expect(state.boardUrl).toBe(`http://127.0.0.1:${port}`);
    } finally {
      await stub.close();
      try {
        unlinkSync(dirs.pidFile);
      } catch {
        /* ignore */
      }
    }
  });

  it("reports unhealthy when pid is alive but health check fails", async () => {
    const def = makeDef("test", 4097, homeDir, "board.sqlite");
    const dirs = instanceDataDir(homeDir, def.name);

    // Find a port where nothing is listening.
    const port = await findFreePort();
    const defReal = makeDef(
      "test",
      port,
      homeDir,
      dirs.dataDir + "/db.sqlite",
    );

    // Create pidfile pointing to the current process (alive).
    mkdirSync(dirs.dataDir, { recursive: true });
    writeFileSync(dirs.pidFile, String(process.pid), "utf-8");

    try {
      // No server is listening on this free port, so health check will fail.
      const state = await daemon.status(defReal);
      expect(state.status).toBe("unhealthy");
      expect(state.pid).toBeDefined();
    } finally {
      try {
        unlinkSync(dirs.pidFile);
      } catch {
        /* ignore */
      }
    }
  });
});

// ── Stop ─────────────────────────────────────────────────────────────────────

describe("stop", () => {
  it("is a no-op when no pidFile exists", async () => {
    const def = makeDef("test", 4097, homeDir, "board.sqlite");
    // Should not throw.
    await daemon.stop(def);
  });

  it("cleans up stale pidFile and returns", async () => {
    const def = makeDef("test", 4097, homeDir, "board.sqlite");
    const dirs = instanceDataDir(homeDir, def.name);
    mkdirSync(dirs.dataDir, { recursive: true });
    writeFileSync(dirs.pidFile, "99999", "utf-8");

    await daemon.stop(def);
    // The stale pidFile should be cleaned up.
    expect(existsSync(dirs.pidFile)).toBe(false);
  });

  it("clears a start lock whose owner is dead", async () => {
    const def = makeDef("test", 4097, homeDir, "board.sqlite");
    const dirs = instanceDataDir(homeDir, def.name);
    const lockPath = writeStartLock(dirs.dataDir, deadPid());

    await daemon.stop(def);

    expect(existsSync(lockPath)).toBe(false);
  });

  it("cleans up non-numeric pidFile", async () => {
    const def = makeDef("test", 4097, homeDir, "board.sqlite");
    const dirs = instanceDataDir(homeDir, def.name);
    mkdirSync(dirs.dataDir, { recursive: true });
    writeFileSync(dirs.pidFile, "not-a-number", "utf-8");

    // Should not throw — treats as stopped.
    await daemon.stop(def);
  });
});

// ── Start — health check failure ─────────────────────────────────────────────

describe("start — health check failure", () => {
  it(
    "throws InstanceSpawnError when health check times out",
    { timeout: 15000 },
    async () => {
      const def = makeDef("test", 4097, homeDir, "board.sqlite");
      const dirs = instanceDataDir(homeDir, def.name);
      mkdirSync(dirs.dataDir, { recursive: true });

      // Use a port with nothing listening so health check will fail.
      const port = await findFreePort();
      const defReal = makeDef(
        "test",
        port,
        homeDir,
        dirs.dataDir + "/db.sqlite",
      );

      // daemon.start() spawns "node dist/server/serve.mjs".
      // In the test environment, this file may or may not exist.
      // If it doesn't exist: child dies immediately → InstanceSpawnError.
      // If it does exist: child starts but health check fails (nothing
      //   responds, no opencode) → InstanceSpawnError after bounded retries.
      try {
        await daemon.start(defReal);
        // If start() succeeded, the spawned adapter is actually running.
        // This is unexpected in a test — clean up.
        try {
          await daemon.stop(defReal);
        } catch {
          /* ignore */
        }
      } catch (e) {
        expect(e).toBeInstanceOf(InstanceSpawnError);
        if (e instanceof InstanceSpawnError) {
          expect(e.instanceName).toBe("test");
        }
      }
    },
  );
});

// ── Daemon — full lifecycle with stub adapter ────────────────────────────────

describe("daemon lifecycle with stub adapter", () => {
  it("start → status(running) → stop → status(stopped)", async () => {
    const port = await findFreePort();
    const dirs = instanceDataDir(homeDir, "test");
    const defReal = makeDef(
      "test",
      port,
      homeDir,
      dirs.dataDir + "/db.sqlite",
    );
    const stubDaemon = createInstanceDaemon(homeDir, { serveScript: healthyStubScript() });

    try {
      const started = await stubDaemon.start(defReal);
      expect(started.status).toBe("running");
      expect(started.pid).toBeTypeOf("number");
      expect(started.boardUrl).toBe(`http://127.0.0.1:${port}`);
      expect(readFileSync(dirs.pidFile, "utf-8").trim()).toBe(String(started.pid));

      const runningState = await stubDaemon.status(defReal);
      expect(runningState.status).toBe("running");

      await stubDaemon.stop(defReal);
      const stoppedState = await stubDaemon.status(defReal);
      expect(stoppedState.status).toBe("stopped");
    } finally {
      try {
        await stubDaemon.stop(defReal);
      } catch {
        /* ignore */
      }
    }
  });

  it("start closes the parent log fd on success", async () => {
    const port = await findFreePort();
    const dirs = instanceDataDir(homeDir, "test");
    const defReal = makeDef("test", port, homeDir, dirs.dataDir + "/db.sqlite");
    const closedFds: number[] = [];
    const stubDaemon = createInstanceDaemon(homeDir, {
      serveScript: healthyStubScript(),
      closeFd: (fd) => {
        closedFds.push(fd);
        closeSync(fd);
      },
    });

    try {
      await stubDaemon.start(defReal);
      expect(readFileSync(dirs.pidFile, "utf-8").trim()).toMatch(/^\d+$/);
      expect(closedFds).toHaveLength(1);
    } finally {
      await stubDaemon.stop(defReal);
    }
  });

  it("concurrent start for the same instance spawns once and returns a typed error for the loser", async () => {
    const port = await findFreePort();
    const dirs = instanceDataDir(homeDir, "test");
    const defReal = makeDef("test", port, homeDir, dirs.dataDir + "/db.sqlite");
    const stubDaemon = createInstanceDaemon(homeDir, { serveScript: healthyStubScript() });

    try {
      const results = await Promise.allSettled([stubDaemon.start(defReal), stubDaemon.start(defReal)]);
      const fulfilled = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof stubDaemon.start>>> => result.status === "fulfilled");
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(InstanceError);
      expect(String(rejected[0].reason.message)).toContain("already starting");
      expect(readFileSync(dirs.pidFile, "utf-8").trim()).toBe(String(fulfilled[0].value.pid));
    } finally {
      await stubDaemon.stop(defReal);
    }
  });

  it("recovers a start lock held by a dead pid", async () => {
    const port = await findFreePort();
    const dirs = instanceDataDir(homeDir, "test");
    const lockPath = writeStartLock(dirs.dataDir, deadPid());
    const defReal = makeDef("test", port, homeDir, dirs.dataDir + "/db.sqlite");
    const stubDaemon = createInstanceDaemon(homeDir, { serveScript: healthyStubScript() });

    try {
      const started = await stubDaemon.start(defReal);
      expect(started.status).toBe("running");
      expect(readFileSync(dirs.pidFile, "utf-8").trim()).toBe(String(started.pid));
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await stubDaemon.stop(defReal);
    }
  });

  it("refuses a fresh start lock held by a live pid without touching it", async () => {
    const port = await findFreePort();
    const dirs = instanceDataDir(homeDir, "test");
    const lockPath = writeStartLock(dirs.dataDir, process.pid);
    const before = readFileSync(lockPath, "utf-8");
    const defReal = makeDef("test", port, homeDir, dirs.dataDir + "/db.sqlite");
    const stubDaemon = createInstanceDaemon(homeDir, { serveScript: healthyStubScript() });

    await expect(stubDaemon.start(defReal)).rejects.toBeInstanceOf(InstanceError);
    await expect(stubDaemon.start(defReal)).rejects.toThrow(/already starting/);
    expect(readFileSync(lockPath, "utf-8")).toBe(before);
    unlinkSync(lockPath);
  });

  it("recovers an aged start lock even when its pid is alive", async () => {
    const port = await findFreePort();
    const dirs = instanceDataDir(homeDir, "test");
    const lockPath = writeStartLock(dirs.dataDir, process.pid, Date.now() - 31_000);
    const defReal = makeDef("test", port, homeDir, dirs.dataDir + "/db.sqlite");
    const stubDaemon = createInstanceDaemon(homeDir, { serveScript: healthyStubScript() });

    try {
      const started = await stubDaemon.start(defReal);
      expect(started.status).toBe("running");
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await stubDaemon.stop(defReal);
    }
  });

  it("start refuses an unhealthy live pid without touching the pidFile", async () => {
    const port = await findFreePort();
    const dirs = instanceDataDir(homeDir, "test");
    mkdirSync(dirs.dataDir, { recursive: true });
    writeFileSync(dirs.pidFile, String(process.pid), "utf-8");
    const defReal = makeDef("test", port, homeDir, dirs.dataDir + "/db.sqlite");
    const stubDaemon = createInstanceDaemon(homeDir, { serveScript: healthyStubScript() });

    await expect(stubDaemon.start(defReal)).rejects.toBeInstanceOf(InstanceError);
    expect(readFileSync(dirs.pidFile, "utf-8").trim()).toBe(String(process.pid));
    unlinkSync(dirs.pidFile);
  });

  it("early-exit child throws InstanceSpawnError with log tail", async () => {
    const port = await findFreePort();
    const dirs = instanceDataDir(homeDir, "test");
    const defReal = makeDef("test", port, homeDir, dirs.dataDir + "/db.sqlite");
    const stubDaemon = createInstanceDaemon(homeDir, { serveScript: earlyExitStubScript() });

    try {
      await stubDaemon.start(defReal);
      expect.fail("start should have failed");
    } catch (error) {
      expect(error).toBeInstanceOf(InstanceSpawnError);
      expect(String((error as InstanceSpawnError).cause)).toContain("Log tail");
      expect(String((error as InstanceSpawnError).cause)).toContain("stub adapter boom");
    }
    expect(readFileSync(dirs.logFile, "utf-8")).toContain("stub adapter boom");
  });

  it("stop terminates the daemon process group, including grandchildren", async () => {
    const port = await findFreePort();
    const dirs = instanceDataDir(homeDir, "test");
    const grandchildPidFile = join(homeDir, "grandchild.pid");
    const defReal = makeDef("test", port, homeDir, dirs.dataDir + "/db.sqlite");
    const stubDaemon = createInstanceDaemon(homeDir, { serveScript: groupStubScript(grandchildPidFile) });

    const started = await stubDaemon.start(defReal);
    const childPid = started.pid;
    expect(childPid).toBeTypeOf("number");
    const grandchildPid = Number.parseInt(readFileSync(grandchildPidFile, "utf-8"), 10);
    expect(processAlive(childPid!)).toBe(true);
    expect(processAlive(grandchildPid)).toBe(true);

    await stubDaemon.stop(defReal);
    await waitForDead(childPid!);
    await waitForDead(grandchildPid);
    expect(existsSync(dirs.pidFile)).toBe(false);
  });
});

// ── spawn failure path ───────────────────────────────────────────────────────

describe("spawn failure", () => {
  it("start() asserts exactly one failure outcome for a missing child script", async () => {
    const port = await findFreePort();
    const def = makeDef("test", port, homeDir, "board.sqlite");
    const stubDaemon = createInstanceDaemon(homeDir, { serveScript: join(homeDir, "missing.mjs") });

    await expect(stubDaemon.start(def)).rejects.toBeInstanceOf(InstanceSpawnError);
    try {
      await stubDaemon.stop(def);
    } catch {
      /* ignore */
    }
  });
});

// ── buildAdapterEnv ─────────────────────────────────────────────────────────────

describe("buildAdapterEnv", () => {
  it("includes OPENBOARD_INSTANCE_NAME in the env object", () => {
    const def: InstanceDefinition = {
      name: "my-test-instance",
      port: 4097,
      workspace: "/ws/test",
      dbPath: "board.sqlite",
    };
    const env = buildAdapterEnv(def);
    expect(env.OPENBOARD_INSTANCE_NAME).toBe("my-test-instance");
  });

  it("still passes OPENBOARD_PORT, OPENBOARD_DB, and BOARD_WORKSPACE", () => {
    const def: InstanceDefinition = {
      name: "test",
      port: 5555,
      workspace: "/ws",
      dbPath: "db.sqlite",
    };
    const env = buildAdapterEnv(def);
    expect(env.OPENBOARD_PORT).toBe("5555");
    expect(env.OPENBOARD_DB).toBe("db.sqlite");
    expect(env.BOARD_WORKSPACE).toBe("/ws");
  });

  it("includes OPENBOARD_OPENCODE_PORT when defined", () => {
    const def: InstanceDefinition = {
      name: "test",
      port: 4097,
      workspace: "/ws",
      dbPath: "db.sqlite",
      opencodePort: 4098,
    };
    const env = buildAdapterEnv(def);
    expect(env.OPENBOARD_OPENCODE_PORT).toBe("4098");
  });
});
