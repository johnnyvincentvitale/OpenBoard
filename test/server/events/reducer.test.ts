import { describe, expect, it } from "vitest";
import type { OpencodeEvent } from "../../../src/shared";
import { classifyEvent } from "../../../src/server/events/reducer";

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

describe("classifyEvent", () => {
  it("classifies session.created", () => {
    const event = {
      id: "evt_1",
      type: "session.created",
      properties: { sessionID: SESSION_ID, info: makeSession(SESSION_ID) },
    } as unknown as OpencodeEvent;

    expect(classifyEvent(event)).toEqual({ sessionId: SESSION_ID, kind: "created" });
  });

  it("classifies session.updated", () => {
    const event = {
      id: "evt_2",
      type: "session.updated",
      properties: { sessionID: SESSION_ID, info: makeSession(SESSION_ID) },
    } as unknown as OpencodeEvent;

    expect(classifyEvent(event)).toEqual({ sessionId: SESSION_ID, kind: "updated" });
  });

  it("classifies session.deleted", () => {
    const event = {
      id: "evt_3",
      type: "session.deleted",
      properties: { sessionID: SESSION_ID, info: makeSession(SESSION_ID) },
    } as unknown as OpencodeEvent;

    expect(classifyEvent(event)).toEqual({ sessionId: SESSION_ID, kind: "deleted" });
  });

  it("classifies session.next.step.started as a live-state:running intent", () => {
    const event = {
      id: "evt_4",
      type: "session.next.step.started",
      properties: {
        timestamp: 1,
        sessionID: SESSION_ID,
        assistantMessageID: "msg_1",
        agent: "build",
        model: { id: "claude", providerID: "anthropic" },
      },
    } as unknown as OpencodeEvent;

    expect(classifyEvent(event)).toEqual({
      sessionId: SESSION_ID,
      kind: "live-state",
      liveState: "running",
    });
  });

  it("classifies session.next.tool.input.started as a live-state:running intent", () => {
    const event = {
      id: "evt_5",
      type: "session.next.tool.input.started",
      properties: {
        timestamp: 1,
        sessionID: SESSION_ID,
        assistantMessageID: "msg_1",
        callID: "call_1",
        name: "bash",
      },
    } as unknown as OpencodeEvent;

    expect(classifyEvent(event)).toEqual({
      sessionId: SESSION_ID,
      kind: "live-state",
      liveState: "running",
    });
  });

  it("classifies session.next.shell.started as a live-state:running intent", () => {
    const event = {
      id: "evt_6",
      type: "session.next.shell.started",
      properties: {
        timestamp: 1,
        sessionID: SESSION_ID,
        messageID: "msg_1",
        callID: "call_1",
        command: "ls",
      },
    } as unknown as OpencodeEvent;

    expect(classifyEvent(event)).toEqual({
      sessionId: SESSION_ID,
      kind: "live-state",
      liveState: "running",
    });
  });

  it("classifies session.idle as a live-state:idle intent", () => {
    const event = {
      id: "evt_7",
      type: "session.idle",
      properties: { sessionID: SESSION_ID },
    } as unknown as OpencodeEvent;

    expect(classifyEvent(event)).toEqual({
      sessionId: SESSION_ID,
      kind: "live-state",
      liveState: "idle",
    });
  });

  it("classifies session.next.step.ended as a live-state:idle intent", () => {
    const event = {
      id: "evt_8",
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

    expect(classifyEvent(event)).toEqual({
      sessionId: SESSION_ID,
      kind: "live-state",
      liveState: "idle",
    });
  });

  it("classifies session.error as a live-state:error intent", () => {
    const event = {
      id: "evt_9",
      type: "session.error",
      properties: {
        sessionID: SESSION_ID,
        error: { name: "UnknownError", data: { message: "boom" } },
      },
    } as unknown as OpencodeEvent;

    expect(classifyEvent(event)).toEqual({
      sessionId: SESSION_ID,
      kind: "live-state",
      liveState: "error",
    });
  });

  it("classifies session.next.step.failed as a live-state:error intent", () => {
    const event = {
      id: "evt_10",
      type: "session.next.step.failed",
      properties: {
        timestamp: 1,
        sessionID: SESSION_ID,
        assistantMessageID: "msg_1",
        error: { name: "UnknownError", data: { message: "boom" } },
      },
    } as unknown as OpencodeEvent;

    expect(classifyEvent(event)).toEqual({
      sessionId: SESSION_ID,
      kind: "live-state",
      liveState: "error",
    });
  });

  it("classifies session.next.retried as a live-state:retrying intent", () => {
    const event = {
      id: "evt_11",
      type: "session.next.retried",
      properties: {
        timestamp: 1,
        sessionID: SESSION_ID,
        attempt: 2,
        error: { name: "UnknownError", data: { message: "boom" } },
      },
    } as unknown as OpencodeEvent;

    expect(classifyEvent(event)).toEqual({
      sessionId: SESSION_ID,
      kind: "live-state",
      liveState: "retrying",
    });
  });

  it('classifies session.status busy as a live-state:running intent', () => {
    const event = {
      id: "evt_12",
      type: "session.status",
      properties: { sessionID: SESSION_ID, status: { type: "busy" } },
    } as unknown as OpencodeEvent;

    expect(classifyEvent(event)).toEqual({
      sessionId: SESSION_ID,
      kind: "live-state",
      liveState: "running",
    });
  });

  it('classifies session.status retry as a live-state:retrying intent', () => {
    const event = {
      id: "evt_13",
      type: "session.status",
      properties: {
        sessionID: SESSION_ID,
        status: { type: "retry", attempt: 1, message: "retrying", next: 5000 },
      },
    } as unknown as OpencodeEvent;

    expect(classifyEvent(event)).toEqual({
      sessionId: SESSION_ID,
      kind: "live-state",
      liveState: "retrying",
    });
  });

  it("returns null for events with no board-relevant effect (e.g. text delta)", () => {
    const event = {
      id: "evt_14",
      type: "session.next.text.delta",
      properties: {
        timestamp: 1,
        sessionID: SESSION_ID,
        assistantMessageID: "msg_1",
        textID: "text_1",
        delta: "hello",
      },
    } as unknown as OpencodeEvent;

    expect(classifyEvent(event)).toBeNull();
  });

  it("returns null for a completely unknown event type", () => {
    const event = {
      id: "evt_15",
      type: "totally.unknown.event",
      properties: { sessionID: SESSION_ID },
    } as unknown as OpencodeEvent;

    expect(classifyEvent(event)).toBeNull();
  });

  it("returns null for non-session global events (e.g. installation.updated)", () => {
    const event = {
      id: "evt_16",
      type: "installation.updated",
      properties: { version: "1.2.3" },
    } as unknown as OpencodeEvent;

    expect(classifyEvent(event)).toBeNull();
  });

  it("returns null for session.created with no extractable session id", () => {
    const event = {
      id: "evt_17",
      type: "session.created",
      properties: {},
    } as unknown as OpencodeEvent;

    expect(classifyEvent(event)).toBeNull();
  });
});
