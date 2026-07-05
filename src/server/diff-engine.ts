/**
 * Diff engine — computes per-file diffs for Review cards.
 *
 * Supports three card types:
 *   - worktree cards: git diff base...board/<taskId> merge-base form.
 *   - in-place cards:  working-tree diff against Task.baseCommit, with
 *                      untracked files shown as added.
 *   - Claude Code cards: recorded harness worktree/branch/commit metadata,
 *                        with fallback to in-place diff when worktree metadata
 *                        is available.
 *
 * Output caps at ~2 MB total patch bytes; when exceeded the diff signals
 * `capped: true` and truncates safely (no partial hunks).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import type { DiffFile, DiffResponse, Task } from "../shared";

const execFileAsync = promisify(execFile);

const DIFF_CONTEXT_LINES = 12;
const MAX_TOTAL_PATCH_BYTES = 2 * 1024 * 1024; // 2 MB

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
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
      maxBuffer: 1024 * 1024 * 32,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

/**
 * Parse a unified diff string into per-file DiffFile[] entries.
 * Handles binary, rename, and mode-change edges gracefully —
 * missing patches become undefined on the DiffFile.
 */
function parseUnifiedDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  const chunks = splitByFile(raw);
  for (const chunk of chunks) {
    const file = parseFileChunk(chunk);
    if (file) files.push(file);
  }
  return files;
}

function splitByFile(raw: string): string[] {
  if (!raw.trim()) return [];
  const parts = raw.split(/(?=^diff --git )/m);
  return parts.filter((p) => p.trim());
}

