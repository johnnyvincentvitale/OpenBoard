import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dirtyWarning } from "../../src/server/git-inspect";

const tempDirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    encoding: "utf8",
  }).trim();
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "openboard-git-inspect-"));
  tempDirs.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "openboard@example.test"]);
  git(repo, ["config", "user.name", "OpenBoard Test"]);
  writeFileSync(join(repo, "README.md"), "initial\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "initial"]);
  return repo;
}

describe("git inspection", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("uses the Claude dirty working tree warning copy", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "README.md"), "changed\n");

    await expect(dirtyWarning(repo)).resolves.toBe(
      "Warning: target working tree has 1 uncommitted path. Claude Code may isolate edits in its own worktree. Please commit before using Claude agents in this repo.",
    );
  });
});
