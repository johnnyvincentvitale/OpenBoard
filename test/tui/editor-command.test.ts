import { describe, expect, it } from "vitest";
import { resolveEditorCommand, type EditorTarget } from "../../src/tui/editor-command";

function target(overrides: Partial<EditorTarget> = {}): EditorTarget {
  return { file: "/repo/src/a.ts", line: 42, ...overrides };
}

describe("resolveEditorCommand — line-syntax table (via $EDITOR)", () => {
  const cases: Array<{ editor: string; argv: string[]; kind: "terminal" | "gui" }> = [
    { editor: "vim", argv: ["vim", "+42", "/repo/src/a.ts"], kind: "terminal" },
    { editor: "nvim", argv: ["nvim", "+42", "/repo/src/a.ts"], kind: "terminal" },
    { editor: "vi", argv: ["vi", "+42", "/repo/src/a.ts"], kind: "terminal" },
    { editor: "gvim", argv: ["gvim", "+42", "/repo/src/a.ts"], kind: "gui" },
    { editor: "emacs", argv: ["emacs", "+42", "/repo/src/a.ts"], kind: "terminal" },
    { editor: "emacsclient", argv: ["emacsclient", "+42", "/repo/src/a.ts"], kind: "terminal" },
    { editor: "nano", argv: ["nano", "+42", "/repo/src/a.ts"], kind: "terminal" },
    { editor: "micro", argv: ["micro", "+42", "/repo/src/a.ts"], kind: "terminal" },
    { editor: "kak", argv: ["kak", "+42", "/repo/src/a.ts"], kind: "terminal" },
    { editor: "hx", argv: ["hx", "/repo/src/a.ts:42"], kind: "terminal" },
    { editor: "subl", argv: ["subl", "/repo/src/a.ts:42"], kind: "gui" },
    { editor: "zed", argv: ["zed", "/repo/src/a.ts:42"], kind: "gui" },
    { editor: "code", argv: ["code", "-g", "/repo/src/a.ts:42"], kind: "gui" },
    { editor: "code-insiders", argv: ["code-insiders", "-g", "/repo/src/a.ts:42"], kind: "gui" },
    { editor: "cursor", argv: ["cursor", "-g", "/repo/src/a.ts:42"], kind: "gui" },
    { editor: "windsurf", argv: ["windsurf", "-g", "/repo/src/a.ts:42"], kind: "gui" },
  ];

  for (const { editor, argv, kind } of cases) {
    it(`${editor} -> exact argv + ${kind} classification`, () => {
      const result = resolveEditorCommand({ EDITOR: editor }, target());
      expect(result).toEqual({ ok: true, command: { kind, argv } });
    });
  }

  it("unknown editor basename falls back to a bare {file} arg, classified terminal", () => {
    const result = resolveEditorCommand({ EDITOR: "some-random-editor" }, target());
    expect(result).toEqual({
      ok: true,
      command: { kind: "terminal", argv: ["some-random-editor", "/repo/src/a.ts"] },
    });
  });
});

describe("resolveEditorCommand — GUI vs terminal classification is basename-driven", () => {
  it("classifies by basename even with a full path to the binary", () => {
    const result = resolveEditorCommand({ EDITOR: "/usr/local/bin/code --wait" }, target());
    expect(result).toEqual({
      ok: true,
      command: { kind: "gui", argv: ["/usr/local/bin/code", "--wait", "-g", "/repo/src/a.ts:42"] },
    });
  });

  it("classifies zed as gui per the spec's GUI list", () => {
    const result = resolveEditorCommand({ EDITOR: "zed" }, target());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.command.kind).toBe("gui");
  });

  it("classifies gvim and subl as gui", () => {
    expect(resolveEditorCommand({ EDITOR: "gvim" }, target())).toMatchObject({
      command: { kind: "gui" },
    });
    expect(resolveEditorCommand({ EDITOR: "subl" }, target())).toMatchObject({
      command: { kind: "gui" },
    });
  });
});

describe("resolveEditorCommand — precedence", () => {
  it("OPENBOARD_EDITOR beats $VISUAL beats $EDITOR", () => {
    const allThree = resolveEditorCommand(
      { OPENBOARD_EDITOR: "subl", VISUAL: "code", EDITOR: "vim" },
      target(),
    );
    // OPENBOARD_EDITOR is a raw template: no {file} placeholder means the bare
    // file path is appended (template substitution, not the $EDITOR line-syntax table).
    expect(allThree).toEqual({ ok: true, command: { kind: "gui", argv: ["subl", "/repo/src/a.ts"] } });

    const visualAndEditor = resolveEditorCommand({ VISUAL: "code", EDITOR: "vim" }, target());
    expect(visualAndEditor).toEqual({
      ok: true,
      command: { kind: "gui", argv: ["code", "-g", "/repo/src/a.ts:42"] },
    });

    const editorOnly = resolveEditorCommand({ EDITOR: "vim" }, target());
    expect(editorOnly).toEqual({
      ok: true,
      command: { kind: "terminal", argv: ["vim", "+42", "/repo/src/a.ts"] },
    });
  });
});

