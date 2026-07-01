/**
 * Framework-free task store. Owns the canonical in-memory board state
 * (tasks + agent roster + connection status), folds SSE frames into it, and
 * exposes a subscribe/getSnapshot pair suitable for useSyncExternalStore.
 * Also exports a React hook (useTaskStore) backed by a module-singleton
 * store instance.
 */
import { useCallback, useSyncExternalStore } from "react";
import type { Column, RosterAgent, Task, TaskFrame } from "../shared";
import { COLUMNS } from "../shared";
import * as taskClient from "./api/taskClient";
import { connectTaskSse } from "./api/taskSse";
import type { CreateTaskFields, TaskBoardStatus, UseTaskStoreResult } from "./task-types";

/** Minimal surface of taskClient the store depends on (for test injection). */
export interface TaskClientLike {
  getTasks: typeof taskClient.getTasks;
  createTask: typeof taskClient.createTask;
  runTask: typeof taskClient.runTask;
  retryTask: typeof taskClient.retryTask;
  abortTask: typeof taskClient.abortTask;
  moveTask: typeof taskClient.moveTask;
  removeTask: typeof taskClient.removeTask;
  getAgents: typeof taskClient.getAgents;
  getHealth: typeof taskClient.getHealth;
}

/** Minimal surface of connectTaskSse the store depends on (for test injection). */
export type ConnectFn = typeof connectTaskSse;

export interface TaskStoreDeps {
  client?: TaskClientLike;
  connect?: ConnectFn;
  /** Health poll interval in ms. Defaults to 15000. Exposed for tests. */
  healthPollMs?: number;
}

export interface TaskStoreSnapshot {
  tasks: Task[];
  agents: RosterAgent[];
  status: TaskBoardStatus;
}

export interface TaskStore {
  subscribe(cb: () => void): () => void;
  getSnapshot(): TaskStoreSnapshot;
  init(): void;
  create(fields: CreateTaskFields): Promise<void>;
  run(taskId: string): Promise<void>;
  retry(taskId: string): Promise<void>;
  abort(taskId: string): Promise<void>;
  remove(taskId: string): Promise<void>;
  move(taskId: string, column: Column, position: number): void;
  dispose(): void;
}

const COLUMN_ORDER: Record<Column, number> = Object.fromEntries(
  COLUMNS.map((col, idx) => [col, idx]),
) as Record<Column, number>;

function sortTasks(tasks: Iterable<Task>): Task[] {
  return [...tasks].sort((a, b) => {
    const colDiff = COLUMN_ORDER[a.column] - COLUMN_ORDER[b.column];
    if (colDiff !== 0) return colDiff;
    return a.position - b.position;
  });
}

export function createTaskStore(deps: TaskStoreDeps = {}): TaskStore {
  const client: TaskClientLike = deps.client ?? taskClient;
  const connect: ConnectFn = deps.connect ?? connectTaskSse;
  const healthPollMs = deps.healthPollMs ?? 15000;

  const tasksById = new Map<string, Task>();
  let agents: RosterAgent[] = [];
  let status: TaskBoardStatus = { opencode: "unknown", sse: "connecting" };
  let snapshot: TaskStoreSnapshot = { tasks: [], agents, status };
  const listeners = new Set<() => void>();

  let disconnectSse: (() => void) | undefined;
  let healthTimer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;

  function emit(): void {
    snapshot = { tasks: sortTasks(tasksById.values()), agents, status };
    for (const listener of listeners) listener();
  }

  function setStatus(patch: Partial<TaskBoardStatus>): void {
    status = { ...status, ...patch };
    emit();
  }

  function replaceTasks(tasks: Iterable<Task>): void {
    tasksById.clear();
    for (const task of tasks) tasksById.set(task.id, task);
    emit();
  }

  function applyFrame(frame: TaskFrame): void {
    switch (frame.kind) {
      case "snapshot": {
        replaceTasks(frame.tasks);
        break;
      }
      case "upsert": {
        tasksById.set(frame.task.id, frame.task);
        emit();
        break;
      }
      case "remove": {
        tasksById.delete(frame.taskId);
        emit();
        break;
      }
      case "heartbeat": {
        // No state change.
        break;
      }
    }
  }

  async function pollHealth(): Promise<void> {
    try {
      const health = await client.getHealth();
      setStatus({ opencode: health.opencode });
    } catch {
      setStatus({ opencode: "unreachable" });
    }
  }

  function init(): void {
    void client
      .getTasks()
      .then((tasks) => replaceTasks(tasks))
      .catch(() => {
        // Leave existing state; SSE/health will surface reachability issues.
      });

    void client
      .getAgents()
      .then((roster) => {
        agents = roster;
        emit();
      })
      .catch(() => {
        // Leave existing roster; not critical to board function.
      });

    void pollHealth();
    healthTimer = setInterval(() => void pollHealth(), healthPollMs);

    disconnectSse = connect({
      onFrame: applyFrame,
      onStatus: (sse) => setStatus({ sse }),
    });
  }

  async function create(fields: CreateTaskFields): Promise<void> {
    const task = await client.createTask(fields);
    tasksById.set(task.id, task);
    emit();
  }

  async function run(taskId: string): Promise<void> {
    const task = await client.runTask(taskId);
    tasksById.set(task.id, task);
    emit();
  }

  async function retry(taskId: string): Promise<void> {
    const task = await client.retryTask(taskId);
    tasksById.set(task.id, task);
    emit();
  }

  async function abort(taskId: string): Promise<void> {
    const task = await client.abortTask(taskId);
    tasksById.set(task.id, task);
    emit();
  }

  async function remove(taskId: string): Promise<void> {
    await client.removeTask(taskId);
    tasksById.delete(taskId);
    emit();
  }

  function move(taskId: string, column: Column, position: number): void {
    const existing = tasksById.get(taskId);
    if (existing) {
      tasksById.set(taskId, { ...existing, column, position });
      emit();
    }

    void client
      .moveTask(taskId, column, position)
      .then((tasks) => replaceTasks(tasks))
      .catch(() => {
        // Reconciliation failed; leave optimistic state. A future snapshot/
        // upsert frame or board reload will correct any drift.
      });
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    disconnectSse?.();
    if (healthTimer) clearInterval(healthTimer);
    listeners.clear();
  }

  return {
    subscribe(cb: () => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getSnapshot() {
      return snapshot;
    },
    init,
    create,
    run,
    retry,
    abort,
    remove,
    move,
    dispose,
  };
}

// --- React hook, backed by a module-singleton store ---------------------

let singleton: TaskStore | undefined;

function getSingleton(): TaskStore {
  if (!singleton) {
    singleton = createTaskStore();
    singleton.init();
  }
  return singleton;
}

export function useTaskStore(): UseTaskStoreResult {
  const store = getSingleton();
  const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [store]);
  const getSnapshot = useCallback(() => store.getSnapshot(), [store]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);

  return {
    tasks: snapshot.tasks,
    agents: snapshot.agents,
    status: snapshot.status,
    create: store.create,
    run: store.run,
    retry: store.retry,
    abort: store.abort,
    remove: store.remove,
    move: store.move,
  };
}
