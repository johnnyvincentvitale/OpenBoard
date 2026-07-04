import { randomBytes, randomUUID } from "node:crypto";
import { existsSync as nodeExistsSync, statSync as nodeStatSync } from "node:fs";
import { homedir } from "node:os";
import type { Task, TaskStore } from "../../shared";
import {
  isExternalDirectoriesAllowed,
  resolveTaskDirectory,
  type ResolveTaskDirectoryOptions,
} from "../workspace";

export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export interface PtyExitEvent {
  exitCode: number;
  signal?: number;
}

export interface PtyDisposable {
  dispose(): void;
}

export interface PtyProcess {
  onData(listener: (data: string) => void): PtyDisposable;
  onExit(listener: (event: PtyExitEvent) => void): PtyDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtyModule {
  spawn(file: string, args: string[], options: PtySpawnOptions): PtyProcess;
}

export interface CreateTerminalOptions {
  taskId?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
}

export interface ReserveTerminalOptions extends CreateTerminalOptions {}

export interface TerminalReservation {
  id: string;
  token: string;
  cwd: string;
  cols: number;
  rows: number;
  taskId?: string;
  expiresAt: number;
}

export interface TerminalReservationClaim {
  reservation: TerminalReservation;
  consume(): void;
  release(): void;
}

export interface TerminalHandle {
  id: string;
  cwd: string;
  onData(listener: (data: string) => void): () => void;
  onExit(listener: (code: number | null) => void): () => void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export class TerminalManagerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TerminalManagerError";
  }
}

interface ReservationRecord extends TerminalReservation {
  claimed: boolean;
  timer: ReturnType<typeof setTimeout>;
}

interface PtyManagerDeps {
  taskStore?: Pick<TaskStore, "get">;
  loadPtyModule?: () => Promise<PtyModule>;
  processEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  existsSync?: (path: string) => boolean;
  maxTerminals?: number;
  reservationTtlMs?: number;
  now?: () => number;
  /** Opt-in to terminals outside the workspace. */
  allowExternalDirectories?: boolean;
  /** Override directory canonicalization (tests). */
  resolveTaskDirectory?: (raw: string, workspace: string, opts: ResolveTaskDirectoryOptions) => string;
}

interface ResolveCwdDeps {
  workspace?: string;
  boardWorkspace?: string;
  allowExternalDirectories?: boolean;
  existsSync?: (path: string) => boolean;
  /** Override for tests; receives the validated cwd and should return a canonical path. */
  resolveTaskDirectory?: (raw: string, workspace: string, opts: ResolveTaskDirectoryOptions) => string;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_MAX_TERMINALS = 15;
const DEFAULT_RESERVATION_TTL_MS = 30_000;

export function resolveBoardWorkspace(
  env: NodeJS.ProcessEnv = process.env,
  existsSync: (path: string) => boolean = nodeExistsSync,
  statSync: (path: string) => { isDirectory(): boolean } = nodeStatSync,
): string {
  const configured = env.BOARD_WORKSPACE?.trim();
  if (configured) {
    if (!existsSync(configured)) {
      throw new TerminalManagerError(400, `BOARD_WORKSPACE does not exist: ${configured}`);
    }
    if (!statSync(configured).isDirectory()) {
      throw new TerminalManagerError(400, `BOARD_WORKSPACE is not a directory: ${configured}`);
    }
    return configured;
  }

  if (env.BOARD_WORKSPACE !== undefined) {
    throw new TerminalManagerError(400, "BOARD_WORKSPACE must not be empty");
  }

  const fallback = homedir();
  if (existsSync(fallback)) return fallback;

  throw new TerminalManagerError(409, "BOARD_WORKSPACE does not exist");
}

export function resolveShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const shell = env.SHELL?.trim();
  if (shell) return shell;
  if (platform === "darwin") return "/bin/zsh";
  if (platform === "win32") return "powershell.exe";
  return "/bin/bash";
}

export function buildPtyEnv(processEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(processEnv)) {
    if (typeof value === "string") env[key] = value;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  return env;
}

