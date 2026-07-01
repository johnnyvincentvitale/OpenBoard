/**
 * TaskBoard — the functional-task board's drag-and-drop grid: four columns
 * (todo/in_progress/review/done), grouping + sorting props.tasks by column
 * and position, with dnd-kit sortable drag (pointer + keyboard) reordering
 * and cross-column moves. Rendering of each task is delegated entirely to
 * props.renderCard so this component stays decoupled from TaskCard.
 */
import { useMemo } from "react";
import type { ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent, UniqueIdentifier } from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { COLUMNS, COLUMN_LABELS } from "../../shared";
import type { Column as ColumnId, Task } from "../../shared";
import type { TaskBoardProps } from "../task-types";

/** Wraps a rendered task card in a dnd-kit sortable/draggable node keyed by task.id. */
function SortableCard({ task, children }: { task: Task; children: ReactNode }) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: task.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      data-testid={`sortable-${task.id}`}
    >
      {children}
    </div>
  );
}

interface TaskColumnProps {
  column: ColumnId;
  label: string;
  tasks: Task[];
  renderCard: (task: Task) => ReactNode;
}

/** A single droppable board column: label + count header, sortable task list. */
function TaskColumn({ column, label, tasks, renderCard }: TaskColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: column });

  return (
    <section
      ref={setNodeRef}
      data-testid={`column-${column}`}
      aria-label={label}
      style={{
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        background: isOver ? "rgba(0,0,0,0.04)" : undefined,
      }}
    >
      <header style={{ display: "flex", justifyContent: "space-between" }}>
        <h2>{label}</h2>
        <span data-testid={`column-count-${column}`}>{tasks.length}</span>
      </header>
      <div
        data-testid={`column-list-${column}`}
        style={{ display: "flex", flexDirection: "column", gap: 8 }}
      >
        {tasks.map((task) => (
          <div key={task.id}>{renderCard(task)}</div>
        ))}
      </div>
    </section>
  );
}

function groupByColumn(tasks: Task[]): Record<ColumnId, Task[]> {
  const grouped = Object.fromEntries(COLUMNS.map((column) => [column, [] as Task[]])) as Record<
    ColumnId,
    Task[]
  >;
  for (const column of COLUMNS) {
    grouped[column] = tasks
      .filter((task) => task.column === column)
      .sort((a, b) => a.position - b.position);
  }
  return grouped;
}

/** Locates which column an id (task id or column id) belongs to. */
function findColumnForId(
  id: UniqueIdentifier,
  grouped: Record<ColumnId, Task[]>,
): ColumnId | undefined {
  if ((COLUMNS as readonly string[]).includes(String(id))) {
    return id as ColumnId;
  }
  for (const column of COLUMNS) {
    if (grouped[column].some((task) => task.id === id)) {
      return column;
    }
  }
  return undefined;
}

export function TaskBoard({ tasks, onMove, renderCard }: TaskBoardProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const grouped = useMemo(() => groupByColumn(tasks), [tasks]);

  // Resolve the move on drop only. dnd-kit already animates the card following the
  // cursor; computing a cross-column preview during onDragOver caused an infinite
  // render loop (override <-> reset oscillation) in the session board, so the
  // actual move is committed here only, and the board re-renders from the
  // server's fresh state. Do NOT add an onDragOver handler.
  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;

    const sourceColumn = findColumnForId(active.id, grouped);
    const destColumn = findColumnForId(over.id, grouped);
    if (!sourceColumn || !destColumn) return;

    const destTasks = grouped[destColumn].filter((task) => task.id !== active.id);
    let targetIndex = destTasks.findIndex((task) => task.id === over.id);
    if (targetIndex === -1) targetIndex = destTasks.length;

    // No-op if nothing actually changed (same column, same slot).
    const current = grouped[sourceColumn].findIndex((task) => task.id === active.id);
    if (sourceColumn === destColumn && current === targetIndex) return;

    onMove(String(active.id), destColumn, targetIndex);
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={handleDragEnd}>
      <div
        data-testid="task-board"
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${COLUMNS.length}, 1fr)`,
          gap: 16,
        }}
      >
        {COLUMNS.map((column) => (
          <SortableContext
            key={column}
            id={column}
            items={grouped[column].map((task) => task.id)}
            strategy={verticalListSortingStrategy}
          >
            <TaskColumn
              column={column}
              label={COLUMN_LABELS[column]}
              tasks={grouped[column]}
              renderCard={(task) => <SortableCard task={task}>{renderCard(task)}</SortableCard>}
            />
          </SortableContext>
        ))}
      </div>
    </DndContext>
  );
}
