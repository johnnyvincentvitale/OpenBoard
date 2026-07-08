/**
 * macOS sandbox-wrapper status — resolves whether OpenBoard can and should
 * enable `scripts/sandbox-wrapper.sh` as OpenCode's configured `shell`, so
 * every bash-tool call a dispatched agent makes runs inside a per-call
 * `sandbox-exec` (Seatbelt) profile scoped to its own cwd.
 *
 * macOS-only (Seatbelt/sandbox-exec); Linux (bwrap) is a separate,
 * not-yet-built probe. Connect mode never resolves `enabled` — OpenBoard
 * doesn't own an externally-managed OpenCode process's config, so this
 * feature simply doesn't apply there (existing fence + detector protection
 * is unaffected).
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Well-known path to macOS's built-in Seatbelt sandboxing tool. */
export const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

export interface SandboxStatus {
  /**
   * True when this OpenBoard process is responsible for enabling the
   * wrapper (spawn mode + macOS). Worktree-isolated tasks fail closed when
   * `expected` is true but `enabled` is false, rather than silently
   * dispatching without syscall-level write protection.
   */
  expected: boolean;
  /** True when the wrapper was actually wired as OpenCode's `shell`. */
  enabled: boolean;
  /** Absolute path to the wrapper script, set when `enabled`. */
  wrapperPath?: string;
  /** Human-readable reason, set whenever `enabled` is false. */
  reason?: string;
}

/** Resolve scripts/sandbox-wrapper.sh's absolute path from this module's own location. */
export function resolveSandboxWrapperPath(moduleUrl: string = import.meta.url): string {
  const repoRoot = resolve(dirname(fileURLToPath(moduleUrl)), "../..");
  return resolve(repoRoot, "scripts", "sandbox-wrapper.sh");
}

export interface ResolveSandboxStatusOptions {
  /** "connect" never wires the wrapper — OpenBoard doesn't own that process's config. */
  mode: "connect" | "spawn";
  /**
   * The user's desired bash sandbox state from persisted board settings.
   * When false in spawn mode, sandbox is treated as intentionally off —
   * no wrapper is wired and worktree runs don't fail-close.
   * Undefined / true preserves the original behaviour.
   */
  desired?: boolean;
  platform?: NodeJS.Platform;
  wrapperPath?: string;
  sandboxExecPath?: string;
  existsSync?: typeof existsSync;
}

/**
 * Resolve whether the sandbox wrapper can be enabled for this process.
 * Pure/DI-friendly (platform, path existence, and both resolved paths are
 * all overridable), so every branch is unit-testable without spawning or
 * mocking a real OpenCode/opencode-server process.
 */
export function resolveSandboxStatus(opts: ResolveSandboxStatusOptions): SandboxStatus {
  if (opts.mode !== "spawn") {
    return {
      expected: false,
      enabled: false,
      reason: "connect mode: OpenBoard does not manage the OpenCode process or its config",
    };
  }

  // User explicitly turned off desire sandbox — treat as intentionally off,
  // avoiding both wrapper wiring and worktree fail-close.
  if (opts.desired === false) {
    return {
      expected: false,
      enabled: false,
      reason: "bash sandbox disabled by board setting",
    };
  }

  const platform = opts.platform ?? process.platform;
  if (platform !== "darwin") {
    return {
      expected: false,
      enabled: false,
      reason: `sandbox wrapper is macOS-only (Seatbelt); current platform: ${platform}`,
    };
  }

  const exists = opts.existsSync ?? existsSync;
  const wrapperPath = opts.wrapperPath ?? resolveSandboxWrapperPath();
  if (!exists(wrapperPath)) {
    return {
      expected: true,
      enabled: false,
      reason: `sandbox wrapper script not found at ${wrapperPath}`,
    };
  }

  const sandboxExecPath = opts.sandboxExecPath ?? SANDBOX_EXEC_PATH;
  if (!exists(sandboxExecPath)) {
    return {
      expected: true,
      enabled: false,
      reason: `sandbox-exec not found at ${sandboxExecPath}`,
    };
  }

  return { expected: true, enabled: true, wrapperPath };
}
