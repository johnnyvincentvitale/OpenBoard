/**
 * OpenCode adapter over the shared permission broker (src/server/permission-broker.ts)
 * for worktree-fenced sessions' `external_directory` asks.
 *
 * `WRITE_FENCED_PERMISSION` (src/shared/task.ts) puts OpenCode's built-in
 * Location boundary into "ask" mode for a worktree session. Left unanswered,
 * that ask would hang the unattended run forever, so this pool polls
 * `client.permission.list` for pending requests on each registered session's
 * directory, figures out which tool raised each one, and decides: read-class
 * tools get approved ("once") directly, everything else — including a tool
 * we can't identify — is submitted to the broker as a board ask, which
 * denies ("reject") it once `interactiveTimeoutMs` elapses without an
 * operator reply. Default `interactiveTimeoutMs` is 0, so a caller that
 * never wires an operator reply sees the same "deny almost immediately"
 * behavior as before the broker existed. `listPending()`/`respond()` on the
 * returned pool delegate to this pool's own broker instance, so a dispatcher
 * or HTTP route can list/answer these asks directly once it's wired up.
 *
 * A single shared poll loop serves every currently-registered session — not
 * one independent timer per session — so N concurrent worktree tasks cost
 * one recurring tick that visits N targets, not N overlapping timers each
 * hitting the OpenCode API on their own schedule.
 *
 * `list`/`reply` failures are reported via `onError` (once per failure
 * streak, not on every failing tick) instead of being silently swallowed —
 * a persistently unreachable OpenCode server should be visible, not just
 * retried forever with no trace. A broker-reported reply failure surfaces
 * through the same `onError` channel under the "reply" context, and — since
 * that failure means the request was never actually answered — releases the
 * request from this target's `replied` set so a later poll re-raises it
 * (via a fresh broker ask, for the broker path) instead of ignoring it
 * forever. `onPermissionEvent`, if provided, additionally receives every
 * raw broker event (asked/answered/reply-failed) for external persistence.
 *
 * The `permission.v2.asked` event exists but a bare subscribe-then-prompt
 * race can leave an ask unanswered indefinitely (proven in the Phase 0
 * probe), so polling is the only mechanism relied on here.
 *
 * `getLastDenial(sessionID)` exposes the most recent denial per session so a
 * caller (the dispatcher's stall-recovery nudge) can tell the agent what was
 * denied and how to proceed, instead of a generic "you seem stuck" prompt.
 *
 * `register()`/`unregister()` both clear the broker's state for that
 * sessionID first, so a session id reused by a retried run never inherits a
 * stale pending ask or a late timer callback from the prior registration.
 * `register()`'s optional `source` classifies asks raised for that session
 * (worktree-fence vs in-place-override) for a downstream dispatcher; it
 * defaults to "worktree-fence", this adapter's only source historically.
 */
import type { OpencodeHandle } from "./opencode";
import {
  createPermissionBroker,
  type PermissionAskEvent,
  type PermissionAskSource,
  type PermissionBroker,
  type RespondOutcome,
} from "./permission-broker";
import type { PendingPermissionAsk, RespondPermissionInput } from "../shared/task";

type PermissionClient = OpencodeHandle["client"]["permission"];
type SessionClient = OpencodeHandle["client"]["session"];

const READ_TOOLS = new Set(["read", "glob", "grep", "list"]);

