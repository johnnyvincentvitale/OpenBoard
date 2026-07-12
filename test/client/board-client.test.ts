import { describe, expect, it, vi } from "vitest";
import {
  BOARD_UNAVAILABLE_MESSAGE,
  BOARD_URL_REQUIRED_MESSAGE,
  DEFAULT_BOARD_URL,
  createBoardClient,
  parseModelRef,
  resolveBoardUrl,
} from "../../src/client/board-client";
import type { BoardClientOptions, BoardHealth } from "../../src/client/board-client";
import type { DiffResponse, MergeOutcome, RosterAgent, RosterProvider, Task } from "../../src/shared";

const CWD = "/tmp/openboard-project";

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
    type: (input.type as Task["type"]) ?? "agent",
    title: input.title as string,
	    description: input.description as string,
	    directory: input.directory as string,
	    taskKind: input.taskKind as Task["taskKind"],
	    harness: input.harness as Task["harness"],
    agent: input.agent as string | undefined,
    claudePermissionMode: input.claudePermissionMode as Task["claudePermissionMode"],
    model: input.model as Task["model"],
    isolation: input.isolation as Task["isolation"],
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
  fetchImpl: ReturnType<typeof vi.fn>,
): BoardClientOptions & {
  fetchMock: ReturnType<typeof vi.fn>;
  statMock: ReturnType<typeof vi.fn>;
} {
  const existingDirs = new Set(dirs);
  const statMock = vi.fn(async (path: string) => {
    if (!existingDirs.has(path)) {
      throw new Error("ENOENT");
    }
    return directoryStat();
  });

  return {
    cwd: CWD,
    fetch: fetchImpl as BoardClientOptions["fetch"],
    stat: statMock as BoardClientOptions["stat"],
    fetchMock: fetchImpl,
    statMock,
  };
}

describe("parseModelRef", () => {
  it("splits only on the first slash so nested provider model ids survive", () => {
    expect(parseModelRef("openrouter/anthropic/claude-sonnet-5")).toEqual({
      providerID: "openrouter",
      id: "anthropic/claude-sonnet-5",
    });
  });

  it("rejects empty nested model-id segments", () => {
    expect(() => parseModelRef("openrouter//x")).toThrow('model must use "provider/model-id"');
    expect(() => parseModelRef("openrouter/anthropic//claude")).toThrow('model must use "provider/model-id"');
  });
});

