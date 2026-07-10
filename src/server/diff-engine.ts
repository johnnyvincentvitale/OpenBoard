/**
 * Diff engine — computes per-file diffs for Review and Done cards.
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
import { realpathSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { DiffFile, DiffResponse, Task } from "../shared";

const execFileAsync = promisify(execFile);

export const DIFF_CONTEXT_LINES = 12;
export const MAX_TOTAL_PATCH_BYTES = 2 * 1024 * 1024; // 2 MB
/** Maximum bytes of stdout/stderr the child git process may emit before
 * Node.js kills it with ERR_CHILD_PROCESS_STDIO_MAXBUFFER. Set generously
 * (32 MB) so genuine diffs are not truncated, but small enough to prevent
 * a runaway diff from consuming unbounded memory. When exceeded, callers
 * must return an honest no-git result rather than parsing truncated output. */
export const MAX_GIT_BUFFER_BYTES = 1024 * 1024 * 32;
// Per-file guard for untracked files, applied before any content is read
// into memory. Keeps a single huge or binary untracked file from spiking
// memory or producing a garbage text patch ahead of the total byte cap.
const MAX_UNTRACKED_FILE_BYTES = 1 * 1024 * 1024; // 1 MB
// Bytes sniffed from the head of an untracked file to detect binary content
// (mirrors git's own NUL-byte heuristic).
const BINARY_SNIFF_BYTES = 8000;

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  /** True when the git process was killed because its output exceeded the
   * maxBuffer. When set, `stdout` is truncated and MUST NOT be parsed as
   * a successful diff. Callers should return an honest no-git result. */
  maxBufferExceeded?: boolean;
}

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  return env;
}

async function git(cwd: string, args: string[], maxBuffer?: number): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      env: cleanGitEnv(),
      maxBuffer: maxBuffer ?? MAX_GIT_BUFFER_BYTES,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    const isMaxBuffer = e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
    return {
      // Treat maxBuffer overflow as a real error (code 128+) so all callers
      // that check code >= 128 or code !== 0 will return no-git consistently.
      code: isMaxBuffer ? 128 : (typeof e.code === "number" ? e.code : 1),
      stdout: e.stdout ?? "",
      stderr: e.stderr ??
        (isMaxBuffer ? "git output exceeded maxBuffer; output truncated" : ""),
      maxBufferExceeded: isMaxBuffer,
    };
  }
}

/** Shared low-level git runner used by comparison and diff engines. */
export async function execGit(cwd: string, args: string[]): Promise<GitResult> {
  return git(cwd, args);
}

/**
 * Non-throwing check for refs that start with `-`. A dash-prefixed ref (e.g.
 * `--output=/etc/passwd`) could be interpreted as a git option rather than a
 * positional ref argument. This is a defense-in-depth guard; ref validity and
 * same-repo safety are still enforced by the callers' existing checks.
 */
export function isSafeRef(ref: string): boolean {
  return !ref.startsWith("-");
}

/**
 * Throws an Error when the ref is dash-prefixed. Kept for callers (and unit
 * tests) that want a throwing primitive; every public diff/compare entry
 * point in this file uses the non-throwing `unsafeRefNoGit` boundary guard
 * below instead, so a dash-prefixed stored ref becomes an honest no-git
 * result rather than a rejected promise that routes/MCP would surface as an
 * internal error.
 */
export function assertSafeRef(ref: string): void {
  if (!isSafeRef(ref)) {
    throw new Error(`Refuses dash-prefixed ref for git argv safety: "${ref}"`);
  }
}

/**
 * Boundary guard used by every public diff entry point before its first git
 * invocation for a caller-supplied ref. Returns a no-git DiffResponse when
 * the ref is unsafe, otherwise null.
 */
function unsafeRefNoGit(ref: string): DiffResponse | null {
  if (isSafeRef(ref)) return null;
  return {
    kind: "no-git",
    reason: `Refuses dash-prefixed ref for git argv safety: "${ref}"`,
  };
}

/**
 * Compute a diff between two arbitrary git refs from the same repo.
 * Returns the same DiffResponse shape as computeDiff so callers can
 * treat branch-to-branch, worktree-to-branch, and working-tree diffs uniformly.
 */
