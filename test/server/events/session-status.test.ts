import { describe, expect, it } from "vitest";
import type { OpencodeEvent } from "../../../src/shared";
import { eventLiveState, eventSessionId } from "../../../src/server/events/session-status";

const SESSION_ID = "ses_abc123";

function makeSession(id: string) {
  return {
    id,
    slug: "test-session",
    projectID: "proj_1",
    directory: "/tmp/project",
    title: "Test session",
    version: "1.0.0",
    time: { created: 1000, updated: 2000 },
  };
}

describe("eventLiveState", () => {
  it('maps session.next.step.started -> "running"', () => {
    const event = {
      id: "evt_1",
      type: "session.next.step.started",
      properties: {
        timestamp: 1,
        sessionID: SESSION_ID,
        assistantMessageID: "msg_1",
        agent: "build",
        model: { id: "claude", providerID: "anthropic" },
      },
    } as unknown as OpencodeEvent;

    expect(eventLiveState(event)).toBe("running");
  });

  it('maps session.next.tool.input.started -> "running"', () => {
    const event = {
      id: "evt_2",
      type: "session.next.tool.input.started",
      properties: {
        timestamp: 1,
        sessionID: SESSION_ID,
        assistantMessageID: "msg_1",
        callID: "call_1",
        name: "bash",
      },
    } as unknown as OpencodeEvent;

    expect(eventLiveState(event)).toBe("running");
  });

  it('maps session.next.shell.started -> "running"', () => {
    const event = {
      id: "evt_3",
      type: "session.next.shell.started",
      properties: {
        timestamp: 1,
        sessionID: SESSION_ID,
        messageID: "msg_1",
        callID: "call_1",
        command: "ls",
      },
    } as unknown as OpencodeEvent;

    expect(eventLiveState(event)).toBe("running");
  });

  it('maps session.next.step.ended -> "idle"', () => {
    const event = {
      id: "evt_4",
      type: "session.next.step.ended",
      properties: {
        timestamp: 1,
        sessionID: SESSION_ID,
        assistantMessageID: "msg_1",
        finish: "stop",
        cost: 0.01,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    } as unknown as OpencodeEvent;

    expect(eventLiveState(event)).toBe("idle");
  });

  it('maps session.idle -> "idle"', () => {
    const event = {
      id: "evt_5",
      type: "session.idle",
      properties: { sessionID: SESSION_ID },
    } as unknown as OpencodeEvent;

    expect(eventLiveState(event)).toBe("idle");
  });

  it('maps session.next.step.failed -> "error"', () => {
    const event = {
      id: "evt_6",
      type: "session.next.step.failed",
      properties: {
        timestamp: 1,
        sessionID: SESSION_ID,
        assistantMessageID: "msg_1",
        error: { name: "UnknownError", data: { message: "boom" } },
      },
    } as unknown as OpencodeEvent;

    expect(eventLiveState(event)).toBe("error");
  });

  it('maps session.error -> "error"', () => {
    const event = {
      id: "evt_7",
      type: "session.error",
      properties: {
        sessionID: SESSION_ID,
        error: { name: "UnknownError", data: { message: "boom" } },
      },
    } as unknown as OpencodeEvent;

    expect(eventLiveState(event)).toBe("error");
  });

  it('maps session.next.retried -> "retrying"', () => {
    const event = {
      id: "evt_8",
      type: "session.next.retried",
      properties: {
        timestamp: 1,
        sessionID: SESSION_ID,
        attempt: 2,
        error: { name: "UnknownError", data: { message: "boom" } },
      },
    } as unknown as OpencodeEvent;

    expect(eventLiveState(event)).toBe("retrying");
  });

  it('maps session.status with status.type "busy" -> "running"', () => {
    const event = {
      id: "evt_9",
      type: "session.status",
      properties: { sessionID: SESSION_ID, status: { type: "busy" } },
    } as unknown as OpencodeEvent;

    expect(eventLiveState(event)).toBe("running");
  });

  it('maps session.status with status.type "idle" -> "idle"', () => {
    const event = {
      id: "evt_10",
      type: "session.status",
      properties: { sessionID: SESSION_ID, status: { type: "idle" } },
    } as unknown as OpencodeEvent;

    expect(eventLiveState(event)).toBe("idle");
  });

  it('maps session.status with status.type "retry" -> "retrying"', () => {
    const event = {
      id: "evt_11",
      type: "session.status",
      properties: {
        sessionID: SESSION_ID,
        status: { type: "retry", attempt: 1, message: "retrying", next: 5000 },
      },
    } as unknown as OpencodeEvent;

    expect(eventLiveState(event)).toBe("retrying");
  });

  it("returns null for events that do not change live state", () => {
    const event = {
      id: "evt_12",
      type: "session.next.text.delta",
      properties: {
        timestamp: 1,
        sessionID: SESSION_ID,
        assistantMessageID: "msg_1",
        textID: "text_1",
        delta: "hello",
      },
    } as unknown as OpencodeEvent;

    expect(eventLiveState(event)).toBeNull();
  });

  it("returns null for session.created (creation, not a live-state change)", () => {
    const event = {
      id: "evt_13",
      type: "session.created",
      properties: { sessionID: SESSION_ID, info: makeSession(SESSION_ID) },
    } as unknown as OpencodeEvent;

    expect(eventLiveState(event)).toBeNull();
  });

  it("returns null for a completely unknown event type", () => {
    const event = {
      id: "evt_14",
      type: "totally.unknown.event",
      properties: {},
    } as unknown as OpencodeEvent;

    expect(eventLiveState(event)).toBeNull();
  });
});

describe("eventSessionId", () => {
  it("extracts properties.sessionID when present", () => {
    const event = {
      id: "evt_20",
      type: "session.idle",
      properties: { sessionID: SESSION_ID },
    } as unknown as OpencodeEvent;

    expect(eventSessionId(event)).toBe(SESSION_ID);
  });

  it("extracts properties.info.id when sessionID is absent", () => {
    const event = {
      id: "evt_21",
      type: "session.created",
      properties: { sessionID: SESSION_ID, info: makeSession(SESSION_ID) },
    } as unknown as OpencodeEvent;

    expect(eventSessionId(event)).toBe(SESSION_ID);
  });

  it("falls back to properties.info.id when there is no sessionID field at all", () => {
    const event = {
      id: "evt_22",
      type: "session.created",
      properties: { info: makeSession("ses_from_info_only") },
    } as unknown as OpencodeEvent;

    expect(eventSessionId(event)).toBe("ses_from_info_only");
  });

  it("returns null when properties carries neither sessionID nor info.id", () => {
    const event = {
      id: "evt_23",
      type: "installation.updated",
      properties: { version: "1.2.3" },
    } as unknown as OpencodeEvent;

    expect(eventSessionId(event)).toBeNull();
  });

  it("returns null when properties is an empty object (e.g. server.connected)", () => {
    const event = {
      id: "evt_24",
      type: "server.connected",
      properties: {},
    } as unknown as OpencodeEvent;

    expect(eventSessionId(event)).toBeNull();
  });

  it("returns null when properties is missing entirely", () => {
    const event = {
      id: "evt_25",
      type: "server.connected",
    } as unknown as OpencodeEvent;

    expect(eventSessionId(event)).toBeNull();
  });
});
