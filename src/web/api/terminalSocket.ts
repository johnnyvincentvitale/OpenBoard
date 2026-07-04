import type {
  CreateTerminalInput,
  CreateTerminalResponse,
  ErrorEnvelope,
  TerminalClientMessage,
  TerminalServerMessage,
} from "../../shared";
import { buildTerminalPath } from "../../shared";
import { boardAuthHeaders, boardTokenQueryParam } from "./auth";

export interface WebSocketLike {
  addEventListener(type: "open" | "message" | "error" | "close", listener: EventListener): void;
  removeEventListener(type: "open" | "message" | "error" | "close", listener: EventListener): void;
  send(data: string): void;
  close(): void;
}

export interface CreateTerminalOptions {
  fetchImpl?: typeof fetch;
}

export interface TerminalSocketHandlers {
  onOpen?: () => void;
  onData: (data: string) => void;
  onExit: (code: number | null) => void;
  onError?: (message: string) => void;
  onClose?: () => void;
}

export interface ConnectTerminalSocketOptions {
  locationHref?: string;
  makeSocket?: (url: string) => WebSocketLike;
}

export interface TerminalSocketConnection {
  url: string;
  input: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  close: () => void;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function assertOk(res: Response): Promise<unknown> {
  const body = await readJson(res);
  if (!res.ok) {
    const envelope = body as Partial<ErrorEnvelope> | undefined;
    throw new Error(envelope?.error?.message ?? res.statusText ?? "Request failed");
  }
  return body;
}

export async function createTerminal(
  input: CreateTerminalInput,
  opts: CreateTerminalOptions = {},
): Promise<CreateTerminalResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(buildTerminalPath.create(), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...boardAuthHeaders() },
    body: JSON.stringify(input),
  });
  return (await assertOk(res)) as CreateTerminalResponse;
}

function defaultMakeSocket(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

function buildSocketUrl(id: string, reservationToken: string, locationHref: string): string {
  const url = new URL(buildTerminalPath.socket(id), locationHref);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  // Reservation token (terminal-specific, validated by terminal route).
  url.searchParams.set("token", reservationToken);
  // Board API token (validated by global auth middleware).
  const boardTokenParam = boardTokenQueryParam();
  if (boardTokenParam) {
    const parts = boardTokenParam.split("=");
    if (parts[1]) url.searchParams.set(parts[0], parts[1]);
  }
  return url.toString();
}

function sendJson(socket: WebSocketLike, message: TerminalClientMessage): void {
  socket.send(JSON.stringify(message));
}

export function connectTerminalSocket(
  id: string,
  token: string,
  handlers: TerminalSocketHandlers,
  opts: ConnectTerminalSocketOptions = {},
): TerminalSocketConnection {
  const locationHref = opts.locationHref ?? location.href;
  const url = buildSocketUrl(id, token, locationHref);
  const socket = (opts.makeSocket ?? defaultMakeSocket)(url);
  let closed = false;

  const onOpen: EventListener = () => {
    if (!closed) handlers.onOpen?.();
  };

  const onMessage: EventListener = (event) => {
    if (closed) return;
    const data = (event as MessageEvent).data;
    if (typeof data !== "string") return;
    try {
      const message = JSON.parse(data) as TerminalServerMessage;
      if (message.type === "data") handlers.onData(message.data);
      if (message.type === "exit") handlers.onExit(message.code);
    } catch {
      handlers.onError?.("Malformed terminal message");
    }
  };

  const onError: EventListener = () => {
    if (!closed) handlers.onError?.("Terminal connection failed");
  };

  const onClose: EventListener = () => {
    if (closed) return;
    closed = true;
    handlers.onClose?.();
    socket.removeEventListener("open", onOpen);
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("error", onError);
    socket.removeEventListener("close", onClose);
  };

  socket.addEventListener("open", onOpen);
  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", onError);
  socket.addEventListener("close", onClose);

  return {
    url,
    input(data: string) {
      sendJson(socket, { type: "input", data });
    },
    resize(cols: number, rows: number) {
      sendJson(socket, { type: "resize", cols, rows });
    },
    close() {
      if (closed) return;
      closed = true;
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      socket.close();
    },
  };
}
