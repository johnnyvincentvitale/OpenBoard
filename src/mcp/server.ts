/**
 * OpenBoard MCP server — exposes orchestrator-safe board control tools backed
 * by the board's REST API (see `../client/board-client.ts`).
 *
 * Multi-instance: this server starts unbound unless the CLI or environment
 * selects one OpenBoard adapter. Plugin MCP launches should use `openboard mcp`
 * and then call `select_instance`; worker sessions can use
 * `openboard mcp --instance <name>` when the board is known. Manual
 * `OPENCODE_BOARD_URL` remains supported for advanced callers. The server does
 * not fall back to a default port when no board is selected.
 */
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  AddTasksInputSchema,
  CommentTaskInputSchema,
  CompleteTaskInputSchema,
  CreateTaskInputSchema,
  IntegrateTaskInputSchema,
  LinkTasksInputSchema,
  MoveTaskInputSchema,
  RetryTaskInputSchema,
  SelectInstanceInputSchema,
  TaskIdInputSchema,
  abortTask,
  addNote,
  addTasks,
  blockTask,
  commentTask,
  completeTask,
  createTask,
  currentInstance,
  integrateTask,
  linkTasks,
  listAgents,
  listInstances,
  listTasks,
  moveTask,
  openboardStatus,
  retryTask,
  runTask,
  selectInstance,
  syncTask,
  taskDiff,
  taskEvents,
  unlinkTasks,
  type McpToolOptions,
} from "./tools";

const SERVER_VERSION = "0.1.0";

export function createMcpServer(options: McpToolOptions = {}): McpServer {
  let toolOptions: McpToolOptions = { ...options, requireExplicitBoardUrl: true, mcpStartedAt: options.mcpStartedAt ?? new Date().toISOString() };
  const server = new McpServer({
    name: "openboard",
    version: SERVER_VERSION,
  });

  server.registerTool(
    "openboard_status",
    {
      title: "OpenBoard MCP status",
      description: "Report the selected board identity, reachability, and cheap board counts for orchestrator proof.",
    },
    async () => toToolResult(await openboardStatus(toolOptions)),
  );

  server.registerTool(
    "current_instance",
    {
      title: "Current OpenBoard instance",
      description: "Show the current MCP board target and how it was selected.",
    },
    async () => toToolResult(await currentInstance(toolOptions)),
  );

  server.registerTool(
    "list_instances",
    {
      title: "List OpenBoard instances",
      description: "List registered OpenBoard instances without exposing tokens.",
    },
    async () => toToolResult(await listInstances()),
  );

  server.registerTool(
    "select_instance",
    {
      title: "Select OpenBoard instance",
      description: "Switch this MCP server process to a running named instance for future tool calls.",
      inputSchema: SelectInstanceInputSchema,
    },
    async (args) => {
      const selected = await selectInstance(args, toolOptions);
      toolOptions = selected.options;
      return toToolResult({ boardUrl: selected.boardUrl, selection: selected.selection });
    },
  );

  server.registerTool(
    "create_task",
    {
      title: "Create OpenBoard task",
      description: "Create one manual or agent task in OpenBoard through POST /api/tasks. This never runs tasks.",
      inputSchema: CreateTaskInputSchema,
    },
    async (args) => toToolResult(await createTask(args, toolOptions)),
  );

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
    "link_tasks",
    {
      title: "Link OpenBoard tasks",
      description: "Make childId depend on parentId through POST /api/tasks/:id/links.",
      inputSchema: LinkTasksInputSchema,
    },
    async (args) => toToolResult(await linkTasks(args, toolOptions)),
  );

  server.registerTool(
    "unlink_tasks",
    {
      title: "Unlink OpenBoard tasks",
      description: "Remove a parent dependency from a child task through DELETE /api/tasks/:id/links/:parentId.",
      inputSchema: LinkTasksInputSchema,
    },
    async (args) => toToolResult(await unlinkTasks(args, toolOptions)),
  );

  server.registerTool(
    "run_task",
    {
      title: "Run OpenBoard task",
      description: "Dispatch an agent task through POST /api/tasks/:id/run.",
      inputSchema: TaskIdInputSchema,
    },
    async (args) => toToolResult(await runTask(args, toolOptions)),
  );

  server.registerTool(
    "retry_task",
    {
      title: "Retry OpenBoard task",
      description: "Retry an agent task through POST /api/tasks/:id/retry. Optional feedback is sent to the session.",
      inputSchema: RetryTaskInputSchema,
    },
    async (args) => toToolResult(await retryTask(args, toolOptions)),
  );

  server.registerTool(
    "abort_task",
    {
      title: "Abort OpenBoard task",
      description: "Abort a running task through POST /api/tasks/:id/abort.",
      inputSchema: TaskIdInputSchema,
    },
    async (args) => toToolResult(await abortTask(args, toolOptions)),
  );

  server.registerTool(
    "move_task",
    {
      title: "Move OpenBoard task",
      description: "Move a task by column/position. Moving to done requires explicit completedBy.",
      inputSchema: MoveTaskInputSchema,
    },
    async (args) => toToolResult(await moveTask(args, toolOptions)),
  );

  server.registerTool(
    "complete_task",
    {
      title: "Complete OpenBoard task",
      description: "Submit a structured completion report through POST /api/tasks/:id/complete.",
      inputSchema: CompleteTaskInputSchema,
    },
    async (args) => toToolResult(await completeTask(args, toolOptions)),
  );

  server.registerTool(
    "block_task",
    {
      title: "Block OpenBoard task",
      description: "Submit a structured blocked report through POST /api/tasks/:id/block.",
      inputSchema: CompleteTaskInputSchema,
    },
    async (args) => toToolResult(await blockTask(args, toolOptions)),
  );

  server.registerTool(
    "sync_task",
    {
      title: "Sync OpenBoard task",
      description: "Merge upstream into a task worktree branch through POST /api/tasks/:id/sync.",
      inputSchema: TaskIdInputSchema,
    },
    async (args) => toToolResult(await syncTask(args, toolOptions)),
  );

  server.registerTool(
    "integrate_task",
    {
      title: "Integrate OpenBoard task",
      description: "Integrate a task worktree into a target branch. Requires confirmReviewed: true.",
      inputSchema: IntegrateTaskInputSchema,
    },
    async (args) => toToolResult(await integrateTask(args, toolOptions)),
  );

  server.registerTool(
    "comment_task",
    {
      title: "Comment on OpenBoard task",
      description: "Persist a scoped task comment. This is not chat.",
      inputSchema: CommentTaskInputSchema,
    },
    async (args) => toToolResult(await commentTask(args, toolOptions)),
  );

  server.registerTool(
    "add_note",
    {
      title: "Add OpenBoard task note",
      description: "Alias for comment_task; persists a scoped task note/comment.",
      inputSchema: CommentTaskInputSchema,
    },
    async (args) => toToolResult(await addNote(args, toolOptions)),
  );

  server.registerTool(
    "task_events",
    {
      title: "List OpenBoard task events",
      description: "List durable events recorded for one task. This is not run history.",
      inputSchema: TaskIdInputSchema,
    },
    async (args) => toToolResult(await taskEvents(args, toolOptions)),
  );

  server.registerTool(
    "task_diff",
    {
      title: "Get OpenBoard task diff",
      description: "Fetch the structured Review- or Done-card diff through GET /api/tasks/:id/diff.",
      inputSchema: TaskIdInputSchema,
    },
    async (args) => toToolResult(await taskDiff(args, toolOptions)),
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
