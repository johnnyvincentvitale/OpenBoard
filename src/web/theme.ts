/**
 * OpenBoard design tokens for inline styles — mirrors src/web/theme.css so the
 * inline-style idiom (the app's convention) and the CSS custom properties stay
 * in sync. Colors/fonts are the locked Nightshade Sound values from the design
 * handoff (2026-07-01).
 */
import type { CSSProperties } from "react";
import type { Column } from "../shared";

export const t = {
  ground: "#0c0c0b",
  surface: "#191918",
  border: "#262624",
  text: "#d0ccca",
  muted: "#6e6c6c",
  dim: "#383836",
  accent: "#3f5e52",
  accentHover: "#4a6e60",
  elevation2: "0 2px 8px rgba(0, 0, 0, 0.45)",
  fontDisplay: '"Domaine Display", Georgia, "Times New Roman", serif',
  fontSans: '"General Sans", ui-sans-serif, system-ui, -apple-system, sans-serif',
  fontMono: '"Ioskeley Mono", ui-monospace, "SF Mono", Menlo, monospace',
  // Pixel/blocky logo + New Task header face (Jersey 15).
  fontLogo: '"Jersey 15", "Ioskeley Mono", ui-monospace, monospace',
} as const;

/**
 * Shared "primary action" treatment: black fill, teal-accent outline + label,
 * mono type. Used by the rail "+ New Task" CTA, the isolation active segment,
 * and the enabled "Create task" button. Colors from the design handoff (2026-07-02):
 * the only new value is the pure `#000` fill.
 */
export const outlineAction: CSSProperties = {
  background: "#000",
  border: `1px solid ${t.accent}`,
  color: t.accent,
  fontFamily: t.fontMono,
};

/** Lighter teal tint used only for the "board" half of the logo wordmark. */
export const LOGO_BOARD_COLOR = "#5b8a78";

/** Column color system (project-specific, extends Nightshade). */
export const COLUMN_COLORS: Record<Column, string> = {
  todo: "#4d6486",
  in_progress: "#837d6e",
  review: "#695c86",
  done: "#3f5e52",
};

/** Error state overrides the column color wherever the card sits. */
export const ERROR_COLOR = "#723b3a";
