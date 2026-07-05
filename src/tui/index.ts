#!/usr/bin/env node
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createBoardClient } from "../client/board-client";
import type { BoardClient, BoardHealth } from "../client/board-client";
import { CLAUDE_CODE_MODELS, CLAUDE_CODE_PERMISSION_MODES, DEFAULT_CLAUDE_CODE_PERMISSION_MODE, USER_COMPLETED_BY, type ClaudeCodePermissionMode, type Column, type CompletionReport, type ModelRef, type RosterAgent, type Task, type TaskComment, type TaskHarness, type TaskIsolationMode, type TaskType } from "../shared";
import { validateInstanceName } from "../shared/instances";
import { assertOpenTuiRuntime } from "./runtime";
import {
  TUI_COLUMN_LABELS,
  TUI_COLUMNS,
  TUI_LAYOUT,
  TUI_MIN_SIZE,
  agentLabel,
  archiveListWindow,
  modelLabel,
  laneCapacity,
  laneInnerHeight,
  nearestTaskInColumn,
  nextTaskId,
  reconcileLaneOffset,
  shortPath,
  sidebarDetailMode,
  tasksByColumn,
  boardFilterCategories,
  boardFilterOptions,
  filterTasks,
  type BoardFilter,
  type BoardFilterKind,
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
import {
  buildConfirmationCopy,
  buildRunConfidenceDetails,
  clearConfirmation,
  confirmationStatus,
  formatConfidenceDetail,
  requestConfirmation,
  type ConfirmableAction,
  type PendingConfirmation,
} from "./confirmations";
import { compactTaskBoardLabel, taskLifecycleDetailRows } from "./lifecycle";
import { createRootLifecycle } from "./root-lifecycle";
import { buildWordmarkRows } from "./wordmark";
import { RGBA, type KeyEvent, type PasteEvent, type ScrollBoxOptions, type VChild } from "@opentui/core";

type OpenTui = typeof import("@opentui/core");
type TuiColor = string | RGBA;

const ROOT_ID = "openboard-root";
const POLL_INTERVAL_MS = 2500;
const WORDMARK_WIDTH = 45;
const WORDMARK_HEIGHT = 6;
const SIDEBAR_MIN_WIDTH = 44;
const SIDEBAR_MAX_WIDTH = 68;
const SIDEBAR_GROWTH_START_WIDTH = TUI_MIN_SIZE.columns;
const SIDEBAR_META_LABEL_WIDTH = 13;
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

const AGENT_FIELD_ORDER = ["type", "title", "description", "harness", "agent", "model", "directory", "isolation"] as const;
const CLAUDE_FIELD_ORDER = ["type", "title", "description", "harness", "permissionMode", "model", "directory", "isolation"] as const;
const MANUAL_FIELD_ORDER = ["type", "title", "description", "assignedTo"] as const;
const TEXT_INPUT_COLUMNS = 56;
type Overlay = "none" | "help" | "newTask" | "addInstance" | "renameInstance";
type NewTaskField = (typeof AGENT_FIELD_ORDER)[number] | (typeof CLAUDE_FIELD_ORDER)[number] | (typeof MANUAL_FIELD_ORDER)[number];
type TextInputField = Extract<NewTaskField, "title" | "description" | "directory" | "assignedTo">;
type AddInstanceField = "name" | "workspace";
type RenameInstanceField = "newName";

interface GlobalArchiveRecord {
  source_instance_name: string | null;
  source_port: number;
  source_workspace: string;
  source_db_path: string;
  task_id: string;
  task_type?: TaskType | string | null;
  title: string;
  description: string;
  directory: string;
  agent: string | null;
  assigned_to?: string | null;
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
  completed_by?: string | null;
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
  type: TaskType;
  title: string;
  description: string;
  directory: string;
  harness: TaskHarness;
  agentId: string;
  claudePermissionMode: ClaudeCodePermissionMode;
  assignedTo: string;
  model?: ModelRef;
  isolation: TaskIsolationMode;
  field: NewTaskField;
  textCursors?: Partial<Record<TextInputField, number>>;
  textScrolls?: Partial<Record<TextInputField, number>>;
  textSelection?: { field: TextInputField; start: number; end: number };
  submitting: boolean;
  error?: string;
  /** Set when this draft edits an existing To Do card rather than creating a new one. */
  editingTaskId?: string;
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

/** Detail tabs shown for a selected card via Enter. */
export type TaskDetailTab = "prompt" | "handoff" | "output" | "comments";

/** State for the two-step selected-column filter picker opened with f/F. */
interface FilterModeState {
  column: Column;
  step: "category" | "value";
  category?: BoardFilterKind;
  selectedIndex: number;
}

/** Cached comment thread for the Comments detail tab, keyed to the task currently viewed. */
interface CommentsPanelState {
  taskId: string;
  items: TaskComment[];
  loading: boolean;
  error?: string;
  selectedIndex: number;
}

/** In-progress compose state for a new top-level comment or a reply. */
interface CommentDraftState {
  taskId: string;
  parentCommentId: string | null;
  text: string;
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
  health?: BoardHealth;
  healthError?: string;
  cwd: string;
  overlay: Overlay;
  newTask?: NewTaskDraft;
  addInstance?: AddInstanceDraft;
  renameInstance?: RenameInstanceDraft;
  archive?: ArchiveState;
  archiveBoardUrl?: string;
  terminalCols: number;
  terminalRows: number;
  laneOffsets: Record<Column, number>;
  // Instance management
  viewState: ViewState;
  instanceProvider: InstanceLifecycleProvider;
  instanceList: InstanceListItem[];
  selectedInstanceIndex: number;
  fetchingCardCounts: Set<string>;
  switcherSelectedIndex: number;
  instanceActionState: Record<string, "starting" | "stopping" | undefined>;
  confirmRemoveName?: string;
  detailTab?: TaskDetailTab;
  moveTargetColumn?: Column;
  pendingConfirmation?: PendingConfirmation;
  workspaceGateInput: string;
  workspaceGateError?: string;
  workspaceGateSubmitting: boolean;
  // Selected-column filter (f/F)
  boardFilter?: BoardFilter;
  filterMode?: FilterModeState;
  // Comments detail tab
  comments?: CommentsPanelState;
  commentDraft?: CommentDraftState;
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
    terminalCols: renderer.terminalWidth,
    terminalRows: renderer.terminalHeight,
    laneOffsets: { todo: 0, in_progress: 0, review: 0, done: 0 },
    viewState: initialAttach ? transitionView(initialViewState, "board") : initialViewState,
    instanceProvider: provider,
    instanceList: [],
    selectedInstanceIndex: 0,
    fetchingCardCounts: new Set(),
    switcherSelectedIndex: 0,
    instanceActionState: {},
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
      state.terminalCols = renderer.terminalWidth;
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
      const [tasks, agents, healthResult] = await Promise.all([
        currentClient.listTasks(),
        currentClient.listAgents(),
        currentClient.getHealth().then(
          (health) => ({ ok: true as const, health }),
          (error) => ({ ok: false as const, error }),
        ),
      ]);
      state.tasks = tasks;
      state.agents = agents;
      state.selectedTaskId = resolveSelectedTaskId(tasks, state.selectedTaskId);
      state.pendingConfirmation = clearPendingForSelection(state, state.selectedTaskId);
      if (healthResult.ok) {
        state.health = healthResult.health;
        state.healthError = undefined;
      } else {
        state.health = undefined;
        state.healthError = errorMessage(healthResult.error);
      }
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
    state.instanceActionState[name] = "starting";
    render();
    try {
      await state.instanceProvider.start(name);
      await refreshInstanceList();
      state.status = `started ${name}`;
    } catch (error) {
      state.error = errorMessage(error);
      state.status = `start failed: ${errorMessage(error)}`;
    } finally {
      delete state.instanceActionState[name];
    }
    render();
  };

  const stopInstance = async (name: string) => {
    state.status = `stopping ${name}...`;
    state.instanceActionState[name] = "stopping";
    render();
    try {
      await state.instanceProvider.stop(name);
      await refreshInstanceList();
      state.status = `stopped ${name}`;
    } catch (error) {
      state.error = errorMessage(error);
      state.status = `stop failed: ${errorMessage(error)}`;
    } finally {
      delete state.instanceActionState[name];
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

  renderer.keyInput.on("paste", (event) => {
    handlePaste(event, state, { render });
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
  if (isBelowMinimumSize(state)) return renderMinimumSizeApp(ui, state);

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

function isBelowMinimumSize(state: Pick<TuiState, "terminalCols" | "terminalRows">): boolean {
  return state.terminalCols < TUI_MIN_SIZE.columns || state.terminalRows < TUI_MIN_SIZE.rows;
}

function renderMinimumSizeApp(ui: OpenTui, state: TuiState) {
  return ui.Box(
    {
      id: ROOT_ID,
      width: "100%",
      height: "100%",
      ...boxBg(COLORS.bg),
      flexDirection: "column",
      padding: 1,
      gap: 1,
      alignItems: "center",
      justifyContent: "center",
    },
    ui.Text({
      content: "OpenBoard needs more room",
      fg: COLORS.bright,
      attributes: ui.TextAttributes.BOLD,
      height: 1,
      truncate: true,
    }),
    ui.Text({
      content: `Current ${state.terminalCols}x${state.terminalRows} · minimum ${TUI_MIN_SIZE.columns}x${TUI_MIN_SIZE.rows}`,
      fg: COLORS.muted,
      height: 1,
      truncate: true,
    }),
    ui.Text({
      content: "Resize the terminal to continue · q quit",
      fg: COLORS.text,
      height: 1,
      truncate: true,
    }),
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
  let healthLabel = boardHealthLabel(state);
  let instanceLabel = "";
  let workspaceLabel = "";
  let filterLabel = "";

  if (state.viewState.view === "board") {
    const currentInstance = currentInstanceItem(state);
    if (currentInstance) {
      instanceLabel = ` · INSTANCE ${currentInstance.definition.name}:${currentInstance.definition.port}`;
      workspaceLabel = `WORKSPACE ${shortPath(currentInstance.definition.workspace)}`;
    } else {
      workspaceLabel = `WORKSPACE ${shortPath(state.cwd)}`;
    }
    if (state.boardFilter) filterLabel = `FILTER ${state.boardFilter.kind}:${state.boardFilter.value}`;
  } else if (state.viewState.view === "launch") {
    connection = "";
    host = "";
    taskLabel = "";
    refreshed = "";
    healthLabel = "";
    workspaceLabel = "";
  } else if (state.viewState.view === "workspaceGate") {
    connection = "SETUP";
    host = "";
    taskLabel = "";
    refreshed = "";
    healthLabel = "";
    workspaceLabel = "";
  } else if (state.viewState.view === "switcher") {
    connection = "SWITCHER";
    host = "";
    taskLabel = "";
    refreshed = "";
    healthLabel = "";
    workspaceLabel = "";
  } else if (state.viewState.view === "archive") {
    connection = "ARCHIVE";
    host = "";
    taskLabel = `${state.archive?.records.length ?? 0} RECORD${state.archive?.records.length === 1 ? "" : "S"}`;
    refreshed = "";
    healthLabel = "";
    workspaceLabel = "";
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
      content: [connection, host, instanceLabel.replace(/^ · /, ""), workspaceLabel, filterLabel, taskLabel, refreshed, healthLabel].filter(Boolean).join(" · "),
      fg: state.error ? COLORS.bright : COLORS.muted,
      height: 1,
      truncate: true,
    }),
  );
}

function boardHealthLabel(state: TuiState): string {
  if (state.health?.adapter === "ok") {
    const opencode = state.health.opencode.status === "ok"
      ? `OpenCode ${state.health.opencode.version}`
      : "OpenCode unreachable";
    return `Board ok · ${opencode}`;
  }
  return state.healthError ? "Board health unknown" : "";
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
  const selectedIndex = archive ? clampIndex(archive.selectedIndex, records.length) : 0;
  const selected = archive ? records[selectedIndex] : undefined;
  const window = archiveListWindow(selectedIndex, records.length, state.terminalRows);
  const visibleRecords = records.slice(window.offset, window.offset + window.capacity);
  const hiddenBelow = records.length - window.offset - visibleRecords.length;

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
            ...(window.offset > 0 ? [renderArchiveOverflow(ui, window.offset, "↑")] : []),
            ...visibleRecords.map((record, index) =>
              renderArchiveRow(ui, state, record, window.offset + index === selectedIndex),
            ),
            ...(hiddenBelow > 0 ? [renderArchiveOverflow(ui, hiddenBelow, "↓")] : []),
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

function renderArchiveOverflow(ui: OpenTui, count: number, arrow: string) {
  return ui.Text({
    content: `${arrow} ${count} archived task${count === 1 ? "" : "s"}`,
    fg: COLORS.dim,
    height: 1,
    truncate: true,
  });
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
  const rows = archiveDetailRows(record, model);

  const activeTabFg = COLORS.accentBright;
  const inactiveTabFg = COLORS.dim;
  const promptActive = tab === "prompt";
  const handoffActive = tab === "handoff";

  const tabContent: VChild =
    tab === "prompt"
      ? renderScrollableDetailText(ui, `archive-detail-prompt-${record.task_id}`, record.description || "(empty prompt)")
      : renderHandoffTab(ui, completion, `archive-detail-handoff-${record.task_id}`);

  return ui.Box(
    { flexGrow: 1, flexDirection: "column", gap: 1, ...boxBg(COLORS.panel) },
    ui.Text({ content: record.title, fg: COLORS.text, attributes: ui.TextAttributes.BOLD, wrapMode: "word", height: 3 }),
    ui.Box(
      { width: "100%", height: rows.length, flexDirection: "column", gap: 0, ...boxBg(COLORS.panel) },
      ...rows.map((row) => renderTaskMeta(ui, row, false, SIDEBAR_META_LABEL_WIDTH, COLORS.bright)),
    ),
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

function archiveDetailRows(record: GlobalArchiveRecord, model: ModelRef | null): MetaRow[] {
  const taskType = record.task_type === "manual" ? "manual" : "agent";
  return [
    { label: "INSTANCE", value: `${record.source_instance_name ?? "unknown"}:${record.source_port}`, color: COLORS.text },
    { label: "TYPE", value: taskType, color: COLORS.text },
    ...(record.completed_by ? [{ label: "ACCEPTED BY", value: record.completed_by, color: COLORS.text }] : []),
    { label: "LANE", value: TUI_COLUMN_LABELS[archiveColumn(record.column_name)], color: COLORS.text },
    ...(taskType === "manual"
      ? [{ label: "ASSIGNED TO", value: record.assigned_to ?? "unassigned", color: COLORS.text }]
      : [
          { label: "AGENT", value: record.agent ?? "unassigned", color: COLORS.text },
          { label: "MODEL", value: model ? modelLabel(model) : "agent default", color: COLORS.text },
          { label: "DIR", value: shortPath(record.directory), color: COLORS.text },
          { label: "ISO", value: record.isolation ?? "board default", color: COLORS.text },
          ...(record.isolation === "worktree"
            ? [{ label: "WORKTREE", value: archiveWorktreeId(record), color: COLORS.text }]
            : []),
        ]),
    ...(record.session_id ? [{ label: "SESSION", value: record.session_id, color: COLORS.text }] : []),
    { label: "WORKSPACE", value: shortPath(record.source_workspace), color: COLORS.text },
    { label: "ARCHIVED", value: formatArchiveDate(record.archived_at), color: COLORS.text },
  ];
}

function archiveColumn(column: string): Column {
  return TUI_COLUMNS.includes(column as Column) ? column as Column : "todo";
}

function archiveWorktreeId(record: Pick<GlobalArchiveRecord, "task_id" | "worktree_path" | "worktree_branch">): string {
  if (record.worktree_path) return record.worktree_path.split("/").filter(Boolean).at(-1) ?? record.task_id;
  if (record.worktree_branch) return record.worktree_branch.split("/").filter(Boolean).at(-1) ?? record.task_id;
  return record.task_id;
}

function renderScrollableDetailText(ui: OpenTui, id: string, content: string) {
  return ui.ScrollBox(
    scrollBoxProps(id),
    ui.Text({ content, fg: COLORS.text, width: "100%", minWidth: 0, flexShrink: 1, wrapMode: "word" }),
  );
}

function scrollBoxProps(id: string): ScrollBoxOptions {
  return {
    id,
    flexGrow: 1,
    minHeight: 0,
    scrollY: true,
    scrollX: false,
    stickyScroll: false,
    ...boxBg(COLORS.panel),
    contentOptions: {
      flexDirection: "column",
      gap: 1,
      ...boxBg(COLORS.panel),
    },
    viewportOptions: {
      ...boxBg(COLORS.panel),
    },
    wrapperOptions: {
      ...boxBg(COLORS.panel),
    },
  };
}

function renderHandoffTab(ui: OpenTui, completion: CompletionReport | null, scrollId: string) {
  if (!completion) {
    return ui.ScrollBox(
      scrollBoxProps(scrollId),
      ui.Text({ content: "No completion report available", fg: COLORS.muted, height: 1 }),
    );
  }

  const changedFiles = completion.changedFiles.length ? completion.changedFiles : ["none"];
  const verification = completion.verification.length
    ? completion.verification.map((item) => `${item.command} → ${item.result}`)
    : ["none"];

  return ui.ScrollBox(
    scrollBoxProps(scrollId),
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


function renderInlineMoveDetail(ui: OpenTui, state: TuiState, task: Task) {
  const target = state.moveTargetColumn ?? task.column;
  if (target === "done" && state.pendingConfirmation?.action === "move-to-done" && state.pendingConfirmation.taskId === task.id) {
    const copy = buildConfirmationCopy("move-to-done", task);
    return ui.Box(
      {
        flexGrow: 1,
        flexDirection: "column",
        gap: 1,
        ...boxBg(COLORS.panel),
      },
      ui.Text({ content: "Move this card to Done?", fg: COLORS.text, attributes: ui.TextAttributes.BOLD, height: 1, truncate: true }),
      ui.Text({ content: task.title, fg: COLORS.bright, height: 2, wrapMode: "word" }),
      ui.Text({ content: `Current lane: ${TUI_COLUMN_LABELS[task.column]}`, fg: COLORS.muted, height: 1 }),
      ui.Text({ content: HAIRLINE, fg: COLORS.hairline, height: 1, truncate: true }),
      ...copy.body.map((line) => ui.Text({ content: line, fg: COLORS.text, wrapMode: "word", height: 2 })),
      ui.Box({ flexGrow: 1 }),
      ui.Text({ content: "Press enter again to move to Done.", fg: COLORS.accentBright, height: 1, truncate: true }),
      ui.Text({ content: "accepted by User · esc cancel", fg: COLORS.dim, height: 1, truncate: true }),
    );
  }

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
        content: `${active ? "▸ " : "  "}${index + 1}. ${TUI_COLUMN_LABELS[col]}${col === task.column ? " (current)" : ""}${col === "done" ? " ← accepted by User" : ""}`,
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
    ui.Box({ height: state.terminalRows >= 36 ? 2 : 1 }),
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
    rows.push(renderSwitcherRow(ui, state, item, selected, isCurrent));
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
      ui.Text({ content: "↑/↓ navigate · enter select · s start/stop · esc cancel", fg: COLORS.dim, height: 1 }),
    ),
  );
}

function renderSwitcherRow(ui: OpenTui, state: TuiState, item: InstanceListItem, selected: boolean, isCurrent: boolean) {
  const glyph = INSTANCE_STATUS_GLYPHS[item.runtime.status] ?? "?";
  const action = state.instanceActionState[item.definition.name];
  const status = action === "starting"
    ? "STARTING"
    : action === "stopping"
    ? "STOPPING"
    : instanceStatusLabel(item.runtime.status);
  const control = item.runtime.status === "running" ? "s stop" : "s start";

  const currentMarker = isCurrent ? " ← current" : "";
  const line = `${selected ? "▸ " : "  "}${glyph} ${item.definition.name}  ${status}  :${item.definition.port}  ${control}${currentMarker}`;

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
  const grouped = tasksByColumn(filterTasks(state.tasks, state.boardFilter));

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
  if (state.filterMode && state.filterMode.column === column) {
    return renderColumnFilterPicker(ui, state, column, state.filterMode);
  }

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

// Filter mode replaces one lane's card list with a two-step picker (category, then
// live values) so filtering never leaves the normal 4-column board layout.
function renderColumnFilterPicker(ui: OpenTui, state: TuiState, column: Column, mode: NonNullable<TuiState["filterMode"]>) {
  const items = mode.step === "category"
    ? boardFilterCategories().map((category) => category.label)
    : boardFilterOptions(state.tasks, mode.category as BoardFilterKind);

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
      borderColor: COLORS.borderHot,
      ...boxBg(COLORS.panel),
      padding: TUI_LAYOUT.lanePadding,
      gap: TUI_LAYOUT.laneGap,
      title: `${TUI_COLUMN_LABELS[column]} · filter`,
      titleColor: COLORS.text,
    },
    ui.Text({
      content: mode.step === "category" ? "Filter by:" : `Filter · ${boardFilterCategories().find((c) => c.kind === mode.category)?.label}:`,
      fg: COLORS.muted,
      height: 1,
      truncate: true,
    }),
    items.length === 0
      ? ui.Text({ content: "No values available", fg: COLORS.muted, height: 1 })
      : ui.Box(
          { flexGrow: 1, flexDirection: "column", gap: 0, overflow: "hidden" },
          ...items.map((label, index) =>
            ui.Text({
              content: `${index === mode.selectedIndex ? "▸ " : "  "}${label}`,
              fg: index === mode.selectedIndex ? COLORS.bright : COLORS.text,
              height: 1,
              truncate: true,
            }),
          ),
        ),
    ui.Text({
      content: mode.step === "category" ? "↑/↓ select · enter next · esc cancel" : "↑/↓ select · enter apply · esc back",
      fg: COLORS.dim,
      height: 1,
      truncate: true,
    }),
  );
}

interface MetaRow {
  label: string;
  value: string;
  color: TuiColor;
}

// Status row text: glyph + label, plus the live elapsed time while running
// (`● RUNNING · 4m 12s`). The 2.5s poll re-render keeps the clock ticking.
function taskStatusText(task: Task): string {
  return compactTaskBoardLabel(task);
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
  const agent: MetaRow = {
    label: task.harness === "claude-code" ? "CLAUDE" : "AGENT",
    value: task.agent ?? "agent",
    color: COLORS.muted,
  };
  const model: MetaRow = {
    label: "MODEL",
    value: task.harness === "claude-code" ? task.model?.id ?? "default" : modelLabel(task.model ?? undefined),
    color: COLORS.muted,
  };
  const type: MetaRow = { label: "TYPE", value: task.type ?? "agent", color: COLORS.muted };
  const assigned: MetaRow = { label: "ASSIGN", value: task.assignedTo ?? "unassigned", color: COLORS.muted };

  if (task.runState === "error") {
    return [dir, { label: "ERR", value: task.error ?? "run failed", color: COLORS.text }];
  }
  if (task.type === "manual") {
    return [type, assigned];
  }
  if (task.harness === "claude-code") {
    return [{ label: "PERMS", value: task.claudePermissionMode ?? DEFAULT_CLAUDE_CODE_PERMISSION_MODE, color: COLORS.muted }, model];
  }
  if (task.column === "done" && task.completionSource === "reported") {
    const second = task.worktreeBranch
      ? { label: "BRANCH", value: `⑃ ${task.worktreeBranch}`, color: COLORS.muted }
      : dir;
    return [agent, second];
  }
  if ((task.column === "review" || task.column === "done") && task.worktreeBranch) {
    return [{ label: "BRANCH", value: `⑃ ${task.worktreeBranch}`, color: COLORS.muted }, dir];
  }
  return [dir, agent];
}

function renderTaskMeta(ui: OpenTui, meta: MetaRow, done: boolean, labelWidth = 7, valueColor?: TuiColor) {
  return ui.Box(
    { width: "100%", height: 1, flexDirection: "row" },
    ui.Text({ content: meta.label, fg: COLORS.dim, width: labelWidth, height: 1 }),
    // minWidth:0 lets the value shrink inside the row instead of overflowing the
    // card's right border when the path/branch is longer than the lane is wide.
    ui.Text({
      content: meta.value,
      fg: valueColor ?? (done ? COLORS.dim : meta.color),
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
      width: selectedPanelWidth(state.terminalCols),
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
    state.newTask ? renderInlineNewTask(ui, state) : task ? renderTaskDetails(ui, state, task) : renderEmptyDetails(ui),
  );
}

function selectedPanelWidth(terminalCols: number): number {
  const extra = Math.max(0, terminalCols - SIDEBAR_GROWTH_START_WIDTH);
  return Math.min(SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH + Math.floor(extra / 2));
}

function renderTaskDetails(ui: OpenTui, state: TuiState, task: Task) {
  const instance = currentInstanceItem(state);
  const lifecycleRows: MetaRow[] = taskLifecycleDetailRows(task).map((row) => ({
    label: row.label,
    value: row.value,
    color: lifecycleRowColor(row.role, task),
  }));
  const stateRow = lifecycleRows.find((row) => row.label === "STATE");
  const secondaryLifecycleRows = lifecycleRows.filter((row) => row.label !== "STATE");
  const rows: MetaRow[] = [
    ...(stateRow ? [stateRow] : []),
    { label: "INSTANCE", value: instance ? `${instance.definition.name}:${instance.definition.port}` : boardHost(state.boardUrl), color: COLORS.text },
    { label: "TYPE", value: task.type ?? "agent", color: COLORS.text },
    ...secondaryLifecycleRows,
    { label: "LANE", value: TUI_COLUMN_LABELS[task.column], color: COLORS.muted },
    ...(task.type === "manual"
      ? [{ label: "ASSIGNED TO", value: task.assignedTo ?? "unassigned", color: COLORS.text }]
      : [
          { label: task.harness === "claude-code" ? "HARNESS" : "AGENT", value: agentLabel(task, state.agents), color: COLORS.text },
          ...(task.harness === "claude-code"
            ? [
                { label: "PERMS", value: task.claudePermissionMode ?? DEFAULT_CLAUDE_CODE_PERMISSION_MODE, color: COLORS.text },
                ...(task.harnessWarning ? [{ label: "WARN", value: task.harnessWarning, color: COLORS.bright }] : []),
                ...(task.harnessCwd && task.harnessCwd !== task.directory
                  ? [{ label: "RUN DIR", value: shortPath(task.harnessCwd), color: COLORS.bright }]
                  : []),
                ...(task.harnessBranch ? [{ label: "RUN BRANCH", value: `⑃ ${task.harnessBranch}`, color: COLORS.muted }] : []),
                ...(task.harnessCommit ? [{ label: "RUN COMMIT", value: task.harnessCommit, color: COLORS.muted }] : []),
                ...(task.completionLocation ? [{ label: "RESULT", value: resultLocationLabel(task.completionLocation), color: COLORS.text }] : []),
              ]
            : []),
          { label: "MODEL", value: modelLabel(task.model ?? undefined), color: COLORS.text },
          { label: "DIR", value: shortPath(task.directory), color: COLORS.muted },
          { label: "ISO", value: task.isolation ?? "board default", color: COLORS.text },
          ...(task.isolation === "worktree"
            ? [{ label: "WORKTREE", value: worktreeId(task), color: COLORS.muted }]
            : []),
        ]),
  ];
  if (task.sessionId) rows.push({ label: "SESSION", value: task.sessionId, color: COLORS.muted });
  if (task.worktreeBranch) rows.push({ label: "BRANCH", value: `⑃ ${task.worktreeBranch}`, color: COLORS.muted });
  if (task.baseBranch) rows.push({ label: "BASE", value: `⑃ ${task.baseBranch}`, color: COLORS.muted });
  rows.push({ label: "TASK ID", value: task.id, color: COLORS.text });

  if (state.moveTargetColumn) {
    return renderInlineMoveDetail(ui, state, task);
  }

  if (state.pendingConfirmation?.taskId === task.id) {
    return renderPendingConfirmationDetail(ui, state, task, state.pendingConfirmation.action);
  }

  if (state.detailTab) {
    return renderInlineTaskDetail(ui, state, task, rows);
  }

  // The sidebar shares the lane chrome (border + padding), so lane inner height
  // is its inner height too. When the two-line detail style can't fit, fall back
  // to single-line card-meta rows instead of letting labels and values collide.
  // Error cards represent the failure as normal metadata here; the red error
  // notice is reserved for the inline Prompt/Handoff detail view.
  const mode = sidebarDetailMode(laneInnerHeight(state.terminalRows), rows.length, false);
  return mode === "expanded"
    ? renderExpandedDetails(ui, task, rows)
    : renderCompactDetails(ui, task, rows);
}

function worktreeId(task: Pick<Task, "id" | "worktreePath" | "worktreeBranch">): string {
  if (task.worktreePath) return task.worktreePath.split("/").filter(Boolean).at(-1) ?? task.id;
  if (task.worktreeBranch) return task.worktreeBranch.split("/").filter(Boolean).at(-1) ?? task.id;
  return task.id;
}

function resultLocationLabel(location: NonNullable<Task["completionLocation"]>): string {
  switch (location) {
    case "task-directory":
      return "task dir";
    case "harness-directory":
      return "harness dir";
    case "mixed":
      return "mixed";
    case "missing":
      return "not found";
    case "none":
      return "no file changes";
  }
}

function lifecycleRowColor(role: string | undefined, task: Task): TuiColor {
  if (role === "state") return taskStatusColor(task);
  if (role === "error") return COLORS.bright;
  if (role === "acceptedBy") return COLORS.accentBright;
  if (role === "pending") return COLORS.bright;
  return COLORS.text;
}

const DETAIL_TABS: readonly TaskDetailTab[] = ["prompt", "handoff", "output", "comments"];
const DETAIL_TAB_LABELS: Record<TaskDetailTab, string> = {
  prompt: "Prompt",
  handoff: "Handoff",
  output: "Output",
  comments: "Comments",
};

function nextDetailTab(tab: TaskDetailTab, delta: number): TaskDetailTab {
  const index = DETAIL_TABS.indexOf(tab);
  return DETAIL_TABS[(index + delta + DETAIL_TABS.length) % DETAIL_TABS.length];
}

function renderInlineTaskDetail(ui: OpenTui, state: TuiState, task: Task, rows: MetaRow[]) {
  const tab = state.detailTab ?? "prompt";
  const content: VChild =
    tab === "prompt"
      ? renderScrollableDetailText(ui, `board-detail-prompt-${task.id}`, task.description || "(empty prompt)")
      : tab === "handoff"
        ? renderHandoffTab(ui, task.completion ?? null, `board-detail-handoff-${task.id}`)
        : tab === "output"
          ? renderOutputTab(ui, task)
          : renderCommentsTab(ui, state, task);
  const inlineRows = rows.filter((row) => ["STATE", "TASK ID", "TYPE", "LANE", "AGENT", "ASSIGNED TO", "ACCEPTED BY"].includes(row.label));
  const footer = tab === "comments"
    ? (state.commentDraft ? "enter submit · esc cancel" : "esc details · ←/→ tabs · c comment · r reply")
    : "esc details · ←/→ tabs · m move card";

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
      ...inlineRows.map((row) => renderTaskMeta(ui, row, false, SIDEBAR_META_LABEL_WIDTH, COLORS.bright)),
    ),
    ...(task.error ? [renderErrorBox(ui, task.error, inlineErrorMode(state.terminalRows))] : []),
    ui.Box(
      { width: "100%", flexDirection: "row", height: 1, gap: 2 },
      ...DETAIL_TABS.map((candidate) =>
        ui.Text({
          content: DETAIL_TAB_LABELS[candidate],
          fg: tab === candidate ? COLORS.accentBright : COLORS.dim,
          attributes: tab === candidate ? ui.TextAttributes.BOLD : undefined,
          height: 1,
        }),
      ),
    ),
    ui.Text({ content: HAIRLINE, fg: COLORS.hairline, height: 1, truncate: true }),
    ui.Box(
      { flexGrow: 1, flexDirection: "column", gap: 0, ...boxBg(COLORS.panel) },
      content,
    ),
    ui.Text({ content: footer, fg: COLORS.muted, height: 1, truncate: true }),
  );
}

function renderOutputTab(ui: OpenTui, task: Task) {
  const output = task.finalSessionOutput?.trim();
  return renderScrollableDetailText(
    ui,
    `board-detail-output-${task.id}`,
    output && output.length > 0 ? output : "No final session output available",
  );
}

function renderCommentsTab(ui: OpenTui, state: TuiState, task: Task) {
  const panel = state.comments?.taskId === task.id ? state.comments : undefined;
  const items = panel ? flattenComments(panel.items) : [];
  const canCompose = task.column === "review" || task.column === "done";
  const draft = state.commentDraft?.taskId === task.id ? state.commentDraft : undefined;

  const rows: VChild[] = [];
  if (panel?.loading) {
    rows.push(ui.Text({ content: "Loading comments...", fg: COLORS.muted, height: 1 }));
  } else if (panel?.error) {
    rows.push(ui.Text({ content: `Failed to load comments: ${panel.error}`, fg: COLORS.bright, wrapMode: "word" }));
  } else if (items.length === 0) {
    rows.push(ui.Text({ content: "No comments yet", fg: COLORS.muted, height: 1 }));
  } else {
    items.forEach((comment, index) => {
      const selected = panel?.selectedIndex === index;
      const isReply = Boolean(comment.parentCommentId);
      rows.push(
        ui.Box(
          { width: "100%", flexDirection: "column", gap: 0, paddingLeft: isReply ? 2 : 0, ...boxBg(selected ? COLORS.panelRaised : COLORS.panel) },
          ui.Text({
            content: `${selected ? "▸ " : "  "}${isReply ? "↳ " : ""}${comment.author} · ${formatArchiveDate(comment.createdAt)}`,
            fg: selected ? COLORS.bright : COLORS.muted,
            height: 1,
            truncate: true,
          }),
          ui.Text({ content: comment.body, fg: COLORS.text, wrapMode: "word", width: "100%", minWidth: 0, flexShrink: 1 }),
        ),
      );
    });
  }

  return ui.Box(
    { flexGrow: 1, flexDirection: "column", gap: 1, ...boxBg(COLORS.panel) },
    ui.ScrollBox(scrollBoxProps(`board-detail-comments-${task.id}`), ...rows),
    draft
      ? ui.Box(
          { width: "100%", flexDirection: "column", gap: 0 },
          ui.Text({ content: draft.parentCommentId ? "Reply" : "New comment", fg: COLORS.dim, height: 1 }),
          ui.Box(
            { width: "100%", height: 3, border: true, borderStyle: "single", borderColor: COLORS.borderHot, ...boxBg(COLORS.bg), paddingX: 1 },
            ui.Text({ content: `${draft.text}▍`, fg: COLORS.text, height: 1, wrapMode: "none", truncate: true }),
          ),
        )
      : ui.Text({
          content: canCompose ? "c new comment · r reply to selected · ↑/↓ select" : "Comments are only available on Review or Done cards",
          fg: COLORS.muted,
          height: 1,
          truncate: true,
          wrapMode: "word",
        }),
  );
}

/** Flatten a comment thread into display order: each root comment followed by its replies (oldest first). */
function flattenComments(items: TaskComment[]): TaskComment[] {
  const roots = items.filter((comment) => !comment.parentCommentId).sort((a, b) => a.createdAt - b.createdAt);
  const result: TaskComment[] = [];
  for (const root of roots) {
    result.push(root);
    result.push(...items.filter((comment) => comment.parentCommentId === root.id).sort((a, b) => a.createdAt - b.createdAt));
  }
  const seen = new Set(result.map((comment) => comment.id));
  for (const comment of items) {
    if (!seen.has(comment.id)) result.push(comment);
  }
  return result;
}

function renderPendingConfirmationDetail(ui: OpenTui, _state: TuiState, task: Task, action: ConfirmableAction) {
  const copy = buildConfirmationCopy(action, task);
  const confidence = action === "run" || action === "retry" ? buildRunConfidenceDetails(task) : [];

  return ui.Box(
    {
      flexGrow: 1,
      flexDirection: "column",
      gap: 1,
      ...boxBg(COLORS.panel),
    },
    ui.Text({ content: copy.title, fg: COLORS.text, attributes: ui.TextAttributes.BOLD, height: 1, truncate: true }),
    ui.Text({ content: task.title, fg: COLORS.bright, height: 2, wrapMode: "word" }),
    ui.Text({ content: HAIRLINE, fg: COLORS.hairline, height: 1, truncate: true }),
    ...copy.body.map((line) => ui.Text({ content: line, fg: COLORS.text, wrapMode: "word", height: 2 })),
    ...(confidence.length
      ? [
          ui.Text({ content: "Pre-run confidence", fg: COLORS.dim, height: 1, truncate: true }),
          ui.Box(
            { width: "100%", flexDirection: "column", gap: 0, ...boxBg(COLORS.panel) },
            ...confidence.map((detail) => ui.Text({
              content: formatConfidenceDetail(detail),
              fg: detail.ok ? COLORS.muted : COLORS.bright,
              height: 1,
              truncate: true,
            })),
          ),
        ]
      : []),
    ui.Box({ flexGrow: 1 }),
    ui.Text({ content: copy.confirmHint, fg: COLORS.accentBright, height: 1, truncate: true }),
    ui.Text({ content: "esc cancel · changing selection clears", fg: COLORS.dim, height: 1, truncate: true }),
  );
}

function renderExpandedDetails(ui: OpenTui, task: Task, rows: MetaRow[]) {
  const details: VChild[] = rows.map((row) => renderDetail(ui, row.label, row.value, COLORS.bright));

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
    ...details,
    ui.Box({ flexGrow: 1 }),
    ...renderDetailHints(ui),
  );
}

function renderCompactDetails(ui: OpenTui, task: Task, rows: MetaRow[]) {
  const compactRows = [...rows];
  if (task.error && !compactRows.some((row) => row.label === "ERROR")) {
    compactRows.push({ label: "ERR", value: task.error, color: COLORS.text });
  }

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
      ...compactRows.map((row) => renderTaskMeta(ui, row, false, SIDEBAR_META_LABEL_WIDTH, COLORS.bright)),
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

function inlineErrorMode(terminalRows: number): "compact" | "full" {
  return terminalRows <= 34 ? "compact" : "full";
}

function renderErrorBox(ui: OpenTui, error: string, mode: "compact" | "full" = "full") {
  const errorRows = Math.min(3, Math.max(1, Math.ceil(error.length / 56)));
  if (mode === "compact") {
    return ui.Box(
      {
        id: "selected-error-box",
        width: "100%",
        height: 3,
        border: true,
        borderStyle: "single",
        borderColor: COLORS.laneError,
        paddingX: 1,
        flexDirection: "row",
        alignItems: "center",
        ...boxBg(COLORS.panel),
      },
      ui.Text({ content: `! ERROR · ${error}`, fg: COLORS.bright, height: 1, truncate: true }),
    );
  }

  return ui.Box(
    {
      id: "selected-error-box",
      width: "100%",
      height: errorRows + 4,
      border: true,
      borderStyle: "single",
      borderColor: COLORS.laneError,
      padding: 1,
      flexDirection: "column",
    },
    ui.Text({ content: "! ERROR", fg: COLORS.bright, height: 1 }),
    ui.Text({ content: error, fg: COLORS.text, wrapMode: "word", height: errorRows }),
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
            : "↑/↓ cards · ←/→ lanes · esc instances · b switch board · n new task · e edit · f filter · m move card · u refresh · ? help · q quit · A global archive",
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
    ["enter", "open Prompt/Handoff/Output/Comments"],
    ["←/→/tab", "switch detail tabs"],
    ["c / r", "comment / reply (Comments tab)"],
    ["e", "edit selected To Do card"],
    ["f", "filter selected lane (again to clear)"],
    ["r", "run selected task"],
    ["R", "retry failed run"],
    ["a", "archive task"],
    ["A", "global archive browser"],
    ["d", "delete selected card"],
    ["s", "sync worktree"],
    ["i", "integrate branch"],
    ["x", "move to Done (accepted by User)"],
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
        width: 52,
        height: 38,
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

function renderInlineNewTask(ui: OpenTui, state: TuiState) {
  const draft = state.newTask ?? createNewTaskDraft(state);
  const isEditing = Boolean(draft.editingTaskId);

  return ui.Box(
    {
      width: "100%",
      height: "100%",
      flexDirection: "column",
      gap: 1,
      ...boxBg(COLORS.panel),
    },
    ui.Text({
      content: isEditing ? "Edit Task" : "New Task",
      fg: COLORS.text,
      attributes: ui.TextAttributes.BOLD,
      height: 1,
      truncate: true,
    }),
    ui.Text({ content: HAIRLINE, fg: COLORS.hairline, height: 1, truncate: true }),
    ui.Box(
      {
        flexGrow: 1,
        flexDirection: "column",
        gap: 1,
        ...boxBg(COLORS.panel),
      },
      renderSelectField(ui, "CARD TYPE", draft.type, draft.field === "type"),
      renderInputField(ui, "TITLE", draft.title, draft.field === "title", "", 1, COLORS.text, draft, "title"),
      renderInputField(
        ui,
        draft.type === "manual" ? "NOTES" : "PROMPT",
        draft.description,
        draft.field === "description",
        draft.type === "manual" ? "Notes for the PM/manual card..." : "Describe the task for the agent...",
        4,
        COLORS.text,
        draft,
        "description",
      ),
      ...(draft.type === "manual"
        ? [
            renderInputField(ui, "ASSIGNED TO", draft.assignedTo, draft.field === "assignedTo", "Name or role", 1, COLORS.text, draft, "assignedTo"),
          ]
        : [
            renderSelectField(ui, "HARNESS", currentHarnessLabel(draft), draft.field === "harness"),
            draft.harness === "claude-code"
              ? renderSelectField(ui, "PERMS", currentPermissionModeLabel(draft), draft.field === "permissionMode")
              : renderSelectField(ui, "AGENT", currentAgentLabel(draft), draft.field === "agent"),
            renderSelectField(ui, "MODEL", currentModelLabel(draft), draft.field === "model"),
            renderInputField(
              ui,
              "DIR",
              draft.field === "directory" ? draft.directory : shortPath(draft.directory),
              draft.field === "directory",
              state.cwd,
              1,
              COLORS.muted,
              draft,
              "directory",
            ),
            renderIsolationField(ui, draft),
          ]),
      draft.error
        ? ui.Text({ content: draft.error, fg: COLORS.bright, wrapMode: "word", height: 2 })
        : ui.Box({ height: 2 }),
    ),
    ui.Text({ content: HAIRLINE, fg: COLORS.hairline, height: 1, truncate: true }),
    ui.Box(
      { width: "100%", flexDirection: "row", height: 1, gap: 1 },
      ui.Text({
        content: draft.submitting
          ? (isEditing ? "Saving..." : "Creating...")
          : isEditing
            ? "Save changes"
            : draft.type === "manual" ? "Create manual task" : "Create agent task",
        fg: COLORS.bright,
        ...textBg(COLORS.accent),
        height: 1,
        width: 20,
        truncate: true,
      }),
      ui.Text({ content: "esc cancel", fg: COLORS.muted, height: 1, flexGrow: 1, truncate: true }),
    ),
    ui.Text({
      content: isEditing
        ? "tab next field · shift+tab previous · enter save"
        : "tab next field · shift+tab previous · enter create",
      fg: COLORS.dim,
      height: 1,
      truncate: true,
    }),
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
  draft?: NewTaskDraft,
  field?: TextInputField,
) {
  // Focused fields carry the block cursor in accent-bright (per the design
  // kit) as a styled chunk, so it keeps its color inside wrapped text.
  const viewport = focused && draft && field ? draftTextViewport(draft, field, contentHeight) : { text: value, cursorOffset: value.length };
  const content = focused
    ? ui.t`${ui.fg(valueColor)(viewport.text.slice(0, viewport.cursorOffset))}${ui.fg(COLORS.accentBright)("▍")}${ui.fg(valueColor)(viewport.text.slice(viewport.cursorOffset))}`
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

function draftTextViewport(draft: NewTaskDraft, field: TextInputField, contentHeight: number): { text: string; cursorOffset: number } {
  const value = readDraftText(draft, field);
  const visibleChars = Math.max(1, TEXT_INPUT_COLUMNS * contentHeight);
  const cursor = getDraftCursor(draft, field);
  const rawScroll = draft.textScrolls?.[field] ?? 0;
  const maxScroll = Math.max(0, value.length - visibleChars);
  let scroll = Math.max(0, Math.min(rawScroll, maxScroll));

  if (cursor < scroll) scroll = cursor;
  if (cursor > scroll + visibleChars) scroll = Math.max(0, cursor - visibleChars);
  if (scroll !== rawScroll) setDraftScroll(draft, field, scroll);

  const text = value.slice(scroll, scroll + visibleChars);
  return {
    text,
    cursorOffset: Math.max(0, Math.min(cursor - scroll, text.length)),
  };
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

  if ((state.overlay === "newTask" || state.newTask) && state.viewState.view === "board") {
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

  if (state.filterMode) {
    await handleFilterModeKey(key, state, actions);
    return;
  }

  if (state.detailTab === "comments") {
    await handleCommentsTabKey(key, state, actions);
    return;
  }

  if (state.detailTab) {
    if (isEscapeKey(key)) {
      closeInlineDetail(state);
      actions.render();
      return;
    }
    if ((key.name || key.sequence) === "left") {
      state.detailTab = nextDetailTab(state.detailTab, -1);
      if (state.detailTab === "comments") await loadCommentsForTask(state, actions, selectedTask(state));
      actions.render();
      return;
    }
    if ((key.name || key.sequence) === "right" || key.sequence === "\t") {
      state.detailTab = nextDetailTab(state.detailTab, 1);
      if (state.detailTab === "comments") await loadCommentsForTask(state, actions, selectedTask(state));
      actions.render();
      return;
    }
  }

  // Board view keybindings
  switch (key.sequence) {
    case "q":
      clearPendingConfirmation(state);
      actions.shutdown();
      return;
    case "?":
      clearPendingConfirmation(state);
      state.overlay = "help";
      actions.render();
      return;
    case "n":
      clearPendingConfirmation(state);
      state.newTask = createNewTaskDraft(state);
      state.overlay = "none";
      closeInlineDetail(state);
      state.moveTargetColumn = undefined;
      state.error = undefined;
      actions.render();
      return;
    case "e":
    case "E":
      handleEditRequested(state, actions);
      return;
    case "f":
    case "F":
      handleFilterKeyEntry(state, actions);
      return;
    case "u":
      clearPendingConfirmation(state);
      await actions.refresh();
      return;
    case "r":
      await handleConfirmableCardAction("run", state, actions, (task) => actions.client.runTask(task.id), "run");
      return;
    case "R":
      await handleConfirmableCardAction("retry", state, actions, (task) => actions.client.retryTask(task.id), "retry");
      return;
    case "a":
      await handleConfirmableCardAction("archive", state, actions, (task) => actions.archiveTask(task.id), "archive");
      return;
    case "A":
      clearPendingConfirmation(state);
      await actions.openArchive();
      return;
    case "d":
      await handleConfirmableCardAction("delete", state, actions, (task) => actions.client.deleteTask(task.id), "delete");
      return;
    case "s":
      clearPendingConfirmation(state);
      await actions.runAction("sync", (task) => actions.client.syncTask(task.id));
      return;
    case "i":
      clearPendingConfirmation(state);
      await actions.runAction("integrate", (task) => actions.client.integrateTask(task.id));
      return;
    case "g":
      clearPendingConfirmation(state);
      await actions.runAction("init git and run", (task) => actions.client.initGitAndRun(task.id));
      return;
    case "x":
      await confirmMoveToDone(state, actions);
      return;
    case "m":
      clearPendingConfirmation(state);
      if (!state.selectedTaskId) {
        state.status = "no task selected to move";
        actions.render();
        return;
      }
      closeInlineDetail(state);
      state.moveTargetColumn = selectedTask(state)?.column;
      actions.render();
      return;
    case "b":
      clearPendingConfirmation(state);
      state.viewState = openSwitcher(state.viewState);
      state.switcherSelectedIndex = state.instanceList.findIndex((item) => item.runtime.boardUrl === state.boardUrl);
      if (state.switcherSelectedIndex === -1) state.switcherSelectedIndex = 0;
      actions.render();
      return;
  }

  if (isEscapeKey(key)) {
    if (state.pendingConfirmation) {
      clearPendingConfirmation(state);
      state.error = undefined;
      state.status = "cancelled";
      actions.render();
      return;
    }
    clearPendingConfirmation(state);
    await actions.detachInstance();
    return;
  }

  if (isEnterKey(key) && state.selectedTaskId) {
    clearPendingConfirmation(state);
    if (state.detailTab) closeInlineDetail(state);
    else state.detailTab = "prompt";
    actions.render();
    return;
  }

  if (keyName === "down" || keyName === "up" || keyName === "left" || keyName === "right") {
    // Navigate within the filtered set — otherwise selection could land on a card
    // hidden by an active board filter, and every action would silently target it.
    const visibleTasks = filterTasks(state.tasks, state.boardFilter);
    if (keyName === "down") state.selectedTaskId = nextTaskId(visibleTasks, state.selectedTaskId, 1);
    else if (keyName === "up") state.selectedTaskId = nextTaskId(visibleTasks, state.selectedTaskId, -1);
    else if (keyName === "left") state.selectedTaskId = nearestTaskInColumn(visibleTasks, state.selectedTaskId, -1);
    else state.selectedTaskId = nearestTaskInColumn(visibleTasks, state.selectedTaskId, 1);
    state.pendingConfirmation = clearPendingForSelection(state, state.selectedTaskId);
    actions.render();
  }
}

export function handlePaste(event: PasteEvent, state: TuiState, actions: Pick<TuiActions, "render">): void {
  const text = decodePastedText(event.bytes);
  if (!text) return;

  if ((state.overlay === "newTask" || state.newTask) && state.viewState.view === "board") {
    const draft = state.newTask ?? createNewTaskDraft(state);
    state.newTask = draft;
    if (!isTextInputField(draft.field)) return;

    replaceDraftSelection(draft, draft.field, normalizePastedText(text, draft.field));
    draft.error = undefined;
    event.preventDefault();
    actions.render();
    return;
  }

  if (state.viewState.view === "workspaceGate" && !state.workspaceGateSubmitting) {
    state.workspaceGateInput += normalizeSingleLinePaste(text);
    state.workspaceGateError = undefined;
    event.preventDefault();
    actions.render();
    return;
  }

  if (state.overlay === "addInstance" && state.addInstance && !state.addInstance.submitting) {
    const paste = normalizeSingleLinePaste(text);
    if (state.addInstance.field === "name") state.addInstance.name += paste;
    else state.addInstance.workspace += paste;
    state.addInstance.error = undefined;
    event.preventDefault();
    actions.render();
    return;
  }

  if (state.overlay === "renameInstance" && state.renameInstance && !state.renameInstance.submitting && state.renameInstance.field === "newName") {
    state.renameInstance.newName += normalizeSingleLinePaste(text);
    state.renameInstance.error = undefined;
    event.preventDefault();
    actions.render();
  }
}

async function handleConfirmableCardAction(
  action: ConfirmableAction,
  state: TuiState,
  actions: TuiActions,
  execute: (task: Task) => Promise<unknown>,
  label: string,
): Promise<void> {
  const task = selectedTask(state);
  if (!task) {
    state.status = "no task selected";
    state.error = undefined;
    clearPendingConfirmation(state);
    actions.render();
    return;
  }

  if ((action === "run" || action === "retry") && task.type === "manual") {
    state.status = "manual cards are not runnable; convert to an agent card first";
    state.error = undefined;
    clearPendingConfirmation(state);
    actions.render();
    return;
  }

  const result = requestConfirmation(state, action, task.id);
  state.pendingConfirmation = result.state.pendingConfirmation;
  closeInlineDetail(state);
  state.moveTargetColumn = undefined;
  state.error = undefined;

  if (!result.execute) {
    state.status = confirmationStatus(action, task);
    actions.render();
    return;
  }

  clearPendingConfirmation(state);
  await actions.runAction(label, execute);
}

async function confirmMoveToDone(state: TuiState, actions: TuiActions): Promise<void> {
  await handleConfirmableCardAction(
    "move-to-done",
    state,
    actions,
    (task) => moveTaskToDone(state, actions, task),
    "move done",
  );
}

function moveTaskToDone(state: TuiState, actions: TuiActions, task: Task): Promise<unknown> {
  const endOfDone = state.tasks.filter((item) => item.column === "done" && item.id !== task.id).length;
  return actions.client.moveTask(task.id, "done", endOfDone, "User");
}

function clearPendingConfirmation(state: TuiState): void {
  state.pendingConfirmation = clearConfirmation(state).pendingConfirmation;
}

function clearPendingForSelection(state: Pick<TuiState, "pendingConfirmation">, selectedTaskId: string | undefined): PendingConfirmation | undefined {
  if (!state.pendingConfirmation || state.pendingConfirmation.taskId === selectedTaskId) return state.pendingConfirmation;
  return undefined;
}

/** Close the selected-card detail view and drop any comments state tied to it. */
function closeInlineDetail(state: TuiState): void {
  state.detailTab = undefined;
  state.comments = undefined;
  state.commentDraft = undefined;
}

// ── Edit mode (E/e) ─────────────────────────────────────────────────────────────

function handleEditRequested(state: TuiState, actions: TuiActions): void {
  clearPendingConfirmation(state);
  const task = selectedTask(state);
  if (!task) {
    state.status = "no task selected";
    actions.render();
    return;
  }
  if (task.column !== "todo") {
    state.status = "only To Do cards can be edited";
    actions.render();
    return;
  }

  state.newTask = createEditTaskDraft(task, state);
  state.overlay = "none";
  closeInlineDetail(state);
  state.moveTargetColumn = undefined;
  state.error = undefined;
  actions.render();
}

function createEditTaskDraft(task: Task, state: TuiState): NewTaskDraft {
  return {
    type: task.type ?? "agent",
    title: task.title,
    description: task.description,
    directory: task.directory,
    harness: task.harness ?? "opencode",
    agentId: task.agent ?? defaultAgentId(state.agents),
    claudePermissionMode: task.claudePermissionMode ?? DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
    assignedTo: task.assignedTo ?? "",
    model: task.model ?? undefined,
    isolation: task.isolation ?? "worktree",
    field: "title",
    textCursors: {},
    textScrolls: {},
    submitting: false,
    editingTaskId: task.id,
  };
}

// ── Filter mode (F/f) ────────────────────────────────────────────────────────────

function handleFilterKeyEntry(state: TuiState, actions: TuiActions): void {
  clearPendingConfirmation(state);
  if (state.boardFilter) {
    state.boardFilter = undefined;
    state.status = "filter cleared";
    actions.render();
    return;
  }

  const column = selectedTask(state)?.column ?? TUI_COLUMNS[0];
  closeInlineDetail(state);
  state.moveTargetColumn = undefined;
  state.error = undefined;
  state.filterMode = { column, step: "category", selectedIndex: 0 };
  actions.render();
}

async function handleFilterModeKey(key: KeyEvent, state: TuiState, actions: TuiActions): Promise<void> {
  const mode = state.filterMode;
  if (!mode) return;
  const keyName = key.name || key.sequence;

  if (isEscapeKey(key)) {
    if (mode.step === "value") {
      state.filterMode = { column: mode.column, step: "category", selectedIndex: 0 };
    } else {
      state.filterMode = undefined;
    }
    actions.render();
    return;
  }

  if (mode.step === "category") {
    const categories = boardFilterCategories();
    if (keyName === "down") {
      mode.selectedIndex = (mode.selectedIndex + 1) % categories.length;
      actions.render();
      return;
    }
    if (keyName === "up") {
      mode.selectedIndex = (mode.selectedIndex - 1 + categories.length) % categories.length;
      actions.render();
      return;
    }
    if (isEnterKey(key)) {
      const category = categories[mode.selectedIndex]?.kind;
      if (!category) return;
      state.filterMode = { column: mode.column, step: "value", category, selectedIndex: 0 };
      actions.render();
      return;
    }
    return;
  }

  const category = mode.category as BoardFilterKind;
  const options = boardFilterOptions(state.tasks, category);
  if (keyName === "down") {
    if (options.length) mode.selectedIndex = (mode.selectedIndex + 1) % options.length;
    actions.render();
    return;
  }
  if (keyName === "up") {
    if (options.length) mode.selectedIndex = (mode.selectedIndex - 1 + options.length) % options.length;
    actions.render();
    return;
  }
  if (isEnterKey(key)) {
    const value = options[mode.selectedIndex];
    state.filterMode = undefined;
    if (value === undefined) {
      state.status = "no values available for that filter";
    } else {
      state.boardFilter = { kind: category, value };
      state.status = `filtering by ${category}: ${value}`;
      // The current selection may now be hidden by the filter — reselect the
      // nearest visible card so on-screen highlight and actions stay in sync.
      const visibleTasks = filterTasks(state.tasks, state.boardFilter);
      if (!visibleTasks.some((task) => task.id === state.selectedTaskId)) {
        state.selectedTaskId = visibleTasks[0]?.id;
        clearPendingConfirmation(state);
      }
    }
    actions.render();
  }
}

// ── Comments tab (Review/Done cards) ─────────────────────────────────────────────

async function loadCommentsForTask(state: TuiState, actions: TuiActions, task: Task | undefined): Promise<void> {
  if (!task) return;
  if (state.comments?.taskId === task.id && !state.comments.error) return;

  state.comments = { taskId: task.id, items: [], loading: true, selectedIndex: 0 };
  actions.render();
  try {
    const items = await actions.client.listComments(task.id);
    if (state.comments?.taskId === task.id) {
      state.comments = { taskId: task.id, items, loading: false, selectedIndex: 0 };
    }
  } catch (error) {
    if (state.comments?.taskId === task.id) {
      state.comments = { taskId: task.id, items: [], loading: false, error: errorMessage(error), selectedIndex: 0 };
    }
  }
  actions.render();
}

async function submitCommentDraft(state: TuiState, actions: TuiActions): Promise<void> {
  const draft = state.commentDraft;
  if (!draft) return;
  const body = draft.text.trim();
  if (!body) {
    state.status = "comment body is required";
    actions.render();
    return;
  }

  state.status = "adding comment...";
  actions.render();
  try {
    await actions.client.addComment(draft.taskId, USER_COMPLETED_BY, body, draft.parentCommentId);
    state.commentDraft = undefined;
    state.status = "comment added";
    const task = state.tasks.find((item) => item.id === draft.taskId);
    state.comments = undefined;
    await loadCommentsForTask(state, actions, task);
  } catch (error) {
    state.error = errorMessage(error);
    state.status = "add comment failed";
    actions.render();
  }
}

async function handleCommentsTabKey(key: KeyEvent, state: TuiState, actions: TuiActions): Promise<void> {
  const task = selectedTask(state);

  if (state.commentDraft) {
    if (isEscapeKey(key)) {
      state.commentDraft = undefined;
      actions.render();
      return;
    }
    if (isEnterKey(key)) {
      await submitCommentDraft(state, actions);
      return;
    }
    if (isLineDeleteKey(key)) {
      state.commentDraft.text = "";
      actions.render();
      return;
    }
    if (key.name === "backspace" || key.sequence === "\u007f" || key.sequence === "\b") {
      state.commentDraft.text = state.commentDraft.text.slice(0, -1);
      actions.render();
      return;
    }
    if (!key.ctrl && !key.meta && key.sequence.length === 1 && key.sequence >= " ") {
      state.commentDraft.text += key.sequence;
      actions.render();
    }
    return;
  }

  if (isEscapeKey(key)) {
    closeInlineDetail(state);
    actions.render();
    return;
  }

  // q always quits, even while just browsing (not composing) the Comments tab.
  if (key.sequence === "q") {
    actions.shutdown();
    return;
  }

  const keyName = key.name || key.sequence;
  if (keyName === "left") {
    state.detailTab = nextDetailTab("comments", -1);
    actions.render();
    return;
  }
  if (keyName === "right" || key.sequence === "\t") {
    state.detailTab = nextDetailTab("comments", 1);
    actions.render();
    return;
  }

  const items = task && state.comments?.taskId === task.id ? flattenComments(state.comments.items) : [];
  if (keyName === "down") {
    if (items.length && state.comments) state.comments.selectedIndex = Math.min(state.comments.selectedIndex + 1, items.length - 1);
    actions.render();
    return;
  }
  if (keyName === "up") {
    if (items.length && state.comments) state.comments.selectedIndex = Math.max(state.comments.selectedIndex - 1, 0);
    actions.render();
    return;
  }

  if (key.sequence === "c") {
    if (!task || (task.column !== "review" && task.column !== "done")) {
      state.status = "comments are only available on Review or Done cards";
      actions.render();
      return;
    }
    state.commentDraft = { taskId: task.id, parentCommentId: null, text: "" };
    actions.render();
    return;
  }

  if (key.sequence === "r") {
    if (!task || (task.column !== "review" && task.column !== "done")) {
      state.status = "comments are only available on Review or Done cards";
      actions.render();
      return;
    }
    const selected = items[state.comments?.selectedIndex ?? -1];
    if (!selected) {
      state.status = "no comment selected to reply to";
      actions.render();
      return;
    }
    // Threading is a single level deep (flattenComments only nests root → its
    // replies), so replying to a reply attaches to its root, not the reply itself
    // — otherwise the new comment would render detached at the end of the thread.
    const parentCommentId = selected.parentCommentId ?? selected.id;
    state.commentDraft = { taskId: task.id, parentCommentId, text: "" };
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

  if (handleDraftTextKey(draft, key)) {
    draft.error = undefined;
    actions.render();
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

  if (applyTextInput(draft, key)) actions.render();
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

  const isEditing = Boolean(draft.editingTaskId);
  draft.submitting = true;
  draft.error = undefined;
  state.status = isEditing ? `saving task: ${title}` : `creating task: ${title}`;
  actions.render();

  try {
    const task = isEditing
      ? await actions.client.updateTask(draft.editingTaskId as string, draft.type === "manual" ? {
          type: "manual",
          title,
          description: draft.description,
          directory,
          assignedTo: draft.assignedTo.trim() || null,
        } : {
          type: "agent",
          harness: draft.harness,
          title,
          description: draft.description,
          directory,
          agent: draft.harness === "claude-code" ? null : draft.agentId || null,
          claudePermissionMode: draft.harness === "claude-code" ? draft.claudePermissionMode : null,
          model: draft.model ?? null,
          isolation: draft.isolation,
        })
      : await actions.client.createTask(draft.type === "manual" ? {
          type: "manual",
          title,
          description: draft.description,
          directory,
          assignedTo: draft.assignedTo.trim() || undefined,
        } : {
          type: "agent",
          harness: draft.harness,
          title,
          description: draft.description,
          directory,
          agent: draft.harness === "claude-code" ? undefined : draft.agentId || undefined,
          claudePermissionMode: draft.harness === "claude-code" ? draft.claudePermissionMode : undefined,
          model: draft.model,
          isolation: draft.isolation,
        });
    state.overlay = "none";
    state.newTask = undefined;
    state.error = undefined;
    state.status = isEditing ? `saved task: ${task.title}` : `created task: ${task.title}`;
    await actions.refresh(true);
    state.selectedTaskId = task.id;
    actions.render();
  } catch (error) {
    draft.submitting = false;
    draft.error = errorMessage(error);
    state.status = isEditing ? "save task failed" : "create task failed";
    actions.render();
  }
}

function createNewTaskDraft(state: TuiState): NewTaskDraft {
  const agentId = defaultAgentId(state.agents);
  const agent = state.agents.find((item) => item.id === agentId);
  return {
    type: "agent",
    title: "",
    description: "",
    directory: state.cwd,
    harness: "opencode",
    agentId,
    claudePermissionMode: DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
    assignedTo: "",
    model: agent?.model,
    isolation: "worktree",
    field: "type",
    textCursors: {},
    textScrolls: {},
    submitting: false,
  };
}

function moveDraftField(draft: NewTaskDraft, delta: number): void {
  const order = newTaskFieldOrder(draft);
  const current = order.includes(draft.field) ? draft.field : "type";
  const index = order.indexOf(current);
  draft.field = order[(index + delta + order.length) % order.length];
}

function cycleFocusedField(draft: NewTaskDraft, state: TuiState, delta: number): boolean {
  switch (draft.field) {
    case "type":
      draft.type = draft.type === "agent" ? "manual" : "agent";
      if (!newTaskFieldOrder(draft).includes(draft.field)) draft.field = "type";
      return true;
    case "harness":
      draft.harness = draft.harness === "opencode" ? "claude-code" : "opencode";
      draft.model = defaultModelForHarness(draft, state.agents);
      if (!newTaskFieldOrder(draft).includes(draft.field)) draft.field = "type";
      return true;
    case "agent":
      cycleAgent(draft, state.agents, delta);
      return true;
    case "permissionMode":
      cyclePermissionMode(draft, delta);
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
  draft.model = defaultModelForHarness(draft, agents);
}

function cyclePermissionMode(draft: NewTaskDraft, delta: number): void {
  const current = Math.max(0, CLAUDE_CODE_PERMISSION_MODES.indexOf(draft.claudePermissionMode));
  draft.claudePermissionMode = CLAUDE_CODE_PERMISSION_MODES[(current + delta + CLAUDE_CODE_PERMISSION_MODES.length) % CLAUDE_CODE_PERMISSION_MODES.length];
}

function cycleModel(draft: NewTaskDraft, agents: RosterAgent[], delta: number): void {
  const options = modelOptions(draft, agents);
  const current = Math.max(
    0,
    options.findIndex((model) => sameModel(model, draft.model)),
  );
  draft.model = options[(current + delta + options.length) % options.length];
}

function handleDraftTextKey(draft: NewTaskDraft, key: KeyEvent): boolean {
  if (!isTextInputField(draft.field)) return false;
  const field = draft.field;

  if (isSelectAllKey(key)) {
    const value = readDraftText(draft, field);
    draft.textSelection = { field, start: 0, end: value.length };
    setDraftCursor(draft, field, value.length);
    return true;
  }

  if (isLineDeleteKey(key)) {
    deleteDraftLine(draft, field);
    return true;
  }

  if (key.name === "left") {
    moveDraftCursor(draft, field, -1);
    return true;
  }

  if (key.name === "right") {
    moveDraftCursor(draft, field, 1);
    return true;
  }

  if (key.name === "home") {
    setDraftCursor(draft, field, 0);
    clearDraftSelection(draft);
    return true;
  }

  if (key.name === "end") {
    setDraftCursor(draft, field, readDraftText(draft, field).length);
    clearDraftSelection(draft);
    return true;
  }

  if (field === "description" && key.name === "up") {
    scrollDraftText(draft, field, -TEXT_INPUT_COLUMNS);
    return true;
  }

  if (field === "description" && key.name === "down") {
    scrollDraftText(draft, field, TEXT_INPUT_COLUMNS);
    return true;
  }

  if (key.name === "backspace" || key.sequence === "\u007f" || key.sequence === "\b") {
    deleteDraftText(draft, field, "backward");
    return true;
  }

  if (key.name === "delete" || key.sequence === "\u001b[3~") {
    deleteDraftText(draft, field, "forward");
    return true;
  }

  return applyTextInput(draft, key);
}

function applyTextInput(draft: NewTaskDraft, key: KeyEvent): boolean {
  if (!isTextInputField(draft.field)) return false;

  if (key.ctrl || key.meta || key.sequence.length !== 1 || key.sequence < " ") return false;
  replaceDraftSelection(draft, draft.field, key.sequence);
  return true;
}

function decodePastedText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).replace(/\r\n?/g, "\n");
}

function normalizePastedText(text: string, field: TextInputField): string {
  return field === "description" ? text : normalizeSingleLinePaste(text);
}

function normalizeSingleLinePaste(text: string): string {
  return text.replace(/\n+/g, " ").trimEnd();
}

function isTextInputField(field: NewTaskField): field is TextInputField {
  return field === "title" || field === "description" || field === "directory" || field === "assignedTo";
}

function isSelectAllKey(key: KeyEvent): boolean {
  return (key.ctrl || key.meta) && (key.name === "a" || key.sequence === "\u0001");
}

function isLineDeleteKey(key: KeyEvent): boolean {
  return (
    (key.ctrl && (key.name === "u" || key.sequence === "\u0015")) ||
    (key.meta && (key.name === "backspace" || key.name === "delete" || key.sequence === "\u007f" || key.sequence === "\b" || key.sequence === "\u001b[3~"))
  );
}

function readDraftText(draft: NewTaskDraft, field = draft.field): string {
  switch (field) {
    case "title":
      return draft.title;
    case "description":
      return draft.description;
    case "directory":
      return draft.directory;
    case "assignedTo":
      return draft.assignedTo;
    default:
      return "";
  }
}

function setDraftText(draft: NewTaskDraft, field: TextInputField, value: string): void {
  switch (field) {
    case "title":
      draft.title = value;
      break;
    case "description":
      draft.description = value;
      break;
    case "directory":
      draft.directory = value;
      break;
    case "assignedTo":
      draft.assignedTo = value;
      break;
  }
  setDraftCursor(draft, field, Math.min(getDraftCursor(draft, field), value.length));
  clampDraftScroll(draft, field);
}

function getDraftCursor(draft: NewTaskDraft, field: TextInputField): number {
  const value = readDraftText(draft, field);
  return Math.max(0, Math.min(draft.textCursors?.[field] ?? value.length, value.length));
}

function setDraftCursor(draft: NewTaskDraft, field: TextInputField, cursor: number): void {
  const value = readDraftText(draft, field);
  draft.textCursors ??= {};
  draft.textCursors[field] = Math.max(0, Math.min(cursor, value.length));
  keepDraftCursorVisible(draft, field);
}

function setDraftScroll(draft: NewTaskDraft, field: TextInputField, scroll: number): void {
  draft.textScrolls ??= {};
  draft.textScrolls[field] = Math.max(0, scroll);
}

function clampDraftScroll(draft: NewTaskDraft, field: TextInputField): void {
  const value = readDraftText(draft, field);
  const current = draft.textScrolls?.[field] ?? 0;
  setDraftScroll(draft, field, Math.min(current, Math.max(0, value.length - TEXT_INPUT_COLUMNS)));
}

function keepDraftCursorVisible(draft: NewTaskDraft, field: TextInputField): void {
  const cursor = getDraftCursor(draft, field);
  const height = field === "description" ? 4 : 1;
  const visibleChars = Math.max(1, TEXT_INPUT_COLUMNS * height);
  const rawScroll = draft.textScrolls?.[field] ?? 0;
  if (cursor < rawScroll) setDraftScroll(draft, field, cursor);
  else if (cursor > rawScroll + visibleChars) setDraftScroll(draft, field, cursor - visibleChars);
}

function moveDraftCursor(draft: NewTaskDraft, field: TextInputField, delta: number): void {
  setDraftCursor(draft, field, getDraftCursor(draft, field) + delta);
  clearDraftSelection(draft);
}

function scrollDraftText(draft: NewTaskDraft, field: TextInputField, delta: number): void {
  const value = readDraftText(draft, field);
  const height = field === "description" ? 4 : 1;
  const visibleChars = Math.max(1, TEXT_INPUT_COLUMNS * height);
  const maxScroll = Math.max(0, value.length - visibleChars);
  const nextScroll = Math.max(0, Math.min((draft.textScrolls?.[field] ?? 0) + delta, maxScroll));
  setDraftScroll(draft, field, nextScroll);
  setDraftCursor(draft, field, Math.min(value.length, nextScroll));
  clearDraftSelection(draft);
}

function clearDraftSelection(draft: NewTaskDraft): void {
  draft.textSelection = undefined;
}

function selectedDraftRange(draft: NewTaskDraft, field: TextInputField): { start: number; end: number } | undefined {
  if (!draft.textSelection || draft.textSelection.field !== field) return undefined;
  const start = Math.min(draft.textSelection.start, draft.textSelection.end);
  const end = Math.max(draft.textSelection.start, draft.textSelection.end);
  return start === end ? undefined : { start, end };
}

function replaceDraftSelection(draft: NewTaskDraft, field: TextInputField, insertion: string): void {
  const value = readDraftText(draft, field);
  const selection = selectedDraftRange(draft, field);
  const start = selection?.start ?? getDraftCursor(draft, field);
  const end = selection?.end ?? start;
  const next = `${value.slice(0, start)}${insertion}${value.slice(end)}`;
  clearDraftSelection(draft);
  setDraftText(draft, field, next);
  setDraftCursor(draft, field, start + insertion.length);
}

function deleteDraftText(draft: NewTaskDraft, field: TextInputField, direction: "backward" | "forward"): void {
  const value = readDraftText(draft, field);
  const selection = selectedDraftRange(draft, field);
  if (selection) {
    replaceDraftSelection(draft, field, "");
    return;
  }

  const cursor = getDraftCursor(draft, field);
  if (direction === "backward") {
    if (cursor === 0) return;
    setDraftText(draft, field, `${value.slice(0, cursor - 1)}${value.slice(cursor)}`);
    setDraftCursor(draft, field, cursor - 1);
    return;
  }

  if (cursor >= value.length) return;
  setDraftText(draft, field, `${value.slice(0, cursor)}${value.slice(cursor + 1)}`);
  setDraftCursor(draft, field, cursor);
}

function deleteDraftLine(draft: NewTaskDraft, field: TextInputField): void {
  const value = readDraftText(draft, field);
  const cursor = getDraftCursor(draft, field);
  const { start, end, nextCursor } = lineRangeAtCursor(value, cursor);
  setDraftText(draft, field, `${value.slice(0, start)}${value.slice(end)}`);
  setDraftCursor(draft, field, nextCursor);
  clearDraftSelection(draft);
}

function lineRangeAtCursor(value: string, cursor: number): { start: number; end: number; nextCursor: number } {
  if (!value) return { start: 0, end: 0, nextCursor: 0 };
  const boundedCursor = Math.max(0, Math.min(cursor, value.length));
  const cursorForLine = boundedCursor > 0 && boundedCursor === value.length ? boundedCursor - 1 : boundedCursor;
  const previousNewline = value.lastIndexOf("\n", Math.max(0, cursorForLine - 1));
  const start = previousNewline + 1;
  const nextNewline = value.indexOf("\n", cursorForLine);
  const end = nextNewline === -1 ? value.length : nextNewline + 1;
  const nextCursor = Math.min(start, Math.max(0, value.length - (end - start)));
  return { start, end, nextCursor };
}

function newTaskFieldOrder(draft: NewTaskDraft): readonly NewTaskField[] {
  if (draft.type === "manual") return MANUAL_FIELD_ORDER;
  return draft.harness === "claude-code" ? CLAUDE_FIELD_ORDER : AGENT_FIELD_ORDER;
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

  if (isLineDeleteKey(key)) {
    state.workspaceGateInput = "";
    state.workspaceGateError = undefined;
    actions.render();
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

  if (isEscapeKey(key) || key.sequence === "q") {
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

  if (key.sequence === "s") {
    const item = state.instanceList[state.switcherSelectedIndex];
    if (!item) return;
    if (state.instanceActionState[item.definition.name]) {
      state.status = `${item.definition.name} is already ${state.instanceActionState[item.definition.name]}`;
      actions.render();
      return;
    }
    if (item.runtime.status === "running") {
      await actions.stopInstance(item.definition.name);
    } else {
      await actions.startInstance(item.definition.name);
    }
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

  if (isLineDeleteKey(key)) {
    if (draft.field === "name") draft.name = "";
    else draft.workspace = "";
    draft.error = undefined;
    actions.render();
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

  if (isLineDeleteKey(key)) {
    draft.newName = "";
    draft.error = undefined;
    actions.render();
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
    clearPendingConfirmation(state);
    actions.render();
    return;
  }

  if (isEnterKey(key) && task) {
    const target = state.moveTargetColumn ?? task.column;
    if (target === task.column) {
      // No change, just close
      state.moveTargetColumn = undefined;
      clearPendingConfirmation(state);
      actions.render();
      return;
    }
    if (target === "done") {
      const result = requestConfirmation(state, "move-to-done", task.id);
      state.pendingConfirmation = result.state.pendingConfirmation;
      state.error = undefined;
      if (!result.execute) {
        state.status = `Move "${task.title}" to Done? Press enter again to confirm.`;
        actions.render();
        return;
      }
      clearPendingConfirmation(state);
    } else {
      clearPendingConfirmation(state);
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
    clearPendingConfirmation(state);
    state.moveTargetColumn = nextColumn(state.moveTargetColumn ?? task?.column ?? "todo", 1);
    actions.render();
    return;
  }

  if (keyName === "up") {
    clearPendingConfirmation(state);
    state.moveTargetColumn = nextColumn(state.moveTargetColumn ?? task?.column ?? "todo", -1);
    actions.render();
    return;
  }

  // Number keys 1-4 select lane directly
  const numMap: Record<string, Column> = { "1": "todo", "2": "in_progress", "3": "review", "4": "done" };
  if (key.sequence in numMap) {
    clearPendingConfirmation(state);
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

function currentHarnessLabel(draft: NewTaskDraft): string {
  return draft.harness === "claude-code" ? "Claude Code" : "OpenCode";
}

function currentPermissionModeLabel(draft: NewTaskDraft): string {
  return draft.claudePermissionMode;
}

function currentModelLabel(draft: NewTaskDraft): string {
  if (draft.harness === "claude-code") {
    return draft.model?.id ?? "Claude default";
  }
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

function modelOptions(draft: NewTaskDraft, agents: RosterAgent[]): Array<ModelRef | undefined> {
  return draft.harness === "claude-code"
    ? [...CLAUDE_CODE_MODELS]
    : [undefined, ...uniqueModels(agents)];
}

function defaultModelForHarness(draft: Pick<NewTaskDraft, "harness" | "agentId">, agents: RosterAgent[]): ModelRef | undefined {
  if (draft.harness === "claude-code") return CLAUDE_CODE_MODELS[0];
  return agents.find((item) => item.id === draft.agentId)?.model;
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
