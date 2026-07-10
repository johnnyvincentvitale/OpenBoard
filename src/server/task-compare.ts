/**
 * Task evidence comparison — read-only diff between two cards.
 *
 * Used by GET /api/tasks/:targetId/compare?baseTaskId=:baseTaskId.
 *
 * The comparison is deterministic: files are sorted by relative path,
 * patches are bounded to ~2 MB combined, and the response explicitly
 * marks conflict, stale, and unavailable states.
 */
import type { DiffFile, DiffResponse, Task } from "../shared";
import { computeDiff, MAX_TOTAL_PATCH_BYTES } from "./diff-engine";

export interface TaskCompareFile {
  file: string;
  status: DiffFile["status"] | "conflict" | "stale" | "unavailable";
  baseStatus?: DiffFile["status"];
  targetStatus?: DiffFile["status"];
  baseAdditions: number;
  baseDeletions: number;
  targetAdditions: number;
  targetDeletions: number;
  basePatch?: string;
  targetPatch?: string;
}

export interface UnavailableEvidence {
  taskId: string;
  reason: string;
}

export interface TaskCompareResponse {
  kind: "comparison";
  baseTaskId: string;
  targetTaskId: string;
  baseRef: string | null;
  targetRef: string | null;
  files: TaskCompareFile[];
  capped: boolean;
  conflict: boolean;
  stale: boolean;
  unavailable: UnavailableEvidence[];
}

interface EvidenceResult {
  taskId: string;
  kind: "git" | "metadata" | "none";
  ref: string | null;
  diff?: DiffResponse;
  changedFiles?: string[];
  reason?: string;
}

function resolveTaskRef(task: Task): string | null {
  return task.worktreeBranch ?? task.harnessBranch ?? task.harnessCommit ?? null;
}

async function resolveEvidence(task: Task): Promise<EvidenceResult> {
  const ref = resolveTaskRef(task);
  const diff = await computeDiff(task);
  if (diff.kind === "diff") {
    return { taskId: task.id, kind: "git", ref, diff };
  }
  const changedFiles = task.completion?.changedFiles;
  if (changedFiles && changedFiles.length > 0) {
    return { taskId: task.id, kind: "metadata", ref, reason: diff.reason, changedFiles };
  }
  return { taskId: task.id, kind: "none", ref, reason: diff.reason };
}

/**
 * Normalize a file path for comparison output. Rejects absolute paths and
 * any path that escapes the repository (contains `..`), so the response
 * only contains repo-relative file identifiers.
 */
