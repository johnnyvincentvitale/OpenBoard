import { describe, expect, it } from "vitest";
import { taskExecutionContext } from "../../src/server/task-context";

describe("task execution context", () => {
  it("does not add dispatch context for none or research", () => {
    expect(taskExecutionContext("none")).toBeNull();
    expect(taskExecutionContext("research")).toBeNull();
    expect(taskExecutionContext(undefined)).toBeNull();
  });

  it("describes build mode", () => {
    const context = taskExecutionContext("build");

    expect(context).toContain("OPENBOARD TASK CONTEXT");
    expect(context).toContain("Task type: build");
    expect(context).toContain("Create or modify the requested implementation/artifact in cwd.");
    expect(context).toContain("If starting from scratch, establish the minimal structure needed for the requested result.");
    expect(context).toContain("If modifying existing work, inspect the relevant cwd files before editing.");
    expect(context).toContain("Use parent context as constraints/input, not as a substitute for inspecting cwd.");
    expect(context).toContain("Run relevant verification.");
    expect(context).toContain("Do not move/accept/integrate the card.");
  });

  it("describes synthesis mode", () => {
    const context = taskExecutionContext("synthesis");

    expect(context).toContain("Task type: synthesis");
    expect(context).toContain("For synthesis, the mode is:");
    expect(context).toContain("Read parent context first.");
    expect(context).toContain("Evaluate parent findings for agreement, conflict, evidence strength, gaps, and implications.");
    expect(context).toContain("Preserve the user/card prompt as the authority for the actual output shape.");
    expect(context).toContain("Do not implement build changes unless explicitly asked.");
    expect(context).toContain("Surface unresolved questions or human decisions when they affect the requested output.");
  });

  it("describes audit and fix modes", () => {
    expect(taskExecutionContext("audit")).toContain("Inspect only unless explicitly told otherwise.");
    expect(taskExecutionContext("audit")).toContain("Produce findings with severity/confidence and residual risk.");
    expect(taskExecutionContext("fix")).toContain("Resolve specific findings from parent audit/build/synthesis context.");
    expect(taskExecutionContext("fix")).toContain("Tie each change back to the finding it addresses.");
    expect(taskExecutionContext("fix")).toContain("Call out unfixed findings.");
  });
});
