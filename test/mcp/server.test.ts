import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpServer, parseMcpServerArgs, type McpServerOptions } from "../../src/mcp/server";

const COCKPIT_TOOLS = [
  "openboard_status",
  "current_instance",
  "list_instances",
  "select_instance",
  "create_task",
  "add_tasks",
  "link_tasks",
  "unlink_tasks",
  "run_task",
  "retry_task",
  "abort_task",
  "move_task",
  "complete_task",
  "block_task",
  "sync_task",
  "integrate_task",
  "answer_blocked_task",
  "respond_permission",
  "send_session_message",
  "tail_session",
  "task_context",
  "task_compare",
  "comment_task",
  "add_note",
  "task_events",
  "task_diff",
  "list_tasks",
  "list_agents",
] as const;

const WORKER_TOOLS = [
  "task_diff",
  "task_context",
  "task_compare",
  "complete_task",
  "block_task",
] as const;

const report = {
  summary: "done",
  changedFiles: [],
  verification: [],
  residualRisk: "none",
};

const task = {
  id: "task_1",
  type: "agent",
  title: "Worker task",
  description: "",
  directory: "/repo",
  column: "in_progress",
  position: 0,
  runState: "idle",
  runStartedAt: 123,
  baseCommit: null,
  dirtyAtDispatch: false,
  createdAt: 1,
  updatedAt: 2,
};

const connected: Array<{ client: Client; server: ReturnType<typeof createMcpServer> }> = [];

async function connect(options: McpServerOptions = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(options);
  const client = new Client({ name: "openboard-mcp-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  connected.push({ client, server });
  return { client, server };
}

afterEach(async () => {
  await Promise.allSettled(connected.splice(0).flatMap(({ client, server }) => [client.close(), server.close()]));
});

describe("OpenBoard MCP profiles", () => {
  it("preserves the full default orchestrator cockpit", async () => {
    const { client } = await connect();
    const listed = await client.listTools();

    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([...COCKPIT_TOOLS].sort());
    for (const name of ["complete_task", "block_task"]) {
      const tool = listed.tools.find((candidate) => candidate.name === name);
      expect(tool?.inputSchema.required).toEqual(expect.arrayContaining(["taskId", "runStartedAt", "report"]));
    }
  });

  it("advertises exactly the five worker inspection/report tools", async () => {
    const { client } = await connect({ profile: "worker" });
    const listed = await client.listTools();

    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([...WORKER_TOOLS].sort());
    for (const name of ["complete_task", "block_task"]) {
      const tool = listed.tools.find((candidate) => candidate.name === name);
      expect(tool?.inputSchema.required).toEqual(expect.arrayContaining(["taskId", "runStartedAt", "report"]));
    }
  });

  it("rejects another task id before a scoped worker can make a board request", async () => {
    const fetchMock = vi.fn();
    const { client } = await connect({
      profile: "worker",
      workerScope: { taskId: "task_1" },
      boardUrl: "http://127.0.0.1:4097",
      fetch: fetchMock,
    });

    for (const name of ["complete_task", "block_task"] as const) {
      const result = await client.callTool({
        name,
        arguments: { taskId: "task_2", runStartedAt: 123, report },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("Worker MCP is bound to task task_1");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards a matching task and run identity to the completion endpoint", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(task), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const { client } = await connect({
      profile: "worker",
      workerScope: { taskId: "task_1" },
      boardUrl: "http://127.0.0.1:4097",
      fetch: fetchMock,
    });

    const result = await client.callTool({
      name: "complete_task",
      arguments: { taskId: "task_1", runStartedAt: 123, report },
    });

    expect(result.isError).not.toBe(true);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:4097/api/tasks/task_1/complete?runStartedAt=123",
    );
  });
});

describe("parseMcpServerArgs", () => {
  it("keeps direct launches in cockpit mode by default", () => {
    expect(parseMcpServerArgs([])).toEqual({});
  });

  it("selects an optional task-scoped worker profile", () => {
    expect(parseMcpServerArgs(["--worker"])).toEqual({ profile: "worker" });
    expect(parseMcpServerArgs(["--worker", "--task-id", "task_1"])).toEqual({
      profile: "worker",
      workerScope: { taskId: "task_1" },
    });
  });

  it("rejects task scope without worker mode and unknown arguments", () => {
    expect(() => parseMcpServerArgs(["--task-id", "task_1"])).toThrow("--task-id requires --worker");
    expect(() => parseMcpServerArgs(["--cockpit"])).toThrow("Unknown MCP server argument");
  });
});
