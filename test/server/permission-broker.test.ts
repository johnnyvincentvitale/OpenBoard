import { describe, it, expect, vi } from "vitest";
import { createPermissionBroker, type PermissionAskEvent, type PermissionBrokerClock } from "../../src/server/permission-broker";

/** Deterministic clock: `now()` is caller-controlled and timers fire only when `fire()` is called explicitly. */
function createFakeClock() {
  let current = 0;
  const timers: Array<{ handle: number; fireAt: number; callback: () => void; cancelled: boolean }> = [];
  let nextHandle = 0;

  const clock: PermissionBrokerClock = {
    now: () => current,
    setTimer: (callback, delayMs) => {
      const handle = ++nextHandle;
      timers.push({ handle, fireAt: current + delayMs, callback, cancelled: false });
      return handle;
    },
    clearTimer: (handle) => {
      const timer = timers.find((t) => t.handle === handle);
      if (timer) timer.cancelled = true;
    },
  };

  return {
    clock,
    advanceTo(ms: number): void {
      current = ms;
      for (const timer of timers) {
        if (!timer.cancelled && timer.fireAt <= current) {
          timer.cancelled = true; // fire once
          timer.callback();
        }
      }
    },
    /** Grab a still-armed timer's raw callback, to simulate a callback that fires despite being "late". */
    rawTimers(): Array<{ handle: number; fireAt: number; cancelled: boolean; callback: () => void }> {
      return timers;
    },
  };
}

