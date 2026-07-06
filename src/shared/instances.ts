/**
 * Named OpenBoard instances — frozen shared contracts for the Instances run.
 *
 * Every type, constant, and pure helper in this module is a contract that the
 * three parallel lanes (server daemon lane A, TUI/launcher lane B, CLI lane C)
 * build against. No I/O anywhere — no fs, os, child_process, or network imports.
 *
 * The existing {@link InstanceConfig} from `src/shared/task.ts` is reused
 * directly; this module adds a machine-readable registry file, a daemon data-dir
 * layout, lifecycle types, a CLI command surface, and pure validation helpers.
 */

import type { InstanceConfig } from "./task";

// ── Registry file schema ─────────────────────────────────────────────────────

/**
 * Canonical path for the instance registry file.
 *
 * This is a pure path-builder — it takes a home directory and returns the
 * resolved path. No filesystem access.
 *
 * @param homeDir The user's home directory (e.g. from `os.homedir()`).
 * @returns `~/.config/openboard/instances.json`
 */
export function instancesFilePath(homeDir: string): string {
  return `${homeDir}/.config/openboard/instances.json`;
}

/**
 * A single named instance definition in the registry file.
 *
 * Reuses every field of the existing {@link InstanceConfig} (port, dbPath,
 * workspace, opencodePort?) and adds a unique kebab-case `name`.
 */
export interface InstanceDefinition extends InstanceConfig {
  /** Unique, kebab-case identifier (e.g. "my-repo", "side-project"). */
  name: string;
  /** Private bearer token shared by the named daemon and local TUI attach. */
  boardToken?: string;
}

/**
 * The root shape of `~/.config/openboard/instances.json`.
 *
 * Semantics:
 * - `version` is always `1` for this schema revision.
 * - `defaultInstance` names the instance the `openboard` CLI targets when no
 *   `--instance` flag is given. `undefined` means "no default".
 * - `instances` is the ordered list of named instances. Order is preserved by
 *   the CLI for display; it carries no operational weight.
 */
export interface InstancesFile {
  version: 1;
  defaultInstance?: string;
  instances: InstanceDefinition[];
}

// ── Daemon layout convention ─────────────────────────────────────────────────

/**
 * Per-instance daemon data directory layout.
 *
 * Builds the paths that lane A uses for process supervision, stdout/stderr
 * capture, and PID-file locking under `~/.local/share/openboard/<name>/`.
 */
export interface InstanceDataDir {
  /** `~/.local/share/openboard/<name>/` */
  dataDir: string;
  /** `~/.local/share/openboard/<name>/openboard.pid` */
  pidFile: string;
  /** `~/.local/share/openboard/<name>/openboard.log` */
  logFile: string;
}

/**
 * Pure path-builder for a daemon instance's data directory.
 *
 * @param homeDir The user's home directory.
 * @param name    The instance's kebab-case name.
 */
export function instanceDataDir(homeDir: string, name: string): InstanceDataDir {
  const dataDir = `${homeDir}/.local/share/openboard/${name}`;
  return {
    dataDir,
    pidFile: `${dataDir}/openboard.pid`,
    logFile: `${dataDir}/openboard.log`,
  };
}

// ── Lifecycle result types ───────────────────────────────────────────────────

/** The coarse state of a daemon-managed instance. */
export const INSTANCE_STATUSES = ["running", "stopped", "stale-pid", "unhealthy"] as const;
export type InstanceStatus = (typeof INSTANCE_STATUSES)[number];

/**
 * Runtime state of an instance, as determined by lane A's process supervision
 * and consumed by lanes B (TUI) and C (CLI).
 */
export interface InstanceRuntimeState {
  status: InstanceStatus;
  pid?: number;
  /** Fully-qualified board URL (e.g. `http://127.0.0.1:4097`). */
  boardUrl: string;
  /** Epoch ms when the instance was most recently started (undefined if never started). */
  startedAt?: number;
}

// ── Error shapes ─────────────────────────────────────────────────────────────

/** Base class for all instance-related operational errors. */
export class InstanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstanceError";
  }
}

/** Thrown by `add` when an instance with the given name already exists. */
export class InstanceNameCollisionError extends InstanceError {
  /** The colliding instance name. */
  readonly instanceName: string;

  constructor(instanceName: string) {
    super(`An instance named "${instanceName}" already exists`);
    this.name = "InstanceNameCollisionError";
    this.instanceName = instanceName;
  }
}

