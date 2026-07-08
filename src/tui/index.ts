#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createBoardClient } from "../client/board-client";
import type { BoardClient, BoardHealth } from "../client/board-client";
import { CLAUDE_CODE_MODELS, CODEX_MODELS, CURSOR_ACP_MODELS, DEFAULT_ACP_PERMISSION_MODE, GEMINI_ACP_MODELS, HERMES_MODELS, PI_CODING_AGENT_MODELS, TASK_HARNESSES, USER_COMPLETED_BY, type AcpConfigCatalog, type AcpConfigOption, type AcpConfigValueOption, type AcpOptions, type AcpPermissionMode, type AcpTaskHarness, type Column, type CompletionReport, type DiffResponse, type ModelRef, type PermissionOverrideAction, type PermissionOverrideCategory, type PermissionOverrides, type RosterAgent, type RosterProvider, type Task, type TaskComment, type TaskHarness, type TaskIsolationMode, type TaskRunState, type TaskType, type WorktreeCommitStatus } from "../shared";
import { PERMISSION_OVERRIDE_ACTIONS, PERMISSION_OVERRIDE_CATEGORIES } from "../shared";
import { validateInstanceName } from "../shared/instances";
import { assertOpenTuiRuntime } from "./runtime";
import { isLocalBoardUrl } from "../shared/instances";
import { resolveEditorCommand, type EditorCommand } from "./editor-command";
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
  taskStatus,
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
  openDiffView,
  closeDiffView,
} from "./model";
import {
  canOpenDiffView,
  createLoadingDiffViewState,
  applyDiffResponse,
  applyDiffError,
  moveFileSelection as moveDiffFileSelection,
  toggleFileReviewed as toggleDiffFileReviewed,
  toggleViewOverride as toggleDiffViewOverride,
  moveHunkSelection as moveDiffHunkSelection,
  diffPatchScrollTop,
  clampFullPatchScrollTop,
  fullPatchHunkBodyOffset,
  toggleFileSelectionLock as toggleDiffFileSelectionLock,
  diffViewHeaderLabel,
  diffViewKeyHints,
  diffFileCommitState,
  renderDiffView,
  editorTargetForSelection,
  DIFF_FILE_COLUMN_WIDTH,
  DIFF_FILE_ROW_HEIGHT,
  DIFF_PATCH_SCROLL_ID,
  type DiffViewState,
  type DiffViewTheme,
  type DiffFileCommitState,
} from "./diff-view";
import { formatDiffStat } from "./diff-stat";
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
import { RGBA, type KeyEvent, type MouseEvent, type PasteEvent, type VChild } from "@opentui/core";

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
const DETAIL_SCROLL_STEP_ROWS = 3;

export function shouldAutoRefresh(viewState: ViewState): boolean {
  return !["archive", "diff", "launch", "workspaceGate"].includes(viewState.view);
}

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
  diffAdd: TuiColor;
  diffDelete: TuiColor;
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
  diffAdd: "#30d77d",
  diffDelete: "#ff5c5c",
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
  diffAdd: RGBA.fromIndex(78),
  diffDelete: RGBA.fromIndex(203),
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

/**
 * The 'n'/'e' new-task form is a wizard (identity -> harness ->
 * agentProfile -> isolation -> dependencies -> confirm). Manual cards skip the
 * agent-only screens. Each screen owns its own field-order table below;
 * `stepFieldOrder()` picks the right one for the current step/harness/
 * isolation combination, and Tab/arrow cycling only ever moves within it.
 */
type WizardStep = "identity" | "harness" | "agentProfile" | "isolation" | "dependencies" | "confirm";

const IDENTITY_FIELDS_AGENT = ["type", "title", "description", "directory"] as const;
const IDENTITY_FIELDS_MANUAL = ["type", "title", "description", "assignedTo", "directory"] as const;
const HARNESS_FIELDS_OPENCODE = ["harness", "provider", "model"] as const;
/** MODEL is locked out while PROVIDER is "Use Agent Profile Default" (draft.providerId === "") — nothing to pick. */
const HARNESS_FIELDS_OPENCODE_LOCKED = ["harness", "provider"] as const;
const HARNESS_FIELDS_CLAUDE = ["harness", "model"] as const;
/** Shared label for "no explicit provider/model — the assigned agent profile's own model wins." */
const AGENT_PROFILE_DEFAULT_LABEL = "Use Agent Profile Default";
const AGENT_PROFILE_FIELDS_OPENCODE = ["agent"] as const;
const AGENT_PROFILE_FIELDS_ACP_BASE = ["permissionMode"] as const;
const ACP_OPTION_FIELDS = ["acpOption0", "acpOption1", "acpOption2", "acpOption3", "acpOption4", "acpOption5"] as const;
/** No permission editor: worktree isolation (locked, automatic) or Claude Code harness (N/A). */
const ISOLATION_FIELDS_LOCKED = ["isolation"] as const;
const ISOLATION_FIELDS_EDITABLE = ["isolation", "permEdit", "permBash", "permWebfetch"] as const;
const DEPENDENCY_FIELDS = ["dependency"] as const;
const CONFIRM_FIELDS: readonly never[] = [];
const TEXT_INPUT_COLUMNS = 56;
type Overlay = "none" | "help" | "newTask" | "addInstance" | "renameInstance";
type NewTaskField =
  | (typeof IDENTITY_FIELDS_MANUAL)[number]
  | (typeof HARNESS_FIELDS_OPENCODE)[number]
  | (typeof AGENT_PROFILE_FIELDS_OPENCODE)[number]
  | (typeof AGENT_PROFILE_FIELDS_ACP_BASE)[number]
  | (typeof ACP_OPTION_FIELDS)[number]
  | (typeof ISOLATION_FIELDS_EDITABLE)[number]
  | (typeof DEPENDENCY_FIELDS)[number];
type TextInputField = Extract<NewTaskField, "title" | "description" | "directory" | "assignedTo">;
type AddInstanceField = "name" | "workspace";

function isAcpHarness(harness: TaskHarness | undefined): boolean {
  return harness !== undefined && harness !== "opencode";
}

function isClaudeHarness(harness: TaskHarness | undefined): boolean {
  return harness === "claude-code";
}

function acpHarnessModels(harness: TaskHarness): readonly ModelRef[] {
  switch (harness) {
    case "claude-code":
      return CLAUDE_CODE_MODELS;
    case "codex":
      return CODEX_MODELS;
    case "gemini-acp":
      return GEMINI_ACP_MODELS;
    case "hermes":
      return HERMES_MODELS;
    case "pi-coding-agent":
      return PI_CODING_AGENT_MODELS;
    case "cursor-acp":
      return CURSOR_ACP_MODELS;
    case "opencode":
      return [];
  }
}

function acpModelProviderForHarness(harness: TaskHarness): string | undefined {
  return acpHarnessModels(harness)[0]?.providerID;
}

function acpConfigForHarness(catalog: AcpConfigCatalog, harness: TaskHarness | undefined) {
  if (!isAcpHarness(harness)) return undefined;
  const config = catalog[harness as AcpTaskHarness];
  return config?.available ? config : undefined;
}

function harnessCycle(state: TuiState): readonly TaskHarness[] {
  return [
    "opencode",
    ...TASK_HARNESSES.filter(
      (harness): harness is AcpTaskHarness => harness !== "opencode" && acpConfigForHarness(state.acpConfig, harness) !== undefined,
    ),
  ];
}

function acpOptionSpecs(catalog: AcpConfigCatalog, harness: TaskHarness | undefined): readonly AcpConfigOption[] {
  return acpConfigForHarness(catalog, harness)?.options.slice(0, ACP_OPTION_FIELDS.length) ?? [];
}

function defaultAcpOptions(catalog: AcpConfigCatalog, harness: TaskHarness): AcpOptions {
  const options: AcpOptions = {};
  for (const spec of acpOptionSpecs(catalog, harness)) {
    if (spec.currentValue !== undefined) options[spec.id] = spec.currentValue;
    else if (spec.type === "select") {
      const first = spec.options?.[0]?.value;
      if (first !== undefined) options[spec.id] = first;
    } else if (spec.type === "boolean") {
      options[spec.id] = false;
    }
  }
  return options;
}

function reconcileAcpOptions(catalog: AcpConfigCatalog, harness: TaskHarness, current: AcpOptions | undefined | null): AcpOptions {
  const options: AcpOptions = {};
  for (const spec of acpOptionSpecs(catalog, harness)) {
    const currentValue = current?.[spec.id];
    if (spec.type === "boolean") {
      options[spec.id] = typeof currentValue === "boolean" ? currentValue : typeof spec.currentValue === "boolean" ? spec.currentValue : false;
      continue;
    }
    const allowed = new Set((spec.options ?? []).map((option) => option.value));
    if (typeof currentValue === "string" && (allowed.size === 0 || allowed.has(currentValue))) {
      options[spec.id] = currentValue;
    } else if (typeof spec.currentValue === "string" && (allowed.size === 0 || allowed.has(spec.currentValue))) {
      options[spec.id] = spec.currentValue;
    } else {
      const first = spec.options?.[0]?.value;
      if (first !== undefined) options[spec.id] = first;
    }
  }
  return options;
}

function acpOptionFieldIndex(field: NewTaskField): number {
  return ACP_OPTION_FIELDS.indexOf(field as (typeof ACP_OPTION_FIELDS)[number]);
}

function harnessDisplayName(harness: TaskHarness | undefined): string {
  switch (harness) {
    case "claude-code":
      return "Claude Code";
    case "codex":
      return "Codex ACP";
    case "gemini-acp":
      return "Gemini ACP";
    case "hermes":
      return "Hermes ACP";
    case "pi-coding-agent":
      return "Pi Coding Agent";
    case "cursor-acp":
      return "Cursor ACP";
    case "opencode":
    default:
      return "OpenCode";
  }
}
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
  final_session_output?: string | null;
  completion_source: string | null;
  comments?: string | null;
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
  /** Selected OpenCode provider id ("" = unset — MODEL falls back to the agent-roster-derived list). */
  providerId: string;
  agentId: string;
  permissionMode: AcpPermissionMode;
  acpOptions: AcpOptions;
  assignedTo: string;
  model?: ModelRef;
  /** Type-to-filter query for the MODEL field, active only while it's focused — reset whenever focus leaves it. */
  modelQuery?: string;
  isolation: TaskIsolationMode;
  /** OpenCode permission-category overrides. Only ever submitted for in-place (non-worktree) OpenCode tasks. */
  permissionOverrides: Record<PermissionOverrideCategory, PermissionOverrideAction>;
  parentIds: string[];
  dependencyIndex: number;
  step: WizardStep;
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
  detailTab: TaskDetailTab;
  /** Focused detail mode mirrors the board detail view: up/down scrolls the selected record's tab content. */
  focused: boolean;
  /** Expanded detail mode hides the metadata block so the tab content gets the full height. */
  expanded: boolean;
}

/** Detail tabs shown for a selected card via Enter. */
export type TaskDetailTab = "prompt" | "handoff" | "output" | "files" | "comments";

/** State for the two-step global filter picker opened with f/F. */
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

interface FilesDetailState {
  ownerId: string;
  selectedIndex: number;
  mode: "list" | "patch";
}

interface IntegrateCommitReviewState {
  taskId: string;
  status: WorktreeCommitStatus;
}

type ReviewDiffStatState =
  | { taskId: string; taskUpdatedAt: number; status: "loading" }
  | { taskId: string; taskUpdatedAt: number; status: "success"; label: string; response?: DiffResponse }
  | { taskId: string; taskUpdatedAt: number; status: "error"; label: string };

type ReviewCommitStatusState =
  | { taskId: string; taskUpdatedAt: number; status: "loading" }
  | { taskId: string; taskUpdatedAt: number; status: "success"; response: WorktreeCommitStatus }
  | { taskId: string; taskUpdatedAt: number; status: "error" };

/** In-progress compose state for a new top-level comment or a reply. */
interface CommentDraftState {
  taskId: string;
  parentCommentId: string | null;
  text: string;
}

interface TuiState {
  tasks: Task[];
  agents: RosterAgent[];
  providers: RosterProvider[];
  acpConfig: AcpConfigCatalog;
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
  detailScrollTop: Record<string, number>;
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
  // In-column instance switcher (b from board view)
  instanceSwitcher?: { selectedIndex: number };
  // Comments detail tab
  comments?: CommentsPanelState;
  commentDraft?: CommentDraftState;
  // Files detail tab
  filesDetail?: FilesDetailState;
  // Commit-state review shown before integrating a dirty worktree.
  integrateCommitReview?: IntegrateCommitReviewState;
  // Full-screen diff view (v on a selected Review card)
  diffView?: DiffViewState;
  // Inline selected-card diff stat for Review cards, fetched once per selected task identity.
  reviewDiffStat?: ReviewDiffStatState;
  // File-level dirty-vs-committed state for Review worktrees.
  reviewCommitStatus?: ReviewCommitStatusState;
  // Set by diff keyboard scroll/hunk-nav so the next render() treats `detailScrollTop`
  // as authoritative (applies it to the diff renderable) instead of capturing the live
  // renderable's scrollY. Mouse-wheel scroll leaves it false so that scroll is captured.
  diffScrollIntent?: boolean;
}

/** Result of running a terminal (foreground) editor to completion. */
export interface TerminalEditorResult {
  code: number | null;
}

/**
 * Injectable child_process seam for the `e` (open in editor) action, so wiring tests can fake
 * process spawning instead of launching a real editor. `runTerminalEditor` suspends/resumes the
 * TUI around a foreground spawn (`stdio: "inherit"`) and resolves once the editor exits.
 * `spawnGuiEditor` fires a detached, unref'd background spawn and returns immediately.
 */
export interface EditorSpawner {
  runTerminalEditor: (argv: string[], cwd: string) => Promise<TerminalEditorResult>;
  spawnGuiEditor: (argv: string[], cwd: string, onError?: (error: unknown) => void) => void;
}

function createRealEditorSpawner(renderer: { suspend: () => void; resume: () => void }): EditorSpawner {
  return {
    runTerminalEditor: (argv, cwd) =>
      new Promise<TerminalEditorResult>((resolve, reject) => {
        renderer.suspend();
        try {
          const [command, ...args] = argv;
          const child = spawn(command!, args, { stdio: "inherit", cwd });
          child.once("error", (error) => {
            try {
              renderer.resume();
            } finally {
              reject(error);
            }
          });
          child.once("exit", (code) => {
            try {
              renderer.resume();
            } finally {
              resolve({ code });
            }
          });
        } catch (error) {
          renderer.resume();
          reject(error);
        }
      }),
    spawnGuiEditor: (argv, cwd, onError) => {
      const [command, ...args] = argv;
      const child = spawn(command!, args, { detached: true, stdio: "ignore", cwd });
      // Without a listener, a spawn failure (editor not on PATH → ENOENT)
      // is an unhandled "error" event and kills the whole renderer.
      child.once("error", (error) => onError?.(error));
      child.unref();
    },
  };
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
  // Open-in-editor (e on a DiffView selection)
  editorSpawner: EditorSpawner;
}

/** Minimal shape of OpenTUI's scrollable code renderable (a TextBufferRenderable). */
interface ScrollableCodeRenderable {
  scrollY: number;
  readonly maxScrollY: number;
}

/** Just the slice of the renderer the diff-scroll helpers touch. */
interface DiffScrollRenderer {
  root: { findDescendantById(id: string): unknown };
}

/** The DiffRenderable names its inner code panes `<id>-<side>-code`; unified view builds
 * only the left one, split builds both. Returns whichever currently exist. */
function findDiffCodeRenderables(renderer: DiffScrollRenderer): ScrollableCodeRenderable[] {
  const found: ScrollableCodeRenderable[] = [];
  for (const side of ["left", "right"] as const) {
    const node = renderer.root.findDescendantById(`${DIFF_PATCH_SCROLL_ID}-${side}-code`);
    if (node && typeof (node as { scrollY?: unknown }).scrollY === "number") {
      found.push(node as ScrollableCodeRenderable);
    }
  }
  return found;
}

/** Read the live viewport scrollY back into state so mouse-wheel scroll survives the next
 * root-tree rebuild. No-op when the diff pane isn't mounted. */
export function captureDiffScrollTop(state: TuiState, renderer: DiffScrollRenderer): void {
  if (state.diffView?.kind !== "diff") return;
  const [code] = findDiffCodeRenderables(renderer);
  if (code) state.detailScrollTop[DIFF_PATCH_SCROLL_ID] = code.scrollY;
}

/** Push the tracked scrollTop onto the freshly-built code pane(s), clamped to the real
 * maxScrollY, and write the clamped value back so a held key can't run the counter past the
 * bottom. Both panes share one position (split view keeps them in sync). */
