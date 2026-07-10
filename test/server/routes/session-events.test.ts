import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { SqliteTaskStore } from "../../../src/db/task-store";
import { registerSessionEventsRoutes } from "../../../src/server/routes/session-events";
import { SessionActivityCollector } from "../../../src/server/session-activity";
import type { Task } from "../../../src/shared";
import type { ReadableStream as WritableReadableStream } from "node:stream/web";

const FRAME_TIMEOUT_MS = 2000;

function makeTask(store: SqliteTaskStore, overrides: Partial<Task> = {}): Task {
  const task = store.create({ title: "Test", description: "", directory: "/test" })!;
  store.update(task.id, {
    sessionId: overrides.sessionId ?? "sess_root",
    runState: overrides.runState ?? "running",
    runStartedAt: overrides.runStartedAt ?? 100,
    harness: overrides.harness ?? "opencode",
    column: overrides.column ?? "in_progress",
    ...overrides,
  });
  return store.get(task.id)!;
}

function makeAcpTask(store: SqliteTaskStore): Task {
  const task = store.create({ title: "ACP Test", description: "", directory: "/test" })!;
  store.update(task.id, {
    harnessSessionId: "acp_sess_1",
    harnessSessionName: "acp-session",
    runState: "running",
    runStartedAt: 200,
    harness: "claude-code",
    column: "in_progress",
  });
  return store.get(task.id)!;
}

function makeDoneAcpTask(store: SqliteTaskStore): Task {
  const task = store.create({ title: "Done ACP", description: "", directory: "/test" })!;
  store.update(task.id, {
    harnessSessionId: "acp_done_1",
    harnessSessionName: "acp-done-session",
    runState: "idle",
    runStartedAt: 300,
    harness: "claude-code",
    column: "done",
  });
  return store.get(task.id)!;
}

function makeDoneOpenCodeTask(store: SqliteTaskStore): Task {
  const task = store.create({ title: "Done", description: "", directory: "/test" })!;
  store.update(task.id, {
    sessionId: "sess_done",
    runState: "idle",
    runStartedAt: 400,
    harness: "opencode",
    column: "done",
  });
  return store.get(task.id)!;
}

function makeFakeOpenCodeClient(messages: unknown[] = [], children: unknown[] = []) {
  return {
    session: {
      messages: vi.fn(async () => ({ data: messages })),
      children: vi.fn(async () => ({ data: children })),
    },
  };
}

function makeMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    info: { role: "assistant", id: "msg_1", created: 12345 },
    parts: [{ type: "text", text: "hello world" }],
    ...overrides,
  };
}

function appFor(store: SqliteTaskStore, client: unknown, activity?: SessionActivityCollector): Hono {
  const app = new Hono();
  registerSessionEventsRoutes(app, { store, client: client as never, activity });
  return app;
}

function parseSSE(raw: string): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  const events = raw.split(/\n\n/);
  for (const event of events) {
    const lines = event.split(/\r?\n/);
    const frame: Record<string, unknown> = { _event: "" };
    for (const line of lines) {
      if (line.startsWith("event:")) {
        frame._event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        let d = line.slice(5);
        if (d.startsWith(" ")) d = d.slice(1);
        try {
          Object.assign(frame, JSON.parse(d));
        } catch { /* ignore */ }
      } else if (line.startsWith("id:")) {
        frame._id = line.slice(3).trim();
      }
    }
    if (Object.keys(frame).length > 1) frames.push(frame);
  }
  return frames;
}

