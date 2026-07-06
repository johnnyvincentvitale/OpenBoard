import { describe, expect, it } from "vitest";
import {
  DIFF_FILE_COLUMN_WIDTH,
  DIFF_FILE_LIST_SCROLL_ID,
  DIFF_FILE_ROW_HEIGHT,
  DIFF_MIN_SPLIT_WIDTH,
  DIFF_PATCH_SCROLL_ID,
  applyDiffError,
  applyDiffResponse,
  canOpenDiffView,
  clampDiffPatchScrollTop,
  createLoadingDiffViewState,
  diffViewKeyHints,
  diffPatchScrollTop,
  diffPatchForRender,
  diffFileListWindow,
  diffHunkPositionLabel,
  diffSourceLabel,
  diffViewHeaderLabel,
  editorTargetForSelection,
  effectiveDiffView,
  filetypeForFile,
  hunkLineOffsets,
  isFileReviewed,
  moveFileSelection,
  moveHunkSelection,
  renderDiffView,
  selectFileIndex,
  splitAvailable,
  toggleFileSelectionLock,
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

  it("carries the diff response's root through for the editor-open wiring to use", () => {
    const loading = createLoadingDiffViewState(task());
    const response: DiffResponse = { kind: "diff", files: [diffFile()], capped: false, root: "/tmp/worktree-abc" };
    const next = applyDiffResponse(loading, response);
    expect(next.root).toBe("/tmp/worktree-abc");
  });

  it("clears root when the response has none (never guesses a path)", () => {
    const loading = createLoadingDiffViewState(task());
    const response: DiffResponse = { kind: "diff", files: [diffFile()], capped: false };
    const next = applyDiffResponse(loading, response);
    expect(next.root).toBeUndefined();
  });

  it("carries the no-git sentinel as a readable reason, not an error", () => {
    const loading = createLoadingDiffViewState(task());
    const response: DiffResponse = { kind: "no-git", reason: "not a git repository" };
    const next = applyDiffResponse(loading, response);
    expect(next.kind).toBe("no-git");
    expect(next.noGitReason).toBe("not a git repository");
    expect(next.error).toBeUndefined();
    expect(next.root).toBeUndefined();
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

  it("toggles between file selection and patch scrolling modes", () => {
    expect(base.fileSelectionLocked).toBe(false);
    const locked = toggleFileSelectionLock(base);
    expect(locked.fileSelectionLocked).toBe(true);
    expect(diffViewKeyHints(locked)).toContain("↑/↓ scroll · enter files");
    expect(diffViewKeyHints(base)).toContain("↑/↓ files · enter scroll");
    expect(diffViewKeyHints(locked)).toContain("e edit");
    expect(diffViewKeyHints(base)).toContain("e edit");
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

  it("rotates the rendered patch so the selected hunk is visibly at the top without resizing content", () => {
    const patch = "file header\n@@ -1,1 +1,1 @@\n-old1\n+new1\n@@ -9,1 +9,1 @@\n-old2\n+new2\n@@ -20,1 +20,1 @@\n-old3\n+new3\n";
    const files = [diffFile({ patch })];
    let state: DiffViewState = { ...createLoadingDiffViewState(task()), loading: false, kind: "diff", files, selectedFileIndex: 0 };

    expect(diffPatchForRender(state, files[0])).toBe(patch);
    state = moveHunkSelection(state, 1);
    state = moveHunkSelection(state, 1);
    const rendered = diffPatchForRender(state, files[0]);
    expect(rendered?.startsWith("file header\n@@ -9,1 +9,1 @@")).toBe(true);
    expect(rendered).toContain("old1");
    expect(rendered?.split("\n")).toHaveLength(patch.split("\n").length);
  });

  it("scrolls the rendered patch without changing the diff geometry", () => {
    const patch = "line0\nline1\nline2\nline3\n";
    const files = [diffFile({ patch })];
    const state: DiffViewState = { ...createLoadingDiffViewState(task()), loading: false, kind: "diff", files, selectedFileIndex: 0 };

    expect(clampDiffPatchScrollTop(patch, -1)).toBe(0);
    expect(clampDiffPatchScrollTop(patch, 99)).toBe(4);
    const rendered = diffPatchForRender(state, files[0], 2);
    expect(rendered?.startsWith("line2\nline3")).toBe(true);
    expect(rendered?.split("\n")).toHaveLength(patch.split("\n").length);
  });

  it("keeps git diff headers valid while scrolling a short hunk body", () => {
    const patch = [
      "diff --git a/qa.ts b/qa.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/qa.ts",
      "@@ -0,0 +1,4 @@",
      "+line 1",
      "+line 2",
      "+line 3",
      "+line 4",
    ].join("\n");
    const files = [diffFile({ file: "qa.ts", patch })];
    const state: DiffViewState = { ...createLoadingDiffViewState(task()), loading: false, kind: "diff", files, selectedFileIndex: 0 };

    expect(clampDiffPatchScrollTop(patch, 99)).toBe(3);
    const rendered = diffPatchForRender(state, files[0], 99);
    expect(rendered?.startsWith("diff --git a/qa.ts b/qa.ts\nnew file mode 100644\n--- /dev/null\n+++ b/qa.ts\n@@ -0,0 +1,4 @@\n+line 4")).toBe(true);
    expect(rendered).toContain("+line 1");
    expect(rendered?.split("\n")).toHaveLength(patch.split("\n").length);
  });

  it("labels one-hunk and multi-hunk files in the patch header", () => {
    const files = [
      diffFile({ file: "one.ts", patch: "@@ -1,1 +1,1 @@\nx\n" }),
      diffFile({ file: "two.ts", patch: "@@ -1,1 +1,1 @@\nx\n@@ -9,1 +9,1 @@\ny\n" }),
    ];
    let state: DiffViewState = { ...createLoadingDiffViewState(task()), loading: false, kind: "diff", files, selectedFileIndex: 0 };
    expect(diffHunkPositionLabel(state)).toBe("1 hunk");

    state = { ...state, selectedFileIndex: 1 };
    expect(diffHunkPositionLabel(state)).toBe("hunk 1/2");

    state = moveHunkSelection(state, 1);
    state = moveHunkSelection(state, 1);
    expect(diffHunkPositionLabel(state)).toBe("hunk 2/2");
  });
});

describe("diff file-list windowing", () => {
  it("keeps the selected file visible in a deterministic fixed-capacity window", () => {
    expect(diffFileListWindow(0, 8, 3)).toEqual({ offset: 0, capacity: 3, hiddenAbove: 0, hiddenBelow: 5 });
    expect(diffFileListWindow(4, 8, 3)).toEqual({ offset: 3, capacity: 3, hiddenAbove: 3, hiddenBelow: 2 });
    expect(diffFileListWindow(7, 8, 3)).toEqual({ offset: 5, capacity: 3, hiddenAbove: 5, hiddenBelow: 0 });
  });
});

describe("split/inline view decision", () => {
  const files = [diffFile()];
  const base: DiffViewState = { ...createLoadingDiffViewState(task()), loading: false, kind: "diff", files, selectedFileIndex: 0 };

  it("defaults to split at every width", () => {
    expect(splitAvailable(DIFF_MIN_SPLIT_WIDTH)).toBe(true);
    expect(splitAvailable(DIFF_MIN_SPLIT_WIDTH - 1)).toBe(true);
    expect(effectiveDiffView(base, DIFF_MIN_SPLIT_WIDTH)).toBe("split");
    expect(effectiveDiffView(base, DIFF_MIN_SPLIT_WIDTH - 1)).toBe("split");
  });

  it("lets the manual toggle flip split/inline at every width", () => {
    const toggled = toggleViewOverride(base, DIFF_MIN_SPLIT_WIDTH - 1);
    expect(effectiveDiffView(toggled, DIFF_MIN_SPLIT_WIDTH - 1)).toBe("unified");
    expect(effectiveDiffView(toggleViewOverride(toggled, DIFF_MIN_SPLIT_WIDTH - 1), DIFF_MIN_SPLIT_WIDTH - 1)).toBe("split");
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

  it("emits a stable manual file-list box and keeps selected rows windowed into view", () => {
    const state = applyDiffResponse(createLoadingDiffViewState(task()), {
      kind: "diff",
      files: [
        diffFile({ file: "src/a.ts" }),
        diffFile({ file: "src/b.ts" }),
        diffFile({ file: "src/features/insights/super-long-file-name-that-must-not-overflow-column.ts" }),
        diffFile({ file: "src/d.ts" }),
      ],
      capped: false,
    });
    const selected = selectFileIndex(state, 2);
    const tree = renderDiffView(fakeUi(), fakeTheme(), {}, selected, 200, 2);
    const boxes = nodesByType(tree, "Box");
    const fileList = boxes.find((node) => node.props.id === DIFF_FILE_LIST_SCROLL_ID);
    const fileRows = nodesByType(fileList, "Box").filter((node) => node.props.height === DIFF_FILE_ROW_HEIGHT);

    expect(fileList?.props).toMatchObject({
      width: DIFF_FILE_COLUMN_WIDTH,
      height: "100%",
      minHeight: 0,
      flexShrink: 0,
      flexDirection: "column",
      overflow: "hidden",
    });
    expect(fileList?.type).toBe("Box");
    expect(fileRows).toHaveLength(2);
    expect(textOf(fileList)).toContain("files ↑1 ↓1");
    expect(textOf(fileList)).toContain("▸ src/features/insights/supe");

    const scrollBoxes = nodesByType(tree, "ScrollBox");
    expect(scrollBoxes.find((node) => node.props.id === DIFF_FILE_LIST_SCROLL_ID)).toBeUndefined();
    expect(scrollBoxes.find((node) => node.props.id === DIFF_PATCH_SCROLL_ID)).toBeUndefined();

    const diff = nodesByType(tree, "Diff")[0];
    expect(diff?.props).toMatchObject({
      id: DIFF_PATCH_SCROLL_ID,
      width: "100%",
      flexGrow: 1,
      flexShrink: 1,
      minHeight: 0,
      height: "100%",
      syncScroll: true,
      wrapMode: "none",
    });
  });

  it("does not wrap the native diff renderer in a patch ScrollBox", () => {
    const state = applyDiffResponse(createLoadingDiffViewState(task()), {
      kind: "diff",
      files: [diffFile()],
      capped: false,
    });
    const tree = renderDiffView(fakeUi(), fakeTheme(), { [DIFF_PATCH_SCROLL_ID]: 3 }, state, 200);
    expect(nodesByType(tree, "ScrollBox").find((node) => node.props.id === DIFF_PATCH_SCROLL_ID)).toBeUndefined();
    expect(nodesByType(tree, "Diff")[0].props.id).toBe(DIFF_PATCH_SCROLL_ID);
  });

  it("passes locked patch scroll state into the diff renderer", () => {
    const state = applyDiffResponse(createLoadingDiffViewState(task()), {
      kind: "diff",
      files: [diffFile({ patch: "line0\nline1\nline2\n" })],
      capped: false,
    });
    const tree = renderDiffView(fakeUi(), fakeTheme(), { [DIFF_PATCH_SCROLL_ID]: 1 }, state, 200);
    expect(nodesByType(tree, "Diff")[0].props.diff.startsWith("line1\nline2")).toBe(true);
  });

  it("renders the patch header hunk count so one-hunk files do not look stuck", () => {
    const state = applyDiffResponse(createLoadingDiffViewState(task()), {
      kind: "diff",
      files: [diffFile({ patch: "@@ -1,1 +1,1 @@\n-old\n+new\n" })],
      capped: false,
    });
    const tree = renderDiffView(fakeUi(), fakeTheme(), {}, state, 200);
    expect(textOf(tree)).toContain("1 hunk");
  });

  it("renders the selected hunk at the top of the patch pane", () => {
    const state = applyDiffResponse(createLoadingDiffViewState(task()), {
      kind: "diff",
      files: [diffFile({ patch: "preamble\n@@ -1,1 +1,1 @@\n-a\n+b\n@@ -5,1 +5,1 @@\n-c\n+d\n@@ -9,1 +9,1 @@\n-e\n+f\n" })],
      capped: false,
    });
    const selected = moveHunkSelection(moveHunkSelection(state, 1), 1);
    const tree = renderDiffView(fakeUi(), fakeTheme(), {}, selected, 200);
    const diff = nodesByType(tree, "Diff")[0];
    expect(textOf(tree)).toContain("hunk 2/3");
    expect(diff.props.diff.startsWith("preamble\n@@ -5,1 +5,1 @@")).toBe(true);
    expect(diff.props.diff).toContain("-a");
  });

  it("stays split below the old split width threshold", () => {
    const state = applyDiffResponse(createLoadingDiffViewState(task()), {
      kind: "diff",
      files: [diffFile()],
      capped: false,
    });
    const tree = renderDiffView(fakeUi(), fakeTheme(), {}, state, 60);
    expect(nodesByType(tree, "Diff")[0].props.view).toBe("split");
  });

  it("renders the manual inline view when toggled", () => {
    const state = {
      ...applyDiffResponse(createLoadingDiffViewState(task()), {
        kind: "diff",
        files: [diffFile()],
        capped: false,
      }),
      viewOverride: "unified" as const,
    };
    const tree = renderDiffView(fakeUi(), fakeTheme(), {}, state, 200);
    expect(textOf(tree)).toContain("inline");
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

describe("editorTargetForSelection", () => {
  // Two-hunk fixture with distinct new-file start lines and distinct hunk body lengths,
  // used to compute exact expected line numbers by hand (see PR/handoff notes):
  //   hunk 0 header "@@ -1,3 +10,3 @@"  -> new-start 10, body = [ctx1, -old1, +new1] (length 3)
  //   hunk 1 header "@@ -20,4 +30,5 @@" -> new-start 30, body = [ctx2, +added1, +added2, ctx3, ctx4] (length 5)
  const multiHunkPatch = [
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,3 +10,3 @@",
    " ctx1",
    "-old1",
    "+new1",
    "@@ -20,4 +30,5 @@",
    " ctx2",
    "+added1",
    "+added2",
    " ctx3",
    " ctx4",
  ].join("\n");

  function diffState(overrides: Partial<DiffViewState> = {}): DiffViewState {
    return {
      ...createLoadingDiffViewState(task()),
      loading: false,
      kind: "diff",
      capped: false,
      files: [diffFile({ file: "src/x.ts", patch: multiHunkPatch })],
      selectedFileIndex: 0,
      ...overrides,
    };
  }

  it("resolves the new-file start line of hunk 1 (file-nav mode, no hunk selected yet)", () => {
    const result = editorTargetForSelection(diffState());
    expect(result).toEqual({ ok: true, relPath: "src/x.ts", line: 10 });
  });

  it("resolves the new-file start line of hunk 2 once it is selected", () => {
    const state = moveHunkSelection(diffState(), 1);
    expect(state.selectedHunk).toEqual({ fileIndex: 0, hunkIndex: 0 });
    const state2 = moveHunkSelection(state, 1);
    expect(state2.selectedHunk).toEqual({ fileIndex: 0, hunkIndex: 1 });
    const result = editorTargetForSelection(state2);
    expect(result).toEqual({ ok: true, relPath: "src/x.ts", line: 30 });
  });

  it("adds the locked-scroll-mode hunk body offset on top of the hunk's new-start line", () => {
    // Hunk 0 selected + locked: diffPatchScrollTop = hunk 0's raw header offset (3),
    // clamped into hunk 0's body range [0, 3-1=2] -> bodyOffset 2 -> line 10 + 2 = 12.
    const hunk0Locked = { ...moveHunkSelection(diffState(), 1), fileSelectionLocked: true };
    expect(editorTargetForSelection(hunk0Locked)).toEqual({ ok: true, relPath: "src/x.ts", line: 12 });

    // Hunk 1 selected + locked: diffPatchScrollTop = hunk 1's raw header offset (7),
    // clamped into hunk 1's body range [0, 5-1=4] -> bodyOffset 4 -> line 30 + 4 = 34.
    const hunk1Locked = {
      ...moveHunkSelection(moveHunkSelection(diffState(), 1), 1),
      fileSelectionLocked: true,
    };
    expect(editorTargetForSelection(hunk1Locked)).toEqual({ ok: true, relPath: "src/x.ts", line: 34 });
  });

  it("does not add a locked-mode offset when file selection is not locked", () => {
    const hunk1Unlocked = moveHunkSelection(moveHunkSelection(diffState(), 1), 1);
    expect(hunk1Unlocked.fileSelectionLocked).toBe(false);
    expect(editorTargetForSelection(hunk1Unlocked)).toEqual({ ok: true, relPath: "src/x.ts", line: 30 });
  });

  it("uses the live scroll value over the state-only approximation when locked", () => {
    // Hunk 0 selected + locked, live scrollTop = 1 (body offset 1, within hunk 0's
    // body range [0, 2]) -> line 10 + 1 = 11, distinct from the state-only value (12).
    const hunk0Locked = { ...moveHunkSelection(diffState(), 1), fileSelectionLocked: true };
    expect(editorTargetForSelection(hunk0Locked, 1)).toEqual({ ok: true, relPath: "src/x.ts", line: 11 });
  });

  it("clamps the live scroll value into the selected hunk's own body range", () => {
    // Hunk 0's body has length 3 (indices 0-2); a live scrollTop far past it clamps to 2.
    const hunk0Locked = { ...moveHunkSelection(diffState(), 1), fileSelectionLocked: true };
    expect(editorTargetForSelection(hunk0Locked, 999)).toEqual({ ok: true, relPath: "src/x.ts", line: 12 });
  });

  it("falls back to the state-only approximation when liveScrollTop is omitted", () => {
    const hunk0Locked = { ...moveHunkSelection(diffState(), 1), fileSelectionLocked: true };
    expect(editorTargetForSelection(hunk0Locked)).toEqual(editorTargetForSelection(hunk0Locked, undefined));
    expect(editorTargetForSelection(hunk0Locked)).toEqual({ ok: true, relPath: "src/x.ts", line: 12 });
  });

  it("ignores liveScrollTop when file selection is not locked", () => {
    const hunk1Unlocked = moveHunkSelection(moveHunkSelection(diffState(), 1), 1);
    expect(hunk1Unlocked.fileSelectionLocked).toBe(false);
    expect(editorTargetForSelection(hunk1Unlocked, 999)).toEqual({ ok: true, relPath: "src/x.ts", line: 30 });
  });

  it("blocks on a deleted file with a reason mentioning deletion", () => {
    const state = diffState({
      files: [diffFile({ file: "src/gone.ts", status: "deleted", patch: multiHunkPatch })],
    });
    const result = editorTargetForSelection(state);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/deleted/i);
  });

  it("falls back to line 1 when the file has no patch (e.g. dropped by a capped response)", () => {
    const state = diffState({ files: [diffFile({ file: "src/capped.ts", patch: undefined })] });
    expect(editorTargetForSelection(state)).toEqual({ ok: true, relPath: "src/capped.ts", line: 1 });
  });

  it("falls back to line 1 when the patch has no hunks", () => {
    const state = diffState({ files: [diffFile({ file: "src/nohunks.ts", patch: "diff --git a/n b/n\n" })] });
    expect(editorTargetForSelection(state)).toEqual({ ok: true, relPath: "src/nohunks.ts", line: 1 });
  });

  it("blocks with 'no file selected' when there are no files", () => {
    const state = diffState({ files: [] });
    expect(editorTargetForSelection(state)).toEqual({ ok: false, reason: "no file selected" });
  });

  it("blocks with 'no file selected' while the diff is loading", () => {
    const state = createLoadingDiffViewState(task());
    expect(editorTargetForSelection(state)).toEqual({ ok: false, reason: "no file selected" });
  });

  it("blocks with 'no file selected' on an error state", () => {
    const state = applyDiffError(createLoadingDiffViewState(task()), "network down");
    expect(editorTargetForSelection(state)).toEqual({ ok: false, reason: "no file selected" });
  });

  it("blocks with 'no file selected' on a no-git state", () => {
    const state = applyDiffResponse(createLoadingDiffViewState(task()), {
      kind: "no-git",
      reason: "not a git repository",
    });
    expect(editorTargetForSelection(state)).toEqual({ ok: false, reason: "no file selected" });
  });

  it("parses the single-line-count hunk header form (no comma) for the new-start line", () => {
    const patch = "@@ -3 +5 @@\n-old\n+new\n";
    const state = diffState({ files: [diffFile({ file: "src/single.ts", patch })] });
    expect(editorTargetForSelection(state)).toEqual({ ok: true, relPath: "src/single.ts", line: 5 });
  });

  it("parses a mixed single/comma-count header (single old count, comma new count)", () => {
    const patch = "@@ -3 +5,2 @@\n-old\n+new1\n+new2\n";
    const state = diffState({ files: [diffFile({ file: "src/mixed.ts", patch })] });
    expect(editorTargetForSelection(state)).toEqual({ ok: true, relPath: "src/mixed.ts", line: 5 });
  });
});
