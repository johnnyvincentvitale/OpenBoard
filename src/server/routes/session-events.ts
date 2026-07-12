/**
 * Session activity SSE route — GET /api/tasks/:id/session-events?limit=200.
 *
 * Delivers live session activity events via Server-Sent Events. The route
 * accepts tasks with either an OpenCode `sessionId` or an ACP
 * `harnessSessionId`/`harnessSessionName`.
 *
 * OpenCode backfill uses a subscribe-before-backfill pattern:
 * 1. Subscribe to the activity collector first to capture the watermark
 *    (latest activity seq at time of subscription).
 * 2. Detach the initial buffered frames atomically so live appends arriving
 *    during build are held for post-snapshot drain.
 * 3. Traverse the session tree via `client.session.children` recursively,
 *    bounded by depth/total sessions/shared byte budget.
 * 4. Normalize messages into `SessionActivityEvent` rows with stable source
 *    identity. rootSessionId is always the task's root; parentSessionId comes
 *    from the traversal parent, not message info.
 * 5. Merge backfill events with collector events, preferring collector
 *    identities. Sort, then slice the LAST `limit` rows (newest retained).
 * 6. Emit snapshot, gap, terminal frames (without id). Append frames use
 *    activity seq as id. Heartbeat every HEARTBEAT_INTERVAL_MS.
 * 7. After snapshot, drain buffered appends that arrived *after* the detach
 *    (seq > snapshot live high-watermark). Deduplicate by seq.
 *
 * Review/Done OpenCode tasks still backfill and reconstruct the bounded
 * history, then send static terminal. ACP terminal may gap if the ring is
 * unavailable.
 *
 * 404: task not found.
 * 409: task has no session.
 */
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { streamSSE } from "hono/streaming";
import type {
  SessionActivityEvent,
  SessionActivityFrame,
  SessionActivityRole,
  SessionActivityRun,
  SessionActivityToolStatus,
  SessionActivityTransport,
  TaskStore,
} from "../../shared";
import { TASK_ROUTE_PATTERNS } from "../../shared";
import { AdapterError } from "../../shared/errors";
import type { SessionActivityCollector } from "../session-activity";
import type { OpencodeHandle } from "../opencode";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const MAX_BACKFILL_EVENTS = 300;
const MAX_BACKFILL_BYTES_TOTAL = 768 * 1024;
const SESSION_TREE_MAX_DEPTH = 8;
const SESSION_TREE_MAX_SESSIONS = 32;
const HEARTBEAT_INTERVAL_MS = 15_000;
const SLOW_VIEWER_QUEUE_SIZE = 16;
const MAX_TEXT_LENGTH = 10_000;

export interface SessionEventsRouteDeps {
  store: TaskStore;
  client: OpencodeHandle["client"];
  activity?: SessionActivityCollector;
}

