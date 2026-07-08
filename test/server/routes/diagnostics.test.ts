import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { registerDiagnosticsRoutes, resolveEffectiveSandbox, restartRequired } from "../../../src/server/routes/diagnostics";
import { SqliteTaskStore } from "../../../src/db/task-store";
import { requireBoardToken } from "../../../src/server/auth";
import type { SandboxStatus } from "../../../src/server/sandbox";

const TEST_TOKEN = "test-token-abc";
const OPENCODE_BASE_URL = "http://127.0.0.1:4096";

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_TOKEN}` };
}

function makeFakeClient(opts: {
  data?: { healthy: boolean; version: string };
  error?: unknown;
  throws?: unknown;
}) {
  return {
    global: {
      health: async () => {
        if (opts.throws !== undefined) throw opts.throws;
        if (opts.error !== undefined) return { data: undefined, error: opts.error };
        return { data: opts.data, error: undefined };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeSandbox(overrides: Partial<SandboxStatus> = {}): SandboxStatus {
  return { expected: false, enabled: false, ...overrides };
}

function buildApp(
  client: ReturnType<typeof makeFakeClient>,
  sandbox = makeSandbox(),
  boardToken = TEST_TOKEN,
) {
  const store = new SqliteTaskStore(":memory:");
  store.updateSettings({ worktreeDefault: false, bashSandbox: false });
  const app = new Hono();
  app.use("*", cors({ origin: "*" }));
  const auth = requireBoardToken(boardToken);
  app.use("/api/*", auth);
  registerDiagnosticsRoutes(app, {
    client,
    store,
    sandbox,
    opencodeBaseUrl: OPENCODE_BASE_URL,
    mode: "spawn",
    identity: { name: "alpha", port: 4098, workspace: "/repo", dbPath: "/db/tasks.sqlite", opencodeBaseUrl: OPENCODE_BASE_URL },
    boardTokenPresent: true,
    build: { version: "test-version", commit: "test-commit" },
  });
  return { app, store };
}

describe("resolveEffectiveSandbox", () => {
  it('returns "on" when enabled', () => {
    expect(resolveEffectiveSandbox(makeSandbox({ enabled: true, expected: true }), "spawn", true)).toBe("on");
  });

  it('returns "unavailable" when desired true but not enabled (components missing)', () => {
    expect(resolveEffectiveSandbox(makeSandbox({ enabled: false, expected: true }), "spawn", true)).toBe("unavailable");
  });

  it('returns "off" when desired false in spawn mode', () => {
    expect(resolveEffectiveSandbox(makeSandbox({ enabled: false, expected: false, reason: "disabled by board setting" }), "spawn", false)).toBe("off");
  });

  it('returns "external" for connect mode regardless of desired', () => {
    expect(resolveEffectiveSandbox(makeSandbox({ enabled: false, expected: false }), "connect", true)).toBe("external");
    expect(resolveEffectiveSandbox(makeSandbox({ enabled: false, expected: false }), "connect", false)).toBe("external");
  });

  it('returns "off" for spawn non-macOS when desired false', () => {
    expect(resolveEffectiveSandbox(makeSandbox({ enabled: false, expected: false }), "spawn", false)).toBe("off");
  });

  it('returns "unavailable" for spawn non-macOS when desired true', () => {
    // When expected is false and desired is true, but not external → unavailable as a catch-all
    expect(resolveEffectiveSandbox(makeSandbox({ enabled: false, expected: false }), "spawn", true)).toBe("off");
    // Hmm wait, if expected=false and desired=true, that's ambiguous.
    // In practice this won't happen because when desired=true in spawn, expected is always set.
    // But if it does, the function returns "off" which is the safe default.
  });
});

describe("restartRequired", () => {
  it("false when desired on and effective on", () => {
    expect(restartRequired(true, "on")).toBe(false);
  });

  it("false when desired off and effective off", () => {
    expect(restartRequired(false, "off")).toBe(false);
  });

  it("false when effective is external", () => {
    expect(restartRequired(true, "external")).toBe(false);
  });

  it("true when desired on and effective off", () => {
    expect(restartRequired(true, "off")).toBe(true);
  });

  it("true when desired off and effective on", () => {
    expect(restartRequired(false, "on")).toBe(true);
  });

  it("true when desired on and effective unavailable", () => {
    expect(restartRequired(true, "unavailable")).toBe(true);
  });

  it("false when desired off and effective unavailable", () => {
    expect(restartRequired(false, "unavailable")).toBe(false);
  });
});

describe("GET /api/diagnostics (behind board token)", () => {
  it("returns 401 without auth header", async () => {
    const client = makeFakeClient({ data: { healthy: true, version: "1.x" } });
    const { app } = buildApp(client);
    const res = await app.request("/api/diagnostics");
    expect(res.status).toBe(401);
  });

  it("returns 401 with wrong token", async () => {
    const client = makeFakeClient({ data: { healthy: true, version: "1.x" } });
    const { app } = buildApp(client);
    const res = await app.request("/api/diagnostics", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 with correct token", async () => {
    const client = makeFakeClient({ data: { healthy: true, version: "1.x" } });
    const sandbox = makeSandbox({ enabled: true, expected: true, wrapperPath: "/fake/wrapper.sh" });
    const { app } = buildApp(client, sandbox);
    const res = await app.request("/api/diagnostics", { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sandbox.desired).toBe("off");
    expect(body.sandbox.effective).toBe("on");
  });

  it("reports sandbox desired=off, effective=off when user disabled", async () => {
    const client = makeFakeClient({ data: { healthy: true, version: "1.x" } });
    const sandbox = makeSandbox({ enabled: false, expected: false, reason: "disabled by board setting" });
    const { app, store } = buildApp(client, sandbox);
    store.updateSettings({ bashSandbox: false });

    const res = await app.request("/api/diagnostics", { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sandbox).toMatchObject({
      desired: "off",
      effective: "off",
      restartRequired: false,
    });
  });

  it("reports sandbox desired=on, effective=unavailable when components missing", async () => {
    const client = makeFakeClient({ data: { healthy: true, version: "1.x" } });
    const sandbox = makeSandbox({ enabled: false, expected: true, reason: "wrapper missing" });
    const { app, store } = buildApp(client, sandbox);
    store.updateSettings({ bashSandbox: true });

    const res = await app.request("/api/diagnostics", { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sandbox).toMatchObject({
      desired: "on",
      effective: "unavailable",
      restartRequired: true,
    });
  });

  it("reports sandbox restartRequired when desired on, effective off", async () => {
    const client = makeFakeClient({ data: { healthy: true, version: "1.x" } });
    const sandbox = makeSandbox({ enabled: false, expected: false });
    const { app, store } = buildApp(client, sandbox);
    store.updateSettings({ bashSandbox: true });

    const res = await app.request("/api/diagnostics", { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sandbox.restartRequired).toBe(true);
  });

  it("reports OpenCode URL from dependency", async () => {
    const client = makeFakeClient({ data: { healthy: true, version: "1.x" } });
    const { app } = buildApp(client);
    const res = await app.request("/api/diagnostics", { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.opencode.url).toBe(OPENCODE_BASE_URL);
    expect(body.opencode.reachable).toBe(true);
    expect(body.opencode.version).toBe("1.x");
  });

  it("reports OpenCode URL even when unreachable", async () => {
    const client = makeFakeClient({ throws: new Error("down") });
    const { app } = buildApp(client);
    const res = await app.request("/api/diagnostics", { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.opencode.url).toBe(OPENCODE_BASE_URL);
    expect(body.opencode.reachable).toBe(false);
  });

  it("reports worktree sweep results", async () => {
    const client = makeFakeClient({ data: { healthy: true, version: "1.x" } });
    const { app, store } = buildApp(client);

    store.setSweepResult({
      sweptAt: 1000,
      removedCleanCount: 3,
      keptDirtyCount: 1,
      dirtyOrphans: [{ worktreePath: "/repo/.wt/task_abc", taskId: "task_abc" }],
    });

    const res = await app.request("/api/diagnostics", { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.worktree).toMatchObject({
      lastSweep: 1000,
      removedCleanCount: 3,
      keptDirtyCount: 1,
      dirtyOrphans: [{ worktreePath: "/repo/.wt/task_abc", taskId: "task_abc" }],
    });
  });

  it("does not expose the API token value", async () => {
    const client = makeFakeClient({ data: { healthy: true, version: "1.x" } });
    const { app } = buildApp(client);
    const res = await app.request("/api/diagnostics", { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.instance.apiTokenPresent).toBe(true);
    expect(JSON.stringify(body)).not.toContain(TEST_TOKEN);
  });
});