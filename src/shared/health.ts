/** Shared /api/health response contracts. */

export interface AdapterBuildInfo {
  version?: string;
  commit?: string;
  build?: string;
}

export interface BoardIdentity {
  instanceName?: string;
  boardUrl: string;
  port: number;
  workspace: string;
  dbPath: string;
  opencodeUrl?: string;
  opencodePort?: number;
  boardTokenPresent: boolean;
}

export interface BoardHealth {
  adapter: "ok";
  opencode: { status: "ok"; version: string } | { status: "unreachable" };
  identity?: BoardIdentity;
  build?: AdapterBuildInfo;
}
