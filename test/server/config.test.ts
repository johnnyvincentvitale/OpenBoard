import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/server/config";
import { OPENCODE_DEFAULTS, BOARD_SERVER_DEFAULTS } from "../../src/shared/opencode-defaults";

describe("loadConfig", () => {
  it("defaults to spawn mode with OPENCODE_DEFAULTS and BOARD_SERVER_DEFAULTS when env is empty", () => {
    const config = loadConfig({});
    expect(config.mode).toBe("spawn");
    expect(config.baseUrl).toBeUndefined();
    expect(config.manageProcess).toBe(true);
    expect(config.hostname).toBe(OPENCODE_DEFAULTS.hostname);
    expect(config.port).toBe(OPENCODE_DEFAULTS.port);
    expect(config.boardPort).toBe(BOARD_SERVER_DEFAULTS.port);
  });

  it("switches to connect mode when OPENCODE_BASE_URL is set", () => {
    const config = loadConfig({ OPENCODE_BASE_URL: "http://example.local:9999" });
    expect(config.mode).toBe("connect");
    expect(config.baseUrl).toBe("http://example.local:9999");
    // manageProcess defaults to false in connect mode.
    expect(config.manageProcess).toBe(false);
  });

  it("treats an empty-string OPENCODE_BASE_URL as unset (spawn mode)", () => {
    const config = loadConfig({ OPENCODE_BASE_URL: "" });
    expect(config.mode).toBe("spawn");
    expect(config.baseUrl).toBeUndefined();
  });

  it("respects OPENCODE_MANAGE_PROCESS=false even in spawn mode", () => {
    const config = loadConfig({ OPENCODE_MANAGE_PROCESS: "false" });
    expect(config.mode).toBe("spawn");
    expect(config.manageProcess).toBe(false);
  });

  it("respects OPENCODE_MANAGE_PROCESS=true even in connect mode", () => {
    const config = loadConfig({
      OPENCODE_BASE_URL: "http://example.local:9999",
      OPENCODE_MANAGE_PROCESS: "true",
    });
    expect(config.mode).toBe("connect");
    expect(config.manageProcess).toBe(true);
  });

  it("ignores unrecognized OPENCODE_MANAGE_PROCESS values and falls back to the mode default", () => {
    const config = loadConfig({ OPENCODE_MANAGE_PROCESS: "yes-please" });
    expect(config.manageProcess).toBe(true); // spawn mode default
  });

  it("parses OPENCODE_HOSTNAME and OPENCODE_PORT overrides", () => {
    const config = loadConfig({ OPENCODE_HOSTNAME: "0.0.0.0", OPENCODE_PORT: "5001" });
    expect(config.hostname).toBe("0.0.0.0");
    expect(config.port).toBe(5001);
  });

  it("falls back to OPENCODE_DEFAULTS.port on a non-numeric OPENCODE_PORT", () => {
    const config = loadConfig({ OPENCODE_PORT: "not-a-number" });
    expect(config.port).toBe(OPENCODE_DEFAULTS.port);
  });

  it("parses BOARD_PORT override", () => {
    const config = loadConfig({ BOARD_PORT: "6100" });
    expect(config.boardPort).toBe(6100);
  });

  it("falls back to BOARD_SERVER_DEFAULTS.port on invalid BOARD_PORT", () => {
    const config = loadConfig({ BOARD_PORT: "-5" });
    expect(config.boardPort).toBe(BOARD_SERVER_DEFAULTS.port);
  });

  it("full precedence: explicit base url + explicit manage-process + explicit ports all honored together", () => {
    const config = loadConfig({
      OPENCODE_BASE_URL: "http://remote-host:4096",
      OPENCODE_MANAGE_PROCESS: "true",
      OPENCODE_HOSTNAME: "ignored-in-connect-mode",
      OPENCODE_PORT: "4096",
      BOARD_PORT: "4200",
    });
    expect(config).toMatchObject({
      mode: "connect",
      baseUrl: "http://remote-host:4096",
      manageProcess: true,
      hostname: "ignored-in-connect-mode",
      port: 4096,
      boardPort: 4200,
    });
  });

  it("parses health-check tuning env vars, defaulting when absent", () => {
    const defaults = loadConfig({});
    expect(defaults.healthCheck).toEqual({ attempts: 5, timeoutMs: 2000, delayMs: 250 });

    const overridden = loadConfig({
      OPENCODE_HEALTHCHECK_ATTEMPTS: "2",
      OPENCODE_HEALTHCHECK_TIMEOUT_MS: "50",
      OPENCODE_HEALTHCHECK_DELAY_MS: "10",
    });
    expect(overridden.healthCheck).toEqual({ attempts: 2, timeoutMs: 50, delayMs: 10 });
  });

  it("uses process.env by default when no env argument is given", () => {
    const config = loadConfig();
    expect(config).toBeTruthy();
    expect(["connect", "spawn"]).toContain(config.mode);
  });
});
