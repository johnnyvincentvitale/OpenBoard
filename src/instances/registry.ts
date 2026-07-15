/**
 * Instance registry — loads and mutates `~/.config/openboard/instances.json`.
 *
 * The file is machine-managed. All writes are atomic (temp file + rename).
 * `validateInstancesFile` guards every save so the on-disk schema never
 * drifts from the frozen contract. Unknown extra fields are NOT preserved
 * on round-trip — writes are canonical (this simplifies the impl and the
 * file is not hand-edited).
 *
 * All operations work against a `homeDir` so callers control the filesystem
 * root (production = os.homedir(), tests = temp dir).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  InstanceError,
  InstanceNameCollisionError,
  InstanceUnknownError,
  InstancePortConflictError,
  instancesFilePath,
  validateInstanceName,
  validateInstancesFile,
  type InstanceDefinition,
  type InstancesFile,
} from "../shared/instances";
import { acquireLockfile, LockfileBusyError, releaseLockfile, type LockfileHandle } from "./lockfile";

const REGISTRY_LOCK_FILE = "instances.json.lock";
const REGISTRY_LOCK_RETRIES = 10;
const REGISTRY_LOCK_DELAY_MS = 25;

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Canonical on-disk representation — no extra keys. */
function canonicalFile(file: InstancesFile): unknown {
  const instances = file.instances.map((i) => {
    const inst: Record<string, unknown> = {
      name: i.name,
      port: i.port,
      workspace: i.workspace,
      dbPath: i.dbPath,
    };
    if (i.opencodePort !== undefined) {
      inst.opencodePort = i.opencodePort;
    }
    if (i.boardToken !== undefined) {
      inst.boardToken = i.boardToken;
    }
    return inst;
  });

  const result: Record<string, unknown> = { version: file.version, instances };
  if (file.defaultInstance !== undefined) {
    result.defaultInstance = file.defaultInstance;
  }
  return result;
}

/**
 * Write `content` atomically to `filePath`:
 * 1. Write to a sibling temp file.
 * 2. `rename` over the target.
 */
