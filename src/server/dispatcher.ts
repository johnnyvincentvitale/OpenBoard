/**
 * The Push dispatcher — turns Tasks into running OpenCode sessions and auto-moves
 * cards as those sessions progress.
 *
 * `run()` creates a session in the task's directory, kicks off an async prompt with
 * the task's description, links the session id onto the task, and moves it to
 * `in_progress`. `start()` consumes the global `/event` stream and reacts to
 * live-state changes on any session linked to a task: `running` keeps the task in
 * sync, text-ended events cache the latest useful assistant output, `idle`
 * triggers a completion check, and `error` records the failure without moving the
 * card. `retry()` re-prompts an existing session and
 * moves the task back to `in_progress`. `abort()` stops the task's session.
 * `shutdown()` stops consuming the event stream.
 */
import { basename, dirname, join, resolve } from "node:path";
import type { Event as OpencodeEvent } from "@opencode-ai/sdk/v2/types";
import type { AcpTaskHarness, BlockedAcceptance, BlockedAnswerContext, BlockedAnswerResumeDecision, DiffResponse, FileCommitOutcome, MergeOutcome, ModelRef, PendingPermissionAsk, RespondPermissionInput, SessionMessageInput, SessionMessageReceipt, Task, TaskEvent, TaskStore, WorktreeCleanupOutcome, WorktreeCommitStatus } from "../shared";
import { AdapterError, INTEGRATED_COMPLETED_BY, blockedQuestion, resolveOpenCodePermissionRules } from "../shared";
import type { Dispatcher } from "../shared";
import type { OpencodeHandle } from "./opencode";
import { detectBaseCheckoutEscape, snapshotBaseCheckout } from "./escape-detector";
import { detectTaskBaseCheckoutEscape, markTaskBaseCheckoutEscape } from "./base-checkout-escape";
import { eventLiveState, eventSessionId } from "./events/session-status";
import { createPermissionResponderPool, type PermissionResponderPool } from "./permission-responder";
import { GitWorktreeManager, type WorktreeManager } from "./worktree";
import { ClaudeAcpRunner, CodexAcpRunner, CursorAcpRunner, GeminiAcpRunner, HermesAcpRunner, PiAcpRunner } from "./claude-acp-runner";
import type { ClaudeCodeRunnerLike } from "./acp-runner";
import { completionHandoffGuidance } from "./completion-contract";
import { computeDiffAgainstWorkingTree } from "./diff-engine";
import { loadPermissionConfig, loadWatchdogConfig, type WatchdogConfig } from "./config";
import { dirtyWarning, inspectGitDirectory, isWorkingTreeDirty, resolveHeadCommit } from "./git-inspect";
import { SessionActivityCollector, type SessionActivityEventInput } from "./session-activity";
import { directParentPromptBlock, taskExecutionContext } from "./task-context";
import { createPermissionBroker, type PermissionAskEvent, type PermissionBroker, type RespondOutcome } from "./permission-broker";
import { resolveTaskLineage } from "./task-lineage";
import { RunWatchdog, type WatchdogClock, type WatchdogRetryDecision, type WatchdogRunIdentity, type WatchdogTermination } from "./watchdog";
import { evaluateDonePolicy } from "./done-policy";
import {
  isExternalDirectoriesAllowed,
  isUnderWorkspace,
  resolveBoardWorkspace,
  resolveTaskDirectory,
} from "./workspace";

export interface UnmetParentDependency {
  id: string;
  title: string;
  why: string;
}

export class DependencyGateError extends Error {
  readonly status = 409;
  readonly unmetParents: UnmetParentDependency[];

  constructor(unmetParents: UnmetParentDependency[]) {
    super(`Task has unmet parent dependencies: ${unmetParents.map((p) => p.title).join(", ")}`);
    this.name = "DependencyGateError";
    this.unmetParents = unmetParents;
  }
}

export class ArchivedTaskActionError extends AdapterError {
  constructor(action: "run" | "retry") {
    super("validation", `Cannot ${action} an archived task`);
    this.name = "ArchivedTaskActionError";
  }

  override get status(): number {
    return 409;
  }
}

/** A synchronous dispatch claim already owns this task's pre-session window. */
export class RunDispatchClaimError extends AdapterError {
  constructor(taskId: string) {
    super("validation", `Task is already being dispatched: ${taskId}`);
    this.name = "RunDispatchClaimError";
  }

  override get status(): number {
    return 409;
  }
}

export class StaleTaskRunError extends AdapterError {
  constructor(taskId: string, action: string) {
    super("validation", `Task run changed while ${action} was in progress: ${taskId}`);
    this.name = "StaleTaskRunError";
  }

  override get status(): number {
    return 409;
  }
}

function nextRunStartedAt(task: Pick<Task, "runStartedAt">): number {
  return Math.max(Date.now(), (task.runStartedAt ?? 0) + 1);
}

function sameTaskRunIdentity(current: Task | undefined, expected: Task): current is Task {
  return (
    current !== undefined &&
    current.runStartedAt === expected.runStartedAt &&
    current.sessionId === expected.sessionId &&
    current.harnessSessionId === expected.harnessSessionId &&
    current.harnessSessionName === expected.harnessSessionName
  );
}

function sameTaskRun(current: Task | undefined, expected: Task): boolean {
  return (
    sameTaskRunIdentity(current, expected) &&
    current.runState === expected.runState &&
    current.column === expected.column
  );
}

export interface TaskDispatcherDeps {
  client: OpencodeHandle["client"];
  store: TaskStore;
  /** Base URL for this adapter, injected into spawned ACP MCP configuration. */
  adapterBaseUrl?: string;
  /** Board API token, injected into spawned ACP MCP configuration; never placed in model prompts. */
  boardToken?: string;
  /** Claude Code background-session launcher for `claude-code` harness tasks. */
  claudeRunner?: ClaudeCodeRunnerLike;
  /** ACP background-session launchers for non-OpenCode harness tasks. */
  codexRunner?: ClaudeCodeRunnerLike;
  geminiRunner?: ClaudeCodeRunnerLike;
  hermesRunner?: ClaudeCodeRunnerLike;
  piRunner?: ClaudeCodeRunnerLike;
  cursorRunner?: ClaudeCodeRunnerLike;
  /** Git worktree engine for isolated runs. Defaults to a real GitWorktreeManager. */
  worktrees?: WorktreeManager;
  /**
   * Where a repo's worktrees live. Default: a sibling `.opencode-board-worktrees/<repo>`
   * dir next to the repo root, so worktrees never nest inside the main working tree.
   */
  worktreeBaseDir?: (repoRoot: string) => string;
  /**
   * The board instance's workspace root. Defaults to `BOARD_WORKSPACE` then the
   * user's home directory.
   */
  workspace?: string;
  /**
   * When true, directories outside the workspace are accepted. Unsafe for
   * shared instances; opt-in only.
   */
  allowExternalDirectories?: boolean;
  /**
   * Override directory canonicalization (tests). Receives the raw stored task
   * directory and must return an absolute, validated path.
   */
  resolveDirectory?: (raw: string) => string;
  /** Named OpenBoard instance to expose to spawned Claude Code sessions. */
  instanceName?: string;
  /** Override the stall-detection threshold (tests only; default DEFAULT_STALL_THRESHOLD_MS). */
  stallThresholdMs?: number;
  /** Override OPENBOARD_PERMISSION_GRACE_MS (tests only; default loadPermissionConfig()). */
  permissionGraceMs?: number;
  /** Activity collector for OpenCode session-tree relay. */
  activity?: SessionActivityCollector;
  /** Watchdog config for OpenCode runs. Defaults to OPENBOARD_WATCHDOG_MS. */
  watchdogConfig?: WatchdogConfig;
  /** Watchdog clock injection for tests. */
  watchdogClock?: WatchdogClock;
  /** Override blocked-answer resume eligibility probe timeout (tests only). */
  blockedResumeProbeTimeoutMs?: number;
  /**
   * Called after a task moves to "done" via integrate(), so the chain
   * advancer (src/server/chain-advancer.ts) can auto-dispatch any autoRun
   * children whose parents are now satisfied. Deliberately a plain function,
   * not a chain-advancer type import — the advancer imports `unmetReason`
   * from this module, so this module must never import back from it. Also
   * settable post-construction via setOnParentSatisfied() for callers (see
   * serve.ts) that must build the dispatcher and the advancer in either
   * order.
   */
  onParentSatisfied?: (parentId: string) => Promise<void>;
}

/** Resolve whether a task explicitly requests worktree isolation. */
function wantsWorktree(task: Task): boolean {
  return task.isolation === "worktree";
}

/**
 * Whether `parent` currently satisfies a child's dependency gate. Returns
 * null when satisfied, or a human-readable reason when not. This is the
 * single source of truth for parent-satisfaction semantics — reused as-is
 * by the chain advancer (src/server/chain-advancer.ts) rather than
 * duplicated, so "does this parent satisfy its children" only has one
 * definition in the codebase.
 */
export function unmetReason(parent: Task): string | null {
  if (parent.column === "done") return null;
  if (parent.completion?.outcome === "complete" && parent.completionSource === "reported") return null;
  if (parent.completion?.outcome === "blocked") return "parent reported blocked";
  if (parent.completionSource === "idle-fallback") return "parent went idle without a completion report";
  if (parent.column === "review") return "parent is in review, not done";
  if (parent.runState === "running") return "parent is still running";
  if (parent.runState === "error") return parent.error ? `parent is in error: ${parent.error}` : "parent is in error";
  return `parent is in ${parent.column}`;
}

/** Base/backoff tuning for reconnecting to the upstream OpenCode event stream. */
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 15000;
const COMPLETION_POLL_INTERVAL_MS = 1000;
const COMPLETION_WATCH_TIMEOUT_MS = 6 * 60 * 60 * 1000;
/** How long a session may sit at isStalledAfterToolCalls() with no new messages before nudging. */
const DEFAULT_STALL_THRESHOLD_MS = 45_000;
/** Consecutive nudges producing no new message before giving up — resets to 0 on any progress. */
const MAX_CONSECUTIVE_FUTILE_NUDGES = 2;
/** A denial older than this is treated as unrelated to the current stall (avoids citing stale info). */
const DENIAL_RECENCY_WINDOW_MS = 2 * 60 * 1000;
const BLOCKED_RESUME_PROBE_TIMEOUT_MS = 1_500;
const LINEAGE_PROMPT_MAX_CHARS = 24_000;
const SESSION_TREE_MAX_DEPTH = 16;
const SESSION_TREE_MAX_SESSIONS = 256;
/**
 * How many consecutive watchdog trips the pre-abort status probe may absorb
 * while the session tree still reports busy. Each absorption re-arms the
 * watchdog for one more full window (a long quiet tool call — build, test
 * suite — earns extra patience), but the budget is finite so a session
 * wedged in status "busy" forever still trips.
 */
const MAX_WATCHDOG_BUSY_REARMS = 2;
/**
 * Consecutive reconnect cycles with zero visibility into a run's root
 * session (no status(), no confirmable session tree) before the watchdog is
 * resumed on pure liveness-timeout as a bounded fallback. Below this bound we
 * stay honestly silent rather than false-orphaning or false-tripping.
 */
const BLIND_RECONNECT_BOUND = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function isAcpHarness(harness: Task["harness"]): harness is AcpTaskHarness {
  return harness !== undefined && harness !== "opencode";
}

function asAcpHarness(harness: Task["harness"]): AcpTaskHarness {
  return isAcpHarness(harness) ? harness : "claude-code";
}

function harnessDisplayName(harness: AcpTaskHarness): string {
  switch (harness) {
    case "claude-code":
      return "Claude Code";
    case "codex":
      return "Codex ACP";
    case "gemini-acp":
      return "Gemini ACP";
    case "hermes":
      return "Hermes ACP";
    case "pi-coding-agent":
      return "Pi Coding Agent ACP";
    case "cursor-acp":
      return "Cursor ACP";
  }
}

/** The session create response shape differs across OpenCode SDK surfaces. Unwrap defensively. */
function extractSessionId(data: unknown): string | undefined {
  const inner = (data as { data?: unknown })?.data ?? data;
  const id = (inner as { id?: unknown })?.id;
  return typeof id === "string" ? id : undefined;
}

/**
 * The non-v2 message endpoints use `modelID`, while the board stores OpenCode's
 * roster-shaped `ModelRef` as `{ providerID, id }`.
 */
function toPromptModel(
  model: Task["model"],
): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  return {
    providerID: model.providerID,
    modelID: model.id,
  };
}

function hasAssistantTurnFinished(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;

  const latest = messages[messages.length - 1];
  if (latest === null || typeof latest !== "object") return false;

  const info = (latest as { info?: unknown }).info;
  const role =
    info !== null && typeof info === "object"
      ? (info as Record<string, unknown>).role
      : undefined;
  if (role !== "assistant") return false;

  const parts = (latest as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return false;

  const hasActiveTool = parts.some((part) => {
    if (part === null || typeof part !== "object") return false;
    const record = part as Record<string, unknown>;
    if (record.type !== "tool") return false;
    const state = record.state;
    if (state === null || typeof state !== "object") return false;
    const status = (state as Record<string, unknown>).status;
    return status === "pending" || status === "running";
  });
  if (hasActiveTool) return false;

  return parts.some((part) => {
    if (part === null || typeof part !== "object") return false;
    const record = part as Record<string, unknown>;
    return record.type === "step-finish" && record.reason !== "tool-calls";
  });
}

function hasActiveToolCall(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    if (message === null || typeof message !== "object") continue;
    const parts = (message as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (part === null || typeof part !== "object") continue;
      const record = part as Record<string, unknown>;
      if (record.type !== "tool") continue;
      const state = record.state;
      const status = state && typeof state === "object" ? (state as Record<string, unknown>).status : undefined;
      if (status === undefined || status === "pending" || status === "running") return true;
    }
  }
  return false;
}

/**
 * True when the assistant's last step ended specifically because of a tool
 * call — the state OpenCode is supposed to auto-continue from within the
 * same turn, but a fenced denial has been observed to leave the session
 * sitting here indefinitely (Phase 0/live-proof finding). Deliberately the
 * mirror image of `hasAssistantTurnFinished`'s exclusions: a tool call still
 * actively running (`pending`/`running`) is a normal, possibly long-running
 * step and must never be mistaken for this — only a step that has already
 * *finished* with reason "tool-calls" and nothing new following it counts.
 */
function isStalledAfterToolCalls(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;

  const latest = messages[messages.length - 1];
  if (latest === null || typeof latest !== "object") return false;

  const info = (latest as { info?: unknown }).info;
  const role =
    info !== null && typeof info === "object"
      ? (info as Record<string, unknown>).role
      : undefined;
  if (role !== "assistant") return false;

  const parts = (latest as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return false;

  const hasActiveTool = parts.some((part) => {
    if (part === null || typeof part !== "object") return false;
    const record = part as Record<string, unknown>;
    if (record.type !== "tool") return false;
    const state = record.state;
    if (state === null || typeof state !== "object") return false;
    const status = (state as Record<string, unknown>).status;
    return status === "pending" || status === "running";
  });
  if (hasActiveTool) return false;

  return parts.some((part) => {
    if (part === null || typeof part !== "object") return false;
    const record = part as Record<string, unknown>;
    return record.type === "step-finish" && record.reason === "tool-calls";
  });
}

/** Per-session progress tracking used by trackStallAndMaybeNudge(), scoped to one watchCompletion call. */
interface StallTrackingState {
  lastMessageCount: number;
  lastProgressAt: number;
  /** Resets to 0 on any observed progress — a cap means "N in a row with nothing between them." */
  consecutiveFutileNudges: number;
}

function looksLikeCompletionReport(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return true;
  return (
    normalized.startsWith("task complete. here's the handoff") ||
    normalized.startsWith("audit complete. reported via") ||
    normalized.startsWith("reported via `/complete`") ||
    normalized.startsWith("reported via /complete") ||
    normalized.includes("let me submit the completion report") ||
    normalized.includes("submit the completion report") ||
    normalized.includes("call /complete") ||
    normalized.includes("called /complete") ||
    normalized.includes("reported via `/block`") ||
    normalized.includes("reported via /block")
  );
}

function usefulOutput(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed || looksLikeCompletionReport(trimmed)) return null;
  return trimmed;
}

function extractTextEndedOutput(event: OpencodeEvent): string | null {
  if ((event as { type?: unknown }).type !== "session.next.text.ended") return null;
  const properties = (event as { properties?: unknown }).properties;
  if (properties === null || typeof properties !== "object") return null;
  const text = (properties as Record<string, unknown>).text;
  return usefulOutput(typeof text === "string" ? text : null);
}

function assistantMessageText(message: unknown): string | null {
  if (message === null || typeof message !== "object") return null;

  const info = (message as { info?: unknown }).info;
  const role =
    info !== null && typeof info === "object"
      ? (info as Record<string, unknown>).role
      : undefined;
  if (role !== "assistant") return null;

  const parts = (message as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return null;

  const textParts: string[] = [];
  for (const part of parts) {
    if (part === null || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      textParts.push(record.text);
    }
  }

  return usefulOutput(textParts.join("\n"));
}

/**
 * Extract the final useful assistant text output from an OpenCode session
 * message list. Completion-report wrapper messages are skipped so the Output tab
 * does not duplicate the structured Handoff tab.
 */
function extractFinalOutput(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = assistantMessageText(messages[index]);
    if (text) return text;
  }

  return null;
}

/** Position value that always lands a move at the end of the target column. */
const END_OF_COLUMN = Number.POSITIVE_INFINITY;

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "string") return error;
  if (error !== null && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    const data = record.data;
    if (data !== null && typeof data === "object") {
      const message = (data as Record<string, unknown>).message;
      if (typeof message === "string") return message;
    }
    if (typeof record._tag === "string") return record._tag;
    if (typeof record.name === "string") return record.name;
  }
  return fallback;
}

function toCleanupOutcome(outcome: WorktreeCleanupOutcome): WorktreeCleanupOutcome {
  return {
    ok: outcome.ok,
    removed: outcome.removed,
    dirty: outcome.dirty,
    kept: outcome.kept,
    message: outcome.message,
    ...(outcome.worktreePath ? { worktreePath: outcome.worktreePath } : {}),
    ...(outcome.dirtyFileCount !== undefined ? { dirtyFileCount: outcome.dirtyFileCount } : {}),
  };
}

function hasAskRule(rules: Array<{ action: string }>): boolean {
  return rules.some((rule) => rule.action === "ask");
}

