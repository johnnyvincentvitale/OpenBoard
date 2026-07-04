import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { SqliteColumnStore } from "../db/board-store";
import { SqliteTaskStore } from "../db/task-store";
import { GlobalArchiveStore, resolveGlobalArchivePath, type SourceInstanceInfo } from "../db/global-archive-store";
import { assertPortFree, deriveStorePaths, resolveAdapterConfig, resolveInstanceConfig } from "./config";
import { startOrConnect } from "./opencode";
import { EventBridge } from "./event-bridge";
import { TaskDispatcher } from "./dispatcher";
import { createApp } from "./app";
import { resolveBoardToken } from "./auth";
import { registerTerminalRoutes } from "./routes/terminals";
import { PtyManager } from "./terminal/pty-manager";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

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

  const handle = await startOrConnect(config);

  const storePaths = deriveStorePaths(instance);
  const store = new SqliteColumnStore(storePaths.boardDbPath);
  const bridge = new EventBridge({ client: handle.client, store });
  bridge.start();

  // Push layer: task store + dispatcher (auto-advances cards from the /event stream).
  const taskStore = new SqliteTaskStore(storePaths.taskDbPath);
  const dispatcher = new TaskDispatcher({
    client: handle.client,
    store: taskStore,
    adapterBaseUrl: `http://${config.hostname}:${config.boardPort}`,
    boardToken,
  });
  dispatcher.start();
  const terminalManager = new PtyManager({ taskStore });

  // Global archive store — cross-instance mirrored archive for all tasks.
  const globalArchiveStore = new GlobalArchiveStore(resolveGlobalArchivePath());
  const sourceInstance: SourceInstanceInfo = {
    name: process.env.OPENBOARD_INSTANCE_NAME?.trim() || undefined,
    port: instance.port,
    workspace: instance.workspace,
    dbPath: storePaths.taskDbPath,
  };

  const app = createApp({
    client: handle.client,
    store,
    bridge,
    taskStore,
    dispatcher,
    opencodeBaseUrl: handle.baseUrl,
    globalArchiveStore,
    sourceInstance,
    boardToken,
  });
  registerTerminalRoutes(app, { manager: terminalManager });

  // Serve the built frontend (dist/web) for browser fallback / production.
  // Absolute path so it's independent of the process cwd (the adapter/OpenCode
  // default workspace). API routes are already registered above and match
  // first; this catch-all serves the SPA.
  const webDir =
    process.env.BOARD_WEB_DIR ??
    resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/web");
  if (existsSync(webDir)) {
    app.get("/*", (c) => {
      const urlPath = new URL(c.req.url).pathname;
      const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
      let file = join(webDir, rel);
      if (!existsSync(file) || !file.startsWith(webDir)) file = join(webDir, "index.html");
      let body = readFileSync(file);

      // Inject the board API token into the HTML so the same-origin web client
      // can send it on every API call without the user pasting it manually.
      if (extname(file) === ".html") {
        const tokenScript = `<script>window.__BOARD_API_TOKEN__ = ${JSON.stringify(boardToken)};</script>`;
        body = Buffer.from(
          body.toString("utf8").replace("</head>", `${tokenScript}</head>`),
        );
      }

      return c.body(body, 200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    });
  }
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
    bridge.stop();
    dispatcher.shutdown();
    terminalManager.cleanupReservations();
    terminalManager.killAll();
    await handle.shutdown();
    store.close();
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
