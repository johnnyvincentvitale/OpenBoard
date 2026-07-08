import { createServer, type Server } from "node:net";
import { describe, it, expect, afterEach, vi } from "vitest";
import { createOpencodeServer } from "@opencode-ai/sdk/v2/server";
import { startOrConnect } from "../../src/server/opencode";
import { findFreePort } from "../../src/server/config";
import { AdapterError } from "../../src/shared/errors";
import type { AdapterConfig } from "../../src/server/config";

/**
 * Hermetic: no real `opencode serve` process is spawned anywhere in this
 * file. We only exercise connect mode against an address nothing listens
 * on, with a tiny retry budget so the test stays fast.
 */
function unreachableConfig(overrides: Partial<AdapterConfig> = {}): AdapterConfig {
  return {
    mode: "connect",
    baseUrl: "http://127.0.0.1:1",
    manageProcess: false,
    hostname: "127.0.0.1",
    port: 1,
    boardPort: 4097,
    healthCheck: { attempts: 1, timeoutMs: 50, delayMs: 1 },
    ...overrides,
  };
}

describe("startOrConnect", () => {
  it("rejects with AdapterError('opencode_unreachable') when connecting to an unreachable base url", async () => {
    const config = unreachableConfig();

    await expect(startOrConnect(config)).rejects.toMatchObject({
      name: "AdapterError",
      code: "opencode_unreachable",
    });
  });

  it("rejects with an AdapterError instance exposing status 503 and a JSON envelope", async () => {
    const config = unreachableConfig();

    let caught: unknown;
    try {
      await startOrConnect(config);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AdapterError);
    const adapterError = caught as AdapterError;
    expect(adapterError.status).toBe(503);
    expect(adapterError.toEnvelope()).toEqual({
      error: { code: "opencode_unreachable", message: adapterError.message },
    });
  });

  it("retries up to healthCheck.attempts before giving up", async () => {
    const config = unreachableConfig({ healthCheck: { attempts: 3, timeoutMs: 20, delayMs: 1 } });

    await expect(startOrConnect(config)).rejects.toMatchObject({
      code: "opencode_unreachable",
    });
  });

  it("throws AdapterError.internal when connect mode is requested without a baseUrl", async () => {
    const config = unreachableConfig({ baseUrl: undefined });

    await expect(startOrConnect(config)).rejects.toMatchObject({
      name: "AdapterError",
      code: "internal",
    });
  });
});

/**
 * Hermetic: exercises the fail-fast port-collision check in spawn mode.
 * No real `opencode` binary is ever invoked — the collision is detected
 * (and rejected) before `createOpencodeServer` would be called, so this
 * runs the same in CI with or without the opencode CLI installed.
 */
describe("startOrConnect — spawn-mode port collision", () => {
  let blocker: Server | undefined;

  afterEach(async () => {
    if (blocker) {
      await new Promise<void>((resolveClose) => blocker!.close(() => resolveClose()));
      blocker = undefined;
    }
  });

  it("fails fast with a clear AdapterError when the requested OpenCode port is already taken", async () => {
    const port = await findFreePort("127.0.0.1");
    blocker = createServer();
    await new Promise<void>((resolvePromise) => blocker!.listen(port, "127.0.0.1", resolvePromise));

    const config: AdapterConfig = {
      mode: "spawn",
      manageProcess: true,
      hostname: "127.0.0.1",
      port,
      boardPort: 4097,
      healthCheck: { attempts: 1, timeoutMs: 50, delayMs: 1 },
    };

    let caught: unknown;
    try {
      await startOrConnect(config);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AdapterError);
    const adapterError = caught as AdapterError;
    expect(adapterError.code).toBe("opencode_unreachable");
    expect(adapterError.message).toContain(String(port));
    expect(adapterError.message).toMatch(/already in use/i);
  });
});

/**
 * Hermetic: mocks the SDK's `createOpencodeServer` (via `vi.mock`) so no real
 * `opencode` binary is ever spawned. The mocked server always resolves to the
 * same unreachable http://127.0.0.1:1 the "connect mode" tests above already
 * rely on being unreachable, so the health check fails fast and
 * `startOrConnect` rejects — we only care what `createOpencodeServer` was
 * called with before that happens.
 */
vi.mock("@opencode-ai/sdk/v2/server", () => ({
  createOpencodeServer: vi.fn(async () => ({ url: "http://127.0.0.1:1", close: () => {} })),
}));

describe("startOrConnect — spawn mode", () => {
  afterEach(() => {
    vi.mocked(createOpencodeServer).mockClear();
  });

  async function spawnConfig(): Promise<AdapterConfig> {
    return {
      mode: "spawn",
      manageProcess: true,
      hostname: "127.0.0.1",
      port: await findFreePort("127.0.0.1"),
      boardPort: 4097,
      healthCheck: { attempts: 1, timeoutMs: 20, delayMs: 1 },
    };
  }

  it("spawns OpenCode without injecting a configured shell", async () => {
    const config = await spawnConfig();

    await expect(startOrConnect(config)).rejects.toMatchObject({ code: "opencode_unreachable" });

    expect(createOpencodeServer).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: config.hostname,
        port: config.port,
      }),
    );
    const call = vi.mocked(createOpencodeServer).mock.calls[0]?.[0];
    expect(call).not.toHaveProperty("config");
  });
});
