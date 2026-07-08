import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { SqliteTaskStore } from "../../src/db/task-store";

describe("SqliteTaskStore — isolation fields + settings", () => {
  it("persists a per-task isolation override on create", () => {
    const store = new SqliteTaskStore(":memory:");
    const task = store.create({
      title: "t",
      description: "d",
      directory: "/repo",
      isolation: "worktree",
    });
    expect(task.isolation).toBe("worktree");
    expect(store.get(task.id)?.isolation).toBe("worktree");
    store.close();
  });

  it("round-trips worktree metadata + pending through update", () => {
    const store = new SqliteTaskStore(":memory:");
    const task = store.create({ title: "t", description: "d", directory: "/repo" });

    const updated = store.update(task.id, {
      worktreePath: "/repo/.wt/board-1",
      worktreeBranch: "board/task-1",
      baseBranch: "main",
      pending: "rebase-conflict",
      rebaseConflictPaths: ["src/app.ts", "package.json"],
    });
    expect(updated?.worktreePath).toBe("/repo/.wt/board-1");
    expect(updated?.worktreeBranch).toBe("board/task-1");
    expect(updated?.baseBranch).toBe("main");
    expect(updated?.pending).toBe("rebase-conflict");
    expect(updated?.rebaseConflictPaths).toEqual(["src/app.ts", "package.json"]);
    expect(store.get(task.id)?.rebaseConflictPaths).toEqual(["src/app.ts", "package.json"]);

    // Clearing a field back to undefined persists as absent.
    const cleared = store.update(task.id, { pending: undefined, rebaseConflictPaths: undefined });
    expect(cleared?.pending).toBeUndefined();
    expect(cleared?.rebaseConflictPaths).toBeUndefined();
    expect(store.get(task.id)?.pending).toBeUndefined();
    store.close();
  });

  it("persists known worktree repo roots for orphan sweeps", () => {
    const store = new SqliteTaskStore(":memory:");

    store.rememberWorktreeRepoRoot("/repo/b");
    store.rememberWorktreeRepoRoot("/repo/a");
    store.rememberWorktreeRepoRoot("/repo/b");

    expect(store.listKnownWorktreeRepoRoots()).toEqual(["/repo/a", "/repo/b"]);
    store.close();
  });

  it("migrates a pre-BoardV3 task table in place with data intact", () => {
    // Simulate an older DB: a task table without the new columns.
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE task (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
        directory TEXT NOT NULL, "column" TEXT NOT NULL, position INTEGER NOT NULL,
        session_id TEXT, run_state TEXT NOT NULL, error TEXT, agent TEXT, model TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE("column", position)
      );
    `);
    db.exec(
      `INSERT INTO task (id, title, description, directory, "column", position, run_state, created_at, updated_at)
       VALUES ('t1','old','desc','/repo','todo',0,'unstarted',1,1)`,
    );

    // Opening the store over this db should ALTER-in the new columns/tables without loss.
    const store = new SqliteTaskStore(db);
    const migrated = store.get("t1");
    expect(migrated?.title).toBe("old");
    expect(migrated?.isolation).toBeUndefined();
    expect(migrated?.archived).toBe(false);
    expect(migrated?.parentIds).toEqual([]);
    expect(migrated?.completion).toBeNull();
    expect(migrated?.completionSource).toBeNull();

    // And the new fields are now writable.
    const updated = store.update("t1", {
      isolation: "worktree",
      worktreeBranch: "board/t1",
      archived: true,
      completion: {
        outcome: "blocked",
        summary: "Blocked on decision",
        changedFiles: [],
        verification: [],
        residualRisk: "needs input",
        reportedAt: 2,
      },
      completionSource: "reported",
    });
    expect(updated?.isolation).toBe("worktree");
    expect(updated?.worktreeBranch).toBe("board/t1");
    expect(updated?.archived).toBe(true);
    expect(updated?.completion?.outcome).toBe("blocked");

    const t2 = store.create({ title: "new", description: "desc", directory: "/repo" });
    store.addLink("t1", t2.id);
    expect(store.getParentIds(t2.id)).toEqual(["t1"]);
  });

  it("creates BoardV3 schema for a fresh database", () => {
    const db = new Database(":memory:");
    const store = new SqliteTaskStore(db);

    const taskColumns = new Set(
      (db.prepare("PRAGMA table_info(task)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    expect(taskColumns.has("archived")).toBe(true);
    expect(taskColumns.has("completion")).toBe(true);
    expect(taskColumns.has("completion_source")).toBe(true);

    const taskLinks = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_links'")
      .get();
    expect(taskLinks).toBeTruthy();

    const task = store.create({ title: "t", description: "d", directory: "/repo" });
    expect(task.archived).toBe(false);
    expect(task.parentIds).toEqual([]);
    expect(task.completion).toBeNull();
    expect(task.completionSource).toBeNull();
  });
});
