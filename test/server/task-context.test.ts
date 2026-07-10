import { describe, expect, it } from "vitest";
import {
  taskExecutionContext,
  directParentPromptBlock,
} from "../../src/server/task-context";
import type { TaskContext } from "../../src/shared/lineage-context";

function buildLineage(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    task: {
      taskId: "child_1",
      title: "Child Task",
      description: "Do something",
      taskKind: "build",
      column: "todo",
      completion: null,
      changedFiles: [],
      verification: [],
      residualRisk: "",
      hasStructuredHandoff: false,
    },
    directParents: [],
    inheritedParents: [],
    codeAncestors: [],
    ...overrides,
  };
}

describe("task execution context", () => {
  it("returns null only for none", () => {
    expect(taskExecutionContext("none")).toBeNull();
    expect(taskExecutionContext(undefined)).toBeNull();
  });

  it("returns research context (now non-null)", () => {
    expect(taskExecutionContext("research")).not.toBeNull();
    expect(taskExecutionContext("research")).toContain("For research, the mode is:");
    expect(taskExecutionContext("research")).toContain("Do not edit code or run mutating commands.");
  });

  it("returns linked research context with task_context guidance", () => {
    const ctx = taskExecutionContext("research", { hasParents: true });
    expect(ctx).not.toBeNull();
    expect(ctx).toContain("task_context");
    expect(ctx).toContain("task_diff");
    expect(ctx).toContain("task_compare");
  });

  it("describes standalone build mode without implying parent context", () => {
    const context = taskExecutionContext("build");

    expect(context).toContain("OPENBOARD TASK CONTEXT");
    expect(context).toContain("Task type: build");
    expect(context).toContain("Create or modify the requested implementation/artifact in cwd.");
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
    expect(context).not.toContain("parent");
  });

  it("preserves linked synthesis mode with parent context guidance", () => {
    const context = taskExecutionContext("synthesis", { hasParents: true });

    expect(context).toContain("Read parent context first.");
    expect(context).toContain("task_context to retrieve full ancestor handoffs");
  });

  it("describes standalone audit and fix modes without implying parent context", () => {
    expect(taskExecutionContext("audit")).toContain("Inspect only unless explicitly told otherwise.");
    expect(taskExecutionContext("fix")).toContain("Resolve specific findings described in the card prompt or current cwd.");
  });

  it("preserves linked audit and fix modes with parent-oriented guidance", () => {
    expect(taskExecutionContext("audit", { hasParents: true })).toContain(
      "Inspect parent code changes with the openboard task_diff MCP tool first; use read-only parent worktree inspection as the fallback.",
    );
    expect(taskExecutionContext("fix", { hasParents: true })).toContain("Resolve specific findings from parent audit/build/synthesis context.");
  });
});

describe("directParentPromptBlock", () => {
  it("returns null for null lineage", () => {
    expect(directParentPromptBlock(null)).toBeNull();
  });

  it("returns null when no direct parents", () => {
    const lineage = buildLineage();
    expect(directParentPromptBlock(lineage)).toBeNull();
  });

  it("formats parent context block mentioning task_context and task_compare", () => {
    const lineage = buildLineage({
      directParents: [
        {
          kind: "direct-parent",
          parentId: "task_abc12345",
          taskId: "task_abc12345",
          title: "Build Parent",
          description: "Build the thing",
          taskKind: "build",
          column: "review",
          completion: {
            outcome: "complete",
            summary: "Implemented the feature",
            changedFiles: ["src/feat.ts", "test/feat.test.ts"],
            verification: [
              { command: "npm test", result: "passed" },
              { command: "npm run build", result: "ok" },
            ],
            residualRisk: "No integration tests",
            reportedAt: 1000,
          },
          changedFiles: ["src/feat.ts", "test/feat.test.ts"],
          verification: [
            { command: "npm test", result: "passed" },
            { command: "npm run build", result: "ok" },
          ],
          residualRisk: "No integration tests",
          summary: "Implemented the feature",
          hasStructuredHandoff: true,
        },
      ],
    });

    const block = directParentPromptBlock(lineage);

    expect(block).toContain("PARENT CONTEXT");
    expect(block).toContain("task_context");
    expect(block).toContain("task_compare");
    expect(block).toContain("task_diff");
    expect(block).toContain("PARENT-abc12345");
    expect(block).toContain("Build Parent");
    expect(block).toContain("Implemented the feature");
    expect(block).toContain("src/feat.ts");
    expect(block).toContain("test/feat.test.ts");
    expect(block).toContain("npm test: passed");
    expect(block).toContain("npm run build: ok");
    expect(block).toContain("No integration tests");
  });

  it("parent context block is emitted once per lineage, not per parent", () => {
    const lineage = buildLineage({
      directParents: [
        {
          kind: "direct-parent",
          parentId: "task_aaa",
          taskId: "task_aaa",
          title: "A",
          description: "A",
          completion: null,
          changedFiles: [],
          verification: [],
          residualRisk: "",
          hasStructuredHandoff: false,
        },
        {
          kind: "direct-parent",
          parentId: "task_bbb",
          taskId: "task_bbb",
          title: "B",
          description: "B",
          completion: null,
          changedFiles: [],
          verification: [],
          residualRisk: "",
          hasStructuredHandoff: false,
        },
      ],
    });

    const block = directParentPromptBlock(lineage);
    // The PARENT CONTEXT header and tool guidance appear once.
    const headerCount = (block!.match(/PARENT CONTEXT/g) || []).length;
    expect(headerCount).toBe(1);
    // Each parent gets its own section header.
    const parentHeaders = (block!.match(/PARENT-task_/g) || []).length;
    expect(parentHeaders).toBe(2);
  });
});
