import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { Session, SessionStatus } from "@opencode-ai/sdk/v2/types";
import { SqliteColumnStore } from "../../../src/db/board-store";
import { registerBoardRoutes } from "../../../src/server/routes/board";
import type { OpencodeClientLike } from "../../../src/server/board-service";

// --- Fixtures --------------------------------------------------------------

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "ses_1",
    slug: "ses-1",
    projectID: "proj_1",
    directory: "/repo",
    title: "A session",
    version: "1.17.13",
    time: { created: 1_700_000_000_000, updated: 1_700_000_100_000 },
    ...overrides,
  };
}

const IDLE_STATUS: SessionStatus = { type: "idle" };

/**
 * A hermetic, duck-typed fake of the OpenCode SDK client. Only implements
 * session.list / session.status — the surface board routes actually call.
 */
function makeFakeClient(opts: {
  sessions?: Session[];
  statusMap?: Record<string, SessionStatus>;
  listError?: unknown;
}): OpencodeClientLike {
  const sessions = opts.sessions ?? [];
  const statusMap = opts.statusMap ?? {};

  return {
    session: {
      list: async () => {
        if (opts.listError) {
          return { data: undefined, error: opts.listError };
        }
        return { data: sessions, error: undefined };
      },
      status: async () => {
        return { data: statusMap, error: undefined };
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as OpencodeClientLike;
}

function buildApp(client: OpencodeClientLike, store: SqliteColumnStore): Hono {
  const app = new Hono();
  registerBoardRoutes(app, { client, store });
  return app;
}

// --- GET /api/board ----------------------------------------------------------

describe("GET /api/board", () => {
  let store: SqliteColumnStore;

  beforeEach(() => {
    store = new SqliteColumnStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("returns a JSON array of Cards for every live session", async () => {
    const sessions = [
      makeSession({ id: "ses_a", title: "A" }),
      makeSession({ id: "ses_b", title: "B" }),
    ];
    const client = makeFakeClient({
      sessions,
      statusMap: { ses_a: IDLE_STATUS, ses_b: IDLE_STATUS },
    });
    const app = buildApp(client, store);

    const res = await app.request("/api/board");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    expect(body.map((c: { sessionId: string }) => c.sessionId).sort()).toEqual([
      "ses_a",
      "ses_b",
    ]);
  });

  it("returns the AdapterError envelope + status when OpenCode is unreachable", async () => {
    const client = makeFakeClient({ listError: { message: "connection refused" } });
    const app = buildApp(client, store);

    const res = await app.request("/api/board");

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("opencode_unreachable");
  });
});

// --- POST /api/board/cards/:id/move -------------------------------------------

describe("POST /api/board/cards/:id/move", () => {
  let store: SqliteColumnStore;

  beforeEach(() => {
    store = new SqliteColumnStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("moves the card and responds 200 with the fresh board snapshot", async () => {
    const sessions = [
      makeSession({ id: "ses_a", title: "A" }),
      makeSession({ id: "ses_b", title: "B" }),
    ];
    const client = makeFakeClient({
      sessions,
      statusMap: { ses_a: IDLE_STATUS, ses_b: IDLE_STATUS },
    });
    const app = buildApp(client, store);

    // Prime the store so both sessions have rows.
    await app.request("/api/board");

    const res = await app.request("/api/board/cards/ses_a/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ column: "in_progress", position: 0 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    const moved = body.find((c: { sessionId: string }) => c.sessionId === "ses_a");
    expect(moved.column).toBe("in_progress");
    expect(moved.position).toBe(0);

    // Verify persisted in the store directly too.
    expect(store.getRow("ses_a")?.column).toBe("in_progress");
  });

  it("responds 400 validation when column is invalid", async () => {
    const sessions = [makeSession({ id: "ses_a" })];
    const client = makeFakeClient({ sessions, statusMap: { ses_a: IDLE_STATUS } });
    const app = buildApp(client, store);
    await app.request("/api/board");

    const res = await app.request("/api/board/cards/ses_a/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ column: "not_a_real_column", position: 0 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation");
  });

  it("responds 400 validation when position is not a finite number", async () => {
    const sessions = [makeSession({ id: "ses_a" })];
    const client = makeFakeClient({ sessions, statusMap: { ses_a: IDLE_STATUS } });
    const app = buildApp(client, store);
    await app.request("/api/board");

    const res = await app.request("/api/board/cards/ses_a/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ column: "todo", position: Number.POSITIVE_INFINITY }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation");
  });

  it("responds 400 validation when position is missing/non-numeric", async () => {
    const sessions = [makeSession({ id: "ses_a" })];
    const client = makeFakeClient({ sessions, statusMap: { ses_a: IDLE_STATUS } });
    const app = buildApp(client, store);
    await app.request("/api/board");

    const res = await app.request("/api/board/cards/ses_a/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ column: "todo", position: "zero" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation");
  });
});
