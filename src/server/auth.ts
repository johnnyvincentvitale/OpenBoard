/**
 * Board API token auth — resolves the token for this server process and
 * provides Hono middleware that rejects requests without a matching
 * Authorization: Bearer <token> header or ?board_token=<token> query parameter.
 *
 * Named-instance launches pass a persisted per-instance token through
 * OPENBOARD_API_TOKEN; direct/dev launches generate a random process-local
 * token when the env var is unset.
 *
 * Generated tokens are 64-char hex strings (32 random bytes). Set
 * OPENBOARD_API_TOKEN to a fixed value in env only if deterministic tokens are
 * needed (CI, pre-shared setups, or intentional token sharing).
 */
import { randomFillSync, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

const DEFAULT_TOKEN_BYTES = 32;

/** Reads the API token from env or generates a random 32-byte hex token. */
export function resolveBoardToken(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENBOARD_API_TOKEN?.trim();
  if (explicit) return explicit;
  return generateRandomHexToken(DEFAULT_TOKEN_BYTES);
}

function generateRandomHexToken(bytes: number): string {
  const buffer = Buffer.alloc(bytes);
  randomFillSync(buffer);
  return buffer.toString("hex");
}

/** Constant-time comparison of two token strings. */
export function tokensEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Hono middleware that requires a valid board API token on every request.
 *
 * Accepts the token via:
 *  - `Authorization: Bearer <token>` header, or
 *  - `?board_token=<token>` query parameter (for SSE/EventSource/WebSocket
 *    clients that cannot set custom headers). Uses `board_token` rather
 *    than `token` to avoid colliding with terminal route reservation tokens.
 *
 * Returns 401 with an `unauthorized` error envelope when the token is
 * missing or wrong.
 */
export function requireBoardToken(token: string): MiddlewareHandler {
  return async (c: Context, next) => {
    const provided = extractToken(c);
    if (!provided || !tokensEqual(provided, token)) {
      return c.json(
        { error: { code: "unauthorized", message: "Invalid or missing API token" } },
        401 as ContentfulStatusCode,
      );
    }
    await next();
  };
}

function extractToken(c: Context): string | undefined {
  const auth = c.req.header("Authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return c.req.query("board_token");
}
