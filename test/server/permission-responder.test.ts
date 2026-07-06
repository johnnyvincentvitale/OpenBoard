import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { startPermissionResponder } from "../../src/server/permission-responder";

/** Minimal fake matching the { permission, session } slice permission-responder.ts uses. */
class FakePermissionClient {
  listResponses: unknown[][] = [];
  replyCalls: Array<{ requestID: string; directory?: string; reply: string }> = [];
  replyShouldThrow = false;
  listCallCount = 0;

  permission = {
    list: async (_params?: { directory?: string }) => {
      const data = this.listResponses[this.listCallCount] ?? this.listResponses[this.listResponses.length - 1] ?? [];
      this.listCallCount += 1;
      return { data, error: undefined };
    },
    reply: async (params: { requestID: string; directory?: string; reply: "once" | "always" | "reject" }) => {
      this.replyCalls.push(params);
      if (this.replyShouldThrow) throw new Error("reply failed");
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

describe("startPermissionResponder", () => {
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

    const watcher = startPermissionResponder({
      client: client as never,
      sessionID: "ses_1",
      directory: "/wt",
      pollIntervalMs: 5,
    });

    await waitFor(() => client.replyCalls.length === 1);
    watcher.cancel();

    expect(client.replyCalls[0]).toMatchObject({ requestID: "req_1", directory: "/wt", reply: "once" });
  });

  it("denies ('reject') a pending request raised by a non-read tool", async () => {
    client.messagesResponse = [toolMessage("msg_1", "call_1", "apply_patch")];
    client.listResponses = [
      [{ id: "req_2", sessionID: "ses_1", tool: { messageID: "msg_1", callID: "call_1" } }],
    ];

    const watcher = startPermissionResponder({
      client: client as never,
      sessionID: "ses_1",
      directory: "/wt",
      pollIntervalMs: 5,
    });

    await waitFor(() => client.replyCalls.length === 1);
    watcher.cancel();

    expect(client.replyCalls[0]).toMatchObject({ requestID: "req_2", reply: "reject" });
  });

  it("fails closed (reject) when the tool name can't be determined", async () => {
    client.messagesResponse = []; // no matching message/part
    client.listResponses = [
      [{ id: "req_3", sessionID: "ses_1", tool: { messageID: "msg_missing", callID: "call_missing" } }],
    ];

    const watcher = startPermissionResponder({
      client: client as never,
      sessionID: "ses_1",
      directory: "/wt",
      pollIntervalMs: 5,
    });

    await waitFor(() => client.replyCalls.length === 1);
    watcher.cancel();

    expect(client.replyCalls[0]).toMatchObject({ requestID: "req_3", reply: "reject" });
  });

  it("fails closed (reject) when the request has no tool identity at all", async () => {
    client.listResponses = [[{ id: "req_4", sessionID: "ses_1" }]];

    const watcher = startPermissionResponder({
      client: client as never,
      sessionID: "ses_1",
      directory: "/wt",
      pollIntervalMs: 5,
    });

    await waitFor(() => client.replyCalls.length === 1);
    watcher.cancel();

    expect(client.replyCalls[0]).toMatchObject({ requestID: "req_4", reply: "reject" });
  });

  it("ignores pending requests for a different sessionID", async () => {
    client.listResponses = [[{ id: "req_other", sessionID: "ses_other" }]];

    const watcher = startPermissionResponder({
      client: client as never,
      sessionID: "ses_1",
      directory: "/wt",
      pollIntervalMs: 5,
    });

    // Give it a few poll cycles; nothing should ever be replied to.
    await new Promise((r) => setTimeout(r, 60));
    watcher.cancel();

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

    const watcher = startPermissionResponder({
      client: client as never,
      sessionID: "ses_1",
      directory: "/wt",
      pollIntervalMs: 5,
    });

    await waitFor(() => client.listCallCount >= 3);
    watcher.cancel();

    expect(client.replyCalls).toHaveLength(1);
  });

  it("stop()/cancel() halts the polling loop", async () => {
    client.listResponses = [[]];

    const watcher = startPermissionResponder({
      client: client as never,
      sessionID: "ses_1",
      directory: "/wt",
      pollIntervalMs: 5,
    });

    await waitFor(() => client.listCallCount >= 1);
    watcher.cancel();
    const countAtCancel = client.listCallCount;

    await new Promise((r) => setTimeout(r, 60));

    expect(client.listCallCount).toBe(countAtCancel);
  });
});
