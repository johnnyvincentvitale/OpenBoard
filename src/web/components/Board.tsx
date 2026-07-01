import { useMemo, useState } from "react";
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
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} data-testid={`sortable-${card.sessionId}`}>
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

/** Locates which column an id (card sessionId or column id) currently belongs to. */
function findColumnForId(id: UniqueIdentifier, grouped: Record<ColumnId, Card[]>): ColumnId | undefined {
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
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const grouped = useMemo(() => groupByColumn(cards), [cards]);

  // Local optimistic ordering so keyboard/pointer drags can preview movement
  // between columns before the parent's onMove round-trip updates props.cards.
  const [override, setOverride] = useState<Record<ColumnId, Card[]> | null>(null);
  const display = override ?? grouped;

  function handleDragEnd(event: DragEndEvent) {
    setOverride(null);
    const { active, over } = event;
    if (!over) return;

    const sourceColumn = findColumnForId(active.id, grouped);
    if (!sourceColumn) return;

    const destColumn = findColumnForId(over.id, grouped);
    if (!destColumn) return;

    const destCards = grouped[destColumn].filter((card) => card.sessionId !== active.id);
    let targetIndex = destCards.findIndex((card) => card.sessionId === over.id);
    if (targetIndex === -1) {
      targetIndex = destCards.length;
    }

    onMove(String(active.id), destColumn, targetIndex);
  }

  function handleDragOver(event: { active: { id: UniqueIdentifier }; over: { id: UniqueIdentifier } | null }) {
    const { active, over } = event;
    if (!over) {
      setOverride(null);
      return;
    }

    const sourceColumn = findColumnForId(active.id, display);
    const destColumn = findColumnForId(over.id, display);
    if (!sourceColumn || !destColumn || sourceColumn === destColumn) {
      setOverride(null);
      return;
    }

    setOverride((prev) => {
      const base = prev ?? grouped;
      const movingCard = base[sourceColumn].find((card) => card.sessionId === active.id);
      if (!movingCard) return prev;

      const nextSource = base[sourceColumn].filter((card) => card.sessionId !== active.id);
      const nextDest = base[destColumn].filter((card) => card.sessionId !== active.id);
      let insertAt = nextDest.findIndex((card) => card.sessionId === over.id);
      if (insertAt === -1) insertAt = nextDest.length;
      nextDest.splice(insertAt, 0, movingCard);

      return {
        ...base,
        [sourceColumn]: nextSource,
        [destColumn]: nextDest,
      };
    });
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setOverride(null)}
    >
      <div data-testid="board" style={{ display: "grid", gridTemplateColumns: `repeat(${COLUMNS.length}, 1fr)`, gap: 16 }}>
        {COLUMNS.map((column) => (
          <SortableContext
            key={column}
            id={column}
            items={display[column].map((card) => card.sessionId)}
            strategy={verticalListSortingStrategy}
          >
            <Column
              column={column}
              label={COLUMN_LABELS[column]}
              cards={display[column]}
              renderCard={(card) => <SortableCard card={card}>{renderCard(card)}</SortableCard>}
            />
          </SortableContext>
        ))}
      </div>
    </DndContext>
  );
}
