import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultProvider } from "../../src/cli/default-provider";
import {
  createInstanceRegistry,
  instanceDataDir,
  InstanceError,
  InstanceNameCollisionError,
  renameInstance,
  type InstanceDefinition,
  type InstanceRegistry,
  type InstanceRuntimeState,
} from "../../src/instances";
import { createRealInstanceProvider } from "../../src/tui/model";

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "openboard-rename-"));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

function addDefinition(
  registry: InstanceRegistry,
  name: string,
  options: { dbPath?: string; port?: number } = {},
): InstanceDefinition {
  const dirs = instanceDataDir(homeDir, name);
  const definition: InstanceDefinition = {
    name,
    port: options.port ?? 4097,
    workspace: join(homeDir, "workspace"),
    dbPath: options.dbPath ?? join(dirs.dataDir, "board.sqlite"),
    boardToken: "test-token",
  };
  registry.add(definition);
  return definition;
}

function fakeDaemon(runtime: InstanceRuntimeState = {
  status: "stopped",
  boardUrl: "http://127.0.0.1:4097",
}) {
  return {
    status: vi.fn(async () => runtime),
    stop: vi.fn(async () => undefined),
    start: vi.fn(async (definition: InstanceDefinition) => ({
      status: "running" as const,
      pid: 12345,
      boardUrl: `http://127.0.0.1:${definition.port}`,
    })),
  };
}

function createSentinel(name = "alpha"): string {
  const dirs = instanceDataDir(homeDir, name);
  mkdirSync(dirs.dataDir, { recursive: true });
  const sentinel = join(dirs.dataDir, "board.sqlite");
  writeFileSync(sentinel, "original-board-data", "utf-8");
  return sentinel;
}

function registryWithCommitFailure(registry: InstanceRegistry): Pick<InstanceRegistry, "get" | "rename" | "validateRename"> {
  return {
    get: registry.get,
    validateRename: registry.validateRename,
    // An invalid path makes persistence fail only after the filesystem
    // transaction's apply callback has run.
    rename: (oldName, newName, _newDbPath, transaction) =>
      registry.rename(oldName, newName, "", transaction),
  };
}

describe("real provider rename wiring", () => {
  it("renames a never-started CLI instance without requiring a data directory", async () => {
    const provider = createDefaultProvider(homeDir);
    await provider.add({ name: "alpha", port: 4097, workspace: join(homeDir, "workspace") });

    const renamed = await provider.rename("alpha", " bravo ");

    expect(renamed.name).toBe("bravo");
    expect(renamed.dbPath).toBe(join(instanceDataDir(homeDir, "bravo").dataDir, "board.sqlite"));
    expect(existsSync(instanceDataDir(homeDir, "alpha").dataDir)).toBe(false);
    expect(existsSync(instanceDataDir(homeDir, "bravo").dataDir)).toBe(false);
    expect(createInstanceRegistry(homeDir).list().map((instance) => instance.name)).toEqual(["bravo"]);
  });

  it("renames a never-started TUI instance through the same coordinator", async () => {
    const provider = createRealInstanceProvider(homeDir);
    await provider.add("alpha", join(homeDir, "workspace"));

    const renamed = await provider.rename("alpha", "bravo");

    expect(renamed.name).toBe("bravo");
    expect(renamed.dbPath).toBe(join(instanceDataDir(homeDir, "bravo").dataDir, "board.sqlite"));
    expect(createInstanceRegistry(homeDir).list().map((instance) => instance.name)).toEqual(["bravo"]);
  });
});

