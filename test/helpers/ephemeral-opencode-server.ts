/**
 * Test-only helper — spawns a real, ephemeral `opencode serve` on a random free
 * port on 127.0.0.1, backed by an ISOLATED throwaway database so integration
 * tests never touch the developer's real OpenCode session store.
 *
 * Isolation: opencode honors `OPENCODE_DB` for its store location (verified). We
 * point it at a unique temp file per server and delete that temp dir on close.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * Spawn one opencode server bound to an isolated `OPENCODE_DB`. The env override
 * is set only around the spawn (opencode opens the DB at startup), then restored,
 * so it never leaks to the rest of the test process.
 */
async function createIsolated(port: number): Promise<EphemeralOpencodeServer> {
  const dir = mkdtempSync(join(tmpdir(), "opencode-board-it-"));
  const previous = process.env.OPENCODE_DB;
  process.env.OPENCODE_DB = join(dir, "opencode.db");
  let server: { url: string; close(): void };
  try {
    server = await createOpencodeServer({ hostname: HOSTNAME, port });
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_DB;
    else process.env.OPENCODE_DB = previous;
  }

  return {
    url: server.url,
    close: async () => {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Spawns a real, isolated `opencode serve` on a random free port. Tries `port: 0`
 * (ask the OS for a free port) first; falls back to random-port retries.
 */
export async function startEphemeralOpencodeServer(): Promise<EphemeralOpencodeServer> {
  try {
    return await createIsolated(0);
  } catch {
    // Fall through to random-port retries.
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      return await createIsolated(randomPort());
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to start ephemeral OpenCode server");
}

/**
 * Returns true if an isolated ephemeral OpenCode server can be started here.
 * Integration tests call this to self-skip when the binary/runtime is absent,
 * so CI without opencode stays green.
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
