import { describe, expect, it } from "vitest";
import { backspaceBlockedAnswerDraft, blockedAnswerDraftKey, blockedAnswerSubmitLabel, createBlockedAnswerDraft, editBlockedAnswerDraft, lineDeleteBlockedAnswerDraft, staleBlockedAnswerDraft } from "../../src/tui/blocked-answer";
import type { Task } from "../../src/shared";

function blockedTask(reportedAt = 123): Task {
  return {
    id: "task-1",
    title: "Blocked",
    description: "",
    directory: "/repo",
    column: "review",
    position: 0,
    runState: "idle",
    baseCommit: null,
    dirtyAtDispatch: false,
    createdAt: 0,
    updatedAt: 0,
    completionSource: "reported",
    completion: { outcome: "blocked", summary: "Need input", changedFiles: [], verification: [], residualRisk: "Pick A or B", reportedAt },
  };
}

describe("blocked answer composer helpers", () => {
  it("keys and edits drafts against the exact blocked report", () => {
    let draft = createBlockedAnswerDraft(blockedTask())!;
    expect(blockedAnswerDraftKey(draft.taskId, draft.blockedReportedAt)).toBe("task-1:123");
    expect(blockedAnswerSubmitLabel(draft)).toBe("plain-retry");
    draft = editBlockedAnswerDraft(draft, "Use A\nbecause safe");
    expect(blockedAnswerSubmitLabel(draft)).toBe("answer-blocked");
    draft = lineDeleteBlockedAnswerDraft(draft);
    expect(draft.text).toBe("Use A\n");
    draft = backspaceBlockedAnswerDraft(draft);
    expect(draft.text).toBe("Use A");
  });

  it("detects stale blocked questions while preserving the draft object", () => {
    const draft = createBlockedAnswerDraft(blockedTask(123))!;
    expect(staleBlockedAnswerDraft(blockedTask(456), draft)).toBe(true);
    expect(staleBlockedAnswerDraft(blockedTask(123), draft)).toBe(false);
  });
});
