/**
 * Regression for the serve.ts composition bug: TaskDispatcher privately
 * defaulted its own SessionActivityCollector (`deps.activity ?? new
 * SessionActivityCollector()`) while createApp received no `activity` at
 * all, so registerSessionEventsRoutes always took the no-collector static
 * heartbeat path even for actively-running tasks. Route tests
 * (test/server/routes/session-events.test.ts) and dispatcher tests
 * (test/server/dispatcher.test.ts) both inject a collector directly and so
 * never exercise this.
 *
 * This file drives the *actual* production composition helper,
 * `composeServer` from src/server/serve.ts — the same function `main()`
 * calls to wire the dispatcher and the Hono app together. It is not a
 * hand-rolled double: if a future edit drops the `activity` argument from
 * either the `TaskDispatcher` or `createApp` call inside `composeServer`,
 * one of the two assertions below fails against the real production code
 * path.
 *
 * Two independent failure modes, two independent assertions:
 * - Drop `activity` from the `TaskDispatcher` construction: the dispatcher
 *   falls back to its own private collector, so the collector instance
 *   `composeServer` hands back (and gives to `createApp`) never observes
 *   the run. Caught directly by subscribing to that instance.
 * - Drop `activity` from the `createApp` call: `AppDeps.activity` is
 *   `undefined`, so `registerSessionEventsRoutes` takes the `!activity`
 *   branch (session-events.ts) and only ever emits a static heartbeat for
 *   a non-terminal task, regardless of what the dispatcher recorded. The
 *   OpenCode backfill path in the `activity`-present branch always emits
 *   *some* snapshot frame (it reconstructs from `client.session.children`
 *   independent of the collector), so this must be checked over the real
 *   HTTP route rather than by inspecting the collector alone.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Hono } from "hono";
import type { SessionActivityFrame } from "../../src/shared";
import { SqliteTaskStore } from "../../src/db/task-store";
import { GlobalArchiveStore } from "../../src/db/global-archive-store";
import { TaskDispatcher } from "../../src/server/dispatcher";
import { composeServer } from "../../src/server/serve";
import { cleanupTestWorkspace, setupTestWorkspace } from "./test-workspace";

const TEST_TOKEN = "test-token-64_______________________________________________";
const authHeaders = { Authorization: `Bearer ${TEST_TOKEN}` };

/** Minimal fake OpenCode client — just enough for dispatcher.run() to create+prompt a session. */
class FakeOpencodeClient {
  nextSessionId = "ses_wiring";
  session = {
    create: async () => ({
      data: { id: this.nextSessionId, agent: undefined, model: undefined },
      error: undefined,
    }),
    promptAsync: async () => ({ data: undefined, error: undefined }),
    abort: async () => ({ data: {}, error: undefined }),
    children: async () => ({ data: [], error: undefined }),
    status: async () => ({ data: {}, error: undefined }),
    messages: async () => ({ data: [], error: undefined }),
  };
  event = {
    subscribe: async () => ({ stream: (async function* () {})() }),
  };
  permission = {
    list: async () => ({ data: [], error: undefined }),
    reply: async () => ({ data: true, error: undefined }),
  };
}

function buildApp() {
  const client = new FakeOpencodeClient();
  const store = new SqliteTaskStore(":memory:");

  // Calls the real serve.ts composition helper — the same one main() uses —
  // instead of reimplementing the dispatcher/app wiring in the test.
  const { app, dispatcher, activity } = composeServer({
    client: client as never,
    taskStore: store,
    adapterBaseUrl: "http://127.0.0.1:0",
    boardToken: TEST_TOKEN,
    opencodeBaseUrl: "http://127.0.0.1:0",
    globalArchiveStore: new GlobalArchiveStore(":memory:"),
    sourceInstance: { port: 0, workspace: "/test", dbPath: ":memory:" },
    opencodeMode: "connect",
  });

  return { app, store, dispatcher, activity };
}

async function readSSE(app: Hono, taskId: string, timeoutMs = 1500): Promise<string> {
  const res = await app.request(`/api/tasks/${taskId}/session-events`, { headers: authHeaders });
  expect(res.status).toBe(200);
  const body = res.body as ReadableStream<Uint8Array> | null;
  if (!body) return await res.text().catch(() => "");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  const start = Date.now();
  try {
    while (Date.now() - start < timeoutMs) {
      const chunk = await reader.read();
      if (chunk.done) break;
      result += decoder.decode(chunk.value, { stream: true });
      if (result.includes("\n\n")) break;
    }
  } catch {
    // reader may error on abort/close
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  return result;
}

describe("serve.ts composeServer SessionActivityCollector wiring", () => {
  let dispatcher: TaskDispatcher | undefined;
  let repoDir: string;

  beforeEach(() => {
    const ws = setupTestWorkspace();
    repoDir = ws.repoDir;
  });

  afterEach(() => {
    dispatcher?.shutdown();
    cleanupTestWorkspace();
  });

  it("dispatcher writes runs onto the same collector instance handed to the app", async () => {
    const built = buildApp();
    dispatcher = built.dispatcher;
    const task = built.store.create({ title: "t", description: "d", directory: repoDir })!;

    await built.dispatcher.run(task.id);

    // Subscribe directly on the collector composeServer returned (the same
    // instance given to createApp). subscribe() always fires a "snapshot"
    // frame (plus a follow-up heartbeat) for an active run, but only a bare
    // static "heartbeat" if the dispatcher wrote to a different,
    // privately-defaulted collector instead of this one.
    const frames: SessionActivityFrame[] = [];
    const unsubscribe = built.activity.subscribe(task.id, 0, (frame) => {
      frames.push(frame);
    });
    unsubscribe();

    expect(frames.find((frame) => frame.kind === "snapshot")).toMatchObject({
      kind: "snapshot",
      run: expect.objectContaining({ taskId: task.id, sessionId: "ses_wiring" }),
    });
  });

  it("a running task yields a live snapshot over SSE, not a static heartbeat", async () => {
    const built = buildApp();
    dispatcher = built.dispatcher;
    const task = built.store.create({ title: "t", description: "d", directory: repoDir })!;

    await built.dispatcher.run(task.id);

    const raw = await readSSE(built.app, task.id);
    expect(raw).toContain("event: snapshot");
    expect(raw).not.toContain('"transport":"static"');
  });
});
