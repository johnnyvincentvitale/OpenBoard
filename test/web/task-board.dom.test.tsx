// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { TaskBoard } from "../../src/web/components/TaskBoard";
import { COLUMN_LABELS } from "../../src/shared";
import type { Task } from "../../src/shared";

afterEach(cleanup);

// --- Fixtures ---------------------------------------------------------------

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_1",
    title: "Task 1",
    description: "Do the thing",
    directory: "/repo",
    column: "todo",
    position: 0,
    runState: "unstarted",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

const fixtureTasks: Task[] = [
  makeTask({ id: "task_1", title: "Todo task 1", column: "todo", position: 0 }),
  makeTask({ id: "task_2", title: "Todo task 2", column: "todo", position: 1 }),
  makeTask({ id: "task_3", title: "In progress task", column: "in_progress", position: 0 }),
  makeTask({ id: "task_4", title: "Review task", column: "review", position: 0 }),
  makeTask({ id: "task_5", title: "Done task", column: "done", position: 0 }),
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
      const taskId = sortableMatch[1];
      const task = fixtureTasks.find((t) => t.id === taskId);
      if (task) {
        const colIndex = columnOrder.indexOf(task.column);
        const top = task.position * CARD_HEIGHT;
        const left = colIndex * COLUMN_WIDTH;
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

describe("TaskBoard", () => {
  it("renders four columns with correct labels", () => {
    render(
      <TaskBoard
        tasks={fixtureTasks}
        onMove={vi.fn()}
        renderCard={(t) => <div data-testid={`t-${t.id}`}>{t.title}</div>}
      />,
    );

    for (const column of ["todo", "in_progress", "review", "done"] as const) {
      const columnEl = screen.getByTestId(`column-${column}`);
      expect(within(columnEl).getByText(COLUMN_LABELS[column])).toBeInTheDocument();
    }
  });

  it("places tasks into their assigned column", () => {
    render(
      <TaskBoard
        tasks={fixtureTasks}
        onMove={vi.fn()}
        renderCard={(t) => <div data-testid={`t-${t.id}`}>{t.title}</div>}
      />,
    );

    const todoColumn = screen.getByTestId("column-todo");
    expect(within(todoColumn).getByTestId("t-task_1")).toBeInTheDocument();
    expect(within(todoColumn).getByTestId("t-task_2")).toBeInTheDocument();

    const inProgressColumn = screen.getByTestId("column-in_progress");
    expect(within(inProgressColumn).getByTestId("t-task_3")).toBeInTheDocument();
    expect(within(inProgressColumn).queryByTestId("t-task_1")).not.toBeInTheDocument();

    const reviewColumn = screen.getByTestId("column-review");
    expect(within(reviewColumn).getByTestId("t-task_4")).toBeInTheDocument();

    const doneColumn = screen.getByTestId("column-done");
    expect(within(doneColumn).getByTestId("t-task_5")).toBeInTheDocument();
  });

  it("shows a task count per column", () => {
    render(
      <TaskBoard
        tasks={fixtureTasks}
        onMove={vi.fn()}
        renderCard={(t) => <div data-testid={`t-${t.id}`}>{t.title}</div>}
      />,
    );

    expect(screen.getByTestId("column-count-todo")).toHaveTextContent("2");
    expect(screen.getByTestId("column-count-in_progress")).toHaveTextContent("1");
    expect(screen.getByTestId("column-count-review")).toHaveTextContent("1");
    expect(screen.getByTestId("column-count-done")).toHaveTextContent("1");
  });

  it("moves a task into another column via a keyboard drag and calls onMove", async () => {
    const onMove = vi.fn();
    const user = userEvent.setup();

    render(
      <TaskBoard
        tasks={fixtureTasks}
        onMove={onMove}
        renderCard={(t) => <div data-testid={`t-${t.id}`}>{t.title}</div>}
      />,
    );

    // Tab to the first draggable handle (the sortable wrapper around task_1,
    // the first card in the "todo" column), then pick it up with Space,
    // move it one column to the right with ArrowRight, and drop with Space.
    await user.tab();
    const activeEl = document.activeElement;
    expect(activeEl).toHaveAttribute("data-testid", "sortable-task_1");

    await user.keyboard("[Space]");
    await user.keyboard("[ArrowRight]");
    await user.keyboard("[Space]");

    expect(onMove).toHaveBeenCalledTimes(1);
    const [taskId, targetColumn, position] = onMove.mock.calls[0];
    expect(taskId).toBe("task_1");
    expect(targetColumn).toBe("in_progress");
    expect(typeof position).toBe("number");
  });
});
