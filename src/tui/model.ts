import { homedir } from "node:os";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { createInstanceDaemon, createInstanceRegistry, renameInstance } from "../instances";
import type { Column, ModelRef, RosterAgent, Task, TaskRunState } from "../shared";
import {
  instanceDataDir,
  InstanceNameCollisionError,
  InstanceUnknownError,
  validateInstanceName,
  type InstanceDefinition,
  type InstanceRuntimeState,
  type InstanceStatus,
  type InstancesFile,
} from "../shared/instances";
import { resolveBoardToken } from "../server/auth";

// ── Instance lifecycle provider interface (frozen for parallel lanes) ─────────────

/**
 * Pure lifecycle operations the TUI needs from the instances daemon.
 * Lanes A (daemon) and C (CLI) implement the real provider; the TUI
 * ships a mock implementation; the TUI tests use a mock that satisfies this interface.
 */
export interface InstanceLifecycleProvider {
  list(): Promise<{ definition: InstanceDefinition; runtime: InstanceRuntimeState }[]>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  add(name: string, workspace: string): Promise<InstanceDefinition>;
  rename(oldName: string, newName: string): Promise<InstanceDefinition>;
}

export function createRealInstanceProvider(homeDir = homedir()): InstanceLifecycleProvider {
  const registry = createInstanceRegistry(homeDir);
  const daemon = createInstanceDaemon(homeDir, registry);

  const resolveDefinition = (name: string): InstanceDefinition => {
    const definition = registry.get(name);
    if (!definition) throw new Error(`Unknown instance: "${name}"`);
    return definition;
  };

  const createBoardToken = (): string =>
    resolveBoardToken({ OPENBOARD_API_TOKEN: process.env.OPENBOARD_API_TOKEN } as NodeJS.ProcessEnv);

  const ensureBoardToken = (definition: InstanceDefinition): InstanceDefinition => {
    if (definition.boardToken?.trim()) return definition;
    return registry.ensureBoardToken(definition.name, createBoardToken());
  };

  return {
    async list() {
      return Promise.all(
        registry.list().map(async (definition) => ({
          definition,
          runtime: await daemon.status(definition),
        })),
      );
    },
    async start(name) {
      const definition = ensureBoardToken(resolveDefinition(name));
      const runtime = await daemon.status(definition);
      if (runtime.status !== "running") await daemon.start(definition);
    },
    async stop(name) {
      await daemon.stop(resolveDefinition(name));
    },
    async remove(name) {
      const definition = resolveDefinition(name);
      const runtime = await daemon.status(definition);
      if (runtime.status === "running") throw new Error(`Cannot remove running instance: "${name}"`);
      registry.remove(name);
    },
    async add(name, workspace) {
      const validation = validateInstanceName(name);
      if (!validation.ok) throw new Error(validation.error);
      const instances = registry.list();
      const usedPorts = new Set(instances.flatMap((instance) => [instance.port, instance.opencodePort]).filter((port): port is number => port !== undefined));
      let port = 4097;
      while (usedPorts.has(port)) port += 1;
      const dirs = instanceDataDir(homeDir, validation.value);
      const definition: InstanceDefinition = {
        name: validation.value,
        port,
        workspace,
        dbPath: `${dirs.dataDir}/board.sqlite`,
        boardToken: createBoardToken(),
      };
      registry.add(definition);
      return definition;
    },
    async rename(oldName, newName) {
      return renameInstance(
        { homeDir, registry, daemon, prepareForStart: ensureBoardToken },
        oldName,
        newName,
      );
    },
  };
}

// ── Mock provider for tests ──────────────────────────────────────────────────────

/**
 * Mock lifecycle provider for headless tests. Holds state in memory and
 * simulates the daemon's behavior without I/O.
 */