/** Thrown by `remove` / `start` / `stop` when the named instance is unknown. */
export class InstanceUnknownError extends InstanceError {
  readonly instanceName: string;

  constructor(instanceName: string) {
    super(`Unknown instance: "${instanceName}"`);
    this.instanceName = instanceName;
  }
}

/** Thrown when a port assignment conflicts with another instance. */
export class InstancePortConflictError extends InstanceError {
  readonly port: number;
  readonly existingInstance: string;

  constructor(port: number, existingInstance: string) {
    super(
      `Port ${port} is already assigned to instance "${existingInstance}"`,
    );
    this.port = port;
    this.existingInstance = existingInstance;
  }
}

/** Thrown when lane A cannot spawn the daemon process. */
export class InstanceSpawnError extends InstanceError {
  readonly instanceName: string;
  override readonly cause?: unknown;

  constructor(instanceName: string, cause?: unknown) {
    super(`Failed to spawn instance "${instanceName}"`);
    this.instanceName = instanceName;
    this.cause = cause;
  }
}

// ── CLI surface spec (types + constants) ─────────────────────────────────────

/**
 * The set of CLI subcommands the `openboard` binary supports.
 *
 * - `list`:   Show all registered instances and their status.
 * - `add`:    Register a new named instance.
 * - `remove`: Unregister a named instance (does not delete data).
 * - `start`:  Launch an instance as a background daemon.
 * - `stop`:   Signal a running daemon to shut down.
 * - `attach`: Open the TUI for an instance (or the default instance).
 * - `mcp`:    Start the MCP server bound to an explicit named instance.
 * - `rename`: Rename an instance (stops/restarts if running).
 */
export const CLI_COMMANDS = ["list", "add", "remove", "start", "stop", "attach", "mcp", "rename"] as const;
export type CliCommand = (typeof CLI_COMMANDS)[number];

/** Arguments for the `list` subcommand. */
export interface CliListArgs {
  command: "list";
}

/** Arguments for the `add` subcommand. */
export interface CliAddArgs {
  command: "add";
  name: string;
  port: number;
  workspace: string;
  /** Optional dbPath; defaults to a name-derived path under the data dir. */
  dbPath?: string;
  /** Optional explicit OpenCode port; auto-selected if omitted. */
  opencodePort?: number;
}

/** Arguments for the `remove` subcommand. */
export interface CliRemoveArgs {
  command: "remove";
  name: string;
}

/** Arguments for the `start` subcommand. */
export interface CliStartArgs {
  command: "start";
  name: string;
}

/** Arguments for the `stop` subcommand. */
export interface CliStopArgs {
  command: "stop";
  name: string;
}

/** Arguments for the `attach` subcommand. */
export interface CliAttachArgs {
  command: "attach";
  /** If omitted, the default instance (or the only instance) is targeted. */
  name?: string;
}

/** Arguments for the `mcp` subcommand. */
export interface CliMcpArgs {
  command: "mcp";
  name: string;
}

/** Arguments for the `rename` subcommand. */
export interface CliRenameArgs {
  command: "rename";
  oldName: string;
  newName: string;
}

/** Discriminated union of all CLI argument shapes. */
export type CliArgs =
  | CliListArgs
  | CliAddArgs
  | CliRemoveArgs
  | CliStartArgs
  | CliStopArgs
  | CliAttachArgs
  | CliMcpArgs
  | CliRenameArgs;

// ── Pure validation helpers ──────────────────────────────────────────────────

/**
 * Names reserved by the CLI itself and therefore invalid as instance names.
 *
 * Any name in this list is rejected by {@link validateInstanceName} so a
 * registered instance never shadows a built-in subcommand.
 */
export const RESERVED_INSTANCE_NAMES: ReadonlySet<string> = new Set(CLI_COMMANDS);

/** Max length of an instance name. */
export const INSTANCE_NAME_MAX_LENGTH = 40;

/** Min length of an instance name. */
export const INSTANCE_NAME_MIN_LENGTH = 1;

/**
 * Validate an instance name.
 *
 * Rules:
 * - Must be between {@link INSTANCE_NAME_MIN_LENGTH} and
 *   {@link INSTANCE_NAME_MAX_LENGTH} characters.
 * - Must be lowercase kebab-case: `[a-z][a-z0-9]*(-[a-z0-9]+)*`
 * - Must not be in {@link RESERVED_INSTANCE_NAMES}.
 *
 * @returns `{ ok: true, value: string }` or `{ ok: false, error: string }`.
 */
