import { describe, it, expect, beforeEach } from "vitest";
import type { SessionRef } from "../../src/shared";
import { SqliteColumnStore } from "../../src/db/board-store";

function assertDenseUnique(store: SqliteColumnStore, column: string): number[] {
  const positions = store
    .getBoard()
    .filter((r) => r.column === column)
    .sort((a, b) => a.position - b.position)
    .map((r) => r.position);

  const unique = new Set(positions);
  expect(unique.size).toBe(positions.length); // no duplicates
  positions.forEach((p, i) => expect(p).toBe(i)); // dense, 0-indexed, no gaps
  return positions;
}

describe("SqliteColumnStore", () => {
  let clock: number;
  let store: SqliteColumnStore;

  beforeEach(() => {
    clock = 1_000;
    store = new SqliteColumnStore(":memory:", { now: () => clock });
  });

  describe("empty board", () => {
    it("starts with no rows", () => {
      expect(store.getBoard()).toEqual([]);
    });

    it("getRow returns undefined for unknown session", () => {
      expect(store.getRow("ses_missing")).toBeUndefined();
    });

    it("reconcile on an empty live set is a no-op", () => {
      store.reconcile([]);
      expect(store.getBoard()).toEqual([]);
    });

    it("purgeOrphans on an empty board is a no-op", () => {
      expect(() => store.purgeOrphans([])).not.toThrow();
      expect(store.getBoard()).toEqual([]);
    });
  });

  describe("reconcile: default-column placement + ordering", () => {
    it("appends new sessions to DEFAULT_COLUMN (todo) at the end, in input order", () => {
      const live: SessionRef[] = [{ sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" }];
      store.reconcile(live);

      const rows = store.getBoard();
      expect(rows).toHaveLength(3);
      for (const r of rows) expect(r.column).toBe("todo");

      const byId = Object.fromEntries(rows.map((r) => [r.sessionId, r]));
      expect(byId.a.position).toBe(0);
      expect(byId.b.position).toBe(1);
      expect(byId.c.position).toBe(2);

      assertDenseUnique(store, "todo");
    });

    it("is idempotent: reconciling the same live set twice does not duplicate or reorder", () => {
      const live: SessionRef[] = [{ sessionId: "a" }, { sessionId: "b" }];
      store.reconcile(live);
      const first = store.getBoard();

      store.reconcile(live);
      const second = store.getBoard();

      expect(second).toHaveLength(first.length);
      expect(second.map((r) => [r.sessionId, r.column, r.position])).toEqual(
        first.map((r) => [r.sessionId, r.column, r.position]),
      );
    });

    it("appends only the newly-seen sessions after an existing set", () => {
      store.reconcile([{ sessionId: "a" }, { sessionId: "b" }]);
      store.reconcile([{ sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" }]);

      const rows = store.getBoard();
      const byId = Object.fromEntries(rows.map((r) => [r.sessionId, r]));
      expect(byId.a.position).toBe(0);
      expect(byId.b.position).toBe(1);
      expect(byId.c.position).toBe(2);
      expect(byId.c.column).toBe("todo");
    });

    it("sets createdAt/updatedAt from the injected clock", () => {
      clock = 42;
      store.reconcile([{ sessionId: "a" }]);
      const row = store.getRow("a")!;
      expect(row.createdAt).toBe(42);
      expect(row.updatedAt).toBe(42);
    });
  });

  describe("reconcile: auto-promote running + newly-seen sessions", () => {
    it("promotes a live, running, newly-seen session straight to in_progress", () => {
      store.reconcile([{ sessionId: "a", running: true }]);
      const row = store.getRow("a")!;
      expect(row.column).toBe("in_progress");
      expect(row.position).toBe(0);
    });

    it("does not promote a running session that already has a row in a later column", () => {
      store.reconcile([{ sessionId: "a" }]);
      store.moveCard("a", "review", 0);

      // Now "seen again" as running -- should NOT be reset back to in_progress
      // because promoteToInProgress only fires on first sighting (row creation).
      store.reconcile([{ sessionId: "a", running: true }]);

      const row = store.getRow("a")!;
      expect(row.column).toBe("review");
    });

    it("does not promote a non-running newly-seen session", () => {
      store.reconcile([{ sessionId: "a", running: false }]);
      expect(store.getRow("a")!.column).toBe("todo");
    });

    it("mixes new running, new non-running, and pre-existing sessions in one reconcile", () => {
      store.reconcile([{ sessionId: "existing" }]);
      store.reconcile([
        { sessionId: "existing" },
        { sessionId: "new-running", running: true },
        { sessionId: "new-idle", running: false },
      ]);

      expect(store.getRow("existing")!.column).toBe("todo");
      expect(store.getRow("new-running")!.column).toBe("in_progress");
      expect(store.getRow("new-idle")!.column).toBe("todo");

      assertDenseUnique(store, "todo");
      assertDenseUnique(store, "in_progress");
    });
  });

  describe("reconcile: purge", () => {
    it("removes rows whose session is no longer live", () => {
      store.reconcile([{ sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" }]);
      store.reconcile([{ sessionId: "b" }]);

      const rows = store.getBoard();
      expect(rows.map((r) => r.sessionId)).toEqual(["b"]);
    });

    it("compacts remaining positions after purge (no gaps)", () => {
      store.reconcile([{ sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" }]);
      store.reconcile([{ sessionId: "a" }, { sessionId: "c" }]); // drop "b" (middle)

      const positions = assertDenseUnique(store, "todo");
      expect(positions).toEqual([0, 1]);

      const rows = store.getBoard().sort((a, b) => a.position - b.position);
      expect(rows.map((r) => r.sessionId)).toEqual(["a", "c"]);
    });

    it("purgeOrphans alone removes non-live rows and compacts", () => {
      store.reconcile([{ sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" }]);
      store.purgeOrphans([{ sessionId: "a" }]);

      expect(store.getBoard().map((r) => r.sessionId)).toEqual(["a"]);
      assertDenseUnique(store, "todo");
    });
  });

  describe("reconcileOne", () => {
    it("creates a row in DEFAULT_COLUMN if absent and returns it", () => {
      const row = store.reconcileOne("solo");
      expect(row.sessionId).toBe("solo");
      expect(row.column).toBe("todo");
      expect(row.position).toBe(0);
    });

    it("returns the existing row unchanged if already present", () => {
      store.reconcile([{ sessionId: "a" }]);
      store.moveCard("a", "done", 0);

      const row = store.reconcileOne("a");
      expect(row.column).toBe("done");
      expect(row.position).toBe(0);

      // still only one row for "a"
      expect(store.getBoard().filter((r) => r.sessionId === "a")).toHaveLength(1);
    });

    it("appends after existing rows when creating a new one", () => {
      store.reconcile([{ sessionId: "a" }, { sessionId: "b" }]);
      const row = store.reconcileOne("c");
      expect(row.position).toBe(2);
      assertDenseUnique(store, "todo");
    });
  });

  describe("promoteToInProgress", () => {
    it("moves a todo card to the end of in_progress", () => {
      store.reconcile([{ sessionId: "a" }, { sessionId: "existing-ip" }]);
      store.moveCard("existing-ip", "in_progress", 0);

      store.promoteToInProgress("a");

      const row = store.getRow("a")!;
      expect(row.column).toBe("in_progress");
      expect(row.position).toBe(1); // after existing-ip
      assertDenseUnique(store, "in_progress");
      assertDenseUnique(store, "todo");
    });

    it("is a no-op if the card is already past todo (e.g. review)", () => {
      store.reconcile([{ sessionId: "a" }]);
      store.moveCard("a", "review", 0);

      store.promoteToInProgress("a");

      expect(store.getRow("a")!.column).toBe("review");
    });

    it("is a no-op if the card is already in in_progress", () => {
      store.reconcile([{ sessionId: "a" }]);
      store.moveCard("a", "in_progress", 0);
      const before = store.getRow("a")!;

      store.promoteToInProgress("a");

      const after = store.getRow("a")!;
      expect(after.column).toBe("in_progress");
      expect(after.position).toBe(before.position);
    });

    it("is a safe no-op for an unknown session id", () => {
      expect(() => store.promoteToInProgress("ghost")).not.toThrow();
      expect(store.getRow("ghost")).toBeUndefined();
    });
  });

  describe("moveCard: within-column reindex", () => {
    beforeEach(() => {
      store.reconcile([{ sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" }, { sessionId: "d" }]);
      // initial todo order: a=0, b=1, c=2, d=3
    });

    it("moves a card to position 0 (front)", () => {
      store.moveCard("d", "todo", 0);

      const rows = store.getBoard().sort((x, y) => x.position - y.position);
      expect(rows.map((r) => r.sessionId)).toEqual(["d", "a", "b", "c"]);
      assertDenseUnique(store, "todo");
    });

    it("moves a card to the end", () => {
      store.moveCard("a", "todo", 3); // 3 remaining siblings -> end

      const rows = store.getBoard().sort((x, y) => x.position - y.position);
      expect(rows.map((r) => r.sessionId)).toEqual(["b", "c", "d", "a"]);
      assertDenseUnique(store, "todo");
    });

    it("moves a card to a middle position, shifting siblings", () => {
      store.moveCard("d", "todo", 1);

      const rows = store.getBoard().sort((x, y) => x.position - y.position);
      expect(rows.map((r) => r.sessionId)).toEqual(["a", "d", "b", "c"]);
      assertDenseUnique(store, "todo");
    });

    it("swapping two adjacent cards does not collide on the unique index", () => {
      store.moveCard("b", "todo", 2); // swap b and c

      const rows = store.getBoard().sort((x, y) => x.position - y.position);
      expect(rows.map((r) => r.sessionId)).toEqual(["a", "c", "b", "d"]);
      assertDenseUnique(store, "todo");
    });

    it("clamps an out-of-range position to the end", () => {
      store.moveCard("a", "todo", 999);

      const rows = store.getBoard().sort((x, y) => x.position - y.position);
      expect(rows.map((r) => r.sessionId)).toEqual(["b", "c", "d", "a"]);
      assertDenseUnique(store, "todo");
    });

    it("clamps a negative position to 0", () => {
      store.moveCard("d", "todo", -5);

      const rows = store.getBoard().sort((x, y) => x.position - y.position);
      expect(rows.map((r) => r.sessionId)).toEqual(["d", "a", "b", "c"]);
      assertDenseUnique(store, "todo");
    });

    it("moving a card to its own current position is a no-op ordering-wise", () => {
      store.moveCard("b", "todo", 1);

      const rows = store.getBoard().sort((x, y) => x.position - y.position);
      expect(rows.map((r) => r.sessionId)).toEqual(["a", "b", "c", "d"]);
      assertDenseUnique(store, "todo");
    });
  });

  describe("moveCard: cross-column", () => {
    beforeEach(() => {
      store.reconcile([{ sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" }]);
    });

    it("moves a card into an empty column at position 0", () => {
      store.moveCard("b", "done", 0);

      const row = store.getRow("b")!;
      expect(row.column).toBe("done");
      expect(row.position).toBe(0);

      assertDenseUnique(store, "done");
      const remainingTodo = assertDenseUnique(store, "todo");
      expect(remainingTodo).toEqual([0, 1]);
    });

    it("compacts the source column after a cross-column move (no gap left behind)", () => {
      store.moveCard("a", "review", 0); // remove from front of todo

      const rows = store.getBoard().filter((r) => r.column === "todo").sort((x, y) => x.position - y.position);
      expect(rows.map((r) => r.sessionId)).toEqual(["b", "c"]);
      assertDenseUnique(store, "todo");
    });

    it("inserts into the middle of a populated target column", () => {
      store.moveCard("a", "in_progress", 0);
      store.moveCard("c", "in_progress", 1); // now in_progress = [a, c]

      store.moveCard("b", "in_progress", 1); // insert between a and c

      const rows = store.getBoard().filter((r) => r.column === "in_progress").sort((x, y) => x.position - y.position);
      expect(rows.map((r) => r.sessionId)).toEqual(["a", "b", "c"]);
      assertDenseUnique(store, "in_progress");
    });

    it("updates updatedAt for the moved card using the injected clock", () => {
      clock = 5000;
      store.moveCard("a", "done", 0);
      expect(store.getRow("a")!.updatedAt).toBe(5000);
    });

    it("throws for an unknown session id", () => {
      expect(() => store.moveCard("ghost", "done", 0)).toThrow();
    });
  });

  describe("combined reconcile + moveCard + promote flows", () => {
    it("supports a realistic sequence without corrupting positions", () => {
      store.reconcile([{ sessionId: "s1" }, { sessionId: "s2", running: true }]);
      // s1 -> todo:0, s2 -> in_progress:0

      store.moveCard("s1", "in_progress", 0); // s1 in front of s2
      store.reconcile([
        { sessionId: "s1" },
        { sessionId: "s2", running: true },
        { sessionId: "s3", running: true },
      ]);
      // s3 is newly seen + running -> straight to in_progress, appended at end

      store.promoteToInProgress("s2"); // no-op, s2 already in in_progress

      const inProgress = store
        .getBoard()
        .filter((r) => r.column === "in_progress")
        .sort((a, b) => a.position - b.position);

      expect(inProgress.map((r) => r.sessionId)).toEqual(["s1", "s2", "s3"]);
      assertDenseUnique(store, "in_progress");
      assertDenseUnique(store, "todo");
    });
  });
});