export async function computeDiffBetweenRefs(
  cwd: string,
  leftRef: string,
  rightRef: string,
  options: { contextLines?: number; maxBytes?: number; gitMaxBuffer?: number } = {},
): Promise<DiffResponse> {
  const contextLines = options.contextLines ?? DIFF_CONTEXT_LINES;
  const leftRefGuard = unsafeRefNoGit(leftRef);
  if (leftRefGuard) return leftRefGuard;
  const rightRefGuard = unsafeRefNoGit(rightRef);
  if (rightRefGuard) return rightRefGuard;
  const result = await git(cwd, ["diff", `--unified=${contextLines}`, leftRef, rightRef, "--"], options.gitMaxBuffer);
  if (result.maxBufferExceeded) {
    return {
      kind: "no-git",
      reason: "Diff output exceeded the git maxBuffer (32MB); result truncated for safety",
    };
  }
  if (result.code !== 0) {
    return {
      kind: "no-git",
      reason: `Diff between refs failed: ${(result.stderr || result.stdout).trim() || "unknown git error"}`,
    };
  }
  const files = parseUnifiedDiff(result.stdout);
  const maxBytes = options.maxBytes ?? MAX_TOTAL_PATCH_BYTES;
  const capped = capBytes(files, maxBytes);
  return { kind: "diff", files: capped.files, capped: capped.capped };
}

/**
 * Resolve the absolute filesystem root of the git repository containing `cwd`.
 */
export async function resolveGitRepoRoot(cwd: string): Promise<string | null> {
  const result = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.code !== 0 || !result.stdout.trim()) return null;
  return realpathSync(result.stdout.trim());
}

/**
 * Resolve the absolute path to the shared git directory for the repository
 * containing `cwd`. Worktrees of the same repo share a git-common-dir, making
 * this the canonical identity for same-repo checks. The result is symlink-
 * resolved so worktree paths on macOS (/var -> /private/var) compare cleanly.
 */
export async function resolveGitCommonDir(cwd: string): Promise<string | null> {
  const result = await git(cwd, ["rev-parse", "--git-common-dir"]);
  if (result.code !== 0 || !result.stdout.trim()) return null;
  const common = result.stdout.trim();
  const resolved = isAbsolute(common) ? common : resolve(cwd, common);
  return realpathSync(resolved);
}

/**
 * Compute the diff from a durable base ref to a live working tree directory.
 * Includes tracked changes and untracked files, with the same binary/large
 * guards and byte cap as computeDiff. Used by task-compare when the target
 * card has a live worktree and the base card has a durable output ref.
 */
export async function computeDiffAgainstWorkingTree(
  cwd: string,
  baseRef: string,
  options: { contextLines?: number; maxBytes?: number; gitMaxBuffer?: number } = {},
): Promise<DiffResponse> {
  const contextLines = options.contextLines ?? DIFF_CONTEXT_LINES;
  const maxBytes = options.maxBytes ?? MAX_TOTAL_PATCH_BYTES;

  const baseRefGuard = unsafeRefNoGit(baseRef);
  if (baseRefGuard) return baseRefGuard;
  const diffResult = await git(cwd, ["diff", `--unified=${contextLines}`, baseRef, "--"], options.gitMaxBuffer);
  // git diff exits 1 when there are differences and 0 when there are none;
  // codes >= 128 are real errors. maxBuffer overflow is also a real error.
  if (diffResult.maxBufferExceeded) {
    return {
      kind: "no-git",
      reason: "Working-tree diff output exceeded the git maxBuffer (32MB); result truncated for safety",
    };
  }
  if (diffResult.code >= 128) {
    return {
      kind: "no-git",
      reason: `Working-tree diff failed: ${(diffResult.stderr || diffResult.stdout).trim() || "unknown git error"}`,
    };
  }

  let files = parseUnifiedDiff(diffResult.stdout);
  let forcedCapped = false;

  const untrackedResult = await git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  if (untrackedResult.code === 0) {
    const untrackedPaths = untrackedResult.stdout
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean);
    for (const path of untrackedPaths) {
      const { file: df, forcedCap } = await untrackedFileDiff(cwd, path);
      files.push(df);
      if (forcedCap) forcedCapped = true;
    }
  }

  if (files.length === 0) {
    return { kind: "diff", files: [], capped: false, root: cwd };
  }

  const capped = capBytes(files, maxBytes);
  return { kind: "diff", files: capped.files, capped: capped.capped || forcedCapped, root: cwd };
}

/**
 * Parse a unified diff string into per-file DiffFile[] entries.
 * Handles binary, rename, and mode-change edges gracefully —
 * missing patches become undefined on the DiffFile.
 */
export function parseUnifiedDiff(raw: string): DiffFile[] {
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

interface UntrackedDiffResult {
  file: DiffFile;
  /** True when the file was too large to safely diff — the response-level
   * `capped` flag must reflect this even when the total byte cap wasn't hit. */
  forcedCap: boolean;
}

function untrackedMetadataOnly(filePath: string): DiffFile {
  return { file: filePath, patch: undefined, additions: 0, deletions: 0, status: "added" };
}

/** Sniff the head of a file for NUL bytes to detect binary content, without
 * reading the whole file into memory. */
async function looksBinary(fullPath: string): Promise<boolean> {
  const fd = await open(fullPath, "r");
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await fd.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await fd.close();
  }
}

