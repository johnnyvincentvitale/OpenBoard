import { describe, it, expect } from "vitest";
import {
  createInstanceRegistry,
  createInstanceDaemon,
  InstanceError,
  InstanceNameCollisionError,
  InstanceUnknownError,
  InstancePortConflictError,
  InstanceSpawnError,
  INSTANCE_STATUSES,
  CLI_COMMANDS,
  validateInstanceName,
  validatePort,
  validateInstancesFile,
  instancesFilePath,
  instanceDataDir,
  resolveDefaultInstance,
  type InstanceRegistry,
} from "../../src/instances/index";

describe("index re-exports", () => {
  // ── Factories ────────────────────────────────────────────────────────────

  it("exports createInstanceRegistry as a function", () => {
    expect(typeof createInstanceRegistry).toBe("function");
  });

  it("exports createInstanceDaemon as a function", () => {
    expect(typeof createInstanceDaemon).toBe("function");
  });

  // ── Error classes ────────────────────────────────────────────────────────

  it("exports InstanceError", () => {
    const e = new InstanceError("test");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("InstanceError");
  });

  it("exports InstanceNameCollisionError", () => {
    const e = new InstanceNameCollisionError("dupe");
    expect(e).toBeInstanceOf(InstanceError);
    expect(e.instanceName).toBe("dupe");
  });

  it("exports InstanceUnknownError", () => {
    const e = new InstanceUnknownError("ghost");
    expect(e).toBeInstanceOf(InstanceError);
    expect(e.instanceName).toBe("ghost");
  });

  it("exports InstancePortConflictError", () => {
    const e = new InstancePortConflictError(4097, "other");
    expect(e).toBeInstanceOf(InstanceError);
    expect(e.port).toBe(4097);
  });

  it("exports InstanceSpawnError", () => {
    const e = new InstanceSpawnError("bad");
    expect(e).toBeInstanceOf(InstanceError);
    expect(e.instanceName).toBe("bad");
  });

  // ── Constants ────────────────────────────────────────────────────────────

  it("exports INSTANCE_STATUSES", () => {
    expect(INSTANCE_STATUSES).toEqual([
      "running",
      "stopped",
      "stale-pid",
      "unhealthy",
    ]);
  });

  it("exports CLI_COMMANDS", () => {
    expect(CLI_COMMANDS).toContain("list");
    expect(CLI_COMMANDS).toContain("start");
    expect(CLI_COMMANDS).toContain("stop");
  });

  // ── Pure helpers ─────────────────────────────────────────────────────────

  it("exports validateInstanceName", () => {
    expect(validateInstanceName("hello")).toEqual({ ok: true, value: "hello" });
    expect(validateInstanceName("BAD").ok).toBe(false);
  });

  it("exports validatePort", () => {
    expect(validatePort(4097)).toEqual({ ok: true, value: 4097 });
    expect(validatePort(0).ok).toBe(false);
  });

  it("exports validateInstancesFile", () => {
    const result = validateInstancesFile(null);
    expect(result.ok).toBe(false);
  });

  it("exports resolveDefaultInstance", () => {
    const file = {
      version: 1 as const,
      instances: [{ name: "only", port: 4097, workspace: "/w", dbPath: "b.sqlite" }],
    };
    const result = resolveDefaultInstance(file);
    expect(result).toBeDefined();
    expect(result!.name).toBe("only");
  });

  it("exports instancesFilePath", () => {
    expect(instancesFilePath("/home/alice")).toBe(
      "/home/alice/.config/openboard/instances.json",
    );
  });

  it("exports instanceDataDir", () => {
    const dirs = instanceDataDir("/home/alice", "my-project");
    expect(dirs.dataDir).toContain("my-project");
    expect(dirs.pidFile).toContain("openboard.pid");
    expect(dirs.logFile).toContain("openboard.log");
  });

  // ── Type exports (compile-time only, verified by typecheck) ──────────────
  it("type exports compile (verified by typecheck pass)", () => {
    // This is a runtime smoke test that the types are importable.
    // The actual type-level check is done by tsc --noEmit.
    const _registry: InstanceRegistry = createInstanceRegistry("/tmp");
    expect(_registry).toBeDefined();
  });
});
