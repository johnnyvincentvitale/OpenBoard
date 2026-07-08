/**
 * Instance-scoped settings/control diagnostics — the API surface for a future
 * settings panel, not a second task editor. Read-only endpoint that reports
 * sandbox, OpenCode server, worktree health, instance identity, and editor
 * command status without exposing secrets.
 */

/** What the user wants for the bash sandbox (persisted board setting). */
export type BashSandboxDesired = "on" | "off";

/**
 * What the runtime is actually doing for the bash sandbox.
 * - on: sandbox wrapper is wired and active.
 * - off: sandbox is not wired, but the environment supports it.
 * - unavailable: spawn mode, but macOS or sandbox-exec is missing.
 * - external: connect mode; OpenBoard doesn't own the process.
 */
export type BashSandboxEffective = "on" | "off" | "unavailable" | "external";

export interface BashSandboxDiagnostics {
  desired: BashSandboxDesired;
  effective: BashSandboxEffective;
  /** True when the user's desired state differs from what is currently running. */
  restartRequired: boolean;
}

export interface OpencodeDiagnostics {
  /** The base URL of the spawned/connected OpenCode server. */
  url?: string;
  /** OpenCode version reported by the health check. */
  version?: string;
  /** Whether the OpenCode health check succeeded. */
  reachable: boolean;
}

export interface WorktreeOrphan {
  worktreePath: string;
  taskId: string;
}

export interface WorktreeHealthDiagnostics {
  /** Epoch ms of the last startup orphan sweep. */
  lastSweep?: number;
  /** Clean worktrees that were removed during the sweep. */
  removedCleanCount: number;
  /** Dirty worktrees that were kept during the sweep (never force-deleted). */
  keptDirtyCount: number;
  /** Details of kept dirty orphans when available. */
  dirtyOrphans?: WorktreeOrphan[];
}

export interface InstanceDiagnostics {
  /** Named-instance name (unset for raw-env launches). */
  instanceName?: string;
  boardUrl: string;
  dbPath: string;
  /** Whether a board API token is configured (never the token itself). */
  apiTokenPresent: boolean;
  port: number;
  workspace: string;
}

export interface EditorCommandDiagnostics {
  /** Human-readable resolved command (e.g. "vim +1 {file}" or "code -g {file}:{line}"). */
  resolved?: string;
  /** Which env var was used to resolve the editor. */
  source?: "openboard_editor" | "visual" | "editor";
  /** True when no editor is configured at all. */
  missing: boolean;
}

/** Full diagnostics bundle for the instance-scoped settings/control panel. */
export interface BoardDiagnostics {
  sandbox: BashSandboxDiagnostics;
  opencode: OpencodeDiagnostics;
  worktree: WorktreeHealthDiagnostics;
  instance: InstanceDiagnostics;
  editor: EditorCommandDiagnostics;
}