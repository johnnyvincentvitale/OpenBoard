import { afterEach, describe, expect, it, vi } from "vitest";
import * as boardClient from "../../src/web/api/boardClient";
import { buildPath } from "../../src/shared";
import type { Card } from "../../src/shared";

function jsonResponse(body: unknown, init?: { status?: number; statusText?: string }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    statusText: init?.statusText,
    headers: { "Content-Type": "application/json" },
  });
}

const sampleCard: Card = {
  sessionId: "s1",
  title: "Test session",
  directory: "/tmp/foo",
  cost: 0,
  additions: 0,
  deletions: 0,
  files: 0,
  column: "todo",
  position: 0,
  liveState: "idle",
  updatedAt: 0,
};

describe("boardClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("getBoard hits buildPath.board and parses Card[]", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(buildPath.board());
      return jsonResponse([sampleCard]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await boardClient.getBoard();
    expect(result).toEqual([sampleCard]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("move POSTs to buildPath.cardMove with body and parses Card[]", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(buildPath.cardMove("s1"));
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ column: "in_progress", position: 2 });
      return jsonResponse([sampleCard]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await boardClient.move("s1", "in_progress", 2);
    expect(result).toEqual([sampleCard]);
  });

  it("prompt POSTs to buildPath.cardPrompt with text body", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(buildPath.cardPrompt("s1"));
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ text: "hello" });
      return new Response(null, { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(boardClient.prompt("s1", "hello")).resolves.toBeUndefined();
  });

  it("interrupt POSTs to buildPath.cardInterrupt", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(buildPath.cardInterrupt("s1"));
      expect(init?.method).toBe("POST");
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(boardClient.interrupt("s1")).resolves.toBeUndefined();
  });

  it("diff GETs buildPath.cardDiff and returns parsed array", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(buildPath.cardDiff("s1"));
      return jsonResponse([{ file: "a.ts", additions: 1, deletions: 0 }]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await boardClient.diff("s1");
    expect(result).toEqual([{ file: "a.ts", additions: 1, deletions: 0 }]);
  });

  it("getHealth GETs buildPath.health and maps opencode status", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(buildPath.health());
      return jsonResponse({ adapter: "ok", opencode: { status: "ok", version: "1.0.0" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await boardClient.getHealth();
    expect(result).toEqual({ opencode: "ok" });
  });

  it("getHealth maps unreachable opencode status", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ adapter: "ok", opencode: { status: "unreachable" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await boardClient.getHealth();
    expect(result).toEqual({ opencode: "unreachable" });
  });

  it("throws an Error carrying ErrorEnvelope.error.message on non-2xx", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { error: { code: "session_not_found", message: "Session not found" } },
        { status: 404, statusText: "Not Found" },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(boardClient.getBoard()).rejects.toThrow("Session not found");
  });

  it("falls back to statusText when body is not a valid envelope", async () => {
    const fetchMock = vi.fn(
      async () => new Response("", { status: 500, statusText: "Internal Server Error" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(boardClient.getBoard()).rejects.toThrow("Internal Server Error");
  });
});
