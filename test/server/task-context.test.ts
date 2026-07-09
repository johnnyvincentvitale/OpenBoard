import { describe, expect, it } from "vitest";
import { taskExecutionContext } from "../../src/server/task-context";

describe("task execution context", () => {
  it("does not add dispatch context for none or research", () => {
    expect(taskExecutionContext("none")).toBeNull();
    expect(taskExecutionContext("research")).toBeNull();
    expect(taskExecutionContext(undefined)).toBeNull();
  });

  it("describes standalone build mode without implying parent context", () => {
    const context = taskExecutionContext("build");

    expect(context).toContain("OPENBOARD TASK CONTEXT");
    expect(context).toContain("Task type: build");
    expect(context).toContain("Create or modify the requested implementation/artifact in cwd.");
    expect(context).toContain("If starting from scratch, establish the minimal structure needed for the requested result.");
    expect(context).toContain("If modifying existing work, inspect the relevant cwd files before editing.");
    expect(context).toContain("Use the card prompt and cwd evidence as the source of truth.");
    expect(context).not.toContain("parent context");
    expect(context).toContain("Run relevant verification.");
    expect(context).toContain("Do not move/accept/integrate the card.");
  });

  it("describes linked build mode with parent context guidance", () => {
    const context = taskExecutionContext("build", { hasParents: true });

    expect(context).toContain("Use parent context as constraints/input, not as a substitute for inspecting cwd.");
  });

  it("describes standalone synthesis mode without implying parent context", () => {
    const context = taskExecutionContext("synthesis");

    expect(context).toContain("Task type: synthesis");
    expect(context).toContain("For synthesis, the mode is:");
    expect(context).toContain("Use the card prompt and any named files as the input.");
    expect(context).toContain("Evaluate evidence for agreement, conflict, evidence strength, gaps, and implications.");
    expect(context).not.toContain("parent");
    expect(context).toContain("Preserve the user/card prompt as the authority for the actual output shape.");
    expect(context).toContain("Do not implement build changes unless explicitly asked.");
    expect(context).toContain("Surface unresolved questions or human decisions when they affect the requested output.");
  });

  it("preserves linked synthesis mode with parent context guidance", () => {
    const context = taskExecutionContext("synthesis", { hasParents: true });

    expect(context).toContain("Read parent context first.");
    expect(context).toContain("Evaluate parent findings for agreement, conflict, evidence strength, gaps, and implications.");
  });

  it("describes standalone audit and fix modes without implying parent context", () => {
    expect(taskExecutionContext("audit")).toContain("Inspect only unless explicitly told otherwise.");
    expect(taskExecutionContext("audit")).toContain("Review the requested files, diffs, tests, and behavior in cwd.");
    expect(taskExecutionContext("fix")).toContain("Resolve specific findings described in the card prompt or current cwd.");
    expect(taskExecutionContext("fix")).toContain("Tie each change back to the finding or defect it addresses.");
    expect(taskExecutionContext("fix")).toContain("Call out unfixed findings or assumptions.");
  });

  it("preserves linked audit and fix modes with parent-oriented guidance", () => {
    expect(taskExecutionContext("audit", { hasParents: true })).toContain(
      "Inspect parent code changes with the openboard task_diff MCP tool first; use read-only parent worktree inspection as the fallback.",
    );
    expect(taskExecutionContext("audit", { hasParents: true })).toContain("Review diffs, tests, and behavior.");
    expect(taskExecutionContext("fix", { hasParents: true })).toContain("Resolve specific findings from parent audit/build/synthesis context.");
    expect(taskExecutionContext("fix", { hasParents: true })).toContain(
      "Use audit parents for findings. Use the openboard task_diff MCP tool on the code-bearing (build) parent for the code changes; do not read sibling worktree files directly when the diff is available.",
    );
    expect(taskExecutionContext("fix", { hasParents: true })).toContain(
      "Your cwd starts from the base branch: reapply the parent changes your fix depends on into cwd first, then apply the fix.",
    );
    expect(taskExecutionContext("fix", { hasParents: true })).toContain("Tie each change back to the finding it addresses.");
  });
});
