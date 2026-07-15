export const OPENBOARD_MCP_TOOL_NAMES = [
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

export const OPENBOARD_WORKER_TOOL_NAMES = [
  "task_diff",
  "task_context",
  "task_compare",
  "complete_task",
  "block_task",
] as const satisfies readonly (typeof OPENBOARD_MCP_TOOL_NAMES)[number][];

const WORKER_TOOLS = new Set<string>(OPENBOARD_WORKER_TOOL_NAMES);

/** OpenCode prefixes MCP tools with the configured server name. */
export const OPENBOARD_WORKER_DENIED_TOOL_IDS = OPENBOARD_MCP_TOOL_NAMES
  .filter((name) => !WORKER_TOOLS.has(name))
  .map((name) => `openboard_${name}`);
