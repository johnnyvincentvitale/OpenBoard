import type { Task, TaskStore } from "../shared";
import type {
  CodeAncestorCandidate,
  DirectParentContext,
  InheritedParentContext,
  LineageTruncationReason,
  TaskContext,
  TaskContextDiagnostics,
  TaskHandoff,
} from "../shared/lineage-context";

interface LineageNode {
  taskId: string;
  depth: number;
  viaParentIds: string[];
  createdAt: number;
}

interface QueueEntry {
  taskId: string;
  depth: number;
  viaParentId: string;
}

const MAX_LINEAGE_DEPTH = 16;
const MAX_LINEAGE_NODES = 256;
const MAX_VIA_PARENT_IDS = 64;

function emptyDiagnostics(): TaskContextDiagnostics {
  return {
    truncated: false,
    truncationReasons: [],
    limits: {
      maxDepth: MAX_LINEAGE_DEPTH,
      maxNodes: MAX_LINEAGE_NODES,
      maxViaParentIds: MAX_VIA_PARENT_IDS,
    },
    omittedCounts: {
      depthAtLeast: 0,
      nodeCountAtLeast: 0,
      viaParentIdsAtLeast: 0,
      missingTasks: 0,
    },
    missingTaskIds: [],
  };
}

function markDiagnostic(diagnostics: TaskContextDiagnostics, reason: LineageTruncationReason): void {
  diagnostics.truncated = true;
  if (!diagnostics.truncationReasons.includes(reason)) {
    diagnostics.truncationReasons.push(reason);
  }
}

function addMissing(diagnostics: TaskContextDiagnostics, taskId: string): void {
  markDiagnostic(diagnostics, "missing-task");
  if (!diagnostics.missingTaskIds.includes(taskId)) {
    diagnostics.missingTaskIds.push(taskId);
    diagnostics.missingTaskIds.sort();
    diagnostics.omittedCounts.missingTasks += 1;
  }
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

function lineageOrder(a: LineageNode, b: LineageNode): number {
  if (a.depth !== b.depth) return a.depth - b.depth;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.taskId.localeCompare(b.taskId);
}

function directParentOrder(a: Task, b: Task): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id.localeCompare(b.id);
}

function queueOrder(store: TaskStore, a: QueueEntry, b: QueueEntry): number {
  if (a.depth !== b.depth) return a.depth - b.depth;
  const at = store.get(a.taskId)?.createdAt ?? Number.MAX_SAFE_INTEGER;
  const bt = store.get(b.taskId)?.createdAt ?? Number.MAX_SAFE_INTEGER;
  if (at !== bt) return at - bt;
  return a.taskId.localeCompare(b.taskId) || a.viaParentId.localeCompare(b.viaParentId);
}

function addVia(node: LineageNode, viaParentId: string, diagnostics: TaskContextDiagnostics): boolean {
  if (node.viaParentIds.includes(viaParentId)) return false;
  if (node.viaParentIds.length >= MAX_VIA_PARENT_IDS) {
    markDiagnostic(diagnostics, "via-parent-ids");
    diagnostics.omittedCounts.viaParentIdsAtLeast += 1;
    return false;
  }
  node.viaParentIds.push(viaParentId);
  node.viaParentIds.sort();
  return true;
}

function traverseLineage(
  store: TaskStore,
  targetId: string,
  directParentIds: string[],
): { merged: Map<string, LineageNode>; diagnostics: TaskContextDiagnostics } {
  const diagnostics = emptyDiagnostics();
  const merged = new Map<string, LineageNode>();
  const expandedByRoute = new Set<string>();
  const queue: QueueEntry[] = directParentIds.map((taskId) => ({
    taskId,
    depth: 1,
    viaParentId: taskId,
  }));

  while (queue.length > 0) {
    queue.sort((a, b) => queueOrder(store, a, b));
    const entry = queue.shift()!;
    if (entry.taskId === targetId) continue;

    if (entry.depth > MAX_LINEAGE_DEPTH) {
      markDiagnostic(diagnostics, "depth");
      diagnostics.omittedCounts.depthAtLeast += 1;
      continue;
    }

    const task = store.get(entry.taskId);
    if (!task) {
      addMissing(diagnostics, entry.taskId);
      continue;
    }

    let node = merged.get(entry.taskId);
    let routeIsNew = false;
    if (!node) {
      if (merged.size >= MAX_LINEAGE_NODES) {
        markDiagnostic(diagnostics, "node-count");
        diagnostics.omittedCounts.nodeCountAtLeast += 1;
        continue;
      }
      node = {
        taskId: entry.taskId,
        depth: entry.depth,
        viaParentIds: [entry.viaParentId],
        createdAt: task.createdAt,
      };
      merged.set(entry.taskId, node);
      routeIsNew = true;
    } else {
      if (entry.depth < node.depth) node.depth = entry.depth;
      routeIsNew = addVia(node, entry.viaParentId, diagnostics);
    }

    const expansionKey = `${entry.taskId}\0${entry.viaParentId}`;
    if (!routeIsNew || expandedByRoute.has(expansionKey)) continue;
    expandedByRoute.add(expansionKey);

    for (const parentId of store.getParentIds(entry.taskId)) {
      if (parentId === targetId) continue;
      queue.push({
        taskId: parentId,
        depth: entry.depth + 1,
        viaParentId: entry.viaParentId,
      });
    }
  }

  return { merged, diagnostics };
}

