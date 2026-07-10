import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createPermissionResponderPool } from "../../src/server/permission-responder";

/** Minimal fake matching the { permission, session } slice permission-responder.ts uses. */
class FakePermissionClient {
  listResponses: unknown[][] = [];
  listShouldThrowCount = 0;
  replyCalls: Array<{ requestID: string; directory?: string; reply: string }> = [];
  replyShouldThrowCount = 0;
  listCallCount = 0;
  listCallsByDirectory: Record<string, number> = {};

  permission = {
    list: async (params?: { directory?: string }) => {
      this.listCallCount += 1;
      if (params?.directory) {
        this.listCallsByDirectory[params.directory] = (this.listCallsByDirectory[params.directory] ?? 0) + 1;
      }
      if (this.listShouldThrowCount > 0) {
        this.listShouldThrowCount -= 1;
        throw new Error("list failed");
      }
      const data = this.listResponses[this.listCallCount - 1] ?? this.listResponses[this.listResponses.length - 1] ?? [];
      return { data, error: undefined };
    },
    reply: async (params: { requestID: string; directory?: string; reply: "once" | "always" | "reject" }) => {
      this.replyCalls.push(params);
      if (this.replyShouldThrowCount > 0) {
        this.replyShouldThrowCount -= 1;
        throw new Error("reply failed");
      }
      return { data: true, error: undefined };
    },
  };

  messagesResponse: unknown = [];

  session = {
    messages: async (_params: { sessionID: string; directory?: string }) => {
      return { data: this.messagesResponse, error: undefined };
    },
  };
}

function toolMessage(messageID: string, callID: string, tool: string) {
  return {
    info: { id: messageID, role: "assistant" },
    parts: [{ type: "tool", callID, tool }],
  };
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) {
        resolvePromise();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("waitFor timed out"));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

