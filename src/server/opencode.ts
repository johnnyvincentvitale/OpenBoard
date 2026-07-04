/**
 * OpenCode server connection — either attaches to an already-running
 * `opencode serve` process (connect mode) or spawns one (spawn mode),
 * verifies reachability with a health check, and hands back a client +
 * shutdown handle.
 */
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { createOpencodeServer } from "@opencode-ai/sdk/v2/server";
import { AdapterError } from "../shared/errors";
import { assertPortFree, ConfigError } from "./config";
import type { AdapterConfig } from "./config";

export interface OpencodeHandle {
  client: OpencodeClient;
  baseUrl: string;
  shutdown(): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll client.global.health() with a short retry/backoff. Resolves when the
 * server reports healthy; throws AdapterError.unreachable() if every
 * attempt fails or times out.
 */
async function waitForHealthy(
  client: OpencodeClient,
  healthCheck: AdapterConfig["healthCheck"],
): Promise<void> {
  const { attempts, timeoutMs, delayMs } = healthCheck;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await client.global.health({ signal: AbortSignal.timeout(timeoutMs) });
      if (!result.error && result.data?.healthy) {
        return;
      }
      lastError = result.error ?? new Error("Health check returned unhealthy");
    } catch (err) {
      lastError = err;
    }

    if (attempt < attempts) {
      await sleep(delayMs);
    }
  }

  throw AdapterError.unreachable(
    `OpenCode server did not become healthy after ${attempts} attempt(s)`,
    lastError,
  );
}

/**
 * Start (spawn mode) or connect to (connect mode) the OpenCode server,
 * verify it is reachable, and return a handle with a ready client.
 */
export async function startOrConnect(config: AdapterConfig): Promise<OpencodeHandle> {
  if (config.mode === "connect") {
    const baseUrl = config.baseUrl;
    if (!baseUrl) {
      throw AdapterError.internal("connect mode requires config.baseUrl");
    }

    const client = createOpencodeClient({ baseUrl });
    await waitForHealthy(client, config.healthCheck);

    return {
      client,
      baseUrl,
      // Connect mode never owns the remote process's lifecycle.
      shutdown: async () => {},
    };
  }

  // Spawn mode: start our own `opencode serve` process. Fail fast — before
  // spawning any child process — if the requested port is already taken, so
  // a second instance never produces a half-started, silently-duplicate
  // adapter fighting the first for the same OpenCode backend.
  try {
    await assertPortFree(config.port, config.hostname);
  } catch (err) {
    if (err instanceof ConfigError) {
      throw AdapterError.unreachable(err.message, err);
    }
    throw err;
  }

  let server: { url: string; close(): void };
  try {
    server = await createOpencodeServer({
      hostname: config.hostname,
      port: config.port,
    });
  } catch (err) {
    throw AdapterError.unreachable("Failed to spawn OpenCode server", err);
  }

  const client = createOpencodeClient({ baseUrl: server.url });

  try {
    await waitForHealthy(client, config.healthCheck);
  } catch (err) {
    server.close();
    throw err;
  }

  return {
    client,
    baseUrl: server.url,
    shutdown: async () => {
      if (config.manageProcess) {
        server.close();
      }
    },
  };
}
