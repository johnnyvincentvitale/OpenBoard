import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isExternalDirectoriesAllowed,
  resolveBoardWorkspace,
  resolveTaskDirectory,
} from "../../src/server/workspace";

describe("resolveTaskDirectory", () => {
  let tmp: string;
  let workspace: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "ocb-ws-")));
    workspace = join(tmp, "workspace");
    mkdirSync(workspace, { recursive: true });
    process.env.BOARD_WORKSPACE = workspace;
    delete process.env.OPENBOARD_ALLOW_EXTERNAL_DIRECTORIES;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    delete process.env.BOARD_WORKSPACE;
    delete process.env.OPENBOARD_ALLOW_EXTERNAL_DIRECTORIES;
  });

  it("returns the realpath for a directory inside the workspace", () => {
    const dir = join(workspace, "repo");
    mkdirSync(dir);
    expect(resolveTaskDirectory(dir, workspace)).toBe(realpathSync(dir));
  });

  it("rejects a sibling path that escapes the workspace via ..", () => {
    const outside = join(tmp, "outside");
    mkdirSync(outside);
    expect(() => resolveTaskDirectory(join(workspace, "..", "outside"), workspace)).toThrow(
      /outside the board workspace/,
    );
  });

  it("rejects a symlink that points outside the workspace", () => {
    const outside = join(tmp, "outside");
    mkdirSync(outside);
    const link = join(workspace, "link-out");
    symlinkSync(outside, link);
    expect(() => resolveTaskDirectory(link, workspace)).toThrow(/outside the board workspace/);
  });

  it("rejects a missing directory", () => {
    expect(() => resolveTaskDirectory(join(workspace, "missing"), workspace)).toThrow(
      /Directory does not exist/,
    );
  });

  it("allows external directories when allowExternal is true", () => {
    const outside = join(tmp, "outside");
    mkdirSync(outside);
    expect(resolveTaskDirectory(outside, workspace, { allowExternal: true })).toBe(
      realpathSync(outside),
    );
  });

  it("resolves relative paths against the workspace", () => {
    const rel = join(workspace, "rel");
    mkdirSync(rel);
    expect(resolveTaskDirectory("rel", workspace)).toBe(realpathSync(rel));
  });
});

describe("isExternalDirectoriesAllowed", () => {
  it("is false by default", () => {
    expect(isExternalDirectoriesAllowed({})).toBe(false);
  });

  it("is true for explicit opt-in values", () => {
    expect(isExternalDirectoriesAllowed({ OPENBOARD_ALLOW_EXTERNAL_DIRECTORIES: "true" })).toBe(
      true,
    );
    expect(isExternalDirectoriesAllowed({ OPENBOARD_ALLOW_EXTERNAL_DIRECTORIES: "1" })).toBe(true);
  });

  it("remains false for any other value", () => {
    expect(isExternalDirectoriesAllowed({ OPENBOARD_ALLOW_EXTERNAL_DIRECTORIES: "yes" })).toBe(
      false,
    );
  });
});

describe("resolveBoardWorkspace", () => {
  it("returns the configured workspace when it exists", () => {
    expect(resolveBoardWorkspace({ BOARD_WORKSPACE: "/tmp" })).toBe(realpathSync("/tmp"));
  });

  it("throws when the configured workspace is missing, not a directory, or empty", () => {
    expect(() => resolveBoardWorkspace({ BOARD_WORKSPACE: "/does/not/exist" })).toThrow(
      /BOARD_WORKSPACE does not exist/,
    );
    expect(() => resolveBoardWorkspace({ BOARD_WORKSPACE: "/dev/null" })).toThrow(
      /BOARD_WORKSPACE is not a directory/,
    );
    expect(() => resolveBoardWorkspace({ BOARD_WORKSPACE: "" })).toThrow(
      /BOARD_WORKSPACE must not be empty/,
    );
  });

  it("throws when BOARD_WORKSPACE is unset", () => {
    expect(() => resolveBoardWorkspace({})).toThrow(
      /BOARD_WORKSPACE must be set to an existing directory/,
    );
  });
});
