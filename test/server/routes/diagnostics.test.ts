import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { registerDiagnosticsRoutes } from "../../../src/server/routes/diagnostics";
import { SqliteTaskStore } from "../../../src/db/task-store";
import { requireBoardToken } from "../../../src/server/auth";

const TEST_TOKEN = "test-token-abc";
const OPENCODE_BASE_URL = "http://127.0.0.1:4096";

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_TOKEN}` };
}

function makeFakeClient(opts: {
  data?: { healthy: boolean; version: string };
  error?: unknown;
  throws?: unknown;
}) {
  return {
    global: {
      health: async () => {
        if (opts.throws !== undefined) throw opts.throws;
        if (opts.error !== undefined) return { data: undefined, error: opts.error };
        return { data: opts.data, error: undefined };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function buildApp(
  client: ReturnType<typeof makeFakeClient>,
  boardToken = TEST_TOKEN,
) {
  const store = new SqliteTaskStore(":memory:");
  const app = new Hono();
  app.use("*", cors({ origin: "*" }));
  const auth = requireBoardToken(boardToken);
  app.use("/api/*", auth);
  registerDiagnosticsRoutes(app, {
    client,
    store,
    opencodeBaseUrl: OPENCODE_BASE_URL,
    mode: "spawn",
    identity: { name: "alpha", port: 4098, workspace: "/repo", dbPath: "/db/tasks.sqlite", opencodeBaseUrl: OPENCODE_BASE_URL },
    boardTokenPresent: true,
    build: { version: "test-version", commit: "test-commit" },
  });
  return { app, store };
}

describe("GET /api/diagnostics (behind board token)", () => {
  it("returns 401 without auth header", async () => {
    const client = makeFakeClient({ data: { healthy: true, version: "1.x" } });
    const { app } = buildApp(client);
    const res = await app.request("/api/diagnostics");
    expect(res.status).toBe(401);
  });

  it("returns 401 with wrong token", async () => {
    const client = makeFakeClient({ data: { healthy: true, version: "1.x" } });
    const { app } = buildApp(client);
    const res = await app.request("/api/diagnostics", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 with correct token", async () => {
    const client = makeFakeClient({ data: { healthy: true, version: "1.x" } });
    const { app } = buildApp(client);
    const res = await app.request("/api/diagnostics", { headers: authHeaders() });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("opencode");
  });

  it("reports OpenCode URL from dependency", async () => {
    const client = makeFakeClient({ data: { healthy: true, version: "1.x" } });
    const { app } = buildApp(client);
    const res = await app.request("/api/diagnostics", { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.opencode.url).toBe(OPENCODE_BASE_URL);
    expect(body.opencode.reachable).toBe(true);
    expect(body.opencode.version).toBe("1.x");
  });

  it("reports OpenCode URL even when unreachable", async () => {
    const client = makeFakeClient({ throws: new Error("down") });
    const { app } = buildApp(client);
    const res = await app.request("/api/diagnostics", { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.opencode.url).toBe(OPENCODE_BASE_URL);
    expect(body.opencode.reachable).toBe(false);
  });

  it("reports worktree sweep results", async () => {
    const client = makeFakeClient({ data: { healthy: true, version: "1.x" } });
    const { app, store } = buildApp(client);

    store.setSweepResult({
      sweptAt: 1000,
      removedCleanCount: 3,
      keptDirtyCount: 1,
      dirtyOrphans: [{ worktreePath: "/repo/.wt/task_abc", taskId: "task_abc", dirtyFileCount: 2 }],
    });

    const res = await app.request("/api/diagnostics", { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.worktree).toMatchObject({
      lastSweep: 1000,
      removedCleanCount: 3,
      keptDirtyCount: 1,
      dirtyOrphans: [{ worktreePath: "/repo/.wt/task_abc", taskId: "task_abc", dirtyFileCount: 2 }],
    });
  });

  it("does not expose the API token value", async () => {
    const client = makeFakeClient({ data: { healthy: true, version: "1.x" } });
    const { app } = buildApp(client);
    const res = await app.request("/api/diagnostics", { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.instance.apiTokenPresent).toBe(true);
    expect(JSON.stringify(body)).not.toContain(TEST_TOKEN);
  });
});