function sameProvider(a: ModelRef | null | undefined, b: ModelRef | null | undefined): boolean {
  return !!a && !!b && a.providerID === b.providerID;
}

function watchdogEventBody(
  run: Pick<WatchdogRunIdentity, "runStartedAt" | "sessionId" | "attempt">,
  body: Record<string, unknown> = {},
): Record<string, unknown> {
  const model = body.model as ModelRef | null | undefined;
  return {
    runStartedAt: run.runStartedAt,
    sessionId: run.sessionId,
    attempt: run.attempt,
    ...(model ? { provider: model.providerID } : {}),
    ...body,
  };
}

function watchdogModelForTask(task: Task): ModelRef | null {
  return task.activeModel ?? task.model ?? null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function stringProp(record: Record<string, unknown> | null, ...keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function numberProp(record: Record<string, unknown> | null, ...keys: string[]): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number") return value;
  }
  return undefined;
}

function byteLength(value: unknown): number | undefined {
  return typeof value === "string" ? Buffer.byteLength(value) : undefined;
}

function durationFromTime(value: unknown): number | undefined {
  const time = readRecord(value);
  const start = numberProp(time, "start");
  const end = numberProp(time, "end");
  if (start === undefined || end === undefined) return undefined;
  return Math.max(0, end - start);
}

function isNotFoundError(error: unknown): boolean {
  const record = readRecord(error);
  const data = readRecord(record?.data);
  const code = stringProp(record, "code") ?? stringProp(data, "code");
  const status = numberProp(record, "status", "statusCode") ?? numberProp(data, "status", "statusCode");
  const message = stringProp(record, "message") ?? stringProp(data, "message") ?? "";
  return status === 404 || code === "not_found" || code === "session_not_found" || /not found/i.test(message);
}

function extractCreatedSessionIds(event: OpencodeEvent): { id?: string; parentId?: string } {
  if ((event as { type?: unknown }).type !== "session.created") return {};
  const props = readRecord((event as { properties?: unknown }).properties);
  const info = readRecord(props?.info);
  return {
    id: stringProp(info, "id") ?? stringProp(props, "sessionID", "id"),
    parentId: stringProp(info, "parentID", "parentSessionID") ?? stringProp(props, "parentID", "parentSessionID"),
  };
}

function extractChildSessionId(value: unknown): string | undefined {
  const record = readRecord(value);
  const info = readRecord(record?.info);
  return stringProp(info, "id") ?? stringProp(record, "id", "sessionID");
}

function normalizeSessionStatus(value: unknown): "idle" | "busy" | "retry" | undefined {
  if (value === "idle" || value === "busy" || value === "retry") return value;
  const record = readRecord(value);
  const type = stringProp(record, "type", "status");
  return type === "idle" || type === "busy" || type === "retry" ? type : undefined;
}

function normalizeActivityFromEvent(event: OpencodeEvent): Omit<SessionActivityEventInput, "sessionId" | "rootSessionId" | "harness"> | null {
  const type = (event as { type?: unknown }).type;
  const props = readRecord((event as { properties?: unknown }).properties);
  if (type === "message.part.updated") {
    const part = readRecord(props?.part);
    const partType = stringProp(part, "type");
    if (partType === "tool") {
      const state = readRecord(part?.state);
      const toolName = stringProp(part, "tool") ?? "tool";
      if (isOpenBoardReportTool(toolName)) return null;
      const rawStatus = stringProp(state, "status");
      const status = rawStatus === "pending"
        ? "started"
        : rawStatus === "completed"
          ? "complete"
          : rawStatus === "error"
            ? "error"
            : "running";
      return {
        kind: "tool",
        tool: {
          name: toolName,
          callId: stringProp(part, "callID", "callId", "id"),
          status,
          durationMs: durationFromTime(state?.time),
          outputBytes: numberProp(state, "outputBytes", "bytes") ?? byteLength(state?.output),
        },
      };
    }
    if (partType === "retry") return { kind: "status", text: "retrying" };
    if (partType === "text") {
      if (typeof props?.delta === "string") return null;
      const text = stringProp(part, "text");
      return text ? { kind: "text", role: "assistant", text } : null;
    }
    return null;
  }
  switch (type) {
    case "session.next.step.failed":
    case "session.error":
      return { kind: "status", text: "error" };
    case "session.status": {
      const status = readRecord(props?.status);
      return { kind: "status", text: stringProp(status, "type") ?? "status" };
    }
    default:
      return null;
  }
}

function isOpenBoardReportTool(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized.includes("openboard") && (normalized.endsWith("complete_task") || normalized.endsWith("block_task"));
}

interface OpenCodeRunRecord {
  taskId: string;
  runStartedAt: number;
  rootSessionId: string;
  sessionIds: Set<string>;
  watchdog: RunWatchdog;
  /**
   * Outcome of the watchdog termination flow: true/false = abort
   * confirmed/unconfirmed, "busy-rearm" = the pre-abort status probe found
   * the session tree still busy and re-armed the watchdog instead — the
   * paired retry decision must treat that as a no-op, not a failed abort.
   */
  abortPromise?: Promise<boolean | "busy-rearm">;
  /**
   * Consecutive watchdog trips absorbed because the status probe reported
   * the session tree still busy. Bounded (MAX_WATCHDOG_BUSY_REARMS) so a
   * session wedged in status "busy"/"running" — the original dead-session
   * incident class — still trips eventually; reset whenever real activity
   * arrives.
   */
  busyRearms?: number;
  transportLive: boolean;
  lastLiveState: "running" | "idle" | "error" | null;
  attempt: number;
  /**
   * Set when the most recent watchdog termination was suppressed for a pending
   * in-grace permission ask. The paired onRetryDecision fires synchronously
   * after onTerminate inside RunWatchdog.terminate(), so without this marker
   * the retry decision would proceed to abort the live root and start a fresh
   * writer, defeating the suppression. Checked-and-cleared in
   * applyWatchdogRetryDecision so only the immediately paired decision is
   * ignored; a later (genuinely stale) termination's retry decision still
   * runs.
   */
  watchdogRetrySuppressed?: boolean;
  /**
   * Consecutive reconnect cycles with no visibility into this run's root
   * session. Reset to 0 the moment either the session tree or status() gives
   * any signal about the root; see BLIND_RECONNECT_BOUND.
   */
  blindReconnectAttempts?: number;
}

interface CompletionWatcher {
  cancelled: boolean;
  taskId: string;
  runStartedAt?: number;
}

function watcherOwnsTask(watcher: CompletionWatcher, task: Task | undefined): task is Task {
  return !watcher.cancelled && task !== undefined && task.runStartedAt === watcher.runStartedAt;
}

export class TaskDispatcher implements Dispatcher {
  private readonly client: OpencodeHandle["client"];
  private readonly store: TaskStore;
  private readonly worktrees: WorktreeManager;
  private readonly worktreeBaseDir: (repoRoot: string) => string;
  private readonly adapterBaseUrl: string;
  private readonly boardToken?: string;
  private readonly acpRunners: Record<AcpTaskHarness, ClaudeCodeRunnerLike>;
  private readonly workspace: string;
  private readonly allowExternalDirectories: boolean;
  private readonly resolveDirectory: (raw: string) => string;
  private readonly stallThresholdMs: number;
  private readonly activity: SessionActivityCollector;
  private readonly watchdogConfig: WatchdogConfig;
  private readonly watchdogClock?: WatchdogClock;
  private readonly blockedResumeProbeTimeoutMs: number;
  /** Not readonly — see setOnParentSatisfied() for why this is settable post-construction. */
  private onParentSatisfied?: (parentId: string) => Promise<void>;

  private running = false;
  /** Bumped on every stop()/restart so a stale consume loop knows to exit. */
  private generation = 0;
  /** Aborts the in-flight upstream event.subscribe() fetch/stream, if any — see shutdown(). */
  private upstreamAbort: AbortController | null = null;
  private readonly completionWatchers = new Map<string, CompletionWatcher>();
  private readonly outputCandidates = new Map<string, string>();
  private readonly openCodeRunsByTask = new Map<string, OpenCodeRunRecord>();
  private readonly openCodeSessionToTask = new Map<string, string>();
  private readonly permissionResponderPool: PermissionResponderPool;
  /** One board-wide broker shared by OpenCode and every ACP harness. */
  private readonly permissionBroker: PermissionBroker;
  private readonly permissionGraceMsFallback: number;
  private readonly permissionAskMeta = new Map<string, Pick<PendingPermissionAsk, "raisedAt" | "deadline" | "patterns">>();
  /** Bounded ownership tombstones distinguish stale asks from unknown IDs. */
  private readonly permissionAskOwners = new Map<string, string>();
  /**
   * Synchronous pre-session claims. JavaScript cannot interleave another
   * run() call between has() and add(), so one dispatcher invocation owns the
   * async provisioning window until real session ownership is persisted.
   */
  private readonly dispatchClaims = new Set<string>();
  /** FIFO lifecycle tails prevent provider operations for one card from overtaking each other. */
  private readonly lifecycleTails = new Map<string, Promise<void>>();

  constructor(deps: TaskDispatcherDeps) {
    this.client = deps.client;
    this.store = deps.store;
    // One shared poller for every worktree-isolated session, not one per
    // session — see permission-responder.ts. onError surfaces a persistent
    // list/reply failure as a task_warning event instead of retrying forever
    // in silence.
    this.permissionGraceMsFallback = deps.permissionGraceMs ?? loadPermissionConfig().graceMs;
    const permissionGraceMs = () => this.getPermissionGraceMs();
    this.permissionBroker = createPermissionBroker({ onEvent: (event) => this.handlePermissionEvent(event) });
    this.permissionResponderPool = createPermissionResponderPool({
      client: this.client,
      broker: this.permissionBroker,
      interactiveTimeoutMs: permissionGraceMs,
      onError: (sessionId, context, err) => this.handlePermissionResponderError(sessionId, context, err),
    });
    this.worktrees = deps.worktrees ?? new GitWorktreeManager();
    this.adapterBaseUrl = deps.adapterBaseUrl ?? "http://127.0.0.1:0";
    this.boardToken = deps.boardToken;
    const envInstanceName = process.env.OPENBOARD_INSTANCE_NAME?.trim();
    const instanceName = deps.instanceName ?? (envInstanceName || undefined);
    const acpRunnerDeps = {
      adapterBaseUrl: this.adapterBaseUrl,
      boardToken: this.boardToken,
      instanceName,
      permissionGraceMs,
      permissionBroker: this.permissionBroker,
      onActivity: (taskId: string, runStartedAt: number, input: SessionActivityEventInput) => this.activity.recordEvent(taskId, runStartedAt, input),
      onRunTerminal: (taskId: string, runStartedAt: number, status: "complete" | "error" | "aborted") => this.activity.endRun(taskId, runStartedAt, status),
    };
    this.acpRunners = {
      "claude-code": deps.claudeRunner ?? new ClaudeAcpRunner(acpRunnerDeps),
      codex: deps.codexRunner ?? new CodexAcpRunner(acpRunnerDeps),
      "gemini-acp": deps.geminiRunner ?? new GeminiAcpRunner(acpRunnerDeps),
      hermes: deps.hermesRunner ?? new HermesAcpRunner(acpRunnerDeps),
      "pi-coding-agent": deps.piRunner ?? new PiAcpRunner(acpRunnerDeps),
      "cursor-acp": deps.cursorRunner ?? new CursorAcpRunner(acpRunnerDeps),
    };
    this.workspace = deps.workspace ?? resolveBoardWorkspace();
    this.allowExternalDirectories = deps.allowExternalDirectories ?? isExternalDirectoriesAllowed();
    this.worktreeBaseDir =
      deps.worktreeBaseDir ??
      ((repoRoot) => {
        const sibling = join(dirname(repoRoot), ".opencode-board-worktrees", basename(repoRoot));
        // Keep isolated worktrees inside the configured workspace unless the
        // user explicitly opted in to external directories.
        if (
          this.allowExternalDirectories ||
          isUnderWorkspace(resolve(sibling), this.workspace)
        ) {
          return sibling;
        }
        return join(this.workspace, ".opencode-board-worktrees", basename(repoRoot));
      });
    this.resolveDirectory =
      deps.resolveDirectory ??
      ((raw) =>
        resolveTaskDirectory(raw, this.workspace, {
          allowExternal: this.allowExternalDirectories,
        }));
    this.stallThresholdMs = deps.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
    this.activity = deps.activity ?? new SessionActivityCollector();
    this.watchdogConfig = deps.watchdogConfig ?? loadWatchdogConfig();
    this.watchdogClock = deps.watchdogClock;
    this.blockedResumeProbeTimeoutMs = deps.blockedResumeProbeTimeoutMs ?? BLOCKED_RESUME_PROBE_TIMEOUT_MS;
    this.onParentSatisfied = deps.onParentSatisfied;
    this.reconcileInterruptedPermissionAsks();
  }

  getPermissionGraceMs(): number {
    return this.store.getPermissionGraceMs() ?? this.permissionGraceMsFallback;
  }

  setPermissionGraceMs(value: number): void {
    this.store.setPermissionGraceMs(value);
  }

  /**
   * Late-bind the chain-advancer hook. The advancer needs `dispatcher.run`
   * to dispatch children, and the dispatcher needs the advancer to notify on
   * integrate-to-done — constructing both up front would be circular, so the
   * integrator (serve.ts) builds the dispatcher first, then the advancer,
   * then wires this setter.
   */
  setOnParentSatisfied(fn: (parentId: string) => Promise<void>): void {
    this.onParentSatisfied = fn;
  }

