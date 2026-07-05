import { describe, expect, it, vi } from "vitest";
import {
  BOARD_UNAVAILABLE_MESSAGE,
  BOARD_URL_REQUIRED_MESSAGE,
  DEFAULT_BOARD_URL,
  createBoardClient,
  resolveBoardUrl,
} from "../../src/client/board-client";
import type { BoardClientOptions, BoardHealth } from "../../src/client/board-client";
import type { BoardSettings, MergeOutcome, RosterAgent, Task } from "../../src/shared";

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
    title: input.title as string,
    description: input.description as string,
    directory: input.directory as string,
    agent: input.agent as string | undefined,
    model: input.model as Task["model"],
    isolation: input.isolation as Task["isolation"],
    column: "todo",
    position: 0,
    runState: "unstarted",
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
        agent: " build ",
        model: "opencode/north-mini-code-free",
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
      title: "Build TUI",
      description: "Shared client first",
      directory: `${CWD}/app`,
      agent: "build",
      model: { providerID: "opencode", id: "north-mini-code-free" },
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
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const agents: RosterAgent[] = [{ id: "build", mode: "primary" }];
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith("/api/agents")) return jsonResponse(agents);
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
      },
    ]);
    await expect(client.listAgents()).resolves.toEqual(agents);
  });

  it("calls task action endpoints", async () => {
    const task = createdTask("task-1", { title: "A", description: "", directory: CWD });
    const outcome: MergeOutcome = { task, ok: true, conflict: false, message: "merged" };
    const settings: BoardSettings = { worktreeDefault: true };
    const fetchMock = vi.fn(async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/move")) return jsonResponse([task]);
      if (path.endsWith("/sync") || path.endsWith("/integrate")) return jsonResponse(outcome);
      if (path === "/api/settings") return jsonResponse(settings);
      if (path === "/api/tasks/task-1") return jsonResponse({ ok: true });
      return jsonResponse(task);
    });
    const client = createBoardClient(makeOptions([CWD], fetchMock));

    await client.runTask("task-1");
    await client.retryTask("task-1", "try again");
    await client.abortTask("task-1");
    await client.moveTask("task-1", "review", 0);
    await client.initGitAndRun("task-1");
    await client.syncTask("task-1");
    await client.integrateTask("task-1", "main");
    await client.getSettings();
    await client.updateSettings({ worktreeDefault: true });
    await client.deleteTask("task-1");

    const calls = fetchMock.mock.calls as unknown as Array<[string | URL, RequestInit | undefined]>;

    expect(calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      [`${DEFAULT_BOARD_URL}/api/tasks/task-1/run`, "POST"],
      [`${DEFAULT_BOARD_URL}/api/tasks/task-1/retry`, "POST"],
      [`${DEFAULT_BOARD_URL}/api/tasks/task-1/abort`, "POST"],
      [`${DEFAULT_BOARD_URL}/api/tasks/task-1/move`, "POST"],
      [`${DEFAULT_BOARD_URL}/api/tasks/task-1/init-git`, "POST"],
      [`${DEFAULT_BOARD_URL}/api/tasks/task-1/sync`, "POST"],
      [`${DEFAULT_BOARD_URL}/api/tasks/task-1/integrate`, "POST"],
      [`${DEFAULT_BOARD_URL}/api/settings`, "GET"],
      [`${DEFAULT_BOARD_URL}/api/settings`, "PUT"],
      [`${DEFAULT_BOARD_URL}/api/tasks/task-1`, "DELETE"],
    ]);
    expect(JSON.parse(String(calls[1][1]?.body))).toEqual({ feedback: "try again" });
    expect(JSON.parse(String(calls[6][1]?.body))).toEqual({ targetBranch: "main" });
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
    await expect(client.createTask({ title: "Missing dir", directory: "missing" })).rejects.toThrow(
      `directory does not exist: ${CWD}/missing`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
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
});
