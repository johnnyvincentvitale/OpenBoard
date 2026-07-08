/**
 * Editor command resolution for DiffView's "open in editor" action. Pure
 * logic only — no process spawning, no terminal suspend/resume, no reads
 * from the live environment beyond the `env` map the caller passes in.
 * `index.ts` (or a future Phase 3 wiring module) owns actually spawning the
 * resolved `argv` and suspending/resuming the renderer around it.
 *
 * Resolution never guesses. It only ever uses env vars the user explicitly
 * set (`OPENBOARD_EDITOR`, `$VISUAL`, `$EDITOR`) and fails loudly with a
 * clear message when none are set — never falling back to a platform
 * default opener.
 */

/** A file + 1-indexed line to jump to when the editor opens. `file` is an absolute path. */
export interface EditorTarget {
  file: string;
  line: number;
}

/**
 * A resolved, spawnable editor invocation.
 * - `kind: "terminal"` editors run in the foreground; the caller must
 *   suspend the TUI renderer, spawn with inherited stdio, and resume on exit.
 * - `kind: "gui"` editors are spawned detached (no suspend needed) since
 *   they open their own window and return control to the terminal immediately.
 */
export type EditorCommand = { kind: "terminal" | "gui"; argv: string[] };

/** Result of resolving an editor command: either a spawnable command, or a reason it failed. */
export type EditorResolution = { ok: true; command: EditorCommand } | { ok: false; error: string };

/**
 * Editors that open a GUI window and should be spawned detached rather than
 * suspending the TUI. Matched against the basename of the first token of the
 * resolved command (so `/usr/local/bin/code --wait` still matches `code`).
 */
const GUI_EDITOR_BASENAMES = new Set([
  "code",
  "code-insiders",
  "cursor",
  "windsurf",
  "zed",
  "subl",
  "gvim",
]);

/**
 * Line-jump argument strategy per editor basename. Each function takes the
 * resolved target and returns the extra argv entries to append after the
 * file (or, for editors needing a combined `file:line` token, the full
 * replacement for the trailing file argument).
 *
 * Returning `undefined` from `buildArgs` signals "unknown editor" — the
 * caller falls back to a bare `{file}` arg with no line jump.
 */
type LineArgBuilder = (target: EditorTarget) => string[];

/** `+{line}` then `{file}` — vim-family and friends that accept a leading `+N`. */
const plusLineThenFile: LineArgBuilder = (target) => [`+${target.line}`, target.file];

/** Single `{file}:{line}` arg — editors that parse a trailing `:line` suffix. */
const fileColonLine: LineArgBuilder = (target) => [`${target.file}:${target.line}`];

/** `-g` then `{file}:{line}` — VS Code-family `--goto` syntax. */
const gotoFileColonLine: LineArgBuilder = (target) => ["-g", `${target.file}:${target.line}`];

const LINE_ARG_BUILDERS: Record<string, LineArgBuilder> = {
  vim: plusLineThenFile,
  nvim: plusLineThenFile,
  vi: plusLineThenFile,
  gvim: plusLineThenFile,
  emacs: plusLineThenFile,
  emacsclient: plusLineThenFile,
  nano: plusLineThenFile,
  micro: plusLineThenFile,
  kak: plusLineThenFile,
  hx: fileColonLine,
  subl: fileColonLine,
  zed: fileColonLine,
  code: gotoFileColonLine,
  "code-insiders": gotoFileColonLine,
  cursor: gotoFileColonLine,
  windsurf: gotoFileColonLine,
};

/** Basename of the first path segment, stripping any directory prefix (POSIX or Windows-style). */
function basename(token: string): string {
  const parts = token.split(/[\\/]/);
  return parts[parts.length - 1] ?? token;
}

