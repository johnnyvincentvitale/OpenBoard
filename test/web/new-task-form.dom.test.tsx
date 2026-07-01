// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RosterAgent } from "../../src/shared";
import { NewTaskForm } from "../../src/web/components/NewTaskForm";

afterEach(cleanup);

function makeAgents(): RosterAgent[] {
  return [
    { id: "build", mode: "primary" },
    { id: "review", mode: "subagent" },
  ];
}

describe("NewTaskForm", () => {
  it("fills fields, picks an agent, types a model, and submits with the right shape", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<NewTaskForm agents={makeAgents()} onCreate={onCreate} />);

    await user.click(screen.getByRole("button", { name: "+ New task" }));

    await user.type(screen.getByLabelText("Title"), "Refactor auth flow");
    await user.type(
      screen.getByLabelText("Description"),
      "Clean up the login handler",
    );
    await user.type(
      screen.getByLabelText("Directory"),
      "/Users/johnnyvitale/code/opencode-board",
    );
    await user.selectOptions(screen.getByLabelText("Agent"), "build");
    await user.type(
      screen.getByLabelText("Model"),
      "opencode/north-mini-code-free",
    );

    await user.click(screen.getByRole("button", { name: "Create task" }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith({
      title: "Refactor auth flow",
      description: "Clean up the login handler",
      directory: "/Users/johnnyvitale/code/opencode-board",
      agent: "build",
      model: { providerID: "opencode", id: "north-mini-code-free" },
    });

    // Form clears and collapses after submit.
    expect(
      screen.queryByLabelText("Title"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "+ New task" }),
    ).toBeInTheDocument();
  });

  it("submits with agent undefined when left as default, and model undefined when blank", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<NewTaskForm agents={makeAgents()} onCreate={onCreate} />);

    await user.click(screen.getByRole("button", { name: "+ New task" }));
    await user.type(screen.getByLabelText("Title"), "Ship it");
    await user.type(screen.getByLabelText("Directory"), "/tmp/project");

    await user.click(screen.getByRole("button", { name: "Create task" }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith({
      title: "Ship it",
      description: "",
      directory: "/tmp/project",
      agent: undefined,
      model: undefined,
    });
  });

  it("does not submit when title is empty", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<NewTaskForm agents={makeAgents()} onCreate={onCreate} />);

    await user.click(screen.getByRole("button", { name: "+ New task" }));
    await user.type(screen.getByLabelText("Directory"), "/tmp/project");

    const submitButton = screen.getByRole("button", { name: "Create task" });
    expect(submitButton).toBeDisabled();

    await user.click(submitButton);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("does not submit when directory is empty", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<NewTaskForm agents={makeAgents()} onCreate={onCreate} />);

    await user.click(screen.getByRole("button", { name: "+ New task" }));
    await user.type(screen.getByLabelText("Title"), "Missing directory");

    const submitButton = screen.getByRole("button", { name: "Create task" });
    expect(submitButton).toBeDisabled();

    await user.click(submitButton);
    expect(onCreate).not.toHaveBeenCalled();
  });
});
