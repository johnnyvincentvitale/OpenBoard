import { describe, expect, it, vi } from "vitest";
import {
  InstanceNameCollisionError,
  InstanceSpawnError,
  InstanceUnknownError,
} from "../../src/shared/instances";
import type {
  InstanceDefinition,
  InstanceRuntimeState,
} from "../../src/shared/instances";
import { runOpenboard } from "../../src/cli/openboard";
import type {
  AttachContext,
  McpContext,
  OutStream,
} from "../../src/cli/openboard";
import type { InstanceLifecycleProvider } from "../../src/cli/provider";

const DEFAULT_DEFINITION: InstanceDefinition = {
  name: "my-project",
  port: 4097,
  workspace: "/home/alice/repos/my-project",
  dbPath: "my-project.sqlite",
  boardToken: "token-1",
};

const RUNNING_RUNTIME: InstanceRuntimeState = {
  status: "running",
  boardUrl: "http://127.0.0.1:4097",
};

const STOPPED_RUNTIME: InstanceRuntimeState = {
  status: "stopped",
  boardUrl: "http://127.0.0.1:4097",
};

function mockProvider(
  overrides: Partial<InstanceLifecycleProvider> = {},
): InstanceLifecycleProvider {
  return {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(DEFAULT_DEFINITION),
    resolveDefault: vi.fn().mockResolvedValue(DEFAULT_DEFINITION),
    getDefaultInfo: vi.fn().mockResolvedValue({ kind: "explicit", definition: DEFAULT_DEFINITION, instanceCount: 1 }),
    setDefault: vi.fn().mockResolvedValue(DEFAULT_DEFINITION),
    clearDefault: vi.fn().mockResolvedValue({ kind: "unset", instanceCount: 0 }),
    add: vi.fn().mockImplementation(async (input) => ({
      name: input.name,
      port: input.port,
      workspace: input.workspace,
      dbPath: input.dbPath ?? `${input.name}.sqlite`,
      opencodePort: input.opencodePort,
    })),
    remove: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(RUNNING_RUNTIME),
    stop: vi.fn().mockResolvedValue(STOPPED_RUNTIME),
    getRuntime: vi.fn().mockResolvedValue(STOPPED_RUNTIME),
    getHealth: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockImplementation(async (oldName, newName) => ({
      name: newName,
      port: DEFAULT_DEFINITION.port,
      workspace: DEFAULT_DEFINITION.workspace,
      dbPath: DEFAULT_DEFINITION.dbPath,
    })),
    ...overrides,
  } as unknown as InstanceLifecycleProvider;
}

