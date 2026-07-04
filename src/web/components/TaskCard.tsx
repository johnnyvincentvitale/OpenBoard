/**
 * TaskCard — the OpenBoard "ledger" card (Nightshade design). A status edge in
 * the column color (oxblood when errored), a mono status line with a pulsing
 * run glyph, a DIR/MODEL/BRANCH meta grid, and a state-driven action row. The
 * ⋯ overflow menu and delete-confirm are inline (no modal / no window.confirm).
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";
import type { TaskCardProps } from "../task-types";
import type { Column, Task, TaskRunState } from "../../shared";
import { t, COLUMN_COLORS, ERROR_COLOR } from "../theme";

interface StatusView {
  glyph: string;
  label: string;
  labelColor: string;
  glyphColor: string;
  pulse: boolean;
  weight: number;
}

/** Derive the status line (glyph + label) from the task's live state. */
function statusView(task: Task, columnColor: string): StatusView {
  if (task.pending === "git-init") {
    return { glyph: "△", label: "BLOCKED", labelColor: t.muted, glyphColor: t.muted, pulse: false, weight: 400 };
  }
  const rs: TaskRunState = task.runState;
  if (rs === "running") {
    return { glyph: "●", label: "RUNNING", labelColor: t.text, glyphColor: columnColor, pulse: true, weight: 400 };
  }
  if (rs === "error") {
    return { glyph: "!", label: "ERROR", labelColor: t.text, glyphColor: t.text, pulse: false, weight: 600 };
  }
  if (rs === "unstarted") {
    return { glyph: "○", label: "UNSTARTED", labelColor: t.dim, glyphColor: t.dim, pulse: false, weight: 400 };
  }
  // idle
  if (task.column === "review") {
    return { glyph: "▲", label: "REVIEW", labelColor: t.text, glyphColor: columnColor, pulse: false, weight: 400 };
  }
  return { glyph: "○", label: "IDLE", labelColor: t.muted, glyphColor: t.muted, pulse: false, weight: 400 };
}

const cardBase: CSSProperties = {
  position: "relative",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  gap: 9,
  padding: "12px 14px 12px 16px",
  borderRadius: 8,
  border: `1px solid ${t.border}`,
  background: t.surface,
  fontFamily: t.fontSans,
};

const edgeStyle = (color: string): CSSProperties => ({
  position: "absolute",
  left: 0,
  top: 0,
  bottom: 0,
  width: 2,
  background: color,
});

const statusRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};

const monoStatus: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontFamily: t.fontMono,
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
};

const titleStyle: CSSProperties = {
  fontFamily: t.fontMono,
  fontWeight: 700,
  fontSize: 13.5,
  lineHeight: 1.4,
  color: t.text,
  overflowWrap: "anywhere",
};

const metaGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "52px 1fr",
  rowGap: 4,
  columnGap: 10,
  borderTop: `1px solid ${t.border}`,
  paddingTop: 8,
};

const metaLabel: CSSProperties = {
  fontFamily: t.fontMono,
  fontSize: 9.5,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: t.dim,
};

const metaValue: CSSProperties = {
  fontFamily: t.fontMono,
  fontSize: 10.5,
  color: t.muted,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const actionRow: CSSProperties = {
  display: "flex",
  gap: 8,
};

const btn: CSSProperties = {
  flex: 1,
  padding: "6px 12px",
  borderRadius: 4,
  border: `1px solid ${t.border}`,
  background: t.surface,
  color: t.text,
  fontFamily: t.fontSans,
  fontWeight: 500,
  fontSize: 11.5,
  cursor: "pointer",
};

const menuTrigger: CSSProperties = {
  border: "none",
  background: "transparent",
  color: t.dim,
  cursor: "pointer",
  fontSize: 12,
  lineHeight: 1,
  padding: "0 2px",
};

const menuStyle: CSSProperties = {
  position: "absolute",
  right: 10,
  top: 30,
  zIndex: 5,
  width: 180,
  background: t.surface,
  border: `1px solid ${t.border}`,
  borderRadius: 6,
  boxShadow: t.elevation2,
  padding: 5,
};

const menuItem: CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  border: "none",
  background: "transparent",
  color: t.text,
  fontFamily: t.fontSans,
  fontSize: 12.5,
  padding: "7px 10px",
  borderRadius: 4,
  cursor: "pointer",
};

const noticeStyle: CSSProperties = {
  fontFamily: t.fontSans,
  fontSize: 12,
  lineHeight: 1.5,
  color: t.muted,
};

const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  borderTop: `1px solid ${t.border}`,
  paddingTop: 8,
};