export function resolveCwd(
  task: Pick<Task, "directory" | "worktreePath"> | undefined,
  opts: CreateTerminalOptions,
  deps: ResolveCwdDeps = {},
): string {
  const existsSync = deps.existsSync ?? nodeExistsSync;
  let cwd: string;

  if (task) {
    cwd = task.worktreePath ?? task.directory;
    if (typeof cwd !== "string" || cwd.trim().length === 0) {
      throw new TerminalManagerError(409, "Task has no working directory");
    }
    if (!existsSync(cwd)) {
      throw new TerminalManagerError(409, `Task working directory does not exist: ${cwd}`);
    }
  } else {
    const requestedCwd = typeof opts.cwd === "string" ? opts.cwd.trim() : "";
    if (requestedCwd) {
      if (!existsSync(requestedCwd)) {
        throw new TerminalManagerError(400, `cwd does not exist: ${requestedCwd}`);
      }
      cwd = requestedCwd;
    } else {
      const workspace = deps.workspace ?? deps.boardWorkspace;
      if (!workspace) {
        throw new TerminalManagerError(409, "BOARD_WORKSPACE is not configured");
      }
      if (!existsSync(workspace)) {
        throw new TerminalManagerError(409, `BOARD_WORKSPACE does not exist: ${workspace}`);
      }
      cwd = workspace;
    }
  }

  const workspace = deps.workspace ?? deps.boardWorkspace;
  if (workspace) {
    const allowExternal = deps.allowExternalDirectories ?? false;
    const canonicalize = deps.resolveTaskDirectory ?? resolveTaskDirectory;
    return canonicalize(cwd, workspace, { allowExternal });
  }
  return cwd;
}

async function loadNodePtyModule(): Promise<PtyModule> {
  const moduleName = "node-pty";
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  return require(moduleName) as PtyModule;
}

