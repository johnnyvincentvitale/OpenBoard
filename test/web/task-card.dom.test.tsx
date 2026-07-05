// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
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
    directory: "/tmp/openboard",
    agent: "build",
    model: { id: "claude-sonnet-5", providerID: "anthropic" },
    column: "todo",
    position: 0,
    runState: "unstarted",
    baseCommit: null,
    dirtyAtDispatch: false,
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
  onOpenShell: (task: Task) => void;
  onRun: (id: string) => void | Promise<void>;
  onRetry: (id: string) => void | Promise<void>;
  onAbort: (id: string) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
  onInitGit: (id: string) => void | Promise<void>;
  onSync: (id: string) => void | Promise<void>;
  onIntegrate: (id: string) => void | Promise<void>;
  onArchive: (id: string) => void | Promise<void>;
  onAddParent: (taskId: string, parentId: string) => void | Promise<void>;
  onRemoveParent: (taskId: string, parentId: string) => void | Promise<void>;
  tasks: Task[];
}> = {}) {
  const task = makeTask(overrides);
  const onOpenShell = handlers.onOpenShell ?? vi.fn();
  const onRun = handlers.onRun ?? vi.fn();
  const onRetry = handlers.onRetry ?? vi.fn();
  const onAbort = handlers.onAbort ?? vi.fn();
  const onDelete = handlers.onDelete ?? vi.fn();
  const onInitGit = handlers.onInitGit ?? vi.fn();
  const onSync = handlers.onSync ?? vi.fn();
  const onIntegrate = handlers.onIntegrate ?? vi.fn();
  const onArchive = handlers.onArchive ?? vi.fn();
  const onAddParent = handlers.onAddParent ?? vi.fn();
  const onRemoveParent = handlers.onRemoveParent ?? vi.fn();
  const tasks = handlers.tasks ?? [task];

  render(
    <TaskCard
      task={task}
      tasks={tasks}
      agents={makeAgents()}
      onOpenShell={onOpenShell}
      onRun={onRun}
      onRetry={onRetry}
      onAbort={onAbort}
      onDelete={onDelete}
      onInitGit={onInitGit}
      onSync={onSync}
      onIntegrate={onIntegrate}
      onArchive={onArchive}
      onAddParent={onAddParent}
      onRemoveParent={onRemoveParent}
    />,
  );

  return { task, tasks, onOpenShell, onRun, onRetry, onAbort, onDelete, onInitGit, onSync, onIntegrate, onArchive, onAddParent, onRemoveParent };
}

