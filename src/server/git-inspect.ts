import { execFile } from "node:child_process";
import { isAbsolute, normalize, resolve } from "node:path";
import { promisify } from "node:util";
import type { CompletionReport, Task, TaskCompletionLocation } from "../shared";

const execFileAsync = promisify(execFile);

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitInspection {
  isRepo: boolean;
  root?: string;
  branch?: string;
  commit?: string;
  dirtySummary?: string;
}

export interface CompletionInspection {
  completionLocation: TaskCompletionLocation;
  harnessCwd?: string;
  harnessBranch?: string;
  harnessCommit?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  baseBranch?: string;
}

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  return env;
}

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

function safeRelativePath(file: string): string | undefined {
  const normalized = normalize(file.trim());
  if (!normalized || normalized === "." || isAbsolute(normalized) || normalized.startsWith("..")) {
    return undefined;
  }
  return normalized;
}

export async function inspectGitDirectory(cwd: string): Promise<GitInspection> {
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") return { isRepo: false };

  const [root, branch, commit, status] = await Promise.all([
    git(cwd, ["rev-parse", "--show-toplevel"]),
    git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(cwd, ["rev-parse", "--short", "HEAD"]),
    git(cwd, ["status", "--short"]),
  ]);

  return {
    isRepo: true,
    ...(root.code === 0 ? { root: root.stdout.trim() } : {}),
    ...(branch.code === 0 ? { branch: branch.stdout.trim() } : {}),
    ...(commit.code === 0 ? { commit: commit.stdout.trim() } : {}),
    ...(status.code === 0 && status.stdout.trim() ? { dirtySummary: status.stdout.trim() } : {}),
  };
}

export async function dirtyWarning(cwd: string): Promise<string | undefined> {
  const info = await inspectGitDirectory(cwd);
  if (!info.isRepo || !info.dirtySummary) return undefined;
  const count = info.dirtySummary.split("\n").filter(Boolean).length;
  return `Warning: target working tree has ${count} uncommitted path${count === 1 ? "" : "s"}. Claude Code may isolate edits in its own worktree. Please commit before using Claude agents in this repo.`;
}

async function fileDiffersInGit(cwd: string, file: string, baseBranch?: string): Promise<boolean> {
  const safe = safeRelativePath(file);
  if (!safe) return false;

  const status = await git(cwd, ["status", "--porcelain", "--", safe]);
  if (status.code === 0 && status.stdout.trim()) return true;

  if (baseBranch) {
    const diff = await git(cwd, ["diff", "--quiet", baseBranch, "--", safe]);
    if (diff.code === 1) return true;
  }

  return false;
}

export async function inspectCompletionResult(
  task: Task,
  report: CompletionReport,
): Promise<CompletionInspection> {
  if (report.changedFiles.length === 0) {
    return { completionLocation: "none" };
  }

  const taskInfo = await inspectGitDirectory(task.directory);
  const harnessCwd =
    task.harnessCwd && resolve(task.harnessCwd) !== resolve(task.directory)
      ? task.harnessCwd
      : undefined;
  const harnessInfo = harnessCwd ? await inspectGitDirectory(harnessCwd) : undefined;
  const baseBranch = task.baseBranch ?? taskInfo.branch;

  let inTaskDirectory = false;
  let inHarnessDirectory = false;

  for (const file of report.changedFiles) {
    if (await fileDiffersInGit(task.directory, file, baseBranch)) {
      inTaskDirectory = true;
    }
    if (harnessCwd && (await fileDiffersInGit(harnessCwd, file, baseBranch))) {
      inHarnessDirectory = true;
    }
  }

  let completionLocation: TaskCompletionLocation = "missing";
  if (inTaskDirectory && inHarnessDirectory) completionLocation = "mixed";
  else if (inTaskDirectory) completionLocation = "task-directory";
  else if (inHarnessDirectory) completionLocation = "harness-directory";

  const result: CompletionInspection = {
    completionLocation,
    ...(harnessCwd ? { harnessCwd } : {}),
    ...(harnessInfo?.branch ? { harnessBranch: harnessInfo.branch } : {}),
    ...(harnessInfo?.commit ? { harnessCommit: harnessInfo.commit } : {}),
  };

  if (harnessCwd && harnessInfo?.isRepo && harnessInfo.branch) {
    result.worktreePath = harnessCwd;
    result.worktreeBranch = harnessInfo.branch;
    if (baseBranch) result.baseBranch = baseBranch;
  }

  return result;
}
