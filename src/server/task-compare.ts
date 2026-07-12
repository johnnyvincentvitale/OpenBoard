/**
 * Task evidence comparison — read-only Git delta from base task output to
 * target task output.
 *
 * Build→Fix comparison is only meaningful when the target evidence descends
 * from the selected base task's complete output. Diverged branches are refused
 * rather than labeled as ordered evidence.
 */
import type { DiffResponse, Task, TaskCompareResponse } from "../shared";
import {
  computeDiffBetweenRefs,
  computeDiffAgainstWorkingTree,
  DIFF_CONTEXT_LINES,
  MAX_TOTAL_PATCH_BYTES,
  resolveGitCommonDir,
  resolveGitRepoRoot,
  execGit,
  isSafeRef,
} from "./diff-engine";

export type ResolvedRefSource = {
  kind: "ref";
  repoRoot: string;
  gitCommonDir: string;
  ref: string;
  sha: string;
};

type ResolvedLiveSource = {
  kind: "live";
  repoRoot: string;
  gitCommonDir: string;
  livePath: string;
  sha: string;
};

type ResolvedSource = ResolvedRefSource | ResolvedLiveSource;
type UnsupportedReason = { kind: "unsupported"; reason: string; ref?: string | null; sha?: string | null };

function getWorkingDirectory(task: Task): string | undefined {
  return task.worktreePath ?? task.harnessCwd ?? task.directory;
}

async function resolveRepoIdentity(cwd: string): Promise<{ repoRoot: string; gitCommonDir: string } | null> {
  const [rootResult, commonResult] = await Promise.all([
    resolveGitRepoRoot(cwd),
    resolveGitCommonDir(cwd),
  ]);
  if (!rootResult || !commonResult) return null;
  return { repoRoot: rootResult, gitCommonDir: commonResult };
}

async function resolveRefSha(cwd: string, ref: string): Promise<string | null> {
  const result = await execGit(cwd, ["rev-parse", "--verify", ref]);
  return result.code === 0 && result.stdout.trim().length > 0 ? result.stdout.trim() : null;
}

async function resolveHeadSha(cwd: string): Promise<string | null> {
  const result = await execGit(cwd, ["rev-parse", "HEAD"]);
  return result.code === 0 && result.stdout.trim().length > 0 ? result.stdout.trim() : null;
}

type CleanlinessCheck =
  | { kind: "clean" }
  | { kind: "dirty" }
  | { kind: "unknown"; reason: string };

