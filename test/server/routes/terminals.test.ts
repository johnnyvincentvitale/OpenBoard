import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { serve } from "@hono/node-server";
import { WebSocket, WebSocketServer } from "ws";
import { registerTerminalRoutes, isAllowedOrigin, isValidReservationToken } from "../../../src/server/routes/terminals";
import { PtyManager, type PtyModule, type PtyProcess } from "../../../src/server/terminal/pty-manager";

class FakePtyProcess implements PtyProcess {
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  killCount = 0;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number }) => void>();

  onData(listener: (data: string) => void) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode: number }) => void) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  write(data: string) {
    this.writes.push(data);
  }

  resize(cols: number, rows: number) {
    this.resizes.push({ cols, rows });
  }

  kill() {
    this.killCount += 1;
    this.emitExit(0);
  }

  emitData(data: string) {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(exitCode: number) {
    for (const listener of this.exitListeners) listener({ exitCode });
  }
}

async function openSocket(url: string, origin?: string): Promise<WebSocket> {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: origin ? { Origin: origin } : undefined });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

async function waitForUnexpectedResponse(ws: WebSocket): Promise<number> {
  return await new Promise((resolve, reject) => {
    ws.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
    ws.once("error", reject);
  });
}

describe("terminal route helpers", () => {
  it("allows only local host/origin combinations", () => {
    expect(isAllowedOrigin("http://localhost:5173", "127.0.0.1:4097")).toBe(true);
    expect(isAllowedOrigin(undefined, "localhost:4097")).toBe(true);
    expect(isAllowedOrigin("https://evil.com", "127.0.0.1:4097")).toBe(false);
    expect(isAllowedOrigin("http://localhost:5173", "evil.com:4097")).toBe(false);
  });

  it("validates reservation tokens with constant-time comparison", () => {
    expect(isValidReservationToken("abc123", "abc123")).toBe(true);
    expect(isValidReservationToken("abc123", "abc124")).toBe(false);
    expect(isValidReservationToken("abc123", undefined)).toBe(false);
  });
});

