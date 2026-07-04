/**
 * NewTaskForm — the "New task" slide-over panel (Nightshade design). Controlled
 * by the App (the rail's "+ New task" opens it). Collects title, description,
 * directory, agent, and an isolation segmented control. No model/provider field:
 * the model is resolved from the assigned agent's OpenCode config.
 */
import { useState, type CSSProperties, type FormEvent } from "react";
import type { NewTaskFormProps } from "../task-types";
import type { TaskIsolationMode } from "../../shared";
import { t, outlineAction } from "../theme";

const DEFAULT_AGENT_VALUE = "";
type IsolationChoice = "" | TaskIsolationMode;

const ISOLATION_SEGMENTS: Array<{ value: IsolationChoice; label: string }> = [
  { value: "", label: "Board default" },
  { value: "worktree", label: "Worktree" },
  { value: "in-place", label: "In-place" },
];

const panelStyle: CSSProperties = {
  position: "absolute",
  top: 0,
  right: 0,
  bottom: 0,
  width: 400,
  zIndex: 20,
  display: "flex",
  flexDirection: "column",
  gap: 16,
  padding: "22px 20px",
  background: t.ground,
  borderLeft: `1px solid ${t.border}`,
  overflowY: "auto",
  fontFamily: t.fontSans,
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};

const labelStyle: CSSProperties = {
  fontFamily: t.fontSans,
  fontWeight: 300,
  fontSize: 11,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: t.muted,
};

const fieldStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 6 };

const inputStyle: CSSProperties = {
  background: t.ground,
  border: `1px solid ${t.border}`,
  borderRadius: 4,
  padding: "8px 10px",
  color: t.text,
  fontFamily: t.fontSans,
  fontSize: 13,
};

const monoInput: CSSProperties = { ...inputStyle, fontFamily: t.fontMono, fontSize: 12 };

const helpStyle: CSSProperties = { fontFamily: t.fontSans, fontSize: 11, color: t.dim };

const segmentedStyle: CSSProperties = {
  display: "flex",
  gap: 3,
  padding: 3,
  background: "#000",
  border: `1px solid ${t.border}`,
  borderRadius: 8,
};

const segStyle = (active: boolean): CSSProperties => ({
  flex: 1,
  padding: "6px 12px",
  borderRadius: 5,
  fontFamily: t.fontMono,
  fontSize: 12,
  cursor: "pointer",
  ...(active
    ? outlineAction
    : { border: "none", background: "transparent", color: t.muted }),
});

const footerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  borderTop: `1px solid ${t.border}`,
  paddingTop: 16,
  marginTop: "auto",
};

const ghostBtn: CSSProperties = {
  padding: "8px 16px",
  borderRadius: 4,
  border: "none",
  background: "transparent",
  color: t.muted,
  fontFamily: t.fontSans,
  fontWeight: 500,
  fontSize: 13,
  cursor: "pointer",
};

const primaryBtn = (enabled: boolean): CSSProperties => ({
  padding: "8px 16px",
  borderRadius: 4,
  fontSize: 13,
  cursor: enabled ? "pointer" : "not-allowed",
  ...(enabled
    ? outlineAction
    : {
        border: "none",
        background: t.surface,
        color: t.dim,
        fontFamily: t.fontSans,
        fontWeight: 500,
      }),
});

const closeBtn: CSSProperties = {
  border: "none",
  background: "transparent",
  color: t.muted,
  fontSize: 16,
  cursor: "pointer",
  lineHeight: 1,
};

export function NewTaskForm({ agents, onCreate, open, onClose }: NewTaskFormProps) {
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

  function close() {
    resetForm();
    onClose();
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
    onClose();
  }

  if (!open) return null;

  return (
    <form style={panelStyle} onSubmit={handleSubmit} aria-label="New task">
      <div style={headerStyle}>
        <span style={{ fontFamily: t.fontLogo, fontWeight: 400, fontSize: 24, letterSpacing: "0.05em", color: t.text }}>New Task</span>
        <button type="button" style={closeBtn} aria-label="Close" onClick={close}>
          ✕
        </button>
      </div>

      <label style={fieldStyle}>
        <span style={labelStyle}>Title</span>
        <input
          style={inputStyle}
          type="text"
          aria-label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
      </label>

      <label style={fieldStyle}>
        <span style={labelStyle}>Description</span>
        <textarea
          style={{ ...inputStyle, minHeight: 88, resize: "vertical" }}
          aria-label="Description"
          placeholder="What should the agent do, and what does done look like?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>

      <label style={fieldStyle}>
        <span style={labelStyle}>Directory</span>
        <input
          style={monoInput}
          type="text"
          aria-label="Directory"
          value={directory}
          onChange={(e) => setDirectory(e.target.value)}
          required
        />
        <span style={helpStyle}>Absolute path. The agent works here.</span>
      </label>

      <label style={fieldStyle}>
        <span style={labelStyle}>Agent</span>
        <select
          style={inputStyle}
          aria-label="Agent"
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
        >
          <option value={DEFAULT_AGENT_VALUE}>default</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.id}
            </option>
          ))}
        </select>
        <span style={helpStyle}>Model resolves from the agent&apos;s OpenCode config.</span>
      </label>

      <div style={fieldStyle}>
        <span style={labelStyle}>Isolation</span>
        <div style={segmentedStyle} role="group" aria-label="Isolation">
          {ISOLATION_SEGMENTS.map((seg) => (
            <button
              key={seg.value || "default"}
              type="button"
              style={segStyle(isolation === seg.value)}
              aria-pressed={isolation === seg.value}
              onClick={() => setIsolation(seg.value)}
            >
              {seg.label}
            </button>
          ))}
        </div>
      </div>

      <div style={footerStyle}>
        <button type="button" style={ghostBtn} onClick={close}>
          Cancel
        </button>
        <button type="submit" style={primaryBtn(isValid)} disabled={!isValid}>
          Create task
        </button>
      </div>
    </form>
  );
}