export function validateInstanceName(
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string") {
    return { ok: false, error: "Instance name must be a string" };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Instance name must not be empty" };
  }
  if (trimmed.length < INSTANCE_NAME_MIN_LENGTH) {
    return {
      ok: false,
      error: `Instance name must be at least ${INSTANCE_NAME_MIN_LENGTH} character`,
    };
  }
  if (trimmed.length > INSTANCE_NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: `Instance name must be at most ${INSTANCE_NAME_MAX_LENGTH} characters`,
    };
  }
  // Kebab-case: starts with lowercase letter, followed by alphanumeric
  // lowercase segments separated by single hyphens.
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(trimmed)) {
    return {
      ok: false,
      error:
        'Instance name must be lowercase kebab-case (e.g. "my-project", "side-experiment")',
    };
  }
  if (RESERVED_INSTANCE_NAMES.has(trimmed)) {
    return {
      ok: false,
      error: `"${trimmed}" is a reserved name and cannot be used as an instance name`,
    };
  }
  return { ok: true, value: trimmed };
}

// ── Port validation (mirrors src/server/config.ts rules) ─────────────────────

/** The port range enforced by `src/server/config.ts` (parseStrictPort). */
export const PORT_MIN = 1;
export const PORT_MAX = 65535;

/**
 * Validate a port value against the same rules used in
 * `src/server/config.ts`.
 *
 * - Must be an integer.
 * - Must be in [1, 65535].
 *
 * @returns `{ ok: true; value: number }` or `{ ok: false; error: string }`.
 */
export function validatePort(
  raw: unknown,
): { ok: true; value: number } | { ok: false; error: string } {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { ok: false, error: `Port must be a finite number, got ${typeof raw}` };
  }
  if (!Number.isInteger(raw)) {
    return { ok: false, error: `Port must be an integer, got ${raw}` };
  }
  if (raw < PORT_MIN || raw > PORT_MAX) {
    return {
      ok: false,
      error: `Port must be between ${PORT_MIN} and ${PORT_MAX}, got ${raw}`,
    };
  }
  return { ok: true, value: raw };
}

// ── InstancesFile validation ─────────────────────────────────────────────────

/** Shape of a single validation error returned by {@link validateInstancesFile}. */
export interface InstancesFileError {
  /** Dot-path to the problematic field (e.g. `"instances[1].port"`). */
  path: string;
  message: string;
}

/** Successful validation result. */
export interface InstancesFileOk {
  ok: true;
  value: InstancesFile;
}

/** Failed validation result. */
export interface InstancesFileErr {
  ok: false;
  errors: InstancesFileError[];
}

export type InstancesFileResult = InstancesFileOk | InstancesFileErr;

/**
 * Validate an unknown value as an {@link InstancesFile}.
 *
 * Checks:
 * - Is a plain object (not null, not an array).
 * - `version` is exactly `1`.
 * - `defaultInstance` (if present) is a string that exists in `instances`.
 * - `instances` is a non-empty array.
 * - Each instance has a valid kebab-case `name` (via {@link validateInstanceName}).
 * - All instance `name` values are unique.
 * - Each instance has a valid `port` (via {@link validatePort}).
 * - All instance `port` values are unique.
 * - `workspace` is a non-empty string.
 * - `dbPath` is a non-empty string.
 * - `opencodePort` (if present) is a valid port.
 * - `boardToken` (if present) is a non-empty string.
 *
 * This is a pure function — no I/O.
 */
