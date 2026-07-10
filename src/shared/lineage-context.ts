import type { Column } from "./columns";
import type { CompletionReport, CompletionSource, TaskCompletionLocation, TaskKind } from "./task";

export interface TaskHandoff {
  taskId: string;
  title: string;
  description: string;
  taskKind?: TaskKind | null;
  column?: Column;
  completion: CompletionReport | null;
  changedFiles: string[];
  verification: CompletionReport["verification"];
  residualRisk: string;
  summary?: string;
  hasStructuredHandoff: boolean;
  /** Whether completion was agent-reported, synthesized from idle, or watchdog-stamped. Present on the target task handoff from the context route. */
  completionSource?: CompletionSource | null;
  /** Where the reported changed files were found when the completion report landed. Present on the target task handoff from the context route. */
  completionLocation?: TaskCompletionLocation | null;
}

export interface DirectParentContext extends TaskHandoff {
  kind: "direct-parent";
  parentId: string;
}

export interface InheritedParentContext {
  kind: "inherited-parent";
  taskId: string;
  title: string;
  taskKind?: TaskKind | null;
  column: Column;
  depth: number;
  viaParentIds: string[];
  summary?: string;
  hasStructuredHandoff: boolean;
}

export interface CodeAncestorCandidate {
  taskId: string;
  title: string;
  taskKind?: TaskKind | null;
  column: Column;
  branch?: string | null;
  worktreePath?: string | null;
  changedFiles: string[];
  summary?: string;
  hasStructuredHandoff: boolean;
}

export interface TaskContext {
  task: TaskHandoff;
  directParents: DirectParentContext[];
  inheritedParents: InheritedParentContext[];
  codeAncestors: CodeAncestorCandidate[];
  /**
   * True when the lineage traversal hit a depth, node-count, or via-parent
   * cap and omitted ancestors beyond the bound. Consumers should not assume
   * the lineage is exhaustive when this is set.
   */
  truncated?: boolean;
}
