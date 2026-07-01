/**
 * Framework-free board store. Owns the canonical in-memory board state
 * (cards + connection status), folds SSE frames into it, and exposes a
 * subscribe/getSnapshot pair suitable for useSyncExternalStore. Also exports
 * a React hook (useBoardStore) backed by a module-singleton store instance.
 */
import { useCallback, useSyncExternalStore } from "react";
import type { BoardFrame, Card, Column } from "../shared";
import { COLUMNS } from "../shared";
import * as boardClient from "./api/boardClient";
import { connectBoardSse } from "./api/boardSse";
import type { BoardStatus } from "./types";

/** Minimal surface of boardClient the store depends on (for test injection). */
export interface BoardClientLike {
  getBoard: typeof boardClient.getBoard;
  move: typeof boardClient.move;
  prompt: typeof boardClient.prompt;
  interrupt: typeof boardClient.interrupt;
  diff: typeof boardClient.diff;
  getHealth: typeof boardClient.getHealth;
}

/** Minimal surface of connectBoardSse the store depends on (for test injection). */
export type ConnectFn = typeof connectBoardSse;

export interface BoardStoreDeps {
  client?: BoardClientLike;
  connect?: ConnectFn;
  /** Health poll interval in ms. Defaults to 15000. Exposed for tests. */
  healthPollMs?: number;
}

export interface BoardSnapshot {
  cards: Card[];
  status: BoardStatus;
}

export interface BoardStore {
  subscribe(cb: () => void): () => void;
  getSnapshot(): BoardSnapshot;
  init(): void;
  move(sessionId: string, column: Column, position: number): void;
  prompt(sessionId: string, text: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  diff(sessionId: string): Promise<unknown>;
  dispose(): void;
}

const COLUMN_ORDER: Record<Column, number> = Object.fromEntries(
  COLUMNS.map((col, idx) => [col, idx]),
) as Record<Column, number>;

function sortCards(cards: Iterable<Card>): Card[] {
  return [...cards].sort((a, b) => {
    const colDiff = COLUMN_ORDER[a.column] - COLUMN_ORDER[b.column];
    if (colDiff !== 0) return colDiff;
    return a.position - b.position;
  });
}

export function createBoardStore(deps: BoardStoreDeps = {}): BoardStore {
  const client: BoardClientLike = deps.client ?? boardClient;
  const connect: ConnectFn = deps.connect ?? connectBoardSse;
  const healthPollMs = deps.healthPollMs ?? 15000;

  const cardsById = new Map<string, Card>();
  let status: BoardStatus = { opencode: "unknown", sse: "connecting" };
  let snapshot: BoardSnapshot = { cards: [], status };
  const listeners = new Set<() => void>();

  let disconnectSse: (() => void) | undefined;
  let healthTimer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;

  function emit(): void {
    snapshot = { cards: sortCards(cardsById.values()), status };
    for (const listener of listeners) listener();
  }

  function setStatus(patch: Partial<BoardStatus>): void {
    status = { ...status, ...patch };
    emit();
  }

  function applyFrame(frame: BoardFrame): void {
    switch (frame.kind) {
      case "snapshot": {
        cardsById.clear();
        for (const card of frame.cards) cardsById.set(card.sessionId, card);
        emit();
        break;
      }
      case "upsert": {
        cardsById.set(frame.card.sessionId, frame.card);
        emit();
        break;
      }
      case "remove": {
        cardsById.delete(frame.sessionId);
        emit();
        break;
      }
      case "heartbeat": {
        // No state change.
        break;
      }
    }
  }

  async function pollHealth(): Promise<void> {
    try {
      const health = await client.getHealth();
      setStatus({ opencode: health.opencode });
    } catch {
      setStatus({ opencode: "unreachable" });
    }
  }

  function init(): void {
    void client
      .getBoard()
      .then((cards) => {
        cardsById.clear();
        for (const card of cards) cardsById.set(card.sessionId, card);
        emit();
      })
      .catch(() => {
        // Leave existing state; SSE/health will surface reachability issues.
      });

    void pollHealth();
    healthTimer = setInterval(() => void pollHealth(), healthPollMs);

    disconnectSse = connect({
      onFrame: applyFrame,
      onStatus: (sse) => setStatus({ sse }),
    });
  }

  function move(sessionId: string, column: Column, position: number): void {
    const existing = cardsById.get(sessionId);
    if (existing) {
      cardsById.set(sessionId, { ...existing, column, position });
      emit();
    }

    void client
      .move(sessionId, column, position)
      .then((cards) => {
        cardsById.clear();
        for (const card of cards) cardsById.set(card.sessionId, card);
        emit();
      })
      .catch(() => {
        // Reconciliation failed; leave optimistic state. A future snapshot/
        // upsert frame or board reload will correct any drift.
      });
  }

  async function promptFn(sessionId: string, text: string): Promise<void> {
    await client.prompt(sessionId, text);
  }

  async function interruptFn(sessionId: string): Promise<void> {
    await client.interrupt(sessionId);
  }

  async function diffFn(sessionId: string): Promise<unknown> {
    return client.diff(sessionId);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    disconnectSse?.();
    if (healthTimer) clearInterval(healthTimer);
    listeners.clear();
  }

  return {
    subscribe(cb: () => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getSnapshot() {
      return snapshot;
    },
    init,
    move,
    prompt: promptFn,
    interrupt: interruptFn,
    diff: diffFn,
    dispose,
  };
}

// --- React hook, backed by a module-singleton store ---------------------

let singleton: BoardStore | undefined;

function getSingleton(): BoardStore {
  if (!singleton) {
    singleton = createBoardStore();
    singleton.init();
  }
  return singleton;
}

export interface UseBoardStoreResult {
  cards: Card[];
  status: BoardStatus;
  move: (sessionId: string, column: Column, position: number) => void;
  prompt: (sessionId: string, text: string) => Promise<void>;
  interrupt: (sessionId: string) => Promise<void>;
  diff: (sessionId: string) => Promise<unknown>;
}

export function useBoardStore(): UseBoardStoreResult {
  const store = getSingleton();
  const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [store]);
  const getSnapshot = useCallback(() => store.getSnapshot(), [store]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);

  return {
    cards: snapshot.cards,
    status: snapshot.status,
    move: store.move,
    prompt: store.prompt,
    interrupt: store.interrupt,
    diff: store.diff,
  };
}