function parseFileChunk(chunk: string): DiffFile | null {
  const headerMatch = chunk.match(/^diff --git a\/(.*?) b\/(.*?)$/m);
  if (!headerMatch) return null;
  const file = headerMatch[2] ?? headerMatch[1] ?? "";

  let status: DiffFile["status"] = "modified";
  if (/^new file mode/m.test(chunk)) status = "added";
  else if (/^deleted file mode/m.test(chunk)) status = "deleted";
  else if (/^similarity index/m.test(chunk) || /^rename (from|to)/m.test(chunk)) {
    status = "modified";
  }

  // Binary detection — no meaningful patch to serve.
  const isBinary =
    /^Binary files .* differ$/m.test(chunk) ||
    /^GIT binary patch$/m.test(chunk);

  let patch: string | undefined;
  if (isBinary) {
    patch = undefined;
  } else {
    // Strip the git header lines (everything before the first @@ hunk).
    const hunkStart = chunk.indexOf("@@");
    if (hunkStart > 0) {
      patch = `diff --git a/${file} b/${file}\n${chunk.slice(hunkStart)}`;
    }
  }

  // Count additions and deletions from the patch lines.
  let additions = 0;
  let deletions = 0;
  if (patch) {
    for (const line of patch.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
  } else if (isBinary) {
    // For binary files, the diff header says "Binary files differ" — treat as
    // modified with unknown change count.
    additions = 0;
    deletions = 0;
  }

  return { file, patch, additions, deletions, status };
}

/**
 * Create a synthetic /dev/null-style added-file patch for an untracked file.
 * Reads the file content and produces a unified diff header that shows every
 * line as added.
 */
async function untrackedFileDiff(
  cwd: string,
  filePath: string,
): Promise<DiffFile> {
  let content: string;
  try {
    content = await readFile(`${cwd}/${filePath}`, "utf-8");
  } catch {
    return {
      file: filePath,
      patch: `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,0 @@\n`,
      additions: 0,
      deletions: 0,
      status: "added",
    };
  }
  const lines = content.split("\n");
  // Remove trailing empty line from split (files usually end with newline).
  const effectiveLines =
    lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;

  const hunkLines: string[] = [];
  for (const line of effectiveLines) {
    hunkLines.push(`+${line}`);
  }
  const additions = effectiveLines.length;
  const hunkHeader = `@@ -0,0 +1,${additions} @@`;
  const patch = [
    `diff --git a/${filePath} b/${filePath}`,
    `new file mode 100644`,
    `--- /dev/null`,
    `+++ b/${filePath}`,
    hunkHeader,
    ...hunkLines,
  ].join("\n");

  return {
    file: filePath,
    patch,
    additions,
    deletions: 0,
    status: "added",
  };
}

/**
 * Cap the total patch bytes across all diff files to approx `maxBytes`.
 * Truncates files from the end of the list until total bytes fit under the
 * limit. Files with truncated patches keep their stats but lose the patch
 * string; files that fit keep their patch intact. Sets `capped` on the
 * response when any truncation occurred.
 */
function capBytes(files: DiffFile[], maxBytes: number): { files: DiffFile[]; capped: boolean } {
  let totalBytes = 0;
  const kept: DiffFile[] = [];
  let capped = false;

  for (const f of files) {
    const patchBytes = f.patch ? Buffer.byteLength(f.patch, "utf-8") : 0;
    if (totalBytes + patchBytes <= maxBytes) {
      kept.push(f);
      totalBytes += patchBytes;
    } else {
      // Drop the patch but keep the file metadata + stats.
      kept.push({ ...f, patch: undefined });
      capped = true;
      // Stop adding patches once we hit the cap — everything after is
      // metadata-only.
      for (const remaining of files.slice(kept.length)) {
        kept.push({ ...remaining, patch: undefined });
      }
      break;
    }
  }
  return { files: kept, capped };
}

/**
 * Compute the diff for a Review-card task. Returns a DiffResponse:
 *  - `{ kind: "diff", files, capped }` with file-level patches when git
 *    evidence is available.
 *  - `{ kind: "no-git", reason }` when no git evidence can be produced
 *    (non-git dir, missing baseCommit, deleted branch, etc.).
 */
export async function computeDiff(task: Task): Promise<DiffResponse> {
  // --- Worktree cards ---
  if (task.worktreePath && task.worktreeBranch) {
    // Compare the live task worktree against the recorded base. Review cards
    // usually contain uncommitted edits; integration creates the task commit
    // later, so a branch-to-branch diff would hide the changes users need to
    // review.
    const baseRef = task.baseCommit ?? task.baseBranch;
    if (!baseRef) {
      return { kind: "no-git", reason: "No base reference recorded for this worktree task" };
    }
    const result = await git(task.worktreePath, [
      "diff",
      `--unified=${DIFF_CONTEXT_LINES}`,
      baseRef,
    ]);
    if (result.code !== 0) {
      return {
        kind: "no-git",
        reason: `Worktree diff failed: ${result.stderr || result.stdout}`.trim(),
      };
    }
    let files = parseUnifiedDiff(result.stdout);
    const untrackedResult = await git(task.worktreePath, [
      "ls-files",
      "--others",
      "--exclude-standard",
    ]);
    if (untrackedResult.code === 0) {
      const untrackedPaths = untrackedResult.stdout
        .split("\n")
        .map((p) => p.trim())
        .filter(Boolean);
      for (const path of untrackedPaths) {
        const df = await untrackedFileDiff(task.worktreePath, path);
        files.push(df);
      }
    }
    if (files.length === 0) {
      return { kind: "diff", files: [], capped: false };
    }
    const capped = capBytes(files, MAX_TOTAL_PATCH_BYTES);
    return { kind: "diff", files: capped.files, capped: capped.capped };
  }

  // --- Claude Code cards with harness worktree metadata ---
  if (task.harness === "claude-code" && task.harnessCwd) {
    const worktreeRef = task.harnessBranch ?? task.harnessCommit;
    if (worktreeRef) {
      const ref = task.baseCommit ?? "HEAD";
      // Diff the harness worktree against the recorded baseline.
      const result = await git(task.harnessCwd, [
        "diff",
        `--unified=${DIFF_CONTEXT_LINES}`,
        `${ref}...${worktreeRef}`,
      ]);
      if (result.code === 0) {
        let files = parseUnifiedDiff(result.stdout);
        if (files.length > 0) {
          const capped = capBytes(files, MAX_TOTAL_PATCH_BYTES);
          return { kind: "diff", files: capped.files, capped: capped.capped };
        }
      }
    }
    // Fall through to in-place diff attempt.
  }

  // --- In-place cards ---
  if (task.baseCommit) {
    // Run working-tree diff against the recorded base commit, including
    // unstaged changes.
    const diffResult = await git(task.directory, [
      "diff",
      `--unified=${DIFF_CONTEXT_LINES}`,
      task.baseCommit,
    ]);
    // Non-zero exit is ok (it can mean there are diffs — git diff exits
    // with 1 when there are differences). Only fail on real errors (code 128).
    if (diffResult.code >= 128) {
      return {
        kind: "no-git",
        reason: `In-place diff failed: ${diffResult.stderr || diffResult.stdout}`.trim(),
      };
    }

    let files = parseUnifiedDiff(diffResult.stdout);

    // Include untracked files as added.
    if (!task.dirtyAtDispatch) {
      // Only include untracked when the working tree was clean at dispatch —
      // otherwise the diff baseline is already fuzzy.
      const untrackedResult = await git(task.directory, [
        "ls-files",
        "--others",
        "--exclude-standard",
      ]);
      if (untrackedResult.code === 0) {
        const untrackedPaths = untrackedResult.stdout
          .split("\n")
          .map((p) => p.trim())
          .filter(Boolean);
        for (const path of untrackedPaths) {
          const df = await untrackedFileDiff(task.directory, path);
          files.push(df);
        }
      }
    }

    if (files.length === 0) {
      return { kind: "diff", files: [], capped: false };
    }
    const capped = capBytes(files, MAX_TOTAL_PATCH_BYTES);
    return { kind: "diff", files: capped.files, capped: capped.capped };
  }

  // --- No git evidence ---
  return {
    kind: "no-git",
    reason: "No git evidence available for this task." +
      (task.harness === "claude-code"
        ? " Claude Code harness metadata was not recorded at dispatch."
        : " This card was dispatched without a base commit."),
  };
}
