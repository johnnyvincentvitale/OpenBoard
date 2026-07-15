import type { Task } from "../shared";
import { blockedQuestionPresentation } from "../shared/blocked-task";
import { dominantTaskState } from "../shared/lifecycle";
import { formatElapsed, taskStatus } from "./model";
import { permissionAskDetailRows, permissionAskSummary } from "./permission-surface";

/**
 * Canonical lifecycle phases the TUI distinguishes beyond raw run/column state.
 * These bridge task state, completion metadata, and completion source so callers
 * can pick color/icon without re-deriving the logic.
 */
export type TaskLifecyclePhase =
  | "running"
  | "running-no-elapsed"
  | "needs-user-input"
  | "queued"
  | "idle"
  | "blocked"
  | "error"
  | "review-reported-complete"
  | "review-blocked"
  | "review-idle-fallback"
  | "review-error"
  | "review-no-agent-report"
  | "review-manual"
  | "done-accepted-blocked"
  | "done-resolved"
  | "done-user"
  | "done";

export interface TaskLifecycleStatus {
  /** Canonical phase for consumer styling / decision-making. */
  phase: TaskLifecyclePhase;
  /** Glyph from the OpenBoard set (○ △ ▲ ● !). */
  glyph: string;
  /** Primary status label (RUNNING, REVIEW, ERROR, DONE, etc.). */
  label: string;
  /** Secondary phrase such as elapsed time, outcome, or attribution. */
  detail: string;
}

export interface LifecycleDetailRow {
  label: string;
  value: string;
  /** Semantic role so consumers can place/color rows without parsing text. */
  role?:
    | "state"
    | "elapsed"
    | "outcome"
    | "source"
    | "acceptedBy"
    | "error"
    | "pending"
    | "blockedQuestion"
    | "generic";
}

/** The minimal task shape the lifecycle helpers need to inspect. */
export type TaskLifecycleInput = Pick<
  Task,
  "type" | "runState" | "column" | "pending" | "escapeDetectedPaths" | "rebaseConflictPaths" | "runStartedAt" | "completion" | "completionSource" | "completedBy" | "error" | "sessionId"
  | "pendingPermissions" | "resolution"
>;

function normalizeOutcome(outcome: string | undefined): string {
  return (outcome ?? "").toUpperCase();
}

function normalizeDetail(value: string | undefined): string {
  return (value ?? "").toUpperCase();
}

/**
 * Resolve the lifecycle phase plus a human-readable status + detail pair.
 *
 * This is a pure projection: it returns plain data and never creates terminal
 * nodes or reads clocks (callers pass `now`).
 *
 * The precedence order is delegated to the shared `dominantTaskState`
 * projection in `src/shared/lifecycle.ts` so the MCP and TUI cannot diverge.
 * This function maps the shared dominant state to the TUI's more detailed
 * phase set and display strings.
 */
export function taskLifecycleStatus(task: TaskLifecycleInput, now = Date.now()): TaskLifecycleStatus {
  const status = taskStatus(task);
  const base = { glyph: status.glyph, label: status.label };
  const dominant = dominantTaskState(task);

  switch (dominant) {
    case "needs-user-input": {
      const permissionSummary = permissionAskSummary(task, now);
      return {
        phase: "needs-user-input",
        glyph: "◆",
        label: "NEEDS USER INPUT",
        detail: `${permissionSummary!.count} ${permissionSummary!.count === 1 ? "ask" : "asks"} · ${formatElapsed(permissionSummary!.countdownMs ?? 0)} left`,
      };
    }
    case "blocked": {
      const blocked = task.completion?.outcome === "blocked" ? blockedQuestionPresentation(task.completion) : undefined;
      return { phase: "review-blocked", glyph: "▲", label: "REVIEW", detail: blocked?.needsAnswer ? "BLOCKED · NEEDS ANSWER" : "BLOCKED" };
    }
    case "accepted-blocked": {
      const by = task.completedBy ?? "";
      if (task.resolution?.kind === "completed_elsewhere") {
        return { phase: "done-resolved", glyph: "○", label: "DONE", detail: by ? `completed elsewhere · ${by}` : "completed elsewhere" };
      }
      if (task.resolution?.kind === "superseded") {
        return { phase: "done-resolved", glyph: "○", label: "DONE", detail: by ? `superseded · ${by}` : "superseded" };
      }
      return { phase: "done-accepted-blocked", glyph: "○", label: "DONE", detail: by ? `accepted blocked · ${by}` : "accepted blocked" };
    }
    case "running": {
      const elapsed = task.runStartedAt ? formatElapsed(now - task.runStartedAt) : "";
      return {
        phase: elapsed ? "running" : "running-no-elapsed",
        ...base,
        detail: elapsed,
      };
    }
    case "error": {
      return {
        phase: task.column === "review" ? "review-error" : "error",
        ...base,
        detail: normalizeDetail(task.error),
      };
    }
    case "pending": {
      if (task.pending === "git-init") return { phase: "blocked", ...base, detail: "git init required" };
      if (task.pending === "base-checkout-escape") return { phase: "blocked", ...base, detail: "base checkout changed outside worktree" };
      if (task.pending === "rebase-conflict") return { phase: "blocked", ...base, detail: "rebase conflict in worktree" };
      return { phase: "blocked", ...base, detail: "" };
    }
    case "review": {
      if (task.type === "manual") {
        return { phase: "review-manual", ...base, detail: "MANUAL" };
      }
      if (task.completion) {
        const outcome = task.completion.outcome;
        const source = task.completionSource ?? "reported";
        if (outcome === "blocked") {
          const blocked = blockedQuestionPresentation(task.completion);
          return { phase: "review-blocked", ...base, detail: blocked.needsAnswer ? "BLOCKED · NEEDS ANSWER" : normalizeOutcome(outcome) };
        }
        if (source === "idle-fallback") {
          return { phase: "review-idle-fallback", ...base, detail: "UNCONFIRMED" };
        }
        return { phase: "review-reported-complete", ...base, detail: normalizeOutcome(outcome) };
      }
      return { phase: "review-no-agent-report", ...base, detail: "NO AGENT REPORT" };
    }
    case "done": {
      const by = task.completedBy ?? "";
      return by
        ? { phase: "done-user", ...base, detail: by }
        : { phase: "done", ...base, detail: "" };
    }
    case "idle":
      return { phase: "idle", ...base, detail: "" };
    case "queued":
    default:
      return { phase: "queued", ...base, detail: "" };
  }
}

