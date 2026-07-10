import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { GlobalArchiveStore, resolveGlobalArchivePath, type SourceInstanceInfo } from "../db/global-archive-store";
import { SqliteTaskStore } from "../db/task-store";
import type { TaskStore } from "../shared/index";
import { assertPortFree, deriveStorePaths, resolveAdapterConfig, resolveInstanceConfig } from "./config";
import { startOrConnect, type OpencodeHandle } from "./opencode";
import { TaskDispatcher } from "./dispatcher";
import { createChainAdvancer, type ChainAdvancer } from "./chain-advancer";
import { createApp } from "./app";
import { SessionActivityCollector } from "./session-activity";
import { resolveBoardToken } from "./auth";
import { registerTerminalRoutes } from "./routes/terminals";
import { PtyManager } from "./terminal/pty-manager";

export interface ServerCompositionDeps {
  client: OpencodeHandle["client"];
  taskStore: TaskStore;
  adapterBaseUrl: string;
  boardToken: string;
  instanceName?: string;
  opencodeBaseUrl: string;
  globalArchiveStore: GlobalArchiveStore;
  sourceInstance: SourceInstanceInfo;
  opencodeMode: "spawn" | "connect";
}

export interface ServerComposition {
  dispatcher: TaskDispatcher;
  chainAdvancer: ChainAdvancer;
  app: Hono;
  activity: SessionActivityCollector;
}

/**
 * Wire the dispatcher, chain advancer, and Hono app together. This is the
 * one place that decides whether the dispatcher (writer) and the
 * session-events route (reader, inside createApp) observe the same
 * SessionActivityCollector — constructing two instances silently starves
 * the route to the static no-collector heartbeat path even while the
 * dispatcher is actively recording activity. `main()` below is the only
 * production caller; tests import this function directly so a dropped
 * `activity` wire on either side fails for real, not just in a hand-rolled
 * test double.
 */
export function composeServer(deps: ServerCompositionDeps): ServerComposition {
  const activity = new SessionActivityCollector();
  const dispatcher = new TaskDispatcher({
    client: deps.client,
    store: deps.taskStore,
    adapterBaseUrl: deps.adapterBaseUrl,
    boardToken: deps.boardToken,
    instanceName: deps.instanceName,
    activity,
  });
  const chainAdvancer = createChainAdvancer({ store: deps.taskStore, runTask: (taskId) => dispatcher.run(taskId) });
  dispatcher.setOnParentSatisfied((parentId) => chainAdvancer.advanceReadyChildren(parentId));
  const app = createApp({
    client: deps.client,
    taskStore: deps.taskStore,
    dispatcher,
    opencodeBaseUrl: deps.opencodeBaseUrl,
    globalArchiveStore: deps.globalArchiveStore,
    sourceInstance: deps.sourceInstance,
    boardToken: deps.boardToken,
    opencodeMode: deps.opencodeMode,
    chainAdvancer,
    activity,
  });
  return { dispatcher, chainAdvancer, app, activity };
}

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

  const adapterBaseUrl = `http://${config.hostname}:${config.boardPort}`;
  const instanceName = process.env.OPENBOARD_INSTANCE_NAME?.trim() || undefined;

  const storePaths = deriveStorePaths(instance);
  const taskStore = new SqliteTaskStore(storePaths.taskDbPath);

  const handle = await startOrConnect(config, {
    openboardMcp: {
      adapterBaseUrl,
      boardToken,
      instanceName,
    },
  });
  const globalArchiveStore = new GlobalArchiveStore(resolveGlobalArchivePath());
  const sourceInstance: SourceInstanceInfo = {
    name: process.env.OPENBOARD_INSTANCE_NAME?.trim() || undefined,
    port: instance.port,
    workspace: instance.workspace,
    dbPath: storePaths.taskDbPath,
    opencodeBaseUrl: handle.baseUrl,
  };

  const { dispatcher, app } = composeServer({
    client: handle.client,
    taskStore,
    adapterBaseUrl,
    boardToken,
    instanceName,
    opencodeBaseUrl: handle.baseUrl,
    globalArchiveStore,
    sourceInstance,
    opencodeMode: config.mode,
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
        dirtyFileCount: o.dirtyFileCount ?? 0,
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
