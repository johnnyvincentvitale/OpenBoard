/**
 * Multi-instance integration test — proves two fully independent OpenBoard
 * *adapter* processes (spawned via `tsx src/server/serve.ts`, exactly as
 * `npm run dev:server` does) can run
 * simultaneously with disjoint ports, disjoint task/board DB files, and
 * disjoint spawned OpenCode backends, driven purely by env.
 *
 * This is the heavier, scripted-child-process proof the card's acceptance
 * criteria calls for ("prove two adapters started with different
 * OPENBOARD_PORT/OPENBOARD_DB values serve disjoint task stores
 * simultaneously"). It spawns two real `opencode` backends, so it self-skips
 * (via `opencodeAvailable()`, matching the existing integration-test
 * pattern) when the `opencode` binary/runtime isn't available — e.g. some CI
 * environments — in which case the lighter, hermetic
 * `test/server/config.test.ts` / `test/server/opencode.test.ts` suites are
 * the config-level proof for the same behavior (free-port selection, DB path
 * derivation, fail-fast port collision).
 *
 * IMPORTANT: deliberately clears the legacy `BOARD_DB_PATH` / `BOARD_PORT` /
 * `OPENCODE_PORT` / `BOARD_TASK_DB_PATH` env vars before spawning — if a
 * *different* running OpenBoard/dev session has exported those into this
 * shell's ambient env, they would otherwise win over `OPENBOARD_DB` for both
 * spawned children (see `deriveStorePaths`'s legacy-override precedence) and
 * make two "independent" instances collide on one DB file. Real deployments
 * won't have this ambient-env foot-gun in a fresh shell/process, but the
 * test controls for it explicitly rather than assuming a clean environment.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { findFreePort } from "../../src/server/config";
import { opencodeAvailable } from "../helpers/ephemeral-opencode-server";

const available = await opencodeAvailable();

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const SERVE_TS = join(REPO_ROOT, "src", "server", "serve.ts");
const BOARD_TOKEN = "test-token";
const AUTH_HEADERS = { authorization: `Bearer ${BOARD_TOKEN}` } as const;

interface SpawnedAdapter {
  child: ChildProcess;
  boardPort: number;
  output: () => string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(port: number, timeoutMs = 30_000): Promise<void> {
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
  throw new Error(`Adapter on port ${port} did not become healthy: ${String(lastError)}`);
}

/**
 * Spawn one adapter (`tsx src/server/serve.ts`) as a real child process,
 * with the legacy port/DB env vars explicitly cleared so ambient env from
 * an unrelated running instance in this shell can't leak in and make two
 * "independent" test instances collide.
 */
async function spawnAdapter(opts: {
  boardPort: number;
  opencodePort: number;
  dbPath: string;
  workspace: string;
}): Promise<SpawnedAdapter> {
  const lines: string[] = [];
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.BOARD_PORT;
  delete env.BOARD_DB_PATH;
  delete env.BOARD_TASK_DB_PATH;
  delete env.OPENCODE_PORT;
  delete env.OPENCODE_BASE_URL;

  env.OPENBOARD_PORT = String(opts.boardPort);
  env.OPENBOARD_OPENCODE_PORT = String(opts.opencodePort);
  env.OPENBOARD_DB = opts.dbPath;
  env.BOARD_WORKSPACE = opts.workspace;
  env.BOARD_WEB_DIR = "/nonexistent-web-dir-for-tests";
  env.OPENBOARD_API_TOKEN = BOARD_TOKEN;

  const child = spawn(TSX_BIN, [SERVE_TS], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const capture = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      if (line.trim()) lines.push(line);
    }
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  await waitForHealth(opts.boardPort);

  return { child, boardPort: opts.boardPort, output: () => lines.join("\n") };
}

function stopAdapter(adapter: SpawnedAdapter): Promise<void> {
  return new Promise((resolve) => {
    if (adapter.child.killed || adapter.child.exitCode !== null) {
      resolve();
      return;
    }
    adapter.child.once("exit", () => resolve());
    adapter.child.kill("SIGTERM");
    // Fallback in case the process ignores SIGTERM.
    setTimeout(() => {
      if (adapter.child.exitCode === null) adapter.child.kill("SIGKILL");
    }, 3000);
  });
}

