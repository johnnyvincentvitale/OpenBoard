import { describe, expect, it } from "vitest";
import {
  DIFF_FILE_COLUMN_WIDTH,
  DIFF_FILE_LIST_SCROLL_ID,
  DIFF_MIN_SPLIT_WIDTH,
  DIFF_PATCH_SCROLL_ID,
  applyDiffError,
  applyDiffResponse,
  canOpenDiffView,
  createLoadingDiffViewState,
  diffPatchScrollTop,
  diffSourceLabel,
  diffViewHeaderLabel,
  effectiveDiffView,
  filetypeForFile,
  hunkLineOffsets,
  isFileReviewed,
  moveFileSelection,
  moveHunkSelection,
  renderDiffView,
  selectFileIndex,
  splitAvailable,
  toggleFileReviewed,
  toggleViewOverride,
  type DiffViewState,
  type DiffViewTheme,
} from "../../src/tui/diff-view";
import type { DiffFile, DiffResponse, Task } from "../../src/shared";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "task-1",
    description: "",
    directory: "/repo",
    column: "review",
    position: 0,
    runState: "idle",
    baseCommit: "abc123",
    dirtyAtDispatch: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function diffFile(overrides: Partial<DiffFile> = {}): DiffFile {
  return {
    file: "src/a.ts",
    additions: 1,
    deletions: 0,
    status: "modified",
    patch: "@@ -1,1 +1,1 @@\n-old\n+new\n",
    ...overrides,
  };
}

describe("diff view entry gate", () => {
  it("only allows opening the diff view for Review-column agent cards", () => {
    expect(canOpenDiffView(task({ column: "review" }))).toBe(true);
    expect(canOpenDiffView(task({ column: "todo" }))).toBe(false);
    expect(canOpenDiffView(task({ column: "in_progress" }))).toBe(false);
    expect(canOpenDiffView(task({ column: "done" }))).toBe(false);
    expect(canOpenDiffView(task({ column: "review", type: "manual" }))).toBe(false);
    expect(canOpenDiffView(undefined)).toBe(false);
  });
});

describe("diff source label", () => {
  it("labels by harness/isolation", () => {
    expect(diffSourceLabel(task({ harness: "claude-code" }))).toBe("harness diff");
    expect(diffSourceLabel(task({ harness: "opencode", isolation: "worktree" }))).toBe("worktree diff");
    expect(diffSourceLabel(task({ harness: "opencode", isolation: "in-place" }))).toBe("working tree diff");
  });
});

describe("diff response application", () => {
  it("populates files from a diff response", () => {
    const loading = createLoadingDiffViewState(task());
    expect(loading.loading).toBe(true);
    expect(loading.sourceLabel).toBe("working tree diff");

    const response: DiffResponse = { kind: "diff", files: [diffFile(), diffFile({ file: "src/b.ts" })], capped: false };
    const next = applyDiffResponse(loading, response);
    expect(next.loading).toBe(false);
    expect(next.kind).toBe("diff");
    expect(next.capped).toBe(false);
    expect(next.files).toHaveLength(2);
    expect(next.selectedFileIndex).toBe(0);
  });

  it("carries the no-git sentinel as a readable reason, not an error", () => {
    const loading = createLoadingDiffViewState(task());
    const response: DiffResponse = { kind: "no-git", reason: "not a git repository" };
    const next = applyDiffResponse(loading, response);
    expect(next.kind).toBe("no-git");
    expect(next.noGitReason).toBe("not a git repository");
    expect(next.error).toBeUndefined();
  });

  it("records fetch failures as an error state", () => {
    const loading = createLoadingDiffViewState(task());
    const next = applyDiffError(loading, "network down");
    expect(next.loading).toBe(false);
    expect(next.error).toBe("network down");
  });
});

