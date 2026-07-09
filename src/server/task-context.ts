import type { TaskKind } from "../shared";

type TaskContextOptions = {
  hasParents?: boolean;
};

const LINKED_TASK_CONTEXT: Partial<Record<TaskKind, string[]>> = {
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
    "Inspect parent code changes with the openboard task_diff MCP tool first; use read-only parent worktree inspection as the fallback.",
    "Review diffs, tests, and behavior.",
    "State which tree each verification command ran in (own cwd vs parent changes); static diff review is not runtime proof of the parent's tree.",
    "Produce findings with severity/confidence and residual risk.",
    "Keep output finding-oriented.",
  ],
  fix: [
    "Resolve specific findings from parent audit/build/synthesis context.",
    "Use audit parents for findings. Use the openboard task_diff MCP tool on the code-bearing (build) parent for the code changes; do not read sibling worktree files directly when the diff is available.",
    "Your cwd starts from the base branch: reapply the parent changes your fix depends on into cwd first, then apply the fix.",
    "Tie each change back to the finding it addresses.",
    "Prefer targeted edits and targeted regression checks first, then broader checks when feasible.",
    "Call out unfixed findings.",
  ],
};

const STANDALONE_TASK_CONTEXT: Partial<Record<TaskKind, string[]>> = {
  build: [
    "Create or modify the requested implementation/artifact in cwd.",
    "If starting from scratch, establish the minimal structure needed for the requested result.",
    "If modifying existing work, inspect the relevant cwd files before editing.",
    "Use the card prompt and cwd evidence as the source of truth.",
    "Run relevant verification.",
    "Do not move/accept/integrate the card.",
  ],
  synthesis: [
    "For synthesis, the mode is:",
    "Use the card prompt and any named files as the input.",
    "Evaluate evidence for agreement, conflict, evidence strength, gaps, and implications.",
    "Preserve the user/card prompt as the authority for the actual output shape.",
    "Do not implement build changes unless explicitly asked.",
    "Surface unresolved questions or human decisions when they affect the requested output.",
  ],
  audit: [
    "Inspect only unless explicitly told otherwise.",
    "Do not fix issues.",
    "Review the requested files, diffs, tests, and behavior in cwd.",
    "Produce findings with severity/confidence and residual risk.",
    "Keep output finding-oriented.",
  ],
  fix: [
    "Resolve specific findings described in the card prompt or current cwd.",
    "Tie each change back to the finding or defect it addresses.",
    "Prefer targeted edits and targeted regression checks first, then broader checks when feasible.",
    "Call out unfixed findings or assumptions.",
  ],
};

export function taskExecutionContext(kind: TaskKind | null | undefined, options: TaskContextOptions = {}): string | null {
  const label = kind ?? "none";
  const contextByKind = options.hasParents ? LINKED_TASK_CONTEXT : STANDALONE_TASK_CONTEXT;
  const lines = contextByKind[label];
  if (!lines) return null;
  return ["OPENBOARD TASK CONTEXT", `Task type: ${label}`, ...lines].join("\n");
}
