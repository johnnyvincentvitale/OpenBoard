import type { BlockedAcceptance, Task } from "../shared";

export const DONE_POLICY_ATTRIBUTION_MAX_LENGTH = 200;

export type DonePolicyErrorCode =
  | "blocked_acceptance_required"
  | "blocked_acceptance_incomplete"
  | "blocked_acceptance_stale"
  | "blocked_acceptance_attribution_required";

export interface DonePolicyError {
  code: DonePolicyErrorCode;
  message: string;
}

export type DonePolicyResult =
  | { ok: true; acceptedBy?: string; blockedAccepted: boolean }
  | { ok: false; error: DonePolicyError };

export interface DonePolicyInput {
  task: Pick<Task, "completion">;
  blockedAcceptance?: Partial<BlockedAcceptance> | null;
  completedBy?: string | null;
  acceptor?: string | null;
}

export function evaluateDonePolicy(input: DonePolicyInput): DonePolicyResult {
  if (!isCurrentlyBlocked(input.task)) {
    return { ok: true, acceptedBy: normalizeAttribution(input.completedBy ?? input.acceptor), blockedAccepted: false };
  }

  const acceptance = input.blockedAcceptance;
  if (!acceptance) {
    return blockedError("blocked_acceptance_required", "Blocked tasks require explicit incomplete-work acceptance");
  }
  if (acceptance.acceptIncomplete !== true || typeof acceptance.blockedReportedAt !== "number") {
    return blockedError("blocked_acceptance_incomplete", "Blocked acceptance must include acceptIncomplete=true and blockedReportedAt");
  }
  if (acceptance.blockedReportedAt !== input.task.completion?.reportedAt) {
    return blockedError("blocked_acceptance_stale", "Blocked acceptance does not match the current blocked report");
  }

  const acceptedBy = normalizeAttribution(input.completedBy ?? input.acceptor);
  if (!acceptedBy) {
    return blockedError("blocked_acceptance_attribution_required", "Blocked acceptance requires completedBy or acceptor");
  }
  return { ok: true, acceptedBy, blockedAccepted: true };
}

function isCurrentlyBlocked(task: Pick<Task, "completion">): boolean {
  return task.completion?.outcome === "blocked";
}

function normalizeAttribution(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > DONE_POLICY_ATTRIBUTION_MAX_LENGTH) return undefined;
  return trimmed;
}

function blockedError(code: DonePolicyErrorCode, message: string): DonePolicyResult {
  return { ok: false, error: { code, message } };
}