describe("TaskCard", () => {
  it("renders title, directory leaf, agent badge, and runState", () => {
    renderCard();

    expect(screen.getByText("Build the login form")).toBeInTheDocument();
    // The card shows the directory leaf in the DIR meta row.
    expect(screen.getByText("openboard")).toBeInTheDocument();
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
          tasks={[makeTask({ runState, column: "in_progress" })]}
          agents={makeAgents()}
          onOpenShell={vi.fn()}
          onRun={vi.fn()}
          onRetry={vi.fn()}
          onAbort={vi.fn()}
          onDelete={vi.fn()}
          onInitGit={vi.fn()}
          onSync={vi.fn()}
          onIntegrate={vi.fn()}
          onArchive={vi.fn()}
          onAddParent={vi.fn()}
          onRemoveParent={vi.fn()}
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
    const { onRetry, task } = renderCard({ runState: "idle", column: "review", completionSource: "idle-fallback" });

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

  it("shows Archive in the action row on done cards and calls onArchive with the id", async () => {
    const user = userEvent.setup();
    const { onArchive, task } = renderCard({ runState: "idle", column: "done" });

    const actions = screen.getByTestId("task-actions");
    const archiveButton = within(actions).getByRole("button", { name: "Archive" });
    await user.click(archiveButton);
    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(onArchive).toHaveBeenCalledWith(task.id);
  });

  it("shows Archive alongside Integrate and Sync on review cards with a worktree", () => {
    renderCard({
      runState: "idle",
      column: "review",
      completionSource: "reported",
      completion: {
        outcome: "complete",
        summary: "done",
        changedFiles: [],
        verification: [],
        residualRisk: "none",
        reportedAt: 1,
      },
      isolation: "worktree",
      worktreePath: "/tmp/wt",
      worktreeBranch: "board/task-1",
    });

    const actions = screen.getByTestId("task-actions");
    expect(within(actions).getByRole("button", { name: "Integrate" })).toBeInTheDocument();
    expect(within(actions).getByRole("button", { name: "Sync" })).toBeInTheDocument();
    expect(within(actions).getByRole("button", { name: "Archive" })).toBeInTheDocument();
  });

  it("hides Archive on todo and in-progress cards", () => {
    renderCard({ runState: "unstarted", column: "todo" });
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
  });

  it("calls onDelete with the id after the inline confirm", async () => {
    const user = userEvent.setup();
    const { onDelete, task } = renderCard();

    await user.click(screen.getByRole("button", { name: "Task actions" }));
    await user.click(screen.getByRole("button", { name: /Delete task/ }));
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith(task.id);
  });

  it("opens a shell from the overflow menu", async () => {
    const user = userEvent.setup();
    const { onOpenShell, task } = renderCard();

    await user.click(screen.getByRole("button", { name: "Task actions" }));
    await user.click(screen.getByRole("button", { name: "Open shell" }));

    expect(onOpenShell).toHaveBeenCalledWith(task);
  });

  it("does not call onDelete when the inline confirm is kept", async () => {
    const user = userEvent.setup();
    const { onDelete } = renderCard();

    await user.click(screen.getByRole("button", { name: "Task actions" }));
    await user.click(screen.getByRole("button", { name: /Delete task/ }));
    await user.click(screen.getByRole("button", { name: "Keep" }));

    expect(onDelete).not.toHaveBeenCalled();
    // Back to the normal action row.
    expect(screen.queryByRole("button", { name: "Keep" })).not.toBeInTheDocument();
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

  it("keeps the branch visible but hides worktree actions after integration", () => {
    renderCard({
      worktreeBranch: "board/task-1",
      worktreePath: undefined,
      baseBranch: "main",
      runState: "idle",
      column: "review",
      completion: {
        outcome: "complete",
        summary: "done",
        changedFiles: [],
        verification: [],
        residualRisk: "none",
        reportedAt: 1,
      },
      completionSource: "reported",
    });

    expect(screen.getByTestId("worktree-branch")).toHaveTextContent("board/task-1");
    expect(screen.queryByRole("button", { name: "Sync" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Integrate" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("shows Stop (not Integrate) while the session is still running", () => {
    renderCard({
      worktreeBranch: "board/task-1",
      worktreePath: "/wt/task-1",
      baseBranch: "main",
      runState: "running",
      column: "in_progress",
    });
    // Running cards show Stop in the action row; Integrate/Sync are not there.
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
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

  it("renders a completed badge and expandable handoff details", async () => {
    const user = userEvent.setup();
    renderCard({
      column: "done",
      completion: {
        outcome: "complete",
        summary: "tests passed",
        changedFiles: ["src/web/components/TaskCard.tsx"],
        verification: [{ command: "npm test", result: "passed" }],
        residualRisk: "none",
        reportedAt: 1,
      },
      completionSource: "reported",
    });

    expect(screen.getByTestId("completion-badge")).toHaveTextContent("completed · tests passed");
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    await user.click(screen.getByText("Handoff details"));
    expect(screen.getByTestId("changed-files-list")).toHaveTextContent("src/web/components/TaskCard.tsx");
    expect(screen.getByTestId("verification-list")).toHaveTextContent("npm test");
    expect(screen.getByTestId("residual-risk")).toHaveTextContent("none");
  });

  it("renders a blocked badge from a completion report", () => {
    renderCard({
      column: "review",
      runState: "error",
      error: "design unanswered",
      completion: {
        outcome: "blocked",
        summary: "waiting on design decision",
        changedFiles: [],
        verification: [],
        residualRisk: "design unanswered",
        reportedAt: 1,
      },
      completionSource: "reported",
    });

    expect(screen.getByTestId("blocked-badge")).toHaveTextContent("blocked · waiting on design decision");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("shows an unconfirmed hint and keeps Retry for idle-fallback review cards", () => {
    renderCard({
      column: "review",
      completion: {
        outcome: "complete",
        summary: "idle fallback summary",
        changedFiles: [],
        verification: [],
        residualRisk: "verify manually",
        reportedAt: 1,
      },
      completionSource: "idle-fallback",
    });

    expect(screen.getByTestId("unconfirmed-hint")).toHaveTextContent("unconfirmed · idle fallback summary");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("hides Retry for worktree-less review cards that already reported completion", () => {
    renderCard({
      column: "review",
      runState: "idle",
      completion: {
        outcome: "complete",
        summary: "reported done",
        changedFiles: [],
        verification: [],
        residualRisk: "none",
        reportedAt: 1,
      },
      completionSource: "reported",
    });

    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("surfaces run errors like unmet-parent 409 messages cleanly", async () => {
    const user = userEvent.setup();
    renderCard({}, { onRun: vi.fn(async () => { throw new Error("Cannot run: unmet parents Alpha, Beta"); }) });

    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByTestId("task-notice")).toHaveTextContent("Cannot run: unmet parents Alpha, Beta");
  });

  it("shows blocked-by counts and parent/child summaries from task state", () => {
    const parent = makeTask({ id: "parent-1", title: "Parent task", column: "review", runState: "idle" });
    const child = makeTask({ id: "child-1", title: "Child task", parentIds: ["task-1"] });

    renderCard({ parentIds: ["parent-1"] }, { tasks: [makeTask({ parentIds: ["parent-1"] }), parent, child] });

    expect(screen.getByTestId("blocked-by-indicator")).toHaveTextContent("blocked by 1");
    expect(screen.getByTestId("dependency-summary")).toHaveTextContent("parents 1 · children 1");
  });

  it("adds and removes parent links via the dependency controls", async () => {
    const user = userEvent.setup();
    const onAddParent = vi.fn();
    const onRemoveParent = vi.fn();
    const existingParent = makeTask({ id: "parent-1", title: "Existing parent" });
    const extraParent = makeTask({ id: "parent-2", title: "Extra parent" });
    const task = makeTask({ parentIds: ["parent-1"] });

    renderCard(
      { parentIds: ["parent-1"] },
      { tasks: [task, existingParent, extraParent], onAddParent, onRemoveParent },
    );

    await user.selectOptions(screen.getByTestId("parent-picker"), "parent-2");
    await user.click(screen.getByRole("button", { name: "Add parent" }));
    expect(onAddParent).toHaveBeenCalledWith("task-1", "parent-2");

    await user.click(screen.getByTestId("remove-parent-parent-1"));
    expect(onRemoveParent).toHaveBeenCalledWith("task-1", "parent-1");
  });
});
