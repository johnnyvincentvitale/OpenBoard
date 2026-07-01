// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Card } from "../../src/shared";
import { SessionCard } from "../../src/web/components/SessionCard";

afterEach(cleanup);

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    sessionId: "session-1",
    title: "Refactor auth flow",
    directory: "/Users/johnnyvitale/code/opencode-board",
    agent: "build",
    model: { id: "claude-sonnet-5", providerID: "anthropic" },
    cost: 0.42,
    additions: 12,
    deletions: 3,
    files: 4,
    column: "in_progress",
    position: 0,
    liveState: "idle",
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("SessionCard", () => {
  it("renders title, directory, agent + model, cost, and diff stat", () => {
    const card = makeCard();
    render(
      <SessionCard
        card={card}
        onPrompt={vi.fn()}
        onInterrupt={vi.fn()}
        onDiff={vi.fn()}
      />,
    );

    expect(screen.getByText("Refactor auth flow")).toBeInTheDocument();
    expect(screen.getByText("opencode-board")).toBeInTheDocument();
    expect(screen.getByText("build · claude-sonnet-5")).toBeInTheDocument();
    expect(screen.getByText("$0.42")).toBeInTheDocument();

    const diffStat = screen.getByTestId("diff-stat");
    expect(diffStat).toHaveTextContent("+12");
    expect(diffStat).toHaveTextContent("-3");
    expect(diffStat).toHaveTextContent("(4 files)");
  });

  it("shows an animated pulse dot when liveState is running", () => {
    const card = makeCard({ liveState: "running" });
    render(
      <SessionCard
        card={card}
        onPrompt={vi.fn()}
        onInterrupt={vi.fn()}
        onDiff={vi.fn()}
      />,
    );

    expect(screen.getByTestId("pulse-dot")).toBeInTheDocument();
    const pill = screen.getByTestId("live-state-pill");
    expect(pill).toHaveAttribute("data-live-state", "running");
  });

  it("does not show the pulse dot for non-running states", () => {
    for (const liveState of ["idle", "error", "retrying", "unknown"] as const) {
      const card = makeCard({ liveState });
      const { unmount } = render(
        <SessionCard
          card={card}
          onPrompt={vi.fn()}
          onInterrupt={vi.fn()}
          onDiff={vi.fn()}
        />,
      );

      expect(screen.queryByTestId("pulse-dot")).not.toBeInTheDocument();
      const pill = screen.getByTestId("live-state-pill");
      expect(pill).toHaveAttribute("data-live-state", liveState);
      unmount();
    }
  });

  it("calls onPrompt with the sessionId when Prompt is clicked", async () => {
    const user = userEvent.setup();
    const onPrompt = vi.fn();
    const card = makeCard({ sessionId: "abc-123" });
    render(
      <SessionCard
        card={card}
        onPrompt={onPrompt}
        onInterrupt={vi.fn()}
        onDiff={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Prompt" }));
    expect(onPrompt).toHaveBeenCalledTimes(1);
    expect(onPrompt).toHaveBeenCalledWith("abc-123");
  });

  it("calls onDiff with the sessionId when Diff is clicked", async () => {
    const user = userEvent.setup();
    const onDiff = vi.fn();
    const card = makeCard({ sessionId: "abc-123" });
    render(
      <SessionCard
        card={card}
        onPrompt={vi.fn()}
        onInterrupt={vi.fn()}
        onDiff={onDiff}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Diff" }));
    expect(onDiff).toHaveBeenCalledTimes(1);
    expect(onDiff).toHaveBeenCalledWith("abc-123");
  });

  it("calls onInterrupt with the sessionId when Stop is clicked and running", async () => {
    const user = userEvent.setup();
    const onInterrupt = vi.fn();
    const card = makeCard({ sessionId: "abc-123", liveState: "running" });
    render(
      <SessionCard
        card={card}
        onPrompt={vi.fn()}
        onInterrupt={onInterrupt}
        onDiff={vi.fn()}
      />,
    );

    const stopButton = screen.getByRole("button", { name: "Stop" });
    expect(stopButton).toBeEnabled();
    await user.click(stopButton);
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(onInterrupt).toHaveBeenCalledWith("abc-123");
  });

  it("disables Stop when the session is not running", () => {
    const card = makeCard({ liveState: "idle" });
    render(
      <SessionCard
        card={card}
        onPrompt={vi.fn()}
        onInterrupt={vi.fn()}
        onDiff={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
  });
});
