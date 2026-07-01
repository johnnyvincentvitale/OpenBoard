/**
 * Board merge service — combines live OpenCode session state (via the SDK
 * client) with the board's persisted column/position state (via the
 * ColumnStore) into the frozen `Card` DTO the frontend renders.
 */
import type { Session, SessionStatus } from "@opencode-ai/sdk/v2/types";
import { AdapterError } from "../shared/errors";
import { COLUMNS } from "../shared";
import type { Card, ColumnStore, SessionRef } from "../shared";
import type { OpencodeHandle } from "./opencode";
import { mapSessionToCard } from "./dto";

/** The OpenCode SDK client type, derived from the Phase-1 connection handle. */
export type OpencodeClientLike = OpencodeHandle["client"];

type StatusMap = Record<string, SessionStatus>;

const COLUMN_ORDER: Record<string, number> = Object.fromEntries(
  COLUMNS.map((column, index) => [column, index]),
);

function sortCards(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => {
    const columnDelta = COLUMN_ORDER[a.column] - COLUMN_ORDER[b.column];
    if (columnDelta !== 0) return columnDelta;
    return a.position - b.position;
  });
}

/**
 * Fetch all live sessions + their statuses, reconcile them against the
 * board's persisted column state, and return sorted Cards for every session.
 */
export async function buildBoardSnapshot(
  client: OpencodeClientLike,
  store: ColumnStore,
): Promise<Card[]> {
  const listResult = await client.session.list();
  if (listResult.error || !listResult.data) {
    throw AdapterError.unreachable(
      "Failed to list OpenCode sessions",
      listResult.error,
    );
  }
  const sessions: Session[] = listResult.data;

  const statusResult = await client.session.status();
  if (statusResult.error || !statusResult.data) {
    throw AdapterError.unreachable(
      "Failed to fetch OpenCode session status",
      statusResult.error,
    );
  }
  const statusMap: StatusMap = statusResult.data;

  const refs: SessionRef[] = sessions.map((s) => ({
    sessionId: s.id,
    running: statusMap[s.id]?.type === "busy",
  }));
  store.reconcile(refs);

  const rows = new Map(store.getBoard().map((row) => [row.sessionId, row]));

  const cards: Card[] = [];
  for (const session of sessions) {
    const row = rows.get(session.id);
    // Shouldn't happen after reconcile — skip defensively rather than throw.
    if (!row) continue;
    cards.push(mapSessionToCard(session, statusMap[session.id], row));
  }

  return sortCards(cards);
}

/**
 * Fetch a single session + its status, reconcile the board row for just
 * that session, and return its Card. Returns null if the session is gone.
 */
export async function buildCardForSession(
  client: OpencodeClientLike,
  store: ColumnStore,
  sessionId: string,
): Promise<Card | null> {
  const sessionResult = await client.session.get({ sessionID: sessionId });
  if (sessionResult.error || !sessionResult.data) {
    return null;
  }
  const session = sessionResult.data;

  const statusResult = await client.session.status();
  if (statusResult.error || !statusResult.data) {
    throw AdapterError.unreachable(
      "Failed to fetch OpenCode session status",
      statusResult.error,
    );
  }
  const statusMap: StatusMap = statusResult.data;

  const row = store.reconcileOne(sessionId);

  return mapSessionToCard(session, statusMap[sessionId], row);
}
