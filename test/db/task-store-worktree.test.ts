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
      pending: "git-init",
    });
    expect(updated?.worktreePath).toBe("/repo/.wt/board-1");
    expect(updated?.worktreeBranch).toBe("board/task-1");
    expect(updated?.baseBranch).toBe("main");
    expect(updated?.pending).toBe("git-init");

    // Clearing a field back to undefined persists as absent.
    const cleared = store.update(task.id, { pending: undefined });
    expect(cleared?.pending).toBeUndefined();
    expect(store.get(task.id)?.pending).toBeUndefined();
    store.close();
  });

  it("defaults worktreeDefault to false and persists an update", () => {
    const store = new SqliteTaskStore(":memory:");
    expect(store.getSettings()).toEqual({ worktreeDefault: false });
    expect(store.updateSettings({ worktreeDefault: true })).toEqual({ worktreeDefault: true });
    expect(store.getSettings()).toEqual({ worktreeDefault: true });
    store.close();
  });

  it("settings survive reopening the same database file", () => {
    const path = `/tmp/ocb-settings-${Math.floor(Math.random() * 1e9)}.sqlite`;
    const a = new SqliteTaskStore(path);
    a.updateSettings({ worktreeDefault: true });
    a.close();

    const b = new SqliteTaskStore(path);
    expect(b.getSettings().worktreeDefault).toBe(true);
    b.close();
  });

  it("migrates a pre-existing task table missing the isolation columns", () => {
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

    // Opening the store over this db should ALTER-in the new columns without loss.
    const store = new SqliteTaskStore(db);
    const migrated = store.get("t1");
    expect(migrated?.title).toBe("old");
    expect(migrated?.isolation).toBeUndefined();

    // And the new fields are now writable.
    const updated = store.update("t1", { isolation: "worktree", worktreeBranch: "board/t1" });
    expect(updated?.isolation).toBe("worktree");
    expect(updated?.worktreeBranch).toBe("board/t1");
  });
});
