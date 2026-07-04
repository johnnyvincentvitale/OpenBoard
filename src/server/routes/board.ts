/**
 * Board routes — GET the merged board snapshot and POST card moves.
 */
import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ROUTE_PATTERNS, isColumn } from "../../shared";
import type { ColumnStore, MoveCardBody } from "../../shared";
import { AdapterError } from "../../shared/errors";
import type { OpencodeHandle } from "../opencode";
import { buildBoardSnapshot } from "../board-service";

/** The OpenCode SDK client type, derived from the Phase-1 connection handle. */
type OpencodeClientLike = OpencodeHandle["client"];

/** Registers GET /api/board and POST /api/board/cards/:id/move on the given Hono app. */
export function registerBoardRoutes(
  app: Hono,
  deps: { client: OpencodeClientLike; store: ColumnStore },
): void {
  app.get(ROUTE_PATTERNS.board, async (c) => {
    try {
      const cards = await buildBoardSnapshot(deps.client, deps.store);
      return c.json(cards, 200);
    } catch (err) {
      const adapterError = toAdapterError(err);
      return c.json(
        adapterError.toEnvelope(),
        adapterError.status as ContentfulStatusCode,
      );
    }
  });

  app.post(ROUTE_PATTERNS.cardMove, async (c) => {
    const id = c.req.param("id");

    try {
      let body: Partial<MoveCardBody>;
      try {
        body = await c.req.json();
      } catch {
        throw AdapterError.validation("Request body must be valid JSON");
      }

      const { column, position } = body;

      if (!isColumn(column)) {
        throw AdapterError.validation(`Invalid column: ${String(column)}`);
      }
      if (typeof position !== "number" || !Number.isFinite(position)) {
        throw AdapterError.validation("position must be a finite number");
      }

      deps.store.moveCard(id, column, position);

      const cards = await buildBoardSnapshot(deps.client, deps.store);
      return c.json(cards, 200);
    } catch (err) {
      const adapterError = toAdapterError(err);
      return c.json(
        adapterError.toEnvelope(),
        adapterError.status as ContentfulStatusCode,
      );
    }
  });
}

/** Normalize any thrown value into an AdapterError, wrapping unexpected errors as internal. */
function toAdapterError(err: unknown): AdapterError {
  if (err instanceof AdapterError) return err;
  return AdapterError.internal("Unexpected error", err);
}