export function createMockInstanceProvider(initialFile: InstancesFile = { version: 1, instances: [] }): InstanceLifecycleProvider & { _state: InstancesFile; _runtime: Map<string, InstanceRuntimeState> } {
  const runtime = new Map<string, InstanceRuntimeState>();
  let file = { ...initialFile, instances: [...initialFile.instances] };

  const buildRuntime = (def: InstanceDefinition): InstanceRuntimeState => {
    const existing = runtime.get(def.name);
    return existing ?? {
      status: "stopped",
      boardUrl: `http://127.0.0.1:${def.port}`,
      pid: undefined,
      startedAt: undefined,
    };
  };

  return {
    _state: file,
    _runtime: runtime,
    async list() {
      return file.instances.map((def) => ({ definition: def, runtime: buildRuntime(def) }));
    },
    async start(name) {
      const def = file.instances.find((i) => i.name === name);
      if (!def) throw new Error(`Unknown instance: "${name}"`);
      const rt = runtime.get(name) ?? { status: "stopped" as InstanceStatus, boardUrl: `http://127.0.0.1:${def.port}` };
      rt.status = "running";
      rt.pid = 12345;
      rt.startedAt = Date.now();
      runtime.set(name, rt);
    },
    async stop(name) {
      const rt = runtime.get(name);
      if (!rt) throw new Error(`Unknown instance: "${name}"`);
      rt.status = "stopped";
      rt.pid = undefined;
      rt.startedAt = undefined;
    },
    async remove(name) {
      const rt = runtime.get(name);
      if (rt?.status === "running") throw new Error(`Cannot remove running instance: "${name}"`);
      file.instances = file.instances.filter((i) => i.name !== name);
      runtime.delete(name);
    },
    async add(name, workspace) {
      const validation = validateInstanceName(name);
      if (!validation.ok) throw new Error(validation.error);
      if (file.instances.some((i) => i.name === name)) throw new Error(`Instance name collision: "${name}"`);
      const usedPorts = new Set(file.instances.map((i) => i.port));
      let port = 4097;
      while (usedPorts.has(port)) port++;
      const homeDir = process.env.HOME ?? "/home/user";
      const def: InstanceDefinition = {
        name: validation.value,
        port,
        workspace,
        dbPath: `${homeDir}/.local/share/openboard/${validation.value}/board.sqlite`,
        opencodePort: undefined,
      };
      file.instances.push(def);
      runtime.set(def.name, { status: "stopped", boardUrl: `http://127.0.0.1:${port}` });
      return def;
    },
    async rename(oldName, newName) {
      const validation = validateInstanceName(newName);
      if (!validation.ok) throw new Error(validation.error);
      const idx = file.instances.findIndex((i) => i.name === oldName);
      if (idx === -1) throw new InstanceUnknownError(oldName);
      if (file.instances.some((i) => i.name === validation.value)) throw new InstanceNameCollisionError(validation.value);

      const oldDef = file.instances[idx];
      const homeDir = process.env.HOME ?? "/home/user";
      const dirs = instanceDataDir(homeDir, validation.value);
      const newDef: InstanceDefinition = {
        ...oldDef,
        name: validation.value,
        dbPath: `${dirs.dataDir}/board.sqlite`,
      };
      file.instances[idx] = newDef;
      if (file.defaultInstance === oldName) file.defaultInstance = validation.value;

      const rt = runtime.get(oldName);
      if (rt) {
        runtime.delete(oldName);
        runtime.set(validation.value, rt);
      }
      return newDef;
    },
  };
}

// ── Instance status glyphs ───────────────────────────────────────────────────────

export const INSTANCE_STATUS_GLYPHS: Record<InstanceStatus, string> = {
  running: "●",
  stopped: "○",
  "stale-pid": "⚠",
  unhealthy: "!",
};

export function instanceStatusLabel(status: InstanceStatus): string {
  switch (status) {
    case "running":
      return "RUNNING";
    case "stopped":
      return "STOPPED";
    case "stale-pid":
      return "STALE";
    case "unhealthy":
      return "UNHEALTHY";
  }
}

// ── View state machine ───────────────────────────────────────────────────────────

export type TuiView = "launch" | "board" | "switcher" | "archive" | "workspaceGate" | "diff" | "follow" | "settings";

export interface ViewState {
  view: TuiView;
  previousView: TuiView | null;
}

export const initialViewState: ViewState = { view: "launch", previousView: null };

export function transitionView(state: ViewState, nextView: TuiView): ViewState {
  if (state.view === nextView) return state;
  return { view: nextView, previousView: state.view };
}

