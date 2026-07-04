import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

// electron/instance.cjs is a plain CommonJS module with no Electron
// dependency (see its header comment) — loaded via createRequire so this
// suite runs in the normal Vitest/Node environment, without an Electron
// runtime, exercising the exact multi-instance resolution logic main.cjs uses.
const require = createRequire(import.meta.url);
const instance = require(join(__dirname, "../../electron/instance.cjs"));

const {
  DEFAULT_BOARD_PORT,
  resolveBoardPort,
  resolveOpencodePort,
  isDefaultPort,
  windowTitle,
  resolveUserDataPath,
  defaultDbPath,
  buildAdapterEnv,
} = instance;

describe("resolveBoardPort", () => {
  it("defaults to 4097 when no env is set", () => {
    expect(resolveBoardPort({})).toBe(DEFAULT_BOARD_PORT);
    expect(DEFAULT_BOARD_PORT).toBe("4097");
  });

  it("OPENBOARD_PORT takes precedence over the legacy BOARD_PORT", () => {
    expect(resolveBoardPort({ OPENBOARD_PORT: "5200", BOARD_PORT: "6100" })).toBe("5200");
  });

  it("falls back to the legacy BOARD_PORT when OPENBOARD_PORT is unset", () => {
    expect(resolveBoardPort({ BOARD_PORT: "6100" })).toBe("6100");
  });
});

describe("resolveOpencodePort", () => {
  it("is empty (unset) when neither var is set — auto-select happens in the adapter", () => {
    expect(resolveOpencodePort({})).toBe("");
  });

  it("OPENBOARD_OPENCODE_PORT takes precedence over the legacy OPENCODE_PORT", () => {
    expect(resolveOpencodePort({ OPENBOARD_OPENCODE_PORT: "5301", OPENCODE_PORT: "6200" })).toBe(
      "5301",
    );
  });

  it("falls back to the legacy OPENCODE_PORT when OPENBOARD_OPENCODE_PORT is unset", () => {
    expect(resolveOpencodePort({ OPENCODE_PORT: "6200" })).toBe("6200");
  });
});

describe("isDefaultPort / windowTitle", () => {
  it("the default port is not disambiguated in the title", () => {
    expect(isDefaultPort("4097")).toBe(true);
    expect(windowTitle("4097")).toBe("OpenBoard");
  });

  it("a non-default port is appended to the title for cheap instance disambiguation", () => {
    expect(isDefaultPort("5200")).toBe(false);
    expect(windowTitle("5200")).toBe("OpenBoard — :5200");
  });
});

describe("resolveUserDataPath", () => {
  it("the default-port instance keeps the base userData directory unchanged", () => {
    expect(resolveUserDataPath("/Users/x/Library/Application Support/OpenBoard", "4097")).toBe(
      "/Users/x/Library/Application Support/OpenBoard",
    );
  });

  it("a non-default port gets its own scoped subdirectory", () => {
    const base = "/Users/x/Library/Application Support/OpenBoard";
    const scoped = resolveUserDataPath(base, "5200");
    expect(scoped).toBe(join(base, "instance-5200"));
    expect(scoped).not.toBe(base);
  });

  it("two different non-default ports get two different, disjoint directories", () => {
    const base = "/Users/x/Library/Application Support/OpenBoard";
    const a = resolveUserDataPath(base, "5200");
    const b = resolveUserDataPath(base, "5300");
    expect(a).not.toBe(b);
  });
});

describe("defaultDbPath", () => {
  it("joins the userData path and name into a .sqlite file", () => {
    expect(defaultDbPath("/data/instance-5200", "board")).toBe(
      join("/data/instance-5200", "board.sqlite"),
    );
  });
});