describe("renameInstance", () => {
  it.each([
    ["invalid name", "Bad", InstanceError],
    ["registered collision", "beta", InstanceNameCollisionError],
  ])("rejects a %s before inspecting or stopping the daemon", async (_label, newName, errorType) => {
    const registry = createInstanceRegistry(homeDir);
    addDefinition(registry, "alpha");
    if (newName === "beta") addDefinition(registry, "beta", { port: 4098 });
    const oldSentinel = createSentinel();
    const daemon = fakeDaemon({ status: "running", pid: 12345, boardUrl: "http://127.0.0.1:4097" });

    await expect(renameInstance({ homeDir, registry, daemon }, "alpha", newName)).rejects.toBeInstanceOf(errorType);

    expect(daemon.status).not.toHaveBeenCalled();
    expect(daemon.stop).not.toHaveBeenCalled();
    expect(readFileSync(oldSentinel, "utf-8")).toBe("original-board-data");
    expect(registry.get("alpha")).toBeDefined();
  });

  it("rejects an unregistered destination data directory before inspecting the daemon", async () => {
    const registry = createInstanceRegistry(homeDir);
    addDefinition(registry, "alpha");
    const oldSentinel = createSentinel();
    const destination = instanceDataDir(homeDir, "bravo").dataDir;
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, "unrelated.txt"), "do-not-touch", "utf-8");
    const daemon = fakeDaemon({ status: "running", pid: 12345, boardUrl: "http://127.0.0.1:4097" });

    await expect(renameInstance({ homeDir, registry, daemon }, "alpha", "bravo"))
      .rejects.toThrow("destination data directory already exists");

    expect(daemon.status).not.toHaveBeenCalled();
    expect(daemon.stop).not.toHaveBeenCalled();
    expect(readFileSync(oldSentinel, "utf-8")).toBe("original-board-data");
    expect(readFileSync(join(destination, "unrelated.txt"), "utf-8")).toBe("do-not-touch");
  });

  it("rechecks the destination after stopping and restarts the unchanged old instance", async () => {
    const registry = createInstanceRegistry(homeDir);
    const oldDefinition = addDefinition(registry, "alpha");
    const oldSentinel = createSentinel();
    const daemon = fakeDaemon({ status: "running", pid: 12345, boardUrl: "http://127.0.0.1:4097" });
    const destination = instanceDataDir(homeDir, "bravo").dataDir;
    let destinationChecks = 0;
    const move = vi.fn();

    await expect(renameInstance(
      {
        homeDir,
        registry,
        daemon,
        fileSystem: {
          exists(path) {
            if (path === destination) {
              destinationChecks += 1;
              return destinationChecks > 1;
            }
            return existsSync(path);
          },
          move,
        },
      },
      "alpha",
      "bravo",
    )).rejects.toThrow("destination data directory already exists");

    expect(daemon.stop).toHaveBeenCalledWith(oldDefinition);
    expect(move).not.toHaveBeenCalled();
    expect(readFileSync(oldSentinel, "utf-8")).toBe("original-board-data");
    expect(registry.get("alpha")).toBeDefined();
    expect(registry.get("bravo")).toBeUndefined();
    expect(daemon.start).toHaveBeenCalledWith(oldDefinition);
  });

  it("restarts the old instance when the forward data move fails without changing state", async () => {
    const registry = createInstanceRegistry(homeDir);
    const oldDefinition = addDefinition(registry, "alpha");
    const oldSentinel = createSentinel();
    const daemon = fakeDaemon({ status: "running", pid: 12345, boardUrl: "http://127.0.0.1:4097" });

    await expect(renameInstance(
      {
        homeDir,
        registry,
        daemon,
        fileSystem: {
          exists: existsSync,
          move() {
            throw new Error("simulated forward move failure");
          },
        },
      },
      "alpha",
      "bravo",
    )).rejects.toThrow("simulated forward move failure");

    expect(readFileSync(oldSentinel, "utf-8")).toBe("original-board-data");
    expect(existsSync(instanceDataDir(homeDir, "bravo").dataDir)).toBe(false);
    expect(registry.get("alpha")).toBeDefined();
    expect(registry.get("bravo")).toBeUndefined();
    expect(daemon.start).toHaveBeenCalledWith(oldDefinition);
  });

  it.each([
    ["running", { status: "running" as const, pid: 12345, boardUrl: "http://127.0.0.1:4097" }],
    ["unhealthy", { status: "unhealthy" as const, pid: 12345, boardUrl: "http://127.0.0.1:4097" }],
  ])("moves data and restarts a %s live daemon under the new identity", async (_label, runtime) => {
    const registry = createInstanceRegistry(homeDir);
    const oldDefinition = addDefinition(registry, "alpha");
    const oldSentinel = createSentinel();
    const daemon = fakeDaemon(runtime);

    const renamed = await renameInstance({ homeDir, registry, daemon }, "alpha", "bravo");

    const newSentinel = join(instanceDataDir(homeDir, "bravo").dataDir, "board.sqlite");
    expect(existsSync(oldSentinel)).toBe(false);
    expect(readFileSync(newSentinel, "utf-8")).toBe("original-board-data");
    expect(registry.get("alpha")).toBeUndefined();
    expect(registry.get("bravo")).toEqual(renamed);
    expect(daemon.stop).toHaveBeenCalledWith(oldDefinition);
    expect(daemon.start).toHaveBeenCalledWith(expect.objectContaining({ name: "bravo", dbPath: newSentinel }));
    expect(daemon.stop.mock.invocationCallOrder[0]).toBeLessThan(daemon.start.mock.invocationCallOrder[0]);
  });

  it("preserves a custom database path outside the instance data directory", async () => {
    const registry = createInstanceRegistry(homeDir);
    const customDbPath = join(homeDir, "external", "custom.sqlite");
    addDefinition(registry, "alpha", { dbPath: customDbPath });
    createSentinel();
    const daemon = fakeDaemon();

    const renamed = await renameInstance({ homeDir, registry, daemon }, "alpha", "bravo");

    expect(renamed.dbPath).toBe(customDbPath);
    expect(readFileSync(join(instanceDataDir(homeDir, "bravo").dataDir, "board.sqlite"), "utf-8"))
      .toBe("original-board-data");
  });

  it("moves data back before restarting the old daemon when registry persistence fails", async () => {
    const registry = createInstanceRegistry(homeDir);
    const oldDefinition = addDefinition(registry, "alpha");
    const oldSentinel = createSentinel();
    const daemon = fakeDaemon({ status: "running", pid: 12345, boardUrl: "http://127.0.0.1:4097" });
    const events: string[] = [];
    daemon.start.mockImplementationOnce(async (definition) => {
      events.push("restart-old");
      expect(definition.name).toBe("alpha");
      expect(readFileSync(oldSentinel, "utf-8")).toBe("original-board-data");
      expect(existsSync(instanceDataDir(homeDir, "bravo").dataDir)).toBe(false);
      return { status: "running", pid: 12345, boardUrl: "http://127.0.0.1:4097" };
    });

    await expect(renameInstance(
      {
        homeDir,
        registry: registryWithCommitFailure(registry),
        daemon,
        fileSystem: {
          exists: existsSync,
          move(from, to) {
            events.push(from === instanceDataDir(homeDir, "alpha").dataDir ? "move-forward" : "move-back");
            renameSync(from, to);
          },
        },
      },
      "alpha",
      "bravo",
    )).rejects.toThrow("Refusing to write invalid instances file");

    expect(readFileSync(oldSentinel, "utf-8")).toBe("original-board-data");
    expect(existsSync(instanceDataDir(homeDir, "bravo").dataDir)).toBe(false);
    expect(registry.get("alpha")).toBeDefined();
    expect(registry.get("bravo")).toBeUndefined();
    expect(daemon.start).toHaveBeenCalledTimes(1);
    expect(daemon.start).toHaveBeenCalledWith(oldDefinition);
    expect(events).toEqual(["move-forward", "move-back", "restart-old"]);
  });

  it("does not restart the old name when filesystem rollback fails", async () => {
    const registry = createInstanceRegistry(homeDir);
    addDefinition(registry, "alpha");
    createSentinel();
    const daemon = fakeDaemon({ status: "running", pid: 12345, boardUrl: "http://127.0.0.1:4097" });
    let moveCount = 0;

    await expect(renameInstance(
      {
        homeDir,
        registry: registryWithCommitFailure(registry),
        daemon,
        fileSystem: {
          exists: existsSync,
          move(from, to) {
            moveCount += 1;
            if (moveCount === 2) throw new Error("simulated rollback move failure");
            renameSync(from, to);
          },
        },
      },
      "alpha",
      "bravo",
    )).rejects.toThrow(/Filesystem rollback also failed: simulated rollback move failure/);

    expect(registry.get("alpha")).toBeDefined();
    expect(existsSync(instanceDataDir(homeDir, "alpha").dataDir)).toBe(false);
    expect(readFileSync(join(instanceDataDir(homeDir, "bravo").dataDir, "board.sqlite"), "utf-8"))
      .toBe("original-board-data");
    expect(daemon.start).not.toHaveBeenCalled();
  });

  it("leaves a coherent renamed instance stopped when restart under the new name fails", async () => {
    const registry = createInstanceRegistry(homeDir);
    addDefinition(registry, "alpha");
    createSentinel();
    const daemon = fakeDaemon({ status: "running", pid: 12345, boardUrl: "http://127.0.0.1:4097" });
    daemon.start.mockRejectedValueOnce(new Error("simulated start failure"));

    await expect(renameInstance({ homeDir, registry, daemon }, "alpha", "bravo"))
      .rejects.toThrow(/registry and data directory are consistent under "bravo"; start it with: openboard start bravo/);

    expect(registry.get("alpha")).toBeUndefined();
    expect(registry.get("bravo")).toBeDefined();
    expect(existsSync(instanceDataDir(homeDir, "alpha").dataDir)).toBe(false);
    expect(readFileSync(join(instanceDataDir(homeDir, "bravo").dataDir, "board.sqlite"), "utf-8"))
      .toBe("original-board-data");
    expect(daemon.start).toHaveBeenCalledTimes(1);
    expect(daemon.start).toHaveBeenCalledWith(expect.objectContaining({ name: "bravo" }));
  });
});
