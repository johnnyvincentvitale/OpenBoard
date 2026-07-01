import { describe, it, expect } from "vitest";
import type { Session, SessionStatus } from "@opencode-ai/sdk/v2/types";
import type { BoardRow, LiveState } from "../../src/shared";
import { liveStateFromStatus, mapSessionToCard } from "../../src/server/dto";

// --- Fixtures ------------------------------------------------------------

function makeRow(overrides: Partial<BoardRow> = {}): BoardRow {
  return {
    sessionId: "ses_1",
    column: "in_progress",
    position: 2,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "ses_1",
    slug: "ses-1",
    projectID: "proj_1",
    directory: "/Users/johnnyvitale/code/opencode-board",
    title: "Fix the dto mapper",
    version: "1.17.13",
    time: {
      created: 1_700_000_000_000,
      updated: 1_700_000_200_000,
    },
    ...overrides,
  };
}

const IDLE_STATUS: SessionStatus = { type: "idle" };
const RETRY_STATUS: SessionStatus = {
  type: "retry",
  attempt: 2,
  message: "rate limited",
  next: 1_700_000_500_000,
};
const BUSY_STATUS: SessionStatus = { type: "busy" };

// --- liveStateFromStatus: every SessionStatus variant --------------------

describe("liveStateFromStatus", () => {
  const cases: Array<{ name: string; status: SessionStatus | undefined; expected: LiveState }> =
    [
      { name: "idle", status: IDLE_STATUS, expected: "idle" },
      { name: "retry", status: RETRY_STATUS, expected: "retrying" },
      { name: "busy", status: BUSY_STATUS, expected: "running" },
      { name: "undefined (no status observed)", status: undefined, expected: "unknown" },
    ];

  it.each(cases)("maps $name -> $expected", ({ status, expected }) => {
    expect(liveStateFromStatus(status)).toBe(expected);
  });

  it("defaults an unrecognized/future status type to error rather than throwing", () => {
    const unknownStatus = { type: "something-new" } as unknown as SessionStatus;
    expect(() => liveStateFromStatus(unknownStatus)).not.toThrow();
    expect(liveStateFromStatus(unknownStatus)).toBe("error");
  });

  it("treats null the same as undefined", () => {
    expect(liveStateFromStatus(null as unknown as undefined)).toBe("unknown");
  });
});

// --- mapSessionToCard: full fixture --------------------------------------

describe("mapSessionToCard", () => {
  it("maps a full Session + status + row into a full Card", () => {
    const session = makeSession({
      title: "Implement dto mapper",
      directory: "/repo/opencode-board",
      agent: "build",
      model: { id: "claude-sonnet-5", providerID: "anthropic", variant: "default" },
      cost: 1.23,
      summary: { additions: 10, deletions: 4, files: 2 },
      time: { created: 1_700_000_000_000, updated: 1_700_000_999_000 },
    });
    const row = makeRow({ column: "review", position: 5 });

    const card = mapSessionToCard(session, BUSY_STATUS, row);

    expect(card).toEqual({
      sessionId: "ses_1",
      title: "Implement dto mapper",
      directory: "/repo/opencode-board",
      agent: "build",
      model: { id: "claude-sonnet-5", providerID: "anthropic" },
      cost: 1.23,
      additions: 10,
      deletions: 4,
      files: 2,
      column: "review",
      position: 5,
      liveState: "running",
      updatedAt: 1_700_000_999_000,
    });
  });

  it("strips the model's optional variant field, keeping only id/providerID", () => {
    const session = makeSession({
      model: { id: "gpt-5", providerID: "openai", variant: "mini" },
    });
    const card = mapSessionToCard(session, IDLE_STATUS, makeRow());
    expect(card.model).toEqual({ id: "gpt-5", providerID: "openai" });
  });

  it("defaults missing summary to zeroed additions/deletions/files", () => {
    const session = makeSession({ summary: undefined });
    const card = mapSessionToCard(session, IDLE_STATUS, makeRow());
    expect(card.additions).toBe(0);
    expect(card.deletions).toBe(0);
    expect(card.files).toBe(0);
  });

  it("defaults missing cost to 0", () => {
    const session = makeSession({ cost: undefined });
    const card = mapSessionToCard(session, IDLE_STATUS, makeRow());
    expect(card.cost).toBe(0);
  });

  it("defaults missing model to undefined without throwing", () => {
    const session = makeSession({ model: undefined });
    expect(() => mapSessionToCard(session, IDLE_STATUS, makeRow())).not.toThrow();
    const card = mapSessionToCard(session, IDLE_STATUS, makeRow());
    expect(card.model).toBeUndefined();
  });

  it("defaults missing agent to undefined without throwing", () => {
    const session = makeSession({ agent: undefined });
    const card = mapSessionToCard(session, IDLE_STATUS, makeRow());
    expect(card.agent).toBeUndefined();
  });

  it("takes column and position from the BoardRow, not the session", () => {
    const session = makeSession();
    const row = makeRow({ column: "done", position: 9 });
    const card = mapSessionToCard(session, IDLE_STATUS, row);
    expect(card.column).toBe("done");
    expect(card.position).toBe(9);
  });

  it("uses session.time.updated for updatedAt", () => {
    const session = makeSession({
      time: { created: 1, updated: 42 },
    });
    const card = mapSessionToCard(session, IDLE_STATUS, makeRow());
    expect(card.updatedAt).toBe(42);
  });

  it("derives liveState from the given status for every variant", () => {
    const session = makeSession();
    expect(mapSessionToCard(session, IDLE_STATUS, makeRow()).liveState).toBe("idle");
    expect(mapSessionToCard(session, RETRY_STATUS, makeRow()).liveState).toBe("retrying");
    expect(mapSessionToCard(session, BUSY_STATUS, makeRow()).liveState).toBe("running");
    expect(mapSessionToCard(session, undefined, makeRow()).liveState).toBe("unknown");
  });

  it("never throws when every optional Session field is absent", () => {
    const bareSession: Session = {
      id: "ses_bare",
      slug: "ses-bare",
      projectID: "proj_1",
      directory: "/repo",
      title: "",
      version: "1.0.0",
      time: { created: 0, updated: 0 },
    };
    expect(() => mapSessionToCard(bareSession, undefined, makeRow())).not.toThrow();
    const card = mapSessionToCard(bareSession, undefined, makeRow());
    expect(card).toEqual({
      sessionId: "ses_bare",
      title: "",
      directory: "/repo",
      agent: undefined,
      model: undefined,
      cost: 0,
      additions: 0,
      deletions: 0,
      files: 0,
      column: "in_progress",
      position: 2,
      liveState: "unknown",
      updatedAt: 0,
    });
  });
});
