import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  boardPortFromUrl,
  createAdapterEnv,
  defaultOpenBoardDataDir,
  formatRendererExit,
  hasAttachTarget,
  hasConfiguredWorkspace,
  isLocalBoardUrl,
  resolveRendererCommand,
  rendererExitCode,
  startAdapter,
} from "../../src/tui/launcher";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "openboard-tui-"));
  tempDirs.push(dir);
  return dir;
}

describe("TUI launcher", () => {
  it("recognizes local board URLs and their ports", () => {
    expect(isLocalBoardUrl("http://127.0.0.1:4097")).toBe(true);
    expect(isLocalBoardUrl("http://localhost:4097")).toBe(true);
    expect(isLocalBoardUrl("https://example.com")).toBe(false);
    expect(boardPortFromUrl("http://127.0.0.1:5010")).toBe(5010);
  });

  it("uses platform default data directories", () => {
    expect(defaultOpenBoardDataDir("darwin", {}, "/Users/example")).toBe(
      "/Users/example/Library/Application Support/OpenBoard",
    );
    expect(defaultOpenBoardDataDir("linux", { XDG_CONFIG_HOME: "/config" }, "/home/example")).toBe(
      "/config/OpenBoard",
    );
    expect(defaultOpenBoardDataDir("win32", { APPDATA: "C:\\Users\\Example\\AppData\\Roaming" }, "C:\\Users\\Example")).toBe(
      "C:\\Users\\Example\\AppData\\Roaming/OpenBoard",
    );
  });

  it("builds the adapter environment from the board URL", () => {
    const dataDir = tempDir();
    const env = createAdapterEnv({
      boardUrl: "http://127.0.0.1:5010",
      repoRoot: "/repo",
      env: { OPENBOARD_DATA_DIR: dataDir, OPENCODE_PORT: "4100" },
      platform: "darwin",
      home: "/Users/example",
    });

    expect(env.BOARD_PORT).toBe("5010");
    expect(env.OPENCODE_PORT).toBe("4100");
    expect(env.BOARD_WEB_DIR).toBe("/repo/dist/web");
    expect(env.BOARD_DB_PATH).toBe(join(dataDir, "board.sqlite"));
    expect(env.BOARD_TASK_DB_PATH).toBe(join(dataDir, "board-tasks.sqlite"));
  });

  it("does not treat a bare launch without BOARD_WORKSPACE as attachable/spawnable", () => {
    expect(hasAttachTarget({})).toBe(false);
    expect(hasConfiguredWorkspace({})).toBe(false);
    expect(hasAttachTarget({ OPENCODE_BOARD_URL: "http://127.0.0.1:4097" })).toBe(true);
    expect(hasConfiguredWorkspace({ BOARD_WORKSPACE: "/repo" })).toBe(true);
  });

  it("refuses to spawn the adapter without BOARD_WORKSPACE so the renderer can show setup instead", () => {
    expect(() => startAdapter({ boardUrl: "http://127.0.0.1:5010", repoRoot: "/repo", env: {} })).toThrow(
      /BOARD_WORKSPACE must be set/,
    );
  });

  it("uses current Node 26 when available", () => {
    expect(
      resolveRendererCommand("/repo/dist/tui/index.mjs", {
        versions: { node: "26.3.0" },
        execPath: "/node26",
        env: {},
      }),
    ).toEqual({
      command: "/node26",
      args: ["--no-warnings", "--experimental-ffi", "/repo/dist/tui/index.mjs"],
    });
  });

  it("falls back to transient node@26.3.0 through npx on older Node", () => {
    expect(
      resolveRendererCommand("/repo/dist/tui/index.mjs", {
        versions: { node: "22.22.3" },
        env: {},
      }),
    ).toEqual({
      command: "npx",
      args: ["-y", "node@26.3.0", "--no-warnings", "--experimental-ffi", "/repo/dist/tui/index.mjs"],
    });
  });

  it("allows an explicit Node binary override", () => {
    expect(
      resolveRendererCommand("/repo/dist/tui/index.mjs", {
        versions: { node: "22.22.3" },
        env: { OPENBOARD_TUI_NODE: "/opt/node26/bin/node" },
      }),
    ).toEqual({
      command: "/opt/node26/bin/node",
      args: ["--no-warnings", "--experimental-ffi", "/repo/dist/tui/index.mjs"],
    });
  });

  it("preserves renderer exit codes and reports crash signals", () => {
    expect(rendererExitCode({ code: 0, signal: null })).toBe(0);
    expect(formatRendererExit({ code: 0, signal: null })).toBeUndefined();

    expect(rendererExitCode({ code: 1, signal: null })).toBe(1);
    expect(formatRendererExit({ code: 1, signal: null })).toBe("OpenBoard TUI renderer exited with code 1.");

    expect(rendererExitCode({ code: null, signal: "SIGSEGV" })).toBe(139);
    expect(formatRendererExit({ code: null, signal: "SIGSEGV" })).toBe(
      "OpenBoard TUI renderer exited from SIGSEGV.",
    );
  });
});
