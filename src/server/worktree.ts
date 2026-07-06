/**
 * Git worktree engine — the isolation primitive behind worktree-per-agent runs.
 *
 * Each isolated task run gets its own `git worktree` cut from the task's repo, so
 * concurrent agents never share a working tree and can't clobber each other's
 * edits. The worktree + its branch persist after the run (the card hits Review);
 * the board then drives two explicit reclaim operations:
 *
 *   - sync:      merge the upstream base branch *into* the worktree branch, so the
 *                agent's branch can be brought current and conflicts resolved there.
 *   - integrate: commit dirty worktree changes onto the task branch, merge that
 *                branch *into* the base branch, then remove the worktree — but
 *                keep the branch.
 *
 * Non-git task directories can't be isolated; `isGitRepo` lets the caller surface
 * the "make this a git repo?" decision instead of silently running.
 *
 * All git calls go through execFile (no shell) so paths/branch names with spaces
 * are safe. Every method returns structured results rather than throwing on the
 * expected git failure modes (merge conflict, dirty tree) so callers can react.
 */
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface WorktreeInfo {
  /** Absolute path of the created worktree checkout. */
  worktreePath: string;
  /** The branch created for (and checked out in) the worktree. */
  branch: string;
  /** The branch the worktree was cut from (upstream/base). */
  baseBranch: string;
}

export interface MergeResult {
  ok: boolean;
  /** True when the merge stopped on conflicts (left in the working tree to resolve). */
  conflict: boolean;
  message: string;
  /** Files reported by git as unmerged/conflicted. */
  conflictPaths?: string[];
}

export interface WorktreeCleanupResult {
  ok: boolean;
  removed: boolean;
  dirty: boolean;
  kept: boolean;
  message: string;
  worktreePath?: string;
}

export interface WorktreeManager {
  /** True if `dir` is inside a git work tree. */
  isGitRepo(dir: string): Promise<boolean>;
  /** `git init` a plain directory and commit whatever is there as the first commit. */
  initRepo(dir: string, message?: string): Promise<void>;
  /** Absolute path of the repo's top-level working directory containing `dir`. */
  repoRoot(dir: string): Promise<string>;
  /** The branch currently checked out at `dir` (the base for a new worktree). */
  currentBranch(dir: string): Promise<string>;
  /** `git worktree add <path> -b <branch>` cut from `dir`'s current branch. */
  createWorktree(dir: string, branch: string, worktreePath: string): Promise<WorktreeInfo>;
  /** Merge `baseBranch` into the branch checked out in `worktreePath`. */
  syncUpstream(worktreePath: string, baseBranch: string): Promise<MergeResult>;
  /**
   * Commit dirty worktree changes, merge `branch` into `targetBranch` in the
   * main repo, then remove `worktreePath` (keep branch).
   */
  integrate(
    repoDir: string,
    branch: string,
    targetBranch: string,
    worktreePath: string,
  ): Promise<MergeResult>;
  /** True when tracked/untracked worktree changes exist, including unmerged paths. */
  isWorktreeDirty(worktreePath: string): Promise<boolean>;
  /** Remove a worktree if clean, or when `force` is true. Keeps the branch. */
  cleanupWorktree(repoDir: string, worktreePath: string, options?: { force?: boolean }): Promise<WorktreeCleanupResult>;
  /** List immediate directories under the board-owned worktree root for `repoDir`. */
  listManagedWorktrees(repoDir: string, worktreeBaseDir: string): Promise<string[]>;
  /** `git worktree remove` (force). The branch is left intact. */
  removeWorktree(repoDir: string, worktreePath: string): Promise<void>;
}

/**
 * Env with every inherited GIT_* variable stripped. Git exports GIT_DIR,
 * GIT_INDEX_FILE, GIT_WORK_TREE, etc. into hook processes (and can be set in any
 * shell); inheriting them would redirect our commands at the wrong repo instead
 * of the `cwd` we pass. Scrub them so `git -C <dir>` always targets <dir>'s repo.
 */
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  return env;
}

