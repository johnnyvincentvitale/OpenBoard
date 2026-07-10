import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { compareTaskEvidence, normalizeFilePath } from "../../src/server/task-compare";
import type { Task } from "../../src/shared";

function runGit(cwd: string, args: string[]): string {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  return execFileSync("git", args, { cwd, encoding: "utf-8", env }).trim();
}

function initRepo(dir: string): { baseCommit: string; repoDir: string } {
  mkdirSync(dir, { recursive: true });
  runGit(dir, ["init", "-b", "main"]);
  runGit(dir, ["config", "user.email", "test@test.com"]);
  runGit(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "# Test\n");
  runGit(dir, ["add", "README.md"]);
  runGit(dir, ["commit", "-m", "initial"]);
  return { baseCommit: runGit(dir, ["rev-parse", "HEAD"]), repoDir: dir };
}

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: "Test task",
    description: "Test",
    directory: "/tmp/test",
    column: "review",
    position: 0,
    runState: "idle",
    createdAt: 0,
    updatedAt: 0,
    baseCommit: null,
    dirtyAtDispatch: false,
    ...overrides,
  };
}

describe("normalizeFilePath", () => {
  it("returns repo-relative paths and rejects escapes", () => {
    expect(normalizeFilePath("src/a.ts")).toBe("src/a.ts");
    expect(normalizeFilePath("./src/a.ts")).toBe("src/a.ts");
    expect(normalizeFilePath("/etc/passwd")).toBeUndefined();
    expect(normalizeFilePath("../escape")).toBeUndefined();
    expect(normalizeFilePath("src/../../escape")).toBeUndefined();
    expect(normalizeFilePath("")).toBeUndefined();
    expect(normalizeFilePath("  ")).toBeUndefined();
  });
});

