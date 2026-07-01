import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { OpencodeEvent, BoardFrame, Card } from "../../src/shared";
import { SqliteColumnStore } from "../../src/db/board-store";
import { EventBridge } from "../../src/server/event-bridge";

interface FixtureSession {
  id: string;
  slug: string;
  projectID: string;
  directory: string;
  title: string;
  version: string;
  time: { created: number; updated: number };
}

function makeSession(id: string, title = "Test session"): FixtureSession {
  return {
    id,
    slug: "test-session",
    projectID: "proj_1",
    directory: "/tmp/project",
    title,
    version: "1.0.0",
    time: { created: 1000, updated: 2000 },
  };
}

type StatusValue = { type: "idle" } | { type: "busy" } | { type: "retry"; attempt: number; message: string; next: number };

/**
 * Fake OpenCode client. `event.subscribe()` yields a scripted async
 * generator of events (one script per call, so tests can control what the
 * "next connection" yields after a reconnect). session.get/status/list are
 * driven off simple in-memory fixture maps.
 */
class FakeOpencodeClient {
  sessions = new Map<string, FixtureSession>();
  statuses = new Map<string, StatusValue>();

  /** Queue of scripts; each `event.subscribe()` call consumes the next one. */
  private scripts: OpencodeEvent[][] = [];
  subscribeCallCount = 0;

  queueScript(events: OpencodeEvent[]): void {
    this.scripts.push(events);
  }

  session = {
    list: async () => ({
      data: Array.from(this.sessions.values()),
      error: undefined,
    }),
    status: async () => ({
      data: Object.fromEntries(this.statuses.entries()),
      error: undefined,
    }),
    get: async ({ sessionID }: { sessionID: string }) => {
      const session = this.sessions.get(sessionID);
      if (!session) {
        return { data: undefined, error: { message: "not found" } };
      }
      return { data: session, error: undefined };
    },
  };

  event = {
    subscribe: async () => {
      const script = this.scripts[this.subscribeCallCount] ?? [];
      this.subscribeCallCount += 1;
      return { stream: makeAsyncGenerator(script) };
    },
  };
}

async function* makeAsyncGenerator<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("waitFor timed out"));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