async function createTask(boardPort: number, title: string, directory: string) {
  const res = await fetch(`http://127.0.0.1:${boardPort}/api/tasks`, {
    method: "POST",
    headers: { ...AUTH_HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ title, description: "multi-instance proof task", directory }),
  });
  if (!res.ok) throw new Error(`createTask failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function listTasks(boardPort: number): Promise<Array<{ title: string }>> {
  const res = await fetch(`http://127.0.0.1:${boardPort}/api/tasks`, { headers: AUTH_HEADERS });
  if (!res.ok) throw new Error(`listTasks failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function getHealth(boardPort: number): Promise<{ adapter: string; opencode: { status: string } }> {
  const res = await fetch(`http://127.0.0.1:${boardPort}/api/health`);
  if (!res.ok) throw new Error(`health failed: ${res.status}`);
  return res.json();
}

describe.skipIf(!available)("multi-instance (real child-process integration)", () => {
  let adapters: SpawnedAdapter[] = [];
  let tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(adapters.map(stopAdapter));
    adapters = [];
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs = [];
  });

  it(
    "two adapters with different OPENBOARD_PORT/OPENBOARD_DB serve fully disjoint task stores, both healthy, simultaneously",
    async () => {
      const [boardPortA, opencodePortA, boardPortB, opencodePortB] = await Promise.all([
        findFreePort("127.0.0.1"),
        findFreePort("127.0.0.1"),
        findFreePort("127.0.0.1"),
        findFreePort("127.0.0.1"),
      ]);

      const instanceDirA = mkdtempSync(join(tmpdir(), "openboard-instance-a-"));
      const instanceDirB = mkdtempSync(join(tmpdir(), "openboard-instance-b-"));
      const workspaceA = mkdtempSync(join(tmpdir(), "openboard-workspace-a-"));
      const workspaceB = mkdtempSync(join(tmpdir(), "openboard-workspace-b-"));
      const taskDirA = mkdtempSync(join(workspaceA, "taskdir-a-"));
      tempDirs = [instanceDirA, instanceDirB, workspaceA, workspaceB, taskDirA];

      const [adapterA, adapterB] = await Promise.all([
        spawnAdapter({
          boardPort: boardPortA,
          opencodePort: opencodePortA,
          dbPath: join(instanceDirA, "board.sqlite"),
          workspace: workspaceA,
        }),
        spawnAdapter({
          boardPort: boardPortB,
          opencodePort: opencodePortB,
          dbPath: join(instanceDirB, "board.sqlite"),
          workspace: workspaceB,
        }),
      ]);
      adapters = [adapterA, adapterB];

      // Both health endpoints OK.
      const [healthA, healthB] = await Promise.all([getHealth(boardPortA), getHealth(boardPortB)]);
      expect(healthA.adapter).toBe("ok");
      expect(healthA.opencode.status).toBe("ok");
      expect(healthB.adapter).toBe("ok");
      expect(healthB.opencode.status).toBe("ok");

      // Both start with disjoint (empty, in this case) task stores.
      const [initialA, initialB] = await Promise.all([listTasks(boardPortA), listTasks(boardPortB)]);
      expect(initialA).toEqual([]);
      expect(initialB).toEqual([]);

      // Create a task in instance A only.
      const created = (await createTask(boardPortA, "instance-A-only-task", taskDirA)) as { title: string };
      expect(created.title).toBe("instance-A-only-task");

      // Instance A sees it; instance B does not.
      const [tasksA, tasksB] = await Promise.all([listTasks(boardPortA), listTasks(boardPortB)]);
      expect(tasksA.map((t) => t.title)).toContain("instance-A-only-task");
      expect(tasksB.map((t) => t.title)).not.toContain("instance-A-only-task");
      expect(tasksB).toEqual([]);

      // Both still healthy after the write.
      const [healthA2, healthB2] = await Promise.all([getHealth(boardPortA), getHealth(boardPortB)]);
      expect(healthA2.adapter).toBe("ok");
      expect(healthB2.adapter).toBe("ok");
    },
    60_000,
  );

  it(
    "a second instance requesting an already-taken OPENBOARD_PORT fails fast with a clear error, not a half-started instance",
    async () => {
      const boardPort = await findFreePort("127.0.0.1");
      const opencodePortA = await findFreePort("127.0.0.1");
      const opencodePortB = await findFreePort("127.0.0.1");

      const instanceDirA = mkdtempSync(join(tmpdir(), "openboard-collision-a-"));
      const instanceDirB = mkdtempSync(join(tmpdir(), "openboard-collision-b-"));
      const workspace = mkdtempSync(join(tmpdir(), "openboard-collision-ws-"));
      tempDirs = [instanceDirA, instanceDirB, workspace];

      const adapterA = await spawnAdapter({
        boardPort,
        opencodePort: opencodePortA,
        dbPath: join(instanceDirA, "board.sqlite"),
        workspace,
      });
      adapters = [adapterA];

      // Second instance requests the SAME board port — must fail fast (non-zero
      // exit) rather than silently running alongside instance A.
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.BOARD_PORT;
      delete env.BOARD_DB_PATH;
      delete env.BOARD_TASK_DB_PATH;
      delete env.OPENCODE_PORT;
      delete env.OPENCODE_BASE_URL;
      env.OPENBOARD_PORT = String(boardPort);
      env.OPENBOARD_OPENCODE_PORT = String(opencodePortB);
      env.OPENBOARD_DB = join(instanceDirB, "board.sqlite");
      env.BOARD_WORKSPACE = workspace;
      env.BOARD_WEB_DIR = "/nonexistent-web-dir-for-tests";
      env.OPENBOARD_API_TOKEN = BOARD_TOKEN;

      const exit = await new Promise<{ code: number | null; output: string }>((resolve) => {
        const lines: string[] = [];
        const child = spawn(TSX_BIN, [SERVE_TS], {
          cwd: REPO_ROOT,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const capture = (chunk: Buffer) => lines.push(chunk.toString("utf8"));
        child.stdout?.on("data", capture);
        child.stderr?.on("data", capture);
        child.once("exit", (code) => resolve({ code, output: lines.join("") }));
        setTimeout(() => child.kill("SIGKILL"), 15_000);
      });

      expect(exit.code).not.toBe(0);
      expect(exit.output).toMatch(/already in use/i);
      expect(exit.output).toContain(String(boardPort));

      // Instance A is unaffected — still healthy.
      const health = await getHealth(boardPort);
      expect(health.adapter).toBe("ok");
    },
    30_000,
  );
});
