import type { CodeAncestorCandidate, DiffResponse, TaskContext } from "../shared";

export interface DiffLineageState {
  targetTaskId: string;
  directParents: TaskContext["directParents"];
  inheritedParents: TaskContext["inheritedParents"];
  codeAncestors: CodeAncestorCandidate[];
  selectedAncestorIndex: number | null;
}

export function createDiffLineageState(context: TaskContext): DiffLineageState {
  return {
    targetTaskId: context.task.taskId,
    directParents: context.directParents,
    inheritedParents: context.inheritedParents,
    codeAncestors: context.codeAncestors,
    selectedAncestorIndex: null,
  };
}

export function selectedCodeAncestor(state: DiffLineageState): CodeAncestorCandidate | undefined {
  return state.selectedAncestorIndex === null ? undefined : state.codeAncestors[state.selectedAncestorIndex];
}

export function moveAncestorSelection(state: DiffLineageState, delta: number): DiffLineageState {
  if (state.codeAncestors.length === 0) return state;
  // Baseline is a real evidence source, not merely the initial state. Keeping it
  // in the cycle lets the operator return to the card's normal task_diff without
  // closing and reopening View Diff.
  const sourceCount = state.codeAncestors.length + 1;
  const currentSource = state.selectedAncestorIndex === null ? 0 : state.selectedAncestorIndex + 1;
  const nextSource = (currentSource + delta % sourceCount + sourceCount) % sourceCount;
  return { ...state, selectedAncestorIndex: nextSource === 0 ? null : nextSource - 1 };
}

export function clearAncestorSelection(state: DiffLineageState): DiffLineageState {
  return { ...state, selectedAncestorIndex: null };
}

export function diffLineageHeader(state: DiffLineageState, response: DiffResponse | undefined): string {
  const ancestor = selectedCodeAncestor(state);
  const route = ancestor ? ancestorRoute(state, ancestor) : "current baseline";
  const source = ancestor
    ? `compare ${ancestor.title}${ancestor.taskKind ? ` (${ancestor.taskKind})` : ""} · ${route}`
    : "baseline task_diff";
  if (!response) return source;
  if (response.kind === "no-git") return `${source} · no git: ${response.reason}`;
  return `${source} · ${response.files.length} file${response.files.length === 1 ? "" : "s"}${response.capped ? " · capped" : ""}`;
}

export function ancestorRoute(state: DiffLineageState, ancestor: CodeAncestorCandidate): string {
  const inherited = state.inheritedParents.find((parent) => parent.taskId === ancestor.taskId);
  if (inherited) return `depth ${inherited.depth} via ${inherited.viaParentIds.join("/")}`;
  const direct = state.directParents.find((parent) => parent.taskId === ancestor.taskId);
  if (direct) return "direct parent";
  return "code ancestor";
}

export function evidenceSourceIds(state: DiffLineageState): string[] {
  return state.codeAncestors.map((ancestor) => ancestor.taskId);
}

export async function fetchSelectedDiffEvidence(
  state: DiffLineageState,
  client: { getTaskDiff(id: string): Promise<DiffResponse>; getTaskCompare(targetId: string, baseTaskId: string): Promise<DiffResponse> },
): Promise<DiffResponse> {
  const ancestor = selectedCodeAncestor(state);
  return ancestor ? client.getTaskCompare(state.targetTaskId, ancestor.taskId) : client.getTaskDiff(state.targetTaskId);
}
