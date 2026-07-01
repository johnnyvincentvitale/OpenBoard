import Database from "better-sqlite3";
import type { BoardRow, Column, ColumnStore, SessionRef } from "../shared";
import { DEFAULT_COLUMN } from "../shared";
import { bootstrap } from "./schema";

interface BoardRowRecord {
  session_id: string;
  column: string;
  position: number;
  created_at: number;
  updated_at: number;
}

function toBoardRow(record: BoardRowRecord): BoardRow {
  return {
    sessionId: record.session_id,
    column: record.column as Column,
    position: record.position,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

/**
 * better-sqlite3-backed ColumnStore. Fully synchronous. Positions are dense
 * integers starting at 0, unique within a column; every mutation that can
 * disturb sibling ordering runs inside a single db.transaction() so the
 * table never observes a duplicate or gapped position.
 */
export class SqliteColumnStore implements ColumnStore {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly ownsDb: boolean;

  constructor(dbOrPath: Database.Database | string = ":memory:", opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());

    if (typeof dbOrPath === "string") {
      this.db = new Database(dbOrPath);
      this.ownsDb = true;
    } else {
      this.db = dbOrPath;
      this.ownsDb = false;
    }

    this.db.pragma("journal_mode = WAL");
    bootstrap(this.db);

    this.stmts = {
      getBoard: this.db.prepare("SELECT * FROM board_row ORDER BY column, position"),
      getRow: this.db.prepare("SELECT * FROM board_row WHERE session_id = ?"),
      getColumnRows: this.db.prepare(
        "SELECT * FROM board_row WHERE column = ? ORDER BY position",
      ),
      maxPositionInColumn: this.db.prepare(
        "SELECT MAX(position) AS maxPos FROM board_row WHERE column = ?",
      ),
      countInColumn: this.db.prepare(
        "SELECT COUNT(*) AS n FROM board_row WHERE column = ?",
      ),
      insertRow: this.db.prepare(
        `INSERT INTO board_row (session_id, column, position, created_at, updated_at)
         VALUES (@sessionId, @column, @position, @createdAt, @updatedAt)`,
      ),
      updateRowPlacement: this.db.prepare(
        `UPDATE board_row SET column = @column, position = @position, updated_at = @updatedAt
         WHERE session_id = @sessionId`,
      ),
      // Bump a row into a temporary negative position space so we can freely
      // renumber siblings without tripping the UNIQUE(column, position) index
      // mid-transaction.
      parkRow: this.db.prepare(
        "UPDATE board_row SET position = @position WHERE session_id = @sessionId",
      ),
      deleteRow: this.db.prepare("DELETE FROM board_row WHERE session_id = ?"),
      allSessionIds: this.db.prepare("SELECT session_id FROM board_row"),
    };
  }

  private readonly stmts: {
    getBoard: Database.Statement;
    getRow: Database.Statement;
    getColumnRows: Database.Statement;
    maxPositionInColumn: Database.Statement;
    countInColumn: Database.Statement;
    insertRow: Database.Statement;
    updateRowPlacement: Database.Statement;
    parkRow: Database.Statement;
    deleteRow: Database.Statement;
    allSessionIds: Database.Statement;
  };

  getBoard(): BoardRow[] {
    const rows = this.stmts.getBoard.all() as BoardRowRecord[];
    return rows.map(toBoardRow);
  }

  getRow(sessionId: string): BoardRow | undefined {
    const row = this.stmts.getRow.get(sessionId) as BoardRowRecord | undefined;
    return row ? toBoardRow(row) : undefined;
  }

  reconcile(live: SessionRef[]): void {
    const runTxn = this.db.transaction((liveSessions: SessionRef[]) => {
      for (const ref of liveSessions) {
        const existing = this.getRowInTxn(ref.sessionId);
        if (!existing) {
          this.appendToColumnInTxn(ref.sessionId, DEFAULT_COLUMN);
          if (ref.running) {
            this.promoteToInProgressInTxn(ref.sessionId);
          }
        }
      }
      this.purgeOrphansInTxn(liveSessions);
    });

    runTxn(live);
  }

  reconcileOne(sessionId: string): BoardRow {
    const runTxn = this.db.transaction((id: string) => {
      const existing = this.getRowInTxn(id);
      if (existing) return existing;
      this.appendToColumnInTxn(id, DEFAULT_COLUMN);
      const created = this.getRowInTxn(id);
      if (!created) {
        throw new Error(`SqliteColumnStore: failed to create row for session ${id}`);
      }
      return created;
    });

    return runTxn(sessionId);
  }

  moveCard(sessionId: string, column: Column, position: number): void {
    const runTxn = this.db.transaction((id: string, targetColumn: Column, targetPosition: number) => {
      const existing = this.getRowInTxn(id);
      if (!existing) {
        throw new Error(`SqliteColumnStore: unknown session ${id}`);
      }
      this.moveCardInTxn(existing, targetColumn, targetPosition);
    });

    runTxn(sessionId, column, position);
  }

  promoteToInProgress(sessionId: string): void {
    const runTxn = this.db.transaction((id: string) => {
      this.promoteToInProgressInTxn(id);
    });

    runTxn(sessionId);
  }

  purgeOrphans(live: SessionRef[]): void {
    const runTxn = this.db.transaction((liveSessions: SessionRef[]) => {
      this.purgeOrphansInTxn(liveSessions);
    });

    runTxn(live);
  }

  /** Close the underlying connection. Only meaningful when this store opened it (path constructor). */
  close(): void {
    if (this.ownsDb) {
      this.db.close();
    }
  }

  // ---- internal helpers (must only be called from within a db.transaction) ----

  private getRowInTxn(sessionId: string): BoardRow | undefined {
    const row = this.stmts.getRow.get(sessionId) as BoardRowRecord | undefined;
    return row ? toBoardRow(row) : undefined;
  }

  private appendToColumnInTxn(sessionId: string, column: Column): void {
    const maxRow = this.stmts.maxPositionInColumn.get(column) as { maxPos: number | null };
    const nextPosition = maxRow.maxPos === null ? 0 : maxRow.maxPos + 1;
    const ts = this.now();
    this.stmts.insertRow.run({
      sessionId,
      column,
      position: nextPosition,
      createdAt: ts,
      updatedAt: ts,
    });
  }

  private promoteToInProgressInTxn(sessionId: string): void {
    const existing = this.getRowInTxn(sessionId);
    if (!existing) return;
    if (existing.column !== "todo") return;
    this.moveCardInTxn(existing, "in_progress", Number.POSITIVE_INFINITY);
  }

  private purgeOrphansInTxn(live: SessionRef[]): void {
    const liveIds = new Set(live.map((s) => s.sessionId));
    const allIds = this.stmts.allSessionIds.all() as { session_id: string }[];
    const affectedColumns = new Set<Column>();

    for (const { session_id } of allIds) {
      if (!liveIds.has(session_id)) {
        const row = this.getRowInTxn(session_id);
        if (row) affectedColumns.add(row.column);
        this.stmts.deleteRow.run(session_id);
      }
    }

    for (const column of affectedColumns) {
      this.compactColumnInTxn(column);
    }
  }

  /**
   * Move `existing` to `targetColumn` at `targetPosition` (clamped into
   * range; Infinity means "end"), reindexing every disturbed column so
   * positions stay dense (0..n-1) and unique.
   */
  private moveCardInTxn(existing: BoardRow, targetColumn: Column, targetPosition: number): void {
    const sameColumn = existing.column === targetColumn;

    // Siblings in the target column, excluding the moving card itself.
    const targetSiblings = (
      this.stmts.getColumnRows.all(targetColumn) as BoardRowRecord[]
    )
      .map(toBoardRow)
      .filter((r) => r.sessionId !== existing.sessionId);

    const clamped = Math.max(0, Math.min(targetPosition, targetSiblings.length));

    const newOrder = [
      ...targetSiblings.slice(0, clamped),
      { ...existing, column: targetColumn },
      ...targetSiblings.slice(clamped),
    ];

    // Park every row in the target column into a disjoint negative range
    // first so intermediate UPDATEs never collide with the UNIQUE(column,
    // position) index (e.g. swapping two adjacent rows).
    newOrder.forEach((row, idx) => {
      this.stmts.parkRow.run({ sessionId: row.sessionId, position: -(idx + 1) });
    });

    const ts = this.now();
    newOrder.forEach((row, idx) => {
      this.stmts.updateRowPlacement.run({
        sessionId: row.sessionId,
        column: targetColumn,
        position: idx,
        updatedAt: row.sessionId === existing.sessionId ? ts : row.updatedAt,
      });
    });

    if (!sameColumn) {
      this.compactColumnInTxn(existing.column);
    }
  }

  /** Renumber a column's rows to dense 0..n-1 in current position order. */
  private compactColumnInTxn(column: Column): void {
    const rows = (this.stmts.getColumnRows.all(column) as BoardRowRecord[]).map(toBoardRow);
    if (rows.length === 0) return;

    rows.forEach((row, idx) => {
      this.stmts.parkRow.run({ sessionId: row.sessionId, position: -(idx + 1) });
    });
    rows.forEach((row, idx) => {
      this.stmts.updateRowPlacement.run({
        sessionId: row.sessionId,
        column,
        position: idx,
        updatedAt: row.updatedAt,
      });
    });
  }
}
