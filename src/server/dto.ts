import type { CompletionReport, CompletionSource, Task } from "../shared";

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
