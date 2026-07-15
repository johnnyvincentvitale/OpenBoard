import { describe, it, expect } from "vitest";
import {
  COLUMNS,
  COLUMN_LABELS,
  DEFAULT_COLUMN,
  isColumn,
  LIVE_STATES,
  isLiveState,
  TERMINAL_ROUTE_PATTERNS,
  buildTerminalPath,
  ERROR_CODES,
  ERROR_STATUS,
  OPENCODE_DEFAULTS,
  BOARD_SERVER_DEFAULTS,
  AdapterError,
  buildTaskPath,
  resolveOpenCodePermissionRules,
  canAutoRun,
  UNATTENDED_PERMISSION,
  WRITE_FENCED_PERMISSION,
  OPENBOARD_WORKER_DENIED_TOOL_IDS,
  OPENBOARD_WORKER_PERMISSION_DENIALS,
  OPENBOARD_WORKER_TOOL_NAMES,
  TASK_HARNESSES,
  CODEX_MODELS,
  GEMINI_ACP_MODELS,
  HERMES_MODELS,
  PI_CODING_AGENT_MODELS,
  CURSOR_ACP_MODELS,
  TASK_ROUTE_PATTERNS,
  blockedQuestion,
} from "../../src/shared/index";

describe("frozen contracts", () => {
  it("columns are the four workflow columns with labels", () => {
    expect(COLUMNS).toEqual(["todo", "in_progress", "review", "done"]);
    for (const c of COLUMNS) expect(COLUMN_LABELS[c]).toBeTruthy();
    expect(COLUMNS).toContain(DEFAULT_COLUMN);
    expect(isColumn("todo")).toBe(true);
    expect(isColumn("nope")).toBe(false);
  });

  it("live states are the canonical enum", () => {
    expect(LIVE_STATES).toEqual(["running", "idle", "retrying", "error", "unknown"]);
    expect(isLiveState("running")).toBe(true);
    expect(isLiveState("busy")).toBe(false);
  });

  it("terminal routes live under /api/terminals and build correctly", () => {
    expect(TERMINAL_ROUTE_PATTERNS.create).toBe("/api/terminals");
    expect(TERMINAL_ROUTE_PATTERNS.socket).toBe("/api/terminals/:id/socket");
    expect(buildTerminalPath.create()).toBe("/api/terminals");
    expect(buildTerminalPath.socket("shell/a")).toBe("/api/terminals/shell%2Fa/socket");
  });

  it("error codes each map to an HTTP status", () => {
    for (const code of ERROR_CODES) expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
  });

  it("server defaults are distinct ports", () => {
    expect(OPENCODE_DEFAULTS.port).toBe(4096);
    expect(BOARD_SERVER_DEFAULTS.port).toBe(4097);
  });

  it("exposes all ACP task harnesses and their visible model rosters", () => {
    expect(TASK_HARNESSES).toEqual([
      "opencode",
      "claude-code",
      "codex",
      "gemini-acp",
      "hermes",
      "pi-coding-agent",
      "cursor-acp",
    ]);
    expect(CODEX_MODELS.map((model) => model.providerID)).toEqual(["codex", "codex"]);
    expect(GEMINI_ACP_MODELS.map((model) => model.providerID)).toEqual(["gemini-acp", "gemini-acp"]);
    expect(HERMES_MODELS).toEqual([{ providerID: "hermes", id: "default" }]);
    expect(PI_CODING_AGENT_MODELS).toEqual([{ providerID: "pi-coding-agent", id: "default" }]);
    expect(CURSOR_ACP_MODELS).toEqual([{ providerID: "cursor-acp", id: "default" }]);
  });

  it("AdapterError carries code -> status + envelope", () => {
    const e = AdapterError.notFound("no session ses_x");
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("session_not_found");
    expect(e.status).toBe(404);
    expect(e.toEnvelope()).toEqual({
      error: { code: "session_not_found", message: "no session ses_x" },
    });
    expect(AdapterError.unreachable().status).toBe(503);
  });
});

