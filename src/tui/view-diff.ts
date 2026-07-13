/**
 * TUI full-screen diff view (Review cards only). State/logic here is pure and
 * OpenTUI-agnostic except for `renderViewDiff`, which builds a VChild tree the
 * same way index.ts's render functions do. Keeping the two separate lets the
 * navigation/selection logic be unit tested without a terminal or fixture UI.
 */
import type { RGBA, VChild } from "@opentui/core";
import { truncateText } from "./model";
import type { DiffFile, DiffResponse, Task, WorktreeCommitStatus } from "../shared";

type OpenTui = typeof import("@opentui/core");
type ThemeColor = string | RGBA;

/** Narrow file-selection column width, matching OpenCode's own diff-viewer layout constant. */
export const DIFF_FILE_COLUMN_WIDTH = 32;
/** Every file-list entry is exactly two terminal rows: filename, then stats/marker. */
export const DIFF_FILE_ROW_HEIGHT = 2;
/** Legacy threshold retained for callers; View Diff no longer auto-collapses below it. */
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
export interface ViewDiffState {
  taskId: string;
  sourceLabel: string;
  /** Done-card evidence is historical and must never expose edit/commit actions. */
  historical: boolean;
  dirtyAtDispatch: boolean;
  loading: boolean;
  error?: string;
  kind?: "diff" | "no-git";
  noGitReason?: string;
  capped: boolean;
  files: DiffFile[];
  selectedFileIndex: number;
  fileSelectionLocked: boolean;
  selectedHunk?: SelectedHunk;
  reviewedFiles: Set<string>;
  viewOverride?: DiffPatchView;
  commitStatus?: WorktreeCommitStatus;
  /** Absolute path of the tree the diff was computed against (worktree or in-place dir), from
   * the diff response's `root`. Undefined when the server didn't send one — callers (the `e`
   * open-in-editor wiring) must treat a missing root as blocked, never guess a path. */
  root?: string;
}

/** Diff-source label shown in the header, derived from how the task's session ran. */
export function diffSourceLabel(task: Pick<Task, "harness" | "isolation">): string {
  if (task.harness && task.harness !== "opencode") return "harness diff";
  if (task.isolation === "worktree") return "worktree diff";
  return "working tree diff";
}

/** `v` opens current Review evidence or historical Done evidence for agent cards. */
export function canOpenViewDiff(task: Pick<Task, "column" | "type"> | undefined): boolean {
  return Boolean(task) && (task!.column === "review" || task!.column === "done") && task!.type !== "manual";
}

export function createLoadingViewDiffState(task: Task): ViewDiffState {
  return {
    taskId: task.id,
    sourceLabel: diffSourceLabel(task),
    historical: task.column === "done",
    dirtyAtDispatch: task.dirtyAtDispatch,
    loading: true,
    capped: false,
    files: [],
    selectedFileIndex: 0,
    fileSelectionLocked: false,
    reviewedFiles: new Set(),
  };
}

export function applyDiffResponse(state: ViewDiffState, response: DiffResponse): ViewDiffState {
  if (response.kind === "no-git") {
    return { ...state, loading: false, error: undefined, kind: "no-git", noGitReason: response.reason, files: [], root: undefined };
  }
  return {
    ...state,
    loading: false,
    error: undefined,
    kind: "diff",
    capped: response.capped,
    files: response.files,
    selectedFileIndex: 0,
    fileSelectionLocked: false,
    selectedHunk: undefined,
    root: response.root,
  };
}

export type DiffFileCommitState = "committed" | "dirty" | undefined;

export function diffFileCommitState(status: WorktreeCommitStatus | undefined, file: string): DiffFileCommitState {
  if (!status) return undefined;
  const committed = status.committedFiles.includes(file);
  const dirty = status.uncommittedFiles.includes(file);
  if (dirty && committed) return "dirty";
  if (committed) return "committed";
  return undefined;
}

export function applyDiffError(state: ViewDiffState, message: string): ViewDiffState {
  return { ...state, loading: false, error: message };
}

export function selectFileIndex(state: ViewDiffState, index: number): ViewDiffState {
  if (state.files.length === 0) return state;
  const clamped = Math.max(0, Math.min(index, state.files.length - 1));
  if (clamped === state.selectedFileIndex) return state;
  return { ...state, selectedFileIndex: clamped, fileSelectionLocked: false, selectedHunk: undefined };
}