export function applyDiffScrollTop(state: TuiState, renderer: DiffScrollRenderer): void {
  if (state.diffView?.kind !== "diff") return;
  const codes = findDiffCodeRenderables(renderer);
  if (codes.length === 0) return;
  const desired = Math.max(0, Math.trunc(state.detailScrollTop[DIFF_PATCH_SCROLL_ID] ?? 0));
  const clamped = Math.min(desired, codes[0].maxScrollY);
  for (const code of codes) code.scrollY = clamped;
  state.detailScrollTop[DIFF_PATCH_SCROLL_ID] = clamped;
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
    providers: [],
    acpConfig: {},
    boardUrl: client.boardUrl,
    status: `connected to ${client.boardUrl}`,
    refreshing: false,
    cwd: client.cwd,
    overlay: "none",
    terminalCols: renderer.terminalWidth,
    terminalRows: renderer.terminalHeight,
    laneOffsets: { todo: 0, in_progress: 0, review: 0, done: 0 },
    detailScrollTop: {},
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
      // Diff scroll lives on the DiffRenderable's own viewport, but the root tree is
      // destroyed and rebuilt on every render (see root-lifecycle.ts). Capture the live
      // scrollY into state before teardown so mouse-wheel scroll survives the rebuild —
      // unless a scroll key just set the position, in which case state is authoritative.
      if (state.diffScrollIntent) {
        state.diffScrollIntent = false;
      } else {
        captureDiffScrollTop(state, renderer);
      }
      resetTerminalModes();
      state.terminalCols = renderer.terminalWidth;
      state.terminalRows = renderer.terminalHeight;
      mountRoot(renderApp(ui, state));
      // Re-apply the tracked scroll onto the freshly-built renderable, clamped to its real
      // maxScrollY (which reflects wrapping and viewport height). Keeps the line-number
      // gutter synced with its code on keyboard scroll — the whole point of this pass.
      applyDiffScrollTop(state, renderer);
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
      const [tasks, agents, providers, acpConfig, healthResult] = await Promise.all([
        currentClient.listTasks(),
        currentClient.listAgents(),
        // Best-effort: an older board daemon without /api/providers (or any
        // other provider-fetch failure) must never break the whole refresh —
        // fall back to [], same contract as the server route's own best-effort
        // GET /api/providers behavior.
        currentClient.listProviders().catch(() => [] as RosterProvider[]),
        currentClient.listAcpConfig().catch(() => ({} as AcpConfigCatalog)),
        currentClient.getHealth().then(
          (health) => ({ ok: true as const, health }),
          (error) => ({ ok: false as const, error }),
        ),
      ]);
      state.tasks = tasks;
      state.agents = agents;
      state.providers = providers;
      state.acpConfig = acpConfig;
      state.selectedTaskId = resolveSelectedTaskId(tasks, state.selectedTaskId);
      state.reviewDiffStat = reconcileReviewDiffStatCache(state.reviewDiffStat, selectedTask(state));
      state.reviewCommitStatus = reconcileReviewCommitStatusCache(state.reviewCommitStatus, selectedTask(state));
      state.pendingConfirmation = clearPendingForSelection(state, state.selectedTaskId);
      if (state.integrateCommitReview && state.integrateCommitReview.taskId !== state.selectedTaskId) {
        state.integrateCommitReview = undefined;
      }
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
      void fetchSelectedReviewDiffStat(state, currentClient, render);
      void fetchSelectedReviewCommitStatus(state, currentClient, render);
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
      state.providers = [];
      state.selectedTaskId = undefined;
      state.reviewDiffStat = undefined;
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
    state.providers = [];
    state.selectedTaskId = undefined;
    state.reviewDiffStat = undefined;
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
        focused: false,
        expanded: false,
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

  const editorSpawner = createRealEditorSpawner(renderer);

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
      editorSpawner,
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
    if (!shouldAutoRefresh(state.viewState)) return;
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

  const mainView = state.viewState.view === "workspaceGate"
      ? renderWorkspaceGateView(ui, state)
      : state.viewState.view === "launch"
        ? renderLaunchView(ui, state)
        : state.viewState.view === "archive"
          ? renderArchiveView(ui, state)
          : state.viewState.view === "diff"
            ? renderDiffViewMain(ui, state)
            : renderMain(ui, state);
  const children = state.viewState.view === "board"
    ? [mainView, renderCommandStrip(ui, state), renderHeader(ui, state)]
    : [renderHeader(ui, state), mainView, renderCommandStrip(ui, state)];
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
  let dbLabel = "";
  let filterLabel = "";

  if (state.viewState.view === "board") {
    const currentInstance = currentInstanceItem(state);
    if (currentInstance) {
      instanceLabel = ` · INSTANCE ${currentInstance.definition.name}:${currentInstance.definition.port}`;
      workspaceLabel = `WORKSPACE ${shortPath(currentInstance.definition.workspace)}`;
      dbLabel = `DB ${shortPath(state.health?.identity?.dbPath ?? currentInstance.definition.dbPath)}`;
    } else {
      workspaceLabel = `WORKSPACE ${shortPath(state.cwd)}`;
      if (state.health?.identity?.dbPath) dbLabel = `DB ${shortPath(state.health.identity.dbPath)}`;
    }
    if (state.boardFilter) filterLabel = `FILTER ${state.boardFilter.kind}:${state.boardFilter.value}`;
  } else if (state.viewState.view === "launch") {
    connection = "";
    host = "";
    taskLabel = "";
    refreshed = "";
    healthLabel = "";
    workspaceLabel = "";
    dbLabel = "";
  } else if (state.viewState.view === "workspaceGate") {
    connection = "SETUP";
    host = "";
    taskLabel = "";
    refreshed = "";
    healthLabel = "";
    workspaceLabel = "";
    dbLabel = "";
  } else if (state.viewState.view === "switcher") {
    connection = "SWITCHER";
    host = "";
    taskLabel = "";
    refreshed = "";
    healthLabel = "";
    workspaceLabel = "";
    dbLabel = "";
  } else if (state.viewState.view === "archive") {
    connection = "ARCHIVE";
    host = "";
    taskLabel = `${state.archive?.records.length ?? 0} RECORD${state.archive?.records.length === 1 ? "" : "S"}`;
    refreshed = "";
    healthLabel = "";
    workspaceLabel = "";
    dbLabel = "";
  } else if (state.viewState.view === "diff") {
    connection = "DIFF";
    host = "";
    taskLabel = diffViewHeaderLabel(state.diffView);
    refreshed = "";
    healthLabel = "";
    workspaceLabel = "";
    dbLabel = "";
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
      content: [connection, host, instanceLabel.replace(/^ · /, ""), workspaceLabel, dbLabel, filterLabel, taskLabel, refreshed, healthLabel].filter(Boolean).join(" · "),
      fg: state.error ? COLORS.bright : COLORS.muted,
      height: 1,
      truncate: true,
    }),
  );
}

