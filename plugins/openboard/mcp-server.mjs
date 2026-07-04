#!/usr/bin/env node
/**
 * OpenBoard MCP bootstrap.
 *
 * The MCP server bundle is a generated file under `dist/mcp/server.mjs`, so we
 * cannot ship an absolute path. This tiny wrapper resolves the bundle relative
 * to the plugin directory (following symlinks), or from the
 * `OPENCODE_BOARD_MCP_SERVER` environment variable for explicit installs.
 *
 * Usage in `.mcp.json`:
 *   { "command": "node", "args": ["mcp-server.mjs"] }
 *
 * The harness should run this command with the plugin directory as the working
 * directory, or you can set `OPENCODE_BOARD_MCP_SERVER` to an absolute path.
 */
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXPLICIT = process.env.OPENCODE_BOARD_MCP_SERVER?.trim();

async function resolveServerPath() {
  if (EXPLICIT) {
    return EXPLICIT;
  }

  // `import.meta.url` follows symlinks, so a symlinked plugin install still
  // resolves to the canonical plugin directory.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "dist", "mcp", "server.mjs");
}

async function main() {
  const serverPath = await resolveServerPath();
  const child = spawn(process.execPath, [serverPath], {
    stdio: ["inherit", "inherit", "inherit"],
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.exit(128 + signal);
    }
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
