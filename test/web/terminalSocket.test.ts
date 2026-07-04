import { describe, expect, it, vi } from "vitest";
import { connectTerminalSocket, createTerminal } from "../../src/web/api/terminalSocket";

class FakeSocket {
  listeners = new Map<string, Set<EventListener>>();
  sent: string[] = [];
  closed = false;

  addEventListener(type: string, listener: EventListener) {
    const set = this.listeners.get(type) ?? new Set<EventListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, event: Event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("terminalSocket", () => {
  it("POSTs to create a terminal with injectable fetch", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "t-1", token: "abc", cwd: "/repo" }), { status: 201 }));
    const result = await createTerminal({ taskId: "task-1", cols: 80, rows: 24 }, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith("/api/terminals", expect.objectContaining({ method: "POST" }));
    expect(result).toEqual({ id: "t-1", token: "abc", cwd: "/repo" });
  });

  it("builds a ws url and serializes input/resize messages", () => {
    const socket = new FakeSocket();
    const connection = connectTerminalSocket(
      "terminal 1",
      "tok",
      { onData: vi.fn(), onExit: vi.fn() },
      { locationHref: "https://localhost:5173/board", makeSocket: () => socket },
    );

    expect(connection.url).toBe("wss://localhost:5173/api/terminals/terminal%201/socket?token=tok");

    connection.input("pwd\n");
    connection.resize(120, 40);

    expect(socket.sent).toEqual([
      JSON.stringify({ type: "input", data: "pwd\n" }),
      JSON.stringify({ type: "resize", cols: 120, rows: 40 }),
    ]);
  });

  it("dispatches data and exit messages from the socket", () => {
    const socket = new FakeSocket();
    const onData = vi.fn();
    const onExit = vi.fn();

    connectTerminalSocket("terminal-1", "tok", { onData, onExit }, { locationHref: "http://localhost:3000", makeSocket: () => socket });

    socket.emit("message", new MessageEvent("message", { data: JSON.stringify({ type: "data", data: "hello" }) }));
    socket.emit("message", new MessageEvent("message", { data: JSON.stringify({ type: "exit", code: 0 }) }));

    expect(onData).toHaveBeenCalledWith("hello");
    expect(onExit).toHaveBeenCalledWith(0);
  });
});
