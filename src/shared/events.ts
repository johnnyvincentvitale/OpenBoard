import type { Event as OpencodeEvent } from "@opencode-ai/sdk/v2/types";
import type { Card } from "./card";

/**
 * The OpenCode global /event stream emits a FLAT union: each frame is
 * `{ id, type, properties }` with a dotted `type` string (verified live + against the
 * installed SDK `Event` type). Reducers switch on `event.type`. This is NOT the
 * `SyncEvent*`-wrapped shape (that is a separate, per-session/durable stream).
 */
export type { OpencodeEvent };

/** The dotted `type` prefixes that concern the board. */
export const BOARD_EVENT_PREFIXES = ["session.", "server."] as const;

/**
 * SSE frames the adapter pushes to the browser. A snapshot on connect, then
 * incremental patches, plus heartbeats. `seq` monotonically increases and drives
 * ring-buffer replay on reconnect.
 */
export type BoardFrame =
  | { kind: "snapshot"; seq: number; cards: Card[] }
  | { kind: "upsert"; seq: number; card: Card }
  | { kind: "remove"; seq: number; sessionId: string }
  | { kind: "heartbeat"; seq: number };
