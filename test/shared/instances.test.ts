import { describe, it, expect } from "vitest";
import {
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
} from "../../src/shared/instances";

// ---------------------------------------------------------------------------
// Path builders
// ---------------------------------------------------------------------------

describe("instancesFilePath", () => {
  it("builds the canonical path from a home dir", () => {
    expect(instancesFilePath("/home/alice")).toBe(
      "/home/alice/.config/openboard/instances.json",
    );
  });

  it("works with macOS-style home dirs", () => {
    expect(instancesFilePath("/Users/bob")).toBe(
      "/Users/bob/.config/openboard/instances.json",
    );
  });

  it("is a pure function — same input, same output", () => {
    const a = instancesFilePath("/tmp/x");
    const b = instancesFilePath("/tmp/x");
    expect(a).toBe(b);
  });
});

describe("instanceDataDir", () => {
  it("builds the daemon data layout for a named instance", () => {
    const result = instanceDataDir("/home/alice", "my-project");
    expect(result).toEqual({
      dataDir: "/home/alice/.local/share/openboard/my-project",
      pidFile: "/home/alice/.local/share/openboard/my-project/openboard.pid",
      logFile: "/home/alice/.local/share/openboard/my-project/openboard.log",
    });
  });

  it("works with different names", () => {
    const result = instanceDataDir("/Users/bob", "side-experiment");
    expect(result.dataDir).toBe(
      "/Users/bob/.local/share/openboard/side-experiment",
    );
    expect(result.pidFile).toContain("openboard.pid");
    expect(result.logFile).toContain("openboard.log");
  });
});

// ---------------------------------------------------------------------------
// InstanceStatus
// ---------------------------------------------------------------------------

describe("INSTANCE_STATUSES", () => {
  it("contains the four canonical lifecycle statuses", () => {
    expect(INSTANCE_STATUSES).toEqual([
      "running",
      "stopped",
      "stale-pid",
      "unhealthy",
    ]);
  });
});

// ---------------------------------------------------------------------------
// CLI_COMMANDS
// ---------------------------------------------------------------------------

