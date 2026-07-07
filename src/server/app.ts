import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ColumnStore, Dispatcher, TaskStore } from "../shared/index";
import { AdapterError } from "../shared/index";
import type { GlobalArchiveStore, SourceInstanceInfo } from "../db/global-archive-store";
import type { OpencodeHandle } from "./opencode";
import { fetchRosterStrict } from "./agents";
import { requireBoardToken } from "./auth";
import { EventBridge } from "./event-bridge";
import { registerHealthRoutes } from "./routes/health";
import { registerBoardRoutes } from "./routes/board";
import { registerCardActionRoutes } from "./routes/card-actions";
import { registerBoardEventsRoutes } from "./routes/board-events";
import { registerTaskRoutes } from "./routes/tasks";
import { registerTaskEventsRoutes } from "./routes/task-events";
import { registerAgentRoutes } from "./routes/agents";
import { registerProviderRoutes } from "./routes/providers";
import { registerAcpConfigRoutes } from "./routes/acp-config";
import { registerCompletionRoutes } from "./routes/completion";
import { registerArchiveRoutes } from "./routes/archive";
import { registerTaskLinkRoutes } from "./routes/links";
import { registerTaskCommentRoutes } from "./routes/comments";

export interface AppDeps {
  client: OpencodeHandle["client"];
  store: ColumnStore;
  bridge: EventBridge;
  /** Task (Push) layer. */
  taskStore: TaskStore;
  dispatcher: Dispatcher;
  /** OpenCode base URL, for the agent roster proxy. */
  opencodeBaseUrl: string;
  /** Global archive store for cross-instance mirrored task archival. */
  globalArchiveStore: GlobalArchiveStore;
  /** Source instance identity written into every global archive mirror row. */
  sourceInstance: SourceInstanceInfo;
  /** Per-instance board API token. */
  boardToken: string;
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

  // Health route is deliberately unauthenticated so boot-time probes work
  // without a token. It reports adapter, upstream OpenCode reachability, and
  // non-secret board identity for MCP/TUI/CLI disambiguation.
  registerHealthRoutes(app, { client: deps.client, identity: deps.sourceInstance, boardTokenPresent: Boolean(deps.boardToken) });

  // All remaining API routes require the board token.
  const auth = requireBoardToken(deps.boardToken);
  app.use("/api/*", auth);

  registerBoardRoutes(app, { client: deps.client, store: deps.store });
  registerCardActionRoutes(app, { client: deps.client });
  registerBoardEventsRoutes(app, { bridge: deps.bridge });

  // Push (task) layer: the roster, task CRUD/run, and the task SSE stream.
  registerAgentRoutes(app, { baseUrl: deps.opencodeBaseUrl });
  registerProviderRoutes(app, { client: deps.client });
  registerAcpConfigRoutes(app, { cwd: deps.sourceInstance.workspace });
  registerCompletionRoutes(app, { store: deps.taskStore });
  registerTaskLinkRoutes(app, { store: deps.taskStore });
  registerTaskCommentRoutes(app, { store: deps.taskStore });
  registerTaskRoutes(app, {
    store: deps.taskStore,
    dispatcher: deps.dispatcher,
    agentRoster: { fetch: () => fetchRosterStrict(deps.opencodeBaseUrl) },
  });
  registerArchiveRoutes(app, {
    store: deps.taskStore,
    globalArchiveStore: deps.globalArchiveStore,
    sourceInstance: deps.sourceInstance,
  });
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
