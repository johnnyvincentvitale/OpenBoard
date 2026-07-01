import { describe, it, expect } from "vitest";
import { SqliteColumnStore } from "../../src/db/board-store";
import { EventBridge } from "../../src/server/event-bridge";
import { createApp, type AppDeps } from "../../src/server/app";
import type { Card } from "../../src/shared/index";

/** Minimal Session fixture satisfying the SDK Session required fields. */
function session(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    slug: id,
    projectID: "global",
    directory: "/tmp/proj",
    title: `title ${id}`,
    version: "1.17.12",
    time: { created: 1, updated: 2 },
    summary: { additions: 1, deletions: 2, files: 3 },
    cost: 0,
    ...over,
  };
}

/** Fake OpencodeClient — only the methods the routes touch. */
function fakeClient(sessions: ReturnType<typeof session>[], calls: string[] = []) {
  return {
    global: { health: async () => ({ data: { healthy: true, version: "1.17.12" }, error: undefined }) },
    session: {
      list: async () => ({ data: sessions, error: undefined }),
      status: async () => ({ data: {}, error: undefined }),
      get: async ({ sessionID }: { sessionID: string }) => {
        const s = sessions.find((x) => x.id === sessionID);
        return s ? { data: s, error: undefined } : { data: undefined, error: { name: "NotFoundError" } };
      },
      promptAsync: async (p: { sessionID: string }) => {
        calls.push(`prompt:${p.sessionID}`);
        return { data: { ok: true }, error: undefined };
      },
      abort: async (p: { sessionID: string }) => {
        calls.push(`abort:${p.sessionID}`);
        return { data: true, error: undefined };
      },
      diff: async () => ({ data: [], error: undefined }),
    },
    event: { subscribe: async () => ({ stream: (async function* () {})() }) },
  };
}

function makeApp(sessions: ReturnType<typeof session>[], calls: string[] = []) {
  const client = fakeClient(sessions, calls) as unknown as AppDeps["client"];
  const store = new SqliteColumnStore(":memory:");
  const bridge = new EventBridge({ client, store }); // not started — REST only
  return { app: createApp({ client, store, bridge }), store, calls };
}

describe("app integration (faked deps)", () => {
  it("GET /api/health reports adapter + opencode ok", async () => {
    const { app } = makeApp([session("ses_1")]);
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.adapter).toBe("ok");
    expect(body.opencode.status).toBe("ok");
  });

  it("GET /api/board returns cards placed in columns", async () => {
    const { app } = makeApp([session("ses_1"), session("ses_2")]);
    const res = await app.request("/api/board");
    expect(res.status).toBe(200);
    const cards = (await res.json()) as Card[];
    expect(cards.map((c) => c.sessionId).sort()).toEqual(["ses_1", "ses_2"]);
    expect(cards.every((c) => c.column === "todo")).toBe(true);
    expect(cards.every((c) => typeof c.position === "number")).toBe(true);
  });

  it("POST move relocates a card and returns the fresh board", async () => {
    const { app } = makeApp([session("ses_1")]);
    // seed the row first
    await app.request("/api/board");
    const res = await app.request("/api/board/cards/ses_1/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ column: "review", position: 0 }),
    });
    expect(res.status).toBe(200);
    const cards = (await res.json()) as Card[];
    expect(cards.find((c) => c.sessionId === "ses_1")?.column).toBe("review");
  });

  it("POST move rejects an invalid column with 400", async () => {
    const { app } = makeApp([session("ses_1")]);
    await app.request("/api/board");
    const res = await app.request("/api/board/cards/ses_1/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ column: "nope", position: 0 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation");
  });

  it("POST prompt and interrupt call the client with the session id", async () => {
    const calls: string[] = [];
    const { app } = makeApp([session("ses_1")], calls);
    const p = await app.request("/api/board/cards/ses_1/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(p.status).toBe(202);
    const i = await app.request("/api/board/cards/ses_1/interrupt", { method: "POST" });
    expect(i.status).toBe(200);
    expect(calls).toContain("prompt:ses_1");
    expect(calls).toContain("abort:ses_1");
  });
});
