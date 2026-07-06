/**
 * Base-checkout escape detector — the blocking backstop for worktree isolation.
 *
 * Phase 1's permission-responder fences OpenCode tool calls, but a bash command
 * that redirects output to an absolute path outside the worktree raises no
 * `external_directory` ask at all (see opencode-capabilities.md Phase 0 probe
 * B) and lands on disk unblocked. This module re-checks the BASE checkout's
 * `git status --porcelain` at completion/integrate time and compares it
 * against the snapshot captured at dispatch, so a base-checkout write that
 * slipped past the permission fence still gets caught before the card is
 * allowed to reach Review or be integrated.
 *
 * Uses the same execFile-based, no-shell, GIT_*-env-scrubbed pattern as
 * worktree.ts so paths/branch names with spaces are safe and inherited git
 * env vars can't redirect the command at the wrong repo.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const execFileAsync = promisify(execFile);

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  return env;
}

async function gitStatusPorcelain(cwd: string): Promise<string> {
  // `-z` (NUL-terminated records) is essential, not cosmetic: the default
  // porcelain format collapses an entire untracked directory to one `?? dir/`
  // line no matter how many files land inside it during the run, and it
  // double-quotes+C-escapes any path containing a space or other "unusual"
  // character (including the literal substring ` -> `), which makes rename
  // old/new paths ambiguous to split back out. `--untracked-files=all` makes
  // git enumerate every file inside a new untracked directory individually
  // instead of collapsing it, and `-z` disables quoting entirely and uses
  // NUL to separate the (up to two, for renames/copies) path fields.
  const { stdout } = await execFileAsync(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    {
      cwd,
      env: cleanGitEnv(),
      maxBuffer: 1024 * 1024 * 16,
    },
  );
  return stdout;
}

/**
 * Parse `git status --porcelain=v1 -z` output into the set of changed-entry
 * identities it mentions. Each record is NUL-terminated; a plain entry is
 * `XY PATH`, while a rename/copy entry is `XY NEWPATH` followed by a second
 * NUL-terminated record holding OLDPATH. The identity kept for diffing is the
 * two-character status code (`XY`) plus the (new) path — including the
 * status code matters because a path that was already dirty at dispatch
 * (e.g. a pre-existing rename, `R  old -> new`) and is then further modified
 * during the run (`RM old -> new`) must be treated as changed, not as an
 * unchanged repeat of the same path string.
 */
function parsePorcelainPaths(porcelain: string): Set<string> {
  const records = porcelain.split("\0");
  const paths = new Set<string>();

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record) continue;

    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (!path) continue;
    paths.add(`${status} ${path}`);

    // Rename/copy status codes consume the following NUL-terminated record
    // as the old path. It's not part of "what's new" (the new path already
    // captures that this entry changed), so it's consumed here only to
    // advance past it — not added to the identity set.
    if (status[0] === "R" || status[0] === "C") {
      i += 1;
    }
  }

  return paths;
}

/**
 * List the absolute paths of every *linked* git worktree registered against
 * `baseRepoDir` (via `git worktree list --porcelain`, the authoritative,
 * unspoofable source — unlike matching on a naming convention, a path can't
 * fake its way into this list without actually being a real linked worktree).
 * `git worktree list` also reports the main checkout itself as its first
 * entry with no distinguishing marker, so it's explicitly excluded here —
 * otherwise every changed path would resolve "inside" it and nothing would
 * ever be flagged. Empty array if the command fails (e.g. git too old)
 * rather than throwing.
 */
async function listActiveWorktrees(baseRepoDir: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
      cwd: baseRepoDir,
      env: cleanGitEnv(),
      maxBuffer: 1024 * 1024 * 16,
    });
    const mainWorktree = realOrResolved(baseRepoDir);
    return stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => realOrResolved(line.slice("worktree ".length).trim()))
      .filter((worktreePath) => worktreePath.length > 0 && worktreePath !== mainWorktree);
  } catch {
    return [];
  }
}

