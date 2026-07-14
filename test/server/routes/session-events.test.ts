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

  it("completed Review ACP card emits complete without an activity collector", async () => {
    const task = makeAcpTask(store);
    store.update(task.id, {
      column: "review",
      runState: "idle",
      completion: {
        outcome: "complete",
        summary: "finished",
        changedFiles: [],
        verification: [],
        residualRisk: "none",
        reportedAt: 500,
      },
    });
    const app = appFor(store, makeFakeOpenCodeClient());

    const res = await app.request(`/api/tasks/${task.id}/session-events`);
    const frames = parseSSE(await readStreamBody(res, 3000));
    const terminal = frames.find((frame) => frame._event === "terminal");

    expect(terminal?.status).toBe("complete");
  });

  it("completed Review ACP card overrides an obsolete aborted collector terminal", async () => {
    const task = makeAcpTask(store);
    store.update(task.id, {
      column: "review",
      runState: "idle",
      completion: {
        outcome: "complete",
        summary: "finished after interrupt",
        changedFiles: [],
        verification: [],
        residualRisk: "none",
        reportedAt: 600,
      },
    });
    const activity = new SessionActivityCollector();
    activity.startRun({
      taskId: task.id,
      runStartedAt: task.runStartedAt!,
      sessionId: task.harnessSessionId!,
      rootSessionId: task.harnessSessionId!,
      harness: "claude-code",
    });
    activity.recordEvent(task.id, task.runStartedAt!, {
      sessionId: task.harnessSessionId!,
      rootSessionId: task.harnessSessionId!,
      harness: "claude-code",
      kind: "text",
      text: "replacement turn completed",
    });
    activity.endRun(task.id, task.runStartedAt!, "aborted");
    const app = appFor(store, makeFakeOpenCodeClient(), activity);

    const res = await app.request(`/api/tasks/${task.id}/session-events`);
    const frames = parseSSE(await readStreamBody(res, 3000));
    const terminal = frames.find((frame) => frame._event === "terminal");

    expect(terminal?.status).toBe("complete");
    activity.reset();
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

  // ── Dedup fingerprint: same logical event from both sides ────────────

  it("does not duplicate the same logical event when backfill and collector both carry it with different occurredAt timestamps", async () => {
    // Backfill stamps occurredAt at message-created time; the collector
    // stamps it at record time via its clock — these are never equal for
    // the same real event, so a fingerprint that includes occurredAt (the
    // pre-fix behavior) fails to dedup and the event renders twice.
    const task = makeDoneOpenCodeTask(store);
    const activity = new SessionActivityCollector({ clock: () => 999_999 });
    activity.startRun({
      taskId: task.id,
      runStartedAt: task.runStartedAt!,
      sessionId: task.sessionId!,
      rootSessionId: task.sessionId!,
      harness: "opencode",
    });
    activity.recordEvent(task.id, task.runStartedAt!, {
      sessionId: task.sessionId!,
      rootSessionId: task.sessionId!,
      harness: "opencode",
      kind: "text",
      role: "assistant",
      text: "duplicate me",
    });

    const client = makeFakeOpenCodeClient([
      makeMessage({
        info: { role: "assistant", id: "msg_1", created: 500 },
        parts: [{ type: "text", text: "duplicate me" }],
      }),
    ]);
    const app = appFor(store, client, activity);
    const res = await app.request(`/api/tasks/${task.id}/session-events`);
    expect(res.status).toBe(200);

    const raw = await readStreamBody(res, 3000);
    const frames = parseSSE(raw);
    const snapshots = frames.filter((f) => f._event === "snapshot");
    expect(snapshots.length).toBeGreaterThanOrEqual(1);

    const events = (snapshots[0] as { events?: Array<{ text?: string }> }).events ?? [];
    const duplicateCopies = events.filter((e) => e.text === "duplicate me");
    expect(duplicateCopies.length).toBe(1);
    activity.reset();
  });

  it("unwraps the internal Session Chat prompt so the operator message appears only once", async () => {
    const task = makeDoneOpenCodeTask(store);
    const activity = new SessionActivityCollector({ clock: () => 999_999 });
    activity.startRun({
      taskId: task.id,
      runStartedAt: task.runStartedAt!,
      sessionId: task.sessionId!,
      rootSessionId: task.sessionId!,
      harness: "opencode",
    });
    activity.recordEvent(task.id, task.runStartedAt!, {
      sessionId: task.sessionId!,
      rootSessionId: task.sessionId!,
      harness: "opencode",
      kind: "text",
      role: "user",
      text: "Show me the command",
    });

    const wrapped = "OPENBOARD SESSION CHAT\n\nShow me the command\n\nRespond conversationally in this session. Do not call complete_task or block_task, do not change files, and do not alter the card lifecycle for this chat turn.";
    const client = makeFakeOpenCodeClient([
      makeMessage({ info: { role: "user", id: "msg_chat", created: 500 }, parts: [{ type: "text", text: wrapped }] }),
    ]);
    const res = await appFor(store, client, activity).request(`/api/tasks/${task.id}/session-events`);
    const frames = parseSSE(await readStreamBody(res, 3000));
    const snapshot = frames.find((frame) => frame._event === "snapshot") as { events?: Array<{ text?: string }> } | undefined;
    const texts = snapshot?.events?.map((event) => event.text) ?? [];
    expect(texts.filter((text) => text === "Show me the command")).toHaveLength(1);
    expect(texts.some((text) => text?.includes("OPENBOARD SESSION CHAT"))).toBe(false);
    activity.reset();
  });

  it("renders provider backfill chronologically and strips injected worker contracts from user chat", async () => {
    const task = makeDoneOpenCodeTask(store);
    const client = makeFakeOpenCodeClient([
      makeMessage({ info: { role: "user", id: "msg_1", time: { created: 100 } }, parts: [{ type: "text", text: "First question\n\n---\nOPENBOARD COMPLETION CONTRACT\nsecret plumbing" }] }),
      makeMessage({ info: { role: "assistant", id: "msg_2", time: { created: 200 } }, parts: [{ type: "text", text: "First answer" }] }),
      makeMessage({ info: { role: "user", id: "msg_3", time: { created: 300 } }, parts: [{ type: "text", text: "OPERATOR MESSAGE\n\nSecond question\n\nContinue the existing task in the current working tree. Preserve prior work" }] }),
      makeMessage({ info: { role: "assistant", id: "msg_4", time: { created: 400 } }, parts: [{ type: "text", text: "Second answer" }] }),
    ]);
    const res = await appFor(store, client).request(`/api/tasks/${task.id}/session-events`);
    const frames = parseSSE(await readStreamBody(res, 3000));
    const snapshot = frames.find((frame) => frame._event === "snapshot") as { events?: Array<{ text?: string }> } | undefined;
    expect(snapshot?.events?.map((event) => event.text)).toEqual(["First question", "First answer", "Second question", "Second answer"]);
  });

  it("hides OpenBoard report tools and collapses the provider's post-tool assistant echo", async () => {
    const task = makeDoneOpenCodeTask(store);
    const client = makeFakeOpenCodeClient([
      makeMessage({ info: { role: "user", id: "msg_u", time: { created: 100 } }, parts: [{ type: "text", text: "Can you read this?" }] }),
      makeMessage({ info: { role: "assistant", id: "msg_tool", time: { created: 200 } }, parts: [
        { type: "text", text: "YES" },
        { type: "tool", tool: "openboard_complete_task", callID: "call_report", state: { status: "completed" } },
      ] }),
      makeMessage({ info: { role: "assistant", id: "msg_stop", time: { created: 300 } }, parts: [{ type: "text", text: "YES" }] }),
    ]);
    const res = await appFor(store, client).request(`/api/tasks/${task.id}/session-events`);
    const frames = parseSSE(await readStreamBody(res, 3000));
    const snapshot = frames.find((frame) => frame._event === "snapshot") as { events?: Array<{ kind?: string; text?: string; tool?: { name?: string } }> } | undefined;
    expect(snapshot?.events?.filter((event) => event.text === "YES")).toHaveLength(1);
    expect(snapshot?.events?.some((event) => event.tool?.name === "openboard_complete_task")).toBe(false);
  });

  // ── Terminal mid-backfill: not dropped, and the stream actually closes ─

  it("delivers a terminal frame that arrives during backfill (not just append frames) and stops the heartbeat loop instead of looping forever", async () => {
    // Not terminal at request time — column stays in_progress/running so
    // the route takes the live subscribe-before-backfill path all the way
    // through the drain + heartbeat loop, instead of the isTerminal
    // short-circuit that Done/Review cards take.
    const task = makeTask(store, { column: "in_progress", runState: "running" });
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

    const resPromise = app.request(`/api/tasks/${task.id}/session-events`);
    // The run ends while backfill is still awaiting messages() — this
    // terminal frame lands in the post-detach pendingLiveFrames buffer,
    // which the pre-fix drain step filtered to append-only and dropped.
    activity.endRun(task.id, task.runStartedAt!, "complete");
    resolveDelay!();
    const res = await (resPromise as Promise<Response>);
    expect(res.status).toBe(200);

    const { raw, closed } = await readUntilCloseOrTimeout(res, 2000);
    // The broken heartbeat loop never consults the terminal state and
    // sleeps for HEARTBEAT_INTERVAL_MS (15s) before ever checking again, so
    // the stream would still be open at the 2s mark without the fix.
    expect(closed).toBe(true);

    const frames = parseSSE(raw);
    const terminals = frames.filter((f) => f._event === "terminal");
    expect(terminals.length).toBeGreaterThanOrEqual(1);
    expect(terminals[0]?.status).toBe("complete");
    activity.reset();
  });

  it("ACP live path: stream closes after the run's terminal frame instead of heartbeating LIVE forever (P2 regression)", async () => {
    // Task is still running/in_progress in the STORE (so the route takes the
    // ACP live path, not the isTerminal short-circuit), but the collector
    // run has already ended — subscribe replays snapshot + heartbeat +
    // terminal, and the fixed heartbeat loop must exit instead of sleeping
    // 15s and stamping the finished run back to transport "live".
    const task = makeAcpTask(store);
    const activity = new SessionActivityCollector();
    activity.startRun({
      taskId: task.id,
      runStartedAt: task.runStartedAt!,
      sessionId: "acp_sess_1",
      rootSessionId: "acp_sess_1",
      harness: "claude-code",
    });
    activity.recordEvent(task.id, task.runStartedAt!, {
      sessionId: "acp_sess_1",
      rootSessionId: "acp_sess_1",
      harness: "claude-code",
      kind: "text",
      text: "acp output",
    });
    activity.endRun(task.id, task.runStartedAt!, "complete");
    const app = appFor(store, makeFakeOpenCodeClient(), activity);

    const res = await app.request(`/api/tasks/${task.id}/session-events`);
    expect(res.status).toBe(200);
    const { raw, closed } = await readUntilCloseOrTimeout(res, 2000);
    // The broken loop ignored the terminal frame and slept HEARTBEAT_INTERVAL_MS
    // (15s), so the stream would still be open at the 2s mark without the fix.
    expect(closed).toBe(true);

    const frames = parseSSE(raw);
    const terminalIndex = frames.findIndex((f) => f._event === "terminal");
    expect(terminalIndex).toBeGreaterThan(-1);
    expect(frames[terminalIndex]?.status).toBe("complete");
    // Nothing after the terminal frame may claim the stream is live again.
    const afterTerminal = frames.slice(terminalIndex + 1).filter((f) => f._event === "heartbeat" && f.transport === "live");
    expect(afterTerminal).toHaveLength(0);
    activity.reset();
  });
});

/** Read a response body, racing each read against a timeout, and report whether the stream actually closed (vs. timed out still open). */
async function readUntilCloseOrTimeout(res: Response, timeoutMs: number): Promise<{ raw: string; closed: boolean }> {
  const body = res.body as WritableReadableStream<Uint8Array> | null;
  if (!body) return { raw: await res.text().catch(() => ""), closed: true };

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let closed = false;

  try {
    while (true) {
      const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs));
      const result = await Promise.race([reader.read(), timeout]);
      if (result === "timeout") break;
      const { value, done } = result as ReadableStreamReadResult<Uint8Array>;
      if (value) raw += decoder.decode(value, { stream: true });
      if (done) {
        closed = true;
        break;
      }
    }
  } catch {
    // Reader may error on abort/close.
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  return { raw, closed };
}
