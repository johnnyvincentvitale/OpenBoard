import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Session, SessionStatus } from "@opencode-ai/sdk/v2/types";
import { SqliteColumnStore } from "../../src/db/board-store";
import {
  buildBoardSnapshot,
  buildCardForSession,
  type OpencodeClientLike,
} from "../../src/server/board-service";
import { AdapterError } from "../../src/shared/errors";

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
const BUSY_STATUS: SessionStatus = { type: "busy" };

/**
 * A hermetic, duck-typed fake of the OpenCode SDK client. Only implements
 * session.list / session.status / session.get — the surface board-service
 * actually calls. Every method returns the SDK's real { data, error } shape.
 */
function makeFakeClient(opts: {
  sessions?: Session[];
  statusMap?: Record<string, SessionStatus>;
  listError?: unknown;
  statusError?: unknown;
  getError?: unknown;
  getSession?: Session | null;
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
        if (opts.statusError) {
          return { data: undefined, error: opts.statusError };
        }
        return { data: statusMap, error: undefined };
      },
      get: async (_params: { sessionID: string }) => {
        if (opts.getError) {
          return { data: undefined, error: opts.getError };
        }
        if (opts.getSession === null || opts.getSession === undefined) {
          return { data: undefined, error: { message: "not found" } };
        }
        return { data: opts.getSession, error: undefined };
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as OpencodeClientLike;
}

// --- buildBoardSnapshot ------------------------------------------------------

describe("buildBoardSnapshot", () => {
  let store: SqliteColumnStore;

  beforeEach(() => {
    store = new SqliteColumnStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("builds a Card for every session returned by the client", async () => {
    const sessions = [
      makeSession({ id: "ses_a", title: "A" }),
      makeSession({ id: "ses_b", title: "B" }),
    ];
    const client = makeFakeClient({
      sessions,
      statusMap: { ses_a: IDLE_STATUS, ses_b: IDLE_STATUS },
    });

    const cards = await buildBoardSnapshot(client, store);

    expect(cards).toHaveLength(2);
    const ids = cards.map((c) => c.sessionId).sort();
    expect(ids).toEqual(["ses_a", "ses_b"]);
  });

  it("lands new sessions in 'todo'", async () => {
    const sessions = [makeSession({ id: "ses_new" })];
    const client = makeFakeClient({
      sessions,
      statusMap: { ses_new: IDLE_STATUS },
    });

    const cards = await buildBoardSnapshot(client, store);

    expect(cards).toHaveLength(1);
    expect(cards[0].column).toBe("todo");
  });

  it("promotes a newly-seen running session (status busy) to in_progress with liveState 'running'", async () => {
    const sessions = [makeSession({ id: "ses_running" })];
    const client = makeFakeClient({
      sessions,
      statusMap: { ses_running: BUSY_STATUS },
    });

    const cards = await buildBoardSnapshot(client, store);

    expect(cards).toHaveLength(1);
    expect(cards[0].liveState).toBe("running");
    expect(cards[0].column).toBe("in_progress");
  });

  it("sorts cards by column order (todo, in_progress, review, done) then position ascending", async () => {
    // Seed the store directly so we control column placement precisely.
    store.reconcile([
      { sessionId: "ses_done" },
      { sessionId: "ses_todo_2" },
      { sessionId: "ses_todo_1" },
      { sessionId: "ses_review" },
    ]);
    store.moveCard("ses_done", "done", 0);
    store.moveCard("ses_review", "review", 0);
    // ses_todo_1 and ses_todo_2 stay in todo; ensure ses_todo_1 sorts before ses_todo_2.
    store.moveCard("ses_todo_1", "todo", 0);
    store.moveCard("ses_todo_2", "todo", 1);

    const sessions = [
      makeSession({ id: "ses_done" }),
      makeSession({ id: "ses_todo_2" }),
      makeSession({ id: "ses_todo_1" }),
      makeSession({ id: "ses_review" }),
    ];
    const client = makeFakeClient({
      sessions,
      statusMap: {
        ses_done: IDLE_STATUS,
        ses_todo_2: IDLE_STATUS,
        ses_todo_1: IDLE_STATUS,
        ses_review: IDLE_STATUS,
      },
    });

    const cards = await buildBoardSnapshot(client, store);

    expect(cards.map((c) => c.sessionId)).toEqual([
      "ses_todo_1",
      "ses_todo_2",
      "ses_review",
      "ses_done",
    ]);
  });

  it("throws AdapterError with code 'opencode_unreachable' when session.list returns an error", async () => {
    const client = makeFakeClient({
      listError: { message: "connection refused" },
    });

    let caught: unknown;
    try {
      await buildBoardSnapshot(client, store);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AdapterError);
    expect((caught as AdapterError).code).toBe("opencode_unreachable");
  });

  it("throws AdapterError with code 'opencode_unreachable' when session.status returns an error", async () => {
    const client = makeFakeClient({
      sessions: [makeSession({ id: "ses_a" })],
      statusError: { message: "boom" },
    });

    await expect(buildBoardSnapshot(client, store)).rejects.toMatchObject({
      name: "AdapterError",
      code: "opencode_unreachable",
    });
  });
});

// --- buildCardForSession -----------------------------------------------------

describe("buildCardForSession", () => {
  let store: SqliteColumnStore;

  beforeEach(() => {
    store = new SqliteColumnStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("returns a single Card for an existing session", async () => {
    const session = makeSession({ id: "ses_one", title: "Solo" });
    const client = makeFakeClient({
      getSession: session,
      statusMap: { ses_one: BUSY_STATUS },
    });

    const card = await buildCardForSession(client, store, "ses_one");

    expect(card).not.toBeNull();
    expect(card?.sessionId).toBe("ses_one");
    expect(card?.title).toBe("Solo");
    expect(card?.liveState).toBe("running");
  });

  it("reconciles a row for the session (lands in todo) before mapping", async () => {
    const session = makeSession({ id: "ses_two" });
    const client = makeFakeClient({
      getSession: session,
      statusMap: { ses_two: IDLE_STATUS },
    });

    const card = await buildCardForSession(client, store, "ses_two");

    expect(card?.column).toBe("todo");
    expect(store.getRow("ses_two")).toBeDefined();
  });

  it("returns null when the session is absent (get returns error/not found)", async () => {
    const client = makeFakeClient({ getSession: null });

    const card = await buildCardForSession(client, store, "ses_missing");

    expect(card).toBeNull();
  });
});
