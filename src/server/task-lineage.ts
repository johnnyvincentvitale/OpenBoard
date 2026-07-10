import type { Task, TaskStore } from "../shared";
import type {
  CodeAncestorCandidate,
  DirectParentContext,
  InheritedParentContext,
  TaskContext,
  TaskHandoff,
} from "../shared/lineage-context";

/** Internal node tracked during per-branch BFS ancestry traversal. */
interface LineageNode {
  taskId: string;
  depth: number;
  viaParentIds: string[];
  createdAt: number;
}

function buildHandoff(task: Task): TaskHandoff {
  return {
    taskId: task.id,
    title: task.title,
    description: task.description,
    taskKind: task.taskKind,
    column: task.column,
    completion: task.completion ?? null,
    changedFiles: task.completion?.changedFiles ?? [],
    verification: task.completion?.verification ?? [],
    residualRisk: task.completion?.residualRisk ?? "",
    summary: task.completion?.summary,
    hasStructuredHandoff: task.completion != null,
  };
}

function isCodeEvidenceCandidate(task: Task): boolean {
  const col = task.column;
  if (col !== "review" && col !== "done") return false;
  const kind = task.taskKind;
  return kind === "build" || kind === "fix";
}

/**
 * Comparator: depth (ascending), then createdAt (ascending), then taskId.
 * Used for inherited parents and code ancestors.
 */
function lineageOrder(a: LineageNode, b: LineageNode): number {
  if (a.depth !== b.depth) return a.depth - b.depth;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.taskId.localeCompare(b.taskId);
}

/**
 * Comparator: createdAt (ascending), then taskId.
 * Used for direct parents.
 */
function directParentOrder(a: Task, b: Task): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id.localeCompare(b.id);
}

/**
 * Per-direct-parent BFS traversal: for each direct parent, independently
 * discover its reachable ancestors and record (depth, viaParentIds).
 * After all branches complete, merge globally: each node gets the minimum
 * depth across all branches and the UNION of all viaParentIds that lead
 * to it. This correctly propagates routes through reconverged nodes to
 * their own ancestors.
 */
function traverseLineage(
  store: TaskStore,
  targetId: string,
  directParentIds: string[],
): Map<string, LineageNode> {
  // Per-direct-parent branch results: branchKey -> Map<taskId, LineageNode>
  const branchMaps: Map<string, LineageNode>[] = [];

  for (const dpId of directParentIds) {
    const branch = new Map<string, LineageNode>();

    // Queue holds (taskId, depth).
    // We seed with the direct parent at depth 1.
    const queue: Array<{ taskId: string; depth: number }> = [{ taskId: dpId, depth: 1 }];
    let head = 0;

    while (head < queue.length) {
      const { taskId, depth } = queue[head++];

      // Cycle safety within this branch.
      if (branch.has(taskId)) {
        const existing = branch.get(taskId)!;
        if (depth < existing.depth) {
          existing.depth = depth;
        }
        continue;
      }

      const ancestor = store.get(taskId);
      if (!ancestor) continue; // missing/unlinked

      branch.set(taskId, {
        taskId,
        depth,
        viaParentIds: [dpId],
        createdAt: ancestor.createdAt,
      });

      // Enqueue this node's own parents (continue going up).
      const grandparentIds = store.getParentIds(taskId);
      for (const gpid of grandparentIds) {
        if (gpid === targetId) continue; // self-cycle guard
        queue.push({ taskId: gpid, depth: depth + 1 });
      }
    }

    branchMaps.push(branch);
  }

  // --- Global merge ---
  const merged = new Map<string, LineageNode>();

  for (const branch of branchMaps) {
    for (const [taskId, node] of branch) {
      const existing = merged.get(taskId);
      if (!existing) {
        merged.set(taskId, { ...node, viaParentIds: [...node.viaParentIds] });
      } else {
        // Keep minimum depth.
        if (node.depth < existing.depth) {
          existing.depth = node.depth;
        }
        // Union viaParentIds.
        for (const v of node.viaParentIds) {
          if (!existing.viaParentIds.includes(v)) {
            existing.viaParentIds.push(v);
          }
        }
      }
    }
  }

  return merged;
}

