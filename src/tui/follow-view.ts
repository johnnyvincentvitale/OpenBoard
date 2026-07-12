import type { SessionActivityEvent, SessionActivityFrame, SessionActivityTransport } from "../shared";

export type FollowConnectionState = "LIVE" | "RECONNECTING" | "STATIC" | "GAP";

export interface FollowViewState {
  taskId: string;
  events: SessionActivityEvent[];
  connection: FollowConnectionState;
  autoFollow: boolean;
  scrollOffset: number;
  lastSeq?: number;
  lastRenderAt: number;
  maxEvents: number;
  gapReason?: string;
  /** Set when a frame was applied but rendering was throttled (P3-5). */
  needsTrailingFlush?: boolean;
  /**
   * Set once a terminal frame arrives. A stream that ends after the terminal
   * frame is a normal close (the run is over), not a connection loss — the
   * reconnect path must not fire for it.
   */
  terminalSeen?: boolean;
  /** Stable event/block key selected for clipboard copy. Undefined follows the newest block. */
  selectedCodeBlockKey?: string;
}

export const FOLLOW_MAX_RENDER_FPS = 10;
export const FOLLOW_RENDER_INTERVAL_MS = 1000 / FOLLOW_MAX_RENDER_FPS;

export function createFollowViewState(taskId: string, maxEvents = 500): FollowViewState {
  return { taskId, events: [], connection: "STATIC", autoFollow: true, scrollOffset: 0, lastRenderAt: 0, maxEvents };
}

export function followConnectionFromTransport(transport: SessionActivityTransport): FollowConnectionState {
  if (transport === "live") return "LIVE";
  if (transport === "reconnecting") return "RECONNECTING";
  return "STATIC";
}

export function applyFollowFrame(state: FollowViewState, frame: SessionActivityFrame): FollowViewState {
  if (frame.kind === "snapshot") {
    return trimFollowEvents({
      ...state,
      events: frame.events,
      lastSeq: frame.events.at(-1)?.seq,
      connection: followConnectionFromTransport(frame.transport),
      gapReason: undefined,
    });
  }
  if (frame.kind === "append") {
    if (state.events.some((event) => event.seq === frame.event.seq)) return state;
    return trimFollowEvents({
      ...state,
      events: [...state.events, frame.event],
      lastSeq: frame.event.seq,
      connection: state.connection === "GAP" ? "GAP" : "LIVE",
    });
  }
  if (frame.kind === "gap") {
    return { ...state, connection: "GAP", gapReason: frame.reason };
  }
  if (frame.kind === "heartbeat") {
    // A terminal run is done for good — a late heartbeat (e.g. one still
    // in flight when the terminal frame landed) must not flip the
    // connection back to LIVE.
    if (state.connection === "GAP" || state.connection === "STATIC") return state;
    return { ...state, connection: followConnectionFromTransport(frame.transport) };
  }
  // Terminal: every outcome (complete, aborted, or error) means the run is
  // over and nothing more will arrive, so all three map to STATIC — an
  // errored run isn't a connection problem to reconnect from.
  return { ...state, connection: "STATIC", terminalSeen: true };
}

/**
 * Mark the stream as lost (server restart, socket reset). Only meaningful
 * before the terminal frame — after it, a stream end is the normal close.
 */
export function markFollowDisconnected(state: FollowViewState): FollowViewState {
  if (state.terminalSeen) return state;
  return { ...state, connection: "RECONNECTING", gapReason: "stream disconnected; reconnecting..." };
}

export function shouldRenderFollowFrame(state: FollowViewState, now = Date.now()): boolean {
  return now - state.lastRenderAt >= FOLLOW_RENDER_INTERVAL_MS;
}

export function markFollowRendered(state: FollowViewState, now = Date.now()): FollowViewState {
  return { ...state, lastRenderAt: now };
}

export function setFollowManualScroll(state: FollowViewState): FollowViewState {
  return { ...state, autoFollow: false };
}

export function scrollFollow(state: FollowViewState, delta: number, windowSize: number): FollowViewState {
  const maxOffset = Math.max(0, state.events.length - Math.max(1, windowSize));
  const current = state.autoFollow ? maxOffset : state.scrollOffset;
  return { ...state, autoFollow: false, scrollOffset: Math.max(0, Math.min(maxOffset, current + delta)) };
}

export function tailFollow(state: FollowViewState): FollowViewState {
  return { ...state, autoFollow: true, scrollOffset: Math.max(0, state.events.length - 1) };
}

export function followVisibleEvents(state: FollowViewState, windowSize: number): SessionActivityEvent[] {
  const size = Math.max(1, windowSize);
  const start = state.autoFollow
    ? Math.max(0, state.events.length - size)
    : Math.max(0, Math.min(state.scrollOffset, Math.max(0, state.events.length - size)));
  return state.events.slice(start, start + size);
}

export function descendantSessionLabel(event: Pick<SessionActivityEvent, "sessionId" | "rootSessionId" | "parentSessionId">): string {
  if (event.sessionId === event.rootSessionId) return "root";
  return event.parentSessionId ? `child of ${event.parentSessionId.slice(0, 8)}` : "descendant";
}

function trimFollowEvents(state: FollowViewState): FollowViewState {
  if (state.events.length <= state.maxEvents) return state;
  return { ...state, events: state.events.slice(-state.maxEvents) };
}

/**
 * Apply a frame and set the trailing-flush flag when rendering is throttled (P3-5).
 * Returns the updated state plus whether an immediate render should occur.
 */
export function applyFollowFrameWithRender(
  state: FollowViewState,
  frame: SessionActivityFrame,
  now = Date.now(),
): { state: FollowViewState; shouldRender: boolean } {
  const next = applyFollowFrame(state, frame);
  if (shouldRenderFollowFrame(next, now)) {
    return { state: { ...next, needsTrailingFlush: false }, shouldRender: true };
  }
  return { state: { ...next, needsTrailingFlush: true }, shouldRender: false };
}

/**
 * Schedule a trailing flush after the render throttle interval (P3-5).
 * If a frame was applied but not rendered (throttled), this ensures the
 * final state is rendered after the interval, rather than depending on
 * the next heartbeat to trigger a render.
 *
 * @param state the current follow view state
 * @param onFlush called when the trailing flush fires
 * @param existingTimer an existing pending timer to cancel (if any)
 * @returns the timer handle (pass to the next call to cancel/replace)
 */
export function scheduleFollowTrailingFlush(
  state: FollowViewState,
  onFlush: () => void,
  existingTimer?: ReturnType<typeof setTimeout>,
): ReturnType<typeof setTimeout> | undefined {
  if (existingTimer) clearTimeout(existingTimer);
  if (!state.needsTrailingFlush) return undefined;
  return setTimeout(() => {
    onFlush();
  }, FOLLOW_RENDER_INTERVAL_MS);
}

/** Clear a pending trailing flush timer (P3-5). */
export function cancelFollowTrailingFlush(timer: ReturnType<typeof setTimeout> | undefined): void {
  if (timer) clearTimeout(timer);
}
