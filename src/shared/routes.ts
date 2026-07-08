/** Canonical REST route contracts. */
import type { CompletionReport } from "./task";

export const ROUTE_PATTERNS = {
  health: "/api/health",
} as const;

export const buildPath = {
  health: () => "/api/health",
} as const;

export interface FinalSessionOutputBody {
  /** Optional final OpenCode session output; null/omitted when unavailable. */
  finalSessionOutput?: string | null;
}

/** POST /api/tasks/:id/complete body. Server supplies outcome="complete" and reportedAt. */
export type CompleteTaskBody = Omit<CompletionReport, "reportedAt" | "outcome"> & FinalSessionOutputBody;

/** POST /api/tasks/:id/block body. Server supplies outcome="blocked" and reportedAt. */
export type BlockTaskBody = Omit<CompletionReport, "reportedAt" | "outcome"> & FinalSessionOutputBody;

/** POST /api/tasks/:id/archive body. */
export type ArchiveTaskBody = Record<string, never>;

/** POST /api/tasks/:id/unarchive body. */
export type UnarchiveTaskBody = Record<string, never>;

/** GET /api/tasks?archived= query parameter. */
export interface ListTasksQuery {
  archived?: "true" | "false" | "all";
}

/** POST /api/tasks/:id/links body. */
export interface AddTaskLinkBody {
  parentId: string;
}

/** DELETE /api/tasks/:id/links/:parentId has no request body. */
export type RemoveTaskLinkBody = Record<string, never>;
