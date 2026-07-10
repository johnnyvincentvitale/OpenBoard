import { describe, it, expect, beforeEach } from "vitest";
import type { CompletionReport } from "../../src/shared";
import { SqliteTaskStore } from "../../src/db/task-store";
import { resolveTaskLineage } from "../../src/server/task-lineage";

function buildCompletion(overrides: Partial<CompletionReport> = {}): CompletionReport {
  return {
    outcome: "complete",
    summary: "Done",
    changedFiles: ["src/a.ts"],
    verification: [{ command: "npm test", result: "passed" }],
    residualRisk: "none",
    reportedAt: 2000,
    ...overrides,
  };
}

describe("resolveTaskLineage", () => {
  let clock: number;
  let idCounter: number;
  let store: SqliteTaskStore;

  function create(opts: {
    title?: string;
    description?: string;
    taskKind?: string;
    column?: string;
    completion?: CompletionReport | null;
    createdAt?: number;
  } = {}) {
    // Advance clock so each task gets a distinct createdAt.
    clock += 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = store.create({
      title: opts.title ?? "Task",
      description: opts.description ?? "desc",
      directory: "/repo",
      taskKind: (opts.taskKind as any) ?? "none",
    });
    if (opts.column && opts.column !== "todo") {
      store.move(t.id, opts.column as any, 0);
    }
    if (opts.completion !== undefined) {
      store.setCompletion(t.id, opts.completion!, "reported");
    }
    return store.get(t.id)!;
  }

  function link(parentId: string, childId: string) {
    store.addLink(parentId, childId);
  }

  beforeEach(() => {
    clock = 1000;
    idCounter = 0;
    store = new SqliteTaskStore(":memory:", {
      now: () => clock,
      genId: () => `task_${++idCounter}`,
    });
  });

  it("returns null for unknown task id", () => {
    expect(resolveTaskLineage("task_missing", store)).toBeNull();
  });

  it("returns target handoff with description and empty ancestors for orphan task", () => {
    const target = create({ title: "Lone Task", description: "Do it alone" });
    const result = resolveTaskLineage(target.id, store);

    expect(result).not.toBeNull();
    expect(result!.task.taskId).toBe(target.id);
    expect(result!.task.title).toBe("Lone Task");
    expect(result!.task.description).toBe("Do it alone");
    expect(result!.directParents).toEqual([]);
    expect(result!.inheritedParents).toEqual([]);
    expect(result!.codeAncestors).toEqual([]);
  });

  describe("linear lineage", () => {
    it("resolves a simple A -> B -> C chain", () => {
      const grandparent = create({ title: "Grandparent", taskKind: "research" });
      const parent = create({ title: "Parent", taskKind: "synthesis" });
      const child = create({ title: "Child", taskKind: "build" });

      link(grandparent.id, parent.id);
      link(parent.id, child.id);

      const result = resolveTaskLineage(child.id, store);

      expect(result).not.toBeNull();
      expect(result!.task.taskId).toBe(child.id);
      expect(result!.directParents).toHaveLength(1);
      expect(result!.directParents[0].taskId).toBe(parent.id);
      expect(result!.directParents[0].kind).toBe("direct-parent");
      expect(result!.directParents[0].parentId).toBe(parent.id);

      expect(result!.inheritedParents).toHaveLength(1);
      expect(result!.inheritedParents[0].taskId).toBe(grandparent.id);
      expect(result!.inheritedParents[0].kind).toBe("inherited-parent");
      expect(result!.inheritedParents[0].depth).toBe(2);
      expect(result!.inheritedParents[0].viaParentIds).toEqual([parent.id]);

      expect(result!.codeAncestors).toEqual([]);
    });

    it("preserves full handoff data including description for direct parents", () => {
      const completion = buildCompletion({ summary: "Parent is done" });
      const parent = create({ title: "Parent", description: "Parent desc", taskKind: "build", completion, column: "review" });
      const child = create({ title: "Child", taskKind: "fix" });

      link(parent.id, child.id);

      const result = resolveTaskLineage(child.id, store);

      expect(result!.directParents[0].summary).toBe("Parent is done");
      expect(result!.directParents[0].description).toBe("Parent desc");
      expect(result!.directParents[0].changedFiles).toEqual(["src/a.ts"]);
      expect(result!.directParents[0].verification).toEqual([{ command: "npm test", result: "passed" }]);
      expect(result!.directParents[0].residualRisk).toBe("none");
      expect(result!.directParents[0].hasStructuredHandoff).toBe(true);
    });
  });

  describe("multi-parent fanout", () => {
    it("resolves multiple direct parents from different research/synthesis branches", () => {
      const researchA = create({ title: "Research A", taskKind: "research" });
      const researchB = create({ title: "Research B", taskKind: "research" });
      const synthesis = create({ title: "Synthesis", taskKind: "synthesis" });

      link(researchA.id, synthesis.id);
      link(researchB.id, synthesis.id);

      const result = resolveTaskLineage(synthesis.id, store);

      expect(result!.directParents).toHaveLength(2);
      expect(result!.directParents.map((p) => p.taskId).sort()).toEqual(
        [researchA.id, researchB.id].sort(),
      );
      expect(result!.inheritedParents).toEqual([]);
    });

    it("resolves inherited ancestors from both parent branches", () => {
      const rootA = create({ title: "Root A", taskKind: "research" });
      const rootB = create({ title: "Root B", taskKind: "audit" });
      const parentA = create({ title: "Parent A", taskKind: "research" });
      const parentB = create({ title: "Parent B", taskKind: "audit" });
      const child = create({ title: "Child", taskKind: "build" });

      link(rootA.id, parentA.id);
      link(rootB.id, parentB.id);
      link(parentA.id, child.id);
      link(parentB.id, child.id);

      const result = resolveTaskLineage(child.id, store);

      expect(result!.directParents).toHaveLength(2);
      expect(result!.inheritedParents).toHaveLength(2);

      const inheritedIds = result!.inheritedParents.map((p) => p.taskId).sort();
      expect(inheritedIds).toEqual([rootA.id, rootB.id].sort());

      for (const ip of result!.inheritedParents) {
        expect(ip.depth).toBe(2);
        expect(ip.viaParentIds.length).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe("diamond patterns", () => {
    it("merges viaParentIds when an ancestor is reachable through multiple paths", () => {
      //     root
      //    /    \
      //  left  right
      //    \    /
      //    child
      const root = create({ title: "Root", taskKind: "research" });
      const left = create({ title: "Left", taskKind: "research" });
      const right = create({ title: "Right", taskKind: "synthesis" });
      const child = create({ title: "Child", taskKind: "build" });

      link(root.id, left.id);
      link(root.id, right.id);
      link(left.id, child.id);
      link(right.id, child.id);

      const result = resolveTaskLineage(child.id, store);

      expect(result!.directParents).toHaveLength(2);
      expect(result!.inheritedParents).toHaveLength(1);
      expect(result!.inheritedParents[0].taskId).toBe(root.id);
      expect(result!.inheritedParents[0].depth).toBe(2); // minimum depth
      expect(result!.inheritedParents[0].viaParentIds.sort()).toEqual(
        [left.id, right.id].sort(),
      );
    });

    it("propagates merged viaParentIds through a reconverged node to its own parent", () => {
      //     superRoot
      //        |
      //       root
      //      /    \
      //    left  right
      //      \    /
      //      child
      //
      // superRoot should see both viaParentIds [left, right]
      // even though it's above the diamond merge point.
      const superRoot = create({ title: "SuperRoot", taskKind: "research" });
      const root = create({ title: "Root", taskKind: "research" });
      const left = create({ title: "Left", taskKind: "research" });
      const right = create({ title: "Right", taskKind: "synthesis" });
      const child = create({ title: "Child", taskKind: "build" });

      link(superRoot.id, root.id);
      link(root.id, left.id);
      link(root.id, right.id);
      link(left.id, child.id);
      link(right.id, child.id);

      const result = resolveTaskLineage(child.id, store);

      // Inherited ancestors: root (depth 2), superRoot (depth 3)
      // Both left and right are direct parents.
      expect(result!.inheritedParents).toHaveLength(2);

      const rootInherited = result!.inheritedParents.find((p) => p.taskId === root.id);
      expect(rootInherited).toBeDefined();
      expect(rootInherited!.depth).toBe(2);
      expect(rootInherited!.viaParentIds.sort()).toEqual([left.id, right.id].sort());

      const superInherited = result!.inheritedParents.find((p) => p.taskId === superRoot.id);
      expect(superInherited).toBeDefined();
      expect(superInherited!.depth).toBe(3);
      // superRoot has root as its only child, but root is reachable from both
      // left and right, so superRoot inherits BOTH viaParentIds.
      expect(superInherited!.viaParentIds.sort()).toEqual([left.id, right.id].sort());
    });
  });

  describe("cycle safety", () => {
    it("terminates on A -> B -> A cycle without infinite loop", () => {
      const taskA = create({ title: "A" });
      const taskB = create({ title: "B", taskKind: "build" });

      link(taskA.id, taskB.id);
      link(taskB.id, taskA.id);

      const resultA = resolveTaskLineage(taskA.id, store);
      expect(resultA).not.toBeNull();
      expect(resultA!.directParents).toHaveLength(1);
      expect(resultA!.directParents[0].taskId).toBe(taskB.id);
      expect(resultA!.inheritedParents).toEqual([]);
    });

    it("terminates on longer cycle A -> B -> C -> A", () => {
      const taskA = create({ title: "A" });
      const taskB = create({ title: "B" });
      const taskC = create({ title: "C" });

      link(taskA.id, taskB.id);
      link(taskB.id, taskC.id);
      link(taskC.id, taskA.id);

      const result = resolveTaskLineage(taskA.id, store);
      expect(result).not.toBeNull();
      expect(result!.directParents).toHaveLength(1);
      // B is reachable from C (depth 2)
      expect(result!.inheritedParents).toHaveLength(1);
      expect(result!.inheritedParents[0].taskId).toBe(taskB.id);
      expect(result!.inheritedParents[0].depth).toBe(2);
    });
  });

  describe("missing / unlinked tasks", () => {
    it("skips missing parent tasks gracefully", () => {
      const child = create({ title: "Child" });
      const db = (store as any).db;
      db.pragma("foreign_keys = OFF");
      db.prepare("INSERT INTO task_links (parent_id, child_id) VALUES (?, ?)").run(
        "task_missing",
        child.id,
      );
      db.pragma("foreign_keys = ON");

      const result = resolveTaskLineage(child.id, store);
      expect(result).not.toBeNull();
      expect(result!.directParents).toEqual([]);
    });

    it("skips missing grandparent but still resolves existing parent", () => {
      const parent = create({ title: "Parent" });
      const child = create({ title: "Child" });

      link(parent.id, child.id);

      const db = (store as any).db;
      db.pragma("foreign_keys = OFF");
      db.prepare("INSERT INTO task_links (parent_id, child_id) VALUES (?, ?)").run(
        "task_missing_gp",
        parent.id,
      );
      db.pragma("foreign_keys = ON");

      const result = resolveTaskLineage(child.id, store);
      expect(result!.directParents).toHaveLength(1);
      expect(result!.directParents[0].taskId).toBe(parent.id);
      expect(result!.inheritedParents).toEqual([]);
    });
  });

  describe("code ancestor candidates", () => {
    it("identifies nearest Review/Done build/fix ancestors ordered by depth then createdAt", () => {
      const buildDone = create({
        title: "Build Done",
        taskKind: "build",
        column: "done",
        completion: buildCompletion({ changedFiles: ["src/mod.ts"] }),
      });
      const researchDone = create({
        title: "Research Done",
        taskKind: "research",
        column: "done",
        completion: buildCompletion(),
      });
      const buildReview = create({
        title: "Build Review",
        taskKind: "build",
        column: "review",
        completion: buildCompletion({ changedFiles: ["src/reviewed.ts"] }),
      });
      const child = create({ title: "Child", taskKind: "fix" });

      link(buildDone.id, child.id);
      link(researchDone.id, child.id);
      link(buildReview.id, child.id);

      const result = resolveTaskLineage(child.id, store);

      // Only build/fix in Review/Done qualify
      expect(result!.codeAncestors).toHaveLength(2);
      const ids = result!.codeAncestors.map((c) => c.taskId);
      // Build Done created first (before Build Review)
      expect(ids[0]).toBe(buildDone.id);
      expect(ids[1]).toBe(buildReview.id);
    });

    it("excludes build/fix ancestors not in Review or Done", () => {
      const buildInProgress = create({
        title: "Build In Progress",
        taskKind: "build",
        column: "in_progress",
        completion: buildCompletion(),
      });
      const child = create({ title: "Child", taskKind: "fix" });

      link(buildInProgress.id, child.id);

      const result = resolveTaskLineage(child.id, store);
      expect(result!.codeAncestors).toEqual([]);
    });

    it("includes inherited code-evidence ancestors", () => {
      const gpBuild = create({
        title: "GP Build",
        taskKind: "build",
        column: "done",
        completion: buildCompletion({ changedFiles: ["src/gp.ts"] }),
      });
      const parentResearch = create({
        title: "Parent Research",
        taskKind: "research",
        column: "done",
        completion: buildCompletion(),
      });
      const child = create({ title: "Child", taskKind: "fix" });

      link(gpBuild.id, parentResearch.id);
      link(parentResearch.id, child.id);

      const result = resolveTaskLineage(child.id, store);
      expect(result!.codeAncestors).toHaveLength(1);
      expect(result!.codeAncestors[0].taskId).toBe(gpBuild.id);
      expect(result!.codeAncestors[0].changedFiles).toEqual(["src/gp.ts"]);
    });

    it("populates branch and worktreePath on code candidates", () => {
      const buildParent = create({
        title: "Build Parent",
        taskKind: "build",
        column: "done",
        completion: buildCompletion(),
      });
      const child = create({ title: "Child", taskKind: "fix" });

      store.update(buildParent.id, {
        worktreeBranch: "board/task_1",
        worktreePath: "/tmp/worktrees/task_1",
      });

      link(buildParent.id, child.id);

      const result = resolveTaskLineage(child.id, store);
      expect(result!.codeAncestors[0].branch).toBe("board/task_1");
      expect(result!.codeAncestors[0].worktreePath).toBe("/tmp/worktrees/task_1");
    });
  });

  describe("deterministic ordering", () => {
    it("orders direct parents by createdAt then taskId", () => {
      // Create tasks in order: pC, pA, pB. pC has earliest createdAt.
      const pC = create({ title: "pC" });
      const pA = create({ title: "pA" });
      const pB = create({ title: "pB" });
      const child = create({ title: "Child" });

      link(pC.id, child.id);
      link(pA.id, child.id);
      link(pB.id, child.id);

      const result = resolveTaskLineage(child.id, store);
      const ids = result!.directParents.map((p) => p.taskId);

      // pC has earliest createdAt, then pA, then pB.
      expect(ids).toEqual([pC.id, pA.id, pB.id]);
    });

    it("orders inherited parents by depth then createdAt then taskId", () => {
      // Tree: gpB (created earliest) -> parentB -> child
      //       gpA (created later)  -> parentA -> child
      const gpB = create({ title: "gpB", taskKind: "research" });
      const gpA = create({ title: "gpA", taskKind: "research" });
      const parentB = create({ title: "parentB" });
      const parentA = create({ title: "parentA" });
      const child = create({ title: "Child" });

      link(gpB.id, parentB.id);
      link(gpA.id, parentA.id);
      link(parentB.id, child.id);
      link(parentA.id, child.id);

      const result = resolveTaskLineage(child.id, store);

      // Both inherited at depth 2; gpB created before gpA
      expect(result!.inheritedParents).toHaveLength(2);
      expect(result!.inheritedParents[0].taskId).toBe(gpB.id);
      expect(result!.inheritedParents[1].taskId).toBe(gpA.id);
    });

    it("idempotent: same lineage called twice returns same order", () => {
      const pC = create({ title: "pC" });
      const pA = create({ title: "pA" });
      const pB = create({ title: "pB" });
      const child = create({ title: "Child" });

      link(pC.id, child.id);
      link(pA.id, child.id);
      link(pB.id, child.id);

      const result1 = resolveTaskLineage(child.id, store);
      const result2 = resolveTaskLineage(child.id, store);

      expect(result1!.directParents.map((p) => p.taskId)).toEqual(
        result2!.directParents.map((p) => p.taskId),
      );
    });
  });

  describe("traversal bounds", () => {
    it("leaves truncated unset/false when a small graph fits well within the bounds", () => {
      const grandparent = create({ title: "Grandparent", taskKind: "research" });
      const parent = create({ title: "Parent", taskKind: "synthesis" });
      const child = create({ title: "Child", taskKind: "build" });

      link(grandparent.id, parent.id);
      link(parent.id, child.id);

      const result = resolveTaskLineage(child.id, store);
      expect(result!.truncated).toBe(false);
    });

    it("caps a deep linear chain at the depth bound, sets truncated, and preserves ordering up to the cap", () => {
      // Build a chain of 25 ancestors feeding into `child` through a single
      // direct parent: root -> link1 -> ... -> link23 -> directParent -> child.
      // Depth cap is 16, so only depth 1 (direct parent) through depth 16
      // (15 inherited ancestors) should be collected; anything deeper must be
      // omitted and `truncated` must be set.
      const CHAIN_LENGTH = 25;
      const chain = [create({ title: "chain-0" })];
      for (let i = 1; i < CHAIN_LENGTH; i++) {
        const next = create({ title: `chain-${i}` });
        link(chain[i - 1].id, next.id);
        chain.push(next);
      }
      const directParent = chain[chain.length - 1];
      const child = create({ title: "Child", taskKind: "build" });
      link(directParent.id, child.id);

      const result = resolveTaskLineage(child.id, store);

      expect(result!.truncated).toBe(true);
      expect(result!.directParents).toHaveLength(1);
      expect(result!.directParents[0].taskId).toBe(directParent.id);

      // depth 1 (direct parent) + depth 2..16 inherited = 15 inherited nodes.
      expect(result!.inheritedParents).toHaveLength(15);
      const depths = result!.inheritedParents.map((p) => p.depth);
      expect(Math.max(...depths)).toBe(16);
      expect(Math.min(...depths)).toBe(2);

      // Ordering (depth, createdAt, id) is preserved among the surviving nodes.
      const sorted = [...result!.inheritedParents].sort(
        (a, b) => a.depth - b.depth || a.taskId.localeCompare(b.taskId),
      );
      expect(result!.inheritedParents.map((p) => p.taskId)).toEqual(
        sorted.map((p) => p.taskId),
      );

      // The chain's earliest root ancestors (beyond depth 16) must not appear.
      const rootId = chain[0].id;
      expect(result!.inheritedParents.some((p) => p.taskId === rootId)).toBe(false);
    });

    it("caps a wide fan-out at the node-count bound and sets truncated, while keeping dedup and diamond merging correct within the cap", () => {
      // One direct parent with 260 of its own distinct parents (grandparents
      // of `child`). 260 > MAX_LINEAGE_NODES(256), so the branch-level
      // node-count cap must trigger, and the surviving set must still be
      // internally consistent (no duplicates).
      const WIDE_COUNT = 260;
      const directParent = create({ title: "DirectParent", taskKind: "synthesis" });
      const grandparents = [];
      for (let i = 0; i < WIDE_COUNT; i++) {
        const gp = create({ title: `gp-${i}`, taskKind: "research" });
        link(gp.id, directParent.id);
        grandparents.push(gp);
      }
      const child = create({ title: "Child", taskKind: "build" });
      link(directParent.id, child.id);

      const result = resolveTaskLineage(child.id, store);

      expect(result!.truncated).toBe(true);
      expect(result!.directParents).toHaveLength(1);

      // Total collected ancestors (direct parent + inherited) must not
      // exceed the global node cap.
      const totalCollected = result!.directParents.length + result!.inheritedParents.length;
      expect(totalCollected).toBeLessThanOrEqual(256);

      // Every inherited node must be a distinct grandparent (no duplicates
      // introduced by the bounded traversal).
      const inheritedIds = result!.inheritedParents.map((p) => p.taskId);
      expect(new Set(inheritedIds).size).toBe(inheritedIds.length);
      for (const id of inheritedIds) {
        expect(grandparents.some((gp) => gp.id === id)).toBe(true);
      }

      // Not every grandparent made it in — proves the cap actually bound
      // the traversal rather than silently allowing everything through.
      expect(inheritedIds.length).toBeLessThan(WIDE_COUNT);
    });

    it("still merges viaParentIds correctly through a diamond that stays well within the bounds", () => {
      // Sanity check that adding caps did not disturb small-graph diamond
      // dedup behavior (already covered above, re-asserted here alongside
      // the bound-specific tests for locality).
      const root = create({ title: "Root", taskKind: "research" });
      const left = create({ title: "Left", taskKind: "research" });
      const right = create({ title: "Right", taskKind: "synthesis" });
      const child = create({ title: "Child", taskKind: "build" });

      link(root.id, left.id);
      link(root.id, right.id);
      link(left.id, child.id);
      link(right.id, child.id);

      const result = resolveTaskLineage(child.id, store);

      expect(result!.truncated).toBe(false);
      expect(result!.inheritedParents).toHaveLength(1);
      expect(result!.inheritedParents[0].viaParentIds.sort()).toEqual(
        [left.id, right.id].sort(),
      );
    });
  });

  describe("task handoff fields", () => {
    it("returns hasStructuredHandoff false for tasks without completion", () => {
      const parent = create({ title: "No Completion Parent" });
      const child = create({ title: "Child" });

      link(parent.id, child.id);

      const result = resolveTaskLineage(child.id, store);
      expect(result!.directParents[0].hasStructuredHandoff).toBe(false);
      expect(result!.directParents[0].changedFiles).toEqual([]);
      expect(result!.directParents[0].verification).toEqual([]);
      expect(result!.directParents[0].residualRisk).toBe("");
      expect(result!.directParents[0].summary).toBeUndefined();
    });

    it("returns completion data for target task", () => {
      const comp = buildCompletion({ summary: "Target complete", residualRisk: "low" });
      const target = create({ title: "Target", completion: comp, column: "done" });

      const result = resolveTaskLineage(target.id, store);
      expect(result!.task.completion).not.toBeNull();
      expect(result!.task.completion!.summary).toBe("Target complete");
      expect(result!.task.residualRisk).toBe("low");
      expect(result!.task.hasStructuredHandoff).toBe(true);
    });
  });
});
