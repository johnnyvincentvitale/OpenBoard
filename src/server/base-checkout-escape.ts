import type { Task, TaskStore } from "../shared";
import { detectBaseCheckoutEscape, type EscapeDetectionResult } from "./escape-detector";
import { inspectGitDirectory } from "./git-inspect";

export async function detectTaskBaseCheckoutEscape(task: Task): Promise<EscapeDetectionResult> {
  if (task.isolationAtDispatch !== "worktree") {
    return { escaped: false, changedPaths: [] };
  }

  const baseInfo = await inspectGitDirectory(task.directory);
  if (!baseInfo.isRepo || !baseInfo.root) {
    return { escaped: false, changedPaths: [] };
  }

  // A null dispatch snapshot is intentionally fail-closed for worktree runs:
  // it can over-block on base dirt that predated dispatch if the snapshot
  // capture failed, but it avoids silently accepting a possible bash escape.
  return detectBaseCheckoutEscape(baseInfo.root, task.baseCheckoutSnapshot ?? null);
}

export function markTaskBaseCheckoutEscape(
  store: TaskStore,
  taskId: string,
  changedPaths: string[],
  patch: Partial<Omit<Task, "id" | "createdAt">> = {},
): Task | undefined {
  return store.update(taskId, {
    runState: "idle",
    pending: "base-checkout-escape",
    escapeDetectedPaths: changedPaths,
    ...patch,
  });
}