function atomicWrite(filePath: string, content: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = filePath + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, filePath);
  } catch (err) {
    // Best-effort cleanup — don't mask the original error.
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireRegistryLock(filePath: string): LockfileHandle {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const lockPath = `${dir}/${REGISTRY_LOCK_FILE}`;
  for (let attempt = 0; attempt <= REGISTRY_LOCK_RETRIES; attempt += 1) {
    try {
      return acquireLockfile(lockPath);
    } catch (err) {
      if (!(err instanceof LockfileBusyError)) throw err;
      if (attempt === REGISTRY_LOCK_RETRIES) {
        throw new InstanceError(`Instance registry is locked by another writer: ${lockPath}`);
      }
      sleepSync(REGISTRY_LOCK_DELAY_MS);
    }
  }
  throw new InstanceError(`Instance registry is locked by another writer: ${lockPath}`);
}

function releaseRegistryLock(lock: LockfileHandle): void {
  releaseLockfile(lock);
}

// ── Registry ─────────────────────────────────────────────────────────────────

/**
 * Persistent registry of named OpenBoard instances.
 *
 * Create a registry bound to a specific home directory:
 *
 * ```ts
 * import { homedir } from "node:os";
 * const registry = createInstanceRegistry(homedir());
 * ```
 */
export interface InstanceRegistry {
  /** Load (or create) the backing file and return its contents. */
  load(): InstancesFile;

  /** Add a new instance. Throws on name collision or port conflict. */
  add(def: InstanceDefinition): InstancesFile;

  /** Remove an instance by name. Throws if unknown. */
  remove(name: string): InstancesFile;

  /**
   * Validate a rename against a fresh, locked registry snapshot without
   * mutating it. Used by lifecycle callers to fail before stopping a daemon.
   */
  validateRename(oldName: string, newName: string): InstanceDefinition;

  /**
   * Rename an instance.
   *
   * - Validates newName via {@link validateInstanceName}.
   * - Throws {@link InstanceUnknownError} if oldName is not found.
   * - Throws {@link InstanceNameCollisionError} if newName already exists.
   * - Updates defaultInstance if it matches oldName.
   * - Preserves all other fields (port, workspace, opencodePort).
   */
  rename(
    oldName: string,
    newName: string,
    newDbPath: string,
    transaction?: InstanceRenameTransaction,
  ): InstancesFile;

  /** Get a single instance by name. */
  get(name: string): InstanceDefinition | undefined;

  /** List all registered instances. */
  list(): InstanceDefinition[];

  /** Set the explicit default instance. */
  setDefault(name: string): InstancesFile;

  /** Clear the explicit default instance. */
  clearDefault(): InstancesFile;

  /** Persist a board token only when a fresh, locked definition still lacks one. */
  ensureBoardToken(name: string, candidateToken: string): InstanceDefinition;

  /** Return the raw backing file. */
  getFile(): InstancesFile;
}

/**
 * Synchronous side effect committed under the same lock as a registry rename.
 * `apply` must either complete atomically or throw before changing state.
 */
export interface InstanceRenameTransaction {
  apply(): void;
  rollback(): void;
}

interface ValidatedRename {
  index: number;
  normalizedName: string;
  oldDefinition: InstanceDefinition;
}

function validateRenameRequest(
  file: InstancesFile,
  oldName: string,
  newName: string,
): ValidatedRename {
  const index = file.instances.findIndex((instance) => instance.name === oldName);
  if (index === -1) {
    throw new InstanceUnknownError(oldName);
  }

  const nameResult = validateInstanceName(newName);
  if (!nameResult.ok) {
    throw new InstanceError(nameResult.error);
  }

  if (file.instances.some((instance) => instance.name === nameResult.value)) {
    throw new InstanceNameCollisionError(nameResult.value);
  }

  return {
    index,
    normalizedName: nameResult.value,
    oldDefinition: file.instances[index],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createInstanceRegistry(homeDir: string): InstanceRegistry {
  const filePath = instancesFilePath(homeDir);

  let cache: InstancesFile | null = null;

  const loadFresh = (): InstancesFile => {
    if (!existsSync(filePath)) {
      const def: InstancesFile = { version: 1, instances: [] };
      const json = JSON.stringify(canonicalFile(def), null, 2) + "\n";
      atomicWrite(filePath, json);
      return def;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(filePath, "utf-8"));
    } catch {
      throw new InstanceError(
        `Failed to parse ${filePath}: invalid JSON`,
      );
    }

    const result = validateInstancesFile(raw);
    if (!result.ok) {
      if (
        typeof raw === "object" &&
        raw !== null &&
        !Array.isArray(raw) &&
        (raw as { version?: unknown }).version === 1 &&
        Array.isArray((raw as { instances?: unknown }).instances) &&
        ((raw as { instances: unknown[] }).instances).length === 0 &&
        result.errors.length === 1 &&
        result.errors[0]?.path === "instances"
      ) {
        return { version: 1, instances: [] };
      }
      const messages = result.errors
        .map((e) => `  ${e.path}: ${e.message}`)
        .join("\n");
      throw new InstanceError(
        `Invalid instances file at ${filePath}:\n${messages}`,
      );
    }

    return result.value;
  };

  const load = (): InstancesFile => {
    if (cache) return cache;
    cache = loadFresh();
    return cache;
  };

  const persist = (file: InstancesFile): void => {
    const result = validateInstancesFile(file);
    if (!result.ok) {
      if (file.version === 1 && Array.isArray(file.instances) && file.instances.length === 0) {
        const json = JSON.stringify(canonicalFile(file), null, 2) + "\n";
        atomicWrite(filePath, json);
        cache = file;
        return;
      }
      const messages = result.errors
        .map((e) => `  ${e.path}: ${e.message}`)
        .join("\n");
      throw new InstanceError(`Refusing to write invalid instances file:\n${messages}`);
    }
    const json = JSON.stringify(canonicalFile(result.value), null, 2) + "\n";
    atomicWrite(filePath, json);
    cache = result.value;
  };

  const add = (def: InstanceDefinition): InstancesFile => {
    const lock = acquireRegistryLock(filePath);
    try {
      const file = loadFresh();

      // Name collision
      if (file.instances.some((i) => i.name === def.name)) {
        throw new InstanceNameCollisionError(def.name);
      }

      // Port conflict (within the registry)
      const conflict = file.instances.find((i) => i.port === def.port);
      if (conflict) {
        throw new InstancePortConflictError(def.port, conflict.name);
      }
      // opencodePort conflict (if set)
      if (def.opencodePort !== undefined) {
        const ocConflict = file.instances.find(
          (i) => i.opencodePort === def.opencodePort,
        );
        if (ocConflict) {
          throw new InstancePortConflictError(
            def.opencodePort,
            ocConflict.name,
          );
        }
      }

      const updated: InstancesFile = {
        ...file,
        instances: [...file.instances, def],
      };
      persist(updated);
      return updated;
    } finally {
      releaseRegistryLock(lock);
    }
  };

  const remove = (name: string): InstancesFile => {
    const lock = acquireRegistryLock(filePath);
    try {
      const file = loadFresh();
      const idx = file.instances.findIndex((i) => i.name === name);
      if (idx === -1) {
        throw new InstanceUnknownError(name);
      }

      const updated: InstancesFile = {
        ...file,
        instances: file.instances.filter((i) => i.name !== name),
      };

      // If the removed instance was the default, clear defaultInstance.
      if (updated.defaultInstance === name) {
        updated.defaultInstance = undefined;
      }

      persist(updated);
      return updated;
    } finally {
      releaseRegistryLock(lock);
    }
  };

  const validateRename = (oldName: string, newName: string): InstanceDefinition => {
    const lock = acquireRegistryLock(filePath);
    try {
      const file = loadFresh();
      cache = file;
      return validateRenameRequest(file, oldName, newName).oldDefinition;
    } finally {
      releaseRegistryLock(lock);
    }
  };

  const rename = (
    oldName: string,
    newName: string,
    newDbPath: string,
    transaction?: InstanceRenameTransaction,
  ): InstancesFile => {
    const lock = acquireRegistryLock(filePath);
    try {
      const file = loadFresh();
      cache = file;
      const validated = validateRenameRequest(file, oldName, newName);
      const oldDef = validated.oldDefinition;
      const newDef: InstanceDefinition = {
        name: validated.normalizedName,
        port: oldDef.port,
        workspace: oldDef.workspace,
        dbPath: newDbPath,
        ...(oldDef.opencodePort !== undefined
          ? { opencodePort: oldDef.opencodePort }
          : {}),
        ...(oldDef.boardToken !== undefined
          ? { boardToken: oldDef.boardToken }
          : {}),
      };

      // Replace in place to preserve order
      const newInstances = [...file.instances];
      newInstances[validated.index] = newDef;

      const updated: InstancesFile = {
        ...file,
        instances: newInstances,
      };

      // Update defaultInstance if it matched the old name
      if (updated.defaultInstance === oldName) {
        updated.defaultInstance = validated.normalizedName;
      }

      let transactionApplied = false;
      try {
        transaction?.apply();
        transactionApplied = transaction !== undefined;
        persist(updated);
      } catch (error) {
        if (transactionApplied && transaction) {
          try {
            transaction.rollback();
          } catch (rollbackError) {
            throw new InstanceError(
              `Failed to rename instance "${oldName}" to "${validated.normalizedName}": ${errorMessage(error)}. ` +
              `Filesystem rollback also failed: ${errorMessage(rollbackError)}. ` +
              `The registry still names "${oldName}"; data may remain under "${validated.normalizedName}".`,
            );
          }
        }
        throw error;
      }
      return updated;
    } finally {
      releaseRegistryLock(lock);
    }
  };

  const get = (name: string): InstanceDefinition | undefined => {
    return load().instances.find((i) => i.name === name);
  };

  const list = (): InstanceDefinition[] => {
    return load().instances;
  };

  const setDefault = (name: string): InstancesFile => {
    const lock = acquireRegistryLock(filePath);
    try {
      const file = loadFresh();
      if (!file.instances.some((i) => i.name === name)) {
        throw new InstanceUnknownError(name);
      }
      const updated: InstancesFile = { ...file, defaultInstance: name };
      persist(updated);
      return updated;
    } finally {
      releaseRegistryLock(lock);
    }
  };

  const clearDefault = (): InstancesFile => {
    const lock = acquireRegistryLock(filePath);
    try {
      const file = loadFresh();
      const updated: InstancesFile = { ...file, defaultInstance: undefined };
      persist(updated);
      return updated;
    } finally {
      releaseRegistryLock(lock);
    }
  };

  const ensureBoardToken = (name: string, candidateToken: string): InstanceDefinition => {
    const lock = acquireRegistryLock(filePath);
    try {
      const file = loadFresh();
      const index = file.instances.findIndex((instance) => instance.name === name);
      if (index === -1) throw new InstanceUnknownError(name);
      const current = file.instances[index];
      if (current.boardToken?.trim()) {
        cache = file;
        return current;
      }
      const updatedDefinition: InstanceDefinition = {
        ...current,
        boardToken: candidateToken,
      };
      const instances = [...file.instances];
      instances[index] = updatedDefinition;
      persist({ ...file, instances });
      return updatedDefinition;
    } finally {
      releaseRegistryLock(lock);
    }
  };

  const getFile = (): InstancesFile => {
    return load();
  };

  return { load, add, remove, validateRename, rename, get, list, setDefault, clearDefault, ensureBoardToken, getFile };
}
