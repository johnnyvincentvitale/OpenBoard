/**
 * OpenCode agent roster access — shared normalization + fetch helper used by
 * the agents route (`GET /api/agents`) and the task create route when it needs
 * to materialize a concrete model from an assigned agent.
 */
import type { RosterAgent } from "../shared";
import { AdapterError } from "../shared/errors";

/** Loosely-typed shape of an OpenCode agent, as returned by GET /api/agent. */
interface OpencodeAgentLike {
  id?: unknown;
  name?: unknown;
  mode?: unknown;
  description?: unknown;
  model?: unknown;
}

export function toRosterAgent(a: OpencodeAgentLike): RosterAgent {
  return {
    id: (a.id ?? a.name) as RosterAgent["id"],
    mode: a.mode as RosterAgent["mode"],
    description: a.description as RosterAgent["description"],
    model: a.model as RosterAgent["model"],
  };
}

/**
 * Fetch and normalize the live OpenCode agent roster (`GET /api/agent`).
 * Any failure (network error, non-ok response, bad JSON) returns an empty array,
 * matching the best-effort behavior of `GET /api/agents`.
 */
export async function fetchRoster(baseUrl: string): Promise<RosterAgent[]> {
  try {
    return await fetchRosterStrict(baseUrl);
  } catch {
    return [];
  }
}

/**
 * Fetch the live roster for create-time agent validation/model resolution.
 * Unlike GET /api/agents' best-effort contract, failures here are surfaced so
 * callers do not misreport an unreachable OpenCode server as an unknown agent.
 */
export async function fetchRosterStrict(baseUrl: string): Promise<RosterAgent[]> {
  try {
    const res = await fetch(`${baseUrl}/api/agent`);
    if (!res.ok) {
      throw AdapterError.unreachable(`OpenCode agent roster fetch failed (${res.status})`);
    }

    const body = (await res.json()) as unknown;
    const list: OpencodeAgentLike[] = Array.isArray(body)
      ? body
      : ((body as { data?: OpencodeAgentLike[] })?.data ?? []);

    return list.map(toRosterAgent);
  } catch (err) {
    if (err instanceof AdapterError) throw err;
    throw AdapterError.unreachable("OpenCode agent roster is unreachable", err);
  }
}
