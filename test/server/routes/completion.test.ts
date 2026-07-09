import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { SqliteTaskStore } from "../../../src/db/task-store";
import { registerCompletionRoutes } from "../../../src/server/routes/completion";
import { createChainAdvancer } from "../../../src/server/chain-advancer";
import type { Task } from "../../../src/shared";

const validBody = {
  summary: "implemented the change",
  changedFiles: ["src/file.ts"],
  verification: [{ command: "npm test", result: "passed" }],
  residualRisk: "none",
};

function appFor(store: SqliteTaskStore, advancer?: ReturnType<typeof createChainAdvancer>): Hono {
  const app = new Hono();
  registerCompletionRoutes(app, { store, advancer });
  return app;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("completion routes", () => {
  let store: SqliteTaskStore;
  let tempDirs: string[];

  beforeEach(() => {
    store = new SqliteTaskStore(":memory:");
    tempDirs = [];
  });

  afterEach(() => {
    store.close();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, {
      cwd,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
      encoding: "utf8",
    }).trim();
  }

  function gitRepoWithClaudeWorktree(): { repo: string; worktree: string; branch: string; commit: string } {
    const root = mkdtempSync(join(tmpdir(), "openboard-completion-"));
    tempDirs.push(root);
    const repo = join(root, "repo");
    const worktree = join(root, "claude-worktree");
    mkdirSync(repo);
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "openboard@example.test"]);
    git(repo, ["config", "user.name", "OpenBoard Test"]);
    git(repo, ["checkout", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "before\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "initial"]);
    git(repo, ["worktree", "add", "-b", "worktree-readme", worktree, "HEAD"]);
    writeFileSync(join(worktree, "README.md"), "after\n");
    git(worktree, ["add", "README.md"]);
    git(worktree, ["commit", "-m", "claude edit"]);
    return { repo, worktree, branch: git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]), commit: git(worktree, ["rev-parse", "--short", "HEAD"]) };
  }

  it("POST /complete on a running task stores a reported completion and moves to review/idle", async () => {
    const task = store.create({ title: "A", description: "do it", directory: "/repo" });
    store.update(task.id, { runState: "running" });
    store.move(task.id, "in_progress", 0);
    const app = appFor(store);

    const res = await app.request(`/api/tasks/${task.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runState).toBe("idle");
    expect(body.column).toBe("review");
    expect(body.completionSource).toBe("reported");
    expect(body.completion).toMatchObject({ ...validBody, outcome: "complete" });
    expect(typeof body.completion.reportedAt).toBe("number");
  });

  it("stores optional final OpenCode session output but reports null for Claude Code", async () => {
    const openCode = store.create({ title: "OpenCode", description: "do it", directory: "/repo" });
    store.update(openCode.id, { runState: "running" });
    store.move(openCode.id, "in_progress", 0);
    const claude = store.create({ harness: "claude-code", title: "Claude", description: "do it", directory: "/repo" });
    store.update(claude.id, { runState: "running" });
    store.move(claude.id, "in_progress", 0);
    const app = appFor(store);

    const openCodeRes = await app.request(`/api/tasks/${openCode.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validBody, finalSessionOutput: "final assistant output" }),
    });
    const claudeRes = await app.request(`/api/tasks/${claude.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validBody, finalSessionOutput: "not available from claude" }),
    });

    expect(openCodeRes.status).toBe(200);
    expect((await openCodeRes.json()).finalSessionOutput).toBe("final assistant output");
    expect(claudeRes.status).toBe(200);
    expect((await claudeRes.json()).finalSessionOutput).toBeNull();
  });

  it("POST /complete clears busy Claude harness status when the report lands", async () => {
    const task = store.create({
      harness: "claude-code",
      title: "Claude",
      description: "do it",
      directory: "/repo",
    });
    store.update(task.id, { runState: "running", harnessStatus: "busy" });
    store.move(task.id, "in_progress", 0);
    const app = appFor(store);

    const res = await app.request(`/api/tasks/${task.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runState).toBe("idle");
    expect(body.harnessStatus).toBe("idle");
    expect(body.completionSource).toBe("reported");
  });

  it("POST /complete records Claude worktree result metadata when edits land outside the task directory", async () => {
    const { repo, worktree, branch, commit } = gitRepoWithClaudeWorktree();
    const task = store.create({
      harness: "claude-code",
      title: "Claude",
      description: "edit readme",
      directory: repo,
    });
    store.update(task.id, {
      runState: "running",
      harnessStatus: "busy",
      harnessCwd: worktree,
    });
    store.move(task.id, "in_progress", 0);
    const app = appFor(store);

    const res = await app.request(`/api/tasks/${task.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validBody, changedFiles: ["README.md"] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.completionLocation).toBe("harness-directory");
    expect(body.harnessCwd).toBe(worktree);
    expect(body.harnessBranch).toBe(branch);
    expect(body.harnessCommit).toBe(commit);
    expect(body.worktreePath).toBe(worktree);
    expect(body.worktreeBranch).toBe(branch);
    expect(body.baseBranch).toBe("main");
  });

  it("POST /complete blocks a worktree run with a base-checkout escape while preserving the report", async () => {
    const { repo } = gitRepoWithClaudeWorktree();
    const task = store.create({
      title: "Escaped OpenCode report",
      description: "do it",
      directory: repo,
    });
    store.update(task.id, {
      runState: "running",
      isolationAtDispatch: "worktree",
      baseCheckoutSnapshot: "",
    });
    store.move(task.id, "in_progress", 0);
    writeFileSync(join(repo, "escaped.txt"), "escaped write\n");
    const app = appFor(store);

    const res = await app.request(`/api/tasks/${task.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.column).toBe("in_progress");
    expect(body.runState).toBe("idle");
    expect(body.pending).toBe("base-checkout-escape");
    expect(body.escapeDetectedPaths).toEqual(["escaped.txt"]);
    expect(body.completionSource).toBe("reported");
    expect(body.completion).toMatchObject({ ...validBody, outcome: "complete" });
  });

  it("POST /complete blocks a Claude Code worktree run with a base-checkout escape while preserving the report", async () => {
    const { repo, worktree } = gitRepoWithClaudeWorktree();
    const task = store.create({
      harness: "claude-code",
      title: "Escaped Claude report",
      description: "do it",
      directory: repo,
    });
    store.update(task.id, {
      runState: "running",
      harnessStatus: "busy",
      harnessCwd: worktree,
      isolationAtDispatch: "worktree",
      baseCheckoutSnapshot: "",
    });
    store.move(task.id, "in_progress", 0);
    writeFileSync(join(repo, "claude-escaped.txt"), "escaped write\n");
    const app = appFor(store);

    const res = await app.request(`/api/tasks/${task.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validBody, changedFiles: ["README.md"] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.column).toBe("in_progress");
    expect(body.runState).toBe("idle");
    expect(body.harnessStatus).toBe("blocked");
    expect(body.pending).toBe("base-checkout-escape");
    expect(body.escapeDetectedPaths).toEqual(["claude-escaped.txt"]);
    expect(body.completionSource).toBe("reported");
    expect(body.completion).toMatchObject({ outcome: "complete", summary: validBody.summary });
  });

  it("POST /complete does not run escape detection for an in-place task with a Claude-managed worktreePath", async () => {
    const { repo, worktree } = gitRepoWithClaudeWorktree();
    const task = store.create({
      harness: "claude-code",
      title: "In-place Claude report",
      description: "do it",
      directory: repo,
      isolation: "in-place",
    });
    store.update(task.id, {
      runState: "running",
      harnessStatus: "busy",
      harnessCwd: worktree,
      worktreePath: worktree,
      isolationAtDispatch: "in-place",
      baseCheckoutSnapshot: null,
    });
    store.move(task.id, "in_progress", 0);
    writeFileSync(join(repo, "expected-base-change.txt"), "expected\n");
    const app = appFor(store);

    const res = await app.request(`/api/tasks/${task.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validBody, changedFiles: ["README.md"] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.column).toBe("review");
    expect(body.pending).toBeUndefined();
    expect(body.completionSource).toBe("reported");
    expect(body.completion).toMatchObject({ outcome: "complete", summary: validBody.summary });
  });

  it("POST /complete fail-closes a worktree run with a null dispatch snapshot against current base dirt", async () => {
    const { repo } = gitRepoWithClaudeWorktree();
    const task = store.create({
      title: "Null snapshot escape",
      description: "do it",
      directory: repo,
    });
    store.update(task.id, {
      runState: "running",
      isolationAtDispatch: "worktree",
      baseCheckoutSnapshot: null,
    });
    store.move(task.id, "in_progress", 0);
    writeFileSync(join(repo, "preexisting-or-escaped.txt"), "dirty\n");
    const app = appFor(store);

    const res = await app.request(`/api/tasks/${task.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.column).toBe("in_progress");
    expect(body.pending).toBe("base-checkout-escape");
    expect(body.escapeDetectedPaths).toEqual(["preexisting-or-escaped.txt"]);
    expect(body.completion).toMatchObject({ outcome: "complete", summary: validBody.summary });
  });

  it("POST /block on a running task stores a reported block and moves to review/error", async () => {
    const task = store.create({ title: "A", description: "do it", directory: "/repo" });
    store.update(task.id, { runState: "running" });
    store.move(task.id, "in_progress", 0);
    const app = appFor(store);

    const res = await app.request(`/api/tasks/${task.id}/block`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validBody, residualRisk: "needs human decision" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runState).toBe("error");
    expect(body.column).toBe("review");
    expect(body.error).toBe("needs human decision");
    expect(body.completionSource).toBe("reported");
    expect(body.completion).toMatchObject({ outcome: "blocked", residualRisk: "needs human decision" });
  });

  it("returns 409 for a non-running task", async () => {
    const task = store.create({ title: "A", description: "do it", directory: "/repo" });
    const app = appFor(store);

    const res = await app.request(`/api/tasks/${task.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(409);
  });

  it("upgrades an idle-fallback review task when the late /complete report arrives", async () => {
    const task = store.create({ title: "A", description: "do it", directory: "/repo" });
    store.update(task.id, {
      sessionId: "ses_1",
      runState: "idle",
      runStartedAt: 100,
      completion: null,
      completionSource: "idle-fallback",
      finalSessionOutput: "captured assistant output",
    });
    store.move(task.id, "review", 0);
    const app = appFor(store);

    const res = await app.request(`/api/tasks/${task.id}/complete?runStartedAt=100`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.column).toBe("review");
    expect(body.position).toBe(0);
    expect(body.runState).toBe("idle");
    expect(body.completionSource).toBe("reported");
    expect(body.completion).toMatchObject({ ...validBody, outcome: "complete" });
    expect(body.finalSessionOutput).toBe("captured assistant output");
  });

  it("upgrades an idle-fallback review task when the late /block report arrives", async () => {
    const task = store.create({ title: "A", description: "do it", directory: "/repo" });
    store.update(task.id, {
      sessionId: "ses_1",
      runState: "idle",
      runStartedAt: 100,
      completion: null,
      completionSource: "idle-fallback",
      finalSessionOutput: "captured assistant output",
    });
    store.move(task.id, "review", 0);
    const app = appFor(store);

    const res = await app.request(`/api/tasks/${task.id}/block?runStartedAt=100`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validBody, residualRisk: "needs credentials" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.column).toBe("review");
    expect(body.runState).toBe("error");
    expect(body.error).toBe("needs credentials");
    expect(body.completionSource).toBe("reported");
    expect(body.completion).toMatchObject({ outcome: "blocked", residualRisk: "needs credentials" });
    expect(body.finalSessionOutput).toBe("captured assistant output");
  });

  it("rejects an idle-fallback upgrade after the task has been re-dispatched", async () => {
    const task = store.create({ title: "A", description: "do it", directory: "/repo" });
    store.update(task.id, {
      sessionId: "ses_1",
      runState: "idle",
      runStartedAt: 100,
      completion: null,
      completionSource: "idle-fallback",
    });
    store.move(task.id, "review", 0);
    store.update(task.id, {
      runState: "running",
      runStartedAt: 200,
      completion: null,
      completionSource: null,
    });
    store.move(task.id, "in_progress", 0);
    const app = appFor(store);

    const res = await app.request(`/api/tasks/${task.id}/complete?runStartedAt=100`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toBe("Completion report is stale for this task run");
    expect(store.get(task.id)?.completionSource).toBeNull();
  });

  it("returns 400 for malformed bodies", async () => {
    const task = store.create({ title: "A", description: "do it", directory: "/repo" });
    store.update(task.id, { runState: "running" });
    const app = appFor(store);

    const res = await app.request(`/api/tasks/${task.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validBody, changedFiles: [1] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation");
  });

  it("returns 404 for an unknown task", async () => {
    const app = appFor(store);

    const res = await app.request("/api/tasks/task_missing/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(404);
  });

  describe("chain advance on /complete", () => {
    function readyChild(parentId: string) {
      const child = store.create({
        title: "Child",
        description: "",
        directory: "/repo",
        isolation: "worktree",
        autoRun: true,
      });
      store.addLink(parentId, child.id);
      return child;
    }

    it("fires the ready child without delaying the /complete response", async () => {
      const parent = store.create({ title: "Parent", description: "do it", directory: "/repo" });
      store.update(parent.id, { runState: "running" });
      store.move(parent.id, "in_progress", 0);
      const child = readyChild(parent.id);

      let resolveRunTask: (() => void) | undefined;
      const runTask = vi.fn(
        (taskId: string) =>
          new Promise<Task>((resolve) => {
            resolveRunTask = () => {
              store.update(taskId, { runState: "running", column: "in_progress" });
              resolve(store.get(taskId)!);
            };
          }),
      );
      const advancer = createChainAdvancer({ store, runTask });
      const app = appFor(store, advancer);

      const res = await app.request(`/api/tasks/${parent.id}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody),
      });

      // The response already came back even though runTask's promise is
      // still pending — proves the advance never blocked this request.
      expect(res.status).toBe(200);
      expect(runTask).toHaveBeenCalledWith(child.id);
      expect(store.get(child.id)?.column).toBe("todo");

      resolveRunTask?.();
      await sleep(20);

      const dispatched = store.listEvents(child.id);
      expect(dispatched.some((e) => e.type === "task_auto_dispatched" && e.body.parentId === parent.id)).toBe(true);
    });

    it("does not fire the advancer on /block", async () => {
      const parent = store.create({ title: "Parent", description: "do it", directory: "/repo" });
      store.update(parent.id, { runState: "running" });
      store.move(parent.id, "in_progress", 0);
      readyChild(parent.id);
      const runTask = vi.fn(async (taskId: string) => store.get(taskId)!);
      const advancer = createChainAdvancer({ store, runTask });
      const app = appFor(store, advancer);

      const res = await app.request(`/api/tasks/${parent.id}/block`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...validBody, residualRisk: "needs human decision" }),
      });

      expect(res.status).toBe(200);
      await sleep(20);
      expect(runTask).not.toHaveBeenCalled();
    });

    it("does not fire the advancer on a base-checkout-escape report", async () => {
      const { repo } = gitRepoWithClaudeWorktree();
      const parent = store.create({ title: "Escaped parent", description: "do it", directory: repo });
      store.update(parent.id, {
        runState: "running",
        isolationAtDispatch: "worktree",
        baseCheckoutSnapshot: "",
      });
      store.move(parent.id, "in_progress", 0);
      writeFileSync(join(repo, "escaped.txt"), "escaped write\n");
      readyChild(parent.id);
      const runTask = vi.fn(async (taskId: string) => store.get(taskId)!);
      const advancer = createChainAdvancer({ store, runTask });
      const app = appFor(store, advancer);

      const res = await app.request(`/api/tasks/${parent.id}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(200);
      expect((await res.json()).pending).toBe("base-checkout-escape");
      await sleep(20);
      expect(runTask).not.toHaveBeenCalled();
    });

    it("fires the advancer on a late idle-fallback-upgrade /complete report", async () => {
      const parent = store.create({ title: "Parent", description: "do it", directory: "/repo" });
      store.update(parent.id, {
        sessionId: "ses_1",
        runState: "idle",
        runStartedAt: 100,
        completion: null,
        completionSource: "idle-fallback",
      });
      store.move(parent.id, "review", 0);
      const child = readyChild(parent.id);
      const runTask = vi.fn(async (taskId: string) => {
        store.update(taskId, { runState: "running", column: "in_progress" });
        return store.get(taskId)!;
      });
      const advancer = createChainAdvancer({ store, runTask });
      const app = appFor(store, advancer);

      const res = await app.request(`/api/tasks/${parent.id}/complete?runStartedAt=100`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody),
      });

      expect(res.status).toBe(200);
      await sleep(20);
      expect(runTask).toHaveBeenCalledWith(child.id);
    });
  });
});
