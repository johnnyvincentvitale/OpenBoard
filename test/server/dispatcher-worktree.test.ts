import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../src/db/task-store";
import { TaskDispatcher } from "../../src/server/dispatcher";
import { GitWorktreeManager, type WorktreeManager } from "../../src/server/worktree";
import { INTEGRATED_COMPLETED_BY } from "../../src/shared";

function g(cwd: string, args: string[]): string {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@localhost",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@localhost",
    },
  }).trim();
}

function makeRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  g(root, ["init", "-b", "main"]);
  writeFileSync(join(root, "file.txt"), "base\n");
  g(root, ["add", "-A"]);
  g(root, ["commit", "--no-gpg-sign", "-m", "base"]);
}

/** Minimal fake OpenCode client: records session.create directory, always succeeds. */
function makeFakeClient() {
  const createCalls: Array<{ directory?: string }> = [];
  const promptCalls: Array<{ sessionID: string; text?: string }> = [];
  return {
    createCalls,
    promptCalls,
    session: {
      create: async (params: { directory?: string }) => {
        createCalls.push(params);
        return { data: { id: "ses_1" }, error: undefined };
      },
      promptAsync: async (params: { sessionID: string; parts?: Array<{ text?: string }> }) => {
        promptCalls.push({ sessionID: params.sessionID, text: params.parts?.[0]?.text });
        return { data: undefined, error: undefined };
      },
      abort: async () => ({ data: {}, error: undefined }),
    },
    event: { subscribe: async () => ({ stream: (async function* () {})() }) },
  };
}

