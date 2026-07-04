import type { RGBA } from "@opentui/core";

export type WordmarkColor = string | RGBA;

export interface WordmarkSegment {
  text: string;
  fg: WordmarkColor;
  bg: WordmarkColor;
}

export interface WordmarkPalette {
  openMain: WordmarkColor;
  openDark: WordmarkColor;
  boardMain: WordmarkColor;
  boardDark: WordmarkColor;
  ground: WordmarkColor;
}

// Pixel map of the OpenBoard wordmark, generated from `OpenBoard LogoRevised.svg`
// (51x14 canvas) by rasterizing its <rect> grid and cropping to the drawn content
// (45 cols wide), then trimmed one row at each extremity for header height —
// The revised styling was accepted, but the full 8 rows were too tall. The b/d
// ascenders keep 1 of their 2 rows and the p's stem now ends at the baseline
// instead of descending below it; the 5-row letter bodies are untouched → 45x6.
// Tokens: W/w = "open" fill / inner counter, B/b = "board" fill / inner
// counter, "." = ground.
//
// Rendered one full block per pixel (NOT half-blocks) to stay seam-free: in rich mode
// each cell is a space painted with a background color (cell backgrounds tile gap-free
// in every terminal); in tmux-safe mode it falls back to a foreground "█" with an
// indexed color, since safe mode strips background fills.
const PIXEL_ROWS = [
  ".....................B......................B",
  "WWWW.WWWW.WWWW.WWWW..BBBB.BBBB.BBBB.BBBB.BBBB",
  "WwwW.WwwW.WwwW.WwwW..BbbB.BbbB.bbbB.BbbB.BbbB",
  "WwwW.WwwW.WWWW.WwwW..BbbB.BbbB.BBBB.B....BbbB",
  "WwwW.WWWW.Wwww.WwwW..BbbB.BbbB.BbbB.B....BbbB",
  "WWWW.W....WWWW.W..W..BBBB.BBBB.BBBB.B....BBBB",
] as const;

export function buildWordmarkRows(palette: WordmarkPalette, safe = false): WordmarkSegment[][] {
  const color = (token: string): WordmarkColor => {
    switch (token) {
      case "W":
        return palette.openMain;
      case "w":
        return palette.openDark;
      case "B":
        return palette.boardMain;
      case "b":
        return palette.boardDark;
      default:
        return palette.ground;
    }
  };

  const rows: WordmarkSegment[][] = [];
  for (const rowText of PIXEL_ROWS) {
    const segments: WordmarkSegment[] = [];
    for (const token of rowText) {
      const cell = color(token);
      // rich: space + bg color (seamless); safe: "█" + fg color (bg gets stripped).
      const text = safe ? "█" : " ";
      const fg = safe ? cell : palette.ground;
      const bg = safe ? palette.ground : cell;
      const last = segments[segments.length - 1];
      if (last && last.fg === fg && last.bg === bg) {
        last.text += text;
      } else {
        segments.push({ text, fg, bg });
      }
    }
    rows.push(segments);
  }

  return rows;
}