export function registerSessionEventsRoutes(app: Hono, deps: SessionEventsRouteDeps): void {
  const { store, client, activity } = deps;

  app.get(TASK_ROUTE_PATTERNS.sessionEvents, (c: Context) => {
    const taskId = c.req.param("id");
    if (!taskId) {
      return c.json(
        { error: { code: "validation", message: "Missing task id" } },
        400 as ContentfulStatusCode,
      );
    }

    const task = store.get(taskId);
    if (!task) {
      return c.json(
        { error: { code: "session_not_found", message: `Task not found: ${taskId}` } },
        404 as ContentfulStatusCode,
      );
    }

    const hasOpenCode = Boolean(task.sessionId);
    const hasAcp = Boolean(task.harnessSessionId || task.harnessSessionName);
    if (!hasOpenCode && !hasAcp) {
      return c.json(
        { error: { code: "validation", message: "Task has no session" } },
        409 as ContentfulStatusCode,
      );
    }

    let limit = DEFAULT_LIMIT;
    const limitRaw = c.req.query("limit");
    if (limitRaw !== undefined) {
      const parsed = Number.parseInt(limitRaw, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = Math.min(parsed, MAX_LIMIT);
      }
    }

    let cursor = 0;
    const lastEventId = c.req.header("Last-Event-ID");
    if (lastEventId) {
      const parsed = Number.parseInt(lastEventId, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        cursor = parsed;
      }
    }

    const sessionId = task.sessionId ??
      task.harnessSessionId ??
      task.harnessSessionName ??
      taskId;
    const harness = task.harness ?? "opencode";
    const runStartedAt = task.runStartedAt ?? 0;
    const effectiveDirectory = task.worktreePath ?? task.harnessCwd ?? task.directory;
    // Review chat temporarily marks the retained task run as running while
    // keeping the card/evidence in Review. Treat that as a live conversation,
    // not a static historical stream.
    const isTerminal = task.column === "done" || (task.column === "review" && task.runState !== "running");

    return streamSSE(c, async (stream) => {
      let closed = false;
      const pendingFrames: Array<SessionActivityFrame & { _id?: string }> = [];
      let writing = false;

      stream.onAbort(() => {
        closed = true;
        pendingFrames.length = 0;
      });

      async function writeFrame(frame: SessionActivityFrame, id?: string): Promise<boolean> {
        if (closed || stream.aborted) return false;

        if (writing) {
          if (pendingFrames.length >= SLOW_VIEWER_QUEUE_SIZE) {
            pendingFrames[SLOW_VIEWER_QUEUE_SIZE - 1] = {
              kind: "gap",
              afterSeq: cursor,
              reason: "Slow viewer — frames dropped",
            };
            return false;
          }
          pendingFrames.push({ ...frame, _id: id });
          return false;
        }

        writing = true;
        try {
          await stream.writeSSE({
            event: frame.kind,
            data: JSON.stringify(frame),
            ...(id !== undefined ? { id } : {}),
          });
          while (!closed && !stream.aborted && pendingFrames.length > 0) {
            const next = pendingFrames.shift()!;
            const { _id: nextId, ...nextFrame } = next as SessionActivityFrame & { _id?: string };
            await stream.writeSSE({
              event: nextFrame.kind,
              data: JSON.stringify(nextFrame),
              ...(nextId !== undefined ? { id: nextId } : {}),
            });
          }
          return true;
        } finally {
          writing = false;
        }
      }

      // Live heartbeat emission, used by the poll loop.
      async function emitHeartbeat(lastEventAt: number | null, transport: SessionActivityTransport): Promise<void> {
        await writeFrame({ kind: "heartbeat", lastEventAt, transport });
      }

      // --- No activity collector ---
      if (!activity) {
        // For Done/Review OpenCode tasks, attempt backfill from the
        // OpenCode client so reconstructed text is available.
        if (isTerminal && hasOpenCode && "children" in client.session) {
          const status = task.runState === "error" ? "error"
            : task.column === "done" ? "complete"
            : "aborted";
          const sessionClient = client.session as unknown as SessionClientLike;
          const backfill: (SessionActivityEvent & { _identity: string })[] = [];
          const budget: ByteBudget = { used: 0, truncated: false };
          await traverseSessionTree(
            sessionClient, task.sessionId!, effectiveDirectory,
            taskId, runStartedAt, harness, sessionId,
            backfill, budget, 0, new Set(),
          );
          const clean: SessionActivityEvent[] = collapseSameTurnAssistantEchoes(
            backfill.map(({ _identity: _, ...e }) => e),
          );
          if (clean.length > limit) clean.length = limit;
          await writeFrame({
            kind: "snapshot",
            run: {
              taskId, runStartedAt, sessionId,
              rootSessionId: sessionId, harness,
            },
            events: clean,
            lastEventAt: clean.length > 0 ? clean[clean.length - 1].occurredAt : null,
            transport: "static",
          });
          if (budget.truncated) {
            await writeFrame({
              kind: "gap",
              afterSeq: 0,
              reason: "Backfill truncated by byte or event cap",
            });
          }
          await writeFrame({ kind: "terminal", status });
          await emitHeartbeat(task.updatedAt, "static");
          return;
        }
        if (isTerminal) {
          const status = task.runState === "error" ? "error"
            : task.column === "done" ? "complete"
            : "aborted";
          await writeFrame({ kind: "terminal", status });
        }
        await emitHeartbeat(null, "static");
        return;
      }

      // --- Build run metadata ---
      const runMeta: SessionActivityRun = {
        taskId,
        runStartedAt,
        sessionId,
        rootSessionId: sessionId,
        harness,
      };

      // --- ACP-only path: collector ring + heartbeats ---
      if (hasAcp && !hasOpenCode) {
        let acpClosed = false;

        // If the task is terminal, close after delivering what's
        // available from the ring (or a gap if unavailable).
        if (isTerminal) {
          const status = task.runState === "error" ? "error"
            : task.column === "done" ? "complete"
            : "aborted";
          const deliverFrames: SessionActivityFrame[] = [];
          const unsubscribe = activity.subscribe(taskId, cursor, (frame) => {
            if (acpClosed || closed) return;
            deliverFrames.push(frame);
          });
          acpClosed = true;
          unsubscribe();
          const snapshotFrames = deliverFrames.filter(
            (f) => f.kind === "snapshot" || f.kind === "append",
          );
          if (snapshotFrames.length === 0) {
            await writeFrame({
              kind: "gap",
              afterSeq: 0,
              reason: "static-history-unavailable",
            });
          } else {
            for (const frame of snapshotFrames) {
              const id = frame.kind === "append" ? String(frame.event.seq) : undefined;
              await writeFrame(frame, id);
            }
          }
          await writeFrame({ kind: "terminal", status });
          await emitHeartbeat(task.updatedAt, "static");
          return;
        }

        let acpClosed2 = false;
        // Same live bookkeeping as the OpenCode path below: the heartbeat
        // loop must report the collector's real transport/lastEventAt and
        // stop once the run's terminal frame has been delivered — otherwise
        // a finished ACP run flips back to LIVE on the next heartbeat.
        let acpLiveTransport: SessionActivityTransport = "live";
        let acpLiveLastEventAt: number | null = null;
        let acpTerminalSent = false;
        const unsubscribe2 = activity.subscribe(taskId, cursor, (frame) => {
          if (acpClosed2 || closed) return;
          if (frame.kind === "append") {
            acpLiveLastEventAt = frame.event.occurredAt;
          }
          if (frame.kind === "snapshot" || frame.kind === "heartbeat") {
            acpLiveTransport = frame.transport;
          }
          if (frame.kind === "terminal") {
            acpTerminalSent = true;
          }
          if (frame.kind === "gap") {
            if (frame.reason.includes("evicted") || frame.reason.includes("replaced")) {
              void writeFrame(frame);
            }
            return;
          }
          if (frame.kind === "snapshot" && frame.events.length === 0 && frame.transport === "static") {
            void writeFrame({
              kind: "gap",
              afterSeq: 0,
              reason: "static-history-unavailable",
            });
            return;
          }
          const id = frame.kind === "append" ? String(frame.event.seq) : undefined;
          void writeFrame(frame, id);
        });

        try {
          while (!closed && !stream.aborted && !acpClosed2 && !acpTerminalSent) {
            await stream.sleep(HEARTBEAT_INTERVAL_MS);
            if (closed || stream.aborted || acpTerminalSent) break;
            await emitHeartbeat(acpLiveLastEventAt, acpLiveTransport);
          }
          // The subscriber's writes are fire-and-forget (void writeFrame) —
          // returning while one is still in flight or queued would end the
          // SSE stream before the terminal frame reaches the wire.
          while (!closed && !stream.aborted && (writing || pendingFrames.length > 0)) {
            await stream.sleep(5);
          }
        } finally {
          acpClosed2 = true;
          unsubscribe2();
        }
        return;
      }

      // --- OpenCode path: subscribe-before-backfill ---
      let watermarkSeq = 0;
      // Phase 1: accumulate buffered frames from subscribe callback.
      let bufferedFrames: SessionActivityFrame[] = [];
      // Phase 2: after detach, frames arriving during snapshot build.
      let pendingLiveFrames: SessionActivityFrame[] = [];
      let switchedToLive = false;
      // Live bookkeeping the post-snapshot heartbeat loop reads from —
      // updated by the subscriber callback in both the buffered and live
      // phases so the loop never reports stale/hardcoded values.
      let liveTransport: SessionActivityTransport = "live";
      let liveLastEventAt: number | null = null;
      let terminalSent = false;

      const subscriberCallback = (frame: SessionActivityFrame) => {
        if (closed || stream.aborted) return;
        if (frame.kind === "append") {
          watermarkSeq = Math.max(watermarkSeq, frame.event.seq);
          liveLastEventAt = frame.event.occurredAt;
        }
        if (frame.kind === "snapshot" || frame.kind === "heartbeat") {
          liveTransport = frame.transport;
        }
        if (frame.kind === "terminal") {
          terminalSent = true;
        }
        if (switchedToLive) {
          const id = frame.kind === "append" ? String(frame.event.seq) : undefined;
          void writeFrame(frame, id);
        } else {
          pendingLiveFrames.push(frame);
        }
      };

      const unsubscribe = activity.subscribe(taskId, cursor, subscriberCallback);

      try {
        // Step 1: Atomic detach — swap the initial buffer so
        // no frame arrives twice. Capture the watermark NOW so
        // frames arriving during backfill don't pollute the
        // snapshot high-watermark.
        bufferedFrames = pendingLiveFrames;
        pendingLiveFrames = [];
        const snapshotWatermark = watermarkSeq;

        // Step 2: Backfill from OpenCode session tree.
        const backfillEvents: (SessionActivityEvent & { _identity: string })[] = [];
        const byteBudget: ByteBudget = { used: 0, truncated: false };

        if (hasOpenCode && "children" in client.session) {
          const sessionClient = client.session as unknown as SessionClientLike;
          await traverseSessionTree(
            sessionClient,
            task.sessionId!,
            effectiveDirectory,
            taskId,
            runStartedAt,
            harness,
            sessionId, // root session
            backfillEvents,
            byteBudget,
            0,
            new Set(),
          );
        }

        // Step 3: Extract collector events from buffered frames.
        const collectorEvents: SessionActivityEvent[] = [];
        let collectorRun: SessionActivityRun | null = null;
        let collectorTransport: SessionActivityTransport = "live";
        let hasTerminal = false;
        let terminalStatus: "complete" | "error" | "aborted" | undefined;
        let hasEvictionGap = false;
        let evictionAfterSeq = 0;

        for (const frame of bufferedFrames) {
          if (frame.kind === "snapshot") {
            collectorEvents.push(...frame.events);
            collectorRun = frame.run;
            collectorTransport = frame.transport;
          } else if (frame.kind === "append") {
            collectorEvents.push(frame.event);
            if (!collectorRun) {
              collectorRun = runMeta;
            }
          } else if (frame.kind === "terminal") {
            hasTerminal = true;
            terminalStatus = frame.status;
          } else if (frame.kind === "gap") {
            hasEvictionGap = true;
            evictionAfterSeq = frame.afterSeq;
          }
        }

        // Step 4: Merge — collector identities preferred over backfill.
        // Build a set of collector event "fingerprints" for dedup.
        const collectorFingerprints = new Set(
          collectorEvents.map((ce) => fingerprint(ce)),
        );

        const allEvents: SessionActivityEvent[] = [];

        // Add backfill events not covered by collector.
        for (const be of backfillEvents) {
          const fp = fingerprint(be);
          if (!collectorFingerprints.has(fp)) {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { _identity: _, ...clean } = be;
            allEvents.push(clean);
          }
        }

        // Add collector events after cursor.
        for (const ce of collectorEvents) {
          if (ce.seq > cursor) {
            allEvents.push(ce);
          }
        }

        // Sort, then slice the LAST `limit` rows (newest retained).
        allEvents.sort((a, b) => a.occurredAt - b.occurredAt || a.seq - b.seq);
        const collapsedEvents = collapseSameTurnAssistantEchoes(allEvents);
        const snapshotEvents = collapsedEvents.length > limit
          ? collapsedEvents.slice(collapsedEvents.length - limit)
          : collapsedEvents;

        // Snapshot live high-watermark: max seq from collector
        // events in the snapshot + the captured watermark (before
        // backfill started). Later pending frames above this are
        // drained; frames at or below it are dropped.
        const snapshotLiveHighWatermark = Math.max(
          snapshotWatermark,
          ...snapshotEvents.map((e) => e.seq),
        );

        // Step 5: Emit snapshot phase.
        if (cursor > 0) {
          const oldestSeq = snapshotEvents.length > 0 ? snapshotEvents[0].seq : 0;
          if (oldestSeq > 0 && cursor < oldestSeq) {
            await writeFrame({
              kind: "gap",
              afterSeq: cursor,
              reason: `Events before seq ${oldestSeq} evicted or unavailable`,
            });
          }
        }

        if (cursor > 0 && snapshotEvents.length === 0 && watermarkSeq > cursor) {
          await writeFrame({
            kind: "gap",
            afterSeq: cursor,
            reason: "Cursor behind available events; starting fresh",
          });
        }

        const runToEmit = collectorRun ?? runMeta;
        const lastEventAt = snapshotEvents.length > 0
          ? snapshotEvents[snapshotEvents.length - 1].occurredAt
          : null;

        await writeFrame({
          kind: "snapshot",
          run: runToEmit,
          events: snapshotEvents,
          lastEventAt,
          transport: collectorTransport,
        });

        if (byteBudget.truncated) {
          await writeFrame({
            kind: "gap",
            afterSeq: snapshotLiveHighWatermark,
            reason: "Backfill truncated by byte or event cap",
          });
        }

        if (hasEvictionGap) {
          await writeFrame({
            kind: "gap",
            afterSeq: evictionAfterSeq,
            reason: "Ring buffer eviction — events not available",
          });
        }

        // Terminal path for Review/Done: emit terminal and close.
        if (isTerminal) {
          const status = task.runState === "error" ? "error"
            : task.column === "done" ? "complete"
            : "aborted";
          await writeFrame({ kind: "terminal", status });
          await emitHeartbeat(lastEventAt ?? task.updatedAt, "static");
          return;
        }

        if (hasTerminal && terminalStatus) {
          await writeFrame({ kind: "terminal", status: terminalStatus });
        }

        // Step 6: Drain frames buffered AFTER the detach, in original order.
        // Appends are filtered to seq > snapshot high-watermark and
        // deduplicated by seq (they may already be represented in the
        // snapshot). Terminal, gap, and snapshot frames are not append-only
        // — a run that ends (or replaces itself, or evicts its ring) while
        // backfill is still in flight must still reach the viewer, so those
        // kinds are preserved unconditionally instead of being dropped.
        switchedToLive = true;
        const drainedSeqs = new Set<number>();
        const toDrain: SessionActivityFrame[] = [];
        for (const frame of pendingLiveFrames) {
          if (frame.kind === "append") {
            if (frame.event.seq > snapshotLiveHighWatermark && !drainedSeqs.has(frame.event.seq)) {
              drainedSeqs.add(frame.event.seq);
              toDrain.push(frame);
            }
            continue;
          }
          if (frame.kind === "terminal" || frame.kind === "gap" || frame.kind === "snapshot") {
            toDrain.push(frame);
          }
          // Heartbeat frames buffered during backfill are superseded by the
          // heartbeat loop below (which reports live, up-to-date state) and
          // are intentionally not replayed.
        }
        for (const frame of toDrain) {
          const id = frame.kind === "append" ? String(frame.event.seq) : undefined;
          await writeFrame(frame, id);
        }
        pendingLiveFrames = [];

        // Step 7: Heartbeat loop. Stops once a terminal frame has been sent
        // for this run (including one just drained above) rather than
        // looping forever; reports the collector's actual transport state
        // and the most recently observed event time instead of a hardcoded
        // "live" and a snapshot-frozen timestamp.
        while (!closed && !stream.aborted && !terminalSent) {
          await stream.sleep(HEARTBEAT_INTERVAL_MS);
          if (closed || stream.aborted || terminalSent) break;
          await emitHeartbeat(liveLastEventAt ?? lastEventAt, liveTransport);
        }
        // A live terminal frame arrives via the subscriber's fire-and-forget
        // writeFrame — don't end the stream while it is still in flight.
        while (!closed && !stream.aborted && (writing || pendingFrames.length > 0)) {
          await stream.sleep(5);
        }
      } finally {
        unsubscribe();
      }
    });
  });
}

