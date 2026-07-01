import type { ReactNode } from "react";
import { useDroppable } from "@dnd-kit/core";
import type { Card, Column as ColumnId } from "../../shared/index";

export interface ColumnProps {
  column: ColumnId;
  label: string;
  cards: Card[];
  /**
   * Renders a single card. The Board owner wraps this so each card is a
   * sortable/draggable dnd-kit node; Column stays dnd-kit-item-agnostic
   * beyond providing the droppable container + SortableContext.
   */
  renderCard: (card: Card) => ReactNode;
}

/** A single droppable board column: label + count header, sortable card list. */
export function Column({ column, label, cards, renderCard }: ColumnProps) {
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
        <span data-testid={`column-count-${column}`}>{cards.length}</span>
      </header>
      <div data-testid={`column-list-${column}`} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {cards.map((card) => (
          <div key={card.sessionId}>{renderCard(card)}</div>
        ))}
      </div>
    </section>
  );
}
