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
  const changedPaths = [...afterPaths]
    .filter((path) => !beforePaths.has(path))
    .map((entry) => entry.slice(3))
    .sort();

  return { escaped: changedPaths.length > 0, changedPaths };
}