function normalizeDimension(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function createToken(): string {
  return randomBytes(24).toString("hex");
}

export class PtyManager {
  private readonly taskStore?: Pick<TaskStore, "get">;
  private readonly loadPtyModule: () => Promise<PtyModule>;
  private readonly processEnv: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly existsSync: (path: string) => boolean;
  private readonly maxTerminals: number;
  private readonly reservationTtlMs: number;
  private readonly now: () => number;
  private readonly boardWorkspace: string;
  private readonly allowExternalDirectories: boolean;
  private readonly resolveTaskDirectoryOverride?: (raw: string, workspace: string, opts: ResolveTaskDirectoryOptions) => string;
  private readonly handles = new Map<string, TerminalHandle>();
  private readonly reservations = new Map<string, ReservationRecord>();

  constructor(deps: PtyManagerDeps = {}) {
    this.taskStore = deps.taskStore;
    this.loadPtyModule = deps.loadPtyModule ?? loadNodePtyModule;
    this.processEnv = deps.processEnv ?? process.env;
    this.platform = deps.platform ?? process.platform;
    this.existsSync = deps.existsSync ?? nodeExistsSync;
    this.maxTerminals = deps.maxTerminals ?? DEFAULT_MAX_TERMINALS;
    this.reservationTtlMs = deps.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS;
    this.now = deps.now ?? Date.now;
    this.boardWorkspace = resolveBoardWorkspace(this.processEnv, this.existsSync);
    this.allowExternalDirectories = deps.allowExternalDirectories ?? isExternalDirectoriesAllowed(this.processEnv);
    this.resolveTaskDirectoryOverride = deps.resolveTaskDirectory;
  }

  async reserve(opts: ReserveTerminalOptions): Promise<TerminalReservation> {
    this.assertCapacity();
    const task = this.getTask(opts.taskId);
    const cwd = resolveCwd(task, opts, {
      workspace: this.boardWorkspace,
      allowExternalDirectories: this.allowExternalDirectories,
      existsSync: this.existsSync,
      resolveTaskDirectory: this.resolveTaskDirectoryOverride,
    });
    const reservation: TerminalReservation = {
      id: randomUUID(),
      token: createToken(),
      cwd,
      cols: normalizeDimension(opts.cols, DEFAULT_COLS),
      rows: normalizeDimension(opts.rows, DEFAULT_ROWS),
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
      expiresAt: this.now() + this.reservationTtlMs,
    };

    const timer = setTimeout(() => {
      this.reservations.delete(reservation.id);
    }, this.reservationTtlMs);
    timer.unref?.();

    this.reservations.set(reservation.id, { ...reservation, claimed: false, timer });
    return reservation;
  }

  getReservation(id: string): TerminalReservation | undefined {
    const reservation = this.reservations.get(id);
    if (!reservation) return undefined;
    if (reservation.expiresAt <= this.now()) {
      clearTimeout(reservation.timer);
      this.reservations.delete(id);
      return undefined;
    }
    const { timer: _timer, claimed: _claimed, ...rest } = reservation;
    return rest;
  }

  beginAttach(id: string, token: string): TerminalReservationClaim {
    const reservation = this.reservations.get(id);
    if (!reservation) {
      throw new TerminalManagerError(404, `Terminal reservation not found: ${id}`);
    }
    if (reservation.expiresAt <= this.now()) {
      clearTimeout(reservation.timer);
      this.reservations.delete(id);
      throw new TerminalManagerError(410, `Terminal reservation expired: ${id}`);
    }
    if (reservation.claimed) {
      throw new TerminalManagerError(409, `Terminal reservation already in use: ${id}`);
    }
    reservation.claimed = true;

    let settled = false;
    return {
      reservation: {
        id: reservation.id,
        token: reservation.token,
        cwd: reservation.cwd,
        cols: reservation.cols,
        rows: reservation.rows,
        ...(reservation.taskId ? { taskId: reservation.taskId } : {}),
        expiresAt: reservation.expiresAt,
      },
      consume: () => {
        if (settled) return;
        settled = true;
        clearTimeout(reservation.timer);
        this.reservations.delete(id);
      },
      release: () => {
        if (settled) return;
        settled = true;
        const current = this.reservations.get(id);
        if (current) current.claimed = false;
      },
    };
  }

  async create(opts: CreateTerminalOptions): Promise<TerminalHandle> {
    this.assertCapacity();
    const task = this.getTask(opts.taskId);
    const cwd = resolveCwd(task, opts, {
      workspace: this.boardWorkspace,
      allowExternalDirectories: this.allowExternalDirectories,
      existsSync: this.existsSync,
      resolveTaskDirectory: this.resolveTaskDirectoryOverride,
    });

    const ptyModule = await this.loadPtyModule();
    const pty = ptyModule.spawn(resolveShell(this.platform, this.processEnv), [], {
      name: "xterm-256color",
      cols: normalizeDimension(opts.cols, DEFAULT_COLS),
      rows: normalizeDimension(opts.rows, DEFAULT_ROWS),
      cwd,
      env: buildPtyEnv(this.processEnv),
    });

    const id = randomUUID();
    const dataListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<(code: number | null) => void>();
    let closed = false;

    const finalize = (code: number | null) => {
      if (closed) return;
      closed = true;
      this.handles.delete(id);
      for (const listener of exitListeners) listener(code);
    };

    pty.onData((data) => {
      for (const listener of dataListeners) listener(data);
    });
    pty.onExit((event) => {
      finalize(typeof event.exitCode === "number" ? event.exitCode : null);
    });

    const handle: TerminalHandle = {
      id,
      cwd,
      onData(listener) {
        dataListeners.add(listener);
        return () => dataListeners.delete(listener);
      },
      onExit(listener) {
        exitListeners.add(listener);
        return () => exitListeners.delete(listener);
      },
      write(data) {
        if (!closed) pty.write(data);
      },
      resize(cols, rows) {
        if (closed) return;
        pty.resize(normalizeDimension(cols, DEFAULT_COLS), normalizeDimension(rows, DEFAULT_ROWS));
      },
      kill(signal) {
        if (closed) return;
        pty.kill(signal);
      },
    };

    this.handles.set(id, handle);
    return handle;
  }

  get(id: string): TerminalHandle | undefined {
    return this.handles.get(id);
  }

  killAll(): void {
    for (const handle of [...this.handles.values()]) {
      handle.kill();
    }
    this.handles.clear();
  }

  cleanupReservations(): void {
    for (const reservation of this.reservations.values()) {
      clearTimeout(reservation.timer);
    }
    this.reservations.clear();
  }

  private getTask(taskId: string | undefined): Pick<Task, "directory" | "worktreePath"> | undefined {
    if (!taskId) return undefined;
    if (!this.taskStore) {
      throw new TerminalManagerError(500, "Task store is not configured for terminal tasks");
    }
    const task = this.taskStore.get(taskId);
    if (!task) {
      throw new TerminalManagerError(404, `Task not found: ${taskId}`);
    }
    return task;
  }

  private assertCapacity(): void {
    const pendingReservations = [...this.reservations.values()].filter((reservation) => !reservation.claimed)
      .length;
    if (this.handles.size + pendingReservations >= this.maxTerminals) {
      throw new TerminalManagerError(429, `Terminal limit reached (${this.maxTerminals})`);
    }
  }
}