/**
 * Resolve the full task lineage for `taskId`.
 *
 * Uses per-direct-parent BFS with global merge so every ancestor correctly
 * retains minimum depth and ALL direct-parent entry routes, even through
 * reconverged nodes. Output lists are deterministically ordered: direct
 * parents by (createdAt, id), inherited ancestors and code candidates by
 * (depth, createdAt, id).
 */
export function resolveTaskLineage(
  taskId: string,
  store: TaskStore,
): TaskContext | null {
  const target = store.get(taskId);
  if (!target) return null;

  const directParentIds = store.getParentIds(taskId);

  // --- Per-direct-parent BFS with global merge ---
  const visited = traverseLineage(store, taskId, directParentIds);

  // --- Build direct parent contexts (depth 1, full handoff, ordered by createdAt/id) ---
  const directParents: DirectParentContext[] = [];
  const directParentTasks: Task[] = [];

  for (const pid of directParentIds) {
    const parent = store.get(pid);
    if (!parent) continue; // missing
    directParentTasks.push(parent);
  }

  directParentTasks.sort(directParentOrder);

  for (const parent of directParentTasks) {
    directParents.push({
      kind: "direct-parent",
      parentId: parent.id,
      ...buildHandoff(parent),
    });
  }

  // --- Build inherited parent contexts (depth > 1, compact, ordered) ---
  const inheritedNodes = [...visited.entries()]
    .filter(([id]) => !directParentIds.includes(id))
    .map(([, node]) => node)
    .sort(lineageOrder);

  const inheritedParents: InheritedParentContext[] = [];
  for (const node of inheritedNodes) {
    const ancestor = store.get(node.taskId);
    if (!ancestor) continue;

    inheritedParents.push({
      kind: "inherited-parent",
      taskId: node.taskId,
      title: ancestor.title,
      taskKind: ancestor.taskKind,
      column: ancestor.column,
      depth: node.depth,
      viaParentIds: node.viaParentIds.slice().sort(),
      summary: ancestor.completion?.summary,
      hasStructuredHandoff: ancestor.completion != null,
    });
  }

  // --- Build code-ancestor candidates ---
  const allResolvedIds = new Set([
    ...directParents.map((p) => p.taskId),
    ...inheritedParents.map((p) => p.taskId),
  ]);

  const codeCandidates: Array<{
    taskId: string;
    depth: number;
    createdAt: number;
    task: Task;
  }> = [];

  for (const id of allResolvedIds) {
    const t = store.get(id);
    if (!t || !isCodeEvidenceCandidate(t)) continue;

    const node = visited.get(id);
    codeCandidates.push({
      taskId: id,
      depth: node?.depth ?? 1,
      createdAt: node?.createdAt ?? t.createdAt,
      task: t,
    });
  }

  // Sort by (depth, createdAt, id)
  codeCandidates.sort(
    (a, b) =>
      a.depth - b.depth ||
      a.createdAt - b.createdAt ||
      a.taskId.localeCompare(b.taskId),
  );

  const codeAncestors: CodeAncestorCandidate[] = [];
  for (const c of codeCandidates) {
    codeAncestors.push({
      taskId: c.taskId,
      title: c.task.title,
      taskKind: c.task.taskKind,
      column: c.task.column,
      branch: c.task.worktreeBranch ?? null,
      worktreePath: c.task.worktreePath ?? null,
      changedFiles: c.task.completion?.changedFiles ?? [],
      summary: c.task.completion?.summary,
      hasStructuredHandoff: c.task.completion != null,
    });
  }

  return {
    task: buildHandoff(target),
    directParents,
    inheritedParents,
    codeAncestors,
  };
}
