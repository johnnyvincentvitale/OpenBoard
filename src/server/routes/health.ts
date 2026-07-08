/**
 * Health route — reports adapter + upstream OpenCode reachability.
 *
 * Always responds 200 (never 503) so the frontend can render a banner even
 * when OpenCode is unreachable, rather than treating this route itself as
 * "down".
 */
import type { Hono } from "hono";
import { ROUTE_PATTERNS } from "../../shared";
import type { AdapterBuildInfo, BoardHealth, BoardIdentity } from "../../shared/health";
import type { OpencodeHandle } from "../opencode";
import type { SourceInstanceInfo } from "../../db/global-archive-store";
import { resolveAdapterBuildInfo } from "../build-info";

/** The OpenCode SDK client type, derived from the Phase-1 connection handle. */
type OpencodeClientLike = OpencodeHandle["client"];

type OpencodeHealthStatus = BoardHealth["opencode"];

/** Registers GET /api/health on the given Hono app. */
export function registerHealthRoutes(app: Hono, deps: { client: OpencodeClientLike; identity?: SourceInstanceInfo; boardTokenPresent?: boolean; build?: AdapterBuildInfo }): void {
  app.get(ROUTE_PATTERNS.health, async (c) => {
    const opencode = await checkOpencodeHealth(deps.client);
    const source: SourceInstanceInfo = deps.identity ?? { port: 4097, workspace: process.cwd(), dbPath: "board-tasks.sqlite" };
    const identity: BoardIdentity = {
      ...(source.name !== undefined ? { instanceName: source.name } : {}),
      boardUrl: `http://127.0.0.1:${source.port}`,
      port: source.port,
      workspace: source.workspace,
      dbPath: source.dbPath,
      ...(source.opencodeBaseUrl !== undefined ? { opencodeUrl: source.opencodeBaseUrl } : {}),
      ...(source.opencodeBaseUrl !== undefined ? { opencodePort: portFromUrl(source.opencodeBaseUrl) } : {}),
      boardTokenPresent: Boolean(deps.boardTokenPresent),
    };
    return c.json({ adapter: "ok", opencode, identity, build: deps.build ?? resolveAdapterBuildInfo() }, 200);
  });
}

function portFromUrl(raw: string): number | undefined {
  try {
    const port = new URL(raw).port;
    return port ? Number(port) : undefined;
  } catch {
    return undefined;
  }
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
