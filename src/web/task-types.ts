import type { ReactNode } from "react";
import type { BoardSettings, Column, ModelRef, RosterAgent, Task, TaskIsolationMode } from "../shared";

/**
 * Pinned frontend contracts for the functional task board. TaskCard (agent C),
 * NewTaskForm (agent D), TaskBoard (agent B), and the store/client (agent A) all
 * build against these — do not redefine.
 */

export interface CreateTaskFields {
  title: string;
  description: string;
  directory: string;
  agent?: string;
  model?: ModelRef;
  /** Isolation override; unset → the board default applies. */
  isolation?: TaskIsolationMode;
}

export interface TaskCardProps {
  task: Task;
  tasks: Task[];
  /** The roster, so the card can show the assigned agent's label. */
  agents: RosterAgent[];
  onOpenShell: (task: Task) => void;
  onRun: (taskId: string) => void | Promise<void>;
  onRetry: (taskId: string) => void | Promise<void>;
  onAbort: (taskId: string) => void | Promise<void>;
  onDelete: (taskId: string) => void | Promise<void>;
  /** Answer the git-init prompt for a non-repo dir (worktree mode), then run. */
  onInitGit: (taskId: string) => void | Promise<void>;
  /** Merge the upstream base branch into the task's worktree branch. */
  onSync: (taskId: string) => void | Promise<void>;
  /** Merge the worktree branch into base, remove the worktree, keep the branch. */
  onIntegrate: (taskId: string) => void | Promise<void>;
  /** Archive a review/done card off the active board. */
  onArchive: (taskId: string) => void | Promise<void>;
  onAddParent: (taskId: string, parentId: string) => void | Promise<void>;
  onRemoveParent: (taskId: string, parentId: string) => void | Promise<void>;
  /** Quiet inline message (sync/integrate result) shown on the card. */
  notice?: string;
}

export interface TaskBoardProps {
  tasks: Task[];
  onMove: (taskId: string, column: Column, position: number) => void;
  /** App passes TaskCard bound to its handlers, keeping board and card decoupled. */
  renderCard: (task: Task) => ReactNode;
}

export interface NewTaskFormProps {
  agents: RosterAgent[];
  onCreate: (fields: CreateTaskFields) => void;
  /** The slide-over panel is controlled by the App (rail "+ New task" opens it). */
  open: boolean;
  onClose: () => void;
}

export interface TaskBoardStatus {
  opencode: "ok" | "unreachable" | "unknown";
  sse: "connecting" | "open" | "closed";
}

/** Public API of the task store hook the App consumes. */
export interface UseTaskStoreResult {
  tasks: Task[];
  agents: RosterAgent[];
  status: TaskBoardStatus;
  settings: BoardSettings;
  create: (fields: CreateTaskFields) => Promise<void>;
  run: (taskId: string) => Promise<void>;
  retry: (taskId: string) => Promise<void>;
  abort: (taskId: string) => Promise<void>;
  remove: (taskId: string) => Promise<void>;
  move: (taskId: string, column: Column, position: number) => void;
  initGit: (taskId: string) => Promise<void>;
  sync: (taskId: string) => Promise<string>;
  integrate: (taskId: string) => Promise<string>;
  addLink: (taskId: string, parentId: string) => Promise<void>;
  removeLink: (taskId: string, parentId: string) => Promise<void>;
  setWorktreeDefault: (value: boolean) => Promise<void>;
}

export interface TerminalDockTab {
  id: string;
  taskId?: string;
  taskTitle?: string;
  cwdLabel: string;
  cwd?: string;
  terminalId?: string;
  token?: string;
  createState: "creating" | "ready" | "error";
  error?: string;
  sessionVersion: number;
}

export interface TerminalDockProps {
  open: boolean;
  height: number;
  tabs: TerminalDockTab[];
  activeTabId: string | null;
  onToggleOpen: () => void;
  onHeightChange: (height: number) => void;
  onActivateTab: (tabId: string) => void;
  onRequestWorkspaceShell: () => void;
  onCloseTab: (tabId: string) => void;
  onReopenTab: (tabId: string) => void;
}
