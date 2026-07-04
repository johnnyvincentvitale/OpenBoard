/**
 * Pure, Electron-free helpers for multi-instance support in `main.cjs`.
 * Kept separate (and dependency-free beyond `node:path`) so they're unit
 * testable without an Electron runtime.
 *
 * Multi-instance env vars (see the README's "Running multiple instances"
 * section for a worked two-instance example):
 * - `OPENBOARD_PORT` — this instance's adapter (board) port. Falls back to
 *   the legacy `BOARD_PORT`, then the documented default (4097).
 * - `OPENBOARD_OPENCODE_PORT` — this instance's spawned OpenCode server
 *   port. Falls back to the legacy `OPENCODE_PORT`. Unset means "let the
 *   adapter auto-select a free port" (see src/server/config.ts).
 * - `OPENBOARD_DB` / `BOARD_DB_PATH` / `BOARD_TASK_DB_PATH` — DB path
 *   overrides, passed straight through to the adapter.
 * - `BOARD_WORKSPACE` — unchanged, existing per-instance workspace env.
 */
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULT_BOARD_PORT = "4097";

/** Resolve this instance's board (adapter) port from env, with legacy fallback. */
function resolveBoardPort(env = process.env) {
  return env.OPENBOARD_PORT || env.BOARD_PORT || DEFAULT_BOARD_PORT;
}

/** Resolve this instance's OpenCode server port from env, with legacy fallback. Empty string means "unset". */
function resolveOpencodePort(env = process.env) {
  return env.OPENBOARD_OPENCODE_PORT || env.OPENCODE_PORT || "";
}

/** True when `boardPort` is the documented default (4097) — the common, unconfigured case. */
function isDefaultPort(boardPort) {
  return boardPort === DEFAULT_BOARD_PORT;
}

/**
 * Cheap instance disambiguation for the window title: only append the port
 * when it differs from the default, so the common single-instance case is
 * visually unchanged.
 */
function windowTitle(boardPort) {
  return isDefaultPort(boardPort) ? "OpenBoard" : `OpenBoard — :${boardPort}`;
}

/**
 * Resolve the Electron `userData` directory for this instance. Electron's
 * own single-instance lock (`app.requestSingleInstanceLock()`) and Chromium's
 * "SingletonLock" file are both keyed off `userData`, not per-process state —
 * so giving each non-default-port instance its own subdirectory is what lets
 * two Electron apps with different `OPENBOARD_PORT` values coexist rather
 * than one silently blocking the other. The default-port instance keeps the
 * original directory unchanged (back-compat).
 */
function resolveUserDataPath(baseUserDataPath, boardPort) {
  return isDefaultPort(boardPort)
    ? baseUserDataPath
    : path.join(baseUserDataPath, `instance-${boardPort}`);
}

/** Default `<userData>/<name>.sqlite` path for a given (already-resolved) userData directory. */
function defaultDbPath(userDataPath, name) {
  return path.join(userDataPath, `${name}.sqlite`);
}

/**
 * Build the env this instance's adapter (`serve.ts`/`serve.mjs`) should be
 * spawned with: passes through the resolved board/OpenCode ports under both
 * the canonical `OPENBOARD_*` names and the legacy names (so either reader
 * in `src/server/config.ts` resolves the same values), and fills in
 * per-instance DB path defaults scoped to `userDataPath` when the user
 * hasn't set them explicitly.
 */
function buildAdapterEnv({ env = process.env, boardPort, opencodePort, userDataPath, webDir }) {
  const resolvedEnv = {
    ...env,
    OPENBOARD_PORT: boardPort,
    BOARD_PORT: boardPort,
    BOARD_WEB_DIR: webDir,
    OPENBOARD_DB: env.OPENBOARD_DB || defaultDbPath(userDataPath, "board"),
    BOARD_DB_PATH: env.BOARD_DB_PATH || defaultDbPath(userDataPath, "board"),
    BOARD_TASK_DB_PATH: env.BOARD_TASK_DB_PATH || defaultDbPath(userDataPath, "board-tasks"),
    // Share a board API token so the Electron shell and its spawned adapter
    // both use the same token. If already set (CI, pre-shared config), keep it.
    OPENBOARD_API_TOKEN: env.OPENBOARD_API_TOKEN || generateBoardToken(),
  };
  if (opencodePort) {
    resolvedEnv.OPENBOARD_OPENCODE_PORT = opencodePort;
    resolvedEnv.OPENCODE_PORT = opencodePort;
  }
  return resolvedEnv;
}

module.exports = {
  DEFAULT_BOARD_PORT,
  resolveBoardPort,
  resolveOpencodePort,
  isDefaultPort,
  windowTitle,
  resolveUserDataPath,
  defaultDbPath,
  buildAdapterEnv,
  generateBoardToken,
};

/** Generate a random 64-char hex token for the board API. */
function generateBoardToken() {
  return crypto.randomBytes(32).toString("hex");
}