/** Whitespace-split a command string into tokens. Collapses runs of whitespace; trims ends. */
function splitCommand(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

/** `undefined`/empty/whitespace-only env values are treated as unset. */
function readEnv(env: Record<string, string | undefined>, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  return raw.trim() === "" ? undefined : raw;
}

function classify(basenameToken: string): "terminal" | "gui" {
  return GUI_EDITOR_BASENAMES.has(basenameToken) ? "gui" : "terminal";
}

/**
 * Build argv for a resolved editor command (tokens already whitespace-split,
 * first token is the editor binary) by appending the line-jump args from the
 * table above. Unknown editors get a bare `{file}` with no line arg.
 */
function buildArgvForEditor(tokens: string[], target: EditorTarget): string[] {
  const [command, ...extraArgs] = tokens;
  const editorBasename = basename(command!);
  const builder = LINE_ARG_BUILDERS[editorBasename];
  const trailingArgs = builder ? builder(target) : [target.file];
  return [command!, ...extraArgs, ...trailingArgs];
}

/**
 * Substitute `{file}`/`{line}` placeholders into a whitespace-split
 * `OPENBOARD_EDITOR` template. If no `{file}` placeholder is present
 * anywhere in the template, the file path is appended as the last arg
 * (so a bare `"subl"` template still opens the right file).
 */
function buildArgvFromTemplate(template: string, target: EditorTarget): string[] {
  const tokens = splitCommand(template);
  const substituted = tokens.map((token) =>
    token.replaceAll("{file}", target.file).replaceAll("{line}", String(target.line)),
  );
  const hasFilePlaceholder = tokens.some((token) => token.includes("{file}"));
  return hasFilePlaceholder ? substituted : [...substituted, target.file];
}

import type { EditorCommandDiagnostics } from "../shared/diagnostics";

/**
 * Resolve editor diagnostics for the settings/control panel — what editor
 * is configured, from which env var, or whether no editor is set at all.
 * Pure logic only; reads from the provided `env` map.
 */
export function resolveEditorDiagnostics(
  env: Record<string, string | undefined>,
): EditorCommandDiagnostics {
  const openboardEditor = readEnv(env, "OPENBOARD_EDITOR");
  if (openboardEditor !== undefined) {
    return { resolved: openboardEditor, source: "openboard_editor", missing: false };
  }

  const visual = readEnv(env, "VISUAL");
  if (visual !== undefined) {
    return { resolved: visual, source: "visual", missing: false };
  }

  const editor = readEnv(env, "EDITOR");
  if (editor !== undefined) {
    return { resolved: editor, source: "editor", missing: false };
  }

  return { missing: true };
}

/**
 * Resolve the editor command to launch for `target`, in precedence order:
 *
 * 1. `OPENBOARD_EDITOR` — a command template with optional `{file}`/`{line}`
 *    placeholders (see {@link buildArgvFromTemplate}). Classified by the
 *    basename of its first token, same as `$VISUAL`/`$EDITOR`.
 * 2. `$VISUAL`, then `$EDITOR` — may include args (e.g. `"code --wait"`);
 *    the first token's basename selects the line-jump syntax from the table
 *    in this module, appended after whitespace-splitting the value.
 * 3. Neither set → `{ ok: false, error }` — never guesses a default editor.
 *
 * Empty or whitespace-only env values are treated as unset, same as an
 * absent key.
 */
export function resolveEditorCommand(
  env: Record<string, string | undefined>,
  target: EditorTarget,
): EditorResolution {
  const openboardEditor = readEnv(env, "OPENBOARD_EDITOR");
  if (openboardEditor !== undefined) {
    const argv = buildArgvFromTemplate(openboardEditor, target);
    const editorBasename = basename(argv[0]!);
    return { ok: true, command: { kind: classify(editorBasename), argv } };
  }

  const visual = readEnv(env, "VISUAL");
  const editor = readEnv(env, "EDITOR");
  const fromEnvVar = visual ?? editor;
  if (fromEnvVar !== undefined) {
    const tokens = splitCommand(fromEnvVar);
    const editorBasename = basename(tokens[0]!);
    const argv = buildArgvForEditor(tokens, target);
    return { ok: true, command: { kind: classify(editorBasename), argv } };
  }

  return { ok: false, error: "No editor configured — set $EDITOR, $VISUAL, or OPENBOARD_EDITOR." };
}
