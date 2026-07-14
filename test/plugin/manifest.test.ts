import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const PLUGIN_ROOT = join(HERE, "..", "..", "plugins", "openboard");

function readPluginJson(...parts: string[]) {
  return JSON.parse(readFileSync(join(PLUGIN_ROOT, ...parts), "utf8")) as unknown;
}

function collectFiles(root: string, files: string[] = []) {
  if (!existsSync(root)) return files;

  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      collectFiles(path, files);
    } else if (stat.isFile()) {
      files.push(path);
    }
  }
  return files;
}

describe("plugin manifests", () => {
  it("does not contain absolute /Users paths in distributable config", () => {
    const mcp = readPluginJson(".mcp.json") as { mcpServers: Record<string, { command: string; args: string[] }> };
    const raw = JSON.stringify(mcp);

    expect(raw).not.toContain("/Users/");
    expect(mcp.mcpServers).toHaveProperty("openboard");
    const server = mcp.mcpServers.openboard;
    expect(server.command).toBe("openboard");
    expect(server.args).toEqual(["mcp"]);
    expect(raw).not.toContain("OPENCODE_BOARD_MCP_SERVER");
    expect(raw).not.toContain("mcp-server.mjs");
  });

  it("does not contain personal handles in public-distribution config", () => {
    const files = [
      "package.json",
      "README.md",
      "SECURITY.md",
      "src/tui/index.ts",
      "src/tui/wordmark.ts",
      "test/plugin/manifest.test.ts",
      ...collectFiles(PLUGIN_ROOT),
      ...collectFiles(join(REPO_ROOT, ".opencode", "skills")),
    ];
    const raw = files.map((file) => readFileSync(isAbsolute(file) ? file : join(REPO_ROOT, file), "utf8")).join("\n");
    const privateVaultName = ["Brain", "Pro"].join("-");
    const personalName = ["Jo", "hnny"].join("");

    const privateHandle = new RegExp(["jo", "hnny", "(vincent)?", "vitale"].join(""), "i");

    expect(raw).not.toMatch(privateHandle);
    expect(raw).not.toContain(privateVaultName);
    expect(raw).not.toMatch(new RegExp(`(^|[^A-Za-z])${personalName}([^A-Za-z]|$)`));
  });

  it("does not require a repo-relative MCP bootstrap script", () => {
    const pluginFiles = collectFiles(PLUGIN_ROOT).map((file) => file.slice(PLUGIN_ROOT.length + 1));

    expect(pluginFiles).not.toContain("mcp-server.mjs");
  });

  it.each([
    [".claude-plugin", "plugin.json"],
    [".codex-plugin", "plugin.json"],
  ] as const)("has valid %s/%s", (dir, file) => {
    const manifest = readPluginJson(dir, file) as Record<string, unknown>;
    expect(manifest.name).toBe("openboard");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
