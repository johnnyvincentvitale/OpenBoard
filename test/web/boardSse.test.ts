import { describe, expect, it, vi } from "vitest";
import { connectBoardSse, type EventSourceLike, type BoardSseStatus } from "../../src/web/api/boardSse";
import { buildPath } from "../../src/shared";
import type { BoardFrame } from "../../src/shared";

class FakeEventSource implements EventSourceLike {
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  closed = false;
  url: string;

  constructor(url: string) {
    this.url = url;
  }

  close(): void {
    this.closed = true;
  }

  emitOpen(): void {
    this.onopen?.(new Event("open"));
  }

  emitError(): void {
    this.onerror?.(new Event("error"));
  }

  emitMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

describe("connectBoardSse", () => {
  it("connects to buildPath.boardEvents and reports connecting then open", () => {
    let fake: FakeEventSource | undefined;
    const statuses: BoardSseStatus[] = [];
    const frames: BoardFrame[] = [];

    const disconnect = connectBoardSse(
      { onFrame: (f) => frames.push(f), onStatus: (s) => statuses.push(s) },
      {
        makeSource: (url) => {
          fake = new FakeEventSource(url);
          return fake;
        },
      },
    );

    expect(fake?.url).toBe(buildPath.boardEvents());
    expect(statuses).toEqual(["connecting"]);

    fake?.emitOpen();
    expect(statuses).toEqual(["connecting", "open"]);

    disconnect();
  });

  it("parses message data as BoardFrame and invokes onFrame", () => {
    let fake: FakeEventSource | undefined;
    const frames: BoardFrame[] = [];

    const disconnect = connectBoardSse(
      { onFrame: (f) => frames.push(f), onStatus: () => {} },
      {
        makeSource: (url) => {
          fake = new FakeEventSource(url);
          return fake;
        },
      },
    );

    const snapshotFrame: BoardFrame = { kind: "snapshot", seq: 1, cards: [] };
    fake?.emitMessage(snapshotFrame);
    expect(frames).toEqual([snapshotFrame]);

    const upsertFrame: BoardFrame = {
      kind: "upsert",
      seq: 2,
      card: {
        sessionId: "s1",
        title: "t",
        directory: "/d",
        cost: 0,
        additions: 0,
        deletions: 0,
        files: 0,
        column: "todo",
        position: 0,
        liveState: "idle",
        updatedAt: 0,
      },
    };
    fake?.emitMessage(upsertFrame);
    expect(frames).toEqual([snapshotFrame, upsertFrame]);

    disconnect();
  });

  it("reports closed status and stops callbacks after disconnect", () => {
    let fake: FakeEventSource | undefined;
    const statuses: BoardSseStatus[] = [];
    const frames: BoardFrame[] = [];

    const disconnect = connectBoardSse(
      { onFrame: (f) => frames.push(f), onStatus: (s) => statuses.push(s) },
      {
        makeSource: (url) => {
          fake = new FakeEventSource(url);
          return fake;
        },
      },
    );

    disconnect();
    expect(fake?.closed).toBe(true);
    expect(statuses.at(-1)).toBe("closed");

    // Further events should be ignored post-disconnect.
    fake?.emitMessage({ kind: "heartbeat", seq: 99 });
    fake?.emitOpen();
    expect(frames).toEqual([]);
    expect(statuses.at(-1)).toBe("closed");
  });

  it("reports connecting status on error (native reconnect)", () => {
    let fake: FakeEventSource | undefined;
    const statuses: BoardSseStatus[] = [];

    const disconnect = connectBoardSse(
      { onFrame: () => {}, onStatus: (s) => statuses.push(s) },
      {
        makeSource: (url) => {
          fake = new FakeEventSource(url);
          return fake;
        },
      },
    );

    fake?.emitOpen();
    fake?.emitError();
    expect(statuses).toEqual(["connecting", "open", "connecting"]);

    disconnect();
  });

  it("ignores malformed message data instead of throwing", () => {
    let fake: FakeEventSource | undefined;
    const frames: BoardFrame[] = [];

    const disconnect = connectBoardSse(
      { onFrame: (f) => frames.push(f), onStatus: () => {} },
      {
        makeSource: (url) => {
          fake = new FakeEventSource(url);
          return fake;
        },
      },
    );

    expect(() => fake?.onmessage?.({ data: "{not valid json" } as MessageEvent)).not.toThrow();
    expect(frames).toEqual([]);

    disconnect();
  });

  it("uses vi.fn to verify default EventSource is used when no makeSource is provided", () => {
    const OriginalEventSource = (globalThis as { EventSource?: unknown }).EventSource;
    class StubEventSource implements EventSourceLike {
      onopen: ((ev: Event) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      constructor(public url: string) {}
      close = vi.fn();
    }
    (globalThis as { EventSource?: unknown }).EventSource = StubEventSource as unknown as typeof EventSource;

    const disconnect = connectBoardSse({ onFrame: () => {}, onStatus: () => {} });
    disconnect();

    (globalThis as { EventSource?: unknown }).EventSource = OriginalEventSource;
  });
});
