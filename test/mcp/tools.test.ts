import { describe, expect, it, vi } from "vitest";
import {
  BOARD_UNAVAILABLE_MESSAGE,
  DEFAULT_BOARD_URL,
  abortTask,
  addTasks,
  answerBlockedTask,
  blockTask,
  commentTask,
  completeTask,
  createTask,
  integrateTask,
  linkTasks,
  listAgents,
  listTasks,
  moveTask,
  currentInstance,
  openboardStatus,
  respondPermission,
  sendSessionMessage,
  resolveBoardUrl,
  retryTask,
  runTask,
  syncTask,
  tailSession,
  taskCompare,
  taskContext,
  taskDiff,
  taskEvents,
  unlinkTasks,
} from "../../src/mcp/tools";
import type { CompactBlockedProjection, TaskSummary } from "../../src/client/board-client";
import type { McpToolOptions } from "../../src/mcp/tools";
import type { DiffResponse, PendingPermissionAsk, RosterAgent, SessionActivityEvent, SessionActivityRun, Task } from "../../src/shared";
import { toTaskSummary } from "../../src/client/board-client";

const CWD = "/tmp/openboard-project";
const NO_AUTH_ENV = { OPENBOARD_API_TOKEN: "" };
const SELECTED_ENV = {
  OPENCODE_BOARD_URL: "http://127.0.0.1:4999",
  OPENBOARD_API_TOKEN: "secret-token",
  OPENBOARD_INSTANCE_NAME: "alpha",
  OPENBOARD_INSTANCE_PORT: "4999",
  OPENBOARD_INSTANCE_WORKSPACE: "/repo/alpha",
  OPENBOARD_INSTANCE_DB_PATH: "/data/alpha/board.sqlite",
  OPENBOARD_SELECTION_SOURCE: "cli --instance",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** One step of a fake SSE stream: a frame, optionally after a delay. */
interface SseStep {
  frame: unknown;
  delayMs?: number;
}

/** Build a fake `text/event-stream` Response emitting the given frames in order, closing after the last one. */
function sseResponse(steps: SseStep[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const step of steps) {
        if (step.delayMs) {
          await new Promise((resolve) => setTimeout(resolve, step.delayMs));
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(step.frame)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function directoryStat(isDirectory = true): { isDirectory(): boolean } {
  return { isDirectory: () => isDirectory };
}

function createdTask(id: string, input: Record<string, unknown>): Task {
  return {
    id,
    type: input.type as Task["type"],
    taskKind: input.taskKind as Task["taskKind"],
    title: input.title as string,
    description: input.description as string,
    directory: input.directory as string,
    harness: input.harness as Task["harness"],
    agent: input.agent as string | undefined,
    permissionMode: input.permissionMode as Task["permissionMode"],
    claudePermissionMode: input.claudePermissionMode as Task["claudePermissionMode"],
    acpOptions: input.acpOptions as Task["acpOptions"],
    assignedTo: input.assignedTo as string | undefined,
    model: input.model as Task["model"],
    isolation: input.isolation as Task["isolation"],
    autoRun: input.autoRun as Task["autoRun"],
    parentIds: input.parentIds as Task["parentIds"],
    column: "todo",
    position: 0,
    runState: "unstarted",
    baseCommit: null,
    dirtyAtDispatch: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeOptions(
  dirs: Iterable<string>,
  fetchImpl?: ReturnType<typeof vi.fn>,
): McpToolOptions & {
  fetchMock: ReturnType<typeof vi.fn>;
  statMock: ReturnType<typeof vi.fn>;
} {
  const existingDirs = new Set(dirs);
  let nextId = 1;

  const fetchMock =
    fetchImpl ??
    vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse(createdTask(`task-${nextId++}`, input), 201);
    });

  const statMock = vi.fn(async (path: string) => {
    if (!existingDirs.has(path)) {
      throw new Error("ENOENT");
    }
    return directoryStat();
  });

  return {
    cwd: CWD,
    fetch: fetchMock as McpToolOptions["fetch"],
    stat: statMock as McpToolOptions["stat"],
    fetchMock,
    statMock,
  };
}

describe("MCP add_tasks", () => {
  it("creates a manual task through create_task", async () => {
    const options = makeOptions([CWD]);

    const result = await createTask(
      {
        type: "manual",
        title: " Triage bug ",
        description: "Manual QA",
        directory: CWD,
        assignedTo: " Johnny ",
      },
      options,
    );

    expect(result.task).toMatchObject({
      id: "task-1",
      type: "manual",
      title: "Triage bug",
      assignedTo: "Johnny",
      column: "todo",
      runState: "unstarted",
    });
    expect(JSON.parse(String(options.fetchMock.mock.calls[0][1]?.body))).toEqual({
      type: "manual",
      title: "Triage bug",
      description: "Manual QA",
      directory: CWD,
      assignedTo: "Johnny",
    });
  });

  it("creates one task through POST /api/tasks with parsed model and valid isolation", async () => {
    const options = makeOptions([`${CWD}/app`]);

    const result = await addTasks(
      {
        tasks: [
          {
            title: " Ship the MCP intake ",
            description: "Create cards only",
            directory: `${CWD}/app`,
            agent: " build ",
            model: "opencode/north-mini-code-free",
            isolation: "worktree",
          },
        ],
      },
      options,
    );

    expect(result).toEqual({
      boardUrl: DEFAULT_BOARD_URL,
      count: 1,
      created: [
        {
          id: "task-1",
          type: "agent",
          title: "Ship the MCP intake",
          directory: `${CWD}/app`,
          column: "todo",
          runState: "unstarted",
          agent: "build",
          model: { providerID: "opencode", id: "north-mini-code-free" },
          isolation: "worktree",
          pendingPermissions: [],
          dominantState: "queued",
        },
      ],
    });

    expect(options.fetchMock).toHaveBeenCalledTimes(1);
    expect(options.fetchMock).toHaveBeenCalledWith(
      `${DEFAULT_BOARD_URL}/api/tasks`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          type: "agent",
          title: "Ship the MCP intake",
          description: "Create cards only",
          directory: `${CWD}/app`,
          agent: "build",
          model: { providerID: "opencode", id: "north-mini-code-free" },
          isolation: "worktree",
        }),
      }),
    );
  });

  it("creates claude-code tasks through POST /api/tasks", async () => {
    const options = makeOptions([`${CWD}/app`]);

    const result = await addTasks(
      {
        tasks: [
          {
            title: " Claude worker ",
            description: "Launch Claude Code",
            directory: `${CWD}/app`,
            harness: "claude-code",
            agent: "plan",
            claudePermissionMode: "bypassPermissions",
            model: "claude-code/sonnet",
            isolation: "worktree",
          },
        ],
      },
      options,
    );

    expect(result.created[0]).toMatchObject({
      id: "task-1",
      type: "agent",
      harness: "claude-code",
      title: "Claude worker",
      claudePermissionMode: "bypassPermissions",
      model: { providerID: "claude-code", id: "sonnet" },
      isolation: "worktree",
    });
    expect(JSON.parse(String(options.fetchMock.mock.calls[0][1]?.body))).toEqual({
      type: "agent",
      harness: "claude-code",
      title: "Claude worker",
      description: "Launch Claude Code",
      directory: `${CWD}/app`,
      claudePermissionMode: "bypassPermissions",
      model: { providerID: "claude-code", id: "sonnet" },
      isolation: "worktree",
    });
  });

  it("creates Codex ACP tasks through POST /api/tasks", async () => {
    const options = makeOptions([`${CWD}/app`]);

    const result = await addTasks(
      {
        tasks: [
          {
            title: " Codex worker ",
            description: "Launch Codex ACP",
            directory: `${CWD}/app`,
            harness: "codex",
            permissionMode: "manual",
            acpOptions: { reasoningEffort: "low" },
            model: "codex/gpt-5-codex",
            isolation: "worktree",
          },
        ],
      },
      options,
    );

    expect(result.created[0]).toMatchObject({
      id: "task-1",
      type: "agent",
      harness: "codex",
      title: "Codex worker",
      permissionMode: "manual",
      acpOptions: { reasoningEffort: "low" },
      model: { providerID: "codex", id: "gpt-5-codex" },
      isolation: "worktree",
    });
    expect(JSON.parse(String(options.fetchMock.mock.calls[0][1]?.body))).toEqual({
      type: "agent",
      harness: "codex",
      title: "Codex worker",
      description: "Launch Codex ACP",
      directory: `${CWD}/app`,
      permissionMode: "manual",
      acpOptions: { reasoningEffort: "low" },
      model: { providerID: "codex", id: "gpt-5-codex" },
      isolation: "worktree",
    });
  });

  it("creates multiple tasks without calling any run endpoint", async () => {
    const options = makeOptions([`${CWD}/one`, `${CWD}/two`]);

    const result = await addTasks(
      {
        tasks: [
          { title: "One", directory: "one" },
          { title: "Two", directory: "two", isolation: "in-place" },
        ],
      },
      options,
    );

    expect(result.created.map((task) => task.id)).toEqual(["task-1", "task-2"]);
    expect(options.fetchMock).toHaveBeenCalledTimes(2);
    expect(options.fetchMock.mock.calls.map((call: unknown[]) => String(call[0]))).toEqual([
      `${DEFAULT_BOARD_URL}/api/tasks`,
      `${DEFAULT_BOARD_URL}/api/tasks`,
    ]);
  });

  it("uses the MCP process cwd when directory is omitted", async () => {
    const options = makeOptions([CWD]);

    await addTasks({ tasks: [{ title: "Use cwd" }] }, options);

    expect(options.statMock).toHaveBeenCalledWith(CWD);
    expect(JSON.parse(String(options.fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      title: "Use cwd",
      directory: CWD,
    });
  });

  it("resolves relative directories against cwd", async () => {
    const options = makeOptions([`${CWD}/packages/api`]);

    await addTasks({ tasks: [{ title: "Relative", directory: "packages/api" }] }, options);

    expect(options.statMock).toHaveBeenCalledWith(`${CWD}/packages/api`);
    expect(JSON.parse(String(options.fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      directory: `${CWD}/packages/api`,
    });
  });

  it("rejects an invalid title before POSTing", async () => {
    const options = makeOptions([CWD]);

    await expect(addTasks({ tasks: [{ title: "  " }] }, options)).rejects.toThrow(
      "title must be a non-empty string",
    );
    expect(options.fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a nonexistent directory before POSTing", async () => {
    const options = makeOptions([]);

    await expect(addTasks({ tasks: [{ title: "Missing dir", directory: "missing" }] }, options)).rejects.toThrow(
      `directory does not exist: ${CWD}/missing`,
    );
    expect(options.fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid model before POSTing", async () => {
    const options = makeOptions([CWD]);

    await expect(addTasks({ tasks: [{ title: "Bad model", model: "north-mini-code-free" }] }, options)).rejects.toThrow(
      'model must use "provider/model-id"',
    );
    expect(options.fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid isolation before POSTing", async () => {
    const options = makeOptions([CWD]);

    await expect(addTasks({ tasks: [{ title: "Bad isolation", isolation: "container" }] }, options)).rejects.toThrow(
      "Invalid option",
    );
    expect(options.fetchMock).not.toHaveBeenCalled();
  });

  it("reports the board-startup hint when fetch cannot connect", async () => {
    const options = makeOptions(
      [CWD],
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );

    await expect(addTasks({ tasks: [{ title: "Needs board" }] }, options)).rejects.toThrow(
      BOARD_UNAVAILABLE_MESSAGE,
    );
  });
it("forwards taskKind through addTasks POST body", async () => {
    const options = makeOptions([CWD]);

    const result = await addTasks(
      {
        tasks: [
          {
            title: "Build coverage",
            description: "Add tests",
            directory: CWD,
            taskKind: "build",
            isolation: "worktree",
          },
        ],
      },
      options,
    );

    expect(result.created[0]).toMatchObject({
      id: "task-1",
      type: "agent",
      title: "Build coverage",
      taskKind: "build",
      column: "todo",
      runState: "unstarted",
    });
    expect(options.fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(options.fetchMock.mock.calls[0][1]?.body))).toEqual({
      type: "agent",
      title: "Build coverage",
      description: "Add tests",
      directory: CWD,
      taskKind: "build",
      isolation: "worktree",
    });
  });

  it("forwards taskKind through createTask POST body for manual tasks", async () => {
    const options = makeOptions([CWD]);

    const result = await createTask(
      {
        type: "manual",
        title: "Research task",
        description: "Research something",
        directory: CWD,
        taskKind: "research",
        assignedTo: "Alice",
      },
      options,
    );

    expect(result.task).toMatchObject({
      id: "task-1",
      type: "manual",
      title: "Research task",
      taskKind: "research",
      column: "todo",
      runState: "unstarted",
    });
    expect(JSON.parse(String(options.fetchMock.mock.calls[0][1]?.body))).toEqual({
      type: "manual",
      title: "Research task",
      description: "Research something",
      directory: CWD,
      taskKind: "research",
      assignedTo: "Alice",
    });
  });

  it("rejects bad taskKind before POSTing", async () => {
    const options = makeOptions([CWD]);

    await expect(
      addTasks({ tasks: [{ title: "Bad kind", taskKind: "investigate" as never }] }, options),
    ).rejects.toThrow();

    expect(options.fetchMock).not.toHaveBeenCalled();
  });

  it("forwards autoRun through addTasks POST body for a worktree-isolated task", async () => {
    const options = makeOptions([`${CWD}/app`]);

    const result = await addTasks(
      {
        tasks: [
          {
            title: "Chain child",
            directory: `${CWD}/app`,
            isolation: "worktree",
            autoRun: true,
          },
        ],
      },
      options,
    );

    expect(result.created[0]).toMatchObject({ id: "task-1", isolation: "worktree", autoRun: true });
    expect(JSON.parse(String(options.fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      isolation: "worktree",
      autoRun: true,
    });
  });

  it("forwards autoRun through createTask POST body", async () => {
    const options = makeOptions([`${CWD}/app`]);

    await createTask(
      { title: "Chain root", directory: `${CWD}/app`, isolation: "worktree", autoRun: false },
      options,
    );

    expect(JSON.parse(String(options.fetchMock.mock.calls[0][1]?.body))).toMatchObject({ autoRun: false });
  });

  it("rejects a non-boolean autoRun before POSTing", async () => {
    const options = makeOptions([CWD]);

    await expect(
      addTasks({ tasks: [{ title: "Bad autoRun", isolation: "worktree", autoRun: "yes" as never }] }, options),
    ).rejects.toThrow();
    expect(options.fetchMock).not.toHaveBeenCalled();
  });
});

describe("MCP orchestrator tools", () => {
  const task: Task = {
    id: "task-1",
    title: "A",
    description: "",
    directory: CWD,
    column: "in_progress",
    position: 0,
    runState: "running",
    sessionId: "ses_1",
    runStartedAt: 10,
    parentIds: ["task-0"],
    baseCommit: null,
    dirtyAtDispatch: false,
    createdAt: 1,
    updatedAt: 2,
  };

  it("wraps run/retry/abort/link/unlink/complete/block/sync/integrate/comment/event/diff endpoints", async () => {
    const outcome = { task, ok: true, conflict: false, message: "merged" };
    const diff: DiffResponse = {
      kind: "diff",
      files: [{ file: "src/a.ts", additions: 1, deletions: 0, status: "added", patch: "@@" }],
      capped: false,
      root: CWD,
    };
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/sync") || path.endsWith("/integrate")) return jsonResponse(outcome);
      if (path.endsWith("/comments")) return jsonResponse({ id: "comment_1", taskId: "task-1", author: "me", body: "note", createdAt: 3 }, 201);
      if (path.endsWith("/events")) return jsonResponse([{ id: "event_1", taskId: "task-1", type: "task_run", body: {}, createdAt: 4 }]);
      if (path.endsWith("/diff")) return jsonResponse(diff);
      return jsonResponse(task);
    });
    const options = makeOptions([CWD], fetchMock);
    const report = { summary: "done", changedFiles: [], verification: [], residualRisk: "none" };

    await runTask({ taskId: "task-1" }, options);
    await retryTask({ taskId: "task-1", feedback: "again" }, options);
    await abortTask({ taskId: "task-1" }, options);
    await linkTasks({ parentId: "task-0", childId: "task-1" }, options);
    await unlinkTasks({ parentId: "task-0", childId: "task-1" }, options);
    await completeTask({ taskId: "task-1", runStartedAt: 10, report }, options);
    await blockTask({ taskId: "task-1", report }, options);
    await syncTask({ taskId: "task-1" }, options);
    await integrateTask({ taskId: "task-1", confirmReviewed: true, targetBranch: "main" }, options);
    await commentTask({ taskId: "task-1", author: "me", body: "note" }, options);
    const events = await taskEvents({ taskId: "task-1" }, options);
    const diffResult = await taskDiff({ taskId: "task-1" }, options);

    expect(events.count).toBe(1);
    expect(diffResult).toEqual({ boardUrl: DEFAULT_BOARD_URL, taskId: "task-1", diff });
    expect(fetchMock.mock.calls.map((call: unknown[]) => new URL(String(call[0])).pathname)).toEqual([
      "/api/tasks/task-1/run",
      "/api/tasks/task-1/retry",
      "/api/tasks/task-1/abort",
      "/api/tasks/task-1/links",
      "/api/tasks/task-1/links/task-0",
      "/api/tasks/task-1/complete",
      "/api/tasks/task-1/block",
      "/api/tasks/task-1/sync",
      "/api/tasks/task-1/integrate",
      "/api/tasks/task-1/comments",
      "/api/tasks/task-1/events",
      "/api/tasks/task-1/diff",
    ]);
    expect(new URL(String(fetchMock.mock.calls[5][0])).search).toBe("?runStartedAt=10");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ feedback: "again" });
    expect(JSON.parse(String(fetchMock.mock.calls[8][1]?.body))).toEqual({ targetBranch: "main" });
  });

  it("passes needsInput through block_task to POST /block (FR12 question channel)", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => jsonResponse(task));
    const options = makeOptions([CWD], fetchMock);
    const report = { summary: "blocked", changedFiles: [], verification: [], residualRisk: "blocked" };

    await blockTask({ taskId: "task-1", report: { ...report, needsInput: "Which env var should I use?" } }, options);

    expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toBe("/api/tasks/task-1/block");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      ...report,
      needsInput: "Which env var should I use?",
    });
  });

  it("trims needsInput and rejects it once empty or over 2000 chars, mirroring the /block route", async () => {
    const options = makeOptions([CWD]);
    const report = { summary: "blocked", changedFiles: [], verification: [], residualRisk: "blocked" };

    await expect(
      blockTask({ taskId: "task-1", report: { ...report, needsInput: "   " } }, options),
    ).rejects.toThrow();
    await expect(
      blockTask({ taskId: "task-1", report: { ...report, needsInput: "x".repeat(2001) } }, options),
    ).rejects.toThrow();
    expect(options.fetchMock).not.toHaveBeenCalled();
  });

  it("still rejects needsInput on complete_task — /complete forbids it by design", async () => {
    const options = makeOptions([CWD]);
    const report = { summary: "done", changedFiles: [], verification: [], residualRisk: "none" };

    await expect(
      completeTask({ taskId: "task-1", report: { ...report, needsInput: "should not be allowed" } }, options),
    ).rejects.toThrow();
    expect(options.fetchMock).not.toHaveBeenCalled();
  });

  it("requires completedBy for MCP moves to done", async () => {
    const options = makeOptions([CWD], vi.fn(async () => jsonResponse([task])));

    await expect(moveTask({ taskId: "task-1", column: "done", position: 0 }, options)).rejects.toThrow(
      "completedBy is required",
    );

    await moveTask({ taskId: "task-1", column: "done", position: 0, completedBy: "orchestrator" }, options);
    expect(JSON.parse(String(options.fetchMock.mock.calls[0][1]?.body))).toEqual({
      column: "done",
      position: 0,
      completedBy: "orchestrator",
    });
  });

  it("requires explicit review confirmation before integrate_task", async () => {
    const options = makeOptions([CWD]);

    await expect(integrateTask({ taskId: "task-1", targetBranch: "main" }, options)).rejects.toThrow();
    expect(options.fetchMock).not.toHaveBeenCalled();
  });

  it("does not fall back to 4097 when MCP requires an explicit board selection", async () => {
    const options = makeOptions([CWD]);
    options.requireExplicitBoardUrl = true;
    options.env = {};

    await expect(runTask({ taskId: "task-1" }, options)).rejects.toThrow("No OpenBoard instance selected");
    expect(options.fetchMock).not.toHaveBeenCalled();
  });

  it("reports current instance selection without exposing tokens", async () => {
    const result = await currentInstance({ env: SELECTED_ENV, requireExplicitBoardUrl: true });

    expect(result).toEqual({
      boardUrl: "http://127.0.0.1:4999",
      selection: {
        selected: true,
        source: "cli --instance",
        instanceName: "alpha",
        boardUrl: "http://127.0.0.1:4999",
        port: 4999,
        workspace: "/repo/alpha",
        dbPath: "/data/alpha/board.sqlite",
        boardTokenPresent: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("reports openboard_status with health identity and cheap counts", async () => {
    const health = {
      adapter: "ok",
      opencode: { status: "ok", version: "1.2.3" },
      identity: {
        instanceName: "alpha",
        boardUrl: "http://127.0.0.1:4999",
        port: 4999,
        workspace: "/repo/alpha",
        dbPath: "/data/alpha/board.sqlite",
        boardTokenPresent: true,
      },
    };
    const fetchMock = vi.fn(async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/health") return jsonResponse(health);
      if (path === "/api/agents") return jsonResponse([{ id: "build", mode: "primary" }]);
      if (path === "/api/tasks") return jsonResponse([task]);
      return jsonResponse({});
    });

    const result = await openboardStatus({
      fetch: fetchMock as McpToolOptions["fetch"],
      cwd: CWD,
      env: SELECTED_ENV,
      requireExplicitBoardUrl: true,
      mcpStartedAt: "2026-07-04T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      boardUrl: "http://127.0.0.1:4999",
      apiReachable: true,
      agentCount: 1,
      taskCount: 1,
      mcpStartedAt: "2026-07-04T00:00:00.000Z",
      selection: {
        instanceName: "alpha",
        boardUrl: "http://127.0.0.1:4999",
        port: 4999,
        workspace: "/repo/alpha",
        dbPath: "/data/alpha/board.sqlite",
        boardTokenPresent: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });
});

describe("MCP list tools", () => {
  it("lists tasks through GET /api/tasks", async () => {
    const tasks: Task[] = [
      {
        id: "t1",
        title: "Existing",
        description: "",
        directory: CWD,
        column: "review",
        position: 0,
        runState: "idle",
        agent: "build",
        isolation: "worktree",
        sessionId: "session-1",
        baseCommit: null,
        dirtyAtDispatch: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const fetchMock = vi.fn(async () => jsonResponse(tasks));

    const result = await listTasks({ fetch: fetchMock, cwd: CWD, env: NO_AUTH_ENV });

    expect(fetchMock).toHaveBeenCalledWith(`${DEFAULT_BOARD_URL}/api/tasks`, { method: "GET" });
    expect(result).toEqual({
      boardUrl: DEFAULT_BOARD_URL,
      count: 1,
      tasks: [
        {
          id: "t1",
          type: "agent",
          title: "Existing",
          directory: CWD,
          column: "review",
          runState: "idle",
          agent: "build",
          isolation: "worktree",
          sessionId: "session-1",
          pendingPermissions: [],
          dominantState: "review",
        },
      ],
    });
  });

  it("includes autoRun in the task summary projection so orchestrators can see chain configuration", async () => {
    const tasks: Task[] = [
      {
        id: "t2",
        title: "Chain child",
        description: "",
        directory: CWD,
        column: "todo",
        position: 0,
        runState: "unstarted",
        isolation: "worktree",
        autoRun: true,
        parentIds: ["t1"],
        baseCommit: null,
        dirtyAtDispatch: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const fetchMock = vi.fn(async () => jsonResponse(tasks));

    const result = await listTasks({ fetch: fetchMock, cwd: CWD, env: NO_AUTH_ENV });

    expect(result.tasks[0]).toMatchObject({ id: "t2", isolation: "worktree", autoRun: true });
  });

  it("lists agents through GET /api/agents", async () => {
    const agents: RosterAgent[] = [
      { id: "build", mode: "primary", description: "Build agent" },
      { id: "plan", mode: "subagent", model: { providerID: "opencode", id: "north-mini-code-free" } },
    ];
    const fetchMock = vi.fn(async () => jsonResponse(agents));

    const result = await listAgents({ fetch: fetchMock, cwd: CWD, env: NO_AUTH_ENV });

    expect(fetchMock).toHaveBeenCalledWith(`${DEFAULT_BOARD_URL}/api/agents`, { method: "GET" });
    expect(result).toEqual({ boardUrl: DEFAULT_BOARD_URL, count: 2, agents });
  });

  it("fetches task diff through GET /api/tasks/:id/diff", async () => {
    const diff: DiffResponse = {
      kind: "diff",
      files: [{ file: "src/card.ts", additions: 4, deletions: 1, status: "modified", patch: "@@ -1 +1 @@" }],
      capped: false,
      root: "/repo/.opencode-board-worktrees/task-1",
    };
    const fetchMock = vi.fn(async () => jsonResponse(diff));

    const result = await taskDiff({ taskId: "task-1" }, { fetch: fetchMock, cwd: CWD, env: NO_AUTH_ENV });

    expect(fetchMock).toHaveBeenCalledWith(`${DEFAULT_BOARD_URL}/api/tasks/task-1/diff`, { method: "GET" });
    expect(result).toEqual({ boardUrl: DEFAULT_BOARD_URL, taskId: "task-1", diff });
  });

  it("uses OPENCODE_BOARD_URL when provided", () => {
    expect(resolveBoardUrl({ env: { OPENCODE_BOARD_URL: "http://localhost:5000/" } })).toBe(
      "http://localhost:5000",
    );
  });
});

describe("TaskSummary projection", () => {
  it("includes blocked projection for blocked tasks", () => {
    const now = Date.now();
    const task: Task = {
      id: "t1",
      title: "Blocked task",
      description: "",
      directory: CWD,
      column: "review",
      position: 0,
      runState: "idle",
      baseCommit: null,
      dirtyAtDispatch: false,
      createdAt: 1,
      updatedAt: 1,
      completion: {
        outcome: "blocked",
        summary: "Stuck on permissions",
        changedFiles: [],
        verification: [],
        residualRisk: "Need API access",
        needsInput: "Can you grant me access to the staging API?",
        reportedAt: now,
      },
      completionSource: "reported",
    };

    const summary = toTaskSummary(task);

    expect(summary.blocked).toEqual({
      reportedAt: now,
      question: "Can you grant me access to the staging API?",
      summary: "Stuck on permissions",
      residualRisk: "Need API access",
      source: "reported",
      hasExplicitQuestion: true,
    });
  });

  it("uses residualRisk as question when no needsInput", () => {
    const now = Date.now();
    const task: Task = {
      id: "t2",
      title: "Blocked without explicit question",
      description: "",
      directory: CWD,
      column: "review",
      position: 0,
      runState: "idle",
      baseCommit: null,
      dirtyAtDispatch: false,
      createdAt: 1,
      updatedAt: 1,
      completion: {
        outcome: "blocked",
        summary: "Blocked",
        changedFiles: [],
        verification: [],
        residualRisk: "Need more data",
        reportedAt: now,
      },
    };

    const summary = toTaskSummary(task);

    expect(summary.blocked?.question).toBe("Need more data");
    expect(summary.blocked?.hasExplicitQuestion).toBeUndefined();
  });

  it("includes pendingPermissions when present", () => {
    const now = Date.now();
    const ask: PendingPermissionAsk = {
      id: "ask_1",
      harness: "opencode",
      source: "worktree-fence",
      permission: "external_directory",
      tool: "Bash",
      summary: "bash outside worktree",
      patterns: ["/etc/*"],
      raisedAt: now,
      deadline: now + 30000,
    };
    const task: Task = {
      id: "t3",
      title: "Permission blocked",
      description: "",
      directory: CWD,
      column: "review",
      position: 0,
      runState: "idle",
      baseCommit: null,
      dirtyAtDispatch: false,
      createdAt: 1,
      updatedAt: 1,
      pendingPermissions: [ask],
      completion: {
        outcome: "blocked",
        summary: "Need permission",
        changedFiles: [],
        verification: [],
        residualRisk: "Permission ask pending",
        reportedAt: now,
      },
    };

    const summary = toTaskSummary(task);

    expect(summary.pendingPermissions).toEqual([ask]);
  });

  it("includes activeModel, fallbackModel, and autoRetries", () => {
    const task: Task = {
      id: "t4",
      title: "Model tracking",
      description: "",
      directory: CWD,
      column: "in_progress",
      position: 0,
      runState: "running",
      baseCommit: null,
      dirtyAtDispatch: false,
      createdAt: 1,
      updatedAt: 1,
      model: { providerID: "opencode", id: "north-mini-code-free" },
      fallbackModel: { providerID: "opencode", id: "north-free" },
      activeModel: { providerID: "openrouter", id: "sonnet" },
      autoRetries: 2,
    };

    const summary = toTaskSummary(task);

    expect(summary.model).toEqual({ providerID: "opencode", id: "north-mini-code-free" });
    expect(summary.fallbackModel).toEqual({ providerID: "opencode", id: "north-free" });
    expect(summary.activeModel).toEqual({ providerID: "openrouter", id: "sonnet" });
    expect(summary.autoRetries).toBe(2);
  });

  it("includes lineage/evidence booleans when metadata is present", () => {
    const now = Date.now();
    const task: Task = {
      id: "t5",
      title: "With lineage",
      description: "",
      directory: CWD,
      column: "review",
      position: 0,
      runState: "idle",
      baseCommit: null,
      dirtyAtDispatch: false,
      createdAt: 1,
      updatedAt: 1,
      parentIds: ["p1", "p2"],
      completion: {
        outcome: "complete",
        summary: "Done",
        changedFiles: ["src/a.ts"],
        verification: [],
        residualRisk: "none",
        reportedAt: now,
      },
    };

    const summary = toTaskSummary(task);

    expect(summary.hasParentIds).toBe(true);
    expect(summary.hasCompletion).toBe(true);
  });
});

describe("MCP answer_blocked_task", () => {
  it("sends answer and blockedAnswer context through retry endpoint", async () => {
    const task: Task = {
      id: "task-1",
      title: "Blocked",
      description: "",
      directory: CWD,
      column: "review",
      position: 0,
      runState: "idle",
      baseCommit: null,
      dirtyAtDispatch: false,
      createdAt: 1,
      updatedAt: 1,
      completion: {
        outcome: "blocked",
        summary: "Blocked",
        changedFiles: [],
        verification: [],
        residualRisk: "Need input",
        reportedAt: 1700000000,
      },
    };
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => jsonResponse(task));
    const options = makeOptions([CWD], fetchMock);

    const result = await answerBlockedTask(
      {
        taskId: "task-1",
        answer: "Here is the access key: abc123",
        answeredBy: "orchestrator",
        blockedReportedAt: 1700000000,
      },
      options,
    );

    expect(result).toMatchObject({
      boardUrl: DEFAULT_BOARD_URL,
      taskId: "task-1",
      answeredBy: "orchestrator",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      feedback: "Here is the access key: abc123",
      blockedAnswer: {
        blockedReportedAt: 1700000000,
        answeredBy: "orchestrator",
      },
    });
  });
});

describe("MCP respond_permission", () => {
  it("sends askId, action, and answeredBy through task permission endpoint", async () => {
    const updatedTask = createdTask("task-1", {
      title: "Permission task",
      description: "d",
      directory: CWD,
    });
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => jsonResponse(updatedTask));
    const options = makeOptions([CWD], fetchMock);

    const result = await respondPermission(
      {
        taskId: "task-1",
        askId: "ask_1",
        action: "allow_once",
        answeredBy: "orchestrator",
      },
      options,
    );

    expect(result.task).toEqual(toTaskSummary(updatedTask));
    expect(result.taskId).toBe("task-1");
    expect(result.answeredBy).toBe("orchestrator");
    expect(fetchMock.mock.calls[0][0]).toBe(`${DEFAULT_BOARD_URL}/api/tasks/task-1/permission`);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      askId: "ask_1",
      action: "allow_once",
      answeredBy: "orchestrator",
    });
  });
});

describe("MCP send_session_message", () => {
  it("sends attributed chat input to the existing session", async () => {
    const task = createdTask("task-chat", { title: "Chat", description: "d", directory: CWD, sessionId: "ses-chat", runStartedAt: 123 });
    const receipt = { messageId: "msg-chat", taskId: task.id, sessionId: "ses-chat", status: "accepted", mode: "queue", sentAt: 456, sentBy: "orchestrator", task };
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => jsonResponse(receipt, 202));
    const result = await sendSessionMessage({
      taskId: task.id,
      text: "Please explain the current failure",
      mode: "queue",
      sentBy: "orchestrator",
      clientMessageId: "msg-chat",
      expectedSessionId: "ses-chat",
      expectedRunStartedAt: 123,
    }, makeOptions([CWD], fetchMock));

    expect(result.receipt.task).toEqual(toTaskSummary(task));
    expect(fetchMock.mock.calls[0][0]).toBe(`${DEFAULT_BOARD_URL}/api/tasks/${task.id}/session-messages`);
  });
});

describe("MCP task_compare", () => {
  it("calls GET /api/tasks/:targetTaskId/compare?baseTaskId=... endpoint", async () => {
    const compareResponse = {
      kind: "diff" as const,
      baseTaskId: "task-base",
      targetTaskId: "task-target",
      baseRef: "refs/heads/task-base",
      targetRef: "refs/heads/board/task-target",
      files: [{ file: "src/a.ts", additions: 3, deletions: 1, status: "modified" as const }],
      capped: false,
    };
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => jsonResponse(compareResponse));
    const options = makeOptions([CWD], fetchMock);

    const result = await taskCompare(
      { targetTaskId: "task-target", baseTaskId: "task-base" },
      options,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      `${DEFAULT_BOARD_URL}/api/tasks/task-target/compare?baseTaskId=task-base`,
      expect.objectContaining({ method: "GET" }),
    );
    expect(result.comparison).toEqual(compareResponse);
    expect(result.targetTaskId).toBe("task-target");
    expect(result.baseTaskId).toBe("task-base");
  });

  it("rejects when baseTaskId equals targetTaskId", async () => {
    const options = makeOptions([CWD]);

    await expect(
      taskCompare({ targetTaskId: "same-task", baseTaskId: "same-task" }, options),
    ).rejects.toThrow("baseTaskId cannot be the same as targetTaskId");
    expect(options.fetchMock).not.toHaveBeenCalled();
  });
});

describe("MCP move_task with blockedAcceptance", () => {
  it("passes blockedAcceptance when moving blocked task to done", async () => {
    const task: Task = {
      id: "task-1",
      title: "Blocked task",
      description: "",
      directory: CWD,
      column: "review",
      position: 0,
      runState: "idle",
      baseCommit: null,
      dirtyAtDispatch: false,
      createdAt: 1,
      updatedAt: 1,
      completion: {
        outcome: "blocked",
        summary: "Blocked",
        changedFiles: [],
        verification: [],
        residualRisk: "Need input",
        reportedAt: 1700000000,
      },
    };
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => jsonResponse([task]));
    const options = makeOptions([CWD], fetchMock);

    await moveTask(
      {
        taskId: "task-1",
        column: "done",
        position: 0,
        completedBy: "orchestrator",
        blockedAcceptance: {
          blockedReportedAt: 1700000000,
          acceptIncomplete: true,
        },
      },
      options,
    );

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      column: "done",
      position: 0,
      completedBy: "orchestrator",
      blockedAcceptance: {
        blockedReportedAt: 1700000000,
        acceptIncomplete: true,
      },
    });
  });
});