export function detachToLaunch(state: ViewState): ViewState {
  return { view: "launch", previousView: "board" };
}

export function openSwitcher(state: ViewState): ViewState {
  if (state.view === "switcher") return state;
  return { view: "switcher", previousView: state.view };
}

export function closeSwitcher(state: ViewState): ViewState {
  if (state.previousView) return { view: state.previousView, previousView: null };
  return { view: "board", previousView: null };
}

export function openArchive(state: ViewState): ViewState {
  if (state.view === "archive") return state;
  return { view: "archive", previousView: state.view };
}

export function closeArchive(state: ViewState): ViewState {
  if (state.previousView) return { view: state.previousView, previousView: null };
  return { view: "board", previousView: null };
}

export function openViewDiff(state: ViewState): ViewState {
  if (state.view === "diff") return state;
  return { view: "diff", previousView: state.view };
}

export function closeViewDiff(state: ViewState): ViewState {
  if (state.previousView) return { view: state.previousView, previousView: null };
  return { view: "board", previousView: null };
}

export function selectInstanceInSwitcher(state: ViewState): ViewState {
  const target = state.previousView === "launch" ? "launch" : "board";
  return { view: target, previousView: null };
}

// ── Workspace gate ──────────────────────────────────────────────────────────────

function unsafeWorkspacePaths(home = homedir()): Set<string> {
  const resolvedHome = resolve(home);
  return new Set([
    canonicalPath(resolvedHome),
    canonicalPath(resolve("/")),
    canonicalPath(resolve(resolvedHome, "Desktop")),
    canonicalPath(resolve(resolvedHome, "Downloads")),
  ]);
}

function canonicalPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Validate a first-run workspace directory. The gate intentionally rejects
 * broad personal folders so agents cannot be armed against an unsafe default.
 */
export function validateWorkspacePath(
  raw: string,
  cwd: string,
  home = homedir(),
): { ok: true; path: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "Please specify a directory path." };

  const expanded = expandHomePath(trimmed, home);
  const requested = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  const canonical = canonicalPath(requested);
  if (unsafeWorkspacePaths(home).has(canonical)) {
    return { ok: false, error: "Cannot use home, root, Desktop, or Downloads as a board workspace." };
  }

  if (!existsSync(requested)) {
    return { ok: false, error: `Directory does not exist: ${shortPath(requested)}` };
  }

  if (!statSync(requested).isDirectory()) {
    return { ok: false, error: `Not a directory: ${shortPath(requested)}` };
  }

  return { ok: true, path: canonical };
}

export function expandHomePath(path: string, home = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return `${home}/${path.slice(2)}`;
  return path;
}

export function isProjectLike(path: string): boolean {
  const canonical = canonicalPath(path);
  if (unsafeWorkspacePaths().has(canonical)) return false;
  if (!existsSync(path) || !statSync(path).isDirectory()) return false;

  return [
    ".git",
    "package.json",
    "Cargo.toml",
    "go.mod",
    "Makefile",
    "pyproject.toml",
    "Gemfile",
    "CMakeLists.txt",
  ].some((marker) => existsSync(join(path, marker)));
}

export function workspaceToInstanceName(workspace: string): string {
  return (
    basename(workspace)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "openboard"
  );
}

// ── Instance list helpers ────────────────────────────────────────────────────────

export interface InstanceListItem {
  definition: InstanceDefinition;
  runtime: InstanceRuntimeState;
  cardCount: number | null; // null = not fetched / not running
  cardCountError?: string;
}

export const TUI_COLUMN_LABELS: Record<Column, string> = {
  todo: "To-Do",
  in_progress: "In-Progress",
  review: "Review",
  done: "Done",
};

export const TUI_COLUMNS: Column[] = ["todo", "in_progress", "review", "done"];

export function tasksByColumn(tasks: Task[]): Record<Column, Task[]> {
  const grouped: Record<Column, Task[]> = {
    todo: [],
    in_progress: [],
    review: [],
    done: [],
  };

  for (const task of tasks) {
    grouped[task.column].push(task);
  }

  for (const column of TUI_COLUMNS) {
    grouped[column].sort((a, b) => a.position - b.position || a.createdAt - b.createdAt);
  }

  return grouped;
}