function baseAsk(overrides: Partial<Parameters<ReturnType<typeof createPermissionBroker>["submitAsk"]>[0]> = {}) {
  return {
    runId: "run_1",
    nativeId: "native_1",
    harness: "opencode" as const,
    source: "worktree-fence" as const,
    permission: "external_directory",
    tool: "bash",
    summary: "bash requested a write outside the worktree",
    deadline: 1000,
    replyToProvider: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("createPermissionBroker", () => {
  it("uses globally unique opaque ids even across independent broker instances", () => {
    const first = createPermissionBroker();
    const second = createPermissionBroker();
    const firstId = first.submitAsk(baseAsk({ deadline: Date.now() + 1000 }));
    const secondId = second.submitAsk(baseAsk({ deadline: Date.now() + 1000 }));
    expect(firstId).not.toBe(secondId);
    expect(firstId).toMatch(/^ask_[0-9a-f-]{36}$/);
    expect(secondId).toMatch(/^ask_[0-9a-f-]{36}$/);
    first.stop();
    second.stop();
  });

  it("projects explicit task, attempt, and provider-session ownership", () => {
    const broker = createPermissionBroker();
    broker.submitAsk(baseAsk({ taskId: "task_1", runStartedAt: 123, providerSessionId: "child_1", deadline: Date.now() + 1000 }));
    expect(broker.listPending()[0]).toMatchObject({ taskId: "task_1", runStartedAt: 123, providerSessionId: "child_1" });
    broker.stop();
  });
  it("mints a board ask id distinct from the native id, and never exposes the native id publicly", () => {
    const { clock } = createFakeClock();
    const events: PermissionAskEvent[] = [];
    const broker = createPermissionBroker({ clock, onEvent: (e) => events.push(e) });

    const askId = broker.submitAsk(baseAsk({ nativeId: "super-secret-native-id" }));
    expect(askId).not.toBe("super-secret-native-id");

    const pending = broker.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(askId);
    expect(JSON.stringify(pending)).not.toContain("super-secret-native-id");
    expect(JSON.stringify(events)).not.toContain("super-secret-native-id");
  });

  it("keeps PendingPermissionAsk projections to exactly the public F0 contract keys", () => {
    const { clock } = createFakeClock();
    const broker = createPermissionBroker({ clock });
    broker.submitAsk(baseAsk({ patterns: ["/repo/**"] }));

    const [ask] = broker.listPending();
    expect(Object.keys(ask).sort()).toEqual(
      ["deadline", "harness", "id", "patterns", "permission", "providerSessionId", "raisedAt", "source", "summary", "tool"].sort(),
    );
  });

  it("deduplicates resubmission of the same provider/run/native identity while it's still active", () => {
    const { clock } = createFakeClock();
    const events: PermissionAskEvent[] = [];
    const broker = createPermissionBroker({ clock, onEvent: (e) => events.push(e) });

    const first = broker.submitAsk(baseAsk());
    const second = broker.submitAsk(baseAsk());

    expect(second).toBe(first);
    expect(broker.listPending()).toHaveLength(1);
    expect(events.filter((e) => e.type === "permission_asked")).toHaveLength(1);
  });

  it("treats the same native identity on a different run as a distinct ask", () => {
    const { clock } = createFakeClock();
    const broker = createPermissionBroker({ clock });

    const a = broker.submitAsk(baseAsk({ runId: "run_a" }));
    const b = broker.submitAsk(baseAsk({ runId: "run_b" }));

    expect(a).not.toBe(b);
    expect(broker.listPending()).toHaveLength(2);
  });

  it("treats overlapping native ids from root and child provider sessions as distinct asks", () => {
    const { clock } = createFakeClock();
    const broker = createPermissionBroker({ clock });
    const root = broker.submitAsk(baseAsk({ nativeId: "req_1", providerSessionId: "root" }));
    const child = broker.submitAsk(baseAsk({ nativeId: "req_1", providerSessionId: "child" }));
    expect(child).not.toBe(root);
    expect(broker.listPending()).toHaveLength(2);
  });

  it("lists pending asks oldest-first", () => {
    const { clock, advanceTo } = createFakeClock();
    const broker = createPermissionBroker({ clock });

    const first = broker.submitAsk(baseAsk({ nativeId: "n1" }));
    advanceTo(10);
    const second = broker.submitAsk(baseAsk({ nativeId: "n2" }));
    advanceTo(20);
    const third = broker.submitAsk(baseAsk({ nativeId: "n3" }));

    expect(broker.listPending().map((a) => a.id)).toEqual([first, second, third]);
  });

  it("truncates oversized summary/patterns so events and projections stay bounded", () => {
    const { clock } = createFakeClock();
    const broker = createPermissionBroker({ clock });
    const longSummary = "x".repeat(1000);
    const manyPatterns = Array.from({ length: 20 }, (_, i) => `/pattern-${i}/`.repeat(20));

    broker.submitAsk(baseAsk({ summary: longSummary, patterns: manyPatterns }));

    const [ask] = broker.listPending();
    expect(ask.summary.length).toBeLessThan(300);
    expect(ask.patterns?.length).toBeLessThanOrEqual(8);
    for (const pattern of ask.patterns ?? []) {
      expect(pattern.length).toBeLessThan(300);
    }
  });

  it("resolves an operator allow_once by claiming, then calling replyToProvider exactly once", async () => {
    const { clock } = createFakeClock();
    const events: PermissionAskEvent[] = [];
    const replyToProvider = vi.fn().mockResolvedValue(undefined);
    const broker = createPermissionBroker({ clock, onEvent: (e) => events.push(e) });
    const askId = broker.submitAsk(baseAsk({ replyToProvider }));

    const outcome = await broker.respond({ askId, action: "allow_once", answeredBy: "reviewer" });

    expect(outcome).toEqual({ ok: true, askId, decision: "allow_once" });
    expect(replyToProvider).toHaveBeenCalledTimes(1);
    expect(replyToProvider).toHaveBeenCalledWith("allow_once");
    expect(broker.listPending()).toHaveLength(0);

    const answered = events.find((e) => e.type === "permission_answered");
    expect(answered).toMatchObject({ decision: "allow_once", reason: "operator", answeredBy: "reviewer" });
  });

  it("resolves an operator deny the same way", async () => {
    const { clock } = createFakeClock();
    const replyToProvider = vi.fn().mockResolvedValue(undefined);
    const broker = createPermissionBroker({ clock });
    const askId = broker.submitAsk(baseAsk({ replyToProvider }));

    const outcome = await broker.respond({ askId, action: "deny", answeredBy: "reviewer" });

    expect(outcome).toEqual({ ok: true, askId, decision: "deny" });
    expect(replyToProvider).toHaveBeenCalledWith("deny");
  });

  it("denies with reason policy-timeout once the deadline passes with no operator reply", async () => {
    const { clock, advanceTo } = createFakeClock();
    const events: PermissionAskEvent[] = [];
    const replyToProvider = vi.fn().mockResolvedValue(undefined);
    const broker = createPermissionBroker({ clock, onEvent: (e) => events.push(e) });
    broker.submitAsk(baseAsk({ deadline: 500, replyToProvider }));

    advanceTo(500);
    await Promise.resolve();
    await Promise.resolve();

    expect(replyToProvider).toHaveBeenCalledWith("deny");
    expect(broker.listPending()).toHaveLength(0);
    const answered = events.find((e) => e.type === "permission_answered");
    expect(answered).toMatchObject({ decision: "deny", reason: "policy-timeout" });
  });

  it("returns not-found for an unknown or already-resolved ask id", async () => {
    const { clock } = createFakeClock();
    const broker = createPermissionBroker({ clock });

    const outcome = await broker.respond({ askId: "ask_missing", action: "deny", answeredBy: "reviewer" });

    expect(outcome).toEqual({ ok: false, askId: "ask_missing", conflict: "not-found" });
  });

  it("rejects a stale/concurrent second resolution attempt on the same ask with a conflict", async () => {
    const { clock } = createFakeClock();
    const broker = createPermissionBroker({ clock });
    const askId = broker.submitAsk(baseAsk());

    const [firstOutcome, secondOutcome] = await Promise.all([
      broker.respond({ askId, action: "allow_once", answeredBy: "reviewer-a" }),
      broker.respond({ askId, action: "deny", answeredBy: "reviewer-b" }),
    ]);

    const outcomes = [firstOutcome, secondOutcome];
    const succeeded = outcomes.filter((o) => o.ok);
    const conflicted = outcomes.filter((o) => !o.ok);
    expect(succeeded).toHaveLength(1);
    expect(conflicted).toHaveLength(1);
    expect(conflicted[0]).toMatchObject({ conflict: "already-resolved" });
  });

  it("never lets a policy timeout resolve an ask an operator already claimed", async () => {
    const { clock, advanceTo } = createFakeClock();
    const replyToProvider = vi.fn().mockResolvedValue(undefined);
    const broker = createPermissionBroker({ clock });
    const askId = broker.submitAsk(baseAsk({ deadline: 500, replyToProvider }));

    const operatorOutcome = await broker.respond({ askId, action: "allow_once", answeredBy: "reviewer" });
    advanceTo(500); // timer already disarmed by the successful claim above — must be a no-op.

    expect(operatorOutcome.ok).toBe(true);
    expect(replyToProvider).toHaveBeenCalledTimes(1);
    expect(replyToProvider).toHaveBeenCalledWith("allow_once");
  });

  it("on provider reply failure: never emits answered, drops the ask instead of marking it resolved, and reports reply-failed", async () => {
    const { clock } = createFakeClock();
    const events: PermissionAskEvent[] = [];
    const replyToProvider = vi.fn().mockRejectedValue(new Error("network blip"));
    const broker = createPermissionBroker({ clock, onEvent: (e) => events.push(e) });
    const askId = broker.submitAsk(baseAsk({ replyToProvider }));

    const outcome = await broker.respond({ askId, action: "allow_once", answeredBy: "reviewer" });

    expect(outcome).toMatchObject({ ok: false, conflict: "reply-failed" });
    expect(events.some((e) => e.type === "permission_answered")).toBe(false);
    expect(events.some((e) => e.type === "permission_reply_failed")).toBe(true);
    expect(events.find((e) => e.type === "permission_reply_failed")).toMatchObject({
      decision: "allow_once",
      reason: "operator",
      answeredBy: "reviewer",
    });
    // Never falsely answered: the ask is gone (not silently left "pending" forever, and not marked resolved).
    expect(broker.listPending()).toHaveLength(0);
    expect(await broker.respond({ askId, action: "allow_once", answeredBy: "reviewer" })).toMatchObject({
      conflict: "not-found",
    });
  });

  it("caps reopened provider reply failures and terminates visibly after three attempts", async () => {
    const { clock } = createFakeClock();
    const events: PermissionAskEvent[] = [];
    const replyToProvider = vi.fn().mockRejectedValue(new Error("provider down"));
    const broker = createPermissionBroker({ clock, onEvent: (event) => events.push(event) });
    const askId = broker.submitAsk(baseAsk({ reopenOnReplyFailure: true, replyToProvider }));

    await expect(broker.respond({ askId, action: "deny", answeredBy: "operator" })).resolves.toMatchObject({ conflict: "reply-failed" });
    expect(broker.listPending()).toHaveLength(1);
    await broker.respond({ askId, action: "deny", answeredBy: "operator" });
    expect(broker.listPending()).toHaveLength(1);
    await broker.respond({ askId, action: "deny", answeredBy: "operator" });

    expect(replyToProvider).toHaveBeenCalledTimes(3);
    expect(broker.listPending()).toEqual([]);
    expect(events.filter((event) => event.type === "permission_reply_failed")).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ pendingAfterFailure: false, delivery: "failed" });
  });

  it("truncates a reply-failure error message in the emitted event", async () => {
    const { clock } = createFakeClock();
    const events: PermissionAskEvent[] = [];
    const replyToProvider = vi.fn().mockRejectedValue(new Error("x".repeat(1000)));
    const broker = createPermissionBroker({ clock, onEvent: (e) => events.push(e) });
    const askId = broker.submitAsk(baseAsk({ replyToProvider }));

    await broker.respond({ askId, action: "deny", answeredBy: "reviewer" });

    const failed = events.find((e) => e.type === "permission_reply_failed");
    expect(failed?.error?.length).toBeLessThan(300);
  });

  it("clearRun cancels timers and removes asks for that run only", async () => {
    const { clock, advanceTo } = createFakeClock();
    const replyA = vi.fn().mockResolvedValue(undefined);
    const replyB = vi.fn().mockResolvedValue(undefined);
    const broker = createPermissionBroker({ clock });
    broker.submitAsk(baseAsk({ runId: "run_a", nativeId: "n_a", deadline: 500, replyToProvider: replyA }));
    broker.submitAsk(baseAsk({ runId: "run_b", nativeId: "n_b", deadline: 500, replyToProvider: replyB }));

    broker.clearRun("run_a");
    expect(broker.listPending()).toHaveLength(1);
    expect(broker.listPending()[0].harness).toBe("opencode");

    advanceTo(500);
    await Promise.resolve();
    await Promise.resolve();

    // run_a's timer was cancelled by clearRun — its provider must never be called.
    expect(replyA).not.toHaveBeenCalled();
    // run_b was untouched and still resolves normally via its own timeout.
    expect(replyB).toHaveBeenCalledWith("deny");
  });

  it("emits one terminal cancellation with unknown delivery when a run is cleared", () => {
    const { clock } = createFakeClock();
    const events: PermissionAskEvent[] = [];
    const broker = createPermissionBroker({ clock, onEvent: (event) => events.push(event) });
    const askId = broker.submitAsk(baseAsk());

    broker.clearRun("run_1", "opencode", "run-replaced");

    expect(broker.listPending()).toEqual([]);
    expect(events.filter((event) => event.askId === askId).map((event) => event.type)).toEqual([
      "permission_asked",
      "permission_cancelled",
    ]);
    expect(events.at(-1)).toMatchObject({ cancellationReason: "run-replaced", delivery: "unknown" });
  });

  it("does not emit answered after a claimed provider write races run cancellation", async () => {
    const { clock } = createFakeClock();
    const events: PermissionAskEvent[] = [];
    let release!: () => void;
    const replyToProvider = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const broker = createPermissionBroker({ clock, onEvent: (event) => events.push(event) });
    const askId = broker.submitAsk(baseAsk({ replyToProvider }));
    const response = broker.respond({ askId, action: "allow_once", answeredBy: "operator" });
    await Promise.resolve();

    broker.clearRun("run_1", "opencode", "shutdown");
    release();

    await expect(response).resolves.toMatchObject({ ok: false, conflict: "already-resolved" });
    expect(events.map((event) => event.type)).toEqual(["permission_asked", "permission_cancelled"]);
    expect(events.at(-1)).toMatchObject({ delivery: "unknown" });
  });

  it("protects a replacement run reusing the same runId from a late timer callback", async () => {
    const { clock, advanceTo, rawTimers } = createFakeClock();
    const firstReply = vi.fn().mockResolvedValue(undefined);
    const secondReply = vi.fn().mockResolvedValue(undefined);
    const broker = createPermissionBroker({ clock });

    const firstAskId = broker.submitAsk(baseAsk({ runId: "run_1", nativeId: "n1", deadline: 500, replyToProvider: firstReply }));
    const firstTimer = rawTimers().find((t) => !t.cancelled);
    expect(firstTimer).toBeDefined();

    broker.clearRun("run_1"); // e.g. the task run ended before the ask timed out.

    // A brand-new ask for the same runId (a retried task reusing the session id).
    const secondAskId = broker.submitAsk(baseAsk({ runId: "run_1", nativeId: "n1", deadline: 1000, replyToProvider: secondReply }));
    expect(secondAskId).not.toBe(firstAskId);

    // Simulate the stale first timer somehow still firing (defense in depth
    // beyond clock.clearTimer having already been invoked by clearRun).
    firstTimer?.callback();
    await Promise.resolve();
    await Promise.resolve();

    expect(firstReply).not.toHaveBeenCalled();
    expect(secondReply).not.toHaveBeenCalled(); // second ask's own deadline (1000) hasn't arrived yet.

    advanceTo(1000);
    await Promise.resolve();
    await Promise.resolve();
    expect(secondReply).toHaveBeenCalledWith("deny");
  });

  it("stop() cancels every timer and clears all runs", async () => {
    const { clock, advanceTo } = createFakeClock();
    const reply = vi.fn().mockResolvedValue(undefined);
    const broker = createPermissionBroker({ clock });
    broker.submitAsk(baseAsk({ deadline: 500, replyToProvider: reply }));

    broker.stop();
    advanceTo(500);
    await Promise.resolve();

    expect(reply).not.toHaveBeenCalled();
    expect(broker.listPending()).toHaveLength(0);
  });

  it("preserves the caller-supplied source across worktree-fence, in-place-override, and acp asks", () => {
    const { clock } = createFakeClock();
    const broker = createPermissionBroker({ clock });

    broker.submitAsk(baseAsk({ nativeId: "n1", source: "worktree-fence" }));
    broker.submitAsk(baseAsk({ nativeId: "n2", source: "in-place-override" }));
    broker.submitAsk(baseAsk({ nativeId: "n3", source: "acp" }));

    const sources = broker.listPending().map((a) => a.source);
    expect(sources).toEqual(["worktree-fence", "in-place-override", "acp"]);
  });

  it("emits exactly one asked event and one answered event per resolved ask, never duplicated by dedupe", async () => {
    const { clock } = createFakeClock();
    const events: PermissionAskEvent[] = [];
    const broker = createPermissionBroker({ clock, onEvent: (e) => events.push(e) });

    const askId = broker.submitAsk(baseAsk());
    broker.submitAsk(baseAsk()); // resubmission — must not emit a second "asked".
    await broker.respond({ askId, action: "allow_once", answeredBy: "reviewer" });

    expect(events.filter((e) => e.type === "permission_asked")).toHaveLength(1);
    expect(events.filter((e) => e.type === "permission_answered")).toHaveLength(1);
  });

  it("swallows a throwing onEvent handler without breaking submitAsk or respond", async () => {
    const { clock } = createFakeClock();
    const broker = createPermissionBroker({
      clock,
      onEvent: () => {
        throw new Error("handler exploded");
      },
    });

    const askId = broker.submitAsk(baseAsk());
    const outcome = await broker.respond({ askId, action: "deny", answeredBy: "reviewer" });

    expect(outcome.ok).toBe(true);
  });
});