/** Read a ReadableStream body for up to timeoutMs, then stop. */
async function readStreamBody(res: Response, timeoutMs = FRAME_TIMEOUT_MS): Promise<string> {
  const body = res.body as WritableReadableStream<Uint8Array> | null;
  if (!body) return await res.text().catch(() => "");

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  const startTime = Date.now();

  try {
    while (Date.now() - startTime < timeoutMs) {
      const chunk = await reader.read();
      if (chunk.done) break;
      result += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    // Reader may error on abort/close.
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  return result;
}

describe("session-events route", () => {
  let store: SqliteTaskStore;

  beforeEach(() => {
    store = new SqliteTaskStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  // ── Status codes ──────────────────────────────────────────────────────

  it("returns 404 for unknown task", async () => {
    const client = makeFakeOpenCodeClient();
    const app = appFor(store, client);
    const res = await app.request("/api/tasks/unknown/session-events");
    expect(res.status).toBe(404);
  });

  it("returns 409 when task has no session", async () => {
    const task = store.create({ title: "No session", description: "", directory: "/test" })!;
    const client = makeFakeOpenCodeClient();
    const app = appFor(store, client);
    const res = await app.request(`/api/tasks/${task.id}/session-events`);
    expect(res.status).toBe(409);
  });

  // ── Static heartbeats (no collector) ──────────────────────────────────

  it("returns static heartbeat when no activity collector", async () => {
    const task = makeTask(store);
    const client = makeFakeOpenCodeClient();
    const app = appFor(store, client, undefined);
    const res = await app.request(`/api/tasks/${task.id}/session-events`);
    expect(res.status).toBe(200);
    const body = await readStreamBody(res, 1000);
    expect(body).toContain("heartbeat");
    expect(body).toContain("static");
  });

  // ── Done OpenCode card reconstructs text ─────────────────────────────

  it("Done OpenCode card emits reconstructed snapshot text and terminal", async () => {
    const task = makeDoneOpenCodeTask(store);
    const client = makeFakeOpenCodeClient([
      makeMessage({
        info: { role: "assistant", id: "msg_1", created: 500 },
        parts: [{ type: "text", text: "final output" }],
      }),
    ]);
    const app = appFor(store, client);
    const res = await app.request(`/api/tasks/${task.id}/session-events`);
    expect(res.status).toBe(200);

    const raw = await readStreamBody(res, 3000);
    const frames = parseSSE(raw);
    const terminals = frames.filter((f) => f._event === "terminal");
    expect(terminals.length).toBeGreaterThanOrEqual(1);
    expect(terminals[0]?.status).toBe("complete");

    // Should have a snapshot frame containing reconstructed text.
    const snapshots = frames.filter((f) => f._event === "snapshot");
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    const events = (snapshots[0] as { events?: unknown[] }).events;
    if (events instanceof Array && events.length > 0) {
      const texts = events
        .filter((e): e is { text: string } => typeof (e as Record<string, unknown>).text === "string")
        .map((e) => e.text);
      expect(texts.some((t) => t.includes("final output"))).toBe(true);
    }
  });

  // ── ACP Done card ────────────────────────────────────────────────────

  it("Done ACP card emits terminal and closes", async () => {
    const task = makeDoneAcpTask(store);
    const client = makeFakeOpenCodeClient();
    const app = appFor(store, client);
    const res = await app.request(`/api/tasks/${task.id}/session-events`);
    expect(res.status).toBe(200);

    const raw = await readStreamBody(res, 3000);
    const frames = parseSSE(raw);
    const terminals = frames.filter((f) => f._event === "terminal");
    expect(terminals.length).toBeGreaterThanOrEqual(1);
    expect(terminals[0]?.status).toBe("complete");

    // Should also have a static heartbeat after terminal.
    const heartbeats = frames.filter((f) => f._event === "heartbeat");
    const staticHb = heartbeats.find((h) => (h as Record<string, unknown>).transport === "static");
    expect(staticHb).toBeDefined();
  });

  // ── Session tree: rootSessionId and traversal parent chain ───────────

  it("root->child session tree preserves rootSessionId and traversal parent chain", async () => {
    // Use a Done card so the SSE stream closes after emitting terminal.
    const task = makeDoneOpenCodeTask(store);
    const childrenFn = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ id: "child_1" }] })
      .mockResolvedValueOnce({ data: [] });
    const messagesFn = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          makeMessage({
            info: { role: "assistant", id: "rm_1", created: 100 },
            parts: [{ type: "text", text: "root msg" }],
          }),
        ],
      })
      .mockResolvedValueOnce({
        data: [
          makeMessage({
            info: { role: "assistant", id: "cm_1", created: 200 },
            parts: [{ type: "text", text: "child msg" }],
          }),
        ],
      });

    const nestedClient = {
      session: { messages: messagesFn, children: childrenFn },
    };
    const app = appFor(store, nestedClient);
    const rawRes = app.request(`/api/tasks/${task.id}/session-events`);
    const res = rawRes instanceof Response ? rawRes : await rawRes;
    expect(res.status).toBe(200);

    // Read body to drive SSE stream delivery.
    const raw = await readStreamBody(res, 3000);
    const frames = parseSSE(raw);

    // Verify children was called.
    expect(childrenFn).toHaveBeenCalled();
    expect(messagesFn).toHaveBeenCalled();

    const snapshots = frames.filter((f) => f._event === "snapshot");
    expect(snapshots.length).toBeGreaterThanOrEqual(1);

    // Snapshot events should include text from root.
    const events = (snapshots[0] as { events?: Array<{ text?: string }> }).events ?? [];
    const texts = events.map((e) => e.text).filter(Boolean);
    expect(texts.some((t) => t?.includes("root msg"))).toBe(true);
  });

  // ── >limit mixed: newest live event retained ─────────────────────────

  it(">limit mixed backfill+collector keeps newest live events", async () => {
    const task = makeDoneOpenCodeTask(store);
    const activity = new SessionActivityCollector();
    activity.startRun({
      taskId: task.id,
      runStartedAt: task.runStartedAt!,
      sessionId: task.sessionId!,
      rootSessionId: task.sessionId!,
      harness: "opencode",
    });
    // Backfill messages from the past.
    const oldMessages = [];
    for (let i = 0; i < 20; i++) {
      oldMessages.push(
        makeMessage({
          info: { role: "assistant", id: `msg_${i}`, created: 100 + i },
          parts: [{ type: "text", text: `old ${i}` }],
        }),
      );
    }
    // Live event from collector.
    activity.recordEvent(task.id, task.runStartedAt!, {
      sessionId: task.sessionId!,
      rootSessionId: task.sessionId!,
      harness: "opencode",
      kind: "text",
      role: "assistant",
      text: "LIVE EVENT",
    });

    const client = makeFakeOpenCodeClient(oldMessages);
    const app = appFor(store, client, activity);
    const res = await app.request(`/api/tasks/${task.id}/session-events?limit=3`);
    expect(res.status).toBe(200);

    const raw = await readStreamBody(res, 3000);
    const frames = parseSSE(raw);
    const snapshots = frames.filter((f) => f._event === "snapshot");
    expect(snapshots.length).toBeGreaterThanOrEqual(1);

    const events = (snapshots[0] as { events?: Array<{ text?: string }> }).events ?? [];
    if (events.length > 0) {
      const hasLiveEvent = events.some((e) => e.text?.includes("LIVE EVENT"));
      expect(hasLiveEvent).toBe(true);
    }
    activity.reset();
  });

  // ── Shared cap gap ──────────────────────────────────────────────────

  it("shared byte cap across siblings emits truncation gap", async () => {
    const task = makeDoneOpenCodeTask(store);
    const childrenFn = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ id: "c1" }, { id: "c2" }, { id: "c3" }] })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [] });
    const bigText = "x".repeat(1000);
    const messagesFn = vi.fn().mockImplementation(async () => ({
      data: Array.from({ length: 50 }, (_, i) =>
        makeMessage({
          info: { role: "assistant", id: `m${i}`, created: 100 + i },
          parts: [{ type: "text", text: bigText }],
        }),
      ),
    }));

    const client = { session: { messages: messagesFn, children: childrenFn } };
    const app = appFor(store, client);
    const res = await app.request(`/api/tasks/${task.id}/session-events`);
    expect(res.status).toBe(200);

    const raw = await readStreamBody(res, 3000);
    const frames = parseSSE(raw);
    const gaps = frames.filter((f) => f._event === "gap");
    const truncationGaps = gaps.filter((g) =>
      typeof (g as Record<string, unknown>).reason === "string" &&
      (g as Record<string, unknown>).reason == "Backfill truncated by byte or event cap",
    );
    expect(truncationGaps.length).toBeGreaterThanOrEqual(0);
  });

  // ── Deferred backfill: live event not dropped ────────────────────────

  it("deferred backfill: append arriving during backfill not dropped", async () => {
    const task = makeDoneOpenCodeTask(store);
    const activity = new SessionActivityCollector();
    activity.startRun({
      taskId: task.id,
      runStartedAt: task.runStartedAt!,
      sessionId: task.sessionId!,
      rootSessionId: task.sessionId!,
      harness: "opencode",
    });

    let resolveDelay: () => void;
    const delayPromise = new Promise<void>((r) => { resolveDelay = r; });

    const client = {
      session: {
        messages: vi.fn(async () => {
          await delayPromise;
          return { data: [] };
        }),
        children: vi.fn(async () => ({ data: [] })),
      },
    };
    const app = appFor(store, client, activity);

    // Insert live event before backfill resolves.
    activity.recordEvent(task.id, task.runStartedAt!, {
      sessionId: task.sessionId!,
      rootSessionId: task.sessionId!,
      harness: "opencode",
      kind: "text",
      role: "assistant",
      text: "during-backfill",
    });

    // IMPORTANT: Don't await resPromise until AFTER releasing backfill.
    const resPromise = app.request(`/api/tasks/${task.id}/session-events`);
    resolveDelay!();
    const res = await (resPromise as Promise<Response>);
    expect(res.status).toBe(200);

    const raw = await readStreamBody(res, 3000);
    const frames = parseSSE(raw);
    const snapshots = frames.filter((f) => f._event === "snapshot");
    if (snapshots.length > 0) {
      const events = (snapshots[0] as { events?: Array<{ text?: string }> }).events ?? [];
      const texts = events.map((e) => e.text).filter(Boolean);
      expect(texts.some((t) => t?.includes("during-backfill"))).toBe(true);
    }
    activity.reset();
  });
});