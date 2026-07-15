import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createInstanceRegistry,
  InstanceError,
  InstanceNameCollisionError,
  InstanceUnknownError,
  InstancePortConflictError,
  instancesFilePath,
  type InstanceRegistry,
  type InstanceDefinition,
} from "../../src/instances";

// ── Helpers ──────────────────────────────────────────────────────────────────

let homeDir: string;
let registry: InstanceRegistry;

function makeDef(
  name: string,
  port: number,
  workspace: string,
  dbPath: string,
  opencodePort?: number,
): InstanceDefinition {
  const def: InstanceDefinition & { opencodePort?: number } = {
    name,
    port,
    workspace,
    dbPath,
  };
  if (opencodePort !== undefined) def.opencodePort = opencodePort;
  return def as InstanceDefinition;
}

beforeEach(() => {
  // Create a fresh temp home for each test.
  homeDir = mkdtempSync(join(tmpdir(), "openboard-registry-"));
  registry = createInstanceRegistry(homeDir);
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

// ── File path ────────────────────────────────────────────────────────────────

describe("registry file path", () => {
  it("uses the frozen instancesFilePath", () => {
    expect(instancesFilePath(homeDir)).toBe(
      join(homeDir, ".config", "openboard", "instances.json"),
    );
  });
});

// ── Create-on-first-use ──────────────────────────────────────────────────────

describe("create-on-first-use", () => {
  it("creates the file with empty instances on first load", () => {
    const filePath = instancesFilePath(homeDir);
    expect(existsSync(filePath)).toBe(false);

    const file = registry.getFile();
    expect(file.version).toBe(1);
    expect(file.instances).toEqual([]);
    expect(file.defaultInstance).toBeUndefined();
    expect(existsSync(filePath)).toBe(true);
  });

  it("new empty file has valid JSON", () => {
    const filePath = instancesFilePath(homeDir);
    registry.getFile(); // trigger creation

    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(raw).toEqual({ version: 1, instances: [] });
  });
});

// ── Add ──────────────────────────────────────────────────────────────────────

describe("add", () => {
  it("adds a single instance and persists it", () => {
    const def = makeDef("my-project", 4097, "/home/alice/repo", "board.sqlite");
    const file = registry.add(def);
    expect(file.instances).toHaveLength(1);
    expect(file.instances[0]).toEqual(def);

    // Reload from disk.
    const fresh = createInstanceRegistry(homeDir);
    expect(fresh.getFile().instances).toHaveLength(1);
    expect(fresh.getFile().instances[0].name).toBe("my-project");
  });

  it("adds multiple instances in order", () => {
    registry.add(makeDef("a", 4097, "/a", "a.sqlite"));
    registry.add(makeDef("b", 4197, "/b", "b.sqlite"));
    registry.add(makeDef("c", 4297, "/c", "c.sqlite"));

    const list = registry.list();
    expect(list).toHaveLength(3);
    expect(list.map((i) => i.name)).toEqual(["a", "b", "c"]);
  });

  it("preserves order across reloads", () => {
    registry.add(makeDef("first", 4097, "/1", "1.sqlite"));
    registry.add(makeDef("second", 4197, "/2", "2.sqlite"));
    registry.add(makeDef("third", 4297, "/3", "3.sqlite"));

    const fresh = createInstanceRegistry(homeDir);
    expect(fresh.list().map((i) => i.name)).toEqual(["first", "second", "third"]);
  });

  it("reloads under the write lock so interleaved add does not silently lose data", () => {
    const staleReader = createInstanceRegistry(homeDir);
    expect(staleReader.getFile().instances).toEqual([]);

    const concurrentWriter = createInstanceRegistry(homeDir);
    concurrentWriter.add(makeDef("b", 4197, "/b", "b.sqlite"));

    staleReader.add(makeDef("a", 4097, "/a", "a.sqlite"));

    const fresh = createInstanceRegistry(homeDir);
    expect(fresh.list().map((item) => item.name).sort()).toEqual(["a", "b"]);
  });

  it("fails with an explicit typed error instead of writing through lock contention", () => {
    const filePath = instancesFilePath(homeDir);
    mkdirSync(dirname(filePath), { recursive: true });
    const lockPath = join(dirname(filePath), "instances.json.lock");
    const fd = openSync(lockPath, "wx");
    try {
      expect(() => registry.add(makeDef("a", 4097, "/a", "a.sqlite"))).toThrow(InstanceError);
      expect(existsSync(filePath)).toBe(false);
    } finally {
      closeSync(fd);
      unlinkSync(lockPath);
    }
  });

  it("recovers a registry write blocked by a dead-pid lock", () => {
    const filePath = instancesFilePath(homeDir);
    mkdirSync(dirname(filePath), { recursive: true });
    const lockPath = join(dirname(filePath), "instances.json.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 2_147_483_647, createdAt: Date.now() }) + "\n", "utf-8");

    registry.add(makeDef("a", 4097, "/a", "a.sqlite"));

    expect(registry.list().map((item) => item.name)).toEqual(["a"]);
    expect(existsSync(lockPath)).toBe(false);
  });
});

// ── Add — error cases ────────────────────────────────────────────────────────

describe("add — NameCollisionError", () => {
  it("throws when name already exists", () => {
    registry.add(makeDef("my-project", 4097, "/a", "a.sqlite"));
    expect(() =>
      registry.add(makeDef("my-project", 4197, "/b", "b.sqlite")),
    ).toThrow(InstanceNameCollisionError);
  });

  it("error carries the colliding name", () => {
    registry.add(makeDef("my-project", 4097, "/a", "a.sqlite"));
    try {
      registry.add(makeDef("my-project", 4197, "/b", "b.sqlite"));
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InstanceNameCollisionError);
      expect((e as InstanceNameCollisionError).instanceName).toBe("my-project");
    }
  });

  it("does not modify the file on collision", () => {
    registry.add(makeDef("my-project", 4097, "/a", "a.sqlite"));
    try {
      registry.add(makeDef("my-project", 4197, "/b", "b.sqlite"));
    } catch {
      /* expected */
    }
    expect(registry.list()).toHaveLength(1);
  });
});

describe("add — PortConflictError", () => {
  it("throws when port is already assigned", () => {
    registry.add(makeDef("a", 4097, "/a", "a.sqlite"));
    expect(() =>
      registry.add(makeDef("b", 4097, "/b", "b.sqlite")),
    ).toThrow(InstancePortConflictError);
  });

  it("error carries the port and existing instance name", () => {
    registry.add(makeDef("repo-a", 4097, "/a", "a.sqlite"));
    try {
      registry.add(makeDef("repo-b", 4097, "/b", "b.sqlite"));
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InstancePortConflictError);
      expect((e as InstancePortConflictError).port).toBe(4097);
      expect((e as InstancePortConflictError).existingInstance).toBe("repo-a");
    }
  });

  it("checks opencodePort conflicts too", () => {
    registry.add(makeDef("a", 4097, "/a", "a.sqlite", 4096));
    expect(() =>
      registry.add(makeDef("b", 4197, "/b", "b.sqlite", 4096)),
    ).toThrow(InstancePortConflictError);
  });

  it("does not flag opencodePort conflict when both are undefined", () => {
    // Both omit opencodePort — no conflict.
    registry.add(makeDef("a", 4097, "/a", "a.sqlite"));
    registry.add(makeDef("b", 4197, "/b", "b.sqlite"));
    expect(registry.list()).toHaveLength(2);
  });
});

// ── Remove ───────────────────────────────────────────────────────────────────

describe("remove", () => {
  it("removes an instance by name", () => {
    registry.add(makeDef("a", 4097, "/a", "a.sqlite"));
    registry.add(makeDef("b", 4197, "/b", "b.sqlite"));

    const file = registry.remove("a");
    expect(file.instances).toHaveLength(1);
    expect(file.instances[0].name).toBe("b");

    // Persisted.
    const fresh = createInstanceRegistry(homeDir);
    expect(fresh.list()).toHaveLength(1);
  });

  it("clears defaultInstance when the default is removed", () => {
    registry.add(makeDef("a", 4097, "/a", "a.sqlite"));
    registry.add(makeDef("b", 4197, "/b", "b.sqlite"));

    registry.setDefault("a");

    expect(registry.getFile().defaultInstance).toBe("a");

    registry.remove("a");
    expect(registry.getFile().defaultInstance).toBeUndefined();
  });

  it("throws InstanceUnknownError for unknown name", () => {
    registry.add(makeDef("a", 4097, "/a", "a.sqlite"));
    expect(() => registry.remove("ghost")).toThrow(InstanceUnknownError);
  });

  it("does not modify the file on unknown remove", () => {
    registry.add(makeDef("a", 4097, "/a", "a.sqlite"));
    try {
      registry.remove("ghost");
    } catch {
      /* expected */
    }
    expect(registry.list()).toHaveLength(1);
  });

  it("removing from an empty registry throws", () => {
    expect(() => registry.remove("any")).toThrow(InstanceUnknownError);
  });

  it("reloads under the write lock so interleaved remove does not overwrite another add", () => {
    registry.add(makeDef("a", 4097, "/a", "a.sqlite"));
    const staleRemover = createInstanceRegistry(homeDir);
    expect(staleRemover.list().map((item) => item.name)).toEqual(["a"]);

    const concurrentWriter = createInstanceRegistry(homeDir);
    concurrentWriter.add(makeDef("b", 4197, "/b", "b.sqlite"));

    staleRemover.remove("a");

    const fresh = createInstanceRegistry(homeDir);
    expect(fresh.list().map((item) => item.name)).toEqual(["b"]);
  });
});

// ── Get ──────────────────────────────────────────────────────────────────────

describe("get", () => {
  it("returns an instance by name", () => {
    registry.add(makeDef("my-project", 4097, "/a", "a.sqlite"));
    const def = registry.get("my-project");
    expect(def).toBeDefined();
    expect(def!.name).toBe("my-project");
  });

  it("returns undefined for unknown name", () => {
    expect(registry.get("ghost")).toBeUndefined();
  });
});

// ── List ─────────────────────────────────────────────────────────────────────

describe("list", () => {
  it("returns empty array for new registry", () => {
    expect(registry.list()).toEqual([]);
  });

  it("returns all instances in order", () => {
    registry.add(makeDef("z", 4097, "/z", "z.sqlite"));
    registry.add(makeDef("a", 4197, "/a", "a.sqlite"));
    registry.add(makeDef("m", 4297, "/m", "m.sqlite"));

    expect(registry.list().map((i) => i.name)).toEqual(["z", "a", "m"]);
  });
});

// ── Default instance ─────────────────────────────────────────────────────────

describe("defaultInstance", () => {
  it("survives add/remove round-trip", () => {
    registry.add(makeDef("a", 4097, "/a", "a.sqlite"));
    registry.add(makeDef("b", 4197, "/b", "b.sqlite"));

    registry.setDefault("b");

    const fresh = createInstanceRegistry(homeDir);
    expect(fresh.getFile().defaultInstance).toBe("b");
  });

  it("sets and clears an explicit default through registry helpers", () => {
    registry.add(makeDef("a", 4097, "/a", "a.sqlite"));
    registry.add(makeDef("b", 4197, "/b", "b.sqlite"));

    registry.setDefault("b");
    expect(registry.getFile().defaultInstance).toBe("b");

    registry.clearDefault();
    expect(registry.getFile().defaultInstance).toBeUndefined();
  });

  it("rejects setting a default to an unknown instance", () => {
    registry.add(makeDef("a", 4097, "/a", "a.sqlite"));

    expect(() => registry.setDefault("ghost")).toThrow(InstanceUnknownError);
    expect(registry.getFile().defaultInstance).toBeUndefined();
  });
});

describe("board token updates", () => {
  it("reloads under the registry lock instead of overwriting concurrent changes", () => {
    registry.add(makeDef("a", 4097, "/a", "a.sqlite"));
    registry.getFile(); // populate this registry object's cache

    const concurrent = createInstanceRegistry(homeDir);
    concurrent.add(makeDef("b", 4197, "/b", "b.sqlite"));

    const updated = registry.ensureBoardToken("a", "new-token");

    expect(updated.boardToken).toBe("new-token");
    const fresh = createInstanceRegistry(homeDir);
    expect(fresh.list().map((instance) => instance.name)).toEqual(["a", "b"]);
    expect(fresh.get("a")?.boardToken).toBe("new-token");
  });

  it("returns the first persisted token to concurrent legacy-token repairs", () => {
    registry.add(makeDef("a", 4097, "/a", "a.sqlite"));
    const concurrent = createInstanceRegistry(homeDir);

    const first = registry.ensureBoardToken("a", "token-a");
    const second = concurrent.ensureBoardToken("a", "token-b");

    expect(first.boardToken).toBe("token-a");
    expect(second.boardToken).toBe("token-a");
    expect(createInstanceRegistry(homeDir).get("a")?.boardToken).toBe("token-a");
  });
});

// ── Atomicity ────────────────────────────────────────────────────────────────

describe("atomicity", () => {
  it("never leaves a partial file when disk is full (simulated)", () => {
    // Populate first.
    registry.add(makeDef("a", 4097, "/a", "a.sqlite"));
    const filePath = instancesFilePath(homeDir);

    // Corrupt the file to simulate a partial write.
    writeFileSync(filePath, "NOT VALID JSON {{{", "utf-8");

    // A new registry trying to read the corrupt file should throw.
    const fresh = createInstanceRegistry(homeDir);
    expect(() => fresh.getFile()).toThrow(InstanceError);
  });

  it("validates file is always valid JSON after a successful write", () => {
    registry.add(makeDef("a", 4097, "/a", "a.sqlite"));
    const filePath = instancesFilePath(homeDir);

    const content = readFileSync(filePath, "utf-8");
    expect(() => JSON.parse(content)).not.toThrow();
    const parsed = JSON.parse(content);
    expect(parsed.version).toBe(1);
    expect(parsed.instances).toHaveLength(1);
    expect(parsed.instances[0].name).toBe("a");
  });
});

// ── Validation on load ───────────────────────────────────────────────────────

describe("validation on load", () => {
  it("rejects a file with invalid version on load", () => {
    const filePath = instancesFilePath(homeDir);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({ version: 2, instances: [] }, null, 2),
      "utf-8",
    );

    const fresh = createInstanceRegistry(homeDir);
    expect(() => fresh.getFile()).toThrow(InstanceError);
  });

  it("rejects a file with duplicate names on load", () => {
    const filePath = instancesFilePath(homeDir);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify(
        {
          version: 1,
          instances: [
            { name: "dup", port: 4097, workspace: "/a", dbPath: "a.sqlite" },
            { name: "dup", port: 4197, workspace: "/b", dbPath: "b.sqlite" },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const fresh = createInstanceRegistry(homeDir);
    expect(() => fresh.getFile()).toThrow(InstanceError);
  });
});

// ── Canonical file format ────────────────────────────────────────────────────

describe("canonical file format", () => {
  it("writes instances in canonical order (no extra keys)", () => {
    registry.add(makeDef("my-project", 4097, "/home/alice", "board.sqlite"));
    const filePath = instancesFilePath(homeDir);
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    // Check that only known keys exist.
    const keys = Object.keys(raw);
    expect(keys.sort()).toEqual(["instances", "version"]);

    const inst = raw.instances[0];
    expect(Object.keys(inst).sort()).toEqual([
      "dbPath",
      "name",
      "port",
      "workspace",
    ]);
  });

  it("includes opencodePort when set", () => {
    registry.add(makeDef("a", 4097, "/a", "a.sqlite", 4096));
    const filePath = instancesFilePath(homeDir);
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(raw.instances[0]).toHaveProperty("opencodePort", 4096);
  });

  it("does not include opencodePort when not set", () => {
    registry.add(makeDef("a", 4097, "/a", "a.sqlite"));
    const filePath = instancesFilePath(homeDir);
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(raw.instances[0]).not.toHaveProperty("opencodePort");
  });

  it("does not include defaultInstance when not set", () => {
    registry.add(makeDef("a", 4097, "/a", "a.sqlite"));
    const filePath = instancesFilePath(homeDir);
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(raw).not.toHaveProperty("defaultInstance");
  });

  it("includes defaultInstance when set", () => {
    registry.add(makeDef("a", 4097, "/a", "a.sqlite"));
    registry.setDefault("a");
    const filePath = instancesFilePath(homeDir);
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(raw).toHaveProperty("defaultInstance", "a");
  });
});

// ── Rename ────────────────────────────────────────────────────────────────────

describe("rename", () => {
  it("updates name + dbPath and preserves order", () => {
    registry.add(makeDef("a", 4097, "/a", "a.sqlite"));
    registry.add(makeDef("b", 4197, "/b", "b.sqlite"));
    registry.add(makeDef("c", 4297, "/c", "c.sqlite"));

    const file = registry.rename("b", "bravo", "/new-db/bravo.sqlite");
    expect(file.instances).toHaveLength(3);
    expect(file.instances.map((i) => i.name)).toEqual(["a", "bravo", "c"]);
    expect(file.instances[1].port).toBe(4197);
    expect(file.instances[1].workspace).toBe("/b");
    expect(file.instances[1].dbPath).toBe("/new-db/bravo.sqlite");

    // Persisted.
    const fresh = createInstanceRegistry(homeDir);
    expect(fresh.list().map((i) => i.name)).toEqual(["a", "bravo", "c"]);
  });

  it("throws InstanceUnknownError for unknown old name", () => {
    registry.add(makeDef("a", 4097, "/a", "a.sqlite"));
    expect(() => registry.rename("ghost", "new-name", "new.sqlite")).toThrow(
      InstanceUnknownError,
    );
  });

  it("throws InstanceNameCollisionError when newName already exists", () => {
    registry.add(makeDef("a", 4097, "/a", "a.sqlite"));
    registry.add(makeDef("b", 4197, "/b", "b.sqlite"));
    expect(() => registry.rename("a", "b", "b.sqlite")).toThrow(
      InstanceNameCollisionError,
    );
  });

  it("throws on invalid newName", () => {
    registry.add(makeDef("a", 4097, "/a", "a.sqlite"));
    expect(() => registry.rename("a", "Bad Name", "new.sqlite")).toThrow(
      InstanceError,
    );
  });

  it("does not modify the file on collision", () => {
    registry.add(makeDef("a", 4097, "/a", "a.sqlite"));
    registry.add(makeDef("b", 4197, "/b", "b.sqlite"));
    try {
      registry.rename("a", "b", "new.sqlite");
    } catch {
      /* expected */
    }
    expect(registry.list().map((i) => i.name)).toEqual(["a", "b"]);
  });

  it("does not modify the file on unknown oldName", () => {
    registry.add(makeDef("a", 4097, "/a", "a.sqlite"));
    try {
      registry.rename("ghost", "new-name", "new.sqlite");
    } catch {
      /* expected */
    }
    expect(registry.list().map((i) => i.name)).toEqual(["a"]);
  });

  it("updates defaultInstance when the renamed instance was the default", () => {
    registry.add(makeDef("a", 4097, "/a", "a.sqlite"));
    registry.add(makeDef("b", 4197, "/b", "b.sqlite"));

    registry.setDefault("a");

    registry.rename("a", "alpha", "/new/alpha.sqlite");
    expect(registry.getFile().defaultInstance).toBe("alpha");
  });

  it("preserves opencodePort when set", () => {
    registry.add(makeDef("a", 4097, "/a", "a.sqlite", 4096));
    registry.rename("a", "alpha", "/new/alpha.sqlite");
    expect(registry.get("alpha")!.opencodePort).toBe(4096);
  });

  it("persists across reload (fresh registry)", () => {
    registry.add(makeDef("a", 4097, "/a", "a.sqlite"));
    registry.rename("a", "alpha", "/new/alpha.sqlite");

    const fresh = createInstanceRegistry(homeDir);
    expect(fresh.getFile().instances).toHaveLength(1);
    expect(fresh.getFile().instances[0].name).toBe("alpha");
    expect(fresh.getFile().instances[0].dbPath).toBe("/new/alpha.sqlite");
  });
});