describe("buildAdapterEnv", () => {
  it("passes the board port through under both the canonical and legacy env names", () => {
    const env = buildAdapterEnv({
      env: {},
      boardPort: "5200",
      opencodePort: "",
      userDataPath: "/data/instance-5200",
      webDir: "/repo/dist/web",
    });
    expect(env.OPENBOARD_PORT).toBe("5200");
    expect(env.BOARD_PORT).toBe("5200");
  });

  it("passes the opencode port through under both names only when set", () => {
    const withPort = buildAdapterEnv({
      env: {},
      boardPort: "5200",
      opencodePort: "5301",
      userDataPath: "/data/instance-5200",
      webDir: "/repo/dist/web",
    });
    expect(withPort.OPENBOARD_OPENCODE_PORT).toBe("5301");
    expect(withPort.OPENCODE_PORT).toBe("5301");

    const withoutPort = buildAdapterEnv({
      env: {},
      boardPort: "5200",
      opencodePort: "",
      userDataPath: "/data/instance-5200",
      webDir: "/repo/dist/web",
    });
    expect(withoutPort.OPENBOARD_OPENCODE_PORT).toBeUndefined();
    expect(withoutPort.OPENCODE_PORT).toBeUndefined();
  });

  it("defaults DB paths scoped to the given userDataPath when not explicitly set", () => {
    const env = buildAdapterEnv({
      env: {},
      boardPort: "5200",
      opencodePort: "",
      userDataPath: "/data/instance-5200",
      webDir: "/repo/dist/web",
    });
    expect(env.OPENBOARD_DB).toBe(join("/data/instance-5200", "board.sqlite"));
    expect(env.BOARD_DB_PATH).toBe(join("/data/instance-5200", "board.sqlite"));
    expect(env.BOARD_TASK_DB_PATH).toBe(join("/data/instance-5200", "board-tasks.sqlite"));
  });

  it("explicit OPENBOARD_DB / BOARD_DB_PATH / BOARD_TASK_DB_PATH win over the defaults", () => {
    const env = buildAdapterEnv({
      env: {
        OPENBOARD_DB: "/custom/board.sqlite",
        BOARD_DB_PATH: "/custom/board-legacy.sqlite",
        BOARD_TASK_DB_PATH: "/custom/tasks.sqlite",
      },
      boardPort: "5200",
      opencodePort: "",
      userDataPath: "/data/instance-5200",
      webDir: "/repo/dist/web",
    });
    expect(env.OPENBOARD_DB).toBe("/custom/board.sqlite");
    expect(env.BOARD_DB_PATH).toBe("/custom/board-legacy.sqlite");
    expect(env.BOARD_TASK_DB_PATH).toBe("/custom/tasks.sqlite");
  });

  it("two instances resolved with different userDataPaths never produce colliding DB paths", () => {
    const a = buildAdapterEnv({
      env: {},
      boardPort: "5200",
      opencodePort: "",
      userDataPath: "/data/instance-5200",
      webDir: "/repo/dist/web",
    });
    const b = buildAdapterEnv({
      env: {},
      boardPort: "5300",
      opencodePort: "",
      userDataPath: "/data/instance-5300",
      webDir: "/repo/dist/web",
    });
    expect(a.OPENBOARD_DB).not.toBe(b.OPENBOARD_DB);
    expect(a.BOARD_TASK_DB_PATH).not.toBe(b.BOARD_TASK_DB_PATH);
    expect(a.OPENBOARD_PORT).not.toBe(b.OPENBOARD_PORT);
  });

  it("preserves the rest of the passed-in env (spread), not just the OpenBoard-specific keys", () => {
    const env = buildAdapterEnv({
      env: { PATH: "/usr/bin", HOME: "/Users/x" },
      boardPort: "5200",
      opencodePort: "",
      userDataPath: "/data/instance-5200",
      webDir: "/repo/dist/web",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/Users/x");
  });

  it("sets BOARD_WEB_DIR from the given webDir", () => {
    const env = buildAdapterEnv({
      env: {},
      boardPort: "5200",
      opencodePort: "",
      userDataPath: "/data/instance-5200",
      webDir: "/repo/dist/web",
    });
    expect(env.BOARD_WEB_DIR).toBe("/repo/dist/web");
  });
});
