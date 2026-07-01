/**
 * Card action routes — prompt, interrupt, and diff for a single session/card.
 */
import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ROUTE_PATTERNS } from "../../shared";
import type { PromptBody } from "../../shared";
import { AdapterError } from "../../shared/errors";
import type { OpencodeHandle } from "../opencode";

/** The OpenCode SDK client type, derived from the Phase-1 connection handle. */
type OpencodeClientLike = OpencodeHandle["client"];

/**
 * Registers POST /api/board/cards/:id/prompt, POST .../interrupt, and
 * GET .../diff on the given Hono app.
 */
export function registerCardActionRoutes(
  app: Hono,
  deps: { client: OpencodeClientLike },
): void {
  app.post(ROUTE_PATTERNS.cardPrompt, async (c) => {
    const id = c.req.param("id");

    try {
      let body: Partial<PromptBody>;
      try {
        body = await c.req.json();
      } catch {
        throw AdapterError.validation("Request body must be valid JSON");
      }

      if (typeof body.text !== "string" || body.text.length === 0) {
        throw AdapterError.validation("text must be a non-empty string");
      }

      const result = await deps.client.session.promptAsync({
        sessionID: id,
        parts: [{ type: "text", text: body.text }],
      });

      if (result.error) {
        throw mapSdkError(result.error);
      }

      return c.json({ ok: true }, 202);
    } catch (err) {
      const adapterError = toAdapterError(err);
      return c.json(
        adapterError.toEnvelope(),
        adapterError.status as ContentfulStatusCode,
      );
    }
  });

  app.post(ROUTE_PATTERNS.cardInterrupt, async (c) => {
    const id = c.req.param("id");

    try {
      const result = await deps.client.session.abort({ sessionID: id });

      if (result.error) {
        throw mapSdkError(result.error);
      }

      return c.json({ ok: true }, 200);
    } catch (err) {
      const adapterError = toAdapterError(err);
      return c.json(
        adapterError.toEnvelope(),
        adapterError.status as ContentfulStatusCode,
      );
    }
  });

  app.get(ROUTE_PATTERNS.cardDiff, async (c) => {
    const id = c.req.param("id");

    try {
      const result = await deps.client.session.diff({ sessionID: id });

      if (result.error || !result.data) {
        throw mapSdkError(result.error);
      }

      return c.json(result.data, 200);
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

/**
 * Maps an SDK `{error}` envelope to an AdapterError. The SDK's generated error
 * unions carry a `name` (e.g. "NotFoundError") or `_tag` (e.g. "BadRequest",
 * "InvalidRequestError") discriminant depending on the endpoint. Anything that
 * looks like "not found" maps to session_not_found; everything else is treated
 * as the upstream OpenCode server being unreachable/misbehaving.
 */
function mapSdkError(error: unknown): AdapterError {
  const name =
    error && typeof error === "object"
      ? ((error as { name?: unknown }).name ?? (error as { _tag?: unknown })._tag)
      : undefined;

  if (name === "NotFoundError") {
    return AdapterError.notFound();
  }

  return AdapterError.unreachable("OpenCode request failed", error);
}
