import type { TaskKind } from "../shared";
import type { TaskContext } from "../shared/lineage-context";

type TaskContextOptions = {
  hasParents?: boolean;
};

const LINKED_TASK_CONTEXT: Partial<Record<TaskKind, string[]>> = {
  research: [
    "For research, the mode is:",
    "Investigate the question using read-only cwd tools and parent context.",
    "Available read-only board tools: task_context (retrieve full ancestor handoffs), task_diff (inspect parent code diffs), task_compare (compare any two task worktrees).",
    "Describe what you found, cite evidence, note gaps, and flag decisions the operator needs to make.",
    "Do not edit code or run mutating commands.",
  ],
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
    "Read parent context first. Use task_context to retrieve full ancestor handoffs for any parent.",
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
  research: [
    "For research, the mode is:",
    "Investigate the question using read-only cwd tools.",
    "Describe what you found, cite evidence, note gaps, and flag decisions the operator needs to make.",
    "Do not edit code or run mutating commands.",
  ],
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

/**
 * Dispatcher prompt injection: returns the execution context block for a given
 * task kind, gating on whether the task has parent links. This is the existing
 * contract used by the dispatcher to inject context guidance into agent prompts.
 *
 * Now covers Research in addition to Build/Synthesis/Audit/Fix.
 */
export function taskExecutionContext(
  kind: TaskKind | null | undefined,
  options: TaskContextOptions = {},
): string | null {
  const label = kind ?? "none";
  const contextByKind = options.hasParents ? LINKED_TASK_CONTEXT : STANDALONE_TASK_CONTEXT;
  const lines = contextByKind[label];
  if (!lines) return null;
  return ["OPENBOARD TASK CONTEXT", `Task type: ${label}`, ...lines].join("\n");
}

/**
 * Format a lineage-aware parent context block for dispatcher prompt injection.
 *
 * This is the "direct-only dependency gating" surface: only direct parents
 * appear in the injected prompt. Inherited ancestors are available through
 * the task_context MCP tool (not the prompt block). Permitted read-only
 * board tools include task_context, task_diff, and task_compare.
 */
export function directParentPromptBlock(lineage: TaskContext | null): string | null {
  if (!lineage || lineage.directParents.length === 0) return null;

  const parts: string[] = ["PARENT CONTEXT"];

  parts.push(
    "To inspect a parent's code changes, first call the openboard MCP tool task_diff with that parent's task id (listed below).",
  );
  parts.push(
    "To retrieve full handoff details for inherited ancestors, use the openboard MCP tool task_context with the ancestor's task id.",
  );
  parts.push(
    "To compare any two task worktrees, use the openboard MCP tool task_compare.",
  );
  parts.push(
    "If task_diff is unavailable, errors, or returns no-git evidence, fall back to the parent worktree with read/grep/glob/list tools only.",
  );
  parts.push(
    "Parent task worktrees are read-only. Do not use bash, git -C, wc, shell grep, tests, or mutating commands against parent or sibling worktrees.",
  );
  parts.push(
    "Do all implementation and verification shell commands from your own cwd.",
  );
  parts.push(
    "Board tools are limited to task_diff, task_context, and task_compare for inspection and complete_task/block_task for your final report. Never call other board tools (run/move/create/link/retry/abort/integrate).",
  );
  parts.push("");

  for (const parent of lineage.directParents) {
    parts.push(
      `PARENT-${parent.parentId.slice(-8)}: ${parent.title}`,
    );
    if (parent.summary) {
      parts.push(`PARENT-${parent.parentId.slice(-8)} SUMMARY: ${parent.summary}`);
    }
    if (parent.changedFiles.length > 0) {
      parts.push(`PARENT-${parent.parentId.slice(-8)} Changed files:`);
      for (const f of parent.changedFiles) {
        parts.push(`- ${f}`);
      }
    }
    if (parent.verification && parent.verification.length > 0) {
      parts.push(`PARENT-${parent.parentId.slice(-8)} Verification:`);
      for (const v of parent.verification) {
        parts.push(`- ${v.command}: ${v.result}`);
      }
    }
    if (parent.residualRisk) {
      parts.push(`PARENT-${parent.parentId.slice(-8)} Residual risk: ${parent.residualRisk}`);
    }
    parts.push("");
  }

  return parts.join("\n");
}
