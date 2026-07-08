import type { Event as OpencodeEvent } from "@opencode-ai/sdk/v2/types";
import type { LiveState } from "../../shared";
import { eventLiveState, eventSessionId } from "./session-status";

/**
 * The board-relevant intent classified from a single flat `/event` frame. Pure
 * classification result — no side effects, no store access.
 */
export type BoardEventIntent =
  | { sessionId: string; kind: "created" }
  | { sessionId: string; kind: "updated" }
  | { sessionId: string; kind: "deleted" }
  | { sessionId: string; kind: "live-state"; liveState: LiveState };

/**
 * Classifies a flat OpenCode `/event` frame into a `BoardEventIntent`, or `null` if the
 * event has no board-relevant effect (unknown event, no session id, or no live-state
 * change).
 *
 * - `session.created` -> created
 * - `session.updated` -> updated
 * - `session.deleted` -> deleted
 * - any event for which `eventLiveState` returns a `LiveState` (session.next.*,
 *   session.status, session.idle, session.error, etc.) -> live-state
 * - everything else -> null
 */
export function classifyEvent(event: OpencodeEvent): BoardEventIntent | null {
  const sessionId = eventSessionId(event);

  switch (event.type) {
    case "session.created":
      return sessionId ? { sessionId, kind: "created" } : null;
    case "session.updated":
      return sessionId ? { sessionId, kind: "updated" } : null;
    case "session.deleted":
      return sessionId ? { sessionId, kind: "deleted" } : null;
    default:
      break;
  }

  if (!sessionId) {
    return null;
  }

  const liveState = eventLiveState(event);
  if (liveState === null) {
    return null;
  }

  return { sessionId, kind: "live-state", liveState };
}
