import { describe, it, expect, beforeEach } from "vitest";
import type { CreateTaskInput } from "../../src/shared";
import { SqliteTaskStore } from "../../src/db/task-store";

function assertDenseUnique(store: SqliteTaskStore, column: string): number[] {
  const positions = store
    .list()
    .filter((t) => t.column === column)
    .sort((a, b) => a.position - b.position)
    .map((t) => t.position);

  const unique = new Set(positions);
  expect(unique.size).toBe(positions.length); // no duplicates
  positions.forEach((p, i) => expect(p).toBe(i)); // dense, 0-indexed, no gaps
  return positions;
}

function input(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    title: "Task",
    description: "Do the thing",
    directory: "/tmp/project",
    ...overrides,
  };
}

describe("SqliteTaskStore", () => {
  let clock: number;
  let idCounter: number;
  let store: SqliteTaskStore;

  beforeEach(() => {
    clock = 1_000;
    idCounter = 0;
    store = new SqliteTaskStore(":memory:", {
      now: () => clock,
      genId: () => `task_${++idCounter}`,
    });
  });

  describe("empty store", () => {
    it("starts with no tasks", () => {
      expect(store.list()).toEqual([]);
    });

    it("get returns undefined for unknown id", () => {
      expect(store.get("task_missing")).toBeUndefined();
    });
  });

  describe("create", () => {
    it("creates a task in todo at position 0 with unstarted runState", () => {
      const task = store.create(input({ title: "First" }));

      expect(task.id).toBe("task_1");
      expect(task.title).toBe("First");
      expect(task.description).toBe("Do the thing");
      expect(task.directory).toBe("/tmp/project");
      expect(task.column).toBe("todo");
      expect(task.position).toBe(0);
      expect(task.runState).toBe("unstarted");
      expect(task.sessionId).toBeUndefined();
      expect(task.error).toBeUndefined();
      expect(task.createdAt).toBe(1_000);
      expect(task.updatedAt).toBe(1_000);
    });

    it("appends subsequent tasks at the end of todo (max position + 1)", () => {
      store.create(input({ title: "A" }));
      store.create(input({ title: "B" }));
      const c = store.create(input({ title: "C" }));

      expect(c.position).toBe(2);
      assertDenseUnique(store, "todo");
    });

    it("uses the injected genId and now", () => {
      clock = 55;
      const task = store.create(input());
      expect(task.id).toBe("task_1");
      expect(task.createdAt).toBe(55);
    });
  });

  describe("list / get ordering", () => {
    it("list returns tasks ordered by (column, position)", () => {
      const a = store.create(input({ title: "A" }));
      const b = store.create(input({ title: "B" }));
      const c = store.create(input({ title: "C" }));

      store.move(a.id, "in_progress", 0);

      const tasks = store.list();
      // in_progress sorts before todo alphabetically... but we just check
      // that within each column ordering is by position and all present.
      const todoTasks = tasks.filter((t) => t.column === "todo");
      const inProgressTasks = tasks.filter((t) => t.column === "in_progress");

      expect(todoTasks.map((t) => t.id)).toEqual([b.id, c.id]);
      expect(todoTasks.map((t) => t.position)).toEqual([0, 1]);
      expect(inProgressTasks.map((t) => t.id)).toEqual([a.id]);
    });

    it("get returns the created task", () => {
      const created = store.create(input());
      const fetched = store.get(created.id);
      expect(fetched).toEqual(created);
    });
  });

  describe("update", () => {
    it("merges patch fields and bumps updatedAt", () => {
      const task = store.create(input({ title: "Original" }));
      clock = 2_000;

      const updated = store.update(task.id, { title: "Updated title" });

      expect(updated).toBeDefined();
      expect(updated!.title).toBe("Updated title");
      expect(updated!.description).toBe(task.description);
      expect(updated!.createdAt).toBe(task.createdAt);
      expect(updated!.updatedAt).toBe(2_000);
    });

    it("can set sessionId and runState together", () => {
      const task = store.create(input());
      clock = 3_000;

      const updated = store.update(task.id, {
        sessionId: "ses_abc",
        runState: "running",
      });

      expect(updated!.sessionId).toBe("ses_abc");
      expect(updated!.runState).toBe("running");
      expect(updated!.updatedAt).toBe(3_000);

      const fetched = store.get(task.id)!;
      expect(fetched.sessionId).toBe("ses_abc");
      expect(fetched.runState).toBe("running");
    });

    it("can set and clear error", () => {
      const task = store.create(input());

      const withError = store.update(task.id, { runState: "error", error: "boom" });
      expect(withError!.error).toBe("boom");
      expect(withError!.runState).toBe("error");

      const cleared = store.update(task.id, { error: undefined, runState: "idle" });
      expect(cleared!.error).toBeUndefined();
      expect(cleared!.runState).toBe("idle");
    });

    it("never lets the caller change id or createdAt", () => {
      const task = store.create(input());
      clock = 9_999;

      // TS wouldn't allow `id`/`createdAt` in the patch type; verify runtime
      // behavior stays correct for the fields that are allowed.
      const updated = store.update(task.id, { title: "Still same id" });

      expect(updated!.id).toBe(task.id);
      expect(updated!.createdAt).toBe(task.createdAt);
    });

    it("returns undefined for an unknown id", () => {
      expect(store.update("task_missing", { title: "x" })).toBeUndefined();
    });
  });

  describe("move: dense reindex", () => {
    it("moves a task to another column, compacting the source column", () => {
      const a = store.create(input({ title: "A" }));
      const b = store.create(input({ title: "B" }));
      const c = store.create(input({ title: "C" }));

      store.move(b.id, "review", 0);

      const moved = store.get(b.id)!;
      expect(moved.column).toBe("review");
      expect(moved.position).toBe(0);

      const todoTasks = store.list().filter((t) => t.column === "todo");
      expect(todoTasks.map((t) => t.id)).toEqual([a.id, c.id]);
      assertDenseUnique(store, "todo");
      assertDenseUnique(store, "review");
    });

    it("reorders within the same column with no gaps and unique positions", () => {
      const a = store.create(input({ title: "A" }));
      const b = store.create(input({ title: "B" }));
      const c = store.create(input({ title: "C" }));

      // Move C to the front.
      store.move(c.id, "todo", 0);

      const todoTasks = store.list().filter((t) => t.column === "todo");
      expect(todoTasks.map((t) => t.id)).toEqual([c.id, a.id, b.id]);
      assertDenseUnique(store, "todo");
    });

    it("clamps an out-of-range target position to the end", () => {
      const a = store.create(input({ title: "A" }));
      const b = store.create(input({ title: "B" }));

      store.move(a.id, "todo", 999);

      const todoTasks = store.list().filter((t) => t.column === "todo");
      expect(todoTasks.map((t) => t.id)).toEqual([b.id, a.id]);
      assertDenseUnique(store, "todo");
    });

    it("bumps updatedAt only for the moved task", () => {
      const a = store.create(input({ title: "A" }));
      const b = store.create(input({ title: "B" }));
      clock = 5_000;

      store.move(b.id, "in_progress", 0);

      expect(store.get(b.id)!.updatedAt).toBe(5_000);
      expect(store.get(a.id)!.updatedAt).toBe(1_000);
    });

    it("throws for an unknown task id", () => {
      expect(() => store.move("task_missing", "todo", 0)).toThrow();
    });
  });

  describe("remove + compact", () => {
    it("removes a task and compacts the vacated column", () => {
      const a = store.create(input({ title: "A" }));
      const b = store.create(input({ title: "B" }));
      const c = store.create(input({ title: "C" }));

      store.remove(b.id);

      expect(store.get(b.id)).toBeUndefined();
      const todoTasks = store.list().filter((t) => t.column === "todo");
      expect(todoTasks.map((t) => t.id)).toEqual([a.id, c.id]);
      assertDenseUnique(store, "todo");
    });

    it("is a no-op for an unknown id", () => {
      store.create(input());
      expect(() => store.remove("task_missing")).not.toThrow();
      expect(store.list()).toHaveLength(1);
    });

    it("leaves an empty column with no tasks after removing the last one", () => {
      const a = store.create(input());
      store.remove(a.id);
      expect(store.list()).toEqual([]);
    });
  });
});