async function checkCleanliness(cwd: string): Promise<CleanlinessCheck> {
  const status = await execGit(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  if (status.code !== 0) {
    return { kind: "unknown", reason: status.stderr.trim() || "git status failed" };
  }
  return status.stdout.trim().length > 0 ? { kind: "dirty" } : { kind: "clean" };
}

function liveBaseLocationForRef(task: Task, ref: string): { path: string; label: string } | null {
  if (task.worktreePath && task.worktreeBranch === ref) {
    return { path: task.worktreePath, label: `branch ${ref}` };
  }
  if (task.harnessCwd && task.harnessBranch === ref) {
    return { path: task.harnessCwd, label: `harness branch ${ref}` };
  }
  return null;
}

async function resolveBaseSource(task: Task): Promise<ResolvedRefSource | UnsupportedReason> {
  const cwd = getWorkingDirectory(task);
  if (!cwd) return { kind: "unsupported", reason: `Task ${task.id} has no associated directory` };

  const identity = await resolveRepoIdentity(cwd);
  if (!identity) return { kind: "unsupported", reason: `Task ${task.id} directory is not a git repository` };

  const ref = task.worktreeBranch ?? task.harnessBranch ?? task.harnessCommit;
  if (!ref) return { kind: "unsupported", reason: `Task ${task.id} has no durable branch or commit snapshot` };

  if (!isSafeRef(ref)) {
    return { kind: "unsupported", reason: `Task ${task.id} durable ref is unsafe and was rejected before git invocation`, ref: null };
  }

  const sha = await resolveRefSha(cwd, ref);
  if (!sha) return { kind: "unsupported", reason: `Task ${task.id} durable ref ${ref} is not available`, ref };

  const liveBase = liveBaseLocationForRef(task, ref);
  if (liveBase) {
    const cleanliness = await checkCleanliness(liveBase.path);
    if (cleanliness.kind === "unknown") {
      return {
        kind: "unsupported",
        reason: `Task ${task.id}'s output cleanliness cannot be established in its live worktree (${liveBase.label}); refusing to compare against possibly incomplete output`,
        ref,
        sha,
      };
    }
    if (cleanliness.kind === "dirty") {
      return {
        kind: "unsupported",
        reason: `Task ${task.id}'s output has uncommitted tracked or untracked changes in its live worktree (${liveBase.label}); commit or integrate the task before comparing against it`,
        ref,
        sha,
      };
    }
  }

  return { kind: "ref", repoRoot: identity.repoRoot, gitCommonDir: identity.gitCommonDir, ref, sha };
}

async function resolveTargetSource(task: Task): Promise<ResolvedSource | UnsupportedReason> {
  const cwd = getWorkingDirectory(task);
  if (!cwd) return { kind: "unsupported", reason: `Task ${task.id} has no associated directory` };

  const identity = await resolveRepoIdentity(cwd);
  if (!identity) return { kind: "unsupported", reason: `Task ${task.id} directory is not a git repository` };

  const livePath = task.worktreePath ?? task.harnessCwd;
  if (livePath) {
    const sha = await resolveHeadSha(livePath);
    if (!sha) return { kind: "unsupported", reason: `Task ${task.id} live worktree has no resolvable HEAD` };
    return { kind: "live", repoRoot: identity.repoRoot, gitCommonDir: identity.gitCommonDir, livePath, sha };
  }

  const ref = task.worktreeBranch ?? task.harnessBranch ?? task.harnessCommit;
  if (!ref) return { kind: "unsupported", reason: `Task ${task.id} has no durable ref or live worktree` };
  if (!isSafeRef(ref)) {
    return { kind: "unsupported", reason: `Task ${task.id} durable ref is unsafe and was rejected before git invocation`, ref: null };
  }
  const sha = await resolveRefSha(cwd, ref);
  if (!sha) return { kind: "unsupported", reason: `Task ${task.id} durable ref ${ref} is not available`, ref };

  return { kind: "ref", repoRoot: identity.repoRoot, gitCommonDir: identity.gitCommonDir, ref, sha };
}

async function mergeBase(cwd: string, baseSha: string, targetSha: string): Promise<string | null> {
  const result = await execGit(cwd, ["merge-base", baseSha, targetSha]);
  return result.code === 0 && result.stdout.trim().length > 0 ? result.stdout.trim() : null;
}

function noGit(
  baseTask: Task,
  targetTask: Task,
  reason: string,
  extras: Partial<Extract<TaskCompareResponse, { kind: "no-git" }>> = {},
): TaskCompareResponse {
  return {
    kind: "no-git",
    baseTaskId: baseTask.id,
    targetTaskId: targetTask.id,
    baseRef: null,
    targetRef: null,
    reason,
    comparisonMode: "unsupported",
    ...extras,
  };
}

export async function compareTaskEvidence(
  baseTask: Task,
  targetTask: Task,
): Promise<TaskCompareResponse> {
  const base = await resolveBaseSource(baseTask);
  if (base.kind === "unsupported") {
    return noGit(baseTask, targetTask, base.reason, { baseRef: base.ref ?? null, baseSha: base.sha ?? null });
  }

  const target = await resolveTargetSource(targetTask);
  if (target.kind === "unsupported") {
    return noGit(baseTask, targetTask, target.reason, {
      baseRef: base.ref,
      targetRef: target.ref ?? null,
      baseSha: base.sha,
      targetSha: target.sha ?? null,
    });
  }

  const targetRef = target.kind === "ref" ? target.ref : null;
  if (base.gitCommonDir !== target.gitCommonDir) {
    return noGit(baseTask, targetTask, "Tasks are not in the same git repository", {
      baseRef: base.ref,
      targetRef,
      baseSha: base.sha,
      targetSha: target.sha,
    });
  }

  const mergeBaseSha = await mergeBase(base.repoRoot, base.sha, target.sha);
  if (!mergeBaseSha) {
    return noGit(baseTask, targetTask, "Could not compute a merge base for task comparison", {
      baseRef: base.ref,
      targetRef,
      baseSha: base.sha,
      targetSha: target.sha,
      mergeBaseSha: null,
    });
  }
  if (mergeBaseSha !== base.sha) {
    return noGit(baseTask, targetTask, "Task branches have diverged; refusing to present a generic two-ref diff as ordered Build->Fix evidence. Compare individual task diffs instead.", {
      baseRef: base.ref,
      targetRef,
      baseSha: base.sha,
      targetSha: target.sha,
      mergeBaseSha,
    });
  }

  let diff: DiffResponse;
  if (target.kind === "ref") {
    diff = await computeDiffBetweenRefs(base.repoRoot, base.sha, target.sha, {
      contextLines: DIFF_CONTEXT_LINES,
      maxBytes: MAX_TOTAL_PATCH_BYTES,
    });
  } else {
    diff = await computeDiffAgainstWorkingTree(target.livePath, base.sha, {
      contextLines: DIFF_CONTEXT_LINES,
      maxBytes: MAX_TOTAL_PATCH_BYTES,
    });
  }

  if (diff.kind === "no-git") {
    return noGit(baseTask, targetTask, diff.reason, {
      baseRef: base.ref,
      targetRef,
      baseSha: base.sha,
      targetSha: target.sha,
      mergeBaseSha,
    });
  }

  return {
    kind: "diff",
    baseTaskId: baseTask.id,
    targetTaskId: targetTask.id,
    baseRef: base.ref,
    targetRef,
    comparisonMode: target.kind === "live" ? "live-target" : "ancestor",
    baseSha: base.sha,
    targetSha: target.sha,
    mergeBaseSha,
    files: diff.files,
    capped: diff.capped,
    root: diff.root,
  };
}
