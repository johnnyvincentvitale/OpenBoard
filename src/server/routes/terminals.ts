import { timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { upgradeWebSocket } from "@hono/node-server";
import type { CreateTerminalInput, TerminalClientMessage, TerminalServerMessage } from "../../shared";
import { TERMINAL_ROUTE_PATTERNS } from "../../shared";
import { AdapterError } from "../../shared/errors";
import { PtyManager, TerminalManagerError, type TerminalReservationClaim } from "../terminal/pty-manager";

interface RegisterTerminalRoutesDeps {
  manager: PtyManager;
}

interface ForbiddenTerminalError {
  status: 403;
  message: string;
}

function isLocalHostname(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function getHostName(host: string): string {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return "";
  }
}

export function isAllowedOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!host) return false;
  const hostName = getHostName(host);
  if (!isLocalHostname(hostName)) return false;
  if (!origin) return true;

  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && isLocalHostname(url.hostname);
  } catch {
    return false;
  }
}

export function isValidReservationToken(expected: string, candidate: string | undefined): boolean {
  if (!candidate) return false;
  const expectedBuffer = Buffer.from(expected);
  const candidateBuffer = Buffer.from(candidate);
  if (expectedBuffer.length !== candidateBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, candidateBuffer);
}

function forbidden(message: string): ForbiddenTerminalError {
  return { status: 403, message };
}

function respondWithError(err: unknown): { status: number; body: { error: { code: string; message: string } } } {
  if ((err as ForbiddenTerminalError)?.status === 403) {
    const blocked = err as ForbiddenTerminalError;
    return { status: blocked.status, body: AdapterError.validation(blocked.message).toEnvelope() };
  }
  if (err instanceof TerminalManagerError) {
    return { status: err.status, body: AdapterError.validation(err.message).toEnvelope() };
  }
  if (err instanceof AdapterError) {
    return { status: err.status, body: err.toEnvelope() };
  }
  const fallback = AdapterError.internal("Unexpected error", err);
  return { status: fallback.status, body: fallback.toEnvelope() };
}

function parseCreateBody(body: Partial<CreateTerminalInput>): CreateTerminalInput {
  const { taskId, cwd, cols, rows } = body;
  if (taskId !== undefined && typeof taskId !== "string") {
    throw AdapterError.validation("taskId must be a string");
  }
  if (cwd !== undefined && typeof cwd !== "string") {
    throw AdapterError.validation("cwd must be a string");
  }
  if (cols !== undefined && (!Number.isFinite(cols) || cols <= 0)) {
    throw AdapterError.validation("cols must be a positive number");
  }
  if (rows !== undefined && (!Number.isFinite(rows) || rows <= 0)) {
    throw AdapterError.validation("rows must be a positive number");
  }
  return { taskId, cwd, cols, rows };
}

function parseClientMessage(raw: string): TerminalClientMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const message = parsed as Partial<TerminalClientMessage> & { type?: unknown };
  if (message.type === "input" && typeof message.data === "string") {
    return { type: "input", data: message.data };
  }
  if (
    message.type === "resize" &&
    typeof message.cols === "number" &&
    Number.isFinite(message.cols) &&
    typeof message.rows === "number" &&
    Number.isFinite(message.rows)
  ) {
    return { type: "resize", cols: message.cols, rows: message.rows };
  }
  return undefined;
}

function sendServerMessage(ws: { send(data: string): void }, message: TerminalServerMessage): void {
  ws.send(JSON.stringify(message));
}

export function registerTerminalRoutes(app: Hono, deps: RegisterTerminalRoutesDeps): void {
  const { manager } = deps;
  const attachClaims = new WeakMap<Request, TerminalReservationClaim>();

  app.use(TERMINAL_ROUTE_PATTERNS.socket, async (c, next) => {
    if (!isAllowedOrigin(c.req.header("origin"), c.req.header("host"))) {
      const response = respondWithError(forbidden("Terminal routes accept local requests only"));
      return c.json(response.body, response.status as ContentfulStatusCode);
    }

    const id = c.req.param("id");
    const token = c.req.query("token");
    const reservation = manager.getReservation(id);
    if (!reservation) {
      const response = respondWithError(AdapterError.notFound("Terminal reservation not found"));
      return c.json(response.body, response.status as ContentfulStatusCode);
    }
    if (!isValidReservationToken(reservation.token, token)) {
      const response = respondWithError(forbidden("Invalid terminal token"));
      return c.json(response.body, response.status as ContentfulStatusCode);
    }

    try {
      attachClaims.set(c.req.raw, manager.beginAttach(id, token ?? ""));
    } catch (err) {
      const response = respondWithError(err);
      return c.json(response.body, response.status as ContentfulStatusCode);
    }

    return next();
  });

  app.post(TERMINAL_ROUTE_PATTERNS.create, async (c) => {
    try {
      if (!isAllowedOrigin(c.req.header("origin"), c.req.header("host"))) {
        throw forbidden("Terminal routes accept local requests only");
      }

      let body: Partial<CreateTerminalInput>;
      try {
        body = await c.req.json();
      } catch {
        throw AdapterError.validation("Request body must be valid JSON");
      }

      const reservation = await manager.reserve(parseCreateBody(body));
      return c.json({ id: reservation.id, token: reservation.token, cwd: reservation.cwd }, 201);
    } catch (err) {
      const response = respondWithError(err);
      return c.json(response.body, response.status as ContentfulStatusCode);
    }
  });

  app.get(
    TERMINAL_ROUTE_PATTERNS.socket,
    upgradeWebSocket((c) => {
      const claim = attachClaims.get(c.req.raw);
      if (!claim) {
        throw AdapterError.internal("Terminal attach claim was not initialized");
      }
      attachClaims.delete(c.req.raw);

      let handle: Awaited<ReturnType<PtyManager["create"]>> | undefined;
      let socketClosed = false;
      let attachSettled = false;

      const releaseClaim = () => {
        if (attachSettled) return;
        attachSettled = true;
        claim.release();
      };

      const consumeClaim = () => {
        if (attachSettled) return;
        attachSettled = true;
        claim.consume();
      };

      return {
        onOpen(_event, ws) {
          void (async () => {
            try {
              const createdHandle = await manager.create({
                cwd: claim.reservation.cwd,
                cols: claim.reservation.cols,
                rows: claim.reservation.rows,
              });
              consumeClaim();

              if (socketClosed) {
                createdHandle.kill();
                return;
              }

              handle = createdHandle;
              handle.onData((data) => sendServerMessage(ws, { type: "data", data }));
              handle.onExit((code) => {
                sendServerMessage(ws, { type: "exit", code });
                ws.close();
              });
            } catch {
              if (socketClosed) {
                consumeClaim();
                return;
              }

              releaseClaim();
              ws.close(1011, "terminal-start-failed");
            }
          })();
        },
        onMessage(event, _ws) {
          if (!handle || typeof event.data !== "string") return;
          const message = parseClientMessage(event.data);
          if (!message) return;
          if (message.type === "input") {
            handle.write(message.data);
            return;
          }
          handle.resize(message.cols, message.rows);
        },
        onClose() {
          socketClosed = true;
          if (handle) {
            handle.kill();
            return;
          }

          if (attachSettled) return;
        },
      };
    }),
  );
}