function boardHealthLabel(state: TuiState): string {
  if (state.health?.adapter === "ok") {
    const board = state.health.build?.version
      ? `Board ${state.health.build.version}`
      : "Board ok";
    const opencode = state.health.opencode.status === "ok"
      ? `OpenCode ${state.health.opencode.version}`
      : "OpenCode unreachable";
    return `${board} · ${opencode}`;
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

const DIFF_VIEW_THEME: DiffViewTheme = {
  text: COLORS.text,
  bright: COLORS.bright,
  muted: COLORS.muted,
  dim: COLORS.dim,
  border: COLORS.border,
  panel: COLORS.panel,
  panelRaised: COLORS.panelRaised,
  laneDone: COLORS.laneDone,
  laneError: COLORS.laneError,
  boxBg,
};

function diffPatchPaneWidth(terminalCols: number): number {
  return Math.max(0, terminalCols - DIFF_FILE_COLUMN_WIDTH - TUI_LAYOUT.laneGap - 4);
}

function diffFileListVisibleRows(terminalRows: number): number {
  // Root padding + header + command strip + diff file-list status line consume the rest.
  return Math.max(1, Math.floor(Math.max(1, terminalRows - 6) / DIFF_FILE_ROW_HEIGHT));
}

function renderDiffViewMain(ui: OpenTui, state: TuiState) {
  return renderDiffView(
    ui,
    DIFF_VIEW_THEME,
    state.detailScrollTop,
    state.diffView,
    diffPatchPaneWidth(state.terminalCols),
    diffFileListVisibleRows(state.terminalRows),
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

  const tabContent: VChild =
    tab === "prompt"
      ? renderScrollableDetailText(ui, state, `archive-detail-prompt-${record.task_id}`, record.description || "(empty prompt)")
      : tab === "handoff"
        ? renderHandoffTab(ui, state, completion, `archive-detail-handoff-${record.task_id}`)
        : tab === "output"
          ? renderFinalOutputTab(ui, state, `archive-detail-output-${record.task_id}`, record.final_session_output)
          : tab === "files"
            ? renderArchiveFilesTab(ui, state, record, completion)
            : renderArchiveCommentsTab(ui, state, record);

  const expanded = state.archive?.expanded ?? false;
  const titleAndMeta: VChild[] = expanded
    ? []
    : [
        ui.Text({ content: record.title, fg: COLORS.text, attributes: ui.TextAttributes.BOLD, wrapMode: "word", height: 3 }),
        ui.Box(
          { width: "100%", height: rows.length, flexDirection: "column", gap: 0, ...boxBg(COLORS.panel) },
          ...rows.map((row) => renderTaskMeta(ui, row, false, SIDEBAR_META_LABEL_WIDTH, COLORS.bright)),
        ),
        ui.Text({ content: HAIRLINE, fg: COLORS.hairline, height: 1, truncate: true }),
      ];

  return ui.Box(
    { flexGrow: 1, flexDirection: "column", gap: 1, ...boxBg(COLORS.panel) },
    ...titleAndMeta,
    // Tab headers
    ui.Box(
      { width: "100%", flexDirection: "row", height: 1, gap: 2 },
      ...BOARD_DETAIL_TABS.map((candidate) =>
        ui.Text({
          content: DETAIL_TAB_LABELS[candidate],
          fg: tab === candidate ? activeTabFg : inactiveTabFg,
          attributes: tab === candidate ? ui.TextAttributes.BOLD : undefined,
          height: 1,
        }),
      ),
    ),
    ui.Text({ content: HAIRLINE, fg: COLORS.hairline, height: 1, truncate: true }),
    tabContent,
  );
}

function archiveDetailRows(record: GlobalArchiveRecord, model: ModelRef | null): MetaRow[] {
  const taskType = record.task_type === "manual" ? "manual" : "agent";
  const state = archiveTaskStatus(record);
  return [
    { label: "STATE", value: `${state.glyph} ${state.label}`, color: COLORS.text },
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
    ...(record.worktree_branch ? [{ label: "BRANCH", value: `⑃ ${record.worktree_branch}`, color: COLORS.text }] : []),
    ...(record.base_branch ? [{ label: "BASE", value: `⑃ ${record.base_branch}`, color: COLORS.text }] : []),
    { label: "TASK ID", value: record.task_id, color: COLORS.text },
    { label: "WORKSPACE", value: shortPath(record.source_workspace), color: COLORS.text },
    { label: "ARCHIVED", value: formatArchiveDate(record.archived_at), color: COLORS.text },
  ];
}

function archiveTaskStatus(record: Pick<GlobalArchiveRecord, "run_state" | "column_name">): { glyph: string; label: string } {
  const runState = ["running", "idle", "error", "unstarted"].includes(record.run_state)
    ? record.run_state as TaskRunState
    : "idle";
  return taskStatus({ runState, column: archiveColumn(record.column_name) });
}

function archiveColumn(column: string): Column {
  return TUI_COLUMNS.includes(column as Column) ? column as Column : "todo";
}

function archiveWorktreeId(record: Pick<GlobalArchiveRecord, "task_id" | "worktree_path" | "worktree_branch">): string {
  if (record.worktree_path) return record.worktree_path.split("/").filter(Boolean).at(-1) ?? record.task_id;
  if (record.worktree_branch) return record.worktree_branch.split("/").filter(Boolean).at(-1) ?? record.task_id;
  return record.task_id;
}

function renderScrollableDetailText(ui: OpenTui, state: TuiState, id: string, content: string) {
  return renderDetailViewport(
    ui,
    state,
    id,
    ui.Text({ content, fg: COLORS.text, width: "100%", minWidth: 0, flexShrink: 1, wrapMode: "word" }),
  );
}

function detailScrollOffset(state: TuiState, id: string): number {
  return Math.max(0, Math.trunc(state.detailScrollTop[id] ?? 0));
}

function clampDetailScrollOffset(value: number, max: number): number {
  const limit = Number.isFinite(max) ? Math.max(0, Math.trunc(max)) : Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.min(Math.trunc(value), limit));
}

function renderDetailViewport(ui: OpenTui, state: TuiState, id: string, ...children: VChild[]) {
  const contentId = `${id}-content`;
  const offset = detailScrollOffset(state, id);
  return ui.Box(
    {
      id,
      flexGrow: 1,
      minHeight: 0,
      position: "relative",
      overflow: "hidden",
      ...boxBg(COLORS.panel),
      onMouseScroll(this: { height: number; findDescendantById: (id: string) => unknown; requestRender: () => void }, event: MouseEvent) {
        const direction = event.scroll?.direction;
        if (direction !== "up" && direction !== "down") return;
        const content = this.findDescendantById(contentId) as { height?: number; top?: number } | undefined;
        const max = Math.max(0, Math.trunc((content?.height ?? 0) - this.height));
        const delta = direction === "down" ? DETAIL_SCROLL_STEP_ROWS : -DETAIL_SCROLL_STEP_ROWS;
        const next = clampDetailScrollOffset(detailScrollOffset(state, id) + delta, max);
        state.detailScrollTop[id] = next;
        if (content) content.top = -next;
        event.preventDefault();
        event.stopPropagation();
        this.requestRender();
      },
    },
    ui.Box(
      {
        id: contentId,
        width: "100%",
        minWidth: 0,
        position: "absolute",
        top: -offset,
        left: 0,
        right: 0,
        flexDirection: "column",
        gap: 1,
        ...boxBg(COLORS.panel),
      },
      ...children,
    ),
  );
}

function renderHandoffTab(ui: OpenTui, state: TuiState, completion: CompletionReport | null, scrollId: string) {
  if (!completion) {
    return renderDetailViewport(
      ui,
      state,
      scrollId,
      ui.Text({ content: "No completion report available", fg: COLORS.muted, height: 1 }),
    );
  }

  const changedFiles = completion.changedFiles.length ? completion.changedFiles : ["none"];
  const verification = completion.verification.length
    ? completion.verification.map((item) => `${item.command} → ${item.result}`)
    : ["none"];

  return renderDetailViewport(
    ui,
    state,
    scrollId,
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

function renderArchiveFilesTab(ui: OpenTui, state: TuiState, record: GlobalArchiveRecord, completion: CompletionReport | null) {
  const files = completion?.changedFiles ?? [];
  const scrollId = `archive-detail-files-${record.task_id}`;
  if (files.length === 0) {
    return renderDetailViewport(ui, state, scrollId, ui.Text({ content: "No changed files recorded", fg: COLORS.muted, height: 1 }));
  }
  const detail = filesDetailState(state, archiveFilesOwnerId(record.task_id), files.length);
  return renderDetailViewport(
    ui,
    state,
    scrollId,
    ...files.map((file, index) => renderChangedFileListRow(ui, { file, additions: null, deletions: null }, index === detail.selectedIndex)),
  );
}

function archiveFilesVisibleRows(state: TuiState): number {
  return Math.max(2, laneInnerHeight(state.terminalRows) - 8);
}

function renderArchiveCommentsTab(ui: OpenTui, state: TuiState, record: GlobalArchiveRecord) {
  const items = parseArchiveComments(record.comments);
  const rows: VChild[] = [];
  if (items.length === 0) {
    rows.push(ui.Text({ content: "No archived comments available", fg: COLORS.muted, height: 1 }));
  } else {
    flattenComments(items).forEach((comment) => {
      const isReply = Boolean(comment.parentCommentId);
      rows.push(
        ui.Box(
          { width: "100%", flexDirection: "column", gap: 0, paddingLeft: isReply ? 2 : 0, ...boxBg(COLORS.panel) },
          ui.Text({
            content: `${isReply ? "↳ " : ""}${comment.author} · ${formatArchiveDate(comment.createdAt)}`,
            fg: COLORS.muted,
            height: 1,
            truncate: true,
          }),
          ui.Text({ content: comment.body, fg: COLORS.text, wrapMode: "word", width: "100%", minWidth: 0, flexShrink: 1 }),
        ),
      );
    });
  }

  return renderDetailViewport(ui, state, `archive-detail-comments-${record.task_id}`, ...rows);
}

function parseArchiveComments(raw: string | null | undefined): TaskComment[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is TaskComment =>
      Boolean(
        item &&
        typeof item === "object" &&
        typeof (item as TaskComment).id === "string" &&
        typeof (item as TaskComment).taskId === "string" &&
        typeof (item as TaskComment).author === "string" &&
        typeof (item as TaskComment).body === "string" &&
        typeof (item as TaskComment).createdAt === "number",
      ),
    );
  } catch {
    return [];
  }
}

function filteredArchiveRecords(archive: ArchiveState): GlobalArchiveRecord[] {
  const query = archive.searchQuery.trim().toLowerCase();
  return archive.records.filter((record) => {
    if (archive.instanceFilter && record.source_instance_name !== archive.instanceFilter) return false;
    if (archive.laneFilter && record.column_name !== archive.laneFilter) return false;
    if (!query) return true;
    return [record.title, record.description, record.agent ?? "", record.source_instance_name ?? "", record.column_name, record.final_session_output ?? "", record.comments ?? ""]
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
      ...copy.body.map((line) => ui.Text({ content: line, fg: COLORS.text, wrapMode: "word", height: wrappedTextHeight(line, 6) })),
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
      state.workspaceGateInput,
      true,
      "Type a path, e.g. ~/code/my-project",
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

// Filter mode is global, so the picker lives in the Details panel instead of
// replacing one board lane's card list.
function renderDetailsFilterPicker(ui: OpenTui, state: TuiState, mode: NonNullable<TuiState["filterMode"]>) {
  const items = mode.step === "category"
    ? boardFilterCategories().map((category) => category.label)
    : boardFilterOptions(state.tasks, mode.category as BoardFilterKind);

  return ui.Box(
    {
      flexGrow: 1,
      flexDirection: "column",
      ...boxBg(COLORS.panel),
      gap: 1,
    },
    ui.Text({
      content: "Global Filter",
      fg: COLORS.text,
      attributes: ui.TextAttributes.BOLD,
      height: 1,
      truncate: true,
    }),
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
  valueParts?: MetaValuePart[];
}

interface MetaValuePart {
  content: string;
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
    label: isAcpHarness(task.harness) ? "HARNESS" : "AGENT",
    value: isAcpHarness(task.harness) ? harnessDisplayName(task.harness) : task.agent ?? "agent",
    color: COLORS.muted,
  };
  const model: MetaRow = {
    label: "MODEL",
    value: isAcpHarness(task.harness) ? task.model?.id ?? "default" : modelLabel(task.model ?? undefined),
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
  if (isAcpHarness(task.harness)) {
    return [{ label: "MODE", value: task.permissionMode ?? task.claudePermissionMode ?? DEFAULT_ACP_PERMISSION_MODE, color: COLORS.muted }, model];
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
  const resolvedValueColor = valueColor ?? (done ? COLORS.dim : meta.color);
  return ui.Box(
    { width: "100%", height: 1, flexDirection: "row" },
    ui.Text({ content: meta.label, fg: COLORS.dim, width: labelWidth, height: 1 }),
    // minWidth:0 lets the value shrink inside the row instead of overflowing the
    // card's right border when the path/branch is longer than the lane is wide.
    meta.valueParts && !done
      ? renderInlineMetaValue(ui, meta.valueParts, resolvedValueColor)
      : ui.Text({
          content: meta.value,
          fg: resolvedValueColor,
          flexGrow: 1,
          flexShrink: 1,
          minWidth: 0,
          height: 1,
          truncate: true,
        }),
  );
}

function renderInlineMetaValue(ui: OpenTui, parts: MetaValuePart[], fallbackColor: TuiColor) {
  return ui.Box(
    { flexGrow: 1, flexShrink: 1, minWidth: 0, height: 1, flexDirection: "row" },
    ...parts.map((part) => ui.Text({
      content: part.content,
      fg: part.color ?? fallbackColor,
      height: 1,
      flexShrink: 0,
      truncate: true,
    })),
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
    state.filterMode
      ? renderDetailsFilterPicker(ui, state, state.filterMode)
      : state.instanceSwitcher
        ? renderInstanceSwitcherPanel(ui, state)
        : state.newTask
          ? renderInlineNewTask(ui, state)
          : task
            ? renderTaskDetails(ui, state, task)
            : renderEmptyDetails(ui),
  );
}

function selectedPanelWidth(terminalCols: number): number {
  const extra = Math.max(0, terminalCols - SIDEBAR_GROWTH_START_WIDTH);
  return Math.min(SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH + Math.floor(extra / 2));
}

function selectedDetailRows(state: TuiState, task: Task): MetaRow[] {
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
          { label: isAcpHarness(task.harness) ? "HARNESS" : "AGENT", value: isAcpHarness(task.harness) ? harnessDisplayName(task.harness) : agentLabel(task, state.agents), color: COLORS.text },
          ...(isAcpHarness(task.harness)
            ? [
                { label: "MODE", value: task.permissionMode ?? task.claudePermissionMode ?? DEFAULT_ACP_PERMISSION_MODE, color: COLORS.text },
                ...acpOptionRows(state.acpConfig, task.harness, task.acpOptions),
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
  const diffStatRow = reviewDiffStatRow(state, task);
  if (diffStatRow) rows.push(diffStatRow);
  rows.push({ label: "TASK ID", value: task.id, color: COLORS.text });
  return rows;
}

function renderTaskDetails(ui: OpenTui, state: TuiState, task: Task) {
  const rows = selectedDetailRows(state, task);
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
  const modeRows = rows.filter((row) => row.label !== "DIFF").length;
  const mode = sidebarDetailMode(laneInnerHeight(state.terminalRows), modeRows, false);
  return mode === "expanded"
    ? renderExpandedDetails(ui, task, rows)
    : renderCompactDetails(ui, task, rows);
}

function reviewDiffStatRow(state: TuiState, task: Task): MetaRow | undefined {
  if (!canOpenDiffView(task)) return undefined;
  const cache = isSameReviewDiffStatIdentity(state.reviewDiffStat, task) ? state.reviewDiffStat : undefined;
  if (!cache || cache.status === "loading") return { label: "DIFF", value: "loading...", color: COLORS.muted };
  const commitStatus = reviewCommitStatusForTask(state, task);
  if (
    cache.status === "success" &&
    commitStatus &&
    commitStatus.committedFiles.length > 0 &&
    commitStatus.uncommittedFiles.length === 0
  ) {
    const fileWord = commitStatus.committedFiles.length === 1 ? "file" : "files";
    return {
      label: "DIFF",
      value: `${commitStatus.committedFiles.length} ${fileWord} · committed ›`,
      color: COLORS.muted,
    };
  }
  return {
    label: "DIFF",
    value: cache.label,
    color: cache.status === "success" ? COLORS.accentBright : COLORS.muted,
    ...(cache.status === "success" ? { valueParts: diffStatValueParts(cache.label) } : {}),
  };
}

function diffStatValueParts(label: string): MetaValuePart[] | undefined {
  const match = /^(.*?)(\+\d+)(\s+)(-\d+)(.*)$/.exec(label);
  if (!match) return undefined;
  const [, prefix, additions, spacer, deletions, suffix] = match;
  return [
    ...(prefix ? [{ content: prefix, color: COLORS.text }] : []),
    { content: additions, color: COLORS.diffAdd },
    { content: spacer, color: COLORS.text },
    { content: deletions, color: COLORS.diffDelete },
    ...(suffix ? [{ content: suffix, color: COLORS.text }] : []),
  ];
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

const BOARD_DETAIL_TABS = ["prompt", "handoff", "output", "files", "comments"] as const satisfies readonly TaskDetailTab[];
const DETAIL_TAB_LABELS: Record<TaskDetailTab, string> = {
  prompt: "Prompt",
  handoff: "Handoff",
  output: "Output",
  files: "Files",
  comments: "Comments",
};

function nextDetailTab(tab: TaskDetailTab, delta: number, tabs: readonly TaskDetailTab[] = BOARD_DETAIL_TABS): TaskDetailTab {
  const index = Math.max(0, tabs.indexOf(tab));
  return tabs[(index + delta + tabs.length) % tabs.length];
}

function boardDetailScrollId(tab: TaskDetailTab, taskId: string): string | undefined {
  switch (tab) {
    case "prompt":
      return `board-detail-prompt-${taskId}`;
    case "handoff":
      return `board-detail-handoff-${taskId}`;
    case "output":
      return `board-detail-output-${taskId}`;
    case "files":
      return `board-detail-files-${taskId}`;
    case "comments":
      return undefined;
  }
}

function boardDetailScrollMax(state: TuiState, task: Task, tab: TaskDetailTab): number {
  const approxWidth = Math.max(20, selectedPanelWidth(state.terminalCols) - 4);
  const wrappedRows = (text: string) => text
    .split("\n")
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(Math.max(1, line.length) / approxWidth)), 0);
  const contentRows = tab === "prompt"
    ? wrappedRows(task.description || "(empty prompt)")
    : tab === "handoff"
      ? task.completion
        ? wrappedRows(`${task.completion.summary}\n${task.completion.changedFiles.join(", ") || "none"}\n${task.completion.verification.map((item) => `${item.command} → ${item.result}`).join("; ") || "none"}\n${task.completion.residualRisk ?? "none"}`)
        : 1
      : tab === "output"
        ? wrappedRows(task.finalSessionOutput?.trim() || "No final session output available")
        : tab === "files"
          ? filesTabScrollRows(state, task)
          : 0;
  // Keyboard scroll happens before OpenTUI reports the real viewport/content heights.
  // Clamp to a conservative content-derived cap so held arrows cannot grow forever;
  // renderDetailViewport's mouse-wheel path still applies the exact visual clamp.
  return contentRows > 0 ? Math.max(DETAIL_SCROLL_STEP_ROWS, contentRows) : 0;
}

function archiveDetailScrollId(tab: TaskDetailTab, taskId: string): string | undefined {
  switch (tab) {
    case "prompt":
      return `archive-detail-prompt-${taskId}`;
    case "handoff":
      return `archive-detail-handoff-${taskId}`;
    case "output":
      return `archive-detail-output-${taskId}`;
    case "files":
      return `archive-detail-files-${taskId}`;
    case "comments":
      return `archive-detail-comments-${taskId}`;
  }
}

function archiveDetailScrollMax(state: TuiState, record: GlobalArchiveRecord, tab: TaskDetailTab): number {
  const approxWidth = Math.max(20, Math.floor(state.terminalCols / 2) - 4);
  const wrappedRows = (text: string) =>
    text
      .split("\n")
      .reduce((sum, line) => sum + Math.max(1, Math.ceil(Math.max(1, line.length) / approxWidth)), 0);
  const completion = parseCompletion(record.completion);
  const contentRows = tab === "prompt"
    ? wrappedRows(record.description || "(empty prompt)")
    : tab === "handoff"
      ? completion
        ? wrappedRows(`${completion.summary}\n${completion.changedFiles.join(", ") || "none"}\n${completion.verification.map((item) => `${item.command} → ${item.result}`).join("; ") || "none"}\n${completion.residualRisk ?? "none"}`)
        : 1
      : tab === "output"
        ? wrappedRows(record.final_session_output?.trim() || "No final session output available")
        : tab === "comments"
          ? (parseArchiveComments(record.comments).length || 1)
          : 0;
  return contentRows > 0 ? Math.max(DETAIL_SCROLL_STEP_ROWS, contentRows) : 0;
}

function renderInlineTaskDetail(ui: OpenTui, state: TuiState, task: Task, rows: MetaRow[]) {
  const tab = state.detailTab ?? "prompt";
  const content: VChild =
    tab === "prompt"
      ? renderScrollableDetailText(ui, state, `board-detail-prompt-${task.id}`, task.description || "(empty prompt)")
      : tab === "handoff"
        ? renderHandoffTab(ui, state, task.completion ?? null, `board-detail-handoff-${task.id}`)
        : tab === "output"
          ? renderOutputTab(ui, state, task)
          : tab === "files"
            ? renderFilesTab(ui, state, task)
            : renderCommentsTab(ui, state, task);
  const inlineRows = rows.filter((row) => ["STATE", "TASK ID", "TYPE", "LANE", "AGENT", "ASSIGNED TO", "ACCEPTED BY", "DIFF"].includes(row.label));
  const footer = tab === "comments"
    ? (state.commentDraft ? "enter submit · esc cancel" : "esc details · ←/→ tabs · c comment · r reply")
    : tab === "files"
      ? filesTabFooter(state, task)
    : "↑/↓ scroll · esc details · ←/→ tabs · m move card";

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
      ...BOARD_DETAIL_TABS.map((candidate) =>
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

function boardFilesVisibleRows(state: TuiState, inlineRowsCount: number): number {
  const fixedRows =
    2 + // title
    1 + // gap after title
    inlineRowsCount +
    1 + // gap after inline metadata
    1 + // tab row
    1 + // hairline
    1 + // footer
    3; // conservative panel/border/padding slack
  return Math.max(2, laneInnerHeight(state.terminalRows) - fixedRows);
}

function renderOutputTab(ui: OpenTui, state: TuiState, task: Task) {
  return renderFinalOutputTab(ui, state, `board-detail-output-${task.id}`, task.finalSessionOutput);
}

function renderFinalOutputTab(ui: OpenTui, state: TuiState, scrollId: string, finalSessionOutput: string | null | undefined) {
  const output = finalSessionOutput?.trim();
  return renderScrollableDetailText(
    ui,
    state,
    scrollId,
    output && output.length > 0 ? output : "No final session output available",
  );
}

function filesTabScrollRows(state: TuiState, task: Task): number {
  const cache = isSameReviewDiffStatIdentity(state.reviewDiffStat, task) ? state.reviewDiffStat : undefined;
  if (!cache || cache.status !== "success" || !cache.response || cache.response.kind === "no-git") return 1;
  if (cache.response.files.length === 0) return 1;
  const detail = filesDetailState(state, task.id, cache.response.files.length);
  if (detail.mode === "list") return cache.response.files.length * 2;
  const file = cache.response.files[detail.selectedIndex];
  return Math.max(1, normalizedPatchLines(file?.patch).length + 2);
}

function renderFilesTab(ui: OpenTui, state: TuiState, task: Task) {
  const scrollId = `board-detail-files-${task.id}`;
  if (!canOpenDiffView(task)) {
    return renderDetailViewport(ui, state, scrollId, ui.Text({ content: "Files are only available on Review cards", fg: COLORS.muted, height: 1 }));
  }

  const cache = isSameReviewDiffStatIdentity(state.reviewDiffStat, task) ? state.reviewDiffStat : undefined;
  if (!cache || cache.status === "loading") {
    return renderDetailViewport(ui, state, scrollId, ui.Text({ content: "Loading diff...", fg: COLORS.muted, height: 1 }));
  }
  if (cache.status === "error" || !cache.response) {
    return renderDetailViewport(ui, state, scrollId, ui.Text({ content: "diff unavailable", fg: COLORS.muted, height: 1 }));
  }
  if (cache.response.kind === "no-git") {
    return renderDetailViewport(ui, state, scrollId, ui.Text({ content: cache.response.reason || "No git evidence for this task.", fg: COLORS.muted, wrapMode: "word" }));
  }
  if (cache.response.files.length === 0) {
    return renderDetailViewport(ui, state, scrollId, ui.Text({ content: "No changes.", fg: COLORS.muted, height: 1 }));
  }
  const detail = filesDetailState(state, task.id, cache.response.files.length);
  const selectedFile = cache.response.files[detail.selectedIndex];
  const commitStatus = reviewCommitStatusForTask(state, task);
  if (detail.mode === "patch") {
    return renderDetailViewport(
      ui,
      state,
      scrollId,
      renderChangedFileListRow(ui, selectedFile, true, diffFileCommitState(commitStatus, selectedFile.file)),
      ...renderPatchLines(ui, selectedFile.patch),
    );
  }

  return renderDetailViewport(
    ui,
    state,
    scrollId,
    ...cache.response.files.map((file, index) => renderChangedFileListRow(ui, file, index === detail.selectedIndex, diffFileCommitState(commitStatus, file.file))),
  );
}

function filesTabFooter(state: TuiState, task: Task): string {
  const files = reviewDiffFiles(state, task);
  const detail = filesDetailState(state, task.id, files.length);
  return detail.mode === "patch"
    ? "↑/↓ scroll · c commit · esc files · ←/→ tabs"
    : "↑/↓ files · enter patch · c commit · esc details · ←/→ tabs";
}

function reviewDiffFiles(state: TuiState, task: Task | undefined): Array<{ file: string; additions: number; deletions: number; patch?: string }> {
  const cache = isSameReviewDiffStatIdentity(state.reviewDiffStat, task) ? state.reviewDiffStat : undefined;
  return cache?.status === "success" && cache.response?.kind === "diff" ? cache.response.files : [];
}

function renderChangedFileListRow(ui: OpenTui, file: { file: string; additions: number | null; deletions: number | null }, selected = false, commitState: DiffFileCommitState = undefined): VChild {
  const committed = commitState === "committed";
  return ui.Box(
    { width: "100%", height: 2, flexDirection: "column", gap: 0, flexShrink: 0, ...boxBg(selected ? COLORS.panelRaised : COLORS.panel) },
    ui.Text({ content: `${selected ? "▸ " : "  "}${file.file}`, fg: committed && !selected ? COLORS.dim : COLORS.bright, height: 1, truncate: true }),
    ui.Box(
      { width: "100%", flexDirection: "row", height: 1 },
      committed
        ? ui.Text({ content: "committed", fg: COLORS.dim, height: 1, width: 12, truncate: true })
        : ui.Text({ content: file.additions === null ? "+?" : `+${file.additions}`, fg: COLORS.diffAdd, height: 1, width: 8, truncate: true }),
      committed
        ? ui.Box({ width: 0 })
        : ui.Text({ content: file.deletions === null ? "-?" : `-${file.deletions}`, fg: COLORS.diffDelete, height: 1, width: 8, truncate: true }),
      commitState === "dirty" ? ui.Text({ content: "dirty", fg: COLORS.muted, height: 1, width: 6, truncate: true }) : ui.Box({ width: 0 }),
    ),
  );
}

function renderPatchLines(ui: OpenTui, patch: string | undefined): VChild[] {
  const lines = normalizedPatchLines(patch);
  if (lines.length === 0) return [ui.Text({ content: "(no text diff)", fg: COLORS.muted, height: 1 })];
  return lines.map((line) => ui.Text({
    content: line,
    fg: diffPatchLineColor(line),
    width: "100%",
    minWidth: 0,
    height: 1,
    truncate: true,
  }));
}

function normalizedPatchLines(patch: string | undefined): string[] {
  if (!patch) return [];
  return patch.split("\n").filter((line, index, lines) => index < lines.length - 1 || line.length > 0);
}

function diffPatchLineColor(line: string): TuiColor {
  if (line.startsWith("+") && !line.startsWith("+++")) return COLORS.diffAdd;
  if (line.startsWith("-") && !line.startsWith("---")) return COLORS.diffDelete;
  if (line.startsWith("@@")) return COLORS.accentBright;
  return COLORS.muted;
}

function archiveFilesOwnerId(taskId: string): string {
  return `archive:${taskId}`;
}

function filesDetailState(state: TuiState, ownerId: string, fileCount: number): FilesDetailState {
  const current = state.filesDetail?.ownerId === ownerId
    ? state.filesDetail
    : { ownerId, selectedIndex: 0, mode: "list" as const };
  return {
    ownerId,
    selectedIndex: clampIndex(current.selectedIndex, Math.max(1, fileCount)),
    mode: current.mode,
  };
}

function setFilesDetailState(state: TuiState, detail: FilesDetailState): void {
  state.filesDetail = detail;
}

function moveFilesSelection(state: TuiState, ownerId: string, fileCount: number, delta: number, scrollId: string, visibleRows: number): void {
  const current = filesDetailState(state, ownerId, fileCount);
  const selectedIndex = clampIndex(current.selectedIndex + delta, fileCount);
  setFilesDetailState(state, { ownerId, selectedIndex, mode: "list" });
  state.detailScrollTop[scrollId] = filesListScrollForSelection(
    selectedIndex,
    fileCount,
    detailScrollOffset(state, scrollId),
    visibleRows,
  );
}

function filesListScrollForSelection(selectedIndex: number, fileCount: number, currentScrollTop: number, visibleRows: number): number {
  const rowStart = selectedIndex * 2;
  const rowEnd = rowStart + 1;
  const contentRows = Math.max(0, fileCount * 2);
  const viewportRows = Math.max(2, Math.trunc(visibleRows));
  const maxScroll = Math.max(0, contentRows - viewportRows);
  let next = clampDetailScrollOffset(currentScrollTop, maxScroll);
  if (rowStart < next) next = rowStart;
  else if (rowEnd >= next + viewportRows) next = rowEnd - viewportRows + 1;
  return clampDetailScrollOffset(next, maxScroll);
}

function openFilesPatch(state: TuiState, ownerId: string, fileCount: number, scrollId: string): void {
  const current = filesDetailState(state, ownerId, fileCount);
  setFilesDetailState(state, { ownerId, selectedIndex: current.selectedIndex, mode: "patch" });
  state.detailScrollTop[scrollId] = 0;
}

function closeFilesPatch(state: TuiState, ownerId: string, fileCount: number, scrollId: string): boolean {
  const current = filesDetailState(state, ownerId, fileCount);
  if (current.mode !== "patch") return false;
  setFilesDetailState(state, { ownerId, selectedIndex: current.selectedIndex, mode: "list" });
  state.detailScrollTop[scrollId] = Math.max(0, current.selectedIndex * 2);
  return true;
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
    renderDetailViewport(ui, state, `board-detail-comments-${task.id}`, ...rows),
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

function renderPendingConfirmationDetail(ui: OpenTui, state: TuiState, task: Task, action: ConfirmableAction) {
  if (action === "integrate" && state.integrateCommitReview?.taskId === task.id) {
    return renderIntegrateCommitConfirmation(ui, task, state.integrateCommitReview.status);
  }

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
    ...copy.body.map((line) => ui.Text({ content: line, fg: COLORS.text, wrapMode: "word", height: wrappedTextHeight(line, 6) })),
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

function renderIntegrateCommitConfirmation(ui: OpenTui, task: Task, status: WorktreeCommitStatus) {
  const committed = status.committedFiles.length > 0 ? status.committedFiles : ["(none yet)"];
  const uncommitted = status.uncommittedFiles.length > 0 ? status.uncommittedFiles : ["(none)"];
  const maxListRows = 6;

  return ui.Box(
    {
      flexGrow: 1,
      flexDirection: "column",
      gap: 1,
      ...boxBg(COLORS.panel),
    },
    ui.Text({ content: "Commit remaining files and integrate?", fg: COLORS.text, attributes: ui.TextAttributes.BOLD, height: 1, truncate: true }),
    ui.Text({ content: task.title, fg: COLORS.bright, height: 2, wrapMode: "word" }),
    ui.Text({ content: HAIRLINE, fg: COLORS.hairline, height: 1, truncate: true }),
    ui.Text({ content: "Already committed on task branch", fg: COLORS.dim, height: 1, truncate: true }),
    ...committed.slice(0, maxListRows).map((file) => ui.Text({ content: `  ${file}`, fg: COLORS.text, height: 1, truncate: true })),
    ...(committed.length > maxListRows ? [ui.Text({ content: `  ...${committed.length - maxListRows} more`, fg: COLORS.muted, height: 1, truncate: true })] : []),
    ui.Text({ content: "Remaining uncommitted files", fg: COLORS.dim, height: 1, truncate: true }),
    ...uncommitted.slice(0, maxListRows).map((file) => ui.Text({ content: `  ${file}`, fg: COLORS.bright, height: 1, truncate: true })),
    ...(uncommitted.length > maxListRows ? [ui.Text({ content: `  ...${uncommitted.length - maxListRows} more`, fg: COLORS.muted, height: 1, truncate: true })] : []),
    ui.Box({ flexGrow: 1 }),
    ui.Text({ content: "Press i again to commit remaining files and integrate.", fg: COLORS.accentBright, height: 1, truncate: true }),
    ui.Text({ content: "esc cancel · worktree stays intact", fg: COLORS.dim, height: 1, truncate: true }),
  );
}

function renderExpandedDetails(ui: OpenTui, task: Task, rows: MetaRow[]) {
  const details: VChild[] = rows.map((row) => renderDetail(ui, row.label, row.value, COLORS.bright, row.valueParts));

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
    ...renderDetailHints(ui, task),
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
    ...renderDetailHints(ui, task),
  );
}

type SelectedCardAction =
  | "run"
  | "edit"
  | "retry"
  | "abort"
  | "view-diff"
  | "integrate"
  | "discard-worktree"
  | "done"
  | "archive"
  | "delete"
  | "move"
  | "details";

interface SelectedCardShortcut {
  action: SelectedCardAction;
  key: string;
  label: string;
}

const SELECTED_CARD_SHORTCUTS: Record<SelectedCardAction, SelectedCardShortcut> = {
  run: { action: "run", key: "r", label: "run" },
  edit: { action: "edit", key: "e", label: "edit" },
  retry: { action: "retry", key: "R", label: "retry" },
  abort: { action: "abort", key: "k", label: "abort" },
  "view-diff": { action: "view-diff", key: "v", label: "diff" },
  integrate: { action: "integrate", key: "i", label: "integrate" },
  "discard-worktree": { action: "discard-worktree", key: "D", label: "discard" },
  done: { action: "done", key: "x", label: "done" },
  archive: { action: "archive", key: "a", label: "archive" },
  delete: { action: "delete", key: "d", label: "delete" },
  move: { action: "move", key: "m", label: "move" },
  details: { action: "details", key: "↵", label: "details" },
};

function selectedCardShortcuts(task: Task): SelectedCardShortcut[] {
  if (task.column === "done") {
    return shortcutList("archive", "delete", "move", "details");
  }

  if (task.runState === "error") {
    return shortcutList("retry", "delete", "move", "details");
  }

  if (task.column === "in_progress" || task.runState === "running") {
    return shortcutList("abort", "move", "details");
  }

  if (task.column === "todo") {
    return task.type === "manual"
      ? shortcutList("edit", "delete", "move", "details")
      : shortcutList("run", "edit", "delete", "move", "details");
  }

  if (task.column === "review") {
    const actions: SelectedCardAction[] = ["view-diff"];
    if (task.pending === "rebase-conflict") actions.push("retry");
    actions.push("integrate");
    if (task.worktreePath) actions.push("discard-worktree");
    actions.push("done", "delete", "move", "details");
    return shortcutList(...actions);
  }

  return shortcutList("details");
}

function shortcutList(...actions: SelectedCardAction[]): SelectedCardShortcut[] {
  return actions.map((action) => SELECTED_CARD_SHORTCUTS[action]);
}

function hasSelectedCardAction(task: Task | undefined, action: SelectedCardAction): boolean {
  return Boolean(task && selectedCardShortcuts(task).some((shortcut) => shortcut.action === action));
}

function canUseSelectedCardAction(state: TuiState, actions: Pick<TuiActions, "render">, action: SelectedCardAction): boolean {
  const task = selectedTask(state);
  if (hasSelectedCardAction(task, action)) return true;

  state.error = undefined;
  clearPendingConfirmation(state);
  state.status = selectedCardActionUnavailableMessage(action, task);
  actions.render();
  return false;
}

function selectedCardActionUnavailableMessage(action: SelectedCardAction, task: Task | undefined): string {
  if (!task) return "no task selected";
  if (action === "run" && task.type === "manual") {
    return "manual cards are not runnable; convert to an agent card first";
  }
  switch (action) {
    case "run":
      return "run is only available for To Do agent cards";
    case "edit":
      return "edit is only available for To Do cards";
    case "retry":
      return "retry is only available for error cards or rebase-conflict Review cards";
    case "abort":
      return "abort is only available for In Progress cards";
    case "view-diff":
      return "diff view is only available for Review cards";
    case "integrate":
      return "integrate is only available for Review cards";
    case "discard-worktree":
      return "discard is only available for Review cards with worktrees";
    case "done":
      return "done is only available for Review cards";
    case "archive":
      return "archive is only available for Done cards";
    case "delete":
      return "delete is only available for To Do, Error, Review, or Done cards";
    case "move":
      return "move requires a selected card";
    case "details":
      return "details require a selected card";
  }
}

function renderDetailHints(ui: OpenTui, task: Task): VChild[] {
  const shortcuts = selectedCardShortcuts(task);
  const midpoint = Math.ceil(shortcuts.length / 2);
  const lines = [
    shortcuts.slice(0, midpoint),
    shortcuts.slice(midpoint),
  ]
    .filter((line) => line.length > 0)
    .map((line) => line.map((shortcut) => `${shortcut.key} ${shortcut.label}`).join(" · "));

  return lines.map((line) =>
    ui.Text({ content: line, fg: COLORS.muted, height: 1, truncate: true }),
  );
}

function inlineErrorMode(terminalRows: number): "compact" | "full" {
  return terminalRows <= 34 ? "compact" : "full";
}

/**
 * Estimated word-wrapped line count for a text node at the sidebar's usual
 * text width, clamped to `maxRows` so one long field can't crowd out the
 * rest of a fixed-height panel. A fixed `height: 2` regardless of actual
 * content length was the bug — long lines (e.g. "Residual risk: ...")
 * silently clipped mid-sentence even though there was room to grow.
 */
function wrappedTextHeight(text: string, maxRows: number, columns = TEXT_INPUT_COLUMNS): number {
  return Math.min(maxRows, Math.max(1, Math.ceil(text.length / columns)));
}

function renderErrorBox(ui: OpenTui, error: string, mode: "compact" | "full" = "full") {
  const errorRows = wrappedTextHeight(error, 3);
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

function renderInstanceSwitcherPanel(ui: OpenTui, state: TuiState) {
  const switcher = state.instanceSwitcher;
  if (!switcher) return renderEmptyDetails(ui);

  const rows: VChild[] = [];
  for (let i = 0; i < state.instanceList.length; i++) {
    const item = state.instanceList[i];
    const selected = i === switcher.selectedIndex;
    const isCurrent = item.runtime.boardUrl === state.boardUrl;
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

    rows.push(
      ui.Box(
        {
          width: "100%",
          height: 1,
          flexDirection: "row",
          ...boxBg(selected ? COLORS.panelRaised : COLORS.panel),
        },
        ui.Text({
          content: line,
          fg: selected ? COLORS.bright : isCurrent ? COLORS.accentBright : COLORS.text,
          height: 1,
          truncate: true,
        }),
      ),
    );
  }

  return ui.Box(
    {
      flexGrow: 1,
      flexDirection: "column",
      gap: 1,
      ...boxBg(COLORS.panel),
    },
    ui.Text({
      content: "Switch Instance",
      fg: COLORS.text,
      attributes: ui.TextAttributes.BOLD,
      height: 1,
      truncate: true,
    }),
    ui.Text({ content: HAIRLINE, fg: COLORS.hairline, height: 1, truncate: true }),
    ...rows,
    ui.Text({ content: HAIRLINE, fg: COLORS.hairline, height: 1, truncate: true }),
    ui.Text({
      content: "↑/↓ navigate · enter select · s start/stop · esc/b back",
      fg: COLORS.dim,
      height: 1,
      truncate: true,
    }),
  );
}

function renderDetail(ui: OpenTui, label: string, value: string, valueColor: TuiColor = COLORS.text, valueParts?: MetaValuePart[]) {
  return ui.Box(
    { width: "100%", flexDirection: "column", gap: 0 },
    ui.Text({ content: label, fg: COLORS.dim, height: 1 }),
    valueParts ? renderInlineMetaValue(ui, valueParts, valueColor) : ui.Text({ content: value, fg: valueColor, height: 1, truncate: true }),
  );
}

function renderCommandStrip(ui: OpenTui, state: TuiState) {
  const showBoardSummary = state.viewState.view !== "board";
  const boardKeyHints = state.detailTab
    ? state.detailTab === "comments"
      ? "↑/↓ comments · ←/→ tabs · ↵ close details · c comment · r reply · esc close · q quit"
      : "↑/↓ scroll detail · ←/→ tabs · ↵ close details · m move · esc close · q quit"
    : "↑/↓ cards · ←/→ lanes · b switch board · n new task · f filter · u refresh · ? help · q quit · A global archive";

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
      content: commandStripStatus(state),
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
            ? state.archive?.focused
              ? "↑/↓ scroll detail · ←/→ tabs · e collapse · ↵ esc back to records · u refresh · b back · q quit"
              : "↑/↓ records · ↵ focus detail · e expand · ←/→ tabs · / search · i instance · l lane · u refresh · b back · q quit"
            : state.viewState.view === "workspaceGate"
            ? "type absolute path · enter confirm · esc quit"
            : state.viewState.view === "launch"
            ? "↑/↓ instances · ↵ launch board · e rename · n add board · s stop · d remove · q quit · A global archive"
            : state.viewState.view === "diff"
            ? diffViewKeyHints(state.diffView)
            : boardKeyHints,
        fg: COLORS.text,
        height: 1,
        flexGrow: 1,
        truncate: true,
      }),
      ...(showBoardSummary
        ? [
            ui.Text({
              content: `${state.tasks.length} task${state.tasks.length === 1 ? "" : "s"} · last refresh ${state.lastRefresh ? formatClock(state.lastRefresh) : "never"}`,
              fg: state.error ? COLORS.bright : COLORS.muted,
              height: 1,
              width: 36,
              truncate: true,
            }),
          ]
        : []),
    ),
  );
}

function commandStripStatus(state: TuiState): string {
  if (state.error) return state.error;
  if (state.viewState.view === "board") {
    const taskSummary = `${state.tasks.length} task${state.tasks.length === 1 ? "" : "s"}`;
    if (state.status === taskSummary || state.status === "board is empty") return "";
  }
  return state.status;
}

function renderHelpOverlay(ui: OpenTui) {
  const rows = [
    ["↑/↓", "move between cards"],
    ["←/→", "jump between lanes"],
    ["enter", "open Prompt/Handoff/Output/Comments"],
    ["↑/↓", "scroll open detail tabs"],
    ["←/→/tab", "switch detail tabs"],
    ["c / r", "comment / reply (Comments tab)"],
    ["e", "edit selected To Do card"],
    ["f", "filter selected lane (again to clear)"],
    ["r", "run selected task"],
    ["R", "retry failed run"],
    ["a", "archive task"],
    ["A", "global archive browser"],
    ["d", "delete selected card"],
    ["D", "discard Review worktree"],
    ["i", "integrate branch"],
    ["x", "move to Done (accepted by User)"],
    ["m", "manual move to lane"],
    ["g", "init git and run"],
    ["n", "new task"],
    ["v", "view diff (Review cards)"],
    ["u", "refresh board"],
    ["b", "switch instances"],
    ["esc", "detach / close overlay"],
    ["q", "quit"],
    ["", ""],
    ["ARCHIVE", ""],
    ["↑/↓", "navigate records / scroll focused detail"],
    ["←/→ / tab", "switch detail tabs"],
    ["enter", "focus / exit detail"],
    ["e", "toggle expanded detail"],
    ["/", "search (enter to exit)"],
    ["i", "cycle instance filter"],
    ["l", "cycle lane filter"],
    ["", ""],
    ["DIFF VIEW", ""],
    ["↑/↓", "select file / scroll when locked"],
    ["enter", "toggle file select / patch scroll"],
    ["←/→", "previous/next hunk"],
    ["m", "mark selected file reviewed"],
    ["t", "toggle split/inline"],
    ["b / esc", "back to board"],
    ["q", "quit"],
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
        height: 45,
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

/** Human-facing step title shown in the wizard header, e.g. "Step 2/5 · HARNESS & MODEL". */
const WIZARD_STEP_LABELS: Record<WizardStep, string> = {
  identity: "IDENTITY",
  harness: "HARNESS & MODEL",
  agentProfile: "AGENT",
  isolation: "ISOLATION",
  dependencies: "DEPENDENCIES",
  confirm: "CONFIRM",
};

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
    renderWizardHeader(ui, draft, isEditing),
    ui.Text({ content: HAIRLINE, fg: COLORS.hairline, height: 1, truncate: true }),
    renderWizardBody(ui, state, draft),
    ui.Text({ content: HAIRLINE, fg: COLORS.hairline, height: 1, truncate: true }),
    renderWizardFooter(ui, draft, isEditing),
  );
}

function renderWizardHeader(ui: OpenTui, draft: NewTaskDraft, isEditing: boolean) {
  const steps = wizardSteps(draft);
  const index = steps.indexOf(draft.step);
  const stepNumber = index === -1 ? 1 : index + 1;
  return ui.Box(
    { width: "100%", flexDirection: "row", height: 1 },
    ui.Text({
      content: isEditing ? "Edit Task" : "New Task",
      fg: COLORS.text,
      attributes: ui.TextAttributes.BOLD,
      height: 1,
      flexGrow: 1,
      truncate: true,
    }),
    ui.Text({
      content: `Step ${stepNumber}/${steps.length} · ${WIZARD_STEP_LABELS[draft.step]}`,
      fg: COLORS.dim,
      height: 1,
      truncate: true,
    }),
  );
}

function renderWizardBody(ui: OpenTui, state: TuiState, draft: NewTaskDraft) {
  switch (draft.step) {
    case "identity":
      return renderIdentityStep(ui, state, draft);
    case "harness":
      return renderHarnessStep(ui, state, draft);
    case "agentProfile":
      return renderAgentProfileStep(ui, state, draft);
    case "isolation":
      return renderIsolationStep(ui, draft);
    case "dependencies":
      return renderDependenciesStep(ui, state, draft);
    case "confirm":
      return renderConfirmStep(ui, state, draft);
  }
}

function renderDraftErrorRow(ui: OpenTui, draft: NewTaskDraft) {
  return draft.error
    ? ui.Text({ content: draft.error, fg: COLORS.bright, wrapMode: "word", height: 2 })
    : ui.Box({ height: 2 });
}

// Step A — CARD TYPE, TITLE, PROMPT/NOTES, [ASSIGNED TO if manual], DIR.
function renderIdentityStep(ui: OpenTui, state: TuiState, draft: NewTaskDraft) {
  return ui.Box(
    { flexGrow: 1, flexDirection: "column", gap: 1, ...boxBg(COLORS.panel) },
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
      ? [renderInputField(ui, "ASSIGNED TO", draft.assignedTo, draft.field === "assignedTo", "Name or role", 1, COLORS.text, draft, "assignedTo")]
      : []),
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
    renderDraftErrorRow(ui, draft),
  );
}

// Step B — HARNESS, then (OpenCode) PROVIDER + MODEL synced to the live
// /api/providers roster, or (Claude Code) the fixed MODEL alias list, unchanged.
function renderHarnessStep(ui: OpenTui, state: TuiState, draft: NewTaskDraft) {
  return ui.Box(
    { flexGrow: 1, flexDirection: "column", gap: 1, ...boxBg(COLORS.panel) },
    renderSelectField(ui, "HARNESS", currentHarnessLabel(draft), draft.field === "harness"),
    ...(draft.harness === "opencode"
      ? [renderSelectField(ui, "PROVIDER", currentProviderLabel(draft, state.providers), draft.field === "provider")]
      : []),
    renderModelField(ui, draft, state.agents, state.providers, state.acpConfig),
    renderDraftErrorRow(ui, draft),
  );
}

/**
 * MODEL renders as a plain select field until it's focused with an active
 * type-to-filter query, at which point it swaps to a two-line search box:
 * the typed query + match count on top, the currently-selected match (or
 * "no matches") below. Locked (unfocusable) while PROVIDER is "Use Agent
 * Profile Default" — currentModelLabel already reads that label in this
 * state, so the plain-select branch below renders it correctly with no
 * special-casing needed here.
 */
function renderModelField(ui: OpenTui, draft: NewTaskDraft, agents: RosterAgent[], providers: RosterProvider[], acpConfig: AcpConfigCatalog) {
  const focused = draft.field === "model";
  if (!focused) {
    return renderSelectField(ui, "MODEL", currentModelLabel(draft), false);
  }

  const query = draft.modelQuery ?? "";
  const matches = filteredModelOptions(draft, agents, providers, acpConfig);
  const selectedLabel =
    matches.length === 0
      ? isAcpHarness(draft.harness) && query
        ? `custom: ${query}`
        : "no matches"
      : draft.model
        ? modelLabel(draft.model)
        : isAcpHarness(draft.harness)
          ? "Provider Default"
          : "type to narrow, ↑/↓ to pick";

  return renderFieldShell(
    ui,
    "MODEL",
    true,
    4,
    ui.Box(
      { flexDirection: "column", height: 2, gap: 0 },
      ui.Box(
        { flexDirection: "row", height: 1 },
        ui.Text({ content: `⌕ ${query}▍`, fg: COLORS.accentBright, flexGrow: 1, height: 1, truncate: true }),
        ui.Text({ content: `${matches.length} match${matches.length === 1 ? "" : "es"}`, fg: COLORS.dim, height: 1, truncate: true }),
      ),
      ui.Text({ content: selectedLabel, fg: matches.length ? COLORS.text : COLORS.dim, height: 1, truncate: true }),
    ),
  );
}

// Step C — execution knobs. OpenCode keeps its live agent picker; ACP harnesses
// expose session/set_mode plus only the selected provider's own option specs.
function renderAgentProfileStep(ui: OpenTui, state: TuiState, draft: NewTaskDraft) {
  const config = acpConfigForHarness(state.acpConfig, draft.harness);
  const modes = config?.modes ?? [];
  const specs = acpOptionSpecs(state.acpConfig, draft.harness);
  return ui.Box(
    { flexGrow: 1, flexDirection: "column", gap: 1, ...boxBg(COLORS.panel) },
    ...(draft.harness === "opencode"
      ? [renderSelectField(ui, "AGENT PROFILE", currentAgentLabel(draft), draft.field === "agent")]
      : modes.length > 0
        ? [renderSelectField(ui, "PERMS", currentPermissionModeLabel(state.acpConfig, draft), draft.field === "permissionMode")]
        : []),
    ...specs.map((spec, index) =>
      renderSelectField(ui, acpConfigLabel(spec), acpConfigValueLabel(spec, draft.acpOptions[spec.id]), draft.field === ACP_OPTION_FIELDS[index]),
    ),
    renderDraftErrorRow(ui, draft),
  );
}

// Step D — ISOLATION (with a live description per option) and, for OpenCode
// only: an automatic/locked note under worktree isolation (the existing
// write-fenced + escape-detector + sandboxed-bash safety stack must never be
// weakened by a per-task override), or an editable allow/ask/deny control
// under in-place isolation, the only mode a permission override ever applies to.
function renderIsolationStep(ui: OpenTui, draft: NewTaskDraft) {
  const editable = draft.harness === "opencode" && draft.isolation === "in-place";
  return ui.Box(
    { flexGrow: 1, flexDirection: "column", gap: 1, ...boxBg(COLORS.panel) },
    renderIsolationField(ui, draft),
    ui.Text({ content: isolationDescription(draft.isolation), fg: COLORS.muted, wrapMode: "word", height: 2 }),
    ...(draft.harness === "opencode" ? [editable ? renderPermissionOverrideControl(ui, draft) : renderLockedPermissionsNote(ui)] : []),
    renderDraftErrorRow(ui, draft),
  );
}

function renderDependenciesStep(ui: OpenTui, state: TuiState, draft: NewTaskDraft) {
  const candidates = dependencyCandidates(state, draft);
  return ui.Box(
    { flexGrow: 1, flexDirection: "column", gap: 1, ...boxBg(COLORS.panel) },
    ui.Text({ content: "Choose zero or more parent tasks that must complete first.", fg: COLORS.muted, wrapMode: "word", height: 2 }),
    renderDependencyField(ui, state, draft),
    ui.Text({ content: candidates.length === 0 ? "No existing tasks available." : "↑/↓ select · space toggle · enter continue", fg: COLORS.dim, height: 1, truncate: true }),
    renderDraftErrorRow(ui, draft),
  );
}

function renderDependencyField(ui: OpenTui, state: TuiState, draft: NewTaskDraft) {
  const candidates = dependencyCandidates(state, draft);
  const selected = new Set(draft.parentIds);
  const selectedIndex = normalizedDependencyIndex(draft, candidates.length);
  const visibleCandidates = dependencyWindow(candidates, selectedIndex, 8);
  const rows = candidates.length === 0
    ? [ui.Text({ content: "No dependencies", fg: COLORS.muted, height: 1, truncate: true })]
    : visibleCandidates.map(({ task, index }) => {
        const active = index === selectedIndex;
        const checked = selected.has(task.id) ? "☑" : "☐";
        return ui.Text({
          content: `${active ? "▸" : " "} ${checked} ${task.title}`,
          fg: active ? COLORS.bright : checked === "☑" ? COLORS.text : COLORS.muted,
          height: 1,
          truncate: true,
        });
      });
  return renderFieldShell(
    ui,
    "PARENTS",
    draft.field === "dependency",
    Math.max(3, rows.length + 2),
    ui.Box({ flexDirection: "column", gap: 0 }, ...rows),
  );
}

function dependencyWindow(candidates: Task[], selectedIndex: number, limit: number): Array<{ task: Task; index: number }> {
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(limit / 2), candidates.length - limit));
  return candidates.slice(start, start + limit).map((task, offset) => ({ task, index: start + offset }));
}

function isolationDescription(mode: TaskIsolationMode): string {
  return mode === "worktree"
    ? "Runs in a dedicated git worktree cut from DIR on a board/<taskId> branch — concurrent agents never share a working tree. Sync (s) and integrate (i) afterward."
    : "Runs directly in DIR — no isolation. Concurrent agents sharing this directory can clobber each other; there is no file locking.";
}

function renderLockedPermissionsNote(ui: OpenTui) {
  return ui.Box(
    { width: "100%", flexDirection: "column", gap: 0 },
    ui.Text({ content: "PERMISSIONS", fg: COLORS.dim, height: 1 }),
    ui.Text({
      content:
        "Automatic for worktree isolation — write-fenced edits, the base-checkout escape detector, and sandboxed bash all apply and are not configurable here. Select ISOLATION \"none\" to set permissions directly.",
      fg: COLORS.muted,
      wrapMode: "word",
      height: 3,
    }),
  );
}

const PERMISSION_OVERRIDE_FIELD_LABELS: Record<PermissionOverrideCategory, string> = {
  edit: "EDIT",
  bash: "BASH",
  webfetch: "WEBFETCH",
};

const PERMISSION_OVERRIDE_FIELD_BY_CATEGORY: Record<PermissionOverrideCategory, NewTaskField> = {
  edit: "permEdit",
  bash: "permBash",
  webfetch: "permWebfetch",
};

function renderPermissionOverrideControl(ui: OpenTui, draft: NewTaskDraft) {
  return ui.Box(
    { width: "100%", flexDirection: "column", gap: 0 },
    ui.Text({ content: "PERMISSIONS", fg: COLORS.dim, height: 1 }),
    ...PERMISSION_OVERRIDE_CATEGORIES.map((category) =>
      renderSelectField(
        ui,
        PERMISSION_OVERRIDE_FIELD_LABELS[category],
        draft.permissionOverrides[category],
        draft.field === PERMISSION_OVERRIDE_FIELD_BY_CATEGORY[category],
      ),
    ),
  );
}

// Step E — read-only summary of every selection. Enter creates/saves the
// card only — it never runs it; `r` (twice) remains the only run path,
// entirely outside this overlay.
// Grouped by which earlier wizard screen each field came from (identity /
// harness+model / agent profile / isolation+permissions) with a gap between
// groups — a flat, ungrouped list of a dozen rows read as one dense,
// undifferentiated block, unlike every field screen before it.
function renderConfirmStep(ui: OpenTui, state: TuiState, draft: NewTaskDraft) {
  return ui.Box(
    { flexGrow: 1, flexDirection: "column", gap: 1, ...boxBg(COLORS.panel) },
    ...confirmSummaryGroups(draft, state).map((group) =>
      ui.Box(
        { flexDirection: "column", gap: 0 },
        ...group.map((row) => renderTaskMeta(ui, row, false, SIDEBAR_META_LABEL_WIDTH, COLORS.text)),
      ),
    ),
    renderDraftErrorRow(ui, draft),
  );
}

function confirmSummaryGroups(draft: NewTaskDraft, state: TuiState): MetaRow[][] {
  const identity: MetaRow[] = [
    { label: "TYPE", value: draft.type === "manual" ? "Manual" : "Agent", color: COLORS.text },
    { label: "TITLE", value: draft.title || "(untitled)", color: COLORS.text },
    { label: draft.type === "manual" ? "NOTES" : "PROMPT", value: draft.description || "(empty)", color: COLORS.text },
    ...(draft.type === "manual" ? [{ label: "ASSIGNED TO", value: draft.assignedTo || "(unassigned)", color: COLORS.text }] : []),
    { label: "DIR", value: shortPath(draft.directory), color: COLORS.text },
  ];

  if (draft.type === "manual") return [identity, dependencySummaryRows(draft, state)];

  const harnessModel: MetaRow[] = [
    { label: "HARNESS", value: currentHarnessLabel(draft), color: COLORS.text },
    ...(draft.harness === "opencode"
      ? [{ label: "PROVIDER", value: currentProviderLabel(draft, state.providers), color: COLORS.text }]
      : []),
    { label: "MODEL", value: currentModelLabel(draft), color: COLORS.text },
  ];

  const agentProfile: MetaRow[] = [
    ...(draft.harness === "opencode"
      ? [{ label: "AGENT PROFILE", value: currentAgentLabel(draft), color: COLORS.text }]
      : (acpConfigForHarness(state.acpConfig, draft.harness)?.modes.length ?? 0) > 0
        ? [{ label: "PERMS", value: currentPermissionModeLabel(state.acpConfig, draft), color: COLORS.text }]
        : []),
    ...acpOptionRows(state.acpConfig, draft.harness, draft.acpOptions),
  ];

  const isolation: MetaRow[] = [
    { label: "ISOLATION", value: draft.isolation === "worktree" ? "Worktree" : "in_place", color: COLORS.text },
    ...(draft.harness === "opencode"
      ? [
          {
            label: "PERMISSIONS",
            value: draft.isolation === "worktree" ? "Automatic (worktree-fenced)" : permissionOverridesSummary(draft),
            color: COLORS.text,
          },
        ]
      : []),
  ];

  return [identity, harnessModel, agentProfile, isolation, dependencySummaryRows(draft, state)];
}

function dependencySummaryRows(draft: NewTaskDraft, state: TuiState): MetaRow[] {
  return [{ label: "PARENTS", value: dependencySummary(draft, state), color: COLORS.text }];
}

function dependencySummary(draft: NewTaskDraft, state: TuiState): string {
  if (draft.parentIds.length === 0) return "None";
  return draft.parentIds
    .map((id) => state.tasks.find((task) => task.id === id)?.title ?? id)
    .join(", ");
}

function permissionOverridesSummary(draft: NewTaskDraft): string {
  const changed = PERMISSION_OVERRIDE_CATEGORIES.filter((category) => draft.permissionOverrides[category] !== "allow");
  if (changed.length === 0) return "Default (allow all)";
  return changed.map((category) => `${category}: ${draft.permissionOverrides[category]}`).join(", ");
}

function acpConfigLabel(option: AcpConfigOption): string {
  return option.name.toUpperCase();
}

function acpConfigValueLabel(option: AcpConfigOption, value: unknown): string {
  if (option.type === "boolean") return value === true ? "on" : "off";
  const raw = typeof value === "string" ? value : typeof option.currentValue === "string" ? option.currentValue : option.options?.[0]?.value ?? "";
  return option.options?.find((item) => item.value === raw)?.name ?? raw;
}

function acpOptionRows(catalog: AcpConfigCatalog, harness: TaskHarness | undefined, options: AcpOptions | null | undefined): MetaRow[] {
  if (!harness || !options) return [];
  return acpOptionSpecs(catalog, harness)
    .filter((spec) => options[spec.id] !== undefined)
    .map((spec) => ({ label: acpConfigLabel(spec), value: acpConfigValueLabel(spec, options[spec.id]), color: COLORS.text }));
}

function currentProviderLabel(draft: NewTaskDraft, providers: RosterProvider[]): string {
  if (!draft.providerId) return AGENT_PROFILE_DEFAULT_LABEL;
  return providers.find((provider) => provider.id === draft.providerId)?.name ?? draft.providerId;
}

function renderWizardFooter(ui: OpenTui, draft: NewTaskDraft, isEditing: boolean) {
  const onConfirm = draft.step === "confirm";
  return ui.Box(
    { width: "100%", flexDirection: "column", gap: 0 },
    ui.Box(
      { width: "100%", flexDirection: "row", height: 1, gap: 1 },
      ...(onConfirm
        ? [
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
          ]
        : []),
      ui.Text({ content: "esc cancel", fg: COLORS.muted, height: 1, flexGrow: 1, truncate: true }),
    ),
    ui.Text({
      content: wizardFooterHint(draft, isEditing),
      fg: COLORS.dim,
      height: 1,
      truncate: true,
    }),
  );
}

function wizardFooterHint(draft: NewTaskDraft, isEditing: boolean): string {
  const steps = wizardSteps(draft);
  const isFirst = steps.indexOf(draft.step) === 0;
  if (draft.step === "confirm") {
    return `${isFirst ? "" : "b back · "}enter ${isEditing ? "save" : "create"}`;
  }
  if (draft.field === "model") {
    if (isAcpHarness(draft.harness)) return "type to filter or custom id · ↑/↓ pick ACP model · tab next field · enter continue";
    // 'b' types a literal "b" into the filter query here, not "back" — say so instead of the usual hint.
    return "type to filter · ↑/↓ pick match · tab next field · enter continue";
  }
  return `tab next field · shift+tab previous${isFirst ? "" : " · b back"} · enter continue`;
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
    { label: "in_place", value: "in-place" },
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

  if (state.viewState.view === "diff") {
    await handleDiffViewKey(key, state, actions);
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

  if (state.instanceSwitcher) {
    await handleInstanceSwitcherKey(key, state, actions);
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

  if (state.detailTab === "files") {
    const task = selectedTask(state);
    const files = reviewDiffFiles(state, task);
    const ownerId = task?.id ?? "";
    const scrollId = task ? `board-detail-files-${task.id}` : "";
    const inlineRowsCount = task ? selectedDetailRows(state, task).filter((row) => ["STATE", "TASK ID", "TYPE", "LANE", "AGENT", "ASSIGNED TO", "ACCEPTED BY", "DIFF"].includes(row.label)).length : 0;
    if (isEscapeKey(key)) {
      if (task && closeFilesPatch(state, ownerId, files.length, scrollId)) {
        actions.render();
        return;
      }
      closeInlineDetail(state);
      actions.render();
      return;
    }
    if ((key.name || key.sequence) === "left") {
      state.detailTab = nextDetailTab(state.detailTab, -1);
      actions.render();
      return;
    }
    if ((key.name || key.sequence) === "right" || key.sequence === "\t") {
      state.detailTab = nextDetailTab(state.detailTab, 1);
      if (state.detailTab === "comments") await loadCommentsForTask(state, actions, task);
      actions.render();
      return;
    }
    if (isEnterKey(key)) {
      const detail = filesDetailState(state, ownerId, files.length);
      if (task && files.length > 0 && detail.mode === "list") openFilesPatch(state, ownerId, files.length, scrollId);
      actions.render();
      return;
    }
    if (key.sequence === "c") {
      await commitSelectedFilesTabFile(state, actions);
      return;
    }
    if ((key.name || key.sequence) === "down" || (key.name || key.sequence) === "up") {
      const detail = filesDetailState(state, ownerId, files.length);
      if (task && files.length > 0 && detail.mode === "list") {
        moveFilesSelection(state, ownerId, files.length, (key.name || key.sequence) === "down" ? 1 : -1, scrollId, boardFilesVisibleRows(state, inlineRowsCount));
      } else if (task && scrollId) {
        const delta = (key.name || key.sequence) === "down" ? DETAIL_SCROLL_STEP_ROWS : -DETAIL_SCROLL_STEP_ROWS;
        state.detailScrollTop[scrollId] = clampDetailScrollOffset(
          detailScrollOffset(state, scrollId) + delta,
          boardDetailScrollMax(state, task, state.detailTab),
        );
      }
      actions.render();
      return;
    }
    actions.render();
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
    if ((key.name || key.sequence) === "down" || (key.name || key.sequence) === "up") {
      const task = selectedTask(state);
      const scrollId = task ? boardDetailScrollId(state.detailTab, task.id) : undefined;
      if (scrollId) {
        const delta = (key.name || key.sequence) === "down" ? DETAIL_SCROLL_STEP_ROWS : -DETAIL_SCROLL_STEP_ROWS;
        state.detailScrollTop[scrollId] = clampDetailScrollOffset(
          detailScrollOffset(state, scrollId) + delta,
          task ? boardDetailScrollMax(state, task, state.detailTab) : 0,
        );
      }
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
      if (!canUseSelectedCardAction(state, actions, "run")) return;
      await handleConfirmableCardAction("run", state, actions, (task) => actions.client.runTask(task.id), "run");
      return;
    case "R":
      if (!canUseSelectedCardAction(state, actions, "retry")) return;
      await handleConfirmableCardAction("retry", state, actions, (task) => actions.client.retryTask(task.id), "retry");
      return;
    case "a":
      if (!canUseSelectedCardAction(state, actions, "archive")) return;
      await handleConfirmableCardAction("archive", state, actions, (task) => actions.archiveTask(task.id), "archive");
      return;
    case "A":
      clearPendingConfirmation(state);
      await actions.openArchive();
      return;
    case "d":
      if (!canUseSelectedCardAction(state, actions, "delete")) return;
      await handleConfirmableCardAction(
        "delete",
        state,
        actions,
        (task) => actions.client.deleteTask(task.id),
        "delete",
      );
      return;
    case "D":
      if (!canUseSelectedCardAction(state, actions, "discard-worktree")) return;
      await handleConfirmableCardAction(
        "discard-worktree",
        state,
        actions,
        (task) => actions.client.discardWorktree(task.id),
        "discard worktree",
      );
      return;
    case "v":
      await openDiffViewForSelection(state, actions);
      return;
    case "k":
      if (!canUseSelectedCardAction(state, actions, "abort")) return;
      await handleConfirmableCardAction("abort", state, actions, (task) => actions.client.abortTask(task.id), "abort");
      return;
    case "i":
      if (!canUseSelectedCardAction(state, actions, "integrate")) return;
      await handleIntegrateRequested(state, actions);
      return;
    case "g":
      clearPendingConfirmation(state);
      await actions.runAction("init git and run", (task) => actions.client.initGitAndRun(task.id));
      return;
    case "x":
      if (!canUseSelectedCardAction(state, actions, "done")) return;
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
      closeInlineDetail(state);
      state.moveTargetColumn = undefined;
      state.instanceSwitcher = { selectedIndex: state.instanceList.findIndex((item) => item.runtime.boardUrl === state.boardUrl) };
      if (state.instanceSwitcher.selectedIndex === -1) state.instanceSwitcher.selectedIndex = 0;
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
    // Esc at board level is a no-op — scoped cancellation (detail tabs, filter mode,
    // move target, instance switcher) is handled before reaching this fallthrough.
    return;
  }

  if (isEnterKey(key) && state.selectedTaskId) {
    clearPendingConfirmation(state);
    if (state.detailTab) closeInlineDetail(state);
    else state.detailTab = "prompt";
    void fetchSelectedReviewDiffStat(state, actions.client, actions.render);
    void fetchSelectedReviewCommitStatus(state, actions.client, actions.render);
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
    state.reviewDiffStat = reconcileReviewDiffStatCache(state.reviewDiffStat, selectedTask(state));
    state.reviewCommitStatus = reconcileReviewCommitStatusCache(state.reviewCommitStatus, selectedTask(state));
    state.pendingConfirmation = clearPendingForSelection(state, state.selectedTaskId);
    if (state.integrateCommitReview && state.integrateCommitReview.taskId !== state.selectedTaskId) {
      state.integrateCommitReview = undefined;
    }
    void fetchSelectedReviewDiffStat(state, actions.client, actions.render);
    void fetchSelectedReviewCommitStatus(state, actions.client, actions.render);
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

async function handleIntegrateRequested(state: TuiState, actions: TuiActions): Promise<void> {
  const task = selectedTask(state);
  if (!task) {
    state.status = "no task selected";
    actions.render();
    return;
  }

  if (state.pendingConfirmation?.action === "integrate" && state.pendingConfirmation.taskId === task.id) {
    clearPendingConfirmation(state);
    await actions.runAction("integrate", (selected) =>
      actions.client.integrateTask(selected.id, undefined, { commitRemaining: true }),
    );
    return;
  }

  state.status = "checking worktree files...";
  state.error = undefined;
  actions.render();

  try {
    const status = await actions.client.getTaskCommitStatus(task.id);
    if (status.uncommittedFiles.length === 0) {
      clearPendingConfirmation(state);
      await actions.runAction("integrate", (selected) => actions.client.integrateTask(selected.id));
      return;
    }

    const result = requestConfirmation(state, "integrate", task.id);
    state.pendingConfirmation = result.state.pendingConfirmation;
    state.integrateCommitReview = { taskId: task.id, status };
    state.detailTab = undefined;
    state.moveTargetColumn = undefined;
    state.status = `Integrating "${task.title}"? Press i again to commit remaining files and integrate.`;
    actions.render();
  } catch (error) {
    state.error = errorMessage(error);
    state.status = "integrate preflight failed";
    actions.render();
  }
}

function moveTaskToDone(state: TuiState, actions: TuiActions, task: Task): Promise<unknown> {
  const endOfDone = state.tasks.filter((item) => item.column === "done" && item.id !== task.id).length;
  return actions.client.moveTask(task.id, "done", endOfDone, "User");
}

async function openDiffViewForSelection(state: TuiState, actions: TuiActions): Promise<void> {
  clearPendingConfirmation(state);
  const task = selectedTask(state);
  if (!canOpenDiffView(task)) {
    state.status = "diff view is only available for Review cards";
    actions.render();
    return;
  }

  closeInlineDetail(state);
  state.moveTargetColumn = undefined;
  state.viewState = openDiffView(state.viewState);
  state.diffView = createLoadingDiffViewState(task!);
  actions.render();

  try {
    const response = await actions.client.getTaskDiff(task!.id);
    if (state.diffView?.taskId === task!.id) state.diffView = applyDiffResponse(state.diffView, response);
    await refreshDiffViewCommitStatus(state, actions);
  } catch (error) {
    if (state.diffView?.taskId === task!.id) state.diffView = applyDiffError(state.diffView, errorMessage(error));
  }
  actions.render();
}

async function handleDiffViewKey(key: KeyEvent, state: TuiState, actions: TuiActions): Promise<void> {
  if (key.sequence === "q") {
    actions.shutdown();
    return;
  }

  if (isEscapeKey(key) || key.sequence === "b") {
    state.viewState = closeDiffView(state.viewState);
    state.diffView = undefined;
    actions.render();
    return;
  }

  if (!state.diffView) return;
  const keyName = key.name || key.sequence;
  const patchPaneWidth = diffPatchPaneWidth(state.terminalCols);

  if (isEnterKey(key)) {
    state.diffView = toggleDiffFileSelectionLock(state.diffView);
    // Landing in scroll-lock focuses the selected hunk (top of file when none selected).
    state.detailScrollTop[DIFF_PATCH_SCROLL_ID] = diffPatchScrollTop(state.diffView);
    state.diffScrollIntent = true;
    actions.render();
    return;
  }

  if (keyName === "down") {
    if (state.diffView.fileSelectionLocked) {
      const selectedFile = state.diffView.files[state.diffView.selectedFileIndex];
      const current = state.detailScrollTop[DIFF_PATCH_SCROLL_ID] ?? 0;
      state.detailScrollTop[DIFF_PATCH_SCROLL_ID] = clampFullPatchScrollTop(selectedFile?.patch, current + 1);
      state.diffScrollIntent = true;
      actions.render();
      return;
    }
    state.diffView = moveDiffFileSelection(state.diffView, 1);
    state.detailScrollTop[DIFF_PATCH_SCROLL_ID] = diffPatchScrollTop(state.diffView);
    state.diffScrollIntent = true;
    actions.render();
    return;
  }
  if (keyName === "up") {
    if (state.diffView.fileSelectionLocked) {
      const selectedFile = state.diffView.files[state.diffView.selectedFileIndex];
      const current = state.detailScrollTop[DIFF_PATCH_SCROLL_ID] ?? 0;
      state.detailScrollTop[DIFF_PATCH_SCROLL_ID] = clampFullPatchScrollTop(selectedFile?.patch, current - 1);
      state.diffScrollIntent = true;
      actions.render();
      return;
    }
    state.diffView = moveDiffFileSelection(state.diffView, -1);
    state.detailScrollTop[DIFF_PATCH_SCROLL_ID] = diffPatchScrollTop(state.diffView);
    state.diffScrollIntent = true;
    actions.render();
    return;
  }
  if (keyName === "right" || key.sequence === "\u001b[C") {
    state.diffView = moveDiffHunkSelection(state.diffView, 1);
    state.detailScrollTop[DIFF_PATCH_SCROLL_ID] = diffPatchScrollTop(state.diffView);
    state.diffScrollIntent = true;
    actions.render();
    return;
  }
  if (keyName === "left" || key.sequence === "\u001b[D") {
    state.diffView = moveDiffHunkSelection(state.diffView, -1);
    state.detailScrollTop[DIFF_PATCH_SCROLL_ID] = diffPatchScrollTop(state.diffView);
    state.diffScrollIntent = true;
    actions.render();
    return;
  }
  if (key.sequence === "m") {
    state.diffView = toggleDiffFileReviewed(state.diffView);
    actions.render();
    return;
  }
  if (key.sequence === "c") {
    await commitSelectedDiffViewFile(state, actions);
    return;
  }
  if (key.sequence === "t") {
    state.diffView = toggleDiffViewOverride(state.diffView, patchPaneWidth);
    actions.render();
    return;
  }
  if (key.sequence === "e") {
    await openSelectedFileInEditor(state, actions);
    return;
  }
  if (key.sequence === "r") {
    state.status = "refreshing diff...";
    actions.render();
    await refreshDiffViewAfterEditor(state, actions);
    return;
  }
  if (key.sequence === "?") {
    state.overlay = "help";
    actions.render();
    return;
  }
}

/**
 * `e` in the DiffView: resolve the selected file + hunk line, resolve an editor command from
 * the environment, then either suspend/spawn/resume (terminal editors) or spawn detached (GUI
 * editors). Each guard surfaces through the same `state.status` feedback row every other DiffView
 * action uses. Never throws — spawn failures and nonzero exits become status messages, and the
 * renderer is always resumed via try/finally around the terminal-editor path.
 */
/**
 * Env for editor resolution. The renderer runs under npm exec, which injects
 * EDITOR=vi; the launcher snapshots the user's real EDITOR/VISUAL into
 * OPENBOARD_USER_* before npm can touch them. When those sentinels exist,
 * they win over the (possibly npm-faked) direct vars — empty string means the
 * user has none set, which resolution already treats as unset.
 */
export function editorResolutionEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  if (env.OPENBOARD_USER_EDITOR === undefined && env.OPENBOARD_USER_VISUAL === undefined) return env;
  return { ...env, EDITOR: env.OPENBOARD_USER_EDITOR, VISUAL: env.OPENBOARD_USER_VISUAL };
}

async function openSelectedFileInEditor(state: TuiState, actions: TuiActions): Promise<void> {
  if (!isLocalBoardUrl(state.boardUrl)) {
    state.status = "editor needs a local board";
    actions.render();
    return;
  }

  const diffView = state.diffView;
  if (!diffView || diffView.kind !== "diff" || !diffView.root) {
    state.status = "diff has no local root to open";
    actions.render();
    return;
  }

  // `detailScrollTop` is now a whole-patch scroll row; `editorTargetForSelection` still wants a
  // per-hunk body offset, so convert against the selected hunk. Only meaningful in scroll-lock
  // (file-nav mode ignores liveScrollTop and jumps to the hunk's own start line).
  const selectedFileForJump = diffView.files[diffView.selectedFileIndex];
  const selectedHunkIndex = diffView.selectedHunk?.fileIndex === diffView.selectedFileIndex
    ? diffView.selectedHunk.hunkIndex
    : 0;
  const liveScrollTop = diffView.fileSelectionLocked
    ? fullPatchHunkBodyOffset(
        selectedFileForJump?.patch,
        selectedHunkIndex,
        state.detailScrollTop[DIFF_PATCH_SCROLL_ID] ?? 0,
      )
    : undefined;
  const target = editorTargetForSelection(diffView, liveScrollTop);
  if (!target.ok) {
    state.status = target.reason;
    actions.render();
    return;
  }

  const root = diffView.root;
  const resolution = resolveEditorCommand(editorResolutionEnv(process.env), {
    file: isAbsolute(target.relPath) ? target.relPath : join(root, target.relPath),
    line: target.line,
  });
  if (!resolution.ok) {
    state.status = resolution.error;
    actions.render();
    return;
  }

  await launchEditorCommand(resolution.command, root, state, actions);
}

async function commitSelectedDiffViewFile(state: TuiState, actions: TuiActions): Promise<void> {
  const diffView = state.diffView;
  if (!diffView || diffView.kind !== "diff") {
    state.status = "no diff file selected";
    actions.render();
    return;
  }
  const file = diffView.files[diffView.selectedFileIndex]?.file;
  if (!file) {
    state.status = "no diff file selected";
    actions.render();
    return;
  }
  await commitTaskFileAndRefresh(state, actions, diffView.taskId, file, "diff");
}

async function commitSelectedFilesTabFile(state: TuiState, actions: TuiActions): Promise<void> {
  const task = selectedTask(state);
  const files = reviewDiffFiles(state, task);
  if (!task || files.length === 0) {
    state.status = "no file selected";
    actions.render();
    return;
  }
  const detail = filesDetailState(state, task.id, files.length);
  const file = files[detail.selectedIndex]?.file;
  if (!file) {
    state.status = "no file selected";
    actions.render();
    return;
  }
  await commitTaskFileAndRefresh(state, actions, task.id, file, "files");
}

async function commitTaskFileAndRefresh(
  state: TuiState,
  actions: TuiActions,
  taskId: string,
  file: string,
  source: "diff" | "files",
): Promise<void> {
  state.status = `committing ${file}...`;
  state.error = undefined;
  actions.render();

  try {
    const outcome = await actions.client.commitTaskFile(taskId, file);
    if (!outcome.ok) {
      state.status = outcome.message;
      actions.render();
      return;
    }
    state.status = outcome.commit ? `committed ${file} (${outcome.commit})` : `committed ${file}`;
    state.integrateCommitReview = undefined;
    if (source === "diff") {
      await refreshDiffViewAfterEditor(state, actions);
    } else {
      state.reviewDiffStat = undefined;
      state.reviewCommitStatus = undefined;
      await fetchSelectedReviewDiffStat(state, actions.client, actions.render);
      await fetchSelectedReviewCommitStatus(state, actions.client, actions.render);
    }
  } catch (error) {
    state.error = errorMessage(error);
    state.status = `commit ${file} failed`;
    actions.render();
  }
}

async function launchEditorCommand(
  command: EditorCommand,
  root: string,
  state: TuiState,
  actions: TuiActions,
): Promise<void> {
  if (command.kind === "gui") {
    // Status is set before the spawn so the async error callback (missing
    // binary → ENOENT) is never clobbered by the optimistic "opened" message.
    state.status = `opened ${command.argv[0]}`;
    actions.editorSpawner.spawnGuiEditor(command.argv, root, (error) => {
      state.status = `editor failed to launch: ${errorMessage(error)}`;
      actions.render();
    });
    actions.render();
    await refreshDiffViewAfterEditor(state, actions);
    return;
  }

  try {
    const result = await actions.editorSpawner.runTerminalEditor(command.argv, root);
    state.status = result.code === 0 || result.code === null
      ? `editor closed: ${command.argv[0]}`
      : `editor exited with code ${result.code}: ${command.argv[0]}`;
  } catch (error) {
    state.status = `editor failed to launch: ${errorMessage(error)}`;
  }
  actions.render();
  await refreshDiffViewAfterEditor(state, actions);
}

/**
 * Re-fetches the diff after the editor returns and reapplies it, preserving the selected file
 * by path (falling back to a clamped index if it vanished from the refreshed diff) and the
 * current keyboard mode (file-nav vs. locked-scroll).
 */
async function refreshDiffViewAfterEditor(state: TuiState, actions: TuiActions): Promise<void> {
  const diffView = state.diffView;
  if (!diffView) return;

  const selectedFile = diffView.files[diffView.selectedFileIndex];
  const wasLocked = diffView.fileSelectionLocked;

  try {
    const response = await actions.client.getTaskDiff(diffView.taskId);
    if (state.diffView?.taskId !== diffView.taskId) return;

    let next = applyDiffResponse(state.diffView, response);
    if (selectedFile) {
      const restoredIndex = next.files.findIndex((file) => file.file === selectedFile.file);
      next = {
        ...next,
        selectedFileIndex: restoredIndex !== -1
          ? restoredIndex
          : Math.max(0, Math.min(diffView.selectedFileIndex, next.files.length - 1)),
        fileSelectionLocked: wasLocked,
      };
    }
    state.diffView = next;
    await refreshDiffViewCommitStatus(state, actions);
    state.detailScrollTop[DIFF_PATCH_SCROLL_ID] = diffPatchScrollTop(state.diffView);
  } catch (error) {
    if (state.diffView?.taskId === diffView.taskId) {
      state.diffView = applyDiffError(state.diffView, errorMessage(error));
    }
  }
  actions.render();
}

async function refreshDiffViewCommitStatus(state: TuiState, actions: TuiActions): Promise<void> {
  const diffView = state.diffView;
  if (!diffView) return;
  const task = state.tasks.find((item) => item.id === diffView.taskId);
  if (!canFetchReviewCommitStatus(task)) {
    state.diffView = { ...diffView, commitStatus: undefined };
    return;
  }

  try {
    const commitStatus = await actions.client.getTaskCommitStatus(diffView.taskId);
    if (state.diffView?.taskId === diffView.taskId) {
      state.diffView = { ...state.diffView, commitStatus };
    }
    if (state.selectedTaskId === diffView.taskId) {
      state.reviewCommitStatus = { ...reviewDiffStatCacheKey(task), status: "success", response: commitStatus };
    }
  } catch {
    if (state.diffView?.taskId === diffView.taskId) {
      state.diffView = { ...state.diffView, commitStatus: undefined };
    }
  }
}

function clearPendingConfirmation(state: TuiState): void {
  state.pendingConfirmation = clearConfirmation(state).pendingConfirmation;
  state.integrateCommitReview = undefined;
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
  state.filesDetail = undefined;
  state.integrateCommitReview = undefined;
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
    // Reverse-engineer the provider from an existing explicit model (ModelRef
    // already carries providerID) so editing a task that has one shows the
    // harness screen unlocked with that provider/model, not falsely "locked"
    // to Use Agent Profile Default.
    providerId: task.model?.providerID ?? "",
    agentId: task.agent ?? defaultAgentId(state.agents),
    permissionMode: task.permissionMode ?? task.claudePermissionMode ?? defaultAcpPermissionMode(state.acpConfig, task.harness),
    acpOptions: reconcileAcpOptions(state.acpConfig, task.harness ?? "opencode", task.acpOptions),
    assignedTo: task.assignedTo ?? "",
    model: task.model ?? undefined,
    isolation: task.isolation ?? "worktree",
    permissionOverrides: {
      edit: task.permissionOverrides?.edit ?? "allow",
      bash: task.permissionOverrides?.bash ?? "allow",
      webfetch: task.permissionOverrides?.webfetch ?? "allow",
    },
    parentIds: task.parentIds ?? [],
    dependencyIndex: 0,
    step: "identity",
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
    moveDraftField(state, draft, key.shift ? -1 : 1);
    actions.render();
    return;
  }

  if (isEnterKey(key)) {
    if (draft.step === "confirm") {
      await createDraftTask(state, actions);
      return;
    }
    advanceWizardStep(state, draft, 1);
    actions.render();
    return;
  }

  if (handleDraftTextKey(draft, key)) {
    draft.error = undefined;
    actions.render();
    return;
  }

  if (handleModelQueryKey(draft, key)) {
    draft.error = undefined;
    actions.render();
    return;
  }

  if (isWizardBackKey(key, draft)) {
    advanceWizardStep(state, draft, -1);
    actions.render();
    return;
  }

  if (handleDependencyKey(draft, state, key)) {
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

/**
 * `b`/`B` navigates to the previous wizard screen — but only when focus
 * isn't on a text-input field, so typing a title/prompt containing the
 * letter "b" still inserts it literally (handleDraftTextKey/applyTextInput
 * already consume the key first in that case; this check is belt-and-suspenders
 * self-documentation of that same contract, mirroring how "n" is typable
 * inside these same fields today).
 */
function isWizardBackKey(key: KeyEvent, draft: NewTaskDraft): boolean {
  if (isTextInputField(draft.field)) return false;
  if (draft.field === "model") return false;
  return key.sequence === "b" || key.sequence === "B";
}

/**
 * The MODEL field is a type-to-filter picker, not a plain select — a
 * provider like OpenRouter can carry hundreds of models, too many to arrow
 * through one at a time. Typed characters narrow `draft.modelQuery`;
 * left/right/up/down (handled separately by cycleFocusedField -> cycleModel)
 * move through whatever the current query matches. Only active while MODEL
 * is focused, which itself is only reachable once a real PROVIDER is picked
 * (see stepFieldOrder) — "Use Agent Profile Default" locks MODEL out entirely.
 */
function handleModelQueryKey(draft: NewTaskDraft, key: KeyEvent): boolean {
  if (draft.field !== "model") return false;

  if (isAcpHarness(draft.harness)) {
    const providerID = acpModelProviderForHarness(draft.harness);
    if (!providerID) return false;
    const current = draft.model?.id ?? "";
    if (key.name === "backspace" || key.sequence === "" || key.sequence === "\b") {
      const next = current.slice(0, -1);
      draft.model = next ? { providerID, id: next } : undefined;
      draft.modelQuery = next || undefined;
      return true;
    }
    if (key.ctrl || key.meta || key.sequence.length !== 1 || key.sequence < " ") return false;
    const base = draft.modelQuery === undefined ? "" : current;
    const next = `${base}${key.sequence}`;
    draft.model = { providerID, id: next };
    draft.modelQuery = next;
    return true;
  }

  if (key.name === "backspace" || key.sequence === "" || key.sequence === "\b") {
    draft.modelQuery = (draft.modelQuery ?? "").slice(0, -1) || undefined;
    return true;
  }
  if (key.ctrl || key.meta || key.sequence.length !== 1 || key.sequence < " ") return false;
  draft.modelQuery = (draft.modelQuery ?? "") + key.sequence;
  return true;
}

/**
 * Only OpenCode's in-place (non-worktree) tasks may carry a permission
 * override — worktree tasks always get the automatic write-fenced ruleset
 * (see resolveOpenCodePermissionRules) and the wizard never shows an
 * editable control for them. Returns undefined for an untouched (all-allow)
 * draft so its create/update payload stays byte-identical to a plain task.
 */
function draftPermissionOverridesPayload(draft: NewTaskDraft): PermissionOverrides | undefined {
  if (draft.harness !== "opencode" || draft.isolation !== "in-place") return undefined;
  const overrides: PermissionOverrides = {};
  for (const category of PERMISSION_OVERRIDE_CATEGORIES) {
    const action = draft.permissionOverrides[category];
    if (action !== "allow") overrides[category] = action;
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function draftAcpOptionsPayload(state: TuiState, draft: NewTaskDraft): AcpOptions | undefined {
  if (!isAcpHarness(draft.harness)) return undefined;
  const options = reconcileAcpOptions(state.acpConfig, draft.harness, draft.acpOptions);
  return Object.keys(options).length > 0 ? options : undefined;
}

function draftModelPayload(draft: NewTaskDraft): ModelRef | undefined {
  if (isAcpHarness(draft.harness) && draft.model?.id === "") return undefined;
  return draft.model;
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
    const permissionMode = currentPermissionModeValue(state.acpConfig, draft);
    const hasAcpModes = (acpConfigForHarness(state.acpConfig, draft.harness)?.modes.length ?? 0) > 0;
    const acpOptions = draftAcpOptionsPayload(state, draft);
    const model = draftModelPayload(draft);
    const task = isEditing
      ? await actions.client.updateTask(draft.editingTaskId as string, draft.type === "manual" ? {
          type: "manual",
          title,
          description: draft.description,
          directory,
          assignedTo: draft.assignedTo.trim() || null,
          parentIds: draft.parentIds,
        } : {
          type: "agent",
          harness: draft.harness,
          title,
          description: draft.description,
          directory,
          agent: draft.harness === "opencode" ? draft.agentId || null : null,
          permissionMode: isAcpHarness(draft.harness) && hasAcpModes ? permissionMode : null,
          claudePermissionMode: isClaudeHarness(draft.harness) && hasAcpModes ? permissionMode : null,
          acpOptions: acpOptions ?? null,
          model: model ?? null,
          isolation: draft.isolation,
          permissionOverrides: draftPermissionOverridesPayload(draft) ?? null,
          parentIds: draft.parentIds,
        })
      : await actions.client.createTask(draft.type === "manual" ? {
          type: "manual",
          title,
          description: draft.description,
          directory,
          assignedTo: draft.assignedTo.trim() || undefined,
          parentIds: draft.parentIds,
        } : {
          type: "agent",
          harness: draft.harness,
          title,
          description: draft.description,
          directory,
          ...(draft.harness === "opencode" ? { agent: draft.agentId || undefined } : {}),
          ...(isAcpHarness(draft.harness) && hasAcpModes ? { permissionMode } : {}),
          ...(isClaudeHarness(draft.harness) && hasAcpModes ? { claudePermissionMode: permissionMode } : {}),
          ...(acpOptions ? { acpOptions } : {}),
          model,
          isolation: draft.isolation,
          permissionOverrides: draftPermissionOverridesPayload(draft),
          parentIds: draft.parentIds,
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
  return {
    type: "agent",
    title: "",
    description: "",
    directory: state.cwd,
    harness: "opencode",
    // providerId "" (Use Agent Profile Default) always pairs with model
    // undefined — MODEL is locked to that label until a real provider is
    // picked, so the agent profile's own model is what actually runs.
    providerId: "",
    agentId,
    permissionMode: defaultAcpPermissionMode(state.acpConfig, "opencode"),
    acpOptions: {},
    assignedTo: "",
    model: undefined,
    isolation: "worktree",
    permissionOverrides: { edit: "allow", bash: "allow", webfetch: "allow" },
    parentIds: [],
    dependencyIndex: 0,
    step: "identity",
    field: "type",
    textCursors: {},
    textScrolls: {},
    submitting: false,
  };
}

function moveDraftField(state: TuiState, draft: NewTaskDraft, delta: number): void {
  const order = stepFieldOrder(state, draft);
  if (order.length === 0) return; // confirm screen has no focusable fields — Tab is a no-op
  const current = order.includes(draft.field) ? draft.field : order[0];
  const index = order.indexOf(current);
  draft.field = order[(index + delta + order.length) % order.length];
  if (current === "model" && draft.field !== "model") draft.modelQuery = undefined;
}

function cycleFocusedField(draft: NewTaskDraft, state: TuiState, delta: number): boolean {
  switch (draft.field) {
    case "type":
      draft.type = draft.type === "agent" ? "manual" : "agent";
      if (!stepFieldOrder(state, draft).includes(draft.field)) draft.field = stepFieldOrder(state, draft)[0] ?? draft.field;
      return true;
    case "harness":
      {
        const harnesses = harnessCycle(state);
        const current = Math.max(0, harnesses.indexOf(draft.harness));
        draft.harness = harnesses[(current + delta + harnesses.length) % harnesses.length] ?? "opencode";
      }
      if (isAcpHarness(draft.harness)) {
        draft.model = undefined;
        draft.permissionMode = defaultAcpPermissionMode(state.acpConfig, draft.harness);
        draft.acpOptions = defaultAcpOptions(state.acpConfig, draft.harness);
      } else {
        draft.providerId = "";
        draft.model = undefined;
        draft.acpOptions = {};
      }
      draft.modelQuery = undefined;
      if (!stepFieldOrder(state, draft).includes(draft.field)) draft.field = stepFieldOrder(state, draft)[0] ?? draft.field;
      return true;
    case "provider":
      cycleProvider(draft, state.providers, delta);
      return true;
    case "agent":
      cycleAgent(draft, state.agents, delta);
      return true;
    case "permissionMode":
      cyclePermissionMode(state.acpConfig, draft, delta);
      return true;
    case "acpOption0":
    case "acpOption1":
    case "acpOption2":
      cycleAcpOption(state.acpConfig, draft, acpOptionFieldIndex(draft.field), delta);
      return true;
    case "model":
      cycleModel(draft, state.agents, state.providers, state.acpConfig, delta);
      return true;
    case "isolation":
      draft.isolation = draft.isolation === "worktree" ? "in-place" : "worktree";
      if (!stepFieldOrder(state, draft).includes(draft.field)) draft.field = stepFieldOrder(state, draft)[0] ?? draft.field;
      return true;
    case "permEdit":
      cyclePermissionOverride(draft, "edit", delta);
      return true;
    case "permBash":
      cyclePermissionOverride(draft, "bash", delta);
      return true;
    case "permWebfetch":
      cyclePermissionOverride(draft, "webfetch", delta);
      return true;
    case "dependency":
      moveDependencySelection(draft, state, delta);
      return true;
    default:
      return false;
  }
}

function handleDependencyKey(draft: NewTaskDraft, state: TuiState, key: KeyEvent): boolean {
  if (draft.step !== "dependencies" || draft.field !== "dependency") return false;
  const keyName = key.name || key.sequence;
  if (keyName === "down") {
    moveDependencySelection(draft, state, 1);
    return true;
  }
  if (keyName === "up") {
    moveDependencySelection(draft, state, -1);
    return true;
  }
  if (key.sequence === " ") {
    toggleSelectedDependency(draft, state);
    return true;
  }
  return false;
}

function dependencyCandidates(state: TuiState, draft: NewTaskDraft): Task[] {
  return state.tasks.filter((task) => task.id !== draft.editingTaskId);
}

function normalizedDependencyIndex(draft: NewTaskDraft, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(draft.dependencyIndex, count - 1));
}

function moveDependencySelection(draft: NewTaskDraft, state: TuiState, delta: number): void {
  const count = dependencyCandidates(state, draft).length;
  if (count === 0) {
    draft.dependencyIndex = 0;
    return;
  }
  draft.dependencyIndex = (normalizedDependencyIndex(draft, count) + delta + count) % count;
}

function toggleSelectedDependency(draft: NewTaskDraft, state: TuiState): void {
  const candidates = dependencyCandidates(state, draft);
  const task = candidates[normalizedDependencyIndex(draft, candidates.length)];
  if (!task) return;
  draft.parentIds = draft.parentIds.includes(task.id)
    ? draft.parentIds.filter((id) => id !== task.id)
    : [...draft.parentIds, task.id];
}

/**
 * Cycling AGENT PROFILE keeps MODEL in sync with the newly-selected agent's
 * own default — but only when the current model still matches the *previous*
 * agent's default, i.e. the user never deviated from it on the earlier MODEL
 * screen. This preserves an explicit model choice (MODEL now has its own
 * screen ahead of AGENT PROFILE) while still auto-syncing for the common case
 * of just picking an agent and moving on.
 */
function cycleAgent(draft: NewTaskDraft, agents: RosterAgent[], delta: number): void {
  // While PROVIDER is "Use Agent Profile Default" (providerId ""), MODEL is
  // locked to that same label regardless of which agent is selected — nothing
  // to sync. Only an explicit provider/model pick (unlocked) needs the
  // preserve-vs-sync heuristic below.
  const previousAgentModel = agents.find((agent) => agent.id === draft.agentId)?.model;
  const modelMatchesPreviousAgentDefault = sameModel(draft.model, previousAgentModel);
  const ids = ["", ...agents.map((agent) => agent.id)];
  const current = Math.max(0, ids.indexOf(draft.agentId));
  draft.agentId = ids[(current + delta + ids.length) % ids.length] ?? "";
  if (draft.providerId && modelMatchesPreviousAgentDefault) {
    draft.model = agents.find((agent) => agent.id === draft.agentId)?.model;
  }
}

function cycleProvider(draft: NewTaskDraft, providers: RosterProvider[], delta: number): void {
  const ids = ["", ...providers.map((provider) => provider.id)];
  const current = Math.max(0, ids.indexOf(draft.providerId));
  draft.providerId = ids[(current + delta + ids.length) % ids.length] ?? "";
  const provider = providers.find((item) => item.id === draft.providerId);
  draft.model = provider ? modelRefFromProvider(provider) : undefined;
  draft.modelQuery = undefined; // a new provider means a new candidate list — any stale filter no longer applies
}

function modelRefFromProvider(provider: RosterProvider): ModelRef | undefined {
  const modelId = provider.defaultModelId ?? provider.models[0]?.id;
  return modelId ? { providerID: provider.id, id: modelId } : undefined;
}

function defaultAcpPermissionMode(catalog: AcpConfigCatalog, harness: TaskHarness | undefined): AcpPermissionMode {
  const first = acpConfigForHarness(catalog, harness)?.modes[0]?.value;
  return (first || DEFAULT_ACP_PERMISSION_MODE) as AcpPermissionMode;
}

function cyclePermissionMode(catalog: AcpConfigCatalog, draft: NewTaskDraft, delta: number): void {
  const modes = acpConfigForHarness(catalog, draft.harness)?.modes ?? [];
  if (modes.length === 0) return;
  const ids = modes.map((mode) => mode.value);
  const current = Math.max(0, ids.indexOf(draft.permissionMode));
  draft.permissionMode = ids[(current + delta + ids.length) % ids.length] as AcpPermissionMode;
}

function cycleAcpOption(catalog: AcpConfigCatalog, draft: NewTaskDraft, optionIndex: number, delta: number): void {
  const spec = acpOptionSpecs(catalog, draft.harness)[optionIndex];
  if (!spec) return;
  if (spec.type === "boolean") {
    draft.acpOptions = {
      ...draft.acpOptions,
      [spec.id]: !(draft.acpOptions[spec.id] === true),
    };
    return;
  }
  const values = spec.options?.map((option) => option.value) ?? [];
  if (values.length === 0) return;
  const rawCurrent = draft.acpOptions[spec.id];
  const currentValue: string = typeof rawCurrent === "string" ? rawCurrent : values[0] ?? "";
  const current = Math.max(0, values.indexOf(currentValue));
  draft.acpOptions = {
    ...draft.acpOptions,
    [spec.id]: values[(current + delta + values.length) % values.length],
  };
}

function cyclePermissionOverride(draft: NewTaskDraft, category: PermissionOverrideCategory, delta: number): void {
  const current = Math.max(0, PERMISSION_OVERRIDE_ACTIONS.indexOf(draft.permissionOverrides[category]));
  draft.permissionOverrides[category] =
    PERMISSION_OVERRIDE_ACTIONS[(current + delta + PERMISSION_OVERRIDE_ACTIONS.length) % PERMISSION_OVERRIDE_ACTIONS.length];
}

function cycleModel(draft: NewTaskDraft, agents: RosterAgent[], providers: RosterProvider[], acpConfig: AcpConfigCatalog, delta: number): void {
  const options = filteredModelOptions(draft, agents, providers, acpConfig);
  if (options.length === 0) return; // no matches for the current query — nothing to move to
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

/** The wizard screens for the current draft's card type — manual cards skip agent-only screens. */
function wizardSteps(draft: NewTaskDraft): readonly WizardStep[] {
  if (draft.type === "manual") return ["identity", "dependencies", "confirm"] as const;
  return ["identity", "harness", "agentProfile", "isolation", "dependencies", "confirm"] as const;
}

/** The focusable field order for the draft's *current* step, branched by harness/isolation where relevant. */
function stepFieldOrder(state: TuiState, draft: NewTaskDraft): readonly NewTaskField[] {
  switch (draft.step) {
    case "identity":
      return draft.type === "manual" ? IDENTITY_FIELDS_MANUAL : IDENTITY_FIELDS_AGENT;
    case "harness":
      if (isAcpHarness(draft.harness)) return HARNESS_FIELDS_CLAUDE;
      return draft.providerId ? HARNESS_FIELDS_OPENCODE : HARNESS_FIELDS_OPENCODE_LOCKED;
    case "agentProfile":
      if (isAcpHarness(draft.harness)) {
        const fields: NewTaskField[] = [];
        if ((acpConfigForHarness(state.acpConfig, draft.harness)?.modes.length ?? 0) > 0) fields.push("permissionMode");
        fields.push(...ACP_OPTION_FIELDS.slice(0, acpOptionSpecs(state.acpConfig, draft.harness).length));
        return fields;
      }
      return draft.harness === "opencode" ? AGENT_PROFILE_FIELDS_OPENCODE : CONFIRM_FIELDS;
    case "isolation":
      return draft.harness === "opencode" && draft.isolation === "in-place" ? ISOLATION_FIELDS_EDITABLE : ISOLATION_FIELDS_LOCKED;
    case "dependencies":
      return DEPENDENCY_FIELDS;
    case "confirm":
      return CONFIRM_FIELDS;
  }
}

/**
 * Move to the next/previous wizard screen (Enter/`b`), clamped at either end
 * — `b` on the first screen and Enter on the last are no-ops here (Enter on
 * "confirm" is handled separately, as a submit rather than a step change).
 * Focus always resets to the new screen's first field, falling back to the
 * non-text "type" sentinel on the fieldless confirm screen so a stale
 * text-field focus can never make `b` silently insert a literal "b" instead
 * of navigating back.
 */
function advanceWizardStep(state: TuiState, draft: NewTaskDraft, delta: number): void {
  const steps = wizardSteps(draft);
  const currentIndex = steps.indexOf(draft.step);
  const nextIndex = Math.max(0, Math.min(steps.length - 1, (currentIndex === -1 ? 0 : currentIndex) + delta));
  draft.step = steps[nextIndex] ?? steps[0];
  draft.field = stepFieldOrder(state, draft)[0] ?? "type";
  draft.modelQuery = undefined; // leaving the harness screen always leaves MODEL too
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

async function handleInstanceSwitcherKey(key: KeyEvent, state: TuiState, actions: TuiActions): Promise<void> {
  const switcher = state.instanceSwitcher;
  if (!switcher) return;

  if (isEscapeKey(key) || key.sequence === "b") {
    state.instanceSwitcher = undefined;
    actions.render();
    return;
  }

  const keyName = key.name || key.sequence;

  if (keyName === "down") {
    switcher.selectedIndex = Math.min(switcher.selectedIndex + 1, state.instanceList.length - 1);
    actions.render();
    return;
  }

  if (keyName === "up") {
    switcher.selectedIndex = Math.max(switcher.selectedIndex - 1, 0);
    actions.render();
    return;
  }

  if (isEnterKey(key)) {
    const item = state.instanceList[switcher.selectedIndex];
    if (item && item.runtime.boardUrl !== state.boardUrl) {
      state.instanceSwitcher = undefined;
      await actions.attachInstance(item);
    } else {
      state.instanceSwitcher = undefined;
      actions.render();
    }
    return;
  }

  if (key.sequence === "s") {
    const item = state.instanceList[switcher.selectedIndex];
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
    const workspace = validateWorkspacePath(draft.workspace, state.cwd);
    if (!workspace.ok) {
      draft.error = workspace.error;
      actions.render();
      return;
    }
    draft.submitting = true;
    draft.error = undefined;
    actions.render();
    await actions.addInstance(name.value, workspace.path);
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
    if (archive.focused) {
      archive.focused = false;
      actions.render();
      return;
    }
    actions.closeArchive();
    return;
  }

  if (isEnterKey(key)) {
    archive.focused = !archive.focused;
    actions.render();
    return;
  }

  if (key.sequence === "e") {
    archive.expanded = !archive.expanded;
    actions.render();
    return;
  }

  if (archive.focused) {
    const record = filteredArchiveRecords(archive)[archive.selectedIndex];
    if (archive.detailTab === "files") {
      const files = parseCompletion(record?.completion ?? null)?.changedFiles ?? [];
      const ownerId = archiveFilesOwnerId(record?.task_id ?? "");
      const scrollId = record ? `archive-detail-files-${record.task_id}` : "";
      if (keyName === "down" || keyName === "up") {
        if (record && files.length > 0) {
          moveFilesSelection(state, ownerId, files.length, keyName === "down" ? 1 : -1, scrollId, archiveFilesVisibleRows(state));
        }
        actions.render();
        return;
      }
      if (keyName === "left" || keyName === "right" || key.sequence === "\t") {
        archive.detailTab = nextDetailTab(archive.detailTab, keyName === "left" ? -1 : 1);
        actions.render();
        return;
      }
    } else {
      const scrollId = record ? archiveDetailScrollId(archive.detailTab, record.task_id) : undefined;
      if (scrollId && (keyName === "down" || keyName === "up")) {
        const delta = keyName === "down" ? DETAIL_SCROLL_STEP_ROWS : -DETAIL_SCROLL_STEP_ROWS;
        state.detailScrollTop[scrollId] = clampDetailScrollOffset(
          detailScrollOffset(state, scrollId) + delta,
          record ? archiveDetailScrollMax(state, record, archive.detailTab) : 0,
        );
        actions.render();
        return;
      }
      if (keyName === "left" || keyName === "right" || key.sequence === "\t") {
        archive.detailTab = nextDetailTab(archive.detailTab, keyName === "left" ? -1 : 1);
        actions.render();
        return;
      }
    }
    return;
  }

  if (keyName === "left" || keyName === "right" || key.sequence === "\t") {
    archive.detailTab = nextDetailTab(archive.detailTab, keyName === "left" ? -1 : 1);
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
  return harnessDisplayName(draft.harness);
}

function currentPermissionModeLabel(catalog: AcpConfigCatalog, draft: NewTaskDraft): string {
  const value = currentPermissionModeValue(catalog, draft);
  return acpConfigForHarness(catalog, draft.harness)?.modes.find((mode) => mode.value === value)?.name ?? value;
}

function currentPermissionModeValue(catalog: AcpConfigCatalog, draft: NewTaskDraft): AcpPermissionMode {
  const legacy = (draft as NewTaskDraft & { claudePermissionMode?: AcpPermissionMode }).claudePermissionMode;
  return draft.permissionMode ?? legacy ?? defaultAcpPermissionMode(catalog, draft.harness);
}

function currentModelLabel(draft: NewTaskDraft): string {
  if (isAcpHarness(draft.harness)) {
    return draft.model?.id || "Provider Default";
  }
  return draft.model ? modelLabel(draft.model) : AGENT_PROFILE_DEFAULT_LABEL;
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

function modelOptions(draft: NewTaskDraft, agents: RosterAgent[], providers: RosterProvider[], acpConfig: AcpConfigCatalog): Array<ModelRef | undefined> {
  if (isAcpHarness(draft.harness)) {
    const providerID = acpModelProviderForHarness(draft.harness);
    const harness = draft.harness as AcpTaskHarness;
    const discovered = providerID
      ? (acpConfig[harness]?.models ?? []).map((model) => ({ providerID, id: model.id }))
      : [];
    return [undefined, ...discovered];
  }
  const provider = draft.providerId ? providers.find((item) => item.id === draft.providerId) : undefined;
  if (provider) return provider.models.map((model) => ({ providerID: provider.id, id: model.id }));
  return [undefined, ...uniqueModels(agents)];
}

/** modelOptions() narrowed by the MODEL field's live type-to-filter query — a provider like OpenRouter can carry hundreds of models, too many to arrow through one at a time. */
function filteredModelOptions(draft: NewTaskDraft, agents: RosterAgent[], providers: RosterProvider[], acpConfig: AcpConfigCatalog): Array<ModelRef | undefined> {
  const options = modelOptions(draft, agents, providers, acpConfig);
  const query = (draft.modelQuery ?? "").trim().toLowerCase();
  if (!query) return options;
  return options.filter((model): model is ModelRef => model !== undefined && modelLabel(model).toLowerCase().includes(query));
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

function reviewDiffStatCacheKey(task: Pick<Task, "id" | "updatedAt">): Pick<ReviewDiffStatState, "taskId" | "taskUpdatedAt"> {
  return { taskId: task.id, taskUpdatedAt: task.updatedAt };
}

function isSameReviewDiffStatIdentity(cache: ReviewDiffStatState | undefined, task: Pick<Task, "id" | "updatedAt"> | undefined): boolean {
  return Boolean(cache && task && cache.taskId === task.id && cache.taskUpdatedAt === task.updatedAt);
}

function reconcileReviewDiffStatCache(cache: ReviewDiffStatState | undefined, task: Task | undefined): ReviewDiffStatState | undefined {
  if (!canOpenDiffView(task)) return undefined;
  return isSameReviewDiffStatIdentity(cache, task) ? cache : undefined;
}

function isSameReviewCommitStatusIdentity(cache: ReviewCommitStatusState | undefined, task: Pick<Task, "id" | "updatedAt"> | undefined): boolean {
  return Boolean(cache && task && cache.taskId === task.id && cache.taskUpdatedAt === task.updatedAt);
}

function canFetchReviewCommitStatus(task: Task | undefined): task is Task {
  return Boolean(task && canOpenDiffView(task) && task.worktreePath);
}

function reconcileReviewCommitStatusCache(cache: ReviewCommitStatusState | undefined, task: Task | undefined): ReviewCommitStatusState | undefined {
  if (!canFetchReviewCommitStatus(task)) return undefined;
  return isSameReviewCommitStatusIdentity(cache, task) ? cache : undefined;
}

function reviewCommitStatusForTask(state: TuiState, task: Task | undefined): WorktreeCommitStatus | undefined {
  const cache = isSameReviewCommitStatusIdentity(state.reviewCommitStatus, task) ? state.reviewCommitStatus : undefined;
  return cache?.status === "success" ? cache.response : undefined;
}

async function fetchSelectedReviewDiffStat(
  state: TuiState,
  client: Pick<BoardClient, "getTaskDiff">,
  render: () => void,
): Promise<void> {
  const task = selectedTask(state);
  if (!task || !canOpenDiffView(task)) {
    state.reviewDiffStat = undefined;
    return;
  }
  if (isSameReviewDiffStatIdentity(state.reviewDiffStat, task)) return;

  const key = reviewDiffStatCacheKey(task);
  state.reviewDiffStat = { ...key, status: "loading" };
  render();

  try {
    const response = await client.getTaskDiff(task.id);
    if (!isSameReviewDiffStatIdentity(state.reviewDiffStat, task)) return;
    state.reviewDiffStat = { ...key, status: "success", label: formatDiffStat(response), response };
  } catch {
    if (!isSameReviewDiffStatIdentity(state.reviewDiffStat, task)) return;
    state.reviewDiffStat = { ...key, status: "error", label: "diff unavailable" };
  }
  render();
}

async function fetchSelectedReviewCommitStatus(
  state: TuiState,
  client: Pick<BoardClient, "getTaskCommitStatus">,
  render: () => void,
): Promise<void> {
  const task = selectedTask(state);
  if (!canFetchReviewCommitStatus(task)) {
    state.reviewCommitStatus = undefined;
    return;
  }
  if (isSameReviewCommitStatusIdentity(state.reviewCommitStatus, task)) return;

  const key = reviewDiffStatCacheKey(task);
  state.reviewCommitStatus = { ...key, status: "loading" };
  render();

  try {
    const response = await client.getTaskCommitStatus(task.id);
    if (!isSameReviewCommitStatusIdentity(state.reviewCommitStatus, task)) return;
    state.reviewCommitStatus = { ...key, status: "success", response };
  } catch {
    if (!isSameReviewCommitStatusIdentity(state.reviewCommitStatus, task)) return;
    state.reviewCommitStatus = { ...key, status: "error" };
  }
  render();
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
  if (task.pending === "base-checkout-escape") return COLORS.muted;
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
