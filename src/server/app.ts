import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ColumnStore, Dispatcher, TaskStore } from "../shared/index";
import { AdapterError } from "../shared/index";
import type { OpencodeHandle } from "./opencode";
import { EventBridge } from "./event-bridge";
import { registerHealthRoutes } from "./routes/health";
import { registerBoardRoutes } from "./routes/board";
import { registerCardActionRoutes } from "./routes/card-actions";
import { registerBoardEventsRoutes } from "./routes/board-events";
import { registerTaskRoutes } from "./routes/tasks";
import { registerTaskEventsRoutes } from "./routes/task-events";
import { registerAgentRoutes } from "./routes/agents";

export interface AppDeps {
  client: OpencodeHandle["client"];
  store: ColumnStore;
  bridge: EventBridge;
  /** Task (Push) layer. */
  taskStore: TaskStore;
  dispatcher: Dispatcher;
  /** OpenCode base URL, for the agent roster proxy. */
  opencodeBaseUrl: string;
}

const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/** Compose the full Hono app from Phase-2 route modules. The integrator owns this file. */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  // Local-only tool: allow same-origin (no Origin header) and any localhost dev origin.
  app.use(
    "*",
    cors({ origin: (origin) => (!origin || LOCALHOST_ORIGIN.test(origin) ? origin || "*" : "") }),
  );

  registerHealthRoutes(app, { client: deps.client });
  registerBoardRoutes(app, { client: deps.client, store: deps.store });
  registerCardActionRoutes(app, { client: deps.client });
  registerBoardEventsRoutes(app, { bridge: deps.bridge });

  // Push (task) layer: the roster, task CRUD/run, and the task SSE stream.
  registerAgentRoutes(app, { baseUrl: deps.opencodeBaseUrl });
  registerTaskRoutes(app, { store: deps.taskStore, dispatcher: deps.dispatcher });
  registerTaskEventsRoutes(app, { store: deps.taskStore });

  // Safety net — route modules already translate their own AdapterErrors, this catches escapes.
  app.onError((err, c) => {
    const ae =
      err instanceof AdapterError
        ? err
        : AdapterError.internal(err instanceof Error ? err.message : "Unexpected error", err);
    return c.json(ae.toEnvelope(), ae.status as ContentfulStatusCode);
  });

  return app;
}
