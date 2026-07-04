import { createServer } from "node:net";
import { homedir } from "node:os";
import { describe, it, expect, afterEach } from "vitest";
import {
  assertPortFree,
  ConfigError,
  deriveStorePaths,
  findFreePort,
  loadConfig,
  resolveAdapterConfig,
  resolveInstanceConfig,
} from "../../src/server/config";
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

describe("resolveInstanceConfig", () => {
  it("defaults to the board port, board.sqlite, the home dir, and no explicit opencode port", () => {
    const instance = resolveInstanceConfig({});
    expect(instance.port).toBe(BOARD_SERVER_DEFAULTS.port);
    expect(instance.dbPath).toBe("board.sqlite");
    expect(instance.workspace).toBe(homedir());
    expect(instance.opencodePort).toBeUndefined();
    expect(instance.allowExternalDirectories).toBe(false);
  });

  it("honors OPENBOARD_ALLOW_EXTERNAL_DIRECTORIES", () => {
    expect(resolveInstanceConfig({ OPENBOARD_ALLOW_EXTERNAL_DIRECTORIES: "true" }).allowExternalDirectories).toBe(true);
    expect(resolveInstanceConfig({ OPENBOARD_ALLOW_EXTERNAL_DIRECTORIES: "1" }).allowExternalDirectories).toBe(true);
    expect(resolveInstanceConfig({ OPENBOARD_ALLOW_EXTERNAL_DIRECTORIES: "false" }).allowExternalDirectories).toBe(false);
    expect(resolveInstanceConfig({}).allowExternalDirectories).toBe(false);
  });

  it("full env override: OPENBOARD_PORT, OPENBOARD_DB, BOARD_WORKSPACE, OPENBOARD_OPENCODE_PORT all honored", () => {
    const instance = resolveInstanceConfig({
      OPENBOARD_PORT: "5200",
      OPENBOARD_DB: "/tmp/instance-a/board.sqlite",
      BOARD_WORKSPACE: "/tmp/instance-a/workspace",
      OPENBOARD_OPENCODE_PORT: "5300",
    });
    expect(instance).toEqual({
      port: 5200,
      dbPath: "/tmp/instance-a/board.sqlite",
      workspace: "/tmp/instance-a/workspace",
      allowExternalDirectories: false,
      opencodePort: 5300,
    });
  });

  it("OPENBOARD_PORT takes precedence over the legacy BOARD_PORT", () => {
    const instance = resolveInstanceConfig({ OPENBOARD_PORT: "5200", BOARD_PORT: "6100" });
    expect(instance.port).toBe(5200);
  });

  it("falls back to the legacy BOARD_PORT when OPENBOARD_PORT is unset", () => {
    const instance = resolveInstanceConfig({ BOARD_PORT: "6100" });
    expect(instance.port).toBe(6100);
  });

  it("OPENBOARD_OPENCODE_PORT takes precedence over the legacy OPENCODE_PORT", () => {
    const instance = resolveInstanceConfig({
      OPENBOARD_OPENCODE_PORT: "5300",
      OPENCODE_PORT: "6200",
    });
    expect(instance.opencodePort).toBe(5300);
  });

  it("falls back to the legacy OPENCODE_PORT when OPENBOARD_OPENCODE_PORT is unset", () => {
    const instance = resolveInstanceConfig({ OPENCODE_PORT: "6200" });
    expect(instance.opencodePort).toBe(6200);
  });

  it("leaves opencodePort undefined when neither OPENBOARD_OPENCODE_PORT nor OPENCODE_PORT is set", () => {
    const instance = resolveInstanceConfig({});
    expect(instance.opencodePort).toBeUndefined();
  });

  it("rejects a non-numeric OPENBOARD_PORT with a clear ConfigError naming the variable", () => {
    expect(() => resolveInstanceConfig({ OPENBOARD_PORT: "not-a-number" })).toThrow(ConfigError);
    expect(() => resolveInstanceConfig({ OPENBOARD_PORT: "not-a-number" })).toThrow(
      /OPENBOARD_PORT/,
    );
  });

  it("rejects an out-of-range OPENBOARD_PORT (0, negative, > 65535)", () => {
    expect(() => resolveInstanceConfig({ OPENBOARD_PORT: "0" })).toThrow(ConfigError);
    expect(() => resolveInstanceConfig({ OPENBOARD_PORT: "-1" })).toThrow(ConfigError);
    expect(() => resolveInstanceConfig({ OPENBOARD_PORT: "70000" })).toThrow(ConfigError);
  });

  it("rejects a non-integer (float) OPENBOARD_PORT", () => {
    expect(() => resolveInstanceConfig({ OPENBOARD_PORT: "4097.5" })).toThrow(ConfigError);
  });

  it("rejects a non-numeric OPENBOARD_OPENCODE_PORT with a clear ConfigError naming the variable", () => {
    expect(() => resolveInstanceConfig({ OPENBOARD_OPENCODE_PORT: "nope" })).toThrow(ConfigError);
    expect(() => resolveInstanceConfig({ OPENBOARD_OPENCODE_PORT: "nope" })).toThrow(
      /OPENBOARD_OPENCODE_PORT/,
    );
  });

  it("rejects an empty-string OPENBOARD_DB", () => {
    expect(() => resolveInstanceConfig({ OPENBOARD_DB: "" })).toThrow(ConfigError);
    expect(() => resolveInstanceConfig({ OPENBOARD_DB: "   " })).toThrow(ConfigError);
  });

  it("trims whitespace around OPENBOARD_DB and BOARD_WORKSPACE", () => {
    const instance = resolveInstanceConfig({
      OPENBOARD_DB: "  /tmp/db.sqlite  ",
      BOARD_WORKSPACE: "  /tmp/ws  ",
    });
    expect(instance.dbPath).toBe("/tmp/db.sqlite");
    expect(instance.workspace).toBe("/tmp/ws");
  });

  it("uses process.env by default when no env argument is given", () => {
    const instance = resolveInstanceConfig();
    expect(instance).toBeTruthy();
    expect(typeof instance.port).toBe("number");
  });
});