/**
 * Create a synthetic /dev/null-style added-file patch for an untracked file.
 * Reads the file content and produces a unified diff header that shows every
 * line as added — unless the file is oversized or binary, in which case a
 * metadata-only DiffFile (no patch) is returned so we never read a huge or
 * binary file fully into memory just to discard it.
 */
async function untrackedFileDiff(
  cwd: string,
  filePath: string,
): Promise<UntrackedDiffResult> {
  const fullPath = `${cwd}/${filePath}`;

  let size: number;
  try {
    size = (await stat(fullPath)).size;
  } catch {
    return { file: untrackedMetadataOnly(filePath), forcedCap: false };
  }

  if (size > MAX_UNTRACKED_FILE_BYTES) {
    return { file: untrackedMetadataOnly(filePath), forcedCap: true };
  }

  if (await looksBinary(fullPath)) {
    return { file: untrackedMetadataOnly(filePath), forcedCap: false };
  }

  let content: string;
  try {
    content = await readFile(fullPath, "utf-8");
  } catch {
    return { file: untrackedMetadataOnly(filePath), forcedCap: false };
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
    file: { file: filePath, patch, additions, deletions: 0, status: "added" },
    forcedCap: false,
  };
}

/**
 * Cap the total patch bytes across all diff files to approx `maxBytes`.
 * Truncates files from the end of the list until total bytes fit under the
 * limit. Files with truncated patches keep their stats but lose the patch
 * string; files that fit keep their patch intact. Sets `capped` on the
 * response when any truncation occurred.
 */
