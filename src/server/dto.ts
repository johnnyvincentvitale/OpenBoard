import type { CompletionReport, CompletionSource, Dispatcher, Task } from "../shared";

export interface TaskDto extends Task {
  archived: boolean;
  parentIds: string[];
  completion: CompletionReport | null;
  completionSource: CompletionSource | null;
}

export function mapTaskToDto(task: Task): TaskDto {
  return {
    ...task,
    type: task.type ?? "agent",
    taskKind: task.taskKind ?? "none",
    archived: task.archived ?? false,
    parentIds: [...(task.parentIds ?? [])],
    completion: task.completion
      ? {
          ...task.completion,
          changedFiles: [...task.completion.changedFiles],
          verification: task.completion.verification.map((v) => ({ ...v })),
        }
      : null,
    completionSource: task.completionSource ?? null,
  };
}

/**
 * Shared projector: enrich every task in `tasks` with its live
 * `pendingPermissions` from the dispatcher's permission broker. Used by
 * GET /api/tasks (task list) and the task-events SSE snapshot frames so
 * a single function gates every surface that lists tasks.
 *
 * Broker-only changes (a new ask raised, an operator response, a policy
 * timeout) alter the dispatcher's pending list, so this projection causes
 * the next SSE snapshot to carry the updated permissions without a store
 * mutation.
 */
export function projectPendingPermissions(
  tasks: Task[],
  dispatcher: Dispatcher | undefined,
): Task[] {
  if (!dispatcher) return tasks;
  return tasks.map((task) => {
    try {
      const pendingPermissions = dispatcher.listPendingPermissions(task.id);
      if (pendingPermissions.length === 0) {
        // Preserve existing pendingPermissions if empty (avoid unnecessary
        // noise in JSON serialization).
        return task.pendingPermissions && task.pendingPermissions.length > 0
          ? { ...task, pendingPermissions: [] }
          : task;
      }
      return { ...task, pendingPermissions };
    } catch {
      // If a specific task lookup fails (e.g. task was removed between
      // list and projection), leave the task unchanged.
      return task;
    }
  });
}