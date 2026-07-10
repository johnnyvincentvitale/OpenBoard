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
  TASK_HARNESSES,
  CODEX_MODELS,
  GEMINI_ACP_MODELS,
  HERMES_MODELS,
  PI_CODING_AGENT_MODELS,
  CURSOR_ACP_MODELS,
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

describe("resolveOpenCodePermissionRules", () => {
  it("worktree-isolated runs always get WRITE_FENCED_PERMISSION unchanged, ignoring any override", () => {
    expect(resolveOpenCodePermissionRules(true)).toEqual([...WRITE_FENCED_PERMISSION]);
    expect(resolveOpenCodePermissionRules(true, { edit: "deny", bash: "deny", webfetch: "deny" })).toEqual([
      ...WRITE_FENCED_PERMISSION,
    ]);
    expect(resolveOpenCodePermissionRules(true, null)).toEqual([...WRITE_FENCED_PERMISSION]);
  });

  it("in-place runs with no override (or all-allow) match today's UNATTENDED_PERMISSION exactly", () => {
    expect(resolveOpenCodePermissionRules(false)).toEqual([...UNATTENDED_PERMISSION]);
    expect(resolveOpenCodePermissionRules(false, null)).toEqual([...UNATTENDED_PERMISSION]);
    expect(resolveOpenCodePermissionRules(false, {})).toEqual([...UNATTENDED_PERMISSION]);
    expect(resolveOpenCodePermissionRules(false, { edit: "allow", bash: "allow", webfetch: "allow" })).toEqual([
      ...UNATTENDED_PERMISSION,
    ]);
  });

  it("in-place runs layer non-allow category overrides after the base allow-all rule (last-rule-wins order)", () => {
    expect(resolveOpenCodePermissionRules(false, { edit: "ask" })).toEqual([
      { permission: "*", pattern: "**", action: "allow" },
      { permission: "edit", pattern: "**", action: "ask" },
    ]);
    expect(resolveOpenCodePermissionRules(false, { edit: "ask", bash: "deny", webfetch: "allow" })).toEqual([
      { permission: "*", pattern: "**", action: "allow" },
      { permission: "edit", pattern: "**", action: "ask" },
      { permission: "bash", pattern: "**", action: "deny" },
    ]);
  });
});

describe("canAutoRun", () => {
  it("accepts worktree-isolated agent tasks regardless of harness or overrides", () => {
    expect(canAutoRun({ isolation: "worktree" })).toBe(true);
    expect(canAutoRun({ type: "agent", isolation: "worktree" })).toBe(true);
    expect(canAutoRun({ harness: "claude-code", isolation: "worktree" })).toBe(true);
    expect(canAutoRun({ isolation: "worktree", permissionOverrides: { edit: "allow", bash: "allow" } })).toBe(true);
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
