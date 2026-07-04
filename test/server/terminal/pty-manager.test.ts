import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PtyManager, TerminalManagerError, buildPtyEnv, resolveBoardWorkspace, resolveCwd, resolveShell } from "../../../src/server/terminal/pty-manager";

class FakePtyProcess {
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number }) => void>();

  onData(listener: (data: string) => void) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode: number }) => void) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  write(data: string) {
    this.writes.push(data);
  }

  resize(cols: number, rows: number) {
    this.resizes.push({ cols, rows });
  }

  kill() {
    this.emitExit(0);
  }

  emitData(data: string) {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(exitCode: number) {
    for (const listener of this.exitListeners) listener({ exitCode });
  }
}

describe("pty-manager helpers", () => {
  it("resolves the shell from env or platform defaults", () => {
    expect(resolveShell("darwin", { SHELL: "/custom/zsh" } as NodeJS.ProcessEnv)).toBe("/custom/zsh");
    expect(resolveShell("darwin", {} as NodeJS.ProcessEnv)).toBe("/bin/zsh");
    expect(resolveShell("linux", {} as NodeJS.ProcessEnv)).toBe("/bin/bash");
    expect(resolveShell("win32", {} as NodeJS.ProcessEnv)).toBe("powershell.exe");
  });

  it("builds a string-only pty env with terminal defaults", () => {
    expect(buildPtyEnv({ KEEP: "yes", DROP: undefined, COUNT: 1 as never })).toEqual({
      KEEP: "yes",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    });
  });

  it("uses a task worktree or directory and ignores conflicting client cwd", () => {
    const exists = vi.fn(() => true);
    const cwd = resolveCwd({ directory: "/repo", worktreePath: "/repo-wt" }, { cwd: "/ignored" }, { existsSync: exists });
    expect(cwd).toBe("/repo-wt");
    expect(exists).toHaveBeenCalledWith("/repo-wt");
  });

  it("rejects missing task directories instead of falling back to workspace", () => {
    expect(() =>
      resolveCwd({ directory: "/missing" }, {}, { existsSync: () => false, workspace: "/workspace" }),
    ).toThrowError(TerminalManagerError);
    expect(() =>
      resolveCwd({ directory: "/missing" }, {}, { existsSync: () => false, workspace: "/workspace" }),
    ).toThrow(/Task working directory does not exist/);
  });

  it("rejects invalid ad-hoc cwd and only falls back for workspace shells", () => {
    const fakeResolve = (_raw: string, _workspace: string) => _raw;
    expect(() =>
      resolveCwd(undefined, { cwd: "/missing" }, { existsSync: () => false, workspace: "/workspace", resolveTaskDirectory: fakeResolve }),
    ).toThrow(/cwd does not exist/);

    expect(
      resolveCwd(undefined, {}, { existsSync: (path) => path === "/workspace", workspace: "/workspace", resolveTaskDirectory: fakeResolve }),
    ).toBe("/workspace");
  });

  it("resolves BOARD_WORKSPACE when it exists and rejects missing/non-directory values", () => {
    const ws = mkdtempSync(join(tmpdir(), "ocb-pty-ws-"));
    try {
      expect(resolveBoardWorkspace({ BOARD_WORKSPACE: ws } as NodeJS.ProcessEnv)).toBe(ws);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }

    expect(() =>
      resolveBoardWorkspace({ BOARD_WORKSPACE: "/does/not/exist" } as NodeJS.ProcessEnv),
    ).toThrow(/BOARD_WORKSPACE does not exist/);
    expect(() => resolveBoardWorkspace({ BOARD_WORKSPACE: "" } as NodeJS.ProcessEnv)).toThrow(
      /BOARD_WORKSPACE must not be empty/,
    );
  });

  it("rejects an unset BOARD_WORKSPACE instead of falling back to the home directory", () => {
    expect(() => resolveBoardWorkspace({} as NodeJS.ProcessEnv)).toThrow(
      /BOARD_WORKSPACE must be set to an existing directory/,
    );
  });
});

describe("PtyManager", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      rmSync(dirs.pop() as string, { recursive: true, force: true });
    }
  });

  it("creates handles, forwards data, and drops them on exit", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ocb-pty-"));
    dirs.push(workspace);
    const process = new FakePtyProcess();
    const spawn = vi.fn(() => process);
    const manager = new PtyManager({
      processEnv: { BOARD_WORKSPACE: workspace } as NodeJS.ProcessEnv,
      loadPtyModule: async () => ({ spawn }),
    });

    const handle = await manager.create({ cwd: workspace, cols: 100, rows: 40 });
    expect(manager.get(handle.id)).toBe(handle);

    const onData = vi.fn();
    const onExit = vi.fn();
    handle.onData(onData);
    handle.onExit(onExit);

    process.emitData("hello");
    expect(onData).toHaveBeenCalledWith("hello");

    handle.write("pwd\n");
    handle.resize(120, 50);
    expect(process.writes).toEqual(["pwd\n"]);
    expect(process.resizes).toEqual([{ cols: 120, rows: 50 }]);

    process.emitExit(7);
    expect(onExit).toHaveBeenCalledWith(7);
    expect(manager.get(handle.id)).toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("enforces the max terminal cap across handles and reservations", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ocb-pty-cap-"));
    dirs.push(workspace);
    const process = new FakePtyProcess();
    const manager = new PtyManager({
      processEnv: { BOARD_WORKSPACE: workspace } as NodeJS.ProcessEnv,
      loadPtyModule: async () => ({ spawn: () => process }),
      maxTerminals: 1,
    });

    await manager.reserve({ cwd: workspace });
    await expect(manager.create({ cwd: workspace })).rejects.toMatchObject({ status: 429 });
  });

  it("expires unattached reservations", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ocb-pty-expire-"));
    dirs.push(workspace);
    const manager = new PtyManager({
      processEnv: { BOARD_WORKSPACE: workspace } as NodeJS.ProcessEnv,
      loadPtyModule: async () => ({ spawn: vi.fn() as never }),
      reservationTtlMs: 10,
    });

    const reservation = await manager.reserve({ cwd: workspace });
    expect(manager.getReservation(reservation.id)).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(manager.getReservation(reservation.id)).toBeUndefined();
  });

  it("releases a failed claim back to the pool", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "ocb-pty-claim-"));
    dirs.push(workspace);
    const manager = new PtyManager({
      processEnv: { BOARD_WORKSPACE: workspace } as NodeJS.ProcessEnv,
      loadPtyModule: async () => ({ spawn: vi.fn() as never }),
    });

    const reservation = await manager.reserve({ cwd: workspace });
    const claim = manager.beginAttach(reservation.id, reservation.token);
    claim.release();
    expect(() => manager.beginAttach(reservation.id, reservation.token)).not.toThrow();
  });

  it("rejects a terminal cwd outside the workspace", async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "ocb-pty-bnd-")));
    dirs.push(workspace);
    const outside = join(workspace, "..", "outside");
    mkdirSync(outside, { recursive: true });
    const manager = new PtyManager({
      processEnv: { BOARD_WORKSPACE: workspace } as NodeJS.ProcessEnv,
      loadPtyModule: async () => ({ spawn: vi.fn() as never }),
    });

    await expect(manager.reserve({ cwd: outside })).rejects.toMatchObject({
      status: 400,
    });
  });
});