// ─── Backfill helpers ───────────────────────────────────────────────────────

type SessionClientLike = {
  messages(input: { sessionID: string; directory: string }): Promise<unknown>;
  children(input: { sessionID: string }): Promise<unknown>;
};

interface ByteBudget {
  used: number;
  truncated: boolean;
}

/**
 * Stable dedup identity between backfill rows and collector events.
 *
 * `occurredAt` cannot be part of the fingerprint: the collector stamps it at
 * record time while backfill stamps it at message-created time, so the same
 * logical event never has equal timestamps on both sides — that mismatch is
 * what caused every event to render twice.
 *
 * Tool events carry OpenCode's own `tool.callId` on both sides (backfill
 * reads it from `part.callID`; the collector passes it through as
 * `tool.callId`), so prefer that shared id when present. Text events have no
 * shared stable id in the `SessionActivityEvent` wire shape on either side,
 * so fall back to kind+text+toolName — still without occurredAt.
 */
function fingerprint(e: { sessionId: string; kind: string; text?: string; tool?: { name: string; callId?: string } }): string {
  if (e.tool?.callId) {
    return `${e.sessionId}:tool-call:${e.tool.callId}`;
  }
  return `${e.sessionId}:${e.kind}:${e.text ?? ""}:${e.tool?.name ?? ""}`;
}

