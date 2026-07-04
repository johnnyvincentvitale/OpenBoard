#!/usr/bin/env node
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createBoardClient } from "../client/board-client";
import type { BoardClient } from "../client/board-client";
import type { Column, CompletionReport, ModelRef, RosterAgent, Task, TaskIsolationMode } from "../shared";
import { validateInstanceName } from "../shared/instances";
import { assertOpenTuiRuntime } from "./runtime";
import {
  TUI_COLUMN_LABELS,
  TUI_COLUMNS,
  TUI_LAYOUT,
  agentLabel,
  formatElapsed,
  modelLabel,
  laneCapacity,
  laneInnerHeight,
  nearestTaskInColumn,
  nextTaskId,
  reconcileLaneOffset,
  shortPath,
  sidebarDetailMode,
  taskStatus,
  tasksByColumn,
  // Instance-related exports
  InstanceLifecycleProvider,
  createRealInstanceProvider,
  TuiView,
  ViewState,
  initialViewState,
  transitionView,
  detachToLaunch,
  openSwitcher,
  closeSwitcher,
  openArchive as openArchiveView,
  closeArchive as closeArchiveView,
  selectInstanceInSwitcher,
  InstanceListItem,
  INSTANCE_STATUS_GLYPHS,
  instanceStatusLabel,
  validateWorkspacePath,
  isProjectLike,
  workspaceToInstanceName,
} from "./model";
import { createRootLifecycle } from "./root-lifecycle";
import { buildWordmarkRows } from "./wordmark";
import { RGBA, type KeyEvent, type VChild } from "@opentui/core";

type OpenTui = typeof import("@opentui/core");
type TuiColor = string | RGBA;

const ROOT_ID = "openboard-root";
const POLL_INTERVAL_MS = 2500;
const WORDMARK_WIDTH = 45;
const WORDMARK_HEIGHT = 6;
const SIDEBAR_WIDTH = 44;
const LANE_MIN_WIDTH = 20;
// Over-long on purpose: Text truncates it to each container's inner width, giving a
// full-bleed rule without measuring the lane.
const HAIRLINE = "─".repeat(64);
const IS_TMUX = Boolean(process.env.TMUX);
// Colorway: rich truecolor is the default everywhere now, including under tmux.
// ~/.tmux.conf no longer advertises RGB, so tmux is an honest 256-color surface and
// downsamples any 24-bit color the app emits — no artifacts. The indexed-color palette
// stays as an explicit opt-in (OPENBOARD_TUI_SAFE=1) but no longer auto-engages in tmux.
const SAFE_COLOR_MODE = process.env.OPENBOARD_TUI_SAFE === "1";
// Screen handling is a separate, tmux-only guard against an alternate-buffer black-screen
// bug — independent of the color path, so it stays keyed to tmux.
const SCREEN_MODE = IS_TMUX ? "main-screen" : "alternate-screen";
const ARCHIVE_READER_MAX_BUFFER = 16 * 1024 * 1024;

export function boardApiFetchInit(init: RequestInit = {}, boardToken = process.env.OPENBOARD_API_TOKEN): RequestInit {
  const token = boardToken?.trim();
  if (!token) return init;

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers };
}

export async function readGlobalArchiveWithoutBoard(options: ArchiveReaderOptions = {}): Promise<GlobalArchiveRecord[]> {
  const env = options.env ?? process.env;
  const nodeExec = options.nodeExec ?? env.OPENBOARD_NODE_EXEC?.trim() ?? process.execPath;
  const script = `
const fs = require("node:fs");
const os = require("node:os");
const Database = require("better-sqlite3");

const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
const dbPath = (process.env.OPENBOARD_ARCHIVE_DB || "").trim() || home + "/.local/share/openboard/archive.sqlite";

if (!fs.existsSync(dbPath)) {
  process.stdout.write("[]");
  process.exit(0);
}

let db;
try {
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const rows = db.prepare("SELECT * FROM global_archive ORDER BY archived_at DESC").all();
  process.stdout.write(JSON.stringify(rows));
} catch (error) {
  if (String(error && error.message || error).includes("no such table: global_archive")) {
    process.stdout.write("[]");
  } else {
    throw error;
  }
} finally {
  if (db) db.close();
}
`;

  const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      nodeExec,
      ["-e", script],
      {
        cwd: options.cwd ?? process.cwd(),
        env,
        maxBuffer: ARCHIVE_READER_MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });

  const records = JSON.parse(stdout || "[]") as unknown;
  if (!Array.isArray(records)) throw new Error("archive reader returned invalid data");
  return records as GlobalArchiveRecord[];
}

async function fetchArchiveRecords(boardUrl: string, boardToken?: string): Promise<GlobalArchiveRecord[]> {
  const response = await fetch(`${boardUrl}/api/archive`, boardApiFetchInit({}, boardToken));
  if (!response.ok) throw new Error(`archive fetch failed (${response.status})`);
  return (await response.json()) as GlobalArchiveRecord[];
}

interface TuiColors {
  bg: TuiColor;
  panel: TuiColor;
  panelRaised: TuiColor;
  border: TuiColor;
  hairline: TuiColor;
  borderHot: TuiColor;
  text: TuiColor;
  bright: TuiColor;
  muted: TuiColor;
  dim: TuiColor;
  accent: TuiColor;
  accentBright: TuiColor;
  logo: TuiColor;
  logoDark: TuiColor;
  laneTodo: TuiColor;
  laneInProgress: TuiColor;
  laneReview: TuiColor;
  laneDone: TuiColor;
  laneError: TuiColor;
}

const TRUECOLOR_COLORS: TuiColors = {
  bg: "#0c0c0b",
  panel: "#0c0c0b",
  panelRaised: "#191918",
  border: "#2e2e2b",
  hairline: "#262624",
  borderHot: "#3f5e52",
  text: "#d0ccca",
  bright: "#ffffff",
  muted: "#6e6c6c",
  dim: "#383836",
  accent: "#3f5e52",
  accentBright: "#4a6e60",
  logo: "#5b8a78",
  logoDark: "#2e453c",
  // Lane hues carry real chroma on purpose: the original design-kit values
  // (#4d6486/#837d6e/#695c86/#3f5e52/#723b3a) were so desaturated that tan and
  // brick collapsed into gray at 1 cell wide on the near-black ground — only
  // ~3 of 5 hues were distinguishable on screen during review (2026-07-03).
  laneTodo: "#5b7cb8",
  laneInProgress: "#ad8a55",
  laneReview: "#8570ad",
  laneDone: "#4e8767",
  laneError: "#a84744",
};

const INDEXED_COLORS: TuiColors = {
  bg: RGBA.fromIndex(0),
  panel: RGBA.fromIndex(0),
  panelRaised: RGBA.fromIndex(236),
  border: RGBA.fromIndex(238),
  hairline: RGBA.fromIndex(238),
  borderHot: RGBA.fromIndex(66),
  text: RGBA.fromIndex(252),
  bright: RGBA.fromIndex(15),
  muted: RGBA.fromIndex(244),
  dim: RGBA.fromIndex(238),
  accent: RGBA.fromIndex(66),
  accentBright: RGBA.fromIndex(72),
  logo: RGBA.fromIndex(72),
  logoDark: RGBA.fromIndex(23),
  laneTodo: RGBA.fromIndex(68),
  laneInProgress: RGBA.fromIndex(179),
  laneReview: RGBA.fromIndex(140),
  laneDone: RGBA.fromIndex(71),
  laneError: RGBA.fromIndex(167),
};

const COLORS = SAFE_COLOR_MODE ? INDEXED_COLORS : TRUECOLOR_COLORS;

const WORDMARK_ROWS = buildWordmarkRows(
  {
    openMain: COLORS.bright,
    openDark: COLORS.dim,
    boardMain: COLORS.logo,
    boardDark: COLORS.logoDark,
    ground: COLORS.bg,
  },
  SAFE_COLOR_MODE,
);

function boxBg(color: TuiColor): { backgroundColor: TuiColor } | Record<string, never> {
  return SAFE_COLOR_MODE ? {} : { backgroundColor: color };
}

function textBg(color: TuiColor): { bg: TuiColor } | Record<string, never> {
  return SAFE_COLOR_MODE ? {} : { bg: color };
}

const FIELD_ORDER = ["title", "description", "agent", "model", "directory", "isolation"] as const;
type Overlay = "none" | "help" | "newTask" | "addInstance" | "renameInstance";
type NewTaskField = (typeof FIELD_ORDER)[number];
type AddInstanceField = "name" | "workspace";
type RenameInstanceField = "newName";

interface GlobalArchiveRecord {
  source_instance_name: string | null;
  source_port: number;
  source_workspace: string;
  source_db_path: string;
  task_id: string;
  title: string;
  description: string;
  directory: string;
  agent: string | null;
  model: string | null;
  isolation: string | null;
  column_name: string;
  run_state: string;
  run_started_at: number | null;
  error: string | null;
  session_id: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
  base_branch: string | null;
  completion: string | null;
  completion_source: string | null;
  archived_at: number;
  task_created_at: number;
  task_updated_at: number;
  mirrored_at: number;
}

interface ArchiveReaderOptions {
  env?: NodeJS.ProcessEnv;
  nodeExec?: string;
  cwd?: string;
}

interface NewTaskDraft {
  title: string;
  description: string;
  directory: string;
  agentId: string;
  model?: ModelRef;
  isolation: TaskIsolationMode;
  field: NewTaskField;
  submitting: boolean;
  error?: string;
}

interface AddInstanceDraft {
  name: string;
  workspace: string;
  field: AddInstanceField;
  submitting: boolean;
  error?: string;
}

interface RenameInstanceDraft {
  oldName: string;
  newName: string;
  field: RenameInstanceField;
  submitting: boolean;
  error?: string;
}

interface ArchiveState {
  records: GlobalArchiveRecord[];
  selectedIndex: number;
  searchQuery: string;
  searchMode: boolean;
  instanceFilter: string | null;
  laneFilter: string | null;
  refreshing: boolean;
  detailTab: "prompt" | "handoff";
}

interface TuiState {
  tasks: Task[];
  agents: RosterAgent[];
  boardUrl: string;
  selectedTaskId?: string;
  status: string;
  error?: string;
  refreshing: boolean;
  lastRefresh?: Date;
  cwd: string;
  overlay: Overlay;
  newTask?: NewTaskDraft;
  addInstance?: AddInstanceDraft;
  renameInstance?: RenameInstanceDraft;
  archive?: ArchiveState;
  archiveBoardUrl?: string;
  terminalRows: number;
  laneOffsets: Record<Column, number>;
  // Instance management
  viewState: ViewState;
  instanceProvider: InstanceLifecycleProvider;
  instanceList: InstanceListItem[];
  selectedInstanceIndex: number;
  fetchingCardCounts: Set<string>;
  switcherSelectedIndex: number;
  confirmRemoveName?: string;
  detailTab?: "prompt" | "handoff";
  moveTargetColumn?: Column;
  workspaceGateInput: string;
  workspaceGateError?: string;
  workspaceGateSubmitting: boolean;
}

interface TuiActions {
  refresh: (quiet?: boolean) => Promise<void>;
  render: () => void;
  shutdown: () => void;
  runAction: (label: string, action: (task: Task) => Promise<unknown>) => Promise<void>;
  client: BoardClient;
  archiveTask: (taskId: string) => Promise<void>;
  // Instance actions
  attachInstance: (item: InstanceListItem) => Promise<void>;
  detachInstance: () => Promise<void>;
  startInstance: (name: string) => Promise<void>;
  stopInstance: (name: string) => Promise<void>;
  removeInstance: (name: string) => Promise<void>;
  addInstance: (name: string, workspace: string) => Promise<void>;
  renameInstance: (oldName: string, newName: string) => Promise<void>;
  refreshInstanceList: () => Promise<void>;
  fetchCardCount: (item: InstanceListItem) => Promise<void>;
  openArchive: () => Promise<void>;
  closeArchive: () => void;
  refreshArchive: () => Promise<void>;
  setupWorkspace: () => Promise<void>;
}

