import type { Session, SessionStatus } from "@opencode-ai/sdk/v2/types";
import type {
  BoardRow,
  Card,
  CompletionReport,
  CompletionSource,
  LiveState,
  Task,
} from "../shared";

export interface TaskDto extends Task {
  archived: boolean;
  parentIds: string[];
  completion: CompletionReport | null;
  completionSource: CompletionSource | null;
}

export function mapTaskToDto(task: Task): TaskDto {
  return {
    ...task,
    archived: task.archived ?? false,
    parentIds: [...(task.parentIds ?? [])],
    completion: task.completion
      ? {
          ...task.completion,
          changedFiles: [...task.completion.changedFiles],
          verification: task.completion.verification.map((v) => ({ ...v })),
        }
      : null,
    completionSource: task.completionSource ?? null,
  };
}

/**
 * Derives the board's `LiveState` from a REST-snapshot `SessionStatus`.
 *
 * `SessionStatus` (types.gen.d.ts ~line 504) is a 3-member discriminated union:
 * - `{ type: "idle" }`          -> "idle"
 * - `{ type: "retry"; ... }`    -> "retrying"
 * - `{ type: "busy" }`          -> "running" (the union's only active/working variant)
 *
 * There is no "error" member on `SessionStatus` itself (session errors arrive via the
 * separate `session.error` event, not as a status type) — any unrecognized/future variant
 * defaults to "error" defensively so the board surfaces something is wrong rather than
 * silently misreporting "idle". `undefined` (no status yet observed) -> "unknown".
 * Never throws.
 */
export function liveStateFromStatus(status: SessionStatus | undefined): LiveState {
  if (status === undefined || status === null) {
    return "unknown";
  }

  switch (status.type) {
    case "idle":
      return "idle";
    case "retry":
      return "retrying";
    case "busy":
      return "running";
    default:
      return "error";
  }
}

/**
 * Maps an OpenCode `Session` + its latest `SessionStatus` + the board's persisted
 * `BoardRow` into the frozen `Card` DTO. Never throws on missing optional fields —
 * every optional Session field is defaulted.
 */
export function mapSessionToCard(
  session: Session,
  status: SessionStatus | undefined,
  row: BoardRow,
): Card {
  return {
    sessionId: session.id,
    title: session.title ?? "",
    directory: session.directory ?? "",
    agent: session.agent,
    model: session.model
      ? { id: session.model.id, providerID: session.model.providerID }
      : undefined,
    cost: session.cost ?? 0,
    additions: session.summary?.additions ?? 0,
    deletions: session.summary?.deletions ?? 0,
    files: session.summary?.files ?? 0,
    column: row.column,
    position: row.position,
    liveState: liveStateFromStatus(status),
    updatedAt: session.time?.updated ?? row.updatedAt,
  };
}