describe("CLI_COMMANDS", () => {
  it("contains the seven subcommands", () => {
    expect(CLI_COMMANDS).toEqual([
      "list",
      "add",
      "remove",
      "start",
      "stop",
      "attach",
      "rename",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

describe("InstanceError hierarchy", () => {
  it("InstanceError is the base class", () => {
    const e = new InstanceError("base");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(InstanceError);
    expect(e.name).toBe("InstanceError");
    expect(e.message).toBe("base");
  });

  it("InstanceNameCollisionError carries the colliding name", () => {
    const e = new InstanceNameCollisionError("dupe");
    expect(e).toBeInstanceOf(InstanceError);
    expect(e.name).toBe("InstanceNameCollisionError");
    expect(e.instanceName).toBe("dupe");
    expect(e.message).toContain("dupe");
  });

  it("InstanceUnknownError carries the unknown instance name", () => {
    const e = new InstanceUnknownError("ghost");
    expect(e).toBeInstanceOf(InstanceError);
    expect(e.instanceName).toBe("ghost");
    expect(e.message).toContain("ghost");
  });

  it("InstancePortConflictError carries the port and existing instance", () => {
    const e = new InstancePortConflictError(4097, "repo-a");
    expect(e).toBeInstanceOf(InstanceError);
    expect(e.port).toBe(4097);
    expect(e.existingInstance).toBe("repo-a");
    expect(e.message).toContain("4097");
    expect(e.message).toContain("repo-a");
  });

  it("InstanceSpawnError carries the instance name and cause", () => {
    const cause = new Error("ENOENT");
    const e = new InstanceSpawnError("bad-instance", cause);
    expect(e).toBeInstanceOf(InstanceError);
    expect(e.instanceName).toBe("bad-instance");
    expect(e.cause).toBe(cause);
    expect(e.message).toContain("bad-instance");
  });
});

// ---------------------------------------------------------------------------
// validateInstanceName
// ---------------------------------------------------------------------------

describe("validateInstanceName — success cases", () => {
  it("accepts single lowercase word", () => {
    expect(validateInstanceName("hello")).toEqual({ ok: true, value: "hello" });
  });

  it("accepts kebab-case with hyphens", () => {
    expect(validateInstanceName("my-project")).toEqual({
      ok: true,
      value: "my-project",
    });
  });

  it("accepts multi-segment kebab-case", () => {
    expect(validateInstanceName("a-b-c-d")).toEqual({
      ok: true,
      value: "a-b-c-d",
    });
  });

  it("accepts names with digits", () => {
    expect(validateInstanceName("repo2")).toEqual({
      ok: true,
      value: "repo2",
    });
    expect(validateInstanceName("v2-beta")).toEqual({
      ok: true,
      value: "v2-beta",
    });
  });

  it("accepts names at max length (40 chars)", () => {
    const name = "a" + "b".repeat(38) + "z"; // 40 chars, valid kebab-case
    const result = validateInstanceName(name);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.length).toBe(40);
  });

  it("trims surrounding whitespace", () => {
    expect(validateInstanceName("  my-project  ")).toEqual({
      ok: true,
      value: "my-project",
    });
  });

  it("accepts single character name", () => {
    expect(validateInstanceName("x")).toEqual({ ok: true, value: "x" });
  });
});

describe("validateInstanceName — rejection cases", () => {
  it("rejects non-string input", () => {
    expect(validateInstanceName(123)).toEqual({
      ok: false,
      error: "Instance name must be a string",
    });
    expect(validateInstanceName(null)).toEqual({
      ok: false,
      error: "Instance name must be a string",
    });
    expect(validateInstanceName(undefined)).toEqual({
      ok: false,
      error: "Instance name must be a string",
    });
    expect(validateInstanceName({})).toEqual({
      ok: false,
      error: "Instance name must be a string",
    });
  });

  it("rejects empty string", () => {
    expect(validateInstanceName("")).toEqual({
      ok: false,
      error: "Instance name must not be empty",
    });
  });

  it("rejects whitespace-only string", () => {
    expect(validateInstanceName("   ")).toEqual({
      ok: false,
      error: "Instance name must not be empty",
    });
  });

  it("rejects too-long name (41 chars)", () => {
    const name = "a" + "b".repeat(40); // 41 chars
    const result = validateInstanceName(name);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("at most 40");
    }
  });

  it("rejects uppercase letters", () => {
    expect(validateInstanceName("MyProject").ok).toBe(false);
    expect(validateInstanceName("MY-PROJECT").ok).toBe(false);
    expect(validateInstanceName("my-Project").ok).toBe(false);
  });

  it("rejects underscores", () => {
    expect(validateInstanceName("my_project").ok).toBe(false);
  });

  it("rejects leading hyphen", () => {
    expect(validateInstanceName("-my-project").ok).toBe(false);
  });

  it("rejects trailing hyphen", () => {
    expect(validateInstanceName("my-project-").ok).toBe(false);
  });

  it("rejects consecutive hyphens", () => {
    expect(validateInstanceName("my--project").ok).toBe(false);
  });

  it("rejects leading digit", () => {
    expect(validateInstanceName("2nd-project").ok).toBe(false);
  });

  it("rejects special characters", () => {
    expect(validateInstanceName("my@project").ok).toBe(false);
    expect(validateInstanceName("project!").ok).toBe(false);
    expect(validateInstanceName("hello world").ok).toBe(false);
    expect(validateInstanceName("project.name").ok).toBe(false);
  });

  it("rejects reserved CLI command names", () => {
    for (const cmd of CLI_COMMANDS) {
      const result = validateInstanceName(cmd);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("reserved");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// validatePort
// ---------------------------------------------------------------------------

describe("validatePort — success cases", () => {
  it("accepts port 1 (minimum)", () => {
    expect(validatePort(1)).toEqual({ ok: true, value: 1 });
  });

  it("accepts port 65535 (maximum)", () => {
    expect(validatePort(65535)).toEqual({ ok: true, value: 65535 });
  });

  it("accepts common ports", () => {
    expect(validatePort(4097).ok).toBe(true);
    expect(validatePort(4197).ok).toBe(true);
    expect(validatePort(8080).ok).toBe(true);
    expect(validatePort(3000).ok).toBe(true);
  });
});

describe("validatePort — rejection cases", () => {
  it("rejects port 0", () => {
    const result = validatePort(0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("between");
  });

  it("rejects negative port", () => {
    expect(validatePort(-1).ok).toBe(false);
    expect(validatePort(-100).ok).toBe(false);
  });

  it("rejects port above 65535", () => {
    expect(validatePort(65536).ok).toBe(false);
    expect(validatePort(99999).ok).toBe(false);
  });

  it("rejects non-integer numbers", () => {
    expect(validatePort(4097.5).ok).toBe(false);
    expect(validatePort(3.14).ok).toBe(false);
  });

  it("rejects NaN and Infinity", () => {
    expect(validatePort(NaN).ok).toBe(false);
    expect(validatePort(Infinity).ok).toBe(false);
    expect(validatePort(-Infinity).ok).toBe(false);
  });

  it("rejects non-number types", () => {
    expect(validatePort("4097").ok).toBe(false);
    expect(validatePort(null).ok).toBe(false);
    expect(validatePort(undefined).ok).toBe(false);
    expect(validatePort({}).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("shared constants", () => {
  it("PORT_MIN is 1", () => expect(PORT_MIN).toBe(1));
  it("PORT_MAX is 65535", () => expect(PORT_MAX).toBe(65535));
  it("INSTANCE_NAME_MIN_LENGTH is 1", () =>
    expect(INSTANCE_NAME_MIN_LENGTH).toBe(1));
  it("INSTANCE_NAME_MAX_LENGTH is 40", () =>
    expect(INSTANCE_NAME_MAX_LENGTH).toBe(40));
  it("RESERVED_INSTANCE_NAMES includes all CLI command names", () => {
    for (const cmd of CLI_COMMANDS) {
      expect(RESERVED_INSTANCE_NAMES.has(cmd)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// validateInstancesFile
// ---------------------------------------------------------------------------

/** Minimal valid instances file for reuse in tests. */
function validFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    defaultInstance: "my-project",
    instances: [
      {
        name: "my-project",
        port: 4097,
        workspace: "/home/alice/repos/my-project",
        dbPath: "board.sqlite",
      },
      {
        name: "side-experiment",
        port: 4197,
        workspace: "/home/alice/repos/side-experiment",
        dbPath: "board-exp.sqlite",
        opencodePort: 4196,
      },
    ],
    ...overrides,
  };
}

describe("validateInstancesFile — success cases", () => {
  it("validates a correct file", () => {
    const result = validateInstancesFile(validFile());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.version).toBe(1);
      expect(result.value.instances).toHaveLength(2);
    }
  });

  it("accepts file without defaultInstance", () => {
    const result = validateInstancesFile(validFile({ defaultInstance: undefined }));
    expect(result.ok).toBe(true);
  });

  it("accepts single-instance file", () => {
    const data = {
      version: 1,
      instances: [
        {
          name: "solo",
          port: 4097,
          workspace: "/tmp/solo",
          dbPath: "board.sqlite",
        },
      ],
    };
    const result = validateInstancesFile(data);
    expect(result.ok).toBe(true);
  });

  it("accepts instance without opencodePort", () => {
    const data = {
      version: 1,
      instances: [
        {
          name: "no-oc",
          port: 4097,
          workspace: "/tmp/no-oc",
          dbPath: "board.sqlite",
        },
      ],
    };
    const result = validateInstancesFile(data);
    expect(result.ok).toBe(true);
  });
});

describe("validateInstancesFile — rejection: type/shape", () => {
  it("rejects null", () => {
    const result = validateInstancesFile(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].message).toContain("JSON object");
    }
  });

  it("rejects arrays", () => {
    const result = validateInstancesFile([1, 2, 3]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].message).toContain("JSON object");
    }
  });

  it("rejects string", () => {
    const result = validateInstancesFile("hello");
    expect(result.ok).toBe(false);
  });

  it("rejects undefined", () => {
    const result = validateInstancesFile(undefined);
    expect(result.ok).toBe(false);
  });

  it("rejects non-object primitives", () => {
    expect(validateInstancesFile(42).ok).toBe(false);
    expect(validateInstancesFile(true).ok).toBe(false);
  });
});

describe("validateInstancesFile — rejection: version", () => {
  it("rejects version 0", () => {
    const result = validateInstancesFile(validFile({ version: 0 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].path).toBe("version");
      expect(result.errors[0].message).toContain("must be 1");
    }
  });

  it("rejects version 2", () => {
    const result = validateInstancesFile(validFile({ version: 2 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].path).toBe("version");
    }
  });

  it("rejects missing version", () => {
    const result = validateInstancesFile(validFile({ version: undefined }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].path).toBe("version");
    }
  });
});

describe("validateInstancesFile — rejection: instances array", () => {
  it("rejects missing instances", () => {
    const result = validateInstancesFile({ version: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].path).toBe("instances");
    }
  });

  it("rejects empty instances array", () => {
    const result = validateInstancesFile({ version: 1, instances: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].path).toBe("instances");
      expect(result.errors[0].message).toContain("at least one");
    }
  });

  it("rejects non-array instances", () => {
    const result = validateInstancesFile({ version: 1, instances: "nope" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].path).toBe("instances");
    }
  });

  it("rejects non-object entries in instances array", () => {
    const data = validFile();
    (data.instances as unknown[]).push("not-an-object");
    const result = validateInstancesFile(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path.includes("instances[2]"))).toBe(
        true,
      );
    }
  });
});

describe("validateInstancesFile — rejection: duplicate names", () => {
  it("rejects two instances with the same name", () => {
    const data = {
      version: 1,
      instances: [
        { name: "dup", port: 4097, workspace: "/a", dbPath: "a.sqlite" },
        { name: "dup", port: 4197, workspace: "/b", dbPath: "b.sqlite" },
      ],
    };
    const result = validateInstancesFile(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const dupErr = result.errors.find((e) =>
        e.message.includes("Duplicate instance name"),
      );
      expect(dupErr).toBeDefined();
      expect(dupErr!.message).toContain("instances[0]");
    }
  });
});

describe("validateInstancesFile — rejection: duplicate ports", () => {
  it("rejects two instances with the same port", () => {
    const data = {
      version: 1,
      instances: [
        { name: "a", port: 4097, workspace: "/a", dbPath: "a.sqlite" },
        { name: "b", port: 4097, workspace: "/b", dbPath: "b.sqlite" },
      ],
    };
    const result = validateInstancesFile(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const dupErr = result.errors.find((e) =>
        e.message.includes("Duplicate port"),
      );
      expect(dupErr).toBeDefined();
      expect(dupErr!.message).toContain("instances[0]");
    }
  });
});

describe("validateInstancesFile — rejection: bad instance fields", () => {
  it("rejects missing name", () => {
    const data = {
      version: 1,
      instances: [{ port: 4097, workspace: "/a", dbPath: "a.sqlite" }],
    };
    const result = validateInstancesFile(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].path).toBe("instances[0].name");
    }
  });

  it("rejects invalid name via validateInstanceName", () => {
    const data = {
      version: 1,
      instances: [
        { name: "Bad Name!", port: 4097, workspace: "/a", dbPath: "a.sqlite" },
      ],
    };
    const result = validateInstancesFile(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].path).toBe("instances[0].name");
    }
  });

  it("rejects missing port", () => {
    const data = {
      version: 1,
      instances: [{ name: "test", workspace: "/a", dbPath: "a.sqlite" }],
    };
    const result = validateInstancesFile(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === "instances[0].port")).toBe(
        true,
      );
    }
  });

  it("rejects invalid port", () => {
    const data = {
      version: 1,
      instances: [
        { name: "test", port: 99999, workspace: "/a", dbPath: "a.sqlite" },
      ],
    };
    const result = validateInstancesFile(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some(
          (e) => e.path === "instances[0].port" && e.message.includes("between"),
        ),
      ).toBe(true);
    }
  });

  it("rejects empty workspace string", () => {
    const data = {
      version: 1,
      instances: [
        { name: "test", port: 4097, workspace: "", dbPath: "a.sqlite" },
      ],
    };
    const result = validateInstancesFile(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.path === "instances[0].workspace"),
      ).toBe(true);
    }
  });

  it("rejects missing workspace", () => {
    const data = {
      version: 1,
      instances: [{ name: "test", port: 4097, dbPath: "a.sqlite" }],
    };
    const result = validateInstancesFile(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.path === "instances[0].workspace"),
      ).toBe(true);
    }
  });

  it("rejects empty dbPath string", () => {
    const data = {
      version: 1,
      instances: [
        { name: "test", port: 4097, workspace: "/a", dbPath: "" },
      ],
    };
    const result = validateInstancesFile(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.path === "instances[0].dbPath"),
      ).toBe(true);
    }
  });

  it("rejects missing dbPath", () => {
    const data = {
      version: 1,
      instances: [{ name: "test", port: 4097, workspace: "/a" }],
    };
    const result = validateInstancesFile(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.path === "instances[0].dbPath"),
      ).toBe(true);
    }
  });

  it("rejects invalid opencodePort", () => {
    const data = {
      version: 1,
      instances: [
        {
          name: "test",
          port: 4097,
          workspace: "/a",
          dbPath: "a.sqlite",
          opencodePort: "not-a-port",
        },
      ],
    };
    const result = validateInstancesFile(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.path === "instances[0].opencodePort"),
      ).toBe(true);
    }
  });

  it("reports multiple errors for a single bad entry", () => {
    const data = {
      version: 1,
      instances: [{ port: 0, workspace: "", dbPath: "" }],
    };
    const result = validateInstancesFile(data);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Should have errors for name, port, workspace, and dbPath — at least 4
      expect(result.errors.length).toBeGreaterThanOrEqual(4);
    }
  });
});

