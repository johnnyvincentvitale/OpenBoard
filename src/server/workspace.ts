/**
 * Workspace-bound directory canonicalization.
 *
 * Every task directory, execution directory, and terminal cwd is resolved
 * against the board instance's selected workspace and rejected if it escapes
 * that boundary, unless the instance explicitly opts in to external
 * directories.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, parse, resolve, sep } from "node:path";
import { AdapterError } from "../shared/errors";

export interface ResolveTaskDirectoryOptions {
  /** Allow paths that resolve outside the workspace. */
  allowExternal?: boolean;
  /** Override for file-system checks (tests). */
  existsSync?: typeof existsSync;
  /** Override for symlink resolution (tests). */
  realpathSync?: typeof realpathSync;
  /** Override for stat checks (tests). */
  statSync?: typeof statSync;
}

function normalizeDirectory(p: string): string {
  return resolve(p);
}

function isRootPath(p: string): boolean {
  return p === parse(p).root;
}

export function isUnderWorkspace(canonical: string, workspace: string): boolean {
  const ws = normalizeDirectory(workspace);
  if (canonical === ws) return true;
  // Use a path-separator-aware prefix so `/ws/foo` does not match `/ws-foo`.
  const prefix = isRootPath(ws) ? ws : `${ws}${sep}`;
  return canonical.startsWith(prefix);
}

/**
 * Resolve the board workspace for this process.
 *
 * Returns the configured `BOARD_WORKSPACE` if it points to an existing
 * directory. An explicitly configured but missing, empty, or non-directory
 * value is rejected with a validation error.
 *
 * Only when `BOARD_WORKSPACE` is unset does this fall back to the user's home
 * directory, matching the historical default.
 */
export function resolveBoardWorkspace(
  env: NodeJS.ProcessEnv = process.env,
  fsExistsSync: typeof existsSync = existsSync,
  fsStatSync: typeof statSync = statSync,
): string {
  const configured = env.BOARD_WORKSPACE?.trim();
  if (configured) {
    if (!fsExistsSync(configured)) {
      throw AdapterError.validation(`BOARD_WORKSPACE does not exist: ${configured}`);
    }
    if (!fsStatSync(configured).isDirectory()) {
      throw AdapterError.validation(`BOARD_WORKSPACE is not a directory: ${configured}`);
    }
    return resolveWorkspace(configured);
  }

  if (env.BOARD_WORKSPACE !== undefined) {
    throw AdapterError.validation("BOARD_WORKSPACE must not be empty");
  }

  const fallback = homedir();
  if (fsExistsSync(fallback)) return resolveWorkspace(fallback);

  throw new AdapterError("validation", "BOARD_WORKSPACE does not exist");
}

/**
 * Whether this instance allows task/terminal directories outside its
 * workspace. Enabled with the `OPENBOARD_ALLOW_EXTERNAL_DIRECTORIES` env var.
 */
export function isExternalDirectoriesAllowed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env.OPENBOARD_ALLOW_EXTERNAL_DIRECTORIES?.trim().toLowerCase();
  return value === "true" || value === "1";
}

/**
 * Canonicalize a raw task/terminal directory.
 *
 * - Resolves relative paths against the workspace.
 * - Collapses `..` segments and resolves symlinks via `realpathSync`.
 * - Verifies the path exists and is a directory.
 * - Rejects paths that escape the workspace unless `allowExternal` is set.
 *
 * Returns the absolute, symlink-resolved directory path.
 */
export function resolveTaskDirectory(
  raw: string,
  workspace: string,
  opts: ResolveTaskDirectoryOptions = {},
): string {
  const exists = opts.existsSync ?? existsSync;
  const realpath = opts.realpathSync ?? realpathSync;
  const stat = opts.statSync ?? statSync;

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw AdapterError.validation("directory must be a non-empty string");
  }

  const requested = isAbsolute(trimmed) ? resolve(trimmed) : resolve(workspace, trimmed);

  if (!exists(requested)) {
    throw AdapterError.validation(`Directory does not exist: ${requested}`);
  }

  let canonical: string;
  try {
    canonical = realpath(requested);
  } catch {
    throw AdapterError.validation(
      `Directory could not be resolved: ${requested}`,
    );
  }

  if (!stat(canonical).isDirectory()) {
    throw AdapterError.validation(`Path is not a directory: ${canonical}`);
  }

  const workspaceRoot = resolveWorkspace(workspace);
  if (!opts.allowExternal && !isUnderWorkspace(canonical, workspaceRoot)) {
    throw AdapterError.validation(
      `Directory is outside the board workspace (${workspaceRoot}). ` +
        `Set OPENBOARD_ALLOW_EXTERNAL_DIRECTORIES=true to allow external directories.`,
    );
  }

  return canonical;
}

function resolveWorkspace(workspace: string): string {
  const ws = resolve(workspace);
  try {
    return realpathSync(ws);
  } catch {
    return ws;
  }
}