export function orderedTasks(tasks: Task[]): Task[] {
  const grouped = tasksByColumn(tasks);
  return TUI_COLUMNS.flatMap((column) => grouped[column]);
}

export function nextTaskId(tasks: Task[], selectedTaskId: string | undefined, delta: number): string | undefined {
  const ordered = orderedTasks(tasks);
  if (ordered.length === 0) return undefined;

  const current = selectedTaskId ? ordered.findIndex((task) => task.id === selectedTaskId) : -1;
  if (current === -1) {
    // Selection is missing or filtered out of `tasks` — land on the first
    // (down) or last (up) visible task instead of skipping one (P3-7).
    return delta > 0 ? ordered[0]?.id : ordered[ordered.length - 1]?.id;
  }
  const next = (current + delta + ordered.length) % ordered.length;
  return ordered[next]?.id;
}

export interface AdjacentLaneSelection {
  taskId: string | undefined;
  column: Column | undefined;
  moved: boolean;
  status?: string;
}

export interface AdjacentLaneSelectionOptions {
  laneOffsets?: Partial<Record<Column, number>>;
  laneCapacity?: (column: Column, total: number) => number;
  /** One-row children painted before a lane's overflow indicator and cards. */
  laneLeadingRows?: (column: Column, total: number) => number;
}

export function adjacentLaneSelection(
  tasks: Task[],
  selectedTaskId: string | undefined,
  delta: number,
  options: AdjacentLaneSelectionOptions = {},
): AdjacentLaneSelection {
  const grouped = tasksByColumn(tasks);
  const ordered = orderedTasks(tasks);
  if (ordered.length === 0) {
    return { taskId: undefined, column: undefined, moved: false, status: "no cards visible" };
  }

  const selected = selectedTaskId ? tasks.find((task) => task.id === selectedTaskId) : undefined;
  const fallbackTask = selected ?? (delta >= 0 ? ordered[0] : ordered[ordered.length - 1]);
  const currentColumnIndex = selected ? TUI_COLUMNS.indexOf(selected.column) : delta >= 0 ? -1 : TUI_COLUMNS.length;
  const targetColumnIndex = currentColumnIndex + (delta >= 0 ? 1 : -1);

  if (targetColumnIndex < 0 || targetColumnIndex >= TUI_COLUMNS.length) {
    return {
      taskId: fallbackTask?.id,
      column: fallbackTask?.column,
      moved: false,
      status: fallbackTask ? `Already at ${TUI_COLUMN_LABELS[fallbackTask.column]} lane` : "no cards visible",
    };
  }

  const targetColumn = TUI_COLUMNS[targetColumnIndex];
  const targetTasks = grouped[targetColumn];
  if (targetTasks.length === 0) {
    return {
      taskId: fallbackTask?.id,
      column: targetColumn,
      moved: false,
      status: `${TUI_COLUMN_LABELS[targetColumn]} lane is empty`,
    };
  }

  const capacityFor = (column: Column, total: number): number => {
    const capacity = options.laneCapacity?.(column, total) ?? total;
    return Math.max(0, Math.trunc(capacity));
  };
  const leadingRowsFor = (column: Column, total: number): number =>
    Math.max(0, Math.trunc(options.laneLeadingRows?.(column, total) ?? 0));
  const offsetFor = (column: Column, selectedIndex: number, total: number): number =>
    reconcileLaneOffset(options.laneOffsets?.[column] ?? 0, selectedIndex, total, capacityFor(column, total));

  const selectedColumnTasks = selected ? grouped[selected.column] : [];
  const selectedIndex = selected ? selectedColumnTasks.findIndex((task) => task.id === selected.id) : -1;
  const sourceOffset = selected && selectedIndex >= 0 ? offsetFor(selected.column, selectedIndex, selectedColumnTasks.length) : 0;
  const sourceCapacity = selected ? capacityFor(selected.column, selectedColumnTasks.length) : selectedColumnTasks.length;
  const selectedCardRow = selected && selectedIndex >= 0
    ? Math.min(Math.max(0, selectedIndex - sourceOffset), Math.max(0, sourceCapacity - 1))
    : 0;
  // Preserve the nearest terminal row, accounting for the fact that indicator
  // children are one row while cards are cardHeight rows. Treating both as one
  // ordinal slot can move the selection farther away than leaving the card
  // index unchanged.
  const childGap = TUI_LAYOUT.laneGap;
  const cardStride = TUI_LAYOUT.cardHeight + childGap;
  const chromeHeight = (column: Column, total: number, offset: number): number =>
    leadingRowsFor(column, total) * (1 + childGap) + (offset > 0 ? 1 + childGap : 0);
  const selectedRenderedTop = selected && selectedIndex >= 0
    ? chromeHeight(selected.column, selectedColumnTasks.length, sourceOffset) + selectedCardRow * cardStride
    : 0;
  const targetOffset = offsetFor(targetColumn, -1, targetTasks.length);
  const targetChromeHeight = chromeHeight(targetColumn, targetTasks.length, targetOffset);
  const targetCardRow = Math.max(0, Math.round((selectedRenderedTop - targetChromeHeight) / cardStride));
  const targetVisibleCount = Math.max(1, Math.min(capacityFor(targetColumn, targetTasks.length), targetTasks.length - targetOffset));
  const targetIndex = Math.min(targetTasks.length - 1, targetOffset + Math.min(targetCardRow, targetVisibleCount - 1));
  const target = targetTasks[targetIndex];
  return { taskId: target?.id, column: targetColumn, moved: Boolean(target) };
}