export async function runOpenBoardTui(
  client: BoardClient = createBoardClient(resolveInitialClientOptions(process.env)),
  instanceProvider?: InstanceLifecycleProvider
): Promise<void> {
  assertOpenTuiRuntime();

  const ui = await import("@opentui/core");
  resetTerminalModes({ clear: true });
  const renderer = await ui.createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 30,
    screenMode: SCREEN_MODE,
    backgroundColor: SAFE_COLOR_MODE ? undefined : COLORS.bg,
  });
  (renderer as unknown as { setMaxListeners?: (count: number) => void }).setMaxListeners?.(100);
  renderer.setTerminalTitle("OpenBoard");
  if (!SAFE_COLOR_MODE) renderer.setBackgroundColor(COLORS.bg);

  const provider = instanceProvider ?? createRealInstanceProvider();
  const initialAttach = hasInitialAttachTarget(process.env);

  const state: TuiState = {
    tasks: [],
    agents: [],
    boardUrl: client.boardUrl,
    status: `connected to ${client.boardUrl}`,
    refreshing: false,
    cwd: client.cwd,
    overlay: "none",
    terminalRows: renderer.terminalHeight,
    laneOffsets: { todo: 0, in_progress: 0, review: 0, done: 0 },
    viewState: initialAttach ? transitionView(initialViewState, "board") : initialViewState,
    instanceProvider: provider,
    instanceList: [],
    selectedInstanceIndex: 0,
    fetchingCardCounts: new Set(),
    switcherSelectedIndex: 0,
    workspaceGateInput: "",
    workspaceGateSubmitting: false,
  };

  let refreshTimer: NodeJS.Timeout | undefined;
  let shuttingDown = false;
  let currentClient = client;
  let currentBoardToken = process.env.OPENBOARD_API_TOKEN?.trim() || undefined;

  const setError = (error: unknown, status = "TUI error") => {
    state.error = errorMessage(error);
    state.status = status;
  };

  const { destroyRoot, mountRoot } = createRootLifecycle<VChild>(ROOT_ID, renderer.root);

  const destroyRenderer = () => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
    state.archiveBoardUrl = undefined;
    destroyRoot();
    renderer.destroy();
    restoreTerminalForShell();
  };

  const removeFatalHandlers = installFatalHandlers((error) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      destroyRenderer();
    } catch {
      restoreTerminalForShell();
    }
    reportFatalError(error);
    process.exit(1);
  });

  const render = () => {
    if (shuttingDown) return;

    try {
      resetTerminalModes();
      state.terminalRows = renderer.terminalHeight;
      mountRoot(renderApp(ui, state));
      renderer.requestRender();
    } catch (error) {
      setError(error, "render failed");
      try {
        mountRoot(renderFallbackApp(ui, state));
      } catch {
        try {
          destroyRoot();
        } catch {
        }
      }
      renderer.requestRender();
    }
  };

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    removeFatalHandlers();
    destroyRenderer();
    process.exit(0);
  };

  const refresh = async (quiet = false) => {
    if (state.refreshing) return;
    state.refreshing = true;
    if (!quiet) {
      state.status = "refreshing board...";
      render();
    }

    try {
      const [tasks, agents] = await Promise.all([currentClient.listTasks(), currentClient.listAgents()]);
      state.tasks = tasks;
      state.agents = agents;
      state.selectedTaskId = resolveSelectedTaskId(tasks, state.selectedTaskId);
      state.error = undefined;
      state.status = tasks.length === 0 ? "board is empty" : `${tasks.length} task${tasks.length === 1 ? "" : "s"}`;
      state.lastRefresh = new Date();
    } catch (error) {
      state.error = errorMessage(error);
      state.status = "board unavailable";
    } finally {
      state.refreshing = false;
      render();
    }
  };

  const runAction = async (label: string, action: (task: Task) => Promise<unknown>) => {
    const task = selectedTask(state);
    if (!task) {
      state.status = "no task selected";
      render();
      return;
    }

    state.status = `${label}: ${task.title}`;
    state.error = undefined;
    render();

    try {
      await action(task);
      state.status = `${label} complete: ${task.title}`;
      await refresh(true);
    } catch (error) {
      state.error = errorMessage(error);
      state.status = `${label} failed`;
      render();
    }
  };

  const attachInstance = async (item: InstanceListItem) => {
    state.status = `attaching to ${item.definition.name}...`;
    render();

    try {
      if (item.runtime.status !== "running") {
        await state.instanceProvider.start(item.definition.name);
        await refreshInstanceList();
        item = state.instanceList.find((candidate) => candidate.definition.name === item.definition.name) ?? item;
      }
      const boardToken = item.definition.boardToken?.trim() || process.env.OPENBOARD_API_TOKEN?.trim() || undefined;
      const newClient = createBoardClient({
        boardUrl: item.runtime.boardUrl,
        cwd: item.definition.workspace,
        env: { OPENBOARD_API_TOKEN: boardToken },
      });
      await newClient.listTasks();
      currentClient = newClient;
      currentBoardToken = boardToken;
      state.boardUrl = item.runtime.boardUrl;
      state.cwd = item.definition.workspace;
      state.tasks = [];
      state.agents = [];
      state.selectedTaskId = undefined;
      state.viewState = transitionView(state.viewState, "board");
      state.status = `attached to ${item.definition.name} (${item.runtime.boardUrl})`;
      await refresh();
    } catch (error) {
      state.error = errorMessage(error);
      state.status = `attach failed: ${errorMessage(error)}`;
      render();
    }
  };

  const detachInstance = async () => {
    state.viewState = detachToLaunch(state.viewState);
    state.tasks = [];
    state.agents = [];
    state.selectedTaskId = undefined;
    state.status = "detached; back to instance list";
    render();
  };

  const startInstance = async (name: string) => {
    state.status = `starting ${name}...`;
    render();
    try {
      await state.instanceProvider.start(name);
      await refreshInstanceList();
      state.status = `started ${name}`;
    } catch (error) {
      state.error = errorMessage(error);
      state.status = `start failed`;
    }
    render();
  };

  const stopInstance = async (name: string) => {
    state.status = `stopping ${name}...`;
    render();
    try {
      await state.instanceProvider.stop(name);
      await refreshInstanceList();
      state.status = `stopped ${name}`;
    } catch (error) {
      state.error = errorMessage(error);
      state.status = `stop failed`;
    }
    render();
  };

  const removeInstance = async (name: string) => {
    state.status = `removing ${name}...`;
    render();
    try {
      await state.instanceProvider.remove(name);
      state.confirmRemoveName = undefined;
      await refreshInstanceList();
      state.status = `removed ${name}`;
    } catch (error) {
      state.error = errorMessage(error);
      state.status = `remove failed`;
    }
    render();
  };

  const addInstance = async (name: string, workspace: string) => {
    state.status = `adding ${name}...`;
    render();
    try {
      await state.instanceProvider.add(name, workspace);
      state.overlay = "none";
      state.addInstance = undefined;
    } catch (error) {
      if (state.addInstance) state.addInstance.error = errorMessage(error);
      state.status = `add failed`;
      render();
      return;
    }
    // Adding an instance is a declaration of intent to use it — start it
    // immediately; a start failure is reported without undoing the add.
    try {
      state.status = `added ${name}, starting...`;
      render();
      await state.instanceProvider.start(name);
      await refreshInstanceList();
      state.status = `added ${name} (running)`;
    } catch (error) {
      await refreshInstanceList();
      state.status = `added ${name}; start failed: ${errorMessage(error)}`;
    }
    render();
  };

  const renameInstance = async (oldName: string, newName: string) => {
    state.status = `renaming ${oldName}...`;
    render();
    try {
      await state.instanceProvider.rename(oldName, newName);
      state.overlay = "none";
      state.renameInstance = undefined;
      await refreshInstanceList();
      state.selectedInstanceIndex = Math.max(0, state.instanceList.findIndex((item) => item.definition.name === newName));
      state.status = `renamed ${oldName} to ${newName}`;
    } catch (error) {
      if (state.renameInstance) state.renameInstance.error = errorMessage(error);
      state.status = "rename failed";
    }
    render();
  };

  const refreshInstanceList = async () => {
    try {
      const instances = await state.instanceProvider.list();
      state.instanceList = instances.map((item) => ({
        ...item,
        cardCount: null,
        cardCountError: undefined,
      }));
      for (const item of state.instanceList) {
        if (item.runtime.status === "running") {
          fetchCardCount(item);
        }
      }
    } catch (error) {
      state.error = errorMessage(error);
      state.status = "failed to load instances";
    }
  };

  const fetchCardCount = async (item: InstanceListItem) => {
    if (state.fetchingCardCounts.has(item.definition.name)) return;
    state.fetchingCardCounts.add(item.definition.name);
    render();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    try {
      const response = await fetch(`${item.runtime.boardUrl}/api/tasks`, boardApiFetchInit({ signal: controller.signal }, item.definition.boardToken));
      clearTimeout(timeout);
      if (response.ok) {
        const tasks = await response.json();
        item.cardCount = Array.isArray(tasks) ? tasks.length : 0;
      } else {
        item.cardCountError = `HTTP ${response.status}`;
      }
    } catch (error) {
      clearTimeout(timeout);
      item.cardCountError = error instanceof Error ? error.message : "fetch failed";
    } finally {
      state.fetchingCardCounts.delete(item.definition.name);
      render();
    }
  };

  const archiveTask = async (taskId: string) => {
    await archiveTaskShortcut(state, currentClient.boardUrl, taskId, render, () => refresh(true), fetch, currentBoardToken);
  };

  const openArchive = async () => {
    state.status = "loading archive...";
    render();
    try {
      const records = state.viewState.view === "launch"
        ? await readGlobalArchiveWithoutBoard()
        : await fetchArchiveRecords(currentClient.boardUrl, currentBoardToken);
      state.archiveBoardUrl = state.viewState.view === "launch" ? undefined : currentClient.boardUrl;
      state.archive = {
        records,
        selectedIndex: 0,
        searchQuery: "",
        searchMode: false,
        instanceFilter: null,
        laneFilter: null,
        refreshing: false,
        detailTab: "prompt",
      };
      state.viewState = openArchiveView(state.viewState);
      state.status = `${records.length} archived task${records.length === 1 ? "" : "s"}`;
    } catch (error) {
      state.error = errorMessage(error);
      state.status = "archive load failed";
    }
    render();
  };

  const closeArchive = () => {
    state.archiveBoardUrl = undefined;
    state.viewState = closeArchiveView(state.viewState);
    state.archive = undefined;
    render();
  };

  const refreshArchive = async () => {
    if (!state.archive) return;
    state.archive.refreshing = true;
    render();
    try {
      state.archive.records = state.archiveBoardUrl
        ? await fetchArchiveRecords(state.archiveBoardUrl, currentBoardToken)
        : await readGlobalArchiveWithoutBoard();
      const records = filteredArchiveRecords(state.archive);
      state.archive.selectedIndex = clampIndex(state.archive.selectedIndex, records.length);
      state.status = `${state.archive.records.length} archived task${state.archive.records.length === 1 ? "" : "s"}`;
    } catch (error) {
      state.error = errorMessage(error);
      state.status = "archive refresh failed";
    } finally {
      state.archive.refreshing = false;
      render();
    }
  };

  const setupWorkspace = async () => {
    const input = state.workspaceGateInput.trim();
    const target = input || (isProjectLike(state.cwd) ? state.cwd : "");
    if (!target) {
      state.workspaceGateError = "Please type a path or navigate to a project directory.";
      render();
      return;
    }

    const validation = validateWorkspacePath(target, state.cwd);
    if (!validation.ok) {
      state.workspaceGateError = validation.error;
      render();
      return;
    }

    state.workspaceGateError = undefined;
    state.workspaceGateSubmitting = true;
    state.status = "creating workspace board...";
    render();

    try {
      await refreshInstanceList();
      const existing = state.instanceList.find((item) => item.definition.workspace === validation.path);
      if (existing) {
        await attachInstance(existing);
        state.workspaceGateSubmitting = false;
        return;
      }

      const baseName = workspaceToInstanceName(validation.path);
      const usedNames = new Set(state.instanceList.map((item) => item.definition.name));
      let name = baseName;
      for (let suffix = 2; usedNames.has(name); suffix += 1) {
        name = `${baseName}-${suffix}`;
      }

      await state.instanceProvider.add(name, validation.path);
      await state.instanceProvider.start(name);
      await refreshInstanceList();
      const created = state.instanceList.find((item) => item.definition.name === name);
      if (!created) throw new Error("instance created but not found in list after refresh");
      await attachInstance(created);
      state.workspaceGateSubmitting = false;
    } catch (error) {
      state.workspaceGateSubmitting = false;
      state.workspaceGateError = errorMessage(error);
      state.status = "workspace setup failed";
      render();
    }
  };

  renderer.keyInput.on("keypress", (key) => {
    handleKeypress(key, state, {
      refresh,
      render,
      shutdown,
      runAction,
      client: currentClient,
      attachInstance,
      detachInstance,
      startInstance,
      stopInstance,
      removeInstance,
      addInstance,
      renameInstance,
      refreshInstanceList,
      fetchCardCount,
      archiveTask,
      openArchive,
      closeArchive,
      refreshArchive,
      setupWorkspace,
    }).catch((error) => {
      setError(error, "key handling failed");
      render();
    });
  });

  renderer.on("resize", () => render());

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  refreshTimer = setInterval(() => {
    if (state.viewState.view === "launch") return;
    if (state.viewState.view === "workspaceGate") return;
    if (state.viewState.view === "archive") return;
    refresh(true).catch((error) => {
      setError(error, "refresh failed");
      render();
    });
  }, POLL_INTERVAL_MS);

  await refreshInstanceList();
  if (!initialAttach && state.instanceList.length === 0) {
    state.viewState = transitionView(state.viewState, "workspaceGate");
    render();
  } else if (initialAttach) await refresh(true);
  else render();
  renderer.start();
}

function hasInitialAttachTarget(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.OPENCODE_BOARD_URL?.trim() || env.OPENBOARD_INSTANCE_NAME?.trim() || env.OPENBOARD_INSTANCE_PORT?.trim() || env.OPENBOARD_PORT?.trim());
}

function resolveInitialClientOptions(env: NodeJS.ProcessEnv): Parameters<typeof createBoardClient>[0] {
  const explicitUrl = env.OPENCODE_BOARD_URL?.trim();
  const instancePort = env.OPENBOARD_INSTANCE_PORT?.trim() || env.OPENBOARD_PORT?.trim();
  return {
    ...(explicitUrl ? { boardUrl: explicitUrl } : instancePort ? { boardUrl: `http://127.0.0.1:${instancePort}` } : {}),
    ...(env.OPENBOARD_INSTANCE_WORKSPACE?.trim() ? { cwd: env.OPENBOARD_INSTANCE_WORKSPACE.trim() } : {}),
  };
}

