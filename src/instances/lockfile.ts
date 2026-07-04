import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export const LOCKFILE_STALE_MS = 30_000;

export class LockfileBusyError extends Error {
  constructor(readonly lockPath: string) {
    super(`Lock file is held by another live process: ${lockPath}`);
    this.name = "LockfileBusyError";
  }
}

export interface LockfileHandle {
  fd: number;
  path: string;
}

interface LockfileContents {
  pid?: number;
  createdAt?: number;
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as NodeJS.ErrnoException).code === code;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockfile(lockPath: string): LockfileContents {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf-8")) as Partial<LockfileContents>;
    const pid = typeof parsed.pid === "number" && Number.isFinite(parsed.pid) && parsed.pid > 0 ? parsed.pid : undefined;
    const createdAt = typeof parsed.createdAt === "number" && Number.isFinite(parsed.createdAt) ? parsed.createdAt : undefined;
    return { pid, createdAt };
  } catch {
    try {
      return { createdAt: statSync(lockPath).mtimeMs };
    } catch {
      return {};
    }
  }
}

function lockIsStale(lockPath: string, staleMs: number, now: number): boolean {
  const lock = readLockfile(lockPath);
  if (lock.pid !== undefined && !isProcessAlive(lock.pid)) {
    return true;
  }
  if (lock.createdAt !== undefined && now - lock.createdAt > staleMs) {
    return true;
  }
  return false;
}

function writeOwner(fd: number): void {
  writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }) + "\n", "utf-8");
}

function tryAcquire(lockPath: string): LockfileHandle {
  const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
  writeOwner(fd);
  return { fd, path: lockPath };
}

export function acquireLockfile(lockPath: string, options: { staleMs?: number } = {}): LockfileHandle {
  mkdirSync(dirname(lockPath), { recursive: true });
  const staleMs = options.staleMs ?? LOCKFILE_STALE_MS;
  try {
    return tryAcquire(lockPath);
  } catch (err) {
    if (!isErrno(err, "EEXIST")) throw err;
    if (!lockIsStale(lockPath, staleMs, Date.now())) {
      throw new LockfileBusyError(lockPath);
    }
    try {
      unlinkSync(lockPath);
    } catch (unlinkErr) {
      if (!isErrno(unlinkErr, "ENOENT")) throw unlinkErr;
    }
    try {
      return tryAcquire(lockPath);
    } catch (retryErr) {
      if (isErrno(retryErr, "EEXIST")) {
        throw new LockfileBusyError(lockPath);
      }
      throw retryErr;
    }
  }
}

export function releaseLockfile(lock: LockfileHandle): void {
  try {
    closeSync(lock.fd);
  } catch {
    /* ignore */
  }
  try {
    unlinkSync(lock.path);
  } catch {
    /* ignore */
  }
}

export function removeLockfileIfOwnerDead(lockPath: string): void {
  const lock = readLockfile(lockPath);
  if (lock.pid === undefined || isProcessAlive(lock.pid)) {
    return;
  }
  try {
    unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}
