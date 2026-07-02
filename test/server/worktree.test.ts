import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitWorktreeManager } from "../../src/server/worktree";

/** Deterministic git in a temp dir (no shell, fixed identity, no signing). */
function g(cwd: string, args: string[]): string {
  // Strip inherited GIT_* (a git hook exports GIT_DIR/GIT_INDEX_FILE/etc. that
  // would redirect these commands at the real repo instead of the temp dir).
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("GIT_")) env[k] = v;
  }
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@localhost",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@localhost",
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

describe("GitWorktreeManager", () => {
  let tmp: string;
  const mgr = new GitWorktreeManager();

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ocb-wt-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("isGitRepo distinguishes repos from plain dirs", async () => {
    const repo = join(tmp, "repo");
    const plain = join(tmp, "plain");
    makeRepo(repo);
    mkdirSync(plain, { recursive: true });

    expect(await mgr.isGitRepo(repo)).toBe(true);
    expect(await mgr.isGitRepo(plain)).toBe(false);
  });

  it("initRepo turns a plain dir into a repo with a first commit", async () => {
    const dir = join(tmp, "fresh");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.txt"), "hello\n");

    expect(await mgr.isGitRepo(dir)).toBe(false);
    await mgr.initRepo(dir);

    expect(await mgr.isGitRepo(dir)).toBe(true);
    // The initial content was committed.
    const log = g(dir, ["log", "--oneline"]);
    expect(log).toContain("opencode-board");
    const tracked = g(dir, ["ls-files"]);
    expect(tracked).toContain("a.txt");
  });

  it("initRepo commits even an empty dir (--allow-empty)", async () => {
    const dir = join(tmp, "empty");
    mkdirSync(dir, { recursive: true });
    await mgr.initRepo(dir);
    expect(await mgr.isGitRepo(dir)).toBe(true);
    expect(g(dir, ["rev-list", "--count", "HEAD"])).toBe("1");
  });

  it("repoRoot and currentBranch report the toplevel and branch", async () => {
    const repo = join(tmp, "repo");
    makeRepo(repo);
    const sub = join(repo, "nested");
    mkdirSync(sub, { recursive: true });

    expect(await mgr.repoRoot(sub)).toBe(g(repo, ["rev-parse", "--show-toplevel"]));
    expect(await mgr.currentBranch(repo)).toBe("main");
  });

  it("createWorktree cuts a new branch checkout at a separate path", async () => {
    const repo = join(tmp, "repo");
    makeRepo(repo);
    const wtPath = join(tmp, "wt");

    const info = await mgr.createWorktree(repo, "board/task-1", wtPath);
    expect(info).toEqual({ worktreePath: wtPath, branch: "board/task-1", baseBranch: "main" });
    expect(existsSync(join(wtPath, "file.txt"))).toBe(true);
    // The worktree is on its own branch; the main repo is still on main.
    expect(g(wtPath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("board/task-1");
    expect(g(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(g(repo, ["worktree", "list"])).toContain(wtPath);
  });

  it("syncUpstream merges upstream base commits into the worktree branch (clean)", async () => {
    const repo = join(tmp, "repo");
    makeRepo(repo);
    const wtPath = join(tmp, "wt");
    await mgr.createWorktree(repo, "board/task-1", wtPath);

    // Advance main with a non-conflicting file after the worktree was cut.
    writeFileSync(join(repo, "upstream.txt"), "from upstream\n");
    g(repo, ["add", "-A"]);
    g(repo, ["commit", "--no-gpg-sign", "-m", "upstream change"]);

    const res = await mgr.syncUpstream(wtPath, "main");
    expect(res.ok).toBe(true);
    expect(res.conflict).toBe(false);
    // The upstream file now exists in the worktree.
    expect(existsSync(join(wtPath, "upstream.txt"))).toBe(true);
  });

  it("syncUpstream reports a conflict instead of throwing", async () => {
    const repo = join(tmp, "repo");
    makeRepo(repo);
    const wtPath = join(tmp, "wt");
    await mgr.createWorktree(repo, "board/task-1", wtPath);

    // Both branches edit the same line → conflict on merge.
    writeFileSync(join(wtPath, "file.txt"), "worktree edit\n");
    g(wtPath, ["add", "-A"]);
    g(wtPath, ["commit", "--no-gpg-sign", "-m", "wt edit"]);
    writeFileSync(join(repo, "file.txt"), "upstream edit\n");
    g(repo, ["add", "-A"]);
    g(repo, ["commit", "--no-gpg-sign", "-m", "upstream edit"]);

    const res = await mgr.syncUpstream(wtPath, "main");
    expect(res.ok).toBe(false);
    expect(res.conflict).toBe(true);
  });

  it("integrate merges the worktree branch into target, removes the worktree, keeps the branch", async () => {
    const repo = join(tmp, "repo");
    makeRepo(repo);
    const wtPath = join(tmp, "wt");
    await mgr.createWorktree(repo, "board/task-1", wtPath);

    // Do work on the worktree branch.
    writeFileSync(join(wtPath, "feature.txt"), "agent work\n");
    g(wtPath, ["add", "-A"]);
    g(wtPath, ["commit", "--no-gpg-sign", "-m", "feature"]);

    const res = await mgr.integrate(repo, "board/task-1", "main", wtPath);
    expect(res.ok).toBe(true);
    // main now has the feature commit.
    expect(existsSync(join(repo, "feature.txt"))).toBe(true);
    expect(g(repo, ["log", "--oneline"])).toContain("feature");
    // Worktree removed…
    expect(existsSync(wtPath)).toBe(false);
    expect(g(repo, ["worktree", "list"])).not.toContain(wtPath);
    // …but the branch is kept.
    expect(g(repo, ["branch", "--list", "board/task-1"])).toContain("board/task-1");
  });

  it("removeWorktree drops the checkout but leaves the branch", async () => {
    const repo = join(tmp, "repo");
    makeRepo(repo);
    const wtPath = join(tmp, "wt");
    await mgr.createWorktree(repo, "board/task-1", wtPath);

    await mgr.removeWorktree(repo, wtPath);
    expect(existsSync(wtPath)).toBe(false);
    expect(g(repo, ["branch", "--list", "board/task-1"])).toContain("board/task-1");
  });

  it("currentBranch falls back to a short sha on detached HEAD", async () => {
    const repo = join(tmp, "repo");
    makeRepo(repo);
    const sha = g(repo, ["rev-parse", "--short", "HEAD"]);
    g(repo, ["checkout", "--detach", "HEAD"]);
    expect(await mgr.currentBranch(repo)).toBe(sha);
  });

  it("surfaces a readable error when git operations fail", async () => {
    const plain = join(tmp, "plain");
    mkdirSync(plain, { recursive: true });
    await expect(mgr.repoRoot(plain)).rejects.toThrow(/git rev-parse/);
  });
});