describe("validateInstancesFile — rejection: defaultInstance", () => {
  it("rejects non-string defaultInstance", () => {
    const result = validateInstancesFile(validFile({ defaultInstance: 42 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((e) => e.path === "defaultInstance"),
      ).toBe(true);
    }
  });

  it("rejects defaultInstance not in instances", () => {
    const result = validateInstancesFile(
      validFile({ defaultInstance: "ghost" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some(
          (e) =>
            e.path === "defaultInstance" &&
            e.message.includes("not found"),
        ),
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveDefaultInstance
// ---------------------------------------------------------------------------

describe("resolveDefaultInstance", () => {
  const instances = [
    {
      name: "repo-a",
      port: 4097,
      workspace: "/a",
      dbPath: "a.sqlite",
    },
    {
      name: "repo-b",
      port: 4197,
      workspace: "/b",
      dbPath: "b.sqlite",
    },
  ];

  it("returns the explicitly named default", () => {
    const file = {
      version: 1 as const,
      defaultInstance: "repo-b",
      instances,
    };
    const result = resolveDefaultInstance(file);
    expect(result).toBeDefined();
    expect(result!.name).toBe("repo-b");
  });

  it("returns the single instance when no default is set", () => {
    const file = {
      version: 1 as const,
      instances: instances.slice(0, 1),
    };
    const result = resolveDefaultInstance(file);
    expect(result).toBeDefined();
    expect(result!.name).toBe("repo-a");
  });

  it("returns undefined when no default and >1 instances", () => {
    const file = {
      version: 1 as const,
      instances,
    };
    expect(resolveDefaultInstance(file)).toBeUndefined();
  });

  it("returns undefined when default names a missing instance", () => {
    // (validation catches this, but resolve should be robust)
    const file = {
      version: 1 as const,
      defaultInstance: "ghost",
      instances,
    };
    expect(resolveDefaultInstance(file)).toBeUndefined();
  });

  it("returns undefined for empty instances array", () => {
    const file = {
      version: 1 as const,
      instances: [] as typeof instances,
    };
    expect(resolveDefaultInstance(file)).toBeUndefined();
  });

  it("prefers explicit default over single-instance fallback", () => {
    const file = {
      version: 1 as const,
      defaultInstance: "repo-a",
      instances: instances.slice(0, 1),
    };
    const result = resolveDefaultInstance(file);
    expect(result).toBeDefined();
    expect(result!.name).toBe("repo-a");
  });
});