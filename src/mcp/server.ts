/**
 * OpenBoard MCP server — exposes `add_tasks`, `list_tasks`, and `list_agents`
 * tools backed by the board's REST API (see `../client/board-client.ts`).
 *
 * Multi-instance: this server always talks to exactly one selected OpenBoard
 * adapter, resolved from `OPENCODE_BOARD_URL`. It does not fall back to a
 * default port; the orchestrator must select an instance first and set
 * `OPENCODE_BOARD_URL` to that instance's adapter URL, e.g.
 * `OPENCODE_BOARD_URL=http://127.0.0.1:4098`. Running against two instances at
 * once requires two separate MCP server processes/configs, each with its own
 * `OPENCODE_BOARD_URL`.
 */
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  AddTasksInputSchema,
  addTasks,
  listAgents,
  listTasks,
  type McpToolOptions,
} from "./tools";

const SERVER_VERSION = "0.1.0";

export function createMcpServer(options: McpToolOptions = {}): McpServer {
  const toolOptions: McpToolOptions = { ...options, requireExplicitBoardUrl: true };
  const server = new McpServer({
    name: "openboard",
    version: SERVER_VERSION,
  });

  server.registerTool(
    "add_tasks",
    {
      title: "Add OpenBoard tasks",
      description: "Create one or more To Do cards in OpenBoard through POST /api/tasks. This never runs tasks.",
      inputSchema: AddTasksInputSchema,
    },
    async (args) => toToolResult(await addTasks(args, toolOptions)),
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List OpenBoard tasks",
      description: "List current OpenBoard Kanban cards through GET /api/tasks.",
    },
    async () => toToolResult(await listTasks(toolOptions)),
  );

  server.registerTool(
    "list_agents",
    {
      title: "List OpenBoard agents",
      description: "List assignable OpenCode agents through the board's GET /api/agents proxy.",
    },
    async () => toToolResult(await listAgents(toolOptions)),
  );

  return server;
}

export async function main(): Promise<void> {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
}

function toToolResult(structuredContent: object): CallToolResult {
  return {
    structuredContent: structuredContent as Record<string, unknown>,
    content: [
      {
        type: "text",
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
  };
}

function isDirectRun(): boolean {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