export function nearestTaskInColumn(
  tasks: Task[],
  selectedTaskId: string | undefined,
  delta: number,
): string | undefined {
  return adjacentLaneSelection(tasks, selectedTaskId, delta).taskId;
}

export function runStateLabel(runState: TaskRunState): string {
  switch (runState) {
    case "running":
      return "RUNNING";
    case "idle":
      return "READY";
    case "error":
      return "ERROR";
    case "unstarted":
      return "QUEUED";
  }
}

export function runStateGlyph(runState: TaskRunState): string {
  switch (runState) {
    case "running":
      return "●";
    case "idle":
      return "○";
    case "error":
      return "!";
    case "unstarted":
      return "○";
  }
}

/**
 * The glyph + label a card shows, resolved from run state, column, and any pending
 * decision — so a Review-column card reads `▲ REVIEW` and a Done card `○ DONE`,
 * not the raw run-state label. Glyphs match the OpenBoard set (`○ △ ▲ ● !`).
 */
export function taskStatus(task: Pick<Task, "runState" | "column" | "pending">): {
  glyph: string;
  label: string;
} {
  if (task.runState === "error") return { glyph: "!", label: "ERROR" };
  if (task.pending === "git-init") return { glyph: "△", label: "BLOCKED" };
  if (task.pending === "base-checkout-escape") return { glyph: "△", label: "BLOCKED" };
  if (task.pending === "rebase-conflict") return { glyph: "△", label: "BLOCKED" };
  if (task.runState === "running") return { glyph: "●", label: "RUNNING" };
  if (task.column === "done") return { glyph: "○", label: "DONE" };
  if (task.column === "review") return { glyph: "▲", label: "REVIEW" };
  if (task.runState === "idle") return { glyph: "○", label: "READY" };
  return { glyph: "○", label: "QUEUED" };
}

/**
 * The fixed chrome the TUI spends around lane cards, in rows. The render code
 * (renderApp / renderColumn / renderTask in index.ts) reads its box props from
 * these same values, so the windowing math below can never drift from the
 * painted layout. `laneBorder` mirrors the lane Box's `border: true` (1 row per
 * edge) — if a lane ever drops its border, set it to 0 here too.
 */
export const TUI_LAYOUT = {
  // Slim 1-row header in board view; the wordmark only renders in the launch view.
  headerHeight: 1,
  commandStripHeight: 4,
  rootPadding: 1,
  rootGap: 1,
  laneBorder: 1,
  lanePadding: 1,
  laneGap: 1,
  cardHeight: 8,
} as const;

export const TUI_MIN_SIZE = {
  columns: 160,
  rows: 30,
} as const;

