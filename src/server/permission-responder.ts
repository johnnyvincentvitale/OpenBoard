/**
 * Auto-responder for worktree-fenced sessions' `external_directory` asks.
 *
 * `WRITE_FENCED_PERMISSION` (src/shared/task.ts) puts OpenCode's built-in
 * Location boundary into "ask" mode for a worktree session. Left unanswered,
 * that ask would hang the unattended run forever, so this pool polls
 * `client.permission.list` for pending requests on each registered session's
 * directory, figures out which tool raised each one, and replies: read-class
 * tools get approved ("once"), everything else — including a tool we can't
 * identify — gets denied ("reject"). Denying-by-default is the fence;
 * approving is the carve-out for the reads OpenBoard has decided are safe.
 *
 * A single shared poll loop serves every currently-registered session — not
 * one independent timer per session — so N concurrent worktree tasks cost
 * one recurring tick that visits N targets, not N overlapping timers each
 * hitting the OpenCode API on their own schedule.
 *
 * `list`/`reply` failures are reported via `onError` (once per failure
 * streak, not on every failing tick) instead of being silently swallowed —
 * a persistently unreachable OpenCode server should be visible, not just
 * retried forever with no trace.
 *
 * The `permission.v2.asked` event exists but a bare subscribe-then-prompt
 * race can leave an ask unanswered indefinitely (proven in the Phase 0
 * probe), so polling is the only mechanism relied on here.
 *
 * `getLastDenial(sessionID)` exposes the most recent denial per session so a
 * caller (the dispatcher's stall-recovery nudge) can tell the agent what was
 * denied and how to proceed, instead of a generic "you seem stuck" prompt.
 */
import type { OpencodeHandle } from "./opencode";

type PermissionClient = OpencodeHandle["client"]["permission"];
type SessionClient = OpencodeHandle["client"]["session"];

const READ_TOOLS = new Set(["read", "glob", "grep", "list"]);

const DEFAULT_POLL_INTERVAL_MS = 250;

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
   * Called on the first consecutive `list`/`reply` failure for a registered
   * session (not on every failing tick, to avoid spamming a caller that logs
   * or records a task event once per streak) and again if that session
   * recovers and then fails again. Never called for a "tool name couldn't be
   * resolved" fail-closed deny — that's a deliberate security decision, not
   * an operational failure. Errors thrown by this callback are swallowed;
   * they must never be able to break the poll loop.
   */
  onError?: (sessionID: string, context: PermissionResponderErrorContext, error: unknown) => void;
}

/** Info about the most recently denied ask for a session — lets a caller give recovery guidance. */
export interface DenialInfo {
  tool: string;
  deniedAt: number;
}

export interface PermissionResponderPool {
  /** Start (or restart, discarding prior state) responding to asks for this session. */
  register(sessionID: string, directory: string): void;
  /** Stop responding to asks for this session and free its state. */
  unregister(sessionID: string): void;
  /** Stop the pool's poll loop entirely and free all state. */
  stop(): void;
  /** The most recent denial for this session, or null if none/not registered. */
  getLastDenial(sessionID: string): DenialInfo | null;
}

interface TargetState {
  directory: string;
  /** requestIDs already replied to, scoped to this target so it's freed on unregister(). */
  replied: Set<string>;
  /** Whether the most recent list/reply attempt for this target failed — gates onError de-dup. */
  failing: boolean;
  /** Most recent denial for this target, so a caller can give the agent recovery guidance. */
  lastDenial: DenialInfo | null;
}

/** Create a pool that polls `client.permission.list` once per tick for every registered session. */
export function createPermissionResponderPool(options: PermissionResponderPoolOptions): PermissionResponderPool {
  const { client, onError } = options;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const targets = new Map<string, TargetState>();
  let stopped = false;

  void runLoop();

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
    reportRecovery(state);

    for (const request of pending) {
      if (stopped || !targets.has(sessionID)) return;
      if (request.sessionID !== sessionID) continue;
      if (state.replied.has(request.id)) continue;

      const toolName = await resolveToolName(sessionID, state.directory, request);
      const approve = toolName !== undefined && READ_TOOLS.has(toolName);

      // Mark replied before the network call so a slow reply can't race a
      // subsequent poll into double-replying the same request.
      state.replied.add(request.id);
      try {
        const result = await client.permission.reply({
          requestID: request.id,
          directory: state.directory,
          reply: approve ? "once" : "reject",
        });
        if ((result as { error?: unknown }).error) throw (result as { error?: unknown }).error;
        reportRecovery(state);
        if (!approve) {
          state.lastDenial = { tool: toolName ?? "unknown", deniedAt: Date.now() };
        }
      } catch (err) {
        reportFailure(sessionID, "reply", state, err);
      }
    }
  }

  function reportFailure(sessionID: string, context: PermissionResponderErrorContext, state: TargetState, err: unknown): void {
    if (state.failing) return;
    state.failing = true;
    if (!onError) return;
    try {
      onError(sessionID, context, err);
    } catch {
      // A misbehaving handler must not be able to break the poll loop.
    }
  }

  function reportRecovery(state: TargetState): void {
    state.failing = false;
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
    register(sessionID: string, directory: string): void {
      targets.set(sessionID, { directory, replied: new Set(), failing: false, lastDenial: null });
    },
    unregister(sessionID: string): void {
      targets.delete(sessionID);
    },
    stop(): void {
      stopped = true;
      targets.clear();
    },
    getLastDenial(sessionID: string): DenialInfo | null {
      return targets.get(sessionID)?.lastDenial ?? null;
    },
  };
}
