import { afterEach, describe, expect, it, vi } from "vitest";
import * as taskClient from "../../src/web/api/taskClient";
import { buildTaskPath, type Task } from "../../src/shared";

function jsonResponse(body: unknown, init?: { status?: number; statusText?: string }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    statusText: init?.statusText,
    headers: { "Content-Type": "application/json" },
  });
}

const sampleTask: Task = {
  id: "task_1",
  title: "Stop work",
  description: "stop the session",
  directory: "/tmp/project",
  agent: "build",
  column: "in_progress",
  position: 0,
  sessionId: "ses_1",
  runState: "idle",
  createdAt: 1,
  updatedAt: 2,
};

describe("taskClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("abortTask POSTs to the abort route and parses a Task response", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(buildTaskPath.abort("task_1"));
      expect(init?.method).toBe("POST");
      return jsonResponse(sampleTask);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await taskClient.abortTask("task_1");

    expect(result).toEqual(sampleTask);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
