import type { CompletionReport } from "./task";

export interface BlockedAnswerContext {
  blockedReportedAt: number;
  answeredBy: string;
}

export function blockedQuestion(report: Pick<CompletionReport, "needsInput" | "residualRisk" | "summary">): string {
  const explicit = report.needsInput?.trim();
  if (explicit) return explicit;
  const risk = report.residualRisk.trim();
  if (risk) return risk;
  return "No question was reported; inspect the block summary before retrying.";
}

export type BlockedQuestionPresentationState = "blocked-needs-answer" | "blocked-no-explicit-question";

export interface BlockedQuestionPresentation {
  state: BlockedQuestionPresentationState;
  question: string;
  blockedReportedAt: number;
  needsAnswer: boolean;
}

export function blockedQuestionPresentation(report: Pick<CompletionReport, "needsInput" | "residualRisk" | "summary" | "reportedAt">): BlockedQuestionPresentation {
  const needsAnswer = Boolean(report.needsInput?.trim());
  return {
    state: needsAnswer ? "blocked-needs-answer" : "blocked-no-explicit-question",
    question: blockedQuestion(report),
    blockedReportedAt: report.reportedAt,
    needsAnswer,
  };
}