describe("compareTaskEvidence", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ocb-compare-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports identical evidence when both tasks changed the same files the same way", async () => {
    const { baseCommit, repoDir } = initRepo(join(tmpDir, "repo"));

    const wtA = join(tmpDir, "wtA");
    runGit(repoDir, ["worktree", "add", "-b", "board/task_a", wtA, "HEAD"]);
    writeFileSync(join(wtA, "shared.ts"), "export const x = 1;\n");
    runGit(wtA, ["add", "shared.ts"]);
    runGit(wtA, ["commit", "-m", "task a"]);

    const wtB = join(tmpDir, "wtB");
    runGit(repoDir, ["worktree", "add", "-b", "board/task_b", wtB, "HEAD"]);
    writeFileSync(join(wtB, "shared.ts"), "export const x = 1;\n");
    runGit(wtB, ["add", "shared.ts"]);
    runGit(wtB, ["commit", "-m", "task b"]);

    const baseTask = makeTask({
      id: "task_a",
      directory: repoDir,
      worktreePath: wtA,
      worktreeBranch: "board/task_a",
      baseBranch: "main",
      baseCommit,
    });
    const targetTask = makeTask({
      id: "task_b",
      directory: repoDir,
      worktreePath: wtB,
      worktreeBranch: "board/task_b",
      baseBranch: "main",
      baseCommit,
    });

    const result = await compareTaskEvidence(baseTask, targetTask);
    expect(result.kind).toBe("comparison");
    expect(result.conflict).toBe(false);
    expect(result.stale).toBe(false);
    expect(result.unavailable).toHaveLength(0);
    expect(result.files.map((f) => f.file)).toEqual(["shared.ts"]);
    const file = result.files[0];
    expect(file.status).toBe("added");
    expect(file.baseStatus).toBe("added");
    expect(file.targetStatus).toBe("added");
    expect(file.basePatch).toBeDefined();
    expect(file.basePatch).toBe(file.targetPatch);
  });

  it("flags conflicts when ancestor build and audit/fix touch the same file differently", async () => {
    const { baseCommit, repoDir } = initRepo(join(tmpDir, "repo"));

    const buildWt = join(tmpDir, "build");
    runGit(repoDir, ["worktree", "add", "-b", "board/build", buildWt, "HEAD"]);
    writeFileSync(join(buildWt, "src.ts"), "export const build = true;\n");
    runGit(buildWt, ["add", "src.ts"]);
    runGit(buildWt, ["commit", "-m", "build"]);

    const auditWt = join(tmpDir, "audit");
    runGit(repoDir, ["worktree", "add", "-b", "board/audit", auditWt, "HEAD"]);
    writeFileSync(join(auditWt, "src.ts"), "export const audit = true;\n");
    runGit(auditWt, ["add", "src.ts"]);
    runGit(auditWt, ["commit", "-m", "audit"]);

    const baseTask = makeTask({
      id: "task_build",
      directory: repoDir,
      worktreePath: buildWt,
      worktreeBranch: "board/build",
      baseBranch: "main",
      baseCommit,
      taskKind: "build",
    });
    const targetTask = makeTask({
      id: "task_audit",
      directory: repoDir,
      worktreePath: auditWt,
      worktreeBranch: "board/audit",
      baseBranch: "main",
      baseCommit,
      taskKind: "audit",
    });

    const result = await compareTaskEvidence(baseTask, targetTask);
    expect(result.conflict).toBe(true);
    expect(result.files).toHaveLength(1);
    const file = result.files[0];
    expect(file.file).toBe("src.ts");
    expect(file.status).toBe("conflict");
    expect(file.baseStatus).toBe("added");
    expect(file.targetStatus).toBe("added");
    expect(file.basePatch).not.toBe(file.targetPatch);
  });

  it("compares an integrated Done card against a live Review card", async () => {
    const { baseCommit, repoDir } = initRepo(join(tmpDir, "repo"));

    // Done card: worktree removed, branch retained.
    const doneWt = join(tmpDir, "done");
    runGit(repoDir, ["worktree", "add", "-b", "board/done", doneWt, "HEAD"]);
    writeFileSync(join(doneWt, "done.ts"), "export const done = true;\n");
    runGit(doneWt, ["add", "done.ts"]);
    runGit(doneWt, ["commit", "-m", "done task"]);
    runGit(repoDir, ["worktree", "remove", doneWt]);

    // Review card: live worktree with uncommitted changes.
    const reviewWt = join(tmpDir, "review");
    runGit(repoDir, ["worktree", "add", "-b", "board/review", reviewWt, "HEAD"]);
    writeFileSync(join(reviewWt, "review.ts"), "export const review = true;\n");
    // Intentionally leave uncommitted so computeDiff includes untracked file.

    const doneTask = makeTask({
      id: "task_done",
      directory: repoDir,
      column: "done",
      worktreeBranch: "board/done",
      baseBranch: "main",
      baseCommit,
    });
    const reviewTask = makeTask({
      id: "task_review",
      directory: repoDir,
      column: "review",
      worktreePath: reviewWt,
      worktreeBranch: "board/review",
      baseBranch: "main",
      baseCommit,
    });

    const result = await compareTaskEvidence(doneTask, reviewTask);
    expect(result.kind).toBe("comparison");
    expect(result.unavailable).toHaveLength(0);
    expect(result.files.map((f) => f.file).sort()).toEqual(["done.ts", "review.ts"]);
    expect(result.files.find((f) => f.file === "done.ts")?.status).toBe("added");
    expect(result.files.find((f) => f.file === "review.ts")?.status).toBe("added");
  });

  it("uses completion changedFiles as stale metadata fallback when worktree/branch is gone", async () => {
    const { repoDir } = initRepo(join(tmpDir, "repo"));

    const baseTask = makeTask({
      id: "task_base",
      directory: repoDir,
      worktreeBranch: "board/missing-base",
      baseBranch: "main",
      baseCommit: "deadbeef",
      completion: {
        outcome: "complete",
        summary: "base work",
        changedFiles: ["base.ts"],
        verification: [],
        residualRisk: "none",
        reportedAt: 1,
      },
    });
    const targetTask = makeTask({
      id: "task_target",
      directory: repoDir,
      worktreeBranch: "board/missing-target",
      baseBranch: "main",
      baseCommit: "deadbeef",
      completion: {
        outcome: "complete",
        summary: "target work",
        changedFiles: ["base.ts", "target.ts"],
        verification: [],
        residualRisk: "none",
        reportedAt: 2,
      },
    });

    const result = await compareTaskEvidence(baseTask, targetTask);
    expect(result.stale).toBe(true);
    expect(result.files.map((f) => f.file).sort()).toEqual(["base.ts", "target.ts"]);
    const shared = result.files.find((f) => f.file === "base.ts");
    expect(shared?.status).toBe("conflict");
    expect(shared?.baseStatus).toBe("modified");
    expect(shared?.targetStatus).toBe("modified");
    const targetOnly = result.files.find((f) => f.file === "target.ts");
    expect(targetOnly?.status).toBe("stale");
  });

  it("reports unavailable when neither task has any git evidence or completion report", async () => {
    const repoDir = join(tmpDir, "repo");
    mkdirSync(repoDir, { recursive: true });

    const baseTask = makeTask({ id: "task_base", directory: repoDir });
    const targetTask = makeTask({ id: "task_target", directory: repoDir });

    const result = await compareTaskEvidence(baseTask, targetTask);
    expect(result.unavailable).toHaveLength(2);
    expect(result.files).toEqual([]);
    expect(result.conflict).toBe(false);
    expect(result.stale).toBe(false);
  });

  it("still includes available task's files when the other has no evidence", async () => {
    const { baseCommit, repoDir } = initRepo(join(tmpDir, "repo"));

    const wt = join(tmpDir, "wt");
    runGit(repoDir, ["worktree", "add", "-b", "board/wt", wt, "HEAD"]);
    writeFileSync(join(wt, "only.ts"), "single;\n");
    runGit(wt, ["add", "only.ts"]);
    runGit(wt, ["commit", "-m", "only task"]);

    const goodTask = makeTask({
      id: "task_good",
      directory: repoDir,
      worktreePath: wt,
      worktreeBranch: "board/wt",
      baseBranch: "main",
      baseCommit,
    });
    const emptyTask = makeTask({ id: "task_empty", directory: repoDir });

    const result = await compareTaskEvidence(goodTask, emptyTask);
    expect(result.files.map((f) => f.file)).toEqual(["only.ts"]);
    expect(result.unavailable).toHaveLength(1);
    expect(result.unavailable[0].taskId).toBe("task_empty");
  });

  it("marks binary files without patches", async () => {
    const { baseCommit, repoDir } = initRepo(join(tmpDir, "repo"));

    const wt = join(tmpDir, "wt");
    runGit(repoDir, ["worktree", "add", "-b", "board/bin", wt, "HEAD"]);
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    writeFileSync(join(wt, "image.png"), binary);

    const task = makeTask({
      id: "task_bin",
      directory: repoDir,
      worktreePath: wt,
      worktreeBranch: "board/bin",
      baseBranch: "main",
      baseCommit,
    });

    const result = await compareTaskEvidence(task, task);
    expect(result.files).toHaveLength(1);
    const file = result.files[0];
    expect(file.file).toBe("image.png");
    expect(file.status).toBe("added");
    expect(file.basePatch).toBeUndefined();
    expect(file.targetPatch).toBeUndefined();
  });

  it("caps combined patch bytes across both tasks", async () => {
    const { baseCommit, repoDir } = initRepo(join(tmpDir, "repo"));

    // Generate ~1.3 MB of text per file so two of them exceed the 2 MB cap
    // when combined in the comparison response.
    const bigContent = "// line\n".repeat(120_000);

    const wtA = join(tmpDir, "wtA");
    runGit(repoDir, ["worktree", "add", "-b", "board/bigA", wtA, "HEAD"]);
    writeFileSync(join(wtA, "big.ts"), bigContent);
    runGit(wtA, ["add", "big.ts"]);
    runGit(wtA, ["commit", "-m", "big a"]);

    const wtB = join(tmpDir, "wtB");
    runGit(repoDir, ["worktree", "add", "-b", "board/bigB", wtB, "HEAD"]);
    writeFileSync(join(wtB, "big.ts"), bigContent + "// extra\n");
    runGit(wtB, ["add", "big.ts"]);
    runGit(wtB, ["commit", "-m", "big b"]);

    const baseTask = makeTask({
      id: "task_big_a",
      directory: repoDir,
      worktreePath: wtA,
      worktreeBranch: "board/bigA",
      baseBranch: "main",
      baseCommit,
    });
    const targetTask = makeTask({
      id: "task_big_b",
      directory: repoDir,
      worktreePath: wtB,
      worktreeBranch: "board/bigB",
      baseBranch: "main",
      baseCommit,
    });

    const result = await compareTaskEvidence(baseTask, targetTask);
    expect(result.capped).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].basePatch).toBeUndefined();
    expect(result.files[0].targetPatch).toBeUndefined();
  });
});
