import { describe, it, expect } from "vitest";
import { startOrConnect } from "../../src/server/opencode";
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
