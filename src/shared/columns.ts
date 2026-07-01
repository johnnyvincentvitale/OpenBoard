/** The workflow columns a session card can live in. Canonical, frozen contract. */
export const COLUMNS = ["todo", "in_progress", "review", "done"] as const;
export type Column = (typeof COLUMNS)[number];

export const COLUMN_LABELS: Record<Column, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  review: "Review",
  done: "Done",
};

/** Column a newly-discovered session lands in. */
export const DEFAULT_COLUMN: Column = "todo";

export function isColumn(value: unknown): value is Column {
  return typeof value === "string" && (COLUMNS as readonly string[]).includes(value);
}
