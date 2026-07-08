import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { registerHealthRoutes } from "../../../src/server/routes/health";

/**
 * A hermetic, duck-typed fake of the OpenCode SDK client. Only implements
 * global.health — the surface the health route actually calls.
 */
function makeFakeClient(opts: {
  data?: { healthy: boolean; version: string };
  error?: unknown;
  throws?: unknown;
}) {
  return {
    global: {
      health: async () => {
        if (opts.throws !== undefined) {
          throw opts.throws;
        }
        if (opts.error !== undefined) {
          return { data: undefined, error: opts.error };
        }
        return { data: opts.data, error: undefined };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function buildApp(client: ReturnType<typeof makeFakeClient>) {
  const app = new Hono();
  registerHealthRoutes(app, {
    client,
    identity: { name: "alpha", port: 4098, workspace: "/repo", dbPath: "/db/tasks.sqlite", opencodeBaseUrl: "http://127.0.0.1:4096" },
    boardTokenPresent: true,
    build: { version: "test-version", commit: "test-commit" },
  });
  return app;
}

describe("GET /api/health", () => {
  it("responds 200 with adapter 'ok' and opencode 'ok' + version when health() succeeds", async () => {
    const client = makeFakeClient({ data: { healthy: true, version: "1.x" } });
    const app = buildApp(client);

    const res = await app.request("/api/health");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      adapter: "ok",
      opencode: { status: "ok", version: "1.x" },
      build: { version: "test-version", commit: "test-commit" },
      identity: {
        instanceName: "alpha",
        boardUrl: "http://127.0.0.1:4098",
        port: 4098,
        workspace: "/repo",
        dbPath: "/db/tasks.sqlite",
        opencodeUrl: "http://127.0.0.1:4096",
        opencodePort: 4096,
        boardTokenPresent: true,
      },
    });
  });

  it("responds 200 with opencode 'unreachable' when health() returns an {error} envelope", async () => {
    const client = makeFakeClient({ error: { message: "connection refused" } });
    const app = buildApp(client);

    const res = await app.request("/api/health");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      adapter: "ok",
      opencode: { status: "unreachable" },
      identity: {
        instanceName: "alpha",
        boardUrl: "http://127.0.0.1:4098",
        port: 4098,
        workspace: "/repo",
        dbPath: "/db/tasks.sqlite",
        boardTokenPresent: true,
      },
    });
  });

  it("responds 200 with opencode 'unreachable' when health() throws", async () => {
    const client = makeFakeClient({ throws: new Error("network down") });
    const app = buildApp(client);

    const res = await app.request("/api/health");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      adapter: "ok",
      opencode: { status: "unreachable" },
      identity: {
        instanceName: "alpha",
        boardUrl: "http://127.0.0.1:4098",
        port: 4098,
        workspace: "/repo",
        dbPath: "/db/tasks.sqlite",
        boardTokenPresent: true,
      },
    });
  });

  it("responds 200 with opencode 'unreachable' when health() returns data with healthy:false", async () => {
    const client = makeFakeClient({ data: { healthy: false, version: "1.x" } });
    const app = buildApp(client);

    const res = await app.request("/api/health");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      adapter: "ok",
      opencode: { status: "unreachable" },
      identity: {
        instanceName: "alpha",
        boardUrl: "http://127.0.0.1:4098",
        port: 4098,
        workspace: "/repo",
        dbPath: "/db/tasks.sqlite",
        boardTokenPresent: true,
      },
    });
  });
});