export function moveFileSelection(state: ViewDiffState, delta: number): ViewDiffState {
  if (state.files.length === 0) return state;
  const next = (state.selectedFileIndex + delta + state.files.length) % state.files.length;
  return { ...state, selectedFileIndex: next, fileSelectionLocked: false, selectedHunk: undefined };
}

export function toggleFileSelectionLock(state: ViewDiffState): ViewDiffState {
  if (state.files.length === 0 || state.kind !== "diff") return state;
  return { ...state, fileSelectionLocked: !state.fileSelectionLocked };
}

export function toggleFileReviewed(state: ViewDiffState): ViewDiffState {
  const file = state.files[state.selectedFileIndex];
  if (!file) return state;
  const next = new Set(state.reviewedFiles);
  if (next.has(file.file)) next.delete(file.file);
  else next.add(file.file);
  return { ...state, reviewedFiles: next };
}

export function isFileReviewed(state: ViewDiffState, file: string): boolean {
  return state.reviewedFiles.has(file);
}

export function splitAvailable(patchPaneWidth: number): boolean {
  void patchPaneWidth;
  return true;
}

export function effectiveViewDiff(state: ViewDiffState, patchPaneWidth: number): DiffPatchView {
  void patchPaneWidth;
  return state.viewOverride ?? "split";
}

export function toggleViewOverride(state: ViewDiffState, patchPaneWidth: number): ViewDiffState {
  void patchPaneWidth;
  const current = effectiveViewDiff(state, patchPaneWidth);
  return { ...state, viewOverride: current === "split" ? "unified" : "split" };
}

/** 0-based line indices of `@@` hunk headers within a unified patch's text. */
export function hunkLineOffsets(patch: string | undefined): number[] {
  if (!patch) return [];
  return patch.split("\n").flatMap((line, index) => (line.startsWith("@@") ? [index] : []));
}