describe("diff contract", () => {
  it("diff route lives under /api/tasks/:id/diff", () => {
    expect(buildTaskPath.diff("task-1")).toBe("/api/tasks/task-1/diff");
    // URI-encoded paths
    expect(buildTaskPath.diff("a/b")).toBe("/api/tasks/a%2Fb/diff");
  });

  it("DiffResponse union is importable with both variants", () => {
    // Compile-time check: the types must be assignable
    const diffOk: import("../../src/shared").DiffResponse = {
      kind: "diff",
      files: [{ file: "src/a.ts", additions: 3, deletions: 1, status: "modified" }],
      capped: false,
    };
    expect(diffOk.kind).toBe("diff");
    expect((diffOk as { kind: "diff"; files: unknown[] }).files).toHaveLength(1);

    const noGit: import("../../src/shared").DiffResponse = {
      kind: "no-git",
      reason: "not a git repository",
    };
    expect(noGit.kind).toBe("no-git");
    expect(noGit.reason).toBe("not a git repository");
  });

  it("DiffResponse kind:diff variant accepts the optional root field", () => {
    // root is the absolute filesystem path of the tree the diff was computed
    // against (worktree or in-place dir). Typed optional so pre-existing
    // fixtures without it still compile; the live route always sets it.
    const withRoot: import("../../src/shared").DiffResponse = {
      kind: "diff",
      files: [],
      capped: false,
      root: "/tmp/some/worktree",
    };
    expect(withRoot.kind).toBe("diff");
    expect((withRoot as { kind: "diff"; root?: string }).root).toBe("/tmp/some/worktree");
  });

  it("DiffFile has the required four statuses", () => {
    const statuses = ["added", "deleted", "modified"] as const;
    for (const s of statuses) {
      const f: import("../../src/shared").DiffFile = {
        file: "x.ts",
        patch: "line",
        additions: 0,
        deletions: 0,
        status: s,
      };
      expect(f.status).toBe(s);
    }
  });
});

describe("FR08-FR12 shared contracts", () => {
  it("exposes additive task routes without handler registration", () => {
    expect(TASK_ROUTE_PATTERNS.permissionReply).toBe("/api/tasks/:id/permission");
    expect(TASK_ROUTE_PATTERNS.sessionEvents).toBe("/api/tasks/:id/session-events");
    expect(TASK_ROUTE_PATTERNS.context).toBe("/api/tasks/:id/context");
    expect(TASK_ROUTE_PATTERNS.compare).toBe("/api/tasks/:targetId/compare?baseTaskId=:baseTaskId");
    expect(buildTaskPath.permissionReply("task/a")).toBe("/api/tasks/task%2Fa/permission");
    expect(buildTaskPath.sessionEvents("task/a")).toBe("/api/tasks/task%2Fa/session-events");
    expect(buildTaskPath.context("task/a")).toBe("/api/tasks/task%2Fa/context");
    expect(buildTaskPath.compare("target/a", "base/b")).toBe("/api/tasks/target%2Fa/compare?baseTaskId=base%2Fb");
  });

  it("keeps native permission ids out of public permission ask/reply contracts", () => {
    const ask: import("../../src/shared").PendingPermissionAsk = {
      id: "ask_public_1",
      harness: "opencode",
      source: "worktree-fence",
      permission: "external_directory",
      tool: "edit",
      summary: "External directory write requested",
      patterns: ["/repo/**"],
      raisedAt: 124,
      deadline: 224,
    };
    const reply: import("../../src/shared").RespondPermissionInput = {
      askId: "ask_public_1",
      action: "deny",
      answeredBy: "reviewer",
    };
    expect(Object.keys(ask).sort()).toEqual([
      "deadline",
      "harness",
      "id",
      "patterns",
      "permission",
      "raisedAt",
      "source",
      "summary",
      "tool",
    ]);
    expect(reply).toEqual({ askId: "ask_public_1", action: "deny", answeredBy: "reviewer" });
  });

  it("keeps active model retry state out of public create/update inputs", () => {
    const createInput: import("../../src/shared").CreateTaskInput = {
      title: "Task",
      description: "Do it",
      directory: "/repo",
      fallbackModel: { providerID: "p", id: "fallback" },
    };
    expect(createInput.fallbackModel?.id).toBe("fallback");

    // @ts-expect-error activeModel is server-owned state, not create input.
    const invalidCreate: import("../../src/shared").CreateTaskInput = { ...createInput, activeModel: { providerID: "p", id: "active" } };
    expect(invalidCreate).toBeTruthy();

    // @ts-expect-error autoRetries is server-owned state, not update input.
    const invalidUpdate: import("../../src/shared").UpdateTaskInput = { autoRetries: 1 };
    expect(invalidUpdate).toBeTruthy();
  });

  it("types session activity frames with monotonic seq identity", () => {
    const event: import("../../src/shared").SessionActivityEvent = {
      seq: 2,
      taskId: "task_1",
      runStartedAt: 1,
      sessionId: "ses_1",
      rootSessionId: "ses_root",
      parentSessionId: null,
      harness: "opencode",
      occurredAt: 3,
      kind: "tool",
      role: "assistant",
      text: "bounded text",
      tool: { name: "bash", callId: "call_1", status: "complete", durationMs: 10, outputBytes: 42 },
    };
    const frame: import("../../src/shared").SessionActivityFrame = {
      kind: "append",
      event,
    };
    expect(frame.event.seq).toBe(event.seq);
    expect(event.tool).not.toHaveProperty("inputSummary");
    expect(event.tool).not.toHaveProperty("outputSummary");
    const snapshot: import("../../src/shared").SessionActivityFrame = {
      kind: "snapshot",
      run: { taskId: "task_1", runStartedAt: 1, sessionId: "ses_1", rootSessionId: "ses_root", harness: "opencode" },
      events: [event],
      lastEventAt: 3,
      transport: "live",
    };
    expect(snapshot.kind).toBe("snapshot");
  });

  it("adds public lineage/context response shapes without changing direct parent ids", () => {
    const context: import("../../src/shared").TaskContext = {
      task: { taskId: "child", title: "Child", description: "Child desc", completion: null, changedFiles: [], verification: [], residualRisk: "none", hasStructuredHandoff: false },
      directParents: [{ kind: "direct-parent", parentId: "p1", taskId: "p1", title: "Parent", description: "Parent desc", completion: null, changedFiles: [], verification: [], residualRisk: "none", hasStructuredHandoff: true }],
      inheritedParents: [{ kind: "inherited-parent", taskId: "a1", title: "Ancestor", taskKind: "research", column: "done", depth: 2, viaParentIds: ["p1", "p2"], summary: "Older evidence", hasStructuredHandoff: true }],
      codeAncestors: [{ taskId: "a1", title: "Ancestor", column: "done", branch: "board/a1", changedFiles: ["src/a.ts"], hasStructuredHandoff: true }],
    };
    expect(context.task.taskId).toBe("child");
    expect(context.directParents.map((parent) => parent.parentId)).toEqual(["p1"]);
    expect(context.inheritedParents[0].viaParentIds).toEqual(["p1", "p2"]);
    expect(context.codeAncestors[0]).not.toHaveProperty("files");
    // `truncated` is optional so untruncated lineages need not set it...
    expect(context.truncated).toBeUndefined();
    // ...but bounded traversals must be able to signal it explicitly.
    const boundedContext: import("../../src/shared").TaskContext = { ...context, truncated: true };
    expect(boundedContext.truncated).toBe(true);
  });

  it("derives blocked questions from needsInput first, then residualRisk, without mutating reports", () => {
    const oldReport: import("../../src/shared").CompletionReport = {
      outcome: "blocked",
      summary: "Could not continue",
      changedFiles: [],
      verification: [],
      residualRisk: "Need the deploy token",
      reportedAt: 1,
    };
    expect(blockedQuestion(oldReport)).toBe("Need the deploy token");
    expect(oldReport).not.toHaveProperty("needsInput");

    expect(blockedQuestion({ ...oldReport, needsInput: "  Which branch should I target?  " })).toBe("Which branch should I target?");
    expect(blockedQuestion({ ...oldReport, needsInput: " ", residualRisk: " " })).toBe("No question was reported; inspect the block summary before retrying.");
  });

  it("types blocked answer, retry, and blocked acceptance contracts", () => {
    const blockedAnswer: import("../../src/shared").BlockedAnswerContext = {
      blockedReportedAt: 10,
      answeredBy: "reviewer",
    };
    const retry: import("../../src/shared").RetryTaskBody = {
      feedback: "Continue with option A",
      blockedAnswer,
    };
    const move: import("../../src/shared").MoveTaskBody = {
      column: "done",
      position: 0,
      completedBy: "Reviewer",
      blockedAcceptance: { blockedReportedAt: 10, acceptIncomplete: true },
    };
    expect(retry.blockedAnswer).toEqual(blockedAnswer);
    expect(move.blockedAcceptance?.acceptIncomplete).toBe(true);
  });
});