describe("MCP integrate_task with blockedAcceptance", () => {
  it("passes blockedAcceptance to integrate endpoint", async () => {
    const task: Task = {
      id: "task-1",
      title: "Blocked task",
      description: "",
      directory: CWD,
      column: "review",
      position: 0,
      runState: "idle",
      baseCommit: null,
      dirtyAtDispatch: false,
      createdAt: 1,
      updatedAt: 1,
      worktreePath: `${CWD}/worktrees/task-1`,
    };
    const outcome = { task, ok: true, conflict: false, message: "integrated" };
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => jsonResponse(outcome));
    const options = makeOptions([CWD], fetchMock);

    await integrateTask(
      {
        taskId: "task-1",
        confirmReviewed: true,
        blockedAcceptance: {
          blockedReportedAt: 1700000000,
          acceptIncomplete: true,
        },
      },
      options,
    );

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      blockedAcceptance: {
        blockedReportedAt: 1700000000,
        acceptIncomplete: true,
      },
    });
  });
});

describe("MCP tail_session", () => {
  const run: SessionActivityRun = {
    taskId: "task-1",
    runStartedAt: 1000,
    sessionId: "session-1",
    rootSessionId: "session-1",
    harness: "opencode",
  };

  function makeEvent(seq: number): SessionActivityEvent {
    return {
      seq,
      taskId: "task-1",
      runStartedAt: 1000,
      sessionId: "session-1",
      rootSessionId: "session-1",
      harness: "opencode",
      occurredAt: 1000 + seq,
      kind: "text",
      role: "assistant",
      text: `event ${seq}`,
    };
  }

  it("captures the terminal frame that arrives after the snapshot (P2-2)", async () => {
    const snapshotFrame = { kind: "snapshot" as const, run, transport: "live" as const, events: [makeEvent(1)], lastEventAt: 1001 };
    const terminalFrame = { kind: "terminal" as const, status: "complete" as const };
    const fetchMock = vi.fn(async () => sseResponse([
      { frame: snapshotFrame },
      { frame: terminalFrame, delayMs: 30 },
    ]));
    const options = makeOptions([CWD], fetchMock);

    const result = await tailSession({ taskId: "task-1", timeoutMs: 3000 }, options);

    expect(result.terminal).toEqual({ status: "complete" });
    expect(result.run).toEqual(run);
    expect(result.events).toHaveLength(1);
  });

  it("resolves without a terminal signal if none arrives within the bounded window (P2-2)", async () => {
    const snapshotFrame = { kind: "snapshot" as const, run, transport: "live" as const, events: [makeEvent(1)], lastEventAt: 1001 };
    // Only a snapshot — no terminal frame ever arrives on the wire.
    const fetchMock = vi.fn(async () => sseResponse([{ frame: snapshotFrame }]));
    const options = makeOptions([CWD], fetchMock);

    const result = await tailSession({ taskId: "task-1", timeoutMs: 3000 }, options);

    expect(result.terminal).toBeUndefined();
    expect(result.run).toEqual(run);
  }, 2000);

  it("does not flag exactly `limit` events as bounded (off-by-one, P3-15)", async () => {
    const events = [makeEvent(1), makeEvent(2)];
    const snapshotFrame = { kind: "snapshot" as const, run, transport: "live" as const, events, lastEventAt: 1002 };
    const terminalFrame = { kind: "terminal" as const, status: "complete" as const };
    const fetchMock = vi.fn(async () => sseResponse([{ frame: snapshotFrame }, { frame: terminalFrame }]));
    const options = makeOptions([CWD], fetchMock);

    const result = await tailSession({ taskId: "task-1", limit: 2 }, options);

    expect(result.events).toHaveLength(2);
    expect(result.bounded).toBe(false);
  });

  it("flags more-than-limit events as bounded (P3-15)", async () => {
    const events = [makeEvent(1), makeEvent(2), makeEvent(3)];
    const snapshotFrame = { kind: "snapshot" as const, run, transport: "live" as const, events, lastEventAt: 1003 };
    const terminalFrame = { kind: "terminal" as const, status: "complete" as const };
    const fetchMock = vi.fn(async () => sseResponse([{ frame: snapshotFrame }, { frame: terminalFrame }]));
    const options = makeOptions([CWD], fetchMock);

    const result = await tailSession({ taskId: "task-1", limit: 2 }, options);

    expect(result.events).toHaveLength(2);
    expect(result.bounded).toBe(true);
  });
});

