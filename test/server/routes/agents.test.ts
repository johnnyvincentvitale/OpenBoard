import { describe, it, expect, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { registerAgentRoutes } from "../../../src/server/routes/agents";

function buildApp(baseUrl = "http://fake-test-server") {
  const app = new Hono();
  registerAgentRoutes(app, { baseUrl });
  return app;
}

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as Response;
}

describe("GET /api/agents", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the mapped RosterAgent[] when OpenCode responds with a bare array", async () => {
    const fixture = [
      { id: "build", mode: "primary", description: "Build agent", model: { id: "m", providerID: "p" } },
      { name: "explore", mode: "subagent" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("http://fake-test-server/api/agent");
        return jsonResponse(fixture);
      }),
    );

    const app = buildApp();
    const res = await app.request("/api/agents");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([
      { id: "build", mode: "primary", description: "Build agent", model: { id: "m", providerID: "p" } },
      { id: "explore", mode: "subagent" },
    ]);
  });

  it("returns the mapped RosterAgent[] when OpenCode responds with a {data: [...]} envelope", async () => {
    const fixture = {
      data: [{ id: "plan", mode: "primary", description: "Plan agent" }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(fixture)),
    );

    const app = buildApp();
    const res = await app.request("/api/agents");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([{ id: "plan", mode: "primary", description: "Plan agent" }]);
  });

  it("returns 200 with [] when fetch throws (network error)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const app = buildApp();
    const res = await app.request("/api/agents");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("returns 200 with [] when the upstream response is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, false)),
    );

    const app = buildApp();
    const res = await app.request("/api/agents");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  it("returns 200 with [] when the response body is not valid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => {
          throw new Error("bad json");
        },
      })),
    );

    const app = buildApp();
    const res = await app.request("/api/agents");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });
});
