/**
 * TUI full-screen diff view (Review cards only). State/logic here is pure and
 * OpenTUI-agnostic except for `renderDiffView`, which builds a VChild tree the
 * same way index.ts's render functions do. Keeping the two separate lets the
 * navigation/selection logic be unit tested without a terminal or fixture UI.
 */
import type { RGBA, VChild } from "@opentui/core";
import { truncateText } from "./model";
import type { DiffFile, DiffResponse, Task } from "../shared";

type OpenTui = typeof import("@opentui/core");
type ThemeColor = string | RGBA;

/** Narrow file-selection column width, matching OpenCode's own diff-viewer layout constant. */
export const DIFF_FILE_COLUMN_WIDTH = 32;
/** Every file-list entry is exactly two terminal rows: filename, then stats/marker. */
export const DIFF_FILE_ROW_HEIGHT = 2;
/** Legacy threshold retained for callers; DiffView no longer auto-collapses below it. */
export const DIFF_MIN_SPLIT_WIDTH = 100;
/** Shared ids/`state.detailScrollTop` keys so scroll position persists like every other detail pane. */
export const DIFF_FILE_LIST_SCROLL_ID = "diff-files";
export const DIFF_PATCH_SCROLL_ID = "diff-patch";

export type DiffPatchView = "split" | "unified";

export interface SelectedHunk {
  fileIndex: number;
  hunkIndex: number;
}

/** Result kind mirrors DiffResponse; `undefined` while the initial fetch is in flight. */
export interface DiffViewState {
  taskId: string;
  sourceLabel: string;
  dirtyAtDispatch: boolean;
  loading: boolean;
  error?: string;
  kind?: "diff" | "no-git";
  noGitReason?: string;
  capped: boolean;
  files: DiffFile[];
  selectedFileIndex: number;
  selectedHunk?: SelectedHunk;
  reviewedFiles: Set<string>;
  viewOverride?: DiffPatchView;
}

/** Diff-source label shown in the header, derived from how the task's session ran. */
export function diffSourceLabel(task: Pick<Task, "harness" | "isolation">): string {
  if (task.harness === "claude-code") return "harness diff";
  if (task.isolation === "worktree") return "worktree diff";
  return "working tree diff";
}

/** `v` only opens the diff view for Review-column agent cards, never manual/PM cards. */
export function canOpenDiffView(task: Pick<Task, "column" | "type"> | undefined): boolean {
  return Boolean(task) && task!.column === "review" && task!.type !== "manual";
}

export function createLoadingDiffViewState(task: Task): DiffViewState {
  return {
    taskId: task.id,
    sourceLabel: diffSourceLabel(task),
    dirtyAtDispatch: task.dirtyAtDispatch,
    loading: true,
    capped: false,
    files: [],
    selectedFileIndex: 0,
    reviewedFiles: new Set(),
  };
}

export function applyDiffResponse(state: DiffViewState, response: DiffResponse): DiffViewState {
  if (response.kind === "no-git") {
    return { ...state, loading: false, error: undefined, kind: "no-git", noGitReason: response.reason, files: [] };
  }
  return {
    ...state,
    loading: false,
    error: undefined,
    kind: "diff",
    capped: response.capped,
    files: response.files,
    selectedFileIndex: 0,
    selectedHunk: undefined,
  };
}

export function applyDiffError(state: DiffViewState, message: string): DiffViewState {
  return { ...state, loading: false, error: message };
}

export function selectFileIndex(state: DiffViewState, index: number): DiffViewState {
  if (state.files.length === 0) return state;
  const clamped = Math.max(0, Math.min(index, state.files.length - 1));
  if (clamped === state.selectedFileIndex) return state;
  return { ...state, selectedFileIndex: clamped, selectedHunk: undefined };
}

export function moveFileSelection(state: DiffViewState, delta: number): DiffViewState {
  if (state.files.length === 0) return state;
  const next = (state.selectedFileIndex + delta + state.files.length) % state.files.length;
  return { ...state, selectedFileIndex: next, selectedHunk: undefined };
}