async function traverseSessionTree(
  sessionClient: SessionClientLike,
  sessionId: string,
  directory: string,
  taskId: string,
  runStartedAt: number,
  harness: NonNullable<SessionActivityEvent["harness"]>,
  rootSessionId: string,
  out: (SessionActivityEvent & { _identity: string })[],
  budget: ByteBudget,
  depth: number,
  visited: Set<string>,
  traversalParentId?: string,
): Promise<void> {
  if (depth >= SESSION_TREE_MAX_DEPTH || visited.size >= SESSION_TREE_MAX_SESSIONS) {
    budget.truncated = true;
    return;
  }
  if (out.length >= MAX_BACKFILL_EVENTS || budget.used >= MAX_BACKFILL_BYTES_TOTAL) {
    budget.truncated = true;
    return;
  }
  if (visited.has(sessionId)) return;
  visited.add(sessionId);

  // Fetch messages for this session.
  try {
    const msgResult = await sessionClient.messages({ sessionID: sessionId, directory });
    if ((msgResult as { error?: unknown }).error) return;
    const messages = ((msgResult as { data?: unknown }).data as unknown[]) ?? [];
    if (!Array.isArray(messages)) return;

    let partIndex = 0;
    for (const msg of messages) {
      if (msg === null || typeof msg !== "object") continue;
      const record = msg as Record<string, unknown>;
      const info = record.info as Record<string, unknown> | undefined;
      const role: SessionActivityRole = typeof info?.role === "string"
        ? (["assistant", "user", "system"].includes(info.role) ? info.role as SessionActivityRole : "system")
        : "system";
      const messageId = typeof info?.id === "string" ? info.id : "";
      const messageTime = info?.time as Record<string, unknown> | undefined;
      const occurredAt = typeof info?.created === "number"
        ? info.created
        : typeof messageTime?.created === "number"
          ? messageTime.created
          : 0;

      const parts = Array.isArray(record.parts)
        ? (record.parts as Array<Record<string, unknown>>)
        : [];

      for (const part of parts) {
        if (part === null || typeof part !== "object") continue;
        const type = typeof part.type === "string" ? part.type : null;
        const identity = `${sessionId}:${messageId}:${partIndex++}`;

        if (type === "text") {
          const rawText = typeof part.text === "string" ? part.text : "";
          const text = displayTextForBackfill(rawText, role).slice(0, MAX_TEXT_LENGTH);
          if (!text.trim()) continue;
          const event = {
            seq: visited.size * 10000 + partIndex,
            taskId,
            runStartedAt,
            sessionId,
            rootSessionId,
            parentSessionId: traversalParentId ?? null,
            harness,
            occurredAt,
            kind: "text" as const,
            role,
            text,
            _identity: identity,
          };
          pushEvent(event, out, budget);
        } else if (type === "tool") {
          const toolName = typeof part.tool === "string" ? part.tool : "unknown";
          if (isOpenBoardReportTool(toolName)) continue;
          const callId = typeof part.callID === "string" ? part.callID : undefined;
          const state = part.state as Record<string, unknown> | undefined;
          const status: SessionActivityToolStatus =
            state?.status === "completed" ? "complete"
            : state?.status === "error" ? "error"
            : state?.status === "running" ? "running"
            : "started";
          const time = state?.time as Record<string, unknown> | undefined;
          const durationMs = typeof time?.start === "number" && typeof time?.end === "number"
            ? Math.max(0, time.end - time.start)
            : undefined;
          const output = typeof state?.output === "string" ? state.output : undefined;
          const outputBytes = output !== undefined ? Buffer.byteLength(output, "utf-8") : undefined;
          const event = {
            seq: visited.size * 10000 + partIndex,
            taskId,
            runStartedAt,
            sessionId,
            rootSessionId,
            parentSessionId: traversalParentId ?? null,
            harness,
            occurredAt,
            kind: "tool" as const,
            role: "assistant" as SessionActivityRole,
            tool: {
              name: toolName,
              callId,
              status,
              durationMs,
              outputBytes,
            },
            _identity: identity,
          };
          pushEvent(event, out, budget);
        }

        if (out.length >= MAX_BACKFILL_EVENTS || budget.used >= MAX_BACKFILL_BYTES_TOTAL) return;
      }
    }
  } catch {
    // Non-fatal.
  }

  // Traverse child sessions.
  try {
    const childrenResult = await sessionClient.children({ sessionID: sessionId });
    if ((childrenResult as { error?: unknown }).error) return;
    const children = ((childrenResult as { data?: unknown }).data as unknown[]) ?? [];
    if (!Array.isArray(children)) return;

    for (const child of children) {
      if (child === null || typeof child !== "object") continue;
      const childId = typeof (child as Record<string, unknown>).id === "string"
        ? (child as Record<string, unknown>).id as string
        : undefined;
      if (childId && !visited.has(childId)) {
        await traverseSessionTree(
          sessionClient, childId, directory, taskId, runStartedAt,
          harness, rootSessionId, out, budget, depth + 1, visited,
          sessionId, // traversal parent = current session
        );
      }
      if (out.length >= MAX_BACKFILL_EVENTS || budget.used >= MAX_BACKFILL_BYTES_TOTAL) return;
    }
  } catch {
    // Non-fatal.
  }
}

