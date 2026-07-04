import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { resolveBoardToken, tokensEqual, requireBoardToken } from "../../src/server/auth";
import { registerHealthRoutes } from "../../src/server/routes/health";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A fake OpenCode client the health route needs. */
function fakeClient(opts: { healthy?: boolean } = {}) {
  return {
    global: {
      health: async () => ({
        data: opts.healthy === false ? { healthy: false, version: "1.x" } : { healthy: true, version: "1.x" },
        error: undefined,
      }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** Build a Hono app with the auth middleware protecting a test route. */
function makeProtectedApp(token: string): Hono {
  const app = new Hono();
  // Health is registered BEFORE the auth middleware, so it stays
  // unauthenticated — matching the real createApp order.
  registerHealthRoutes(app, { client: fakeClient() });
  app.use("/api/*", requireBoardToken(token));
  app.get("/api/test", (c) => c.json({ ok: true }));
  return app;
}

// ---------------------------------------------------------------------------
// resolveBoardToken
// ---------------------------------------------------------------------------

describe("resolveBoardToken", () => {
  it("returns the env override when OPENBOARD_API_TOKEN is set", () => {
    const token = resolveBoardToken({ OPENBOARD_API_TOKEN: "fixed-token" });
    expect(token).toBe("fixed-token");
  });

  it("returns a random 64-char hex token when env is not set", () => {
    const token = resolveBoardToken({});
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("trims the env value", () => {
    const token = resolveBoardToken({ OPENBOARD_API_TOKEN: "  my-token  " });
    expect(token).toBe("my-token");
  });
});

// ---------------------------------------------------------------------------
// tokensEqual
// ---------------------------------------------------------------------------

describe("tokensEqual", () => {
  it("returns true for equal strings", () => {
    expect(tokensEqual("abc", "abc")).toBe(true);
  });

  it("returns false for different strings of same length", () => {
    expect(tokensEqual("abc", "abd")).toBe(false);
  });

  it("returns false for strings of different length", () => {
    expect(tokensEqual("abc", "ab")).toBe(false);
  });

  it("returns false for empty vs token", () => {
    expect(tokensEqual("", "abc")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// requireBoardToken middleware
// ---------------------------------------------------------------------------

describe("requireBoardToken middleware", () => {
  const TOKEN = "test-token-64-chars_______________________________________";

  it("accepts a valid Authorization: Bearer header", async () => {
    const app = makeProtectedApp(TOKEN);
    const res = await app.request("/api/test", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("accepts a valid board_token query parameter", async () => {
    const app = makeProtectedApp(TOKEN);
    const res = await app.request(`/api/test?board_token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects with 401 when no token is provided (header)", async () => {
    const app = makeProtectedApp(TOKEN);
    const res = await app.request("/api/test");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.message).toBe("Invalid or missing API token");
  });

  it("rejects with 401 when the token is wrong (header)", async () => {
    const app = makeProtectedApp(TOKEN);
    const res = await app.request("/api/test", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unauthorized");
  });

  it("rejects with 401 when the token is wrong (query)", async () => {
    const app = makeProtectedApp(TOKEN);
    const res = await app.request(`/api/test?board_token=wrong`);
    expect(res.status).toBe(401);
  });

  it("rejects when Authorization header has a scheme other than Bearer", async () => {
    const app = makeProtectedApp(TOKEN);
    const res = await app.request("/api/test", {
      headers: { Authorization: `Basic ${TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it("rejects when Authorization header is empty string", async () => {
    const app = makeProtectedApp(TOKEN);
    const res = await app.request("/api/test", {
      headers: { Authorization: "" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects Bearer with empty token", async () => {
    const app = makeProtectedApp(TOKEN);
    const res = await app.request("/api/test", {
      headers: { Authorization: "Bearer " },
    });
    expect(res.status).toBe(401);
  });

  // -----------------------------------------------------------------------
  // Health endpoint remains unauthenticated
  // -----------------------------------------------------------------------

  it("health endpoint is accessible without a token", async () => {
    const app = makeProtectedApp(TOKEN);
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.adapter).toBe("ok");
  });

  it("health endpoint is accessible even with wrong token", async () => {
    const app = makeProtectedApp(TOKEN);
    const res = await app.request("/api/health", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(200);
  });

  // -----------------------------------------------------------------------
  // Localhost origin is NOT sufficient — token is required regardless
  // -----------------------------------------------------------------------

  it("rejects localhost-origin requests without a token (no origin bypass)", async () => {
    const app = makeProtectedApp(TOKEN);
    // Simulate a same-origin request (no Origin header, which is how a
    // browser sends requests to the same origin).
    const res = await app.request("/api/test");
    expect(res.status).toBe(401);
  });

  it("accepts localhost-origin requests with the correct token", async () => {
    const app = makeProtectedApp(TOKEN);
    const res = await app.request("/api/test", {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: "http://localhost:4097",
      },
    });
    expect(res.status).toBe(200);
  });
});