describe("diff view header label", () => {
  it("shows source, file count, and the dirty-at-dispatch honesty label", () => {
    const dirty = applyDiffResponse(
      createLoadingDiffViewState(task({ dirtyAtDispatch: true })),
      { kind: "diff", files: [diffFile()], capped: false },
    );
    expect(diffViewHeaderLabel(dirty)).toBe("working tree diff · 1 file · includes pre-existing changes");

    const clean = applyDiffResponse(
      createLoadingDiffViewState(task({ dirtyAtDispatch: false })),
      { kind: "diff", files: [diffFile(), diffFile({ file: "b.ts" })], capped: false },
    );
    expect(diffViewHeaderLabel(clean)).toBe("working tree diff · 2 files");
    expect(diffViewHeaderLabel(undefined)).toContain("select a Review card");
  });

  it("surfaces capped server diffs in the header label", () => {
    const capped = applyDiffResponse(
      createLoadingDiffViewState(task()),
      { kind: "diff", files: [diffFile()], capped: true },
    );
    expect(diffViewHeaderLabel(capped)).toBe("working tree diff · 1 file · capped");
  });
});

describe("diff file navigation", () => {
  const files = [diffFile({ file: "a.ts" }), diffFile({ file: "b.ts" }), diffFile({ file: "c.ts" })];
  const base: DiffViewState = {
    ...createLoadingDiffViewState(task()),
    loading: false,
    kind: "diff",
    capped: false,
    files,
    selectedFileIndex: 0,
  };

  it("wraps forward and backward across files", () => {
    expect(moveFileSelection(base, 1).selectedFileIndex).toBe(1);
    expect(moveFileSelection(base, -1).selectedFileIndex).toBe(2);
    const atEnd = { ...base, selectedFileIndex: 2 };
    expect(moveFileSelection(atEnd, 1).selectedFileIndex).toBe(0);
  });

  it("clamps direct selection and clears the selected hunk on jump-to-file", () => {
    const withHunk = { ...base, selectedHunk: { fileIndex: 0, hunkIndex: 0 } };
    const jumped = selectFileIndex(withHunk, 5);
    expect(jumped.selectedFileIndex).toBe(2);
    expect(jumped.selectedHunk).toBeUndefined();
  });

  it("toggles mark-reviewed for the selected file only", () => {
    const reviewed = toggleFileReviewed(base);
    expect(isFileReviewed(reviewed, "a.ts")).toBe(true);
    expect(isFileReviewed(reviewed, "b.ts")).toBe(false);
    const unreviewed = toggleFileReviewed(reviewed);
    expect(isFileReviewed(unreviewed, "a.ts")).toBe(false);
  });
});

describe("diff hunk navigation", () => {
  it("finds @@ hunk header line offsets in a unified patch", () => {
    const patch = "line0\n@@ -1,1 +1,1 @@\nline2\n@@ -5,1 +5,1 @@\nline4\n";
    expect(hunkLineOffsets(patch)).toEqual([1, 3]);
    expect(hunkLineOffsets(undefined)).toEqual([]);
  });

  it("keeps hunk navigation within the currently selected file", () => {
    const files = [
      diffFile({ file: "a.ts", patch: "@@ -1,1 +1,1 @@\nx\n@@ -9,1 +9,1 @@\nz\n" }),
      diffFile({ file: "b.ts", patch: "@@ -1,1 +1,1 @@\ny\n@@ -9,1 +9,1 @@\nz\n" }),
    ];
    let state: DiffViewState = { ...createLoadingDiffViewState(task()), loading: false, kind: "diff", files, selectedFileIndex: 0 };

    state = moveHunkSelection(state, 1);
    expect(state.selectedHunk).toEqual({ fileIndex: 0, hunkIndex: 0 });

    state = moveHunkSelection(state, 1);
    expect(state.selectedFileIndex).toBe(0);
    expect(state.selectedHunk).toEqual({ fileIndex: 0, hunkIndex: 1 });

    // Wraps within the selected file instead of jumping to b.ts.
    state = moveHunkSelection(state, 1);
    expect(state.selectedFileIndex).toBe(0);
    expect(state.selectedHunk).toEqual({ fileIndex: 0, hunkIndex: 0 });

    state = moveHunkSelection(state, -1);
    expect(state.selectedFileIndex).toBe(0);
    expect(state.selectedHunk).toEqual({ fileIndex: 0, hunkIndex: 1 });
  });

  it("does not change files for one-hunk-per-file diffs", () => {
    const files = [
      diffFile({ file: "a.ts", patch: "@@ -1,1 +1,1 @@\nx\n" }),
      diffFile({ file: "b.ts", patch: "@@ -1,1 +1,1 @@\ny\n" }),
    ];
    let state: DiffViewState = { ...createLoadingDiffViewState(task()), loading: false, kind: "diff", files, selectedFileIndex: 0 };

    state = moveHunkSelection(state, 1);
    expect(state.selectedFileIndex).toBe(0);
    expect(state.selectedHunk).toEqual({ fileIndex: 0, hunkIndex: 0 });

    state = moveHunkSelection(state, 1);
    expect(state.selectedFileIndex).toBe(0);
    expect(state.selectedHunk).toEqual({ fileIndex: 0, hunkIndex: 0 });

    state = { ...state, selectedFileIndex: 1, selectedHunk: undefined };
    state = moveHunkSelection(state, -1);
    expect(state.selectedFileIndex).toBe(1);
    expect(state.selectedHunk).toEqual({ fileIndex: 1, hunkIndex: 0 });
  });

  it("computes the patch scrollTop target for the selected hunk", () => {
    const files = [diffFile({ patch: "line0\n@@ -1,1 +1,1 @@\nline2\n@@ -5,1 +5,1 @@\nline4\n" })];
    let state: DiffViewState = { ...createLoadingDiffViewState(task()), loading: false, kind: "diff", files, selectedFileIndex: 0 };
    expect(diffPatchScrollTop(state)).toBe(0);

    state = moveHunkSelection(state, 1);
    expect(diffPatchScrollTop(state)).toBe(1);

    state = moveHunkSelection(state, 1);
    expect(diffPatchScrollTop(state)).toBe(3);
  });
});