/** Steps to the next/previous hunk within the currently selected file only. */
export function moveHunkSelection(state: ViewDiffState, delta: 1 | -1): ViewDiffState {
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
export function diffPatchScrollTop(state: ViewDiffState): number {
  const file = state.files[state.selectedFileIndex];
  if (!file || !state.selectedHunk || state.selectedHunk.fileIndex !== state.selectedFileIndex) return 0;
  const offsets = hunkLineOffsets(file.patch);
  return offsets[state.selectedHunk.hunkIndex] ?? 0;
}

/** Legacy rotation-model clamp (bounds a scrollTop to the scrollable body-line count).
 * Retained for the pure-string helpers/tests below; the live diff pane now scrolls the
 * DiffRenderable's own viewport (see `clampFullPatchScrollTop`).
 */
export function clampDiffPatchScrollTop(patch: string | undefined, value: number): number {
  if (!patch) return 0;
  const max = Math.max(0, countScrollablePatchLines(patch) - 1);
  return Math.max(0, Math.min(Math.trunc(value), max));
}

/** Clamp a full-patch scrollTop — a row index into the entire patch text, header lines
 * included — into `[0, lineCount-1]`. This is the unit the DiffRenderable's native
 * `scrollY` uses now that the pane renders the whole patch and scrolls its own viewport
 * (the wiring layer re-clamps against the live `maxScrollY`, which also accounts for wrap).
 */
export function clampFullPatchScrollTop(patch: string | undefined, value: number): number {
  if (!patch) return 0;
  const max = Math.max(0, patch.split("\n").length - 1);
  return Math.max(0, Math.min(Math.trunc(value), max));
}

/** Maps a full-patch scrollTop to the body offset *within* `hunkIndex`, so the editor-jump
 * layer can keep passing `editorTargetForSelection` a per-hunk body offset even though the
 * pane now tracks a whole-patch scroll position. Rows at or above the hunk's first body line
 * resolve to 0; `editorTargetForSelection` clamps the upper end into the hunk's own range.
 */
export function fullPatchHunkBodyOffset(
  patch: string | undefined,
  hunkIndex: number,
  scrollTop: number,
): number {
  const offsets = hunkLineOffsets(patch);
  const headerRow = offsets[hunkIndex];
  if (headerRow === undefined) return 0;
  return Math.max(0, Math.trunc(scrollTop) - (headerRow + 1));
}

function scrollPatchText(patch: string, scrollTop: number): string {
  const offset = clampDiffPatchScrollTop(patch, scrollTop);
  if (offset === 0) return patch;
  const lines = patch.split("\n");
  return [...lines.slice(offset), ...Array.from({ length: offset }, () => "")].join("\n");
}

/** Shared by `diffPatchForRender` and `editorTargetForSelection`: resolves which hunk is
 * "at the top" for a given scrollTop, and how far into that hunk's body the scroll has
 * gone, without duplicating the `patchScrollTarget`/`clampHunkBodyOffset` math twice.
 */
function hunkRenderTarget(
  state: ViewDiffState,
  sections: PatchSections,
  scrollTop: number,
): { hunkIndex: number; bodyOffset: number } {
  const selectedHunkIndex = state.selectedHunk?.fileIndex === state.selectedFileIndex
    ? state.selectedHunk.hunkIndex
    : undefined;
  return selectedHunkIndex === undefined
    ? patchScrollTarget(sections, scrollTop)
    : { hunkIndex: selectedHunkIndex, bodyOffset: clampHunkBodyOffset(sections.hunks[selectedHunkIndex], scrollTop) };
}

export function diffPatchForRender(state: ViewDiffState, file: DiffFile, scrollTop = 0): string | undefined {
  if (!file.patch) return undefined;
  const sections = splitPatchIntoHunkSections(file.patch);
  if (!sections) return scrollPatchText(file.patch, scrollTop);

  const target = hunkRenderTarget(state, sections, scrollTop);
  return renderPatchSections(sections, target.hunkIndex, target.bodyOffset);
}

interface PatchHunkSection {
  header: string;
  body: string[];
}

interface PatchSections {
  metadata: string[];
  hunks: PatchHunkSection[];
}

function splitPatchIntoHunkSections(patch: string): PatchSections | undefined {
  const lines = patch.split("\n");
  const hunks: PatchHunkSection[] = [];
  const metadata: string[] = [];

  for (const line of lines) {
    if (line.startsWith("@@")) {
      hunks.push({ header: line, body: [] });
    } else if (hunks.length === 0) {
      metadata.push(line);
    } else {
      hunks[hunks.length - 1].body.push(line);
    }
  }

  return hunks.length === 0 ? undefined : { metadata, hunks };
}

function countScrollablePatchLines(patch: string): number {
  const sections = splitPatchIntoHunkSections(patch);
  if (!sections) return patch.split("\n").length;
  return sections.hunks.reduce((total, hunk) => total + hunk.body.length, 0);
}

function clampHunkBodyOffset(hunk: PatchHunkSection | undefined, value: number): number {
  if (!hunk || hunk.body.length === 0) return 0;
  return Math.max(0, Math.min(Math.trunc(value), hunk.body.length - 1));
}

function patchScrollTarget(sections: PatchSections, scrollTop: number): { hunkIndex: number; bodyOffset: number } {
  let remaining = clampDiffPatchScrollTop(renderPatchSections(sections, 0, 0), scrollTop);
  for (let index = 0; index < sections.hunks.length; index++) {
    const hunk = sections.hunks[index];
    if (remaining < hunk.body.length) return { hunkIndex: index, bodyOffset: remaining };
    remaining -= hunk.body.length;
  }
  return { hunkIndex: Math.max(0, sections.hunks.length - 1), bodyOffset: 0 };
}

function renderPatchSections(sections: PatchSections, hunkIndex: number, bodyOffset: number): string {
  const clampedHunkIndex = Math.max(0, Math.min(Math.trunc(hunkIndex), sections.hunks.length - 1));
  const hunkOrder = [...sections.hunks.slice(clampedHunkIndex), ...sections.hunks.slice(0, clampedHunkIndex)];
  const lines = [...sections.metadata];
  for (const [index, hunk] of hunkOrder.entries()) {
    const offset = index === 0 ? clampHunkBodyOffset(hunk, bodyOffset) : 0;
    lines.push(hunk.header, ...hunk.body.slice(offset), ...hunk.body.slice(0, offset));
  }
  return lines.join("\n");
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

export function diffHunkPositionLabel(state: ViewDiffState): string {
  const file = state.files[state.selectedFileIndex];
  const count = hunkLineOffsets(file?.patch).length;
  if (count === 0) return "0 hunks";
  if (count === 1) return "1 hunk";
  const selected = state.selectedHunk?.fileIndex === state.selectedFileIndex ? state.selectedHunk.hunkIndex : 0;
  const current = Math.max(0, Math.min(selected, count - 1)) + 1;
  return `hunk ${current}/${count}`;
}

/** Result of resolving where `e` should open an editor for the current View Diff selection.
 * Deliberately ignorant of filesystem roots, $EDITOR, or remote-board guards — a separate
 * wiring layer (src/tui/index.ts + src/tui/editor-command.ts) joins `relPath` to the diff
 * response's `root` and applies those guards.
 */
export type EditorJumpTarget = { ok: true; relPath: string; line: number } | { ok: false; reason: string };

/** Parses a unified-diff hunk header (`@@ -a,b +c,d @@` or the no-comma `@@ -a +c @@` form)
 * and returns the new-file start line `c`. Returns undefined if the header doesn't match.
 */
function newFileStartLine(header: string): number | undefined {
  const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
  if (!match) return undefined;
  const line = Number.parseInt(match[1], 10);
  return Number.isFinite(line) ? line : undefined;
}

/** Resolves the editor jump target (repo-relative path + 1-based line) for whatever the
 * View Diff is currently showing. Never throws — any ViewDiffState shape (loading, error,
 * no-git, no files) resolves to `{ ok: false }` instead.
 *
 * `liveScrollTop`, when provided, is the TUI wiring layer's actual current patch scrollTop
 * (index.ts's `detailScrollTop[DIFF_PATCH_SCROLL_ID]`) — the real live-owned position the
 * renderer is showing on screen right now. When omitted, this falls back to the state-only
 * approximation (`diffPatchScrollTop(state)`, the selected hunk's own raw header offset) so
 * existing state-only callers/tests keep their prior behavior unchanged.
 */
export function editorTargetForSelection(state: ViewDiffState, liveScrollTop?: number): EditorJumpTarget {
  if (state.kind !== "diff" || state.files.length === 0) return { ok: false, reason: "no file selected" };

  const file = state.files[state.selectedFileIndex];
  if (!file) return { ok: false, reason: "no file selected" };
  if (file.status === "deleted") return { ok: false, reason: "file was deleted in this diff" };

  if (!file.patch) return { ok: true, relPath: file.file, line: 1 };
  const sections = splitPatchIntoHunkSections(file.patch);
  if (!sections || sections.hunks.length === 0) return { ok: true, relPath: file.file, line: 1 };

  const selectedHunkIndex = state.selectedHunk?.fileIndex === state.selectedFileIndex
    ? state.selectedHunk.hunkIndex
    : undefined;
  const hunkIndex = selectedHunkIndex !== undefined
    ? Math.max(0, Math.min(selectedHunkIndex, sections.hunks.length - 1))
    : 0;
  const hunk = sections.hunks[hunkIndex];
  const startLine = newFileStartLine(hunk.header) ?? 1;

  // Locked-scroll mode: Up/Down scroll the patch body rather than moving file selection, so
  // the line the user is actually looking at can be past the hunk's own start line. The
  // renderer computes that live scroll position via `patchScrollTarget`/`clampHunkBodyOffset`
  // (see diffPatchForRender/hunkRenderTarget above), and the TUI wiring layer owns the actual
  // scrollTop those need (index.ts's `detailScrollTop` map) — callers that have it pass it as
  // `liveScrollTop` so the jump line tracks exactly what's on screen. Callers without it (e.g.
  // pure-state unit tests) fall back to `diffPatchScrollTop(state)`, the selected hunk's own raw
  // header offset, which reproduces the renderer's math via the same `hunkRenderTarget` helper
  // and adds whatever body offset it resolves to (0 when no finer-grained position is known).
  // Counting patch body lines (including unchanged/deleted context lines) as new-file lines is
  // an approximation — exactness is not required for v1 (see editor-open-plan.md Phase 2).
  const bodyOffset = state.fileSelectionLocked
    ? hunkRenderTarget(state, sections, liveScrollTop ?? diffPatchScrollTop(state)).bodyOffset
    : 0;

  return { ok: true, relPath: file.file, line: startLine + bodyOffset };
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

export function viewDiffHeaderLabel(state: ViewDiffState | undefined): string {
  if (!state) return "select a Review or Done card";
  const sourceLabel = state.historical ? `historical ${state.sourceLabel}` : state.sourceLabel;
  if (state.loading) return `${sourceLabel} · loading…`;
  if (state.error) return `${sourceLabel} · error: ${state.error}`;
  if (state.kind === "no-git") return `${sourceLabel} · no git evidence`;
  const fileWord = state.files.length === 1 ? "file" : "files";
  const dirty = state.dirtyAtDispatch ? " · includes pre-existing changes" : "";
  const capped = state.capped ? " · capped" : "";
  return `${sourceLabel} · ${state.files.length} ${fileWord}${dirty}${capped}`;
}

export function viewDiffKeyHints(state?: ViewDiffState): string {
  const vertical = state?.fileSelectionLocked ? "↑/↓ scroll · enter files" : "↑/↓ files · enter scroll";
  const mutableActions = state?.historical ? "" : " · c commit · e edit";
  return `${vertical} · ←/→ hunks · a ancestor · m mark · t split/inline${mutableActions} · r refresh · b back · q quit`;
}

export interface ViewDiffTheme {
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
  theme: ViewDiffTheme,
  file: DiffFile,
  selected: boolean,
  reviewed: boolean,
  commitState: DiffFileCommitState = undefined,
): VChild {
  const nameColor = reviewed ? theme.dim : selected ? theme.bright : theme.text;
  const namePrefix = selected ? "▸ " : "  ";
  const name = `${namePrefix}${truncateText(file.file, DIFF_FILE_COLUMN_WIDTH - namePrefix.length - 2)}`;
  const additions = truncateText(`+${file.additions}`, 7);
  const deletions = truncateText(`-${file.deletions}`, 7);
  const committed = commitState === "committed";
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
      committed
        ? ui.Text({ content: "committed", fg: theme.dim, height: 1, width: 14, truncate: true })
        : ui.Text({ content: additions, fg: reviewed ? theme.dim : theme.laneDone, height: 1, width: 7, truncate: true }),
      committed
        ? ui.Box({ width: 0 })
        : ui.Text({ content: deletions, fg: reviewed ? theme.dim : theme.laneError, height: 1, width: 7, truncate: true }),
      commitState === "dirty" ? ui.Text({ content: "dirty", fg: theme.muted, height: 1, width: 6, truncate: true }) : ui.Box({ width: 0 }),
      ui.Box({ flexGrow: 1 }),
      reviewed ? ui.Text({ content: "✓", fg: theme.dim, height: 1, width: 1 }) : ui.Box({ width: 1 }),
    ),
  );
}

function fileListFillerRow(ui: OpenTui, theme: ViewDiffTheme): VChild {
  return ui.Box({ width: "100%", height: DIFF_FILE_ROW_HEIGHT, flexShrink: 0, ...theme.boxBg(theme.panel) });
}

function fullWidthMessage(ui: OpenTui, theme: ViewDiffTheme, content: string): VChild {
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
export function renderViewDiff(
  ui: OpenTui,
  theme: ViewDiffTheme,
  scrollState: Record<string, number>,
  state: ViewDiffState | undefined,
  patchPaneWidth: number,
  visibleFileRows = 12,
): VChild {
  if (!state) return fullWidthMessage(ui, theme, "Select a Review card and press v to view its diff.");
  if (state.loading) return fullWidthMessage(ui, theme, "Loading diff…");
  if (state.error) return fullWidthMessage(ui, theme, `Failed to load diff: ${state.error}`);
  if (state.kind === "no-git") return fullWidthMessage(ui, theme, state.noGitReason || "No git evidence for this task.");
  if (state.files.length === 0) return fullWidthMessage(ui, theme, "No changes.");
  const selectedFile = state.files[state.selectedFileIndex];
  const reviewed = selectedFile ? isFileReviewed(state, selectedFile.file) : false;
  const view = effectiveViewDiff(state, patchPaneWidth);

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
      fileRow(
        ui,
        theme,
        file,
        window.offset + index === state.selectedFileIndex,
        isFileReviewed(state, file.file),
        diffFileCommitState(state.commitStatus, file.file),
      ),
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

  // The pane now renders the whole patch and lets DiffRenderable scroll its own viewport,
  // so the line-number gutter (which the component derives from the real hunk headers) stays
  // pinned to its code. Scroll position is applied to the live renderable by the wiring layer
  // (src/tui/index.ts) after mount, not by rewriting this string. `scrollState` is retained in
  // the signature for callers/tests; it no longer transforms the rendered content.
  void scrollState;
  const renderPatch = selectedFile?.patch ? selectedFile.patch : undefined;
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
