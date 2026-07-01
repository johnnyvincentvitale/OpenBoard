import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { registerCardActionRoutes } from "../../../src/server/routes/card-actions";
import type { OpencodeClientLike } from "../../../src/server/board-service";

// --- Fixtures --------------------------------------------------------------

/**
 * A hermetic, duck-typed fake of the OpenCode SDK client. Only implements
 * session.promptAsync / session.abort / session.diff — the surface these
 * routes actually call. Every method returns the SDK's real { data, error }
 * shape and every call is tracked via vi.fn() so tests can assert on it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = ReturnType<typeof vi.fn<(...args: any[]) => Promise<any>>>;

function makeFakeClient(opts: {
  promptAsync?: AnyMock;
  abort?: AnyMock;
  diff?: AnyMock;
}): OpencodeClientLike {
  return {
    session: {
      promptAsync:
        opts.promptAsync ?? vi.fn(async () => ({ data: undefined, error: undefined })),
      abort: opts.abort ?? vi.fn(async () => ({ data: true, error: undefined })),
      diff: opts.diff ?? vi.fn(async () => ({ data: [], error: undefined })),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as OpencodeClientLike;
}

function buildApp(client: OpencodeClientLike): Hono {
  const app = new Hono();
  registerCardActionRoutes(app, { client });
  return app;
}

// --- POST /api/board/cards/:id/prompt -----------------------------------------

describe("POST /api/board/cards/:id/prompt", () => {
  it("calls session.promptAsync with the session id and text, responds 202", async () => {
    const promptAsync = vi.fn(
      async (_args: { sessionID: string; parts?: unknown }) => ({
        data: undefined,
        error: undefined,
      }),
    );
    const client = makeFakeClient({ promptAsync });
    const app = buildApp(client);

    const res = await app.request("/api/board/cards/ses_1/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "do the thing" }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ ok: true });

    expect(promptAsync).toHaveBeenCalledTimes(1);
    const callArgs = promptAsync.mock.calls[0][0];
    expect(callArgs.sessionID).toBe("ses_1");
    expect(callArgs.parts).toEqual([{ type: "text", text: "do the thing" }]);
  });

  it("responds 400 validation when text is missing", async () => {
    const client = makeFakeClient({});
    const app = buildApp(client);

    const res = await app.request("/api/board/cards/ses_1/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation");
  });

  it("responds 400 validation when body is not valid JSON", async () => {
    const client = makeFakeClient({});
    const app = buildApp(client);

    const res = await app.request("/api/board/cards/ses_1/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation");
  });

  it("maps a NotFoundError from the SDK to a session_not_found 404", async () => {
    const promptAsync = vi.fn(async () => ({
      data: undefined,
      error: { name: "NotFoundError", data: { message: "no such session" } },
    }));
    const client = makeFakeClient({ promptAsync });
    const app = buildApp(client);

    const res = await app.request("/api/board/cards/ses_missing/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("session_not_found");
  });
});

// --- POST /api/board/cards/:id/interrupt --------------------------------------

describe("POST /api/board/cards/:id/interrupt", () => {
  it("calls session.abort with the session id, responds 200", async () => {
    const abort = vi.fn(async (_args: { sessionID: string }) => ({
      data: true,
      error: undefined,
    }));
    const client = makeFakeClient({ abort });
    const app = buildApp(client);

    const res = await app.request("/api/board/cards/ses_1/interrupt", {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });

    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort.mock.calls[0][0]).toEqual({ sessionID: "ses_1" });
  });

  it("maps an SDK error to opencode_unreachable when abort fails", async () => {
    const abort = vi.fn(async () => ({
      data: undefined,
      error: { _tag: "BadRequest" },
    }));
    const client = makeFakeClient({ abort });
    const app = buildApp(client);

    const res = await app.request("/api/board/cards/ses_1/interrupt", {
      method: "POST",
    });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("opencode_unreachable");
  });
});

// --- GET /api/board/cards/:id/diff --------------------------------------------

describe("GET /api/board/cards/:id/diff", () => {
  it("calls session.diff with the session id, responds 200 with the diff array", async () => {
    const fakeDiffs = [{ file: "src/a.ts", additions: 3, deletions: 1 }];
    const diff = vi.fn(async (_args: { sessionID: string }) => ({
      data: fakeDiffs,
      error: undefined,
    }));
    const client = makeFakeClient({ diff });
    const app = buildApp(client);

    const res = await app.request("/api/board/cards/ses_1/diff");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(fakeDiffs);

    expect(diff).toHaveBeenCalledTimes(1);
    expect(diff.mock.calls[0][0]).toEqual({ sessionID: "ses_1" });
  });

  it("maps a NotFoundError from the SDK to a session_not_found 404", async () => {
    const diff = vi.fn(async () => ({
      data: undefined,
      error: { name: "NotFoundError", data: { message: "no such session" } },
    }));
    const client = makeFakeClient({ diff });
    const app = buildApp(client);

    const res = await app.request("/api/board/cards/ses_missing/diff");

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("session_not_found");
  });

  it("maps an unrecognized SDK error to opencode_unreachable 503", async () => {
    const diff = vi.fn(async () => ({
      data: undefined,
      error: { _tag: "BadRequest" },
    }));
    const client = makeFakeClient({ diff });
    const app = buildApp(client);

    const res = await app.request("/api/board/cards/ses_1/diff");

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("opencode_unreachable");
  });
});
