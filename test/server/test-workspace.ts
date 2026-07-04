import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let savedWorkspace: string | undefined;
let activeTmp: string | undefined;
let activeRepoDir: string | undefined;

/**
 * Create a temporary board workspace for a test, expose a `repo` subdirectory
 * inside it, and set `BOARD_WORKSPACE` for the server-side directory resolver.
 */
export function setupTestWorkspace(): { workspace: string; repoDir: string } {
  cleanupTestWorkspace();
  activeTmp = realpathSync(mkdtempSync(join(tmpdir(), "ocb-test-")));
  activeRepoDir = join(activeTmp, "repo");
  mkdirSync(activeRepoDir, { recursive: true });
  savedWorkspace = process.env.BOARD_WORKSPACE;
  process.env.BOARD_WORKSPACE = activeTmp;
  delete process.env.OPENBOARD_ALLOW_EXTERNAL_DIRECTORIES;
  return { workspace: activeTmp, repoDir: activeRepoDir };
}

/** Tear down the temporary workspace and restore the original env. */
export function cleanupTestWorkspace(): void {
  if (activeTmp) {
    rmSync(activeTmp, { recursive: true, force: true });
    activeTmp = undefined;
    activeRepoDir = undefined;
  }
  if (savedWorkspace !== undefined) {
    process.env.BOARD_WORKSPACE = savedWorkspace;
  } else {
    delete process.env.BOARD_WORKSPACE;
  }
  savedWorkspace = undefined;
  delete process.env.OPENBOARD_ALLOW_EXTERNAL_DIRECTORIES;
}