const DEFAULT_POLL_INTERVAL_MS = 250;
/** Back-compat default: deny a non-read ask almost immediately, same as before the broker existed. */
const DEFAULT_INTERACTIVE_TIMEOUT_MS = 0;
/** Back-compat default for a pending request that (in tests, or an older SDK) carries no `permission` field of its own. */
const DEFAULT_PERMISSION_TYPE = "external_directory";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Pending permission request shape actually needed here (subset of the SDK's PermissionRequest). */
interface PendingRequest {
  id: string;
  sessionID: string;
  /** The SDK's own permission kind (e.g. "external_directory", "bash"). Projected through the broker as-is. */
  permission?: string;
  /** Bounded glob-style patterns the SDK attaches to the request. Projected through the broker (which truncates/caps them) — never `metadata` or raw commands. */
  patterns?: string[];
  tool?: { messageID: string; callID: string };
}

function asPendingRequests(data: unknown): PendingRequest[] {
  if (!Array.isArray(data)) return [];
  return data.filter(
    (item): item is PendingRequest =>
      item !== null && typeof item === "object" && typeof (item as { id?: unknown }).id === "string",
  );
}

/**
 * Find the `.tool` field of the message part matching `callID`, by scanning
 * the session's messages for a tool part with that call id. Returns
 * undefined when the message/part can't be found — callers must fail closed
 * on that, not assume it's safe.
 */
function findToolName(messages: unknown, messageID: string, callID: string): string | undefined {
  if (!Array.isArray(messages)) return undefined;

  for (const message of messages) {
    if (message === null || typeof message !== "object") continue;
    const info = (message as { info?: unknown }).info;
    const infoId = info !== null && typeof info === "object" ? (info as Record<string, unknown>).id : undefined;
    if (infoId !== messageID) continue;

    const parts = (message as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (part === null || typeof part !== "object") continue;
      const record = part as Record<string, unknown>;
      if (record.type !== "tool") continue;
      if (record.callID !== callID) continue;
      const tool = record.tool;
      if (typeof tool === "string") return tool;
    }
  }

  return undefined;
}

export type PermissionResponderErrorContext = "list" | "reply";

export interface PermissionResponderPoolOptions {
  client: { permission: PermissionClient; session: SessionClient };
  /** Default 250ms — proven reliable in the Phase 0 live probe. */
  pollIntervalMs?: number;
  /**
   * How long a non-read-class ask waits, via the broker, for an operator
   * reply before the existing fail-closed policy denies it automatically.
   * Default 0 preserves pre-broker behavior (deny almost immediately, no
   * wait) — raise this once a caller actually wires an operator reply path.
   */
  interactiveTimeoutMs?: number;
  /**
   * Called on the first consecutive `list`/`reply` failure for a registered
   * session (not on every failing tick, to avoid spamming a caller that logs
   * or records a task event once per streak) and again if that session
   * recovers and then fails again. Never called for a "tool name couldn't be
   * resolved" fail-closed deny — that's a deliberate security decision, not
   * an operational failure. Errors thrown by this callback are swallowed;
   * they must never be able to break the poll loop.
   */
  onError?: (sessionID: string, context: PermissionResponderErrorContext, error: unknown) => void;
  /**
   * Called for every broker event (`permission_asked`/`permission_answered`/
   * `permission_reply_failed`) across every registered session, so a caller
   * can persist a bounded, display-safe event history (e.g. as durable task
   * events) without reaching into the pool's internals. Never carries a
   * native provider id — same public shape the broker itself emits. Errors
   * thrown by this callback are swallowed, like `onError`.
   */
  onPermissionEvent?: (event: PermissionAskEvent) => void;
}

/** Info about the most recently denied ask for a session — lets a caller give recovery guidance. */
export interface DenialInfo {
  tool: string;
  deniedAt: number;
}

export interface PermissionResponderPool {
  /**
   * Start (or restart, discarding prior state) responding to asks for this
   * session. `source` classifies asks raised for this session (defaults to
   * "worktree-fence", the only source this adapter has produced historically)
   * for a downstream dispatcher that distinguishes worktree-fenced runs from
   * in-place overrides; it does not change polling/reply behavior.
   */
  register(sessionID: string, directory: string, options?: { source?: PermissionAskSource }): void;
  /** Stop responding to asks for this session and free its state. */
  unregister(sessionID: string): void;
  /** Stop the pool's poll loop entirely and free all state. */
  stop(): void;
  /** The most recent denial for this session, or null if none/not registered. */
  getLastDenial(sessionID: string): DenialInfo | null;
  /** Oldest-first pending asks from this pool's broker, optionally scoped to one session/run. */
  listPending(runId?: string): PendingPermissionAsk[];
  /** Resolve a pending ask on this pool's broker (operator path). */
  respond(input: RespondPermissionInput): Promise<RespondOutcome>;
}

interface TargetState {
  directory: string;
  /** requestIDs already handled (approved or submitted to the broker), scoped to this target so it's freed on unregister(). */
  replied: Set<string>;
  /** Whether the most recent list attempt for this target failed — gates onError de-dup for list failures. */
  failingList: boolean;
  /** Whether the most recent reply attempt for this target failed — gates onError de-dup for reply failures independently of list failures. */
  failingReply: boolean;
  /** Most recent denial for this target, so a caller can give the agent recovery guidance. */
  lastDenial: DenialInfo | null;
  /** Source classification applied to every broker ask raised for this session. */
  source: PermissionAskSource;
  /**
   * Board ask id -> native request id, for asks currently pending in the
   * broker. Kept private to this target (never exposed publicly) so a
   * `permission_reply_failed` event — which only carries the askId — can
   * release the matching request from `replied`, making it eligible for a
   * later poll to re-raise. Cleaned up on answer, on reply failure, and
   * implicitly on register()/unregister() (a fresh TargetState replaces this
   * one).
   */
  pendingAskNativeIds: Map<string, string>;
}

/** Create a pool that polls `client.permission.list` once per tick for every registered session. */
export function createPermissionResponderPool(options: PermissionResponderPoolOptions): PermissionResponderPool {
  const { client, onError, onPermissionEvent } = options;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const interactiveTimeoutMs = options.interactiveTimeoutMs ?? DEFAULT_INTERACTIVE_TIMEOUT_MS;
  const targets = new Map<string, TargetState>();
  let stopped = false;

  const broker: PermissionBroker = createPermissionBroker({
    onEvent: (event) => handleBrokerEvent(event),
  });

  void runLoop();

  function handleBrokerEvent(event: PermissionAskEvent): void {
    if (onPermissionEvent) {
      try {
        onPermissionEvent(event);
      } catch {
        // A misbehaving handler must not be able to break the poll loop.
      }
    }

    const state = targets.get(event.runId);
    if (!state) return; // unregistered/cleared mid-flight; nothing left to update.
    if (event.type === "permission_answered") {
      state.pendingAskNativeIds.delete(event.askId);
      reportRecovery(state, "reply");
      if (event.decision === "deny") {
        state.lastDenial = { tool: event.tool ?? "unknown", deniedAt: event.occurredAt };
      }
    } else if (event.type === "permission_reply_failed") {
      const nativeId = state.pendingAskNativeIds.get(event.askId);
      state.pendingAskNativeIds.delete(event.askId);
      // Provider reply failed: the request was never actually answered, so
      // release it from `replied` — a later poll must be able to see it
      // again (via the broker, which already forgot this askId) instead of
      // the suppression permanently hiding it.
      if (nativeId !== undefined) state.replied.delete(nativeId);
      reportFailure(event.runId, "reply", state, new Error(event.error ?? "reply failed"));
    }
  }

  async function runLoop(): Promise<void> {
    while (!stopped) {
      await sleep(pollIntervalMs);
      if (stopped) return;

      // Snapshot so a register()/unregister() call triggered mid-tick (e.g.
      // from a dispatcher event handler) can't mutate the map while it's
      // being iterated.
      for (const [sessionID, state] of [...targets.entries()]) {
        if (stopped) return;
        if (!targets.has(sessionID)) continue; // unregistered mid-tick
        await processTarget(sessionID, state);
      }
    }
  }

  async function processTarget(sessionID: string, state: TargetState): Promise<void> {
    let pending: PendingRequest[];
    try {
      const result = await client.permission.list({ directory: state.directory });
      if ((result as { error?: unknown }).error) throw (result as { error?: unknown }).error;
      pending = asPendingRequests((result as { data?: unknown }).data);
    } catch (err) {
      reportFailure(sessionID, "list", state, err);
      return;
    }
    reportRecovery(state, "list");

    for (const request of pending) {
      if (stopped || !targets.has(sessionID)) return;
      if (request.sessionID !== sessionID) continue;
      if (state.replied.has(request.id)) continue;

      const toolName = await resolveToolName(sessionID, state.directory, request);
      const isReadClass = toolName !== undefined && READ_TOOLS.has(toolName);

      // Mark handled before any reply/broker submission so a slow reply — or
      // a still-pending broker ask — can't race a subsequent poll into
      // double-processing the same request.
      state.replied.add(request.id);

      if (isReadClass) {
        try {
          const result = await client.permission.reply({
            requestID: request.id,
            directory: state.directory,
            reply: "once",
          });
          if ((result as { error?: unknown }).error) throw (result as { error?: unknown }).error;
          reportRecovery(state, "reply");
        } catch (err) {
          // Never actually replied: release the suppression so a later poll
          // sees this request again instead of permanently ignoring it.
          state.replied.delete(request.id);
          reportFailure(sessionID, "reply", state, err);
        }
        continue;
      }

      const askId = broker.submitAsk({
        runId: sessionID,
        nativeId: request.id,
        harness: "opencode",
        source: state.source,
        permission: request.permission ?? DEFAULT_PERMISSION_TYPE,
        tool: toolName,
        patterns: request.patterns,
        summary: toolName
          ? `Tool "${toolName}" requested a permission this worktree fence denies by default.`
          : "Permission request with unresolved tool identity.",
        deadline: Date.now() + interactiveTimeoutMs,
        replyToProvider: async (decision) => {
          const result = await client.permission.reply({
            requestID: request.id,
            directory: state.directory,
            reply: decision === "allow_once" ? "once" : "reject",
          });
          if ((result as { error?: unknown }).error) throw (result as { error?: unknown }).error;
        },
      });
      state.pendingAskNativeIds.set(askId, request.id);
    }
  }

  function reportFailure(sessionID: string, context: PermissionResponderErrorContext, state: TargetState, err: unknown): void {
    const alreadyFailing = context === "list" ? state.failingList : state.failingReply;
    if (alreadyFailing) return;
    if (context === "list") state.failingList = true;
    else state.failingReply = true;
    if (!onError) return;
    try {
      onError(sessionID, context, err);
    } catch {
      // A misbehaving handler must not be able to break the poll loop.
    }
  }

  function reportRecovery(state: TargetState, context: PermissionResponderErrorContext): void {
    if (context === "list") state.failingList = false;
    else state.failingReply = false;
  }

  async function resolveToolName(sessionID: string, directory: string, request: PendingRequest): Promise<string | undefined> {
    if (!request.tool) return undefined;
    try {
      const result = await client.session.messages({ sessionID, directory });
      if ((result as { error?: unknown }).error) return undefined;
      const messages = (result as { data?: unknown }).data;
      return findToolName(messages, request.tool.messageID, request.tool.callID);
    } catch {
      return undefined;
    }
  }

  return {
    register(sessionID: string, directory: string, registerOptions?: { source?: PermissionAskSource }): void {
      broker.clearRun(sessionID);
      targets.set(sessionID, {
        directory,
        replied: new Set(),
        failingList: false,
        failingReply: false,
        lastDenial: null,
        source: registerOptions?.source ?? "worktree-fence",
        pendingAskNativeIds: new Map(),
      });
    },
    unregister(sessionID: string): void {
      broker.clearRun(sessionID);
      targets.delete(sessionID);
    },
    stop(): void {
      stopped = true;
      broker.stop();
      targets.clear();
    },
    getLastDenial(sessionID: string): DenialInfo | null {
      return targets.get(sessionID)?.lastDenial ?? null;
    },
    listPending(runId?: string): PendingPermissionAsk[] {
      return broker.listPending(runId);
    },
    respond(input: RespondPermissionInput): Promise<RespondOutcome> {
      return broker.respond(input);
    },
  };
}