/** Keep provider backfill conversational by removing OpenBoard's injected worker envelope. */
function displayTextForBackfill(text: string, role: SessionActivityRole): string {
  if (role !== "user") return text;
  const chatEnvelopes = [
    {
      prefix: "OPENBOARD SESSION CHAT\n\n",
      suffix: "\n\nRespond conversationally in this session. Do not call complete_task or block_task, do not change files, and do not alter the card lifecycle for this chat turn.",
    },
    {
      prefix: "OPENBOARD OPERATOR GUIDANCE\n\n",
      suffix: "\n\nApply this guidance to the active task. Preserve the existing session, working tree, and original completion contract.",
    },
  ];
  for (const envelope of chatEnvelopes) {
    if (text.startsWith(envelope.prefix) && text.endsWith(envelope.suffix)) {
      return text.slice(envelope.prefix.length, -envelope.suffix.length);
    }
  }
  const operatorMarker = "OPERATOR MESSAGE\n\n";
  if (text.startsWith(operatorMarker)) {
    const body = text.slice(operatorMarker.length);
    const suffix = "\n\nContinue the existing task in the current working tree.";
    const suffixIndex = body.indexOf(suffix);
    return suffixIndex >= 0 ? body.slice(0, suffixIndex) : body;
  }
  const contractIndex = text.indexOf("\n\n---\nOPENBOARD");
  return contractIndex >= 0 ? text.slice(0, contractIndex) : text;
}

function isOpenBoardReportTool(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized.includes("openboard") && (normalized.endsWith("complete_task") || normalized.endsWith("block_task"));
}

function collapseSameTurnAssistantEchoes(events: SessionActivityEvent[]): SessionActivityEvent[] {
  const result: SessionActivityEvent[] = [];
  let assistantTexts = new Set<string>();
  for (const event of events) {
    if (event.kind === "text" && event.role === "user") assistantTexts = new Set<string>();
    if (event.kind === "text" && event.role === "assistant" && event.text?.trim()) {
      const text = event.text.trim();
      if (assistantTexts.has(text)) continue;
      assistantTexts.add(text);
    }
    result.push(event);
  }
  return result;
}

function pushEvent(
  event: SessionActivityEvent & { _identity: string },
  out: (SessionActivityEvent & { _identity: string })[],
  budget: ByteBudget,
): void {
  const bytes = JSON.stringify(event).length;
  if (budget.used + bytes > MAX_BACKFILL_BYTES_TOTAL) {
    budget.truncated = true;
    return;
  }
  out.push(event);
  budget.used += bytes;
}