describe("board client", () => {
  it("creates tasks with normalized directory, model, agent, and isolation", async () => {
    let nextId = 1;
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse(createdTask(`task-${nextId++}`, input), 201);
    });
    const options = makeOptions([`${CWD}/app`, `${CWD}/packages/api`], fetchMock);
    const client = createBoardClient(options);

    const created = await client.createTasks([
      {
        title: " Build TUI ",
        description: "Shared client first",
	        directory: "app",
	        taskKind: "build",
        agent: " build ",
        model: "opencode/north-mini-code-free",
        fallbackModel: "anthropic/claude-sonnet-5",
        isolation: "worktree",
      },
      { title: "List cards", directory: "packages/api" },
    ]);

    expect(created.map((task) => task.id)).toEqual(["task-1", "task-2"]);
    expect(options.fetchMock.mock.calls.map((call: unknown[]) => String(call[0]))).toEqual([
      `${DEFAULT_BOARD_URL}/api/tasks`,
      `${DEFAULT_BOARD_URL}/api/tasks`,
    ]);
    expect(JSON.parse(String(options.fetchMock.mock.calls[0][1]?.body))).toEqual({
	      type: "agent",
	      taskKind: "build",
	      title: "Build TUI",
      description: "Shared client first",
      directory: `${CWD}/app`,
      agent: "build",
      model: { providerID: "opencode", id: "north-mini-code-free" },
      fallbackModel: { providerID: "anthropic", id: "claude-sonnet-5" },
      isolation: "worktree",
    });
  });

  it("creates claude-code tasks with a selected Claude Code model", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse(createdTask("task-claude", input), 201);
    });
    const options = makeOptions([`${CWD}/app`], fetchMock);
    const client = createBoardClient(options);

    const created = await client.createTask({
      title: " Claude task ",
      description: "Use Claude Code",
      directory: "app",
      harness: "claude-code",
      agent: "plan",
      permissionMode: "auto",
      claudePermissionMode: "auto",
      acpOptions: { profile: "audit", maxTurns: 3, readOnly: true },
      model: "claude-code/sonnet",
      isolation: "worktree",
    });

    expect(created.harness).toBe("claude-code");
    expect(created.claudePermissionMode).toBe("auto");
    expect(created.model).toEqual({ providerID: "claude-code", id: "sonnet" });
    expect(JSON.parse(String(options.fetchMock.mock.calls[0][1]?.body))).toEqual({
      type: "agent",
      harness: "claude-code",
      title: "Claude task",
      description: "Use Claude Code",
      directory: `${CWD}/app`,
      permissionMode: "auto",
      claudePermissionMode: "auto",
      acpOptions: { profile: "audit", maxTurns: 3, readOnly: true },
      model: { providerID: "claude-code", id: "sonnet" },
      isolation: "worktree",
    });
  });

  it("lists tasks, summaries, and agents", async () => {
    const tasks: Task[] = [
      {
        id: "task-1",
        type: "agent",
        title: "Existing",
        description: "",
        directory: CWD,
        column: "review",
        position: 0,
        runState: "idle",
        agent: "build",
        sessionId: "session-1",
        baseCommit: null,
        dirtyAtDispatch: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const agents: RosterAgent[] = [{ id: "build", mode: "primary" }];
    const providers: RosterProvider[] = [{ id: "anthropic", name: "Anthropic", models: [{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }] }];
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/api/agents")) return jsonResponse(agents);
      if (String(url).endsWith("/api/providers")) return jsonResponse(providers);
      return jsonResponse(tasks);
    });
    const client = createBoardClient(makeOptions([CWD], fetchMock));

    await expect(client.listTasks()).resolves.toEqual(tasks);
    await expect(client.listTaskSummaries()).resolves.toEqual([
      {
        id: "task-1",
        type: "agent",
        title: "Existing",
        directory: CWD,
        column: "review",
        runState: "idle",
        agent: "build",
        sessionId: "session-1",
        pendingPermissions: [],
        dominantState: "review",
      },
    ]);
    await expect(client.listAgents()).resolves.toEqual(agents);
    await expect(client.listProviders()).resolves.toEqual(providers);
  });

  it("calls task action endpoints", async () => {
    const task = createdTask("task-1", { title: "A", description: "", directory: CWD });
    const outcome: MergeOutcome = { task, ok: true, conflict: false, message: "merged" };
    const fetchMock = vi.fn(async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/move")) return jsonResponse([task]);
      if (path.endsWith("/sync") || path.endsWith("/integrate")) return jsonResponse(outcome);
      if (path.endsWith("/comments")) return jsonResponse([{ id: "comment-1", taskId: "task-1", author: "me", body: "note", createdAt: 1 }]);
      if (path.endsWith("/events")) return jsonResponse([{ id: "event-1", taskId: "task-1", type: "task_run", body: {}, createdAt: 1 }]);
      if (path === "/api/tasks/task-1") return jsonResponse({ ok: true });
      return jsonResponse(task);
    });
    const client = createBoardClient(makeOptions([CWD], fetchMock));

    await client.runTask("task-1");
    await client.retryTask("task-1", "try again");
    await client.answerBlockedTask("task-1", "Use option A", { blockedReportedAt: 123, answeredBy: "Reviewer" });
    await client.abortTask("task-1");
    await client.moveTask("task-1", "review", 0);
    await client.linkTasks("task-0", "task-1");
    await client.unlinkTasks("task-0", "task-1");
    await client.completeTask("task-1", { summary: "done", changedFiles: [], verification: [], residualRisk: "none" }, 10);
    await client.blockTask("task-1", { summary: "blocked", changedFiles: [], verification: [], residualRisk: "risk" });
    await client.initGitAndRun("task-1");
    await client.syncTask("task-1");
    await client.integrateTask("task-1", "main");
    await client.addComment("task-1", "me", "note");
    await client.listComments("task-1");
    await client.listTaskEvents("task-1");
    await client.getTaskCompare("task-1", "task-0");
    await client.getTaskContext("task-1");
    await client.resolveOrphanWorktree("/repo/.opencode-board-worktrees/task_dirty");
    await client.deleteTask("task-1");

    const calls = fetchMock.mock.calls as unknown as Array<[string | URL, RequestInit | undefined]>;

    expect(calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      [`${DEFAULT_BOARD_URL}/api/tasks/task-1/run`, "POST"],
      [`${DEFAULT_BOARD_URL}/api/tasks/task-1/retry`, "POST"],
      [`${DEFAULT_BOARD_URL}/api/tasks/task-1/retry`, "POST"],
      [`${DEFAULT_BOARD_URL}/api/tasks/task-1/abort`, "POST"],
      [`${DEFAULT_BOARD_URL}/api/tasks/task-1/move`, "POST"],
      [`${DEFAULT_BOARD_URL}/api/tasks/task-1/links`, "POST"],
      [`${DEFAULT_BOARD_URL}/api/tasks/task-1/links/task-0`, "DELETE"],
      [`${DEFAULT_BOARD_URL}/api/tasks/task-1/complete?runStartedAt=10`, "POST"],
      [`${DEFAULT_BOARD_URL}/api/tasks/task-1/block`, "POST"],
      [`${DEFAULT_BOARD_URL}/api/tasks/task-1/init-git`, "POST"],
      [`${DEFAULT_BOARD_URL}/api/tasks/task-1/sync`, "POST"],
      [`${DEFAULT_BOARD_URL}/api/tasks/task-1/integrate`, "POST"],
      [`${DEFAULT_BOARD_URL}/api/tasks/task-1/comments`, "POST"],
      [`${DEFAULT_BOARD_URL}/api/tasks/task-1/comments`, "GET"],
      [`${DEFAULT_BOARD_URL}/api/tasks/task-1/events`, "GET"],
      [`${DEFAULT_BOARD_URL}/api/tasks/task-1/compare?baseTaskId=task-0`, "GET"],
      [`${DEFAULT_BOARD_URL}/api/tasks/task-1/context`, "GET"],
      [`${DEFAULT_BOARD_URL}/api/worktrees/orphans/resolve`, "POST"],
      [`${DEFAULT_BOARD_URL}/api/tasks/task-1`, "DELETE"],
    ]);
    expect(JSON.parse(String(calls[1][1]?.body))).toEqual({ feedback: "try again" });
    expect(JSON.parse(String(calls[2][1]?.body))).toEqual({ feedback: "Use option A", blockedAnswer: { blockedReportedAt: 123, answeredBy: "Reviewer" } });
    expect(JSON.parse(String(calls[5][1]?.body))).toEqual({ parentId: "task-0" });
    expect(JSON.parse(String(calls[11][1]?.body))).toEqual({ targetBranch: "main" });
  });

  it("rejects bad task input before POSTing", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    const client = createBoardClient(makeOptions([], fetchMock));

    await expect(client.createTask({ title: "  " })).rejects.toThrow(
      "title must be a non-empty string",
    );
    await expect(client.createTask({ title: "Bad model", model: "north-mini-code-free" })).rejects.toThrow(
      'model must use "provider/model-id"',
    );
	    await expect(client.createTask({ title: "Bad isolation", isolation: "container" })).rejects.toThrow(
	      "isolation must be 'worktree' or 'in-place'",
	    );
	    await expect(client.createTask({ title: "Bad kind", taskKind: "investigate" as never })).rejects.toThrow(
	      "taskKind must be one of",
	    );
    await expect(client.createTask({ title: "Bad Claude permission", claudePermissionMode: "root" })).rejects.toThrow(
      "claudePermissionMode can only be set for claude-code agent tasks",
    );
    await expect(client.createTask({ title: "Bad Claude permission", harness: "claude-code", claudePermissionMode: "root" })).rejects.toThrow(
      "claudePermissionMode must be a supported Claude Code permission mode",
    );
    await expect(client.createTask({ title: "Bad override", permissionOverrides: { edit: "ask" } })).rejects.toThrow(
      "permissionOverrides can only be set for in-place OpenCode agent tasks",
    );
    await expect(client.createTask({ title: "Bad override", harness: "claude-code", isolation: "in-place", permissionOverrides: { edit: "ask" } })).rejects.toThrow(
      "permissionOverrides can only be set for in-place OpenCode agent tasks",
    );
    await expect(
      client.createTask({ title: "Bad override shape", isolation: "in-place", permissionOverrides: { edit: "sometimes" as never } }),
    ).rejects.toThrow("permissionOverrides.edit must be one of: allow, ask, deny");
    await expect(client.createTask({ title: "Bad auto-run", autoRun: true })).rejects.toThrow(
      'autoRun requires worktree isolation, or an in-place OpenCode task with edit and bash permission overrides set to "deny"',
    );
    await expect(client.createTask({ title: "Bad auto-run", isolation: "in-place", autoRun: true })).rejects.toThrow(
      'autoRun requires worktree isolation, or an in-place OpenCode task with edit and bash permission overrides set to "deny"',
    );
    await expect(client.createTask({ title: "Bad auto-run shape", isolation: "worktree", autoRun: "yes" as never })).rejects.toThrow(
      "autoRun must be a boolean",
    );
    await expect(
      client.createTask({ title: "Half fenced", isolation: "in-place", permissionOverrides: { edit: "deny", bash: "ask" }, autoRun: true }),
    ).rejects.toThrow("autoRun requires worktree isolation");
    await expect(client.createTask({ title: "Missing dir", directory: "missing" })).rejects.toThrow(
      `directory does not exist: ${CWD}/missing`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts permissionOverrides for an in-place OpenCode agent task and POSTs it verbatim", async () => {
    const options = makeOptions([CWD], vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse(createdTask("task-override", input), 201);
    }));
    const client = createBoardClient(options);

    await client.createTask({
      title: "In-place worker",
      isolation: "in-place",
      permissionOverrides: { edit: "ask", bash: "deny" },
    });

    expect(JSON.parse(String(options.fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      isolation: "in-place",
      permissionOverrides: { edit: "ask", bash: "deny" },
    });
  });

  it("rejects a bad permissionOverrides update on normalizeUpdateTaskInput", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(createdTask("task-1", {})));
    const client = createBoardClient(makeOptions([CWD], fetchMock));

    await expect(client.updateTask("task-1", { permissionOverrides: { edit: "sometimes" as never } })).rejects.toThrow(
      "permissionOverrides.edit must be one of: allow, ask, deny",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts autoRun for a worktree-isolated task and POSTs it verbatim", async () => {
    const options = makeOptions([CWD], vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse(createdTask("task-auto-run", input), 201);
    }));
    const client = createBoardClient(options);

    await client.createTask({
      title: "Auto-run worker",
      isolation: "worktree",
      autoRun: true,
    });

    expect(JSON.parse(String(options.fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      isolation: "worktree",
      autoRun: true,
    });
  });

  it("accepts autoRun for a fenced in-place OpenCode task and POSTs it verbatim", async () => {
    const options = makeOptions([CWD], vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse(createdTask("task-fenced-auto-run", input), 201);
    }));
    const client = createBoardClient(options);

    await client.createTask({
      title: "Read-only auto-run worker",
      isolation: "in-place",
      permissionOverrides: { edit: "deny", bash: "deny" },
      autoRun: true,
    });

    expect(JSON.parse(String(options.fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      isolation: "in-place",
      permissionOverrides: { edit: "deny", bash: "deny" },
      autoRun: true,
    });
  });

  it("rejects a non-boolean autoRun update on normalizeUpdateTaskInput", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(createdTask("task-1", {})));
    const client = createBoardClient(makeOptions([CWD], fetchMock));

    await expect(client.updateTask("task-1", { autoRun: "yes" as never })).rejects.toThrow(
      "autoRun must be a boolean",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards autoRun through updateTask PATCH body", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse(createdTask("task-1", input));
    });
    const client = createBoardClient(makeOptions([CWD], fetchMock));

    await client.updateTask("task-1", { autoRun: false });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ autoRun: false });
  });

  it("forwards valid taskKind through updateTask PATCH body", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse(createdTask("task-1", input));
    });
    const client = createBoardClient(makeOptions([CWD], fetchMock));

    const result = await client.updateTask("task-1", { taskKind: "build" });

    expect(result.taskKind).toBe("build");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `${DEFAULT_BOARD_URL}/api/tasks/task-1`,
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      taskKind: "build",
    });
  });

  it("clears taskKind through updateTask PATCH body when set to null", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse(createdTask("task-1", input));
    });
    const client = createBoardClient(makeOptions([CWD], fetchMock));

    const result = await client.updateTask("task-1", { taskKind: null });

    expect(result.taskKind).toBeNull();
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      taskKind: null,
    });
  });

  it("rejects a bad taskKind on updateTask", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(createdTask("task-1", {})));
    const client = createBoardClient(makeOptions([CWD], fetchMock));

    await expect(client.updateTask("task-1", { taskKind: "investigate" as never })).rejects.toThrow(
      "taskKind must be one of",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards and normalizes parentIds through updateTask PATCH body", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse(createdTask("task-1", input));
    });
    const client = createBoardClient(makeOptions([CWD], fetchMock));

    const result = await client.updateTask("task-1", {
      parentIds: [" task-0 ", "task-0", "  task-1 "],
    });

    expect(result.parentIds).toEqual(["task-0", "task-1"]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      parentIds: ["task-0", "task-1"],
    });
  });

  it("clears parentIds through updateTask PATCH body when set to null", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse(createdTask("task-1", input));
    });
    const client = createBoardClient(makeOptions([CWD], fetchMock));

    const result = await client.updateTask("task-1", { parentIds: null });

    expect(result.parentIds).toBeNull();
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      parentIds: null,
    });
  });

  it("reports board startup failures and resolves OPENCODE_BOARD_URL", async () => {
    const client = createBoardClient(
      makeOptions(
        [CWD],
        vi.fn(async () => {
          throw new Error("ECONNREFUSED");
        }),
      ),
    );

    await expect(client.listTasks()).rejects.toThrow(BOARD_UNAVAILABLE_MESSAGE);
    expect(resolveBoardUrl({ env: { OPENCODE_BOARD_URL: "http://localhost:5000/" } })).toBe(
      "http://localhost:5000",
    );
    expect(() => resolveBoardUrl({ requireExplicitBoardUrl: true, env: {} })).toThrow(
      BOARD_URL_REQUIRED_MESSAGE,
    );
    expect(resolveBoardUrl({ requireExplicitBoardUrl: true, boardUrl: "http://localhost:5001/" })).toBe(
      "http://localhost:5001",
    );
  });

  it("returns adapter and opencode health via GET /api/health", async () => {
    const healthy: BoardHealth = {
      adapter: "ok",
      opencode: { status: "ok", version: "0.17.0" },
    };
    const unreachable: BoardHealth = {
      adapter: "ok",
      opencode: { status: "unreachable" },
    };

    let callCount = 0;
    const fetchMock = vi.fn(async (_url: string | URL) => {
      callCount++;
      return jsonResponse(callCount === 1 ? healthy : unreachable);
    });
    const client = createBoardClient(makeOptions([CWD], fetchMock));

    const result1 = await client.getHealth();
    expect(result1).toEqual(healthy);
    expect(result1.opencode.status).toBe("ok");
    expect(result1.adapter).toBe("ok");

    const result2 = await client.getHealth();
    expect(result2).toEqual(unreachable);
    expect(result2.opencode.status).toBe("unreachable");
    expect(result2.adapter).toBe("ok");

    expect(fetchMock.mock.calls.map((call: unknown[]) => String(call[0]))).toEqual([
      `${DEFAULT_BOARD_URL}/api/health`,
      `${DEFAULT_BOARD_URL}/api/health`,
    ]);
  });

  it("fetches task diff from GET /api/tasks/:id/diff", async () => {
    const diffResponse: DiffResponse = {
      kind: "diff",
      files: [
        { file: "src/a.ts", additions: 5, deletions: 2, status: "modified", patch: "@@ -1 +1 @@" },
      ],
      capped: false,
      root: "/repo/worktree",
    };
    const fetchMock = vi.fn(async (url: string | URL) => {
      return jsonResponse(diffResponse);
    });
    const client = createBoardClient(makeOptions([CWD], fetchMock));

    const result = await client.getTaskDiff("task-1");

    expect(result).toEqual(diffResponse);
    expect(fetchMock).toHaveBeenCalledWith(
      `${DEFAULT_BOARD_URL}/api/tasks/task-1/diff`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("fetches task commit status from GET /api/tasks/:id/commit-status", async () => {
    const response = { committedFiles: ["src/a.ts"], uncommittedFiles: ["src/b.ts"] };
    const fetchMock = vi.fn(async () => jsonResponse(response));
    const client = createBoardClient(makeOptions([CWD], fetchMock));

    const result = await client.getTaskCommitStatus("task-1", "dev");

    expect(result).toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      `${DEFAULT_BOARD_URL}/api/tasks/task-1/commit-status?targetBranch=dev`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("commits one task file through POST /api/tasks/:id/commit-file", async () => {
    const response = { task: createdTask("task-1", { title: "A", description: "", directory: CWD }), ok: true, file: "src/a.ts", message: "committed" };
    const fetchMock = vi.fn(async () => jsonResponse(response));
    const client = createBoardClient(makeOptions([CWD], fetchMock));

    const result = await client.commitTaskFile("task-1", "src/a.ts");

    expect(result).toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      `${DEFAULT_BOARD_URL}/api/tasks/task-1/commit-file`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ file: "src/a.ts" }),
      }),
    );
  });

  it("getTaskDiff returns no-git variant when there is no git evidence", async () => {
    const noGitResponse: DiffResponse = {
      kind: "no-git",
      reason: "not a git repository",
    };
    const fetchMock = vi.fn(async () => jsonResponse(noGitResponse));
    const client = createBoardClient(makeOptions([CWD], fetchMock));

    const result = await client.getTaskDiff("task-2");

    expect(result.kind).toBe("no-git");
    expect(result).toEqual(noGitResponse);
    expect(fetchMock).toHaveBeenCalledWith(
      `${DEFAULT_BOARD_URL}/api/tasks/task-2/diff`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("respondPermission POSTs to /api/tasks/:id/permission and resolves with the projected Task, not a RespondPermissionOutcome", async () => {
    // POST /api/tasks/:id/permission returns the shared projected Task on
    // success (src/server/routes/permission.ts), never an {ok, decision}
    // outcome shape — the client must be typed and shaped honestly, or
    // callers reading a nonexistent `.ok` field silently see `undefined`.
    const projectedTask = createdTask("task-1", { title: "A", description: "", directory: CWD });
    const fetchMock = vi.fn(async () => jsonResponse(projectedTask));
    const client = createBoardClient(makeOptions([CWD], fetchMock));

    const result = await client.respondPermission("task-1", { askId: "ask-1", action: "allow_once", answeredBy: "User" });

    expect(result).toEqual(projectedTask);
    expect("ok" in (result as object)).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      `${DEFAULT_BOARD_URL}/api/tasks/task-1/permission`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ askId: "ask-1", action: "allow_once", answeredBy: "User" }),
      }),
    );
  });

  it("respondPermission rejects (throws) on a non-2xx response instead of returning a conflict outcome", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: { code: "validation", message: "Permission ask already resolved: ask-1" } }, 409),
    );
    const client = createBoardClient(makeOptions([CWD], fetchMock));

    await expect(
      client.respondPermission("task-1", { askId: "ask-1", action: "deny", answeredBy: "User" }),
    ).rejects.toThrow(/409/);
  });

  it("sendSessionMessage POSTs chat input to the task session route", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => new Response(init?.body as BodyInit, { status: 202, headers: { "content-type": "application/json" } }));
    const client = createBoardClient({ boardUrl: "http://127.0.0.1:4097", cwd: "/repo", fetch: fetch as never, stat: vi.fn() as never });
    const input = { text: "Continue", mode: "queue" as const, sentBy: "User", clientMessageId: "msg-1", expectedSessionId: "ses-1" };
    await client.sendSessionMessage("task-1", input);
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:4097/api/tasks/task-1/session-messages", expect.objectContaining({ method: "POST", body: JSON.stringify(input) }));
  });
});