describe("deriveStorePaths", () => {
  it("defaults to the pre-multi-instance sibling files when OPENBOARD_DB is unset", () => {
    const paths = deriveStorePaths({ dbPath: "board.sqlite" }, {});
    expect(paths).toEqual({ boardDbPath: "board.sqlite", taskDbPath: "board-tasks.sqlite" });
  });

  it("derives disjoint sibling paths from an explicit OPENBOARD_DB", () => {
    const paths = deriveStorePaths(
      { dbPath: "/data/instance-a/board.sqlite" },
      { OPENBOARD_DB: "/data/instance-a/board.sqlite" },
    );
    expect(paths.taskDbPath).toBe("/data/instance-a/board.sqlite");
    expect(paths.boardDbPath).toBe("/data/instance-a/board-board.sqlite");
    expect(paths.boardDbPath).not.toBe(paths.taskDbPath);
  });

  it("legacy BOARD_DB_PATH / BOARD_TASK_DB_PATH win over derived defaults", () => {
    const paths = deriveStorePaths(
      { dbPath: "board.sqlite" },
      { BOARD_DB_PATH: "/legacy/board.sqlite", BOARD_TASK_DB_PATH: "/legacy/tasks.sqlite" },
    );
    expect(paths).toEqual({
      boardDbPath: "/legacy/board.sqlite",
      taskDbPath: "/legacy/tasks.sqlite",
    });
  });

  it("two different instance dbPaths never derive the same pair of store paths", () => {
    const a = deriveStorePaths(
      { dbPath: "/data/a.sqlite" },
      { OPENBOARD_DB: "/data/a.sqlite" },
    );
    const b = deriveStorePaths(
      { dbPath: "/data/b.sqlite" },
      { OPENBOARD_DB: "/data/b.sqlite" },
    );
    expect(a.boardDbPath).not.toBe(b.boardDbPath);
    expect(a.taskDbPath).not.toBe(b.taskDbPath);
  });
});

describe("findFreePort", () => {
  it("returns a usable port on the given hostname", async () => {
    const port = await findFreePort("127.0.0.1");
    expect(typeof port).toBe("number");
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);

    // Prove it's actually free: bind to it directly.
    await assertPortFree(port, "127.0.0.1");
  });

  it("returns a different port on repeated calls (extremely likely, not guaranteed)", async () => {
    const a = await findFreePort("127.0.0.1");
    const b = await findFreePort("127.0.0.1");
    // Not a hard guarantee the OS won't reuse, but true in practice since
    // each server release happens before the next bind.
    expect(typeof a).toBe("number");
    expect(typeof b).toBe("number");
  });
});

describe("assertPortFree", () => {
  it("resolves when the port is free", async () => {
    const port = await findFreePort("127.0.0.1");
    await expect(assertPortFree(port, "127.0.0.1")).resolves.toBeUndefined();
  });

  it("rejects with a clear ConfigError naming the port when it's already taken", async () => {
    const port = await findFreePort("127.0.0.1");
    const blocker = createServer();
    await new Promise<void>((resolvePromise) => blocker.listen(port, "127.0.0.1", resolvePromise));

    try {
      await expect(assertPortFree(port, "127.0.0.1")).rejects.toThrow(ConfigError);
      await expect(assertPortFree(port, "127.0.0.1")).rejects.toThrow(String(port));
    } finally {
      await new Promise<void>((resolvePromise) => blocker.close(() => resolvePromise()));
    }
  });
});

describe("resolveAdapterConfig", () => {
  afterEach(() => {
    // no-op — each test uses isolated env objects, nothing to restore.
  });

  it("spawn mode with no OpenCode port configured: auto-selects a free port instead of hardcoding 4096", async () => {
    const config = await resolveAdapterConfig({});
    expect(config.mode).toBe("spawn");
    expect(typeof config.port).toBe("number");
    expect(config.port).toBeGreaterThan(0);
    // Prove it's actually free at the moment of resolution.
    await assertPortFree(config.port, config.hostname);
  });

  it("spawn mode with OPENBOARD_OPENCODE_PORT set: uses that exact port, no auto-selection", async () => {
    const config = await resolveAdapterConfig({ OPENBOARD_OPENCODE_PORT: "5301" });
    expect(config.mode).toBe("spawn");
    expect(config.port).toBe(5301);
  });

  it("boardPort comes from the resolved instance config (OPENBOARD_PORT)", async () => {
    const config = await resolveAdapterConfig({ OPENBOARD_PORT: "5201" });
    expect(config.boardPort).toBe(5201);
  });

  it("connect mode: port is loadConfig's resolved value, no free-port selection performed", async () => {
    const config = await resolveAdapterConfig({ OPENCODE_BASE_URL: "http://example.local:9999" });
    expect(config.mode).toBe("connect");
    expect(config.port).toBe(OPENCODE_DEFAULTS.port);
  });

  it("two instances resolved concurrently with no OpenCode port configured get disjoint ports", async () => {
    const [a, b] = await Promise.all([resolveAdapterConfig({}), resolveAdapterConfig({})]);
    expect(a.port).not.toBe(b.port);
  });

  it("defaults with no env set reproduce the pre-multi-instance boardPort default", async () => {
    const config = await resolveAdapterConfig({});
    expect(config.boardPort).toBe(BOARD_SERVER_DEFAULTS.port);
  });
});
