import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type {
  BlockTaskBody,
  CompleteTaskBody,
  CompletionReport,
  Task,
  TaskRunIdentity,
  TaskRunOutcome,
  TaskStore,
} from "../../shared";
import { AdapterError, deriveTaskAttemptIdentity } from "../../shared";
import { detectTaskBaseCheckoutEscape } from "../base-checkout-escape";
import { inspectCompletionResult } from "../git-inspect";
import { fireChainAdvance, type ChainAdvancer } from "../chain-advancer";

type CompletionBody = CompleteTaskBody | BlockTaskBody;

export interface CompletionRouteDeps {
  store: TaskStore;
  /** Optional so existing callers/tests that don't care about auto-dispatch keep working unchanged. */
  advancer?: ChainAdvancer;
  /** Test seam for deterministically exercising a retry during asynchronous completion inspection. */
  inspectCompletion?: typeof completionPatch;
}

export function registerCompletionRoutes(app: Hono, deps: CompletionRouteDeps): void {
  app.post("/api/tasks/:id/complete", async (c) => handleCompletion(c, deps, "complete"));
  app.post("/api/tasks/:id/block", async (c) => handleCompletion(c, deps, "blocked"));
}

async function handleCompletion(
  c: Context,
  deps: CompletionRouteDeps,
  outcome: TaskRunOutcome,
): Promise<Response> {
  const store = deps.store;
  const id = c.req.param("id");
  if (!id) throw AdapterError.notFound("Task not found");
  const task = store.get(id);
  if (!task) throw AdapterError.notFound(`Task not found: ${id}`);
  const staleMessage = staleRunMessage(c, task.runStartedAt);
  if (staleMessage) {
    return c.json(
      { error: { code: "validation", message: staleMessage } },
      409 as ContentfulStatusCode,
    );
  }
  const isLateIdleFallbackUpgrade =
    task.runState !== "running" &&
    task.column === "review" &&
    task.completionSource === "idle-fallback" &&
    task.completion == null;
  if (task.runState !== "running" && !isLateIdleFallbackUpgrade) {
    return c.json(
      { error: { code: "validation", message: "Task is not running" } },
      409 as ContentfulStatusCode,
    );
  }
  const expectedRun: TaskRunIdentity = {
    runStartedAt: task.runStartedAt,
    sessionId: task.sessionId,
    harnessSessionId: task.harnessSessionId,
    harnessSessionName: task.harnessSessionName,
  };

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw AdapterError.validation("Request body must be valid JSON");
  }

  const payload = parseCompletionBody(body, outcome);
  const { finalSessionOutput, ...reportPayload } = payload;
  const report: CompletionReport = { ...reportPayload, outcome, reportedAt: Date.now() };

  const attempt = deriveTaskAttemptIdentity(task);

  const escapeCheck = await detectTaskBaseCheckoutEscape(task);
  const completionMetadata = await (deps.inspectCompletion ?? completionPatch)(task, report);
  const finalOutput = isAcpHarness(task)
    ? null
    : Object.prototype.hasOwnProperty.call(payload, "finalSessionOutput")
      ? finalSessionOutput ?? null
      : task.finalSessionOutput ?? null;
  const commit = store.commitTaskCompletion({
    taskId: id,
    expectedRun,
    expectedMode: isLateIdleFallbackUpgrade ? "idle-fallback" : "running",
    report,
    patch: escapeCheck.escaped
      ? {
          runState: "idle",
          pending: "base-checkout-escape",
          escapeDetectedPaths: escapeCheck.changedPaths,
          error: undefined,
          finalSessionOutput: finalOutput,
          ...completionMetadata,
          ...(isAcpHarness(task) ? { harnessStatus: "blocked" } : {}),
        }
      : {
          runState: outcome === "complete" ? "idle" : "error",
          error: outcome === "complete" ? undefined : payload.residualRisk,
          finalSessionOutput: finalOutput,
          ...completionMetadata,
          ...(isAcpHarness(task)
            ? { harnessStatus: outcome === "complete" ? "idle" : "blocked" }
            : {}),
        },
    moveToReview: !escapeCheck.escaped && !isLateIdleFallbackUpgrade,
    event: escapeCheck.escaped
      ? {
          type: "task_blocked",
          body: {
            ...(attempt ? { attempt } : {}),
            ...report,
            pending: "base-checkout-escape",
            escapeDetectedPaths: escapeCheck.changedPaths,
          },
        }
      : {
          type: outcome === "complete" ? "task_completed" : "task_blocked",
          body: { ...(attempt ? { attempt } : {}), ...report },
        },
  });
  if (commit.status === "missing") throw AdapterError.notFound(`Task not found: ${id}`);
  if (commit.status === "stale") {
    return c.json(
      { error: { code: "validation", message: "Completion report is stale for this task run" } },
      409 as ContentfulStatusCode,
    );
  }

  if (outcome === "complete" && !escapeCheck.escaped) {
    void fireChainAdvance(deps.advancer, store, id);
  }
  return c.json(commit.task, 200);
}

