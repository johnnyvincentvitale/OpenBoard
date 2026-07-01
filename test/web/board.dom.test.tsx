// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { Board } from "../../src/web/components/Board";
import { COLUMN_LABELS } from "../../src/shared/index";
import type { Card } from "../../src/shared/index";

afterEach(cleanup);

// --- Fixtures ---------------------------------------------------------------

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    sessionId: "ses_1",
    title: "Session 1",
    directory: "/repo",
    cost: 0,
    additions: 0,
    deletions: 0,
    files: 0,
    column: "todo",
    position: 0,
    liveState: "idle",
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

const fixtureCards: Card[] = [
  makeCard({ sessionId: "ses_1", title: "Todo card 1", column: "todo", position: 0 }),
  makeCard({ sessionId: "ses_2", title: "Todo card 2", column: "todo", position: 1 }),
  makeCard({ sessionId: "ses_3", title: "In progress card", column: "in_progress", position: 0 }),
  makeCard({ sessionId: "ses_4", title: "Review card", column: "review", position: 0 }),
  makeCard({ sessionId: "ses_5", title: "Done card", column: "done", position: 0 }),
];

/**
 * dnd-kit derives all collision/keyboard-navigation math from
 * getBoundingClientRect(). jsdom returns an all-zero rect for every element by
 * default, which collapses every droppable/draggable onto the same point and
 * makes keyboard arrow navigation a no-op. We assign each column and card a
 * distinct, non-overlapping rect (columns laid out left-to-right, cards
 * stacked top-to-bottom within a column) so a real keyboard-driven drag can
 * navigate between them.
 */
function mockLayoutRects() {
  const columnOrder = ["todo", "in_progress", "review", "done"];
  const COLUMN_WIDTH = 300;
  const CARD_HEIGHT = 60;

  const original = HTMLElement.prototype.getBoundingClientRect;

  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const testId = this.getAttribute("data-testid") ?? "";

    const columnMatch = /^column-([a-z_]+)$/.exec(testId);
    if (columnMatch) {
      const colIndex = columnOrder.indexOf(columnMatch[1]);
      const left = colIndex * COLUMN_WIDTH;
      return domRect(left, 0, COLUMN_WIDTH, 600);
    }

    const sortableMatch = /^sortable-(.+)$/.exec(testId);
    if (sortableMatch) {
      const sessionId = sortableMatch[1];
      const card = fixtureCards.find((c) => c.sessionId === sessionId);
      if (card) {
        const colIndex = columnOrder.indexOf(card.column);
        const left = colIndex * COLUMN_WIDTH;
        const top = card.position * CARD_HEIGHT;
        return domRect(left, top, COLUMN_WIDTH - 20, CARD_HEIGHT - 10);
      }
    }

    return original.call(this);
  };

  return () => {
    HTMLElement.prototype.getBoundingClientRect = original;
  };
}

function domRect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON() {
      return this;
    },
  } as DOMRect;
}

let restoreRects: () => void;

beforeEach(() => {
  restoreRects = mockLayoutRects();
});

afterEach(() => {
  restoreRects();
});

// --- Tests -------------------------------------------------------------------

describe("Board", () => {
  it("renders four columns with correct labels", () => {
    render(<Board cards={fixtureCards} onMove={vi.fn()} renderCard={(c) => <div>{c.title}</div>} />);

    for (const column of ["todo", "in_progress", "review", "done"] as const) {
      const columnEl = screen.getByTestId(`column-${column}`);
      expect(within(columnEl).getByText(COLUMN_LABELS[column])).toBeInTheDocument();
    }
  });

  it("places cards into their assigned column", () => {
    render(
      <Board
        cards={fixtureCards}
        onMove={vi.fn()}
        renderCard={(c) => <div data-testid={`card-${c.sessionId}`}>{c.title}</div>}
      />,
    );

    const todoColumn = screen.getByTestId("column-todo");
    expect(within(todoColumn).getByTestId("card-ses_1")).toBeInTheDocument();
    expect(within(todoColumn).getByTestId("card-ses_2")).toBeInTheDocument();

    const inProgressColumn = screen.getByTestId("column-in_progress");
    expect(within(inProgressColumn).getByTestId("card-ses_3")).toBeInTheDocument();
    expect(within(inProgressColumn).queryByTestId("card-ses_1")).not.toBeInTheDocument();

    const reviewColumn = screen.getByTestId("column-review");
    expect(within(reviewColumn).getByTestId("card-ses_4")).toBeInTheDocument();

    const doneColumn = screen.getByTestId("column-done");
    expect(within(doneColumn).getByTestId("card-ses_5")).toBeInTheDocument();
  });

  it("shows a card count per column", () => {
    render(<Board cards={fixtureCards} onMove={vi.fn()} renderCard={(c) => <div>{c.title}</div>} />);

    expect(screen.getByTestId("column-count-todo")).toHaveTextContent("2");
    expect(screen.getByTestId("column-count-in_progress")).toHaveTextContent("1");
    expect(screen.getByTestId("column-count-review")).toHaveTextContent("1");
    expect(screen.getByTestId("column-count-done")).toHaveTextContent("1");
  });

  it("moves a card into another column via a keyboard drag and calls onMove", async () => {
    const onMove = vi.fn();
    const user = userEvent.setup();

    render(
      <Board
        cards={fixtureCards}
        onMove={onMove}
        renderCard={(c) => <div data-testid={`card-${c.sessionId}`}>{c.title}</div>}
      />,
    );

    // Tab to the first draggable handle (the sortable wrapper around ses_1,
    // the first card in the "todo" column), then pick it up with Space,
    // move it one column to the right with ArrowRight, and drop with Space.
    await user.tab();
    const activeEl = document.activeElement;
    expect(activeEl).toHaveAttribute("data-testid", "sortable-ses_1");

    await user.keyboard("[Space]");
    await user.keyboard("[ArrowRight]");
    await user.keyboard("[Space]");

    expect(onMove).toHaveBeenCalledTimes(1);
    const [sessionId, targetColumn, position] = onMove.mock.calls[0];
    expect(sessionId).toBe("ses_1");
    expect(targetColumn).toBe("in_progress");
    expect(typeof position).toBe("number");
  });
});
