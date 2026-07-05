import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
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
          type: "agent",
          title: "Columns check",
          description: "spot-check fields",
          directory: "/repo",
          completedBy: "User",
          column: "done",
          position: 0,
          runState: "idle",
          archived: true,
          parentIds: [],
          completion: null,
          finalSessionOutput: "final output snapshot",
          completionSource: null,
          createdAt: 11,
          updatedAt: 22,
        },
        { name: "src-inst", port: 4099, workspace: "/ws", dbPath: "/db/cols.sqlite" },
        99,
        [{ id: "comment_1", taskId: "task_columns", parentCommentId: null, author: "User", body: "archive this note", createdAt: 33 }],
      );

      const rows = store.listAll();
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.title).toBe("Columns check");
      expect(row.source_instance_name).toBe("src-inst");
      expect(row.task_type).toBe("agent");
      expect(row.final_session_output).toBe("final output snapshot");
      expect(row.comments).toContain("archive this note");
      expect(row.completed_by).toBe("User");
      expect(row.archived_at).toBe(99);
      expect(row.task_id).toBe("task_columns");
    } finally {
      store.close();
    }
  });

  it("migrates existing archive databases with selected-card metadata columns", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE global_archive (
        source_instance_name TEXT,
        source_port INTEGER NOT NULL,
        source_workspace TEXT NOT NULL,
        source_db_path TEXT NOT NULL,
        task_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        directory TEXT NOT NULL,
        agent TEXT,
        model TEXT,
        isolation TEXT,
        column_name TEXT NOT NULL,
        run_state TEXT NOT NULL,
        run_started_at INTEGER,
        error TEXT,
        session_id TEXT,
        worktree_path TEXT,
        worktree_branch TEXT,
        base_branch TEXT,
        completion TEXT,
        completion_source TEXT,
        archived_at INTEGER NOT NULL,
        task_created_at INTEGER NOT NULL,
        task_updated_at INTEGER NOT NULL,
        mirrored_at INTEGER NOT NULL,
        PRIMARY KEY(source_db_path, task_id)
      );
    `);

    const store = new GlobalArchiveStore(db);
    try {
      const columns = new Set((db.prepare("PRAGMA table_info(global_archive)").all() as Array<{ name: string }>).map((column) => column.name));
      expect(columns.has("task_type")).toBe(true);
      expect(columns.has("assigned_to")).toBe(true);
      expect(columns.has("final_session_output")).toBe(true);
      expect(columns.has("comments")).toBe(true);
      expect(columns.has("completed_by")).toBe(true);
    } finally {
      store.close();
      db.close();
    }
  });
});
