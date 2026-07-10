import { describe, expect, it } from "vitest";
import { applyFollowFrame, createFollowViewState, descendantSessionLabel, followVisibleEvents, markFollowRendered, scrollFollow, shouldRenderFollowFrame, tailFollow } from "../../src/tui/follow-view";
import type { SessionActivityEvent } from "../../src/shared";

function event(seq: number, sessionId = "root"): SessionActivityEvent {
  return { seq, taskId: "task-1", runStartedAt: 1, sessionId, rootSessionId: "root", harness: "opencode", occurredAt: seq, kind: "text", text: `line ${seq}` };
}

describe("follow view state", () => {
  it("keeps a bounded rolling buffer and truthful connection state", () => {
    let state = createFollowViewState("task-1", 2);
    state = applyFollowFrame(state, { kind: "snapshot", run: { taskId: "task-1", runStartedAt: 1, sessionId: "root", rootSessionId: "root", harness: "opencode" }, events: [event(1), event(2), event(3)], lastEventAt: 3, transport: "live" });
    expect(state.connection).toBe("LIVE");
    expect(state.events.map((item) => item.seq)).toEqual([2, 3]);

    state = applyFollowFrame(state, { kind: "gap", afterSeq: 3, reason: "evicted" });
    expect(state.connection).toBe("GAP");
    expect(state.gapReason).toBe("evicted");
  });

  it("tracks manual scroll, tail, render throttling, and descendant labels", () => {
    let state = createFollowViewState("task-1");
    state = applyFollowFrame(state, { kind: "snapshot", run: { taskId: "task-1", runStartedAt: 1, sessionId: "root", rootSessionId: "root", harness: "opencode" }, events: [event(1), event(2), event(3), event(4)], lastEventAt: 4, transport: "live" });
    expect(followVisibleEvents(state, 2).map((item) => item.seq)).toEqual([3, 4]);
    state = scrollFollow(state, -1, 2);
    expect(state.autoFollow).toBe(false);
    expect(followVisibleEvents(state, 2).map((item) => item.seq)).toEqual([2, 3]);
    state = tailFollow(state);
    expect(state.autoFollow).toBe(true);
    expect(followVisibleEvents(state, 2).map((item) => item.seq)).toEqual([3, 4]);
    expect(shouldRenderFollowFrame(state, 50)).toBe(false);
    state = markFollowRendered(state, 100);
    expect(shouldRenderFollowFrame(state, 199)).toBe(false);
    expect(shouldRenderFollowFrame(state, 200)).toBe(true);
    expect(descendantSessionLabel({ sessionId: "child-session", rootSessionId: "root", parentSessionId: "root" })).toBe("child of root");
  });
});
