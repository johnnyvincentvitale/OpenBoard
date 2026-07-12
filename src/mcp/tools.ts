import * as z from "zod/v4";
import {
  BOARD_UNAVAILABLE_MESSAGE,
  DEFAULT_BOARD_URL,
  createBoardClient,
  parseModelRef,
  resolveBoardUrl,
  toTaskSummary,
  type BoardClientOptions,
  type BoardHealth,
  type CompactBlockedProjection,
  type CompletionInput,
  type TaskSummary,
} from "../client/board-client";
import type {
  Column,
  DiffResponse,
  MergeOutcome,
  PendingPermissionAsk,
  RosterAgent,
  SessionActivityEvent,
  SessionActivityRun,
  SessionActivityTransport,
  TaskComment,
  TaskEvent,
  TaskContext,
  TaskCompareResponse,
  SessionMessageReceipt,
} from "../shared";
import {
  CLAUDE_CODE_PERMISSION_MODES,
  TASK_HARNESSES,
  TASK_KINDS,
  blockedQuestion,
} from "../shared";
import {
  currentSelectionFromOptions,
  listInstances as listRegisteredInstances,
  mergeHealthIdentity,
  resolveInstanceTarget,
  resolveSelectedOptions,
  type CurrentSelection,
  type InstanceSummary,
} from "./instance-selection";

const IdSchema = z.string().min(1);
const AcpOptionValueSchema = z.union([z.string(), z.number().finite(), z.boolean()]);
const AcpOptionsSchema = z.record(z.string().min(1), AcpOptionValueSchema);
const CompletionReportInputSchema = z
  .object({
    summary: z.string(),
    changedFiles: z.array(z.string()),
    verification: z.array(z.object({ command: z.string(), result: z.string() }).strict()),
    residualRisk: z.string(),
  })
  .strict();