describe("split/unified view decision", () => {
  const files = [diffFile()];
  const base: DiffViewState = { ...createLoadingDiffViewState(task()), loading: false, kind: "diff", files, selectedFileIndex: 0 };

  it("defaults to split at or above the min width, unified below it", () => {
    expect(splitAvailable(DIFF_MIN_SPLIT_WIDTH)).toBe(true);
    expect(splitAvailable(DIFF_MIN_SPLIT_WIDTH - 1)).toBe(false);
    expect(effectiveDiffView(base, DIFF_MIN_SPLIT_WIDTH)).toBe("split");
    expect(effectiveDiffView(base, DIFF_MIN_SPLIT_WIDTH - 1)).toBe("unified");
  });

  it("lets the manual toggle flip split/unified only when width allows it", () => {
    const toggled = toggleViewOverride(base, DIFF_MIN_SPLIT_WIDTH);
    expect(effectiveDiffView(toggled, DIFF_MIN_SPLIT_WIDTH)).toBe("unified");
    expect(toggleViewOverride(base, DIFF_MIN_SPLIT_WIDTH - 1)).toBe(base);
  });
});

describe("filetype detection", () => {
  it("maps common extensions and falls back to plain text", () => {
    expect(filetypeForFile("src/a.ts")).toBe("typescript");
    expect(filetypeForFile("README.md")).toBe("markdown");
    expect(filetypeForFile("Makefile")).toBe("text");
  });
});

function fakeTheme(): DiffViewTheme {
  return {
    text: "text",
    bright: "bright",
    muted: "muted",
    dim: "dim",
    border: "border",
    panel: "panel",
    panelRaised: "panelRaised",
    laneDone: "laneDone",
    laneError: "laneError",
    boxBg: (color) => ({ backgroundColor: color }),
  };
}

function fakeUi() {
  return {
    Box: (props: Record<string, unknown>, ...children: unknown[]) => ({ type: "Box", props, children }),
    ScrollBox: (props: Record<string, unknown>, ...children: unknown[]) => ({ type: "ScrollBox", props, children }),
    Text: (props: Record<string, unknown>) => ({ type: "Text", props, children: [] }),
    DiffRenderable: class {},
    h: (_type: unknown, props: Record<string, unknown>) => ({ type: "Diff", props, children: [] }),
  } as any;
}

