import { homedir } from "node:os";
import { createDefaultProvider } from "../cli/default-provider";
import type { BoardClientOptions, BoardHealth } from "../client/board-client";
import type { InstanceDefinition, InstanceRuntimeState } from "../shared/instances";

export interface InstanceSummary {
  name: string;
  status: InstanceRuntimeState["status"];
  port: number;
  boardUrl: string;
  workspace: string;
  dbPath: string;
  boardTokenPresent: boolean;
}

export interface CurrentSelection {
  selected: boolean;
  source: string;
  instanceName?: string;
  boardUrl?: string;
  workspace?: string;
  dbPath?: string;
  boardTokenPresent: boolean;
}

export interface SelectedInstanceTarget {
  definition: InstanceDefinition;
  runtime: InstanceRuntimeState;
  options: BoardClientOptions;
}

type EnvLike = BoardClientOptions["env"] & {
  OPENBOARD_INSTANCE_NAME?: string;
  OPENBOARD_INSTANCE_WORKSPACE?: string;
  OPENBOARD_INSTANCE_DB_PATH?: string;
  OPENBOARD_SELECTION_SOURCE?: string;
};

export function boardUrlForPort(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function summarizeInstance(definition: InstanceDefinition, runtime: InstanceRuntimeState): InstanceSummary {
  return {
    name: definition.name,
    status: runtime.status,
    port: definition.port,
    boardUrl: runtime.boardUrl || boardUrlForPort(definition.port),
    workspace: definition.workspace,
    dbPath: definition.dbPath,
    boardTokenPresent: Boolean(definition.boardToken?.trim()),
  };
}

export async function listInstances(homeDir = homedir()): Promise<InstanceSummary[]> {
  const provider = createDefaultProvider(homeDir);
  const entries = await provider.list();
  return entries.map(({ definition, runtime }) => summarizeInstance(definition, runtime));
}

export async function resolveInstanceTarget(name: string, options: BoardClientOptions = {}): Promise<SelectedInstanceTarget> {
  const provider = createDefaultProvider();
  const definition = await provider.get(name);
  const runtime = await provider.getRuntime(name);
  if (runtime.status !== "running") {
    throw new Error(`Instance "${name}" is ${runtime.status}. Start it first with: openboard start ${name}`);
  }
  if (!definition.boardToken?.trim()) {
    throw new Error(`Instance "${name}" is missing a board token; restart or recreate it.`);
  }
  return {
    definition,
    runtime,
    options: {
      ...options,
      boardUrl: runtime.boardUrl,
      env: {
        ...(options.env ?? {}),
        OPENCODE_BOARD_URL: runtime.boardUrl,
        OPENBOARD_API_TOKEN: definition.boardToken,
        OPENBOARD_INSTANCE_NAME: definition.name,
      },
    },
  };
}

export async function resolveSelectedOptions(options: BoardClientOptions = {}): Promise<BoardClientOptions> {
  if (!options.requireExplicitBoardUrl) return options;
  const env = selectionEnv(options);
  const explicitUrl = options.boardUrl ?? env.OPENCODE_BOARD_URL;
  if (explicitUrl?.trim()) return options;

  const instanceName = env.OPENBOARD_INSTANCE_NAME?.trim();
  if (instanceName) {
    return (await resolveInstanceTarget(instanceName, options)).options;
  }

  throw new Error(await noSelectionMessage());
}

export function currentSelectionFromOptions(options: BoardClientOptions = {}): CurrentSelection {
  const env = selectionEnv(options);
  const boardUrl = options.boardUrl ?? env.OPENCODE_BOARD_URL;
  const instanceName = env.OPENBOARD_INSTANCE_NAME?.trim() || undefined;
  const source = env.OPENBOARD_SELECTION_SOURCE?.trim()
    || (options.boardUrl ? "explicit boardUrl option" : env.OPENCODE_BOARD_URL ? "explicit OPENCODE_BOARD_URL" : instanceName ? "OPENBOARD_INSTANCE_NAME" : "none");

  return {
    selected: Boolean(boardUrl?.trim() || instanceName),
    source,
    ...(instanceName !== undefined ? { instanceName } : {}),
    ...(boardUrl?.trim() ? { boardUrl: boardUrl.trim() } : {}),
    ...(env.OPENBOARD_INSTANCE_WORKSPACE?.trim() ? { workspace: env.OPENBOARD_INSTANCE_WORKSPACE.trim() } : {}),
    ...(env.OPENBOARD_INSTANCE_DB_PATH?.trim() ? { dbPath: env.OPENBOARD_INSTANCE_DB_PATH.trim() } : {}),
    boardTokenPresent: Boolean(env.OPENBOARD_API_TOKEN?.trim()),
  };
}

export async function noSelectionMessage(): Promise<string> {
  const instances = await listInstances().catch(() => []);
  const lines = ["No OpenBoard instance selected."];
  if (instances.length > 0) {
    lines.push("Available instances:");
    for (const item of instances) {
      lines.push(`- ${item.name} (:${item.port}) ${item.workspace}`);
    }
  } else {
    lines.push("No registered instances found.");
  }
  lines.push(
    "",
    "Select one with:",
    '  select_instance({"name":"<name>"})',
    "",
    "Or start MCP pre-bound with:",
    "  openboard mcp --instance <name>",
    "",
    "Advanced callers may set:",
    "  OPENCODE_BOARD_URL=http://127.0.0.1:<port>",
  );
  return lines.join("\n");
}

export function mergeHealthIdentity(selection: CurrentSelection, health: BoardHealth | undefined): CurrentSelection {
  if (!health?.identity) return selection;
  return {
    ...selection,
    selected: true,
    instanceName: health.identity.instanceName ?? selection.instanceName,
    boardUrl: health.identity.boardUrl,
    workspace: health.identity.workspace,
    dbPath: health.identity.dbPath,
    boardTokenPresent: selection.boardTokenPresent || health.identity.boardTokenPresent,
  };
}

function selectionEnv(options: BoardClientOptions): EnvLike {
  const env = options.env as EnvLike | undefined;
  if (env !== undefined) {
    return {
      OPENCODE_BOARD_URL: env.OPENCODE_BOARD_URL,
      OPENBOARD_API_TOKEN: env.OPENBOARD_API_TOKEN,
      OPENBOARD_INSTANCE_NAME: env.OPENBOARD_INSTANCE_NAME,
      OPENBOARD_INSTANCE_WORKSPACE: env.OPENBOARD_INSTANCE_WORKSPACE,
      OPENBOARD_INSTANCE_DB_PATH: env.OPENBOARD_INSTANCE_DB_PATH,
      OPENBOARD_SELECTION_SOURCE: env.OPENBOARD_SELECTION_SOURCE,
    };
  }
  return {
    OPENCODE_BOARD_URL: process.env.OPENCODE_BOARD_URL,
    OPENBOARD_API_TOKEN: process.env.OPENBOARD_API_TOKEN,
    OPENBOARD_INSTANCE_NAME: process.env.OPENBOARD_INSTANCE_NAME,
    OPENBOARD_INSTANCE_WORKSPACE: process.env.OPENBOARD_INSTANCE_WORKSPACE,
    OPENBOARD_INSTANCE_DB_PATH: process.env.OPENBOARD_INSTANCE_DB_PATH,
    OPENBOARD_SELECTION_SOURCE: process.env.OPENBOARD_SELECTION_SOURCE,
  };
}
