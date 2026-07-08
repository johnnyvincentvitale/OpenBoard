/**
 * OpenBoard CLI integration test — proves the named-instance `openboard`
 * binary (dist/cli/openboard.mjs) works end-to-end with the real registry +
 * daemon seam behind `src/instances`.
 *
 * Flow covered:
 *   openboard add <name> --workspace <dir> --port N
 *   openboard start <name>
 *   openboard list
 *   instance A task is isolated from instance B
 *   openboard stop <name>
 *   stale-pidfile recovery after kill -9
 *
 * Uses an ephemeral OpenCode server (same helper as other integration tests)
 * so the spawned adapters can run in "connect" mode without requiring a real
 * long-running `opencode serve` backend, and self-skips via opencodeAvailable()
 * when the OpenCode SDK isn't available.
 *
 * Every test gets a fresh temp HOME directory so the user registry
 * (`~/.config/openboard/instances.json`) and per-instance data dirs are fully
 * isolated and cleaned up. All spawned processes are stopped and/or killed
 * even when a test fails.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { findFreePort } from "../../src/server/config";
import {
  opencodeAvailable,
  startEphemeralOpencodeServer,
  type EphemeralOpencodeServer,
} from "../helpers/ephemeral-opencode-server";

const available = await opencodeAvailable();

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI_PATH = join(REPO_ROOT, "dist", "cli", "openboard.mjs");
const BOARD_TOKEN = "test-token";
const AUTH_HEADERS = { authorization: `Bearer ${BOARD_TOKEN}` } as const;

let ephemeral: EphemeralOpencodeServer | undefined;

function buildCliArtifacts(): void {
  // The daemon spawns dist/server/serve.mjs, and the CLI binary is
  // dist/cli/openboard.mjs. Build both once before the suite.
  execSync("npm run build:server && npm run build:cli", {
    cwd: REPO_ROOT,
    stdio: "pipe",
    timeout: 120_000,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return;
    } catch (err) {
      lastError = err;
    }
    await sleep(300);
  }
  throw new Error(`Health on port ${port} never returned OK: ${String(lastError)}`);
}

async function waitForHealthGone(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (!res.ok) return;
    } catch {
      return;
    }
    await sleep(200);
  }
  throw new Error(`Health on port ${port} was still reachable after timeout`);
}

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface TestContext {
  home: string;
  env: NodeJS.ProcessEnv;
  instances: string[];
  childProcesses: ReturnType<typeof spawn>[];
}

function createTestEnv(): TestContext {
  const home = mkdtempSync(join(tmpdir(), "openboard-cli-it-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    OPENCODE_BASE_URL: ephemeral?.url,
    OPENCODE_MANAGE_PROCESS: "false",
    OPENBOARD_API_TOKEN: BOARD_TOKEN,
    NODE_NO_WARNINGS: "1",
  };
  return { home, env, instances: [], childProcesses: [] };
}

function runCli(
  ctx: TestContext,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: REPO_ROOT,
      env: ctx.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    ctx.childProcesses.push(child);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk) => stderrChunks.push(chunk));

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`openboard ${args.join(" ")} timed out`));
    }, opts.timeoutMs ?? 30_000);

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
      });
    });
  });
}

function pidFilePath(home: string, name: string): string {
  return join(home, ".local", "share", "openboard", name, "openboard.pid");
}

async function cleanup(ctx: TestContext): Promise<void> {
  for (const name of ctx.instances) {
    try {
      await runCli(ctx, ["stop", name], { timeoutMs: 10_000 });
    } catch {
      /* ignore — process may already be gone */
    }
    const pidFile = pidFilePath(ctx.home, name);
    if (existsSync(pidFile)) {
      try {
        const pid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
        if (Number.isFinite(pid) && pid > 0) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* already dead */
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
  for (const child of ctx.childProcesses) {
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }
  rmSync(ctx.home, { recursive: true, force: true });
}

async function createTask(port: number, title: string, directory: string): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
    method: "POST",
    headers: { ...AUTH_HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ title, description: "cli-instance isolation task", directory }),
  });
  if (!res.ok) throw new Error(`createTask failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function listTasks(port: number): Promise<Array<{ title: string }>> {
  const res = await fetch(`http://127.0.0.1:${port}/api/tasks`, { headers: AUTH_HEADERS });
  if (!res.ok) throw new Error(`listTasks failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function healthOk(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

describe.skipIf(!available)("openboard CLI named-instance flow (integration)", () => {
  beforeAll(async () => {
    buildCliArtifacts();
    ephemeral = await startEphemeralOpencodeServer();
  }, 180_000);

  afterAll(async () => {
    await ephemeral?.close();
  });

  it(
    "adds, starts, lists, isolates, and stops named instances",
    async () => {
      const ctx = createTestEnv();
      try {
        const workspaceA = mkdtempSync(join(tmpdir(), "openboard-cli-ws-a-"));
        const workspaceB = mkdtempSync(join(tmpdir(), "openboard-cli-ws-b-"));

        const [portA, portB] = await Promise.all([
          findFreePort("127.0.0.1"),
          findFreePort("127.0.0.1"),
        ]);
        expect(portA).not.toBe(portB);

        // Register two instances; add is register-only and start is explicit.
        const addA = await runCli(ctx, [
          "add",
          "alpha",
          "--workspace",
          workspaceA,
          "--port",
          String(portA),
        ]);
        expect(addA.code).toBe(0);

        const addB = await runCli(ctx, [
          "add",
          "beta",
          "--workspace",
          workspaceB,
          "--port",
          String(portB),
        ]);
        expect(addB.code).toBe(0);
        ctx.instances = ["alpha", "beta"];

        // List before start shows both stopped.
        const listBefore = await runCli(ctx, ["list"]);
        expect(listBefore.code).toBe(0);
        expect(listBefore.stdout).toContain("alpha");
        expect(listBefore.stdout).toContain("beta");
        expect(listBefore.stdout).toContain("stopped");

        // Start both.
        const startA = await runCli(ctx, ["start", "alpha"]);
        expect(startA.code).toBe(0);
        const startB = await runCli(ctx, ["start", "beta"]);
        expect(startB.code).toBe(0);

        // Both healthy on distinct ports.
        await Promise.all([waitForHealth(portA), waitForHealth(portB)]);

        const [healthA, healthB] = await Promise.all([
          fetch(`http://127.0.0.1:${portA}/api/health`).then((r) => r.json()),
          fetch(`http://127.0.0.1:${portB}/api/health`).then((r) => r.json()),
        ]);
        expect(healthA.adapter).toBe("ok");
        expect(healthB.adapter).toBe("ok");
        expect(healthA.opencode.status).toBe("ok");
        expect(healthB.opencode.status).toBe("ok");

        // List shows both running with the right ports.
        const listRunning = await runCli(ctx, ["list"]);
        expect(listRunning.code).toBe(0);
        const rows = listRunning.stdout
          .split("\n")
          .filter((line) => line.startsWith("alpha") || line.startsWith("beta"));
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatch(/alpha\s+running/);
        expect(rows[1]).toMatch(/beta\s+running/);
        expect(rows[0]).toContain(String(portA));
        expect(rows[1]).toContain(String(portB));

        // Distinct DBs: write through A, prove B does not see it.
        const taskDir = mkdtempSync(join(workspaceA, "task-"));
        const created = (await createTask(portA, "alpha-only-task", taskDir)) as {
          title: string;
        };
        expect(created.title).toBe("alpha-only-task");

        const tasksA = await listTasks(portA);
        const tasksB = await listTasks(portB);
        expect(tasksA.map((t) => t.title)).toContain("alpha-only-task");
        expect(tasksB.map((t) => t.title)).not.toContain("alpha-only-task");
        expect(tasksB).toEqual([]);

        // Stop alpha.
        const stopA = await runCli(ctx, ["stop", "alpha"]);
        expect(stopA.code).toBe(0);
        expect(stopA.stdout).toMatch(/Instance "alpha" is stopped/);

        // Alpha's health endpoint dies; beta stays healthy.
        await waitForHealthGone(portA);
        await waitForHealth(portB);
        expect(await healthOk(portB)).toBe(true);

        // Alpha's pidfile is removed.
        expect(existsSync(pidFilePath(ctx.home, "alpha"))).toBe(false);
        // Beta's pidfile remains.
        expect(existsSync(pidFilePath(ctx.home, "beta"))).toBe(true);
      } finally {
        await cleanup(ctx);
      }
    },
    120_000,
  );

  it(
    "recovers from a stale pidfile after kill -9",
    async () => {
      const ctx = createTestEnv();
      try {
        const workspace = mkdtempSync(join(tmpdir(), "openboard-cli-stale-ws-"));
        const port = await findFreePort("127.0.0.1");

        const add = await runCli(ctx, [
          "add",
          "gamma",
          "--workspace",
          workspace,
          "--port",
          String(port),
        ]);
        expect(add.code).toBe(0);
        ctx.instances = ["gamma"];

        const start = await runCli(ctx, ["start", "gamma"]);
        expect(start.code).toBe(0);
        await waitForHealth(port);

        const pidFile = pidFilePath(ctx.home, "gamma");
        expect(existsSync(pidFile)).toBe(true);
        const pid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
        expect(Number.isFinite(pid) && pid > 0).toBe(true);

        // Simulate an unclean shutdown.
        process.kill(pid, "SIGKILL");
        await sleep(500);

        // List should detect the stale pidfile and not report "running".
        const listStale = await runCli(ctx, ["list"]);
        expect(listStale.code).toBe(0);
        const gammaLine = listStale.stdout
          .split("\n")
          .find((line) => line.startsWith("gamma"));
        expect(gammaLine).toBeDefined();
        expect(gammaLine).not.toMatch(/gamma\s+running/);
        expect(gammaLine).toMatch(/gamma\s+(stale-pid|stopped)/);

        // Stopping cleans up the stale state and removes the pidfile.
        const stop = await runCli(ctx, ["stop", "gamma"]);
        expect(stop.code).toBe(0);
        await waitForHealthGone(port);
        expect(existsSync(pidFile)).toBe(false);
      } finally {
        await cleanup(ctx);
      }
    },
    60_000,
  );
});
