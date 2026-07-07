/**
 * OpenCode AI provider sync — shared normalization + fetch helper used by
 * the providers route (`GET /api/providers`) so the TUI's new-task wizard
 * can offer a live PROVIDER/MODEL picker synced to whichever AI providers
 * the connected OpenCode server currently has configured and authenticated
 * for — not just whatever models happen to already be attached to a roster
 * agent (the only source the MODEL field had before this).
 */
import type { OpencodeHandle } from "./opencode";
import type { RosterProvider } from "../shared";

type ProviderClient = OpencodeHandle["client"]["provider"];

/** Loosely-typed shapes of OpenCode's provider/model, as returned by provider.list(). */
interface OpencodeModelLike {
  id?: unknown;
  name?: unknown;
}

interface OpencodeProviderLike {
  id?: unknown;
  name?: unknown;
  models?: unknown;
}

interface ProviderListBody {
  all?: OpencodeProviderLike[];
  default?: Record<string, string>;
  connected?: string[];
}

export function toRosterProviders(body: ProviderListBody): RosterProvider[] {
  const all = Array.isArray(body.all) ? body.all : [];
  const connected = new Set(Array.isArray(body.connected) ? body.connected : []);
  const defaults = body.default ?? {};

  return all
    .filter((provider): provider is OpencodeProviderLike & { id: string } => typeof provider.id === "string" && connected.has(provider.id))
    .map((provider) => {
      const modelsRecord =
        provider.models && typeof provider.models === "object" ? (provider.models as Record<string, OpencodeModelLike>) : {};
      const models = Object.values(modelsRecord)
        .filter((model): model is OpencodeModelLike & { id: string } => typeof model?.id === "string")
        .map((model) => ({ id: model.id, name: typeof model.name === "string" ? model.name : model.id }));

      return {
        id: provider.id,
        name: typeof provider.name === "string" ? provider.name : provider.id,
        defaultModelId: defaults[provider.id],
        models,
      };
    });
}

/**
 * Fetch and normalize the live, currently-connected OpenCode AI provider
 * list (`client.provider.list()`). Best-effort: any failure — a thrown
 * error, or the SDK's own `{error}` response envelope — returns an empty
 * array, matching `GET /api/agents`' best-effort contract (see
 * `src/server/agents.ts`'s `fetchRoster`), so an unreachable/misconfigured
 * OpenCode server never turns this into a 500.
 */
export async function fetchProviders(client: { provider: ProviderClient }): Promise<RosterProvider[]> {
  try {
    const result = await client.provider.list();
    if ((result as { error?: unknown }).error) return [];
    const data = (result as { data?: ProviderListBody }).data;
    return data ? toRosterProviders(data) : [];
  } catch {
    return [];
  }
}
