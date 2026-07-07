import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { registerProviderRoutes } from "../../../src/server/routes/providers";

function buildApp(list: () => Promise<unknown>) {
  const app = new Hono();
  registerProviderRoutes(app, { client: { provider: { list } } as never });
  return app;
}

describe("GET /api/providers", () => {
  it("returns only connected providers, mapped to the narrow RosterProvider shape", async () => {
    const list = vi.fn(async () => ({
      data: {
        all: [
          {
            id: "anthropic",
            name: "Anthropic",
            models: {
              sonnet: { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
              opus: { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
            },
          },
          { id: "openrouter", name: "OpenRouter", models: { "z-ai/glm-5.2": { id: "z-ai/glm-5.2", name: "GLM 5.2" } } },
          { id: "not-connected", name: "Not Connected", models: {} },
        ],
        default: { anthropic: "claude-sonnet-5" },
        connected: ["anthropic", "openrouter"],
      },
    }));

    const app = buildApp(list);
    const res = await app.request("/api/providers");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([
      {
        id: "anthropic",
        name: "Anthropic",
        defaultModelId: "claude-sonnet-5",
        models: [
          { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
          { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
        ],
      },
      { id: "openrouter", name: "OpenRouter", models: [{ id: "z-ai/glm-5.2", name: "GLM 5.2" }] },
    ]);
  });

  it("returns 200 with [] when the SDK call throws (network error)", async () => {
    const list = vi.fn(async () => {
      throw new Error("network down");
    });

    const app = buildApp(list);
    const res = await app.request("/api/providers");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns 200 with [] when the SDK responds with an {error} envelope", async () => {
    const list = vi.fn(async () => ({ error: { message: "unauthorized" } }));

    const app = buildApp(list);
    const res = await app.request("/api/providers");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns 200 with [] when the response body is missing/malformed", async () => {
    const list = vi.fn(async () => ({}));

    const app = buildApp(list);
    const res = await app.request("/api/providers");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
