import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { SqliteTaskStore } from "../../../src/db/task-store";
import { GlobalArchiveStore } from "../../../src/db/global-archive-store";
import { registerArchiveRoutes } from "../../../src/server/routes/archive";

function makeApp(options: {
  archiveDiffSnapshot?: Parameters<typeof registerArchiveRoutes>[1]["archiveDiffSnapshot"];
} = {}) {
  const store = new SqliteTaskStore(":memory:");
  const globalArchiveStore = new GlobalArchiveStore(":memory:");
  const app = new Hono();
  registerArchiveRoutes(app, {
    store,
    globalArchiveStore,
    sourceInstance: {
      name: "test-instance",
      port: 4099,
      workspace: "/ws",
      dbPath: "/db/test-tasks.sqlite",
    },
    archiveDiffSnapshot: options.archiveDiffSnapshot,
  });
  return { app, store, globalArchiveStore };
}

describe("archive routes", () => {
  let store: SqliteTaskStore;
  let globalArchiveStore: GlobalArchiveStore;
  let app: Hono;

  beforeEach(() => {
    const m = makeApp();
    store = m.store;
    globalArchiveStore = m.globalArchiveStore;
    app = m.app;
  });

  afterEach(() => {
    store.close();
    globalArchiveStore.close();
  });

  it("archives a review task", async () => {
    const task = store.create({ title: "Review me", description: "", directory: "/repo" });
    store.move(task.id, "review", 0);

    const res = await app.request(`/api/tasks/${task.id}/archive`, { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.archived).toBe(true);
    expect(store.get(task.id)?.archived).toBe(true);
  });

  it("rejects archiving a todo task", async () => {
    const task = store.create({ title: "Todo", description: "", directory: "/repo" });

    const res = await app.request(`/api/tasks/${task.id}/archive`, { method: "POST" });

    expect(res.status).toBe(409);
    expect(store.get(task.id)?.archived).toBe(false);
  });

  it("rejects archiving a running review task", async () => {
    const task = store.create({ title: "Still running", description: "", directory: "/repo" });
    store.move(task.id, "review", 0);
    store.update(task.id, { runState: "running", runStartedAt: 1000, sessionId: "ses_live" });

    const res = await app.request(`/api/tasks/${task.id}/archive`, { method: "POST" });

    expect(res.status).toBe(409);
    expect(store.get(task.id)).toMatchObject({ archived: false, runState: "running" });
    expect(globalArchiveStore.countMirrored()).toBe(0);
  });

  it("returns 404 for archiving an unknown task", async () => {
    const res = await app.request("/api/tasks/missing/archive", { method: "POST" });

    expect(res.status).toBe(404);
  });

  it("unarchives an archived task", async () => {
    const task = store.create({ title: "Done", description: "", directory: "/repo" });
    store.move(task.id, "done", 0);
    store.setArchived(task.id, true);

    const res = await app.request(`/api/tasks/${task.id}/unarchive`, { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.archived).toBe(false);
    expect(store.get(task.id)?.archived).toBe(false);
  });

  it("returns 404 for unarchiving an unknown task", async () => {
    const res = await app.request("/api/tasks/missing/unarchive", { method: "POST" });

    expect(res.status).toBe(404);
  });

  it("mirrors an archived task into the global archive store", async () => {
    const task = store.create({
      type: "agent",
      title: "Mirror me",
      description: "test desc",
      directory: "/repo",
      agent: "build",
      isolation: "worktree",
    });
    store.update(task.id, { completedBy: "User", finalSessionOutput: "final assistant archive output" });
    store.addComment({ taskId: task.id, author: "User", body: "archive note" });
    store.move(task.id, "review", 0);

    expect(globalArchiveStore.countMirrored()).toBe(0);

    const res = await app.request(`/api/tasks/${task.id}/archive`, { method: "POST" });
    expect(res.status).toBe(200);

    expect(globalArchiveStore.countMirrored()).toBe(1);

    const mirrored = globalArchiveStore.getMirrored("/db/test-tasks.sqlite", task.id);
    expect(mirrored).toBeDefined();
    expect(mirrored!.source_instance_name).toBe("test-instance");
    expect(mirrored!.source_port).toBe(4099);
    expect(mirrored!.source_workspace).toBe("/ws");
    expect(mirrored!.source_db_path).toBe("/db/test-tasks.sqlite");
    expect(mirrored!.task_type).toBe("agent");
    expect(mirrored!.completed_by).toBe("User");
    expect(mirrored!.final_session_output).toBe("final assistant archive output");
    expect(mirrored!.comments).toContain("archive note");
    expect(mirrored!.task_id).toBe(task.id);
    expect(JSON.parse(mirrored!.diff_snapshot!)).toMatchObject({ kind: "no-git" });
  });

  it("returns an error and keeps the local card visible when the global mirror fails", async () => {
    const task = store.create({ title: "Do not disappear", description: "", directory: "/repo" });
    store.move(task.id, "review", 0);
    vi.spyOn(globalArchiveStore, "mirrorTask").mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    const res = await app.request(`/api/tasks/${task.id}/archive`, { method: "POST" });

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      error: {
        message: "Failed to mirror task to the global archive; local archive was rolled back",
      },
    });
    expect(store.get(task.id)?.archived).toBe(false);
    expect(store.list().map((visible) => visible.id)).toContain(task.id);
    expect(globalArchiveStore.countMirrored()).toBe(0);
  });

  it("keeps an already archived card archived when re-mirroring fails", async () => {
    const task = store.create({ title: "Stay archived", description: "", directory: "/repo" });
    store.move(task.id, "done", 0);
    store.setArchived(task.id, true);
    vi.spyOn(globalArchiveStore, "mirrorTask").mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    const res = await app.request(`/api/tasks/${task.id}/archive`, { method: "POST" });

    expect(res.status).toBe(500);
    expect(store.get(task.id)?.archived).toBe(true);
    expect(store.list().map((visible) => visible.id)).not.toContain(task.id);
    expect(globalArchiveStore.countMirrored()).toBe(0);
  });

  it("does not archive a card that starts running while its diff snapshot is prepared", async () => {
    let markSnapshotStarted!: () => void;
    const snapshotStarted = new Promise<void>((resolve) => {
      markSnapshotStarted = resolve;
    });
    let releaseSnapshot!: () => void;
    const snapshotRelease = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });

    store.close();
    globalArchiveStore.close();
    const replacement = makeApp({
      archiveDiffSnapshot: async () => {
        markSnapshotStarted();
        await snapshotRelease;
        return { kind: "no-git", reason: "gated archive snapshot" };
      },
    });
    store = replacement.store;
    globalArchiveStore = replacement.globalArchiveStore;
    app = replacement.app;

    const task = store.create({ title: "Do not hide a live run", description: "", directory: "/repo" });
    store.move(task.id, "review", 0);

    const archiveRequest = app.request(`/api/tasks/${task.id}/archive`, { method: "POST" });
    await snapshotStarted;
    store.move(task.id, "in_progress", 0);
    store.update(task.id, {
      runState: "running",
      runStartedAt: 6000,
      sessionId: "ses_new_run",
    });
    releaseSnapshot();

    const res = await archiveRequest;

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: {
        message: "Task changed while preparing the archive; retry after the current run finishes",
      },
    });
    expect(store.get(task.id)).toMatchObject({
      archived: false,
      column: "in_progress",
      runState: "running",
      runStartedAt: 6000,
      sessionId: "ses_new_run",
    });
    expect(store.list().map((visible) => visible.id)).toContain(task.id);
    expect(globalArchiveStore.countMirrored()).toBe(0);
  });

  it("captures task_diff as an immutable global-archive snapshot", async () => {
    const repo = mkdtempSync(join(tmpdir(), "openboard-archive-diff-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "OpenBoard Test"], { cwd: repo });
      writeFileSync(join(repo, "src.ts"), "export const value = 1;\n");
      execFileSync("git", ["add", "src.ts"], { cwd: repo });
      execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
      const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

      const task = store.create({ title: "Snapshot diff", description: "", directory: repo, isolation: "in-place" });
      store.move(task.id, "done", 0);
      store.update(task.id, { baseCommit, dirtyAtDispatch: false });
      writeFileSync(join(repo, "src.ts"), "export const value = 2;\n");

      const res = await app.request(`/api/tasks/${task.id}/archive`, { method: "POST" });
      expect(res.status).toBe(200);

      const mirrored = globalArchiveStore.getMirrored("/db/test-tasks.sqlite", task.id);
      const snapshot = JSON.parse(mirrored!.diff_snapshot!);
      expect(snapshot).toMatchObject({
        kind: "diff",
        capped: false,
        files: [{ file: "src.ts", additions: 1, deletions: 1, status: "modified" }],
      });
      expect(snapshot.files[0].patch).toContain("-export const value = 1;");
      expect(snapshot.files[0].patch).toContain("+export const value = 2;");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("re-archiving the same task is idempotent (no duplicate mirror rows)", async () => {
    const task = store.create({ title: "Re-archive me", description: "", directory: "/repo" });
    store.move(task.id, "done", 0);

    await app.request(`/api/tasks/${task.id}/archive`, { method: "POST" });
    expect(globalArchiveStore.countMirrored()).toBe(1);

    await app.request(`/api/tasks/${task.id}/archive`, { method: "POST" });
    expect(globalArchiveStore.countMirrored()).toBe(1);
  });

  it("unarchiving does NOT delete the global archive mirror row", async () => {
    const task = store.create({ title: "Unarchive test", description: "", directory: "/repo" });
    store.move(task.id, "review", 0);

    await app.request(`/api/tasks/${task.id}/archive`, { method: "POST" });
    expect(globalArchiveStore.countMirrored()).toBe(1);

    const res = await app.request(`/api/tasks/${task.id}/unarchive`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(store.get(task.id)?.archived).toBe(false);

    expect(globalArchiveStore.countMirrored()).toBe(1);
    expect(globalArchiveStore.getMirrored("/db/test-tasks.sqlite", task.id)).toBeDefined();
  });

  it("mirrors all task metadata fields into the global archive", async () => {
    const completion = {
      outcome: "complete" as const,
      summary: "full summary",
      changedFiles: ["src/a.ts"],
      verification: [{ command: "npm test", result: "passed" }],
      residualRisk: "none",
      reportedAt: 7000,
    };
    const model = { providerID: "openai", id: "gpt-5.5", variant: "reasoning" };
    const task = store.create({
      title: "Full metadata",
      description: "desc text",
      directory: "/repo/a",
      agent: "plan",
      model,
      isolation: "in-place",
    });
    store.move(task.id, "review", 0);
    store.update(task.id, {
      sessionId: "ses_xyz",
      runState: "idle",
      runStartedAt: 5000,
      worktreePath: "/wt",
      worktreeBranch: "board/task_1",
      baseBranch: "main",
      error: "prior error",
      completion,
      completionSource: "reported",
    });

    const beforeArchive = Date.now();
    const res = await app.request(`/api/tasks/${task.id}/archive`, { method: "POST" });
    const afterArchive = Date.now();
    expect(res.status).toBe(200);

    const archived = store.get(task.id)!;
    const mirrored = globalArchiveStore.getMirrored("/db/test-tasks.sqlite", task.id);
    expect(mirrored).toBeDefined();
    expect(mirrored).toMatchObject({
      source_instance_name: "test-instance",
      source_port: 4099,
      source_workspace: "/ws",
      source_db_path: "/db/test-tasks.sqlite",
      task_id: task.id,
      title: "Full metadata",
      description: "desc text",
      directory: "/repo/a",
      agent: "plan",
      model: JSON.stringify(model),
      isolation: "in-place",
      column_name: "review",
      run_state: "idle",
      run_started_at: 5000,
      error: "prior error",
      session_id: "ses_xyz",
      worktree_path: "/wt",
      worktree_branch: "board/task_1",
      base_branch: "main",
      completion: JSON.stringify(completion),
      completion_source: "reported",
      task_created_at: task.createdAt,
      task_updated_at: archived.updatedAt,
    });
    expect(mirrored!.archived_at).toBeGreaterThanOrEqual(beforeArchive);
    expect(mirrored!.archived_at).toBeLessThanOrEqual(afterArchive);
    expect(mirrored!.mirrored_at).toBeGreaterThanOrEqual(beforeArchive);
    expect(mirrored!.mirrored_at).toBeLessThanOrEqual(afterArchive);
  });

  it("does NOT mirror when the task cannot be archived (e.g., todo column)", async () => {
    const task = store.create({ title: "Cant archive", description: "", directory: "/repo" });

    const res = await app.request(`/api/tasks/${task.id}/archive`, { method: "POST" });
    expect(res.status).toBe(409);

    expect(globalArchiveStore.countMirrored()).toBe(0);
  });

  it("opens and writes a file-backed global archive DB with missing parent directories", () => {
    const root = mkdtempSync(join(tmpdir(), "openboard-global-archive-"));
    const archivePath = join(root, "missing", "nested", "archive.sqlite");
    let fileStore: GlobalArchiveStore | undefined;
    try {
      fileStore = new GlobalArchiveStore(archivePath);
      fileStore.mirrorTask(
        {
          id: "task_file_backed",
          title: "File backed",
          description: "writes successfully",
          directory: "/repo",
          column: "done",
          position: 0,
          runState: "idle",
          archived: true,
          parentIds: [],
          completion: null,
          completionSource: null,
          baseCommit: null,
          dirtyAtDispatch: false,
          createdAt: 1,
          updatedAt: 2,
        },
        { port: 4100, workspace: "/ws", dbPath: "/db/source.sqlite" },
        3,
      );

      expect(existsSync(archivePath)).toBe(true);
      expect(fileStore.countMirrored()).toBe(1);
      expect(fileStore.getMirrored("/db/source.sqlite", "task_file_backed")?.title).toBe(
        "File backed",
      );
    } finally {
      fileStore?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
