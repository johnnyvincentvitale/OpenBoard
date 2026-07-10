import { describe, expect, it, vi } from "vitest";
import { clearAncestorSelection, createDiffLineageState, diffLineageHeader, evidenceSourceIds, fetchSelectedDiffEvidence, moveAncestorSelection, selectedCodeAncestor } from "../../src/tui/diff-lineage";
import type { TaskContext } from "../../src/shared";

function fixContext(): TaskContext {
  return {
    task: { taskId: "fix", title: "Fix", description: "", taskKind: "fix", column: "review", completion: null, changedFiles: [], verification: [], residualRisk: "", hasStructuredHandoff: false },
    directParents: [
      { kind: "direct-parent", parentId: "audit", taskId: "audit", title: "Audit", description: "", taskKind: "audit", column: "done", completion: null, changedFiles: [], verification: [], residualRisk: "", hasStructuredHandoff: false },
    ],
    inheritedParents: [
      { kind: "inherited-parent", taskId: "build", title: "Build", taskKind: "build", column: "done", depth: 2, viaParentIds: ["audit"], summary: "Implemented feature", hasStructuredHandoff: true },
    ],
    codeAncestors: [
      { taskId: "build", title: "Build", taskKind: "build", column: "done", branch: "board/build", changedFiles: ["src/a.ts"], hasStructuredHandoff: true },
    ],
  };
}

describe("diff lineage helpers", () => {
  it("uses context.codeAncestors, not direct parentIds, for selectable evidence", async () => {
    let state = createDiffLineageState(fixContext());
    expect(evidenceSourceIds(state)).toEqual(["build"]);
    expect(selectedCodeAncestor(state)).toBeUndefined();
    expect(diffLineageHeader(state, { kind: "diff", files: [], capped: false })).toBe("baseline task_diff · 0 files");

    state = moveAncestorSelection(state, 1);
    expect(selectedCodeAncestor(state)?.taskId).toBe("build");
    expect(diffLineageHeader(state, { kind: "diff", files: [{ file: "a", additions: 1, deletions: 0, status: "modified" }], capped: true })).toBe("compare Build (build) · depth 2 via audit · 1 file · capped");

    const client = { getTaskDiff: vi.fn(async () => ({ kind: "diff" as const, files: [], capped: false })), getTaskCompare: vi.fn(async () => ({ kind: "no-git" as const, reason: "missing worktree" })) };
    await fetchSelectedDiffEvidence(state, client);
    expect(client.getTaskDiff).not.toHaveBeenCalled();
    expect(client.getTaskCompare).toHaveBeenCalledWith("fix", "build");

    state = clearAncestorSelection(state);
    await fetchSelectedDiffEvidence(state, client);
    expect(client.getTaskDiff).toHaveBeenCalledWith("fix");
  });

  it("preserves honest no-git source metadata", () => {
    const state = moveAncestorSelection(createDiffLineageState(fixContext()), 1);
    expect(diffLineageHeader(state, { kind: "no-git", reason: "missing worktree" })).toBe("compare Build (build) · depth 2 via audit · no git: missing worktree");
  });
});
