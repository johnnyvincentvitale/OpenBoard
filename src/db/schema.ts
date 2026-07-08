import type Database from "better-sqlite3";

/**
 * Shared SQLite metadata used by stores before they install their own tables.
 */
export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
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
