import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type {
  BlockTaskBody,
  CompleteTaskBody,
  CompletionReport,
  Task,
  TaskRunOutcome,
  TaskStore,
} from "../../shared";
import { AdapterError } from "../../shared/errors";
import { inspectCompletionResult } from "../git-inspect";

const END_OF_COLUMN = Number.POSITIVE_INFINITY;
type CompletionBody = CompleteTaskBody | BlockTaskBody;

export function registerCompletionRoutes(app: Hono, deps: { store: TaskStore }): void {
  app.post("/api/tasks/:id/complete", async (c) => handleCompletion(c, deps.store, "complete"));
  app.post("/api/tasks/:id/block", async (c) => handleCompletion(c, deps.store, "blocked"));
}

async function handleCompletion(
  c: Context,
  store: TaskStore,
  outcome: TaskRunOutcome,
): Promise<Response> {
  const id = c.req.param("id");
  if (!id) return respondWithError(c, AdapterError.notFound("Task not found"));
  try {
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

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw AdapterError.validation("Request body must be valid JSON");
    }

    const payload = parseCompletionBody(body);
    const { finalSessionOutput, ...reportPayload } = payload;
    const report: CompletionReport = { ...reportPayload, outcome, reportedAt: Date.now() };
    const stored = store.setCompletion(id, report, "reported");
    if (!stored) throw AdapterError.notFound(`Task not found: ${id}`);

    const completionMetadata = await completionPatch(task, report);
    const updated = store.update(id, {
      runState: outcome === "complete" ? "idle" : "error",
      error: outcome === "complete" ? undefined : payload.residualRisk,
      finalSessionOutput: task.harness === "claude-code"
        ? null
        : Object.prototype.hasOwnProperty.call(payload, "finalSessionOutput")
          ? finalSessionOutput ?? null
          : task.finalSessionOutput ?? null,
      ...completionMetadata,
      ...(task.harness === "claude-code"
        ? { harnessStatus: outcome === "complete" ? "idle" : "blocked" }
        : {}),
    });
    if (!updated) throw AdapterError.notFound(`Task not found: ${id}`);
    store.addEvent({ taskId: id, type: outcome === "complete" ? "task_completed" : "task_blocked", body: { ...report } });
    if (!isLateIdleFallbackUpgrade && (updated.column === "todo" || updated.column === "in_progress")) {
      store.move(id, "review", END_OF_COLUMN);
    }
    return c.json(store.get(id) ?? updated, 200);
  } catch (err) {
    return respondWithError(c, err);
  }
}

async function completionPatch(
  task: Task,
  report: CompletionReport,
): Promise<Partial<Omit<Task, "id" | "createdAt">>> {
  if (task.harness !== "claude-code") return {};
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

function staleRunMessage(c: Context, runStartedAt: number | undefined): string | undefined {
  const reportRunStartedAt = c.req.query("runStartedAt");
  if (reportRunStartedAt === undefined) return undefined;
  const parsed = Number(reportRunStartedAt);
  if (!Number.isFinite(parsed) || runStartedAt !== parsed) {
    return "Completion report is stale for this task run";
  }
  return undefined;
}

function parseCompletionBody(body: unknown): CompletionBody {
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
  return {
    summary: record.summary,
    changedFiles: record.changedFiles,
    verification: record.verification,
    residualRisk: record.residualRisk,
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

function respondWithError(c: Context, err: unknown): Response {
  const adapterError = err instanceof AdapterError ? err : AdapterError.internal("Unexpected error", err);
  return c.json(adapterError.toEnvelope(), adapterError.status as ContentfulStatusCode);
}