/** Run a git command in `cwd`. Never throws on non-zero exit; returns the captured result. */
async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      env: cleanGitEnv(),
      maxBuffer: 1024 * 1024 * 16,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? "",
    };
  }
}

function fail(result: GitResult, action: string): never {
  const detail = (result.stderr || result.stdout || "").trim();
  throw new Error(`git ${action} failed (exit ${result.code})${detail ? `: ${detail}` : ""}`);
}

function hasUnmergedPaths(status: string): boolean {
  return status
    .split("\n")
    .filter(Boolean)
    .some((line) => {
      const xy = line.slice(0, 2);
      return xy.includes("U") || xy === "AA" || xy === "DD";
    });
}

function conflictPaths(status: string): string[] {
  const paths = new Set<string>();
  for (const line of status.split("\n").filter(Boolean)) {
    const xy = line.slice(0, 2);
    if (!xy.includes("U") && xy !== "AA" && xy !== "DD") continue;
    paths.add(line.slice(3).trim());
  }
  return [...paths].filter(Boolean).sort();
}

export class GitWorktreeManager implements WorktreeManager {
  async isGitRepo(dir: string): Promise<boolean> {
    const result = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
    return result.code === 0 && result.stdout.trim() === "true";
  }

  async initRepo(dir: string, message = "openboard: initial commit"): Promise<void> {
    const init = await git(dir, ["init"]);
    if (init.code !== 0) fail(init, "init");
    // Ensure there's an identity for the commit even on a bare environment.
    const add = await git(dir, ["add", "-A"]);
    if (add.code !== 0) fail(add, "add");
    const commit = await git(dir, [
      "-c",
      "user.name=openboard",
      "-c",
      "user.email=openboard@localhost",
      "commit",
      "--no-gpg-sign",
      "-m",
      message,
      "--allow-empty",
    ]);
    if (commit.code !== 0) fail(commit, "commit");
  }

  async repoRoot(dir: string): Promise<string> {
    const result = await git(dir, ["rev-parse", "--show-toplevel"]);
    if (result.code !== 0) fail(result, "rev-parse --show-toplevel");
    return result.stdout.trim();
  }

  async currentBranch(dir: string): Promise<string> {
    const result = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (result.code !== 0) fail(result, "rev-parse --abbrev-ref HEAD");
    const branch = result.stdout.trim();
    // Detached HEAD → fall back to the short sha so we still have a base ref.
    if (branch === "HEAD") {
      const sha = await git(dir, ["rev-parse", "--short", "HEAD"]);
      if (sha.code !== 0) fail(sha, "rev-parse --short HEAD");
      return sha.stdout.trim();
    }
    return branch;
  }

