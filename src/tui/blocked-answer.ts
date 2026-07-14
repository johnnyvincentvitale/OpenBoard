import type { Task } from "../shared";

export interface BlockedAnswerDraft {
  taskId: string;
  blockedReportedAt: number;
  text: string;
  submitting: boolean;
  resumeMode?: "resume" | "restart";
  error?: string;
}

export function blockedAnswerDraftKey(taskId: string, reportedAt: number): string {
  return `${taskId}:${reportedAt}`;
}

export function currentBlockedReport(task: Pick<Task, "id" | "completion"> | undefined): { taskId: string; reportedAt: number } | undefined {
  if (!task?.completion || task.completion.outcome !== "blocked") return undefined;
  return { taskId: task.id, reportedAt: task.completion.reportedAt };
}

export function createBlockedAnswerDraft(task: Pick<Task, "id" | "completion">, existing?: BlockedAnswerDraft): BlockedAnswerDraft | undefined {
  const report = currentBlockedReport(task);
  if (!report || !task.completion?.needsInput?.trim()) return undefined;
  if (existing && existing.taskId === report.taskId && existing.blockedReportedAt === report.reportedAt) return existing;
  return { taskId: report.taskId, blockedReportedAt: report.reportedAt, text: "", submitting: false };
}

export function editBlockedAnswerDraft(draft: BlockedAnswerDraft, input: string): BlockedAnswerDraft {
  return { ...draft, text: draft.text + input, error: undefined };
}

export function backspaceBlockedAnswerDraft(draft: BlockedAnswerDraft): BlockedAnswerDraft {
  return { ...draft, text: draft.text.slice(0, -1), error: undefined };
}

export function lineDeleteBlockedAnswerDraft(draft: BlockedAnswerDraft): BlockedAnswerDraft {
  const index = draft.text.lastIndexOf("\n");
  return { ...draft, text: index === -1 ? "" : draft.text.slice(0, index + 1), error: undefined };
}

export function staleBlockedAnswerDraft(task: Pick<Task, "id" | "completion"> | undefined, draft: BlockedAnswerDraft | undefined): boolean {
  if (!draft) return false;
  return task?.id !== draft.taskId || task.completion?.outcome !== "blocked" || task.completion.reportedAt !== draft.blockedReportedAt;
}