/**
 * Rows available for cards inside a lane. The root column stacks
 * header / main / command strip with `rootPadding` and two `rootGap` seams,
 * and each lane spends its border and padding on both edges.
 */
export function laneInnerHeight(terminalRows: number): number {
  const rootChrome =
    2 * TUI_LAYOUT.rootPadding +
    2 * TUI_LAYOUT.rootGap +
    TUI_LAYOUT.headerHeight +
    TUI_LAYOUT.commandStripHeight;
  const laneChrome = 2 * (TUI_LAYOUT.laneBorder + TUI_LAYOUT.lanePadding);
  return terminalRows - rootChrome - laneChrome;
}

export function archiveListCapacity(terminalRows: number): number {
  const rootChrome =
    2 * TUI_LAYOUT.rootPadding +
    2 * TUI_LAYOUT.rootGap +
    TUI_LAYOUT.headerHeight +
    TUI_LAYOUT.commandStripHeight;
  const panelChrome = 2 + 2 + 1; // border, padding, filter/search row
  return Math.max(1, terminalRows - rootChrome - panelChrome);
}

export function archiveListWindow(
  selectedIndex: number,
  totalRecords: number,
  terminalRows: number,
): { offset: number; capacity: number } {
  const rawCapacity = archiveListCapacity(terminalRows);
  const capacity = Math.min(totalRecords, totalRecords > rawCapacity ? Math.max(1, rawCapacity - 2) : rawCapacity);
  if (totalRecords <= 0 || capacity <= 0) return { offset: 0, capacity: 0 };

  const selected = Math.min(Math.max(0, selectedIndex), totalRecords - 1);
  const maxOffset = Math.max(0, totalRecords - capacity);
  const offset = Math.min(Math.max(0, selected - capacity + 1), maxOffset);
  return { offset, capacity };
}

/**
 * Whether the sidebar can afford its two-line label-over-value detail style.
 * Expanded spends 2 rows on the title, 2 per detail, 2 on the key hints, and a
 * 1-row gap between every child (details, spacer, hints); an error adds the
 * compact red error notice plus its gap. When that doesn't fit, compact mode drops to
 * single-line `LABEL value` rows grouped without gaps — the card-meta style —
 * so labels and values can't collide at short terminal heights.
 */
export function sidebarDetailMode(
  innerHeight: number,
  detailCount: number,
  hasError: boolean,
): "expanded" | "compact" {
  const expandedRows = 3 * detailCount + 7 + (hasError ? 7 : 0);
  return expandedRows <= innerHeight ? "expanded" : "compact";
}

/**
 * How many cards a lane can paint in `innerHeight` rows. Cards are `cardHeight`
 * tall with a `laneGap` seam between children. `leadingRows` accounts for
 * one-row children painted before the cards (for example Review's NEEDS ANSWER
 * indicator), including each child's following gap. When the full list doesn't
 * fit, two 1-row overflow slots (`↑ n more` / `↓ n more`) join the column — both
 * are always reserved under overflow so capacity stays stable while the window
 * slides. Always at least 1 so the selected card can render.
 */
export function laneCapacity(innerHeight: number, total: number, cardHeight: number, leadingRows = 0): number {
  const gap = TUI_LAYOUT.laneGap;
  if (total <= 0) return 0;
  const leadingBudget = Math.max(0, Math.trunc(leadingRows)) * (1 + gap);
  const cardBudget = innerHeight - leadingBudget;
  if (total * (cardHeight + gap) - gap <= cardBudget) return total;
  const budget = cardBudget - 2 * (1 + gap);
  return Math.max(1, Math.floor((budget + gap) / (cardHeight + gap)));
}

/**
 * Slide a lane's scroll offset the minimum distance needed to keep the selected
 * card inside the visible window, clamped to the valid range. `selectedIndex`
 * is -1 when the selection lives in another lane — the offset only clamps.
 */
export function reconcileLaneOffset(
  offset: number,
  selectedIndex: number,
  total: number,
  capacity: number,
): number {
  const maxOffset = Math.max(0, total - capacity);
  let next = Math.min(Math.max(offset, 0), maxOffset);
  if (selectedIndex >= 0 && capacity > 0) {
    if (selectedIndex < next) next = selectedIndex;
    else if (selectedIndex >= next + capacity) next = selectedIndex - capacity + 1;
  }
  return next;
}

