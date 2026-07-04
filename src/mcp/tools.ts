import * as z from "zod/v4";
import {
  BOARD_UNAVAILABLE_MESSAGE,
  DEFAULT_BOARD_URL,
  createBoardClient,
  parseModelRef,
  resolveBoardUrl,
  toTaskSummary,
  type BoardClientOptions,
  type TaskSummary,
} from "../client/board-client";
import type { RosterAgent } from "../shared";

export const AddTaskInputSchema = z
  .object({
    title: z.string(),
    description: z.string().optional(),
    directory: z.string().optional(),
    agent: z.string().optional(),
    model: z.string().optional(),
    isolation: z.string().optional(),
  })
  .strict();

export const AddTasksInputSchema = z
  .object({
    tasks: z.array(AddTaskInputSchema).min(1),
  })
  .strict();

export type AddTasksInput = z.infer<typeof AddTasksInputSchema>;

export type McpToolOptions = BoardClientOptions;

export interface AddTasksResult {
  boardUrl: string;
  count: number;
  created: TaskSummary[];
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

export { BOARD_UNAVAILABLE_MESSAGE, DEFAULT_BOARD_URL, parseModelRef, resolveBoardUrl };

export async function addTasks(input: unknown, options: McpToolOptions = {}): Promise<AddTasksResult> {
  const parsed = AddTasksInputSchema.parse(input);
  const client = createBoardClient(options);
  const created = await client.createTasks(parsed.tasks);
  return { boardUrl: client.boardUrl, count: created.length, created: created.map(toTaskSummary) };
}

export async function listTasks(options: McpToolOptions = {}): Promise<ListTasksResult> {
  const client = createBoardClient(options);
  const tasks = await client.listTaskSummaries();
  return { boardUrl: client.boardUrl, count: tasks.length, tasks };
}

export async function listAgents(options: McpToolOptions = {}): Promise<ListAgentsResult> {
  const client = createBoardClient(options);
  const agents = await client.listAgents();
  return { boardUrl: client.boardUrl, count: agents.length, agents };
}
