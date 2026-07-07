import type { DiffResponse } from "../shared/task";

/**
 * Turn a GET /api/tasks/:id/diff response into a compact git-diff-shortstat
 * display string suitable for selected-card detail panes.
 *
 * - `{ kind: "diff", files }` → aggregates file count, additions, and deletions
 *   across all files, even binary/rename-only entries (which contribute zero
 *   counts). An empty diff renders "0 files · +0 -0 ›".
 * - `{ kind: "no-git" }` → returns a non-crashing unavailable label.
 */
export function formatDiffStat(response: DiffResponse): string {
  if (response.kind === "no-git") {
    return "diff unavailable";
  }

  const fileCount = response.files.length;
  const additions = response.files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = response.files.reduce((sum, f) => sum + f.deletions, 0);

  return `${fileCount} files · +${additions} -${deletions} ›`;
}