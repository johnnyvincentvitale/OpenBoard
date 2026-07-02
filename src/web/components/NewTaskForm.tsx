/**
 * NewTaskForm — a compact form for creating a new task. Fields: title
 * (required), description, directory (required, absolute path), agent
 * (picked from the roster), and an isolation choice. There is no model/provider
 * field: the model is resolved from the assigned agent's OpenCode config, not
 * per task. Revealed via a "+ New task" button.
 */
import { useState, type CSSProperties, type FormEvent } from "react";
import type { NewTaskFormProps } from "../task-types";
import type { TaskIsolationMode } from "../../shared";

const DEFAULT_AGENT_VALUE = "";
/** "" = inherit the board default; otherwise an explicit per-task override. */
type IsolationChoice = "" | TaskIsolationMode;

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
  const [isolation, setIsolation] = useState<IsolationChoice>("");

  const isValid = title.trim().length > 0 && directory.trim().length > 0;

  function resetForm() {
    setTitle("");
    setDescription("");
    setDirectory("");
    setAgent(DEFAULT_AGENT_VALUE);
    setIsolation("");
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isValid) return;

    onCreate({
      title: title.trim(),
      description,
      directory: directory.trim(),
      agent: agent || undefined,
      ...(isolation ? { isolation } : {}),
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
      <select
        style={inputStyle}
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
      <select
        style={inputStyle}
        aria-label="Isolation"
        value={isolation}
        onChange={(event) => setIsolation(event.target.value as IsolationChoice)}
      >
        <option value="">Isolation: board default</option>
        <option value="worktree">Isolation: worktree</option>
        <option value="in-place">Isolation: in-place</option>
      </select>
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
