import { describe, it, expect } from "vitest";
import {
  COLUMNS,
  COLUMN_LABELS,
  DEFAULT_COLUMN,
  isColumn,
  LIVE_STATES,
  isLiveState,
  ROUTE_PATTERNS,
  buildPath,
  ERROR_CODES,
  ERROR_STATUS,
  OPENCODE_DEFAULTS,
  BOARD_SERVER_DEFAULTS,
  AdapterError,
} from "../../src/shared/index";

describe("frozen contracts", () => {
  it("columns are the four workflow columns with labels", () => {
    expect(COLUMNS).toEqual(["todo", "in_progress", "review", "done"]);
    for (const c of COLUMNS) expect(COLUMN_LABELS[c]).toBeTruthy();
    expect(COLUMNS).toContain(DEFAULT_COLUMN);
    expect(isColumn("todo")).toBe(true);
    expect(isColumn("nope")).toBe(false);
  });

  it("live states are the canonical enum", () => {
    expect(LIVE_STATES).toEqual(["running", "idle", "retrying", "error", "unknown"]);
    expect(isLiveState("running")).toBe(true);
    expect(isLiveState("busy")).toBe(false);
  });

  it("routes live under /api/board and build correctly", () => {
    expect(ROUTE_PATTERNS.board).toBe("/api/board");
    expect(ROUTE_PATTERNS.boardEvents).toBe("/api/board/events");
    expect(buildPath.cardMove("ses_1")).toBe("/api/board/cards/ses_1/move");
    expect(buildPath.cardDiff("a/b")).toBe("/api/board/cards/a%2Fb/diff");
  });

  it("error codes each map to an HTTP status", () => {
    for (const code of ERROR_CODES) expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
  });

  it("server defaults are distinct ports", () => {
    expect(OPENCODE_DEFAULTS.port).toBe(4096);
    expect(BOARD_SERVER_DEFAULTS.port).toBe(4097);
  });

  it("AdapterError carries code -> status + envelope", () => {
    const e = AdapterError.notFound("no session ses_x");
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("session_not_found");
    expect(e.status).toBe(404);
    expect(e.toEnvelope()).toEqual({
      error: { code: "session_not_found", message: "no session ses_x" },
    });
    expect(AdapterError.unreachable().status).toBe(503);
  });
});
