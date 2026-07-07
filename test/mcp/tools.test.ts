import { describe, expect, it, vi } from "vitest";
import {
  BOARD_UNAVAILABLE_MESSAGE,
  DEFAULT_BOARD_URL,
  abortTask,
  addTasks,
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
  resolveBoardUrl,
  retryTask,
  runTask,
  syncTask,
  taskEvents,
  unlinkTasks,
} from "../../src/mcp/tools";
import type { McpToolOptions } from "../../src/mcp/tools";
import type { RosterAgent, Task } from "../../src/shared";

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

function directoryStat(isDirectory = true): { isDirectory(): boolean } {
  return { isDirectory: () => isDirectory };
}

function createdTask(id: string, input: Record<string, unknown>): Task {
  return {
    id,
    type: input.type as Task["type"],
    title: input.title as string,
    description: input.description as string,
    directory: input.directory as string,
    harness: input.harness as Task["harness"],
    agent: input.agent as string | undefined,
    claudePermissionMode: input.claudePermissionMode as Task["claudePermissionMode"],
    assignedTo: input.assignedTo as string | undefined,
    model: input.model as Task["model"],
    isolation: input.isolation as Task["isolation"],
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
      model: { providerID: "codex", id: "gpt-5-codex" },
      isolation: "worktree",
    });
    expect(JSON.parse(String(options.fetchMock.mock.calls[0][1]?.body))).toEqual({
      type: "agent",
      harness: "codex",
      title: "Codex worker",
      description: "Launch Codex ACP",
      directory: `${CWD}/app`,
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

  it("wraps run/retry/abort/link/unlink/complete/block/sync/integrate/comment/event endpoints", async () => {
    const outcome = { task, ok: true, conflict: false, message: "merged" };
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/sync") || path.endsWith("/integrate")) return jsonResponse(outcome);
      if (path.endsWith("/comments")) return jsonResponse({ id: "comment_1", taskId: "task-1", author: "me", body: "note", createdAt: 3 }, 201);
      if (path.endsWith("/events")) return jsonResponse([{ id: "event_1", taskId: "task-1", type: "task_run", body: {}, createdAt: 4 }]);
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

    expect(events.count).toBe(1);
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
    ]);
    expect(new URL(String(fetchMock.mock.calls[5][0])).search).toBe("?runStartedAt=10");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ feedback: "again" });
    expect(JSON.parse(String(fetchMock.mock.calls[8][1]?.body))).toEqual({ targetBranch: "main" });
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
        },
      ],
    });
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

  it("uses OPENCODE_BOARD_URL when provided", () => {
    expect(resolveBoardUrl({ env: { OPENCODE_BOARD_URL: "http://localhost:5000/" } })).toBe(
      "http://localhost:5000",
    );
  });
});
