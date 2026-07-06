import type { Column, Task } from "../shared";

/**
 * Card-level actions that require a second press to confirm before executing.
 * These are bound to single keys in board view (run/retry/abort/move-to-done/archive/delete/discard).
 */
export type ConfirmableAction = "run" | "retry" | "abort" | "move-to-done" | "archive" | "delete" | "discard-worktree";

/** Canonical display order for confirmable actions. */
export const CONFIRMABLE_ACTIONS: readonly ConfirmableAction[] = [
  "run",
  "retry",
  "abort",
  "move-to-done",
  "archive",
  "delete",
  "discard-worktree",
];

/** A pending confirmation waiting for the same action/key on the same task. */
export interface PendingConfirmation {
  action: ConfirmableAction;
  taskId: string;
}

/** The smallest state slice the confirmation helpers need. */
export interface TuiConfirmState {
  pendingConfirmation?: PendingConfirmation;
}

/** Result of asking for or resolving a confirmation. */
export interface ConfirmationResult {
  /** The updated confirmation state. */
  state: TuiConfirmState;
  /** True when the caller should execute the action now. */
  execute: boolean;
}

/**
 * Human-readable copy for confirmation prompts in the Selected/details column.
 */
export interface ConfirmationCopy {
  /** Short headline, e.g. "Run this card?" */
  title: string;
  /** One or two explanatory lines. */
  body: string[];
  /** Hint line showing the key to confirm, e.g. "Press r again to run." */
  confirmHint: string;
}

/**
 * A single confidence/detail row for pre-run inspection.
 */
export interface ConfidenceDetail {
  /** Whether this row is satisfactory. */
  ok: boolean;
  /** Field label, e.g. "Agent" or "Prompt". */
  label: string;
  /** Human-readable value or issue. */
  message: string;
}

function samePending(
  pending: PendingConfirmation | undefined,
  action: ConfirmableAction,
  taskId: string,
): boolean {
  return pending !== undefined && pending.action === action && pending.taskId === taskId;
}

/**
 * Ask the user to confirm an action on the currently-selected task.
 * If the same action is already pending on the same task, this resolves the
 * confirmation and `execute` is true.
 */
export function requestConfirmation(
  state: TuiConfirmState | undefined,
  action: ConfirmableAction,
  taskId: string,
): ConfirmationResult {
  const current = state ?? {};
  if (samePending(current.pendingConfirmation, action, taskId)) {
    return { state: current, execute: true };
  }
  return { state: { pendingConfirmation: { action, taskId } }, execute: false };
}

/**
 * Force the pending confirmation to clear. Safe to call when no confirmation is pending.
 */
export function clearConfirmation(state: TuiConfirmState | undefined): TuiConfirmState {
  const current = state ?? {};
  if (!current.pendingConfirmation) return current;
  return {};
}

/**
 * Clear the pending confirmation when the selected task changes.
 */
export function clearOnSelectionChange(
  state: TuiConfirmState | undefined,
  selectedTaskId: string | undefined,
): TuiConfirmState {
  const current = state ?? {};
  if (!current.pendingConfirmation) return current;
  if (current.pendingConfirmation.taskId !== selectedTaskId) {
    return {};
  }
  return current;
}

/**
 * Clear the pending confirmation when a different command key is pressed.
 * `commandAction` is the action the user just invoked; if it matches the
 * pending action/task, the confirmation stays (requestConfirmation should be
 * used to resolve it).
 */
export function clearOnDifferentCommand(
  state: TuiConfirmState | undefined,
  commandAction: ConfirmableAction,
  taskId: string,
): TuiConfirmState {
  const current = state ?? {};
  if (!current.pendingConfirmation) return current;
  if (current.pendingConfirmation.action === commandAction && current.pendingConfirmation.taskId === taskId) {
    return current;
  }
  return {};
}

/**
 * True when `action` on `taskId` is currently waiting for confirmation.
 */
export function isConfirmationPending(
  state: TuiConfirmState | undefined,
  action: ConfirmableAction,
  taskId: string,
): boolean {
  return samePending(state?.pendingConfirmation, action, taskId);
}

function actionKey(action: ConfirmableAction): string {
  switch (action) {
    case "run":
      return "r";
    case "retry":
      return "R";
    case "abort":
      return "k";
    case "move-to-done":
      return "x";
    case "archive":
      return "a";
    case "delete":
      return "d";
    case "discard-worktree":
      return "D";
  }
}

function actionVerb(action: ConfirmableAction, presentParticiple = false): string {
  switch (action) {
    case "run":
      return presentParticiple ? "running" : "run";
    case "retry":
      return presentParticiple ? "retrying" : "retry";
    case "abort":
      return presentParticiple ? "aborting" : "abort";
    case "move-to-done":
      return presentParticiple ? "moving to Done" : "move to Done";
    case "archive":
      return presentParticiple ? "archiving" : "archive";
    case "delete":
      return presentParticiple ? "deleting" : "delete";
    case "discard-worktree":
      return presentParticiple ? "discarding worktree" : "discard worktree";
  }
}

/**
 * Build the copy for the confirmation prompt shown in the Selected/details column.
 */
