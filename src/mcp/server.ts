/**
 * OpenBoard MCP server — exposes orchestrator-safe board control tools backed
 * by the board's REST API (see `../client/board-client.ts`).
 *
 * Multi-instance: this server starts unbound unless the CLI or environment
 * selects one OpenBoard adapter. Plugin MCP launches should use `openboard mcp`
 * and then call `select_instance`; worker sessions can use
 * `openboard mcp --instance <name> --worker` when the board is known. Manual
 * `OPENCODE_BOARD_URL` remains supported for advanced callers. The server does
 * not fall back to a default port when no board is selected.
 */
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  AddTasksInputSchema,
  AnswerBlockedTaskInputSchema,
  BlockTaskInputSchema,
  CommentTaskInputSchema,
  CompleteTaskInputSchema,
  CreateTaskInputSchema,
  IntegrateTaskInputSchema,
  LinkTasksInputSchema,
  MoveTaskInputSchema,
  RespondPermissionInputSchema,
  SendSessionMessageInputSchema,
  RetryTaskInputSchema,
  SelectInstanceInputSchema,
  TailSessionInputSchema,
  TaskContextInputSchema,
  TaskCompareInputSchema,
  TaskIdInputSchema,
  abortTask,
  addNote,
  addTasks,
  answerBlockedTask,
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
  respondPermission,
  sendSessionMessage,
  retryTask,
  runTask,
  selectInstance,
  syncTask,
  tailSession,
  taskContext,
  taskCompare,
  taskDiff,
  taskEvents,
  unlinkTasks,
  type McpToolOptions,
} from "./tools";

const SERVER_VERSION = "0.1.0";

export interface WorkerMcpScope {
  taskId: string;
}

export interface McpServerOptions extends McpToolOptions {
  profile?: "cockpit" | "worker";
  workerScope?: WorkerMcpScope;
}

function assertWorkerAssignment(
  input: { taskId: string; runStartedAt: number },
  scope: WorkerMcpScope | undefined,
): void {
  if (scope && input.taskId !== scope.taskId) {
    throw new Error(`Worker MCP is bound to task ${scope.taskId}`);
  }
}

function registerReportTools(
  server: McpServer,
  getOptions: () => McpToolOptions,
  worker: boolean,
  scope?: WorkerMcpScope,
): void {
  server.registerTool(
    "complete_task",
    {
      title: "Complete OpenBoard task",
      description: "Submit a structured completion report for the current run through POST /api/tasks/:id/complete. Requires that run's runStartedAt.",
      inputSchema: CompleteTaskInputSchema,
    },
    async (args) => {
      if (worker) assertWorkerAssignment(args, scope);
      return toToolResult(await completeTask(args, getOptions()));
    },
  );

  server.registerTool(
    "block_task",
    {
      title: "Block OpenBoard task",
      description: "Submit a structured blocked report for the current run through POST /api/tasks/:id/block. Requires that run's runStartedAt. When blocked on a question the operator must answer, include needsInput with the direct question (1-2000 chars) so the board can surface it for an answer.",
      inputSchema: BlockTaskInputSchema,
    },
    async (args) => {
      if (worker) assertWorkerAssignment(args, scope);
      return toToolResult(await blockTask(args, getOptions()));
    },
  );
}

function registerInspectionTools(server: McpServer, getOptions: () => McpToolOptions): void {
  server.registerTool(
    "task_context",
    {
      title: "Get task lineage context",
      description: "Retrieve the full resolved task lineage: target handoff, direct-parent handoffs, inherited-ancestor metadata, and code-evidence candidates. No raw transcripts.",
      inputSchema: TaskContextInputSchema,
    },
    async (args) => toToolResult(await taskContext(args, getOptions())),
  );

  server.registerTool(
    "task_compare",
    {
      title: "Compare task evidence",
      description: "Fetch the git delta from a base task's output to a target task's output via GET /api/tasks/:targetId/compare?baseTaskId=:baseTaskId. Returns the real server comparison: a single DiffResponse from base→target with source refs and an honest no-git reason when Git evidence is unavailable.",
      inputSchema: TaskCompareInputSchema,
    },
    async (args) => toToolResult(await taskCompare(args, getOptions())),
  );

  server.registerTool(
    "task_diff",
    {
      title: "Get OpenBoard task diff",
      description: "Fetch the structured Review- or Done-card diff through GET /api/tasks/:id/diff.",
      inputSchema: TaskIdInputSchema,
    },
    async (args) => toToolResult(await taskDiff(args, getOptions())),
  );
}