/**
 * A single compact label suitable for a board card meta line.
 *
 * Examples:
 *   "● RUNNING · 4m 12s"
 *   "▲ REVIEW · COMPLETE"
 *   "▲ REVIEW · UNCONFIRMED"
 *   "▲ REVIEW · BLOCKED"
 *   "! ERROR"
 *   "○ DONE · User"
 */
export function compactTaskBoardLabel(task: TaskLifecycleInput, now = Date.now()): string {
  const status = taskLifecycleStatus(task, now);
  if (!status.detail) return `${status.glyph} ${status.label}`;
  return `${status.glyph} ${status.label} · ${status.detail}`;
}

/**
 * Plain detail rows for the Selected panel that expose lifecycle metadata:
 * state, elapsed time while running, completion outcome/source in Review,
 * user signoff attribution in Done, and errors.
 */
export function taskLifecycleDetailRows(task: TaskLifecycleInput, now = Date.now()): LifecycleDetailRow[] {
  const status = taskLifecycleStatus(task, now);
  const rows: LifecycleDetailRow[] = [
    { label: "STATE", value: `${status.glyph} ${status.label}`, role: "state" },
  ];

  for (const row of permissionAskDetailRows(task, now)) {
    rows.push({ ...row, role: "pending" });
  }

  if (task.runState === "running" && status.detail) {
    rows.push({ label: "ELAPSED", value: status.detail, role: "elapsed" });
  }

  if (task.column === "review") {
    if (task.completion) {
      const blocked = task.completion.outcome === "blocked" ? blockedQuestionPresentation(task.completion) : undefined;
      rows.push({
        label: "OUTCOME",
        value: blocked?.needsAnswer ? "BLOCKED · NEEDS ANSWER" : normalizeOutcome(task.completion.outcome),
        role: "outcome",
      });
      if (blocked?.needsAnswer) {
        rows.push({ label: "QUESTION", value: blocked.question, role: "blockedQuestion" });
      }
      rows.push({
        label: "SOURCE",
        value: task.completionSource ?? "reported",
        role: "source",
      });
    } else if (status.phase === "review-no-agent-report") {
      rows.push({ label: "OUTCOME", value: "NO AGENT REPORT", role: "outcome" });
    } else if (status.phase === "review-manual") {
      rows.push({ label: "OUTCOME", value: "MANUAL", role: "outcome" });
    }
  }

  if (task.column === "done" && task.completedBy) {
    rows.push({ label: "ACCEPTED BY", value: task.completedBy, role: "acceptedBy" });
  }

  if (task.column === "done" && task.completion?.outcome === "blocked") {
    const resolution = task.resolution?.kind === "completed_elsewhere"
      ? "COMPLETED ELSEWHERE"
      : task.resolution?.kind === "superseded"
        ? "SUPERSEDED"
        : "ACCEPTED BLOCKED";
    rows.push({ label: "OUTCOME", value: resolution, role: "outcome" });
    rows.push({ label: "SOURCE", value: task.completionSource ?? "reported", role: "source" });
  }

  if (task.runState === "error" && task.error && status.phase !== "review-blocked") {
    rows.push({ label: "ERROR", value: task.error, role: "error" });
  }

  if (task.pending === "git-init") {
    rows.push({ label: "PENDING", value: "git init required", role: "pending" });
  }

  if (task.pending === "base-checkout-escape") {
    const paths = task.escapeDetectedPaths ?? [];
    rows.push({
      label: "PENDING",
      value: paths.length > 0 ? `base checkout escape: ${paths.join(", ")}` : "base checkout escape detected",
      role: "pending",
    });
  }

  if (task.pending === "rebase-conflict") {
    const paths = task.rebaseConflictPaths ?? [];
    rows.push({
      label: "PENDING",
      value: paths.length > 0 ? `rebase conflict: ${paths.join(", ")}` : "rebase conflict in worktree",
      role: "pending",
    });
  }

  return rows;
}
