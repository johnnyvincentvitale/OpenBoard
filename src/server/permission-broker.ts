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
import type { PendingPermissionAsk, RespondPermissionInput, TaskHarness } from "../shared/task";

const MAX_TEXT_LENGTH = 240;
const MAX_PATTERNS = 8;

export type PermissionAskSource = PendingPermissionAsk["source"];
export type PermissionDecision = RespondPermissionInput["action"];
export type PermissionDecisionReason = "operator" | "policy-timeout";

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
  type: "permission_asked" | "permission_answered" | "permission_reply_failed";
  askId: string;
  runId: string;
  harness: TaskHarness;
  source: PermissionAskSource;
  permission: string;
  tool?: string;
  summary: string;
  occurredAt: number;
  decision?: PermissionDecision;
  reason?: PermissionDecisionReason;
  answeredBy?: string;
  error?: string;
}

export interface SubmitAskInput {
  /** Scopes dedupe + clearRun; e.g. an OpenCode sessionID or an ACP session id. */
  runId: string;
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
  | { ok: false; askId: string; conflict: "not-found" | "already-resolved" | "reply-failed"; error?: string };

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
  listPending(runId?: string): PendingPermissionAsk[];
  /** Resolve a pending ask (operator path). */
  respond(input: RespondPermissionInput): Promise<RespondOutcome>;
  /** Cancel every timer/ask for a run; guards a same-runId replacement run against late callbacks. */
  clearRun(runId: string): void;
  /** Stop the broker entirely — clears every run. */
  stop(): void;
}

interface AskRecord {
  askId: string;
  runId: string;
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
  state: "pending" | "claimed";
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

function identityKey(harness: TaskHarness, runId: string, nativeId: string): string {
  return JSON.stringify([harness, runId, nativeId]);
}

export function createPermissionBroker(options: PermissionBrokerOptions = {}): PermissionBroker {
  const clock = options.clock ?? realClock;
  const onEvent = options.onEvent;
  let askCounter = 0;
  const nextAskId = options.nextAskId ?? (() => `ask_${++askCounter}`);

  const asks = new Map<string, AskRecord>();
  const byNativeIdentity = new Map<string, string>();
  const runGenerations = new Map<string, number>();

  function generationFor(runId: string): number {
    return runGenerations.get(runId) ?? 0;
  }

  function emit(type: PermissionAskEvent["type"], record: AskRecord, extra?: Partial<PermissionAskEvent>): void {
    if (!onEvent) return;
    const event: PermissionAskEvent = {
      type,
      askId: record.askId,
      runId: record.runId,
      harness: record.harness,
      source: record.source,
      permission: record.permission,
      tool: record.tool,
      summary: record.summary,
      occurredAt: clock.now(),
      ...extra,
    };
    try {
      onEvent(event);
    } catch {
      // A misbehaving handler must never break the broker.
    }
  }

  function toPublic(record: AskRecord): PendingPermissionAsk {
    return {
      id: record.askId,
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
    byNativeIdentity.delete(identityKey(record.harness, record.runId, record.nativeId));
  }

  function onTimeout(askId: string): void {
    const record = asks.get(askId);
    if (!record) return; // already resolved/removed — a late callback is a no-op.
    if (record.state !== "pending") return;
    if (generationFor(record.runId) !== record.generation) return; // run was cleared/replaced.
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

    try {
      await record.replyToProvider(decision);
    } catch (err) {
      // Provider failure: drop the ask as failed rather than mark it
      // answered. A fresh native poll re-raising the same request mints a
      // new board ask (submitAsk no longer finds this identity).
      if (record.reopenOnReplyFailure) {
        record.state = "pending";
        if (reason === "operator" && record.deadline > clock.now()) armTimer(record);
      } else {
        forget(record);
      }
      const message = errorText(err);
      emit("permission_reply_failed", record, { decision, reason, answeredBy, error: truncate(message, MAX_TEXT_LENGTH) });
      return { ok: false, askId: record.askId, conflict: "reply-failed", error: message };
    }

    forget(record);
    emit("permission_answered", record, { decision, reason, answeredBy });
    return { ok: true, askId: record.askId, decision };
  }

  return {
    submitAsk(input: SubmitAskInput): string {
      const key = identityKey(input.harness, input.runId, input.nativeId);
      const existingId = byNativeIdentity.get(key);
      if (existingId && asks.has(existingId)) return existingId;

      const generation = generationFor(input.runId);
      if (!runGenerations.has(input.runId)) runGenerations.set(input.runId, generation);

      const askId = nextAskId();
      const record: AskRecord = {
        askId,
        runId: input.runId,
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
        timerHandle: undefined,
      };
      asks.set(askId, record);
      byNativeIdentity.set(key, askId);
      armTimer(record);
      emit("permission_asked", record);
      return askId;
    },

    listPending(runId?: string): PendingPermissionAsk[] {
      const result: PendingPermissionAsk[] = [];
      for (const record of asks.values()) {
        if (record.state !== "pending") continue;
        if (runId !== undefined && record.runId !== runId) continue;
        result.push(toPublic(record));
      }
      return result;
    },

    respond(input: RespondPermissionInput): Promise<RespondOutcome> {
      const record = asks.get(input.askId);
      if (!record) return Promise.resolve({ ok: false, askId: input.askId, conflict: "not-found" });
      return resolve(record, input.action, "operator", input.answeredBy);
    },

    clearRun(runId: string): void {
      runGenerations.set(runId, generationFor(runId) + 1);
      for (const record of [...asks.values()]) {
        if (record.runId !== runId) continue;
        disarmTimer(record);
        forget(record);
      }
    },

    stop(): void {
      for (const record of asks.values()) {
        disarmTimer(record);
      }
      asks.clear();
      byNativeIdentity.clear();
      runGenerations.clear();
    },
  };
}
