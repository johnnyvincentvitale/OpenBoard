/**
 * Phase 4 integration test — exercises the REAL server pipeline (config ->
 * startOrConnect in connect mode -> real :memory: SqliteColumnStore -> real
 * EventBridge -> real Hono app) against a REAL ephemeral `opencode serve`
 * process. No mocks. Self-skips if an ephemeral OpenCode server can't be
 * started in this environment (e.g. CI without the binary).
 *
 * Deliberately avoids invoking any model/prompt (cost/latency) — only
 * session lifecycle + board reads/moves.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { loadConfig } from "../../src/server/config";
import { startOrConnect, type OpencodeHandle } from "../../src/server/opencode";
import { SqliteColumnStore } from "../../src/db/board-store";
import { SqliteTaskStore } from "../../src/db/task-store";
import { EventBridge } from "../../src/server/event-bridge";
import { TaskDispatcher } from "../../src/server/dispatcher";
import { createApp } from "../../src/server/app";
import type { Card } from "../../src/shared";
import {
  opencodeAvailable,
  startEphemeralOpencodeServer,
  type EphemeralOpencodeServer,
} from "../helpers/ephemeral-opencode-server";

const available = await opencodeAvailable();

describe.skipIf(!available)("session routes (integration)", () => {
  let ephemeral: EphemeralOpencodeServer;
  let handle: OpencodeHandle;
  let store: SqliteColumnStore;
  let bridge: EventBridge;
  let app: Hono;

  beforeAll(async () => {
    ephemeral = await startEphemeralOpencodeServer();

    const config = loadConfig({
      ...process.env,
      OPENCODE_BASE_URL: ephemeral.url,
    });
    handle = await startOrConnect(config);

    store = new SqliteColumnStore(":memory:");
    bridge = new EventBridge({ client: handle.client, store });
    bridge.start();

    const taskStore = new SqliteTaskStore(":memory:");
    const dispatcher = new TaskDispatcher({ client: handle.client, store: taskStore });

    app = createApp({
      client: handle.client,
      store,
      bridge,
      taskStore,
      dispatcher,
      opencodeBaseUrl: handle.baseUrl,
    });
  });

  afterAll(async () => {
    bridge?.stop();
    await handle?.shutdown();
    store?.close();
    await ephemeral?.close();
  });

  it("GET /api/health reports opencode status ok with a version", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.adapter).toBe("ok");
    expect(body.opencode.status).toBe("ok");
    expect(typeof body.opencode.version).toBe("string");
    expect(body.opencode.version.length).toBeGreaterThan(0);
  });

  it("GET /api/board returns an array of Cards", async () => {
    const res = await app.request("/api/board");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("creates a real session and shows it as a Card in 'todo', then moves it to 'review'", async () => {
    const createResult = await handle.client.session.create({
      title: "integration-test-session",
    });
    expect(createResult.error).toBeFalsy();
    expect(createResult.data).toBeTruthy();

    const sessionId = createResult.data!.id;
    expect(typeof sessionId).toBe("string");

    const boardRes = await app.request("/api/board");
    expect(boardRes.status).toBe(200);
    const cards = (await boardRes.json()) as Card[];

    const card = cards.find((c) => c.sessionId === sessionId);
    expect(card).toBeTruthy();
    expect(card?.column).toBe("todo");

    const moveRes = await app.request(`/api/board/cards/${encodeURIComponent(sessionId)}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ column: "review", position: 0 }),
    });
    expect(moveRes.status).toBe(200);

    const movedCards = (await moveRes.json()) as Card[];
    const movedCard = movedCards.find((c) => c.sessionId === sessionId);
    expect(movedCard).toBeTruthy();
    expect(movedCard?.column).toBe("review");
  });
});
