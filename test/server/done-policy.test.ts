import { describe, expect, it } from "vitest";
import { blockedQuestion, type Task } from "../../src/shared";
import { evaluateDonePolicy } from "../../src/server/done-policy";

const blockedCompletion = {
  outcome: "blocked" as const,
  summary: "Could not continue",
  changedFiles: [],
  verification: [],
  residualRisk: "Need credentials",
  reportedAt: 123,
};

function task(input: Partial<Task>): Pick<Task, "completion" | "completionSource"> {
  return { completion: null, completionSource: null, ...input };
}

describe("Done policy", () => {
  it("allows ordinary successful cards unchanged", () => {
    const result = evaluateDonePolicy({
      task: task({ completionSource: "reported", completion: { ...blockedCompletion, outcome: "complete", residualRisk: "none" } }),
      completedBy: " Reviewer ",
    });

    expect(result).toEqual({ ok: true, acceptedBy: "Reviewer", blockedAccepted: false });
  });

  it("requires exact blocked acceptance for currently blocked reports", () => {
    const result = evaluateDonePolicy({
      task: task({ completionSource: "reported", completion: blockedCompletion }),
      blockedAcceptance: { blockedReportedAt: 123, acceptIncomplete: true },
      completedBy: "Reviewer",
    });

    expect(result).toEqual({ ok: true, acceptedBy: "Reviewer", blockedAccepted: true });
  });

  it("requires exact acceptance and attribution for watchdog blocked completions", () => {
    const current = task({ completionSource: "watchdog", completion: blockedCompletion });

    expect(evaluateDonePolicy({ task: current, completedBy: "Reviewer" })).toMatchObject({ ok: false, error: { code: "blocked_acceptance_required" } });
    expect(evaluateDonePolicy({ task: current, blockedAcceptance: { blockedReportedAt: 123, acceptIncomplete: true } })).toMatchObject({ ok: false, error: { code: "blocked_acceptance_attribution_required" } });
    expect(evaluateDonePolicy({ task: current, blockedAcceptance: { blockedReportedAt: 122, acceptIncomplete: true }, completedBy: "Reviewer" })).toMatchObject({ ok: false, error: { code: "blocked_acceptance_stale" } });
    expect(evaluateDonePolicy({ task: current, blockedAcceptance: { blockedReportedAt: 123, acceptIncomplete: true }, completedBy: "Reviewer" })).toEqual({ ok: true, acceptedBy: "Reviewer", blockedAccepted: true });
  });

  it("rejects missing, partial, stale, and unattributed blocked acceptance", () => {
    const current = task({ completionSource: "reported", completion: blockedCompletion });

    expect(evaluateDonePolicy({ task: current, completedBy: "Reviewer" })).toMatchObject({ ok: false, error: { code: "blocked_acceptance_required" } });
    expect(evaluateDonePolicy({ task: current, blockedAcceptance: { blockedReportedAt: 123 }, completedBy: "Reviewer" })).toMatchObject({ ok: false, error: { code: "blocked_acceptance_incomplete" } });
    expect(evaluateDonePolicy({ task: current, blockedAcceptance: { blockedReportedAt: 122, acceptIncomplete: true }, completedBy: "Reviewer" })).toMatchObject({ ok: false, error: { code: "blocked_acceptance_stale" } });
    expect(evaluateDonePolicy({ task: current, blockedAcceptance: { blockedReportedAt: 123, acceptIncomplete: true }, completedBy: " " })).toMatchObject({ ok: false, error: { code: "blocked_acceptance_attribution_required" } });
  });

  it("treats idle fallback or nonblocked reports as nonblocked", () => {
    expect(evaluateDonePolicy({ task: task({ completionSource: "idle-fallback", completion: null }) })).toEqual({ ok: true, acceptedBy: undefined, blockedAccepted: false });
    expect(evaluateDonePolicy({ task: task({ completionSource: "reported", completion: null }) })).toEqual({ ok: true, acceptedBy: undefined, blockedAccepted: false });
  });

  it("derives legacy blocked questions without changing completion JSON", () => {
    expect(blockedQuestion(blockedCompletion)).toBe("Need credentials");
    expect(blockedCompletion).not.toHaveProperty("needsInput");
    expect(blockedQuestion({ ...blockedCompletion, needsInput: "  What token should I use?  " })).toBe("What token should I use?");
  });
});
