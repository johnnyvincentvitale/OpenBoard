// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Task, RosterAgent } from "../../src/shared";
import { TaskCard } from "../../src/web/components/TaskCard";

afterEach(cleanup);

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Build the login form",
    description:
      "Implement a login form with email + password fields, client-side validation, and a submit handler that posts to /api/auth/login.",
    directory: "/Users/johnnyvitale/code/opencode-board",
    agent: "build",
    model: { id: "claude-sonnet-5", providerID: "anthropic" },
    column: "todo",
    position: 0,
    runState: "unstarted",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeAgents(overrides: Partial<RosterAgent>[] = []): RosterAgent[] {
  if (overrides.length > 0) {
    return overrides.map((agent, index) => ({
      id: `agent-${index}`,
      mode: "primary",
      ...agent,
    }));
  }
  return [
    { id: "build", mode: "primary", description: "Build agent" },
    { id: "plan", mode: "primary", description: "Plan agent" },
  ];
}

function renderCard(overrides: Partial<Task> = {}, handlers: Partial<{
  onRun: (id: string) => void;
  onRetry: (id: string) => void;
  onAbort: (id: string) => void;
  onDelete: (id: string) => void;
  onInitGit: (id: string) => void;
  onSync: (id: string) => void;
  onIntegrate: (id: string) => void;
}> = {}) {
  const task = makeTask(overrides);
  const onRun = handlers.onRun ?? vi.fn();
  const onRetry = handlers.onRetry ?? vi.fn();
  const onAbort = handlers.onAbort ?? vi.fn();
  const onDelete = handlers.onDelete ?? vi.fn();
  const onInitGit = handlers.onInitGit ?? vi.fn();
  const onSync = handlers.onSync ?? vi.fn();
  const onIntegrate = handlers.onIntegrate ?? vi.fn();

  render(
    <TaskCard
      task={task}
      agents={makeAgents()}
      onRun={onRun}
      onRetry={onRetry}
      onAbort={onAbort}
      onDelete={onDelete}
      onInitGit={onInitGit}
      onSync={onSync}
      onIntegrate={onIntegrate}
    />,
  );

  return { task, onRun, onRetry, onAbort, onDelete, onInitGit, onSync, onIntegrate };
}

