/**
 * AI provider roster route — proxies OpenCode's live provider list
 * (`client.provider.list()`) into the board's provider sync endpoint
 * (`GET /api/providers`). Best-effort: any failure (network error, bad
 * response shape) yields [] rather than a 500, matching `GET /api/agents`.
 */
import type { Hono } from "hono";
import type { OpencodeHandle } from "../opencode";
import { fetchProviders } from "../providers";

/** Registers GET /api/providers on the given Hono app. */
export function registerProviderRoutes(app: Hono, deps: { client: OpencodeHandle["client"] }): void {
  app.get("/api/providers", async (c) => {
    const providers = await fetchProviders(deps.client);
    return c.json(providers, 200);
  });
}
