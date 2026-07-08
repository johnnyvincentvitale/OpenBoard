import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { GlobalArchiveStore, resolveGlobalArchivePath, type SourceInstanceInfo } from "../db/global-archive-store";
import { SqliteTaskStore } from "../db/task-store";
import { assertPortFree, deriveStorePaths, resolveAdapterConfig, resolveInstanceConfig } from "./config";
import { startOrConnect } from "./opencode";
import { TaskDispatcher } from "./dispatcher";
import { createApp } from "./app";
import { resolveBoardToken } from "./auth";
import { registerTerminalRoutes } from "./routes/terminals";
import { PtyManager } from "./terminal/pty-manager";

/** Boot the board: connect/spawn opencode, open the sidecars, start the event bridge + dispatcher, serve. */
export async function main(): Promise<void> {
  const instance = resolveInstanceConfig();
  const config = await resolveAdapterConfig(process.env, instance);

  // Fail fast on the adapter's own port before spawning anything (including
  // the OpenCode server below) — a taken board port must produce a clear
  // startup error, never a half-started instance.
  await assertPortFree(config.boardPort, config.hostname);

  // Per-instance board API token — random at startup, configurable via
  // OPENBOARD_API_TOKEN env var. Local clients pick it up from the environment
  // so users don't paste it manually.
  const boardToken = resolveBoardToken(process.env);

  // Open the task store early so the bashSandbox setting can be read before
  // spawning OpenCode. When the user has set bashSandbox: false, the sandbox
  // wrapper is not wired, and worktree runs do not fail-close.
  const storePaths = deriveStorePaths(instance);
  const taskStore = new SqliteTaskStore(storePaths.taskDbPath);
  const bashSandboxDesired = taskStore.getSettings().bashSandbox;

  const handle = await startOrConnect(config, { bashSandboxDesired });
  const dispatcher = new TaskDispatcher({
    client: handle.client,
    store: taskStore,
    adapterBaseUrl: `http://${config.hostname}:${config.boardPort}`,
    boardToken,
    instanceName: process.env.OPENBOARD_INSTANCE_NAME?.trim() || undefined,
    sandbox: handle.sandbox,
  });
  try {
    const outcomes = await dispatcher.sweepOrphanedWorktrees();
    const removedCleanCount = outcomes.filter((o) => o.ok && o.removed && !o.dirty).length;
    const keptDirtyCount = outcomes.filter((o) => !o.removed && o.dirty).length;
    const dirtyOrphans = outcomes
      .filter((o) => !o.removed && o.dirty)
      .map((o) => ({
        worktreePath: o.worktreePath ?? "unknown",
        taskId: o.worktreePath ? o.worktreePath.split("/").pop() ?? "unknown" : "unknown",
      }));
    taskStore.setSweepResult({
      sweptAt: Date.now(),
      removedCleanCount,
      keptDirtyCount,
      dirtyOrphans,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`openboard orphan worktree sweep skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
  dispatcher.start();
  const terminalManager = new PtyManager({ taskStore });

  const globalArchiveStore = new GlobalArchiveStore(resolveGlobalArchivePath());
  const sourceInstance: SourceInstanceInfo = {
    name: process.env.OPENBOARD_INSTANCE_NAME?.trim() || undefined,
    port: instance.port,
    workspace: instance.workspace,
    dbPath: storePaths.taskDbPath,
    opencodeBaseUrl: handle.baseUrl,
  };

  const app = createApp({
    client: handle.client,
    taskStore,
    dispatcher,
    opencodeBaseUrl: handle.baseUrl,
    globalArchiveStore,
    sourceInstance,
    boardToken,
    sandbox: handle.sandbox,
    opencodeMode: config.mode,
  });
  registerTerminalRoutes(app, { manager: terminalManager });

  const wss = new WebSocketServer({ noServer: true });
  const server = serve(
    { fetch: app.fetch, hostname: config.hostname, port: config.boardPort, websocket: { server: wss } },
    (info) => {
      // eslint-disable-next-line no-console
      console.log(
        `openboard → http://${config.hostname}:${info.port}  (opencode: ${handle.baseUrl})`,
      );
      if (!process.env.OPENBOARD_API_TOKEN) {
        // eslint-disable-next-line no-console
        console.log(`board API token: ${boardToken}`);
      }
    },
  );

  const shutdown = async () => {
    dispatcher.shutdown();
    terminalManager.cleanupReservations();
    terminalManager.killAll();
    await handle.shutdown();
    taskStore.close();
    globalArchiveStore.close();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Run only when executed directly (not when imported by a test).
const invokedDirectly =
  typeof process.argv[1] === "string" && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
