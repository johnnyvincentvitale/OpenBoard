import { describe, it, expect, afterEach } from "vitest";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveSandboxWrapperPath, SANDBOX_EXEC_PATH } from "../../src/server/sandbox";

/**
 * Direct-invocation harness for scripts/sandbox-wrapper.sh — no live OpenCode
 * session required, mirroring the original sandbox-wrapper-probe's
 * direct-invocation leg (see opencode-capabilities.md's "Sandbox-wrapper
 * probe" section). Skips entirely off real macOS with Seatbelt present, so
 * CI on other platforms (or a macOS box missing sandbox-exec) stays green.
 */
const WRAPPER_PATH = resolveSandboxWrapperPath();

function sandboxWrapperAvailable(): boolean {
  return process.platform === "darwin" && existsSync(SANDBOX_EXEC_PATH) && existsSync(WRAPPER_PATH);
}

/** Deterministic git in a temp dir (no shell, fixed identity, no signing) — mirrors escape-detector.test.ts's `g()`. */
function g(cwd: string, args: string[]): string {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@localhost",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@localhost",
    },
  }).trim();
}

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  return env;
}

function makeRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  g(root, ["init", "-b", "main"]);
  writeFileSync(join(root, "file.txt"), "base\n");
  g(root, ["add", "-A"]);
  g(root, ["commit", "--no-gpg-sign", "-m", "base"]);
}

