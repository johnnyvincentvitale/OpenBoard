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

  it("syncTask returns the MergeOutcome body even on a 409 conflict (no throw)", async () => {
    const outcome = { task: sampleTask, ok: false, conflict: true, message: "conflict" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        expect(String(url)).toBe(buildTaskPath.sync("task_1"));
        return jsonResponse(outcome, { status: 409 });
      }),
    );

    const result = await taskClient.syncTask("task_1");
    expect(result.conflict).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("integrateTask throws on a non-409 error status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { message: "boom" } }, { status: 500 })),
    );
    await expect(taskClient.integrateTask("task_1")).rejects.toThrow("boom");
  });

  it("getSettings + updateSettings hit /api/settings", async () => {
    const getMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(buildTaskPath.settings());
      return jsonResponse({ worktreeDefault: false });
    });
    vi.stubGlobal("fetch", getMock);
    expect(await taskClient.getSettings()).toEqual({ worktreeDefault: false });

    const putMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(buildTaskPath.settings());
      expect(init?.method).toBe("PUT");
      return jsonResponse({ worktreeDefault: true });
    });
    vi.stubGlobal("fetch", putMock);
    expect(await taskClient.updateSettings({ worktreeDefault: true })).toEqual({
      worktreeDefault: true,
    });
  });
});