/**
 * Compact elapsed-run duration in the design mock's format: `42s` under a
 * minute, `4m 12s` under an hour (seconds zero-padded), `1h 04m` beyond.
 * Negative or absurd inputs (clock skew) clamp to `0s`.
 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

// ── Board filter (F/f) ───────────────────────────────────────────────────────────

/** Filter categories offered by the selected-column filter picker. */
export type BoardFilterKind = "worktree" | "manual" | "agent";

export interface BoardFilter {
  kind: BoardFilterKind;
  value: string;
}

export function boardFilterCategories(): Array<{ kind: BoardFilterKind; label: string }> {
  return [
    { kind: "worktree", label: "Worktree" },
    { kind: "manual", label: "Manual" },
    { kind: "agent", label: "Agent" },
  ];
}

/** The worktree identity a card filters by: prefer the branch, fall back to the path. Unset for cards with no worktree. */
export function taskWorktreeFilterValue(task: Pick<Task, "worktreeBranch" | "worktreePath">): string | undefined {
  return task.worktreeBranch || task.worktreePath || undefined;
}

/** The manual assignee a card filters by. Manual cards with no assignee still group under "unassigned". */
export function taskManualFilterValue(task: Pick<Task, "type" | "assignedTo">): string | undefined {
  if (task.type !== "manual") return undefined;
  return task.assignedTo?.trim() || "unassigned";
}

/** The agent/harness label a card filters by. Claude Code cards group by harness; OpenCode cards by roster agent id. */
export function taskAgentFilterValue(task: Pick<Task, "type" | "harness" | "agent">): string | undefined {
  if (task.type === "manual") return undefined;
  if (task.harness && task.harness !== "opencode") return task.harness;
  return task.agent?.trim() || "unassigned";
}

function taskFilterValue(task: Task, kind: BoardFilterKind): string | undefined {
  switch (kind) {
    case "worktree":
      return taskWorktreeFilterValue(task);
    case "manual":
      return taskManualFilterValue(task);
    case "agent":
      return taskAgentFilterValue(task);
  }
}

/** Live, deduped, sorted values for a filter category, gathered from the current cards/sessions. */
export function boardFilterOptions(tasks: Task[], kind: BoardFilterKind): string[] {
  const values = tasks.map((task) => taskFilterValue(task, kind)).filter((value): value is string => Boolean(value));
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function taskMatchesBoardFilter(task: Task, filter: BoardFilter | undefined): boolean {
  if (!filter) return true;
  return taskFilterValue(task, filter.kind) === filter.value;
}

export function filterTasks(tasks: Task[], filter: BoardFilter | undefined): Task[] {
  if (!filter) return tasks;
  return tasks.filter((task) => taskMatchesBoardFilter(task, filter));
}

export function modelLabel(model: ModelRef | undefined): string {
  if (!model) return "agent default";
  return `${model.providerID}/${model.id}${model.variant ? `:${model.variant}` : ""}`;
}

export function agentLabel(task: Pick<Task, "agent" | "model">, agents: RosterAgent[]): string {
  if (task.agent) return task.agent;
  const matchingAgent = agents.find((agent) => {
    if (!agent.model || !task.model) return false;
    return agent.model.providerID === task.model.providerID && agent.model.id === task.model.id;
  });
  return matchingAgent?.id ?? "unassigned";
}

export function shortPath(path: string, home = process.env.HOME): string {
  if (home && path === home) return "~";
  if (home && path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  return path;
}

export function truncateText(value: string, maxLength: number): string {
  if (maxLength <= 1) return value.slice(0, maxLength);
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

export function middleEllipsize(value: string, maxLength: number): string {
  const width = Math.max(0, Math.trunc(maxLength));
  if (width === 0) return "";
  if (value.length <= width) return value;
  if (width === 1) return "…";

  const tailLength = Math.max(1, Math.min(value.length - 1, Math.ceil((width - 1) / 2)));
  const headLength = Math.max(0, width - 1 - tailLength);
  return `${value.slice(0, headLength)}…${value.slice(value.length - tailLength)}`;
}