export function toggleFileReviewed(state: DiffViewState): DiffViewState {
  const file = state.files[state.selectedFileIndex];
  if (!file) return state;
  const next = new Set(state.reviewedFiles);
  if (next.has(file.file)) next.delete(file.file);
  else next.add(file.file);
  return { ...state, reviewedFiles: next };
}

export function isFileReviewed(state: DiffViewState, file: string): boolean {
  return state.reviewedFiles.has(file);
}

export function splitAvailable(patchPaneWidth: number): boolean {
  void patchPaneWidth;
  return true;
}

export function effectiveDiffView(state: DiffViewState, patchPaneWidth: number): DiffPatchView {
  void patchPaneWidth;
  return state.viewOverride ?? "split";
}

export function toggleViewOverride(state: DiffViewState, patchPaneWidth: number): DiffViewState {
  void patchPaneWidth;
  const current = effectiveDiffView(state, patchPaneWidth);
  return { ...state, viewOverride: current === "split" ? "unified" : "split" };
}

/** 0-based line indices of `@@` hunk headers within a unified patch's text. */
export function hunkLineOffsets(patch: string | undefined): number[] {
  if (!patch) return [];
  return patch.split("\n").flatMap((line, index) => (line.startsWith("@@") ? [index] : []));
}

/** Steps to the next/previous hunk within the currently selected file only. */
export function moveHunkSelection(state: DiffViewState, delta: 1 | -1): DiffViewState {
  const file = state.files[state.selectedFileIndex];
  const offsets = hunkLineOffsets(file?.patch);
  if (offsets.length === 0) return state;

  const currentIndex = state.selectedHunk?.fileIndex === state.selectedFileIndex ? state.selectedHunk.hunkIndex : -1;
  const nextIndex = currentIndex === -1
    ? delta === 1 ? 0 : offsets.length - 1
    : (currentIndex + delta + offsets.length) % offsets.length;

  return { ...state, selectedHunk: { fileIndex: state.selectedFileIndex, hunkIndex: nextIndex } };
}

/** Target scrollTop (in patch rows) for the currently selected hunk, else the top of the file. */
export function diffPatchScrollTop(state: DiffViewState): number {
  const file = state.files[state.selectedFileIndex];
  if (!file || !state.selectedHunk || state.selectedHunk.fileIndex !== state.selectedFileIndex) return 0;
  const offsets = hunkLineOffsets(file.patch);
  return offsets[state.selectedHunk.hunkIndex] ?? 0;
}

/** Patch text presented to DiffRenderable. Selected hunks are rotated to the top
 * without changing the total line count, keeping the diff pane geometry stable.
 */
export function diffPatchForRender(state: DiffViewState, file: DiffFile): string | undefined {
  if (!file.patch || !state.selectedHunk || state.selectedHunk.fileIndex !== state.selectedFileIndex) return file.patch;
  const offsets = hunkLineOffsets(file.patch);
  const selectedOffset = offsets[state.selectedHunk.hunkIndex];
  if (!selectedOffset) return file.patch;
  const lines = file.patch.split("\n");
  return [...lines.slice(selectedOffset), ...lines.slice(0, selectedOffset)].join("\n");
}

export interface DiffFileListWindow {
  offset: number;
  capacity: number;
  hiddenAbove: number;
  hiddenBelow: number;
}

/** Deterministic manual file-list windowing keeps the selected file visible without ScrollBox churn. */
export function diffFileListWindow(selectedIndex: number, totalFiles: number, visibleRows: number): DiffFileListWindow {
  const capacity = Math.max(1, Math.min(totalFiles, Math.floor(visibleRows) || 1));
  if (totalFiles <= 0) return { offset: 0, capacity: 1, hiddenAbove: 0, hiddenBelow: 0 };
  const selected = Math.max(0, Math.min(selectedIndex, totalFiles - 1));
  const centered = selected - Math.floor(capacity / 2);
  const maxOffset = Math.max(0, totalFiles - capacity);
  const offset = Math.max(0, Math.min(centered, maxOffset));
  return {
    offset,
    capacity,
    hiddenAbove: offset,
    hiddenBelow: Math.max(0, totalFiles - offset - capacity),
  };
}

