import type { Event as OpencodeEvent } from "@opencode-ai/sdk/v2/types";
import type { LiveState } from "../../shared";

/**
 * Derives the board's `LiveState` from a single flat `/event` frame, or `null` if the
 * event does not change live state (e.g. text deltas, message parts, non-session events).
 *
 * Mapping (per the flat OpenCode Event union, `types.gen.d.ts`):
 * - step started / tool-input started / shell started -> "running"
 * - step ended / session.idle -> "idle"
 * - step failed / session.error -> "error"
 * - session.next.retried -> "retrying"
 * - session.status carries a `SessionStatus` (`idle` | `retry` | `busy`) -> idle/retrying/running
 */
export function eventLiveState(event: OpencodeEvent): LiveState | null {
  switch (event.type) {
    case "session.next.step.started":
    case "session.next.tool.input.started":
    case "session.next.shell.started":
      return "running";

    case "session.next.step.ended":
    case "session.idle":
      return "idle";

    case "session.next.step.failed":
    case "session.error":
      return "error";

    case "session.next.retried":
      return "retrying";

    case "session.status": {
      const status = event.properties.status;
      switch (status.type) {
        case "idle":
          return "idle";
        case "retry":
          return "retrying";
        case "busy":
          return "running";
        default:
          return null;
      }
    }

    default:
      return null;
  }
}

/**
 * Extracts the session id a flat `/event` frame pertains to, or `null` if the event
 * carries no session id (e.g. global/installation/server events).
 */
export function eventSessionId(event: OpencodeEvent): string | null {
  const properties = (event as { properties?: unknown }).properties;
  if (properties === null || typeof properties !== "object") {
    return null;
  }

  const props = properties as Record<string, unknown>;

  if (typeof props.sessionID === "string") {
    return props.sessionID;
  }

  const info = props.info;
  if (info !== null && typeof info === "object") {
    const id = (info as Record<string, unknown>).id;
    if (typeof id === "string") {
      return id;
    }
  }

  return null;
}
