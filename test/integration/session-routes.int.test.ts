/**
 * Phase 4 integration test — exercises the REAL server pipeline (config ->
 * startOrConnect in connect mode -> real :memory: SqliteColumnStore -> real
 * EventBridge -> real Hono app) against a REAL ephemeral `opencode serve`
 * process. No mocks. Self-skips if an ephemeral OpenCode server can't be
 * started in this environment (e.g. CI without the binary).
 *
 * Most tests avoid invoking any model/prompt (cost/latency). The Push smoke
 * test deliberately admits one minimal task prompt to verify task -> session
 * dispatch against the real OpenCode server.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { loadConfig } from "../../src/server/config";
import { startOrConnect, type OpencodeHandle } from "../../src/server/opencode";
import { SqliteColumnStore } from "../../src/db/board-store";
import { SqliteTaskStore } from "../../src/db/task-store";
import { GlobalArchiveStore } from "../../src/db/global-archive-store";
import { EventBridge } from "../../src/server/event-bridge";
import { TaskDispatcher } from "../../src/server/dispatcher";
import { createApp } from "../../src/server/app";
import type { Card, Task } from "../../src/shared";
import {
  opencodeAvailable,
  startEphemeralOpencodeServer,
  type EphemeralOpencodeServer,
} from "../helpers/ephemeral-opencode-server";

const available = await opencodeAvailable();
const BOARD_TOKEN = "test-token";
const AUTH_HEADERS = { authorization: `Bearer ${BOARD_TOKEN}` } as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 60_000,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await probe();
    if (value !== undefined) return value;
    await sleep(500);
  }
  throw new Error("waitFor timed out");
}

describe.skipIf(!available)("session routes (integration)", () => {
  let ephemeral: EphemeralOpencodeServer;
  let handle: OpencodeHandle;
  let store: SqliteColumnStore;
  let taskStore: SqliteTaskStore;
  let dispatcher: TaskDispatcher;
  let bridge: EventBridge;
  let app: Hono;
  let boardWorkspace: string;
  let previousBoardWorkspace: string | undefined;

  beforeAll(async () => {
    ephemeral = await startEphemeralOpencodeServer();
    previousBoardWorkspace = process.env.BOARD_WORKSPACE;
    boardWorkspace = mkdtempSync(join(tmpdir(), "openboard-session-workspace-"));
    process.env.BOARD_WORKSPACE = boardWorkspace;

    const config = loadConfig({
      ...process.env,
      OPENCODE_BASE_URL: ephemeral.url,
    });
    handle = await startOrConnect(config);

    store = new SqliteColumnStore(":memory:");
    bridge = new EventBridge({ client: handle.client, store });
    bridge.start();

    taskStore = new SqliteTaskStore(":memory:");
    dispatcher = new TaskDispatcher({ client: handle.client, store: taskStore, boardToken: BOARD_TOKEN });
    dispatcher.start();

    app = createApp({
      client: handle.client,
      store,
      bridge,
      taskStore,
      dispatcher,
      opencodeBaseUrl: handle.baseUrl,
      globalArchiveStore: new GlobalArchiveStore(":memory:"),
      sourceInstance: { port: 0, workspace: "/test", dbPath: ":memory:" },
      boardToken: BOARD_TOKEN,
    });
  });

  afterAll(async () => {
    bridge?.stop();
    dispatcher?.shutdown();
    await handle?.shutdown();
    store?.close();
    taskStore?.close();
    await ephemeral?.close();
    if (previousBoardWorkspace === undefined) delete process.env.BOARD_WORKSPACE;
    else process.env.BOARD_WORKSPACE = previousBoardWorkspace;
    if (boardWorkspace) rmSync(boardWorkspace, { recursive: true, force: true });
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
    const res = await app.request("/api/board", { headers: AUTH_HEADERS });
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

    const boardRes = await app.request("/api/board", { headers: AUTH_HEADERS });
    expect(boardRes.status).toBe(200);
    const cards = (await boardRes.json()) as Card[];

    const card = cards.find((c) => c.sessionId === sessionId);
    expect(card).toBeTruthy();
    expect(card?.column).toBe("todo");

    const moveRes = await app.request(`/api/board/cards/${encodeURIComponent(sessionId)}/move`, {
      method: "POST",
      headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ column: "review", position: 0 }),
    });
    expect(moveRes.status).toBe(200);

    const movedCards = (await moveRes.json()) as Card[];
    const movedCard = movedCards.find((c) => c.sessionId === sessionId);
    expect(movedCard).toBeTruthy();
    expect(movedCard?.column).toBe("review");
  });

  it(
    "runs a Push task in its requested directory and produces an assistant turn",
    async () => {
      const taskDir = mkdtempSync(join(boardWorkspace, "task-"));
      let sessionId: string | undefined;

      try {
        const createRes = await app.request("/api/tasks", {
          method: "POST",
          headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "push integration location smoke",
            description: "Reply OK only. Do not edit files.",
            directory: taskDir,
            agent: "build",
            model: { providerID: "opencode", id: "north-mini-code-free" },
          }),
        });
        expect(createRes.status).toBe(201);
        const created = (await createRes.json()) as Task;

        const runRes = await app.request(`/api/tasks/${created.id}/run`, { method: "POST", headers: AUTH_HEADERS });
        expect(runRes.status).toBe(202);
        const ran = (await runRes.json()) as Task;
        if (ran.runState === "error") {
          throw new Error(`Push prompt failed: ${ran.error ?? "unknown error"}`);
        }

        expect(ran.column).toBe("in_progress");
        expect(ran.runState).toBe("running");
        expect(ran.sessionId).toBeTruthy();
        sessionId = ran.sessionId;

        const sessionResult = await handle.client.session.get({ sessionID: sessionId! });
        expect(sessionResult.error).toBeFalsy();
        expect(realpathSync(sessionResult.data?.directory ?? "")).toBe(realpathSync(taskDir));

        const messages = await waitFor(async () => {
          const result = await handle.client.session.messages({ sessionID: sessionId! });
          if (result.error) throw new Error(`messages failed: ${JSON.stringify(result.error)}`);
          const assistant = result.data?.find((message) => message.info.role === "assistant");
          return assistant ? result.data : undefined;
        });
        expect(messages.some((message) => message.info.role === "user")).toBe(true);
        expect(messages.some((message) => message.info.role === "assistant")).toBe(true);

        await waitFor(() => {
          const task = taskStore.get(created.id);
          return task?.column === "review" && task.runState === "idle" ? task : undefined;
        });
      } finally {
        if (sessionId) {
          await handle.client.session.abort({ sessionID: sessionId }).catch(() => {});
        }
        rmSync(taskDir, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
