/**
 * The live runtime state of a session, derived from client.session.status() (REST
 * snapshot) and the flat /event stream (live patches). One name, one enum — frozen.
 */
export const LIVE_STATES = ["running", "idle", "retrying", "error", "unknown"] as const;
export type LiveState = (typeof LIVE_STATES)[number];

export function isLiveState(value: unknown): value is LiveState {
  return typeof value === "string" && (LIVE_STATES as readonly string[]).includes(value);
}