export async function archiveTaskShortcut(
  state: Pick<TuiState, "tasks" | "status" | "error">,
  boardUrl: string,
  taskId: string,
  render: () => void,
  refresh: () => Promise<void>,
  fetchImpl: typeof fetch = fetch,
  boardToken?: string,
): Promise<void> {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) {
    state.status = "Archive: no task selected";
    state.error = undefined;
    render();
    return;
  }

  if (task.column !== "done") {
    state.status = "Archive: only Done cards";
    state.error = undefined;
    render();
    return;
  }

  state.status = `archiving ${task.title}...`;
  state.error = undefined;
  render();

  try {
    const response = await fetchImpl(`${boardUrl}/api/tasks/${encodeURIComponent(taskId)}/archive`, boardApiFetchInit({
      method: "POST",
    }, boardToken));
    if (!response.ok) {
      const detail = await safeResponseText(response);
      throw new Error(`archive failed (${response.status}): ${detail}`);
    }
    state.status = `archived: ${task.title}`;
    await refresh();
  } catch (error) {
    state.error = errorMessage(error);
    state.status = "archive failed";
    render();
  }
}

function resetTerminalModes(options: { clear?: boolean } = {}): void {
  const clearVisibleScreen = IS_TMUX && options.clear ? "\x1b[2J\x1b[H" : "";
  process.stdout.write(`\x1b[0m\x1b[?5l${clearVisibleScreen}`);
}

function restoreTerminalForShell(): void {
  // Reset color, show cursor, leave alt screen, and disable the mouse-reporting
  // + bracketed-paste modes the renderer enables at startup.
  process.stdout.write("\x1b[0m\x1b[?25h\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l");
}

function installFatalHandlers(onFatal: (error: unknown) => void): () => void {
  const handleFatal = (error: unknown) => onFatal(error);
  process.once("uncaughtException", handleFatal);
  process.once("unhandledRejection", handleFatal);
  return () => {
    process.off("uncaughtException", handleFatal);
    process.off("unhandledRejection", handleFatal);
  };
}

function reportFatalError(error: unknown): void {
  const detail = error instanceof Error && error.stack ? error.stack : errorMessage(error);
  process.stderr.write(`\nOpenBoard TUI crashed:\n${detail}\n`);
}

export function renderApp(ui: OpenTui, state: TuiState) {
  const children = [
    renderHeader(ui, state),
    state.viewState.view === "workspaceGate"
      ? renderWorkspaceGateView(ui, state)
      : state.viewState.view === "launch"
        ? renderLaunchView(ui, state)
        : state.viewState.view === "archive"
          ? renderArchiveView(ui, state)
          : renderMain(ui, state),
    renderCommandStrip(ui, state),
  ];
  if (state.overlay === "help") children.push(renderHelpOverlay(ui));
  if (state.overlay === "newTask") children.push(renderNewTaskOverlay(ui, state));
  if (state.overlay === "addInstance") children.push(renderAddInstanceOverlay(ui, state));
  if (state.overlay === "renameInstance") children.push(renderRenameInstanceOverlay(ui, state));
  if (state.viewState.view === "switcher") children.push(renderSwitcherOverlay(ui, state));

  return ui.Box(
    {
      id: ROOT_ID,
      width: "100%",
      height: "100%",
      ...boxBg(COLORS.bg),
      flexDirection: "column",
      padding: TUI_LAYOUT.rootPadding,
      gap: TUI_LAYOUT.rootGap,
    },
    ...children,
  );
}

function renderFallbackApp(ui: OpenTui, state: TuiState) {
  return ui.Box(
    {
      id: ROOT_ID,
      width: "100%",
      height: "100%",
      ...boxBg(COLORS.bg),
      flexDirection: "column",
      padding: 1,
      gap: 1,
    },
    ui.Text({
      content: "OpenBoard TUI render failed",
      fg: COLORS.bright,
      attributes: ui.TextAttributes.BOLD,
      height: 1,
    }),
    ui.Text({
      content: state.error ?? state.status,
      fg: COLORS.muted,
      height: 2,
      wrapMode: "word",
    }),
    ui.Text({
      content: "Press q to quit, or u to retry refresh.",
      fg: COLORS.text,
      height: 1,
    }),
  );
}

function renderHeader(ui: OpenTui, state: TuiState) {
  let connection = state.error ? "BOARD UNAVAILABLE" : state.refreshing ? "REFRESHING" : "CONNECTED";
  let host = boardHost(state.boardUrl);
  let taskLabel = `${state.tasks.length} TASK${state.tasks.length === 1 ? "" : "S"}`;
  let refreshed = state.lastRefresh ? formatClock(state.lastRefresh) : "NO REFRESH";
  let instanceLabel = "";

  if (state.viewState.view === "board") {
    const currentInstance = currentInstanceItem(state);
    if (currentInstance) {
      instanceLabel = ` · INSTANCE ${currentInstance.definition.name}:${currentInstance.definition.port}`;
    }
  } else if (state.viewState.view === "launch") {
    connection = "";
    host = "";
    taskLabel = "";
    refreshed = "";
  } else if (state.viewState.view === "workspaceGate") {
    connection = "SETUP";
    host = "";
    taskLabel = "";
    refreshed = "";
  } else if (state.viewState.view === "switcher") {
    connection = "SWITCHER";
    host = "";
    taskLabel = "";
    refreshed = "";
  } else if (state.viewState.view === "archive") {
    connection = "ARCHIVE";
    host = "";
    taskLabel = `${state.archive?.records.length ?? 0} RECORD${state.archive?.records.length === 1 ? "" : "S"}`;
    refreshed = "";
  }

  return ui.Box(
    {
      height: TUI_LAYOUT.headerHeight,
      width: "100%",
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      ...boxBg(COLORS.bg),
    },
    ui.Box({ flexGrow: 1 }),
    ui.Text({
      content: `${connection}${host}${instanceLabel} · ${taskLabel} · ${refreshed}`.replace(/^ · /, "").replace(/ · $/, ""),
      fg: state.error ? COLORS.bright : COLORS.muted,
      height: 1,
      truncate: true,
    }),
  );
}

function renderWordmark(ui: OpenTui) {
  return ui.Box(
    {
      width: WORDMARK_WIDTH,
      height: WORDMARK_HEIGHT,
      flexDirection: "column",
      ...boxBg(COLORS.bg),
    },
    ...WORDMARK_ROWS.map((segments) =>
      ui.Box(
        { height: 1, flexDirection: "row", ...boxBg(COLORS.bg) },
        ...segments.map((segment) =>
          ui.Text({ content: segment.text, fg: segment.fg, ...textBg(segment.bg), height: 1 }),
        ),
      ),
    ),
  );
}

function boardHost(boardUrl: string): string {
  try {
    const url = new URL(boardUrl);
    return url.hostname === "127.0.0.1" ? `localhost:${url.port}` : url.host;
  } catch {
    return boardUrl;
  }
}