function captureStreams(): {
  stdout: OutStream;
  stderr: OutStream;
  out: string;
  err: string;
} {
  let out = "";
  let err = "";
  return {
    stdout: { write: (chunk: string) => {
      out += chunk;
    } },
    stderr: { write: (chunk: string) => {
      err += chunk;
    } },
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

async function run(
  argv: string[],
  provider: InstanceLifecycleProvider,
  attach: (ctx: AttachContext) => Promise<number> = () => Promise.resolve(0),
  selector: (ctx: { repoRoot: string }) => Promise<number> = () => Promise.resolve(0),
  mcp: (ctx: McpContext) => Promise<number> = () => Promise.resolve(0),
) {
  const streams = captureStreams();
  const code = await runOpenboard(argv, {
    provider,
    attach,
    mcp,
    selector,
    stdout: streams.stdout,
    stderr: streams.stderr,
  });
  return { code, out: streams.out, err: streams.err };
}

// ---------------------------------------------------------------------------
// Help / usage
// ---------------------------------------------------------------------------

describe("openboard --help", () => {
  it("prints usage to stdout and exits 0", async () => {
    const provider = mockProvider();
    const { code, out, err } = await run(["--help"], provider);
    expect(code).toBe(0);
    expect(out).toContain("Usage:");
    expect(out).toContain("list");
    expect(err).toBe("");
  });

  it("opens the instance selector for empty arguments", async () => {
    const provider = mockProvider();
    const selector = vi.fn(() => Promise.resolve(0));
    const { code, out } = await run([], provider, undefined, selector);
    expect(code).toBe(0);
    expect(selector).toHaveBeenCalledTimes(1);
    expect(out).not.toContain("Usage:");
  });

  it("does not advertise the removed add --no-start flag", async () => {
    const provider = mockProvider();
    const { code, out } = await run(["--help"], provider);
    expect(code).toBe(0);
    expect(out).not.toContain("--no-start");
    expect(out).toContain("default show");
    expect(out).toContain("status <name>");
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("openboard list", () => {
  it("prints a table of instances with status, board URL, workspace, and DB path", async () => {
    const provider = mockProvider({
      list: vi.fn().mockResolvedValue([
        {
          definition: {
            name: "alpha",
            port: 4097,
            workspace: "/ws/alpha",
            dbPath: "alpha.sqlite",
          },
          runtime: { status: "running", boardUrl: "http://127.0.0.1:4097" },
        },
        {
          definition: {
            name: "beta",
            port: 4197,
            workspace: "/ws/beta",
            dbPath: "beta.sqlite",
          },
          runtime: { status: "stopped", boardUrl: "http://127.0.0.1:4197" },
        },
      ]),
    });
    const { code, out } = await run(["list"], provider);
    expect(code).toBe(0);
    expect(out).toContain("NAME");
    expect(out).toContain("STATUS");
    expect(out).toContain("BOARD URL");
    expect(out).toContain("WORKSPACE");
    expect(out).toContain("DB PATH");
    expect(out).toContain("alpha");
    expect(out).toContain("running");
    expect(out).toContain("http://127.0.0.1:4097");
    expect(out).toContain("/ws/alpha");
    expect(out).toContain("alpha.sqlite");
    expect(out).toContain("stopped");
    expect(out).toContain("http://127.0.0.1:4197");
  });

  it("prints a friendly message when no instances exist", async () => {
    const provider = mockProvider();
    const { code, out } = await run(["list"], provider);
    expect(code).toBe(0);
    expect(out).toContain("No instances");
  });
});

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

describe("openboard add", () => {
  it("registers an instance with explicit port", async () => {
    const provider = mockProvider();
    const { code, out } = await run(
      ["add", "new-project", "--workspace", "/ws/new", "--port", "5000"],
      provider,
    );
    expect(code).toBe(0);
    expect(out).toContain('Added instance "new-project"');
    expect(out).toContain("5000");
    expect(out).toContain("/ws/new");
    expect(provider.add).toHaveBeenCalledWith({
      name: "new-project",
      port: 5000,
      workspace: "/ws/new",
      opencodePort: undefined,
    });
    // add must NOT auto-start the instance
    expect(provider.start).not.toHaveBeenCalled();
  });

  it("auto-assigns the next available board port", async () => {
    const provider = mockProvider({
      list: vi.fn().mockResolvedValue([
        {
          definition: {
            name: "alpha",
            port: 4097,
            workspace: "/a",
            dbPath: "a.sqlite",
          },
          runtime: { status: "stopped", boardUrl: "http://127.0.0.1:4097" },
        },
        {
          definition: {
            name: "beta",
            port: 4098,
            workspace: "/b",
            dbPath: "b.sqlite",
          },
          runtime: { status: "stopped", boardUrl: "http://127.0.0.1:4098" },
        },
      ]),
    });
    await run(["add", "gamma", "--workspace", "/c"], provider);
    expect(provider.add).toHaveBeenCalledWith({
      name: "gamma",
      port: 4099,
      workspace: "/c",
      opencodePort: undefined,
    });
  });

  it("does NOT auto-start the instance after add", async () => {
    const provider = mockProvider();
    const { code, out } = await run(
      ["add", "fresh", "--workspace", "/ws/fresh"],
      provider,
    );
    expect(code).toBe(0);
    expect(provider.start).not.toHaveBeenCalled();
    expect(out).toContain('Added instance "fresh"');
  });

  it("rejects --no-start as an unknown dead flag", async () => {
    const provider = mockProvider();
    const { code, err } = await run(
      ["add", "fresh", "--workspace", "/ws/fresh", "--no-start"],
      provider,
    );
    expect(code).toBe(1);
    expect(err).toContain("Unknown argument: --no-start");
    expect(provider.start).not.toHaveBeenCalled();
    expect(provider.add).not.toHaveBeenCalled();
  });

  it("rejects invalid instance names", async () => {
    const provider = mockProvider();
    const { code, err } = await run(
      ["add", "Bad Name", "--workspace", "/a"],
      provider,
    );
    expect(code).toBe(1);
    expect(err).toContain("kebab-case");
    expect(provider.add).not.toHaveBeenCalled();
  });

  it("requires a workspace", async () => {
    const provider = mockProvider();
    const { code, err } = await run(["add", "foo"], provider);
    expect(code).toBe(1);
    expect(err).toContain("workspace");
  });

  it("rejects an out-of-range port", async () => {
    const provider = mockProvider();
    const { code, err } = await run(
      ["add", "foo", "--workspace", "/a", "--port", "99999"],
      provider,
    );
    expect(code).toBe(1);
    expect(err).toContain("between");
  });

  it("surfaces a name collision as a typed error", async () => {
    const provider = mockProvider({
      add: vi.fn().mockRejectedValue(new InstanceNameCollisionError("dup")),
    });
    const { code, err } = await run(
      ["add", "dup", "--workspace", "/a"],
      provider,
    );
    expect(code).toBe(1);
    expect(err).toContain('"dup"');
    expect(err).toContain("already exists");
  });
});

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

describe("openboard remove", () => {
  it("removes a stopped instance", async () => {
    const provider = mockProvider({
      getRuntime: vi.fn().mockResolvedValue(STOPPED_RUNTIME),
    });
    const { code, out } = await run(["remove", "my-project"], provider);
    expect(code).toBe(0);
    expect(out).toContain('Removed instance "my-project"');
    expect(provider.remove).toHaveBeenCalledWith("my-project");
  });

  it("refuses to remove a running instance without --force", async () => {
    const provider = mockProvider({
      getRuntime: vi.fn().mockResolvedValue(RUNNING_RUNTIME),
    });
    const { code, err } = await run(["remove", "my-project"], provider);
    expect(code).toBe(1);
    expect(err).toContain("running");
    expect(err).toContain("--force");
    expect(provider.remove).not.toHaveBeenCalled();
  });

  it("stops a running instance with --force, then removes it", async () => {
    const provider = mockProvider({
      getRuntime: vi.fn().mockResolvedValue(RUNNING_RUNTIME),
    });
    const { code, out } = await run(["remove", "my-project", "--force"], provider);
    expect(code).toBe(0);
    expect(provider.stop).toHaveBeenCalledWith("my-project");
    expect(provider.remove).toHaveBeenCalledWith("my-project");
    expect(out).toContain('Removed instance "my-project"');
  });

  it("surfaces unknown instances", async () => {
    const provider = mockProvider({
      remove: vi.fn().mockRejectedValue(new InstanceUnknownError("ghost")),
    });
    const { code, err } = await run(["remove", "ghost"], provider);
    expect(code).toBe(1);
    expect(err).toContain("Unknown instance");
  });
});

// ---------------------------------------------------------------------------
// start / stop
// ---------------------------------------------------------------------------

describe("openboard start", () => {
  it("starts an instance and reports its status", async () => {
    const provider = mockProvider();
    const { code, out } = await run(["start", "my-project"], provider);
    expect(code).toBe(0);
    expect(provider.start).toHaveBeenCalledWith("my-project");
    expect(out).toContain("running");
    expect(out).toContain("http://127.0.0.1:4097");
  });

  it("surfaces a start failure with the typed error", async () => {
    const cause = new Error("ENOENT");
    const provider = mockProvider({
      start: vi.fn().mockRejectedValue(new InstanceSpawnError("bad", cause)),
    });
    const { code, err } = await run(["start", "bad"], provider);
    expect(code).toBe(1);
    expect(err).toContain('Failed to spawn instance "bad"');
    expect(err).toContain("ENOENT");
  });
});

describe("openboard stop", () => {
  it("stops an instance and reports its status", async () => {
    const provider = mockProvider();
    const { code, out } = await run(["stop", "my-project"], provider);
    expect(code).toBe(0);
    expect(provider.stop).toHaveBeenCalledWith("my-project");
    expect(out).toContain("stopped");
  });
});

// ---------------------------------------------------------------------------
// default
// ---------------------------------------------------------------------------

describe("openboard default", () => {
  it("shows an explicit default", async () => {
    const provider = mockProvider({
      getDefaultInfo: vi.fn().mockResolvedValue({ kind: "explicit", definition: DEFAULT_DEFINITION, instanceCount: 2 }),
    });

    const { code, out } = await run(["default", "show"], provider);

    expect(code).toBe(0);
    expect(out).toContain("my-project");
    expect(out).toContain("explicit");
  });

  it("shows an inferred only-instance default", async () => {
    const provider = mockProvider({
      getDefaultInfo: vi.fn().mockResolvedValue({ kind: "inferred", definition: DEFAULT_DEFINITION, instanceCount: 1 }),
    });

    const { code, out } = await run(["default", "show"], provider);

    expect(code).toBe(0);
    expect(out).toContain("inferred");
    expect(out).toContain("only registered instance");
  });

  it("shows unset default with actionable commands", async () => {
    const provider = mockProvider({
      getDefaultInfo: vi.fn().mockResolvedValue({ kind: "unset", instanceCount: 2 }),
    });

    const { code, out } = await run(["default", "show"], provider);

    expect(code).toBe(0);
    expect(out).toContain("openboard default set <name>");
    expect(out).toContain("openboard attach <name>");
  });

  it("sets a default after provider validation", async () => {
    const provider = mockProvider();

    const { code, out } = await run(["default", "set", "my-project"], provider);

    expect(code).toBe(0);
    expect(provider.setDefault).toHaveBeenCalledWith("my-project");
    expect(out).toContain('Default instance set to "my-project"');
  });

  it("surfaces unknown instance when setting default", async () => {
    const provider = mockProvider({
      setDefault: vi.fn().mockRejectedValue(new InstanceUnknownError("ghost")),
    });

    const { code, err } = await run(["default", "set", "ghost"], provider);

    expect(code).toBe(1);
    expect(err).toContain("Unknown instance");
  });

  it("clears a default and explains attach behavior", async () => {
    const provider = mockProvider({
      clearDefault: vi.fn().mockResolvedValue({ kind: "inferred", definition: DEFAULT_DEFINITION, instanceCount: 1 }),
    });

    const { code, out } = await run(["default", "clear"], provider);

    expect(code).toBe(0);
    expect(provider.clearDefault).toHaveBeenCalled();
    expect(out).toContain("Cleared explicit default");
    expect(out).toContain("will infer");
  });
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe("openboard status", () => {
  it("prints stopped registry identity with live fields unavailable", async () => {
    const provider = mockProvider({
      getRuntime: vi.fn().mockResolvedValue(STOPPED_RUNTIME),
      getHealth: vi.fn().mockResolvedValue(undefined),
    });

    const { code, out } = await run(["status", "my-project"], provider);

    expect(code).toBe(0);
    expect(provider.start).not.toHaveBeenCalled();
    expect(out).toContain("Instance: my-project");
    expect(out).toContain("Runtime: stopped");
    expect(out).toContain("Task DB path: my-project.sqlite");
    expect(out).toContain("Board token: present");
    expect(out).toContain("Live identity: unavailable");
  });

  it("prints live health identity and build for running instances", async () => {
    const provider = mockProvider({
      getRuntime: vi.fn().mockResolvedValue(RUNNING_RUNTIME),
      getHealth: vi.fn().mockResolvedValue({
        adapter: "ok",
        opencode: { status: "ok", version: "1.2.3" },
        identity: {
          instanceName: "my-project",
          boardUrl: "http://127.0.0.1:4097",
          port: 4097,
          workspace: "/home/alice/repos/my-project",
          dbPath: "my-project.sqlite",
          opencodeUrl: "http://127.0.0.1:4096",
          opencodePort: 4096,
          boardTokenPresent: true,
        },
        build: { version: "0.0.1", commit: "abc123" },
      }),
    });

    const { code, out } = await run(["status", "my-project"], provider);

    expect(code).toBe(0);
    expect(out).toContain("OpenCode backend: http://127.0.0.1:4096");
    expect(out).toContain("Adapter build: version 0.0.1, commit abc123");
    expect(out).toContain("OpenCode health: ok (1.2.3)");
  });
});

// ---------------------------------------------------------------------------
// attach
// ---------------------------------------------------------------------------

describe("openboard attach", () => {
  it("attaches to a named running instance without starting", async () => {
    const attach = vi.fn().mockResolvedValue(0);
    const provider = mockProvider({
      getRuntime: vi.fn().mockResolvedValue(RUNNING_RUNTIME),
    });
    const { code } = await run(["attach", "my-project"], provider, attach);
    expect(code).toBe(0);
    expect(provider.start).not.toHaveBeenCalled();
    expect(attach).toHaveBeenCalledWith({
      repoRoot: expect.any(String) as unknown,
      definition: DEFAULT_DEFINITION,
      runtime: RUNNING_RUNTIME,
    });
  });

  it("attaches to the default instance when no name is given", async () => {
    const attach = vi.fn().mockResolvedValue(42);
    const provider = mockProvider();
    const { code } = await run(["attach"], provider, attach);
    expect(code).toBe(42);
    expect(provider.get).not.toHaveBeenCalled();
    expect(provider.resolveDefault).toHaveBeenCalled();
    expect(attach).toHaveBeenCalled();
  });

  it("errors when there is no default instance", async () => {
    const provider = mockProvider({
      resolveDefault: vi.fn().mockResolvedValue(undefined),
    });
    const { code, err } = await run(["attach"], provider);
    expect(code).toBe(1);
    expect(err).toContain("No default instance");
    expect(err).toContain("openboard default set <name>");
    expect(err).toContain("openboard default show");
  });
});

// ---------------------------------------------------------------------------
// mcp
// ---------------------------------------------------------------------------

describe("openboard mcp", () => {
  it("starts MCP unbound without resolving an instance", async () => {
    const mcp = vi.fn().mockResolvedValue(0);
    const provider = mockProvider();

    const { code } = await run(["mcp"], provider, undefined, undefined, mcp);

    expect(code).toBe(0);
    expect(provider.get).not.toHaveBeenCalled();
    expect(provider.getRuntime).not.toHaveBeenCalled();
    expect(provider.start).not.toHaveBeenCalled();
    expect(mcp).toHaveBeenCalledWith({
      repoRoot: expect.any(String) as unknown,
    });
  });

  it("starts MCP for a named running instance without starting it", async () => {
    const mcp = vi.fn().mockResolvedValue(0);
    const provider = mockProvider({
      getRuntime: vi.fn().mockResolvedValue(RUNNING_RUNTIME),
    });

    const { code } = await run(["mcp", "--instance", "my-project"], provider, undefined, undefined, mcp);

    expect(code).toBe(0);
    expect(provider.start).not.toHaveBeenCalled();
    expect(mcp).toHaveBeenCalledWith({
      repoRoot: expect.any(String) as unknown,
      definition: DEFAULT_DEFINITION,
      runtime: RUNNING_RUNTIME,
    });
  });

  it("refuses stopped instances", async () => {
    const mcp = vi.fn().mockResolvedValue(0);
    const provider = mockProvider({ getRuntime: vi.fn().mockResolvedValue(STOPPED_RUNTIME) });

    const { code, err } = await run(["mcp", "--instance", "my-project"], provider, undefined, undefined, mcp);

    expect(code).toBe(1);
    expect(err).toContain("is stopped");
    expect(err).toContain("openboard start my-project");
    expect(provider.start).not.toHaveBeenCalled();
    expect(mcp).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// bare invocation
// ---------------------------------------------------------------------------

describe("openboard <name>", () => {
  it("starts a stopped instance, then attaches", async () => {
    const attach = vi.fn().mockResolvedValue(0);
    const provider = mockProvider({
      getRuntime: vi.fn().mockResolvedValue(STOPPED_RUNTIME),
      start: vi.fn().mockResolvedValue(RUNNING_RUNTIME),
    });
    const { code } = await run(["my-project"], provider, attach);
    expect(code).toBe(0);
    expect(provider.get).toHaveBeenCalledWith("my-project");
    expect(provider.getRuntime).toHaveBeenCalledWith("my-project");
    expect(provider.start).toHaveBeenCalledWith("my-project");
    expect(attach).toHaveBeenCalledWith({
      repoRoot: expect.any(String) as unknown,
      definition: DEFAULT_DEFINITION,
      runtime: RUNNING_RUNTIME,
    });
  });

  it("attaches a running instance without starting twice", async () => {
    const attach = vi.fn().mockResolvedValue(0);
    const provider = mockProvider({
      getRuntime: vi.fn().mockResolvedValue(RUNNING_RUNTIME),
    });
    const { code } = await run(["my-project"], provider, attach);
    expect(code).toBe(0);
    expect(provider.start).not.toHaveBeenCalled();
    expect(attach).toHaveBeenCalled();
  });

  it("errors for an unknown bare instance", async () => {
    const provider = mockProvider({
      get: vi.fn().mockRejectedValue(new InstanceUnknownError("ghost")),
    });
    const { code, err } = await run(["ghost"], provider);
    expect(code).toBe(1);
    expect(err).toContain("Unknown instance");
  });
});

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------

describe("openboard rename", () => {
  it("parses two positional args and calls provider.rename", async () => {
    const provider = mockProvider();
    const { code, out } = await run(
      ["rename", "old-project", "new-project"],
      provider,
    );
    expect(code).toBe(0);
    expect(provider.rename).toHaveBeenCalledWith("old-project", "new-project");
    expect(out).toContain("Renamed instance");
    expect(out).toContain("old-project");
    expect(out).toContain("new-project");
  });

  it("prints success message", async () => {
    const provider = mockProvider();
    const { code, out } = await run(
      ["rename", "alpha", "beta"],
      provider,
    );
    expect(code).toBe(0);
    expect(out).toContain('Renamed instance "alpha" to "beta"');
  });

  it("rejects missing args (only one arg given)", async () => {
    const provider = mockProvider();
    const { code, err } = await run(
      ["rename", "only-one"],
      provider,
    );
    expect(code).toBe(1);
    expect(err).toContain("rename requires");
    expect(provider.rename).not.toHaveBeenCalled();
  });

  it("surfaces InstanceUnknownError for unknown old name", async () => {
    const provider = mockProvider({
      rename: vi.fn().mockRejectedValue(new InstanceUnknownError("ghost")),
    });
    const { code, err } = await run(
      ["rename", "ghost", "new-name"],
      provider,
    );
    expect(code).toBe(1);
    expect(err).toContain("Unknown instance");
  });
});