const statusBadgeStyle = (tone: "complete" | "blocked" | "unconfirmed"): CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  alignSelf: "flex-start",
  padding: "3px 8px",
  borderRadius: 999,
  border: `1px solid ${tone === "blocked" ? ERROR_COLOR : t.border}`,
  color: tone === "blocked" ? "#ffb3b3" : tone === "complete" ? t.accent : t.muted,
  fontFamily: t.fontMono,
  fontSize: 10,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
});

const detailsStyle: CSSProperties = {
  ...noticeStyle,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const linkRowStyle: CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "center",
  flexWrap: "wrap",
};

const compactButton: CSSProperties = {
  ...btn,
  flex: "0 0 auto",
  padding: "4px 8px",
  fontSize: 11,
};

const compactSelect: CSSProperties = {
  ...btn,
  flex: 1,
  minWidth: 0,
  padding: "4px 8px",
  fontSize: 11,
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isReportedComplete(task: Task | undefined): boolean {
  return task?.completionSource === "reported" && task.completion?.outcome === "complete";
}

export function TaskCard({
  task,
  tasks,
  agents,
  onOpenShell,
  onRun,
  onRetry,
  onAbort,
  onDelete,
  onInitGit,
  onSync,
  onIntegrate,
  onArchive,
  onAddParent,
  onRemoveParent,
  notice,
}: TaskCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | undefined>();
  const [selectedParentId, setSelectedParentId] = useState("");
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  const column: Column = task.column;
  const columnColor = COLUMN_COLORS[column];
  const isError = task.runState === "error";
  const isBlocked = task.pending === "git-init";
  const isDone = column === "done";
  const running = task.runState === "running";
  const hasBranch = Boolean(task.worktreeBranch);
  const hasWorktree = Boolean(task.worktreeBranch && task.worktreePath);
  const edgeColor = isError ? ERROR_COLOR : columnColor;
  const status = statusView(task, columnColor);
  const completion = task.completion ?? null;
  const isUnconfirmed = task.column === "review" && task.completionSource === "idle-fallback";
  const isTaskReportedComplete = isReportedComplete(task);
  const hasBlockedCompletion = completion?.outcome === "blocked";
  const canRetry = isError || isUnconfirmed;
  const taskIndex = useMemo(() => new Map(tasks.map((item) => [item.id, item] as const)), [tasks]);
  const parentIds = task.parentIds ?? [];
  const parentTasks = parentIds.map((id) => taskIndex.get(id)).filter((item): item is Task => Boolean(item));
  const childTasks = tasks.filter((candidate) => (candidate.parentIds ?? []).includes(task.id));
  const unmetParentCount = parentIds.filter((id) => {
    const parent = taskIndex.get(id);
    return !parent || (parent.column !== "done" && !isReportedComplete(parent));
  }).length;
  const availableParents = tasks.filter((candidate) => candidate.id !== task.id && !parentIds.includes(candidate.id));
  const displayNotice = notice ?? actionNotice;

  const runAsync = (work: () => void | Promise<void>) => {
    const result = work();
    Promise.resolve(result)
      .then(() => setActionNotice(undefined))
      .catch((error) => setActionNotice(messageOf(error)));
  };

  const rosterAgent = task.agent ? agents.find((a) => a.id === task.agent) : undefined;
  const agentLabel = rosterAgent?.id ?? task.agent;
  const dirLeaf = task.directory.split("/").filter(Boolean).pop() ?? task.directory;

  const copyBranch = () => {
    if (task.worktreeBranch && typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(task.worktreeBranch);
    }
    setMenuOpen(false);
  };

  return (
    <div
      style={{ ...cardBase, ...(isDone ? { opacity: 0.55 } : {}), ...(confirmingDelete ? { borderColor: t.muted } : {}) }}
      data-testid="task-card"
      data-task-id={task.id}
    >
      <div style={edgeStyle(edgeColor)} />

      {/* Status line */}
      <div style={statusRow}>
        <span
          style={{ ...monoStatus, color: status.labelColor, fontWeight: status.weight }}
          data-testid="run-state-pill"
          data-run-state={task.runState}
        >
          <span
            style={{
              color: status.glyphColor,
              ...(status.pulse ? { animation: "ob-pulse 1.6s ease-in-out infinite" } : {}),
            }}
            data-testid={status.pulse ? "pulse-dot" : undefined}
            aria-label={status.pulse ? "running" : undefined}
            role={status.pulse ? "status" : undefined}
          >
            {status.glyph}
          </span>
          {status.label}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          {agentLabel ? (
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.muted }} data-testid="agent-badge">
              {agentLabel}
            </span>
          ) : null}
          <button
            type="button"
            style={menuTrigger}
            aria-label="Task actions"
            onClick={() => setMenuOpen((v) => !v)}
          >
            ⋯
          </button>
        </span>
      </div>

      {/* Title */}
      <div style={titleStyle} title={task.title}>
        {task.title}
      </div>

      {/* Body: meta grid, or error / blocked copy */}
      {isError ? (
        <div style={{ ...noticeStyle, borderTop: `1px solid ${t.border}`, paddingTop: 8 }} data-testid="task-error">
          {task.error ?? "Session reported an error"}
        </div>
      ) : isBlocked ? (
        <div style={{ ...noticeStyle, borderTop: `1px solid ${t.border}`, paddingTop: 8 }} data-testid="git-init-prompt">
          {dirLeaf} is not a git repo — initialize it to isolate this run?
        </div>
      ) : (
        <div style={metaGrid}>
          <span style={metaLabel}>DIR</span>
          <span style={metaValue} title={task.directory}>
            {dirLeaf}
          </span>
          {task.model?.id ? (
            <>
              <span style={metaLabel}>MODEL</span>
              <span style={metaValue} data-testid="model-id">
                {task.model.id}
              </span>
            </>
          ) : null}
          {task.worktreeBranch ? (
            <>
              <span style={metaLabel}>BRANCH</span>
              <span style={metaValue} data-testid="worktree-branch" title={task.worktreePath ?? task.worktreeBranch}>
                ⑃ {task.worktreeBranch}
              </span>
            </>
          ) : null}
        </div>
      )}

      {(completion || isUnconfirmed || parentIds.length > 0 || childTasks.length > 0 || unmetParentCount > 0) ? (
        <div style={sectionStyle}>
          {completion?.outcome === "complete" && task.completionSource === "reported" ? (
            <div data-testid="completion-badge" style={statusBadgeStyle("complete")}>
              completed · {completion.summary}
            </div>
          ) : null}
          {completion?.outcome === "blocked" ? (
            <div data-testid="blocked-badge" style={statusBadgeStyle("blocked")}>
              blocked · {completion.summary}
            </div>
          ) : null}
          {isUnconfirmed ? (
            <div data-testid="unconfirmed-hint" style={statusBadgeStyle("unconfirmed")}>
              unconfirmed · {completion?.summary ?? "review before retrying"}
            </div>
          ) : null}

          {completion ? (
            <details data-testid="handoff-details" style={detailsStyle}>
              <summary style={{ cursor: "pointer" }}>Handoff details</summary>
              <div><strong>Changed files:</strong></div>
              <ul data-testid="changed-files-list" style={{ margin: 0, paddingLeft: 18 }}>
                {completion.changedFiles.length > 0 ? completion.changedFiles.map((file) => <li key={file}>{file}</li>) : <li>none</li>}
              </ul>
              <div><strong>Verification:</strong></div>
              <ul data-testid="verification-list" style={{ margin: 0, paddingLeft: 18 }}>
                {completion.verification.length > 0 ? completion.verification.map((item) => (
                  <li key={`${item.command}-${item.result}`}>
                    <code>{item.command}</code> — {item.result}
                  </li>
                )) : <li>none</li>}
              </ul>
              <div data-testid="residual-risk"><strong>Residual risk:</strong> {completion.residualRisk}</div>
            </details>
          ) : null}

          <div style={detailsStyle}>
            {unmetParentCount > 0 ? (
              <div data-testid="blocked-by-indicator">blocked by {unmetParentCount}</div>
            ) : null}
            <div data-testid="dependency-summary">parents {parentIds.length} · children {childTasks.length}</div>
            {parentTasks.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {parentTasks.map((parent) => (
                  <div key={parent.id} style={linkRowStyle}>
                    <span>{parent.title}</span>
                    <button
                      type="button"
                      style={compactButton}
                      data-testid={`remove-parent-${parent.id}`}
                      onClick={() => runAsync(() => onRemoveParent(task.id, parent.id))}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <div style={linkRowStyle}>
              <select
                aria-label="Add parent task"
                data-testid="parent-picker"
                style={compactSelect}
                value={selectedParentId}
                onChange={(event) => setSelectedParentId(event.target.value)}
              >
                <option value="">Add parent…</option>
                {availableParents.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.title}
                  </option>
                ))}
              </select>
              <button
                type="button"
                style={compactButton}
                disabled={!selectedParentId}
                onClick={() => {
                  const parentId = selectedParentId;
                  runAsync(async () => {
                    await onAddParent(task.id, parentId);
                    setSelectedParentId("");
                  });
                }}
              >
                Add parent
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {displayNotice ? (
        <div style={noticeStyle} data-testid="task-notice">
          {displayNotice}
        </div>
      ) : null}

      {/* Delete confirm (inline) or action row */}
      {confirmingDelete ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          <div style={noticeStyle}>
            {hasWorktree
              ? `Delete this task? The worktree and branch ⑃ ${task.worktreeBranch} are kept.`
              : hasBranch
                ? `Delete this task? The branch ⑃ ${task.worktreeBranch} is kept.`
                : "Delete this task?"}
          </div>
          <div style={actionRow}>
            <button type="button" style={{ ...btn, fontWeight: 600 }} onClick={() => onDelete(task.id)}>
              Delete
            </button>
            <button
              type="button"
              style={{ ...btn, background: "transparent", border: "none", color: t.muted }}
              onClick={() => setConfirmingDelete(false)}
            >
              Keep
            </button>
          </div>
        </div>
      ) : (
        <ActionRow
          task={task}
          isBlocked={isBlocked}
          isError={isError}
          isDone={isDone}
          running={running}
          hasWorktree={hasWorktree}
          isReportedComplete={isTaskReportedComplete}
          hasBlockedCompletion={hasBlockedCompletion}
          canRetry={canRetry}
          onRun={(id) => runAsync(() => onRun(id))}
          onRetry={(id) => runAsync(() => onRetry(id))}
          onAbort={(id) => runAsync(() => onAbort(id))}
          onInitGit={(id) => runAsync(() => onInitGit(id))}
          onSync={(id) => runAsync(() => onSync(id))}
          onIntegrate={(id) => runAsync(() => onIntegrate(id))}
          onArchive={(id) => runAsync(() => onArchive(id))}
        />
      )}

      {/* Overflow menu */}
      {menuOpen ? (
        <div ref={menuRef} style={menuStyle} data-testid="task-menu">
          <button type="button" style={menuItem} onClick={() => { setMenuOpen(false); onOpenShell(task); }}>
            Open shell
          </button>
          {canRetry && !isBlocked ? (
            <button type="button" style={menuItem} onClick={() => { setMenuOpen(false); runAsync(() => onRetry(task.id)); }}>
              Retry
            </button>
          ) : null}
          {hasWorktree ? (
            <button type="button" style={menuItem} onClick={() => { setMenuOpen(false); runAsync(() => onSync(task.id)); }}>
              Sync worktree
            </button>
          ) : null}
          {task.worktreeBranch ? (
            <button type="button" style={menuItem} onClick={copyBranch}>
              Copy branch name
            </button>
          ) : null}
          <div style={{ height: 1, background: t.border, margin: "5px 0" }} />
          <button
            type="button"
            style={{ ...menuItem, fontWeight: 600 }}
            onClick={() => { setMenuOpen(false); setConfirmingDelete(true); }}
          >
            Delete task…
          </button>
        </div>
      ) : null}
    </div>
  );
}

interface ActionRowProps {
  task: Task;
  isBlocked: boolean;
  isError: boolean;
  isDone: boolean;
  running: boolean;
  hasWorktree: boolean;
  isReportedComplete: boolean;
  hasBlockedCompletion: boolean;
  canRetry: boolean;
  onRun: (id: string) => void;
  onRetry: (id: string) => void;
  onAbort: (id: string) => void;
  onInitGit: (id: string) => void;
  onSync: (id: string) => void;
  onIntegrate: (id: string) => void;
  onArchive: (id: string) => void;
}

/** State-driven buttons, per the design's action-row spec. */
function ActionRow(p: ActionRowProps) {
  const { task } = p;
  const canArchive = task.column === "review" || task.column === "done";

  let buttons: ReactElement[] = [];
  if (p.isDone) {
    buttons = [];
  } else if (p.isBlocked) {
    buttons = [
      <button key="init" type="button" style={btn} onClick={() => p.onInitGit(task.id)}>
        Make repo &amp; run
      </button>,
    ];
  } else if (p.running) {
    buttons = [
      <button key="stop" type="button" style={btn} onClick={() => p.onAbort(task.id)}>
        Stop
      </button>,
    ];
  } else if (p.canRetry) {
    buttons = [
      <button key="retry" type="button" style={btn} onClick={() => p.onRetry(task.id)}>
        Retry
      </button>,
    ];
  } else if (task.column === "review") {
    buttons = p.hasWorktree
      ? [
          <button key="integrate" type="button" style={{ ...btn, borderColor: t.accent }} onClick={() => p.onIntegrate(task.id)}>
            Integrate
          </button>,
          <button key="sync" type="button" style={btn} onClick={() => p.onSync(task.id)}>
            Sync
          </button>,
        ]
      : p.isReportedComplete || p.hasBlockedCompletion
        ? []
        : [];
  } else {
    buttons = [
      <button key="run" type="button" style={btn} onClick={() => p.onRun(task.id)}>
        Run
      </button>,
    ];
  }

  if (canArchive) {
    buttons = [
      ...buttons,
      <button
        key="archive"
        type="button"
        data-testid={`archive-task-${task.id}`}
        style={btn}
        onClick={() => p.onArchive(task.id)}
      >
        Archive
      </button>,
    ];
  }

  if (buttons.length === 0) return null;

  return (
    <div style={actionRow} data-testid="task-actions">
      {buttons}
    </div>
  );
}