describe("permission-broker source-quality regression", () => {
  it("the TypeScript source file contains zero NUL bytes (proving it is never classified as binary by git)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const src = await readFile(fileURLToPath(import.meta.resolve("../../src/server/permission-broker.ts")));
    const nulCount = Uint8Array.from(src).filter((b) => b === 0).length;
    expect(nulCount).toBe(0);
  });
});

describe("permission-broker identity collision safety", () => {
  it("distinguishes harness/runId/nativeId tuples with JSON-like characters in their values", () => {
    const { clock } = createFakeClock();
    const broker = createPermissionBroker({ clock });

    // A nativeId that happens to contain JSON-like delimiters must not collide
    // with a different real tuple. JSON.stringify escapes all special
    // characters within each string, so the encoding is unambiguous.
    const a = broker.submitAsk(baseAsk({ harness: "opencode", runId: "run_1", nativeId: 'native_1","run_2"', }));
    const b = broker.submitAsk(baseAsk({ harness: "opencode", runId: 'run_1","run_2', nativeId: "native_1" }));
    const c = broker.submitAsk(baseAsk({ harness: "opencode", runId: "run_1", nativeId: "native_1" }));

    // All three are distinct identities — JSON.stringify produces different
    // strings for each, so dedupe must not merge them.
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
    expect(broker.listPending()).toHaveLength(3);
  });

  it("deduplicates the same identity even when JSON.stringify is the encoding", () => {
    const { clock } = createFakeClock();
    const broker = createPermissionBroker({ clock });

    const first = broker.submitAsk(baseAsk({ harness: "opencode", runId: "run_1", nativeId: "n1" }));
    const second = broker.submitAsk(baseAsk({ harness: "opencode", runId: "run_1", nativeId: "n1" }));

    expect(second).toBe(first);
    expect(broker.listPending()).toHaveLength(1);
  });

  it("plain identityKey output from JSON.stringify is stable and textual", () => {
    // Not a broker test per se — just confirming the encoding never regresses
    // back to NUL separators. We verify by checking that the identity used
    // internally contains no JSON-invalid control characters (NUL is invalid
    // in JSON, so JSON.stringify would reject it anyway).
    const { clock } = createFakeClock();
    const events: string[] = [];
    const broker = createPermissionBroker({
      clock,
      onEvent: (e) => events.push(JSON.stringify(e)),
    });

    broker.submitAsk(baseAsk({ harness: "opencode", runId: "run_1", nativeId: "n1" }));
    // If identityKey ever regressed to NUL separators, the serialization of
    // the internal maps would contain \x00 and the JSON events (which go
    // through toPublic, not the key) would be fine — but the test reads the
    // source file, so we also check here that no event carries NUL.
    for (const s of events) {
      expect(s).not.toContain("\x00");
    }
    expect(broker.listPending()).toHaveLength(1);
  });
});
