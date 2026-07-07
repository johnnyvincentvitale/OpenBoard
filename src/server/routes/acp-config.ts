import type { Hono } from "hono";
import { TASK_HARNESSES, type AcpConfigCatalog, type AcpModelCatalog, type AcpTaskHarness } from "../../shared";
import { discoverAcpConfig } from "../claude-acp-runner";

const ACP_HARNESSES = TASK_HARNESSES.filter((harness): harness is AcpTaskHarness => harness !== "opencode");
const CACHE_TTL_MS = 30_000;

let cache: { expiresAt: number; catalog: AcpConfigCatalog } | undefined;
let inFlight: Promise<AcpConfigCatalog> | undefined;

export function registerAcpConfigRoutes(app: Hono, deps: { cwd: string }): void {
  app.get("/api/acp-config", async (c) => {
    const catalog = await getCatalog(deps.cwd);
    return c.json(catalog, 200);
  });

  app.get("/api/acp-models", async (c) => {
    const catalog = await getCatalog(deps.cwd);
    const models: AcpModelCatalog = {};
    for (const [harness, config] of Object.entries(catalog)) {
      models[harness as AcpTaskHarness] = config?.models ?? [];
    }
    return c.json(models, 200);
  });
}

async function getCatalog(cwd: string): Promise<AcpConfigCatalog> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.catalog;

  inFlight ??= discoverCatalog(cwd).finally(() => {
    inFlight = undefined;
  });
  const catalog = await inFlight;
  cache = { catalog, expiresAt: Date.now() + CACHE_TTL_MS };
  return catalog;
}

async function discoverCatalog(cwd: string): Promise<AcpConfigCatalog> {
  const entries = await Promise.all(
    ACP_HARNESSES.map(async (harness) => {
      try {
        return [harness, await discoverAcpConfig(harness, { cwd, timeoutMs: 3500 })] as const;
      } catch (error) {
        const message = error instanceof Error ? error.message : "ACP discovery failed";
        return [harness, { available: false, modes: [], models: [], options: [], error: message }] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}
