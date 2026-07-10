/**
 * Task evidence comparison — read-only Git delta from base task output to
 * target task output.
 *
 * Used by GET /api/tasks/:targetId/compare?baseTaskId=:baseTaskId.
 *
 * The comparison produces ONE real Git diff between durable sources:
 *   - base task is required to have a durable branch/commit snapshot
 *     (worktreeBranch / harnessBranch / harnessCommit). Live-only base
 *     output is unsupported.
 *   - target task prefers a durable ref; otherwise a live worktree is accepted
 *     when the base has a durable ref, computing baseRef -> target working tree.
 *   - base and target must belong to the same git repository.
 *
 * The response mirrors DiffResponse with added task/source metadata.
 */
import type { DiffFile, DiffResponse, Task, TaskCompareResponse } from "../shared";
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
};

type ResolvedLiveSource = {
  kind: "live";
  repoRoot: string;
  gitCommonDir: string;
  livePath: string;
};

type ResolvedSource = ResolvedRefSource | ResolvedLiveSource;

type UnsupportedReason = { kind: "unsupported"; reason: string };

function getWorkingDirectory(task: Task): string | undefined {
  return task.worktreePath ?? task.harnessCwd ?? task.directory;
}

async function isValidRef(cwd: string, ref: string): Promise<boolean> {
  const result = await execGit(cwd, ["rev-parse", "--verify", ref]);
  return result.code === 0 && result.stdout.trim().length > 0;
}

async function resolveRepoIdentity(cwd: string): Promise<{ repoRoot: string; gitCommonDir: string } | null> {
  const [rootResult, commonResult] = await Promise.all([
    resolveGitRepoRoot(cwd),
    resolveGitCommonDir(cwd),
  ]);
  if (!rootResult || !commonResult) return null;
  return { repoRoot: rootResult, gitCommonDir: commonResult };
}

async function resolveBaseSource(task: Task): Promise<ResolvedRefSource | UnsupportedReason> {
  const cwd = getWorkingDirectory(task);
  if (!cwd) {
    return { kind: "unsupported", reason: `Task ${task.id} has no associated directory` };
  }

  const identity = await resolveRepoIdentity(cwd);
  if (!identity) {
    return { kind: "unsupported", reason: `Task ${task.id} directory is not a git repository` };
  }

  const ref = task.worktreeBranch ?? task.harnessBranch ?? task.harnessCommit;
  if (!ref) {
    return { kind: "unsupported", reason: `Task ${task.id} has no durable branch or commit snapshot` };
  }

  // Validate ref safety before any git invocation, including rev-parse —
  // a dash-prefixed stored ref must never reach git argv.
  if (!isSafeRef(ref)) {
    return { kind: "unsupported", reason: `Task ${task.id} durable ref is unsafe and was rejected before git invocation` };
  }

  if (!(await isValidRef(cwd, ref))) {
    return { kind: "unsupported", reason: `Task ${task.id} durable ref ${ref} is not available` };
  }

  return { kind: "ref", repoRoot: identity.repoRoot, gitCommonDir: identity.gitCommonDir, ref };
}

async function resolveTargetSource(task: Task): Promise<ResolvedSource | UnsupportedReason> {
  const cwd = getWorkingDirectory(task);
  if (!cwd) {
    return { kind: "unsupported", reason: `Task ${task.id} has no associated directory` };
  }

  const identity = await resolveRepoIdentity(cwd);
  if (!identity) {
    return { kind: "unsupported", reason: `Task ${task.id} directory is not a git repository` };
  }

  const livePath = task.worktreePath ?? task.harnessCwd;
  if (livePath) {
    return { kind: "live", repoRoot: identity.repoRoot, gitCommonDir: identity.gitCommonDir, livePath };
  }

  const ref = task.worktreeBranch ?? task.harnessBranch ?? task.harnessCommit;
  if (ref && isSafeRef(ref) && (await isValidRef(cwd, ref))) {
    return { kind: "ref", repoRoot: identity.repoRoot, gitCommonDir: identity.gitCommonDir, ref };
  }

  return { kind: "unsupported", reason: `Task ${task.id} has no durable ref or live worktree` };
}

/**
 * Compare two cards' durable code evidence, producing a single Git delta from
 * the base task's output to the target task's output.
 *
 * No mutation, checkout, or transcript access is performed.
 */
export async function compareTaskEvidence(
  baseTask: Task,
  targetTask: Task,
): Promise<TaskCompareResponse> {
  const base = await resolveBaseSource(baseTask);
  if (base.kind === "unsupported") {
    return {
      kind: "no-git",
      baseTaskId: baseTask.id,
      targetTaskId: targetTask.id,
      baseRef: null,
      targetRef: null,
      reason: base.reason,
    };
  }

  const target = await resolveTargetSource(targetTask);
  if (target.kind === "unsupported") {
    return {
      kind: "no-git",
      baseTaskId: baseTask.id,
      targetTaskId: targetTask.id,
      baseRef: base.ref,
      targetRef: null,
      reason: target.reason,
    };
  }

  if (base.gitCommonDir !== target.gitCommonDir) {
    return {
      kind: "no-git",
      baseTaskId: baseTask.id,
      targetTaskId: targetTask.id,
      baseRef: base.ref,
      targetRef: target.kind === "ref" ? target.ref : null,
      reason: "Tasks are not in the same git repository",
    };
  }

  let diff: DiffResponse;
  if (target.kind === "ref") {
    diff = await computeDiffBetweenRefs(base.repoRoot, base.ref, target.ref, {
      contextLines: DIFF_CONTEXT_LINES,
      maxBytes: MAX_TOTAL_PATCH_BYTES,
    });
  } else {
    diff = await computeDiffAgainstWorkingTree(target.livePath, base.ref, {
      contextLines: DIFF_CONTEXT_LINES,
      maxBytes: MAX_TOTAL_PATCH_BYTES,
    });
  }

  if (diff.kind === "no-git") {
    return {
      kind: "no-git",
      baseTaskId: baseTask.id,
      targetTaskId: targetTask.id,
      baseRef: base.ref,
      targetRef: target.kind === "ref" ? target.ref : null,
      reason: diff.reason,
    };
  }

  return {
    kind: "diff",
    baseTaskId: baseTask.id,
    targetTaskId: targetTask.id,
    baseRef: base.ref,
    targetRef: target.kind === "ref" ? target.ref : null,
    files: diff.files,
    capped: diff.capped,
    root: diff.root,
  };
}
