// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import type { RosterAgent, Task } from "../../src/shared";
import { TaskBoardSurface } from "../../src/web/components/TaskBoardSurface";

afterEach(cleanup);

function makeTask(overrides: Partial<Task> & { id: string; title: string }): Task {
  return {
    description: "desc",
    directory: "/repo",
    column: "todo",
    position: 0,
    runState: "unstarted",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const agents: RosterAgent[] = [
  { id: "build", mode: "primary" },
  { id: "plan", mode: "primary" },
];

describe("TaskBoardSurface", () => {
  it("filters active tasks by title and agent", async () => {
    const user = userEvent.setup();
    render(
      <TaskBoardSurface
        tasks={[
          makeTask({ id: "a", title: "Alpha fix", column: "review", agent: "build" }),
          makeTask({ id: "b", title: "Beta docs", column: "done", agent: "plan" }),
        ]}
        agents={agents}
        archivedView={false}
        onArchivedViewChange={vi.fn()}
        onMove={vi.fn()}
        onUnarchive={vi.fn()}
        renderTaskCard={(task) => <div>{task.title}</div>}
      />,
    );

    await user.type(screen.getByTestId("title-filter"), "alpha");
    expect(screen.getByText("Alpha fix")).toBeInTheDocument();
    expect(screen.queryByText("Beta docs")).not.toBeInTheDocument();

    await user.clear(screen.getByTestId("title-filter"));
    await user.selectOptions(screen.getByTestId("agent-filter"), "plan");
    expect(screen.getByText("Beta docs")).toBeInTheDocument();
    expect(screen.queryByText("Alpha fix")).not.toBeInTheDocument();
  });

  it("covers the archive/unarchive round trip in archived view", async () => {
    const user = userEvent.setup();

    function Harness() {
      const [archivedView, setArchivedView] = useState(false);
      const [activeTasks, setActiveTasks] = useState<Task[]>([
        makeTask({ id: "review-1", title: "Ship release", column: "review", agent: "build" }),
      ]);
      const [archivedTasks, setArchivedTasks] = useState<Task[]>([]);

      return (
        <TaskBoardSurface
          tasks={archivedView ? archivedTasks : activeTasks}
          agents={agents}
          archivedView={archivedView}
          onArchivedViewChange={setArchivedView}
          onMove={vi.fn()}
          onUnarchive={(taskId) => {
            setArchivedTasks((current) => {
              const task = current.find((item) => item.id === taskId);
              if (task) setActiveTasks((active) => [...active, { ...task, archived: false }]);
              return current.filter((item) => item.id !== taskId);
            });
          }}
          renderTaskCard={(task) => (
            // The Archive action now lives on the TaskCard itself (ActionRow);
            // this stub stands in for it so the surface round trip stays covered.
            <div>
              {task.title}
              <button
                type="button"
                data-testid={`archive-task-${task.id}`}
                onClick={() => {
                  setActiveTasks((current) => {
                    const found = current.find((item) => item.id === task.id);
                    if (found) setArchivedTasks((archived) => [...archived, { ...found, archived: true }]);
                    return current.filter((item) => item.id !== task.id);
                  });
                }}
              >
                Archive
              </button>
            </div>
          )}
        />
      );
    }

    render(<Harness />);

    expect(screen.getByText("Ship release")).toBeInTheDocument();
    await user.click(screen.getByTestId("archive-task-review-1"));
    expect(screen.queryByText("Ship release")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("archived-toggle"));
    expect(screen.getByTestId("archived-list")).toBeInTheDocument();
    expect(screen.getByText("Ship release")).toBeInTheDocument();

    await user.click(screen.getByText("Unarchive"));
    expect(screen.queryByText("Ship release")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("archived-toggle"));
    expect(screen.getByText("Ship release")).toBeInTheDocument();
  });
});
