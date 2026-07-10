import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyFollowFrame, applyFollowFrameWithRender, cancelFollowTrailingFlush, createFollowViewState, descendantSessionLabel, followVisibleEvents, FOLLOW_RENDER_INTERVAL_MS, markFollowRendered, scheduleFollowTrailingFlush, scrollFollow, shouldRenderFollowFrame, tailFollow } from "../../src/tui/follow-view";
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

describe("follow view trailing flush (P3-5)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks a throttled frame as needing a trailing flush instead of rendering immediately", () => {
    let state = createFollowViewState("task-1");
    state = markFollowRendered(state, 100);
    const result = applyFollowFrameWithRender(
      state,
      { kind: "snapshot", run: { taskId: "task-1", runStartedAt: 1, sessionId: "root", rootSessionId: "root", harness: "opencode" }, events: [event(1)], lastEventAt: 1, transport: "live" },
      150, // within the throttle window relative to lastRenderAt=100
    );
    expect(result.shouldRender).toBe(false);
    expect(result.state.needsTrailingFlush).toBe(true);
  });

  it("renders immediately and clears the trailing-flush flag once outside the throttle window", () => {
    let state = createFollowViewState("task-1");
    state = markFollowRendered(state, 100);
    const result = applyFollowFrameWithRender(
      state,
      { kind: "snapshot", run: { taskId: "task-1", runStartedAt: 1, sessionId: "root", rootSessionId: "root", harness: "opencode" }, events: [event(1)], lastEventAt: 1, transport: "live" },
      100 + FOLLOW_RENDER_INTERVAL_MS,
    );
    expect(result.shouldRender).toBe(true);
    expect(result.state.needsTrailingFlush).toBe(false);
  });

  it("schedules a flush callback that fires after the render interval when a frame was throttled", () => {
    const onFlush = vi.fn();
    const state = { ...createFollowViewState("task-1"), needsTrailingFlush: true };
    const timer = scheduleFollowTrailingFlush(state, onFlush);
    expect(timer).toBeDefined();
    expect(onFlush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(FOLLOW_RENDER_INTERVAL_MS);
    expect(onFlush).toHaveBeenCalledOnce();
  });

  it("does not schedule a flush when the frame was already rendered", () => {
    const onFlush = vi.fn();
    const state = { ...createFollowViewState("task-1"), needsTrailingFlush: false };
    const timer = scheduleFollowTrailingFlush(state, onFlush);
    expect(timer).toBeUndefined();
    vi.advanceTimersByTime(FOLLOW_RENDER_INTERVAL_MS * 2);
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("cancels a stale pending timer when scheduling a new one, so only the latest flush fires", () => {
    const firstFlush = vi.fn();
    const secondFlush = vi.fn();
    const state = { ...createFollowViewState("task-1"), needsTrailingFlush: true };
    const firstTimer = scheduleFollowTrailingFlush(state, firstFlush);
    const secondTimer = scheduleFollowTrailingFlush(state, secondFlush, firstTimer);
    vi.advanceTimersByTime(FOLLOW_RENDER_INTERVAL_MS);
    expect(firstFlush).not.toHaveBeenCalled();
    expect(secondFlush).toHaveBeenCalledOnce();
    cancelFollowTrailingFlush(secondTimer);
  });

  it("cancelFollowTrailingFlush clears a pending timer so it never fires", () => {
    const onFlush = vi.fn();
    const state = { ...createFollowViewState("task-1"), needsTrailingFlush: true };
    const timer = scheduleFollowTrailingFlush(state, onFlush);
    cancelFollowTrailingFlush(timer);
    vi.advanceTimersByTime(FOLLOW_RENDER_INTERVAL_MS * 2);
    expect(onFlush).not.toHaveBeenCalled();
  });
});