export function normalizeFilePath(file: string): string | undefined {
  const trimmed = file.trim();
  if (!trimmed || trimmed === ".") return undefined;
  if (trimmed.startsWith("/") || trimmed.startsWith("..") || trimmed.includes("../")) {
    return undefined;
  }
  return trimmed.replace(/^\.+\//, "");
}

function toDiffFileMap(files: DiffFile[]): Map<string, DiffFile> {
  const map = new Map<string, DiffFile>();
  for (const f of files) {
    const safe = normalizeFilePath(f.file);
    if (safe) map.set(safe, { ...f, file: safe });
  }
  return map;
}

function applyMetadataFallback(
  files: Map<string, DiffFile>,
  changedFiles: string[],
): Set<string> {
  const metadataFiles = new Set<string>();
  for (const raw of changedFiles) {
    const safe = normalizeFilePath(raw);
    if (!safe) continue;
    metadataFiles.add(safe);
    if (!files.has(safe)) {
      files.set(safe, { file: safe, status: "modified", additions: 0, deletions: 0 });
    }
  }
  return metadataFiles;
}

function buildComparison(
  base: EvidenceResult,
  target: EvidenceResult,
): { files: TaskCompareFile[]; conflict: boolean; stale: boolean; capped: boolean } {
  const baseMap = base.kind === "git" && base.diff?.kind === "diff"
    ? toDiffFileMap(base.diff.files)
    : new Map<string, DiffFile>();
  const targetMap = target.kind === "git" && target.diff?.kind === "diff"
    ? toDiffFileMap(target.diff.files)
    : new Map<string, DiffFile>();

  const baseMetadataFiles = base.kind === "metadata" && base.changedFiles
    ? applyMetadataFallback(baseMap, base.changedFiles)
    : new Set<string>();
  const targetMetadataFiles = target.kind === "metadata" && target.changedFiles
    ? applyMetadataFallback(targetMap, target.changedFiles)
    : new Set<string>();

  const allPaths = new Set<string>([...baseMap.keys(), ...targetMap.keys()]);
  const sortedPaths = [...allPaths].sort();

  const files: TaskCompareFile[] = [];
  let conflict = false;
  const stale = base.kind === "metadata" || target.kind === "metadata";

  for (const path of sortedPaths) {
    const baseFile = baseMap.get(path);
    const targetFile = targetMap.get(path);
    const baseIsMetadata = baseMetadataFiles.has(path);
    const targetIsMetadata = targetMetadataFiles.has(path);

    let status: TaskCompareFile["status"] = "unavailable";
    if (baseFile && targetFile) {
      // If either side is stale metadata we cannot verify patch equality,
      // so treat shared files as potential conflicts.
      if (baseIsMetadata || targetIsMetadata) {
        status = "conflict";
        conflict = true;
      } else {
        const sameEvidence = baseFile.status === targetFile.status && baseFile.patch === targetFile.patch;
        if (sameEvidence) {
          status = targetFile.status;
        } else {
          status = "conflict";
          conflict = true;
        }
      }
    } else if (baseFile) {
      status = base.kind === "metadata" ? "stale" : baseFile.status;
    } else if (targetFile) {
      status = target.kind === "metadata" ? "stale" : targetFile.status;
    }

    files.push({
      file: path,
      status,
      baseStatus: baseFile?.status,
      targetStatus: targetFile?.status,
      baseAdditions: baseFile?.additions ?? 0,
      baseDeletions: baseFile?.deletions ?? 0,
      targetAdditions: targetFile?.additions ?? 0,
      targetDeletions: targetFile?.deletions ?? 0,
      basePatch: baseFile?.patch,
      targetPatch: targetFile?.patch,
    });
  }

  const capped = capComparisonFiles(files, MAX_TOTAL_PATCH_BYTES);
  return { files: capped.files, conflict, stale, capped: capped.capped };
}

function capComparisonFiles(
  files: TaskCompareFile[],
  maxBytes: number,
): { files: TaskCompareFile[]; capped: boolean } {
  let total = 0;
  const kept: TaskCompareFile[] = [];
  let capped = false;
  for (const f of files) {
    const baseBytes = f.basePatch ? Buffer.byteLength(f.basePatch, "utf-8") : 0;
    const targetBytes = f.targetPatch ? Buffer.byteLength(f.targetPatch, "utf-8") : 0;
    if (!capped && total + baseBytes + targetBytes <= maxBytes) {
      kept.push(f);
      total += baseBytes + targetBytes;
      continue;
    }
    capped = true;
    kept.push({ ...f, basePatch: undefined, targetPatch: undefined });
  }
  return { files: kept, capped };
}

/**
 * Compare the durable code evidence of two tasks without mutation,
 * checkout, or transcript access.
 *
 * Resolves each task's git diff via the diff engine, then falls back to the
 * task's completion report changedFiles when git evidence is unavailable
 * (deleted worktree, missing branch, in-place without baseCommit, etc.).
 */
export async function compareTaskEvidence(
  baseTask: Task,
  targetTask: Task,
): Promise<TaskCompareResponse> {
  const [baseEvidence, targetEvidence] = await Promise.all([
    resolveEvidence(baseTask),
    resolveEvidence(targetTask),
  ]);

  const unavailable: UnavailableEvidence[] = [];
  if (baseEvidence.kind === "none" && baseEvidence.reason) {
    unavailable.push({ taskId: baseEvidence.taskId, reason: baseEvidence.reason });
  }
  if (targetEvidence.kind === "none" && targetEvidence.reason) {
    unavailable.push({ taskId: targetEvidence.taskId, reason: targetEvidence.reason });
  }

  const comparison = buildComparison(baseEvidence, targetEvidence);

  return {
    kind: "comparison",
    baseTaskId: baseTask.id,
    targetTaskId: targetTask.id,
    baseRef: baseEvidence.ref,
    targetRef: targetEvidence.ref,
    files: comparison.files,
    capped: comparison.capped,
    conflict: comparison.conflict,
    stale: comparison.stale,
    unavailable,
  };
}
