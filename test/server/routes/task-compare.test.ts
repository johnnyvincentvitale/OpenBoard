import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { SqliteTaskStore } from "../../../src/db/task-store";
import { registerTaskCompareRoutes } from "../../../src/server/routes/task-compare";

function appFor(store: SqliteTaskStore): Hono {
  const app = new Hono();
  registerTaskCompareRoutes(app, { store });
  return app;
}

function storeCreate(store: SqliteTaskStore, title: string, directory: string) {
  return store.create({ title, description: "", directory });
}

function runGit(cwd: string, args: string[]): string {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  return execFileSync("git", args, { cwd, encoding: "utf-8", env }).trim();
}

function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  runGit(dir, ["init", "-b", "main"]);
  runGit(dir, ["config", "user.email", "test@test.com"]);
  runGit(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "# Test\n");
  runGit(dir, ["add", "README.md"]);
  runGit(dir, ["commit", "-m", "initial"]);
  return runGit(dir, ["rev-parse", "HEAD"]);
}

describe("task compare route", () => {
  let store: SqliteTaskStore;

  beforeEach(() => {
    store = new SqliteTaskStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("returns 400 when baseTaskId is missing", async () => {
    const task = storeCreate(store, "Task", "/repo");
    const app = appFor(store);

    const res = await app.request(`/api/tasks/${task.id}/compare`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("validation");
    expect(body.error.message).toContain("baseTaskId");
  });

  it("returns 400 when baseTaskId equals targetId", async () => {
    const task = storeCreate(store, "Task", "/repo");
    const app = appFor(store);

    const res = await app.request(`/api/tasks/${task.id}/compare?baseTaskId=${encodeURIComponent(task.id)}`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("same as targetId");
  });

  it("returns 404 when target task does not exist", async () => {
    const base = storeCreate(store, "Base", "/repo");
    const app = appFor(store);

    const res = await app.request(`/api/tasks/missing/compare?baseTaskId=${encodeURIComponent(base.id)}`);
    expect(res.status).toBe(404);
  });

  it("returns 404 when base task does not exist", async () => {
    const target = storeCreate(store, "Target", "/repo");
    const app = appFor(store);

    const res = await app.request(`/api/tasks/${target.id}/compare?baseTaskId=missing`);
    expect(res.status).toBe(404);
  });

  it("returns 200 with a DiffResponse-style comparison result for two known tasks", async () => {
    const base = storeCreate(store, "Base", "/repo");
    const target = storeCreate(store, "Target", "/repo");
    const app = appFor(store);

    const res = await app.request(`/api/tasks/${target.id}/compare?baseTaskId=${encodeURIComponent(base.id)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("no-git"); // /repo is not a real git repo
    expect(body.baseTaskId).toBe(base.id);
    expect(body.targetTaskId).toBe(target.id);
    expect(body.reason).toBeTruthy();
  });

  it("URL-decodes task ids", async () => {
    const base = storeCreate(store, "Base", "/repo");
    const target = storeCreate(store, "Target", "/repo");
    const app = appFor(store);

    const res = await app.request(`/api/tasks/${encodeURIComponent(target.id)}/compare?baseTaskId=${encodeURIComponent(base.id)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.targetTaskId).toBe(target.id);
  });

  describe("dash-prefixed ref safety", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "ocb-compare-route-test-"));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns a 200 honest no-git response for a dash-prefixed base worktreeBranch instead of a 500", async () => {
      // A real git repo, so a fix regression would otherwise reach a real
      // `git rev-parse --verify` call with the dash-prefixed ref instead of
      // short-circuiting on "not a git repository".
      const repoDir = join(tmpDir, "repo");
      initRepo(repoDir);

      const base = storeCreate(store, "Base", repoDir);
      store.update(base.id, { worktreeBranch: "--upload-pack=evil" });
      const target = storeCreate(store, "Target", repoDir);
      store.update(target.id, { worktreeBranch: "main" });
      const app = appFor(store);

      const res = await app.request(`/api/tasks/${target.id}/compare?baseTaskId=${encodeURIComponent(base.id)}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.kind).toBe("no-git");
      expect(body.reason).toMatch(/unsafe/i);
    });

    it("returns a 200 honest no-git response for a dash-prefixed target harnessBranch instead of a 500", async () => {
      const repoDir = join(tmpDir, "repo");
      initRepo(repoDir);

      const base = storeCreate(store, "Base", repoDir);
      store.update(base.id, { worktreeBranch: "main" });
      const target = storeCreate(store, "Target", repoDir);
      store.update(target.id, { harness: "claude-code", harnessBranch: "--upload-pack=evil" });
      const app = appFor(store);

      const res = await app.request(`/api/tasks/${target.id}/compare?baseTaskId=${encodeURIComponent(base.id)}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.kind).toBe("no-git");
      expect(body.reason).toBeTruthy();
    });
  });
});