describe("createPermissionResponderPool", () => {
  let client: FakePermissionClient;

  beforeEach(() => {
    client = new FakePermissionClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("approves ('once') a pending request raised by a read-class tool", async () => {
    client.messagesResponse = [toolMessage("msg_1", "call_1", "read")];
    client.listResponses = [
      [{ id: "req_1", sessionID: "ses_1", tool: { messageID: "msg_1", callID: "call_1" } }],
    ];

    const pool = createPermissionResponderPool({ client: client as never, pollIntervalMs: 5 });
    pool.register("ses_1", "/wt");

    await waitFor(() => client.replyCalls.length === 1);
    pool.stop();

    expect(client.replyCalls[0]).toMatchObject({ requestID: "req_1", directory: "/wt", reply: "once" });
  });

  it("denies ('reject') a pending request raised by a non-read tool", async () => {
    client.messagesResponse = [toolMessage("msg_1", "call_1", "apply_patch")];
    client.listResponses = [
      [{ id: "req_2", sessionID: "ses_1", tool: { messageID: "msg_1", callID: "call_1" } }],
    ];

    const pool = createPermissionResponderPool({ client: client as never, pollIntervalMs: 5 });
    pool.register("ses_1", "/wt");

    await waitFor(() => client.replyCalls.length === 1);
    pool.stop();

    expect(client.replyCalls[0]).toMatchObject({ requestID: "req_2", reply: "reject" });
  });

  it("denies ('reject') a pending request raised by bash", async () => {
    client.messagesResponse = [toolMessage("msg_1", "call_1", "bash")];
    client.listResponses = [
      [{ id: "req_bash", sessionID: "ses_1", tool: { messageID: "msg_1", callID: "call_1" } }],
    ];

    const pool = createPermissionResponderPool({ client: client as never, pollIntervalMs: 5 });
    pool.register("ses_1", "/wt");

    await waitFor(() => client.replyCalls.length === 1);
    pool.stop();

    expect(client.replyCalls[0]).toMatchObject({ requestID: "req_bash", reply: "reject" });
  });

  it("fails closed (reject) when the tool name can't be determined", async () => {
    client.messagesResponse = []; // no matching message/part
    client.listResponses = [
      [{ id: "req_3", sessionID: "ses_1", tool: { messageID: "msg_missing", callID: "call_missing" } }],
    ];

    const pool = createPermissionResponderPool({ client: client as never, pollIntervalMs: 5 });
    pool.register("ses_1", "/wt");

    await waitFor(() => client.replyCalls.length === 1);
    pool.stop();

    expect(client.replyCalls[0]).toMatchObject({ requestID: "req_3", reply: "reject" });
  });

  it("fails closed (reject) when the request has no tool identity at all", async () => {
    client.listResponses = [[{ id: "req_4", sessionID: "ses_1" }]];

    const pool = createPermissionResponderPool({ client: client as never, pollIntervalMs: 5 });
    pool.register("ses_1", "/wt");

    await waitFor(() => client.replyCalls.length === 1);
    pool.stop();

    expect(client.replyCalls[0]).toMatchObject({ requestID: "req_4", reply: "reject" });
  });

  it("ignores pending requests for a different sessionID", async () => {
    client.listResponses = [[{ id: "req_other", sessionID: "ses_other" }]];

    const pool = createPermissionResponderPool({ client: client as never, pollIntervalMs: 5 });
    pool.register("ses_1", "/wt");

    // Give it a few poll cycles; nothing should ever be replied to.
    await new Promise((r) => setTimeout(r, 60));
    pool.stop();

    expect(client.replyCalls).toHaveLength(0);
  });

  it("never double-replies an already-replied requestID across multiple polls", async () => {
    client.messagesResponse = [toolMessage("msg_1", "call_1", "read")];
    // Same pending request appears on every poll (as it would if the SDK
    // continued reporting it briefly after a reply due to eventual consistency).
    client.listResponses = [
      [{ id: "req_5", sessionID: "ses_1", tool: { messageID: "msg_1", callID: "call_1" } }],
      [{ id: "req_5", sessionID: "ses_1", tool: { messageID: "msg_1", callID: "call_1" } }],
      [{ id: "req_5", sessionID: "ses_1", tool: { messageID: "msg_1", callID: "call_1" } }],
    ];

    const pool = createPermissionResponderPool({ client: client as never, pollIntervalMs: 5 });
    pool.register("ses_1", "/wt");

    await waitFor(() => client.listCallCount >= 3);
    pool.stop();

    expect(client.replyCalls).toHaveLength(1);
  });

  it("unregister() halts polling for that session only", async () => {
    client.listResponses = [[]];

    const pool = createPermissionResponderPool({ client: client as never, pollIntervalMs: 5 });
    pool.register("ses_1", "/wt");

    await waitFor(() => client.listCallCount >= 1);
    pool.unregister("ses_1");
    const countAtUnregister = client.listCallCount;

    await new Promise((r) => setTimeout(r, 60));
    pool.stop();

    expect(client.listCallCount).toBe(countAtUnregister);
  });

  it("stop() halts the entire pool, including any still-registered sessions", async () => {
    client.listResponses = [[]];

    const pool = createPermissionResponderPool({ client: client as never, pollIntervalMs: 5 });
    pool.register("ses_1", "/wt");

    await waitFor(() => client.listCallCount >= 1);
    pool.stop();
    const countAtStop = client.listCallCount;

    await new Promise((r) => setTimeout(r, 60));

    expect(client.listCallCount).toBe(countAtStop);
  });

  it("serves multiple registered sessions from a single shared poll loop", async () => {
    client.listResponses = [[]];

    const pool = createPermissionResponderPool({ client: client as never, pollIntervalMs: 20 });
    pool.register("ses_1", "/wt-1");
    pool.register("ses_2", "/wt-2");

    // A single loop visiting both targets each tick keeps their call counts
    // in lockstep (never more than one tick apart). Two independently
    // scheduled timers would drift apart instead.
    await waitFor(() => (client.listCallsByDirectory["/wt-1"] ?? 0) >= 3 && (client.listCallsByDirectory["/wt-2"] ?? 0) >= 3);
    const gap = Math.abs((client.listCallsByDirectory["/wt-1"] ?? 0) - (client.listCallsByDirectory["/wt-2"] ?? 0));
    pool.stop();

    expect(gap).toBeLessThanOrEqual(1);
  });

  it("calls onError once per failure streak for a persistently failing list(), not on every tick", async () => {
    client.listShouldThrowCount = 3;
    client.listResponses = [[]];
    const errors: Array<{ sessionID: string; context: string }> = [];

    const pool = createPermissionResponderPool({
      client: client as never,
      pollIntervalMs: 5,
      onError: (sessionID, context) => errors.push({ sessionID, context }),
    });
    pool.register("ses_1", "/wt");

    await waitFor(() => client.listCallCount >= 3);
    // Let it recover (listShouldThrowCount is now exhausted) and confirm no
    // further onError calls fire once list() starts succeeding again.
    await waitFor(() => client.listCallCount >= 5);
    pool.stop();

    expect(errors).toEqual([{ sessionID: "ses_1", context: "list" }]);
  });

  it("calls onError again after a failure, a recovery, and a new failure", async () => {
    client.listShouldThrowCount = 1;
    client.listResponses = [[]];
    const errors: Array<{ sessionID: string; context: string }> = [];

    const pool = createPermissionResponderPool({
      client: client as never,
      pollIntervalMs: 5,
      onError: (sessionID, context) => errors.push({ sessionID, context }),
    });
    pool.register("ses_1", "/wt");

    await waitFor(() => errors.length === 1);
    // Wait for an actual successful call after the failure (real recovery,
    // not just the failure having happened) before failing it again.
    await waitFor(() => client.listCallCount >= 2);
    client.listShouldThrowCount = 1;
    await waitFor(() => errors.length === 2);
    pool.stop();

    expect(errors).toEqual([
      { sessionID: "ses_1", context: "list" },
      { sessionID: "ses_1", context: "list" },
    ]);
  });

  it("does not call onError for a fail-closed deny (tool name unresolvable)", async () => {
    client.listResponses = [[{ id: "req_6", sessionID: "ses_1" }]];
    const errors: unknown[] = [];

    const pool = createPermissionResponderPool({
      client: client as never,
      pollIntervalMs: 5,
      onError: (...args) => errors.push(args),
    });
    pool.register("ses_1", "/wt");

    await waitFor(() => client.replyCalls.length === 1);
    pool.stop();

    expect(client.replyCalls[0]).toMatchObject({ reply: "reject" });
    expect(errors).toHaveLength(0);
  });

  it("getLastDenial reports the denied tool after a reject reply, and null before any denial / after unregister", async () => {
    client.messagesResponse = [toolMessage("msg_1", "call_1", "apply_patch")];
    client.listResponses = [
      [{ id: "req_7", sessionID: "ses_1", tool: { messageID: "msg_1", callID: "call_1" } }],
    ];

    const pool = createPermissionResponderPool({ client: client as never, pollIntervalMs: 5 });
    expect(pool.getLastDenial("ses_1")).toBeNull();

    pool.register("ses_1", "/wt");
    expect(pool.getLastDenial("ses_1")).toBeNull(); // registered, but nothing denied yet

    await waitFor(() => client.replyCalls.length === 1);
    const denial = pool.getLastDenial("ses_1");
    expect(denial).not.toBeNull();
    expect(denial?.tool).toBe("apply_patch");
    expect(typeof denial?.deniedAt).toBe("number");

    pool.unregister("ses_1");
    expect(pool.getLastDenial("ses_1")).toBeNull();
    pool.stop();
  });

  it("getLastDenial stays null for an approved (read-class) request", async () => {
    client.messagesResponse = [toolMessage("msg_1", "call_1", "read")];
    client.listResponses = [
      [{ id: "req_8", sessionID: "ses_1", tool: { messageID: "msg_1", callID: "call_1" } }],
    ];

    const pool = createPermissionResponderPool({ client: client as never, pollIntervalMs: 5 });
    pool.register("ses_1", "/wt");

    await waitFor(() => client.replyCalls.length === 1);
    pool.stop();

    expect(pool.getLastDenial("ses_1")).toBeNull();
  });

  it("with interactiveTimeoutMs > 0, holds a non-read ask open (via the broker) until the timeout elapses", async () => {
    client.messagesResponse = [toolMessage("msg_1", "call_1", "apply_patch")];
    client.listResponses = [
      [{ id: "req_9", sessionID: "ses_1", tool: { messageID: "msg_1", callID: "call_1" } }],
    ];

    const pool = createPermissionResponderPool({
      client: client as never,
      pollIntervalMs: 5,
      interactiveTimeoutMs: 80,
    });
    pool.register("ses_1", "/wt");

    await new Promise((r) => setTimeout(r, 30));
    expect(client.replyCalls).toHaveLength(0); // still within the interactive window — the default reject hasn't fired yet.

    await waitFor(() => client.replyCalls.length === 1);
    pool.stop();

    expect(client.replyCalls[0]).toMatchObject({ requestID: "req_9", reply: "reject" });
  });

  it("surfaces a broker provider-reply failure through onError under the 'reply' context", async () => {
    client.messagesResponse = [toolMessage("msg_1", "call_1", "apply_patch")];
    client.listResponses = [
      [{ id: "req_10", sessionID: "ses_1", tool: { messageID: "msg_1", callID: "call_1" } }],
    ];
    client.replyShouldThrowCount = 1;
    const errors: Array<{ sessionID: string; context: string }> = [];

    const pool = createPermissionResponderPool({
      client: client as never,
      pollIntervalMs: 5,
      onError: (sessionID, context) => errors.push({ sessionID, context }),
    });
    pool.register("ses_1", "/wt");

    await waitFor(() => errors.length === 1);
    pool.stop();

    expect(errors[0]).toEqual({ sessionID: "ses_1", context: "reply" });
  });

  it("retries and succeeds after a read-class provider reply fails once", async () => {
    client.messagesResponse = [toolMessage("msg_1", "call_1", "read")];
    client.listResponses = [
      [{ id: "req_retry_read", sessionID: "ses_1", tool: { messageID: "msg_1", callID: "call_1" } }],
    ];
    client.replyShouldThrowCount = 1;

    const pool = createPermissionResponderPool({ client: client as never, pollIntervalMs: 5 });
    pool.register("ses_1", "/wt");

    // First attempt throws and must not permanently suppress the request.
    await waitFor(() => client.replyCalls.length >= 1);
    // A later poll retries the same still-native-pending request and succeeds.
    await waitFor(() => client.replyCalls.length === 2);
    pool.stop();

    expect(client.replyCalls.every((call) => call.requestID === "req_retry_read")).toBe(true);
    expect(client.replyCalls[1]).toMatchObject({ requestID: "req_retry_read", reply: "once" });
  });

  it("re-raises the same native request as a fresh board ask after a broker provider-reply failure", async () => {
    client.messagesResponse = [toolMessage("msg_1", "call_1", "apply_patch")];
    client.listResponses = [
      [{ id: "req_retry_broker", sessionID: "ses_1", tool: { messageID: "msg_1", callID: "call_1" } }],
    ];
    client.replyShouldThrowCount = 1;
    const errors: Array<{ sessionID: string; context: string }> = [];

    const pool = createPermissionResponderPool({
      client: client as never,
      pollIntervalMs: 5,
      interactiveTimeoutMs: 20,
      onError: (sessionID, context) => errors.push({ sessionID, context }),
    });
    pool.register("ses_1", "/wt");

    // First interactive-timeout deny attempt fails at the provider.
    await waitFor(() => errors.length === 1);
    // The request was released back to pending, so it must show up again as
    // a fresh board ask instead of being silently suppressed forever.
    await waitFor(() => pool.listPending("ses_1").length === 1);
    // And its second (retried) provider reply attempt succeeds.
    await waitFor(() => client.replyCalls.filter((c) => c.requestID === "req_retry_broker").length === 2);
    pool.stop();

    expect(errors).toEqual([{ sessionID: "ses_1", context: "reply" }]);
    expect(client.replyCalls[client.replyCalls.length - 1]).toMatchObject({
      requestID: "req_retry_broker",
      reply: "reject",
    });
  });

  it("lists and responds to a broker ask through the pool's own listPending/respond surface", async () => {
    client.messagesResponse = [toolMessage("msg_1", "call_1", "apply_patch")];
    client.listResponses = [
      [{ id: "req_surface", sessionID: "ses_1", tool: { messageID: "msg_1", callID: "call_1" } }],
    ];

    const pool = createPermissionResponderPool({
      client: client as never,
      pollIntervalMs: 5,
      interactiveTimeoutMs: 10_000, // long enough that only an operator reply resolves it in this test.
    });
    pool.register("ses_1", "/wt");

    await waitFor(() => pool.listPending("ses_1").length === 1);
    const [ask] = pool.listPending("ses_1");
    expect(ask.tool).toBe("apply_patch");

    const outcome = await pool.respond({ askId: ask.id, action: "allow_once", answeredBy: "reviewer" });
    pool.stop();

    expect(outcome).toMatchObject({ ok: true, decision: "allow_once" });
    expect(client.replyCalls[0]).toMatchObject({ requestID: "req_surface", reply: "once" });
    expect(pool.listPending("ses_1")).toHaveLength(0);
  });

  it("classifies asks by register()'s source and projects the SDK permission/patterns fields through the broker", async () => {
    client.messagesResponse = [toolMessage("msg_1", "call_1", "apply_patch")];
    client.listResponses = [
      [
        {
          id: "req_classified",
          sessionID: "ses_1",
          permission: "bash",
          patterns: ["/repo/**"],
          tool: { messageID: "msg_1", callID: "call_1" },
          metadata: { command: "rm -rf /" }, // must never survive into the public projection.
        },
      ],
    ];

    const pool = createPermissionResponderPool({
      client: client as never,
      pollIntervalMs: 5,
      interactiveTimeoutMs: 10_000,
    });
    pool.register("ses_1", "/wt", { source: "in-place-override" });

    await waitFor(() => pool.listPending("ses_1").length === 1);
    const [ask] = pool.listPending("ses_1");
    pool.stop();

    expect(ask.source).toBe("in-place-override");
    expect(ask.permission).toBe("bash");
    expect(ask.patterns).toEqual(["/repo/**"]);
    expect(JSON.stringify(ask)).not.toContain("rm -rf");
  });

  it("register() discards a still-pending broker ask from a prior registration of the same sessionID, so its late timeout never replies", async () => {
    client.messagesResponse = [toolMessage("msg_1", "call_1", "apply_patch")];
    client.listResponses = [
      [{ id: "req_11", sessionID: "ses_1", tool: { messageID: "msg_1", callID: "call_1" } }],
    ];

    const pool = createPermissionResponderPool({
      client: client as never,
      pollIntervalMs: 5,
      interactiveTimeoutMs: 1000, // long enough that it's still pending when we unregister/re-register.
    });
    pool.register("ses_1", "/wt");

    await waitFor(() => client.listCallCount >= 1);
    pool.unregister("ses_1");

    // Re-register the same sessionID (e.g. a retried task reusing the OpenCode
    // session id) against a target that now reports nothing pending.
    client.listResponses = [[]];
    pool.register("ses_1", "/wt");

    // Give the original ask's 1000ms broker timeout no chance to matter —
    // just prove no reply is ever recorded for it during a normal test window.
    await new Promise((r) => setTimeout(r, 60));
    pool.stop();

    expect(client.replyCalls).toHaveLength(0);
  });
});
