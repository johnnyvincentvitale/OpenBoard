import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterBuildInfo } from "../shared/health";

let cached: AdapterBuildInfo | undefined;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readPackageVersion(): string | undefined {
  try {
    const packageJsonPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../package.json");
    const raw = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version?: unknown };
    return typeof raw.version === "string" && raw.version.trim() ? raw.version.trim() : undefined;
  } catch {
    return undefined;
  }
}

function readGitCommit(): string | undefined {
  try {
    const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    return nonEmpty(execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return undefined;
  }
}

export function resolveAdapterBuildInfo(env: NodeJS.ProcessEnv = process.env): AdapterBuildInfo {
  if (env === process.env && cached !== undefined) return cached;

  const info: AdapterBuildInfo = {
    version: nonEmpty(env.OPENBOARD_VERSION) ?? nonEmpty(env.npm_package_version) ?? readPackageVersion(),
    commit: nonEmpty(env.OPENBOARD_COMMIT) ?? nonEmpty(env.GIT_COMMIT) ?? readGitCommit(),
    build: nonEmpty(env.OPENBOARD_BUILD_ID),
  };

  if (env === process.env) cached = info;
  return info;
}
