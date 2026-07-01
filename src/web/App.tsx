import { useState } from "react";
import type { Card } from "../shared/index";
import { useBoardStore } from "./store";
import { Board } from "./components/Board";
import { SessionCard } from "./components/SessionCard";

/**
 * Root: wires the store to the board. Board renders each card via renderCard, so it
 * never imports SessionCard directly (keeps the dnd board and the card decoupled).
 */
export function App() {
  const { cards, status, move, prompt, interrupt, diff } = useBoardStore();
  const [diffView, setDiffView] = useState<{ sessionId: string; text: string } | null>(null);

  const onPrompt = (sessionId: string) => {
    const text = window.prompt("Send a prompt to this session:");
    if (text && text.trim()) void prompt(sessionId, text.trim());
  };
  const onInterrupt = (sessionId: string) => {
    void interrupt(sessionId);
  };
  const onDiff = async (sessionId: string) => {
    try {
      const d = await diff(sessionId);
      setDiffView({ sessionId, text: JSON.stringify(d, null, 2) });
    } catch (err) {
      setDiffView({ sessionId, text: String(err) });
    }
  };

  const ocOk = status.opencode === "ok";

  return (
    <div style={styles.app}>
      <header style={styles.header}>
        <h1 style={styles.title}>opencode-board</h1>
        <div style={styles.badges}>
          <span style={{ ...styles.badge, background: ocOk ? "#132d1c" : "#3a1620", color: ocOk ? "#4ade80" : "#f87171" }}>
            opencode: {status.opencode}
          </span>
          <span style={{ ...styles.badge, opacity: status.sse === "open" ? 1 : 0.6 }}>
            live: {status.sse}
          </span>
          <span style={styles.count}>{cards.length} sessions</span>
        </div>
      </header>

      <main style={styles.main}>
        <Board
          cards={cards}
          onMove={move}
          renderCard={(card: Card) => (
            <SessionCard card={card} onPrompt={onPrompt} onInterrupt={onInterrupt} onDiff={onDiff} />
          )}
        />
      </main>

      {diffView && (
        <div style={styles.overlay} onClick={() => setDiffView(null)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHead}>
              <strong>diff — {diffView.sessionId}</strong>
              <button style={styles.close} onClick={() => setDiffView(null)}>
                ✕
              </button>
            </div>
            <pre style={styles.pre}>{diffView.text}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  app: { minHeight: "100vh", background: "#0b0d10", color: "#e6e8eb", fontFamily: "ui-sans-serif, system-ui, sans-serif" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: "1px solid #1c2128" },
  title: { margin: 0, fontSize: 18, fontWeight: 650, letterSpacing: "-0.01em" },
  badges: { display: "flex", alignItems: "center", gap: 10 },
  badge: { fontSize: 12, padding: "3px 9px", borderRadius: 999, background: "#161b22", border: "1px solid #232a33" },
  count: { fontSize: 12, color: "#8b949e" },
  main: { padding: 20 },
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center" },
  modal: { width: "min(760px, 92vw)", maxHeight: "80vh", overflow: "auto", background: "#0f141a", border: "1px solid #232a33", borderRadius: 10 },
  modalHead: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid #1c2128" },
  close: { background: "transparent", border: "none", color: "#8b949e", cursor: "pointer", fontSize: 14 },
  pre: { margin: 0, padding: 14, fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" },
};
