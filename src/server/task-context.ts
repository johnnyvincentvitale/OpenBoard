import type { TaskKind } from "../shared";

const TASK_CONTEXT: Partial<Record<TaskKind, string[]>> = {
  build: [
    "Create or modify the requested implementation/artifact in cwd.",
    "If starting from scratch, establish the minimal structure needed for the requested result.",
    "If modifying existing work, inspect the relevant cwd files before editing.",
    "Use parent context as constraints/input, not as a substitute for inspecting cwd.",
    "Run relevant verification.",
    "Do not move/accept/integrate the card.",
  ],
  synthesis: [
    "For synthesis, the mode is:",
    "Read parent context first.",
    "Evaluate parent findings for agreement, conflict, evidence strength, gaps, and implications.",
    "Preserve the user/card prompt as the authority for the actual output shape.",
    "Do not implement build changes unless explicitly asked.",
    "Surface unresolved questions or human decisions when they affect the requested output.",
  ],
  audit: [
    "Inspect only unless explicitly told otherwise.",
    "Do not fix issues.",
    "Review diffs, parent worktrees, tests, and behavior.",
    "Produce findings with severity/confidence and residual risk.",
    "Keep output finding-oriented.",
  ],
  fix: [
    "Resolve specific findings from parent audit/build/synthesis context.",
    "Tie each change back to the finding it addresses.",
    "Prefer targeted edits and targeted regression checks first, then broader checks when feasible.",
    "Call out unfixed findings.",
  ],
};

export function taskExecutionContext(kind: TaskKind | null | undefined): string | null {
  const label = kind ?? "none";
  const lines = TASK_CONTEXT[label];
  if (!lines) return null;
  return ["OPENBOARD TASK CONTEXT", `Task type: ${label}`, ...lines].join("\n");
}