// Blocked reports may carry a direct question for the operator. Mirrors the
// /api/tasks/:id/block route's own validation (completion.ts:199-212): the
// value is trimmed, then must be 1..2000 characters. /complete rejects this
// field by design, so it is not part of CompletionReportInputSchema.
const BlockReportInputSchema = z
  .object({
    summary: z.string(),
    changedFiles: z.array(z.string()),
    verification: z.array(z.object({ command: z.string(), result: z.string() }).strict()),
    residualRisk: z.string(),
    needsInput: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

const ManualTaskInputSchema = z
  .object({
    type: z.literal("manual"),
    taskKind: z.enum(TASK_KINDS).optional(),
    title: z.string(),
    description: z.string().optional(),
    directory: z.string().optional(),
    assignedTo: z.string().optional(),
  })
  .strict();

const AgentTaskInputSchema = z
  .object({
    type: z.literal("agent").optional(),
    taskKind: z.enum(TASK_KINDS).optional(),
    harness: z.enum(TASK_HARNESSES).optional(),
    title: z.string(),
    description: z.string().optional(),
    directory: z.string().optional(),
    agent: z.string().optional(),
    permissionMode: z.enum(CLAUDE_CODE_PERMISSION_MODES).optional(),
    claudePermissionMode: z.enum(CLAUDE_CODE_PERMISSION_MODES).optional(),
    acpOptions: AcpOptionsSchema.optional(),
    model: z.string().optional(),
    isolation: z.enum(["worktree", "in-place"]).optional(),
    autoRun: z
      .boolean()
      .optional()
      .describe(
        'Opt-in auto-dispatch: the card self-dispatches once its parents are satisfied. Requires isolation "worktree", or in-place OpenCode with permissionOverrides edit and bash set to "deny" (write-fenced read-only work).',
      ),
  })
  .strict();

export const CreateTaskInputSchema = z.union([ManualTaskInputSchema, AgentTaskInputSchema]);

export const AddTaskInputSchema = z
  .object({
    type: z.enum(["manual", "agent"]).optional(),
    taskKind: z.enum(TASK_KINDS).optional(),
    harness: z.enum(TASK_HARNESSES).optional(),
    title: z.string(),
    description: z.string().optional(),
    directory: z.string().optional(),
    agent: z.string().optional(),
    permissionMode: z.enum(CLAUDE_CODE_PERMISSION_MODES).optional(),
    claudePermissionMode: z.enum(CLAUDE_CODE_PERMISSION_MODES).optional(),
    acpOptions: AcpOptionsSchema.optional(),
    assignedTo: z.string().optional(),
    model: z.string().optional(),
    isolation: z.enum(["worktree", "in-place"]).optional(),
    autoRun: z
      .boolean()
      .optional()
      .describe(
        'Opt-in auto-dispatch: the card self-dispatches once its parents are satisfied. Requires isolation "worktree", or in-place OpenCode with permissionOverrides edit and bash set to "deny" (write-fenced read-only work).',
      ),
  })
  .strict();

export const AddTasksInputSchema = z
  .object({
    tasks: z.array(AddTaskInputSchema).min(1),
  })
  .strict();

export type AddTasksInput = z.infer<typeof AddTasksInputSchema>;

export const TaskIdInputSchema = z.object({ taskId: IdSchema }).strict();
export const LinkTasksInputSchema = z.object({ parentId: IdSchema, childId: IdSchema }).strict();
export const RunTaskInputSchema = TaskIdInputSchema;
export const RetryTaskInputSchema = z.object({ taskId: IdSchema, feedback: z.string().optional() }).strict();
export const MoveTaskInputSchema = z
  .object({
    taskId: IdSchema,
    column: z.enum(["todo", "in_progress", "review", "done"]),
    position: z.number().finite(),
    completedBy: z.string().optional(),
    blockedAcceptance: z
      .object({
        blockedReportedAt: z.number().finite(),
        acceptIncomplete: z.literal(true),
      })
      .strict()
      .optional(),
  })
  .strict();
export const CompleteTaskInputSchema = z
  .object({ taskId: IdSchema, runStartedAt: z.number().finite().optional(), report: CompletionReportInputSchema })
  .strict();
export const BlockTaskInputSchema = z
  .object({ taskId: IdSchema, runStartedAt: z.number().finite().optional(), report: BlockReportInputSchema })
  .strict();
export const CommentTaskInputSchema = z.object({ taskId: IdSchema, author: z.string(), body: z.string() }).strict();
export const IntegrateTaskInputSchema = z
  .object({
    taskId: IdSchema,
    confirmReviewed: z.literal(true),
    targetBranch: z.string().optional(),
    commitRemaining: z.boolean().optional(),
    blockedAcceptance: z
      .object({
        blockedReportedAt: z.number().finite(),
        acceptIncomplete: z.literal(true),
      })
      .strict()
      .optional(),
  })
  .strict();
export const AnswerBlockedTaskInputSchema = z
  .object({
    taskId: IdSchema,
    answer: z.string().min(1).max(2000),
    answeredBy: z.string().min(1).max(200),
    blockedReportedAt: z.number().finite(),
  })
  .strict();
export const RespondPermissionInputSchema = z
  .object({
    taskId: IdSchema,
    askId: IdSchema,
    action: z.enum(["allow_once", "deny"]),
    answeredBy: z.string().min(1).max(200),
  })
  .strict();
export const SendSessionMessageInputSchema = z
  .object({
    taskId: IdSchema,
    text: z.string().trim().min(1).max(12000),
    mode: z.enum(["queue", "interrupt"]).default("queue"),
    sentBy: z.string().trim().min(1).max(200),
    clientMessageId: z.string().trim().min(1).max(200),
    expectedSessionId: z.string().trim().min(1).max(500),
    expectedRunStartedAt: z.number().finite().optional(),
    blockedReportedAt: z.number().finite().optional(),
  })
  .strict();
export const TailSessionInputSchema = z
  .object({
    taskId: IdSchema,
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.number().int().min(0).optional(),
    timeoutMs: z.number().int().min(100).max(30000).optional(),
  })
  .strict();
export const TaskContextInputSchema = z
  .object({
    taskId: IdSchema,
  })
  .strict();
export const TaskCompareInputSchema = z
  .object({
    targetTaskId: IdSchema,
    baseTaskId: IdSchema,
  })
  .strict();
export const SelectInstanceInputSchema = z.object({ name: IdSchema }).strict();

export type McpToolOptions = BoardClientOptions & { mcpStartedAt?: string };

export interface AddTasksResult {
  boardUrl: string;
  count: number;
  created: TaskSummary[];
}

export interface TaskResult {
  boardUrl: string;
  task: TaskSummary;
}

export interface MoveTaskResult {
  boardUrl: string;
  count: number;
  tasks: TaskSummary[];
}

export interface LinkTasksResult extends TaskResult {
  parentId: string;
  childId: string;
}

export interface MergeResult {
  boardUrl: string;
  outcome: Omit<MergeOutcome, "task"> & { task: TaskSummary };
}

export interface CommentResult {
  boardUrl: string;
  comment: TaskComment;
}

export interface TaskEventsResult {
  boardUrl: string;
  taskId: string;
  count: number;
  events: TaskEvent[];
}

export interface TaskDiffResult {
  boardUrl: string;
  taskId: string;
  diff: DiffResponse;
}

export interface ListTasksResult {
  boardUrl: string;
  count: number;
  tasks: TaskSummary[];
}

export interface ListAgentsResult {
  boardUrl: string;
  count: number;
  agents: RosterAgent[];
}

export interface CurrentInstanceResult {
  boardUrl?: string;
  selection: CurrentSelection;
}

export interface ListInstancesResult {
  count: number;
  instances: InstanceSummary[];
}

export interface OpenboardStatusResult {
  boardUrl?: string;
  selection: CurrentSelection;
  mcpStartedAt: string;
  apiReachable: boolean;
  health?: BoardHealth;
  agentCount?: number;
  taskCount?: number;
}

export interface AnswerBlockedTaskResult {
  boardUrl: string;
  task: TaskSummary;
  taskId: string;
  answeredBy: string;
}

export interface RespondPermissionResult {
  boardUrl: string;
  task: TaskSummary;
  taskId: string;
  askId: string;
  action: "allow_once" | "deny";
  resolution: "operator";
  answeredBy: string;
}

export interface SendSessionMessageResult {
  boardUrl: string;
  receipt: Omit<SessionMessageReceipt, "task"> & { task: TaskSummary };
}

export interface TailSessionResult {
  boardUrl: string;
  taskId: string;
  run?: SessionActivityRun;
  transport?: SessionActivityTransport;
  events: SessionActivityEvent[];
  lastEventAt?: number | null;
  hasGap: boolean;
  terminal?: { status: string };
  bounded: boolean;
}

export interface TaskContextResult {
  boardUrl: string;
  taskId: string;
  context: TaskContext;
}

export interface TaskCompareResult {
  boardUrl: string;
  targetTaskId: string;
  baseTaskId: string;
  comparison: TaskCompareResponse;
}

export { BOARD_UNAVAILABLE_MESSAGE, DEFAULT_BOARD_URL, parseModelRef, resolveBoardUrl };

export async function addTasks(input: unknown, options: McpToolOptions = {}): Promise<AddTasksResult> {
  const parsed = AddTasksInputSchema.parse(input);
  const created: TaskSummary[] = [];
  let boardUrl = "";
  for (const task of parsed.tasks) {
    const result = await createTask(task, options);
    boardUrl = result.boardUrl;
    created.push(result.task);
  }
  return { boardUrl, count: created.length, created };
}

export async function createTask(input: unknown, options: McpToolOptions = {}): Promise<TaskResult> {
  const parsed = CreateTaskInputSchema.parse(input);
  const client = await createMcpBoardClient(options);
  const task = await client.createTask(parsed);
  return { boardUrl: client.boardUrl, task: toTaskSummary(task) };
}

export async function listTasks(options: McpToolOptions = {}): Promise<ListTasksResult> {
  const client = await createMcpBoardClient(options);
  const tasks = await client.listTaskSummaries();
  return { boardUrl: client.boardUrl, count: tasks.length, tasks };
}

export async function listAgents(options: McpToolOptions = {}): Promise<ListAgentsResult> {
  const client = await createMcpBoardClient(options);
  const agents = await client.listAgents();
  return { boardUrl: client.boardUrl, count: agents.length, agents };
}

export async function linkTasks(input: unknown, options: McpToolOptions = {}): Promise<LinkTasksResult> {
  const parsed = LinkTasksInputSchema.parse(input);
  const client = await createMcpBoardClient(options);
  const task = await client.linkTasks(parsed.parentId, parsed.childId);
  return { boardUrl: client.boardUrl, parentId: parsed.parentId, childId: parsed.childId, task: toTaskSummary(task) };
}

export async function unlinkTasks(input: unknown, options: McpToolOptions = {}): Promise<LinkTasksResult> {
  const parsed = LinkTasksInputSchema.parse(input);
  const client = await createMcpBoardClient(options);
  const task = await client.unlinkTasks(parsed.parentId, parsed.childId);
  return { boardUrl: client.boardUrl, parentId: parsed.parentId, childId: parsed.childId, task: toTaskSummary(task) };
}

export async function runTask(input: unknown, options: McpToolOptions = {}): Promise<TaskResult> {
  const parsed = RunTaskInputSchema.parse(input);
  const client = await createMcpBoardClient(options);
  const task = await client.runTask(parsed.taskId);
  return { boardUrl: client.boardUrl, task: toTaskSummary(task) };
}

export async function retryTask(input: unknown, options: McpToolOptions = {}): Promise<TaskResult> {
  const parsed = RetryTaskInputSchema.parse(input);
  const client = await createMcpBoardClient(options);
  const task = await client.retryTask(parsed.taskId, parsed.feedback);
  return { boardUrl: client.boardUrl, task: toTaskSummary(task) };
}

export async function abortTask(input: unknown, options: McpToolOptions = {}): Promise<TaskResult> {
  const parsed = TaskIdInputSchema.parse(input);
  const client = await createMcpBoardClient(options);
  const task = await client.abortTask(parsed.taskId);
  return { boardUrl: client.boardUrl, task: toTaskSummary(task) };
}

export async function moveTask(input: unknown, options: McpToolOptions = {}): Promise<MoveTaskResult> {
  const parsed = MoveTaskInputSchema.parse(input);
  if (parsed.column === "done" && !parsed.completedBy?.trim()) {
    throw new Error("completedBy is required when moving a task to done through MCP");
  }
  const client = await createMcpBoardClient(options);
  const tasks = await client.moveTask(
    parsed.taskId,
    parsed.column as Column,
    parsed.position,
    parsed.completedBy,
    parsed.blockedAcceptance
      ? { blockedReportedAt: parsed.blockedAcceptance.blockedReportedAt, acceptIncomplete: true }
      : undefined,
  );
  return { boardUrl: client.boardUrl, count: tasks.length, tasks: tasks.map(toTaskSummary) };
}

export async function completeTask(input: unknown, options: McpToolOptions = {}): Promise<TaskResult> {
  const parsed = CompleteTaskInputSchema.parse(input);
  const client = await createMcpBoardClient(options);
  const task = await client.completeTask(parsed.taskId, parsed.report as CompletionInput, parsed.runStartedAt);
  return { boardUrl: client.boardUrl, task: toTaskSummary(task) };
}

export async function blockTask(input: unknown, options: McpToolOptions = {}): Promise<TaskResult> {
  const parsed = BlockTaskInputSchema.parse(input);
  const client = await createMcpBoardClient(options);
  const task = await client.blockTask(parsed.taskId, parsed.report as CompletionInput, parsed.runStartedAt);
  return { boardUrl: client.boardUrl, task: toTaskSummary(task) };
}

export async function syncTask(input: unknown, options: McpToolOptions = {}): Promise<MergeResult> {
  const parsed = TaskIdInputSchema.parse(input);
  const client = await createMcpBoardClient(options);
  const outcome = await client.syncTask(parsed.taskId);
  return { boardUrl: client.boardUrl, outcome: { ...outcome, task: toTaskSummary(outcome.task) } };
}

export async function integrateTask(input: unknown, options: McpToolOptions = {}): Promise<MergeResult> {
  const parsed = IntegrateTaskInputSchema.parse(input);
  const client = await createMcpBoardClient(options);
  const outcome = await client.integrateTask(parsed.taskId, parsed.targetBranch, {
    commitRemaining: parsed.commitRemaining,
    blockedAcceptance: parsed.blockedAcceptance
      ? { blockedReportedAt: parsed.blockedAcceptance.blockedReportedAt, acceptIncomplete: true }
      : undefined,
  });
  return { boardUrl: client.boardUrl, outcome: { ...outcome, task: toTaskSummary(outcome.task) } };
}

export async function commentTask(input: unknown, options: McpToolOptions = {}): Promise<CommentResult> {
  const parsed = CommentTaskInputSchema.parse(input);
  const client = await createMcpBoardClient(options);
  const comment = await client.addComment(parsed.taskId, parsed.author, parsed.body);
  return { boardUrl: client.boardUrl, comment };
}

export const addNote = commentTask;

export async function taskEvents(input: unknown, options: McpToolOptions = {}): Promise<TaskEventsResult> {
  const parsed = TaskIdInputSchema.parse(input);
  const client = await createMcpBoardClient(options);
  const events = await client.listTaskEvents(parsed.taskId);
  return { boardUrl: client.boardUrl, taskId: parsed.taskId, count: events.length, events };
}

export async function taskDiff(input: unknown, options: McpToolOptions = {}): Promise<TaskDiffResult> {
  const parsed = TaskIdInputSchema.parse(input);
  const client = await createMcpBoardClient(options);
  const diff = await client.getTaskDiff(parsed.taskId);
  return { boardUrl: client.boardUrl, taskId: parsed.taskId, diff };
}

export async function listInstances(): Promise<ListInstancesResult> {
  const instances = await listRegisteredInstances();
  return { count: instances.length, instances };
}

export async function currentInstance(options: McpToolOptions = {}): Promise<CurrentInstanceResult> {
  const selection = currentSelectionFromOptions(options);
  return { ...(selection.boardUrl !== undefined ? { boardUrl: selection.boardUrl } : {}), selection };
}

export async function openboardStatus(options: McpToolOptions = {}): Promise<OpenboardStatusResult> {
  const initialSelection = currentSelectionFromOptions(options);
  try {
    const client = await createMcpBoardClient(options);
    const health = await client.getHealth();
    const [agents, tasks] = await Promise.allSettled([client.listAgents(), client.listTaskSummaries()]);
    const selection = mergeHealthIdentity(initialSelection, health);
    return {
      boardUrl: client.boardUrl,
      selection,
      mcpStartedAt: options.mcpStartedAt ?? new Date(0).toISOString(),
      apiReachable: true,
      health,
      ...(agents.status === "fulfilled" ? { agentCount: agents.value.length } : {}),
      ...(tasks.status === "fulfilled" ? { taskCount: tasks.value.length } : {}),
    };
  } catch {
    return {
      ...(initialSelection.boardUrl !== undefined ? { boardUrl: initialSelection.boardUrl } : {}),
      selection: initialSelection,
      mcpStartedAt: options.mcpStartedAt ?? new Date(0).toISOString(),
      apiReachable: false,
    };
  }
}

export async function respondPermission(input: unknown, options: McpToolOptions = {}): Promise<RespondPermissionResult> {
  const parsed = RespondPermissionInputSchema.parse(input);
  const client = await createMcpBoardClient(options);
  const updated = await client.respondPermission(parsed.taskId, {
    askId: parsed.askId,
    action: parsed.action,
    answeredBy: parsed.answeredBy,
  });
  return {
    boardUrl: client.boardUrl,
    task: toTaskSummary(updated),
    taskId: parsed.taskId,
    askId: parsed.askId,
    action: parsed.action,
    resolution: "operator",
    answeredBy: parsed.answeredBy,
  };
}

export async function sendSessionMessage(input: unknown, options: McpToolOptions = {}): Promise<SendSessionMessageResult> {
  const parsed = SendSessionMessageInputSchema.parse(input);
  const client = await createMcpBoardClient(options);
  const receipt = await client.sendSessionMessage(parsed.taskId, parsed);
  return { boardUrl: client.boardUrl, receipt: { ...receipt, task: toTaskSummary(receipt.task) } };
}

/**
 * Bounded window (ms) to capture the terminal frame after the snapshot
 * arrives. The SSE route always emits snapshot before terminal on every
 * path (see session-events.ts), so we defer resolution until the terminal
 * arrives or this window expires — whichever comes first. This is bounded:
 * it cannot hang, it cannot leak the AbortController, and the overall
 * timeoutMs is still the hard backstop.
 */
const TERMINAL_WINDOW_MS = 500;

/**
 * Collect buffered session-activity events for a task's current or most recent
 * run, plus transport/gap/generation-truth metadata. Returns a bounded tail
 * snapshot by default (up to 50 events); raise limit up to 200 with a longer
 * timeout. Callers that need unbounded streaming should use the SSE endpoint
 * (session-events) through the board-client directly — this function is for
 * diagnostic and orchestrator inspection, not continuous monitoring.
 *
 * Wire ordering: the SSE route emits snapshot, then terminal (then closes).
 * This function resolves as soon as the terminal frame arrives after the
 * snapshot. If the terminal does not arrive within a bounded window
 * (TERMINAL_WINDOW_MS) after the snapshot, it resolves without a terminal
 * signal — the session may still be live. The overall timeoutMs is the hard
 * backstop for the case where no snapshot ever arrives.
 */
export async function tailSession(input: unknown, options: McpToolOptions = {}): Promise<TailSessionResult> {
  const parsed = TailSessionInputSchema.parse(input);
  const client = await createMcpBoardClient(options);
  const limit = parsed.limit ?? 50;
  const timeoutMs = parsed.timeoutMs ?? 3000;

  return new Promise<TailSessionResult>((resolve, reject) => {
    const controller = new AbortController();
    let resolved = false;
    let snapshotData: {
      run: SessionActivityRun;
      transport: SessionActivityTransport;
      events: SessionActivityEvent[];
      lastEventAt: number | null;
    } | null = null;
    let terminalBuffer: { status: string } | undefined;
    let gapBuffer = false;
    let terminalTimer: ReturnType<typeof setTimeout> | null = null;

    function doFinish() {
      if (resolved) return;
      resolved = true;
      clearTimeout(overallTimer);
      if (terminalTimer) clearTimeout(terminalTimer);
      controller.abort();
      const rawEvents = snapshotData ? snapshotData.events : [];
      const events = rawEvents.slice(0, limit);
      // bounded = more events exist than we returned, or a gap was reported.
      // Compare the pre-slice count to `limit`: exactly `limit` events (and
      // nothing more) is not truncated.
      const bounded = rawEvents.length > limit || gapBuffer;
      resolve({
        boardUrl: client.boardUrl,
        taskId: parsed.taskId,
        ...(snapshotData ? { run: snapshotData.run, transport: snapshotData.transport, lastEventAt: snapshotData.lastEventAt } : {}),
        events,
        hasGap: gapBuffer,
        ...(terminalBuffer ? { terminal: terminalBuffer } : {}),
        bounded,
      });
    }

    // Overall timeout: reject if we never got a snapshot; resolve without
    // a terminal signal if we got a snapshot but no terminal frame.
    const overallTimer = setTimeout(() => {
      if (resolved) return;
      if (snapshotData) {
        doFinish();
      } else {
        resolved = true;
        controller.abort();
        reject(new Error("tail_session timed out waiting for snapshot events"));
      }
    }, timeoutMs);

    client.streamSessionEvents(parsed.taskId, (frame) => {
      if (resolved) return;

      if (frame.kind === "snapshot") {
        if (!snapshotData) {
          snapshotData = {
            run: frame.run,
            transport: frame.transport,
            events: frame.events,
            lastEventAt: frame.lastEventAt,
          };
          // Start a bounded window to capture the terminal frame that
          // follows the snapshot on every SSE route path.
          terminalTimer = setTimeout(() => {
            if (!resolved) doFinish();
          }, TERMINAL_WINDOW_MS);
        }
      } else if (frame.kind === "terminal") {
        terminalBuffer = { status: frame.status };
        // Terminal is the last frame the route emits — resolve immediately
        // whether or not a snapshot preceded it.
        doFinish();
      } else if (frame.kind === "gap") {
        gapBuffer = true;
      }
    }, { limit, cursor: parsed.cursor, signal: controller.signal }).catch((err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(overallTimer);
        if (terminalTimer) clearTimeout(terminalTimer);
        controller.abort();
        reject(err);
      }
    });
  });
}

export async function taskContext(input: unknown, options: McpToolOptions = {}): Promise<TaskContextResult> {
  const parsed = TaskContextInputSchema.parse(input);
  const client = await createMcpBoardClient(options);

  const rawContext = await client.getTaskContext(parsed.taskId);
  // Validate the response matches the TaskContext contract (nested `task`
  // key) rather than trusting the client's static type blindly — the client
  // casts the raw JSON without runtime validation.
  const json = rawContext as unknown as Record<string, unknown>;
  if (
    typeof json !== "object" || json === null ||
    typeof json.task !== "object" || json.task === null ||
    !Array.isArray(json.directParents) ||
    !Array.isArray(json.inheritedParents) ||
    !Array.isArray(json.codeAncestors)
  ) {
    throw new Error("task_context returned an unexpected response shape (missing task/directParents/inheritedParents/codeAncestors)");
  }
  const context = rawContext;
  return { boardUrl: client.boardUrl, taskId: parsed.taskId, context };
}

export async function taskCompare(input: unknown, options: McpToolOptions = {}): Promise<TaskCompareResult> {
  const parsed = TaskCompareInputSchema.parse(input);
  if (parsed.baseTaskId === parsed.targetTaskId) {
    throw new Error("baseTaskId cannot be the same as targetTaskId");
  }
  const client = await createMcpBoardClient(options);
  const comparison = await client.getTaskCompare(parsed.targetTaskId, parsed.baseTaskId);
  return { boardUrl: client.boardUrl, targetTaskId: parsed.targetTaskId, baseTaskId: parsed.baseTaskId, comparison };
}

export async function answerBlockedTask(input: unknown, options: McpToolOptions = {}): Promise<AnswerBlockedTaskResult> {
  const parsed = AnswerBlockedTaskInputSchema.parse(input);
  const client = await createMcpBoardClient(options);
  const task = await client.answerBlockedTask(parsed.taskId, parsed.answer, {
    blockedReportedAt: parsed.blockedReportedAt,
    answeredBy: parsed.answeredBy,
  });
  return { boardUrl: client.boardUrl, task: toTaskSummary(task), taskId: parsed.taskId, answeredBy: parsed.answeredBy };
}

export async function selectInstance(input: unknown, options: McpToolOptions = {}): Promise<{ boardUrl: string; selection: CurrentSelection; options: McpToolOptions }> {
  const parsed = SelectInstanceInputSchema.parse(input);
  const target = await resolveInstanceTarget(parsed.name, options);
  const nextOptions: McpToolOptions = { ...target.options, requireExplicitBoardUrl: options.requireExplicitBoardUrl, mcpStartedAt: options.mcpStartedAt };
  return { boardUrl: target.runtime.boardUrl, selection: currentSelectionFromOptions(nextOptions), options: nextOptions };
}

async function createMcpBoardClient(options: McpToolOptions) {
  return createBoardClient(await resolveSelectedOptions(options));
}