describe("TaskCard", () => {
  it("renders title, truncated description, directory, agent badge, and runState", () => {
    const longDescription = "x".repeat(200);
    renderCard({ description: longDescription });

    expect(screen.getByText("Build the login form")).toBeInTheDocument();
    expect(screen.getByText("opencode-board")).toBeInTheDocument();

    const description = screen.getByTestId("task-description");
    expect(description.textContent!.length).toBeLessThan(longDescription.length);
    expect(description.textContent).toMatch(/…$/);

    expect(screen.getByTestId("agent-badge")).toHaveTextContent("build");

    const pill = screen.getByTestId("run-state-pill");
    expect(pill).toHaveAttribute("data-run-state", "unstarted");
  });

  it("shows the model id when set", () => {
    renderCard({ model: { id: "claude-sonnet-5", providerID: "anthropic" } });
    expect(screen.getByTestId("model-id")).toHaveTextContent("claude-sonnet-5");
  });

  it("does not render a model id element when model is unset", () => {
    renderCard({ model: undefined });
    expect(screen.queryByTestId("model-id")).not.toBeInTheDocument();
  });

  it("shows an animated pulse dot when runState is running", () => {
    renderCard({ runState: "running", column: "in_progress" });

    expect(screen.getByTestId("pulse-dot")).toBeInTheDocument();
    const pill = screen.getByTestId("run-state-pill");
    expect(pill).toHaveAttribute("data-run-state", "running");
  });

  it("does not show the pulse dot for non-running states", () => {
    for (const runState of ["unstarted", "idle", "error"] as const) {
      const { unmount } = render(
        <TaskCard
          task={makeTask({ runState, column: "in_progress" })}
          agents={makeAgents()}
          onRun={vi.fn()}
          onRetry={vi.fn()}
          onAbort={vi.fn()}
          onDelete={vi.fn()}
          onInitGit={vi.fn()}
          onSync={vi.fn()}
          onIntegrate={vi.fn()}
        />,
      );

      expect(screen.queryByTestId("pulse-dot")).not.toBeInTheDocument();
      const pill = screen.getByTestId("run-state-pill");
      expect(pill).toHaveAttribute("data-run-state", runState);
      unmount();
    }
  });

  it("shows Run when runState is unstarted and calls onRun with the id", async () => {
    const user = userEvent.setup();
    const { onRun, task } = renderCard({ runState: "unstarted", column: "todo" });

    const runButton = screen.getByRole("button", { name: "Run" });
    await user.click(runButton);
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledWith(task.id);
  });

  it("shows Run when column is todo even if runState is not unstarted", () => {
    renderCard({ runState: "idle", column: "todo" });
    expect(screen.getByRole("button", { name: "Run" })).toBeInTheDocument();
  });

  it("hides Run when runState is running", () => {
    renderCard({ runState: "running", column: "in_progress" });
    expect(screen.queryByRole("button", { name: "Run" })).not.toBeInTheDocument();
  });

  it("shows Stop when running and calls onAbort with the id", async () => {
    const user = userEvent.setup();
    const { onAbort, task } = renderCard({ runState: "running", column: "in_progress" });

    const stopButton = screen.getByRole("button", { name: "Stop" });
    await user.click(stopButton);
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(onAbort).toHaveBeenCalledWith(task.id);
  });

  it("hides Stop when not running", () => {
    renderCard({ runState: "idle", column: "review" });
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  });

  it("shows Retry when column is review and calls onRetry with the id", async () => {
    const user = userEvent.setup();
    const { onRetry, task } = renderCard({ runState: "idle", column: "review" });

    const retryButton = screen.getByRole("button", { name: "Retry" });
    await user.click(retryButton);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(task.id);
  });

  it("shows Retry when runState is error even outside review column", () => {
    renderCard({ runState: "error", column: "in_progress" });
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("hides Retry when not in review and not errored", () => {
    renderCard({ runState: "idle", column: "in_progress" });
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("calls onDelete with the id after confirm", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { onDelete, task } = renderCard();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith(task.id);

    confirmSpy.mockRestore();
  });

  it("does not call onDelete when confirm is declined", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { onDelete } = renderCard();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it("shows the roster agent's label when the roster has a matching agent", () => {
    renderCard(
      { agent: "build" },
    );
    expect(screen.getByTestId("agent-badge")).toHaveTextContent("build");
  });

  it("does not render an agent badge when the task has no agent", () => {
    renderCard({ agent: undefined });
    expect(screen.queryByTestId("agent-badge")).not.toBeInTheDocument();
  });
});

describe("TaskCard — worktree isolation UI", () => {
  it("shows the git-init prompt for a pending task and hides Run", async () => {
    const { onInitGit } = renderCard({ pending: "git-init", runState: "unstarted", column: "todo" });
    expect(screen.getByTestId("git-init-prompt")).toBeInTheDocument();
    // Run is suppressed while awaiting the git-init decision.
    expect(screen.queryByRole("button", { name: "Run" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Make repo/ }));
    expect(onInitGit).toHaveBeenCalledWith("task-1");
  });

  it("shows the worktree branch and Sync; Integrate appears once not running", () => {
    renderCard({
      worktreeBranch: "board/task-1",
      worktreePath: "/wt/task-1",
      baseBranch: "main",
      runState: "idle",
      column: "review",
    });
    expect(screen.getByTestId("worktree-branch")).toHaveTextContent("board/task-1");
    expect(screen.getByRole("button", { name: "Sync" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Integrate" })).toBeInTheDocument();
  });

  it("hides Integrate while the session is still running", () => {
    renderCard({
      worktreeBranch: "board/task-1",
      worktreePath: "/wt/task-1",
      baseBranch: "main",
      runState: "running",
      column: "in_progress",
    });
    expect(screen.getByRole("button", { name: "Sync" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Integrate" })).not.toBeInTheDocument();
  });

  it("wires Sync and Integrate to their handlers", async () => {
    const { onSync, onIntegrate } = renderCard({
      worktreeBranch: "board/task-1",
      worktreePath: "/wt/task-1",
      baseBranch: "main",
      runState: "idle",
      column: "review",
    });
    await userEvent.click(screen.getByRole("button", { name: "Sync" }));
    await userEvent.click(screen.getByRole("button", { name: "Integrate" }));
    expect(onSync).toHaveBeenCalledWith("task-1");
    expect(onIntegrate).toHaveBeenCalledWith("task-1");
  });
});
