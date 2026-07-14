import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Dispatcher, PermissionSettings } from "../../shared";
import { AdapterError, permissionTimeoutSecondsToMs } from "../../shared";

export interface PermissionSettingsRouteDeps {
  dispatcher: Pick<Dispatcher, "getPermissionGraceMs" | "setPermissionGraceMs">;
}

function currentSettings(dispatcher: PermissionSettingsRouteDeps["dispatcher"]): PermissionSettings {
  return { timeoutSeconds: dispatcher.getPermissionGraceMs() / 1000 };
}

export function registerPermissionSettingsRoutes(app: Hono, deps: PermissionSettingsRouteDeps): void {
  app.get("/api/settings/permissions", (c) => c.json(currentSettings(deps.dispatcher), 200));

  app.patch("/api/settings/permissions", async (c) => {
    try {
      let body: Record<string, unknown>;
      try {
        body = (await c.req.json()) ?? {};
      } catch {
        throw AdapterError.validation("Request body must be valid JSON");
      }

      const timeoutMs = permissionTimeoutSecondsToMs(body.timeoutSeconds);
      if (timeoutMs === undefined) {
        throw AdapterError.validation("timeoutSeconds must be between 0 and 86400 with millisecond precision");
      }
      deps.dispatcher.setPermissionGraceMs(timeoutMs);
      return c.json(currentSettings(deps.dispatcher), 200);
    } catch (error) {
      return respondWithError(c, error);
    }
  });
}

function respondWithError(c: Context, error: unknown): Response {
  const adapterError = error instanceof AdapterError
    ? error
    : AdapterError.internal(error instanceof Error ? error.message : "Unexpected error", error);
  return c.json(adapterError.toEnvelope(), adapterError.status as ContentfulStatusCode);
}

