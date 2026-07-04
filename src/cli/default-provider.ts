import { homedir } from "node:os";
import { renameSync } from "node:fs";
import {
  createInstanceDaemon,
  createInstanceRegistry,
  instanceDataDir,
  InstanceError,
  InstanceUnknownError,
  resolveDefaultInstance,
} from "../instances";
import type {
  InstanceDefinition,
  InstanceRuntimeState,
} from "../shared/instances";
import { resolveBoardToken } from "../server/auth";
import type { InstanceLifecycleProvider } from "./provider";

/**
 * Real instance lifecycle provider wired to the persistent registry and daemon
 * in `src/instances`. The CLI binary uses this by default; tests inject a mock
 * by passing a different `provider` to `runOpenboard()`.
 *
 * Paths are derived from the user's home directory so a temp `HOME` in tests
 * fully isolates the registry and per-instance data directories.
 */
export function createDefaultProvider(homeDir = homedir()): InstanceLifecycleProvider {
  const registry = createInstanceRegistry(homeDir);
  const daemon = createInstanceDaemon(homeDir, registry);

  const getDefinition = (name: string): InstanceDefinition => {
    const def = registry.get(name);
    if (!def) throw new InstanceUnknownError(name);
    return def;
  };

  const createBoardToken = (): string =>
    resolveBoardToken({ OPENBOARD_API_TOKEN: process.env.OPENBOARD_API_TOKEN } as NodeJS.ProcessEnv);

  const ensureBoardToken = (definition: InstanceDefinition): InstanceDefinition => {
    if (definition.boardToken?.trim()) return definition;
    const updated: InstanceDefinition = { ...definition, boardToken: createBoardToken() };
    const file = registry.getFile();
    registry.save({
      ...file,
      instances: file.instances.map((item) => item.name === updated.name ? updated : item),
    });
    return updated;
  };

  return {
    async list() {
      const defs = registry.list();
      const entries = await Promise.all(
        defs.map(async (definition) => ({
          definition,
          runtime: await daemon.status(definition),
        })),
      );
      return entries;
    },

    async get(name) {
      return getDefinition(name);
    },

    async resolveDefault() {
      const file = registry.getFile();
      return resolveDefaultInstance(file);
    },

    async add(input) {
      const dirs = instanceDataDir(homeDir, input.name);
      const definition: InstanceDefinition = {
        name: input.name,
        port: input.port,
        workspace: input.workspace,
        dbPath: input.dbPath ?? `${dirs.dataDir}/board.sqlite`,
        boardToken: createBoardToken(),
        ...(input.opencodePort !== undefined
          ? { opencodePort: input.opencodePort }
          : {}),
      };
      registry.add(definition);
      return definition;
    },

    async remove(name) {
      registry.remove(name);
    },

    async start(name) {
      const definition = ensureBoardToken(getDefinition(name));
      const before = await daemon.status(definition);
      if (before.status === "running") {
        return before;
      }
      if (before.status === "unhealthy") {
        throw new InstanceError(`Instance "${name}" is unhealthy with live pid ${before.pid}; stop it before starting again`);
      }
      return daemon.start(definition);
    },

    async stop(name) {
      const definition = getDefinition(name);
      await daemon.stop(definition);
      return daemon.status(definition);
    },

    async getRuntime(name) {
      const definition = getDefinition(name);
      return daemon.status(definition);
    },

    async rename(oldName, newName) {
      const oldDef = getDefinition(oldName);

      const runtime = await daemon.status(oldDef);
      const wasRunning = runtime.status === "running";

      if (wasRunning) {
        await daemon.stop(oldDef);
      }

      // Move data directory from old name to new name
      const oldDirs = instanceDataDir(homeDir, oldName);
      const newDirs = instanceDataDir(homeDir, newName);
      renameSync(oldDirs.dataDir, newDirs.dataDir);

      // Compute new dbPath
      const newDbPath = `${newDirs.dataDir}/board.sqlite`;

      // Rename in registry
      registry.rename(oldName, newName, newDbPath);

      if (wasRunning) {
        const newDef = registry.get(newName);
        if (newDef) {
          await daemon.start(ensureBoardToken(newDef));
        }
      }

      return registry.get(newName)!;
    },
  };
}
