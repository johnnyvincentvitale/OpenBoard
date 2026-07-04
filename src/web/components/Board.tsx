import { useMemo } from "react";
import type { ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
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
import { COLUMNS, COLUMN_LABELS } from "../../shared/index";
import type { Card, Column as ColumnId } from "../../shared/index";
import type { BoardProps } from "../types";
import { Column } from "./Column";

/** Wraps a rendered card in a dnd-kit sortable/draggable node keyed by sessionId. */
function SortableCard({ card, children }: { card: Card; children: ReactNode }) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: card.sessionId,
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
      data-testid={`sortable-${card.sessionId}`}
    >
      {children}
    </div>
  );
}

function groupByColumn(cards: Card[]): Record<ColumnId, Card[]> {
  const grouped = Object.fromEntries(COLUMNS.map((column) => [column, [] as Card[]])) as Record<
    ColumnId,
    Card[]
  >;
  for (const column of COLUMNS) {
    grouped[column] = cards
      .filter((card) => card.column === column)
      .sort((a, b) => a.position - b.position);
  }
  return grouped;
}

/** Locates which column an id (card sessionId or column id) belongs to. */
function findColumnForId(
  id: UniqueIdentifier,
  grouped: Record<ColumnId, Card[]>,
): ColumnId | undefined {
  if ((COLUMNS as readonly string[]).includes(String(id))) {
    return id as ColumnId;
  }
  for (const column of COLUMNS) {
    if (grouped[column].some((card) => card.sessionId === id)) {
      return column;
    }
  }
  return undefined;
}

export function Board({ cards, onMove, renderCard }: BoardProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const grouped = useMemo(() => groupByColumn(cards), [cards]);

  // Resolve the move on drop only. dnd-kit already animates the card following the
  // cursor; computing a cross-column preview during onDragOver caused an infinite
  // render loop (override <-> reset oscillation), so the actual move is committed
  // here and the board re-renders from the server's fresh state.
  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;

    const sourceColumn = findColumnForId(active.id, grouped);
    const destColumn = findColumnForId(over.id, grouped);
    if (!sourceColumn || !destColumn) return;

    const destCards = grouped[destColumn].filter((card) => card.sessionId !== active.id);
    let targetIndex = destCards.findIndex((card) => card.sessionId === over.id);
    if (targetIndex === -1) targetIndex = destCards.length;

    // No-op if nothing actually changed (same column, same slot).
    const current = grouped[sourceColumn].findIndex((card) => card.sessionId === active.id);
    if (sourceColumn === destColumn && current === targetIndex) return;

    onMove(String(active.id), destColumn, targetIndex);
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={handleDragEnd}>
      <div
        data-testid="board"
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
            items={grouped[column].map((card) => card.sessionId)}
            strategy={verticalListSortingStrategy}
          >
            <Column
              column={column}
              label={COLUMN_LABELS[column]}
              cards={grouped[column]}
              renderCard={(card) => <SortableCard card={card}>{renderCard(card)}</SortableCard>}
            />
          </SortableContext>
        ))}
      </div>
    </DndContext>
  );
}
