/**
 * OpenBoard instances module — public surface.
 *
 * This module is the single import target for CLI (lane C) and TUI (lane B)
 * callers. It re-exports the frozen shared contracts (types, validators,
 * path-builders, error classes) and adds the two I/O-backed controllers:
 *
 * - {@link createInstanceRegistry} — load/save the registry file.
 * - {@link createInstanceDaemon}  — spawn/stop/status daemon processes.
 */
export type {
  InstanceDefinition,
  InstancesFile,
  InstanceRuntimeState,
  InstanceStatus,
  InstanceDataDir,
  InstancesFileError,
  InstancesFileOk,
  InstancesFileErr,
  InstancesFileResult,
  CliCommand,
  CliArgs,
  CliListArgs,
  CliAddArgs,
  CliRemoveArgs,
  CliStartArgs,
  CliStopArgs,
  CliAttachArgs,
  CliRenameArgs,
} from "../shared/instances";

export {
  instancesFilePath,
  instanceDataDir,
  InstanceError,
  InstanceNameCollisionError,
  InstanceUnknownError,
  InstancePortConflictError,
  InstanceSpawnError,
  INSTANCE_STATUSES,
  CLI_COMMANDS,
  RESERVED_INSTANCE_NAMES,
  PORT_MIN,
  PORT_MAX,
  INSTANCE_NAME_MIN_LENGTH,
  INSTANCE_NAME_MAX_LENGTH,
  validateInstanceName,
  validatePort,
  validateInstancesFile,
  resolveDefaultInstance,
} from "../shared/instances";

export {
  createInstanceRegistry,
  type InstanceRegistry,
  type InstanceRenameTransaction,
} from "./registry";
export { createInstanceDaemon, type InstanceDaemon, buildAdapterEnv } from "./daemon";
export {
  renameInstance,
  type InstanceRenameFileSystem,
  type RenameInstanceDependencies,
} from "./rename";