export function validateInstancesFile(raw: unknown): InstancesFileResult {
  const errors: InstancesFileError[] = [];

  // Must be a plain (non-null, non-array) object.
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: [{ path: "", message: "Instances file must be a JSON object" }] };
  }

  const obj = raw as Record<string, unknown>;

  // version
  if (obj.version !== 1) {
    errors.push({
      path: "version",
      message: `version must be 1, got ${JSON.stringify(obj.version)}`,
    });
    // If version is wrong, short-circuit — the rest of the schema is unverifiable.
    return { ok: false, errors };
  }

  // defaultInstance
  if (obj.defaultInstance !== undefined && typeof obj.defaultInstance !== "string") {
    errors.push({ path: "defaultInstance", message: "defaultInstance must be a string if set" });
  }

  // instances
  if (!Array.isArray(obj.instances)) {
    errors.push({ path: "instances", message: "instances must be an array" });
    return { ok: false, errors };
  }
  if (obj.instances.length === 0) {
    errors.push({ path: "instances", message: "instances must contain at least one instance" });
    return { ok: false, errors };
  }

  const seenNames = new Map<string, number>(); // name -> first index
  const seenPorts = new Map<number, number>(); // port -> first index

  const instancesArr = obj.instances as unknown[];

  for (let i = 0; i < instancesArr.length; i++) {
    const entry = instancesArr[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push({ path: `instances[${i}]`, message: "Each instance must be an object" });
      continue;
    }
    const inst = entry as Record<string, unknown>;

    // --- name ---
    if (typeof inst.name !== "string") {
      errors.push({
        path: `instances[${i}].name`,
        message: "name must be a string",
      });
    } else {
      const nameResult = validateInstanceName(inst.name);
      if (!nameResult.ok) {
        errors.push({ path: `instances[${i}].name`, message: nameResult.error });
      } else {
        const existing = seenNames.get(nameResult.value);
        if (existing !== undefined) {
          errors.push({
            path: `instances[${i}].name`,
            message: `Duplicate instance name "${nameResult.value}" (first seen at instances[${existing}].name)`,
          });
        } else {
          seenNames.set(nameResult.value, i);
        }
      }
    }

    // --- port ---
    const portResult = validatePort(inst.port);
    if (!portResult.ok) {
      errors.push({ path: `instances[${i}].port`, message: portResult.error });
    } else {
      const existing = seenPorts.get(portResult.value);
      if (existing !== undefined) {
        errors.push({
          path: `instances[${i}].port`,
          message: `Duplicate port ${portResult.value} (first seen at instances[${existing}].port)`,
        });
      } else {
        seenPorts.set(portResult.value, i);
      }
    }

    // --- workspace ---
    if (typeof inst.workspace !== "string" || inst.workspace.trim() === "") {
      errors.push({
        path: `instances[${i}].workspace`,
        message: "workspace must be a non-empty string",
      });
    }

    // --- dbPath ---
    if (typeof inst.dbPath !== "string" || inst.dbPath.trim() === "") {
      errors.push({
        path: `instances[${i}].dbPath`,
        message: "dbPath must be a non-empty string",
      });
    }

    // --- opencodePort (optional) ---
    if (inst.opencodePort !== undefined) {
      const ocPortResult = validatePort(inst.opencodePort);
      if (!ocPortResult.ok) {
        errors.push({
          path: `instances[${i}].opencodePort`,
          message: ocPortResult.error,
        });
      }
    }

    // --- boardToken (optional) ---
    if (inst.boardToken !== undefined && (typeof inst.boardToken !== "string" || inst.boardToken.trim() === "")) {
      errors.push({
        path: `instances[${i}].boardToken`,
        message: "boardToken must be a non-empty string if set",
      });
    }
  }

  // --- defaultInstance must reference an existing instance ---
  if (typeof obj.defaultInstance === "string" && obj.defaultInstance.length > 0) {
    if (!seenNames.has(obj.defaultInstance)) {
      errors.push({
        path: "defaultInstance",
        message: `defaultInstance "${obj.defaultInstance}" not found in instances`,
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // We've validated enough to trust the cast.
  return { ok: true, value: obj as unknown as InstancesFile };
}

// ── Default instance resolution ──────────────────────────────────────────────

/**
 * Resolve the default instance from a validated {@link InstancesFile}.
 *
 * Precedence:
 * 1. `file.defaultInstance` if set.
 * 2. The single instance if there is exactly one.
 * 3. `undefined` otherwise (caller decides what "no default" means).
 *
 * This is pure — it reads only its argument, no I/O.
 *
 * @returns The resolved {@link InstanceDefinition} or `undefined`.
 */
export function resolveDefaultInstance(
  file: InstancesFile,
): InstanceDefinition | undefined {
  if (file.defaultInstance) {
    return file.instances.find((i) => i.name === file.defaultInstance);
  }
  if (file.instances.length === 1) {
    return file.instances[0];
  }
  return undefined;
}

/**
 * Whether a board URL points at this machine (loopback host).
 *
 * Lives here — not in the TUI launcher — so renderer code can use it without
 * importing the launcher module. The launcher ends in an "am I the entrypoint"
 * `import.meta.url === argv[1]` guard; bundling it into `dist/tui/index.mjs`
 * makes that guard true inside the renderer and every renderer boot spawns
 * another renderer (live incident, 2026-07-05). Nothing the renderer bundle
 * imports may pull in `src/tui/launcher.ts`.
 */
export function isLocalBoardUrl(boardUrl: string): boolean {
  const { hostname } = new URL(boardUrl);
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}
