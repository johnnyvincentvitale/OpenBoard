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
  type CompletionInput,
  type TaskSummary,
} from "../client/board-client";
import type { Column, DiffResponse, MergeOutcome, RosterAgent, TaskComment, TaskEvent } from "../shared";
import { CLAUDE_CODE_PERMISSION_MODES, TASK_HARNESSES, TASK_KINDS } from "../shared";
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
  })
  .strict();
export const CompleteTaskInputSchema = z
  .object({ taskId: IdSchema, runStartedAt: z.number().finite().optional(), report: CompletionReportInputSchema })
  .strict();
export const CommentTaskInputSchema = z.object({ taskId: IdSchema, author: z.string(), body: z.string() }).strict();
export const IntegrateTaskInputSchema = z
  .object({
    taskId: IdSchema,
    confirmReviewed: z.literal(true),
    targetBranch: z.string().optional(),
    commitRemaining: z.boolean().optional(),
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
  const tasks = await client.moveTask(parsed.taskId, parsed.column as Column, parsed.position, parsed.completedBy);
  return { boardUrl: client.boardUrl, count: tasks.length, tasks: tasks.map(toTaskSummary) };
}

export async function completeTask(input: unknown, options: McpToolOptions = {}): Promise<TaskResult> {
  const parsed = CompleteTaskInputSchema.parse(input);
  const client = await createMcpBoardClient(options);
  const task = await client.completeTask(parsed.taskId, parsed.report as CompletionInput, parsed.runStartedAt);
  return { boardUrl: client.boardUrl, task: toTaskSummary(task) };
}

export async function blockTask(input: unknown, options: McpToolOptions = {}): Promise<TaskResult> {
  const parsed = CompleteTaskInputSchema.parse(input);
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
  const outcome = await client.integrateTask(parsed.taskId, parsed.targetBranch, { commitRemaining: parsed.commitRemaining });
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

export async function selectInstance(input: unknown, options: McpToolOptions = {}): Promise<{ boardUrl: string; selection: CurrentSelection; options: McpToolOptions }> {
  const parsed = SelectInstanceInputSchema.parse(input);
  const target = await resolveInstanceTarget(parsed.name, options);
  const nextOptions: McpToolOptions = { ...target.options, requireExplicitBoardUrl: options.requireExplicitBoardUrl, mcpStartedAt: options.mcpStartedAt };
  return { boardUrl: target.runtime.boardUrl, selection: currentSelectionFromOptions(nextOptions), options: nextOptions };
}

async function createMcpBoardClient(options: McpToolOptions) {
  return createBoardClient(await resolveSelectedOptions(options));
}
