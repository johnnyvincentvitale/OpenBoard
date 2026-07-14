import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { requireBoardToken } from "../../../src/server/auth";
import { registerPermissionSettingsRoutes } from "../../../src/server/routes/permission-settings";

const TOKEN = "settings-token";

function buildApp(initialMs = 300_000) {
  let graceMs = initialMs;
  const dispatcher = {
    getPermissionGraceMs: vi.fn(() => graceMs),
    setPermissionGraceMs: vi.fn((value: number) => {
      graceMs = value;
    }),
  };
  const app = new Hono();
  app.use("/api/*", requireBoardToken(TOKEN));
  registerPermissionSettingsRoutes(app, { dispatcher });
  return { app, dispatcher };
}

const auth = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

describe("permission settings routes", () => {
  it("requires the board token", async () => {
    const { app } = buildApp();
    expect((await app.request("/api/settings/permissions")).status).toBe(401);
  });

  it("returns the effective five-minute default", async () => {
    const { app } = buildApp();
    const response = await app.request("/api/settings/permissions", { headers: auth });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ timeoutSeconds: 300 });
  });

  it("updates the live instance timeout", async () => {
    const { app, dispatcher } = buildApp();
    const response = await app.request("/api/settings/permissions", {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ timeoutSeconds: 450 }),
    });
    expect(response.status).toBe(200);
    expect(dispatcher.setPermissionGraceMs).toHaveBeenCalledWith(450_000);
    expect(await response.json()).toEqual({ timeoutSeconds: 450 });
  });

  it("rejects invalid or overlong windows", async () => {
    const { app, dispatcher } = buildApp();
    for (const timeoutSeconds of [-1, 86_401, "five", 1.0001]) {
      const response = await app.request("/api/settings/permissions", {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify({ timeoutSeconds }),
      });
      expect(response.status).toBe(400);
    }
    expect(dispatcher.setPermissionGraceMs).not.toHaveBeenCalled();
  });
});

