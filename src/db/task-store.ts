import crypto from "node:crypto";
import Database from "better-sqlite3";
import type {
  BoardSettings,
  CompletionReport,
  CompletionSource,
  Column,
  CreateTaskInput,
  ModelRef,
  Task,
  TaskIsolationMode,
  TaskPending,
  TaskRunState,
  TaskStore,
} from "../shared";
import { DEFAULT_COLUMN } from "../shared";
import { bootstrap } from "./schema";

const TASK_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task (
  id          TEXT PRIMARY KEY,
  task_type   TEXT NOT NULL DEFAULT 'agent',
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  directory   TEXT NOT NULL,
  column      TEXT NOT NULL,
  position    INTEGER NOT NULL,
  session_id  TEXT,
  run_state   TEXT NOT NULL,
  run_started_at INTEGER,
  error       TEXT,
  agent       TEXT,
  assigned_to TEXT,
  model       TEXT,
  isolation       TEXT,
  worktree_path   TEXT,
  worktree_branch TEXT,
  base_branch     TEXT,
  pending         TEXT,
  archived        INTEGER NOT NULL DEFAULT 0,
  completion      TEXT,
  completion_source TEXT,
  completed_by    TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(column, position)
);

CREATE INDEX IF NOT EXISTS idx_task_column ON task(column);
CREATE INDEX IF NOT EXISTS idx_task_column_position ON task(column, position);

CREATE TABLE IF NOT EXISTS board_setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_links (
  parent_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  child_id  TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  PRIMARY KEY(parent_id, child_id)
);

