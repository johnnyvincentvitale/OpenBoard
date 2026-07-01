/**
 * Health route — reports adapter + upstream OpenCode reachability.
 *
 * Always responds 200 (never 503) so the frontend can render a banner even
 * when OpenCode is unreachable, rather than treating this route itself as
 * "down".
 */
import type { Hono } from "hono";
import { ROUTE_PATTERNS } from "../../shared";
import type { OpencodeHandle } from "../opencode";

/** The OpenCode SDK client type, derived from the Phase-1 connection handle. */
type OpencodeClientLike = OpencodeHandle["client"];

type OpencodeHealthStatus = { status: "ok"; version: string } | { status: "unreachable" };

/** Registers GET /api/health on the given Hono app. */
export function registerHealthRoutes(app: Hono, deps: { client: OpencodeClientLike }): void {
  app.get(ROUTE_PATTERNS.health, async (c) => {
    const opencode = await checkOpencodeHealth(deps.client);
    return c.json({ adapter: "ok", opencode }, 200);
  });
}

async function checkOpencodeHealth(client: OpencodeClientLike): Promise<OpencodeHealthStatus> {
  try {
    const result = await client.global.health();
    if (result.error || !result.data?.healthy) {
      return { status: "unreachable" };
    }
    return { status: "ok", version: result.data.version };
  } catch {
    return { status: "unreachable" };
  }
}
