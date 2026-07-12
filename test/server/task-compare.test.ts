import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { compareTaskEvidence } from "../../src/server/task-compare";
import type { Task } from "../../src/shared";

// Wraps execGit in a spy so tests can prove that task-compare's isValidRef()
// never invokes `git rev-parse --verify <ref>` with an unsafe, dash-prefixed
// ref, while every other diff-engine export keeps its real implementation.
vi.mock("../../src/server/diff-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/diff-engine")>();
  return { ...actual, execGit: vi.fn(actual.execGit) };
});
import { execGit } from "../../src/server/diff-engine";

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

describe("compareTaskEvidence", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ocb-compare-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("regression: returns only the Build->Fix delta, omitting the baseline->Build hunk", async () => {
    const { baseCommit, repoDir } = initRepo(join(tmpDir, "repo"));

    const buildWt = join(tmpDir, "build");
    runGit(repoDir, ["worktree", "add", "-b", "board/build", buildWt, "HEAD"]);
    writeFileSync(join(buildWt, "README.md"), "# Build output\n");
    runGit(buildWt, ["add", "README.md"]);
    runGit(buildWt, ["commit", "-m", "build output"]);

    const fixWt = join(tmpDir, "fix");
    runGit(repoDir, ["worktree", "add", "-b", "board/fix", fixWt, "HEAD"]);
    runGit(fixWt, ["merge", "board/build", "-m", "merge build output"]);
    writeFileSync(join(fixWt, "fix.ts"), "export const fix = true;\n");
    runGit(fixWt, ["add", "fix.ts"]);
    runGit(fixWt, ["commit", "-m", "fix output"]);

    const buildTask = makeTask({
      id: "task_build",
      directory: repoDir,
      worktreePath: buildWt,
      worktreeBranch: "board/build",
      baseBranch: "main",
      baseCommit,
    });
    const fixTask = makeTask({
      id: "task_fix",
      directory: repoDir,
      worktreePath: fixWt,
      worktreeBranch: "board/fix",
      baseBranch: "main",
      baseCommit,
    });

    const result = await compareTaskEvidence(buildTask, fixTask);
    expect(result.kind).toBe("diff");
    if (result.kind === "diff") {
      expect(result.files.map((f) => f.file)).toEqual(["fix.ts"]);
      expect(result.files.some((f) => f.file === "README.md")).toBe(false);
      expect(result.capped).toBe(false);
      expect(result.baseRef).toBe("board/build");
      // Target has a live worktree, so targetRef is null even though a branch exists.
      expect(result.targetRef).toBeNull();
    }
  });

  it("refuses honestly when the base Review card's work is uncommitted in its live worktree", async () => {
    const { baseCommit, repoDir } = initRepo(join(tmpDir, "repo"));

    // Base: worktree with UNCOMMITTED edits — branch tip is still the fork commit.
    const buildWt = join(tmpDir, "build");
    runGit(repoDir, ["worktree", "add", "-b", "board/build", buildWt, "HEAD"]);
    writeFileSync(join(buildWt, "README.md"), "# Uncommitted build output\n");

    const fixWt = join(tmpDir, "fix");
    runGit(repoDir, ["worktree", "add", "-b", "board/fix", fixWt, "HEAD"]);
    writeFileSync(join(fixWt, "fix.ts"), "export const fix = true;\n");
    runGit(fixWt, ["add", "fix.ts"]);
    runGit(fixWt, ["commit", "-m", "fix output"]);

    const buildTask = makeTask({
      id: "task_build",
      directory: repoDir,
      worktreePath: buildWt,
      worktreeBranch: "board/build",
      baseBranch: "main",
      baseCommit,
    });
    const fixTask = makeTask({
      id: "task_fix",
      directory: repoDir,
      worktreePath: fixWt,
      worktreeBranch: "board/fix",
      baseBranch: "main",
      baseCommit,
    });

    const result = await compareTaskEvidence(buildTask, fixTask);
    expect(result.kind).toBe("no-git");
    if (result.kind === "no-git") {
      expect(result.reason).toContain("uncommitted");
      expect(result.reason).toContain("board/build");
    }
  });

  it("still compares against a live-worktree base whose branch has real commits beyond the fork point", async () => {
    const { baseCommit, repoDir } = initRepo(join(tmpDir, "repo"));

    const buildWt = join(tmpDir, "build");
    runGit(repoDir, ["worktree", "add", "-b", "board/build", buildWt, "HEAD"]);
    writeFileSync(join(buildWt, "README.md"), "# Committed build output\n");
    runGit(buildWt, ["add", "README.md"]);
    runGit(buildWt, ["commit", "-m", "build output"]);
    // Extra uncommitted noise on top of the committed output must not block the compare.
    writeFileSync(join(buildWt, "scratch.txt"), "wip\n");

    const fixWt = join(tmpDir, "fix");
    runGit(repoDir, ["worktree", "add", "-b", "board/fix", fixWt, "HEAD"]);
    runGit(fixWt, ["merge", "board/build", "-m", "merge build output"]);
    writeFileSync(join(fixWt, "fix.ts"), "export const fix = true;\n");
    runGit(fixWt, ["add", "fix.ts"]);
    runGit(fixWt, ["commit", "-m", "fix output"]);

    const buildTask = makeTask({
      id: "task_build",
      directory: repoDir,
      worktreePath: buildWt,
      worktreeBranch: "board/build",
      baseBranch: "main",
      baseCommit,
    });
    const fixTask = makeTask({
      id: "task_fix",
      directory: repoDir,
      worktreePath: fixWt,
      worktreeBranch: "board/fix",
      baseBranch: "main",
      baseCommit,
    });

    const result = await compareTaskEvidence(buildTask, fixTask);
    expect(result.kind).toBe("diff");
  });

  it("returns an empty diff when both task outputs are identical", async () => {
    const { baseCommit, repoDir } = initRepo(join(tmpDir, "repo"));

    const wtA = join(tmpDir, "a");
    runGit(repoDir, ["worktree", "add", "-b", "board/a", wtA, "HEAD"]);
    writeFileSync(join(wtA, "same.ts"), "export const same = true;\n");
    runGit(wtA, ["add", "same.ts"]);
    runGit(wtA, ["commit", "-m", "task a"]);

    const wtB = join(tmpDir, "b");
    runGit(repoDir, ["worktree", "add", "-b", "board/b", wtB, "HEAD"]);
    writeFileSync(join(wtB, "same.ts"), "export const same = true;\n");
    runGit(wtB, ["add", "same.ts"]);
    runGit(wtB, ["commit", "-m", "task b"]);

    const taskA = makeTask({
      id: "task_a",
      directory: repoDir,
      worktreePath: wtA,
      worktreeBranch: "board/a",
      baseBranch: "main",
      baseCommit,
    });
    const taskB = makeTask({
      id: "task_b",
      directory: repoDir,
      worktreePath: wtB,
      worktreeBranch: "board/b",
      baseBranch: "main",
      baseCommit,
    });

    const result = await compareTaskEvidence(taskA, taskB);
    expect(result.kind).toBe("diff");
    if (result.kind === "diff") {
      expect(result.files).toEqual([]);
      expect(result.capped).toBe(false);
    }
  });

  it("compares an integrated Done branch against a live Review worktree", async () => {
    const { baseCommit, repoDir } = initRepo(join(tmpDir, "repo"));

    const doneWt = join(tmpDir, "done");
    runGit(repoDir, ["worktree", "add", "-b", "board/done", doneWt, "HEAD"]);
    writeFileSync(join(doneWt, "done.ts"), "export const done = true;\n");
    runGit(doneWt, ["add", "done.ts"]);
    runGit(doneWt, ["commit", "-m", "done task"]);
    runGit(repoDir, ["worktree", "remove", doneWt]);

    const reviewWt = join(tmpDir, "review");
    // Build the review worktree on top of the Done output so the comparison
    // shows only the Review delta beyond Done.
    runGit(repoDir, ["worktree", "add", "-b", "board/review", reviewWt, "board/done"]);
    writeFileSync(join(reviewWt, "review.ts"), "export const review = true;\n");
    // Intentionally leave uncommitted.

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
      worktreePath: reviewWt,
      worktreeBranch: "board/review",
      baseBranch: "main",
      baseCommit,
    });

    const result = await compareTaskEvidence(doneTask, reviewTask);
    expect(result.kind).toBe("diff");
    if (result.kind === "diff") {
      expect(result.files.map((f) => f.file)).toEqual(["review.ts"]);
      expect(result.root).toBe(reviewWt);
      expect(result.baseRef).toBe("board/done");
      expect(result.targetRef).toBeNull();
    }
  });

  it("returns unsupported when the base task has only live uncommitted changes", async () => {
    const { baseCommit, repoDir } = initRepo(join(tmpDir, "repo"));

    const baseWt = join(tmpDir, "base");
    runGit(repoDir, ["worktree", "add", "-b", "board/base", baseWt, "HEAD"]);
    writeFileSync(join(baseWt, "only-live.ts"), "live;\n");
    // No durable branch/commit metadata on the task row.

    const targetWt = join(tmpDir, "target");
    runGit(repoDir, ["worktree", "add", "-b", "board/target", targetWt, "HEAD"]);

    const baseTask = makeTask({
      id: "task_base",
      directory: repoDir,
      worktreePath: baseWt,
      baseBranch: "main",
      baseCommit,
      // No worktreeBranch/harnessBranch/harnessCommit
    });
    const targetTask = makeTask({
      id: "task_target",
      directory: repoDir,
      worktreePath: targetWt,
      worktreeBranch: "board/target",
      baseBranch: "main",
      baseCommit,
    });

    const result = await compareTaskEvidence(baseTask, targetTask);
    expect(result.kind).toBe("no-git");
    if (result.kind === "no-git") {
      expect(result.baseRef).toBeNull();
      expect(result.reason).toContain("no durable branch");
    }
  });

  it("returns unsupported when the base durable ref is deleted", async () => {
    const { baseCommit, repoDir } = initRepo(join(tmpDir, "repo"));

    const baseTask = makeTask({
      id: "task_base",
      directory: repoDir,
      worktreeBranch: "board/deleted",
      baseBranch: "main",
      baseCommit,
    });
    const targetTask = makeTask({
      id: "task_target",
      directory: repoDir,
      worktreeBranch: "board/deleted-too",
      baseBranch: "main",
      baseCommit,
    });

    const result = await compareTaskEvidence(baseTask, targetTask);
    expect(result.kind).toBe("no-git");
    if (result.kind === "no-git") {
      expect(result.reason).toContain("not available");
    }
  });

  it("rejects cross-repo comparison", async () => {
    const repoA = initRepo(join(tmpDir, "repoA"));
    const repoB = initRepo(join(tmpDir, "repoB"));

    const baseTask = makeTask({
      id: "task_base",
      directory: repoA.repoDir,
      worktreeBranch: "main",
      baseBranch: "main",
      baseCommit: repoA.baseCommit,
    });
    const targetTask = makeTask({
      id: "task_target",
      directory: repoB.repoDir,
      worktreeBranch: "main",
      baseBranch: "main",
      baseCommit: repoB.baseCommit,
    });

    const result = await compareTaskEvidence(baseTask, targetTask);
    expect(result.kind).toBe("no-git");
    if (result.kind === "no-git") {
      expect(result.reason).toContain("not in the same git repository");
    }
  });

  it("marks binary files without patches", async () => {
    const { baseCommit, repoDir } = initRepo(join(tmpDir, "repo"));

    const baseWt = join(tmpDir, "base");
    runGit(repoDir, ["worktree", "add", "-b", "board/base", baseWt, "HEAD"]);

    const targetWt = join(tmpDir, "target");
    runGit(repoDir, ["worktree", "add", "-b", "board/target", targetWt, "HEAD"]);
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    writeFileSync(join(targetWt, "image.png"), binary);
    runGit(targetWt, ["add", "image.png"]);
    runGit(targetWt, ["commit", "-m", "add binary"]);

    const baseTask = makeTask({
      id: "task_base",
      directory: repoDir,
      worktreePath: baseWt,
      worktreeBranch: "board/base",
      baseBranch: "main",
      baseCommit,
    });
    const targetTask = makeTask({
      id: "task_target",
      directory: repoDir,
      worktreePath: targetWt,
      worktreeBranch: "board/target",
      baseBranch: "main",
      baseCommit,
    });

    const result = await compareTaskEvidence(baseTask, targetTask);
    expect(result.kind).toBe("diff");
    if (result.kind === "diff") {
      expect(result.files).toHaveLength(1);
      const file = result.files[0];
      expect(file.file).toBe("image.png");
      expect(file.status).toBe("added");
      expect(file.patch).toBeUndefined();
    }
  });

  it("caps combined patch bytes for large files", async () => {
    const { baseCommit, repoDir } = initRepo(join(tmpDir, "repo"));

    const baseWt = join(tmpDir, "base");
    runGit(repoDir, ["worktree", "add", "-b", "board/base", baseWt, "HEAD"]);

    const targetWt = join(tmpDir, "target");
    runGit(repoDir, ["worktree", "add", "-b", "board/target", targetWt, "HEAD"]);
    // ~1.3 MB of content produces a patch that exceeds the 2 MB cap
    // for a single file when combined with headers.
    // ~2.5 MB of content produces a patch that exceeds the 2 MB cap.
    const bigContent = "// line content that pads the patch beyond the two megabyte cap\n".repeat(50_000);
    writeFileSync(join(targetWt, "big.ts"), bigContent);
    runGit(targetWt, ["add", "big.ts"]);
    runGit(targetWt, ["commit", "-m", "big file"]);

    const baseTask = makeTask({
      id: "task_base",
      directory: repoDir,
      worktreePath: baseWt,
      worktreeBranch: "board/base",
      baseBranch: "main",
      baseCommit,
    });
    const targetTask = makeTask({
      id: "task_target",
      directory: repoDir,
      worktreePath: targetWt,
      worktreeBranch: "board/target",
      baseBranch: "main",
      baseCommit,
    });

    const result = await compareTaskEvidence(baseTask, targetTask);
    expect(result.kind).toBe("diff");
    if (result.kind === "diff") {
      expect(result.capped).toBe(true);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].patch).toBeUndefined();
    }
  });

  it("does not mutate repository state", async () => {
    const { baseCommit, repoDir } = initRepo(join(tmpDir, "repo"));

    const baseWt = join(tmpDir, "base");
    runGit(repoDir, ["worktree", "add", "-b", "board/base", baseWt, "HEAD"]);
    writeFileSync(join(baseWt, "base.ts"), "export const base = true;\n");
    runGit(baseWt, ["add", "base.ts"]);
    runGit(baseWt, ["commit", "-m", "base"]);

    const targetWt = join(tmpDir, "target");
    runGit(repoDir, ["worktree", "add", "-b", "board/target", targetWt, "HEAD"]);
    writeFileSync(join(targetWt, "target.ts"), "export const target = true;\n");
    runGit(targetWt, ["add", "target.ts"]);
    runGit(targetWt, ["commit", "-m", "target"]);

    // Snapshot the repo state before comparison.
    const beforeBaseHead = runGit(baseWt, ["rev-parse", "HEAD"]);
    const beforeTargetHead = runGit(targetWt, ["rev-parse", "HEAD"]);
    expect(existsSync(join(targetWt, "unwanted.ts"))).toBe(false);
    writeFileSync(join(targetWt, "untracked.ts"), "should remain;\n");

    const baseTask = makeTask({
      id: "task_base",
      directory: repoDir,
      worktreePath: baseWt,
      worktreeBranch: "board/base",
      baseBranch: "main",
      baseCommit,
    });
    const targetTask = makeTask({
      id: "task_target",
      directory: repoDir,
      worktreePath: targetWt,
      worktreeBranch: "board/target",
      baseBranch: "main",
      baseCommit,
    });

    const result = await compareTaskEvidence(baseTask, targetTask);
    expect(result.kind).toBe("diff");

    expect(runGit(baseWt, ["rev-parse", "HEAD"])).toBe(beforeBaseHead);
    expect(runGit(targetWt, ["rev-parse", "HEAD"])).toBe(beforeTargetHead);
    expect(readFileSync(join(targetWt, "untracked.ts"), "utf-8")).toBe("should remain;\n");
  });

  describe("dash-prefixed ref safety", () => {
    it("rejects a dash-prefixed base worktreeBranch before any rev-parse validation, returning an honest unsupported reason", async () => {
      const { baseCommit, repoDir } = initRepo(join(tmpDir, "repo"));

      const baseTask = makeTask({
        id: "task_base",
        directory: repoDir,
        worktreeBranch: "--upload-pack=evil",
        baseBranch: "main",
        baseCommit,
      });
      const targetTask = makeTask({
        id: "task_target",
        directory: repoDir,
        worktreeBranch: "main",
        baseBranch: "main",
        baseCommit,
      });

      vi.mocked(execGit).mockClear();
      const result = await compareTaskEvidence(baseTask, targetTask);

      expect(result.kind).toBe("no-git");
      if (result.kind === "no-git") {
        expect(result.baseRef).toBeNull();
        expect(result.reason).toMatch(/unsafe/i);
      }
      // isValidRef must never reach `git rev-parse --verify` with the unsafe ref.
      const unsafeRevParseCalls = vi.mocked(execGit).mock.calls.filter(
        ([, args]) => args.includes("--upload-pack=evil"),
      );
      expect(unsafeRevParseCalls).toHaveLength(0);
    });

    it("rejects a dash-prefixed target harnessBranch before any rev-parse validation, returning an honest unsupported reason", async () => {
      const { baseCommit, repoDir } = initRepo(join(tmpDir, "repo"));

      const baseTask = makeTask({
        id: "task_base",
        directory: repoDir,
        worktreeBranch: "main",
        baseBranch: "main",
        baseCommit,
      });
      const targetTask = makeTask({
        id: "task_target",
        harness: "claude-code",
        directory: repoDir,
        harnessBranch: "--upload-pack=evil",
        baseBranch: "main",
        baseCommit,
      });

      vi.mocked(execGit).mockClear();
      const result = await compareTaskEvidence(baseTask, targetTask);

      expect(result.kind).toBe("no-git");
      if (result.kind === "no-git") {
        expect(result.reason).toBeTruthy();
      }
      const unsafeRevParseCalls = vi.mocked(execGit).mock.calls.filter(
        ([, args]) => args.includes("--upload-pack=evil"),
      );
      expect(unsafeRevParseCalls).toHaveLength(0);
    });
  });
});
