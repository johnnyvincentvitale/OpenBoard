import type Database from "better-sqlite3";

/**
 * DDL for the board's SQLite-backed column store. `board_row` is the sole
 * persisted table: one row per session, holding which column it's in and its
 * dense-integer position within that column. `schema_meta` holds a single
 * version row so future migrations have somewhere to check compatibility.
 */
export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS board_row (
  session_id TEXT PRIMARY KEY,
  column     TEXT NOT NULL,
  position   INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(column, position)
);

CREATE INDEX IF NOT EXISTS idx_board_row_column ON board_row(column);
CREATE INDEX IF NOT EXISTS idx_board_row_column_position ON board_row(column, position);

CREATE TABLE IF NOT EXISTS schema_meta (
  version INTEGER NOT NULL
);
`;

/**
 * Idempotently create the schema on the given database and seed the
 * `schema_meta` row if it doesn't already exist. Safe to call on every
 * process start.
 */
export function bootstrap(db: Database.Database): void {
  db.exec(SCHEMA_SQL);

  const row = db.prepare("SELECT version FROM schema_meta LIMIT 1").get() as
    | { version: number }
    | undefined;

  if (!row) {
    db.prepare("INSERT INTO schema_meta (version) VALUES (?)").run(SCHEMA_VERSION);
  }
}