  async createWorktree(dir: string, branch: string, worktreePath: string): Promise<WorktreeInfo> {
    const baseBranch = await this.currentBranch(dir);
    const result = await git(dir, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
    if (result.code !== 0) fail(result, "worktree add");
    return { worktreePath, branch, baseBranch };
  }

  async syncUpstream(worktreePath: string, baseBranch: string): Promise<MergeResult> {
    const result = await git(worktreePath, [
      "-c",
      "user.name=openboard",
      "-c",
      "user.email=openboard@localhost",
      "merge",
      "--no-edit",
      "--no-gpg-sign",
      baseBranch,
    ]);
    return toMergeResult(result, `merge ${baseBranch} into worktree`);
  }

  async integrate(
    repoDir: string,
    branch: string,
    targetBranch: string,
    worktreePath: string,
  ): Promise<MergeResult> {
    // Agents normally leave file edits uncommitted. Capture those edits on the
    // task branch first, or integration would merge an unchanged branch and then
    // remove the only checkout containing the work.
    const status = await git(worktreePath, ["status", "--porcelain"]);
    if (status.code !== 0) {
      return { ok: false, conflict: false, message: `status worktree: ${errText(status)}` };
    }
    if (hasUnmergedPaths(status.stdout)) {
      return {
        ok: false,
        conflict: true,
        message: "worktree has unresolved merge conflicts — resolve them before integrate",
      };
    }
    if (status.stdout.trim().length > 0) {
      const add = await git(worktreePath, ["add", "-A"]);
      if (add.code !== 0) {
        return { ok: false, conflict: false, message: `add worktree changes: ${errText(add)}` };
      }
      const commit = await git(worktreePath, [
        "-c",
        "user.name=openboard",
        "-c",
        "user.email=openboard@localhost",
        "commit",
        "--no-gpg-sign",
        "-m",
        `openboard: save ${branch}`,
      ]);
      if (commit.code !== 0) {
        return { ok: false, conflict: false, message: `commit worktree changes: ${errText(commit)}` };
      }
    }

    const rebase = await git(worktreePath, ["rebase", targetBranch]);
    if (rebase.code !== 0) {
      const conflict = await git(worktreePath, ["status", "--porcelain"]);
      const paths = conflict.code === 0 ? conflictPaths(conflict.stdout) : [];
      return {
        ok: false,
        conflict: true,
        conflictPaths: paths,
        message: paths.length
          ? `rebase ${branch} onto ${targetBranch}: conflict in ${paths.join(", ")}`
          : `rebase ${branch} onto ${targetBranch}: ${errText(rebase)}`,
      };
    }

    // Rebase succeeded inside the task worktree, so the base checkout is only
    // touched by a fast-forward merge. Any non-ff result is unexpected and
    // returns as a normal failure without leaving the base mid-conflict.
    const checkout = await git(repoDir, ["checkout", targetBranch]);
    if (checkout.code !== 0) {
      return { ok: false, conflict: false, message: `checkout ${targetBranch}: ${errText(checkout)}` };
    }
    const merge = await git(repoDir, [
      "-c",
      "user.name=openboard",
      "-c",
      "user.email=openboard@localhost",
      "merge",
      "--ff-only",
      branch,
    ]);
    const merged = toMergeResult(merge, `merge ${branch} into ${targetBranch}`);
    if (!merged.ok) return merged;
    // Success → drop the worktree, keep the branch.
    await this.removeWorktree(repoDir, worktreePath);
    return merged;
  }

  async isWorktreeDirty(worktreePath: string): Promise<boolean> {
    const status = await git(worktreePath, ["status", "--porcelain"]);
    if (status.code !== 0) fail(status, "status worktree");
    return status.stdout.trim().length > 0;
  }

  async cleanupWorktree(
    repoDir: string,
    worktreePath: string,
    options: { force?: boolean } = {},
  ): Promise<WorktreeCleanupResult> {
    const dirty = await this.isWorktreeDirty(worktreePath);
    if (dirty && !options.force) {
      return {
        ok: false,
        removed: false,
        dirty: true,
        kept: true,
        worktreePath,
        message: "worktree has uncommitted changes; confirm removal or keep it for manual salvage",
      };
    }

    await this.removeWorktree(repoDir, worktreePath);
    return {
      ok: true,
      removed: true,
      dirty,
      kept: false,
      worktreePath,
      message: dirty ? "dirty worktree removed; branch kept" : "clean worktree removed; branch kept",
    };
  }

  async listManagedWorktrees(_repoDir: string, worktreeBaseDir: string): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(worktreeBaseDir, { withFileTypes: true });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") return [];
      throw err;
    }
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("task_"))
      .map((entry) => `${worktreeBaseDir}/${entry.name}`)
      .sort();
  }

  async removeWorktree(repoDir: string, worktreePath: string): Promise<void> {
    const result = await git(repoDir, ["worktree", "remove", "--force", worktreePath]);
    if (result.code !== 0) fail(result, "worktree remove");
  }
}

function errText(result: GitResult): string {
  return (result.stderr || result.stdout || "").trim();
}

function toMergeResult(result: GitResult, action: string): MergeResult {
  if (result.code === 0) {
    return { ok: true, conflict: false, message: (result.stdout || "merge complete").trim() };
  }
  const text = errText(result);
  const conflict = /conflict/i.test(text) || /CONFLICT/.test(result.stdout);
  return {
    ok: false,
    conflict,
    message: conflict ? `${action}: merge conflict — resolve in the worktree` : `${action}: ${text}`,
  };
}
