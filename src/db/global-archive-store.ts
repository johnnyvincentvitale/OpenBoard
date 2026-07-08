/**
 * Global mirrored archive store.
 *
 * When a task is archived on any instance, a full archive record is mirrored
 * into this shared, cross-instance SQLite database so archived tasks can be
 * inspected without locating the source instance DB.
 *
 * The store lives at a deterministic path under the OpenBoard user-data area
 * (default: ~/.local/share/openboard/archive.sqlite), not inside any single
 * instance's data directory. The path is overrideable via OPENBOARD_ARCHIVE_DB.
 *
 * Mirroring is idempotent on (source_db_path, task_id) — re-archiving the
 * same task replaces the existing mirror row rather than creating duplicates.
 * Unarchiving does NOT delete global archive rows.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Task, TaskComment } from "../shared";

const GLOBAL_ARCHIVE_SCHEMA = `
CREATE TABLE IF NOT EXISTS global_archive (
  source_instance_name TEXT,
  source_port           INTEGER NOT NULL,
  source_workspace      TEXT NOT NULL,
  source_db_path        TEXT NOT NULL,
  task_id               TEXT NOT NULL,
  task_type             TEXT NOT NULL DEFAULT 'agent',
  title                 TEXT NOT NULL,
  description           TEXT NOT NULL,
  directory             TEXT NOT NULL,
  agent                 TEXT,
  assigned_to           TEXT,
  model                 TEXT,
  isolation             TEXT,
  column_name           TEXT NOT NULL,
  run_state             TEXT NOT NULL,
  run_started_at        INTEGER,
  error                 TEXT,
  session_id            TEXT,
  worktree_path         TEXT,
  worktree_branch       TEXT,
  base_branch           TEXT,
  completion            TEXT,
  final_session_output  TEXT,
  completion_source     TEXT,
  comments              TEXT,
  completed_by          TEXT,
  archived_at           INTEGER NOT NULL,
  task_created_at       INTEGER NOT NULL,
  task_updated_at       INTEGER NOT NULL,
  mirrored_at           INTEGER NOT NULL,
  PRIMARY KEY(source_db_path, task_id)
);
`;

const GLOBAL_ARCHIVE_COLUMNS: Array<[name: string, definition: string]> = [
  ["task_type", "TEXT NOT NULL DEFAULT 'agent'"],
  ["assigned_to", "TEXT"],
  ["final_session_output", "TEXT"],
  ["comments", "TEXT"],
  ["completed_by", "TEXT"],
];

/** Identity of the source OpenBoard instance that archived a task. */
export interface SourceInstanceInfo {
  /** Human-readable instance name (may be undefined for raw-env instances). */
  name?: string;
  /** Adapter port the instance listens on. */
  port: number;
  /** Workspace the instance was started with. */
  workspace: string;
  /** Path to this instance's task-store SQLite file (unique per-instance). */
  dbPath: string;
  /** Live OpenCode backend URL, when known for a running adapter. */
  opencodeBaseUrl?: string;
}

/** Full mirrored record as returned from the database. */
export interface GlobalArchiveRecord {
  source_instance_name: string | null;
  source_port: number;
  source_workspace: string;
  source_db_path: string;
  task_id: string;
  task_type: string;
  title: string;
  description: string;
  directory: string;
  agent: string | null;
  assigned_to: string | null;
  model: string | null;
  isolation: string | null;
  column_name: string;
  run_state: string;
  run_started_at: number | null;
  error: string | null;
  session_id: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
  base_branch: string | null;
  completion: string | null;
  final_session_output: string | null;
  completion_source: string | null;
  comments: string | null;
  completed_by: string | null;
  archived_at: number;
  task_created_at: number;
  task_updated_at: number;
  mirrored_at: number;
}

/**
 * Resolve the global archive DB path.
 *
 * Default: `${HOME}/.local/share/openboard/archive.sqlite`.
 * Override: set `OPENBOARD_ARCHIVE_DB` to a fully-qualified file path.
 */
export function resolveGlobalArchivePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  return env.OPENBOARD_ARCHIVE_DB?.trim() || `${home}/.local/share/openboard/archive.sqlite`;
}

function ensureParentDirectory(dbPath: string): void {
  if (dbPath === ":memory:") return;
  const parent = dirname(dbPath);
  if (parent !== ".") {
    mkdirSync(parent, { recursive: true });
  }
}

/**
 * Cross-instance global archive backed by SQLite.
 *
 * Accepts a path string (opens + owns the connection) or a pre-existing
 * better-sqlite3 `Database` instance (caller manages the connection), so
 * tests can use `:memory:`.
 */
export class GlobalArchiveStore {
  private readonly db: Database.Database;
  private readonly ownsDb: boolean;

  private readonly stmts: {
    upsert: Database.Statement;
    countAll: Database.Statement;
    findByKey: Database.Statement;
    listAll: Database.Statement;
  };

