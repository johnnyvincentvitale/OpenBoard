/**
 * Instance-scoped diagnostics route — read-only control panel surface for
 * sandbox, OpenCode server reachability, worktree health, instance identity,
 * and editor command status.
 *
 * Registered behind the board-token auth middleware (unlike /api/health which
 * is unauthenticated) because this reports workspace/db/worktree paths and
 * editor configuration.
 */
import type { Hono } from "hono";
import type {
  BashSandboxDiagnostics,
  BashSandboxEffective,
  BoardDiagnostics,
  OpencodeDiagnostics,
  WorktreeHealthDiagnostics,
} from "../../shared/diagnostics";
import type { TaskStore } from "../../shared/task";
import type { SandboxStatus } from "../sandbox";
import { resolveEditorDiagnostics } from "../../tui/editor-command";
import type { BoardIdentitySource } from "../../shared/health";
import type { AdapterBuildInfo } from "../../shared/health";
import { resolveAdapterBuildInfo } from "../build-info";

/** The OpenCode SDK client type — duck-typed for the health check. */
type OpencodeClientLike = {
  global: { health: (opts?: { signal?: AbortSignal }) => Promise<{ data?: { healthy: boolean; version: string } | null; error?: unknown }> };
};

export interface DiagnosticsDeps {
  client: OpencodeClientLike;
  store: TaskStore;
  sandbox: SandboxStatus;
  opencodeBaseUrl: string;
  /** The adapter's connection mode — used to determine sandbox effective state. */
  mode: "spawn" | "connect";
  identity?: BoardIdentitySource;
  boardTokenPresent?: boolean;
  build?: AdapterBuildInfo;
}

/** Safely extract port from an OpenCode base URL. */
function portFromUrl(raw: string): number | undefined {
  try {
    const port = new URL(raw).port;
    return port ? Number(port) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the effective bash sandbox state from SandboxStatus and the
 * persisted user setting.
 *
 * - "on":         sandbox wrapper is wired and active.
 * - "off":        user disabled sandbox (or sandbox not applicable in spawn).
 * - "unavailable": user wants sandbox but prerequisites are missing.
 * - "external":   connect mode — OpenBoard doesn't own the process.
 */
export function resolveEffectiveSandbox(
  sandbox: SandboxStatus,
  mode: "spawn" | "connect",
  desired: boolean,
): BashSandboxEffective {
  if (sandbox.enabled) return "on";
  if (mode === "connect") return "external";
  if (!desired) return "off";
  // desired === true, sandbox not enabled
  if (sandbox.expected) return "unavailable";
  // spawn mode, platform doesn't support sandbox at all
  return "off";
}

/** Compute restart-required: true when desired ≠ effective in a restart-mutable way. */
export function restartRequired(
  desired: boolean,
  effective: BashSandboxEffective,
): boolean {
  if (effective === "external") return false;
  const effectiveBool = effective === "on";
  return desired !== effectiveBool;
}

export function registerDiagnosticsRoutes(app: Hono, deps: DiagnosticsDeps): void {
  app.get("/api/diagnostics", async (c) => {
    const settings = deps.store.getSettings();
    const desired = settings.bashSandbox;
    const effective = resolveEffectiveSandbox(deps.sandbox, deps.mode, desired);

    const sandbox: BashSandboxDiagnostics = {
      desired: desired ? "on" : "off",
      effective,
      restartRequired: restartRequired(desired, effective),
    };

    const opencode: OpencodeDiagnostics = await resolveOpencodeDiagnostics(deps.client, deps.opencodeBaseUrl);

    const sweepResult = deps.store.getSweepResult();
    const worktree: WorktreeHealthDiagnostics = {
      lastSweep: sweepResult?.sweptAt,
      removedCleanCount: sweepResult?.removedCleanCount ?? 0,
      keptDirtyCount: sweepResult?.keptDirtyCount ?? 0,
      ...(sweepResult?.dirtyOrphans?.length ? { dirtyOrphans: sweepResult.dirtyOrphans } : {}),
    };

    const source: BoardIdentitySource = deps.identity ?? { port: 4097, workspace: process.cwd(), dbPath: "board-tasks.sqlite" };
    const instance = {
      ...(source.name !== undefined ? { instanceName: source.name } : {}),
      boardUrl: `http://127.0.0.1:${source.port}`,
      port: source.port,
      workspace: source.workspace,
      dbPath: source.dbPath,
      apiTokenPresent: Boolean(deps.boardTokenPresent),
    };

    const editor = resolveEditorDiagnostics(process.env);

    const result: BoardDiagnostics = {
      sandbox,
      opencode,
      worktree,
      instance,
      editor,
    };

    return c.json(result, 200);
  });
}

async function resolveOpencodeDiagnostics(
  client: OpencodeClientLike,
  opencodeBaseUrl: string,
): Promise<OpencodeDiagnostics> {
  const url = opencodeBaseUrl;
  let version: string | undefined;
  let reachable = false;

  try {
    const result = await client.global.health();
    if (!result.error && result.data?.healthy) {
      reachable = true;
      version = result.data.version;
    }
  } catch {
    // unreachable stays false
  }

  return { url, version, reachable };
}