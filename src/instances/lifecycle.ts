import {
  instanceDataDir,
  InstanceError,
  InstanceUnknownError,
  validateInstanceName,
  type InstanceDefinition,
  type InstanceRuntimeState,
} from "../shared/instances";
import type { InstanceDaemon } from "./daemon";
import type { InstanceRegistry } from "./registry";
import { renameInstance } from "./rename";

export interface InstanceLifecycleCore {
  get(name: string): InstanceDefinition;
  list(): Promise<Array<{ definition: InstanceDefinition; runtime: InstanceRuntimeState }>>;
  add(input: { name: string; port: number; workspace: string; dbPath?: string; opencodePort?: number }): InstanceDefinition;
  remove(name: string): Promise<void>;
  start(name: string): Promise<InstanceRuntimeState>;
  stop(name: string): Promise<InstanceRuntimeState>;
  getRuntime(name: string): Promise<InstanceRuntimeState>;
  rename(oldName: string, newName: string): Promise<InstanceDefinition>;
}

/** Shared named-instance lifecycle used by both CLI and TUI adapters. */
export function createInstanceLifecycleCore(input: {
  homeDir: string;
  registry: InstanceRegistry;
  daemon: InstanceDaemon;
  createBoardToken: () => string;
}): InstanceLifecycleCore {
  const { homeDir, registry, daemon, createBoardToken } = input;
  const get = (name: string): InstanceDefinition => {
    const definition = registry.get(name);
    if (!definition) throw new InstanceUnknownError(name);
    return definition;
  };
  const prepareForStart = (definition: InstanceDefinition): InstanceDefinition =>
    definition.boardToken?.trim()
      ? definition
      : registry.ensureBoardToken(definition.name, createBoardToken());

  return {
    get,
    async list() {
      return Promise.all(registry.list().map(async (definition) => ({
        definition,
        runtime: await daemon.status(definition),
      })));
    },
    add(addInput) {
      const validation = validateInstanceName(addInput.name);
      if (!validation.ok) throw new InstanceError(validation.error);
      const dirs = instanceDataDir(homeDir, validation.value);
      const definition: InstanceDefinition = {
        ...addInput,
        name: validation.value,
        dbPath: addInput.dbPath ?? `${dirs.dataDir}/board.sqlite`,
        boardToken: createBoardToken(),
      };
      registry.add(definition);
      return definition;
    },
    async remove(name) {
      if ((await daemon.status(get(name))).status === "running") {
        throw new InstanceError(`Cannot remove running instance: "${name}"`);
      }
      registry.remove(name);
    },
    async start(name) {
      const definition = prepareForStart(get(name));
      const runtime = await daemon.status(definition);
      if (runtime.status === "running") return runtime;
      if (runtime.status === "unhealthy") {
        throw new InstanceError(`Instance "${name}" is unhealthy with live pid ${runtime.pid}; stop it before starting again`);
      }
      return daemon.start(definition);
    },
    async stop(name) {
      const definition = get(name);
      await daemon.stop(definition);
      return daemon.status(definition);
    },
    getRuntime(name) {
      return daemon.status(get(name));
    },
    rename(oldName, newName) {
      return renameInstance({ homeDir, registry, daemon, prepareForStart }, oldName, newName);
    },
  };
}
