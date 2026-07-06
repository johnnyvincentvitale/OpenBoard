import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveSandboxWrapperPath, SANDBOX_EXEC_PATH } from "../../src/server/sandbox";

/**
 * npm install/test through the sandbox wrapper ("where practical" per
 * sandbox-wrapper-plan.md's required-tests list) — needs real npm registry
 * access, unlike every other wrapper check, so it lives in the integration
 * lane (test:integration) rather than the default `npm test` gate, matching
 * this repo's existing convention of keeping slow/network-dependent checks
 * out of the primary suite (see test/helpers/ephemeral-opencode-server.ts's
 * self-skip pattern, mirrored below).
 */
const WRAPPER_PATH = resolveSandboxWrapperPath();

function sandboxWrapperAvailable(): boolean {
  return process.platform === "darwin" && existsSync(SANDBOX_EXEC_PATH) && existsSync(WRAPPER_PATH);
}

function runWrapper(cwd: string, command: string): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(WRAPPER_PATH, ["-c", command], { cwd, encoding: "utf8" });
  return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// Same $HOME-based (never os.tmpdir()-based) scratch dir rule as
// test/server/sandbox-wrapper.test.ts — see that file for why.
function scratchDir(prefix: string): string {
  return mkdtempSync(join(homedir(), prefix));
}

describe.skipIf(!sandboxWrapperAvailable())("sandbox-wrapper.sh — npm install/test (integration)", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("installs a small real dependency and runs a test script inside the sandbox", () => {
    dir = scratchDir(".ocb-sbx-npm-");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "sandbox-wrapper-npm-probe",
        version: "1.0.0",
        private: true,
        scripts: { test: "node -e \"console.log('probe-test-ok')\"" },
        dependencies: { "is-odd": "3.0.1" },
      }),
    );

    const result = runWrapper(dir, "npm install --no-audit --no-fund --loglevel=error && npm test --silent");

    if (result.code !== 0 && /ENOTFOUND|ETIMEDOUT|network|getaddrinfo/i.test(result.stderr)) {
      // Practical, not required offline — self-skip rather than fail the
      // integration suite on a machine with no registry access.
      return;
    }

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("probe-test-ok");
    expect(existsSync(join(dir, "node_modules", "is-odd"))).toBe(true);
    expect(existsSync(join(dir, "package-lock.json"))).toBe(true);
  });
});
