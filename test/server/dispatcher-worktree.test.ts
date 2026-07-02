import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../src/db/task-store";
import { TaskDispatcher } from "../../src/server/dispatcher";
import { GitWorktreeManager } from "../../src/server/worktree";

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

/** Minimal fake OpenCode client: records session.create location, always succeeds. */
function makeFakeClient() {
  const createCalls: Array<{ location?: { directory: string } }> = [];
  const promptCalls: Array<{ sessionID: string }> = [];
  return {
    createCalls,
    promptCalls,
    v2: {
      session: {
        create: async (params: { location?: { directory: string } }) => {
          createCalls.push(params);
          return { data: { data: { id: "ses_1" } }, error: undefined };
        },
        prompt: async (params: { sessionID: string; prompt: unknown }) => {
          promptCalls.push({ sessionID: params.sessionID });
          return { data: {}, error: undefined };
        },
      },
    },
    session: { abort: async () => ({ data: {}, error: undefined }) },
    event: { subscribe: async () => ({ stream: (async function* () {})() }) },
  };
}

describe("TaskDispatcher — worktree isolation", () => {
  let tmp: string;
  let store: SqliteTaskStore;

  function buildDispatcher(client: ReturnType<typeof makeFakeClient>) {
    return new TaskDispatcher({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client: client as any,
      store,
      worktrees: new GitWorktreeManager(),
      // Keep worktrees inside the temp dir for the test.
      worktreeBaseDir: () => join(tmp, "worktrees"),
    });
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ocb-disp-"));
    store = new SqliteTaskStore(":memory:");
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
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
    expect(client.createCalls[0]?.location?.directory).toBe(wtPath);
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

    expect(client.createCalls[0]?.location?.directory).toBe(repo);
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
    expect(client.createCalls[0]?.location?.directory).toBe(join(tmp, "worktrees", task.id));
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

    const outcome = await dispatcher.integrate(task.id);
    expect(outcome.ok).toBe(true);
    // base has the feature, worktree gone, branch kept, task.worktreePath cleared.
    expect(existsSync(join(repo, "feature.txt"))).toBe(true);
    expect(existsSync(wtPath)).toBe(false);
    expect(g(repo, ["branch", "--list", `board/${task.id}`])).toContain(`board/${task.id}`);
    expect(store.get(task.id)?.worktreePath).toBeUndefined();
  });
});
