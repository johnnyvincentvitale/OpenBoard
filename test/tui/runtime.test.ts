import { describe, expect, it } from "vitest";
import { getOpenTuiRuntimeStatus } from "../../src/tui/runtime";

describe("OpenTUI runtime guard", () => {
  it("allows Bun", () => {
    expect(getOpenTuiRuntimeStatus({ bun: "1.3.4", node: "22.0.0" }, [])).toEqual({
      ok: true,
      runtime: "bun 1.3.4",
    });
  });

  it("allows Node 26.3+ with experimental FFI", () => {
    expect(getOpenTuiRuntimeStatus({ node: "26.3.0" }, ["--experimental-ffi"])).toEqual({
      ok: true,
      runtime: "node 26.3.0 --experimental-ffi",
    });
  });

  it("rejects Node 22 with a useful message", () => {
    const result = getOpenTuiRuntimeStatus({ node: "22.22.3" }, []);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Bun or Node 26.3+");
    expect(result.message).toContain("Electron app, adapter, MCP server, and shared client");
  });
});