  constructor(dbOrPath: Database.Database | string = resolveGlobalArchivePath()) {
    if (typeof dbOrPath === "string") {
      ensureParentDirectory(dbOrPath);
      this.db = new Database(dbOrPath);
      this.ownsDb = true;
    } else {
      this.db = dbOrPath;
      this.ownsDb = false;
    }

    this.db.pragma("journal_mode = WAL");
    this.db.exec(GLOBAL_ARCHIVE_SCHEMA);
    ensureColumns(this.db);

    this.stmts = {
      upsert: this.db.prepare(
        `INSERT OR REPLACE INTO global_archive (
           source_instance_name, source_port, source_workspace, source_db_path,
           task_id, task_type, title, description, directory,
           agent, assigned_to, model, isolation,
           column_name, run_state, run_started_at, error,
           session_id, worktree_path, worktree_branch, base_branch,
           completion, final_session_output, completion_source, comments, completed_by,
           archived_at, task_created_at, task_updated_at, mirrored_at
         ) VALUES (
           @sourceInstanceName, @sourcePort, @sourceWorkspace, @sourceDbPath,
           @taskId, @taskType, @title, @description, @directory,
           @agent, @assignedTo, @model, @isolation,
           @columnName, @runState, @runStartedAt, @error,
           @sessionId, @worktreePath, @worktreeBranch, @baseBranch,
           @completion, @finalSessionOutput, @completionSource, @comments, @completedBy,
           @archivedAt, @taskCreatedAt, @taskUpdatedAt, @mirroredAt
         )`,
      ),
      countAll: this.db.prepare("SELECT COUNT(*) AS count FROM global_archive"),
      findByKey: this.db.prepare(
        "SELECT * FROM global_archive WHERE source_db_path = ? AND task_id = ?",
      ),
      listAll: this.db.prepare(
        "SELECT * FROM global_archive ORDER BY archived_at DESC",
      ),
    };
  }

  /**
   * Mirror an archived task into the global archive.
   *
   * Idempotent: re-mirroring the same (sourceDbPath, taskId) pair replaces
   * the existing row rather than creating a duplicate — see `INSERT OR REPLACE`
   * on the composite primary key `(source_db_path, task_id)`.
   */
  mirrorTask(task: Task, source: SourceInstanceInfo, archivedAt: number, comments: TaskComment[] = []): void {
    const mirroredAt = Date.now();

    this.stmts.upsert.run({
      sourceInstanceName: source.name ?? null,
      sourcePort: source.port,
      sourceWorkspace: source.workspace,
      sourceDbPath: source.dbPath,
      taskId: task.id,
      taskType: task.type ?? "agent",
      title: task.title,
      description: task.description,
      directory: task.directory,
      agent: task.agent ?? null,
      assignedTo: task.assignedTo ?? null,
      model: task.model ? JSON.stringify(task.model) : null,
      isolation: task.isolation ?? null,
      columnName: task.column,
      runState: task.runState,
      runStartedAt: task.runStartedAt ?? null,
      error: task.error ?? null,
      sessionId: task.sessionId ?? null,
      worktreePath: task.worktreePath ?? null,
      worktreeBranch: task.worktreeBranch ?? null,
      baseBranch: task.baseBranch ?? null,
      completion: task.completion ? JSON.stringify(task.completion) : null,
      finalSessionOutput: task.finalSessionOutput ?? null,
      completionSource: task.completionSource ?? null,
      comments: comments.length ? JSON.stringify(comments) : null,
      completedBy: task.completedBy ?? null,
      archivedAt,
      taskCreatedAt: task.createdAt,
      taskUpdatedAt: task.updatedAt,
      mirroredAt,
    });
  }

  /** Count all mirrored rows (useful for assertions in tests). */
  countMirrored(): number {
    const row = this.stmts.countAll.get() as { count: number };
    return row.count;
  }

  /**
   * Look up a mirrored record by source instance DB path + original task id.
   * Returns `undefined` when no mirror row exists.
   */
  getMirrored(sourceDbPath: string, taskId: string): GlobalArchiveRecord | undefined {
    return this.stmts.findByKey.get(sourceDbPath, taskId) as GlobalArchiveRecord | undefined;
  }

  /**
   * Return all mirrored records ordered by `archived_at` descending
   * (most recently archived first).
   */
  listAll(): GlobalArchiveRecord[] {
    return this.stmts.listAll.all() as GlobalArchiveRecord[];
  }

  /** Close the underlying connection (only when this store opened it). */
  close(): void {
    if (this.ownsDb) {
      this.db.close();
    }
  }
}

function ensureColumns(db: Database.Database): void {
  const existing = new Set(
    (db.prepare("PRAGMA table_info(global_archive)").all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
  for (const [name, definition] of GLOBAL_ARCHIVE_COLUMNS) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE global_archive ADD COLUMN ${name} ${definition}`);
    }
  }
}
