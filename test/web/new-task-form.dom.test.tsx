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

/** The panel is controlled; open it by default for form tests. */
function renderPanel(open = true) {
  const onCreate = vi.fn();
  const onClose = vi.fn();
  render(<NewTaskForm agents={makeAgents()} onCreate={onCreate} open={open} onClose={onClose} />);
  return { onCreate, onClose };
}

describe("NewTaskForm (slide-over panel)", () => {
  it("renders nothing when closed", () => {
    renderPanel(false);
    expect(screen.queryByLabelText("Title")).not.toBeInTheDocument();
  });

  it("fills fields, picks an agent, and submits with the right shape (no model field)", async () => {
    const user = userEvent.setup();
    const { onCreate, onClose } = renderPanel();

    await user.type(screen.getByLabelText("Title"), "Refactor auth flow");
    await user.type(screen.getByLabelText("Description"), "Clean up the login handler");
    await user.type(screen.getByLabelText("Directory"), "/tmp/openboard");
    await user.selectOptions(screen.getByLabelText("Agent"), "build");

    // No model input on the card — the model comes from the agent's config.
    expect(screen.queryByLabelText("Model")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create task" }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith({
      title: "Refactor auth flow",
      description: "Clean up the login handler",
      directory: "/tmp/openboard",
      agent: "build",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("submits with agent undefined when left as default", async () => {
    const user = userEvent.setup();
    const { onCreate } = renderPanel();

    await user.type(screen.getByLabelText("Title"), "Ship it");
    await user.type(screen.getByLabelText("Directory"), "/tmp/project");
    await user.click(screen.getByRole("button", { name: "Create task" }));

    expect(onCreate).toHaveBeenCalledWith({
      title: "Ship it",
      description: "",
      directory: "/tmp/project",
      agent: undefined,
    });
  });

  it("keeps Create disabled until title and directory are set", async () => {
    const user = userEvent.setup();
    const { onCreate } = renderPanel();

    const submit = screen.getByRole("button", { name: "Create task" });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText("Title"), "Only a title");
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText("Directory"), "/tmp/project");
    expect(submit).toBeEnabled();

    await user.click(submit);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("Cancel closes the panel without creating", async () => {
    const user = userEvent.setup();
    const { onCreate, onClose } = renderPanel();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("submits an explicit isolation from the segmented control, omits it on board default", async () => {
    const user = userEvent.setup();
    const { onCreate } = renderPanel();

    await user.type(screen.getByLabelText("Title"), "Isolated task");
    await user.type(screen.getByLabelText("Directory"), "/repo");
    await user.click(screen.getByRole("button", { name: "Worktree" }));
    await user.click(screen.getByRole("button", { name: "Create task" }));

    expect(onCreate.mock.calls[0][0]).toMatchObject({ title: "Isolated task", isolation: "worktree" });
  });

  it("omits isolation when left on Board default", async () => {
    const user = userEvent.setup();
    const { onCreate } = renderPanel();

    await user.type(screen.getByLabelText("Title"), "Default task");
    await user.type(screen.getByLabelText("Directory"), "/repo");
    await user.click(screen.getByRole("button", { name: "Create task" }));

    expect(onCreate.mock.calls[0][0].isolation).toBeUndefined();
  });
});