describe("streamSessionEvents lifecycle", () => {
  function sseResponse(body: ReadableStream<Uint8Array>): Response {
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  it("close() consumes reader.cancel() rejection instead of leaking an unhandled rejection (live-view quit bug)", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const body = new ReadableStream<Uint8Array>({
        pull() {
          // Stays pending, like a live SSE socket with no frames due.
          return new Promise(() => {});
        },
        cancel() {
          return Promise.reject(new Error("cancel failed"));
        },
      });
      const fetchMock = vi.fn(async () => sseResponse(body));
      const client = createBoardClient(makeOptions([CWD], fetchMock));
      const stream = await client.streamSessionEvents("task-1", () => {});
      stream.close();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("calls onEnd when the stream ends server-side (liveness signal for reconnect)", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: heartbeat\ndata: {"kind":"heartbeat","lastEventAt":null,"transport":"live"}\n\n'));
        controller.close();
      },
    });
    const fetchMock = vi.fn(async () => sseResponse(body));
    const client = createBoardClient(makeOptions([CWD], fetchMock));
    const frames: unknown[] = [];
    let ended = 0;
    const stream = await client.streamSessionEvents("task-1", (frame) => frames.push(frame), {
      onEnd: () => {
        ended += 1;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(frames).toHaveLength(1);
    expect(ended).toBe(1);
    expect(stream.active).toBe(false);
  });

  it("does not call onEnd after an explicit client-side close()", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {});
      },
    });
    const fetchMock = vi.fn(async () => sseResponse(body));
    const client = createBoardClient(makeOptions([CWD], fetchMock));
    let ended = 0;
    const stream = await client.streamSessionEvents("task-1", () => {}, {
      onEnd: () => {
        ended += 1;
      },
    });
    stream.close();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(ended).toBe(0);
  });
});
