import { isAbsolute, relative, sep } from "node:path";
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

const DEFAULT_PARENT_CONTEXT_MAX_CHARS = 24_000;

type ParentPromptOptions = {
  maxChars?: number;
};

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return "…";
  return `${value.slice(0, max - 1)}…`;
}

function parentChangedFiles(parent: TaskContext["directParents"][number]): string[] {
  return (parent.changedFiles ?? []).map((file) => {
    if (!parent.worktreePath || !isAbsolute(file)) return file;
    const rel = relative(parent.worktreePath, file);
    const outsideParentWorktree = rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel);
    if (!rel || outsideParentWorktree) return file;
    return sep === "\\" ? rel.replaceAll("\\", "/") : rel;
  });
}

function tryPush(lines: string[], line: string, maxChars: number, reserve = 0): boolean {
  const current = lines.join("\n").length;
  const nextLength = current + (lines.length > 0 ? 1 : 0) + line.length + reserve;
  if (nextLength <= maxChars) {
    lines.push(line);
    return true;
  }
  return false;
}

function pushRequired(lines: string[], line: string, maxChars: number): void {
  const current = lines.join("\n").length;
  const prefix = lines.length > 0 ? 1 : 0;
  const remaining = maxChars - current - prefix;
  if (remaining <= 0) return;
  lines.push(clip(line, remaining));
}

/**
 * Format the production parent-context prompt block. The dispatcher uses this
 * same helper, so tests for this module cover what workers actually see. The
 * budget applies to the entire injected block, not only inherited rows.
 */