describe("resolveOpenCodePermissionRules", () => {
  it("worktree runs retain the fence and accept only a stricter bash ask/deny layer", () => {
    expect(resolveOpenCodePermissionRules(true)).toEqual([
      ...WRITE_FENCED_PERMISSION,
      ...OPENBOARD_WORKER_PERMISSION_DENIALS,
    ]);
    expect(resolveOpenCodePermissionRules(true, { edit: "deny", bash: "deny", webfetch: "deny" })).toEqual([
      ...WRITE_FENCED_PERMISSION,
      { permission: "bash", pattern: "**", action: "deny" },
      ...OPENBOARD_WORKER_PERMISSION_DENIALS,
    ]);
    expect(resolveOpenCodePermissionRules(true, { bash: "ask" })).toEqual([
      ...WRITE_FENCED_PERMISSION,
      { permission: "bash", pattern: "**", action: "ask" },
      ...OPENBOARD_WORKER_PERMISSION_DENIALS,
    ]);
    expect(resolveOpenCodePermissionRules(true, null)).toEqual([
      ...WRITE_FENCED_PERMISSION,
      ...OPENBOARD_WORKER_PERMISSION_DENIALS,
    ]);
  });

  it("in-place runs keep unattended defaults before the worker denials", () => {
    const expected = [...UNATTENDED_PERMISSION, ...OPENBOARD_WORKER_PERMISSION_DENIALS];
    expect(resolveOpenCodePermissionRules(false)).toEqual(expected);
    expect(resolveOpenCodePermissionRules(false, null)).toEqual(expected);
    expect(resolveOpenCodePermissionRules(false, {})).toEqual(expected);
    expect(resolveOpenCodePermissionRules(false, { edit: "allow", bash: "allow", webfetch: "allow" })).toEqual([
      ...UNATTENDED_PERMISSION,
      ...OPENBOARD_WORKER_PERMISSION_DENIALS,
    ]);
  });

  it("in-place runs layer non-allow category overrides after the base allow-all rule (last-rule-wins order)", () => {
    expect(resolveOpenCodePermissionRules(false, { edit: "ask" })).toEqual([
      { permission: "*", pattern: "**", action: "allow" },
      { permission: "edit", pattern: "**", action: "ask" },
      ...OPENBOARD_WORKER_PERMISSION_DENIALS,
    ]);
    expect(resolveOpenCodePermissionRules(false, { edit: "ask", bash: "deny", webfetch: "allow" })).toEqual([
      { permission: "*", pattern: "**", action: "allow" },
      { permission: "edit", pattern: "**", action: "ask" },
      { permission: "bash", pattern: "**", action: "deny" },
      ...OPENBOARD_WORKER_PERMISSION_DENIALS,
    ]);
  });

  it("denies every non-worker OpenBoard tool by its exact OpenCode MCP id", () => {
    expect(OPENBOARD_WORKER_DENIED_TOOL_IDS).toEqual([
      "openboard_openboard_status",
      "openboard_current_instance",
      "openboard_list_instances",
      "openboard_select_instance",
      "openboard_create_task",
      "openboard_add_tasks",
      "openboard_link_tasks",
      "openboard_unlink_tasks",
      "openboard_run_task",
      "openboard_retry_task",
      "openboard_abort_task",
      "openboard_move_task",
      "openboard_sync_task",
      "openboard_integrate_task",
      "openboard_answer_blocked_task",
      "openboard_respond_permission",
      "openboard_send_session_message",
      "openboard_tail_session",
      "openboard_comment_task",
      "openboard_add_note",
      "openboard_task_events",
      "openboard_list_tasks",
      "openboard_list_agents",
    ]);
    const allowedIds = OPENBOARD_WORKER_TOOL_NAMES.map((name) => `openboard_${name}`);
    for (const allowedId of allowedIds) {
      expect(OPENBOARD_WORKER_DENIED_TOOL_IDS).not.toContain(allowedId);
    }
    expect(OPENBOARD_WORKER_PERMISSION_DENIALS).toEqual(
      OPENBOARD_WORKER_DENIED_TOOL_IDS.map((permission) => ({ permission, pattern: "**", action: "deny" })),
    );
  });
});

