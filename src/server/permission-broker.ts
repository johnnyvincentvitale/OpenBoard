/**
 * Shared interactive permission broker core (FR08).
 *
 * A harness-agnostic core that turns a provider's native permission ask
 * (an OpenCode `permission.list` entry today; an ACP `session/request_permission`
 * call for a future adapter) into exactly one durable **board ask** — a
 * `PendingPermissionAsk` (src/shared/task.ts) that can be safely projected onto
 * a `Task` and shown to an operator, and a `RespondPermissionInput` reply
 * contract an operator (or a policy timeout) resolves it with.
 *
 * Design invariants this module exists to guarantee:
 *
 * - **One board ask id per native ask.** The native identity (provider +
 *   run + native id) and the closure that actually replies to the provider
 *   never leave this module — they are not present on `PendingPermissionAsk`,
 *   nor on any emitted event.
 * - **Oldest-first, deduplicated pending list.** Resubmitting the same native
 *   identity while it's still active returns the existing board ask id
 *   instead of creating a second one; `listPending()` iterates in submission
 *   order (a `Map` preserves insertion order, and ids are never reinserted).
 * - **Atomic claim.** `respond()` (operator) and the policy timeout both
 *   funnel through `resolve()`, which synchronously flips an ask from
 *   `pending` to `claimed` before ever awaiting the provider reply. Since
 *   JS has no preemption between that check and that flip, a concurrent
 *   second attempt always sees the claimed state and gets a `conflict`
 *   instead of a second reply.
 * - **Explicit provider failure.** If the provider's own reply call throws,
 *   the ask is never marked answered — it's dropped as failed (with a
 *   `permission_reply_failed` event) so a fresh native poll can raise a new
 *   ask for the same request instead of silently pretending it was resolved.
 * - **Injected clock/timer + `clearRun`.** Every timer goes through the
 *   `PermissionBrokerClock` passed in (defaulting to real timers), and every
 *   run (`runId`) has a generation counter bumped by `clearRun()`. A timer
 *   callback checks both "does this ask still exist" and "is this still the
 *   current generation for its run" before acting, so a timer that fires
 *   after its run was cleared (e.g. a retried task reusing the same runId)
 *   is a no-op even if the underlying timer somehow still fires.
 * - **Bounded, display-safe events.** `asked`/`answered`/`reply-failed`
 *   events carry only public-projection fields plus a decision/reason/error,
 *   with summary/patterns/error text truncated to a fixed cap.
 */
import { randomUUID } from "node:crypto";
import type { PendingPermissionAsk, RespondPermissionInput, TaskHarness } from "../shared/task";

const MAX_TEXT_LENGTH = 240;
const MAX_PATTERNS = 8;
const MAX_PROVIDER_REPLY_ATTEMPTS = 3;

export type PermissionAskSource = PendingPermissionAsk["source"];
export type PermissionDecision = RespondPermissionInput["action"];
export type PermissionDecisionReason = "operator" | "policy-timeout";
export type PermissionCancellationReason = "run-cleared" | "run-replaced" | "shutdown";

export interface PermissionBrokerClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