describe("EventBridge", () => {
  let client: FakeOpencodeClient;
  let store: SqliteColumnStore;
  let bridge: EventBridge;

  beforeEach(() => {
    client = new FakeOpencodeClient();
    store = new SqliteColumnStore(":memory:");
  });

  afterEach(() => {
    bridge?.stop();
    store.close();
  });

  it("emits an 'upsert' frame with a Card on session.created", async () => {
    const sessionId = "ses_created";
    client.sessions.set(sessionId, makeSession(sessionId));
    client.statuses.set(sessionId, { type: "idle" });
    client.queueScript([
      {
        id: "evt_1",
        type: "session.created",
        properties: { sessionID: sessionId, info: makeSession(sessionId) },
      } as unknown as OpencodeEvent,
    ]);

    bridge = new EventBridge({ client: client as never, store });

    const frames: BoardFrame[] = [];
    bridge.subscribe(undefined, (frame) => frames.push(frame));
    bridge.start();

    await waitFor(() => frames.some((f) => f.kind === "upsert"));

    const upsert = frames.find((f) => f.kind === "upsert");
    expect(upsert).toBeDefined();
    if (upsert?.kind !== "upsert") throw new Error("expected upsert");
    expect(upsert.card.sessionId).toBe(sessionId);
    expect(upsert.card.title).toBe("Test session");
    expect(upsert.card.liveState).toBe("idle");
    expect(typeof upsert.seq).toBe("number");
  });

  it("emits a 'remove' frame on session.deleted", async () => {
    const sessionId = "ses_deleted";
    // Session existed at some point, but by the time we handle the deleted
    // event it's no longer resolvable — irrelevant for 'deleted', since the
    // bridge must emit remove without calling session.get.
    client.queueScript([
      {
        id: "evt_1",
        type: "session.deleted",
        properties: { sessionID: sessionId, info: makeSession(sessionId) },
      } as unknown as OpencodeEvent,
    ]);

    bridge = new EventBridge({ client: client as never, store });

    const frames: BoardFrame[] = [];
    bridge.subscribe(undefined, (frame) => frames.push(frame));
    bridge.start();

    await waitFor(() => frames.some((f) => f.kind === "remove"));

    const remove = frames.find((f) => f.kind === "remove");
    expect(remove).toEqual(
      expect.objectContaining({ kind: "remove", sessionId }),
    );
  });

  it("updates the card's liveState on a live-state event", async () => {
    const sessionId = "ses_live";
    client.sessions.set(sessionId, makeSession(sessionId));
    client.statuses.set(sessionId, { type: "idle" });

    // Flip the fixture status to "busy" the moment the bridge first reads it
    // (during the first event's card rebuild), so every subsequent card
    // rebuild — including the live-state event's — deterministically
    // observes "busy". Avoids timing races from real setTimeout/waitFor.
    const originalStatus = client.session.status;
    let statusReadCount = 0;
    client.session.status = async () => {
      statusReadCount += 1;
      if (statusReadCount === 1) {
        client.statuses.set(sessionId, { type: "busy" });
      }
      return originalStatus();
    };

    client.queueScript([
      {
        id: "evt_1",
        type: "session.created",
        properties: { sessionID: sessionId, info: makeSession(sessionId) },
      } as unknown as OpencodeEvent,
      {
        id: "evt_2",
        type: "session.status",
        properties: { sessionID: sessionId, status: { type: "busy" } },
      } as unknown as OpencodeEvent,
    ]);

    bridge = new EventBridge({ client: client as never, store });

    const frames: BoardFrame[] = [];
    bridge.subscribe(undefined, (frame) => frames.push(frame));
    bridge.start();

    await waitFor(() => {
      const upserts = frames.filter((f): f is Extract<BoardFrame, { kind: "upsert" }> => f.kind === "upsert");
      return upserts.some((f) => f.card.liveState === "running");
    });

    const upserts = frames.filter((f): f is Extract<BoardFrame, { kind: "upsert" }> => f.kind === "upsert");
    expect(upserts.length).toBeGreaterThanOrEqual(2);
    expect(upserts[upserts.length - 1].card.sessionId).toBe(sessionId);
    expect(upserts[upserts.length - 1].card.liveState).toBe("running");
  });

  it("replays missed frames via subscribe(fromSeq) using the ring buffer", async () => {
    const sessionA = "ses_a";
    const sessionB = "ses_b";
    client.sessions.set(sessionA, makeSession(sessionA, "A"));
    client.sessions.set(sessionB, makeSession(sessionB, "B"));
    client.statuses.set(sessionA, { type: "idle" });
    client.statuses.set(sessionB, { type: "idle" });

    client.queueScript([
      {
        id: "evt_1",
        type: "session.created",
        properties: { sessionID: sessionA, info: makeSession(sessionA, "A") },
      } as unknown as OpencodeEvent,
      {
        id: "evt_2",
        type: "session.created",
        properties: { sessionID: sessionB, info: makeSession(sessionB, "B") },
      } as unknown as OpencodeEvent,
    ]);

    bridge = new EventBridge({ client: client as never, store });

    const earlyFrames: BoardFrame[] = [];
    bridge.subscribe(undefined, (frame) => earlyFrames.push(frame));
    bridge.start();

    await waitFor(() => earlyFrames.filter((f) => f.kind === "upsert").length >= 2);

    // A late subscriber that "missed" both frames asks for replay from seq 0.
    const replayed: BoardFrame[] = [];
    bridge.subscribe(0, (frame) => replayed.push(frame));

    expect(replayed).toHaveLength(2);
    expect(replayed.map((f) => (f.kind === "upsert" ? f.card.sessionId : null))).toEqual([
      sessionA,
      sessionB,
    ]);

    // A subscriber that already saw seq 1 only gets the frame after it.
    const partialReplay: BoardFrame[] = [];
    const firstSeq = earlyFrames[0].seq;
    bridge.subscribe(firstSeq, (frame) => partialReplay.push(frame));

    expect(partialReplay).toHaveLength(1);
    expect(partialReplay[0].kind === "upsert" && partialReplay[0].card.sessionId).toBe(sessionB);
  });

  it("snapshotFrame() returns all cards", async () => {
    const sessionA = "ses_snap_a";
    const sessionB = "ses_snap_b";
    client.sessions.set(sessionA, makeSession(sessionA, "A"));
    client.sessions.set(sessionB, makeSession(sessionB, "B"));
    client.statuses.set(sessionA, { type: "idle" });
    client.statuses.set(sessionB, { type: "busy" });

    bridge = new EventBridge({ client: client as never, store });

    const frame = await bridge.snapshotFrame();
    expect(frame.kind).toBe("snapshot");
    if (frame.kind !== "snapshot") throw new Error("expected snapshot");
    expect(frame.cards).toHaveLength(2);
    const ids = frame.cards.map((c: Card) => c.sessionId).sort();
    expect(ids).toEqual([sessionA, sessionB].sort());
  });

  it("skips 'created'/'updated'/'live-state' events for sessions that resolve to null (buildCardForSession returns null)", async () => {
    const sessionId = "ses_gone";
    // Not registered in client.sessions -> session.get returns error/undefined -> buildCardForSession -> null.
    client.queueScript([
      {
        id: "evt_1",
        type: "session.updated",
        properties: { sessionID: sessionId, info: makeSession(sessionId) },
      } as unknown as OpencodeEvent,
      // Follow with a real event so we know the loop kept going and didn't emit a null upsert.
      {
        id: "evt_2",
        type: "session.deleted",
        properties: { sessionID: sessionId, info: makeSession(sessionId) },
      } as unknown as OpencodeEvent,
    ]);

    bridge = new EventBridge({ client: client as never, store });

    const frames: BoardFrame[] = [];
    bridge.subscribe(undefined, (frame) => frames.push(frame));
    bridge.start();

    await waitFor(() => frames.some((f) => f.kind === "remove"));

    expect(frames.filter((f) => f.kind === "upsert")).toHaveLength(0);
    expect(frames.filter((f) => f.kind === "remove")).toHaveLength(1);
  });
});
