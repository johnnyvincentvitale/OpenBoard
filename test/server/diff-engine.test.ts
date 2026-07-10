import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  computeDiff,
  execGit,
  computeDiffBetweenRefs,
  computeDiffAgainstWorkingTree,
  resolveGitRepoRoot,
  resolveGitCommonDir,
  parseUnifiedDiff,
  capBytes,
  assertSafeRef,
} from "../../src/server/diff-engine";
import type { DiffFile, Task } from "../../src/shared";

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
        // root must be the worktree path, not the base repo the worktree was cut from.
        expect(result.root).toBe(worktreePath);
      }
    });

    it("uses the retained branch for a Done card after its worktree is removed", async () => {
      const repoDir = join(tmpDir, "repo");
      const baseCommit = initRepo(repoDir);
      const worktreePath = join(tmpDir, "wt");
      runGit(repoDir, ["worktree", "add", "-b", "board/task_test", worktreePath, "HEAD"]);

      writeFileSync(join(worktreePath, "task.ts"), "export const task = true;\n");
      runGit(worktreePath, ["add", "task.ts"]);
      runGit(worktreePath, ["commit", "-m", "task change"]);
      runGit(repoDir, ["worktree", "remove", worktreePath]);

      // Advance main independently after the task branch was frozen. A Done
      // task diff must not absorb this later, unrelated base-branch change.
      writeFileSync(join(repoDir, "later.ts"), "export const later = true;\n");
      runGit(repoDir, ["add", "later.ts"]);
      runGit(repoDir, ["commit", "-m", "later main change"]);

      const task = makeBaseTask({
        column: "done",
        directory: repoDir,
        worktreeBranch: "board/task_test",
        baseBranch: "main",
        baseCommit,
      });

      const result = await computeDiff(task);
      expect(result.kind).toBe("diff");
      if (result.kind === "diff") {
        expect(result.files.map((file) => file.file)).toEqual(["task.ts"]);
        expect(result.files.some((file) => file.file === "later.ts")).toBe(false);
        expect(result.root).toBeUndefined();
      }
    });

    it("rejects a dash-prefixed baseCommit ref defensively instead of passing it to git argv", async () => {
      const repoDir = join(tmpDir, "repo");
      initRepo(repoDir);
      const worktreePath = join(tmpDir, "wt");
      runGit(repoDir, ["worktree", "add", "-b", "board/task_test", worktreePath, "HEAD"]);

      const task = makeBaseTask({
        directory: repoDir,
        worktreePath,
        worktreeBranch: "board/task_test",
        baseBranch: "main",
        baseCommit: "--upload-pack=evil",
      });

      await expect(computeDiff(task)).rejects.toThrow(/dash-prefixed ref/i);
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
        // root for an in-place (dirty working-tree) diff is the task directory itself.
        expect(result.root).toBe(repoDir);
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
        expect(result.root).toBe(repoDir);
      }
    });

    it("rejects a dash-prefixed baseCommit ref defensively instead of passing it to git argv", async () => {
      const repoDir = join(tmpDir, "repo");
      initRepo(repoDir);

      const task = makeBaseTask({
        directory: repoDir,
        baseCommit: "--output=/etc/passwd",
      });

      await expect(computeDiff(task)).rejects.toThrow(/dash-prefixed ref/i);
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
        // root is the harness's own worktree cwd, not the task's base directory.
        expect(result.root).toBe(harnessDir);
      }
    });

    it("rejects a dash-prefixed harnessBranch ref defensively instead of passing it to git argv", async () => {
      const repoDir = join(tmpDir, "repo");
      const baseCommit = initRepo(repoDir);
      const harnessDir = join(tmpDir, "harness");
      runGit(repoDir, ["worktree", "add", "-b", "harness-branch", harnessDir, "HEAD"]);

      const task = makeBaseTask({
        harness: "claude-code",
        directory: repoDir,
        harnessCwd: harnessDir,
        harnessBranch: "--upload-pack=evil",
        baseCommit,
      });

      await expect(computeDiff(task)).rejects.toThrow(/dash-prefixed ref/i);
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

describe("diff-engine exported primitives", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ocb-diff-prim-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("execGit", () => {
    it("returns stdout and zero exit code on success", async () => {
      const repoDir = join(tmpDir, "repo");
      initRepo(repoDir);
      const result = await execGit(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("main");
    });

    it("returns non-zero code on invalid ref without throwing", async () => {
      const repoDir = join(tmpDir, "repo");
      initRepo(repoDir);
      const result = await execGit(repoDir, ["rev-parse", "nonexistent"])
      expect(result.code).not.toBe(0);
      expect(result.stderr || result.stdout).toBeTruthy();
    });
  });

  describe("assertSafeRef", () => {
    it("throws for a dash-prefixed ref", () => {
      expect(() => assertSafeRef("--upload-pack=evil")).toThrow(/dash-prefixed ref/i);
      expect(() => assertSafeRef("-x")).toThrow(/dash-prefixed ref/i);
    });

    it("does not throw for ordinary branch names, commit shas, or refs with dots/slashes", () => {
      expect(() => assertSafeRef("main")).not.toThrow();
      expect(() => assertSafeRef("board/task_1")).not.toThrow();
      expect(() => assertSafeRef("HEAD")).not.toThrow();
      expect(() => assertSafeRef("main...board/task_1")).not.toThrow();
      expect(() => assertSafeRef("deadbeef1234")).not.toThrow();
    });
  });

  describe("parseUnifiedDiff", () => {
    it("parses added, deleted, and modified files", () => {
      const raw = `diff --git a/add.ts b/add.ts
new file mode 100644
--- /dev/null
+++ b/add.ts
@@ -0,0 +1 @@
+hello
diff --git a/del.ts b/del.ts
deleted file mode 100644
--- a/del.ts
+++ /dev/null
@@ -1 +0,0 @@
-hello
diff --git a/mod.ts b/mod.ts
--- a/mod.ts
+++ b/mod.ts
@@ -1 +1 @@
-old
+new
`;
      const files = parseUnifiedDiff(raw);
      expect(files).toHaveLength(3);
      expect(files[0].file).toBe("add.ts");
      expect(files[0].status).toBe("added");
      expect(files[1].file).toBe("del.ts");
      expect(files[1].status).toBe("deleted");
      expect(files[2].file).toBe("mod.ts");
      expect(files[2].status).toBe("modified");
    });

    it("returns empty array for empty or whitespace input", () => {
      expect(parseUnifiedDiff("")).toEqual([]);
      expect(parseUnifiedDiff("   \n")).toEqual([]);
    });
  });

  describe("capBytes", () => {
    it("keeps patches that fit and drops the rest", () => {
      const files: DiffFile[] = [
        { file: "a.ts", patch: "a".repeat(10), additions: 0, deletions: 0, status: "modified" },
        { file: "b.ts", patch: "b".repeat(10), additions: 0, deletions: 0, status: "modified" },
      ];
      const result = capBytes(files, 15);
      expect(result.capped).toBe(true);
      expect(result.files[0].patch).toBeDefined();
      expect(result.files[1].patch).toBeUndefined();
    });

    it("leaves files unchanged when all patches fit", () => {
      const files: DiffFile[] = [
        { file: "a.ts", patch: "a".repeat(5), additions: 0, deletions: 0, status: "modified" },
      ];
      const result = capBytes(files, 100);
      expect(result.capped).toBe(false);
      expect(result.files[0].patch).toBe(files[0].patch);
    });
  });

  describe("computeDiffBetweenRefs", () => {
    it("returns a no-git sentinel when one or both refs do not exist", async () => {
      const repoDir = join(tmpDir, "repo");
      initRepo(repoDir);
      const result = await computeDiffBetweenRefs(repoDir, "missing", "also-missing");
      expect(result.kind).toBe("no-git");
    });

    it("returns the diff between two branches", async () => {
      const repoDir = join(tmpDir, "repo");
      initRepo(repoDir);
      runGit(repoDir, ["checkout", "-b", "feature"]);
      writeFileSync(join(repoDir, "feat.ts"), "export const feat = true;\n");
      runGit(repoDir, ["add", "feat.ts"]);
      runGit(repoDir, ["commit", "-m", "feature"]);
      runGit(repoDir, ["checkout", "main"]);

      const result = await computeDiffBetweenRefs(repoDir, "main", "feature");
      expect(result.kind).toBe("diff");
      if (result.kind === "diff") {
        expect(result.files.map((f) => f.file)).toEqual(["feat.ts"]);
        expect(result.files[0].status).toBe("added");
      }
    });

    it("rejects a dash-prefixed ref defensively instead of passing it to git argv (Build->Fix style comparison)", async () => {
      const repoDir = join(tmpDir, "repo");
      initRepo(repoDir);
      runGit(repoDir, ["checkout", "-b", "board/build"]);
      runGit(repoDir, ["checkout", "-b", "board/fix"]);

      await expect(
        computeDiffBetweenRefs(repoDir, "board/build", "--upload-pack=evil"),
      ).rejects.toThrow(/dash-prefixed ref/i);
    });

    it("returns an honest no-git result when git output exceeds a configured maxBuffer, never parsing truncated stdout", async () => {
      const repoDir = join(tmpDir, "repo");
      initRepo(repoDir);
      runGit(repoDir, ["checkout", "-b", "board/build"]);
      writeFileSync(join(repoDir, "feat.ts"), "export const feat = true;\n".repeat(50));
      runGit(repoDir, ["add", "feat.ts"]);
      runGit(repoDir, ["commit", "-m", "feature"]);
      runGit(repoDir, ["checkout", "-b", "board/fix"]);

      // A tiny maxBuffer forces Node to kill the git child process even for
      // this small diff, simulating the real 32MB overflow deterministically.
      const result = await computeDiffBetweenRefs(repoDir, "main", "board/build", {
        gitMaxBuffer: 10,
      });
      expect(result.kind).toBe("no-git");
      if (result.kind === "no-git") {
        expect(result.reason).toContain("maxBuffer");
      }
    });
  });

  describe("computeDiffAgainstWorkingTree", () => {
    it("diffs a base ref against the current working tree including untracked files", async () => {
      const repoDir = join(tmpDir, "repo");
      const baseCommit = initRepo(repoDir);

      const wt = join(tmpDir, "wt");
      runGit(repoDir, ["worktree", "add", "-b", "board/wt", wt, "HEAD"]);
      writeFileSync(join(wt, "tracked.ts"), "tracked change;\n");
      writeFileSync(join(wt, "untracked.ts"), "untracked content;\n");

      const result = await computeDiffAgainstWorkingTree(wt, baseCommit);
      expect(result.kind).toBe("diff");
      if (result.kind === "diff") {
        const files = result.files.map((f) => f.file).sort();
        expect(files).toEqual(["tracked.ts", "untracked.ts"]);
        expect(result.root).toBe(wt);
      }
    });

    it("returns an empty diff when the working tree matches the base ref", async () => {
      const repoDir = join(tmpDir, "repo");
      const baseCommit = initRepo(repoDir);

      const wt = join(tmpDir, "wt");
      runGit(repoDir, ["worktree", "add", "-b", "board/wt", wt, "HEAD"]);

      const result = await computeDiffAgainstWorkingTree(wt, baseCommit);
      expect(result.kind).toBe("diff");
      if (result.kind === "diff") {
        expect(result.files).toEqual([]);
      }
    });

    it("returns no-git when the base ref does not exist", async () => {
      const repoDir = join(tmpDir, "repo");
      initRepo(repoDir);
      const wt = join(tmpDir, "wt");
      runGit(repoDir, ["worktree", "add", "-b", "board/wt", wt, "HEAD"]);

      const result = await computeDiffAgainstWorkingTree(wt, "deadbeef");
      expect(result.kind).toBe("no-git");
    });

    it("rejects a dash-prefixed base ref defensively instead of passing it to git argv", async () => {
      const repoDir = join(tmpDir, "repo");
      initRepo(repoDir);
      const wt = join(tmpDir, "wt");
      runGit(repoDir, ["worktree", "add", "-b", "board/wt", wt, "HEAD"]);

      await expect(
        computeDiffAgainstWorkingTree(wt, "--upload-pack=evil"),
      ).rejects.toThrow(/dash-prefixed ref/i);
    });

    it("returns an honest no-git result when git output exceeds a configured maxBuffer, never parsing truncated stdout (working-tree path, consistent with the ref path)", async () => {
      const repoDir = join(tmpDir, "repo");
      const baseCommit = initRepo(repoDir);
      const wt = join(tmpDir, "wt");
      runGit(repoDir, ["worktree", "add", "-b", "board/wt", wt, "HEAD"]);
      // Must modify an already-tracked file: untracked files are read directly
      // (not via `git diff`) and would bypass the maxBuffer path entirely.
      writeFileSync(join(wt, "README.md"), "tracked change;\n".repeat(50));

      const result = await computeDiffAgainstWorkingTree(wt, baseCommit, { gitMaxBuffer: 10 });
      expect(result.kind).toBe("no-git");
      if (result.kind === "no-git") {
        expect(result.reason).toContain("maxBuffer");
      }
    });
  });

  describe("resolveGitRepoRoot and resolveGitCommonDir", () => {
    it("resolve the repo root and shared git dir for a normal repo", async () => {
      const repoDir = join(tmpDir, "repo");
      initRepo(repoDir);

      const root = await resolveGitRepoRoot(repoDir);
      const common = await resolveGitCommonDir(repoDir);
      expect(root).toBe(realpathSync(repoDir));
      expect(common).toBe(realpathSync(join(repoDir, ".git")));
    });

    it("share a common git dir across worktrees of the same repo", async () => {
      const repoDir = join(tmpDir, "repo");
      initRepo(repoDir);

      const wtA = join(tmpDir, "wtA");
      const wtB = join(tmpDir, "wtB");
      runGit(repoDir, ["worktree", "add", "-b", "board/a", wtA, "HEAD"]);
      runGit(repoDir, ["worktree", "add", "-b", "board/b", wtB, "HEAD"]);

      const rootA = await resolveGitRepoRoot(wtA);
      const rootB = await resolveGitRepoRoot(wtB);
      expect(rootA).toBe(realpathSync(wtA));
      expect(rootB).toBe(realpathSync(wtB));
      expect(rootA).not.toBe(rootB);

      const commonA = await resolveGitCommonDir(wtA);
      const commonB = await resolveGitCommonDir(wtB);
      expect(commonA).toBe(commonB);
      expect(commonA).not.toBe(realpathSync(join(wtA, ".git")));
    });

    it("return null for a non-git directory", async () => {
      const nonRepo = join(tmpDir, "not-a-repo");
      mkdirSync(nonRepo, { recursive: true });
      expect(await resolveGitRepoRoot(nonRepo)).toBeNull();
      expect(await resolveGitCommonDir(nonRepo)).toBeNull();
    });
  });
});