function realSetTimer(callback: () => void, delayMs: number): unknown {
  const timer = setTimeout(callback, delayMs);
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

const realClock: PermissionBrokerClock = {
  now: () => Date.now(),
  setTimer: realSetTimer,
  clearTimer: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

/** Durable, display-safe record of a broker decision — never carries the native id or reply closure. */
export interface PermissionAskEvent {
  type: "permission_asked" | "permission_answered" | "permission_reply_failed" | "permission_cancelled";
  askId: string;
  runId: string;
  taskId?: string;
  runStartedAt?: number;
  providerSessionId?: string;
  harness: TaskHarness;
  source: PermissionAskSource;
  permission: string;
  tool?: string;
  summary: string;
  patterns?: string[];
  raisedAt: number;
  deadline: number;
  occurredAt: number;
  decision?: PermissionDecision;
  reason?: PermissionDecisionReason;
  answeredBy?: string;
  error?: string;
  cancellationReason?: PermissionCancellationReason;
  delivery?: "confirmed" | "failed" | "unknown";
  pendingAfterFailure?: boolean;
}

export interface SubmitAskInput {
  /** Scopes dedupe + clearRun; e.g. an OpenCode sessionID or an ACP session id. */
  runId: string;
  taskId?: string;
  runStartedAt?: number;
  providerSessionId?: string;
  /** The provider's own id for this ask. Kept private to this module. */
  nativeId: string;
  harness: TaskHarness;
  source: PermissionAskSource;
  permission: string;
  tool?: string;
  summary: string;
  patterns?: string[];
  /** Epoch ms (per the injected clock). Policy denies once `clock.now()` reaches this without an operator reply. */
  deadline: number;
  /** Decision used when the deadline expires. Defaults to deny for existing providers. */
  timeoutDecision?: PermissionDecision;
  /** Keep the same board ask pending if the provider reply fails. Defaults false for polling providers. */
  reopenOnReplyFailure?: boolean;
  /** Called at most once per resolution attempt to actually answer the provider. */
  replyToProvider: (decision: PermissionDecision) => Promise<void>;
}

export type RespondOutcome =
  | { ok: true; askId: string; decision: PermissionDecision }
  | { ok: false; askId: string; conflict: "not-found" | "stale" | "already-resolved" | "unsupported-action" | "reply-failed"; error?: string };

export class PermissionActionUnsupportedError extends Error {
  constructor(message = "Provider did not offer an option for this permission action") {
    super(message);
    this.name = "PermissionActionUnsupportedError";
  }
}

export interface PermissionBrokerOptions {
  clock?: PermissionBrokerClock;
  onEvent?: (event: PermissionAskEvent) => void;
  /** Board ask id generator. Defaults to an incrementing `ask_<n>` counter. */
  nextAskId?: () => string;
}

export interface PermissionBroker {
  /** Submit a native ask; returns its board ask id (existing or newly minted). */
  submitAsk(input: SubmitAskInput): string;
  /** Oldest-first pending asks, as the public projection shape, optionally scoped to one run. */
  listPending(runId?: string, harness?: TaskHarness): PendingPermissionAsk[];
  /** Resolve a pending ask (operator path). */
  respond(input: RespondPermissionInput): Promise<RespondOutcome>;
  /** Cancel every timer/ask for a run; guards a same-runId replacement run against late callbacks. */
  clearRun(runId: string, harness?: TaskHarness, reason?: PermissionCancellationReason): void;
  /** Observe lifecycle events without owning or wrapping the broker. */
  subscribe(listener: (event: PermissionAskEvent) => void): () => void;
  /** Stop the broker entirely — clears every run. */
  stop(): void;
}

interface AskRecord {
  askId: string;
  runId: string;
  taskId?: string;
  runStartedAt?: number;
  providerSessionId?: string;
  nativeId: string;
  harness: TaskHarness;
  source: PermissionAskSource;
  permission: string;
  tool?: string;
  summary: string;
  patterns?: string[];
  raisedAt: number;
  deadline: number;
  timeoutDecision: PermissionDecision;
  reopenOnReplyFailure: boolean;
  generation: number;
  replyToProvider: (decision: PermissionDecision) => Promise<void>;
  state: "pending" | "claimed" | "replying" | "answered" | "reply-failed" | "expired" | "cancelled";
  replyAttempts: number;
  timerHandle: unknown;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(max - 1, 0))}…`;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err !== null && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

function identityKey(harness: TaskHarness, runId: string, providerSessionId: string, nativeId: string): string {
  return JSON.stringify([harness, runId, providerSessionId, nativeId]);
}

export function createPermissionBroker(options: PermissionBrokerOptions = {}): PermissionBroker {
  const clock = options.clock ?? realClock;
  const listeners = new Set<(event: PermissionAskEvent) => void>();
  if (options.onEvent) listeners.add(options.onEvent);
  const nextAskId = options.nextAskId ?? (() => `ask_${randomUUID()}`);

  const asks = new Map<string, AskRecord>();
  const byNativeIdentity = new Map<string, string>();
  const runGenerations = new Map<string, number>();

  function runKey(harness: TaskHarness, runId: string): string {
    return JSON.stringify([harness, runId]);
  }

  function generationFor(harness: TaskHarness, runId: string): number {
    return runGenerations.get(runKey(harness, runId)) ?? 0;
  }

  function emit(type: PermissionAskEvent["type"], record: AskRecord, extra?: Partial<PermissionAskEvent>): void {
    const event: PermissionAskEvent = {
      type,
      askId: record.askId,
      runId: record.runId,
      ...(record.taskId ? { taskId: record.taskId } : {}),
      ...(record.runStartedAt !== undefined ? { runStartedAt: record.runStartedAt } : {}),
      ...(record.providerSessionId ? { providerSessionId: record.providerSessionId } : {}),
      harness: record.harness,
      source: record.source,
      permission: record.permission,
      tool: record.tool,
      summary: record.summary,
      patterns: record.patterns,
      raisedAt: record.raisedAt,
      deadline: record.deadline,
      occurredAt: clock.now(),
      ...extra,
    };
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A misbehaving handler must never break the broker.
      }
    }
  }

  function toPublic(record: AskRecord): PendingPermissionAsk {
    return {
      id: record.askId,
      ...(record.taskId ? { taskId: record.taskId } : {}),
      ...(record.runStartedAt !== undefined ? { runStartedAt: record.runStartedAt } : {}),
      ...(record.providerSessionId ? { providerSessionId: record.providerSessionId } : {}),
      harness: record.harness,
      source: record.source,
      permission: record.permission,
      tool: record.tool,
      summary: record.summary,
      patterns: record.patterns,
      raisedAt: record.raisedAt,
      deadline: record.deadline,
    };
  }

  function armTimer(record: AskRecord): void {
    const delay = Math.max(record.deadline - clock.now(), 0);
    record.timerHandle = clock.setTimer(() => onTimeout(record.askId), delay);
  }

  function disarmTimer(record: AskRecord): void {
    if (record.timerHandle !== undefined) {
      clock.clearTimer(record.timerHandle);
      record.timerHandle = undefined;
    }
  }

  function forget(record: AskRecord): void {
    asks.delete(record.askId);
    byNativeIdentity.delete(identityKey(record.harness, record.runId, record.providerSessionId ?? record.runId, record.nativeId));
  }

  function onTimeout(askId: string): void {
    const record = asks.get(askId);
    if (!record) return; // already resolved/removed — a late callback is a no-op.
    if (record.state !== "pending") return;
    if (generationFor(record.harness, record.runId) !== record.generation) return; // run was cleared/replaced.
    void resolve(record, record.timeoutDecision, "policy-timeout");
  }

  async function resolve(
    record: AskRecord,
    decision: PermissionDecision,
    reason: PermissionDecisionReason,
    answeredBy?: string,
  ): Promise<RespondOutcome> {
    if (record.state !== "pending") {
      return { ok: false, askId: record.askId, conflict: "already-resolved" };
    }
    // Atomic claim: synchronous flip before the first await below means a
    // concurrent respond()/timeout racing in the same tick always loses here.
    record.state = "claimed";
    disarmTimer(record);
    record.state = "replying";
    record.replyAttempts += 1;

    try {
      await record.replyToProvider(decision);
    } catch (err) {
      if (asks.get(record.askId) !== record || generationFor(record.harness, record.runId) !== record.generation) {
        return { ok: false, askId: record.askId, conflict: "already-resolved" };
      }
      // Provider failure: drop the ask as failed rather than mark it
      // answered. A fresh native poll re-raising the same request mints a
      // new board ask (submitAsk no longer finds this identity).
      record.state = "reply-failed";
      const pendingAfterFailure = record.reopenOnReplyFailure && record.deadline > clock.now() && record.replyAttempts < MAX_PROVIDER_REPLY_ATTEMPTS;
      if (pendingAfterFailure) {
        record.state = "pending";
        armTimer(record);
      } else {
        forget(record);
      }
      const message = errorText(err);
      emit("permission_reply_failed", record, {
        decision,
        reason,
        answeredBy,
        error: truncate(message, MAX_TEXT_LENGTH),
        delivery: "failed",
        pendingAfterFailure,
      });
      return {
        ok: false,
        askId: record.askId,
        conflict: err instanceof PermissionActionUnsupportedError ? "unsupported-action" : "reply-failed",
        error: message,
      };
    }

    // The run may have been cleared while the provider write was in flight.
    // In that case clearRun already emitted cancellation with unknown delivery;
    // never contradict it with a later "answered" event.
    if (asks.get(record.askId) !== record || generationFor(record.harness, record.runId) !== record.generation) {
      return { ok: false, askId: record.askId, conflict: "already-resolved" };
    }
    record.state = reason === "policy-timeout" ? "expired" : "answered";
    forget(record);
    emit("permission_answered", record, { decision, reason, answeredBy, delivery: "confirmed" });
    return { ok: true, askId: record.askId, decision };
  }

  return {
    submitAsk(input: SubmitAskInput): string {
      const providerSessionId = input.providerSessionId ?? input.runId;
      const key = identityKey(input.harness, input.runId, providerSessionId, input.nativeId);
      const existingId = byNativeIdentity.get(key);
      if (existingId && asks.has(existingId)) return existingId;

      const generation = generationFor(input.harness, input.runId);
      const keyForRun = runKey(input.harness, input.runId);
      if (!runGenerations.has(keyForRun)) runGenerations.set(keyForRun, generation);

      const askId = nextAskId();
      const record: AskRecord = {
        askId,
        runId: input.runId,
        taskId: input.taskId,
        runStartedAt: input.runStartedAt,
        providerSessionId,
        nativeId: input.nativeId,
        harness: input.harness,
        source: input.source,
        permission: input.permission,
        tool: input.tool,
        summary: truncate(input.summary, MAX_TEXT_LENGTH),
        patterns: input.patterns?.slice(0, MAX_PATTERNS).map((pattern) => truncate(pattern, MAX_TEXT_LENGTH)),
        raisedAt: clock.now(),
        deadline: input.deadline,
        timeoutDecision: input.timeoutDecision ?? "deny",
        reopenOnReplyFailure: input.reopenOnReplyFailure ?? false,
        generation,
        replyToProvider: input.replyToProvider,
        state: "pending",
        replyAttempts: 0,
        timerHandle: undefined,
      };
      asks.set(askId, record);
      byNativeIdentity.set(key, askId);
      armTimer(record);
      emit("permission_asked", record);
      return askId;
    },

    listPending(runId?: string, harness?: TaskHarness): PendingPermissionAsk[] {
      const result: PendingPermissionAsk[] = [];
      for (const record of asks.values()) {
        if (record.state !== "pending") continue;
        if (runId !== undefined && record.runId !== runId) continue;
        if (harness !== undefined && record.harness !== harness) continue;
        result.push(toPublic(record));
      }
      return result;
    },

    respond(input: RespondPermissionInput): Promise<RespondOutcome> {
      const record = asks.get(input.askId);
      if (!record) return Promise.resolve({ ok: false, askId: input.askId, conflict: "not-found" });
      return resolve(record, input.action, "operator", input.answeredBy);
    },

    clearRun(runId: string, harness?: TaskHarness, reason: PermissionCancellationReason = "run-cleared"): void {
      const matchingHarnesses = new Set(
        [...asks.values()]
          .filter((record) => record.runId === runId && (harness === undefined || record.harness === harness))
          .map((record) => record.harness),
      );
      if (harness) matchingHarnesses.add(harness);
      for (const matchingHarness of matchingHarnesses) {
        runGenerations.set(runKey(matchingHarness, runId), generationFor(matchingHarness, runId) + 1);
      }
      for (const record of [...asks.values()]) {
        if (record.runId !== runId) continue;
        if (harness !== undefined && record.harness !== harness) continue;
        disarmTimer(record);
        record.state = "cancelled";
        emit("permission_cancelled", record, {
          cancellationReason: reason,
          delivery: "unknown",
        });
        forget(record);
      }
    },

    subscribe(listener: (event: PermissionAskEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    stop(): void {
      for (const record of [...asks.values()]) {
        disarmTimer(record);
        record.state = "cancelled";
        emit("permission_cancelled", record, { cancellationReason: "shutdown", delivery: "unknown" });
        forget(record);
      }
      byNativeIdentity.clear();
      runGenerations.clear();
    },
  };
}
