import { describe, expect, it, vi } from "vitest";
import { createBoardStore, type BoardClientLike, type ConnectFn } from "../../src/web/store";
import type { BoardFrame, Card } from "../../src/shared";

function makeCard(overrides: Partial<Card> & { sessionId: string }): Card {
  return {
    title: overrides.sessionId,
    directory: "/tmp",
    cost: 0,
    additions: 0,
    deletions: 0,
    files: 0,
    column: "todo",
    position: 0,
    liveState: "idle",
    updatedAt: 0,
    ...overrides,
  };
}

interface FakeConnectHandle {
  handlers?: { onFrame: (f: BoardFrame) => void; onStatus: (s: "connecting" | "open" | "closed") => void };
  disconnect: ReturnType<typeof vi.fn<() => void>>;
}

function makeFakeConnect(): { connect: ConnectFn; handle: FakeConnectHandle } {
  const handle: FakeConnectHandle = { disconnect: vi.fn<() => void>() };
  const connect: ConnectFn = (handlers) => {
    handle.handlers = handlers;
    return () => handle.disconnect();
  };
  return { connect, handle };
}

function makeFakeClient(overrides: Partial<BoardClientLike> = {}): BoardClientLike {
  return {
    getBoard: vi.fn(async () => []),
    move: vi.fn(async () => []),
    prompt: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    diff: vi.fn(async () => []),
    getHealth: vi.fn(async () => ({ opencode: "ok" as const })),
    ...overrides,
  };
}

describe("createBoardStore — frame folding", () => {
  it("folds snapshot then upsert then remove, sorted by column order then position", async () => {
    const { connect, handle } = makeFakeConnect();
    const client = makeFakeClient();
    const store = createBoardStore({ client, connect, healthPollMs: 1_000_000 });

    store.init();
    // Allow the init() getBoard()/getHealth() promise chains to flush.
    await Promise.resolve();
    await Promise.resolve();

    const cardA = makeCard({ sessionId: "a", column: "in_progress", position: 1 });
    const cardB = makeCard({ sessionId: "b", column: "todo", position: 5 });
    const cardC = makeCard({ sessionId: "c", column: "todo", position: 1 });

    handle.handlers?.onFrame({ kind: "snapshot", seq: 1, cards: [cardA, cardB, cardC] });

    let snapshot = store.getSnapshot();
    expect(snapshot.cards.map((c) => c.sessionId)).toEqual(["c", "b", "a"]);

    const cardAUpdated = makeCard({ sessionId: "a", column: "todo", position: 0 });
    handle.handlers?.onFrame({ kind: "upsert", seq: 2, card: cardAUpdated });

    snapshot = store.getSnapshot();
    expect(snapshot.cards.map((c) => c.sessionId)).toEqual(["a", "c", "b"]);

    handle.handlers?.onFrame({ kind: "remove", seq: 3, sessionId: "c" });

    snapshot = store.getSnapshot();
    expect(snapshot.cards.map((c) => c.sessionId)).toEqual(["a", "b"]);

    store.dispose();
  });

  it("heartbeat frames do not change card state", async () => {
    const { connect, handle } = makeFakeConnect();
    const client = makeFakeClient();
    const store = createBoardStore({ client, connect, healthPollMs: 1_000_000 });

    store.init();
    await Promise.resolve();
    await Promise.resolve();

    const cardA = makeCard({ sessionId: "a" });
    handle.handlers?.onFrame({ kind: "snapshot", seq: 1, cards: [cardA] });
    const before = store.getSnapshot();

    handle.handlers?.onFrame({ kind: "heartbeat", seq: 2 });
    const after = store.getSnapshot();

    expect(after.cards).toEqual(before.cards);

    store.dispose();
  });

  it("sorts across all four columns in COLUMNS order", async () => {
    const { connect, handle } = makeFakeConnect();
    const client = makeFakeClient();
    const store = createBoardStore({ client, connect, healthPollMs: 1_000_000 });

    store.init();
    await Promise.resolve();
    await Promise.resolve();

    const cards = [
      makeCard({ sessionId: "done1", column: "done", position: 0 }),
      makeCard({ sessionId: "review1", column: "review", position: 0 }),
      makeCard({ sessionId: "inprog1", column: "in_progress", position: 0 }),
      makeCard({ sessionId: "todo1", column: "todo", position: 0 }),
    ];
    handle.handlers?.onFrame({ kind: "snapshot", seq: 1, cards });

    const snapshot = store.getSnapshot();
    expect(snapshot.cards.map((c) => c.sessionId)).toEqual(["todo1", "inprog1", "review1", "done1"]);

    store.dispose();
  });
});

