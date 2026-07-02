import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { SqliteColumnStore } from "../db/board-store";
import { SqliteTaskStore } from "../db/task-store";
import { loadConfig } from "./config";
import { startOrConnect } from "./opencode";
import { EventBridge } from "./event-bridge";
import { TaskDispatcher } from "./dispatcher";
import { createApp } from "./app";

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
  const config = loadConfig();
  const handle = await startOrConnect(config);
  const store = new SqliteColumnStore(process.env.BOARD_DB_PATH ?? "board.sqlite");
  const bridge = new EventBridge({ client: handle.client, store });
  bridge.start();

  // Push layer: task store + dispatcher (auto-advances cards from the /event stream).
  const taskStore = new SqliteTaskStore(process.env.BOARD_TASK_DB_PATH ?? "board-tasks.sqlite");
  const dispatcher = new TaskDispatcher({ client: handle.client, store: taskStore });
  dispatcher.start();

  const app = createApp({
    client: handle.client,
    store,
    bridge,
    taskStore,
    dispatcher,
    opencodeBaseUrl: handle.baseUrl,
  });

  // Serve the built frontend (dist/web) for the Electron shell / production. Absolute
  // path so it's independent of the process cwd (the adapter/OpenCode default workspace). API
  // routes are already registered above and match first; this catch-all serves the SPA.
  const webDir =
    process.env.BOARD_WEB_DIR ??
    resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/web");
  if (existsSync(webDir)) {
    app.get("/*", (c) => {
      const urlPath = new URL(c.req.url).pathname;
      const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
      let file = join(webDir, rel);
      if (!existsSync(file) || !file.startsWith(webDir)) file = join(webDir, "index.html");
      const body = readFileSync(file);
      return c.body(body, 200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    });
  }
  const server = serve(
    { fetch: app.fetch, hostname: config.hostname, port: config.boardPort },
    (info) => {
      // eslint-disable-next-line no-console
      console.log(
        `opencode-board → http://${config.hostname}:${info.port}  (opencode: ${handle.baseUrl})`,
      );
    },
  );

  const shutdown = async () => {
    bridge.stop();
    dispatcher.shutdown();
    await handle.shutdown();
    store.close();
    taskStore.close();
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
