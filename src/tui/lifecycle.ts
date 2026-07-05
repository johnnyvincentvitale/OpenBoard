import type { Task } from "../shared";
import { formatElapsed, taskStatus } from "./model";

/**
 * Canonical lifecycle phases the TUI distinguishes beyond raw run/column state.
 * These bridge task state, completion metadata, and completion source so callers
 * can pick color/icon without re-deriving the logic.
 */
export type TaskLifecyclePhase =
  | "running"
  | "running-no-elapsed"
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
    | "generic";
}

/** The minimal task shape the lifecycle helpers need to inspect. */
export type TaskLifecycleInput = Pick<
  Task,
  "type" | "runState" | "column" | "pending" | "runStartedAt" | "completion" | "completionSource" | "completedBy" | "error" | "sessionId"
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
 */
export function taskLifecycleStatus(task: TaskLifecycleInput, now = Date.now()): TaskLifecycleStatus {
  const status = taskStatus(task);
  const base = { glyph: status.glyph, label: status.label };

  if (task.runState === "running") {
    const elapsed = task.runStartedAt ? formatElapsed(now - task.runStartedAt) : "";
    return {
      phase: elapsed ? "running" : "running-no-elapsed",
      ...base,
      detail: elapsed,
    };
  }

  if (task.runState === "error") {
    return {
      phase: task.column === "review" ? "review-error" : "error",
      ...base,
      detail: normalizeDetail(task.error),
    };
  }

  if (task.pending === "git-init") {
    return { phase: "blocked", ...base, detail: "git init required" };
  }

  if (task.column === "review") {
    if (task.type === "manual") {
      return { phase: "review-manual", ...base, detail: "MANUAL" };
    }
    if (task.completion) {
      const outcome = task.completion.outcome;
      const source = task.completionSource ?? "reported";
      if (outcome === "blocked") {
        return { phase: "review-blocked", ...base, detail: normalizeOutcome(outcome) };
      }
      if (source === "idle-fallback") {
        return { phase: "review-idle-fallback", ...base, detail: "UNCONFIRMED" };
      }
      return { phase: "review-reported-complete", ...base, detail: normalizeOutcome(outcome) };
    }
    if (task.sessionId) {
      return { phase: "review-no-agent-report", ...base, detail: "NO AGENT REPORT" };
    }
    return { phase: "review-no-agent-report", ...base, detail: "NO AGENT REPORT" };
  }

  if (task.column === "done") {
    const by = task.completedBy ?? "";
    return by
      ? { phase: "done-user", ...base, detail: by }
      : { phase: "done", ...base, detail: "" };
  }

  if (task.runState === "idle") {
    return { phase: "idle", ...base, detail: "" };
  }

  return { phase: "queued", ...base, detail: "" };
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

  if (task.runState === "running" && status.detail) {
    rows.push({ label: "ELAPSED", value: status.detail, role: "elapsed" });
  }

  if (task.column === "review") {
    if (task.completion) {
      rows.push({
        label: "OUTCOME",
        value: normalizeOutcome(task.completion.outcome),
        role: "outcome",
      });
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

  if (task.runState === "error" && task.error) {
    rows.push({ label: "ERROR", value: task.error, role: "error" });
  }

  if (task.pending === "git-init") {
    rows.push({ label: "PENDING", value: "git init required", role: "pending" });
  }

  return rows;
}
