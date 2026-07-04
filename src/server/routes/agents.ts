/**
 * Agents roster route — proxies OpenCode's own agent roster
 * (`GET /api/agent`, singular) into the board's assignable-agent list
 * (`GET /api/agents`, plural). Best-effort: any failure (network error,
 * non-ok response, bad JSON) yields [] rather than a 500, so the roster
 * never breaks the board.
 */
import type { Hono } from "hono";
import { fetchRoster } from "../agents";

/** Registers GET /api/agents on the given Hono app. */
export function registerAgentRoutes(app: Hono, deps: { baseUrl: string }): void {
  app.get("/api/agents", async (c) => {
    const roster = await fetchRoster(deps.baseUrl);
    return c.json(roster, 200);
  });
}
