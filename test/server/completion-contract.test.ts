import { describe, expect, it } from "vitest";
import { completionHandoffGuidance } from "../../src/server/completion-contract";

describe("completion handoff guidance", () => {
  it("describes the generic handoff for none", () => {
    const guidance = completionHandoffGuidance("none");

    expect(guidance).toContain("Task type: none");
    expect(guidance).toContain("- summary: what happened.");
    expect(guidance).toContain("- changedFiles: files changed, if any.");
    expect(guidance).toContain("- verification: commands/checks run.");
    expect(guidance).toContain("- residualRisk: what remains uncertain or blocked.");
  });

  it("describes research handoffs as factual evidence gathering", () => {
    const guidance = completionHandoffGuidance("research");

    expect(guidance).toContain("Task type: research");
    expect(guidance).toContain("factual findings, sources inspected, repo areas read, or evidence gathered");
    expect(guidance).toContain("not applicable: research only");
    expect(guidance).toContain("source gaps, confidence limits, unverified claims, missing access");
  });

  it("describes standalone synthesis handoffs without implying parent handoffs", () => {
    const guidance = completionHandoffGuidance("synthesis");

    expect(guidance).toContain("Task type: synthesis");
    expect(guidance).toContain("evaluation of the requested material");
    expect(guidance).toContain("files/sources read");
    expect(guidance).not.toContain("parent");
    expect(guidance).toContain("ideas to avoid, questions for human");
    expect(guidance).toContain("proposed build/audit graph");
  });

  it("preserves linked synthesis handoffs with parent wording", () => {
    const guidance = completionHandoffGuidance("synthesis", { hasParents: true });

    expect(guidance).toContain("evaluation of parent findings");
    expect(guidance).toContain("parent handoffs/raw files read");
  });

  it("describes build, audit, and fix handoffs with role-specific expectations", () => {
    expect(completionHandoffGuidance("build")).toContain("implementation completed and behavior changed");
    expect(completionHandoffGuidance("audit")).toContain("Be finding-oriented, not implementation-oriented.");
    expect(completionHandoffGuidance("fix")).toContain("which finding or defect it resolves");
    expect(completionHandoffGuidance("fix", { hasParents: true })).toContain("which audit/build/synthesis finding it resolves");
  });
});
