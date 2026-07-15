import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import type { CompletionReport, CreateTaskInput, ModelRef } from "../../src/shared";
import { SqliteTaskStore } from "../../src/db/task-store";

function assertDenseUnique(store: SqliteTaskStore, column: string): number[] {
  const positions = store
    .list()
    .filter((t) => t.column === column)
    .sort((a, b) => a.position - b.position)
    .map((t) => t.position);

  const unique = new Set(positions);
  expect(unique.size).toBe(positions.length); // no duplicates
  positions.forEach((p, i) => expect(p).toBe(i)); // dense, 0-indexed, no gaps
  return positions;
}

function input(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    title: "Task",
    description: "Do the thing",
    directory: "/tmp/project",
    ...overrides,
  };
}

describe("SqliteTaskStore", () => {
  let clock: number;
  let idCounter: number;
  let store: SqliteTaskStore;

  beforeEach(() => {
    clock = 1_000;
    idCounter = 0;
    store = new SqliteTaskStore(":memory:", {
      now: () => clock,
      genId: () => `task_${++idCounter}`,
    });
  });

  describe("empty store", () => {
    it("starts with no tasks", () => {
      expect(store.list()).toEqual([]);
    });

    it("get returns undefined for unknown id", () => {
      expect(store.get("task_missing")).toBeUndefined();
    });
  });

  describe("create", () => {
    it("creates a task in todo at position 0 with unstarted runState", () => {
      const task = store.create(input({ title: "First" }));

      expect(task.id).toBe("task_1");
      expect(task.type).toBe("agent");
      expect(task.taskKind).toBe("none");
      expect(task.title).toBe("First");
      expect(task.description).toBe("Do the thing");
      expect(task.directory).toBe("/tmp/project");
      expect(task.column).toBe("todo");
      expect(task.position).toBe(0);
      expect(task.runState).toBe("unstarted");
      expect(task.sessionId).toBeUndefined();
      expect(task.error).toBeUndefined();
      expect(task.archived).toBe(false);
      expect(task.parentIds).toEqual([]);
      expect(task.completion).toBeNull();
      expect(task.finalSessionOutput).toBeNull();
      expect(task.completionSource).toBeNull();
      expect(task.completedBy).toBeNull();
      expect(task.fallbackModel).toBeNull();
      expect(task.activeModel).toBeNull();
      expect(task.autoRetries).toBe(0);
      expect(task.createdAt).toBe(1_000);
      expect(task.updatedAt).toBe(1_000);
    });

    it("round-trips manual task type and assignee", () => {
      const created = store.create(input({
        type: "manual",
        assignedTo: "Johnny",
      }));

      expect(created.type).toBe("manual");
      expect(created.assignedTo).toBe("Johnny");

      const fetched = store.get(created.id);
      expect(fetched?.type).toBe("manual");
      expect(fetched?.assignedTo).toBe("Johnny");

      const listed = store.list().find((t) => t.id === created.id);
      expect(listed?.type).toBe("manual");
      expect(listed?.assignedTo).toBe("Johnny");
    });

    it("round-trips task kind through create/update/list/get", () => {
      const created = store.create(input({ taskKind: "synthesis" }));

      expect(created.taskKind).toBe("synthesis");
      expect(store.get(created.id)?.taskKind).toBe("synthesis");

      const updated = store.update(created.id, { taskKind: "fix" });
      expect(updated?.taskKind).toBe("fix");
      expect(store.list().find((task) => task.id === created.id)?.taskKind).toBe("fix");
    });

    it("appends subsequent tasks at the end of todo (max position + 1)", () => {
      store.create(input({ title: "A" }));
      store.create(input({ title: "B" }));
      const c = store.create(input({ title: "C" }));

      expect(c.position).toBe(2);
      assertDenseUnique(store, "todo");
    });

    it("uses the injected genId and now", () => {
      clock = 55;
      const task = store.create(input());
      expect(task.id).toBe("task_1");
      expect(task.createdAt).toBe(55);
    });

    it("leaves agent/model undefined when not provided", () => {
      const task = store.create(input());
      expect(task.agent).toBeUndefined();
      expect(task.model).toBeUndefined();
    });

    it("round-trips agent/model through create/list/get", () => {
      const model: ModelRef = { id: "m", providerID: "p" };
      const created = store.create(input({ agent: "build", model }));

      expect(created.agent).toBe("build");
      expect(created.model).toEqual(model);

      const fetched = store.get(created.id);
      expect(fetched?.agent).toBe("build");
      expect(fetched?.model).toEqual(model);

      const listed = store.list().find((t) => t.id === created.id);
      expect(listed?.agent).toBe("build");
      expect(listed?.model).toEqual(model);
    });

    it("round-trips claude-code harness metadata through create/update/list/get", () => {
      const created = store.create(input({
        harness: "claude-code",
        agent: "plan",
        permissionMode: "bypassPermissions",
        claudePermissionMode: "bypassPermissions",
        acpOptions: { profile: "audit", maxTurns: 3, readOnly: true },
      }));

      expect(created.harness).toBe("claude-code");
      expect(created.permissionMode).toBe("bypassPermissions");
      expect(created.claudePermissionMode).toBe("bypassPermissions");
      expect(created.acpOptions).toEqual({ profile: "audit", maxTurns: 3, readOnly: true });
      expect(created.model).toBeUndefined();

      const updated = store.update(created.id, {
        runState: "running",
        harnessSessionId: "claude-session-1",
        harnessSessionName: "openboard-task-1",
        harnessStatus: "running",
        harnessCwd: "/tmp/project/.claude/worktrees/task-1",
        harnessBranch: "worktree-task-1",
        harnessCommit: "abc1234",
        harnessWarning: "Warning: target working tree has 2 uncommitted paths. Claude Code may isolate edits in its own worktree. Please commit before using Claude agents in this repo.",
        completionLocation: "harness-directory",
        permissionMode: "manual",
        claudePermissionMode: "manual",
        acpOptions: { profile: "fix", maxTurns: 7, readOnly: false },
      });

      expect(updated).toMatchObject({
        harness: "claude-code",
        harnessSessionId: "claude-session-1",
        harnessSessionName: "openboard-task-1",
        harnessStatus: "running",
        harnessCwd: "/tmp/project/.claude/worktrees/task-1",
        harnessBranch: "worktree-task-1",
        harnessCommit: "abc1234",
        harnessWarning: "Warning: target working tree has 2 uncommitted paths. Claude Code may isolate edits in its own worktree. Please commit before using Claude agents in this repo.",
        completionLocation: "harness-directory",
        permissionMode: "manual",
        claudePermissionMode: "manual",
        acpOptions: { profile: "fix", maxTurns: 7, readOnly: false },
      });
      expect(store.get(created.id)).toMatchObject({
        harness: "claude-code",
        harnessSessionId: "claude-session-1",
        harnessSessionName: "openboard-task-1",
        harnessStatus: "running",
        harnessCwd: "/tmp/project/.claude/worktrees/task-1",
        harnessBranch: "worktree-task-1",
        harnessCommit: "abc1234",
        harnessWarning: "Warning: target working tree has 2 uncommitted paths. Claude Code may isolate edits in its own worktree. Please commit before using Claude agents in this repo.",
        completionLocation: "harness-directory",
        permissionMode: "manual",
        claudePermissionMode: "manual",
        acpOptions: { profile: "fix", maxTurns: 7, readOnly: false },
      });
      expect(store.list().find((task) => task.id === created.id)).toMatchObject({
        harness: "claude-code",
        harnessSessionId: "claude-session-1",
        harnessCwd: "/tmp/project/.claude/worktrees/task-1",
        completionLocation: "harness-directory",
        permissionMode: "manual",
        claudePermissionMode: "manual",
        acpOptions: { profile: "fix", maxTurns: 7, readOnly: false },
      });
    });

    it("round-trips a model with a variant", () => {
      const model: ModelRef = { id: "m", providerID: "p", variant: "thinking" };
      const created = store.create(input({ model }));

      expect(created.model).toEqual(model);
      expect(store.get(created.id)?.model).toEqual(model);
    });

    it("round-trips user-configured fallback model on create", () => {
      const fallbackModel: ModelRef = { id: "fallback", providerID: "p", variant: "cheap" };
      const created = store.create(input({ fallbackModel }));

      expect(created.fallbackModel).toEqual(fallbackModel);
      expect(created.activeModel).toBeNull();
      expect(created.autoRetries).toBe(0);
      expect(store.get(created.id)).toMatchObject({ fallbackModel, activeModel: null, autoRetries: 0 });
    });
  });

  describe("list / get ordering", () => {
    it("list returns tasks ordered by (column, position)", () => {
      const a = store.create(input({ title: "A" }));
      const b = store.create(input({ title: "B" }));
      const c = store.create(input({ title: "C" }));

      store.move(a.id, "in_progress", 0);

      const tasks = store.list();
      // in_progress sorts before todo alphabetically... but we just check
      // that within each column ordering is by position and all present.
      const todoTasks = tasks.filter((t) => t.column === "todo");
      const inProgressTasks = tasks.filter((t) => t.column === "in_progress");

      expect(todoTasks.map((t) => t.id)).toEqual([b.id, c.id]);
      expect(todoTasks.map((t) => t.position)).toEqual([0, 1]);
      expect(inProgressTasks.map((t) => t.id)).toEqual([a.id]);
    });

    it("get returns the created task", () => {
      const created = store.create(input());
      const fetched = store.get(created.id);
      expect(fetched).toEqual(created);
    });

    it("excludes archived tasks by default and supports archived filters", () => {
      const active = store.create(input({ title: "Active" }));
      const archived = store.create(input({ title: "Archived" }));
      store.setArchived(archived.id, true);

      expect(store.list().map((task) => task.id)).toEqual([active.id]);
      expect(store.list({ archived: "only" }).map((task) => task.id)).toEqual([archived.id]);
      expect(store.list({ archived: "all" }).map((task) => task.id)).toEqual([active.id, archived.id]);
    });
  });

  describe("update", () => {
    it("merges patch fields and bumps updatedAt", () => {
      const task = store.create(input({ title: "Original" }));
      clock = 2_000;

      const updated = store.update(task.id, { title: "Updated title" });

      expect(updated).toBeDefined();
      expect(updated!.title).toBe("Updated title");
      expect(updated!.description).toBe(task.description);
      expect(updated!.createdAt).toBe(task.createdAt);
      expect(updated!.updatedAt).toBe(2_000);
    });

    it("can set sessionId and runState together", () => {
      const task = store.create(input());
      clock = 3_000;

      const updated = store.update(task.id, {
        sessionId: "ses_abc",
        runState: "running",
      });

      expect(updated!.sessionId).toBe("ses_abc");
      expect(updated!.runState).toBe("running");
      expect(updated!.updatedAt).toBe(3_000);

      const fetched = store.get(task.id)!;
      expect(fetched.sessionId).toBe("ses_abc");
      expect(fetched.runState).toBe("running");
    });

    it("persists runStartedAt round-trip and absent by default", () => {
      const task = store.create(input());
      expect(task.runStartedAt).toBeUndefined();

      const updated = store.update(task.id, { runState: "running", runStartedAt: 4_000 });
      expect(updated!.runStartedAt).toBe(4_000);
      expect(store.get(task.id)!.runStartedAt).toBe(4_000);
    });

    it("can set and clear error", () => {
      const task = store.create(input());

      const withError = store.update(task.id, { runState: "error", error: "boom" });
      expect(withError!.error).toBe("boom");
      expect(withError!.runState).toBe("error");

      const cleared = store.update(task.id, { error: undefined, runState: "idle" });
      expect(cleared!.error).toBeUndefined();
      expect(cleared!.runState).toBe("idle");
    });

    it("never lets the caller change id or createdAt", () => {
      const task = store.create(input());
      clock = 9_999;

      // TS wouldn't allow `id`/`createdAt` in the patch type; verify runtime
      // behavior stays correct for the fields that are allowed.
      const updated = store.update(task.id, { title: "Still same id" });

      expect(updated!.id).toBe(task.id);
      expect(updated!.createdAt).toBe(task.createdAt);
    });

    it("returns undefined for an unknown id", () => {
      expect(store.update("task_missing", { title: "x" })).toBeUndefined();
    });

    it("can set agent and model on an existing task", () => {
      const task = store.create(input());
      const model: ModelRef = { id: "m", providerID: "p" };

      const updated = store.update(task.id, { agent: "plan", model });

      expect(updated!.agent).toBe("plan");
      expect(updated!.model).toEqual(model);

      const fetched = store.get(task.id)!;
      expect(fetched.agent).toBe("plan");
      expect(fetched.model).toEqual(model);
    });

    it("can set and clear fallback/active models and autoRetries", () => {
      const task = store.create(input());
      const fallbackModel: ModelRef = { id: "fallback", providerID: "p" };
      const activeModel: ModelRef = { id: "active", providerID: "p" };

      const updated = store.update(task.id, { fallbackModel, activeModel, autoRetries: 3 });
      expect(updated?.fallbackModel).toEqual(fallbackModel);
      expect(updated?.activeModel).toEqual(activeModel);
      expect(updated?.autoRetries).toBe(3);

      const cleared = store.update(task.id, { fallbackModel: null, activeModel: null, autoRetries: 0 });
      expect(cleared?.fallbackModel).toBeNull();
      expect(cleared?.activeModel).toBeNull();
      expect(cleared?.autoRetries).toBe(0);
    });

    it("does not persist runtime-only pendingPermissions", () => {
      const task = store.create(input());
      store.update(task.id, {
        pendingPermissions: [{ id: "ask_1", harness: "opencode", source: "worktree-fence", permission: "external_directory", summary: "Allow?", raisedAt: 2, deadline: 3 }],
      });
      expect(store.get(task.id)?.pendingPermissions).toBeUndefined();
    });

    it("can clear agent and model back to undefined", () => {
      const model: ModelRef = { id: "m", providerID: "p" };
      const task = store.create(input({ agent: "build", model }));

      const cleared = store.update(task.id, { agent: undefined, model: undefined });

      expect(cleared!.agent).toBeUndefined();
      expect(cleared!.model).toBeUndefined();

      const fetched = store.get(task.id)!;
      expect(fetched.agent).toBeUndefined();
      expect(fetched.model).toBeUndefined();
    });

    it("round-trips permissionOverrides through create/update/list/get", () => {
      const task = store.create(input({ permissionOverrides: { edit: "ask", bash: "deny" } }));
      expect(task.permissionOverrides).toEqual({ edit: "ask", bash: "deny" });
      expect(store.get(task.id)!.permissionOverrides).toEqual({ edit: "ask", bash: "deny" });

      const updated = store.update(task.id, { permissionOverrides: { webfetch: "deny" } });
      expect(updated!.permissionOverrides).toEqual({ webfetch: "deny" });
      expect(store.get(task.id)!.permissionOverrides).toEqual({ webfetch: "deny" });

      const cleared = store.update(task.id, { permissionOverrides: null });
      expect(cleared!.permissionOverrides).toBeNull();
      expect(store.get(task.id)!.permissionOverrides).toBeNull();
    });

    it("leaves permissionOverrides null when not provided", () => {
      const task = store.create(input());
      expect(task.permissionOverrides).toBeNull();
      expect(store.get(task.id)!.permissionOverrides).toBeNull();
    });

    it("round-trips autoRun through create/update/list/get", () => {
      const task = store.create(input({ autoRun: true }));
      expect(task.autoRun).toBe(true);
      expect(store.get(task.id)!.autoRun).toBe(true);
      expect(store.list().find((t) => t.id === task.id)?.autoRun).toBe(true);

      const cleared = store.update(task.id, { autoRun: false });
      expect(cleared!.autoRun).toBe(false);
      expect(store.get(task.id)!.autoRun).toBe(false);
    });

    it("hydrates autoRun as false when not provided at create", () => {
      const task = store.create(input());
      expect(task.autoRun).toBe(false);
      expect(store.get(task.id)!.autoRun).toBe(false);
    });

    it("can set and clear completedBy", () => {
      const task = store.create(input());
      clock = 11_000;

      const updated = store.update(task.id, { completedBy: "User" });
      expect(updated!.completedBy).toBe("User");
      expect(updated!.updatedAt).toBe(11_000);
      expect(store.get(task.id)!.completedBy).toBe("User");

      const cleared = store.update(task.id, { completedBy: null });
      expect(cleared!.completedBy).toBeNull();
      expect(store.get(task.id)!.completedBy).toBeNull();
    });
  });

  describe("move: dense reindex", () => {
    it("moves a task to another column, compacting the source column", () => {
      const a = store.create(input({ title: "A" }));
      const b = store.create(input({ title: "B" }));
      const c = store.create(input({ title: "C" }));

      store.move(b.id, "review", 0);

      const moved = store.get(b.id)!;
      expect(moved.column).toBe("review");
      expect(moved.position).toBe(0);

      const todoTasks = store.list().filter((t) => t.column === "todo");
      expect(todoTasks.map((t) => t.id)).toEqual([a.id, c.id]);
      assertDenseUnique(store, "todo");
      assertDenseUnique(store, "review");
    });

    it("reorders within the same column with no gaps and unique positions", () => {
      const a = store.create(input({ title: "A" }));
      const b = store.create(input({ title: "B" }));
      const c = store.create(input({ title: "C" }));

      // Move C to the front.
      store.move(c.id, "todo", 0);

      const todoTasks = store.list().filter((t) => t.column === "todo");
      expect(todoTasks.map((t) => t.id)).toEqual([c.id, a.id, b.id]);
      assertDenseUnique(store, "todo");
    });

    it("clamps an out-of-range target position to the end", () => {
      const a = store.create(input({ title: "A" }));
      const b = store.create(input({ title: "B" }));

      store.move(a.id, "todo", 999);

      const todoTasks = store.list().filter((t) => t.column === "todo");
      expect(todoTasks.map((t) => t.id)).toEqual([b.id, a.id]);
      assertDenseUnique(store, "todo");
    });

    it("bumps updatedAt only for the moved task", () => {
      const a = store.create(input({ title: "A" }));
      const b = store.create(input({ title: "B" }));
      clock = 5_000;

      store.move(b.id, "in_progress", 0);

      expect(store.get(b.id)!.updatedAt).toBe(5_000);
      expect(store.get(a.id)!.updatedAt).toBe(1_000);
    });

    it("throws for an unknown task id", () => {
      expect(() => store.move("task_missing", "todo", 0)).toThrow();
    });
  });

  describe("remove + compact", () => {
    it("removes a task and compacts the vacated column", () => {
      const a = store.create(input({ title: "A" }));
      const b = store.create(input({ title: "B" }));
      const c = store.create(input({ title: "C" }));

      store.remove(b.id);

      expect(store.get(b.id)).toBeUndefined();
      const todoTasks = store.list().filter((t) => t.column === "todo");
      expect(todoTasks.map((t) => t.id)).toEqual([a.id, c.id]);
      assertDenseUnique(store, "todo");
    });

    it("is a no-op for an unknown id", () => {
      store.create(input());
      expect(() => store.remove("task_missing")).not.toThrow();
      expect(store.list()).toHaveLength(1);
    });

    it("leaves an empty column with no tasks after removing the last one", () => {
      const a = store.create(input());
      store.remove(a.id);
      expect(store.list()).toEqual([]);
    });
  });

  describe("completion + archive", () => {
    const report: CompletionReport = {
      outcome: "complete",
      summary: "Done",
      changedFiles: ["src/a.ts"],
      verification: [{ command: "npm test", result: "passed" }],
      residualRisk: "none",
      reportedAt: 9_000,
    };

    it("setCompletion persists the report and source", () => {
      const task = store.create(input());
      clock = 10_000;

      const updated = store.setCompletion(task.id, report, "reported");

      expect(updated?.completion).toEqual(report);
      expect(updated?.completionSource).toBe("reported");
      expect(updated?.updatedAt).toBe(10_000);
      expect(store.get(task.id)?.completion).toEqual(report);
      expect(store.get(task.id)?.completionSource).toBe("reported");
    });

    it("persists final session output separately from the completion report", () => {
      const task = store.create(input());

      const updated = store.update(task.id, { finalSessionOutput: "last assistant turn" });

      expect(updated?.finalSessionOutput).toBe("last assistant turn");
      expect(store.get(task.id)?.finalSessionOutput).toBe("last assistant turn");
      expect(store.get(task.id)?.completion).toBeNull();
    });

    it("setCompletion returns undefined for an unknown task", () => {
      expect(store.setCompletion("task_missing", report, "reported")).toBeUndefined();
    });

    it("setArchived toggles the archived flag", () => {
      const task = store.create(input());

      expect(store.setArchived(task.id, true)?.archived).toBe(true);
      expect(store.get(task.id)?.archived).toBe(true);
      expect(store.setArchived(task.id, false)?.archived).toBe(false);
      expect(store.get(task.id)?.archived).toBe(false);
    });

    it("setArchived returns undefined for an unknown task", () => {
      expect(store.setArchived("task_missing", true)).toBeUndefined();
    });
  });

  describe("dependency links", () => {
    it("adds a parent link and reads both directions", () => {
      const parent = store.create(input({ title: "Parent" }));
      const child = store.create(input({ title: "Child" }));

      store.addLink(parent.id, child.id);

      expect(store.getParentIds(child.id)).toEqual([parent.id]);
      expect(store.getChildIds(parent.id)).toEqual([child.id]);
      expect(store.get(child.id)?.parentIds).toEqual([parent.id]);
      expect(store.list().find((task) => task.id === child.id)?.parentIds).toEqual([parent.id]);
    });

    it("rejects self-links", () => {
      const task = store.create(input());
      expect(() => store.addLink(task.id, task.id)).toThrow(/cannot reference itself/);
    });

    it("rejects duplicate links", () => {
      const parent = store.create(input({ title: "Parent" }));
      const child = store.create(input({ title: "Child" }));

      store.addLink(parent.id, child.id);

      expect(() => store.addLink(parent.id, child.id)).toThrow(/duplicate task link/);
    });

    it("rejects links to unknown tasks", () => {
      const task = store.create(input());

      expect(() => store.addLink("task_missing", task.id)).toThrow(/unknown parent task/);
      expect(() => store.addLink(task.id, "task_missing")).toThrow(/unknown child task/);
    });

    it("removes a link without deleting either task", () => {
      const parent = store.create(input({ title: "Parent" }));
      const child = store.create(input({ title: "Child" }));
      store.addLink(parent.id, child.id);

      store.removeLink(parent.id, child.id);

      expect(store.getParentIds(child.id)).toEqual([]);
      expect(store.getChildIds(parent.id)).toEqual([]);
      expect(store.get(parent.id)).toBeDefined();
      expect(store.get(child.id)).toBeDefined();
    });

    it("removes links when a task is removed", () => {
      const parent = store.create(input({ title: "Parent" }));
      const child = store.create(input({ title: "Child" }));
      store.addLink(parent.id, child.id);

      store.remove(parent.id);

      expect(store.getParentIds(child.id)).toEqual([]);
    });
  });

  describe("comments and task events", () => {
    it("persists scoped task comments and events in creation order", () => {
      const task = store.create(input());
      const comment = store.addComment({ taskId: task.id, author: "orchestrator", body: "reviewed" });
      clock = 2_000;
      const event = store.addEvent({ taskId: task.id, type: "comment_added", body: { commentId: comment.id } });

      expect(comment).toMatchObject({ taskId: task.id, author: "orchestrator", body: "reviewed", createdAt: 1_000 });
      expect(event).toMatchObject({ taskId: task.id, type: "comment_added", body: { commentId: comment.id }, createdAt: 2_000 });
      expect(store.listComments(task.id)).toEqual([comment]);
      expect(store.listEvents(task.id)).toEqual([event]);
    });

    it("persists reply comments and keeps comments across Review to Done moves", () => {
      const task = store.create(input());
      store.move(task.id, "review", 0);
      const parent = store.addComment({ taskId: task.id, author: "reviewer", body: "Please fix" });
      const reply = store.addComment({ taskId: task.id, author: "worker", body: "Fixed", parentCommentId: parent.id });

      store.move(task.id, "done", 0);

      expect(store.listComments(task.id)).toEqual([parent, reply]);
      expect(store.listComments(task.id)[1].parentCommentId).toBe(parent.id);
    });

    it("rejects replies whose parent comment belongs to another task", () => {
      const a = store.create(input({ title: "A" }));
      const b = store.create(input({ title: "B" }));
      const parent = store.addComment({ taskId: a.id, author: "reviewer", body: "A" });

      expect(() => store.addComment({ taskId: b.id, author: "worker", body: "B", parentCommentId: parent.id })).toThrow(/unknown parent comment/);
    });

    it("migrates final output and parent comment columns into existing sqlite DBs", () => {
      const db = new Database(":memory:");
      db.exec(`
        CREATE TABLE task (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, directory TEXT NOT NULL,
          column TEXT NOT NULL, position INTEGER NOT NULL, session_id TEXT, run_state TEXT NOT NULL,
          error TEXT, agent TEXT, model TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          UNIQUE(column, position)
        );
        CREATE TABLE task_comments (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
      `);

      const migrated = new SqliteTaskStore(db);
      const taskColumns = new Set((db.prepare("PRAGMA table_info(task)").all() as Array<{ name: string }>).map((row) => row.name));
      const commentColumns = new Set((db.prepare("PRAGMA table_info(task_comments)").all() as Array<{ name: string }>).map((row) => row.name));

      expect(taskColumns.has("final_session_output")).toBe(true);
      expect(commentColumns.has("parent_comment_id")).toBe(true);
      migrated.close();
      db.close();
    });

    it("rejects comments and events for unknown tasks", () => {
      expect(() => store.addComment({ taskId: "missing", author: "a", body: "b" })).toThrow(/unknown task/);
      expect(() => store.listComments("missing")).toThrow(/unknown task/);
      expect(() => store.addEvent({ taskId: "missing", type: "x" })).toThrow(/unknown task/);
      expect(() => store.listEvents("missing")).toThrow(/unknown task/);
    });
  });

  describe("baseCommit / dirtyAtDispatch", () => {
    it("defaults to null and false on newly created tasks", () => {
      const task = store.create(input());
      expect(task.baseCommit).toBeNull();
      expect(task.dirtyAtDispatch).toBe(false);
    });

    it("round-trips null baseCommit and false dirtyAtDispatch", () => {
      const task = store.create(input());
      const fetched = store.get(task.id);
      expect(fetched?.baseCommit).toBeNull();
      expect(fetched?.dirtyAtDispatch).toBe(false);

      const listed = store.list().find((t) => t.id === task.id);
      expect(listed?.baseCommit).toBeNull();
      expect(listed?.dirtyAtDispatch).toBe(false);
    });

    it("can set baseCommit and dirtyAtDispatch via update", () => {
      const task = store.create(input());
      const updated = store.update(task.id, {
        baseCommit: "abc1234def",
        dirtyAtDispatch: true,
      });

      expect(updated?.baseCommit).toBe("abc1234def");
      expect(updated?.dirtyAtDispatch).toBe(true);

      const fetched = store.get(task.id);
      expect(fetched?.baseCommit).toBe("abc1234def");
      expect(fetched?.dirtyAtDispatch).toBe(true);
    });

    it("can clear baseCommit back to null", () => {
      const task = store.create(input());
      store.update(task.id, { baseCommit: "abc1234", dirtyAtDispatch: true });
      store.update(task.id, { baseCommit: null, dirtyAtDispatch: false });

      const cleared = store.get(task.id);
      expect(cleared?.baseCommit).toBeNull();
      expect(cleared?.dirtyAtDispatch).toBe(false);
    });

    it("migrates baseCommit and dirtyAtDispatch into a pre-existing DB (columns added)", () => {
      const db = new Database(":memory:");
      db.exec(`
        CREATE TABLE task (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, directory TEXT NOT NULL,
          column TEXT NOT NULL, position INTEGER NOT NULL, session_id TEXT, run_state TEXT NOT NULL,
          error TEXT, agent TEXT, model TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          UNIQUE(column, position)
        );
      `);

      // Insert a row into the pre-migration schema
      db.prepare(
        "INSERT INTO task (id, title, description, directory, column, position, session_id, run_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("task_pre", "Pre", "desc", "/repo", "todo", 0, null, "unstarted", 1000, 1000);

      const migratedStore = new SqliteTaskStore(db);

      // Verify the new columns were added
      const taskColumns = new Set(
        (db.prepare("PRAGMA table_info(task)").all() as Array<{ name: string }>).map((row) => row.name),
      );
      expect(taskColumns.has("base_commit")).toBe(true);
      expect(taskColumns.has("dirty_at_dispatch")).toBe(true);
      expect(taskColumns.has("auto_run")).toBe(true);
      expect(taskColumns.has("fallback_model")).toBe(true);
      expect(taskColumns.has("active_model")).toBe(true);
      expect(taskColumns.has("auto_retries")).toBe(true);

      // Existing row got the defaults
      const existing = migratedStore.get("task_pre");
      expect(existing?.baseCommit).toBeNull();
      expect(existing?.dirtyAtDispatch).toBe(false);
      expect(existing?.autoRun).toBe(false);
      expect(existing?.autoRetries).toBe(0);

      // New rows created after migration also work
      const created = migratedStore.create(input({ title: "Post" }));
      expect(created.baseCommit).toBeNull();
      expect(created.dirtyAtDispatch).toBe(false);
      expect(created.autoRun).toBe(false);
      expect(created.autoRetries).toBe(0);

      migratedStore.close();
      db.close();
    });

    it("hydrates a legacy row missing the auto_run column as false", () => {
      const db = new Database(":memory:");
      db.exec(`
        CREATE TABLE task (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, directory TEXT NOT NULL,
          column TEXT NOT NULL, position INTEGER NOT NULL, session_id TEXT, run_state TEXT NOT NULL,
          error TEXT, agent TEXT, model TEXT, isolation TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          UNIQUE(column, position)
        );
      `);

      db.prepare(
        "INSERT INTO task (id, title, description, directory, column, position, session_id, run_state, isolation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("task_legacy", "Legacy", "desc", "/repo", "todo", 0, null, "unstarted", "worktree", 1000, 1000);

      const migratedStore = new SqliteTaskStore(db);

      const legacy = migratedStore.get("task_legacy");
      expect(legacy?.autoRun).toBe(false);
      expect(legacy?.autoRetries).toBe(0);
      expect(legacy?.isolation).toBe("worktree");

      migratedStore.close();
      db.close();
    });
  });

  describe("verificationPolicy persistence", () => {
    it("defaults verificationPolicy to { mode: 'inherit' } on new tasks", () => {
      const task = store.create(input());
      expect(task.verificationPolicy).toEqual({ mode: "inherit" });
      expect(store.get(task.id)!.verificationPolicy).toEqual({ mode: "inherit" });
    });

    it("round-trips verificationPolicy through create/update/list/get", () => {
      const policy = { mode: "required" as const, checkIds: ["lint", "test"] };
      const created = store.create(input({ verificationPolicy: policy }));
      expect(created.verificationPolicy).toEqual(policy);
      expect(store.get(created.id)!.verificationPolicy).toEqual(policy);
      expect(store.list().find((t) => t.id === created.id)!.verificationPolicy).toEqual(policy);

      const updated = store.update(created.id, { verificationPolicy: { mode: "disabled" } });
      expect(updated!.verificationPolicy).toEqual({ mode: "disabled" });
      expect(store.get(created.id)!.verificationPolicy).toEqual({ mode: "disabled" });

      const cleared = store.update(created.id, { verificationPolicy: null });
      expect(cleared!.verificationPolicy).toEqual({ mode: "inherit" });
    });

    it("round-trips verificationPolicy with presetId", () => {
      const policy = { mode: "required" as const, presetId: "quick" };
      const created = store.create(input({ verificationPolicy: policy }));
      expect(created.verificationPolicy).toEqual(policy);
      expect(store.get(created.id)!.verificationPolicy).toEqual(policy);
    });

    it("round-trips verificationPolicy with both presetId and checkIds", () => {
      const policy = { mode: "required" as const, presetId: "full", checkIds: ["lint"] };
      const created = store.create(input({ verificationPolicy: policy }));
      expect(created.verificationPolicy).toEqual(policy);
    });

    it("reopen preserves verificationPolicy across column/state transitions", () => {
      const policy = { mode: "required" as const, checkIds: ["lint"] };
      const task = store.create(input({ verificationPolicy: policy }));
      store.update(task.id, { runState: "running", runStartedAt: 200 });
      store.move(task.id, "in_progress", 0);
      store.update(task.id, { runState: "idle", completionSource: "idle-fallback" });
      store.move(task.id, "review", 0);

      // Retry/reopen
      store.update(task.id, { runState: "running", runStartedAt: 300, completion: null, completionSource: null });
      store.move(task.id, "in_progress", 0);

      const reopened = store.get(task.id);
      expect(reopened!.verificationPolicy).toEqual(policy);
    });

    it("hydrates legacy rows (no verification_policy column) as { mode: 'inherit' }", () => {
      const db = new Database(":memory:");
      db.exec(`
        CREATE TABLE task (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, directory TEXT NOT NULL,
          column TEXT NOT NULL, position INTEGER NOT NULL, session_id TEXT, run_state TEXT NOT NULL,
          error TEXT, agent TEXT, model TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          UNIQUE(column, position)
        );
      `);
      db.prepare(
        "INSERT INTO task (id, title, description, directory, column, position, session_id, run_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("task_legacy", "Legacy", "desc", "/repo", "todo", 0, null, "unstarted", 1000, 1000);

      const migrated = new SqliteTaskStore(db);
      const legacy = migrated.get("task_legacy");
      expect(legacy!.verificationPolicy).toEqual({ mode: "inherit" });

      const taskColumns = new Set(
        (db.prepare("PRAGMA table_info(task)").all() as Array<{ name: string }>).map((row) => row.name),
      );
      expect(taskColumns.has("verification_policy")).toBe(true);

      migrated.close();
      db.close();
    });
  });

  describe("verification catalog + presets + board default access", () => {
    function chk(id: string): import("../../src/shared").VerificationCheckDefinition {
      return { id, label: `${id} check`, command: `run ${id}`, timeoutMs: 30_000, maxOutputBytes: 10_000 };
    }

    it("catalog access round-trips checks through persistence", () => {
      const checks = [chk("lint"), chk("test")];
      store.setVerificationCatalog(checks);
      expect(store.getVerificationCatalog()).toEqual(checks);
    });

    it("catalog access returns an empty array when nothing is persisted", () => {
      expect(store.getVerificationCatalog()).toEqual([]);
    });

    it("catalog access rejects malformed entries rather than silently filtering", () => {
      const db = (store as any).db as any;
      db.prepare("INSERT OR REPLACE INTO board_setting (key, value) VALUES (?, ?)").run(
        "boardVerificationCatalog",
        JSON.stringify([
          { id: "good", label: "Good", command: "cmd", timeoutMs: 1000, maxOutputBytes: 1000 },
          { id: "bad", command: "missing-fields" },
        ]),
      );
      expect(store.getVerificationCatalog()).toEqual([]);
    });

    it("presets round-trips through persistence", () => {
      store.setVerificationCatalog([chk("lint"), chk("test")]);
      const presets = [
        { id: "quick", label: "Quick", checkIds: ["lint"] },
        { id: "full", label: "Full", checkIds: ["lint", "test"] },
      ];
      store.setVerificationPresets(presets);
      expect(store.getVerificationPresets()).toEqual(presets);
    });

    it("presets returns an empty array when nothing is persisted", () => {
      expect(store.getVerificationPresets()).toEqual([]);
    });

it("presets rejects malformed entries", () => {
      store.setVerificationCatalog([chk("lint")]);
      const db = (store as any).db as any;
      db.prepare("INSERT OR REPLACE INTO board_setting (key, value) VALUES (?, ?)").run(
        "boardVerificationPresets",
        JSON.stringify([
          { id: "good", label: "Good", checkIds: ["lint"] },
          { id: "bad" }, // missing label and checkIds
        ]),
      );
      expect(store.getVerificationPresets()).toEqual([]);
    });

    it("board default policy round-trips through persistence", () => {
      const policy = { mode: "required" as const, checkIds: ["lint"] };
      store.setBoardVerificationDefault(policy);
      expect(store.getBoardVerificationDefault()).toEqual(policy);

      store.setBoardVerificationDefault(null);
      expect(store.getBoardVerificationDefault()).toBeNull();
    });

    it("board default returns null when nothing is persisted", () => {
      expect(store.getBoardVerificationDefault()).toBeNull();
    });

    it("board default rejects invalid persisted shapes", () => {
      const db = (store as any).db as any;
      db.prepare("INSERT OR REPLACE INTO board_setting (key, value) VALUES (?, ?)").run(
        "boardVerificationDefault",
        JSON.stringify({ mode: "invalid-mode", checkIds: ["x"] }),
      );
      expect(store.getBoardVerificationDefault()).toBeNull();
    });

    it("board default rejects required mode with invalid checkIds", () => {
      const db = (store as any).db as any;
      db.prepare("INSERT OR REPLACE INTO board_setting (key, value) VALUES (?, ?)").run(
        "boardVerificationDefault",
        JSON.stringify({ mode: "required", checkIds: [""] }),
      );
      expect(store.getBoardVerificationDefault()).toBeNull();
    });

    it("setBoardVerificationDefault rejects invalid modes at write time", () => {
      expect(() => store.setBoardVerificationDefault({ mode: "invalid" as any })).toThrow();
    });

    it("setBoardVerificationDefault rejects invalid checkIds at write time", () => {
      expect(() => store.setBoardVerificationDefault({ mode: "required" as const, checkIds: [""] })).toThrow();
    });
  });
});