CREATE INDEX IF NOT EXISTS idx_task_links_child ON task_links(child_id);
CREATE INDEX IF NOT EXISTS idx_task_links_parent ON task_links(parent_id);
`;

/** Columns added after the initial task schema — ALTER-in for pre-existing DBs. */
const TASK_ADDED_COLUMNS: Array<[string, string]> = [
  ["task_type", "TEXT NOT NULL DEFAULT 'agent'"],
  ["assigned_to", "TEXT"],
  ["isolation", "TEXT"],
  ["worktree_path", "TEXT"],
  ["worktree_branch", "TEXT"],
  ["base_branch", "TEXT"],
  ["pending", "TEXT"],
  ["run_started_at", "INTEGER"],
  ["archived", "INTEGER NOT NULL DEFAULT 0"],
  ["completion", "TEXT"],
  ["completion_source", "TEXT"],
  ["completed_by", "TEXT"],
];

const DEFAULT_SETTINGS: BoardSettings = { worktreeDefault: false };

interface TaskRowRecord {
  id: string;
  task_type: string;
  title: string;
  description: string;
  directory: string;
  column: string;
  position: number;
  session_id: string | null;
  run_state: string;
  run_started_at: number | null;
  error: string | null;
  agent: string | null;
  assigned_to: string | null;
  model: string | null;
  isolation: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
  base_branch: string | null;
  pending: string | null;
  archived: number;
  completion: string | null;
  completion_source: string | null;
  completed_by: string | null;
  created_at: number;
  updated_at: number;
}

function toTask(record: TaskRowRecord): Task {
  const task: Task = {
    id: record.id,
    type: record.task_type === "manual" ? "manual" : "agent",
    title: record.title,
    description: record.description,
    directory: record.directory,
    column: record.column as Column,
    position: record.position,
    runState: record.run_state as TaskRunState,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    agent: record.agent ?? undefined,
    assignedTo: record.assigned_to ?? undefined,
    model: record.model ? (JSON.parse(record.model) as ModelRef) : undefined,
    archived: record.archived === 1,
    parentIds: [],
    completion: record.completion ? (JSON.parse(record.completion) as CompletionReport) : null,
    completionSource: record.completion_source as CompletionSource | null,
    completedBy: record.completed_by ?? null,
  };
  if (record.session_id !== null) task.sessionId = record.session_id;
  if (record.run_started_at !== null) task.runStartedAt = record.run_started_at;
  if (record.error !== null) task.error = record.error;
  if (record.isolation !== null) task.isolation = record.isolation as TaskIsolationMode;
  if (record.worktree_path !== null) task.worktreePath = record.worktree_path;
  if (record.worktree_branch !== null) task.worktreeBranch = record.worktree_branch;
  if (record.base_branch !== null) task.baseBranch = record.base_branch;
  if (record.pending !== null) task.pending = record.pending as TaskPending;
  return task;
}

/**
 * better-sqlite3-backed TaskStore. Fully synchronous. Positions are dense
 * integers starting at 0, unique within a column; every mutation that can
 * disturb sibling ordering runs inside a single db.transaction() so the
 * table never observes a duplicate or gapped position. Mirrors the
 * SqliteColumnStore pattern in board-store.ts.
 */
export class SqliteTaskStore implements TaskStore {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly genId: () => string;
  private readonly ownsDb: boolean;

  constructor(
    dbOrPath: Database.Database | string = ":memory:",
    opts: { now?: () => number; genId?: () => string } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.genId = opts.genId ?? (() => `task_${crypto.randomUUID()}`);

    if (typeof dbOrPath === "string") {
      this.db = new Database(dbOrPath);
      this.ownsDb = true;
    } else {
      this.db = dbOrPath;
      this.ownsDb = false;
    }

    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    bootstrap(this.db);
    this.db.exec(TASK_SCHEMA_SQL);
    this.migrateTaskColumns();

    this.stmts = {
      listTasks: this.db.prepare(
        "SELECT * FROM task WHERE archived = @archived ORDER BY column, position",
      ),
      listAllTasks: this.db.prepare("SELECT * FROM task ORDER BY column, position"),
      getTask: this.db.prepare("SELECT * FROM task WHERE id = ?"),
      getColumnRows: this.db.prepare("SELECT * FROM task WHERE column = ? ORDER BY position"),
      maxPositionInColumn: this.db.prepare(
        "SELECT MAX(position) AS maxPos FROM task WHERE column = ?",
      ),
      insertTask: this.db.prepare(
        `INSERT INTO task (id, task_type, title, description, directory, column, position, session_id, run_state, run_started_at, error, agent, assigned_to, model, isolation, worktree_path, worktree_branch, base_branch, pending, archived, completion, completion_source, completed_by, created_at, updated_at)
         VALUES (@id, @type, @title, @description, @directory, @column, @position, @sessionId, @runState, @runStartedAt, @error, @agent, @assignedTo, @model, @isolation, @worktreePath, @worktreeBranch, @baseBranch, @pending, @archived, @completion, @completionSource, @completedBy, @createdAt, @updatedAt)`,
      ),
      updateTaskFields: this.db.prepare(
        `UPDATE task SET
           task_type = @type,
           title = @title,
           description = @description,
           directory = @directory,
           column = @column,
           position = @position,
           session_id = @sessionId,
           run_state = @runState,
           run_started_at = @runStartedAt,
           error = @error,
           agent = @agent,
           assigned_to = @assignedTo,
           model = @model,
           isolation = @isolation,
           worktree_path = @worktreePath,
           worktree_branch = @worktreeBranch,
           base_branch = @baseBranch,
           pending = @pending,
           archived = @archived,
           completion = @completion,
           completion_source = @completionSource,
           completed_by = @completedBy,
           updated_at = @updatedAt
         WHERE id = @id`,
      ),
      updateTaskPlacement: this.db.prepare(
        `UPDATE task SET column = @column, position = @position, updated_at = @updatedAt WHERE id = @id`,
      ),
      parkTask: this.db.prepare("UPDATE task SET position = @position WHERE id = @id"),
      deleteTask: this.db.prepare("DELETE FROM task WHERE id = ?"),
      deleteLinksForTask: this.db.prepare(
        "DELETE FROM task_links WHERE parent_id = ? OR child_id = ?",
      ),
      getLink: this.db.prepare(
        "SELECT parent_id, child_id FROM task_links WHERE parent_id = ? AND child_id = ?",
      ),
      insertLink: this.db.prepare("INSERT INTO task_links (parent_id, child_id) VALUES (?, ?)"),
      deleteLink: this.db.prepare("DELETE FROM task_links WHERE parent_id = ? AND child_id = ?"),
      getParentIds: this.db.prepare(
        "SELECT parent_id FROM task_links WHERE child_id = ? ORDER BY parent_id",
      ),
      getChildIds: this.db.prepare(
        "SELECT child_id FROM task_links WHERE parent_id = ? ORDER BY child_id",
      ),
      getSetting: this.db.prepare("SELECT value FROM board_setting WHERE key = ?"),
      putSetting: this.db.prepare(
        "INSERT INTO board_setting (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = @value",
      ),
    };
  }

  /** Add columns introduced after the initial schema to a pre-existing task table. */
  private migrateTaskColumns(): void {
    const existing = new Set(
      (this.db.prepare("PRAGMA table_info(task)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    for (const [name, type] of TASK_ADDED_COLUMNS) {
      if (!existing.has(name)) {
        this.db.exec(`ALTER TABLE task ADD COLUMN ${name} ${type}`);
      }
    }
  }

  private readonly stmts: {
    listTasks: Database.Statement;
    listAllTasks: Database.Statement;
    getTask: Database.Statement;
    getColumnRows: Database.Statement;
    maxPositionInColumn: Database.Statement;
    insertTask: Database.Statement;
    updateTaskFields: Database.Statement;
    updateTaskPlacement: Database.Statement;
    parkTask: Database.Statement;
    deleteTask: Database.Statement;
    getSetting: Database.Statement;
    putSetting: Database.Statement;
    deleteLinksForTask: Database.Statement;
    getLink: Database.Statement;
    insertLink: Database.Statement;
    deleteLink: Database.Statement;
    getParentIds: Database.Statement;
    getChildIds: Database.Statement;
  };

  list(filter: { archived?: "exclude" | "only" | "all" } = {}): Task[] {
    const mode = filter.archived ?? "exclude";
    const rows =
      mode === "all"
        ? (this.stmts.listAllTasks.all() as TaskRowRecord[])
        : (this.stmts.listTasks.all({ archived: mode === "only" ? 1 : 0 }) as TaskRowRecord[]);
    return rows.map((row) => this.withParentIds(toTask(row)));
  }

  get(id: string): Task | undefined {
    const row = this.stmts.getTask.get(id) as TaskRowRecord | undefined;
    return row ? this.withParentIds(toTask(row)) : undefined;
  }

  create(input: CreateTaskInput): Task {
    const runTxn = this.db.transaction((data: CreateTaskInput) => {
      const maxRow = this.stmts.maxPositionInColumn.get(DEFAULT_COLUMN) as {
        maxPos: number | null;
      };
      const position = maxRow.maxPos === null ? 0 : maxRow.maxPos + 1;
      const ts = this.now();
      const id = this.genId();

      this.stmts.insertTask.run({
        id,
        type: data.type ?? "agent",
        title: data.title,
        description: data.description,
        directory: data.directory,
        column: DEFAULT_COLUMN,
        position,
        sessionId: null,
        runState: "unstarted",
        runStartedAt: null,
        error: null,
        agent: data.agent ?? null,
        assignedTo: data.assignedTo ?? null,
        model: data.model ? JSON.stringify(data.model) : null,
        isolation: data.isolation ?? null,
        worktreePath: null,
        worktreeBranch: null,
        baseBranch: null,
        pending: null,
        archived: 0,
        completion: null,
        completionSource: null,
        completedBy: null,
        createdAt: ts,
        updatedAt: ts,
      });

      return this.getTaskInTxn(id)!;
    });

    return runTxn(input);
  }

  update(id: string, patch: Partial<Omit<Task, "id" | "createdAt">>): Task | undefined {
    const runTxn = this.db.transaction((taskId: string, p: Partial<Omit<Task, "id" | "createdAt">>) => {
      const existing = this.getTaskInTxn(taskId);
      if (!existing) return undefined;

      // id/createdAt are excluded from the patch type itself; merge everything else.
      const merged: Task = { ...existing, ...p };

      this.stmts.updateTaskFields.run({
        id: taskId,
        type: merged.type,
        title: merged.title,
        description: merged.description,
        directory: merged.directory,
        column: merged.column,
        position: merged.position,
        sessionId: merged.sessionId ?? null,
        runState: merged.runState,
        runStartedAt: merged.runStartedAt ?? null,
        error: merged.error ?? null,
        agent: merged.agent ?? null,
        assignedTo: merged.assignedTo ?? null,
        model: merged.model ? JSON.stringify(merged.model) : null,
        isolation: merged.isolation ?? null,
        worktreePath: merged.worktreePath ?? null,
        worktreeBranch: merged.worktreeBranch ?? null,
        baseBranch: merged.baseBranch ?? null,
        pending: merged.pending ?? null,
        archived: merged.archived ? 1 : 0,
        completion: merged.completion ? JSON.stringify(merged.completion) : null,
        completionSource: merged.completionSource ?? null,
        completedBy: merged.completedBy ?? null,
        updatedAt: this.now(),
      });

      return this.getTaskInTxn(taskId);
    });

    return runTxn(id, patch);
  }

  move(id: string, column: Column, position: number): void {
    const runTxn = this.db.transaction((taskId: string, targetColumn: Column, targetPosition: number) => {
      const existing = this.getTaskInTxn(taskId);
      if (!existing) {
        throw new Error(`SqliteTaskStore: unknown task ${taskId}`);
      }
      this.moveTaskInTxn(existing, targetColumn, targetPosition);
    });

    runTxn(id, column, position);
  }

  remove(id: string): void {
    const runTxn = this.db.transaction((taskId: string) => {
      const existing = this.getTaskInTxn(taskId);
      if (!existing) return;

      this.stmts.deleteLinksForTask.run(taskId, taskId);
      this.stmts.deleteTask.run(taskId);
      this.compactColumnInTxn(existing.column);
    });

    runTxn(id);
  }

  setCompletion(id: string, report: CompletionReport, source: CompletionSource): Task | undefined {
    return this.update(id, { completion: report, completionSource: source });
  }

  setArchived(id: string, archived: boolean): Task | undefined {
    return this.update(id, { archived });
  }

  addLink(parentId: string, childId: string): void {
    const runTxn = this.db.transaction((parent: string, child: string) => {
      if (parent === child) {
        throw new Error("SqliteTaskStore: task link cannot reference itself");
      }
      if (!this.getTaskInTxn(parent)) {
        throw new Error(`SqliteTaskStore: unknown parent task ${parent}`);
      }
      if (!this.getTaskInTxn(child)) {
        throw new Error(`SqliteTaskStore: unknown child task ${child}`);
      }
      const existing = this.stmts.getLink.get(parent, child) as
        | { parent_id: string; child_id: string }
        | undefined;
      if (existing) {
        throw new Error(`SqliteTaskStore: duplicate task link ${parent} -> ${child}`);
      }
      this.stmts.insertLink.run(parent, child);
    });

    runTxn(parentId, childId);
  }

  removeLink(parentId: string, childId: string): void {
    this.stmts.deleteLink.run(parentId, childId);
  }

  getParentIds(childId: string): string[] {
    return (this.stmts.getParentIds.all(childId) as Array<{ parent_id: string }>).map(
      (row) => row.parent_id,
    );
  }

  getChildIds(parentId: string): string[] {
    return (this.stmts.getChildIds.all(parentId) as Array<{ child_id: string }>).map(
      (row) => row.child_id,
    );
  }

  getSettings(): BoardSettings {
    const row = this.stmts.getSetting.get("worktreeDefault") as { value: string } | undefined;
    return {
      worktreeDefault: row ? row.value === "true" : DEFAULT_SETTINGS.worktreeDefault,
    };
  }

  updateSettings(patch: Partial<BoardSettings>): BoardSettings {
    const next = { ...this.getSettings(), ...patch };
    this.stmts.putSetting.run({ key: "worktreeDefault", value: next.worktreeDefault ? "true" : "false" });
    return next;
  }

  /** Close the underlying connection. Only meaningful when this store opened it (path constructor). */
  close(): void {
    if (this.ownsDb) {
      this.db.close();
    }
  }

  // ---- internal helpers (must only be called from within a db.transaction) ----

  private getTaskInTxn(id: string): Task | undefined {
    const row = this.stmts.getTask.get(id) as TaskRowRecord | undefined;
    return row ? this.withParentIds(toTask(row)) : undefined;
  }

  private withParentIds(task: Task): Task {
    return { ...task, parentIds: this.getParentIds(task.id) };
  }

  /**
   * Move `existing` to `targetColumn` at `targetPosition` (clamped into
   * range), reindexing every disturbed column so positions stay dense
   * (0..n-1) and unique.
   */
  private moveTaskInTxn(existing: Task, targetColumn: Column, targetPosition: number): void {
    const sameColumn = existing.column === targetColumn;

    const targetSiblings = (this.stmts.getColumnRows.all(targetColumn) as TaskRowRecord[])
      .map(toTask)
      .filter((t) => t.id !== existing.id);

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
      this.stmts.parkTask.run({ id: row.id, position: -(idx + 1) });
    });

    const ts = this.now();
    newOrder.forEach((row, idx) => {
      this.stmts.updateTaskPlacement.run({
        id: row.id,
        column: targetColumn,
        position: idx,
        updatedAt: row.id === existing.id ? ts : row.updatedAt,
      });
    });

    if (!sameColumn) {
      this.compactColumnInTxn(existing.column);
    }
  }

  /** Renumber a column's rows to dense 0..n-1 in current position order. */
  private compactColumnInTxn(column: Column): void {
    const rows = (this.stmts.getColumnRows.all(column) as TaskRowRecord[]).map(toTask);
    if (rows.length === 0) return;

    rows.forEach((row, idx) => {
      this.stmts.parkTask.run({ id: row.id, position: -(idx + 1) });
    });
    rows.forEach((row, idx) => {
      this.stmts.updateTaskPlacement.run({
        id: row.id,
        column,
        position: idx,
        updatedAt: row.updatedAt,
      });
    });
  }
}
