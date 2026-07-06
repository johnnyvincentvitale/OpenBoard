import { describe, it, expect } from "vitest";
import {
  resolveSandboxStatus,
  resolveSandboxWrapperPath,
  SANDBOX_EXEC_PATH,
} from "../../src/server/sandbox";

/** Always-true/always-false existsSync stand-ins, keyed by path, for DI. */
function existsMap(present: Record<string, boolean>): (p: import("node:fs").PathLike) => boolean {
  return (p) => present[String(p)] ?? false;
}

describe("resolveSandboxStatus", () => {
  it("connect mode never expects or enables the wrapper, regardless of platform", () => {
    const status = resolveSandboxStatus({
      mode: "connect",
      platform: "darwin",
      existsSync: existsMap({ "/wrapper.sh": true, [SANDBOX_EXEC_PATH]: true }),
    });
    expect(status).toEqual({
      expected: false,
      enabled: false,
      reason: "connect mode: OpenBoard does not manage the OpenCode process or its config",
    });
  });

  it("non-darwin spawn mode is not expected to sandbox (Linux bwrap is a separate, unbuilt probe)", () => {
    const status = resolveSandboxStatus({ mode: "spawn", platform: "linux" });
    expect(status.expected).toBe(false);
    expect(status.enabled).toBe(false);
    expect(status.reason).toMatch(/macOS-only/i);
    expect(status.reason).toContain("linux");
  });

  it("win32 spawn mode is also not expected", () => {
    const status = resolveSandboxStatus({ mode: "spawn", platform: "win32" });
    expect(status.expected).toBe(false);
    expect(status.enabled).toBe(false);
  });

  it("darwin spawn mode fails closed (expected but not enabled) when the wrapper script is missing", () => {
    const status = resolveSandboxStatus({
      mode: "spawn",
      platform: "darwin",
      wrapperPath: "/does/not/exist/sandbox-wrapper.sh",
      sandboxExecPath: SANDBOX_EXEC_PATH,
      existsSync: existsMap({ [SANDBOX_EXEC_PATH]: true }),
    });
    expect(status.expected).toBe(true);
    expect(status.enabled).toBe(false);
    expect(status.reason).toContain("/does/not/exist/sandbox-wrapper.sh");
  });

  it("darwin spawn mode fails closed (expected but not enabled) when sandbox-exec is missing", () => {
    const status = resolveSandboxStatus({
      mode: "spawn",
      platform: "darwin",
      wrapperPath: "/repo/scripts/sandbox-wrapper.sh",
      sandboxExecPath: "/usr/bin/sandbox-exec",
      existsSync: existsMap({ "/repo/scripts/sandbox-wrapper.sh": true }),
    });
    expect(status.expected).toBe(true);
    expect(status.enabled).toBe(false);
    expect(status.reason).toContain("/usr/bin/sandbox-exec");
  });

  it("darwin spawn mode enables the wrapper when both prerequisites exist", () => {
    const status = resolveSandboxStatus({
      mode: "spawn",
      platform: "darwin",
      wrapperPath: "/repo/scripts/sandbox-wrapper.sh",
      sandboxExecPath: "/usr/bin/sandbox-exec",
      existsSync: existsMap({
        "/repo/scripts/sandbox-wrapper.sh": true,
        "/usr/bin/sandbox-exec": true,
      }),
    });
    expect(status).toEqual({
      expected: true,
      enabled: true,
      wrapperPath: "/repo/scripts/sandbox-wrapper.sh",
    });
  });
});

describe("resolveSandboxWrapperPath", () => {
  it("resolves to <repo-root>/scripts/sandbox-wrapper.sh from this module's own location", () => {
    const path = resolveSandboxWrapperPath();
    expect(path).toMatch(/[\\/]scripts[\\/]sandbox-wrapper\.sh$/);
    expect(path).not.toContain("/dist/");
  });
});