export function diffHunkPositionLabel(state: DiffViewState): string {
  const file = state.files[state.selectedFileIndex];
  const count = hunkLineOffsets(file?.patch).length;
  if (count === 0) return "0 hunks";
  if (count === 1) return "1 hunk";
  const selected = state.selectedHunk?.fileIndex === state.selectedFileIndex ? state.selectedHunk.hunkIndex : 0;
  const current = Math.max(0, Math.min(selected, count - 1)) + 1;
  return `hunk ${current}/${count}`;
}

const EXTENSION_FILETYPES: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".md": "markdown",
  ".css": "css",
  ".html": "html",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".sh": "bash",
  ".sql": "sql",
};

export function filetypeForFile(file: string): string {
  const dot = file.lastIndexOf(".");
  const ext = dot === -1 ? "" : file.slice(dot);
  return EXTENSION_FILETYPES[ext] ?? "text";
}

export function diffViewHeaderLabel(state: DiffViewState | undefined): string {
  if (!state) return "select a Review card";
  if (state.loading) return `${state.sourceLabel} · loading…`;
  if (state.error) return `${state.sourceLabel} · error: ${state.error}`;
  if (state.kind === "no-git") return `${state.sourceLabel} · no git evidence`;
  const fileWord = state.files.length === 1 ? "file" : "files";
  const dirty = state.dirtyAtDispatch ? " · includes pre-existing changes" : "";
  const capped = state.capped ? " · capped" : "";
  return `${state.sourceLabel} · ${state.files.length} ${fileWord}${dirty}${capped}`;
}

export function diffViewKeyHints(): string {
  return "↑/↓ files · ←/→ hunks in file · m mark reviewed · t split/inline · ? help · esc/q back";
}

export interface DiffViewTheme {
  text: ThemeColor;
  bright: ThemeColor;
  muted: ThemeColor;
  dim: ThemeColor;
  border: ThemeColor;
  panel: ThemeColor;
  panelRaised: ThemeColor;
  laneDone: ThemeColor;
  laneError: ThemeColor;
  boxBg: (color: ThemeColor) => Record<string, unknown>;
}

function fileRow(
  ui: OpenTui,
  theme: DiffViewTheme,
  file: DiffFile,
  selected: boolean,
  reviewed: boolean,
): VChild {
  const nameColor = reviewed ? theme.dim : selected ? theme.bright : theme.text;
  const namePrefix = selected ? "▸ " : "  ";
  const name = `${namePrefix}${truncateText(file.file, DIFF_FILE_COLUMN_WIDTH - namePrefix.length - 2)}`;
  const additions = truncateText(`+${file.additions}`, 7);
  const deletions = truncateText(`-${file.deletions}`, 7);
  return ui.Box(
    {
      width: "100%",
      height: DIFF_FILE_ROW_HEIGHT,
      flexDirection: "column",
      flexShrink: 0,
      ...theme.boxBg(selected ? theme.panelRaised : theme.panel),
    },
    ui.Text({
      content: name,
      fg: nameColor,
      width: "100%",
      height: 1,
      truncate: true,
    }),
    ui.Box(
      { width: "100%", flexDirection: "row", height: 1 },
      ui.Text({ content: additions, fg: reviewed ? theme.dim : theme.laneDone, height: 1, width: 7, truncate: true }),
      ui.Text({ content: deletions, fg: reviewed ? theme.dim : theme.laneError, height: 1, width: 7, truncate: true }),
      ui.Box({ flexGrow: 1 }),
      reviewed ? ui.Text({ content: "✓", fg: theme.dim, height: 1, width: 1 }) : ui.Box({ width: 1 }),
    ),
  );
}

function fileListFillerRow(ui: OpenTui, theme: DiffViewTheme): VChild {
  return ui.Box({ width: "100%", height: DIFF_FILE_ROW_HEIGHT, flexShrink: 0, ...theme.boxBg(theme.panel) });
}

function fullWidthMessage(ui: OpenTui, theme: DiffViewTheme, content: string): VChild {
  return ui.Box(
    { flexGrow: 1, width: "100%", alignItems: "center", justifyContent: "center", ...theme.boxBg(theme.panel) },
    ui.Text({ content, fg: theme.muted }),
  );
}

