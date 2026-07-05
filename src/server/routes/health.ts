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
import type { SourceInstanceInfo } from "../../db/global-archive-store";

/** The OpenCode SDK client type, derived from the Phase-1 connection handle. */
type OpencodeClientLike = OpencodeHandle["client"];

type OpencodeHealthStatus = { status: "ok"; version: string } | { status: "unreachable" };

export interface BoardIdentity {
  instanceName?: string;
  boardUrl: string;
  port: number;
  workspace: string;
  dbPath: string;
  boardTokenPresent: boolean;
}

/** Registers GET /api/health on the given Hono app. */
export function registerHealthRoutes(app: Hono, deps: { client: OpencodeClientLike; identity?: SourceInstanceInfo; boardTokenPresent?: boolean }): void {
  app.get(ROUTE_PATTERNS.health, async (c) => {
    const opencode = await checkOpencodeHealth(deps.client);
    const source = deps.identity ?? { port: 4097, workspace: process.cwd(), dbPath: "board-tasks.sqlite" };
    const identity: BoardIdentity = {
      ...(source.name !== undefined ? { instanceName: source.name } : {}),
      boardUrl: `http://127.0.0.1:${source.port}`,
      port: source.port,
      workspace: source.workspace,
      dbPath: source.dbPath,
      boardTokenPresent: Boolean(deps.boardTokenPresent),
    };
    return c.json({ adapter: "ok", opencode, identity }, 200);
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
