import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { BoardClientError, createBoardClient } from "../../src/client/board-client";
import { SqliteTaskStore } from "../../src/db/task-store";
import { registerTaskRoutes } from "../../src/server/routes/tasks";
import { respondWithAppError } from "../../src/server/app";
import { applyDiffResponse, createLoadingViewDiffState, viewDiffHeaderLabel } from "../../src/tui/view-diff";
import type { Dispatcher, RespondPermissionOutcome, RosterAgent, Task } from "../../src/shared";

let tmpDir: string | undefined;

function cleanGitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", env: cleanGitEnv() }).trim();
}

function makeRepo(name: string): { repoDir: string; baseCommit: string } {
  const repoDir = join(tmpDir!, name);
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["config", "user.name", "OpenBoard Test"]);
  writeFileSync(join(repoDir, "README.md"), "# fixture\n");
  git(repoDir, ["add", "README.md"]);
  git(repoDir, ["commit", "-m", "initial"]);
  return { repoDir, baseCommit: git(repoDir, ["rev-parse", "HEAD"]) };
}

function makeDispatcher(store: SqliteTaskStore): Dispatcher {
  return {
    getPermissionGraceMs: () => store.getPermissionGraceMs() ?? 300_000,
    setPermissionGraceMs: (value) => store.setPermissionGraceMs(value),
    run: vi.fn(async (taskId: string) => store.get(taskId)!),
    retry: vi.fn(async (taskId: string) => store.get(taskId)!),
    abort: vi.fn(async () => undefined),
    initGitAndRun: vi.fn(async (taskId: string) => store.get(taskId)!),
    syncUpstream: vi.fn(async (taskId: string) => ({ task: store.get(taskId)!, ok: true, conflict: false, message: "ok" })),
    getWorktreeCommitStatus: vi.fn(async () => ({ committedFiles: [], uncommittedFiles: [] })),
    commitFile: vi.fn(async (taskId: string, file: string) => ({ task: store.get(taskId)!, ok: true, file, message: "committed" })),
    integrate: vi.fn(async (taskId: string) => ({ task: store.get(taskId)!, ok: true, conflict: false, message: "ok" })),
    removeTask: vi.fn(async (taskId: string) => {
      store.remove(taskId);
      return { ok: true };
    }),
    discardWorktree: vi.fn(async () => ({ ok: true, removed: true, dirty: false, kept: false, message: "discarded" })),
    retainTaskWorktree: vi.fn(async () => ({ ok: true, removed: false, dirty: true, kept: true, message: "kept" })),
    sweepOrphanedWorktrees: vi.fn(async () => []),
    resolveOrphanWorktree: vi.fn(async (worktreePath) => ({ ok: true, removed: true, dirty: false, kept: false, message: "resolved", worktreePath })),
    getOrphanWorktreeDiff: vi.fn(async (_worktreePath: string) => ({ kind: "diff" as const, files: [], capped: false })),
    listPendingPermissions: vi.fn(() => []),
    respondPermission: vi.fn(async (_taskId: string, _input: { askId: string; action: "allow_once" | "deny"; answeredBy: string }): Promise<RespondPermissionOutcome> => ({ ok: true, askId: "ask_1", decision: "allow_once" })),
    sendSessionMessage: vi.fn(async (taskId: string, input) => ({ messageId: input.clientMessageId, taskId, sessionId: input.expectedSessionId, status: "accepted" as const, mode: input.mode, sentAt: Date.now(), sentBy: input.sentBy, task: store.get(taskId)! })),
    start: vi.fn(),
    shutdown: vi.fn(),
  };
}

function makeApp(store: SqliteTaskStore): Hono {
  const app = new Hono();
  app.onError(respondWithAppError);
  const agents: RosterAgent[] = [
    { id: "build", mode: "primary", model: { providerID: "opencode", id: "north-mini-code-free" } },
  ];
  registerTaskRoutes(app, {
    store,
    dispatcher: makeDispatcher(store),
    agentRoster: { fetch: async () => agents },
  });
  return app;
}

function makeClient(app: Hono) {
  return createBoardClient({
    boardUrl: "http://openboard.test",
    cwd: tmpDir,
    stat: async () => ({ isDirectory: () => true }),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      return app.request(`${url.pathname}${url.search}`, init);
    },
  });
}

