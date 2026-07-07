import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

  function buildDispatcher(client: ReturnType<typeof makeFakeClient>, worktrees: WorktreeManager = new GitWorktreeManager()) {
    return new TaskDispatcher({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      store,
      worktrees,
      // Keep worktrees inside the temp dir for the test.
      worktreeBaseDir: () => join(tmp, "worktrees"),
    });
  }

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "ocb-disp-")));
    process.env.BOARD_WORKSPACE = tmp;
    store = new SqliteTaskStore(":memory:");
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
    delete process.env.BOARD_WORKSPACE;
  });

  it("runs an isolated task in a real git worktree (board default on)", async () => {
    const repo = join(tmp, "repo");
    makeRepo(repo);
    store.updateSettings({ worktreeDefault: true });
    const client = makeFakeClient();
    const dispatcher = buildDispatcher(client);

    const task = store.create({ title: "t", description: "d", directory: repo });
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

  it("per-task in-place override beats a board default of worktree", async () => {
    const repo = join(tmp, "repo");
    makeRepo(repo);
    store.updateSettings({ worktreeDefault: true });
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
    store.updateSettings({ worktreeDefault: true });
    const dispatcher = buildDispatcher(makeFakeClient());
    const task = store.create({ title: "t", description: "d", directory: repo });
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
    store.updateSettings({ worktreeDefault: true });
    const dispatcher = buildDispatcher(makeFakeClient());
    const task = store.create({ title: "t", description: "d", directory: repo });
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
    const task = store.create({ title: "t", description: "d", directory: repo });
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
    const task = store.create({ title: "t", description: "d", directory: repo });
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
    store.updateSettings({ worktreeDefault: true });
    const client = makeFakeClient();
    const dispatcher = buildDispatcher(client);
    const task = store.create({ title: "t", description: "finish it", directory: repo });
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
    store.updateSettings({ worktreeDefault: true });
    const dispatcher = buildDispatcher(makeFakeClient());
    const task = store.create({ title: "t", description: "d", directory: repo });
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
    store.updateSettings({ worktreeDefault: true });
    const dispatcher = buildDispatcher(makeFakeClient());
    const task = store.create({ title: "t", description: "d", directory: repo });
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
    store.updateSettings({ worktreeDefault: true });
    const dispatcher = buildDispatcher(makeFakeClient());
    const task = store.create({ title: "t", description: "d", directory: repo });
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
    store.updateSettings({ worktreeDefault: true });
    const dispatcher = buildDispatcher(makeFakeClient());
    const task = store.create({ title: "t", description: "d", directory: repo });
    const ran = await dispatcher.run(task.id);
    store.update(task.id, { column: "review", runState: "idle" });

    const outcome = await dispatcher.discardWorktree(task.id);

    expect(outcome).toMatchObject({ ok: true, removed: true });
    expect(store.get(task.id)?.worktreePath).toBeUndefined();
    expect(store.get(task.id)).toBeTruthy();
    expect(existsSync(ran.worktreePath!)).toBe(false);
    expect(g(repo, ["branch", "--list", `board/${task.id}`])).toContain(`board/${task.id}`);
  });

  it("sweepOrphanedWorktrees removes clean unreferenced worktrees and keeps live task worktrees", async () => {
    const repo = join(tmp, "repo");
    makeRepo(repo);
    store.updateSettings({ worktreeDefault: true });
    const dispatcher = buildDispatcher(makeFakeClient());
    const task = store.create({ title: "live", description: "d", directory: repo });
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
});

describe("TaskDispatcher — sandbox fail-closed gating", () => {
  let tmp: string;
  let store: SqliteTaskStore;

  function buildDispatcher(
    client: ReturnType<typeof makeFakeClient>,
    sandbox?: { expected: boolean; enabled: boolean; wrapperPath?: string; reason?: string },
  ) {
    return new TaskDispatcher({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      store,
      worktrees: new GitWorktreeManager(),
      worktreeBaseDir: () => join(tmp, "worktrees"),
      sandbox,
    });
  }

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "ocb-sandbox-")));
    process.env.BOARD_WORKSPACE = tmp;
    store = new SqliteTaskStore(":memory:");
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
    delete process.env.BOARD_WORKSPACE;
  });

  it("blocks a worktree-isolated run with runState error when sandboxing is expected but unavailable (no session, no worktree)", async () => {
    const repo = join(tmp, "repo");
    makeRepo(repo);
    const client = makeFakeClient();
    const dispatcher = buildDispatcher(client, {
      expected: true,
      enabled: false,
      reason: "sandbox-exec not found at /usr/bin/sandbox-exec",
    });

    const task = store.create({
      title: "t",
      description: "d",
      directory: repo,
      isolation: "worktree",
    });
    const blocked = await dispatcher.run(task.id);

    expect(blocked.runState).toBe("error");
    expect(blocked.error).toContain("sandbox wrapper");
    expect(blocked.error).toContain("sandbox-exec not found at /usr/bin/sandbox-exec");
    expect(client.createCalls).toHaveLength(0);
    // No worktree should have been created either — the gate fires before ensureWorktree().
    expect(existsSync(join(tmp, "worktrees", task.id))).toBe(false);
  });

  it("proceeds normally when sandbox.expected is true and sandbox.enabled is also true", async () => {
    const repo = join(tmp, "repo");
    makeRepo(repo);
    const client = makeFakeClient();
    const dispatcher = buildDispatcher(client, {
      expected: true,
      enabled: true,
      wrapperPath: "/repo/scripts/sandbox-wrapper.sh",
    });

    const task = store.create({
      title: "t",
      description: "d",
      directory: repo,
      isolation: "worktree",
    });
    const ran = await dispatcher.run(task.id);

    expect(ran.runState).toBe("running");
    expect(client.createCalls).toHaveLength(1);
  });

  it("proceeds normally (no gating at all) when sandbox is undefined — the safe default for existing callers", async () => {
    const repo = join(tmp, "repo");
    makeRepo(repo);
    const client = makeFakeClient();
    const dispatcher = buildDispatcher(client); // no sandbox dep passed at all

    const task = store.create({
      title: "t",
      description: "d",
      directory: repo,
      isolation: "worktree",
    });
    const ran = await dispatcher.run(task.id);

    expect(ran.runState).toBe("running");
    expect(client.createCalls).toHaveLength(1);
  });

  it("never fail-closes an in-place task, even when sandboxing is expected but unavailable", async () => {
    const repo = join(tmp, "repo");
    makeRepo(repo);
    const client = makeFakeClient();
    const dispatcher = buildDispatcher(client, {
      expected: true,
      enabled: false,
      reason: "sandbox-exec not found at /usr/bin/sandbox-exec",
    });

    const task = store.create({
      title: "t",
      description: "d",
      directory: repo,
      isolation: "in-place",
    });
    const ran = await dispatcher.run(task.id);

    // In-place tasks never depended on the wrapper for their write scope
    // (UNATTENDED_PERMISSION already grants full access to their own
    // directory), so the fail-closed gate — which only guards the isolation
    // guarantee worktree tasks rely on — must not block them.
    expect(ran.runState).toBe("running");
    expect(client.createCalls[0]?.directory).toBe(repo);
  });
});
