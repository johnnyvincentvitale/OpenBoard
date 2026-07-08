import type {
  InstanceDefinition,
  InstanceRuntimeState,
} from "../shared/instances";
import type { BoardHealth } from "../shared/health";

export type DefaultInstanceInfo =
  | { kind: "explicit"; definition: InstanceDefinition; instanceCount: number }
  | { kind: "inferred"; definition: InstanceDefinition; instanceCount: number }
  | { kind: "unset"; instanceCount: number };

/**
 * Thin lifecycle seam for the `openboard` CLI.
 *
 * The real implementation lives in the parallel `src/instances/` lane; this
 * interface is consumed by `src/cli/openboard.ts` and mocked in tests. All
 * methods return the frozen data shapes from `src/shared/instances.ts` and
 * throw the frozen error hierarchy.
 */
export interface InstanceLifecycleProvider {
  /** Return every registered instance together with its current runtime state. */
  list(): Promise<
    Array<{ definition: InstanceDefinition; runtime: InstanceRuntimeState }>
  >;

  /** Return a single instance definition, or throw {@link InstanceUnknownError}. */
  get(name: string): Promise<InstanceDefinition>;

  /** Resolve the default instance: explicit default, or the only instance. */
  resolveDefault(): Promise<InstanceDefinition | undefined>;

  /** Explain default resolution: explicit, inferred from one instance, or unset. */
  getDefaultInfo(): Promise<DefaultInstanceInfo>;

  /** Persist an explicit default instance after validating it exists. */
  setDefault(name: string): Promise<InstanceDefinition>;

  /** Clear any explicit default instance. */
  clearDefault(): Promise<DefaultInstanceInfo>;

  /**
   * Register a new instance.
   *
   * The CLI is responsible for computing an auto-assigned board port; the
   * provider validates the result and may throw {@link InstanceNameCollisionError}
   * or {@link InstancePortConflictError}.
   */
  add(input: {
    name: string;
    port: number;
    workspace: string;
    dbPath?: string;
    opencodePort?: number;
  }): Promise<InstanceDefinition>;

  /** Unregister an instance. May throw {@link InstanceUnknownError}. */
  remove(name: string): Promise<void>;

  /** Start an instance and return its new runtime state. */
  start(name: string): Promise<InstanceRuntimeState>;

  /** Stop an instance and return its new runtime state. */
  stop(name: string): Promise<InstanceRuntimeState>;

  /** Current runtime state of a single instance. */
  getRuntime(name: string): Promise<InstanceRuntimeState>;

  /** Live health for a running instance, or undefined if unavailable. */
  getHealth(name: string): Promise<BoardHealth | undefined>;

  /**
   * Rename an instance.
   *
   * - Stops the instance if currently running.
   * - Moves the data directory to the new name.
   * - Updates the registry entry.
   * - Restarts the instance if it was running before the rename.
   */
  rename(oldName: string, newName: string): Promise<InstanceDefinition>;
}