function reviewTask(store: SqliteTaskStore, input: Partial<Task> & { title: string; directory: string }): Task {
  const created = store.create({
    title: input.title,
    description: "",
    directory: input.directory,
    type: input.type,
    harness: input.harness,
    ...(input.isolation != null ? { isolation: input.isolation } : {}),
  });
  store.move(created.id, "review", 0);
  return store.update(created.id, input)!;
}

describe("View Diff live route/client/TUI seam", () => {
  let store: SqliteTaskStore;

  afterEach(() => {
    store?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it("flows worktree, dirty in-place, no-git, and non-Review diff outcomes through the client contract", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "openboard-view-diff-int-"));
    store = new SqliteTaskStore(":memory:");
    const app = makeApp(store);
    const client = makeClient(app);

    const worktreeRepo = makeRepo("worktree-repo");
    const worktreeTask = store.create({
      title: "worktree diff",
      description: "",
      directory: worktreeRepo.repoDir,
      isolation: "worktree",
    });
    store.move(worktreeTask.id, "review", 0);
    const worktreePath = join(tmpDir, "worktree");
    const worktreeBranch = `board/${worktreeTask.id}`;
    git(worktreeRepo.repoDir, ["worktree", "add", "-b", worktreeBranch, worktreePath, "HEAD"]);
    writeFileSync(join(worktreePath, "src.ts"), "export const seam = true;\n");
    git(worktreePath, ["add", "src.ts"]);
    git(worktreePath, ["commit", "-m", "add seam fixture"]);
    const worktreeReview = store.update(worktreeTask.id, {
      baseCommit: worktreeRepo.baseCommit,
      dirtyAtDispatch: false,
      worktreePath,
      worktreeBranch,
      baseBranch: "main",
    })!;

    const worktreeDiff = await client.getTaskDiff(worktreeReview.id);
    expect(worktreeDiff.kind).toBe("diff");
    if (worktreeDiff.kind === "diff") {
      expect(worktreeDiff.capped).toBe(false);
      expect(worktreeDiff.files.map((file) => file.file)).toContain("src.ts");
      const state = applyDiffResponse(createLoadingViewDiffState(worktreeReview), worktreeDiff);
      expect(viewDiffHeaderLabel(state)).toBe("worktree diff · 1 file");
    }

    const dirtyRepo = makeRepo("dirty-repo");
    writeFileSync(join(dirtyRepo.repoDir, "README.md"), "# changed before dispatch\n");
    const dirtyReview = reviewTask(store, {
      title: "dirty in-place diff",
      directory: dirtyRepo.repoDir,
      isolation: "in-place",
      baseCommit: dirtyRepo.baseCommit,
      dirtyAtDispatch: true,
    });
    const dirtyDiff = await client.getTaskDiff(dirtyReview.id);
    expect(dirtyDiff.kind).toBe("diff");
    if (dirtyDiff.kind === "diff") {
      const state = applyDiffResponse(createLoadingViewDiffState(dirtyReview), dirtyDiff);
      expect(viewDiffHeaderLabel(state)).toContain("includes pre-existing changes");
    }

    const noGitDir = join(tmpDir, "not-git");
    mkdirSync(noGitDir);
    const noGitReview = reviewTask(store, {
      title: "no git",
      directory: noGitDir,
      baseCommit: null,
      dirtyAtDispatch: false,
    });
    const noGit = await client.getTaskDiff(noGitReview.id);
    expect(noGit.kind).toBe("no-git");
    if (noGit.kind === "no-git") {
      const state = applyDiffResponse(createLoadingViewDiffState(noGitReview), noGit);
      expect(viewDiffHeaderLabel(state)).toBe("working tree diff · no git evidence");
    }

    const todo = store.create({ title: "todo", description: "", directory: dirtyRepo.repoDir });
    await expect(client.getTaskDiff(todo.id)).rejects.toBeInstanceOf(BoardClientError);
    await expect(client.getTaskDiff(todo.id)).rejects.toMatchObject({ status: 409 });
    await expect(client.getTaskDiff("task_missing")).rejects.toMatchObject({ status: 404 });
  });
});