describe("resolveEditorCommand — OPENBOARD_EDITOR template substitution", () => {
  it("substitutes {file} and {line} placeholders anywhere in the template", () => {
    const result = resolveEditorCommand(
      { OPENBOARD_EDITOR: "vim +{line} {file}" },
      target(),
    );
    expect(result).toEqual({
      ok: true,
      command: { kind: "terminal", argv: ["vim", "+42", "/repo/src/a.ts"] },
    });
  });

  it("appends the file path as the last arg when the template has no {file} placeholder", () => {
    const result = resolveEditorCommand({ OPENBOARD_EDITOR: "subl" }, target());
    expect(result).toEqual({
      ok: true,
      command: { kind: "gui", argv: ["subl", "/repo/src/a.ts"] },
    });
  });

  it("still appends the file when only {line} is present in the template", () => {
    const result = resolveEditorCommand(
      { OPENBOARD_EDITOR: "myeditor --line={line}" },
      target(),
    );
    expect(result).toEqual({
      ok: true,
      command: { kind: "terminal", argv: ["myeditor", "--line=42", "/repo/src/a.ts"] },
    });
  });

  it("classifies a GUI editor's OPENBOARD_EDITOR template as gui", () => {
    const result = resolveEditorCommand(
      { OPENBOARD_EDITOR: "code -g {file}:{line}" },
      target(),
    );
    expect(result).toEqual({
      ok: true,
      command: { kind: "gui", argv: ["code", "-g", "/repo/src/a.ts:42"] },
    });
  });

  it("substitutes multiple placeholder occurrences in a single token", () => {
    const result = resolveEditorCommand(
      { OPENBOARD_EDITOR: "echo {file}@{line}-{file}" },
      target(),
    );
    expect(result).toEqual({
      ok: true,
      command: { kind: "terminal", argv: ["echo", "/repo/src/a.ts@42-/repo/src/a.ts"] },
    });
  });
});

describe("resolveEditorCommand — multi-word env values", () => {
  it("splits $EDITOR values with extra args and keeps them ahead of the line args", () => {
    const result = resolveEditorCommand({ EDITOR: "code --wait --new-window" }, target());
    expect(result).toEqual({
      ok: true,
      command: {
        kind: "gui",
        argv: ["code", "--wait", "--new-window", "-g", "/repo/src/a.ts:42"],
      },
    });
  });

  it("splits $VISUAL values with extra args", () => {
    const result = resolveEditorCommand({ VISUAL: "emacsclient -nw" }, target());
    expect(result).toEqual({
      ok: true,
      command: { kind: "terminal", argv: ["emacsclient", "-nw", "+42", "/repo/src/a.ts"] },
    });
  });

  it("collapses multiple whitespace characters between tokens", () => {
    const result = resolveEditorCommand({ EDITOR: "vim   -O" }, target());
    expect(result).toEqual({
      ok: true,
      command: { kind: "terminal", argv: ["vim", "-O", "+42", "/repo/src/a.ts"] },
    });
  });
});

describe("resolveEditorCommand — empty/whitespace env values are treated as unset", () => {
  it("treats an empty string OPENBOARD_EDITOR as unset and falls through to $VISUAL", () => {
    const result = resolveEditorCommand({ OPENBOARD_EDITOR: "", VISUAL: "vim" }, target());
    expect(result).toEqual({
      ok: true,
      command: { kind: "terminal", argv: ["vim", "+42", "/repo/src/a.ts"] },
    });
  });

  it("treats a whitespace-only OPENBOARD_EDITOR as unset", () => {
    const result = resolveEditorCommand({ OPENBOARD_EDITOR: "   ", EDITOR: "vim" }, target());
    expect(result).toEqual({
      ok: true,
      command: { kind: "terminal", argv: ["vim", "+42", "/repo/src/a.ts"] },
    });
  });

  it("treats an empty string $VISUAL as unset and falls through to $EDITOR", () => {
    const result = resolveEditorCommand({ VISUAL: "", EDITOR: "vim" }, target());
    expect(result).toEqual({
      ok: true,
      command: { kind: "terminal", argv: ["vim", "+42", "/repo/src/a.ts"] },
    });
  });

  it("treats a whitespace-only $EDITOR as unset, yielding the error case", () => {
    const result = resolveEditorCommand({ EDITOR: "   " }, target());
    expect(result).toEqual({
      ok: false,
      error: "No editor configured — set $EDITOR, $VISUAL, or OPENBOARD_EDITOR.",
    });
  });
});

describe("resolveEditorCommand — error case", () => {
  it("returns a clear error when no editor is configured at all", () => {
    const result = resolveEditorCommand({}, target());
    expect(result).toEqual({
      ok: false,
      error: "No editor configured — set $EDITOR, $VISUAL, or OPENBOARD_EDITOR.",
    });
  });

  it("returns the same error when env has unrelated keys only", () => {
    const result = resolveEditorCommand({ PATH: "/usr/bin", HOME: "/home/user" }, target());
    expect(result.ok).toBe(false);
  });
});
