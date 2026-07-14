import type { Task } from "../shared";

export interface ClaudeCodeRunInput {
  task: Task;
  directory: string;
  prompt: string;
  runStartedAt: number;
}

export interface ClaudeCodeRunResult {
  sessionId: string;
  sessionName: string;
  status: string;
}

export interface ClaudeCodeStatus {
  status: string;
  terminal: boolean;
  cwd?: string;
  error?: string;
}

export interface ClaudeCodeRunnerLike {
  run(input: ClaudeCodeRunInput): Promise<ClaudeCodeRunResult>;
  retry(input: ClaudeCodeRunInput): Promise<ClaudeCodeRunResult>;
  runPrepared?(input: ClaudeCodeRunInput, onReady: (result: ClaudeCodeRunResult) => void | Promise<void>): Promise<ClaudeCodeRunResult>;
  retryPrepared?(input: ClaudeCodeRunInput, onReady: (result: ClaudeCodeRunResult) => void | Promise<void>): Promise<ClaudeCodeRunResult>;
  poll(sessionName: string): Promise<ClaudeCodeStatus | undefined>;
  abort(sessionName: string): Promise<void>;
  sendMessage?(sessionName: string, text: string, options: { mode: "queue" | "interrupt"; runStartedAt: number }): Promise<void>;
  shutdown?(): void;
}

export interface ClaudeCodeRunnerDeps {
  adapterBaseUrl: string;
  boardToken?: string;
  instanceName?: string;
  command?: string;
  permissionMode?: string;
  env?: NodeJS.ProcessEnv;
}
