/**
 * Regression for the serve.ts composition bug: TaskDispatcher privately
 * defaulted its own SessionActivityCollector (`deps.activity ?? new
 * SessionActivityCollector()`) while createApp received no `activity` at
 * all, so registerSessionEventsRoutes always took the no-collector static
 * heartbeat path even for actively-running tasks. Route tests
 * (test/server/routes/session-events.test.ts) and dispatcher tests
 * (test/server/dispatcher.test.ts) both inject a collector directly and so
 * never exercise this — they pass even when serve.ts wires two separate
 * instances. This file drives a real TaskDispatcher + createApp pair, wired
 * exactly like serve.ts does, over HTTP.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { SqliteTaskStore } from "../../src/db/task-store";
import { GlobalArchiveStore } from "../../src/db/global-archive-store";
import { TaskDispatcher } from "../../src/server/dispatcher";
import { SessionActivityCollector } from "../../src/server/session-activity";
import { createApp } from "../../src/server/app";
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

function buildApp(opts: { sharedActivity: boolean }) {
  const client = new FakeOpencodeClient();
  const store = new SqliteTaskStore(":memory:");
  const activity = new SessionActivityCollector();

  // Mirrors serve.ts's composition order: dispatcher constructed first, app second.
  const dispatcher = new TaskDispatcher({
    client: client as never,
    store,
    ...(opts.sharedActivity ? { activity } : {}),
  });

  const app = createApp({
    client: client as never,
    taskStore: store,
    dispatcher,
    opencodeBaseUrl: "http://127.0.0.1:0",
    globalArchiveStore: new GlobalArchiveStore(":memory:"),
    sourceInstance: { port: 0, workspace: "/test", dbPath: ":memory:" },
    boardToken: TEST_TOKEN,
    opencodeMode: "connect",
    ...(opts.sharedActivity ? { activity } : {}),
  });

  return { app, store, dispatcher };
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

describe("serve.ts SessionActivityCollector composition wiring", () => {
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

  it("shared collector: a running task yields a live snapshot, not a static heartbeat", async () => {
    const built = buildApp({ sharedActivity: true });
    dispatcher = built.dispatcher;
    const task = built.store.create({ title: "t", description: "d", directory: repoDir })!;

    await built.dispatcher.run(task.id);

    const raw = await readSSE(built.app, task.id);
    expect(raw).toContain("event: snapshot");
    expect(raw).not.toContain('"transport":"static"');
  });

  it("regression: separately-constructed collectors starve the route to static heartbeat despite an active run", async () => {
    const built = buildApp({ sharedActivity: false });
    dispatcher = built.dispatcher;
    const task = built.store.create({ title: "t", description: "d", directory: repoDir })!;

    // The dispatcher's own private SessionActivityCollector does record this
    // run — but createApp never received it, so the route can't see it.
    await built.dispatcher.run(task.id);

    const raw = await readSSE(built.app, task.id);
    expect(raw).toContain("event: heartbeat");
    expect(raw).toContain('"transport":"static"');
    expect(raw).not.toContain("event: snapshot");
  });
});