export function directParentPromptBlock(lineage: TaskContext | null, options: ParentPromptOptions = {}): string | null {
  if (!lineage || lineage.directParents.length === 0) return null;

  const maxChars = Math.max(400, options.maxChars ?? DEFAULT_PARENT_CONTEXT_MAX_CHARS);
  const lines: string[] = [];
  let omitted = 0;
  let omittedParentIds = 0;
  const reserve = 180;

  const guidanceLines = maxChars < 2_000
    ? [
        "PARENT CONTEXT",
        "Use task_context for bounded full lineage, task_diff for parent diffs, and task_compare for Build->Fix evidence.",
        "Parent worktrees are read-only; run edits/tests only from your own cwd.",
        "",
      ]
    : [
        "PARENT CONTEXT",
        "To inspect a parent's code changes, first call the openboard MCP tool task_diff with that parent's task id (listed below).",
        "Use task_context to retrieve bounded full lineage diagnostics and full ancestor handoffs; use task_compare for Build->Fix comparisons.",
        "If task_diff is unavailable, errors, or returns no-git evidence, fall back to the parent worktree with read/grep/glob/list tools only.",
        "Parent task worktrees are read-only. Do not use bash, git -C, wc, shell grep, tests, or mutating commands against parent or sibling worktrees.",
        "Do all implementation and verification shell commands from your own cwd.",
        "Board tools are limited to task_diff, task_context, and task_compare for inspection and complete_task/block_task for your final report. Never call other board tools (run/move/create/link/retry/abort/integrate).",
        "",
      ];
  for (const [index, line] of guidanceLines.entries()) {
    if (index === 0) pushRequired(lines, line, maxChars);
    else if (!tryPush(lines, line, maxChars, reserve)) omitted += 1;
  }

  const representedParentIds = new Set<string>();
  if (tryPush(lines, "DIRECT PARENT IDS:", maxChars, reserve)) {
    for (const [index, parent] of lineage.directParents.entries()) {
      const label = `PARENT-${String(index).padStart(3, "0")}`;
      if (tryPush(lines, `- ${label} TASK ID: ${parent.parentId}`, maxChars, reserve)) {
        representedParentIds.add(parent.parentId);
      } else {
        omittedParentIds += 1;
      }
    }
    if (!tryPush(lines, "", maxChars, reserve)) omitted += 1;
  } else {
    omittedParentIds += lineage.directParents.length;
  }

  for (const [index, parent] of lineage.directParents.entries()) {
    if (!representedParentIds.has(parent.parentId)) continue;
    const label = `PARENT-${String(index).padStart(3, "0")}`;
    if (!tryPush(lines, `${label}: ${clip(parent.title, 160)}`, maxChars, reserve)) {
      omitted += 1;
      continue;
    }
    if (!tryPush(lines, `${label} WORKTREE: ${parent.worktreePath ?? "unavailable"}`, maxChars, reserve)) omitted += 1;
    if (!tryPush(lines, `${label} TASK ID: ${parent.parentId}`, maxChars, reserve)) omitted += 1;
    if (!tryPush(lines, `${label} BRANCH: ${parent.branch ?? "unavailable"}`, maxChars, reserve)) omitted += 1;

    if (parent.completion) {
      if (!tryPush(lines, `${label} SUMMARY: ${clip(parent.completion.summary, 600)}`, maxChars, reserve)) omitted += 1;
      if (tryPush(lines, `${label} Changed files:`, maxChars, reserve)) {
        const files = parentChangedFiles(parent);
        if (files.length === 0) {
          if (!tryPush(lines, "- none reported", maxChars, reserve)) omitted += 1;
        } else {
          for (const file of files) {
            if (!tryPush(lines, `- ${clip(file, 300)}`, maxChars, reserve)) omitted += 1;
          }
        }
      } else {
        omitted += Math.max(1, parent.changedFiles.length);
      }

      if (tryPush(lines, `${label} Verification:`, maxChars, reserve)) {
        if (parent.completion.verification.length === 0) {
          if (!tryPush(lines, "- none reported", maxChars, reserve)) omitted += 1;
        } else {
          for (const check of parent.completion.verification) {
            if (!tryPush(lines, `- ${clip(check.command, 300)}: ${clip(check.result, 500)}`, maxChars, reserve)) omitted += 1;
          }
        }
      } else {
        omitted += Math.max(1, parent.completion.verification.length);
      }
      if (!tryPush(lines, `${label} Residual risk: ${clip(parent.completion.residualRisk, 600)}`, maxChars, reserve)) omitted += 1;
    } else {
      if (!tryPush(lines, "No structured handoff exists; parent is manually marked Done.", maxChars, reserve)) omitted += 1;
    }
    if (!tryPush(lines, "", maxChars, reserve)) omitted += 1;
  }

  if (lineage.inheritedParents.length > 0) {
    if (tryPush(lines, "INHERITED CONTEXT", maxChars, reserve)) {
      for (const ancestor of lineage.inheritedParents) {
        const row = [
          `- ${ancestor.taskId}: ${clip(ancestor.title, 180)}`,
          `kind=${ancestor.taskKind ?? "none"}`,
          `depth=${ancestor.depth}`,
          `via=${ancestor.viaParentIds.join(",")}`,
          `structured=${ancestor.hasStructuredHandoff}`,
          `codeCandidate=${lineage.codeAncestors.some((candidate) => candidate.taskId === ancestor.taskId)}`,
          ancestor.summary ? `summary=${clip(ancestor.summary, 300)}` : "summary=none",
        ].join("; ");
        if (!tryPush(lines, row, maxChars, reserve)) omitted += 1;
      }
      if (lineage.diagnostics?.truncated) {
        const reason = lineage.diagnostics.truncationReasons.join(",") || "bounded";
        if (!tryPush(lines, `Lineage diagnostics: truncated=${lineage.diagnostics.truncated}; reasons=${reason}; use task_context for the bounded full lineage response.`, maxChars, reserve)) omitted += 1;
      }
      if (!tryPush(lines, "", maxChars, reserve)) omitted += 1;
    } else {
      omitted += lineage.inheritedParents.length;
    }
  }

  for (const line of [
    "Your cwd starts from the base branch: parent changes are NOT present in your cwd unless they were already integrated.",
    "If your task depends on un-integrated parent changes, reapply the needed changes into cwd first (guided by task_diff), then do your own work.",
    "If a parent changed file also exists in your cwd, inspect the parent copy only to understand intent, then open/edit/test the cwd copy.",
  ]) {
    if (!tryPush(lines, line, maxChars, reserve)) omitted += 1;
  }

  if (omittedParentIds > 0) {
    const note = `Direct parent IDs omitted by the ${maxChars} character prompt budget: ${omittedParentIds} of ${lineage.directParents.length}; use task_context for the bounded full lineage response before relying on omitted parents.`;
    if (!tryPush(lines, note, maxChars, 0)) {
      pushRequired(lines, "Direct parent IDs omitted; use task_context for full lineage evidence.", maxChars);
    }
  }

  if (omitted > 0) {
    const note = `Some parent context details omitted by the ${maxChars} character prompt budget; use task_context for bounded full lineage diagnostics and task_diff/task_compare for evidence.`;
    if (!tryPush(lines, note, maxChars, 0)) {
      pushRequired(lines, "Some details omitted; use task_context for full lineage evidence.", maxChars);
    }
  }

  return lines.join("\n").trimEnd();
}
