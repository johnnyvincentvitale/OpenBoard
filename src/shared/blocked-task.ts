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