/** True if `absolutePath` is `worktreeDir` itself or falls inside it. */
function isInsideWorktree(absolutePath: string, worktreeDir: string): boolean {
  const rel = relative(worktreeDir, absolutePath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve symlinks so path comparisons are reliable (e.g. macOS's /tmp ->
 * /private/tmp: `git worktree list` reports the real path, so anything
 * compared against it must be real-pathed too, or every comparison silently
 * fails). Falls back to a plain resolve() if the path doesn't exist yet.
 */
function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export interface EscapeDetectionResult {
  escaped: boolean;
  changedPaths: string[];
}

/**
 * Capture the base checkout's `git status --porcelain` at dispatch time, for
 * later comparison by `detectBaseCheckoutEscape`. Returns null when the
 * directory isn't a git repo (or the command otherwise fails) rather than
 * throwing — dispatch shouldn't fail because a snapshot couldn't be taken.
 */
export async function snapshotBaseCheckout(baseRepoDir: string): Promise<string | null> {
  try {
    return await gitStatusPorcelain(baseRepoDir);
  } catch {
    return null;
  }
}

/**
 * Re-run `git status --porcelain` in `baseRepoDir` and compare against
 * `snapshotBefore` (the same command's output captured at dispatch time).
 * `escaped` is true iff a path appears in the current status that was not
 * present in the snapshot — a path that was already dirty at dispatch and
 * stays dirty in the same way is not an escape. `snapshotBefore` of `null`
 * (not yet captured, or the base repo wasn't inspectable) is treated as an
 * empty baseline, so a clean-to-escaped repo is still caught.
 *
 * `baseRepoDir` must be the actual git repo root, not merely a directory
 * inside it — see `TaskDispatcher.resolveRepoRoot()`. `git status`/
 * `git worktree list` both report root-relative paths and the repo root
 * itself regardless of invocation cwd, so a subdirectory passed here would
 * make the main-checkout exclusion below compare against the wrong
 * baseline and silently swallow every change.
 *
 * Accepted residual: a write that lands inside a *different, currently
 * registered* sibling worktree (e.g. one task's bash escape reaching into
 * another concurrent task's checkout) is excluded here by design, same as
 * a legitimate sibling worktree appearing mid-run — see the exclusion
 * below. This function genuinely can't see it either way: a linked
 * worktree is a nested repository boundary, so `git status` on the base
 * repo shows one unchanged collapsed line for it regardless of what
 * changes inside — that's true for both the writing task's check and the
 * victim task's own check, since both only ever inspect the *base* repo's
 * status, never a worktree's internal one. The only place this kind of
 * cross-card contamination becomes visible at all is the victim card's own
 * Review diff (a `git status`/diff run *inside* that worktree, a different
 * code path from this module) — deliberately out of scope here, since the
 * worktree registration itself already assigns ownership and a dedicated
 * cross-worktree write check would need to run against every other active
 * worktree on every check, not just the base repo.
 */
export async function detectBaseCheckoutEscape(
  baseRepoDir: string,
  snapshotBefore: string | null,
): Promise<EscapeDetectionResult> {
  const after = await gitStatusPorcelain(baseRepoDir);

  const beforePaths = parsePorcelainPaths(snapshotBefore ?? "");
  const afterPaths = parsePorcelainPaths(after);

  // Diff on the full "XY path" identity (see parsePorcelainPaths) so a status
  // change on an already-dirty path (e.g. R -> RM) counts as a change, but
  // report just the path portion back to callers/operators — the leading
  // status code is diffing-internal, not something a human triaging a
  // blocked task needs to see.
  const rawChangedPaths = [...afterPaths].filter((path) => !beforePaths.has(path)).map((entry) => entry.slice(3));

  // A sibling task's own worktree can legitimately appear mid-run when
  // worktrees nest inside the base repo (the isUnderWorkspace fallback
  // layout) — that's not a content escape, it's another card's checkout.
  // Exclude paths that fall inside a *currently registered* git worktree
  // (verified via `git worktree list`, not a naming-convention guess — a
  // path merely named like a worktree but not a real one is still caught).
  const activeWorktrees = await listActiveWorktrees(baseRepoDir);
  const realBaseRepoDir = realOrResolved(baseRepoDir);
  const changedPaths = rawChangedPaths
    .filter((path) => {
      const absolute = resolve(realBaseRepoDir, path);
      return !activeWorktrees.some((worktreeDir) => isInsideWorktree(absolute, worktreeDir));
    })
    .sort();

  return { escaped: changedPaths.length > 0, changedPaths };
}
