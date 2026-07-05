import { describe, expect, it, vi } from "vitest";
import {
  BOARD_UNAVAILABLE_MESSAGE,
  DEFAULT_BOARD_URL,
  addTasks,
  listAgents,
  listTasks,
  resolveBoardUrl,
} from "../../src/mcp/tools";
import type { McpToolOptions } from "../../src/mcp/tools";
import type { RosterAgent, Task } from "../../src/shared";

const CWD = "/tmp/openboard-project";
const NO_AUTH_ENV = { OPENBOARD_API_TOKEN: "" };

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
      "isolation must be 'worktree' or 'in-place'",
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