describe("TaskDispatcher — worktree isolation", () => {
  let tmp: string;
  let store: SqliteTaskStore;

  function buildDispatcher(
    client: ReturnType<typeof makeFakeClient>,
    worktrees: WorktreeManager = new GitWorktreeManager(),
    onParentSatisfied?: (parentId: string) => Promise<void>,
  ) {
    return new TaskDispatcher({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      store,
      worktrees,
      // Keep worktrees inside the temp dir for the test.
      worktreeBaseDir: () => join(tmp, "worktrees"),
      onParentSatisfied,
    });
  }

  beforeEach(() => {
    tmp = realpathSync.native(mkdtempSync(join(tmpdir(), "ocb-disp-")));
    process.env.BOARD_WORKSPACE = tmp;
    store = new SqliteTaskStore(":memory:");
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
    delete process.env.BOARD_WORKSPACE;
  });

  it("runs an explicitly isolated task in a real git worktree", async () => {
    const repo = join(tmp, "repo");
    makeRepo(repo);
    const client = makeFakeClient();
    const dispatcher = buildDispatcher(client);

    const task = store.create({ isolation: "worktree", title: "t", description: "d", directory: repo });
    const ran = await dispatcher.run(task.id);

    // Dispatched into the worktree, not the repo itself.
    const wtPath = join(tmp, "worktrees", task.id);
    expect(client.createCalls[0]?.directory).toBe(wtPath);
    expect(existsSync(wtPath)).toBe(true);
    expect(ran.worktreePath).toBe(wtPath);
    expect(ran.worktreeBranch).toBe(`board/${task.id}`);
    expect(ran.baseBranch).toBe("main");
    expect(ran.runState).toBe("running");
    expect(ran.column).toBe("in_progress");
    // The worktree is on its own branch.
    expect(g(wtPath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(`board/${task.id}`);
  });

  it("in-place tasks run directly in their directory", async () => {
    const repo = join(tmp, "repo");
    makeRepo(repo);
    const client = makeFakeClient();
    const dispatcher = buildDispatcher(client);

    const task = store.create({
      title: "t",
      description: "d",
      directory: repo,
      isolation: "in-place",
    });
    await dispatcher.run(task.id);

    expect(client.createCalls[0]?.directory).toBe(repo);
    expect(existsSync(join(tmp, "worktrees", task.id))).toBe(false);
  });

  it("blocks a worktree run on a non-git dir with pending git-init (no session)", async () => {
    const plain = join(tmp, "plain");
    mkdirSync(plain, { recursive: true });
    const client = makeFakeClient();
    const dispatcher = buildDispatcher(client);

    const task = store.create({
      title: "t",
      description: "d",
      directory: plain,
      isolation: "worktree",
    });
    const blocked = await dispatcher.run(task.id);

    expect(blocked.pending).toBe("git-init");
    expect(blocked.runState).toBe("unstarted");
    expect(client.createCalls).toHaveLength(0);
  });

  it("initGitAndRun makes the dir a repo, clears pending, then runs isolated", async () => {
    const plain = join(tmp, "plain");
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, "seed.txt"), "hi\n");
    const client = makeFakeClient();
    const dispatcher = buildDispatcher(client);

    const task = store.create({
      title: "t",
      description: "d",
      directory: plain,
      isolation: "worktree",
    });
    await dispatcher.run(task.id); // → pending git-init
    const ran = await dispatcher.initGitAndRun(task.id);

    expect(ran.pending).toBeUndefined();
    expect(ran.runState).toBe("running");
    expect(existsSync(join(tmp, "worktrees", task.id))).toBe(true);
    expect(client.createCalls[0]?.directory).toBe(join(tmp, "worktrees", task.id));
  });

  it("syncUpstream merges upstream commits into the worktree branch", async () => {
    const repo = join(tmp, "repo");
    makeRepo(repo);
    const dispatcher = buildDispatcher(makeFakeClient());
    const task = store.create({ isolation: "worktree", title: "t", description: "d", directory: repo });
    await dispatcher.run(task.id);

    // Advance main after the worktree was cut.
    writeFileSync(join(repo, "up.txt"), "up\n");
    g(repo, ["add", "-A"]);
    g(repo, ["commit", "--no-gpg-sign", "-m", "up"]);

    const outcome = await dispatcher.syncUpstream(task.id);
    expect(outcome.ok).toBe(true);
    expect(existsSync(join(tmp, "worktrees", task.id, "up.txt"))).toBe(true);
  });

  it("integrate merges the worktree branch to base, removes the worktree, keeps the branch", async () => {
    const repo = join(tmp, "repo");
    makeRepo(repo);
    const dispatcher = buildDispatcher(makeFakeClient());
    const task = store.create({ isolation: "worktree", title: "t", description: "d", directory: repo });
    const ran = await dispatcher.run(task.id);

    // Do work on the worktree branch.
    const wtPath = ran.worktreePath!;
    writeFileSync(join(wtPath, "feature.txt"), "work\n");
    g(wtPath, ["add", "-A"]);
    g(wtPath, ["commit", "--no-gpg-sign", "-m", "feature"]);

    // integrate() refuses to run against a still-running session (TOCTOU
    // guard) — Integrate is only ever reachable from the UI once the task
    // has finished running, so simulate that here.
    store.update(task.id, { runState: "idle" });

    const outcome = await dispatcher.integrate(task.id);
    expect(outcome.ok).toBe(true);
    // base has the feature, worktree gone, branch kept, task accepted.
    expect(existsSync(join(repo, "feature.txt"))).toBe(true);
    expect(existsSync(wtPath)).toBe(false);
    expect(g(repo, ["branch", "--list", `board/${task.id}`])).toContain(`board/${task.id}`);
    expect(outcome.task.column).toBe("done");
    expect(outcome.task.completedBy).toBe(INTEGRATED_COMPLETED_BY);
    expect(outcome.task.worktreePath).toBeUndefined();
    const completed = store.get(task.id);
    expect(completed?.column).toBe("done");
    expect(completed?.completedBy).toBe(INTEGRATED_COMPLETED_BY);
    expect(completed?.worktreePath).toBeUndefined();
  });

  it("fires onParentSatisfied without blocking the response when integrate lands the task in Done", async () => {
    const repo = join(tmp, "repo");
    makeRepo(repo);
    const onParentSatisfied = vi.fn(async () => undefined);
    const dispatcher = buildDispatcher(makeFakeClient(), new GitWorktreeManager(), onParentSatisfied);
    const task = store.create({ isolation: "worktree", title: "t", description: "d", directory: repo });
    const ran = await dispatcher.run(task.id);

    const wtPath = ran.worktreePath!;
    writeFileSync(join(wtPath, "feature.txt"), "work\n");
    g(wtPath, ["add", "-A"]);
    g(wtPath, ["commit", "--no-gpg-sign", "-m", "feature"]);
    store.update(task.id, { runState: "idle" });

    const outcome = await dispatcher.integrate(task.id);

    expect(outcome.ok).toBe(true);
    expect(outcome.task.column).toBe("done");
    expect(onParentSatisfied).toHaveBeenCalledWith(task.id);
  });

  it("records a task_warning instead of throwing when onParentSatisfied fails", async () => {
    const repo = join(tmp, "repo");
    makeRepo(repo);
    const onParentSatisfied = vi.fn(async () => {
      throw new Error("chain check boom");
    });
    const dispatcher = buildDispatcher(makeFakeClient(), new GitWorktreeManager(), onParentSatisfied);
    const task = store.create({ isolation: "worktree", title: "t", description: "d", directory: repo });
    const ran = await dispatcher.run(task.id);

    const wtPath = ran.worktreePath!;
    writeFileSync(join(wtPath, "feature.txt"), "work\n");
    g(wtPath, ["add", "-A"]);
    g(wtPath, ["commit", "--no-gpg-sign", "-m", "feature"]);
    store.update(task.id, { runState: "idle" });

    const outcome = await dispatcher.integrate(task.id);
    expect(outcome.ok).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const events = store.listEvents(task.id);
    expect(events.some((e) => e.type === "task_warning" && String(e.body.warning).includes("chain check boom"))).toBe(true);
  });

  it("maps integrate rebase conflicts to pending rebase-conflict without clearing the worktree", async () => {
    const repo = join(tmp, "repo");
    makeRepo(repo);
    const worktreePath = join(tmp, "worktrees", "task-conflict");
    mkdirSync(worktreePath, { recursive: true });
    const worktrees: WorktreeManager = {
      isGitRepo: async () => true,
      initRepo: async () => undefined,
      repoRoot: async (dir) => dir,
      currentBranch: async () => "main",
      createWorktree: async () => ({ worktreePath, branch: "board/task-conflict", baseBranch: "main" }),
      syncUpstream: async () => ({ ok: true, conflict: false, message: "synced" }),
      commitStatus: async () => ({ committedFiles: [], uncommittedFiles: [] }),
      commitFile: async (_worktreePath, file) => ({ ok: true, file, message: "committed" }),
      integrate: async () => ({ ok: false, conflict: true, conflictPaths: ["file.txt"], message: "conflict" }),
      isWorktreeDirty: async () => false,
      cleanupWorktree: async () => ({ ok: true, removed: true, dirty: false, kept: false, message: "removed", worktreePath }),
      listManagedWorktrees: async () => [],
      removeWorktree: async () => undefined,
    };
    const dispatcher = buildDispatcher(makeFakeClient(), worktrees);
    const task = store.create({ isolation: "worktree", title: "t", description: "d", directory: repo });
    store.move(task.id, "review", 0);
    store.update(task.id, {
      worktreePath,
      worktreeBranch: "board/task-conflict",
      baseBranch: "main",
      runState: "idle",
      baseCheckoutSnapshot: "",
    });

    const outcome = await dispatcher.integrate(task.id);

    expect(outcome.ok).toBe(false);
    expect(outcome.conflict).toBe(true);
    expect(outcome.rebaseConflictPaths).toEqual(["file.txt"]);
    const blocked = store.get(task.id);
    expect(blocked?.column).toBe("review");
    expect(blocked?.completedBy).toBeNull();
    expect(blocked?.pending).toBe("rebase-conflict");
    expect(blocked?.rebaseConflictPaths).toEqual(["file.txt"]);
    expect(blocked?.worktreePath).toBe(worktreePath);
  });

  it("keeps Review cards in Review when integrate still needs remaining files committed", async () => {
    const repo = join(tmp, "repo");
    makeRepo(repo);
    const worktreePath = join(tmp, "worktrees", "task-dirty");
    mkdirSync(worktreePath, { recursive: true });
    const worktrees: WorktreeManager = {
      isGitRepo: async () => true,
      initRepo: async () => undefined,
      repoRoot: async (dir) => dir,
      currentBranch: async () => "main",
      createWorktree: async () => ({ worktreePath, branch: "board/task-dirty", baseBranch: "main" }),
      syncUpstream: async () => ({ ok: true, conflict: false, message: "synced" }),
      commitStatus: async () => ({ committedFiles: ["src/a.ts"], uncommittedFiles: ["src/b.ts"] }),
      commitFile: async (_worktreePath, file) => ({ ok: true, file, message: "committed" }),
      integrate: async () => ({
        ok: false,
        conflict: false,
        needsCommit: true,
        committedFiles: ["src/a.ts"],
        uncommittedFiles: ["src/b.ts"],
        message: "remaining files need commit",
      }),
      isWorktreeDirty: async () => true,
      cleanupWorktree: async () => ({ ok: true, removed: true, dirty: false, kept: false, message: "removed", worktreePath }),
      listManagedWorktrees: async () => [],
      removeWorktree: async () => undefined,
    };
    const dispatcher = buildDispatcher(makeFakeClient(), worktrees);
    const task = store.create({ isolation: "worktree", title: "t", description: "d", directory: repo });
    store.move(task.id, "review", 0);
    store.update(task.id, {
      worktreePath,
      worktreeBranch: "board/task-dirty",
      baseBranch: "main",
      runState: "idle",
      baseCheckoutSnapshot: "",
    });

    const outcome = await dispatcher.integrate(task.id);

    expect(outcome.ok).toBe(false);
    expect(outcome.conflict).toBe(false);
    expect(outcome.needsCommit).toBe(true);
    const blocked = store.get(task.id);
    expect(blocked?.column).toBe("review");
    expect(blocked?.completedBy).toBeNull();
    expect(blocked?.worktreePath).toBe(worktreePath);
  });

  it("retry on a rebase-conflict task tells the existing session to continue the mid-rebase", async () => {
    const repo = join(tmp, "repo");
    makeRepo(repo);
    const client = makeFakeClient();
    const dispatcher = buildDispatcher(client);
    const task = store.create({ isolation: "worktree", title: "t", description: "finish it", directory: repo });
    const ran = await dispatcher.run(task.id);
    store.update(task.id, {
      runState: "idle",
      pending: "rebase-conflict",
      rebaseConflictPaths: ["file.txt"],
    });

    await dispatcher.retry(task.id);

    const retryPrompt = client.promptCalls.at(-1)?.text ?? "";
    expect(retryPrompt).toContain("OPENBOARD REBASE CONFLICT RESOLUTION");
    expect(retryPrompt).toContain("git rebase --continue");
    expect(retryPrompt).toContain("- file.txt");
    expect(retryPrompt).toContain(ran.worktreePath);
    expect(store.get(task.id)?.pending).toBeUndefined();
  });

  it("removeTask removes a clean worktree before deleting the task", async () => {
    const repo = join(tmp, "repo");
    makeRepo(repo);
    const dispatcher = buildDispatcher(makeFakeClient());
    const task = store.create({ isolation: "worktree", title: "t", description: "d", directory: repo });
    const ran = await dispatcher.run(task.id);
    store.update(task.id, { runState: "idle" });

    const outcome = await dispatcher.removeTask(task.id);

    expect(outcome.ok).toBe(true);
    expect(outcome.worktree).toMatchObject({ removed: true, dirty: false });
    expect(store.get(task.id)).toBeUndefined();
    expect(existsSync(ran.worktreePath!)).toBe(false);
    expect(g(repo, ["branch", "--list", `board/${task.id}`])).toContain(`board/${task.id}`);
  });

  it("removeTask keeps a dirty worktree until forced", async () => {
    const repo = join(tmp, "repo");
    makeRepo(repo);
    const dispatcher = buildDispatcher(makeFakeClient());
    const task = store.create({ isolation: "worktree", title: "t", description: "d", directory: repo });
    const ran = await dispatcher.run(task.id);
    writeFileSync(join(ran.worktreePath!, "scratch.txt"), "partial\n");

    const blocked = await dispatcher.removeTask(task.id);
    expect(blocked.ok).toBe(false);
    expect(blocked.worktree).toMatchObject({ dirty: true, kept: true });
    expect(store.get(task.id)).toBeTruthy();
    expect(existsSync(ran.worktreePath!)).toBe(true);

    const removed = await dispatcher.removeTask(task.id, { force: true });
    expect(removed.ok).toBe(true);
    expect(store.get(task.id)).toBeUndefined();
    expect(existsSync(ran.worktreePath!)).toBe(false);
  });

  it("removeTask keepWorktree reports clean kept worktrees accurately", async () => {
    const repo = join(tmp, "repo");
    makeRepo(repo);
    const dispatcher = buildDispatcher(makeFakeClient());
    const task = store.create({ isolation: "worktree", title: "t", description: "d", directory: repo });
    const ran = await dispatcher.run(task.id);

    const kept = await dispatcher.removeTask(task.id, { keepWorktree: true });

    expect(kept.ok).toBe(true);
    expect(kept.worktree).toMatchObject({ removed: false, dirty: false, kept: true });
    expect(store.get(task.id)).toBeUndefined();
    expect(existsSync(ran.worktreePath!)).toBe(true);
  });

  it("discardWorktree removes a Review worktree without deleting the card", async () => {
    const repo = join(tmp, "repo");
    makeRepo(repo);
    const dispatcher = buildDispatcher(makeFakeClient());
    const task = store.create({ isolation: "worktree", title: "t", description: "d", directory: repo });
    const ran = await dispatcher.run(task.id);
    store.update(task.id, { column: "review", runState: "idle" });

    const outcome = await dispatcher.discardWorktree(task.id);

    expect(outcome).toMatchObject({ ok: true, removed: true });
    expect(store.get(task.id)?.worktreePath).toBeUndefined();
    expect(store.get(task.id)).toBeTruthy();
    expect(existsSync(ran.worktreePath!)).toBe(false);
    expect(g(repo, ["branch", "--list", `board/${task.id}`])).toContain(`board/${task.id}`);
  });

  it("retainTaskWorktree reports dirty state while keeping the Review worktree attached", async () => {
    const repo = join(tmp, "repo");
    makeRepo(repo);
    const dispatcher = buildDispatcher(makeFakeClient());
    const task = store.create({ isolation: "worktree", title: "t", description: "d", directory: repo });
    const ran = await dispatcher.run(task.id);
    store.update(task.id, { column: "review", runState: "error" });
    writeFileSync(join(ran.worktreePath!, "partial.txt"), "unfinished\n");

    const outcome = await dispatcher.retainTaskWorktree(task.id);

    expect(outcome).toMatchObject({ ok: true, removed: false, dirty: true, kept: true, worktreePath: ran.worktreePath });
    expect(store.get(task.id)?.worktreePath).toBe(ran.worktreePath);
    expect(existsSync(ran.worktreePath!)).toBe(true);
  });

  it("sweepOrphanedWorktrees removes clean unreferenced worktrees and keeps live task worktrees", async () => {
    const repo = join(tmp, "repo");
    makeRepo(repo);
    const dispatcher = buildDispatcher(makeFakeClient());
    const task = store.create({ isolation: "worktree", title: "live", description: "d", directory: repo });
    const ran = await dispatcher.run(task.id);

    const orphanPath = join(tmp, "worktrees", "task_orphan");
    const mgr = new GitWorktreeManager();
    await mgr.createWorktree(repo, "board/task_orphan", orphanPath);

    const outcomes = await dispatcher.sweepOrphanedWorktrees();

    expect(outcomes).toContainEqual(expect.objectContaining({ worktreePath: orphanPath, removed: true }));
    expect(existsSync(orphanPath)).toBe(false);
    expect(existsSync(ran.worktreePath!)).toBe(true);
  });

  it("sweepOrphanedWorktrees removes remembered repo orphans even when no live task remains", async () => {
    const repo = join(tmp, "repo");
    makeRepo(repo);
    const dispatcher = buildDispatcher(makeFakeClient());
    store.rememberWorktreeRepoRoot(repo);
    const orphanPath = join(tmp, "worktrees", "task_orphan");
    const mgr = new GitWorktreeManager();
    await mgr.createWorktree(repo, "board/task_orphan", orphanPath);

    const outcomes = await dispatcher.sweepOrphanedWorktrees();

    expect(outcomes).toContainEqual(expect.objectContaining({ worktreePath: orphanPath, removed: true }));
    expect(existsSync(orphanPath)).toBe(false);
  });

  it("resolveOrphanWorktree deletes dirty orphans, reports file counts, and updates the sweep result", async () => {
    const repo = join(tmp, "repo");
    makeRepo(repo);
    const dispatcher = buildDispatcher(makeFakeClient());
    const mgr = new GitWorktreeManager();
    const deletePath = join(tmp, "worktrees", "task_delete");
    store.rememberWorktreeRepoRoot(repo);
    store.setSweepResult({
      sweptAt: Date.now(),
      removedCleanCount: 0,
      keptDirtyCount: 1,
      dirtyOrphans: [
        { taskId: "task_delete", worktreePath: deletePath, dirtyFileCount: 2 },
      ],
    });

    await mgr.createWorktree(repo, "board/task_delete", deletePath);
    writeFileSync(join(deletePath, "delete.txt"), "drop me\n");
    writeFileSync(join(deletePath, "second.txt"), "drop me too\n");

    const deleted = await dispatcher.resolveOrphanWorktree(deletePath);
    expect(deleted).toMatchObject({ ok: true, removed: true, dirty: true, kept: false, dirtyFileCount: 2 });
    expect(existsSync(deletePath)).toBe(false);
    expect(g(repo, ["branch", "--list", "board/task_delete"])).toContain("board/task_delete");
    expect(store.getSweepResult()?.keptDirtyCount).toBe(0);
    expect(store.getSweepResult()?.dirtyOrphans).toEqual([]);
  });

  it("getOrphanWorktreeDiff returns tracked and untracked changes without deleting the orphan", async () => {
    const repo = join(tmp, "repo");
    makeRepo(repo);
    const dispatcher = buildDispatcher(makeFakeClient());
    const orphanPath = join(tmp, "worktrees", "task_inspect");
    store.rememberWorktreeRepoRoot(repo);
    await new GitWorktreeManager().createWorktree(repo, "board/task_inspect", orphanPath);
    writeFileSync(join(orphanPath, "file.txt"), "changed\n");
    writeFileSync(join(orphanPath, "new.txt"), "new file\n");

    const diff = await dispatcher.getOrphanWorktreeDiff(orphanPath);

    expect(diff.kind).toBe("diff");
    if (diff.kind === "diff") {
      expect(diff.root).toBe(orphanPath);
      expect(diff.files.map((file) => file.file)).toEqual(["file.txt", "new.txt"]);
      expect(diff.files[0]?.patch).toContain("-base");
      expect(diff.files[0]?.patch).toContain("+changed");
      expect(diff.files[1]?.patch).toContain("+new file");
    }
    expect(existsSync(orphanPath)).toBe(true);
  });
});