function textOf(node: any): string {
  if (!node || typeof node !== "object") return "";
  const own = typeof node.props?.content === "string" ? node.props.content : "";
  return [own, ...(node.children ?? []).map(textOf)].filter(Boolean).join("\n");
}

function nodesByType(node: any, type: string): any[] {
  if (!node || typeof node !== "object") return [];
  const matches = node.type === type ? [node] : [];
  return [...matches, ...(node.children ?? []).flatMap((child: unknown) => nodesByType(child, type))];
}

describe("renderDiffView", () => {
  it("renders a readable message instead of crashing when there is no git evidence", () => {
    const state = applyDiffResponse(createLoadingDiffViewState(task()), {
      kind: "no-git",
      reason: "task directory is not a git repository",
    });
    const tree = renderDiffView(fakeUi(), fakeTheme(), {}, state, 200);
    expect(textOf(tree)).toContain("task directory is not a git repository");
    expect(nodesByType(tree, "Diff")).toHaveLength(0);
  });

  it("renders the file column and the selected file's patch via the Diff renderable", () => {
    const state = applyDiffResponse(createLoadingDiffViewState(task()), {
      kind: "diff",
      files: [diffFile({ file: "src/a.ts" }), diffFile({ file: "src/b.ts" })],
      capped: false,
    });
    const tree = renderDiffView(fakeUi(), fakeTheme(), {}, state, 200);
    expect(textOf(tree)).toContain("src/a.ts");
    expect(textOf(tree)).toContain("src/b.ts");
    const diffNodes = nodesByType(tree, "Diff");
    expect(diffNodes).toHaveLength(1);
    expect(diffNodes[0].props.view).toBe("split");
  });

  it("emits stable ScrollBox layout props for the file list and patch pane", () => {
    const state = applyDiffResponse(createLoadingDiffViewState(task()), {
      kind: "diff",
      files: [diffFile({ file: "src/a.ts" }), diffFile({ file: "src/b.ts" })],
      capped: false,
    });
    const tree = renderDiffView(fakeUi(), fakeTheme(), {}, state, 200);
    const scrollBoxes = nodesByType(tree, "ScrollBox");
    const fileList = scrollBoxes.find((node) => node.props.id === DIFF_FILE_LIST_SCROLL_ID);
    const patchPane = scrollBoxes.find((node) => node.props.id === DIFF_PATCH_SCROLL_ID);

    expect(fileList?.props).toMatchObject({
      width: DIFF_FILE_COLUMN_WIDTH,
      height: "100%",
      minHeight: 0,
      flexShrink: 0,
      scrollY: true,
      scrollX: false,
      stickyScroll: false,
    });
    expect(fileList?.props.contentOptions).toMatchObject({ flexDirection: "column" });
    expect(fileList?.props.viewportOptions).toBeDefined();
    expect(fileList?.props.wrapperOptions).toBeDefined();

    expect(patchPane?.props).toMatchObject({
      width: "100%",
      flexGrow: 1,
      flexShrink: 1,
      minHeight: 0,
      scrollY: true,
      scrollX: false,
      stickyScroll: false,
    });
    expect(patchPane?.props.contentOptions).toMatchObject({ flexDirection: "column" });
    expect(patchPane?.props.viewportOptions).toBeDefined();
    expect(patchPane?.props.wrapperOptions).toBeDefined();
  });

  it("falls back to unified below the split width threshold", () => {
    const state = applyDiffResponse(createLoadingDiffViewState(task()), {
      kind: "diff",
      files: [diffFile()],
      capped: false,
    });
    const tree = renderDiffView(fakeUi(), fakeTheme(), {}, state, 60);
    expect(nodesByType(tree, "Diff")[0].props.view).toBe("unified");
  });

  it("shows a loading message before the fetch resolves", () => {
    const tree = renderDiffView(fakeUi(), fakeTheme(), {}, createLoadingDiffViewState(task()), 200);
    expect(textOf(tree)).toContain("Loading diff");
  });

  it("shows a fallback message when no card has opened the view yet", () => {
    const tree = renderDiffView(fakeUi(), fakeTheme(), {}, undefined, 200);
    expect(textOf(tree)).toContain("Select a Review card");
  });
});