describe("MCP task_context", () => {
  const nestedContextBody = {
    task: {
      taskId: "task-1",
      title: "Target",
      description: "desc",
      taskKind: "fix",
      completion: null,
      changedFiles: [],
      verification: [],
      residualRisk: "",
      hasStructuredHandoff: false,
      completionSource: null,
      completionLocation: null,
    },
    directParents: [],
    inheritedParents: [],
    codeAncestors: [],
  };

  it("resolves a nested `task` handoff (P2-3)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(nestedContextBody));
    const options = makeOptions([CWD], fetchMock);
    const result = await taskContext({ taskId: "task-1" }, options);
    expect(result.context.task.taskId).toBe("task-1");
    expect(result.context.directParents).toEqual([]);
  });

  it("rejects a legacy flat response body missing the nested `task` key (P2-3)", async () => {
    const flatLegacyBody = {
      taskId: "task-1",
      title: "Target",
      directParents: [],
      inheritedParents: [],
      codeAncestors: [],
    };
    const fetchMock = vi.fn(async () => jsonResponse(flatLegacyBody));
    const options = makeOptions([CWD], fetchMock);
    await expect(taskContext({ taskId: "task-1" }, options)).rejects.toThrow(
      "unexpected response shape",
    );
  });

  it("goes through the board client so the selected-instance token is authorized, not a bare unauthenticated fetch", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => jsonResponse(nestedContextBody));
    const options = makeOptions([CWD], fetchMock);
    options.env = { OPENBOARD_API_TOKEN: "secret-token" };

    await taskContext({ taskId: "task-1" }, options);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe("Bearer secret-token");
  });
});
