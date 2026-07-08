import type { TaskKind } from "../shared";

type HandoffGuidance = {
  label: string;
  summary: string;
  changedFiles: string;
  verification: string;
  residualRisk: string;
  extra?: string;
};

const GUIDANCE: Record<TaskKind, HandoffGuidance> = {
  none: {
    label: "none",
    summary: "what happened",
    changedFiles: "files changed, if any",
    verification: "commands/checks run",
    residualRisk: "what remains uncertain or blocked",
  },
  research: {
    label: "research",
    summary: "factual findings, sources inspected, repo areas read, or evidence gathered",
    changedFiles: "usually empty unless you wrote a raw note/artifact",
    verification: "searches, reads, commands, source checks, or \"not applicable: research only\"",
    residualRisk: "source gaps, confidence limits, unverified claims, missing access",
  },
  synthesis: {
    label: "synthesis",
    summary: "evaluation of parent findings, recommended direction, and proposed next action",
    changedFiles: "usually empty unless you wrote a synthesis document",
    verification: "parent handoffs/raw files read, checks against brief/goal, gap checks performed",
    residualRisk: "unresolved questions, assumptions, competing interpretations, human decisions needed",
    extra: "Include ideas to avoid, questions for human, and, if useful, a proposed build/audit graph.",
  },
  build: {
    label: "build",
    summary: "implementation completed and behavior changed",
    changedFiles: "actual touched files",
    verification: "commands run and results",
    residualRisk: "test gaps, edge cases, integration concerns, follow-ups",
  },
  audit: {
    label: "audit",
    summary: "verdict plus findings",
    changedFiles: "usually empty unless you wrote an audit artifact",
    verification: "diffs reviewed, tests run, files inspected, behavior checked",
    residualRisk: "areas not inspected, confidence limits, unresolved concerns",
    extra: "Be finding-oriented, not implementation-oriented.",
  },
  fix: {
    label: "fix",
    summary: "what was fixed and which audit/build/synthesis finding it resolves",
    changedFiles: "actual touched files",
    verification: "targeted regression check plus broader relevant check when feasible",
    residualRisk: "unfixed findings, skipped tests, remaining uncertainty",
  },
};

export function completionHandoffGuidance(kind: TaskKind | null | undefined): string {
  const guidance = GUIDANCE[kind ?? "none"] ?? GUIDANCE.none;
  return [
    "OPENBOARD HANDOFF GUIDANCE",
    `Task type: ${guidance.label}`,
    "Use the same JSON report fields, but structure them this way:",
    `- summary: ${guidance.summary}.`,
    `- changedFiles: ${guidance.changedFiles}.`,
    `- verification: ${guidance.verification}.`,
    `- residualRisk: ${guidance.residualRisk}.`,
    ...(guidance.extra ? [guidance.extra] : []),
  ].join("\n");
}
