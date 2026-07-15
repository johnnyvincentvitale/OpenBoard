import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectBaseCheckoutEscape, snapshotBaseCheckout } from "../../src/server/escape-detector";

/** Deterministic git in a temp dir (no shell, fixed identity, no signing). */
function g(cwd: string, args: string[]): string {
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

describe("detectBaseCheckoutEscape", () => {
  let tmp: string;
  let repo: string;

  beforeEach(() => {
    tmp = realpathSync.native(mkdtempSync(join(tmpdir(), "ocb-escape-")));
    repo = join(tmp, "repo");
    makeRepo(repo);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("clean-to-clean: no escape when the repo stays clean", async () => {
    const snapshot = await snapshotBaseCheckout(repo);
    expect(snapshot).toBe("");

    const result = await detectBaseCheckoutEscape(repo, snapshot);
    expect(result).toEqual({ escaped: false, changedPaths: [] });
  });

  it("dirty-to-same-dirty: no escape when the same file stays dirty the same way", async () => {
    writeFileSync(join(repo, "file.txt"), "already dirty\n");
    const snapshot = await snapshotBaseCheckout(repo);
    expect(snapshot?.trim()).not.toBe("");

    // Re-run detection with the exact same dirty state — nothing new.
    const result = await detectBaseCheckoutEscape(repo, snapshot);
    expect(result).toEqual({ escaped: false, changedPaths: [] });
  });

  it("clean-to-escaped: a new untracked path appears on a previously clean repo", async () => {
    const snapshot = await snapshotBaseCheckout(repo);
    expect(snapshot).toBe("");

    writeFileSync(join(repo, "escape.txt"), "bash wrote this\n");

    const result = await detectBaseCheckoutEscape(repo, snapshot);
    expect(result.escaped).toBe(true);
    expect(result.changedPaths).toEqual(["escape.txt"]);
  });

  it("dirty-to-extra-escape: a new path appears on top of pre-existing dirt", async () => {
    writeFileSync(join(repo, "file.txt"), "already dirty\n");
    const snapshot = await snapshotBaseCheckout(repo);

    writeFileSync(join(repo, "escape.txt"), "new escape on top of existing dirt\n");

    const result = await detectBaseCheckoutEscape(repo, snapshot);
    expect(result.escaped).toBe(true);
    expect(result.changedPaths).toEqual(["escape.txt"]);
  });

  it("treats a null snapshot as an empty baseline", async () => {
    writeFileSync(join(repo, "escape.txt"), "no snapshot was ever taken\n");

    const result = await detectBaseCheckoutEscape(repo, null);
    expect(result.escaped).toBe(true);
    expect(result.changedPaths).toEqual(["escape.txt"]);
  });

  it("resolves a rename's new path from the porcelain '-> ' arrow", async () => {
    const snapshot = await snapshotBaseCheckout(repo);
    g(repo, ["mv", "file.txt", "renamed.txt"]);

    const result = await detectBaseCheckoutEscape(repo, snapshot);
    expect(result.escaped).toBe(true);
    expect(result.changedPaths).toEqual(["renamed.txt"]);
  });

  it("catches a new file added inside a directory that was already untracked at dispatch", async () => {
    mkdirSync(join(repo, "d"));
    writeFileSync(join(repo, "d", "a.txt"), "already untracked at dispatch\n");
    const snapshot = await snapshotBaseCheckout(repo);
    // Sanity: the untracked dir is captured, not collapsed to a bare "?? d/" line.
    expect(snapshot).toContain("d/a.txt");

    writeFileSync(join(repo, "d", "b.txt"), "bash escape wrote this new file\n");

    const result = await detectBaseCheckoutEscape(repo, snapshot);
    expect(result.escaped).toBe(true);
    expect(result.changedPaths).toEqual(["d/b.txt"]);
  });

  it("catches a modification to a path that was already dirty via rename at dispatch", async () => {
    g(repo, ["mv", "file.txt", "renamed.txt"]);
    const afterRename = await snapshotBaseCheckout(repo);

    // Further modify the renamed file in the base checkout — a bash escape on
    // top of a pre-existing rename must still be caught, not masked by the
    // path string being identical to the rename-only snapshot.
    writeFileSync(join(repo, "renamed.txt"), "bash escape appended to renamed file\n");

    const result = await detectBaseCheckoutEscape(repo, afterRename);
    expect(result.escaped).toBe(true);
    expect(result.changedPaths).toEqual(["renamed.txt"]);
  });

  it.skipIf(process.platform === "win32")("correctly splits rename old/new paths when a filename contains a literal ' -> '", async () => {
    writeFileSync(join(repo, "weird -> name.txt"), "hi\n");
    g(repo, ["add", "-A"]);
    g(repo, ["commit", "--no-gpg-sign", "-m", "add weird file"]);
    const snapshot = await snapshotBaseCheckout(repo);

    g(repo, ["mv", "weird -> name.txt", "weird -> name2.txt"]);

    const result = await detectBaseCheckoutEscape(repo, snapshot);
    expect(result.escaped).toBe(true);
    expect(result.changedPaths).toEqual(["weird -> name2.txt"]);
  });

  it("does not flag a sibling task's own worktree created after this task's snapshot (nested layout)", async () => {
    const nestDir = join(repo, ".opencode-board-worktrees", "repo");
    g(repo, ["worktree", "add", "-b", "board/taskA", join(nestDir, "taskA"), "HEAD"]);
    const snapshot = await snapshotBaseCheckout(repo);

    // A concurrent sibling card's worktree is created afterward, in the same repo.
    g(repo, ["worktree", "add", "-b", "board/taskB", join(nestDir, "taskB"), "HEAD"]);

    const result = await detectBaseCheckoutEscape(repo, snapshot);
    expect(result).toEqual({ escaped: false, changedPaths: [] });
  });

  it("still catches a fake directory that merely shares the worktree naming convention but isn't a real worktree", async () => {
    const nestDir = join(repo, ".opencode-board-worktrees", "repo");
    g(repo, ["worktree", "add", "-b", "board/taskA", join(nestDir, "taskA"), "HEAD"]);
    const snapshot = await snapshotBaseCheckout(repo);

    // Not a real `git worktree add` — just a directory sharing the naming
    // convention. Must not be swallowed by the same-shaped exclusion above.
    mkdirSync(join(nestDir, "fake-task"), { recursive: true });
    writeFileSync(join(nestDir, "fake-task", "evil.txt"), "escape disguised as a worktree\n");

    const result = await detectBaseCheckoutEscape(repo, snapshot);
    expect(result.escaped).toBe(true);
    expect(result.changedPaths).toEqual([".opencode-board-worktrees/repo/fake-task/evil.txt"]);
  });

  it("catches a symlink write-through that dirties a tracked base-checkout file (CVE-2026-39861 shape)", async () => {
    // A worktree can hold a symlink pointing at a tracked file in the base
    // checkout. A write through that symlink lands as an ordinary content
    // change to the base repo's own working tree; the detector must catch it.
    const snapshot = await snapshotBaseCheckout(repo);
    expect(snapshot).toBe("");

    const worktreeStandIn = join(tmp, "worktree-stand-in");
    mkdirSync(worktreeStandIn, { recursive: true });
    const symlinkPath = join(worktreeStandIn, "evil-symlink");
    symlinkSync(join(repo, "file.txt"), symlinkPath);
    writeFileSync(symlinkPath, "escape written through a symlink into the base checkout\n");

    const result = await detectBaseCheckoutEscape(repo, snapshot);
    expect(result.escaped).toBe(true);
    expect(result.changedPaths).toEqual(["file.txt"]);
  });
});
