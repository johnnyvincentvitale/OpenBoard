/**
 * NewTaskForm — a compact form for creating a new task. Fields: title
 * (required), description, directory (required, absolute path), agent
 * (picked from the roster), and an optional "provider/model-id" text input
 * parsed into a ModelRef on submit. Revealed via a "+ New task" button.
 */
import { useState, type CSSProperties, type FormEvent } from "react";
import type { NewTaskFormProps } from "../task-types";
import type { ModelRef } from "../../shared";

const DEFAULT_AGENT_VALUE = "";

/** Parse "provider/model-id" into a ModelRef, splitting on the first '/'. */
function parseModelInput(raw: string): ModelRef | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) return undefined;
  const providerID = trimmed.slice(0, slashIndex);
  const id = trimmed.slice(slashIndex + 1);
  return { providerID, id };
}

const toggleButtonStyle: CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid rgba(255, 255, 255, 0.15)",
  background: "rgba(255, 255, 255, 0.03)",
  color: "inherit",
  fontFamily: "inherit",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const formStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 12,
  borderRadius: 10,
  border: "1px solid rgba(255, 255, 255, 0.1)",
  background: "rgba(255, 255, 255, 0.03)",
  color: "inherit",
  fontFamily: "inherit",
};

const inputStyle: CSSProperties = {
  padding: "6px 8px",
  borderRadius: 6,
  border: "1px solid rgba(255, 255, 255, 0.15)",
  background: "rgba(0, 0, 0, 0.2)",
  color: "inherit",
  fontFamily: "inherit",
  fontSize: 13,
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  resize: "vertical",
  minHeight: 60,
};

const rowStyle: CSSProperties = {
  display: "flex",
  gap: 8,
};

const actionsRowStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  justifyContent: "flex-end",
};

const submitButtonStyle: CSSProperties = {
  padding: "6px 14px",
  borderRadius: 6,
  border: "1px solid rgba(255, 255, 255, 0.15)",
  background: "rgba(80, 160, 255, 0.25)",
  color: "inherit",
  fontFamily: "inherit",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const cancelButtonStyle: CSSProperties = {
  padding: "6px 14px",
  borderRadius: 6,
  border: "1px solid rgba(255, 255, 255, 0.15)",
  background: "transparent",
  color: "inherit",
  fontFamily: "inherit",
  fontSize: 13,
  cursor: "pointer",
};

export function NewTaskForm({ agents, onCreate }: NewTaskFormProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [directory, setDirectory] = useState("");
  const [agent, setAgent] = useState(DEFAULT_AGENT_VALUE);
  const [modelInput, setModelInput] = useState("");

  const isValid = title.trim().length > 0 && directory.trim().length > 0;

  function resetForm() {
    setTitle("");
    setDescription("");
    setDirectory("");
    setAgent(DEFAULT_AGENT_VALUE);
    setModelInput("");
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isValid) return;

    onCreate({
      title: title.trim(),
      description,
      directory: directory.trim(),
      agent: agent || undefined,
      model: parseModelInput(modelInput),
    });

    resetForm();
    setOpen(false);
  }

  if (!open) {
    return (
      <button
        type="button"
        style={toggleButtonStyle}
        onClick={() => setOpen(true)}
      >
        + New task
      </button>
    );
  }

  return (
    <form style={formStyle} onSubmit={handleSubmit} aria-label="New task">
      <input
        style={inputStyle}
        type="text"
        placeholder="Title"
        aria-label="Title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        required
      />
      <textarea
        style={textareaStyle}
        placeholder="Description"
        aria-label="Description"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
      />
      <input
        style={inputStyle}
        type="text"
        placeholder="/absolute/path/to/project"
        aria-label="Directory"
        value={directory}
        onChange={(event) => setDirectory(event.target.value)}
        required
      />
      <div style={rowStyle}>
        <select
          style={{ ...inputStyle, flex: 1 }}
          aria-label="Agent"
          value={agent}
          onChange={(event) => setAgent(event.target.value)}
        >
          <option value={DEFAULT_AGENT_VALUE}>default</option>
          {agents.map((rosterAgent) => (
            <option key={rosterAgent.id} value={rosterAgent.id}>
              {rosterAgent.id}
            </option>
          ))}
        </select>
        <input
          style={{ ...inputStyle, flex: 1 }}
          type="text"
          placeholder="provider/model-id"
          aria-label="Model"
          value={modelInput}
          onChange={(event) => setModelInput(event.target.value)}
        />
      </div>
      <div style={actionsRowStyle}>
        <button
          type="button"
          style={cancelButtonStyle}
          onClick={() => {
            resetForm();
            setOpen(false);
          }}
        >
          Cancel
        </button>
        <button type="submit" style={submitButtonStyle} disabled={!isValid}>
          Create task
        </button>
      </div>
    </form>
  );
}
