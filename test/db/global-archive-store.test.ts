import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GlobalArchiveStore, resolveGlobalArchivePath } from "../../src/db/global-archive-store";

describe("GlobalArchiveStore", () => {
  it("resolves the default archive path under the OpenBoard user-data directory", () => {
    expect(resolveGlobalArchivePath({ HOME: "/tmp/home" } as NodeJS.ProcessEnv)).toBe(
      "/tmp/home/.local/share/openboard/archive.sqlite",
    );
  });

  it("resolves OPENBOARD_ARCHIVE_DB when provided", () => {
    expect(
      resolveGlobalArchivePath({
        HOME: "/tmp/home",
        OPENBOARD_ARCHIVE_DB: "/tmp/custom/archive.sqlite",
      } as NodeJS.ProcessEnv),
    ).toBe("/tmp/custom/archive.sqlite");
  });

  it("creates missing parent directories for a default-style nested file path", () => {
    const root = mkdtempSync(join(tmpdir(), "openboard-archive-default-style-"));
    const archivePath = resolveGlobalArchivePath({ HOME: root } as NodeJS.ProcessEnv);
    let store: GlobalArchiveStore | undefined;
    try {
      store = new GlobalArchiveStore(archivePath);
      store.mirrorTask(
        {
          id: "task_default_path",
          title: "Default path",
          description: "created parents",
          directory: "/repo",
          column: "done",
          position: 0,
          runState: "idle",
          archived: true,
          parentIds: [],
          completion: null,
          completionSource: null,
          createdAt: 1,
          updatedAt: 2,
        },
        { port: 4097, workspace: "/ws", dbPath: "/db/tasks.sqlite" },
        3,
      );

      expect(existsSync(archivePath)).toBe(true);
      expect(store.countMirrored()).toBe(1);
    } finally {
      store?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates missing parent directories for OPENBOARD_ARCHIVE_DB and writes successfully", () => {
    const root = mkdtempSync(join(tmpdir(), "openboard-archive-env-"));
    const archivePath = join(root, "custom", "nested", "archive.sqlite");
    let store: GlobalArchiveStore | undefined;
    try {
      store = new GlobalArchiveStore(archivePath);
      store.mirrorTask(
        {
          id: "task_env_path",
          title: "Env path",
          description: "created parents",
          directory: "/repo",
          column: "review",
          position: 0,
          runState: "idle",
          archived: true,
          parentIds: [],
          completion: null,
          completionSource: null,
          createdAt: 10,
          updatedAt: 20,
        },
        { name: "env", port: 4098, workspace: "/ws", dbPath: "/db/env.sqlite" },
        30,
      );

      expect(existsSync(archivePath)).toBe(true);
      expect(store.getMirrored("/db/env.sqlite", "task_env_path")?.title).toBe("Env path");
    } finally {
      store?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("listAll returns records ordered by archived_at DESC", () => {
    const store = new GlobalArchiveStore(":memory:");
    try {
      const baseTask = {
        title: "ordered task",
        description: "ordering test",
        directory: "/repo",
        column: "done" as const,
        position: 0,
        runState: "idle" as const,
        archived: true,
        parentIds: [],
        completion: null,
        completionSource: null,
        createdAt: 1,
        updatedAt: 2,
      };
      store.mirrorTask(
        { ...baseTask, id: "oldest", title: "oldest" },
        { name: "inst", port: 1, workspace: "/ws", dbPath: "/db/oldest.sqlite" },
        100,
      );
      store.mirrorTask(
        { ...baseTask, id: "newest", title: "newest" },
        { name: "inst", port: 1, workspace: "/ws", dbPath: "/db/newest.sqlite" },
        300,
      );
      store.mirrorTask(
        { ...baseTask, id: "middle", title: "middle" },
        { name: "inst", port: 1, workspace: "/ws", dbPath: "/db/middle.sqlite" },
        200,
      );

      const rows = store.listAll();
      expect(rows.map((r) => r.task_id)).toEqual(["newest", "middle", "oldest"]);
    } finally {
      store.close();
    }
  });

  it("listAll returns an empty array for a fresh store", () => {
    const store = new GlobalArchiveStore(":memory:");
    try {
      expect(store.listAll()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("listAll returns all columns correctly", () => {
    const store = new GlobalArchiveStore(":memory:");
    try {
      store.mirrorTask(
        {
          id: "task_columns",
          title: "Columns check",
          description: "spot-check fields",
          directory: "/repo",
          column: "done",
          position: 0,
          runState: "idle",
          archived: true,
          parentIds: [],
          completion: null,
          completionSource: null,
          createdAt: 11,
          updatedAt: 22,
        },
        { name: "src-inst", port: 4099, workspace: "/ws", dbPath: "/db/cols.sqlite" },
        99,
      );

      const rows = store.listAll();
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.title).toBe("Columns check");
      expect(row.source_instance_name).toBe("src-inst");
      expect(row.archived_at).toBe(99);
      expect(row.task_id).toBe("task_columns");
    } finally {
      store.close();
    }
  });
});
