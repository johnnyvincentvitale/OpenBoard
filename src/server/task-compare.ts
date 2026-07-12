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

  const tip = await execGit(cwd, ["rev-parse", "--verify", ref]);
  const tipSha = tip.code === 0 ? tip.stdout.trim() : "";
  if (!tipSha) {
    return { kind: "unsupported", reason: `Task ${task.id} durable ref ${ref} is not available` };
  }

  // A Review card's work usually sits UNCOMMITTED in its live worktree until
  // Integrate — its branch tip is still the fork commit. Diffing against
  // that tip would silently present the base's entire output as absent
  // (a confident wrong answer), so refuse honestly when the worktree holds
  // uncommitted changes the tip doesn't contain. A branch with commits
  // beyond the fork point, or a genuinely clean worktree at the fork
  // (the card produced no output), remains a truthful durable base.
  if (task.worktreePath && ref === task.worktreeBranch && task.baseCommit && tipSha === task.baseCommit) {
    const status = await execGit(task.worktreePath, ["status", "--porcelain"]);
    if (status.code === 0 && status.stdout.trim().length > 0) {
      return {
        kind: "unsupported",
        reason: `Task ${task.id}'s output is still uncommitted in its live worktree (branch ${ref} has no commits beyond its fork point) — integrate the task or commit its work before comparing against it`,
      };
    }
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