function evidenceAvailability(task: Task): CodeAncestorCandidate["evidenceAvailability"] {
  if (task.worktreePath) return "live-worktree";
  if (task.worktreeBranch || task.harnessBranch || task.harnessCommit) return "durable-ref";
  return "unknown";
}

export function resolveTaskLineage(
  taskId: string,
  store: TaskStore,
): TaskContext | null {
  const target = store.get(taskId);
  if (!target) return null;

  const directParentIds = store.getParentIds(taskId);
  const { merged: visited, diagnostics } = traverseLineage(store, taskId, directParentIds);

  const directParents: DirectParentContext[] = [];
  const directParentTasks: Task[] = [];
  for (const pid of directParentIds) {
    const parent = store.get(pid);
    if (!parent) {
      addMissing(diagnostics, pid);
      continue;
    }
    // Direct parents participate in the same global output budget as inherited
    // ancestors. If traversal omitted a direct parent due to the node cap, do
    // not re-add it here and silently exceed the advertised bound.
    if (!visited.has(pid)) continue;
    directParentTasks.push(parent);
  }

  directParentTasks.sort(directParentOrder);
  for (const parent of directParentTasks) {
    directParents.push({
      kind: "direct-parent",
      parentId: parent.id,
      ...buildHandoff(parent),
      branch: parent.worktreeBranch ?? parent.harnessBranch ?? parent.harnessCommit ?? null,
      worktreePath: parent.worktreePath ?? parent.harnessCwd ?? null,
    });
  }

  const inheritedNodes = [...visited.entries()]
    .filter(([id]) => !directParentIds.includes(id))
    .map(([, node]) => node)
    .sort(lineageOrder);

  const inheritedParents: InheritedParentContext[] = [];
  for (const node of inheritedNodes) {
    const ancestor = store.get(node.taskId);
    if (!ancestor) {
      addMissing(diagnostics, node.taskId);
      continue;
    }
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

  const allResolvedIds = new Set([
    ...directParents.map((p) => p.taskId),
    ...inheritedParents.map((p) => p.taskId),
  ]);

  const codeCandidates: Array<{ taskId: string; depth: number; createdAt: number; viaParentIds: string[]; task: Task }> = [];
  for (const id of allResolvedIds) {
    const t = store.get(id);
    if (!t || !isCodeEvidenceCandidate(t)) continue;
    const node = visited.get(id);
    codeCandidates.push({
      taskId: id,
      depth: node?.depth ?? 1,
      createdAt: node?.createdAt ?? t.createdAt,
      viaParentIds: node?.viaParentIds.slice().sort() ?? [id],
      task: t,
    });
  }

  codeCandidates.sort((a, b) =>
    a.depth - b.depth ||
    a.createdAt - b.createdAt ||
    a.taskId.localeCompare(b.taskId),
  );

  const codeAncestors: CodeAncestorCandidate[] = codeCandidates.map((c) => ({
    taskId: c.taskId,
    title: c.task.title,
    taskKind: c.task.taskKind,
    column: c.task.column,
    branch: c.task.worktreeBranch ?? c.task.harnessBranch ?? c.task.harnessCommit ?? null,
    worktreePath: c.task.worktreePath ?? c.task.harnessCwd ?? null,
    changedFiles: c.task.completion?.changedFiles ?? [],
    summary: c.task.completion?.summary,
    hasStructuredHandoff: c.task.completion != null,
    depth: c.depth,
    viaParentIds: c.viaParentIds,
    evidenceAvailability: evidenceAvailability(c.task),
  }));

  return {
    task: buildHandoff(target),
    directParents,
    inheritedParents,
    codeAncestors,
    truncated: diagnostics.truncated,
    diagnostics,
  };
}
