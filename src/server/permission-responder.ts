/**
 * Auto-responder for worktree-fenced sessions' `external_directory` asks.
 *
 * `WRITE_FENCED_PERMISSION` (src/shared/task.ts) puts OpenCode's built-in
 * Location boundary into "ask" mode for a worktree session. Left unanswered,
 * that ask would hang the unattended run forever, so this watcher polls
 * `client.permission.list` for pending requests on the session's directory,
 * figures out which tool raised each one, and replies: read-class tools get
 * approved ("once"), everything else — including a tool we can't identify —
 * gets denied ("reject"). Denying-by-default is the fence; approving is the
 * carve-out for the reads OpenBoard has decided are safe to allow.
 *
 * The `permission.v2.asked` event exists but a bare subscribe-then-prompt
 * race can leave an ask unanswered indefinitely (proven in the Phase 0
 * probe), so polling is the only mechanism relied on here.
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

export interface PermissionResponderWatcher {
  cancel(): void;
}

export interface StartPermissionResponderOptions {
  client: { permission: PermissionClient; session: SessionClient };
  sessionID: string;
  directory: string;
  pollIntervalMs?: number;
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

/** Start polling for pending `external_directory` asks on `sessionID` and auto-reply to each. */
export function startPermissionResponder(
  options: StartPermissionResponderOptions,
): PermissionResponderWatcher {
  const { client, sessionID, directory } = options;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const watcher = { cancelled: false };
  const replied = new Set<string>();

  void runLoop();

  async function runLoop(): Promise<void> {
    while (!watcher.cancelled) {
      await sleep(pollIntervalMs);
      if (watcher.cancelled) return;

      let pending: PendingRequest[];
      try {
        const result = await client.permission.list({ directory });
        if ((result as { error?: unknown }).error) continue;
        pending = asPendingRequests((result as { data?: unknown }).data);
      } catch {
        continue;
      }

      for (const request of pending) {
        if (watcher.cancelled) return;
        if (request.sessionID !== sessionID) continue;
        if (replied.has(request.id)) continue;

        const toolName = await resolveToolName(request);
        const approve = toolName !== undefined && READ_TOOLS.has(toolName);

        // Mark replied before the network call so a slow reply can't race a
        // subsequent poll into double-replying the same request.
        replied.add(request.id);
        try {
          await client.permission.reply({
            requestID: request.id,
            directory,
            reply: approve ? "once" : "reject",
          });
        } catch {
          // A failed reply leaves OpenCode's own ask timeout/deny behavior as
          // the backstop; retrying would risk a double-reply, so don't.
        }
      }
    }
  }

  async function resolveToolName(request: PendingRequest): Promise<string | undefined> {
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
    cancel(): void {
      watcher.cancelled = true;
    },
  };
}