/**
 * Builds the diff view's main content area (file column + patch pane). Callers
 * (index.ts) wrap this with the shared header/command-strip chrome, exactly
 * like every other non-board view.
 */
export function renderDiffView(
  ui: OpenTui,
  theme: DiffViewTheme,
  scrollState: Record<string, number>,
  state: DiffViewState | undefined,
  patchPaneWidth: number,
  visibleFileRows = 12,
): VChild {
  if (!state) return fullWidthMessage(ui, theme, "Select a Review card and press v to view its diff.");
  if (state.loading) return fullWidthMessage(ui, theme, "Loading diff…");
  if (state.error) return fullWidthMessage(ui, theme, `Failed to load diff: ${state.error}`);
  if (state.kind === "no-git") return fullWidthMessage(ui, theme, state.noGitReason || "No git evidence for this task.");
  if (state.files.length === 0) return fullWidthMessage(ui, theme, "No changes.");
  void scrollState;

  const selectedFile = state.files[state.selectedFileIndex];
  const reviewed = selectedFile ? isFileReviewed(state, selectedFile.file) : false;
  const view = effectiveDiffView(state, patchPaneWidth);

  const window = diffFileListWindow(state.selectedFileIndex, state.files.length, visibleFileRows);
  const visibleFiles = state.files.slice(window.offset, window.offset + window.capacity);
  const fillerCount = Math.max(0, window.capacity - visibleFiles.length);
  const fileList = ui.Box(
    {
      id: DIFF_FILE_LIST_SCROLL_ID,
      width: DIFF_FILE_COLUMN_WIDTH,
      height: "100%",
      minHeight: 0,
      flexShrink: 0,
      flexDirection: "column",
      border: true,
      borderStyle: "single",
      borderColor: theme.border,
      overflow: "hidden",
      ...theme.boxBg(theme.panel),
    },
    ui.Text({
      content: `files ↑${window.hiddenAbove} ↓${window.hiddenBelow}`,
      fg: theme.muted,
      width: "100%",
      height: 1,
      truncate: true,
    }),
    ...visibleFiles.map((file, index) =>
      fileRow(ui, theme, file, window.offset + index === state.selectedFileIndex, isFileReviewed(state, file.file)),
    ),
    ...Array.from({ length: fillerCount }, () => fileListFillerRow(ui, theme)),
  );

  const patchHeader = ui.Box(
    { width: "100%", flexDirection: "row", height: 1, flexShrink: 0 },
    ui.Text({
      content: selectedFile ? selectedFile.file : "",
      fg: reviewed ? theme.dim : theme.text,
      flexGrow: 1,
      truncate: true,
      height: 1,
    }),
    ui.Text({ content: `${diffHunkPositionLabel(state)} · `, fg: theme.muted, height: 1 }),
    ui.Text({ content: view === "split" ? "split" : "inline", fg: theme.muted, height: 1 }),
  );

  const renderPatch = selectedFile ? diffPatchForRender(state, selectedFile) : undefined;
  const patchBody: VChild = renderPatch
    ? ui.h(ui.DiffRenderable, {
        id: DIFF_PATCH_SCROLL_ID,
        diff: renderPatch,
        view,
        filetype: reviewed ? "text" : filetypeForFile(selectedFile.file),
        showLineNumbers: true,
        syncScroll: true,
        wrapMode: view === "split" ? "none" : "char",
        fg: reviewed ? theme.dim : theme.text,
        width: "100%",
        height: "100%",
        flexGrow: 1,
        flexShrink: 1,
        minHeight: 0,
      })
    : ui.Text({ content: "No patch available for this file.", fg: theme.muted });

  const patchPane = ui.Box(
    {
      flexGrow: 1,
      minWidth: 0,
      minHeight: 0,
      height: "100%",
      flexShrink: 1,
      flexDirection: "column",
      border: true,
      borderStyle: "single",
      borderColor: theme.border,
      overflow: "hidden",
      ...theme.boxBg(theme.panel),
    },
    patchHeader,
    patchBody,
  );

  return ui.Box(
    { flexGrow: 1, width: "100%", height: "100%", minHeight: 0, flexDirection: "row", gap: 1, ...theme.boxBg(theme.panel) },
    fileList,
    patchPane,
  );
}