  private async withTaskLifecycleLock<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleTails.get(taskId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.lifecycleTails.set(taskId, tail);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.lifecycleTails.get(taskId) === tail) this.lifecycleTails.delete(taskId);
    }
  }

  async run(taskId: string): Promise<Task> {
    if (!this.store.get(taskId)) throw AdapterError.notFound(`Task not found: ${taskId}`);
    if (this.dispatchClaims.has(taskId)) {
      throw new RunDispatchClaimError(taskId);
    }
    this.dispatchClaims.add(taskId);

    try {
      return await this.withTaskLifecycleLock(taskId, async () => {
        const task = this.store.get(taskId);
        if (!task) throw AdapterError.notFound(`Task not found: ${taskId}`);
        this.assertNotArchived(task, "run");
        this.assertNotAlreadyRunning(task);
        this.assertParentsSatisfied(task);
        return this.runWithClaim(task);
      });
    } finally {
      this.dispatchClaims.delete(taskId);
    }
  }

  private async runWithClaim(task: Task): Promise<Task> {
    const taskId = task.id;
    this.store.update(taskId, { completion: null, completionSource: null, finalSessionOutput: null });

    // Resolve and contain the execution directory before doing any git or
    // session work. This canonicalizes symlinks and rejects escapes from the
    // configured board workspace unless the user has explicitly opted in.
    let execDirectory = this.resolveDirectory(task.directory);
    // Captured before the worktree swap below — the Phase 3 preamble needs the
    // original (base repo) directory, not the worktree path execDirectory becomes.
    const baseRepoDirectory = execDirectory;

    // Resolve where the session actually runs. In worktree isolation the session
    // runs in a dedicated `git worktree`; a non-repo directory can't be isolated,
    // so we block the run and surface the "make it a git repo?" decision instead.
    const isolatedRun = wantsWorktree(task);
    if (isolatedRun) {
      if (!(await this.worktrees.isGitRepo(execDirectory))) {
        const blocked = this.store.update(taskId, {
          pending: "git-init",
          runState: "unstarted",
          error: undefined,
        });
        if (!blocked) throw AdapterError.notFound(`Task not found: ${taskId}`);
        return blocked;
      }
      const wt = await this.ensureWorktree(task, execDirectory);
      execDirectory = this.resolveDirectory(wt.worktreePath);
    }

    await this.captureDispatchBaseline(task, isolatedRun, execDirectory);

    if (isAcpHarness(task.harness)) {
      return this.runAcpTask(task, execDirectory, task.description, "run");
    }

    // The legacy session/message surface is the one that actually wakes the
    // agent in OpenCode 1.17.13. It also honors an agent's configured default
    // model when task.model is unset; the v2 prompt route can admit input
    // without producing a message turn.
    const permissionRules = resolveOpenCodePermissionRules(isolatedRun, task.permissionOverrides);
    const activeModel = task.model ?? null;
    const createInput = {
      agent: task.agent ?? undefined,
      model: activeModel ?? undefined,
      directory: execDirectory,
      permission: permissionRules,
    };
    const created = await this.client.session.create(createInput);
    if ((created as { error?: unknown }).error) {
      throw AdapterError.unreachable(
        "Failed to create OpenCode session",
        (created as { error?: unknown }).error,
      );
    }
    const sessionId = extractSessionId((created as { data?: unknown }).data);
    if (!sessionId) {
      throw AdapterError.unreachable("OpenCode session create returned no id");
    }

    const runStartedAt = nextRunStartedAt(task);
    this.bindOpenCodeRun({ task, sessionId, runStartedAt, attempt: 0 });
    this.store.update(taskId, { sessionId, activeModel, autoRetries: 0, runStartedAt });
    if (hasAskRule(permissionRules)) {
      this.startPermissionResponder(sessionId, execDirectory, isolatedRun ? "worktree-fence" : "in-place-override", task.id, runStartedAt);
    }
    const taskPrompt = isolatedRun
      ? this.withWorktreeIsolationPreamble(execDirectory, baseRepoDirectory, task.description)
      : task.description;
    const contextPrompt = this.withTaskContext(task, taskPrompt);
    const parentPrompt = this.withParentHandoffs(task, contextPrompt);
    const promptError = await this.prompt(
      sessionId,
      this.withCompletionContract(task, parentPrompt, runStartedAt),
      task.agent ?? undefined,
      task.model ?? undefined,
    );
    if (promptError) {
      this.stopPermissionResponder(sessionId);
      this.endOpenCodeRun(task.id, runStartedAt, "error");
      const updated = this.store.update(taskId, {
        sessionId,
        activeModel,
        autoRetries: 0,
        runState: "error",
        error: promptError,
      });
      if (!updated) {
        throw AdapterError.notFound(`Task not found: ${taskId}`);
      }
      return updated;
    }

    this.store.update(taskId, {
      sessionId,
      activeModel,
      autoRetries: 0,
      runState: "running",
      runStartedAt,
      error: undefined,
      pending: undefined,
    });
    this.store.move(taskId, "in_progress", END_OF_COLUMN);
    this.startCompletionWatcher(taskId, sessionId);

    const fresh = this.store.get(taskId);
    if (!fresh) {
      throw AdapterError.notFound(`Task not found: ${taskId}`);
    }
    return fresh;
  }

  private async runAcpTask(
    task: Task,
    execDirectory: string,
    prompt: string,
    action: "run" | "retry",
    preserveBlocked = false,
    runStartedAt = nextRunStartedAt(task),
  ): Promise<Task> {
    const warning = await dirtyWarning(execDirectory);
    const gitInfo = await inspectGitDirectory(execDirectory);
    const harness = asAcpHarness(task.harness);
    const runner = this.acpRunners[harness];
    const label = harnessDisplayName(harness);
    try {
      const contextPrompt = this.withTaskContext(task, prompt);
      const parentPrompt = this.withParentHandoffs(task, contextPrompt);
      let ownershipRegistered = false;
      const registerOwnership = (launched: Awaited<ReturnType<ClaudeCodeRunnerLike["run"]>>): void => {
        if (ownershipRegistered) return;
        ownershipRegistered = true;
        this.store.update(task.id, {
          sessionId: undefined,
          ...(action === "retry" ? { completion: null, completionSource: null, finalSessionOutput: null } : {}),
          harnessSessionId: launched.sessionId,
          harnessSessionName: launched.sessionName,
          harnessStatus: launched.status,
          harnessCwd: execDirectory,
          harnessBranch: gitInfo.branch,
          harnessCommit: gitInfo.commit,
          harnessWarning: warning,
          runState: "running",
          runStartedAt,
          error: undefined,
          pending: undefined,
          completionLocation: undefined,
        });
        this.activity.startRun({
          taskId: task.id,
          runStartedAt,
          sessionId: launched.sessionId,
          rootSessionId: launched.sessionId,
          harness,
        });
        if (warning) {
          this.store.addEvent({ taskId: task.id, type: "task_warning", body: { warning } });
        }
        this.store.move(task.id, "in_progress", END_OF_COLUMN);
        this.startAcpWatcher(task.id, launched.sessionName, harness);
      };
      const launchInput = {
        task,
        directory: execDirectory,
        prompt: this.withAcpPreflightContext(parentPrompt, warning, label),
        runStartedAt,
      };
      const preparedLaunch = action === "run" ? runner.runPrepared : runner.retryPrepared;
      const launched = preparedLaunch
        ? await preparedLaunch.call(runner, launchInput, registerOwnership)
        : await runner[action](launchInput);
      // Compatibility path for injected/legacy runners without the two-stage hook.
      registerOwnership(launched);
    } catch (err) {
      const updated = this.store.update(task.id, {
        runState: "error",
        error: errorMessage(err, `Failed to launch ${label} background session`),
      });
      if (!updated) throw AdapterError.notFound(`Task not found: ${task.id}`);
      if (preserveBlocked) throw AdapterError.unreachable(updated.error ?? `Failed to launch ${label} background session`);
      return updated;
    }

    const fresh = this.store.get(task.id);
    if (!fresh) throw AdapterError.notFound(`Task not found: ${task.id}`);
    return fresh;
  }

  private async captureDispatchBaseline(
    task: Task,
    isolatedRun: boolean,
    execDirectory: string,
  ): Promise<void> {
    // Record git baseline at dispatch time for diff computation later. The
    // worktree lane's baseCommit is the main-repo HEAD (not the worktree
    // checkout), captured via task.directory before the worktree path swap.
    const baseCommitDir = isolatedRun
      ? await this.resolveRepoRoot(this.resolveDirectory(task.directory))
      : execDirectory;
    const [baseCommit, dirty, baseCheckoutSnapshot] = await Promise.all([
      resolveHeadCommit(baseCommitDir),
      isWorkingTreeDirty(baseCommitDir),
      isolatedRun ? snapshotBaseCheckout(baseCommitDir) : Promise.resolve(null),
    ]);
    this.store.update(task.id, {
      baseCommit,
      dirtyAtDispatch: dirty,
      isolationAtDispatch: isolatedRun ? "worktree" : "in-place",
      baseCheckoutSnapshot,
    });
  }

  /**
   * Resolve `dir` to its actual git repo root before any escape-detection
   * call. `git status`/`git worktree list` both report root-relative paths
   * and the repo root itself regardless of which subdirectory they're
   * invoked from — if a task's directory is a repo *subdirectory* rather
   * than its root, escape-detector.ts's main-checkout exclusion compares
   * against the wrong baseline, the real root leaks into its "registered
   * worktree" list, and every changed path ends up "inside" it: a silent,
   * unconditional `escaped: false` no matter what actually changed. Falls
   * back to `dir` itself if repoRoot() fails — escape detection must never
   * throw and hang a run because of this.
   */
  private async resolveRepoRoot(dir: string): Promise<string> {
    try {
      return await this.worktrees.repoRoot(dir);
    } catch {
      return dir;
    }
  }

  /**
   * Get (or lazily create) the git worktree for an isolated task. Reuses an
   * already-created worktree so a re-run doesn't collide on the branch; otherwise
   * cuts `board/<taskId>` from the task directory's current branch and records the
   * worktree metadata on the task.
   */
  private async ensureWorktree(
    task: Task,
    repoDir: string,
  ): Promise<{ worktreePath: string; branch: string; baseBranch: string }> {
    if (task.worktreePath && task.worktreeBranch) {
      return {
        worktreePath: task.worktreePath,
        branch: task.worktreeBranch,
        baseBranch: task.baseBranch ?? (await this.worktrees.currentBranch(repoDir)),
      };
    }
    const repoRoot = await this.worktrees.repoRoot(repoDir);
    const branch = `board/${task.id}`;
    const worktreePath = join(this.worktreeBaseDir(repoRoot), task.id);
    const info = await this.worktrees.createWorktree(repoDir, branch, worktreePath);
    this.store.rememberWorktreeRepoRoot(repoRoot);
    this.store.update(task.id, {
      worktreePath: info.worktreePath,
      worktreeBranch: info.branch,
      baseBranch: info.baseBranch,
    });
    return info;
  }

  async initGitAndRun(taskId: string): Promise<Task> {
    const task = this.store.get(taskId);
    if (!task) throw AdapterError.notFound(`Task not found: ${taskId}`);
    this.assertInitGitEligible(task);
    const repoDir = this.resolveDirectory(task.directory);
    try {
      await this.worktrees.initRepo(repoDir);
    } catch (err) {
      const updated = this.store.update(taskId, {
        runState: "error",
        pending: undefined,
        error: errorMessage(err, "Failed to initialize git repository"),
      });
      if (!updated) throw AdapterError.notFound(`Task not found: ${taskId}`);
      return updated;
    }
    this.store.update(taskId, { pending: undefined });
    return this.run(taskId);
  }

  async syncUpstream(taskId: string): Promise<MergeOutcome> {
    const task = this.store.get(taskId);
    if (!task) throw AdapterError.notFound(`Task not found: ${taskId}`);
    if (!task.worktreePath || !task.baseBranch) {
      throw AdapterError.validation("Task has no worktree to sync");
    }
    const result = await this.worktrees.syncUpstream(task.worktreePath, task.baseBranch);
    return { task: this.store.get(taskId) ?? task, ...result };
  }

  async getWorktreeCommitStatus(taskId: string, targetBranch?: string): Promise<WorktreeCommitStatus> {
    const task = this.store.get(taskId);
    if (!task) throw AdapterError.notFound(`Task not found: ${taskId}`);
    if (!task.worktreePath) {
      throw AdapterError.validation("Task has no worktree");
    }
    const baseRef = task.baseCommit ?? targetBranch ?? task.baseBranch;
    if (!baseRef) throw AdapterError.validation("No base reference for commit status");
    return this.worktrees.commitStatus(task.worktreePath, baseRef);
  }

  async commitFile(taskId: string, file: string, message?: string): Promise<FileCommitOutcome> {
    const task = this.store.get(taskId);
    if (!task) throw AdapterError.notFound(`Task not found: ${taskId}`);
    if (!task.worktreePath) {
      throw AdapterError.validation("Task has no worktree");
    }
    if (task.runState === "running") {
      throw AdapterError.validation("Cannot commit task files while its session is still running");
    }
    const result = await this.worktrees.commitFile(task.worktreePath, file, message);
    return { task: this.store.get(taskId) ?? task, ...result };
  }

  async integrate(taskId: string, targetBranch?: string, options: { commitRemaining?: boolean; blockedAcceptance?: BlockedAcceptance } = {}): Promise<MergeOutcome> {
    const task = this.store.get(taskId);
    if (!task) throw AdapterError.notFound(`Task not found: ${taskId}`);
    const donePolicy = evaluateDonePolicy({ task, completedBy: INTEGRATED_COMPLETED_BY, blockedAcceptance: options.blockedAcceptance });
    if (!donePolicy.ok) {
      throw new AdapterError("validation", donePolicy.error.message);
    }
    if (!task.worktreePath || !task.worktreeBranch) {
      throw AdapterError.validation("Task has no worktree to integrate");
    }
    // A still-running session may still be writing to the worktree/base
    // checkout via a bash escape (external_directory fencing never blocks
    // bash writes — see escape-detector.ts). The escape snapshot compare
    // below is a single check-then-act read; refusing to even start it while
    // the session is live closes most of that TOCTOU window instead of
    // racing a concurrent writer that this design already assumes exists.
    if (task.runState === "running") {
      throw AdapterError.validation("Cannot integrate a task while its session is still running");
    }
    const target = targetBranch ?? task.baseBranch;
    if (!target) throw AdapterError.validation("No target branch to integrate into");

    // Re-resolve the task directory to stay inside the workspace boundary even
    // after the worktree has been removed.
    const repoDir = this.resolveDirectory(task.directory);
    // The escape check specifically needs the repo root, not just any
    // directory inside it — see resolveRepoRoot(). git checkout/merge below
    // work fine from a subdirectory, so repoDir itself is left unchanged.
    const escapeCheckRoot = await this.resolveRepoRoot(repoDir);

    const escapeCheck = await detectBaseCheckoutEscape(escapeCheckRoot, task.baseCheckoutSnapshot ?? null);
    if (escapeCheck.escaped) {
      this.store.update(taskId, {
        pending: "base-checkout-escape",
        escapeDetectedPaths: escapeCheck.changedPaths,
      });
      return {
        task: this.store.get(taskId) ?? task,
        ok: false,
        conflict: false,
        message: `Refusing to integrate: base checkout changed outside the worktree (${escapeCheck.changedPaths.join(", ")})`,
      };
    }

    const result = await this.worktrees.integrate(
      repoDir,
      task.worktreeBranch,
      target,
      task.worktreePath,
      { commitRemaining: options.commitRemaining, baseRef: task.baseCommit ?? target },
    );
    if (result.conflict) {
      const paths = result.conflictPaths ?? [];
      this.store.update(taskId, {
        pending: "rebase-conflict",
        rebaseConflictPaths: paths,
        runState: "idle",
      });
      return {
        task: this.store.get(taskId) ?? task,
        ...result,
        rebaseConflictPaths: paths,
      };
    }
    // On success the worktree is gone (branch kept), so the review is accepted.
    if (result.ok) {
      this.store.move(taskId, "done", END_OF_COLUMN);
      this.store.update(taskId, {
        completedBy: INTEGRATED_COMPLETED_BY,
        worktreePath: undefined,
        pending: undefined,
        rebaseConflictPaths: undefined,
      });
      if (donePolicy.blockedAccepted) {
        this.store.addEvent({ taskId, type: "task_blocked_accepted", body: this.blockedAcceptanceEvidence(task, donePolicy.acceptedBy, "integrate") });
      }
      this.fireOnParentSatisfied(taskId);
    }
    return { task: this.store.get(taskId) ?? task, ...result };
  }

  async removeTask(
    taskId: string,
    options: { force?: boolean; keepWorktree?: boolean } = {},
  ): Promise<{ ok: boolean; worktree?: WorktreeCleanupOutcome; message?: string }> {
    const task = this.store.get(taskId);
    if (!task) return { ok: true };

    let cleanup: WorktreeCleanupOutcome | undefined;
    if (task.worktreePath) {
      const repoDir = this.resolveDirectory(task.directory);
      const repoRoot = await this.resolveRepoRoot(repoDir);
      if (options.keepWorktree) {
        const dirty = await this.worktrees.isWorktreeDirty(task.worktreePath);
        this.store.rememberWorktreeRepoRoot(repoRoot);
        cleanup = {
          ok: true,
          removed: false,
          dirty,
          kept: true,
          message: dirty ? "worktree kept on disk for manual salvage" : "clean worktree kept on disk",
          worktreePath: task.worktreePath,
        };
      } else {
        cleanup = toCleanupOutcome(
          await this.worktrees.cleanupWorktree(repoRoot, task.worktreePath, {
            force: options.force,
          }),
        );
        if (!cleanup.ok) return { ok: false, worktree: cleanup, message: cleanup.message };
      }
    }

    this.store.remove(taskId);
    return { ok: true, worktree: cleanup };
  }

  async discardWorktree(
    taskId: string,
    options: { force?: boolean } = {},
  ): Promise<WorktreeCleanupOutcome> {
    const task = this.store.get(taskId);
    if (!task) throw AdapterError.notFound(`Task not found: ${taskId}`);
    if (task.column !== "review") {
      throw AdapterError.validation("Discard worktree is only available for Review cards");
    }
    if (!task.worktreePath) {
      return {
        ok: true,
        removed: false,
        dirty: false,
        kept: false,
        message: "task has no worktree to discard",
      };
    }

    const repoDir = this.resolveDirectory(task.directory);
    const repoRoot = await this.resolveRepoRoot(repoDir);
    this.store.rememberWorktreeRepoRoot(repoRoot);
    const cleanup = toCleanupOutcome(await this.worktrees.cleanupWorktree(repoRoot, task.worktreePath, options));
    if (cleanup.ok && cleanup.removed) {
      this.store.update(taskId, { worktreePath: undefined });
    }
    return cleanup;
  }

  async sweepOrphanedWorktrees(): Promise<WorktreeCleanupOutcome[]> {
    const tasks = this.store.list();
    const liveTaskIds = new Set(tasks.map((task) => task.id));
    const liveWorktreePaths = new Set(
      tasks.map((task) => task.worktreePath).filter((path): path is string => Boolean(path)),
    );
    const repoRoots = new Set<string>(this.store.listKnownWorktreeRepoRoots());

    for (const task of tasks) {
      try {
        repoRoots.add(await this.resolveRepoRoot(this.resolveDirectory(task.directory)));
      } catch {
        // A stale task directory should not fail board startup.
      }
    }

    const outcomes: WorktreeCleanupOutcome[] = [];
    for (const repoRoot of repoRoots) {
      const worktrees = await this.worktrees.listManagedWorktrees(repoRoot, this.worktreeBaseDir(repoRoot));
      for (const worktreePath of worktrees) {
        const id = basename(worktreePath);
        if (liveTaskIds.has(id) || liveWorktreePaths.has(worktreePath)) continue;
        outcomes.push(toCleanupOutcome(await this.worktrees.cleanupWorktree(repoRoot, worktreePath, { force: false })));
      }
    }
    return outcomes;
  }

  async resolveOrphanWorktree(worktreePath: string): Promise<WorktreeCleanupOutcome> {
    if (!worktreePath || !worktreePath.startsWith("/")) {
      throw AdapterError.validation("worktreePath must be an absolute path");
    }

    const tasks = this.store.list();
    if (tasks.some((task) => task.worktreePath === worktreePath)) {
      throw AdapterError.validation("worktree is still referenced by a task");
    }

    const repoRoot = await this.findManagedWorktreeRepoRoot(worktreePath, tasks);
    if (!repoRoot) throw AdapterError.notFound(`Orphan worktree not found: ${worktreePath}`);

    const outcome = toCleanupOutcome(await this.worktrees.cleanupWorktree(repoRoot, worktreePath, { force: true }));
    if (outcome.removed) this.forgetDirtyOrphan(worktreePath);
    return outcome;
  }

  async getOrphanWorktreeDiff(worktreePath: string): Promise<DiffResponse> {
    if (!worktreePath || !worktreePath.startsWith("/")) {
      throw AdapterError.validation("worktreePath must be an absolute path");
    }

    const tasks = this.store.list();
    if (tasks.some((task) => task.worktreePath === worktreePath)) {
      throw AdapterError.validation("worktree is still referenced by a task");
    }

    const repoRoot = await this.findManagedWorktreeRepoRoot(worktreePath, tasks);
    if (!repoRoot) throw AdapterError.notFound(`Orphan worktree not found: ${worktreePath}`);

    return computeDiffAgainstWorkingTree(worktreePath, "HEAD");
  }

  private async findManagedWorktreeRepoRoot(worktreePath: string, tasks: Task[]): Promise<string | undefined> {
    const repoRoots = new Set<string>(this.store.listKnownWorktreeRepoRoots());
    for (const task of tasks) {
      try {
        repoRoots.add(await this.resolveRepoRoot(this.resolveDirectory(task.directory)));
      } catch {
        // Ignore stale task directories while resolving an orphan.
      }
    }
    for (const repoRoot of repoRoots) {
      const worktrees = await this.worktrees.listManagedWorktrees(repoRoot, this.worktreeBaseDir(repoRoot));
      if (worktrees.includes(worktreePath)) return repoRoot;
    }
    return undefined;
  }

  private forgetDirtyOrphan(worktreePath: string): void {
    const current = this.store.getSweepResult();
    if (!current) return;
    const dirtyOrphans = current.dirtyOrphans.filter((item) => item.worktreePath !== worktreePath);
    this.store.setSweepResult({
      ...current,
      keptDirtyCount: dirtyOrphans.length,
      dirtyOrphans,
    });
  }

  private async prompt(
    sessionId: string,
    text: string,
    agent?: string,
    model?: Task["model"],
  ): Promise<string | undefined> {
    try {
      const promptModel = toPromptModel(model);
      const prompted = await this.client.session.promptAsync({
        sessionID: sessionId,
        ...(agent ? { agent } : {}),
        ...(promptModel ? { model: promptModel } : {}),
        ...(model?.variant ? { variant: model.variant } : {}),
        parts: [{ type: "text", text }],
      });
      const error = (prompted as { error?: unknown }).error;
      return error ? errorMessage(error, "Failed to prompt OpenCode session") : undefined;
    } catch (err) {
      return errorMessage(err, "Failed to prompt OpenCode session");
    }
  }

  private taskHasParents(task: Task): boolean {
    return (task.parentIds ?? this.store.getParentIds(task.id)).length > 0;
  }

  private withCompletionContract(task: Task, prompt: string, runStartedAt: number): string {
    const taskId = task.id;
    return `${prompt}\n\n---\nOPENBOARD COMPLETION CONTRACT\nTask id: ${taskId}\n\n${completionHandoffGuidance(task.taskKind, { hasParents: this.taskHasParents(task) })}\n\nWhen all work and verification are complete, report exactly once as your final action (replace JSON values with your actual report).\n\nUse the OpenBoard MCP reporting tools:\n- complete_task with { taskId: "${taskId}", runStartedAt: ${runStartedAt}, report: { summary, changedFiles, verification, residualRisk } }\n- block_task with { taskId: "${taskId}", runStartedAt: ${runStartedAt}, report: { summary, changedFiles, verification, residualRisk } }\n\nWhen blocking on a question the operator must answer before you can continue, also include needsInput with the direct question.\n\nIf these MCP tools are unavailable, do not call board HTTP endpoints or inspect credentials. Finish with a normal final response; OpenBoard will treat an idle-only result as unconfirmed.\n\nCall complete_task or block_task exactly once, and only as the final action. Do not continue working after reporting.`;
  }

  private withTaskContext(task: Task, prompt: string): string {
    const context = taskExecutionContext(task.taskKind, { hasParents: this.taskHasParents(task) });
    if (!context) return prompt;
    return `${prompt}\n\n---\n${context}`;
  }

  private withParentHandoffs(task: Task, prompt: string): string {
    const block = directParentPromptBlock(resolveTaskLineage(task.id, this.store), {
      maxChars: LINEAGE_PROMPT_MAX_CHARS,
    });
    if (!block) return prompt;
    return `${prompt}\n\n---\n${block}`;
  }

  /**
   * Boundary preamble for worktree-isolated task prompts — states the agent's actual
   * cwd, keeps normal work on cwd-relative paths, and gives a recovery hint for
   * outside-cwd denials.
   * This is guidance/recovery only: `WRITE_FENCED_PERMISSION` + the permission-responder
   * pool are what actually block an absolute-path escape (worktree-isolation-plan.md
   * Phase 1). Telling the agent its boundaries upfront just makes it less likely to try
   * an absolute path in the first place, and gives it something to recover with if a
   * write is denied — it does not, on its own, un-stick an already-stalled session
   * (that's the dispatcher-side auto-nudge in trackStallAndMaybeNudge()). It also steers
   * the agent to prefer worktree-local context and avoid sibling/base checkout paths
   * unless the task explicitly requests read-only inspection.
   */
  private withWorktreeIsolationPreamble(worktreePath: string, _baseRepoPath: string, prompt: string): string {
    return `OPENBOARD WORKTREE ISOLATION\nYour working directory (cwd): ${worktreePath}\nRun edits, tests, builds, and shell commands from cwd using relative paths.\nDo not use bash, git -C, wc, shell grep, tests, or mutating commands against the original checkout or sibling task worktrees.\nIf the task explicitly asks for read-only outside-cwd inspection, use read/grep/glob/list tools instead of bash.\nRead context from cwd first: CLAUDE.md, AGENTS.md, README.md, src/..., test/...\nIf an outside-cwd write is denied, switch back to cwd-relative paths or report blocked. If a cwd-local test/build command is denied, report the exact command and denied path instead of retrying with parent/sibling paths. Do not try chmod, symlinks, npm install, or temp-dir workarounds unless the task explicitly asks for that bootstrap.\n---\n\n${prompt}`;
  }

  private withRebaseConflictContext(task: Task, prompt: string): string {
    if (task.pending !== "rebase-conflict") return prompt;
    const paths = task.rebaseConflictPaths?.length
      ? task.rebaseConflictPaths.map((path) => `- ${path}`).join("\n")
      : "- unknown paths; inspect `git status`";
    return `OPENBOARD REBASE CONFLICT RESOLUTION\nThis is the same session and worktree from the failed Integrate attempt. The worktree is already in the middle of a git rebase, with conflict markers on disk. Do not create a fresh commit. Resolve the conflicts below, stage the resolutions, then run git rebase --continue. Report via /complete when the rebase continues cleanly, or /block if it cannot be resolved.\nConflicted paths:\n${paths}\n---\n\n${prompt}`;
  }

  private withAcpPreflightContext(prompt: string, warning: string | undefined, label: string): string {
    if (!warning) return prompt;
    return `${prompt}\n\n---\nOPENBOARD PREFLIGHT WARNING\n${warning}\nIf you avoid the dirty target by using a ${label}-managed worktree or branch, report the actual cwd, branch, and commit in your final OpenBoard report.`;
  }

  private assertBlockedAnswerCurrent(task: Task, answer: BlockedAnswerContext): void {
    if (!task.completion || task.completion.outcome !== "blocked") {
      throw AdapterError.validation("Blocked answer is only valid for the current blocked report");
    }
    if (task.completion.reportedAt !== answer.blockedReportedAt) {
      throw AdapterError.validation("Blocked answer does not match the current blocked report");
    }
  }

  private async withBlockedResumeProbeTimeout<T>(probe: Promise<T>): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        probe,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), this.blockedResumeProbeTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async decideOpenCodeBlockedAnswerResume(task: Task): Promise<{
    decision: BlockedAnswerResumeDecision;
    fenceSessionBeforeFresh: boolean;
  }> {
    if (task.completionSource !== "reported" || !task.sessionId) {
      return {
        decision: { mode: "fresh-session", evidence: "not-resumable" },
        fenceSessionBeforeFresh: Boolean(task.sessionId),
      };
    }
    const statuses = await this.withBlockedResumeProbeTimeout(this.fetchSessionStatusMap());
    const status = statuses?.get(task.sessionId);
    if (status === "idle" || status === "busy" || status === "retry") {
      return { decision: { mode: "same-session", evidence: "status" }, fenceSessionBeforeFresh: false };
    }
    if (statuses && statuses.has(task.sessionId)) {
      return { decision: { mode: "fresh-session", evidence: "not-resumable" }, fenceSessionBeforeFresh: true };
    }

    try {
      const result = await this.withBlockedResumeProbeTimeout(this.client.session.messages({ sessionID: task.sessionId }));
      if (result && !(result as { error?: unknown }).error && Array.isArray((result as { data?: unknown }).data)) {
        return { decision: { mode: "same-session", evidence: "messages" }, fenceSessionBeforeFresh: false };
      }
      if (result && (result as { error?: unknown }).error && isNotFoundError((result as { error?: unknown }).error)) {
        return { decision: { mode: "fresh-session", evidence: "not-resumable" }, fenceSessionBeforeFresh: false };
      }
    } catch {
      // Message evidence is best-effort; fall through to session-tree evidence.
    }

    try {
      if ("children" in this.client.session) {
        const result = await this.withBlockedResumeProbeTimeout((this.client.session as unknown as { children(input: { sessionID: string }): Promise<unknown> }).children({ sessionID: task.sessionId }));
        const error = (result as { error?: unknown } | undefined)?.error;
        if (result && !error) return { decision: { mode: "same-session", evidence: "session-tree" }, fenceSessionBeforeFresh: false };
        if (error && isNotFoundError(error)) return { decision: { mode: "fresh-session", evidence: "not-resumable" }, fenceSessionBeforeFresh: false };
      }
    } catch {
      // Session-tree evidence is best-effort.
    }

    return { decision: { mode: "fresh-session", evidence: "not-resumable" }, fenceSessionBeforeFresh: true };
  }

  private async fenceBlockedAnswerSessionBeforeFresh(task: Task): Promise<void> {
    if (!task.sessionId) return;
    try {
      const result = await this.withBlockedResumeProbeTimeout(this.client.session.abort({ sessionID: task.sessionId }));
      if (!result) throw new Error("OpenCode session abort timed out");
      const error = (result as { error?: unknown }).error;
      if (error && !isNotFoundError(error)) throw error;
    } catch (err) {
      if (!isNotFoundError(err)) {
        throw AdapterError.unreachable(
          "Could not confirm the prior OpenCode session was stopped; the blocked report was preserved",
          err,
        );
      }
    }
    this.cancelCompletionWatcher(task.sessionId);
    this.stopPermissionResponder(task.sessionId);
    this.endOpenCodeRun(task.id, task.runStartedAt, "aborted");
    this.outputCandidates.delete(task.sessionId);
  }

  private withBlockedAnswerPrompt(task: Task, answer: BlockedAnswerContext, feedback: string | undefined, liveSession: boolean): string {
    const question = blockedQuestion(task.completion ?? { summary: "", residualRisk: "" });
    const header = liveSession ? "OPERATOR ANSWER TO BLOCKED QUESTION" : "OPENBOARD BLOCKED RETRY CONTEXT";
    return `${header}\nBlocked reportedAt: ${answer.blockedReportedAt}\nQuestion: ${question}\nAnswered by: ${answer.answeredBy}\nAnswer: ${feedback ?? ""}\n\nContinue from the preserved baseline/partial files in this task cwd. Do not discard existing work. Report via the OpenBoard completion contract when done or blocked again.`;
  }

  private blockedAcceptanceEvidence(task: Task, completedBy: string | undefined, transition: "integrate"): Record<string, unknown> {
    const completion = task.completion;
    return {
      completedBy,
      blockedReportedAt: completion?.reportedAt,
      question: completion ? blockedQuestion(completion) : undefined,
      summary: completion?.summary,
      residualRisk: completion?.residualRisk,
      transition,
    };
  }

  private async startFreshOpenCodeAnsweredBlock(task: Task, prompt: string, runStartedAt: number): Promise<Task> {
    const taskId = task.id;
    const isolatedRun = wantsWorktree(task);
    const execDirectory = this.resolveDirectory(task.worktreePath ?? task.directory);
    const permissionRules = resolveOpenCodePermissionRules(isolatedRun, task.permissionOverrides);
    const activeModel = task.model ?? null;
    const created = await this.client.session.create({
      agent: task.agent ?? undefined,
      model: activeModel ?? undefined,
      directory: execDirectory,
      permission: permissionRules,
    });
    if ((created as { error?: unknown }).error) throw AdapterError.unreachable("Failed to create OpenCode session", (created as { error?: unknown }).error);
    const sessionId = extractSessionId((created as { data?: unknown }).data);
    if (!sessionId) throw AdapterError.unreachable("OpenCode session create returned no id");
    this.bindOpenCodeRun({ task, sessionId, runStartedAt, attempt: 0 });
    this.store.update(taskId, { sessionId, activeModel, autoRetries: 0, runStartedAt });
    if (hasAskRule(permissionRules)) this.startPermissionResponder(sessionId, execDirectory, isolatedRun ? "worktree-fence" : "in-place-override", task.id, runStartedAt);
    const retryPrompt = isolatedRun ? this.withWorktreeIsolationPreamble(execDirectory, this.resolveDirectory(task.directory), prompt) : prompt;
    const fullPrompt = this.withCompletionContract(task, this.withParentHandoffs(task, this.withTaskContext(task, retryPrompt)), runStartedAt);
    const promptError = await this.prompt(sessionId, fullPrompt, task.agent ?? undefined, task.model ?? undefined);
    if (promptError) {
      this.stopPermissionResponder(sessionId);
      this.endOpenCodeRun(task.id, runStartedAt, "error");
      const updated = this.store.update(taskId, { sessionId, activeModel, autoRetries: 0, runState: "error", error: promptError });
      if (!updated) throw AdapterError.notFound(`Task not found: ${taskId}`);
      throw AdapterError.unreachable(promptError);
    }
    this.store.update(taskId, { completion: null, completionSource: null, finalSessionOutput: null, sessionId, activeModel, autoRetries: 0, runState: "running", runStartedAt, error: undefined, pending: undefined });
    this.store.move(taskId, "in_progress", END_OF_COLUMN);
    this.startCompletionWatcher(taskId, sessionId);
    const fresh = this.store.get(taskId);
    if (!fresh) throw AdapterError.notFound(`Task not found: ${taskId}`);
    return fresh;
  }

  async retry(taskId: string, feedback?: string, blockedAnswer?: BlockedAnswerContext): Promise<Task> {
    return this.withTaskLifecycleLock(taskId, () => this.retryUnlocked(taskId, feedback, blockedAnswer));
  }

  private async retryUnlocked(taskId: string, feedback?: string, blockedAnswer?: BlockedAnswerContext): Promise<Task> {
    const task = this.store.get(taskId);
    if (!task) {
      throw AdapterError.notFound(`Task not found: ${taskId}`);
    }
    this.assertNotArchived(task, "retry");
    if (blockedAnswer) this.assertBlockedAnswerCurrent(task, blockedAnswer);
    if (isAcpHarness(task.harness)) {
      this.assertParentsSatisfied(task);
      const runStartedAt = nextRunStartedAt(task);
      this.store.update(taskId, {
        runStartedAt,
        ...(!blockedAnswer ? { completion: null, completionSource: null, finalSessionOutput: null } : {}),
      });
      const execDirectory = this.resolveDirectory(task.worktreePath ?? task.directory);
      if (!blockedAnswer) await this.captureDispatchBaseline(task, wantsWorktree(task), execDirectory);
      return this.runAcpTask(
        task,
        execDirectory,
        blockedAnswer ? this.withBlockedAnswerPrompt(task, blockedAnswer, feedback, false) : feedback ?? task.description,
        "retry",
        blockedAnswer !== undefined,
        runStartedAt,
      );
    }

    if (!task.sessionId && !blockedAnswer) {
      throw AdapterError.notFound(`Task has no session to retry: ${taskId}`);
    }
    this.assertParentsSatisfied(task);
    const runStartedAt = nextRunStartedAt(task);
    this.store.update(taskId, {
      runStartedAt,
      autoRetries: 0,
      activeModel: task.model ?? null,
      ...(!blockedAnswer ? { completion: null, completionSource: null, finalSessionOutput: null } : {}),
    });
    if (task.sessionId) this.outputCandidates.delete(task.sessionId);

    const blockedAnswerResumePlan = blockedAnswer ? await this.decideOpenCodeBlockedAnswerResume(task) : undefined;
    const blockedAnswerResumeDecision = blockedAnswerResumePlan?.decision;
    if (blockedAnswer && blockedAnswerResumeDecision?.mode !== "same-session") {
      if (blockedAnswerResumePlan?.fenceSessionBeforeFresh) {
        await this.fenceBlockedAnswerSessionBeforeFresh(task);
      }
      const fresh = await this.startFreshOpenCodeAnsweredBlock(
        task,
        this.withBlockedAnswerPrompt(task, blockedAnswer, feedback, false),
        runStartedAt,
      );
      return { ...fresh, blockedAnswerResumeDecision };
    }
    const sessionId = task.sessionId;
    if (!sessionId) throw AdapterError.notFound(`Task has no session to retry: ${taskId}`);

    this.bindOpenCodeRun({ task, sessionId, runStartedAt, attempt: 0 });
    // retry() re-prompts an existing session — the worktree already exists from
    // run(), so its path comes off the task record rather than ensureWorktree().
    const isolatedRetry = wantsWorktree(task);
    const retryDirectory = this.resolveDirectory(task.worktreePath ?? task.directory);
    if (!blockedAnswer) await this.captureDispatchBaseline(task, isolatedRetry, retryDirectory);
    const permissionRules = resolveOpenCodePermissionRules(isolatedRetry, task.permissionOverrides);
    // The fresh run identity and primary-model breaker reset were persisted
    // before the first await so stale completion/abort work cannot still own
    // the previous attempt while this retry provisions.
    if (hasAskRule(permissionRules)) {
      this.startPermissionResponder(sessionId, retryDirectory, isolatedRetry ? "worktree-fence" : "in-place-override", task.id, runStartedAt);
    } else {
      this.stopPermissionResponder(sessionId);
    }
    const baseRetryPrompt = this.withRebaseConflictContext(task, blockedAnswer ? this.withBlockedAnswerPrompt(task, blockedAnswer, feedback, true) : feedback ?? task.description);
    const retryPrompt = isolatedRetry
      ? this.withWorktreeIsolationPreamble(
          retryDirectory,
          this.resolveDirectory(task.directory),
          baseRetryPrompt,
        )
      : baseRetryPrompt;
    const contextPrompt = this.withTaskContext(task, retryPrompt);
    const parentPrompt = this.withParentHandoffs(task, contextPrompt);
    const promptError = await this.prompt(
      sessionId,
      this.withCompletionContract(task, parentPrompt, runStartedAt),
      task.agent ?? undefined,
      task.model ?? undefined,
    );
    if (promptError) {
      this.stopPermissionResponder(sessionId);
      this.endOpenCodeRun(task.id, runStartedAt, "error");
      const updated = this.store.update(taskId, { runState: "error", error: promptError });
      if (!updated) {
        throw AdapterError.notFound(`Task not found: ${taskId}`);
      }
      if (blockedAnswer) throw AdapterError.unreachable(promptError);
      return updated;
    }

    this.store.update(taskId, {
      completion: null,
      completionSource: null,
      finalSessionOutput: null,
      runState: "running",
      runStartedAt,
      error: undefined,
      pending: undefined,
    });
    this.store.move(taskId, "in_progress", END_OF_COLUMN);
    this.startCompletionWatcher(taskId, sessionId);

    const fresh = this.store.get(taskId);
    if (!fresh) {
      throw AdapterError.notFound(`Task not found: ${taskId}`);
    }
    return blockedAnswerResumeDecision ? { ...fresh, blockedAnswerResumeDecision } : fresh;
  }

  private assertNotArchived(task: Task, action: "run" | "retry"): void {
    if (task.archived) throw new ArchivedTaskActionError(action);
  }

  private assertInitGitEligible(task: Task): void {
    this.assertNotArchived(task, "run");
    if (task.type === "manual") {
      throw AdapterError.validation("Manual tasks cannot initialize git and run; convert it to an agent task first.");
    }
    if (!wantsWorktree(task)) {
      throw AdapterError.validation("Git initialization is only available for worktree-isolated tasks");
    }
    if (task.pending !== "git-init") {
      throw AdapterError.validation("Task is not awaiting git initialization");
    }
    this.assertNotAlreadyRunning(task);
    this.assertParentsSatisfied(task);
  }

  /**
   * run() dispatches a brand-new session (OpenCode session.create or a fresh
   * ACP launch) — calling it again while a live session already exists would
   * start a second writer against the same worktree without ever aborting
   * the first. Gated on an actual session id, not bare `runState` — the
   * chain-advancer synchronously claims `runState: "running"` on a child
   * *before* it has a session, purely to prevent a second near-simultaneous
   * advance from double-dispatching (see chain-advancer.ts), and that claim
   * must still be able to call through to run(). retry()/
   * startFreshOpenCodeAttempt() are the sanctioned ways to replace an
   * already-live run and are not gated by this check.
   */
  private assertNotAlreadyRunning(task: Task): void {
    if (task.runState === "running" && (task.sessionId || task.harnessSessionId || task.harnessSessionName)) {
      throw AdapterError.validation(`Task is already running; use retry to restart an active run: ${task.id}`);
    }
  }

  private assertParentsSatisfied(task: Task): void {
    const parentIds = task.parentIds ?? this.store.getParentIds(task.id);
    if (parentIds.length === 0) return;

    const unmetParents = parentIds
      .map((parentId): UnmetParentDependency | null => {
        const parent = this.store.get(parentId);
        if (!parent) return { id: parentId, title: "Unknown parent", why: "parent task no longer exists" };
        const why = unmetReason(parent);
        return why ? { id: parent.id, title: parent.title, why } : null;
      })
      .filter((parent): parent is UnmetParentDependency => parent !== null);

    if (unmetParents.length > 0) {
      throw new DependencyGateError(unmetParents);
    }
  }

  /**
   * Fire-and-forget notify that `taskId` just became satisfied (moved to
   * done), so the chain advancer can check for autoRun children. Never
   * awaited by the caller — integrate() must not delay its response on
   * spawned child sessions. Any advancer failure is recorded as a
   * task_warning on the parent rather than becoming an unhandled rejection.
   */
  private fireOnParentSatisfied(taskId: string): void {
    if (!this.onParentSatisfied) return;
    void this.onParentSatisfied(taskId).catch((err) => {
      this.store.addEvent({
        taskId,
        type: "task_warning",
        body: { warning: `Auto-dispatch chain check failed: ${errorMessage(err, "unknown error")}` },
      });
    });
  }

  async abort(taskId: string): Promise<void> {
    return this.withTaskLifecycleLock(taskId, () => this.abortUnlocked(taskId));
  }

  private async abortUnlocked(taskId: string): Promise<void> {
    const task = this.store.get(taskId);
    if (task && isAcpHarness(task.harness)) {
      if (task.harnessSessionName) {
        const runner = this.acpRunners[task.harness];
        const label = harnessDisplayName(task.harness);
        try {
          await runner.abort(task.harnessSessionName);
        } catch (err) {
          if (!sameTaskRun(this.store.get(taskId), task)) {
            throw new StaleTaskRunError(taskId, "abort");
          }
          this.store.update(taskId, {
            runState: "error",
            error: errorMessage(err, `${label} background abort failed`),
          });
          return;
        }
        if (!sameTaskRun(this.store.get(taskId), task)) {
          throw new StaleTaskRunError(taskId, "abort");
        }
        this.cancelCompletionWatcher(task.harnessSessionName);
      }
      this.store.update(taskId, { runState: "idle", harnessStatus: "aborted" });
      return;
    }
    if (!task || !task.sessionId) {
      return;
    }
    await this.client.session.abort({ sessionID: task.sessionId });
    if (!sameTaskRun(this.store.get(taskId), task)) {
      throw new StaleTaskRunError(taskId, "abort");
    }
    this.cancelCompletionWatcher(task.sessionId);
    this.stopPermissionResponder(task.sessionId);
    this.endOpenCodeRun(taskId, task.runStartedAt, "aborted");
    this.outputCandidates.delete(task.sessionId);
    this.store.update(taskId, { runState: "idle" });
  }

  /**
   * Begin consuming `client.event.subscribe()`. Safe to call once; a second call
   * while already running is a no-op. Auto-reconnects with backoff if the upstream
   * stream ends or errors, until `shutdown()` is called.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    const myGeneration = ++this.generation;
    void this.runConsumeLoop(myGeneration);
  }

  /** Stop consuming the upstream event stream. Idempotent. */
  shutdown(): void {
    this.running = false;
    this.generation++;
    // Cancels the in-flight subscribe() fetch/stream so the old consume loop
    // exits promptly instead of blocking on `for await` for an event that
    // may never arrive — without this, the old subscription lingers and a
    // later start() opens a second, redundant one.
    this.upstreamAbort?.abort();
    this.upstreamAbort = null;
    for (const watcher of this.completionWatchers.values()) {
      watcher.cancelled = true;
    }
    this.completionWatchers.clear();
    this.outputCandidates.clear();
    this.permissionAskMeta.clear();
    for (const [taskId, run] of this.openCodeRunsByTask) {
      this.activity.endRun(taskId, run.runStartedAt, "aborted");
      run.watchdog.dispose();
    }
    this.openCodeRunsByTask.clear();
    this.openCodeSessionToTask.clear();
    this.permissionResponderPool.stop();
    for (const runner of new Set(Object.values(this.acpRunners))) runner.shutdown?.();
    this.permissionBroker.stop();
  }

  listPendingPermissions(taskId: string): PendingPermissionAsk[] {
    const task = this.store.get(taskId);
    if (!task) throw AdapterError.notFound(`Task not found: ${taskId}`);
    return this.pendingPermissionsForTask(task);
  }

  async respondPermission(taskId: string, input: RespondPermissionInput): Promise<RespondOutcome> {
    const task = this.store.get(taskId);
    if (!task) throw AdapterError.notFound(`Task not found: ${taskId}`);
    const owned = this.pendingPermissionsForTask(task).some((ask) => ask.id === input.askId);
    if (!owned) {
      return this.permissionAskOwners.get(input.askId) === taskId
        ? { ok: false, askId: input.askId, conflict: "stale" }
        : { ok: false, askId: input.askId, conflict: "not-found" };
    }
    if (isAcpHarness(task.harness) && task.harnessSessionName) {
      const runner = this.acpRunners[task.harness] as ClaudeCodeRunnerLike & { respondPermission?: (sessionName: string, input: RespondPermissionInput) => Promise<RespondOutcome> };
      return runner.respondPermission?.(task.harnessSessionName, input) ?? { ok: false, askId: input.askId, conflict: "not-found" };
    }
    return this.permissionResponderPool.respond(input);
  }

  async sendSessionMessage(taskId: string, input: SessionMessageInput): Promise<SessionMessageReceipt> {
    return this.withTaskLifecycleLock(taskId, () => this.sendSessionMessageUnlocked(taskId, input));
  }

  private async sendSessionMessageUnlocked(taskId: string, input: SessionMessageInput): Promise<SessionMessageReceipt> {
    const task = this.store.get(taskId);
    if (!task) throw AdapterError.notFound(`Task not found: ${taskId}`);
    if (task.archived) throw AdapterError.validation("Cannot chat with an archived task");
    if (task.column === "done") throw AdapterError.validation("Done tasks are historical; move the task out of Done before chatting");
    const sessionId = task.sessionId ?? task.harnessSessionId;
    if (!sessionId) throw AdapterError.notFound("Task has no resumable session");
    const acpRunner = isAcpHarness(task.harness) ? this.acpRunners[task.harness] : undefined;
    if (isAcpHarness(task.harness) && (!task.harnessSessionName || !acpRunner?.sendMessage)) {
      throw AdapterError.validation("This ACP session is no longer resumable; start a fresh continuation instead");
    }
    if (!isAcpHarness(task.harness) && !task.sessionId) {
      throw AdapterError.notFound("OpenCode session is no longer resumable");
    }
    if (sessionId !== input.expectedSessionId) {
      throw AdapterError.validation("Session changed while the message was being composed");
    }
    if (input.expectedRunStartedAt !== undefined && task.runStartedAt !== input.expectedRunStartedAt) {
      throw AdapterError.validation("Task run changed while the message was being composed");
    }
    if (input.blockedReportedAt !== undefined && task.completion?.reportedAt !== input.blockedReportedAt) {
      throw AdapterError.validation("Blocked question changed while the message was being composed");
    }

    const sentAt = Date.now();
    const wasRunning = task.runState === "running";
    const runStartedAt = Math.max(sentAt, (task.runStartedAt ?? 0) + 1);
    const promptText = wasRunning
      ? `OPENBOARD OPERATOR GUIDANCE\n\n${input.text}\n\nApply this guidance to the active task. Preserve the existing session, working tree, and original completion contract.\n\nCurrent report identity: taskId "${taskId}", runStartedAt ${runStartedAt}. Use these exact values in the final complete_task or block_task call; this identity replaces any earlier runStartedAt.`
      : `OPENBOARD SESSION CHAT\n\n${input.text}\n\nRespond conversationally in this session. Do not call complete_task or block_task, do not change files, and do not alter the card lifecycle for this chat turn.`;

    // Every operator message starts a new logical report generation, even
    // when the provider queues it behind an active turn. Publish that
    // identity before any provider await so an older completion cannot win
    // while the guidance is being admitted.
    const claimed = this.store.update(taskId, {
      runStartedAt,
      runState: "running",
      error: undefined,
      ...(isAcpHarness(task.harness)
        ? { harnessStatus: input.mode === "queue" && wasRunning ? "queued" : "running" }
        : {}),
    });
    if (!claimed) throw AdapterError.notFound(`Task not found: ${taskId}`);
    if (task.column === "todo") this.store.move(taskId, "in_progress", END_OF_COLUMN);

    if (isAcpHarness(task.harness)) {
      if (task.harnessSessionName) this.cancelCompletionWatcher(task.harnessSessionName);
      this.activity.startRun({
        taskId,
        runStartedAt,
        sessionId,
        rootSessionId: sessionId,
        harness: task.harness,
      });
      this.activity.recordEvent(taskId, runStartedAt, {
        sessionId,
        rootSessionId: sessionId,
        harness: task.harness,
        kind: "text",
        role: "user",
        text: input.text,
      });
    } else if (task.sessionId) {
      this.cancelCompletionWatcher(task.sessionId);
    }

    try {
      if (isAcpHarness(task.harness)) {
        await acpRunner!.sendMessage!(task.harnessSessionName!, promptText, { mode: input.mode, runStartedAt });
      } else {
        if (input.mode === "interrupt" && wasRunning) {
          const aborted = await this.client.session.abort({ sessionID: task.sessionId! });
          const abortError = (aborted as { error?: unknown }).error;
          if (abortError) throw AdapterError.unreachable("Could not interrupt the active OpenCode turn", abortError);
        }
        if (!sameTaskRunIdentity(this.store.get(taskId), claimed)) {
          throw new StaleTaskRunError(taskId, "sending a session message");
        }
        this.bindOpenCodeRun({ task: claimed, sessionId: task.sessionId!, runStartedAt, attempt: 0 });
        const promptError = await this.prompt(task.sessionId!, promptText, task.agent ?? undefined, task.activeModel ?? task.model ?? undefined);
        if (promptError) {
          throw AdapterError.unreachable(promptError);
        }
      }
    } catch (error) {
      await this.fenceFailedSessionMessage(task, claimed, errorMessage(error, "Session message delivery failed"));
      throw error;
    }

    const current = this.store.get(taskId);
    if (!sameTaskRunIdentity(current, claimed)) {
      throw new StaleTaskRunError(taskId, "sending a session message");
    }
    if (isAcpHarness(task.harness)) {
      if (current.runState === "running") {
        this.startAcpWatcher(taskId, task.harnessSessionName!, task.harness);
      } else {
        this.activity.endRun(taskId, runStartedAt, current.runState === "error" ? "error" : "complete");
      }
    } else {
      this.recordOpenCodeActivity(taskId, task.sessionId!, { kind: "text", role: "user", text: input.text });
      if (current.runState === "running") {
        this.startCompletionWatcher(taskId, task.sessionId!);
      } else {
        this.endOpenCodeRun(taskId, runStartedAt, current.runState === "error" ? "error" : "complete");
      }
    }

    // Chatting with a Review card is a conversation over its retained
    // session, not a new task attempt. Its placement and completion evidence
    // stay untouched; Todo was moved before provider admission above.
    this.store.addEvent({
      taskId,
      type: "task_session_message",
      body: {
        messageId: input.clientMessageId,
        sentBy: input.sentBy,
        mode: input.mode,
        byteCount: Buffer.byteLength(input.text),
        sessionId,
        runStartedAt,
      },
    });
    const updated = this.store.get(taskId);
    if (!updated) throw AdapterError.notFound(`Task not found: ${taskId}`);
    return {
      messageId: input.clientMessageId,
      taskId,
      sessionId,
      status: wasRunning && input.mode === "queue" ? "queued" : "accepted",
      mode: input.mode,
      sentAt,
      sentBy: input.sentBy,
      task: updated,
    };
  }

  /**
   * Provider admission errors are ambiguous: the message may have been
   * accepted even though its response failed. Fence the captured session
   * before exposing an error so a caller cannot immediately retry beside a
   * ghost writer. If the fence itself is unconfirmed, keep the claimed run
   * observable instead of pretending it stopped.
   */
  private async fenceFailedSessionMessage(task: Task, claimed: Task, deliveryError: string): Promise<void> {
    const beforeAbort = this.store.get(task.id);
    if (!sameTaskRunIdentity(beforeAbort, claimed)) return;
    if (beforeAbort.runState !== "running") {
      if (isAcpHarness(task.harness)) {
        this.activity.endRun(task.id, claimed.runStartedAt!, beforeAbort.runState === "error" ? "error" : "complete");
      } else {
        this.endOpenCodeRun(task.id, claimed.runStartedAt, beforeAbort.runState === "error" ? "error" : "complete");
      }
      return;
    }

    let fenceError: string | undefined;
    try {
      if (isAcpHarness(task.harness)) {
        await this.acpRunners[task.harness].abort(task.harnessSessionName!);
      } else {
        const aborted = await this.client.session.abort({ sessionID: task.sessionId! });
        const abortError = (aborted as { error?: unknown }).error;
        if (abortError) throw abortError;
      }
    } catch (error) {
      fenceError = errorMessage(error, "provider abort failed");
    }

    const afterAbort = this.store.get(task.id);
    if (!sameTaskRunIdentity(afterAbort, claimed)) return;
    if (afterAbort.runState !== "running") {
      if (isAcpHarness(task.harness)) {
        this.activity.endRun(task.id, claimed.runStartedAt!, afterAbort.runState === "error" ? "error" : "complete");
      } else {
        this.endOpenCodeRun(task.id, claimed.runStartedAt, afterAbort.runState === "error" ? "error" : "complete");
      }
      return;
    }

    if (fenceError) {
      this.store.update(task.id, {
        error: `${deliveryError}; could not confirm the active session stopped: ${fenceError}`,
        ...(isAcpHarness(task.harness) ? { harnessStatus: "running" } : {}),
      });
      if (isAcpHarness(task.harness)) {
        this.startAcpWatcher(task.id, task.harnessSessionName!, task.harness);
      } else {
        const currentRun = this.openCodeRunsByTask.get(task.id);
        if (currentRun?.runStartedAt !== claimed.runStartedAt) {
          this.bindOpenCodeRun({ task: claimed, sessionId: task.sessionId!, runStartedAt: claimed.runStartedAt!, attempt: 0 });
        }
        this.startCompletionWatcher(task.id, task.sessionId!);
      }
      return;
    }

    if (isAcpHarness(task.harness)) {
      this.cancelCompletionWatcher(task.harnessSessionName!);
    } else {
      this.cancelCompletionWatcher(task.sessionId!);
      this.stopPermissionResponder(task.sessionId!);
      const currentRun = this.openCodeRunsByTask.get(task.id);
      if (currentRun) this.endOpenCodeRun(task.id, currentRun.runStartedAt, "aborted");
      this.outputCandidates.delete(task.sessionId!);
    }
    this.store.update(task.id, {
      runState: "error",
      error: deliveryError,
      ...(isAcpHarness(task.harness) ? { harnessStatus: "aborted" } : {}),
    });
    if (isAcpHarness(task.harness)) this.activity.endRun(task.id, claimed.runStartedAt!, "error");
  }

  // ---- internals ----

  private bindOpenCodeRun(input: { task: Task; sessionId: string; runStartedAt: number; attempt: number }): void {
    const previous = this.openCodeRunsByTask.get(input.task.id);
    if (previous) {
      this.activity.endRun(input.task.id, previous.runStartedAt, "aborted");
      previous.watchdog.dispose();
      for (const session of previous.sessionIds) this.openCodeSessionToTask.delete(session);
    }
    const runIdentity: WatchdogRunIdentity = {
      taskId: input.task.id,
      runStartedAt: input.runStartedAt,
      sessionId: input.sessionId,
      attempt: input.attempt,
    };
    const watchdog = this.createRunWatchdog();
    const record: OpenCodeRunRecord = {
      taskId: input.task.id,
      runStartedAt: input.runStartedAt,
      rootSessionId: input.sessionId,
      sessionIds: new Set([input.sessionId]),
      watchdog,
      transportLive: true,
      lastLiveState: "running",
      attempt: input.attempt,
    };
    this.openCodeRunsByTask.set(input.task.id, record);
    this.openCodeSessionToTask.set(input.sessionId, input.task.id);
    this.activity.startRun({
      taskId: input.task.id,
      runStartedAt: input.runStartedAt,
      sessionId: input.sessionId,
      rootSessionId: input.sessionId,
      harness: "opencode",
    });
    watchdog.startRun(runIdentity, input.runStartedAt);
  }

  private createRunWatchdog(): RunWatchdog {
    return new RunWatchdog(
      this.watchdogConfig,
      {
        onTerminate: (event) => this.handleWatchdogTermination(event),
        onRetryDecision: (event) => this.handleWatchdogRetryDecision(event),
      },
      this.watchdogClock,
    );
  }

  private endOpenCodeRun(taskId: string, runStartedAt: number | undefined, status: "complete" | "error" | "aborted"): void {
    const run = this.openCodeRunsByTask.get(taskId);
    if (!run || run.runStartedAt !== runStartedAt) return;
    this.activity.endRun(taskId, run.runStartedAt, status);
    const identity: WatchdogRunIdentity = { taskId, runStartedAt: run.runStartedAt, sessionId: run.rootSessionId, attempt: run.attempt };
    if (status === "complete") run.watchdog.complete(identity);
    if (status === "aborted") run.watchdog.abort(identity);
    run.watchdog.dispose();
    for (const session of run.sessionIds) this.openCodeSessionToTask.delete(session);
    this.openCodeRunsByTask.delete(taskId);
  }

  private recordOpenCodeActivity(
    taskId: string,
    sessionId: string,
    input: Omit<SessionActivityEventInput, "sessionId" | "rootSessionId" | "harness">,
  ): void {
    const run = this.openCodeRunsByTask.get(taskId);
    if (!run || !run.sessionIds.has(sessionId) || !run.transportLive) return;
    this.activity.recordEvent(taskId, run.runStartedAt, {
      sessionId,
      rootSessionId: run.rootSessionId,
      harness: "opencode",
      ...input,
    });
    // Real activity resets the busy-probe patience along with the watchdog
    // clock — a run that resumes and stalls again gets fresh re-arm budget.
    run.busyRearms = 0;
    run.watchdog.recordActivity({ run: { taskId, runStartedAt: run.runStartedAt, sessionId: run.rootSessionId, attempt: run.attempt } });
  }

  private markRunsReconnecting(): void {
    for (const run of this.openCodeRunsByTask.values()) {
      run.transportLive = false;
      run.watchdog.suspend({ taskId: run.taskId, runStartedAt: run.runStartedAt, sessionId: run.rootSessionId, attempt: run.attempt });
      this.activity.setTransport(run.taskId, run.runStartedAt, "reconnecting");
    }
  }

  private async rebuildRunsBeforeLive(): Promise<void> {
    const statusMap = await this.fetchSessionStatusMap();
    for (const run of [...this.openCodeRunsByTask.values()]) {
      const task = this.store.get(run.taskId);
      if (!task || task.sessionId !== run.rootSessionId || task.runStartedAt !== run.runStartedAt) continue;
      const identity: WatchdogRunIdentity = { taskId: run.taskId, runStartedAt: run.runStartedAt, sessionId: run.rootSessionId, attempt: run.attempt };
      const rebuilt = await this.rebuildSessionTree(run);
      if (rebuilt === "missing") {
        // Confirmed by a 404 on the root itself while walking the session
        // tree — a real, decisive loss signal independent of status().
        this.store.update(task.id, { runState: "error", error: "OpenCode root session missing after reconnect; observation is no longer reliable" });
        this.store.addEvent({ taskId: task.id, type: "task_watchdog_orphan", body: { sessionId: run.rootSessionId, runStartedAt: run.runStartedAt } });
        this.endOpenCodeRun(task.id, run.runStartedAt, "error");
        continue;
      }
      const rootStatus = statusMap?.get(run.rootSessionId);
      if (rebuilt === "blind" && !rootStatus) {
        // Neither signal (session tree, status()) confirmed anything about
        // the root this cycle — genuinely no visibility. Bounded honest
        // recovery: stay suspended (not orphaned, not falsely tripped) for a
        // bounded number of cycles, then fall back to pure liveness-timeout
        // detection so a truly stuck session is still eventually caught.
        run.blindReconnectAttempts = (run.blindReconnectAttempts ?? 0) + 1;
        if (run.blindReconnectAttempts < BLIND_RECONNECT_BOUND) continue;
        this.store.addEvent({
          taskId: run.taskId,
          type: "task_watchdog_blind_recovery",
          body: { sessionId: run.rootSessionId, runStartedAt: run.runStartedAt, attempts: run.blindReconnectAttempts },
        });
        run.watchdog.resume(identity);
        continue;
      }
      // Either the tree confirmed the root exists ("live"), or status()
      // reported *something* for it even though the tree couldn't be
      // rebuilt — either signal proves the root is not missing, so an
      // unrecognized/forward-compat status string must not be treated as
      // orphaned.
      run.blindReconnectAttempts = 0;
      run.transportLive = true;
      run.watchdog.resume(identity);
      this.activity.setTransport(run.taskId, run.runStartedAt, "live");
      if (rootStatus === "busy" || rootStatus === "retry") {
        run.watchdog.recordActivity({ run: identity });
        if (task.runState !== "running") this.store.update(task.id, { runState: "running", error: undefined });
        continue;
      }
      if (rootStatus === "idle" && !this.completionWatchers.has(run.rootSessionId)) {
        this.startCompletionWatcher(task.id, run.rootSessionId);
      }
    }
  }

  private async fetchSessionStatusMap(): Promise<Map<string, "idle" | "busy" | "retry"> | null> {
    try {
      if (!("status" in this.client.session)) return null;
      const result = await (this.client.session as unknown as { status(): Promise<unknown> }).status();
      const error = (result as { error?: unknown }).error;
      if (error) return null;
      const data = (result as { data?: unknown }).data;
      const entries = data instanceof Map ? [...data.entries()] : Object.entries(readRecord(data) ?? {});
      const map = new Map<string, "idle" | "busy" | "retry">();
      for (const [sessionId, rawStatus] of entries) {
        if (typeof sessionId !== "string") continue;
        const status = normalizeSessionStatus(rawStatus);
        if (status) map.set(sessionId, status);
      }
      return map;
    } catch {
      return null;
    }
  }

  private async rebuildSessionTree(run: OpenCodeRunRecord): Promise<"live" | "blind" | "missing"> {
    const next = new Set<string>([run.rootSessionId]);
    const queue: Array<{ sessionId: string; depth: number }> = [{ sessionId: run.rootSessionId, depth: 0 }];
    for (let head = 0; head < queue.length; head += 1) {
      const { sessionId, depth } = queue[head]!;
      if (depth >= SESSION_TREE_MAX_DEPTH || next.size >= SESSION_TREE_MAX_SESSIONS) continue;
      let result: unknown;
      try {
        if (!("children" in this.client.session)) return "blind";
        result = await (this.client.session as unknown as { children(input: { sessionID: string }): Promise<unknown> }).children({ sessionID: sessionId });
      } catch {
        return "blind";
      }
      const error = (result as { error?: unknown }).error;
      if (error) return sessionId === run.rootSessionId && isNotFoundError(error) ? "missing" : "blind";
      const data = (result as { data?: unknown }).data;
      if (!Array.isArray(data)) continue;
      for (const child of data) {
        const id = extractChildSessionId(child);
        if (!id || next.has(id) || next.size >= SESSION_TREE_MAX_SESSIONS) continue;
        next.add(id);
        queue.push({ sessionId: id, depth: depth + 1 });
      }
    }
    for (const oldSession of run.sessionIds) this.openCodeSessionToTask.delete(oldSession);
    run.sessionIds = next;
    for (const session of next) this.openCodeSessionToTask.set(session, run.taskId);
    return "live";
  }

  private handleWatchdogTermination(event: WatchdogTermination): void {
    const current = this.openCodeRunsByTask.get(event.run.taskId);
    if (!current || current.runStartedAt !== event.run.runStartedAt || current.rootSessionId !== event.run.sessionId) return;
    const task = this.store.get(event.run.taskId);
    if (!task || task.runState !== "running" || task.runStartedAt !== event.run.runStartedAt) return;
    if (this.suppressWatchdogForPendingPermission(current, event)) return;
    current.abortPromise = this.confirmWatchdogTerminationAfterStatusProbe(current, event, task);
  }

  /**
   * /event-frame silence is not proof of a dead run: a single long tool call
   * (a full test suite, a build, a download) can emit no attributable frames
   * for the whole watchdog window while the session stays genuinely busy.
   * Before aborting, cross-check the live session status; if any session in
   * the run's tree still reports busy, re-arm the watchdog for a fresh
   * window instead of killing a healthy run. A null status map (endpoint
   * unavailable/blind) falls through to the abort — the original behavior —
   * so a dead transport cannot suppress termination forever.
   */
  private async confirmWatchdogTerminationAfterStatusProbe(run: OpenCodeRunRecord, event: WatchdogTermination, task: Task): Promise<boolean | "busy-rearm"> {
    const statuses = await this.fetchSessionStatusMap();
    const statusBusy = statuses !== null && [...run.sessionIds].some((sessionId) => {
      const status = statuses.get(sessionId);
      return status === "busy" || status === "retry";
    });
    const stillBusy = statusBusy || await this.sessionTreeHasActiveTool(run);
    // Bounded patience: a session wedged in status "busy" (the original
    // dead-session incident) must still trip once the re-arm budget is
    // spent — "busy" earns extra full windows, not immunity.
    if (stillBusy && (run.busyRearms ?? 0) < MAX_WATCHDOG_BUSY_REARMS) {
      run.busyRearms = (run.busyRearms ?? 0) + 1;
      const currentRun = this.openCodeRunsByTask.get(event.run.taskId);
      const currentTask = this.store.get(event.run.taskId);
      if (
        currentRun && currentRun.runStartedAt === event.run.runStartedAt && currentRun.rootSessionId === event.run.sessionId &&
        currentTask && currentTask.runState === "running" && currentTask.runStartedAt === event.run.runStartedAt
      ) {
        currentRun.watchdog.dispose();
        currentRun.watchdog = this.createRunWatchdog();
        currentRun.watchdog.startRun(event.run);
        this.store.addEvent({
          taskId: task.id,
          type: "task_watchdog_busy_wait",
          body: watchdogEventBody(event.run, { model: watchdogModelForTask(task), reason: event.reason, outcome: "deferred", observedAt: event.terminatedAt }),
        });
      }
      return "busy-rearm";
    }
    this.store.addEvent({
      taskId: task.id,
      type: "task_watchdog_tripped",
      body: watchdogEventBody(event.run, { model: watchdogModelForTask(task), reason: event.reason, outcome: "tripped", observedAt: event.terminatedAt }),
    });
    return this.confirmWatchdogAbort(event.run);
  }

  private async sessionTreeHasActiveTool(run: OpenCodeRunRecord): Promise<boolean> {
    for (const sessionId of run.sessionIds) {
      try {
        const result = await this.client.session.messages({ sessionID: sessionId });
        if ((result as { error?: unknown }).error) continue;
        if (hasActiveToolCall((result as { data?: unknown }).data)) return true;
      } catch {
        // Message corroboration is best-effort; status/session-tree signals still decide.
      }
    }
    return false;
  }

  private suppressWatchdogForPendingPermission(run: OpenCodeRunRecord, event: WatchdogTermination): boolean {
    const pending = this.permissionResponderPool.listPending(event.run.sessionId)
      .filter((ask) => ask.deadline > event.terminatedAt)
      .sort((a, b) => a.raisedAt - b.raisedAt)[0];
    if (!pending) return false;
    run.watchdogRetrySuppressed = true;
    run.watchdog.dispose();
    run.watchdog = this.createRunWatchdog();
    run.watchdog.startRun(event.run, pending.deadline);
    const task = this.store.get(event.run.taskId);
    this.store.addEvent({
      taskId: event.run.taskId,
      type: "task_watchdog_permission_wait",
      body: watchdogEventBody(event.run, {
        model: task ? watchdogModelForTask(task) : null,
        askId: pending.id,
        deadline: pending.deadline,
        reason: event.reason,
        outcome: "deferred",
      }),
    });
    return true;
  }

  private handleWatchdogRetryDecision(event: WatchdogRetryDecision): void {
    void this.applyWatchdogRetryDecision(event);
  }

  private async applyWatchdogRetryDecision(event: WatchdogRetryDecision): Promise<void> {
    const current = this.openCodeRunsByTask.get(event.run.taskId);
    if (!current || current.runStartedAt !== event.run.runStartedAt || current.rootSessionId !== event.run.sessionId) return;
    if (current.watchdogRetrySuppressed) {
      current.watchdogRetrySuppressed = false;
      return;
    }
    const task = this.store.get(event.run.taskId);
    if (!task || task.runState !== "running" || task.runStartedAt !== event.run.runStartedAt || task.sessionId !== event.run.sessionId) return;
    const abortConfirmed = await (current.abortPromise ?? this.confirmWatchdogAbort(event.run));
    if (abortConfirmed === "busy-rearm") return; // status probe re-armed the watchdog; the run is still healthy
    await this.withTaskLifecycleLock(event.run.taskId, async () => {
      const stillExpected = this.store.get(event.run.taskId);
      const stillCurrentRun = this.openCodeRunsByTask.get(event.run.taskId);
      if (
        !stillExpected ||
        !stillCurrentRun ||
        stillExpected.runState !== "running" ||
        stillExpected.runStartedAt !== event.run.runStartedAt ||
        stillExpected.sessionId !== event.run.sessionId ||
        stillCurrentRun.runStartedAt !== event.run.runStartedAt ||
        stillCurrentRun.rootSessionId !== event.run.sessionId
      ) return;
      if (!abortConfirmed) {
        this.store.update(stillExpected.id, { runState: "error", error: "Watchdog tripped but old OpenCode root abort was not confirmed; refusing to start a second writer" });
        this.store.addEvent({ taskId: stillExpected.id, type: "task_watchdog_abort_unconfirmed", body: watchdogEventBody(event.run, { model: watchdogModelForTask(stillExpected), reason: event.reason, outcome: "abort-unconfirmed" }) });
        return;
      }
      if (event.outcome === "exhausted") {
        this.systemBlockAfterWatchdogExhaustion(
          stillExpected,
          event.run.runStartedAt,
          `tripped for runStartedAt ${event.run.runStartedAt}`,
          watchdogEventBody(event.run, { model: watchdogModelForTask(stillExpected), reason: event.reason }),
        );
        return;
      }

      const nextAttempt = event.nextAttempt ?? event.run.attempt + 1;
      await this.escalateWatchdogAttempt(stillExpected, nextAttempt, event.reason);
    });
  }

  /**
   * Select the model for a watchdog auto-retry attempt (escalating to the
   * configured fallback model on the second retry when it differs from the
   * primary provider), emit the matching retry/fallback event, and start the
   * attempt. Shared by normal watchdog escalation and by the
   * dispatch-failure recovery path in startFreshOpenCodeAttempt.
   */
  private async escalateWatchdogAttempt(task: Task, nextAttempt: number, reason = "liveness-timeout"): Promise<void> {
    const fallback = task.fallbackModel;
    const primary = task.model ?? null;
    const activeModel = nextAttempt === 2 && fallback && !sameProvider(primary, fallback) ? fallback : primary;
    const usedFallback = activeModel === fallback && fallback !== null;
    const previousSessionId = task.sessionId;
    const previousRunStartedAt = task.runStartedAt;
    this.store.addEvent({
      taskId: task.id,
      type: usedFallback ? "task_watchdog_fallback" : "task_watchdog_retry",
      body: {
        attempt: nextAttempt,
        ...(previousRunStartedAt !== undefined ? { runStartedAt: previousRunStartedAt } : {}),
        ...(previousSessionId ? { sessionId: previousSessionId, previousSessionId } : {}),
        model: activeModel,
        provider: activeModel?.providerID,
        reason,
        outcome: usedFallback ? "fallback-starting" : "retry-starting",
      },
    });
    await this.startFreshOpenCodeAttempt(task, nextAttempt, activeModel, previousSessionId, reason);
  }

  /**
   * System-block the task the way watchdog exhaustion does: a blocked
   * completion report with a needsInput question, moved to the review
   * column. Shared by liveness-timeout exhaustion and by watchdog
   * auto-retry attempts that fail to start (session-create or prompt
   * admission) with no attempt budget remaining.
   */
  private systemBlockAfterWatchdogExhaustion(
    task: Task,
    runStartedAtToClose: number | undefined,
    verificationResult: string,
    eventBody: Record<string, unknown>,
  ): void {
    const report = {
      outcome: "blocked" as const,
      summary: "OpenCode watchdog exhausted automatic recovery after two retries.",
      changedFiles: [],
      verification: [{ command: "OPENBOARD_WATCHDOG_MS", result: verificationResult }],
      residualRisk: "Agent session became silent while observation was live; human input is required before continuing.",
      needsInput: "Review the partial worktree/session output and decide whether to retry manually, change model/provider, or edit the task.",
      reportedAt: Date.now(),
    };
    this.store.setCompletion(task.id, report, "watchdog");
    this.store.update(task.id, { runState: "error", error: report.residualRisk, completionLocation: "task-directory" });
    this.store.move(task.id, "review", END_OF_COLUMN);
    this.store.addEvent({ taskId: task.id, type: "task_watchdog_exhausted", body: { ...eventBody, outcome: "exhausted" } });
    if (runStartedAtToClose !== undefined) this.endOpenCodeRun(task.id, runStartedAtToClose, "error");
  }

  private async confirmWatchdogAbort(run: WatchdogRunIdentity): Promise<boolean> {
    return this.withTaskLifecycleLock(run.taskId, () => this.confirmWatchdogAbortUnlocked(run));
  }

  private async confirmWatchdogAbortUnlocked(run: WatchdogRunIdentity): Promise<boolean> {
    const task = this.store.get(run.taskId);
    if (!task || task.sessionId !== run.sessionId || task.runStartedAt !== run.runStartedAt || task.runState !== "running") return false;
    try {
      const result = await this.client.session.abort({ sessionID: run.sessionId });
      const error = (result as { error?: unknown }).error;
      if (error) throw error;
      const current = this.store.get(run.taskId);
      if (!current || current.sessionId !== run.sessionId || current.runStartedAt !== run.runStartedAt || current.runState !== "running") return false;
      this.cancelCompletionWatcher(run.sessionId);
      this.stopPermissionResponder(run.sessionId);
      return true;
    } catch (err) {
      const current = this.store.get(run.taskId);
      if (current?.sessionId === run.sessionId && current.runStartedAt === run.runStartedAt && current.runState === "running") {
        this.store.addEvent({
          taskId: run.taskId,
          type: "task_watchdog_abort_failed",
          body: watchdogEventBody(run, { model: watchdogModelForTask(current), outcome: "abort-failed", error: errorMessage(err, "abort failed") }),
        });
      }
      return false;
    }
  }

  private async startFreshOpenCodeAttempt(task: Task, attempt: number, activeModel: ModelRef | null, previousSessionId: string | undefined, reason: string): Promise<void> {
    const execDirectory = this.resolveDirectory(task.worktreePath ?? task.directory);
    const isolatedRun = wantsWorktree(task);
    const permissionRules = resolveOpenCodePermissionRules(isolatedRun, task.permissionOverrides);
    const runStartedAt = nextRunStartedAt(task);
    const reservedTask = this.store.update(task.id, {
      runStartedAt,
      activeModel,
      autoRetries: attempt,
      runState: "running",
      error: undefined,
    });
    if (!reservedTask) return;
    let created: unknown;
    try {
      created = await this.client.session.create({
        agent: task.agent ?? undefined,
        model: activeModel ?? undefined,
        directory: execDirectory,
        permission: permissionRules,
      });
    } catch (err) {
      await this.handleWatchdogAttemptStartFailure(
        reservedTask,
        attempt,
        "session-create",
        errorMessage(err, "OpenCode session create threw"),
        activeModel,
        previousSessionId,
        undefined,
        reason,
      );
      return;
    }
    const sessionId = extractSessionId((created as { data?: unknown }).data);
    if (!sessionId || (created as { error?: unknown }).error) {
      const detail = errorMessage((created as { error?: unknown }).error, "OpenCode session create returned no id");
      await this.handleWatchdogAttemptStartFailure(reservedTask, attempt, "session-create", detail, activeModel, previousSessionId, sessionId, reason);
      return;
    }
    this.bindOpenCodeRun({ task: reservedTask, sessionId, runStartedAt, attempt });
    this.store.update(task.id, { sessionId, runStartedAt, activeModel, autoRetries: attempt });
    if (hasAskRule(permissionRules)) {
      this.startPermissionResponder(sessionId, execDirectory, isolatedRun ? "worktree-fence" : "in-place-override", task.id, runStartedAt);
    }
    const basePrompt = isolatedRun
      ? this.withWorktreeIsolationPreamble(execDirectory, this.resolveDirectory(task.directory), task.description)
      : task.description;
    // The fresh session lands in the SAME tree the stalled attempt worked
    // in — without saying so, the retry agent has no idea attempt N-1 left
    // partial work behind and may redo or clobber it.
    const prompt = [
      `WATCHDOG RETRY CONTEXT (attempt ${attempt}): a previous session for this task stalled and was aborted.`,
      `You are working in the same directory that attempt used, so its partial work may already be present.`,
      `Inspect the current state first (git status, existing edits), preserve work already done, and continue the task rather than restarting it from scratch.`,
      "",
      basePrompt,
    ].join("\n");
    const fullPrompt = this.withCompletionContract(task, this.withParentHandoffs(task, this.withTaskContext(task, prompt)), runStartedAt);
    const promptError = await this.prompt(sessionId, fullPrompt, task.agent ?? undefined, activeModel);
    if (promptError) {
      const current = this.store.get(task.id);
      const expected = { ...reservedTask, sessionId };
      if (!sameTaskRunIdentity(current, expected) || current.runState !== "running") {
        this.endOpenCodeRun(task.id, runStartedAt, current?.runState === "error" ? "error" : "complete");
        return;
      }
      this.stopPermissionResponder(sessionId);
      this.store.update(task.id, { sessionId, runStartedAt, activeModel, autoRetries: attempt, error: promptError });
      this.endOpenCodeRun(task.id, runStartedAt, "error");
      await this.handleWatchdogAttemptStartFailure(reservedTask, attempt, "prompt", promptError, activeModel, previousSessionId, sessionId, reason);
      return;
    }
    const current = this.store.get(task.id);
    if (!sameTaskRunIdentity(current, { ...reservedTask, sessionId })) {
      this.endOpenCodeRun(task.id, runStartedAt, "aborted");
      return;
    }
    if (current.runState !== "running") {
      this.endOpenCodeRun(task.id, runStartedAt, current.runState === "error" ? "error" : "complete");
      return;
    }
    this.store.update(task.id, { sessionId, runStartedAt, activeModel, autoRetries: attempt, runState: "running", error: undefined });
    this.store.addEvent({
      taskId: task.id,
      type: "task_watchdog_retry_started",
      body: watchdogEventBody({ runStartedAt, sessionId, attempt }, { previousSessionId, nextSessionId: sessionId, model: activeModel, provider: activeModel?.providerID, reason, outcome: "retry-started" }),
    });
    this.startCompletionWatcher(task.id, sessionId);
  }

  /**
   * A watchdog auto-retry attempt failed before a session could observably
   * start (session create or prompt admission). The old root was already
   * aborted and its watchdog is terminal, so the card must not be left
   * runState "running" pointing at a dead session: record why, then either
   * consume the next attempt slot within the cap (same escalation flow as a
   * normal watchdog retry, including fallback-model selection) or
   * system-block the task like watchdog exhaustion does.
   */
  private async handleWatchdogAttemptStartFailure(
    task: Task,
    attempt: number,
    stage: "session-create" | "prompt",
    detail: string,
    activeModel: ModelRef | null,
    previousSessionId: string | undefined,
    sessionId: string | undefined,
    reason: string,
  ): Promise<void> {
    const current = this.store.get(task.id) ?? task;
    const runStartedAt = current.runStartedAt;
    this.store.addEvent({
      taskId: task.id,
      type: "task_watchdog_retry_failed",
      body: {
        attempt,
        ...(runStartedAt !== undefined ? { runStartedAt } : {}),
        ...(sessionId ?? current.sessionId ? { sessionId: sessionId ?? current.sessionId } : {}),
        ...(previousSessionId ? { previousSessionId } : {}),
        model: activeModel,
        provider: activeModel?.providerID,
        reason,
        stage,
        error: detail,
        outcome: "start-failed",
      },
    });
    if (attempt < this.watchdogConfig.maxAutomaticRetries) {
      await this.escalateWatchdogAttempt(current, attempt + 1, reason);
      return;
    }
    const staleRun = this.openCodeRunsByTask.get(task.id);
    this.systemBlockAfterWatchdogExhaustion(
      current,
      staleRun?.runStartedAt,
      `attempt ${attempt} failed to start (${stage}): ${detail}`,
      {
        attempt,
        ...(runStartedAt !== undefined ? { runStartedAt } : {}),
        ...(sessionId ?? current.sessionId ? { sessionId: sessionId ?? current.sessionId } : {}),
        ...(previousSessionId ? { previousSessionId } : {}),
        model: activeModel,
        provider: activeModel?.providerID,
        reason,
        stage,
        error: detail,
      },
    );
  }

  private startCompletionWatcher(taskId: string, sessionId: string): void {
    this.cancelCompletionWatcher(sessionId);
    const runStartedAt = this.store.get(taskId)?.runStartedAt;
    const watcher = { cancelled: false, taskId, runStartedAt };
    this.completionWatchers.set(sessionId, watcher);
    void this.watchCompletion(taskId, sessionId, watcher);
  }

  private startAcpWatcher(taskId: string, sessionName: string, harness: AcpTaskHarness): void {
    this.cancelCompletionWatcher(sessionName);
    const runStartedAt = this.store.get(taskId)?.runStartedAt;
    const watcher = { cancelled: false, taskId, runStartedAt };
    this.completionWatchers.set(sessionName, watcher);
    void this.watchAcpCompletion(taskId, sessionName, harness, watcher);
  }

  private cancelCompletionWatcher(sessionId: string): void {
    const watcher = this.completionWatchers.get(sessionId);
    if (watcher) {
      watcher.cancelled = true;
      this.completionWatchers.delete(sessionId);
    }
  }

  /** Start (or restart) the ask auto-responder for a session with effective ask rules. */
  private startPermissionResponder(
    sessionId: string,
    directory: string,
    source: PendingPermissionAsk["source"],
    taskId: string,
    runStartedAt: number,
  ): void {
    for (const ask of this.permissionResponderPool.listPending(sessionId)) {
      this.permissionAskMeta.delete(ask.id);
    }
    const interactiveBash = source === "worktree-fence" && this.store.get(taskId)?.permissionOverrides?.bash === "ask";
    this.permissionResponderPool.register(sessionId, directory, { source, taskId, runStartedAt, interactiveBash });
  }

  private stopPermissionResponder(sessionId: string): void {
    for (const ask of this.permissionResponderPool.listPending(sessionId)) {
      this.permissionAskMeta.delete(ask.id);
    }
    this.permissionResponderPool.unregister(sessionId);
  }

  private pendingPermissionsForTask(task: Task): PendingPermissionAsk[] {
    if (isAcpHarness(task.harness) && task.harnessSessionName) {
      const runner = this.acpRunners[task.harness] as ClaudeCodeRunnerLike & { listPendingPermissions?: (sessionName: string) => PendingPermissionAsk[] };
      return runner.listPendingPermissions?.(task.harnessSessionName) ?? [];
    }
    if (!task.sessionId) return [];
    return this.permissionResponderPool.listPending(task.sessionId);
  }

  private handlePermissionEvent(event: PermissionAskEvent): void {
    const task = event.taskId
      ? this.store.get(event.taskId)
      : this.listTasksForWatcher().find((candidate) => candidate.sessionId === event.runId || candidate.harnessSessionId === event.runId);
    if (!task) return;
    const runStartedAt = event.runStartedAt ?? this.openCodeRunsByTask.get(task.id)?.runStartedAt ?? task.runStartedAt ?? event.occurredAt;
    const pending = event.type === "permission_asked"
      ? this.pendingPermissionsForTask(task).find((ask) => ask.id === event.askId)
      : undefined;
    if (pending) {
      this.permissionAskMeta.set(event.askId, {
        raisedAt: pending.raisedAt,
        deadline: pending.deadline,
        patterns: pending.patterns,
      });
    } else if (event.type === "permission_asked") {
      this.permissionAskMeta.set(event.askId, {
        raisedAt: event.raisedAt,
        deadline: event.deadline,
        patterns: event.patterns,
      });
    }
    if (event.type === "permission_asked") {
      this.permissionAskOwners.set(event.askId, task.id);
      while (this.permissionAskOwners.size > 2_000) {
        const oldest = this.permissionAskOwners.keys().next().value;
        if (!oldest) break;
        this.permissionAskOwners.delete(oldest);
      }
    }
    const meta = this.permissionAskMeta.get(event.askId);
    const resolution = event.type === "permission_cancelled"
      ? "cancelled"
      : event.reason === "operator"
      ? "operator"
      : event.reason === "policy-timeout" && meta && meta.deadline <= meta.raisedAt
        ? "policy-immediate"
        : event.reason === "policy-timeout"
          ? "policy-timeout"
          : "operator";
    const body: Record<string, unknown> = {
      askId: event.askId,
      harness: event.harness,
      source: event.source,
      permission: event.permission,
      summary: event.summary,
      ...(event.tool ? { tool: event.tool } : {}),
      raisedAt: pending?.raisedAt ?? event.raisedAt,
      deadline: pending?.deadline ?? event.deadline,
      ...((pending?.patterns ?? event.patterns) ? { patterns: pending?.patterns ?? event.patterns } : {}),
      ...(event.providerSessionId ? { providerSessionId: event.providerSessionId } : {}),
      ...(event.runStartedAt !== undefined ? { runStartedAt: event.runStartedAt } : {}),
      ...(event.type !== "permission_asked" ? { resolution } : {}),
      ...(event.decision ? { action: event.decision } : {}),
      ...(event.answeredBy ? { answeredBy: event.answeredBy } : {}),
      ...(event.error ? { error: event.error } : {}),
      ...(event.cancellationReason ? { cancellationReason: event.cancellationReason } : {}),
      ...(event.delivery ? { delivery: event.delivery } : {}),
      ...(event.pendingAfterFailure !== undefined ? { pendingAfterFailure: event.pendingAfterFailure } : {}),
      ...(event.type !== "permission_asked" && meta ? { latencyMs: Math.max(0, event.occurredAt - meta.raisedAt) } : {}),
    };
    try {
      this.store.addEvent({
        taskId: task.id,
        type: event.type === "permission_asked"
          ? "task_permission_asked"
          : event.type === "permission_answered"
            ? "task_permission_answered"
            : event.type === "permission_cancelled"
              ? "task_permission_cancelled"
              : "task_permission_reply_failed",
        body,
      });
    } catch (error) {
      const message = `Permission event persistence failed: ${errorMessage(error, "unknown error")}`;
      try {
        this.store.update(task.id, { error: message });
      } catch {
        // The store itself may be unavailable; stderr remains the final surface.
      }
      // eslint-disable-next-line no-console
      console.error(message);
      return;
    }
    this.activity.recordEvent(task.id, runStartedAt, {
      sessionId: event.runId,
      rootSessionId: event.runId,
      harness: event.harness,
      kind: "permission",
      text: `${event.permission}:${event.type}${event.decision ? `:${event.decision}` : ""}`,
    });
    if (event.type !== "permission_asked") {
      this.permissionAskMeta.delete(event.askId);
      const run = this.openCodeRunsByTask.get(task.id);
      if (run) run.watchdog.recordActivity({ run: { taskId: task.id, runStartedAt: run.runStartedAt, sessionId: run.rootSessionId, attempt: run.attempt } });
    }
  }

  /**
   * A process crash cannot emit broker cancellation. On the next startup,
   * close every durable asked event that has no terminal answer/cancellation.
   * Delivery is explicitly unknown: the prior process may have died before,
   * during, or just after writing the provider reply.
   */
  private reconcileInterruptedPermissionAsks(): void {
    for (const task of this.store.list()) {
      let events: TaskEvent[];
      try {
        events = this.store.listEvents(task.id);
      } catch {
        continue;
      }
      const asked = new Map<string, TaskEvent>();
      const terminal = new Set<string>();
      for (const event of events) {
        const askId = typeof event.body.askId === "string" ? event.body.askId : undefined;
        if (!askId) continue;
        if (event.type === "task_permission_asked") {
          asked.set(askId, event);
          this.permissionAskOwners.set(askId, task.id);
        }
        if (event.type === "task_permission_answered" || event.type === "task_permission_cancelled") terminal.add(askId);
        if (event.type === "task_permission_reply_failed" && event.body.pendingAfterFailure !== true) terminal.add(askId);
      }
      for (const [askId, askEvent] of asked) {
        if (terminal.has(askId)) continue;
        this.store.addEvent({
          taskId: task.id,
          type: "task_permission_cancelled",
          body: {
            ...askEvent.body,
            askId,
            resolution: "cancelled",
            cancellationReason: "restart-reconciliation",
            delivery: "unknown",
            reconciledAt: Date.now(),
          },
        });
      }
    }
    while (this.permissionAskOwners.size > 2_000) {
      const oldest = this.permissionAskOwners.keys().next().value;
      if (!oldest) break;
      this.permissionAskOwners.delete(oldest);
    }
  }

  /** Surface a persistently failing permission-responder list/reply call against its task. */
  private handlePermissionResponderError(
    sessionId: string,
    context: "list" | "reply",
    err: unknown,
  ): void {
    const task = this.listTasksForWatcher().find((t) => t.sessionId === sessionId);
    if (!task) return;
    const warning = `Permission auto-responder ${context} call is failing for this session: ${errorMessage(err, "unknown error")}`;
    this.store.addEvent({ taskId: task.id, type: "task_warning", body: { warning } });
  }

  private async watchCompletion(
    taskId: string,
    sessionId: string,
    watcher: CompletionWatcher,
  ): Promise<void> {
    const startedAt = Date.now();
    const stallState: StallTrackingState = {
      lastMessageCount: 0,
      lastProgressAt: startedAt,
      consecutiveFutileNudges: 0,
    };

    try {
      while (!watcher.cancelled) {
        await sleep(COMPLETION_POLL_INTERVAL_MS);
        if (watcher.cancelled) return;

        const task = this.getTaskForWatcher(taskId);
        if (!watcherOwnsTask(watcher, task) || task.sessionId !== sessionId) return;
        if (task.runState !== "running") {
          // complete_task/block_task can update the card before OpenCode has
          // emitted and persisted the provider's final post-tool assistant
          // message. Keep the activity run alive for a short, bounded flush
          // window so Session Chat does not lose that reply until reconnect.
          if (task.completion && Date.now() - task.completion.reportedAt <= 5_000) {
            try {
              const result = await this.client.session.messages({ sessionID: sessionId });
              const messages = (result as { data?: unknown; error?: unknown }).data;
              const current = this.getTaskForWatcher(taskId);
              if (!watcherOwnsTask(watcher, current) || current.sessionId !== sessionId) return;
              if (!(result as { error?: unknown }).error && hasAssistantTurnFinished(messages)) {
                const output = extractFinalOutput(messages);
                if (output) this.recordOpenCodeActivity(taskId, sessionId, { kind: "text", role: "assistant", text: output });
                this.endOpenCodeRun(taskId, current.runStartedAt, current.runState === "error" ? "error" : "complete");
                return;
              }
            } catch {
              // Keep polling within the bounded flush window.
            }
            continue;
          }
          this.endOpenCodeRun(taskId, task.runStartedAt, task.runState === "error" ? "error" : "complete");
          return;
        }

        if (Date.now() - startedAt > COMPLETION_WATCH_TIMEOUT_MS) {
          this.updateTaskForWatcher(taskId, {
            runState: "error",
            error: "Timed out waiting for OpenCode session completion",
          });
          return;
        }

        let messages: unknown;
        try {
          const result = await this.client.session.messages({ sessionID: sessionId });
          if ((result as { error?: unknown }).error) continue;
          messages = (result as { data?: unknown }).data;
        } catch {
          continue;
        }

        const taskAfterMessages = this.getTaskForWatcher(taskId);
        if (!watcherOwnsTask(watcher, taskAfterMessages) || taskAfterMessages.sessionId !== sessionId || taskAfterMessages.runState !== "running") return;

        if (!hasAssistantTurnFinished(messages)) {
          const gaveUp = await this.trackStallAndMaybeNudge(taskId, sessionId, taskAfterMessages, messages, stallState, watcher);
          if (gaveUp) return;
          continue;
        }

        const finalOutput = this.outputCandidates.get(sessionId) ?? extractFinalOutput(messages);

        const beforeFallback = this.getTaskForWatcher(taskId);
        if (!watcherOwnsTask(watcher, beforeFallback) || beforeFallback.sessionId !== sessionId || beforeFallback.runState !== "running") {
          return;
        }

        // A Session Chat turn over a retained Review completion is not a new
        // task attempt. Publish the final reply, restore the card's semantic
        // idle/blocked state, and preserve its existing completion evidence.
        if (beforeFallback.completion) {
          if (finalOutput) this.recordOpenCodeActivity(taskId, sessionId, { kind: "text", role: "assistant", text: finalOutput });
          this.updateTaskForWatcher(taskId, {
            runState: beforeFallback.completion.outcome === "blocked" ? "error" : "idle",
            error: beforeFallback.completion.outcome === "blocked" ? beforeFallback.completion.residualRisk : undefined,
          });
          this.endOpenCodeRun(taskId, beforeFallback.runStartedAt, beforeFallback.completion.outcome === "blocked" ? "error" : "complete");
          return;
        }

        if (await this.blockOnBaseCheckoutEscape(taskId, beforeFallback)) {
          this.endOpenCodeRun(taskId, beforeFallback.runStartedAt, "error");
          return;
        }
        const afterEscapeCheck = this.getTaskForWatcher(taskId);
        if (!watcherOwnsTask(watcher, afterEscapeCheck) || afterEscapeCheck.sessionId !== sessionId || afterEscapeCheck.runState !== "running") return;

        if (
          !this.updateTaskForWatcher(taskId, {
            runState: "idle",
            error: undefined,
            completion: null,
            completionSource: "idle-fallback",
            finalSessionOutput: finalOutput,
          })
        ) {
          return;
        }
        const fresh = this.getTaskForWatcher(taskId);
        if (fresh && (fresh.column === "todo" || fresh.column === "in_progress")) {
          const endOfReview = this.listTasksForWatcher().filter((t) => t.column === "review")
            .length;
          this.moveTaskForWatcher(taskId, "review", endOfReview);
        }
        this.endOpenCodeRun(taskId, beforeFallback.runStartedAt, "complete");
        return;
      }
    } finally {
      const ownsWatcherSlot = this.completionWatchers.get(sessionId) === watcher;
      if (ownsWatcherSlot) {
        this.completionWatchers.delete(sessionId);
        this.outputCandidates.delete(sessionId);
        // Only the watcher still installed for this session owns terminal
        // cleanup. A repeated idle event can replace a watcher without
        // changing the task/run identity; its cancelled predecessor must not
        // tear down the replacement run's watchdog or permission responder.
        const finalTask = this.getTaskForWatcher(taskId);
        const ownsCurrentRun = finalTask?.sessionId === sessionId && finalTask.runStartedAt === watcher.runStartedAt;
        if (ownsCurrentRun) {
          this.stopPermissionResponder(sessionId);
          if (watcher.runStartedAt !== undefined) {
            this.endOpenCodeRun(taskId, watcher.runStartedAt, finalTask.runState === "error" ? "error" : "complete");
          }
        }
      }
    }
  }

  /**
   * A fenced permission denial can leave a session sitting with its last
   * step finished for reason "tool-calls" and never continuing on its own
   * (live-proof finding — recovery-language in the original prompt did not
   * help). Detects that specific stall shape and sends up to
   * MAX_CONSECUTIVE_FUTILE_NUDGES automatic recovery nudges, giving the
   * agent denial-aware guidance when the responder pool recorded one.
   * `consecutiveFutileNudges` resets to 0 on any observed forward progress,
   * so the cap is "N nudges in a row with nothing in between," not a
   * lifetime budget — a prompt with several fenced paths should be able to
   * recover from each denial in turn without exhausting the budget on the
   * second one. Returns true when it gives up and transitions the task to
   * `runState: "error"`; the caller must stop watching in that case.
   */
  private async trackStallAndMaybeNudge(
    taskId: string,
    sessionId: string,
    task: Task,
    messages: unknown,
    stallState: StallTrackingState,
    watcher: CompletionWatcher,
  ): Promise<boolean> {
    const currentCount = Array.isArray(messages) ? messages.length : 0;
    const now = Date.now();

    if (currentCount !== stallState.lastMessageCount) {
      stallState.lastMessageCount = currentCount;
      stallState.lastProgressAt = now;
      stallState.consecutiveFutileNudges = 0;
      return false;
    }

    // Not the specific stuck-after-tool-calls shape — e.g. a legitimately
    // long-running tool call (hasActiveTool) is still normal progress in
    // disguise, not a stall, and must never be nudged into.
    if (!isStalledAfterToolCalls(messages)) return false;

    if (now - stallState.lastProgressAt < this.stallThresholdMs) return false;

    const denial = this.permissionResponderPool.getLastDenial(sessionId);
    const recentDenial = denial && now - denial.deniedAt < DENIAL_RECENCY_WINDOW_MS ? denial : null;

    if (stallState.consecutiveFutileNudges >= MAX_CONSECUTIVE_FUTILE_NUDGES) {
      const error = recentDenial
        ? `Session stalled after ${MAX_CONSECUTIVE_FUTILE_NUDGES} automatic recovery nudges following a permission denial (tool: ${recentDenial.tool}); it did not recover on its own.`
        : `Session stalled after ${MAX_CONSECUTIVE_FUTILE_NUDGES} automatic recovery nudges with no progress; no permission denial was recorded as the cause.`;
      const current = this.getTaskForWatcher(taskId);
      if (!watcherOwnsTask(watcher, current) || current.sessionId !== sessionId || current.runState !== "running") return true;
      this.updateTaskForWatcher(taskId, { runState: "error", error });
      return true;
    }

    const nudgeText = recentDenial
      ? `Your last write was denied because it targeted a path outside your assigned working directory (tool: ${recentDenial.tool}). Redo it using a relative path inside your current working directory, or report via /block if you can't proceed.`
      : `You appear to have stalled. If your last action didn't complete, report what happened now and continue, or report via /complete or /block if you're done.`;

    const attempt = stallState.consecutiveFutileNudges + 1;
    const promptError = await this.prompt(sessionId, nudgeText, task.agent ?? undefined, task.model ?? undefined);
    const afterPrompt = this.getTaskForWatcher(taskId);
    if (!watcherOwnsTask(watcher, afterPrompt) || afterPrompt.sessionId !== sessionId || afterPrompt.runState !== "running") return true;
    stallState.consecutiveFutileNudges = attempt;
    stallState.lastProgressAt = now;

    // Re-baseline the message count to include the nudge's own injected
    // message, so the next tick's progress check requires the assistant to
    // actually respond beyond the nudge itself before resetting the streak.
    try {
      const result = await this.client.session.messages({ sessionID: sessionId });
      if (!(result as { error?: unknown }).error) {
        const freshMessages = (result as { data?: unknown }).data;
        if (Array.isArray(freshMessages)) stallState.lastMessageCount = freshMessages.length;
      }
    } catch {
      // Worst case the nudge's own message is mistaken for progress once —
      // costs one extra stall-threshold wait, not a correctness problem.
    }

    const afterMessages = this.getTaskForWatcher(taskId);
    if (!watcherOwnsTask(watcher, afterMessages) || afterMessages.sessionId !== sessionId || afterMessages.runState !== "running") return true;

    const warning = promptError
      ? `Auto-nudge attempt ${attempt}/${MAX_CONSECUTIVE_FUTILE_NUDGES} failed to send: ${promptError}`
      : recentDenial
        ? `Auto-nudged after a stall following a denied write (tool: ${recentDenial.tool}), attempt ${attempt}/${MAX_CONSECUTIVE_FUTILE_NUDGES}.`
        : `Auto-nudged after ${Math.round(this.stallThresholdMs / 1000)}s with no progress (no known denial cause), attempt ${attempt}/${MAX_CONSECUTIVE_FUTILE_NUDGES}.`;
    this.store.addEvent({ taskId, type: "task_warning", body: { warning } });

    return false;
  }

  /**
   * Re-check the base checkout against its dispatch-time snapshot for a
   * worktree-isolated task. If an escape is detected, marks the task blocked
   * (pending: "base-checkout-escape") with the changed paths instead of
   * letting the normal idle/review transition proceed, and returns true so
   * the caller stops there. Returns false (no state change) when the base
   * repo can't be resolved/checked or no escape is found.
   */
  private async blockOnBaseCheckoutEscape(taskId: string, task: Task): Promise<boolean> {
    try {
      const { escaped, changedPaths } = await detectTaskBaseCheckoutEscape(task);
      if (!escaped) return false;

      const current = this.getTaskForWatcher(taskId);
      if (!sameTaskRun(current, task)) return false;

      markTaskBaseCheckoutEscape(this.store, taskId, changedPaths, {
        completion: null,
        completionSource: null,
      });
      return true;
    } catch {
      // Detector failure shouldn't hang the run indefinitely — fall through
      // to the normal completion path rather than blocking forever on an
      // unrelated git error (e.g. the base repo dir vanished mid-run).
      return false;
    }
  }

  private async watchAcpCompletion(
    taskId: string,
    sessionName: string,
    harness: AcpTaskHarness,
    watcher: CompletionWatcher,
  ): Promise<void> {
    const startedAt = Date.now();
    const runner = this.acpRunners[harness];
    const label = harnessDisplayName(harness);

    try {
      while (!watcher.cancelled) {
        await sleep(COMPLETION_POLL_INTERVAL_MS);
        if (watcher.cancelled) return;

        const task = this.getTaskForWatcher(taskId);
        if (!watcherOwnsTask(watcher, task) || task.harness !== harness || task.harnessSessionName !== sessionName || task.runState !== "running") return;

        if (Date.now() - startedAt > COMPLETION_WATCH_TIMEOUT_MS) {
          this.updateTaskForWatcher(taskId, {
            runState: "error",
            error: `Timed out waiting for ${label} background session completion`,
          });
          return;
        }

        let status;
        try {
          status = await runner.poll(sessionName);
        } catch {
          continue;
        }
        const taskAfterPoll = this.getTaskForWatcher(taskId);
        if (!watcherOwnsTask(watcher, taskAfterPoll) || taskAfterPoll.harness !== harness || taskAfterPoll.harnessSessionName !== sessionName || taskAfterPoll.runState !== "running") return;
        if (!status) continue;

        const metadata: Partial<Omit<Task, "id" | "createdAt">> = {
          harnessStatus: status.status,
          ...(status.cwd ? { harnessCwd: status.cwd } : {}),
        };
        if (status.cwd) {
          const gitInfo = await inspectGitDirectory(status.cwd);
          if (gitInfo.branch) metadata.harnessBranch = gitInfo.branch;
          if (gitInfo.commit) metadata.harnessCommit = gitInfo.commit;
          if (status.cwd !== task.directory && gitInfo.isRepo && gitInfo.branch) {
            metadata.worktreePath = status.cwd;
            metadata.worktreeBranch = gitInfo.branch;
            if (!taskAfterPoll.baseBranch) {
              const taskGitInfo = await inspectGitDirectory(taskAfterPoll.directory);
              if (taskGitInfo.branch) metadata.baseBranch = taskGitInfo.branch;
            }
          }
        }
        const taskAfterInspection = this.getTaskForWatcher(taskId);
        if (!watcherOwnsTask(watcher, taskAfterInspection) || taskAfterInspection.harness !== harness || taskAfterInspection.harnessSessionName !== sessionName || taskAfterInspection.runState !== "running") return;
        this.updateTaskForWatcher(taskId, metadata);
        if (!status.terminal) continue;

        if (status.error) {
          this.updateTaskForWatcher(taskId, {
            runState: "error",
            error: `${label} session ended with status: ${status.error}`,
          });
          return;
        }

        const beforeFallback = this.getTaskForWatcher(taskId);
        if (!watcherOwnsTask(watcher, beforeFallback) || beforeFallback.harness !== harness || beforeFallback.harnessSessionName !== sessionName || beforeFallback.runState !== "running") {
          return;
        }
        if (beforeFallback.completion) {
          this.updateTaskForWatcher(taskId, {
            runState: beforeFallback.completion.outcome === "blocked" ? "error" : "idle",
            error: beforeFallback.completion.outcome === "blocked" ? beforeFallback.completion.residualRisk : undefined,
          });
          return;
        }
        if (await this.blockOnBaseCheckoutEscape(taskId, beforeFallback)) {
          return;
        }
        const afterEscapeCheck = this.getTaskForWatcher(taskId);
        if (!watcherOwnsTask(watcher, afterEscapeCheck) || afterEscapeCheck.harness !== harness || afterEscapeCheck.harnessSessionName !== sessionName || afterEscapeCheck.runState !== "running") return;
        if (
          !this.updateTaskForWatcher(taskId, {
            runState: "idle",
            error: undefined,
            completion: null,
            completionSource: "idle-fallback",
            finalSessionOutput: null,
          })
        ) {
          return;
        }
        const fresh = this.getTaskForWatcher(taskId);
        if (fresh && (fresh.column === "todo" || fresh.column === "in_progress")) {
          const endOfReview = this.listTasksForWatcher().filter((t) => t.column === "review")
            .length;
          this.moveTaskForWatcher(taskId, "review", endOfReview);
        }
        return;
      }
    } finally {
      if (this.completionWatchers.get(sessionName) === watcher) {
        this.completionWatchers.delete(sessionName);
      }
    }
  }

  private getTaskForWatcher(taskId: string): Task | undefined {
    try {
      return this.store.get(taskId);
    } catch {
      return undefined;
    }
  }

  private listTasksForWatcher(): Task[] {
    try {
      return this.store.list();
    } catch {
      return [];
    }
  }

  private updateTaskForWatcher(
    taskId: string,
    patch: Partial<Omit<Task, "id" | "createdAt">>,
  ): Task | undefined {
    try {
      return this.store.update(taskId, patch);
    } catch {
      return undefined;
    }
  }

  private moveTaskForWatcher(taskId: string, column: Task["column"], position: number): void {
    try {
      this.store.move(taskId, column, position);
    } catch {
      // Store lifecycle races should end the watcher silently; foreground route
      // calls still surface their own errors.
    }
  }

  private handleEvent(event: OpencodeEvent): void {
    const sessionId = eventSessionId(event);
    if (!sessionId) return;

    let task = this.store.list().find((t) => t.sessionId === sessionId);
    if (!task) {
      const taskId = this.openCodeSessionToTask.get(sessionId);
      task = taskId ? this.store.get(taskId) : undefined;
    }
    if (!task && (event as { type?: unknown }).type === "session.created") {
      const { parentId } = extractCreatedSessionIds(event);
      const taskId = parentId ? this.openCodeSessionToTask.get(parentId) : undefined;
      task = taskId ? this.store.get(taskId) : undefined;
    }
    if (!task) return;

    this.bindCreatedDescendant(event, task);

    const textOutput = extractTextEndedOutput(event);
    if (textOutput) {
      this.outputCandidates.set(sessionId, textOutput);
      this.recordOpenCodeActivity(task.id, sessionId, { kind: "text", role: "assistant", text: textOutput });
    }

    const normalizedActivity = normalizeActivityFromEvent(event);
    if (normalizedActivity) {
      this.recordOpenCodeActivity(task.id, sessionId, normalizedActivity);
    }

    const liveState = eventLiveState(event);
    if (liveState === null) return;

    switch (liveState) {
      case "running":
        if (this.openCodeRunsByTask.get(task.id)) this.openCodeRunsByTask.get(task.id)!.lastLiveState = "running";
        this.recordOpenCodeActivity(task.id, sessionId, { kind: "status", text: "running" });
        // Only stamp the clock when actually transitioning into running —
        // live events re-assert "running" mid-run and must not reset it.
        this.store.update(
          task.id,
          task.runState === "running"
            ? { runState: "running" }
            : { runState: "running", runStartedAt: Date.now() },
        );
        break;

      case "idle":
        if (this.openCodeRunsByTask.get(task.id)) this.openCodeRunsByTask.get(task.id)!.lastLiveState = "idle";
        this.recordOpenCodeActivity(task.id, sessionId, { kind: "status", text: "idle" });
        // OpenCode can report idle between tool-call steps. Keep the card
        // running until session.messages() shows a final assistant step.
        this.startCompletionWatcher(task.id, sessionId);
        break;

      case "error": {
        const message = this.extractErrorMessage(event);
        if (this.openCodeRunsByTask.get(task.id)) this.openCodeRunsByTask.get(task.id)!.lastLiveState = "error";
        this.store.update(task.id, { runState: "error", error: message });
        this.recordOpenCodeActivity(task.id, sessionId, { kind: "status", text: message });
        this.endOpenCodeRun(task.id, task.runStartedAt, "error");
        this.outputCandidates.delete(sessionId);
        break;
      }

      default:
        break;
    }
  }

  private bindCreatedDescendant(event: OpencodeEvent, task: Task): void {
    const { id, parentId } = extractCreatedSessionIds(event);
    if (!id || !parentId) return;
    const run = this.openCodeRunsByTask.get(task.id);
    if (!run || !run.sessionIds.has(parentId) || run.sessionIds.size >= SESSION_TREE_MAX_SESSIONS) return;
    run.sessionIds.add(id);
    this.openCodeSessionToTask.set(id, task.id);
    // A fenced subagent raises permission asks under its OWN session id; the
    // responder pool only answers sessions it knows about, so attach the
    // child to the root's target or its asks hang until the watchdog trips.
    if (task.sessionId) this.permissionResponderPool.addChildSession(task.sessionId, id);
    this.recordOpenCodeActivity(task.id, id, { kind: "status", text: "session.created", parentSessionId: parentId });
  }

  private extractErrorMessage(event: OpencodeEvent): string {
    const properties = (event as { properties?: unknown }).properties;
    if (properties !== null && typeof properties === "object") {
      const props = properties as Record<string, unknown>;
      const error = props.error;
      if (typeof error === "string") return error;
      if (error !== null && typeof error === "object") {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === "string") return message;
      }
      const message = props.message;
      if (typeof message === "string") return message;
    }
    return "Session reported an error";
  }

  /**
   * Owns the lifetime of one upstream subscription attempt + its retry loop.
   * Exits cleanly once `generation` no longer matches (i.e. `shutdown()` was
   * called, or a newer `start()` superseded this loop).
   */
  private async runConsumeLoop(generation: number): Promise<void> {
    let attempt = 0;

    while (this.running && this.generation === generation) {
      const controller = new AbortController();
      this.upstreamAbort = controller;
      try {
        const result = await this.client.event.subscribe({}, { signal: controller.signal });
        attempt = 0; // reset backoff once a connection succeeds
        if ([...this.openCodeRunsByTask.values()].some((run) => !run.transportLive)) {
          await this.rebuildRunsBeforeLive();
        }

        for await (const event of result.stream) {
          if (!this.running || this.generation !== generation) return;
          try {
            this.handleEvent(event as OpencodeEvent);
          } catch {
            // A single bad event/store failure shouldn't kill the stream.
          }
        }
        // Stream ended normally (server closed it) — fall through to reconnect.
      } catch {
        // Stream errored or was aborted by shutdown()/supersede — fall
        // through to reconnect (the running/generation check below exits
        // cleanly for the abort case).
      } finally {
        if (this.upstreamAbort === controller) this.upstreamAbort = null;
      }
      this.markRunsReconnecting();

      if (!this.running || this.generation !== generation) return;

      attempt += 1;
      const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1), RECONNECT_MAX_DELAY_MS);
      await sleep(delay);
    }
  }
}
