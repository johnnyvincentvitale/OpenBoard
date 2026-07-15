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

import type {
  Task,
  TaskHarness,
  TaskAttemptIdentity,
  VerificationCheckDefinition,
  TaskVerificationPolicy,
  VerificationPolicyMode,
  VerificationPreset,
} from "../../src/shared";
import { deriveTaskAttemptIdentity, validateVerificationPolicy, validateVerificationCatalog, validateVerificationPresets, VERIFICATION_BOUNDS } from "../../src/shared";

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

describe("FR15 Wave 1: attempt identity + verification policy", () => {
  function buildTask(overrides: Partial<Task> = {}): Task {
    return {
      id: "task_1",
      title: "Test",
      description: "Do the thing",
      directory: "/repo",
      column: "in_progress",
      position: 0,
      runState: "running",
      runStartedAt: 100,
      sessionId: "ses_abc",
      harnessSessionName: "openboard-session",
      harness: "claude-code",
      model: { providerID: "p", id: "m" },
      baseCommit: null,
      dirtyAtDispatch: false,
      archived: false,
      autoRun: false,
      createdAt: 1,
      updatedAt: 2,
      harnessSessionId: "harness-1",
      ...overrides,
    };
  }

  function check(id: string, overrides: Partial<VerificationCheckDefinition> = {}): VerificationCheckDefinition {
    return { id, label: `${id} check`, command: `run ${id}`, timeoutMs: 30_000, maxOutputBytes: 10_000, ...overrides };
  }

  const sampleCatalog: readonly VerificationCheckDefinition[] = [
    check("lint", { label: "Lint", command: "npm run lint" }),
    check("test", { label: "Tests", command: "npm test" }),
  ];

  const samplePresets: readonly VerificationPreset[] = [
    { id: "quick", label: "Quick checks", checkIds: ["lint"] },
    { id: "full", label: "Full suite", checkIds: ["lint", "test"] },
  ];

  describe("deriveTaskAttemptIdentity", () => {
    it("returns a canonical attempt identity with all evidence fields from a running task", () => {
      const task = buildTask();
      const identity = deriveTaskAttemptIdentity(task);
      expect(identity).toEqual({
        runStartedAt: 100,
        harness: "claude-code",
        sessionId: "ses_abc",
        harnessSessionId: "harness-1",
        model: { providerID: "p", id: "m" },
      } satisfies TaskAttemptIdentity);
    });

    it("requires harness in the identity (not optional)", () => {
      const identity = deriveTaskAttemptIdentity(buildTask());
      expect(identity!.harness).toBe("claude-code");
      // Type check: harness is required, not optional
      const h: TaskHarness = identity!.harness;
      expect(h).toBe("claude-code");
    });

    it("returns null when runStartedAt is undefined", () => {
      expect(deriveTaskAttemptIdentity(buildTask({ runStartedAt: undefined }))).toBeNull();
    });

    it("returns null when runStartedAt is NaN", () => {
      expect(deriveTaskAttemptIdentity(buildTask({ runStartedAt: NaN }))).toBeNull();
    });

    it("returns null when runStartedAt is +/-Infinity", () => {
      expect(deriveTaskAttemptIdentity(buildTask({ runStartedAt: Infinity }))).toBeNull();
      expect(deriveTaskAttemptIdentity(buildTask({ runStartedAt: -Infinity }))).toBeNull();
    });

    it("returns null when runStartedAt is null (legacy shape)", () => {
      expect(deriveTaskAttemptIdentity(buildTask({ runStartedAt: undefined }))).toBeNull();
    });

    it("always includes harness in the identity from task's harness field (defaults to opencode)", () => {
      // Harness on the task is undefined → derive defaults to "opencode"
      const task = buildTask({ harness: undefined as unknown as TaskHarness, runStartedAt: 1 });
      const id = deriveTaskAttemptIdentity(task);
      expect(id!.harness).toBe("opencode");
    });

    it("omits optional fields that are absent on the task row", () => {
      const task = buildTask({ sessionId: undefined, harnessSessionId: undefined, model: null });
      const identity = deriveTaskAttemptIdentity(task);
      expect(identity!.runStartedAt).toBe(100);
      expect(identity!.harness).toBe("claude-code");
      expect(identity!.sessionId).toBeUndefined();
      expect(identity!.harnessSessionId).toBeUndefined();
    });

    it("prefers activeModel over model when both are set", () => {
      const task = buildTask({ activeModel: { providerID: "p2", id: "active" }, model: { providerID: "p1", id: "m1" } });
      expect(deriveTaskAttemptIdentity(task)!.model).toEqual({ providerID: "p2", id: "active" });
    });

    it("does not mutate the task or include extra fields", () => {
      const task = buildTask();
      const frozen = { ...task };
      const identity = deriveTaskAttemptIdentity(task);
      expect(Object.keys(identity!).sort()).toEqual(
        ["harness", "harnessSessionId", "model", "runStartedAt", "sessionId"].sort(),
      );
      expect(task).toEqual(frozen);
    });

    it("each attempt identity is independent", () => {
      const a = buildTask({ runStartedAt: 1 });
      const b = buildTask({ runStartedAt: 2, id: "task_2" });
      const idA = deriveTaskAttemptIdentity(a)!;
      const idB = deriveTaskAttemptIdentity(b)!;
      expect(idA.runStartedAt).toBe(1);
      expect(idB.runStartedAt).toBe(2);
      expect(idA).not.toEqual(idB);
    });
  });

  describe("validateVerificationPolicy", () => {
    it("resolves inherit with a board default to the board default's resolved value", () => {
      const boardDefault: TaskVerificationPolicy = { mode: "required", checkIds: ["lint"] };
      const result = validateVerificationPolicy({ mode: "inherit" }, sampleCatalog, samplePresets, boardDefault);
      // inherit returns the resolved value, not the raw board default
      expect(result).toEqual({ valid: true, resolved: { mode: "required", checkIds: ["lint"] } });
    });

    it("resolves inherit with no board default as disabled (null)", () => {
      const result = validateVerificationPolicy({ mode: "inherit" }, sampleCatalog, samplePresets, null);
      expect(result).toEqual({ valid: true, resolved: null });
    });

    it("resolves inherit with a disabled board default to null", () => {
      const disabledDefault: TaskVerificationPolicy = { mode: "disabled" };
      const result = validateVerificationPolicy({ mode: "inherit" }, sampleCatalog, samplePresets, disabledDefault);
      // disabled board default resolves to null
      expect(result).toEqual({ valid: true, resolved: null });
    });

    it("resolves inherit with an inherit board default to null (no further default)", () => {
      const inheritDefault: TaskVerificationPolicy = { mode: "inherit" };
      const result = validateVerificationPolicy({ mode: "inherit" }, sampleCatalog, samplePresets, inheritDefault);
      // inherit with no further default → null
      expect(result).toEqual({ valid: true, resolved: null });
    });

    it("treats null/undefined policy the same as inherit", () => {
      expect(validateVerificationPolicy(null, sampleCatalog, samplePresets, null)).toEqual({ valid: true, resolved: null });
      expect(validateVerificationPolicy(undefined, sampleCatalog, samplePresets, null)).toEqual({ valid: true, resolved: null });
      const boardDefault: TaskVerificationPolicy = { mode: "required" };
      expect(validateVerificationPolicy(null, sampleCatalog, samplePresets, boardDefault)).toEqual({ valid: true, resolved: boardDefault });
    });

    it("resolves disabled to null regardless of board default", () => {
      const boardDefault: TaskVerificationPolicy = { mode: "required", checkIds: ["test"] };
      const result = validateVerificationPolicy({ mode: "disabled" }, sampleCatalog, samplePresets, boardDefault);
      expect(result).toEqual({ valid: true, resolved: null });
    });

    it("resolves required with explicit valid checkIds", () => {
      const result = validateVerificationPolicy({ mode: "required", checkIds: ["lint", "test"] }, sampleCatalog, samplePresets, null);
      expect(result).toEqual({ valid: true, resolved: { mode: "required", checkIds: ["lint", "test"] } });
    });

    it("resolves required with empty/unset checkIds", () => {
      expect(validateVerificationPolicy({ mode: "required" }, sampleCatalog, samplePresets, null)).toEqual({
        valid: true,
        resolved: { mode: "required", checkIds: undefined, presetId: undefined },
      });
      expect(validateVerificationPolicy({ mode: "required", checkIds: [] }, sampleCatalog, samplePresets, null)).toEqual({
        valid: true,
        resolved: { mode: "required", checkIds: [], presetId: undefined },
      });
    });

    it("fails closed on an unknown checkId", () => {
      const result = validateVerificationPolicy(
        { mode: "required", checkIds: ["lint", "unknown-chk"] },
        sampleCatalog, samplePresets, null,
      );
      expect(result).toEqual({ valid: false, error: "Unknown verification check: unknown-chk" });
    });

    it("resolves required with a presetId that exists", () => {
      const result = validateVerificationPolicy(
        { mode: "required", presetId: "full" },
        sampleCatalog, samplePresets, null,
      );
      expect(result).toEqual({ valid: true, resolved: { mode: "required", presetId: "full", checkIds: undefined } });
    });

    it("fails closed on an unknown presetId", () => {
      const result = validateVerificationPolicy(
        { mode: "required", presetId: "nonexistent" },
        sampleCatalog, samplePresets, null,
      );
      expect(result).toEqual({ valid: false, error: "Unknown preset: nonexistent" });
    });

    it("fails closed on an invalid mode", () => {
      const result = validateVerificationPolicy(
        { mode: "invalid" as VerificationPolicyMode },
        sampleCatalog, samplePresets, null,
      );
      expect(result).toEqual({ valid: false, error: "Invalid verification policy mode: invalid" });
    });

    it("fails closed on a catalog with duplicate check IDs", () => {
      const dupCatalog: VerificationCheckDefinition[] = [
        check("lint", { label: "Lint 1" }),
        check("test", { label: "T" }),
        check("lint", { label: "Lint 2" }),
      ];
      const result = validateVerificationPolicy({ mode: "required", checkIds: ["lint"] }, dupCatalog, samplePresets, null);
      expect(result).toEqual({ valid: false, error: "Duplicate check id in catalog: lint" });
    });

    it("fails closed on a preset referencing an unknown check", () => {
      const badPresets: VerificationPreset[] = [
        { id: "bad", label: "Bad", checkIds: ["lint", "bogus"] },
      ];
      const result = validateVerificationPolicy({ mode: "required", presetId: "bad" }, sampleCatalog, badPresets, null);
      expect(result).toEqual({ valid: false, error: "Preset bad references unknown check: bogus" });
    });

    it("fails closed on duplicate check IDs in a preset", () => {
      const badPresets: VerificationPreset[] = [
        { id: "duped", label: "Duped", checkIds: ["lint", "lint"] },
      ];
      const result = validateVerificationPolicy({ mode: "required", presetId: "duped" }, sampleCatalog, badPresets, null);
      expect(result).toEqual({ valid: false, error: "Preset duped has duplicate check id: lint" });
    });

    it("fails closed on duplicate preset IDs", () => {
      const badPresets: VerificationPreset[] = [
        { id: "same", label: "One", checkIds: ["lint"] },
        { id: "same", label: "Two", checkIds: ["test"] },
      ];
      const result = validateVerificationPolicy({ mode: "required" }, sampleCatalog, badPresets, null);
      expect(result).toEqual({ valid: false, error: "Duplicate preset id: same" });
    });

    it("fails closed on an invalid check (missing fields)", () => {
      const badCatalog: VerificationCheckDefinition[] = [
        { id: "", label: "", command: "", timeoutMs: 0, maxOutputBytes: 0 } as VerificationCheckDefinition,
      ];
      const result = validateVerificationPolicy({ mode: "required" }, badCatalog, samplePresets, null);
      expect(result.valid).toBe(false);
    });

    it("fails closed on a catalog with a null entry", () => {
      const badCatalog = [null] as unknown as VerificationCheckDefinition[];
      const result = validateVerificationPolicy({ mode: "required" }, badCatalog, [], null);
      expect(result).toEqual({ valid: false, error: "Catalog entry is not an object" });
    });

    it("fails closed on a catalog with a non-object entry", () => {
      const badCatalog = ["not-an-object"] as unknown as VerificationCheckDefinition[];
      const result = validateVerificationPolicy({ mode: "required" }, badCatalog, [], null);
      expect(result).toEqual({ valid: false, error: "Catalog entry is not an object" });
    });

    it("fails closed on presets with a null entry", () => {
      const badPresets = [null] as unknown as VerificationPreset[];
      const result = validateVerificationPolicy({ mode: "required" }, sampleCatalog, badPresets, null);
      expect(result).toEqual({ valid: false, error: "Preset entry is not an object" });
    });

    it("fails closed on a check with negative timeoutMs", () => {
      const badCatalog: VerificationCheckDefinition[] = [
        check("lint", { timeoutMs: -1 }),
      ];
      const result = validateVerificationPolicy({ mode: "required" }, badCatalog, samplePresets, null);
      expect(result).toEqual({ valid: false, error: "Check lint has invalid timeoutMs: must be a positive integer ≤ 3600000" });
    });

    it("fails closed on a check with timeoutMs exceeding max", () => {
      const badCatalog: VerificationCheckDefinition[] = [
        check("lint", { timeoutMs: VERIFICATION_BOUNDS.MAX_TIMEOUT_MS + 1 }),
      ];
      const result = validateVerificationPolicy({ mode: "required" }, badCatalog, samplePresets, null);
      expect(result.valid).toBe(false);
    });

    it("fails closed on a check with non-integer timeoutMs", () => {
      const badCatalog: VerificationCheckDefinition[] = [
        check("lint", { timeoutMs: 1.5 }),
      ];
      const result = validateVerificationPolicy({ mode: "required" }, badCatalog, samplePresets, null);
      expect(result.valid).toBe(false);
    });

    it("fails closed on a check with maxOutputBytes exceeding max", () => {
      const badCatalog: VerificationCheckDefinition[] = [
        check("lint", { maxOutputBytes: VERIFICATION_BOUNDS.MAX_OUTPUT_BYTES + 1 }),
      ];
      const result = validateVerificationPolicy({ mode: "required" }, badCatalog, samplePresets, null);
      expect(result.valid).toBe(false);
    });

    it("fails closed on a catalog exceeding the max check count", () => {
      const hugeCatalog: VerificationCheckDefinition[] = Array.from(
        { length: VERIFICATION_BOUNDS.MAX_CATALOG_CHECKS + 1 },
        (_, i) => check(`chk${i}`),
      );
      const result = validateVerificationPolicy({ mode: "required" }, hugeCatalog, [], null);
      expect(result.valid).toBe(false);
    });

    it("fails closed on presets exceeding the max preset count", () => {
      const hugePresets: VerificationPreset[] = Array.from(
        { length: VERIFICATION_BOUNDS.MAX_PRESETS + 1 },
        (_, i) => ({ id: `p${i}`, label: `Preset ${i}`, checkIds: ["lint"] }),
      );
      const result = validateVerificationPolicy({ mode: "required" }, sampleCatalog, hugePresets, null);
      expect(result.valid).toBe(false);
    });

    it("fails closed on an invalid board default", () => {
      const badDefault: TaskVerificationPolicy = { mode: "required", checkIds: ["nonexistent"] };
      const result = validateVerificationPolicy({ mode: "inherit" }, sampleCatalog, samplePresets, badDefault);
      expect(result).toEqual({ valid: false, error: "Board default policy is invalid: Unknown verification check: nonexistent" });
    });

    it("fails closed on duplicate checkIds in a policy", () => {
      const result = validateVerificationPolicy(
        { mode: "required", checkIds: ["lint", "lint"] },
        sampleCatalog, samplePresets, null,
      );
      expect(result).toEqual({ valid: false, error: "Duplicate checkId: lint" });
    });

    it("does not spawn processes, run commands, or access I/O", () => {
      const r1 = validateVerificationPolicy({ mode: "required", checkIds: ["lint"] }, sampleCatalog, samplePresets, null);
      const r2 = validateVerificationPolicy({ mode: "required", checkIds: ["lint"] }, sampleCatalog, samplePresets, null);
      expect(r1).toEqual(r2);
    });

    it("does not execute or reinterpret worker-supplied verification command strings", () => {
      const policy: TaskVerificationPolicy = { mode: "required", checkIds: ["lint"] };
      const result = validateVerificationPolicy(policy, sampleCatalog, samplePresets, null);
      expect(result).toEqual({ valid: true, resolved: { mode: "required", checkIds: ["lint"] } });
    });
  });

  describe("validateVerificationCatalog (shared store validator)", () => {
    it("accepts a valid catalog", () => {
      const result = validateVerificationCatalog(sampleCatalog);
      expect(result.valid).toBe(true);
      if (result.valid) expect(result.catalogIds.has("lint")).toBe(true);
    });

    it("rejects negative timeoutMs", () => {
      const result = validateVerificationCatalog([check("x", { timeoutMs: -100 })]);
      expect(result.valid).toBe(false);
    });

    it("rejects non-integer timeoutMs", () => {
      const result = validateVerificationCatalog([check("x", { timeoutMs: 1.5 })]);
      expect(result.valid).toBe(false);
    });

    it("rejects duplicate IDs", () => {
      const result = validateVerificationCatalog([check("dup"), check("dup")]);
      expect(result).toEqual({ valid: false, error: "Duplicate check id in catalog: dup" });
    });

    it("rejects oversized ID", () => {
      const longId = "x".repeat(VERIFICATION_BOUNDS.MAX_ID_LENGTH + 1);
      const result = validateVerificationCatalog([check(longId)]);
      expect(result.valid).toBe(false);
    });
  });

  describe("validateVerificationPresets (shared store validator)", () => {
    it("accepts valid presets against a catalog", () => {
      const result = validateVerificationPresets(samplePresets, new Set(["lint", "test"]));
      expect(result.valid).toBe(true);
    });

    it("rejects presets referencing unknown checks", () => {
      const result = validateVerificationPresets([{ id: "p", label: "P", checkIds: ["nonexistent"] }], new Set(["lint"]));
      expect(result.valid).toBe(false);
    });
  });

  describe("TaskVerificationPolicy types", () => {
    it("accepts the three canonical modes in the const array", () => {
      const modes: import("../../src/shared").VerificationPolicyMode[] = ["inherit", "required", "disabled"];
      expect(modes).toHaveLength(3);
      for (const m of modes) {
        const policy: TaskVerificationPolicy = { mode: m };
        expect(policy.mode).toBe(m);
      }
    });

    it("Task/CreateTaskInput/UpdateTaskInput all accept verificationPolicy", () => {
      const policy: TaskVerificationPolicy = { mode: "required", checkIds: ["lint"] };
      const t: Task = buildTask({ verificationPolicy: policy });
      expect(t.verificationPolicy).toEqual(policy);

      const ci: import("../../src/shared").CreateTaskInput = {
        title: "T",
        description: "D",
        directory: "/repo",
        verificationPolicy: { mode: "disabled" },
      };
      expect(ci.verificationPolicy).toEqual({ mode: "disabled" });

      const ui: import("../../src/shared").UpdateTaskInput = {
        verificationPolicy: null,
      };
      expect(ui.verificationPolicy).toBeNull();
    });

    it("VerificationCheckDefinition requires label, timeoutMs, maxOutputBytes", () => {
      // These fields are required on the type — compile-time verification
      const def: VerificationCheckDefinition = {
        id: "chk",
        label: "My Check",
        command: "run",
        timeoutMs: 30_000,
        maxOutputBytes: 10_000,
      };
      expect(def.label).toBe("My Check");
      expect(def.timeoutMs).toBe(30_000);
      expect(def.maxOutputBytes).toBe(10_000);
    });
  });
});
