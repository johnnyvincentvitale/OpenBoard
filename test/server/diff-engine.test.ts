import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { computeDiff } from "../../src/server/diff-engine";
import type { Task } from "../../src/shared";

function runGit(cwd: string, args: string[]): string {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  return execFileSync("git", args, { cwd, encoding: "utf-8", env }).trim();
}

function makeBaseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_test",
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

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ocb-diff-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

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

describe("computeDiff", () => {
  describe("worktree cards", () => {
    it("returns a no-git sentinel when no base ref is recorded", async () => {
      const task = makeBaseTask({ worktreePath: "/tmp/wt", worktreeBranch: "board/task_test" });
      const result = await computeDiff(task);
      expect(result.kind).toBe("no-git");
      if (result.kind === "no-git") {
        expect(result.reason).toContain("base reference");
      }
    });

    it("returns uncommitted and untracked diffs for a live worktree before integration", async () => {
      const repoDir = join(tmpDir, "repo");
      const baseCommit = initRepo(repoDir);

      // Create a worktree
      const worktreePath = join(tmpDir, "wt");
      runGit(repoDir, ["worktree", "add", "-b", "board/task_test", worktreePath, "HEAD"]);

      // Make changes in the worktree without committing. Review happens
      // before OpenBoard creates the integration commit, so the diff endpoint
      // must show the live worktree state.
      writeFileSync(join(worktreePath, "README.md"), "# Worktree edit\n");
      writeFileSync(join(worktreePath, "src.ts"), "console.log('new');\n");

      const task = makeBaseTask({
        directory: repoDir,
        worktreePath,
        worktreeBranch: "board/task_test",
        baseBranch: "main",
        baseCommit,
      });

      const result = await computeDiff(task);
      expect(result.kind).toBe("diff");
      if (result.kind === "diff") {
        expect(result.files.map((f) => f.file).sort()).toEqual(["README.md", "src.ts"]);
        expect(result.files.find((f) => f.file === "README.md")?.status).toBe("modified");
        expect(result.files.find((f) => f.file === "src.ts")?.status).toBe("added");
        expect(result.capped).toBe(false);
      }
    });
  });

  describe("in-place cards", () => {
    it("returns a no-git sentinel when baseCommit is missing", async () => {
      const task = makeBaseTask({
        directory: join(tmpDir, "norepo"),
        baseCommit: null,
      });
      mkdirSync(task.directory, { recursive: true });
      const result = await computeDiff(task);
      expect(result.kind).toBe("no-git");
    });

    it("returns diffs against the recorded baseCommit", async () => {
      const repoDir = join(tmpDir, "repo");
      const baseCommit = initRepo(repoDir);

      // Make a tracked change
      writeFileSync(join(repoDir, "README.md"), "# Updated\nExtra line\n");
      // Make an untracked file
      writeFileSync(join(repoDir, "untracked.ts"), "export const x = 1;\n");

      const task = makeBaseTask({
        directory: repoDir,
        baseCommit,
        dirtyAtDispatch: false,
      });

      const result = await computeDiff(task);
      expect(result.kind).toBe("diff");
      if (result.kind === "diff") {
        expect(result.files.length).toBe(2); // modified README + added untracked.ts
        const readme = result.files.find((f) => f.file === "README.md");
        expect(readme).toBeDefined();
        expect(readme?.status).toBe("modified");
        expect(readme?.additions).toBeGreaterThan(0);

        const untracked = result.files.find((f) => f.file === "untracked.ts");
        expect(untracked).toBeDefined();
        expect(untracked?.status).toBe("added");
        expect(untracked?.additions).toBeGreaterThan(0);
        expect(untracked?.patch).toContain("+export const x = 1;");
        expect(result.capped).toBe(false);
      }
    });

    it("includes untracked files as added even when dirtyAtDispatch is true", async () => {
      const repoDir = join(tmpDir, "repo");
      const baseCommit = initRepo(repoDir);

      writeFileSync(join(repoDir, "untracked.ts"), "export const x = 1;\n");

      const task = makeBaseTask({
        directory: repoDir,
        baseCommit,
        dirtyAtDispatch: true,
      });

      const result = await computeDiff(task);
      expect(result.kind).toBe("diff");
      if (result.kind === "diff") {
        // dirtyAtDispatch only drives the TUI honesty label — the diff
        // content itself still includes untracked files as added.
        const untracked = result.files.find((f) => f.file === "untracked.ts");
        expect(untracked).toBeDefined();
        expect(untracked?.status).toBe("added");
        expect(untracked?.patch).toContain("+export const x = 1;");
      }
    });

    it("returns empty files when no changes exist", async () => {
      const repoDir = join(tmpDir, "repo");
      const baseCommit = initRepo(repoDir);

      const task = makeBaseTask({
        directory: repoDir,
        baseCommit,
      });

      const result = await computeDiff(task);
      expect(result.kind).toBe("diff");
      if (result.kind === "diff") {
        expect(result.files).toEqual([]);
        expect(result.capped).toBe(false);
      }
    });
  });

  describe("Claude Code cards", () => {
    it("returns a no-git sentinel when no harness metadata exists", async () => {
      const task = makeBaseTask({
        harness: "claude-code",
        directory: join(tmpDir, "norepo"),
      });
      mkdirSync(task.directory, { recursive: true });
      const result = await computeDiff(task);
      expect(result.kind).toBe("no-git");
    });

    it("returns diffs when harnessCwd + harnessBranch metadata exists", async () => {
      const repoDir = join(tmpDir, "repo");
      const baseCommit = initRepo(repoDir);

      // Create a worktree for the harness
      const harnessDir = join(tmpDir, "harness");
      runGit(repoDir, ["worktree", "add", "-b", "harness-branch", harnessDir, "HEAD"]);

      writeFileSync(join(harnessDir, "claude-work.ts"), "// claude edited\n");
      runGit(harnessDir, ["add", "claude-work.ts"]);
      runGit(harnessDir, ["commit", "-m", "claude work"]);

      const task = makeBaseTask({
        harness: "claude-code",
        directory: repoDir,
        harnessCwd: harnessDir,
        harnessBranch: "harness-branch",
        harnessCommit: runGit(harnessDir, ["rev-parse", "--short", "HEAD"]),
        baseCommit,
      });

      const result = await computeDiff(task);
      expect(result.kind).toBe("diff");
      if (result.kind === "diff") {
        expect(result.files.length).toBeGreaterThan(0);
        expect(result.files.some((f) => f.file === "claude-work.ts")).toBe(true);
      }
    });
  });

  describe("byte cap", () => {
    it("caps diff at ~2 MB total patch bytes", async () => {
      const repoDir = join(tmpDir, "repo");
      const baseCommit = initRepo(repoDir);

      // Create many large files to exceed the 2 MB cap.
      for (let i = 0; i < 30; i++) {
        const content = `export const v_${i} = "${"x".repeat(200_000)}";\n`;
        writeFileSync(join(repoDir, `large_${i}.ts`), content);
      }

      const task = makeBaseTask({
        directory: repoDir,
        baseCommit,
        dirtyAtDispatch: false,
      });

      const result = await computeDiff(task);
      expect(result.kind).toBe("diff");
      if (result.kind === "diff") {
        expect(result.capped).toBe(true);
        // At least some files should have patches (capped doesn't drop everything)
        const filesWithPatches = result.files.filter((f) => f.patch !== undefined);
        const filesWithoutPatches = result.files.filter((f) => f.patch === undefined);
        expect(filesWithPatches.length).toBeGreaterThan(0);
        expect(filesWithoutPatches.length).toBeGreaterThan(0);
        // All files should still have metadata.
        expect(result.files.every((f) => f.file && f.status && typeof f.additions === "number")).toBe(true);
      }
    });
  });

  describe("untracked file guards", () => {
    it("returns metadata-only entry and capped=true for an oversized untracked file", async () => {
      const repoDir = join(tmpDir, "repo");
      const baseCommit = initRepo(repoDir);

      // Just over the 1 MB per-file guard — large enough to prove the file's
      // content was never expanded into a text patch, small enough to keep
      // the test fast.
      writeFileSync(join(repoDir, "huge.txt"), "x".repeat(1_100_000));

      const task = makeBaseTask({
        directory: repoDir,
        baseCommit,
        dirtyAtDispatch: false,
      });

      const result = await computeDiff(task);
      expect(result.kind).toBe("diff");
      if (result.kind === "diff") {
        expect(result.capped).toBe(true);
        const huge = result.files.find((f) => f.file === "huge.txt");
        expect(huge).toBeDefined();
        expect(huge?.status).toBe("added");
        expect(huge?.patch).toBeUndefined();
      }
    });

    it("returns metadata-only entry for an untracked binary file without a garbage text patch", async () => {
      const repoDir = join(tmpDir, "repo");
      const baseCommit = initRepo(repoDir);

      const binary = Buffer.alloc(200);
      binary.writeUInt8(0x89, 0);
      binary.writeUInt8(0x00, 50); // NUL byte marks it binary
      writeFileSync(join(repoDir, "untracked.png"), binary);

      const task = makeBaseTask({
        directory: repoDir,
        baseCommit,
        dirtyAtDispatch: false,
      });

      const result = await computeDiff(task);
      expect(result.kind).toBe("diff");
      if (result.kind === "diff") {
        const img = result.files.find((f) => f.file === "untracked.png");
        expect(img).toBeDefined();
        expect(img?.status).toBe("added");
        expect(img?.patch).toBeUndefined();
      }
    });
  });

  describe("edge cases", () => {
    it("handles binary files without crashing", async () => {
      const repoDir = join(tmpDir, "repo");
      const baseCommit = initRepo(repoDir);

      // Create a binary file
      const binary = Buffer.alloc(100);
      binary.writeUInt8(0x89, 0);
      writeFileSync(join(repoDir, "img.png"), binary);
      runGit(repoDir, ["add", "img.png"]);
      runGit(repoDir, ["commit", "-m", "add binary"]);

      const afterCommit = runGit(repoDir, ["rev-parse", "HEAD"]);

      // Modify it
      binary.writeUInt8(0xFF, 50);
      writeFileSync(join(repoDir, "img.png"), binary);

      const task = makeBaseTask({
        directory: repoDir,
        baseCommit: afterCommit,
      });

      const result = await computeDiff(task);
      expect(result.kind).toBe("diff");
      if (result.kind === "diff") {
        const binaryFile = result.files.find((f) => f.file === "img.png");
        expect(binaryFile).toBeDefined();
        expect(binaryFile?.status).toBe("modified");
      }
    });

    it("handles deleted files", async () => {
      const repoDir = join(tmpDir, "repo");
      const baseCommit = initRepo(repoDir);

      writeFileSync(join(repoDir, "to-delete.ts"), "export const x = 1;\n");
      runGit(repoDir, ["add", "to-delete.ts"]);
      runGit(repoDir, ["commit", "-m", "add to-delete"]);

      const afterCommit = runGit(repoDir, ["rev-parse", "HEAD"]);

      // Delete the file
      unlinkSync(join(repoDir, "to-delete.ts"));
      runGit(repoDir, ["rm", "to-delete.ts"]);

      const task = makeBaseTask({
        directory: repoDir,
        baseCommit: afterCommit,
      });

      const result = await computeDiff(task);
      expect(result.kind).toBe("diff");
      if (result.kind === "diff") {
        const deleted = result.files.find((f) => f.file === "to-delete.ts");
        expect(deleted).toBeDefined();
        expect(deleted?.status).toBe("deleted");
        expect(deleted?.deletions).toBeGreaterThan(0);
      }
    });

    it("handles renamed files", async () => {
      const repoDir = join(tmpDir, "repo");
      const baseCommit = initRepo(repoDir);

      writeFileSync(join(repoDir, "old.ts"), "export const x = 1;\n");
      runGit(repoDir, ["add", "old.ts"]);
      runGit(repoDir, ["commit", "-m", "add old"]);

      const afterCommit = runGit(repoDir, ["rev-parse", "HEAD"]);

      // Rename
      runGit(repoDir, ["mv", "old.ts", "new.ts"]);

      const task = makeBaseTask({
        directory: repoDir,
        baseCommit: afterCommit,
      });

      const result = await computeDiff(task);
      expect(result.kind).toBe("diff");
      if (result.kind === "diff") {
        expect(result.files.length).toBeGreaterThan(0);
        expect(result.files.some((f) => f.file.includes(".ts"))).toBe(true);
      }
    });

    it("returns no-git sentinel for a non-git directory", async () => {
      const nonRepo = join(tmpDir, "not-a-repo");
      mkdirSync(nonRepo, { recursive: true });

      const task = makeBaseTask({
        directory: nonRepo,
        baseCommit: null,
      });

      const result = await computeDiff(task);
      expect(result.kind).toBe("no-git");
      if (result.kind === "no-git") {
        expect(result.reason).toContain("No git evidence");
      }
    });
  });
});