async function completionPatch(
  task: Task,
  report: CompletionReport,
): Promise<Partial<Omit<Task, "id" | "createdAt">>> {
  if (!isAcpHarness(task)) return {};
  const inspected = await inspectCompletionResult(task, report);
  return {
    completionLocation: inspected.completionLocation,
    ...(inspected.harnessCwd ? { harnessCwd: inspected.harnessCwd } : {}),
    ...(inspected.harnessBranch ? { harnessBranch: inspected.harnessBranch } : {}),
    ...(inspected.harnessCommit ? { harnessCommit: inspected.harnessCommit } : {}),
    ...(inspected.worktreePath ? { worktreePath: inspected.worktreePath } : {}),
    ...(inspected.worktreeBranch ? { worktreeBranch: inspected.worktreeBranch } : {}),
    ...(inspected.baseBranch ? { baseBranch: inspected.baseBranch } : {}),
  };
}

function isAcpHarness(task: Pick<Task, "harness">): boolean {
  return task.harness !== undefined && task.harness !== "opencode";
}

function staleRunMessage(c: Context, runStartedAt: number | undefined): string | undefined {
  const reportRunStartedAt = c.req.query("runStartedAt");
  if (reportRunStartedAt === undefined) return undefined;
  const parsed = Number(reportRunStartedAt);
  if (!Number.isFinite(parsed) || runStartedAt !== parsed) {
    return "Completion report is stale for this task run";
  }
  return undefined;
}

function parseCompletionBody(body: unknown, outcome: TaskRunOutcome): CompletionBody {
  if (body === null || typeof body !== "object") {
    throw AdapterError.validation("Request body must be an object");
  }
  const record = body as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, "summary") || typeof record.summary !== "string") {
    throw AdapterError.validation("summary must be a string");
  }
  if (
    !Object.prototype.hasOwnProperty.call(record, "changedFiles") ||
    !Array.isArray(record.changedFiles) ||
    !record.changedFiles.every((file) => typeof file === "string")
  ) {
    throw AdapterError.validation("changedFiles must be an array of strings");
  }
  if (
    !Object.prototype.hasOwnProperty.call(record, "verification") ||
    !Array.isArray(record.verification) ||
    !record.verification.every(isVerification)
  ) {
    throw AdapterError.validation("verification must be an array of { command, result }");
  }
  if (
    !Object.prototype.hasOwnProperty.call(record, "residualRisk") ||
    typeof record.residualRisk !== "string"
  ) {
    throw AdapterError.validation("residualRisk must be a string");
  }
  if (
    Object.prototype.hasOwnProperty.call(record, "finalSessionOutput") &&
    record.finalSessionOutput !== null &&
    typeof record.finalSessionOutput !== "string"
  ) {
    throw AdapterError.validation("finalSessionOutput must be a string or null");
  }
  const hasNeedsInput = Object.prototype.hasOwnProperty.call(record, "needsInput");
  if (hasNeedsInput && outcome === "complete") {
    throw AdapterError.validation("needsInput is only valid for blocked reports");
  }
  let needsInput: string | undefined;
  if (hasNeedsInput) {
    if (typeof record.needsInput !== "string") {
      throw AdapterError.validation("needsInput must be a string");
    }
    needsInput = record.needsInput.trim();
    if (needsInput.length < 1 || needsInput.length > 2000) {
      throw AdapterError.validation("needsInput must be 1..2000 characters");
    }
  }
  return {
    summary: record.summary,
    changedFiles: record.changedFiles,
    verification: record.verification,
    residualRisk: record.residualRisk,
    ...(needsInput !== undefined ? { needsInput } : {}),
    ...(Object.prototype.hasOwnProperty.call(record, "finalSessionOutput")
      ? { finalSessionOutput: record.finalSessionOutput as string | null }
      : {}),
  };
}

function isVerification(value: unknown): value is CompletionBody["verification"][number] {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.command === "string" && typeof record.result === "string";
}
