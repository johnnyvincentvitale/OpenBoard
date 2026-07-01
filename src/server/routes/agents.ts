/**
 * Agents roster route — proxies OpenCode's own agent roster
 * (`GET /api/agent`, singular) into the board's assignable-agent list
 * (`GET /api/agents`, plural). Best-effort: any failure (network error,
 * non-ok response, bad JSON) yields [] rather than a 500, so the roster
 * never breaks the board.
 */
import type { Hono } from "hono";
import type { RosterAgent } from "../../shared";

/** Loosely-typed shape of an OpenCode agent, as returned by GET /api/agent. */
interface OpencodeAgentLike {
  id?: unknown;
  name?: unknown;
  mode?: unknown;
  description?: unknown;
  model?: unknown;
}

function toRosterAgent(a: OpencodeAgentLike): RosterAgent {
  return {
    id: (a.id ?? a.name) as RosterAgent["id"],
    mode: a.mode as RosterAgent["mode"],
    description: a.description as RosterAgent["description"],
    model: a.model as RosterAgent["model"],
  };
}

/** Registers GET /api/agents on the given Hono app. */
export function registerAgentRoutes(app: Hono, deps: { baseUrl: string }): void {
  app.get("/api/agents", async (c) => {
    try {
      const res = await fetch(`${deps.baseUrl}/api/agent`);
      if (!res.ok) {
        return c.json([] as RosterAgent[], 200);
      }

      const body = (await res.json()) as unknown;
      const list: OpencodeAgentLike[] = Array.isArray(body)
        ? body
        : ((body as { data?: OpencodeAgentLike[] })?.data ?? []);

      const roster = list.map(toRosterAgent);
      return c.json(roster, 200);
    } catch {
      return c.json([] as RosterAgent[], 200);
    }
  });
}