describe("canAutoRun", () => {
  it("accepts worktree-isolated agent tasks regardless of harness or overrides", () => {
    expect(canAutoRun({ isolation: "worktree" })).toBe(true);
    expect(canAutoRun({ type: "agent", isolation: "worktree" })).toBe(true);
    expect(canAutoRun({ harness: "claude-code", isolation: "worktree" })).toBe(true);
    expect(canAutoRun({ isolation: "worktree", permissionOverrides: { edit: "allow", bash: "allow" } })).toBe(true);
    expect(canAutoRun({ isolation: "worktree", permissionOverrides: { bash: "ask" } })).toBe(false);
    expect(canAutoRun({ isolation: "worktree", permissionOverrides: { bash: "deny" } })).toBe(true);
  });

  it("accepts fenced in-place OpenCode tasks (edit+bash deny)", () => {
    expect(canAutoRun({ isolation: "in-place", permissionOverrides: { edit: "deny", bash: "deny" } })).toBe(true);
    expect(canAutoRun({ harness: "opencode", isolation: "in-place", permissionOverrides: { edit: "deny", bash: "deny", webfetch: "allow" } })).toBe(true);
  });

  it("rejects everything else", () => {
    expect(canAutoRun({ type: "manual", isolation: "worktree" })).toBe(false);
    expect(canAutoRun({ isolation: "in-place" })).toBe(false);
    expect(canAutoRun({ isolation: null })).toBe(false);
    expect(canAutoRun({})).toBe(false);
    expect(canAutoRun({ isolation: "in-place", permissionOverrides: { edit: "deny", bash: "ask" } })).toBe(false);
    expect(canAutoRun({ isolation: "in-place", permissionOverrides: { edit: "ask", bash: "deny" } })).toBe(false);
    expect(canAutoRun({ isolation: "in-place", permissionOverrides: { edit: "deny" } })).toBe(false);
    expect(canAutoRun({ harness: "claude-code", isolation: "in-place", permissionOverrides: { edit: "deny", bash: "deny" } })).toBe(false);
  });
});
