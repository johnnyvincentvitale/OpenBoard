import { afterEach, describe, expect, it, vi } from "vitest";
import * as taskClient from "../../src/web/api/taskClient";
import { USER_COMPLETED_BY, buildTaskPath, type Task } from "../../src/shared";

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
  baseCommit: null,
  dirtyAtDispatch: false,
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

  it("getTasks appends the archived query when requested", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        expect(String(url)).toBe(`${buildTaskPath.list()}?archived=true`);
        return jsonResponse([sampleTask]);
      }),
    );

    expect(await taskClient.getTasks({ archived: "true" })).toEqual([sampleTask]);
  });

  it("archiveTask and unarchiveTask hit their routes", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe("/api/tasks/task_1/archive");
        expect(init?.method).toBe("POST");
        return jsonResponse({ ...sampleTask, archived: true });
      })
      .mockImplementationOnce(async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe("/api/tasks/task_1/unarchive");
        expect(init?.method).toBe("POST");
        return jsonResponse({ ...sampleTask, archived: false });
      });
    vi.stubGlobal("fetch", fetchMock);

    expect((await taskClient.archiveTask("task_1")).archived).toBe(true);
    expect((await taskClient.unarchiveTask("task_1")).archived).toBe(false);
  });

  it("addLink and removeLink hit the frozen link endpoints", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe("/api/tasks/task_1/links");
        expect(init?.method).toBe("POST");
        expect(init?.body).toBe(JSON.stringify({ parentId: "parent_1" }));
        return jsonResponse({ ...sampleTask, parentIds: ["parent_1"] });
      })
      .mockImplementationOnce(async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe("/api/tasks/task_1/links/parent_1");
        expect(init?.method).toBe("DELETE");
        return jsonResponse({ ...sampleTask, parentIds: [] });
      });
    vi.stubGlobal("fetch", fetchMock);

    expect((await taskClient.addLink("task_1", "parent_1")) as Task).toMatchObject({ parentIds: ["parent_1"] });
    expect((await taskClient.removeLink("task_1", "parent_1")) as Task).toMatchObject({ parentIds: [] });
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

  it("moveTask POSTs column/position and forwards completedBy when provided", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(buildTaskPath.move("task_1"));
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify({ column: "done", position: 0, completedBy: USER_COMPLETED_BY }));
      return jsonResponse([{ ...sampleTask, column: "done", completedBy: USER_COMPLETED_BY }]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await taskClient.moveTask("task_1", "done", 0, USER_COMPLETED_BY);

    expect(result[0]?.column).toBe("done");
    expect(result[0]?.completedBy).toBe(USER_COMPLETED_BY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("moveTask omits completedBy from the body when not provided", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(buildTaskPath.move("task_1"));
      expect(init?.body).toBe(JSON.stringify({ column: "todo", position: 1 }));
      return jsonResponse([sampleTask]);
    });
    vi.stubGlobal("fetch", fetchMock);

    await taskClient.moveTask("task_1", "todo", 1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
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