function formatClock(date: Date): string {
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function renderMain(ui: OpenTui, state: TuiState) {
  return ui.Box(
    {
      flexGrow: 1,
      width: "100%",
      flexDirection: "row",
      gap: 1,
      ...boxBg(COLORS.bg),
    },
    renderBoard(ui, state),
    renderSidebar(ui, state),
  );
}

function renderArchiveView(ui: OpenTui, state: TuiState) {
  const archive = state.archive;
  const records = archive ? filteredArchiveRecords(archive) : [];
  const selected = archive ? records[clampIndex(archive.selectedIndex, records.length)] : undefined;

  return ui.Box(
    {
      flexGrow: 1,
      width: "100%",
      flexDirection: "row",
      gap: 1,
      ...boxBg(COLORS.bg),
    },
    ui.Box(
      {
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 0,
        height: "100%",
        flexDirection: "column",
        border: true,
        borderStyle: "single",
        borderColor: COLORS.border,
        title: "Archive",
        titleColor: COLORS.text,
        padding: 1,
        gap: 0,
        ...boxBg(COLORS.panel),
      },
      archive?.searchMode
        ? ui.Box(
            { width: "100%", flexDirection: "row", height: 1, ...boxBg(COLORS.panel) },
            ui.Text({ content: `⌕ / search: ${archive.searchQuery}▍`, fg: COLORS.accentBright, height: 1, flexGrow: 1, truncate: true }),
            ui.Text({ content: "enter to exit", fg: COLORS.dim, height: 1, width: 14 }),
          )
        : ui.Text({ content: archiveFilterLabel(archive), fg: COLORS.muted, height: 1, truncate: true }),
      records.length === 0
        ? ui.Text({ content: "No archived tasks", fg: COLORS.muted, height: 1 })
        : ui.Box(
            { flexGrow: 1, flexDirection: "column", overflow: "hidden", ...boxBg(COLORS.panel) },
            ...records.map((record, index) => renderArchiveRow(ui, state, record, index === (archive?.selectedIndex ?? 0))),
          ),
    ),
    ui.Box(
      {
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 0,
        height: "100%",
        flexDirection: "column",
        border: true,
        borderStyle: "single",
        borderColor: COLORS.border,
        title: "Detail",
        titleColor: COLORS.text,
        padding: 1,
        gap: 1,
        ...boxBg(COLORS.panel),
      },
      selected ? renderArchiveDetail(ui, state, selected) : ui.Text({ content: "Select a record", fg: COLORS.muted, height: 1 }),
    ),
  );
}

function renderArchiveRow(ui: OpenTui, _state: TuiState, record: GlobalArchiveRecord, selected: boolean) {
  const line = `${selected ? "▸ " : "  "}${formatArchiveDate(record.archived_at).slice(0, 10)} · ${record.source_instance_name ?? "unknown"} · ${record.title} · ${record.column_name} · ${record.agent ?? "unassigned"}`;
  return ui.Box(
    { width: "100%", height: 1, flexDirection: "row", ...boxBg(selected ? COLORS.panelRaised : COLORS.panel) },
    ui.Text({ content: line, fg: selected ? COLORS.bright : COLORS.text, height: 1, truncate: true }),
  );
}

function renderArchiveDetail(ui: OpenTui, state: TuiState, record: GlobalArchiveRecord) {
  const completion = parseCompletion(record.completion);
  const model = parseModelRef(record.model);
  const tab = state.archive?.detailTab ?? "prompt";

  const activeTabFg = COLORS.accentBright;
  const inactiveTabFg = COLORS.dim;
  const promptActive = tab === "prompt";
  const handoffActive = tab === "handoff";

  const tabContent: VChild =
    tab === "prompt"
      ? ui.Text({ content: record.description || "(empty prompt)", fg: COLORS.text, wrapMode: "word", flexGrow: 1 })
      : renderHandoffTab(ui, completion);

  return ui.Box(
    { flexGrow: 1, flexDirection: "column", gap: 1, ...boxBg(COLORS.panel) },
    ui.Text({ content: record.title, fg: COLORS.text, attributes: ui.TextAttributes.BOLD, wrapMode: "word", height: 3 }),
    renderDetail(ui, "INSTANCE", `${record.source_instance_name ?? "unknown"}:${record.source_port}`),
    renderDetail(ui, "WORKSPACE", shortPath(record.source_workspace), COLORS.muted),
    renderDetail(ui, "LANE", record.column_name, COLORS.muted),
    renderDetail(ui, "AGENT", record.agent ?? "unassigned"),
    renderDetail(ui, "MODEL", model ? modelLabel(model) : "agent default"),
    renderDetail(ui, "ARCHIVED", formatArchiveDate(record.archived_at), COLORS.muted),
    ui.Text({ content: HAIRLINE, fg: COLORS.hairline, height: 1, truncate: true }),
    // Tab headers
    ui.Box(
      { width: "100%", flexDirection: "row", height: 1, gap: 2 },
      ui.Text({
        content: "Prompt",
        fg: promptActive ? activeTabFg : inactiveTabFg,
        attributes: promptActive ? ui.TextAttributes.BOLD : undefined,
        height: 1,
      }),
      ui.Text({
        content: "Handoff",
        fg: handoffActive ? activeTabFg : inactiveTabFg,
        attributes: handoffActive ? ui.TextAttributes.BOLD : undefined,
        height: 1,
      }),
    ),
    ui.Text({ content: HAIRLINE, fg: COLORS.hairline, height: 1, truncate: true }),
    tabContent,
  );
}

function renderHandoffTab(ui: OpenTui, completion: CompletionReport | null) {
  if (!completion) {
    return ui.Box(
      { flexGrow: 1, flexDirection: "column", gap: 1, ...boxBg(COLORS.panel) },
      ui.Text({ content: "No completion report available", fg: COLORS.muted, height: 1 }),
    );
  }

  const changedFiles = completion.changedFiles.length ? completion.changedFiles : ["none"];
  const verification = completion.verification.length
    ? completion.verification.map((item) => `${item.command} → ${item.result}`)
    : ["none"];

  return ui.Box(
    { flexGrow: 1, flexDirection: "column", gap: 1, ...boxBg(COLORS.panel) },
    ui.Box(
      { width: "100%", flexDirection: "column", gap: 0 },
      ui.Text({ content: "SUMMARY", fg: COLORS.dim, height: 1 }),
      ui.Text({ content: completion.summary, fg: COLORS.text, width: "100%", minWidth: 0, flexShrink: 1, wrapMode: "word", flexGrow: 1 }),
    ),
    ui.Box(
      { width: "100%", flexDirection: "column", gap: 0 },
      ui.Text({ content: "CHANGED FILES", fg: COLORS.dim, height: 1 }),
      ui.Text({ content: changedFiles.join(", "), fg: COLORS.muted, width: "100%", minWidth: 0, flexShrink: 1, wrapMode: "char", flexGrow: 1 }),
    ),
    ui.Box(
      { width: "100%", flexDirection: "column", gap: 0 },
      ui.Text({ content: "VERIFICATION", fg: COLORS.dim, height: 1 }),
      ui.Text({ content: verification.join("; "), fg: COLORS.muted, width: "100%", minWidth: 0, flexShrink: 1, wrapMode: "char", flexGrow: 1 }),
    ),
    ui.Box(
      { width: "100%", flexDirection: "column", gap: 0 },
      ui.Text({ content: "RESIDUAL RISK", fg: COLORS.dim, height: 1 }),
      ui.Text({ content: completion.residualRisk ?? "none", fg: COLORS.text, width: "100%", minWidth: 0, flexShrink: 1, wrapMode: "word", flexGrow: 1 }),
    ),
  );
}

function filteredArchiveRecords(archive: ArchiveState): GlobalArchiveRecord[] {
  const query = archive.searchQuery.trim().toLowerCase();
  return archive.records.filter((record) => {
    if (archive.instanceFilter && record.source_instance_name !== archive.instanceFilter) return false;
    if (archive.laneFilter && record.column_name !== archive.laneFilter) return false;
    if (!query) return true;
    return [record.title, record.description, record.agent ?? "", record.source_instance_name ?? "", record.column_name]
      .join("\n")
      .toLowerCase()
      .includes(query);
  });
}

function archiveFilterLabel(archive: ArchiveState | undefined): string {
  if (!archive) return "";
  const filters = [archive.instanceFilter ? `instance:${archive.instanceFilter}` : undefined, archive.laneFilter ? `lane:${archive.laneFilter}` : undefined].filter(Boolean);
  return filters.length ? filters.join(" · ") : "all archived tasks";
}

function renderBoardHandoffTab(ui: OpenTui, completion: CompletionReport | null) {
  if (!completion) {
    return ui.Box(
      { flexGrow: 1, flexDirection: "column", gap: 1, ...boxBg(COLORS.panel) },
      ui.Text({ content: "No completion report available", fg: COLORS.muted, height: 1 }),
    );
  }

  const changedFiles = completion.changedFiles.length ? completion.changedFiles : ["none"];
  const verification = completion.verification.length
    ? completion.verification.map((item) => `${item.command} → ${item.result}`)
    : ["none"];

  return ui.Box(
    { flexGrow: 1, flexDirection: "column", gap: 1, ...boxBg(COLORS.panel) },
    ui.Box(
      { width: "100%", flexDirection: "column", gap: 0 },
      ui.Text({ content: "SUMMARY", fg: COLORS.dim, height: 1 }),
      ui.Text({ content: completion.summary, fg: COLORS.text, width: "100%", minWidth: 0, flexShrink: 1, wrapMode: "word", height: 3 }),
    ),
    ui.Box(
      { width: "100%", flexDirection: "column", gap: 0 },
      ui.Text({ content: "CHANGED FILES", fg: COLORS.dim, height: 1 }),
      ui.Text({ content: changedFiles.join(", "), fg: COLORS.muted, width: "100%", minWidth: 0, flexShrink: 1, wrapMode: "char", height: 3 }),
    ),
    ui.Box(
      { width: "100%", flexDirection: "column", gap: 0 },
      ui.Text({ content: "VERIFICATION", fg: COLORS.dim, height: 1 }),
      ui.Text({ content: verification.join("; "), fg: COLORS.muted, width: "100%", minWidth: 0, flexShrink: 1, wrapMode: "char", height: 4 }),
    ),
    ui.Box(
      { width: "100%", flexGrow: 1, flexDirection: "column", gap: 0 },
      ui.Text({ content: "RESIDUAL RISK", fg: COLORS.dim, height: 1 }),
      ui.Text({ content: completion.residualRisk ?? "none", fg: COLORS.text, width: "100%", minWidth: 0, flexShrink: 1, wrapMode: "word", flexGrow: 1 }),
    ),
  );
}

function renderInlineMoveDetail(ui: OpenTui, state: TuiState, task: Task) {
  const target = state.moveTargetColumn ?? task.column;

  return ui.Box(
    {
      flexGrow: 1,
      flexDirection: "column",
      gap: 1,
      ...boxBg(COLORS.panel),
    },
    ui.Text({ content: "Move Card", fg: COLORS.text, attributes: ui.TextAttributes.BOLD, height: 1, truncate: true }),
    ui.Text({ content: task.title, fg: COLORS.bright, height: 2, wrapMode: "word" }),
    ui.Text({ content: `Current lane: ${TUI_COLUMN_LABELS[task.column]}`, fg: COLORS.muted, height: 1 }),
    ui.Text({ content: HAIRLINE, fg: COLORS.hairline, height: 1, truncate: true }),
    ...TUI_COLUMNS.map((col, index) => {
      const active = col === target;
      return ui.Text({
        content: `${active ? "▸ " : "  "}${index + 1}. ${TUI_COLUMN_LABELS[col]}${col === task.column ? " (current)" : ""}${col === "done" ? " ← completedBy: User" : ""}`,
        fg: active ? COLORS.accentBright : col === task.column ? COLORS.muted : COLORS.text,
        ...textBg(active ? COLORS.panelRaised : COLORS.panel),
        height: 1,
        truncate: true,
      });
    }),
    ui.Text({ content: HAIRLINE, fg: COLORS.hairline, height: 1, truncate: true }),
    ui.Text({ content: "↑/↓ or 1-4 select lane · enter confirm · esc cancel", fg: COLORS.dim, height: 1, truncate: true }),
  );
}

// ── Workspace gate view (first-run directory selection) ────────────────────────

function renderWorkspaceGateView(ui: OpenTui, state: TuiState) {
  const cwdIsProject = isProjectLike(state.cwd);
  return ui.Box(
    {
      flexGrow: 1,
      width: "100%",
      flexDirection: "column",
      ...boxBg(COLORS.panel),
      padding: 1,
      gap: 0,
    },
    renderWordmark(ui),
    ui.Box({ height: 1 }),
    ui.Text({ content: "Workspace Required", fg: COLORS.bright, attributes: ui.TextAttributes.BOLD, height: 1 }),
    ui.Box({ height: 1 }),
    ui.Text({ content: "OpenBoard needs a project workspace directory to run agents.", fg: COLORS.text, height: 1, truncate: true }),
    ui.Text({ content: "Please specify a directory path or choose a project workspace.", fg: COLORS.muted, height: 1, truncate: true }),
    ui.Box({ height: 1 }),
    renderInputField(
      ui,
      "DIRECTORY",
      state.workspaceGateInput || shortPath(state.cwd),
      true,
      shortPath(state.cwd),
      1,
      state.workspaceGateInput.length > 0 ? COLORS.text : COLORS.muted,
    ),
    ui.Box({ height: 1 }),
    cwdIsProject
      ? ui.Text({ content: "Current directory appears project-like (current project); press enter to use it.", fg: COLORS.accentBright, height: 1, truncate: true })
      : ui.Text({ content: `Current directory: ${shortPath(state.cwd)}`, fg: COLORS.dim, height: 1, truncate: true }),
    ui.Box({ height: 1 }),
    state.workspaceGateError
      ? ui.Text({ content: state.workspaceGateError, fg: COLORS.bright, wrapMode: "word", height: 2 })
      : ui.Box({ height: 2 }),
    ui.Text({ content: HAIRLINE, fg: COLORS.hairline, height: 1, truncate: true }),
    state.workspaceGateSubmitting
      ? ui.Text({ content: "Creating workspace board...", fg: COLORS.accentBright, height: 1 })
      : ui.Text({ content: "type a path then press enter · esc quit", fg: COLORS.dim, height: 1, truncate: true }),
  );
}

// ── Launch view (instance list) ────────────────────────────────────────────────

function renderLaunchView(ui: OpenTui, state: TuiState) {
  const rows: VChild[] = [
    // Large wordmark lives on the launch view only; board view drops it for
    // more vertical room in the lanes.
    renderWordmark(ui),
  ];

  if (state.instanceList.length === 0) {
    rows.push(
      ui.Text({ content: "No instances registered", fg: COLORS.muted, height: 1 }),
      ui.Text({ content: "Press n to add an instance", fg: COLORS.dim, height: 1 }),
    );
  } else {
    for (let i = 0; i < state.instanceList.length; i++) {
      const item = state.instanceList[i];
      const selected = i === state.selectedInstanceIndex;
      rows.push(renderInstanceRow(ui, state, item, selected));
    }
  }

  rows.push(
    ui.Text({ content: "────────────────────────────────────────────", fg: COLORS.hairline, height: 1 }),
  );

  return ui.Box(
    {
      flexGrow: 1,
      width: "100%",
      flexDirection: "column",
      ...boxBg(COLORS.panel),
      padding: 1,
      gap: 0,
    },
    ...rows,
  );
}

function renderInstanceRow(ui: OpenTui, state: TuiState, item: InstanceListItem, selected: boolean) {
  const glyph = INSTANCE_STATUS_GLYPHS[item.runtime.status] ?? "?";

  const cardCountStr =
    item.cardCount !== null
      ? ` · ${item.cardCount} card${item.cardCount === 1 ? "" : "s"}`
      : item.cardCountError
      ? " · —"
      : item.runtime.status === "running"
      ? " · fetching..."
      : "";

  const line = `${selected ? "▸ " : "  "}${glyph} ${item.definition.name}  ${instanceStatusLabel(item.runtime.status)}  :${item.definition.port}  ${item.definition.workspace}${cardCountStr}`;

  return ui.Box(
    {
      width: "100%",
      height: 1,
      flexDirection: "row",
      ...boxBg(selected ? COLORS.panelRaised : COLORS.panel),
    },
    ui.Text({
      content: line,
      fg: selected ? COLORS.bright : COLORS.text,
      height: 1,
      truncate: true,
    }),
  );
}

// ── Switcher overlay ───────────────────────────────────────────────────────────

function renderSwitcherOverlay(ui: OpenTui, state: TuiState) {
  const rows: VChild[] = [];

  for (let i = 0; i < state.instanceList.length; i++) {
    const item = state.instanceList[i];
    const selected = i === state.switcherSelectedIndex;
    const isCurrent = item.runtime.boardUrl === state.boardUrl;
    rows.push(renderSwitcherRow(ui, item, selected, isCurrent));
  }

  return ui.Box(
    {
      position: "absolute",
      top: TUI_LAYOUT.headerHeight + TUI_LAYOUT.rootPadding + TUI_LAYOUT.rootGap,
      left: 0,
      right: 0,
      bottom: TUI_LAYOUT.commandStripHeight + TUI_LAYOUT.rootPadding + TUI_LAYOUT.rootGap,
      zIndex: 40,
      ...boxBg("#000000"),
      alignItems: "center",
      justifyContent: "center",
    },
    ui.Box(
      {
        width: 60,
        maxHeight: "80%",
        flexDirection: "column",
        border: true,
        borderStyle: "single",
        borderColor: COLORS.border,
        ...boxBg(COLORS.bg),
        padding: 1,
        gap: 0,
      },
      ui.Box(
        { width: "100%", flexDirection: "row", height: 1 },
        ui.Text({ content: "Switch Instance", fg: COLORS.text, attributes: ui.TextAttributes.BOLD, height: 1, flexGrow: 1 }),
        ui.Text({ content: "✕", fg: COLORS.dim, height: 1, width: 2 }),
      ),
      ui.Text({ content: "────────────────────────────────────────────────", fg: COLORS.hairline, height: 1 }),
      ...rows,
      ui.Text({ content: "────────────────────────────────────────────────", fg: COLORS.hairline, height: 1 }),
      ui.Text({ content: "↑/↓ navigate · enter select · esc cancel", fg: COLORS.dim, height: 1 }),
    ),
  );
}

function renderSwitcherRow(ui: OpenTui, item: InstanceListItem, selected: boolean, isCurrent: boolean) {
  const glyph = INSTANCE_STATUS_GLYPHS[item.runtime.status] ?? "?";

  const currentMarker = isCurrent ? " ← current" : "";
  const line = `${selected ? "▸ " : "  "}${glyph} ${item.definition.name}  ${instanceStatusLabel(item.runtime.status)}  :${item.definition.port}${currentMarker}`;

  return ui.Box(
    {
      width: "100%",
      height: 1,
      flexDirection: "row",
      ...boxBg(selected ? COLORS.panelRaised : COLORS.bg),
    },
    ui.Text({
      content: line,
      fg: selected ? COLORS.bright : isCurrent ? COLORS.accentBright : COLORS.text,
      height: 1,
      truncate: true,
    }),
  );
}

// ── Add Instance overlay ───────────────────────────────────────────────────────

function renderAddInstanceOverlay(ui: OpenTui, state: TuiState) {
  const draft = state.addInstance ?? { name: "", workspace: state.cwd, field: "name" as const, submitting: false, error: undefined };

  return ui.Box(
    {
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      zIndex: 50,
      ...boxBg("#000000"),
      flexDirection: "row",
    },
    ui.Box({ flexGrow: 1 }),
    ui.Box(
      {
        width: 52,
        height: "100%",
        flexDirection: "row",
        ...boxBg(COLORS.bg),
      },
      ui.Box({ width: 1, height: "100%", ...boxBg(COLORS.border) }),
      ui.Box(
        {
          flexGrow: 1,
          height: "100%",
          flexDirection: "column",
          ...boxBg(COLORS.bg),
          padding: 1,
          gap: 1,
        },
        ui.Box(
          { width: "100%", flexDirection: "row", height: 1 },
          ui.Text({ content: "Add Instance", fg: COLORS.text, attributes: ui.TextAttributes.BOLD, height: 1, flexGrow: 1 }),
          ui.Text({ content: "✕", fg: COLORS.dim, height: 1, width: 2 }),
        ),
        ui.Text({ content: "────────────────────────────────────────────────", fg: COLORS.hairline, height: 1 }),
        ui.Box(
          { flexGrow: 1, flexDirection: "column", gap: 1, ...boxBg(COLORS.bg) },
          renderInputField(ui, "NAME", draft.name, draft.field === "name", "my-project", 1),
          renderInputField(
            ui,
            "WORKSPACE",
            draft.field === "workspace" ? draft.workspace : shortPath(draft.workspace),
            draft.field === "workspace",
            state.cwd,
            1,
            COLORS.muted,
          ),
          draft.error
            ? ui.Text({ content: draft.error, fg: COLORS.bright, wrapMode: "word", height: 2 })
            : ui.Box({ height: 2 }),
        ),
        ui.Text({ content: "────────────────────────────────────────────────", fg: COLORS.hairline, height: 1 }),
        ui.Box(
          { width: "100%", flexDirection: "row", height: 1, gap: 1 },
          ui.Text({
            content: draft.submitting ? "Creating..." : "Create instance",
            fg: COLORS.bright,
            ...textBg(COLORS.accent),
            height: 1,
            width: 16,
          }),
          ui.Text({ content: "esc cancel", fg: COLORS.muted, height: 1, flexGrow: 1 }),
        ),
        ui.Text({ content: "tab next field · shift+tab previous · enter create", fg: COLORS.dim, height: 1 }),
      ),
    ),
  );
}

function renderRenameInstanceOverlay(ui: OpenTui, state: TuiState) {
  const draft = state.renameInstance ?? { oldName: "", newName: "", field: "newName" as const, submitting: false, error: undefined };

  return ui.Box(
    {
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      zIndex: 50,
      ...boxBg("#000000"),
      flexDirection: "row",
    },
    ui.Box({ flexGrow: 1 }),
    ui.Box(
      {
        width: 52,
        height: "100%",
        flexDirection: "row",
        ...boxBg(COLORS.bg),
      },
      ui.Box({ width: 1, height: "100%", ...boxBg(COLORS.border) }),
      ui.Box(
        {
          flexGrow: 1,
          height: "100%",
          flexDirection: "column",
          ...boxBg(COLORS.bg),
          padding: 1,
          gap: 1,
        },
        ui.Box(
          { width: "100%", flexDirection: "row", height: 1 },
          ui.Text({ content: "Rename Instance", fg: COLORS.text, attributes: ui.TextAttributes.BOLD, height: 1, flexGrow: 1 }),
          ui.Text({ content: "✕", fg: COLORS.dim, height: 1, width: 2 }),
        ),
        ui.Text({ content: "────────────────────────────────────────────────", fg: COLORS.hairline, height: 1 }),
        ui.Box(
          { flexGrow: 1, flexDirection: "column", gap: 1, ...boxBg(COLORS.bg) },
          renderInputField(ui, "OLD NAME", draft.oldName, false, "", 1, COLORS.muted),
          renderInputField(ui, "NEW NAME", draft.newName, true, "my-project", 1),
          draft.error
            ? ui.Text({ content: draft.error, fg: COLORS.bright, wrapMode: "word", height: 2 })
            : ui.Box({ height: 2 }),
        ),
        ui.Text({ content: "────────────────────────────────────────────────", fg: COLORS.hairline, height: 1 }),
        ui.Box(
          { width: "100%", flexDirection: "row", height: 1, gap: 1 },
          ui.Text({
            content: draft.submitting ? "Renaming..." : "Rename instance",
            fg: COLORS.bright,
            ...textBg(COLORS.accent),
            height: 1,
            width: 16,
          }),
          ui.Text({ content: "esc cancel", fg: COLORS.muted, height: 1, flexGrow: 1 }),
        ),
        ui.Text({ content: "esc cancel · enter rename", fg: COLORS.dim, height: 1 }),
      ),
    ),
  );
}

function renderBoard(ui: OpenTui, state: TuiState) {
  const grouped = tasksByColumn(state.tasks);

  return ui.Box(
    {
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 0,
      height: "100%",
      flexDirection: "row",
      gap: 1,
      ...boxBg(COLORS.bg),
    },
    ...TUI_COLUMNS.map((column) => renderColumn(ui, state, column, grouped[column])),
  );
}

function renderColumn(ui: OpenTui, state: TuiState, column: Column, tasks: Task[]) {
  // Arrow keys move selection, not a scrollbar — the lane renders the window of
  // cards around the selection and marks what's clipped in either direction.
  const innerHeight = laneInnerHeight(state.terminalRows);
  const capacity = innerHeight > 0 ? laneCapacity(innerHeight, tasks.length, TUI_LAYOUT.cardHeight) : tasks.length;
  const selectedIndex = tasks.findIndex((task) => task.id === state.selectedTaskId);
  const offset = reconcileLaneOffset(state.laneOffsets[column], selectedIndex, tasks.length, capacity);
  state.laneOffsets[column] = offset;
  const visible = tasks.slice(offset, offset + capacity);
  const hiddenBelow = tasks.length - offset - visible.length;

  // Indicators render only when that edge actually hides cards — a reserved
  // blank slot reads as a spacing bug at the top of an overflowing lane.
  // laneCapacity still budgets for both slots, so the window stays stable;
  // at the edges the spare rows fall harmlessly below the last card.
  const cards: VChild[] = [];
  if (offset > 0) cards.push(renderLaneOverflow(ui, offset, "↑"));
  cards.push(...visible.map((task) => renderTask(ui, state, task)));
  if (hiddenBelow > 0) cards.push(renderLaneOverflow(ui, hiddenBelow, "↓"));

  return ui.Box(
    {
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 0,
      minWidth: LANE_MIN_WIDTH,
      height: "100%",
      flexDirection: "column",
      border: true,
      borderStyle: "single",
      borderColor: COLORS.border,
      ...boxBg(COLORS.panel),
      padding: TUI_LAYOUT.lanePadding,
      gap: TUI_LAYOUT.laneGap,
      title: `${TUI_COLUMN_LABELS[column]} · ${tasks.length}`,
      titleColor: COLORS.text,
    },
    tasks.length === 0
      ? ui.Box({ flexGrow: 1, ...boxBg(COLORS.panel) })
      : ui.Box(
          {
            flexGrow: 1,
            flexDirection: "column",
            gap: TUI_LAYOUT.laneGap,
            overflow: "hidden",
            ...boxBg(COLORS.panel),
          },
          ...cards,
        ),
  );
}

function renderLaneOverflow(ui: OpenTui, count: number, arrow: string) {
  return ui.Text({
    content: `${arrow} ${count} more`,
    fg: COLORS.dim,
    height: 1,
    truncate: true,
  });
}

interface MetaRow {
  label: string;
  value: string;
  color: TuiColor;
}

// Status row text: glyph + label, plus the live elapsed time while running
// (`● RUNNING · 4m 12s`). The 2.5s poll re-render keeps the clock ticking.
function taskStatusText(task: Task): string {
  const status = taskStatus(task);
  const elapsed =
    task.runState === "running" && task.runStartedAt
      ? ` · ${formatElapsed(Date.now() - task.runStartedAt)}`
      : "";
  return `${status.glyph} ${status.label}${elapsed}`;
}

function renderTask(ui: OpenTui, state: TuiState, task: Task) {
  const selected = task.id === state.selectedTaskId;
  const done = task.column === "done" && !selected;
  const [metaA, metaB] = taskMetaRows(task);

  return ui.Box(
    {
      width: "100%",
      height: TUI_LAYOUT.cardHeight,
      flexDirection: "row",
      ...boxBg(selected ? COLORS.panelRaised : COLORS.panel),
      border: true,
      borderStyle: "single",
      borderColor: selected ? COLORS.borderHot : COLORS.border,
    },
    ui.Box({ width: 1, height: "100%", ...boxBg(laneColor(task)) }),
    ui.Box(
      { flexGrow: 1, flexDirection: "column", paddingX: 1 },
      ui.Box(
        { width: "100%", height: 1, flexDirection: "row" },
        ui.Text({
          content: taskStatusText(task),
          fg: done ? COLORS.dim : taskStatusColor(task),
          height: 1,
          flexGrow: 1,
          flexShrink: 1,
          minWidth: 0,
          truncate: true,
        }),
        ui.Text({ content: "⋯", fg: COLORS.dim, height: 1, width: 1 }),
      ),
      ui.Text({
        content: `${selected ? "▸ " : ""}${task.title}`,
        fg: selected ? COLORS.bright : done ? COLORS.muted : COLORS.text,
        attributes: ui.TextAttributes.BOLD,
        height: 2,
        wrapMode: "word",
      }),
      ui.Text({ content: HAIRLINE, fg: COLORS.hairline, height: 1, truncate: true }),
      renderTaskMeta(ui, metaA, done),
      renderTaskMeta(ui, metaB, done),
    ),
  );
}

// The two meta lines a card carries under its hairline. Reads by lane: an error card
// surfaces its raw failure; a Review/Done card its worktree branch; everything else
// the working dir and its agent.
function taskMetaRows(task: Task): [MetaRow, MetaRow] {
  const dir: MetaRow = { label: "DIR", value: shortPath(task.directory), color: COLORS.muted };
  const agent: MetaRow = { label: "AGENT", value: task.agent ?? "agent", color: COLORS.muted };

  if (task.runState === "error") {
    return [dir, { label: "ERR", value: task.error ?? "run failed", color: COLORS.text }];
  }
  if ((task.column === "review" || task.column === "done") && task.worktreeBranch) {
    return [{ label: "BRANCH", value: `⑃ ${task.worktreeBranch}`, color: COLORS.muted }, dir];
  }
  return [dir, agent];
}

function renderTaskMeta(ui: OpenTui, meta: MetaRow, done: boolean, labelWidth = 7) {
  return ui.Box(
    { width: "100%", height: 1, flexDirection: "row" },
    ui.Text({ content: meta.label, fg: COLORS.dim, width: labelWidth, height: 1 }),
    // minWidth:0 lets the value shrink inside the row instead of overflowing the
    // card's right border when the path/branch is longer than the lane is wide.
    ui.Text({
      content: meta.value,
      fg: done ? COLORS.dim : meta.color,
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      height: 1,
      truncate: true,
    }),
  );
}

function renderSidebar(ui: OpenTui, state: TuiState) {
  const task = selectedTask(state);
  return ui.Box(
    {
      width: SIDEBAR_WIDTH,
      height: "100%",
      flexDirection: "column",
      border: true,
      borderStyle: "single",
      borderColor: COLORS.border,
      ...boxBg(COLORS.panel),
      padding: 1,
      gap: 1,
      title: "Selected",
      titleColor: COLORS.text,
    },
    task ? renderTaskDetails(ui, state, task) : renderEmptyDetails(ui),
  );
}

function renderTaskDetails(ui: OpenTui, state: TuiState, task: Task) {
  const instance = currentInstanceItem(state);
  const rows: MetaRow[] = [
    { label: "INSTANCE", value: instance ? `${instance.definition.name}:${instance.definition.port}` : boardHost(state.boardUrl), color: COLORS.text },
    { label: "STATE", value: taskStatusText(task), color: taskStatusColor(task) },
    { label: "LANE", value: TUI_COLUMN_LABELS[task.column], color: COLORS.muted },
    { label: "AGENT", value: agentLabel(task, state.agents), color: COLORS.text },
    { label: "MODEL", value: modelLabel(task.model), color: COLORS.text },
    { label: "DIR", value: shortPath(task.directory), color: COLORS.muted },
    { label: "ISO", value: task.isolation ?? "board default", color: COLORS.text },
  ];
  if (task.completedBy) rows.push({ label: "COMPLETED BY", value: task.completedBy, color: COLORS.accentBright });
  if (task.sessionId) rows.push({ label: "SESSION", value: task.sessionId, color: COLORS.muted });
  if (task.worktreeBranch) rows.push({ label: "BRANCH", value: `⑃ ${task.worktreeBranch}`, color: COLORS.muted });
  if (task.baseBranch) rows.push({ label: "BASE", value: `⑃ ${task.baseBranch}`, color: COLORS.muted });

  if (state.moveTargetColumn) {
    return renderInlineMoveDetail(ui, state, task);
  }

  if (state.detailTab) {
    return renderInlineTaskDetail(ui, state, task, rows);
  }

  // The sidebar shares the lane chrome (border + padding), so lane inner height
  // is its inner height too. When the two-line detail style can't fit, fall back
  // to single-line card-meta rows instead of letting labels and values collide.
  const mode = sidebarDetailMode(laneInnerHeight(state.terminalRows), rows.length, Boolean(task.error));
  return mode === "expanded"
    ? renderExpandedDetails(ui, task, rows)
    : renderCompactDetails(ui, task, rows);
}

function renderInlineTaskDetail(ui: OpenTui, state: TuiState, task: Task, rows: MetaRow[]) {
  const tab = state.detailTab ?? "prompt";
  const content: VChild =
    tab === "prompt"
      ? ui.Text({ content: task.description || "(empty prompt)", fg: COLORS.text, wrapMode: "word", flexGrow: 1 })
      : renderBoardHandoffTab(ui, task.completion ?? null);
  const inlineRows = rows.filter((row) => ["STATE", "LANE", "AGENT", "COMPLETED BY"].includes(row.label));

  return ui.Box(
    {
      flexGrow: 1,
      flexDirection: "column",
      gap: 1,
      ...boxBg(COLORS.panel),
    },
    ui.Text({
      content: task.title,
      fg: COLORS.text,
      attributes: ui.TextAttributes.BOLD,
      wrapMode: "word",
      height: 2,
    }),
    ui.Box(
      { width: "100%", height: inlineRows.length, flexDirection: "column", gap: 0, ...boxBg(COLORS.panel) },
      ...inlineRows.map((row) => renderTaskMeta(ui, row, false, 10)),
    ),
    ...(task.error ? [renderErrorBox(ui, task.error)] : []),
    ui.Box(
      { width: "100%", flexDirection: "row", height: 1, gap: 2 },
      ui.Text({
        content: "Prompt",
        fg: tab === "prompt" ? COLORS.accentBright : COLORS.dim,
        attributes: tab === "prompt" ? ui.TextAttributes.BOLD : undefined,
        height: 1,
      }),
      ui.Text({
        content: "Handoff",
        fg: tab === "handoff" ? COLORS.accentBright : COLORS.dim,
        attributes: tab === "handoff" ? ui.TextAttributes.BOLD : undefined,
        height: 1,
      }),
    ),
    ui.Text({ content: HAIRLINE, fg: COLORS.hairline, height: 1, truncate: true }),
    ui.Box(
      { flexGrow: 1, flexDirection: "column", gap: 0, ...boxBg(COLORS.panel) },
      content,
    ),
    ui.Text({ content: "esc details · ←/→ tabs · m move card", fg: COLORS.muted, height: 1, truncate: true }),
  );
}

function renderExpandedDetails(ui: OpenTui, task: Task, rows: MetaRow[]) {
  const details: VChild[] = rows.map((row) => renderDetail(ui, row.label, row.value, row.color));
  if (task.error) details.push(renderErrorBox(ui, task.error));

  return ui.Box(
    {
      flexGrow: 1,
      flexDirection: "column",
      gap: 1,
      ...boxBg(COLORS.panel),
    },
    ui.Text({
      content: task.title,
      fg: COLORS.text,
      attributes: ui.TextAttributes.BOLD,
      wrapMode: "word",
      height: 3,
    }),
    ...details,
    ui.Box({ flexGrow: 1 }),
    ...renderDetailHints(ui),
  );
}

function renderCompactDetails(ui: OpenTui, task: Task, rows: MetaRow[]) {
  const compactRows = [...rows];
  if (task.error) compactRows.push({ label: "ERR", value: task.error, color: COLORS.text });

  return ui.Box(
    {
      flexGrow: 1,
      flexDirection: "column",
      gap: 1,
      ...boxBg(COLORS.panel),
    },
    ui.Text({
      content: task.title,
      fg: COLORS.text,
      attributes: ui.TextAttributes.BOLD,
      wrapMode: "word",
      height: 2,
    }),
    ui.Box(
      { width: "100%", flexDirection: "column", gap: 0, ...boxBg(COLORS.panel) },
      // Width 8: "SESSION" is the widest sidebar label and needs a trailing space.
      ...compactRows.map((row) => renderTaskMeta(ui, row, false, 8)),
    ),
    ui.Box({ flexGrow: 1 }),
    ...renderDetailHints(ui),
  );
}

function renderDetailHints(ui: OpenTui): VChild[] {
  return [
    ui.Text({ content: "r run · R retry · a archive task · d delete", fg: COLORS.muted, height: 1, truncate: true }),
    ui.Text({ content: "s sync · i integrate · x done · ↵ details", fg: COLORS.muted, height: 1, truncate: true }),
  ];
}

function renderErrorBox(ui: OpenTui, error: string) {
  return ui.Box(
    {
      border: true,
      borderStyle: "single",
      borderColor: COLORS.laneError,
      padding: 1,
      flexDirection: "column",
    },
    ui.Text({ content: "! ERROR", fg: COLORS.bright, height: 1 }),
    ui.Text({ content: error, fg: COLORS.text, wrapMode: "word", height: 5 }),
  );
}

function renderEmptyDetails(ui: OpenTui) {
  return ui.Box(
    { flexGrow: 1, alignItems: "center", justifyContent: "center" },
    ui.Text({ content: "No cards yet", fg: COLORS.muted, height: 1 }),
  );
}

function renderDetail(ui: OpenTui, label: string, value: string, valueColor: TuiColor = COLORS.text) {
  return ui.Box(
    { width: "100%", flexDirection: "column", gap: 0 },
    ui.Text({ content: label, fg: COLORS.dim, height: 1 }),
    ui.Text({ content: value, fg: valueColor, height: 1, truncate: true }),
  );
}

function renderCommandStrip(ui: OpenTui, state: TuiState) {
  const refreshed = state.lastRefresh ? formatClock(state.lastRefresh) : "never";

  return ui.Box(
    {
      height: TUI_LAYOUT.commandStripHeight,
      width: "100%",
      flexDirection: "column",
      border: true,
      borderStyle: "single",
      borderColor: COLORS.border,
      ...boxBg(COLORS.panelRaised),
      paddingX: 1,
    },
    // Live status line: errors first, otherwise the action feedback the key
    // handlers write (run/retry/abort/create results, refresh progress).
    ui.Text({
      content: state.error ?? state.status,
      fg: state.error ? COLORS.bright : COLORS.muted,
      height: 1,
      truncate: true,
    }),
    ui.Box(
      {
        width: "100%",
        flexDirection: "row",
        height: 1,
      },
      ui.Text({
        content:
          state.viewState.view === "archive"
            ? "↑/↓ navigate · ←/→ tabs: Prompt/Handoff · / search · i instance · l lane · u refresh · b back · q quit"
            : state.viewState.view === "workspaceGate"
            ? "type absolute path · enter confirm · esc quit"
            : state.viewState.view === "launch"
            ? "↑/↓ instances · ↵ launch board · e rename · n add board · s stop · d remove · q quit · A global archive"
            : "↑/↓ cards · ←/→ lanes · b switch board · n new task · m move card · u refresh · ? help · q quit · A global archive",
        fg: COLORS.text,
        height: 1,
        flexGrow: 1,
        truncate: true,
      }),
      ui.Text({
        content: `${state.tasks.length} task${state.tasks.length === 1 ? "" : "s"} · last refresh ${refreshed}`,
        fg: state.error ? COLORS.bright : COLORS.muted,
        height: 1,
        width: 36,
        truncate: true,
      }),
    ),
  );
}

function renderHelpOverlay(ui: OpenTui) {
  const rows = [
    ["↑/↓", "move between cards"],
    ["←/→", "jump between lanes"],
    ["enter", "show Prompt/Handoff in Selected"],
    ["r", "run selected task"],
    ["R", "retry failed run"],
    ["a", "archive task"],
    ["A", "global archive browser"],
    ["d", "delete selected card"],
    ["s", "sync worktree"],
    ["i", "integrate branch"],
    ["x", "move to Done (completedBy: User)"],
    ["m", "manual move to lane"],
    ["g", "init git and run"],
    ["n", "new task"],
    ["u", "refresh board"],
    ["b", "switch instances"],
    ["e", "rename instance (launch view)"],
    ["esc", "detach / close overlay"],
    ["q", "quit"],
    ["", ""],
    ["ARCHIVE", ""],
    ["↑/↓", "navigate records"],
    ["←/→ / tab", "switch Prompt/Handoff tabs"],
    ["/", "search (enter to exit)"],
    ["i", "cycle instance filter"],
    ["l", "cycle lane filter"],
  ];

  return ui.Box(
    {
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      zIndex: 50,
      ...boxBg("#000000"),
      alignItems: "center",
      justifyContent: "center",
    },
    ui.Box(
      {
        width: 48,
        height: 30,
        flexDirection: "column",
        border: true,
        borderStyle: "single",
        borderColor: COLORS.border,
        ...boxBg(COLORS.bg),
        padding: 1,
        gap: 0,
      },
      ui.Box(
        { width: "100%", flexDirection: "row" },
        ui.Text({
          content: "Keys",
          fg: COLORS.text,
          attributes: ui.TextAttributes.BOLD,
          height: 1,
          flexGrow: 1,
        }),
        ui.Text({ content: "✕", fg: COLORS.dim, height: 1, width: 2 }),
      ),
      ui.Text({ content: "────────────────────────────────────────────", fg: COLORS.hairline, height: 1 }),
      ...rows.map(([key, description]) =>
        ui.Box(
          { width: "100%", flexDirection: "row", height: 1 },
          ui.Text({ content: key, fg: COLORS.text, width: 10, height: 1 }),
          ui.Text({ content: description, fg: COLORS.muted, flexGrow: 1, height: 1 }),
        ),
      ),
      ui.Text({ content: "────────────────────────────────────────────", fg: COLORS.hairline, height: 1 }),
      ui.Text({ content: "esc close", fg: COLORS.dim, height: 1 }),
    ),
  );
}

function renderNewTaskOverlay(ui: OpenTui, state: TuiState) {
  const draft = state.newTask ?? createNewTaskDraft(state);

  return ui.Box(
    {
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      zIndex: 50,
      ...boxBg("#000000"),
      flexDirection: "row",
    },
    ui.Box({ flexGrow: 1 }),
    ui.Box(
      {
        width: 52,
        height: "100%",
        flexDirection: "row",
        ...boxBg(COLORS.bg),
      },
      ui.Box({ width: 1, height: "100%", ...boxBg(COLORS.border) }),
      ui.Box(
        {
          flexGrow: 1,
          height: "100%",
          flexDirection: "column",
          ...boxBg(COLORS.bg),
          padding: 1,
          gap: 1,
        },
        ui.Box(
          { width: "100%", flexDirection: "row", height: 1 },
          ui.Text({
            content: "New Task",
            fg: COLORS.text,
            attributes: ui.TextAttributes.BOLD,
            height: 1,
            flexGrow: 1,
          }),
          ui.Text({ content: "✕", fg: COLORS.dim, height: 1, width: 2 }),
        ),
        ui.Text({ content: "────────────────────────────────────────────────", fg: COLORS.hairline, height: 1 }),
        ui.Box(
          {
            flexGrow: 1,
            flexDirection: "column",
            gap: 1,
            ...boxBg(COLORS.bg),
          },
          renderInputField(ui, "TITLE", draft.title, draft.field === "title", "", 1),
          renderInputField(
            ui,
            "PROMPT",
            draft.description,
            draft.field === "description",
            "Describe the task for the agent...",
            4,
          ),
          renderSelectField(ui, "AGENT", currentAgentLabel(draft), draft.field === "agent"),
          renderSelectField(ui, "MODEL", currentModelLabel(draft), draft.field === "model"),
          renderInputField(
            ui,
            "DIR",
            draft.field === "directory" ? draft.directory : shortPath(draft.directory),
            draft.field === "directory",
            state.cwd,
            1,
            COLORS.muted,
          ),
          renderIsolationField(ui, draft),
          draft.error
            ? ui.Text({ content: draft.error, fg: COLORS.bright, wrapMode: "word", height: 2 })
            : ui.Box({ height: 2 }),
        ),
        ui.Text({ content: "────────────────────────────────────────────────", fg: COLORS.hairline, height: 1 }),
        ui.Box(
          { width: "100%", flexDirection: "row", height: 1, gap: 1 },
          ui.Text({
            content: draft.submitting ? "Creating..." : "Create task",
            fg: COLORS.bright,
            ...textBg(COLORS.accent),
            height: 1,
            width: 14,
          }),
          ui.Text({ content: "esc cancel", fg: COLORS.muted, height: 1, flexGrow: 1 }),
        ),
        ui.Text({ content: "tab next field · shift+tab previous · enter create", fg: COLORS.dim, height: 1 }),
      ),
    ),
  );
}

function renderInputField(
  ui: OpenTui,
  label: string,
  value: string,
  focused: boolean,
  placeholder: string,
  contentHeight: number,
  valueColor = COLORS.text,
) {
  // Focused fields carry the block cursor in accent-bright (per the design
  // kit) as a styled chunk, so it keeps its color inside wrapped text.
  const content = focused
    ? ui.t`${ui.fg(valueColor)(value)}${ui.fg(COLORS.accentBright)("▍")}`
    : value.length > 0
      ? value
      : placeholder;
  const fg = value.length > 0 || focused ? valueColor : COLORS.dim;

  return renderFieldShell(
    ui,
    label,
    focused,
    contentHeight + 2,
    ui.Text({
      content,
      fg,
      height: contentHeight,
      wrapMode: contentHeight > 1 ? "word" : "none",
      truncate: contentHeight === 1,
    }),
  );
}

function renderSelectField(ui: OpenTui, label: string, value: string, focused: boolean) {
  return renderFieldShell(
    ui,
    label,
    focused,
    3,
    ui.Box(
      { flexDirection: "row", height: 1 },
      ui.Text({ content: value, fg: COLORS.text, flexGrow: 1, height: 1, truncate: true }),
      ui.Text({ content: "▾", fg: COLORS.dim, width: 2, height: 1 }),
    ),
  );
}

function renderIsolationField(ui: OpenTui, draft: NewTaskDraft) {
  const segments: Array<{ label: string; value?: TaskIsolationMode; disabled?: boolean }> = [
    { label: "none", value: "in-place" },
    { label: "worktree", value: "worktree" },
    { label: "container", disabled: true },
  ];

  return ui.Box(
    { width: "100%", flexDirection: "column", gap: 0 },
    ui.Text({ content: "ISOLATION", fg: COLORS.dim, height: 1 }),
    ui.Box(
      {
        width: "100%",
        height: 3,
        border: true,
        borderStyle: "single",
        borderColor: draft.field === "isolation" ? COLORS.borderHot : COLORS.border,
        flexDirection: "row",
        ...boxBg(COLORS.bg),
      },
      ...segments.map((segment) => {
        const active = segment.value === draft.isolation;
        return ui.Text({
          content: segment.label,
          fg: active ? COLORS.bright : segment.disabled ? COLORS.dim : COLORS.muted,
          ...textBg(active ? COLORS.accent : COLORS.bg),
          height: 1,
          flexGrow: 1,
          truncate: true,
        });
      }),
    ),
  );
}

function renderFieldShell(ui: OpenTui, label: string, focused: boolean, height: number, child: VChild) {
  return ui.Box(
    { width: "100%", flexDirection: "column", gap: 0 },
    ui.Text({ content: label, fg: COLORS.dim, height: 1 }),
    ui.Box(
      {
        width: "100%",
        height,
        border: true,
        borderStyle: "single",
        borderColor: focused ? COLORS.borderHot : COLORS.border,
        ...boxBg(COLORS.bg),
        paddingX: 1,
        justifyContent: "center",
      },
      child,
    ),
  );
}

export async function handleKeypress(key: KeyEvent, state: TuiState, actions: TuiActions): Promise<void> {
  const keyName = key.name || key.sequence;

  if (key.ctrl && keyName === "c") {
    actions.shutdown();
    return;
  }

  if (state.overlay === "help") {
    if (isEscapeKey(key) || key.sequence === "?") {
      state.overlay = "none";
      actions.render();
    }
    return;
  }

  if (state.overlay === "newTask") {
    await handleNewTaskKey(key, state, actions);
    return;
  }

  if (state.overlay === "addInstance") {
    await handleAddInstanceKey(key, state, actions);
    return;
  }

  if (state.overlay === "renameInstance") {
    await handleRenameInstanceKey(key, state, actions);
    return;
  }

  if (state.viewState.view === "archive") {
    await handleArchiveViewKey(key, state, actions);
    return;
  }

  if (state.viewState.view === "workspaceGate") {
    await handleWorkspaceGateKey(key, state, actions);
    return;
  }

  if (state.viewState.view === "launch") {
    await handleLaunchViewKey(key, state, actions);
    return;
  }

  if (state.viewState.view === "switcher") {
    await handleSwitcherKey(key, state, actions);
    return;
  }

  if (state.moveTargetColumn) {
    await handleInlineMoveKey(key, state, actions);
    return;
  }

  if (state.detailTab) {
    if (isEscapeKey(key)) {
      state.detailTab = undefined;
      actions.render();
      return;
    }
    if ((key.name || key.sequence) === "left" || (key.name || key.sequence) === "right" || key.sequence === "\t") {
      state.detailTab = state.detailTab === "prompt" ? "handoff" : "prompt";
      actions.render();
      return;
    }
  }

  // Board view keybindings
  switch (key.sequence) {
    case "q":
      actions.shutdown();
      return;
    case "?":
      state.overlay = "help";
      actions.render();
      return;
    case "n":
      state.newTask = createNewTaskDraft(state);
      state.overlay = "newTask";
      state.error = undefined;
      actions.render();
      return;
    case "u":
      await actions.refresh();
      return;
    case "r":
      await actions.runAction("run", (task) => actions.client.runTask(task.id));
      return;
    case "R":
      await actions.runAction("retry", (task) => actions.client.retryTask(task.id));
      return;
    case "a":
      await actions.archiveTask(state.selectedTaskId ?? "");
      return;
    case "A":
      await actions.openArchive();
      return;
    case "d":
      await actions.runAction("delete", (task) => actions.client.deleteTask(task.id));
      return;
    case "s":
      await actions.runAction("sync", (task) => actions.client.syncTask(task.id));
      return;
    case "i":
      await actions.runAction("integrate", (task) => actions.client.integrateTask(task.id));
      return;
    case "g":
      await actions.runAction("init git and run", (task) => actions.client.initGitAndRun(task.id));
      return;
    case "x":
      await actions.runAction("move done", (task) => {
        const endOfDone = state.tasks.filter((item) => item.column === "done" && item.id !== task.id).length;
        return actions.client.moveTask(task.id, "done", endOfDone, "User");
      });
      return;
    case "m":
      if (!state.selectedTaskId) {
        state.status = "no task selected to move";
        actions.render();
        return;
      }
      state.detailTab = undefined;
      state.moveTargetColumn = selectedTask(state)?.column;
      actions.render();
      return;
    case "b":
      state.viewState = openSwitcher(state.viewState);
      state.switcherSelectedIndex = state.instanceList.findIndex((item) => item.runtime.boardUrl === state.boardUrl);
      if (state.switcherSelectedIndex === -1) state.switcherSelectedIndex = 0;
      actions.render();
      return;
  }

  if (isEscapeKey(key)) {
    await actions.detachInstance();
    return;
  }

  if (isEnterKey(key) && state.selectedTaskId) {
    state.detailTab = state.detailTab ? undefined : "prompt";
    actions.render();
    return;
  }

  if (keyName === "down") {
    state.selectedTaskId = nextTaskId(state.tasks, state.selectedTaskId, 1);
    actions.render();
  } else if (keyName === "up") {
    state.selectedTaskId = nextTaskId(state.tasks, state.selectedTaskId, -1);
    actions.render();
  } else if (keyName === "left") {
    state.selectedTaskId = nearestTaskInColumn(state.tasks, state.selectedTaskId, -1);
    actions.render();
  } else if (keyName === "right") {
    state.selectedTaskId = nearestTaskInColumn(state.tasks, state.selectedTaskId, 1);
    actions.render();
  }
}

async function handleNewTaskKey(key: KeyEvent, state: TuiState, actions: TuiActions): Promise<void> {
  const draft = state.newTask ?? createNewTaskDraft(state);
  state.newTask = draft;

  if (isEscapeKey(key)) {
    state.overlay = "none";
    state.newTask = undefined;
    actions.render();
    return;
  }

  if (isTabKey(key)) {
    moveDraftField(draft, key.shift ? -1 : 1);
    actions.render();
    return;
  }

  if (isEnterKey(key)) {
    await createDraftTask(state, actions);
    return;
  }

  if ((key.name === "left" || key.name === "up") && cycleFocusedField(draft, state, -1)) {
    actions.render();
    return;
  }

  if ((key.name === "right" || key.name === "down" || key.sequence === " ") && cycleFocusedField(draft, state, 1)) {
    actions.render();
    return;
  }

  if (applyTextInput(draft, key)) {
    draft.error = undefined;
    actions.render();
  }
}

async function createDraftTask(state: TuiState, actions: TuiActions): Promise<void> {
  const draft = state.newTask;
  if (!draft || draft.submitting) return;

  const title = draft.title.trim();
  const directory = expandHomePath(draft.directory.trim());
  if (!title) {
    draft.error = "TITLE is required";
    actions.render();
    return;
  }
  if (!directory) {
    draft.error = "DIR is required";
    actions.render();
    return;
  }

  draft.submitting = true;
  draft.error = undefined;
  state.status = `creating task: ${title}`;
  actions.render();

  try {
    const task = await actions.client.createTask({
      title,
      description: draft.description,
      directory,
      agent: draft.agentId || undefined,
      model: draft.model,
      isolation: draft.isolation,
    });
    state.overlay = "none";
    state.newTask = undefined;
    state.error = undefined;
    state.status = `created task: ${task.title}`;
    await actions.refresh(true);
    state.selectedTaskId = task.id;
    actions.render();
  } catch (error) {
    draft.submitting = false;
    draft.error = errorMessage(error);
    state.status = "create task failed";
    actions.render();
  }
}

function createNewTaskDraft(state: TuiState): NewTaskDraft {
  const agentId = defaultAgentId(state.agents);
  const agent = state.agents.find((item) => item.id === agentId);
  return {
    title: "",
    description: "",
    directory: state.cwd,
    agentId,
    model: agent?.model,
    isolation: "worktree",
    field: "title",
    submitting: false,
  };
}

function moveDraftField(draft: NewTaskDraft, delta: number): void {
  const index = FIELD_ORDER.indexOf(draft.field);
  draft.field = FIELD_ORDER[(index + delta + FIELD_ORDER.length) % FIELD_ORDER.length];
}

function cycleFocusedField(draft: NewTaskDraft, state: TuiState, delta: number): boolean {
  switch (draft.field) {
    case "agent":
      cycleAgent(draft, state.agents, delta);
      return true;
    case "model":
      cycleModel(draft, state.agents, delta);
      return true;
    case "isolation":
      draft.isolation = draft.isolation === "worktree" ? "in-place" : "worktree";
      return true;
    default:
      return false;
  }
}

function cycleAgent(draft: NewTaskDraft, agents: RosterAgent[], delta: number): void {
  const ids = ["", ...agents.map((agent) => agent.id)];
  const current = Math.max(0, ids.indexOf(draft.agentId));
  draft.agentId = ids[(current + delta + ids.length) % ids.length] ?? "";
  const agent = agents.find((item) => item.id === draft.agentId);
  draft.model = agent?.model;
}

function cycleModel(draft: NewTaskDraft, agents: RosterAgent[], delta: number): void {
  const options = [undefined, ...uniqueModels(agents)];
  const current = Math.max(
    0,
    options.findIndex((model) => sameModel(model, draft.model)),
  );
  draft.model = options[(current + delta + options.length) % options.length];
}

function applyTextInput(draft: NewTaskDraft, key: KeyEvent): boolean {
  if (draft.field !== "title" && draft.field !== "description" && draft.field !== "directory") return false;

  if (key.name === "backspace" || key.sequence === "\u007f" || key.sequence === "\b") {
    setDraftText(draft, readDraftText(draft).slice(0, -1));
    return true;
  }

  if (key.ctrl || key.meta || key.sequence.length !== 1 || key.sequence < " ") return false;
  setDraftText(draft, `${readDraftText(draft)}${key.sequence}`);
  return true;
}

function readDraftText(draft: NewTaskDraft): string {
  switch (draft.field) {
    case "title":
      return draft.title;
    case "description":
      return draft.description;
    case "directory":
      return draft.directory;
    default:
      return "";
  }
}

function setDraftText(draft: NewTaskDraft, value: string): void {
  switch (draft.field) {
    case "title":
      draft.title = value;
      return;
    case "description":
      draft.description = value;
      return;
    case "directory":
      draft.directory = value;
      return;
  }
}

async function handleWorkspaceGateKey(key: KeyEvent, state: TuiState, actions: TuiActions): Promise<void> {
  if (state.workspaceGateSubmitting) return;

  if (isEscapeKey(key)) {
    actions.shutdown();
    return;
  }

  if (isEnterKey(key)) {
    await actions.setupWorkspace();
    return;
  }

  if (key.name === "backspace" || key.sequence === "\u007f" || key.sequence === "\b") {
    state.workspaceGateInput = state.workspaceGateInput.slice(0, -1);
    state.workspaceGateError = undefined;
    actions.render();
    return;
  }

  if (key.ctrl || key.meta || key.sequence.length !== 1 || key.sequence < " ") return;

  state.workspaceGateInput += key.sequence;
  state.workspaceGateError = undefined;
  actions.render();
}

async function handleLaunchViewKey(key: KeyEvent, state: TuiState, actions: TuiActions): Promise<void> {
  const keyName = key.name || key.sequence;

  if (isEscapeKey(key)) {
    actions.shutdown();
    return;
  }

  if (keyName === "down") {
    state.selectedInstanceIndex = Math.min(state.selectedInstanceIndex + 1, state.instanceList.length - 1);
    actions.render();
    return;
  }

  if (keyName === "up") {
    state.selectedInstanceIndex = Math.max(state.selectedInstanceIndex - 1, 0);
    actions.render();
    return;
  }

  if (isEnterKey(key)) {
    const item = state.instanceList[state.selectedInstanceIndex];
    if (item) {
      await actions.attachInstance(item);
    }
    return;
  }

  if (key.sequence === "n") {
    state.addInstance = { name: "", workspace: state.cwd, field: "name", submitting: false, error: undefined };
    state.overlay = "addInstance";
    actions.render();
    return;
  }

  if (key.sequence === "e") {
    const item = state.instanceList[state.selectedInstanceIndex];
    if (item) {
      state.renameInstance = { oldName: item.definition.name, newName: "", field: "newName", submitting: false, error: undefined };
      state.overlay = "renameInstance";
      actions.render();
    }
    return;
  }

  if (key.sequence === "A") {
    await actions.openArchive();
    return;
  }

  if (key.sequence === "s") {
    const item = state.instanceList[state.selectedInstanceIndex];
    if (item && item.runtime.status === "running") {
      await actions.stopInstance(item.definition.name);
    }
    return;
  }

  if (key.sequence === "d") {
    const item = state.instanceList[state.selectedInstanceIndex];
    if (item && item.runtime.status !== "running" && state.confirmRemoveName === item.definition.name) {
      await actions.removeInstance(item.definition.name);
    } else if (item && item.runtime.status === "running") {
      state.status = "Cannot remove running instance";
      actions.render();
    } else if (item) {
      state.confirmRemoveName = item.definition.name;
      state.status = `Press d again to remove ${item.definition.name}`;
      actions.render();
    }
    return;
  }
}

async function handleSwitcherKey(key: KeyEvent, state: TuiState, actions: TuiActions): Promise<void> {
  const keyName = key.name || key.sequence;

  if (isEscapeKey(key)) {
    state.viewState = closeSwitcher(state.viewState);
    actions.render();
    return;
  }

  if (keyName === "down") {
    state.switcherSelectedIndex = Math.min(state.switcherSelectedIndex + 1, state.instanceList.length - 1);
    actions.render();
    return;
  }

  if (keyName === "up") {
    state.switcherSelectedIndex = Math.max(state.switcherSelectedIndex - 1, 0);
    actions.render();
    return;
  }

  if (isEnterKey(key)) {
    const item = state.instanceList[state.switcherSelectedIndex];
    if (item) {
      if (item.runtime.boardUrl !== state.boardUrl) {
        await actions.attachInstance(item);
      }
      state.viewState = selectInstanceInSwitcher(state.viewState);
    }
    actions.render();
    return;
  }
}

async function handleAddInstanceKey(key: KeyEvent, state: TuiState, actions: TuiActions): Promise<void> {
  const draft = state.addInstance;
  if (!draft) return;

  if (isEscapeKey(key)) {
    state.overlay = "none";
    state.addInstance = undefined;
    actions.render();
    return;
  }

  if (isTabKey(key)) {
    draft.field = draft.field === "name" ? "workspace" : "name";
    actions.render();
    return;
  }

  if (isEnterKey(key)) {
    const name = validateInstanceName(draft.name);
    if (!name.ok) {
      draft.error = name.error;
      actions.render();
      return;
    }
    if (!draft.workspace.trim()) {
      draft.error = "WORKSPACE is required";
      actions.render();
      return;
    }
    draft.submitting = true;
    draft.error = undefined;
    actions.render();
    await actions.addInstance(name.value, draft.workspace.trim());
    return;
  }

  if (key.name === "backspace" || key.sequence === "\u007f" || key.sequence === "\b") {
    if (draft.field === "name") draft.name = draft.name.slice(0, -1);
    else draft.workspace = draft.workspace.slice(0, -1);
    draft.error = undefined;
    actions.render();
    return;
  }

  if (key.ctrl || key.meta || key.sequence.length !== 1 || key.sequence < " ") return;

  if (draft.field === "name") draft.name += key.sequence;
  else draft.workspace += key.sequence;
  draft.error = undefined;
  actions.render();
}

async function handleRenameInstanceKey(key: KeyEvent, state: TuiState, actions: TuiActions): Promise<void> {
  const draft = state.renameInstance;
  if (!draft) return;

  if (isEscapeKey(key)) {
    state.overlay = "none";
    state.renameInstance = undefined;
    actions.render();
    return;
  }

  if (isEnterKey(key)) {
    const name = validateInstanceName(draft.newName);
    if (!name.ok) {
      draft.error = name.error;
      actions.render();
      return;
    }
    draft.submitting = true;
    draft.error = undefined;
    actions.render();
    await actions.renameInstance(draft.oldName, name.value);
    return;
  }

  if (key.name === "backspace" || key.sequence === "\u007f" || key.sequence === "\b") {
    draft.newName = draft.newName.slice(0, -1);
    draft.error = undefined;
    actions.render();
    return;
  }

  if (key.ctrl || key.meta || key.sequence.length !== 1 || key.sequence < " ") return;
  draft.newName += key.sequence;
  draft.error = undefined;
  actions.render();
}

async function handleInlineMoveKey(key: KeyEvent, state: TuiState, actions: TuiActions): Promise<void> {
  const keyName = key.name || key.sequence;
  const task = selectedTask(state);

  if (isEscapeKey(key)) {
    state.moveTargetColumn = undefined;
    actions.render();
    return;
  }

  if (isEnterKey(key) && task) {
    const target = state.moveTargetColumn ?? task.column;
    if (target === task.column) {
      // No change, just close
      state.moveTargetColumn = undefined;
      actions.render();
      return;
    }
    const targetLane = state.tasks.filter((item) => item.column === target && item.id !== task.id).length;
    const completedBy = target === "done" ? "User" : null;
    state.moveTargetColumn = undefined;
    try {
      state.status = `moving ${task.title} to ${TUI_COLUMN_LABELS[target]}...`;
      actions.render();
      const freshTasks = await actions.client.moveTask(task.id, target, targetLane, completedBy);
      state.tasks = freshTasks;
      state.status = `moved ${task.title} to ${TUI_COLUMN_LABELS[target]}`;
      state.selectedTaskId = task.id;
    } catch (error) {
      state.error = errorMessage(error);
      state.status = "move failed";
    }
    actions.render();
    return;
  }

  if (keyName === "down") {
    state.moveTargetColumn = nextColumn(state.moveTargetColumn ?? task?.column ?? "todo", 1);
    actions.render();
    return;
  }

  if (keyName === "up") {
    state.moveTargetColumn = nextColumn(state.moveTargetColumn ?? task?.column ?? "todo", -1);
    actions.render();
    return;
  }

  // Number keys 1-4 select lane directly
  const numMap: Record<string, Column> = { "1": "todo", "2": "in_progress", "3": "review", "4": "done" };
  if (key.sequence in numMap) {
    state.moveTargetColumn = numMap[key.sequence];
    actions.render();
    return;
  }
}

function nextColumn(current: Column, delta: number): Column {
  const index = TUI_COLUMNS.indexOf(current);
  return TUI_COLUMNS[(index + delta + TUI_COLUMNS.length) % TUI_COLUMNS.length];
}

async function handleArchiveViewKey(key: KeyEvent, state: TuiState, actions: TuiActions): Promise<void> {
  const archive = state.archive;
  if (!archive) return;
  const keyName = key.name || key.sequence;

  if (archive.searchMode) {
    if (isEscapeKey(key)) {
      archive.searchMode = false;
      archive.searchQuery = "";
    } else if (key.name === "backspace" || key.sequence === "\u007f" || key.sequence === "\b") {
      archive.searchQuery = archive.searchQuery.slice(0, -1);
    } else if (isEnterKey(key)) {
      archive.searchMode = false;
    } else if (!key.ctrl && !key.meta && key.sequence.length === 1 && key.sequence >= " ") {
      archive.searchQuery += key.sequence;
    }
    archive.selectedIndex = clampIndex(archive.selectedIndex, filteredArchiveRecords(archive).length);
    actions.render();
    return;
  }

  if (key.sequence === "q") {
    actions.shutdown();
    return;
  }
  if (key.sequence === "b" || isEscapeKey(key)) {
    actions.closeArchive();
    return;
  }
  if (keyName === "left" || keyName === "right" || key.sequence === "\t") {
    archive.detailTab = archive.detailTab === "prompt" ? "handoff" : "prompt";
    actions.render();
    return;
  }
  if (key.sequence === "u") {
    await actions.refreshArchive();
    return;
  }
  if (key.sequence === "/") {
    archive.searchMode = true;
    actions.render();
    return;
  }
  if (key.sequence === "i") {
    archive.instanceFilter = nextCycleValue(archive.instanceFilter, uniqueArchiveInstances(archive.records));
    archive.selectedIndex = clampIndex(archive.selectedIndex, filteredArchiveRecords(archive).length);
    actions.render();
    return;
  }
  if (key.sequence === "l") {
    archive.laneFilter = nextCycleValue(archive.laneFilter, ["todo", "in_progress", "review", "done"]);
    archive.selectedIndex = clampIndex(archive.selectedIndex, filteredArchiveRecords(archive).length);
    actions.render();
    return;
  }
  if (keyName === "down") {
    archive.selectedIndex = clampIndex(archive.selectedIndex + 1, filteredArchiveRecords(archive).length);
    actions.render();
    return;
  }
  if (keyName === "up") {
    archive.selectedIndex = clampIndex(archive.selectedIndex - 1, filteredArchiveRecords(archive).length);
    actions.render();
  }
}

function currentAgentLabel(draft: NewTaskDraft): string {
  return draft.agentId || "default";
}

function currentModelLabel(draft: NewTaskDraft): string {
  return draft.model ? modelLabel(draft.model) : "agent default";
}

function defaultAgentId(agents: RosterAgent[]): string {
  return agents.find((agent) => agent.id === "build")?.id ?? agents[0]?.id ?? "";
}

function uniqueModels(agents: RosterAgent[]): ModelRef[] {
  const models: ModelRef[] = [];
  for (const agent of agents) {
    if (agent.model && !models.some((model) => sameModel(model, agent.model))) {
      models.push(agent.model);
    }
  }
  return models;
}

function sameModel(left: ModelRef | undefined, right: ModelRef | undefined): boolean {
  if (!left || !right) return left === right;
  return left.providerID === right.providerID && left.id === right.id && left.variant === right.variant;
}

function isEscapeKey(key: KeyEvent): boolean {
  return key.name === "escape" || key.name === "esc" || key.sequence === "\u001b";
}

function isTabKey(key: KeyEvent): boolean {
  return key.name === "tab" || key.sequence === "\t";
}

function isEnterKey(key: KeyEvent): boolean {
  return key.name === "return" || key.name === "enter" || key.sequence === "\r" || key.sequence === "\n";
}

function expandHomePath(path: string): string {
  const home = process.env.HOME;
  if (!home) return path;
  if (path === "~") return home;
  if (path.startsWith("~/")) return `${home}/${path.slice(2)}`;
  return path;
}

function resolveSelectedTaskId(tasks: Task[], selectedTaskId: string | undefined): string | undefined {
  if (selectedTaskId && tasks.some((task) => task.id === selectedTaskId)) return selectedTaskId;
  return (
    tasksByColumn(tasks).in_progress[0]?.id ??
    tasksByColumn(tasks).review[0]?.id ??
    tasksByColumn(tasks).todo[0]?.id ??
    tasks[0]?.id
  );
}

function selectedTask(state: TuiState): Task | undefined {
  return state.tasks.find((task) => task.id === state.selectedTaskId);
}

function currentInstanceItem(state: TuiState): InstanceListItem | undefined {
  return state.instanceList.find((item) => item.runtime.boardUrl === state.boardUrl);
}

function parseCompletion(json: string | null): CompletionReport | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as Partial<CompletionReport>;
    if (typeof value.summary !== "string") return null;
    return {
      outcome: value.outcome === "blocked" ? "blocked" : "complete",
      summary: value.summary,
      changedFiles: Array.isArray(value.changedFiles) ? value.changedFiles.filter((item): item is string => typeof item === "string") : [],
      verification: Array.isArray(value.verification)
        ? value.verification.filter((item): item is CompletionReport["verification"][number] => typeof item?.command === "string" && typeof item?.result === "string")
        : [],
      residualRisk: typeof value.residualRisk === "string" ? value.residualRisk : "none",
      reportedAt: typeof value.reportedAt === "number" ? value.reportedAt : 0,
    };
  } catch {
    return null;
  }
}

