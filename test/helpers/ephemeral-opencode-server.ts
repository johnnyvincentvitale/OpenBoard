/**
 * Test-only helper — spawns a real, ephemeral `opencode serve` process via
 * the SDK's in-process server factory, bound to a random free port on
 * 127.0.0.1. Used by Phase-4 integration tests to exercise the real server
 * pipeline (adapter app + EventBridge + SDK client) against a real
 * OpenCode backend, without touching any developer-owned OpenCode instance.
 */
import { createOpencodeServer } from "@opencode-ai/sdk/v2/server";

export interface EphemeralOpencodeServer {
  url: string;
  close: () => Promise<void>;
}

const HOSTNAME = "127.0.0.1";
const RANDOM_PORT_MIN = 41000;
const RANDOM_PORT_MAX = 48999;
const RETRY_ATTEMPTS = 3;

function randomPort(): number {
  return RANDOM_PORT_MIN + Math.floor(Math.random() * (RANDOM_PORT_MAX - RANDOM_PORT_MIN + 1));
}

async function closeServer(server: { close(): void }): Promise<void> {
  await server.close();
}

/**
 * Spawns a real `opencode serve` process (in-process via the SDK's server
 * factory) on a random free port and returns its base URL + a close handle.
 *
 * Tries `port: 0` (ask the OS for a free port) first; if the installed SDK
 * version rejects that, falls back to a few random-port retries within
 * 41000-48999.
 */
export async function startEphemeralOpencodeServer(): Promise<EphemeralOpencodeServer> {
  try {
    const server = await createOpencodeServer({ hostname: HOSTNAME, port: 0 });
    return { url: server.url, close: () => closeServer(server) };
  } catch {
    // Fall through to random-port retries below.
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      const server = await createOpencodeServer({ hostname: HOSTNAME, port: randomPort() });
      return { url: server.url, close: () => closeServer(server) };
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to start ephemeral OpenCode server");
}

/**
 * Returns true if an ephemeral OpenCode server can actually be started in
 * this environment (the `opencode` binary/runtime is available). Integration
 * tests call this to self-skip when it isn't, so CI without the binary stays
 * green.
 */
export async function opencodeAvailable(): Promise<boolean> {
  try {
    const server = await startEphemeralOpencodeServer();
    await server.close();
    return true;
  } catch {
    return false;
  }
}