export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const { profile = "cockpit", workerScope, ...clientOptions } = options;
  let toolOptions: McpToolOptions = { ...clientOptions, requireExplicitBoardUrl: true, mcpStartedAt: options.mcpStartedAt ?? new Date().toISOString() };
  const server = new McpServer({
    name: "openboard",
    version: SERVER_VERSION,
  });

  if (profile === "worker") {
    registerInspectionTools(server, () => toolOptions);
    registerReportTools(server, () => toolOptions, true, workerScope);
    return server;
  }

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

  registerReportTools(server, () => toolOptions, false);

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
    "answer_blocked_task",
    {
      title: "Answer blocked OpenBoard task",
      description: "Submit an operator answer to a blocked task's question through POST /api/tasks/:id/retry with blockedAnswer context. The answer text is carried as bounded retry feedback. Blocks on duplicate in-flight answers.",
      inputSchema: AnswerBlockedTaskInputSchema,
    },
    async (args) => toToolResult(await answerBlockedTask(args, toolOptions)),
  );

  server.registerTool(
    "respond_permission",
    {
      title: "Respond to permission ask",
      description: "Respond to a pending permission ask for a task. Actions: allow_once (grant this request, permission returns to ask on next matching call), deny (block this request, permission returns to ask). answeredBy is required for audit trail. Returns the updated task projection (post-resolution pending asks included), not an ok/decision outcome object.",
      inputSchema: RespondPermissionInputSchema,
    },
    async (args) => toToolResult(await respondPermission(args, toolOptions)),
  );

  server.registerTool(
    "send_session_message",
    {
      title: "Send session message",
      description: "Send operator-authored chat input to an existing card session. queue continues the session without cancelling the current turn; interrupt cancels the current turn before sending. Requires explicit sender, idempotency id, and expected session identity.",
      inputSchema: SendSessionMessageInputSchema,
    },
    async (args) => toToolResult(await sendSessionMessage(args, toolOptions)),
  );

  server.registerTool(
    "tail_session",
    {
      title: "Tail session activity",
      description: "Fetch a bounded tail snapshot of a task's session activity events, plus run identity, transport/gap truth, and terminal signal. Waits a bounded window after the snapshot to capture the terminal frame that follows on every SSE route path. Not for continuous streaming — use the SSE endpoint directly for unbounded reads. Default limit 50, max 200.",
      inputSchema: TailSessionInputSchema,
    },
    async (args) => toToolResult(await tailSession(args, toolOptions)),
  );

  registerInspectionTools(server, () => toolOptions);

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

export function parseMcpServerArgs(argv: string[]): Pick<McpServerOptions, "profile" | "workerScope"> {
  let worker = false;
  let taskId: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--worker") {
      worker = true;
      continue;
    }
    if (arg === "--task-id") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-") || !value.trim()) {
        throw new Error("--task-id requires a non-empty value");
      }
      taskId = value.trim();
      i += 1;
      continue;
    }
    throw new Error(`Unknown MCP server argument: ${arg}`);
  }

  if (taskId !== undefined && !worker) {
    throw new Error("--task-id requires --worker");
  }
  if (!worker) return {};
  return {
    profile: "worker",
    ...(taskId !== undefined ? { workerScope: { taskId } } : {}),
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const server = createMcpServer(parseMcpServerArgs(argv));
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