function parseModelRef(json: string | null): ModelRef | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as Partial<ModelRef>;
    if (typeof value.providerID === "string" && typeof value.id === "string") {
      return { providerID: value.providerID, id: value.id, ...(typeof value.variant === "string" ? { variant: value.variant } : {}) };
    }
  } catch {
    return null;
  }
  return null;
}

function formatArchiveDate(ms: number): string {
  const date = new Date(ms);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

function uniqueArchiveInstances(records: GlobalArchiveRecord[]): string[] {
  return [...new Set(records.map((record) => record.source_instance_name).filter((value): value is string => Boolean(value)))];
}

function nextCycleValue(current: string | null, values: string[]): string | null {
  if (values.length === 0) return null;
  if (current === null) return values[0] ?? null;
  const index = values.indexOf(current);
  if (index === -1 || index === values.length - 1) return null;
  return values[index + 1] ?? null;
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return (await response.text()) || response.statusText || "request failed";
  } catch {
    return response.statusText || "request failed";
  }
}

function laneColor(task: Task): TuiColor {
  if (task.runState === "error") return COLORS.laneError;
  switch (task.column) {
    case "todo":
      return COLORS.laneTodo;
    case "in_progress":
      return COLORS.laneInProgress;
    case "review":
      return COLORS.laneReview;
    case "done":
      return COLORS.laneDone;
  }
}

// Status brightness coding (never hue): error is loud white, a live run glows teal,
// and unstarted/done work recedes to dim. Mirrors `taskStatus`'s lane awareness.
function taskStatusColor(task: Task): TuiColor {
  if (task.runState === "error") return COLORS.bright;
  if (task.pending === "git-init") return COLORS.muted;
  if (task.runState === "running") return COLORS.accentBright;
  if (task.column === "done") return COLORS.dim;
  if (task.column === "review") return COLORS.muted;
  if (task.runState === "idle") return COLORS.muted;
  return COLORS.dim;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectRun(): boolean {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
}

if (isDirectRun()) {
  runOpenBoardTui().catch((error: unknown) => {
    restoreTerminalForShell();
    console.error(errorMessage(error));
    process.exit(1);
  });
}