describe("createBoardStore — move()", () => {
  it("optimistically updates then reconciles with the returned board", async () => {
    const { connect, handle } = makeFakeConnect();
    let resolveMove: (cards: Card[]) => void = () => {};
    const movePromise = new Promise<Card[]>((resolve) => {
      resolveMove = resolve;
    });
    const client = makeFakeClient({
      move: vi.fn(() => movePromise),
    });
    const store = createBoardStore({ client, connect, healthPollMs: 1_000_000 });

    store.init();
    await Promise.resolve();
    await Promise.resolve();

    const cardA = makeCard({ sessionId: "a", column: "todo", position: 0 });
    handle.handlers?.onFrame({ kind: "snapshot", seq: 1, cards: [cardA] });

    store.move("a", "in_progress", 3);

    // Optimistic update should be visible immediately, before the client call resolves.
    let snapshot = store.getSnapshot();
    expect(snapshot.cards[0]).toMatchObject({ sessionId: "a", column: "in_progress", position: 3 });
    expect(client.move).toHaveBeenCalledWith("a", "in_progress", 3);

    // Server reconciliation: returns a fresh board that differs from the optimistic guess.
    const reconciledCard = makeCard({ sessionId: "a", column: "in_progress", position: 0 });
    resolveMove([reconciledCard]);
    await movePromise;
    await Promise.resolve();

    snapshot = store.getSnapshot();
    expect(snapshot.cards).toEqual([reconciledCard]);

    store.dispose();
  });

  it("does nothing optimistically for an unknown sessionId but still calls client.move", async () => {
    const { connect } = makeFakeConnect();
    const client = makeFakeClient({ move: vi.fn(async () => []) });
    const store = createBoardStore({ client, connect, healthPollMs: 1_000_000 });

    store.init();
    await Promise.resolve();
    await Promise.resolve();

    store.move("missing", "done", 0);
    expect(client.move).toHaveBeenCalledWith("missing", "done", 0);

    store.dispose();
  });
});

describe("createBoardStore — subscribe/getSnapshot", () => {
  it("notifies subscribers on state changes and stops after unsubscribe", async () => {
    const { connect, handle } = makeFakeConnect();
    const client = makeFakeClient();
    const store = createBoardStore({ client, connect, healthPollMs: 1_000_000 });

    store.init();
    await Promise.resolve();
    await Promise.resolve();

    const cb = vi.fn();
    const unsubscribe = store.subscribe(cb);

    handle.handlers?.onFrame({ kind: "snapshot", seq: 1, cards: [makeCard({ sessionId: "a" })] });
    expect(cb).toHaveBeenCalledTimes(1);

    unsubscribe();
    handle.handlers?.onFrame({ kind: "upsert", seq: 2, card: makeCard({ sessionId: "b" }) });
    expect(cb).toHaveBeenCalledTimes(1);

    store.dispose();
  });

  it("dispose() calls the sse disconnect function", async () => {
    const { connect, handle } = makeFakeConnect();
    const client = makeFakeClient();
    const store = createBoardStore({ client, connect, healthPollMs: 1_000_000 });

    store.init();
    await Promise.resolve();
    await Promise.resolve();

    store.dispose();
    expect(handle.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("createBoardStore — prompt/interrupt/diff delegate to client", () => {
  it("delegates prompt, interrupt, and diff calls", async () => {
    const { connect } = makeFakeConnect();
    const client = makeFakeClient();
    const store = createBoardStore({ client, connect, healthPollMs: 1_000_000 });

    store.init();
    await Promise.resolve();
    await Promise.resolve();

    await store.prompt("a", "hello");
    expect(client.prompt).toHaveBeenCalledWith("a", "hello");

    await store.interrupt("a");
    expect(client.interrupt).toHaveBeenCalledWith("a");

    await store.diff("a");
    expect(client.diff).toHaveBeenCalledWith("a");

    store.dispose();
  });
});