export function capBytes(files: DiffFile[], maxBytes: number): { files: DiffFile[]; capped: boolean } {
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
 * Compute the diff for a Review- or Done-card task. Returns a DiffResponse:
 *  - `{ kind: "diff", files, capped, root? }` with file-level patches when
 *    git evidence is available. For a live tree, `root` is the absolute path
 *    the diff was computed against so callers can resolve `files[].file`.
 *    It is omitted when a Done card is diffed from a retained branch whose
 *    worktree has already been removed.
 *  - `{ kind: "no-git", reason }` when no git evidence can be produced
 *    (non-git dir, missing baseCommit, deleted branch, etc.).
 */
export async function computeDiff(task: Task): Promise<DiffResponse> {
  // --- Worktree cards ---
  if (task.worktreePath && task.worktreeBranch) {
    // Compare the live task worktree against the recorded base. Review cards,
    // and Done cards accepted without integration, may contain uncommitted
    // edits; integration creates the task commit later, so a branch-to-branch
    // diff would hide the changes users need to inspect.
    const baseRef = task.baseCommit ?? task.baseBranch;
    if (!baseRef) {
      return { kind: "no-git", reason: "No base reference recorded for this worktree task" };
    }
    const baseRefGuard = unsafeRefNoGit(baseRef);
    if (baseRefGuard) return baseRefGuard;
    const result = await git(task.worktreePath, [
      "diff",
      `--unified=${DIFF_CONTEXT_LINES}`,
      baseRef,
      "--",
    ]);
    if (result.maxBufferExceeded) {
      return { kind: "no-git", reason: "Worktree diff output exceeded the git maxBuffer (32MB); result truncated for safety" };
    }
    if (result.code !== 0) {
      return {
        kind: "no-git",
        reason: `Worktree diff failed: ${result.stderr || result.stdout}`.trim(),
      };
    }
    let files = parseUnifiedDiff(result.stdout);
    let forcedCapped = false;
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
        const { file: df, forcedCap } = await untrackedFileDiff(task.worktreePath, path);
        files.push(df);
        if (forcedCap) forcedCapped = true;
      }
    }
    if (files.length === 0) {
      return { kind: "diff", files: [], capped: false, root: task.worktreePath };
    }
    const capped = capBytes(files, MAX_TOTAL_PATCH_BYTES);
    return {
      kind: "diff",
      files: capped.files,
      capped: capped.capped || forcedCapped,
      root: task.worktreePath,
    };
  }

  // --- Done worktree cards after checkout cleanup ---
  // Integrate removes the worktree but deliberately keeps the task branch.
  // Diff that frozen branch rather than the current base checkout, which may
  // have accumulated unrelated later integrations. There is no live checkout
  // whose files match this branch snapshot, so omit `root` intentionally.
  if (task.column === "done" && task.worktreeBranch) {
    const baseRef = task.baseCommit ?? task.baseBranch;
    if (!baseRef) {
      return { kind: "no-git", reason: "No base reference recorded for this completed worktree task" };
    }
    const baseRefGuard = unsafeRefNoGit(baseRef);
    if (baseRefGuard) return baseRefGuard;
    const worktreeBranchGuard = unsafeRefNoGit(task.worktreeBranch);
    if (worktreeBranchGuard) return worktreeBranchGuard;
    const result = await git(task.directory, [
      "diff",
      `--unified=${DIFF_CONTEXT_LINES}`,
      baseRef,
      task.worktreeBranch,
      "--",
    ]);
    if (result.maxBufferExceeded) {
      return { kind: "no-git", reason: "Completed branch diff output exceeded the git maxBuffer (32MB); result truncated for safety" };
    }
    if (result.code !== 0) {
      return {
        kind: "no-git",
        reason: `Completed branch diff failed: ${result.stderr || result.stdout}`.trim(),
      };
    }
    const files = parseUnifiedDiff(result.stdout);
    const capped = capBytes(files, MAX_TOTAL_PATCH_BYTES);
    return { kind: "diff", files: capped.files, capped: capped.capped };
  }

  // --- ACP harness cards with harness worktree metadata ---
  if (isAcpHarness(task) && task.harnessCwd) {
    const worktreeRef = task.harnessBranch ?? task.harnessCommit;
    if (worktreeRef) {
      const ref = task.baseCommit ?? "HEAD";
      const refGuard = unsafeRefNoGit(ref);
      if (refGuard) return refGuard;
      const worktreeRefGuard = unsafeRefNoGit(worktreeRef);
      if (worktreeRefGuard) return worktreeRefGuard;
      // Diff the harness worktree against the recorded baseline.
      const result = await git(task.harnessCwd, [
        "diff",
        `--unified=${DIFF_CONTEXT_LINES}`,
        `${ref}...${worktreeRef}`,
        "--",
      ]);
      if (result.maxBufferExceeded) {
        return { kind: "no-git", reason: "ACP harness diff output exceeded the git maxBuffer (32MB); result truncated for safety" };
      }
      if (result.code === 0) {
        let files = parseUnifiedDiff(result.stdout);
        if (files.length > 0) {
          const capped = capBytes(files, MAX_TOTAL_PATCH_BYTES);
          return { kind: "diff", files: capped.files, capped: capped.capped, root: task.harnessCwd };
        }
      }
    }
    // Fall through to in-place diff attempt.
  }

  // --- In-place cards ---
  if (task.baseCommit) {
    const baseCommitGuard = unsafeRefNoGit(task.baseCommit);
    if (baseCommitGuard) return baseCommitGuard;
    // Run working-tree diff against the recorded base commit, including
    // unstaged changes.
    const diffResult = await git(task.directory, [
      "diff",
      `--unified=${DIFF_CONTEXT_LINES}`,
      task.baseCommit,
      "--",
    ]);
    // Non-zero exit is ok (it can mean there are diffs — git diff exits
    // with 1 when there are differences). Only fail on real errors (code 128).
    // maxBuffer overflow is also a real error — never parse truncated stdout.
    if (diffResult.maxBufferExceeded) {
      return {
        kind: "no-git",
        reason: "In-place diff output exceeded the git maxBuffer (32MB); result truncated for safety",
      };
    }
    if (diffResult.code >= 128) {
      return {
        kind: "no-git",
        reason: `In-place diff failed: ${diffResult.stderr || diffResult.stdout}`.trim(),
      };
    }

    let files = parseUnifiedDiff(diffResult.stdout);
    let forcedCapped = false;

    // Include untracked files as added, regardless of dirtyAtDispatch — the
    // in-place lane always shows the total working-tree diff against
    // baseCommit; dirtyAtDispatch only drives the TUI's honesty label, it
    // does not filter the diff content.
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
        const { file: df, forcedCap } = await untrackedFileDiff(task.directory, path);
        files.push(df);
        if (forcedCap) forcedCapped = true;
      }
    }

    if (files.length === 0) {
      return { kind: "diff", files: [], capped: false, root: task.directory };
    }
    const capped = capBytes(files, MAX_TOTAL_PATCH_BYTES);
    return {
      kind: "diff",
      files: capped.files,
      capped: capped.capped || forcedCapped,
      root: task.directory,
    };
  }

  // --- No git evidence ---
  return {
    kind: "no-git",
    reason: "No git evidence available for this task." +
      (isAcpHarness(task)
        ? " ACP harness metadata was not recorded at dispatch."
        : " This card was dispatched without a base commit."),
  };
}

function isAcpHarness(task: Pick<Task, "harness">): boolean {
  return task.harness !== undefined && task.harness !== "opencode";
}
