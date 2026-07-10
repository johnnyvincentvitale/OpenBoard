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
    return { ...state, connection: state.connection === "GAP" ? "GAP" : followConnectionFromTransport(frame.transport) };
  }
  return { ...state, connection: frame.status === "error" ? "RECONNECTING" : "STATIC" };
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
