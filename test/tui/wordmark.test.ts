import { describe, expect, it } from "vitest";
import { buildWordmarkRows, type WordmarkPalette } from "../../src/tui/wordmark";

const palette: WordmarkPalette = {
  openMain: "open-main",
  openDark: "open-dark",
  boardMain: "board-main",
  boardDark: "board-dark",
  ground: "ground",
};

function rowWidth(row: ReturnType<typeof buildWordmarkRows>[number]): number {
  return row.reduce((sum, segment) => sum + segment.text.length, 0);
}

describe("TUI wordmark", () => {
  it("renders the pixel map as native-scale full-cell block rows", () => {
    const rows = buildWordmarkRows(palette);

    // 45x6: the revised logo SVG's drawn content, extremity rows trimmed for
    // header height (1-row ascenders, p stem ends at the baseline).
    expect(rows).toHaveLength(6);
    expect(rows.map(rowWidth)).toEqual([45, 45, 45, 45, 45, 45]);
    // Rich mode paints each cell as a space carrying a background color (seam-free).
    expect(rows.flat().every((segment) => /^ +$/.test(segment.text))).toBe(true);
  });

  it("maps open, board, counter, and ground pixels to the palette", () => {
    const rows = buildWordmarkRows(palette);
    const colors = new Set(rows.flatMap((row) => row.flatMap((segment) => [segment.fg, segment.bg])));

    expect(colors).toEqual(
      new Set(["open-main", "open-dark", "board-main", "board-dark", "ground"]),
    );
  });

  it("coalesces adjacent cells that share foreground and background colors", () => {
    const [topRow] = buildWordmarkRows(palette);

    // Top row is just the two ascenders: a leading ground run, ending on the "d" ascender.
    expect(topRow[0].fg).toBe("ground");
    expect(topRow[0].bg).toBe("ground");
    expect(topRow.every((segment) => /^ +$/.test(segment.text))).toBe(true);
    expect(topRow.at(-1)).toEqual({ text: " ", fg: "ground", bg: "board-main" });
  });

  it("uses a foreground block with a stripped background in tmux-safe mode", () => {
    const [topRow] = buildWordmarkRows(palette, true);

    // Safe mode carries color in the foreground "█" so background fills can be dropped.
    expect(topRow.every((segment) => /^█+$/.test(segment.text))).toBe(true);
    expect(topRow.at(-1)).toEqual({ text: "█", fg: "board-main", bg: "ground" });
  });
});
