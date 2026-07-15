import { existsSync, renameSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  instanceDataDir,
  InstanceError,
  InstanceUnknownError,
  validateInstanceName,
  type InstanceDefinition,
  type InstancesFile,
} from "../shared/instances";
import type { InstanceDaemon } from "./daemon";
import type { InstanceRegistry } from "./registry";

export interface InstanceRenameFileSystem {
  exists(path: string): boolean;
  move(from: string, to: string): void;
}

export interface RenameInstanceDependencies {
  homeDir: string;
  registry: Pick<InstanceRegistry, "get" | "rename" | "validateRename">;
  daemon: Pick<InstanceDaemon, "start" | "status" | "stop">;
  prepareForStart?: (definition: InstanceDefinition) => InstanceDefinition;
  fileSystem?: InstanceRenameFileSystem;
}

const nodeFileSystem: InstanceRenameFileSystem = {
  exists: existsSync,
  move: renameSync,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function relocatedDbPath(
  definition: InstanceDefinition,
  oldDataDir: string,
  newDataDir: string,
): string {
  const relativePath = relative(resolve(oldDataDir), resolve(definition.dbPath));
  const isInsideOldDataDir =
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath);
  return isInsideOldDataDir ? join(newDataDir, relativePath) : definition.dbPath;
}

/**
 * Rename one registered instance without allowing its registry identity and
 * data directory to diverge.
 *
 * Validation and destination checks happen before daemon shutdown. The data
 * move and registry persistence then commit under the registry write lock; a
 * failed commit moves the data back before the old daemon may be restarted.
 */
export async function renameInstance(
  dependencies: RenameInstanceDependencies,
  oldName: string,
  requestedNewName: string,
): Promise<InstanceDefinition> {
  const { homeDir, registry, daemon } = dependencies;
  const fileSystem = dependencies.fileSystem ?? nodeFileSystem;

  const validation = validateInstanceName(requestedNewName);
  if (!validation.ok) throw new InstanceError(validation.error);
  const newName = validation.value;

  // Fresh, locked preflight: invalid names and registered collisions must fail
  // before status inspection can lead to a daemon stop.
  const oldDefinition = registry.validateRename(oldName, newName);
  const oldDirs = instanceDataDir(homeDir, oldName);
  const newDirs = instanceDataDir(homeDir, newName);
  if (fileSystem.exists(newDirs.dataDir)) {
    throw new InstanceError(
      `Cannot rename instance "${oldName}" to "${newName}": destination data directory already exists: ${newDirs.dataDir}`,
    );
  }

  const runtime = await daemon.status(oldDefinition);
  const wasLive = runtime.pid !== undefined;
  if (wasLive) await daemon.stop(oldDefinition);

  let dataLocation: "old" | "new" | "missing" = fileSystem.exists(oldDirs.dataDir)
    ? "old"
    : "missing";

  let updatedFile: InstancesFile;
  try {
    updatedFile = registry.rename(
      oldName,
      newName,
      relocatedDbPath(oldDefinition, oldDirs.dataDir, newDirs.dataDir),
      {
        apply() {
          // Recheck after the asynchronous stop and while the registry writer
          // lock is held. Never overwrite or silently adopt an orphan directory.
          if (fileSystem.exists(newDirs.dataDir)) {
            throw new InstanceError(
              `Cannot rename instance "${oldName}" to "${newName}": destination data directory already exists: ${newDirs.dataDir}`,
            );
          }
          if (!fileSystem.exists(oldDirs.dataDir)) {
            dataLocation = "missing";
            return;
          }
          fileSystem.move(oldDirs.dataDir, newDirs.dataDir);
          dataLocation = "new";
        },
        rollback() {
          if (dataLocation !== "new") return;
          fileSystem.move(newDirs.dataDir, oldDirs.dataDir);
          dataLocation = "old";
        },
      },
    );
  } catch (error) {
    const oldStillRegistered = registry.get(oldName) !== undefined;
    if (wasLive && oldStillRegistered && dataLocation === "old") {
      try {
        const restartDefinition = dependencies.prepareForStart?.(oldDefinition) ?? oldDefinition;
        await daemon.start(restartDefinition);
      } catch (restartError) {
        throw new InstanceError(
          `Rename from "${oldName}" to "${newName}" failed: ${errorMessage(error)}. ` +
          `The original data and registry entry were restored, but restarting "${oldName}" also failed: ${errorMessage(restartError)}`,
        );
      }
    }
    throw error;
  }

  const newDefinition = updatedFile.instances.find((instance) => instance.name === newName);
  if (!newDefinition) throw new InstanceUnknownError(newName);

  if (wasLive) {
    try {
      const restartDefinition = dependencies.prepareForStart?.(newDefinition) ?? newDefinition;
      await daemon.start(restartDefinition);
    } catch (error) {
      throw new InstanceError(
        `Instance "${oldName}" was renamed to "${newName}", but it could not be restarted: ${errorMessage(error)}. ` +
        `The registry and data directory are consistent under "${newName}"; start it with: openboard start ${newName}`,
      );
    }
  }

  return newDefinition;
}
