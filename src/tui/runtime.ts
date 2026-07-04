export interface OpenTuiRuntimeStatus {
  ok: boolean;
  runtime: string;
  message?: string;
}

interface RuntimeVersions {
  node?: string;
  bun?: string;
}

export function getOpenTuiRuntimeStatus(
  versions: RuntimeVersions = process.versions as RuntimeVersions,
  execArgv: string[] = process.execArgv,
): OpenTuiRuntimeStatus {
  if (versions.bun) {
    return { ok: true, runtime: `bun ${versions.bun}` };
  }

  const nodeVersion = versions.node ?? "0.0.0";
  const [major = 0, minor = 0] = nodeVersion.split(".").map((part) => Number.parseInt(part, 10));
  const hasFfiFlag = execArgv.includes("--experimental-ffi");
  const supportsFfi = major > 26 || (major === 26 && minor >= 3);

  if (supportsFfi && hasFfiFlag) {
    return { ok: true, runtime: `node ${nodeVersion} --experimental-ffi` };
  }

  const reason = supportsFfi
    ? "Node is new enough, but it was not started with --experimental-ffi."
    : `Current Node is ${nodeVersion}.`;

  return {
    ok: false,
    runtime: `node ${nodeVersion}`,
    message: [
      "OpenBoard's OpenTUI renderer needs Bun or Node 26.3+ with --experimental-ffi.",
      reason,
      "Use Bun for the TUI runner, or run Node 26.3+ with: node --experimental-ffi dist/tui/index.mjs",
      "The adapter, MCP server, and shared client still support the existing Node 22 path.",
    ].join("\n"),
  };
}

export function assertOpenTuiRuntime(): OpenTuiRuntimeStatus {
  const status = getOpenTuiRuntimeStatus();
  if (!status.ok) {
    throw new Error(status.message);
  }
  return status;
}