function runWrapper(cwd: string, command: string): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(WRAPPER_PATH, ["-c", command], { cwd, encoding: "utf8", env: cleanGitEnv() });
  return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runWrapperAsync(cwd: string, command: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(WRAPPER_PATH, ["-c", command], { cwd, env: cleanGitEnv() });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("close", (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * Scratch dirs MUST live outside os.tmpdir()/$TMPDIR — never under it. The
 * wrapper explicitly allow-lists canonicalized $TMPDIR (needed for real tool
 * use), so a scratch repo placed there makes every "escape" write land
 * inside an already-allowed path and silently pass for the wrong reason —
 * the exact collision the original probe hit (relocated to a $HOME-based
 * directory to fix it; see opencode-capabilities.md's "Known probe
 * artifact" note). Mirror that fix here rather than the tmpdir()-based
 * helper other test files in this repo use for unrelated (non-sandbox)
 * scratch dirs.
 */
function scratchDir(prefix: string): string {
  return mkdtempSync(join(homedir(), prefix));
}

describe.skipIf(!sandboxWrapperAvailable())("sandbox-wrapper.sh (macOS Seatbelt)", () => {
  const cleanupDirs: string[] = [];
  function track(dir: string): string {
    cleanupDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (cleanupDirs.length) {
      const dir = cleanupDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks an absolute write to the base checkout from a worktree cwd (bash escape, syscall-level)", () => {
    const base = track(scratchDir(".ocb-sbx-escape-base-"));
    makeRepo(base);
    const wt = join(track(scratchDir(".ocb-sbx-escape-wt-")), "wt");
    g(base, ["worktree", "add", "-b", "task", wt, "HEAD"]);

    const escapePath = join(base, "escape.txt");
    const result = runWrapper(wt, `echo escaped > ${escapePath}`);

    expect(result.code).not.toBe(0);
    expect(existsSync(escapePath)).toBe(false);
  });

  it("allows a relative in-worktree write", () => {
    const base = track(scratchDir(".ocb-sbx-rel-base-"));
    makeRepo(base);
    const wt = join(track(scratchDir(".ocb-sbx-rel-wt-")), "wt");
    g(base, ["worktree", "add", "-b", "task", wt, "HEAD"]);

    const result = runWrapper(wt, "echo hello > rel.txt");

    expect(result.code).toBe(0);
    expect(readFileSync(join(wt, "rel.txt"), "utf8")).toBe("hello\n");
  });

  it("allows an in-worktree git commit, including the linked (shared) gitdir", () => {
    const base = track(scratchDir(".ocb-sbx-commit-base-"));
    makeRepo(base);
    const wt = join(track(scratchDir(".ocb-sbx-commit-wt-")), "wt");
    g(base, ["worktree", "add", "-b", "task", wt, "HEAD"]);

    const result = runWrapper(
      wt,
      "echo feature > feature.txt && git add -A && " +
        "git -c user.name=t -c user.email=t@localhost commit --no-gpg-sign -m feature",
    );

    expect(result.code).toBe(0);
    expect(g(wt, ["log", "--oneline", "-1"])).toContain("feature");
    // Base checkout's own working tree is untouched by the worktree's commit.
    expect(existsSync(join(base, "feature.txt"))).toBe(false);
  });

  it("blocks a symlink write-through to a tracked base-checkout file (CVE-2026-39861 shape)", () => {
    const base = track(scratchDir(".ocb-sbx-symlink-base-"));
    makeRepo(base);
    const wt = join(track(scratchDir(".ocb-sbx-symlink-wt-")), "wt");
    g(base, ["worktree", "add", "-b", "task", wt, "HEAD"]);

    symlinkSync(join(base, "file.txt"), join(wt, "evil-symlink"));
    const result = runWrapper(wt, "echo pwned > evil-symlink");

    expect(result.code).not.toBe(0);
    expect(readFileSync(join(base, "file.txt"), "utf8")).toBe("base\n");
  });

  it("resolves the allow-list from cwd generically — an in-place (non-worktree) checkout gets the same protection", () => {
    // No git worktree at all here: this is the "in-place task" shape — the
    // wrapper derives its allow-list purely from its own cwd, so a plain
    // project checkout gets exactly the same cwd-scoped protection a
    // worktree does, with no special-casing required in the wrapper itself.
    const projectCheckout = track(scratchDir(".ocb-sbx-inplace-"));
    const sibling = track(scratchDir(".ocb-sbx-sibling-"));

    const relative = runWrapper(projectCheckout, "echo hello > rel.txt");
    expect(relative.code).toBe(0);
    expect(existsSync(join(projectCheckout, "rel.txt"))).toBe(true);

    const escapePath = join(sibling, "escape.txt");
    const escape = runWrapper(projectCheckout, `echo escaped > ${escapePath}`);
    expect(escape.code).not.toBe(0);
    expect(existsSync(escapePath)).toBe(false);
  });

  it("keeps two simultaneous worktree tasks independently scoped: neither can write to the base checkout or the other's worktree", async () => {
    const base = track(scratchDir(".ocb-sbx-concurrent-base-"));
    makeRepo(base);
    const worktreesRoot = track(scratchDir(".ocb-sbx-concurrent-wt-"));
    const wtA = join(worktreesRoot, "task-a");
    const wtB = join(worktreesRoot, "task-b");
    g(base, ["worktree", "add", "-b", "task-a", wtA, "HEAD"]);
    g(base, ["worktree", "add", "-b", "task-b", wtB, "HEAD"]);

    // Concurrency proof: both tasks' own-worktree writes run at the same
    // time via a real, simultaneously-running wrapper process each — this
    // is the property a shared-temp-profile-file implementation (a natural
    // but wrong first draft) would risk breaking under a race; this
    // wrapper's design (a `-p` profile string, no shared file at all) has
    // no such shared state to race on.
    const [ownA, ownB] = await Promise.all([
      runWrapperAsync(wtA, "echo own-a > owned-by-a.txt"),
      runWrapperAsync(wtB, "echo own-b > owned-by-b.txt"),
    ]);
    expect(ownA.code).toBe(0);
    expect(ownB.code).toBe(0);
    expect(existsSync(join(wtA, "owned-by-a.txt"))).toBe(true);
    expect(existsSync(join(wtB, "owned-by-b.txt"))).toBe(true);

    const escapeFromA = join(base, "escape-from-a.txt");
    const escapeFromB = join(base, "escape-from-b.txt");
    const crossFromA = join(wtB, "cross-from-a.txt");
    const crossFromB = join(wtA, "cross-from-b.txt");

    const [resEscapeA, resCrossA, resCrossB, resEscapeB] = await Promise.all([
      runWrapperAsync(wtA, `echo escape > ${escapeFromA}`),
      runWrapperAsync(wtA, `echo cross > ${crossFromA}`),
      runWrapperAsync(wtB, `echo cross > ${crossFromB}`),
      runWrapperAsync(wtB, `echo escape > ${escapeFromB}`),
    ]);

    expect(resEscapeA.code).not.toBe(0);
    expect(resCrossA.code).not.toBe(0);
    expect(resCrossB.code).not.toBe(0);
    expect(resEscapeB.code).not.toBe(0);
    expect(existsSync(escapeFromA)).toBe(false);
    expect(existsSync(escapeFromB)).toBe(false);
    expect(existsSync(crossFromA)).toBe(false);
    expect(existsSync(crossFromB)).toBe(false);
  });
});
