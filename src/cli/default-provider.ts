import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  createInstanceDaemon,
  createInstanceLifecycleCore,
  createInstanceRegistry,
  instanceDataDir,
  InstanceError,
  resolveDefaultInstance,
} from "../instances";
import type { BoardHealth } from "../shared/health";
import { buildTaskPath, type AcpConfigCatalog, type RosterAgent, type Task, type TaskCausalityMap } from "../shared/task";
import type { RosterProvider } from "../shared/providers";
import type {
  InstanceDefinition,
  InstanceRuntimeState,
} from "../shared/instances";
import { resolveBoardToken } from "../server/auth";
import type { InstanceLifecycleProvider } from "./provider";

function tailLines(content: string, lines = 80): { content: string; truncated: boolean } {
  const all = content.split(/\r?\n/);
  const keep = Math.max(0, Math.floor(lines));
  if (keep === 0 || all.length <= keep) return { content, truncated: false };
  return { content: all.slice(-keep).join("\n"), truncated: true };
}

function scrubSecrets(content: string): string {
  return content.replace(/(Bearer\s+)[A-Za-z0-9._~+\-/]+=*/gi, "$1[redacted]")
    .replace(/(OPENBOARD_API_TOKEN=)[^\s]+/g, "$1[redacted]")
    .replace(/(boardToken["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, "$1[redacted]");
}

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
  const daemon = createInstanceDaemon(homeDir);
  const createBoardToken = (): string =>
    resolveBoardToken({ OPENBOARD_API_TOKEN: process.env.OPENBOARD_API_TOKEN } as NodeJS.ProcessEnv);
  const lifecycle = createInstanceLifecycleCore({ homeDir, registry, daemon, createBoardToken });
  const getDefinition = lifecycle.get;

  const requireRunning = async (name: string): Promise<{ definition: InstanceDefinition; runtime: InstanceRuntimeState }> => {
    const definition = getDefinition(name);
    const runtime = await daemon.status(definition);
    if (runtime.status !== "running") {
      throw new InstanceError(`Instance "${name}" is ${runtime.status}; start it first with: openboard start ${name}`);
    }
    if (!definition.boardToken?.trim()) {
      throw new InstanceError(`Instance "${name}" is missing a board token; restart or recreate the instance.`);
    }
    return { definition, runtime };
  };

  const fetchJson = async <T>(name: string, path: string): Promise<T> => {
    const { definition, runtime } = await requireRunning(name);
    const res = await fetch(`${runtime.boardUrl}${path}`, {
      headers: { Authorization: `Bearer ${definition.boardToken}` },
    });
    if (!res.ok) {
      throw new InstanceError(`GET ${path} failed for "${name}" with HTTP ${res.status}`);
    }
    return await res.json() as T;
  };

  return {
    async list() {
      return lifecycle.list();
    },

    async get(name) {
      return getDefinition(name);
    },

    async resolveDefault() {
      const file = registry.getFile();
      return resolveDefaultInstance(file);
    },

    async getDefaultInfo() {
      const file = registry.getFile();
      if (file.defaultInstance) {
        return { kind: "explicit", definition: getDefinition(file.defaultInstance), instanceCount: file.instances.length };
      }
      if (file.instances.length === 1) {
        return { kind: "inferred", definition: file.instances[0], instanceCount: 1 };
      }
      return { kind: "unset", instanceCount: file.instances.length };
    },

    async setDefault(name) {
      registry.setDefault(name);
      return getDefinition(name);
    },

    async clearDefault() {
      registry.clearDefault();
      const file = registry.getFile();
      if (file.instances.length === 1) {
        return { kind: "inferred", definition: file.instances[0], instanceCount: 1 };
      }
      return { kind: "unset", instanceCount: file.instances.length };
    },

    async add(input) {
      return lifecycle.add(input);
    },

    async remove(name) {
      await lifecycle.remove(name);
    },

    async start(name) {
      return lifecycle.start(name);
    },

    async stop(name) {
      return lifecycle.stop(name);
    },

    async getRuntime(name) {
      return lifecycle.getRuntime(name);
    },

    async getHealth(name) {
      const definition = getDefinition(name);
      const runtime = await daemon.status(definition);
      if (runtime.status !== "running") return undefined;
      try {
        const res = await fetch(`${runtime.boardUrl}/api/health`);
        if (!res.ok) return undefined;
        return await res.json() as BoardHealth;
      } catch {
        return undefined;
      }
    },

    async readLog(name, tailLineCount = 80) {
      getDefinition(name);
      const dirs = instanceDataDir(homeDir, name);
      if (!existsSync(dirs.logFile)) {
        return { path: dirs.logFile, content: "", truncated: false, missing: true };
      }
      const tailed = tailLines(readFileSync(dirs.logFile, "utf-8"), tailLineCount);
      return { path: dirs.logFile, content: scrubSecrets(tailed.content), truncated: tailed.truncated, missing: false };
    },

    async listTasks(name) {
      return fetchJson<Task[]>(name, "/api/tasks");
    },

    async getTaskCausality(name) {
      return fetchJson<TaskCausalityMap>(name, buildTaskPath.taskCausality());
    },

    async listAgents(name) {
      return fetchJson<RosterAgent[]>(name, "/api/agents");
    },

    async listProviders(name) {
      return fetchJson<RosterProvider[]>(name, "/api/providers");
    },

    async getAcpConfig(name) {
      return fetchJson<AcpConfigCatalog>(name, "/api/acp-config");
    },

    async listWorktrees(name) {
      const tasks = await fetchJson<Task[]>(name, "/api/tasks?archived=all");
      return tasks
        .filter((task) => task.worktreePath || task.worktreeBranch || task.isolationAtDispatch === "worktree")
        .map((task) => {
          const exists = task.worktreePath ? existsSync(task.worktreePath) : false;
          let dirty: boolean | "unknown" = "unknown";
          if (exists && task.worktreePath) {
            try {
              const out = execFileSync("git", ["status", "--porcelain"], {
                cwd: task.worktreePath,
                encoding: "utf-8",
                stdio: ["ignore", "pipe", "ignore"],
              });
              dirty = out.trim().length > 0;
            } catch {
              dirty = "unknown";
            }
          } else if (!task.worktreePath) {
            dirty = false;
          }
          return {
            taskId: task.id,
            title: task.title,
            column: task.column,
            runState: task.runState,
            worktreePath: task.worktreePath,
            worktreeBranch: task.worktreeBranch,
            baseBranch: task.baseBranch,
            exists,
            dirty,
            orphanCandidate: Boolean(task.worktreePath && !exists),
          };
        });
    },

    async rename(oldName, newName) {
      return lifecycle.rename(oldName, newName);
    },
  };
}