describe("terminal routes", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("creates reservations without spawning a pty and rejects bad origins", async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "ocb-term-route-")));
    dirs.push(workspace);
    const spawn = vi.fn(() => new FakePtyProcess());
    const manager = new PtyManager({
      processEnv: { BOARD_WORKSPACE: workspace } as NodeJS.ProcessEnv,
      loadPtyModule: async () => ({ spawn }),
    });
    const app = new Hono();
    registerTerminalRoutes(app, { manager });

    const blocked = await app.request("/api/terminals", {
      method: "POST",
      headers: { host: "127.0.0.1:4097", origin: "https://evil.com", "content-type": "application/json" },
      body: JSON.stringify({ cwd: workspace }),
    });
    expect(blocked.status).toBe(403);

    const res = await app.request("/api/terminals", {
      method: "POST",
      headers: { host: "127.0.0.1:4097", origin: "http://localhost:5173", "content-type": "application/json" },
      body: JSON.stringify({ cwd: workspace, cols: 120, rows: 50 }),
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ cwd: workspace, id: expect.any(String), token: expect.any(String) });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("enforces single-use tokens and websocket terminal protocol", async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "ocb-term-ws-")));
    dirs.push(workspace);
    const process = new FakePtyProcess();
    const spawn = vi.fn(() => process);
    const manager = new PtyManager({
      processEnv: { BOARD_WORKSPACE: workspace } as NodeJS.ProcessEnv,
      loadPtyModule: async () => ({ spawn }),
      reservationTtlMs: 5_000,
    });
    const app = new Hono();
    registerTerminalRoutes(app, { manager });
    const wss = new WebSocketServer({ noServer: true });
    let port = 0;
    const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const listening = serve(
        { fetch: app.fetch, port: 0, hostname: "127.0.0.1", websocket: { server: wss } },
        (info) => {
          port = info.port;
          resolve(listening);
        },
      );
    });

    try {
      const reserveRes = await fetch(`http://127.0.0.1:${port}/api/terminals`, {
        method: "POST",
        headers: { origin: "http://localhost:5173", host: `127.0.0.1:${port}`, "content-type": "application/json" },
        body: JSON.stringify({ cwd: workspace }),
      });
      const reservation = (await reserveRes.json()) as { id: string; token: string };

      const badSocket = new WebSocket(
        `ws://127.0.0.1:${port}/api/terminals/${reservation.id}/socket?token=wrong`,
        { headers: { Origin: "http://localhost:5173" } },
      );
      await expect(waitForUnexpectedResponse(badSocket)).resolves.toBe(403);

      const ws = await openSocket(
        `ws://127.0.0.1:${port}/api/terminals/${reservation.id}/socket?token=${reservation.token}`,
        "http://localhost:5173",
      );
      expect(spawn).toHaveBeenCalledTimes(1);

      ws.send(JSON.stringify({ type: "input", data: "pwd\n" }));
      ws.send(JSON.stringify({ type: "resize", cols: 140, rows: 44 }));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(process.writes).toEqual(["pwd\n"]);
      expect(process.resizes).toEqual([{ cols: 140, rows: 44 }]);

      const firstMessage = await new Promise<string>((resolve) => {
        ws.once("message", (data: unknown) => resolve(String(data)));
        process.emitData("hello");
      });
      expect(JSON.parse(firstMessage)).toEqual({ type: "data", data: "hello" });

      const secondAttach = new WebSocket(
        `ws://127.0.0.1:${port}/api/terminals/${reservation.id}/socket?token=${reservation.token}`,
        { headers: { Origin: "http://localhost:5173" } },
      );
      await expect(waitForUnexpectedResponse(secondAttach)).resolves.toBe(404);

      const exitMessage = await new Promise<string>((resolve) => {
        ws.once("message", (data: unknown) => resolve(String(data)));
        process.emitExit(5);
      });
      expect(JSON.parse(exitMessage)).toEqual({ type: "exit", code: 5 });

      ws.close();
    } finally {
      manager.cleanupReservations();
      manager.killAll();
      server.close();
    }
  });

  it("expires unattached reservations before websocket attach", async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "ocb-term-expire-")));
    dirs.push(workspace);
    const spawn = vi.fn(() => new FakePtyProcess());
    const manager = new PtyManager({
      processEnv: { BOARD_WORKSPACE: workspace } as NodeJS.ProcessEnv,
      loadPtyModule: async () => ({ spawn }),
      reservationTtlMs: 20,
    });
    const app = new Hono();
    registerTerminalRoutes(app, { manager });
    const wss = new WebSocketServer({ noServer: true });
    let port = 0;
    const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const listening = serve(
        { fetch: app.fetch, port: 0, hostname: "127.0.0.1", websocket: { server: wss } },
        (info) => {
          port = info.port;
          resolve(listening);
        },
      );
    });

    try {
      const expiringRes = await fetch(`http://127.0.0.1:${port}/api/terminals`, {
        method: "POST",
        headers: { origin: "http://localhost:5173", host: `127.0.0.1:${port}`, "content-type": "application/json" },
        body: JSON.stringify({ cwd: workspace }),
      });
      const expiring = (await expiringRes.json()) as { id: string; token: string };
      await new Promise((resolve) => setTimeout(resolve, 50));

      const expired = new WebSocket(
        `ws://127.0.0.1:${port}/api/terminals/${expiring.id}/socket?token=${expiring.token}`,
        { headers: { Origin: "http://localhost:5173" } },
      );
      await expect(waitForUnexpectedResponse(expired)).resolves.toBe(404);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      manager.cleanupReservations();
      manager.killAll();
      server.close();
    }
  });

  it("kills late-spawned terminals when the socket closes before attach settles", async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "ocb-term-close-race-")));
    dirs.push(workspace);

    let resolveModule: ((value: PtyModule) => void) | undefined;
    const process = new FakePtyProcess();
    const spawn = vi.fn(() => process);
    const manager = new PtyManager({
      processEnv: { BOARD_WORKSPACE: workspace } as NodeJS.ProcessEnv,
      loadPtyModule: () =>
        new Promise((resolve) => {
          resolveModule = resolve;
        }),
      reservationTtlMs: 5_000,
    });
    const app = new Hono();
    registerTerminalRoutes(app, { manager });
    const wss = new WebSocketServer({ noServer: true });
    let port = 0;
    const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const listening = serve(
        { fetch: app.fetch, port: 0, hostname: "127.0.0.1", websocket: { server: wss } },
        (info) => {
          port = info.port;
          resolve(listening);
        },
      );
    });

    try {
      const reserveRes = await fetch(`http://127.0.0.1:${port}/api/terminals`, {
        method: "POST",
        headers: { origin: "http://localhost:5173", host: `127.0.0.1:${port}`, "content-type": "application/json" },
        body: JSON.stringify({ cwd: workspace }),
      });
      const reservation = (await reserveRes.json()) as { id: string; token: string };

      const ws = await openSocket(
        `ws://127.0.0.1:${port}/api/terminals/${reservation.id}/socket?token=${reservation.token}`,
        "http://localhost:5173",
      );

      const inFlightAttach = new WebSocket(
        `ws://127.0.0.1:${port}/api/terminals/${reservation.id}/socket?token=${reservation.token}`,
        { headers: { Origin: "http://localhost:5173" } },
      );
      await expect(waitForUnexpectedResponse(inFlightAttach)).resolves.toBe(409);

      ws.close();
      await new Promise((resolve) => ws.once("close", resolve));

      resolveModule?.({ spawn });
      await vi.waitFor(() => {
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(process.killCount).toBe(1);
      });

      const afterSettle = new WebSocket(
        `ws://127.0.0.1:${port}/api/terminals/${reservation.id}/socket?token=${reservation.token}`,
        { headers: { Origin: "http://localhost:5173" } },
      );
      await expect(waitForUnexpectedResponse(afterSettle)).resolves.toBe(404);
      expect(manager.getReservation(reservation.id)).toBeUndefined();
    } finally {
      manager.cleanupReservations();
      manager.killAll();
      server.close();
    }
  });
});