export function buildConfirmationCopy(action: ConfirmableAction, task: Pick<Task, "title" | "completion" | "completionSource">): ConfirmationCopy {
  const title = action === "move-to-done"
    ? "Move this card to Done?"
    : action === "discard-worktree"
      ? "Discard this worktree?"
      : `${capitalize(actionVerb(action, true))} this card?`;

  let body: string[];
  switch (action) {
    case "run":
      body = [
        `Dispatch the assigned agent on "${task.title}".`,
        "A git worktree will be created if worktree isolation is enabled.",
      ];
      break;
    case "retry":
      body = [
        `Send a follow-up to the existing session for "${task.title}".`,
        "Use this after editing files or adding context to the prompt.",
      ];
      break;
    case "abort":
      body = [
        `Stop the running session for "${task.title}".`,
        "Use this before archiving or deleting an active card.",
      ];
      break;
    case "move-to-done":
      if (task.completion && task.completionSource === "reported") {
        const verification = task.completion.verification.length
          ? task.completion.verification.map((item) => `${item.command} ${item.result}`).join(", ")
          : "none reported";
        body = [
          `Completion: reported ${task.completion.outcome}`,
          `Verification: ${verification}`,
          `Residual risk: ${task.completion.residualRisk || "none reported"}`,
          "Source: agent-reported",
          "Final user signoff will move the card to Done as accepted by User.",
        ];
      } else {
        body = [
          `Mark "${task.title}" as completed manually.`,
          "The card will move to the Done lane as accepted by User.",
        ];
      }
      break;
    case "archive":
      body = [
        `Move "${task.title}" to the global archive.`,
        "Archived cards are hidden from the active board.",
      ];
      break;
    case "delete":
      body = [
        `Permanently delete "${task.title}".`,
        "This cannot be undone; any running session will be detached.",
        "If a task worktree exists, confirming also removes it and keeps the branch.",
      ];
      break;
    case "discard-worktree":
      body = [
        `Remove the task worktree for "${task.title}".`,
        "The Review card and board/* branch stay in place.",
        "Use this for audit/review cards that should never integrate.",
      ];
      break;
  }

  return {
    title,
    body,
    confirmHint: `Press ${actionKey(action)} again to ${actionVerb(action)}.`,
  };
}

function capitalize(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Inspect a task and return pre-run confidence details for manual run/retry.
 * This is intentionally pure (no file-system or network access) so it can be
 * evaluated during render and in unit tests.
 */
export function buildRunConfidenceDetails(task: Task): ConfidenceDetail[] {
  const details: ConfidenceDetail[] = [];

  if (task.agent) {
    details.push({ ok: true, label: "Agent", message: task.agent });
  } else {
    details.push({ ok: false, label: "Agent", message: "No agent assigned; board default will be used" });
  }

  const prompt = task.description?.trim() ?? "";
  if (!prompt) {
    details.push({ ok: false, label: "Prompt", message: "Empty prompt" });
  } else if (prompt.length < 20) {
    details.push({ ok: false, label: "Prompt", message: `Very short (${pluralize(prompt.length, "char", "chars")})` });
  } else {
    details.push({ ok: true, label: "Prompt", message: `${pluralize(prompt.length, "char", "chars")}` });
  }

  if (task.directory) {
    details.push({ ok: true, label: "Directory", message: task.directory });
  } else {
    details.push({ ok: false, label: "Directory", message: "No directory set" });
  }

  details.push({
    ok: true,
    label: "Isolation",
    message: task.isolation ?? "board default",
  });

  if (task.runState === "running") {
    details.push({ ok: false, label: "Run state", message: "Already running" });
  } else if (task.runState === "error") {
    details.push({ ok: false, label: "Run state", message: "Previous run failed" });
  } else {
    details.push({ ok: true, label: "Run state", message: task.runState });
  }

  if (task.pending) {
    details.push({ ok: false, label: "Pending", message: `Blocked: ${task.pending}` });
  }

  return details;
}

/**
 * Summarise whether the task looks ready to run based on `buildRunConfidenceDetails`.
 */
export function runConfidenceOk(task: Task): boolean {
  return buildRunConfidenceDetails(task).every((detail) => detail.ok);
}

/**
 * Build a one-line summary for the status/command strip when a confirmation is pending.
 */
export function confirmationStatus(action: ConfirmableAction, task: Pick<Task, "title">): string {
  return `${capitalize(actionVerb(action, true))} "${task.title}"? Press ${actionKey(action)} again to confirm.`;
}

/**
 * Helper to format a confidence detail as a single line for compact detail rows.
 */
export function formatConfidenceDetail(detail: ConfidenceDetail): string {
  const glyph = detail.ok ? "○" : "!";
  return `${glyph} ${detail.label}: ${detail.message}`;
}

/**
 * Map a manual command action to the board lane for move-to-done.
 */
export function targetColumnForAction(action: Exclude<ConfirmableAction, "move-to-done">): undefined;
export function targetColumnForAction(action: ConfirmableAction): Column | undefined;
export function targetColumnForAction(action: ConfirmableAction): Column | undefined {
  return action === "move-to-done" ? "done" : undefined;
}
