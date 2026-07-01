import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { SqliteColumnStore } from "../db/board-store";
import { loadConfig } from "./config";
import { startOrConnect } from "./opencode";
import { EventBridge } from "./event-bridge";
import { createApp } from "./app";

/** Boot the board: connect/spawn opencode, open the sqlite sidecar, start the event bridge, serve the app. */
export async function main(): Promise<void> {
  const config = loadConfig();
  const handle = await startOrConnect(config);
  const store = new SqliteColumnStore(process.env.BOARD_DB_PATH ?? "board.sqlite");
  const bridge = new EventBridge({ client: handle.client, store });
  bridge.start();

  const app = createApp({ client: handle.client, store, bridge });
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
    await handle.shutdown();
    store.close();
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
