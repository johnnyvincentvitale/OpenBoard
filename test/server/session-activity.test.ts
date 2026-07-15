import { describe, it, expect, beforeEach } from "vitest";
import {
  SessionActivityCollector,
  type SessionActivityEventInput,
} from "../../src/server/session-activity";
import type {
  SessionActivityFrame,
  SessionActivityRun,
} from "../../src/shared";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeRun(overrides: Partial<SessionActivityRun> = {}): SessionActivityRun {
  return {
    taskId: "task_1",
    runStartedAt: 1000,
    sessionId: "ses_1",
    rootSessionId: "ses_root",
    harness: "opencode",
    ...overrides,
  };
}

function makeInput(
  overrides: Partial<SessionActivityEventInput> = {},
): SessionActivityEventInput {
  return {
    sessionId: "ses_1",
    rootSessionId: "ses_root",
    harness: "opencode",
    kind: "text",
    role: "assistant",
    text: "hello",
    ...overrides,
  };
}

/** Collect all frames delivered to a subscriber callback. */
function collectFrames(
  collector: SessionActivityCollector,
  taskId: string,
  cursor: number,
): { frames: SessionActivityFrame[]; unsubscribe: () => void } {
  const frames: SessionActivityFrame[] = [];
  const unsubscribe = collector.subscribe(taskId, cursor, (frame) => {
    frames.push(frame);
  });
  return { frames, unsubscribe };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("SessionActivityCollector", () => {
  let collector: SessionActivityCollector;
  let now: number;

  beforeEach(() => {
    now = 0;
    collector = new SessionActivityCollector({ clock: () => now });
  });

  /** Create a fresh collector with the same clock (for scoped tests). */
  function makeCollector(overrides: { maxEvents?: number } = {}): SessionActivityCollector {
    return new SessionActivityCollector({ clock: () => now, ...overrides });
  }

  // ── Sequence ordering ─────────────────────────────────────────────────

  describe("sequence ordering", () => {
    it("assigns monotonically increasing sequence ids starting from 1", () => {
      now = 2000;
      collector.startRun(makeRun());

      const seq1 = collector.recordEvent("task_1", 1000, makeInput({ text: "a" }));
      now = 2001;
      const seq2 = collector.recordEvent("task_1", 1000, makeInput({ text: "b" }));
      now = 2002;
      const seq3 = collector.recordEvent("task_1", 1000, makeInput({ text: "c" }));

      expect(seq1).toBe(1);
      expect(seq2).toBe(2);
      expect(seq3).toBe(3);
    });

    it("resets sequence to 1 when a new run starts for the same task", () => {
      now = 2000;
      collector.startRun(makeRun({ runStartedAt: 1000 }));
      const seq1 = collector.recordEvent("task_1", 1000, makeInput({ text: "a" }));
      expect(seq1).toBe(1);

      collector.startRun(makeRun({ runStartedAt: 2000, sessionId: "ses_2" }));
      now = 3000;
      const seq2 = collector.recordEvent("task_1", 2000, makeInput({ text: "b", sessionId: "ses_2" }));
      expect(seq2).toBe(1);
    });

    it("fills occurredAt from the injected clock", () => {
      now = 4242;
      collector.startRun(makeRun());
      collector.recordEvent("task_1", 1000, makeInput({ text: "x" }));

      const { frames } = collectFrames(collector, "task_1", 0);
      const snapshot = frames.find((f): f is Extract<SessionActivityFrame, { kind: "snapshot" }> => f.kind === "snapshot")!;
      expect(snapshot.events[0].occurredAt).toBe(4242);
    });
  });

  // ── Subscriber snapshot / backfill ─────────────────────────────────────

  describe("subscriber snapshot and backfill", () => {
    it("alway sends a snapshot for an active run, even when ring is empty", () => {
      collector.startRun(makeRun());

      const { frames } = collectFrames(collector, "task_1", 0);

      const snapshot = frames.find((f) => f.kind === "snapshot");
      expect(snapshot).toBeDefined();
      if (snapshot?.kind === "snapshot") {
        expect(snapshot.run.taskId).toBe("task_1");
        expect(snapshot.events).toHaveLength(0);
        expect(snapshot.lastEventAt).toBeNull();
        expect(snapshot.transport).toBe("live");
      }
    });

    it("sends a snapshot with all events when cursor is 0", () => {
      now = 1000;
      collector.startRun(makeRun());
      collector.recordEvent("task_1", 1000, makeInput({ text: "a" }));
      collector.recordEvent("task_1", 1000, makeInput({ text: "b" }));

      const { frames } = collectFrames(collector, "task_1", 0);

      const snapshot = frames.find((f) => f.kind === "snapshot");
      expect(snapshot).toBeDefined();
      if (snapshot?.kind === "snapshot") {
        expect(snapshot.events).toHaveLength(2);
        expect(snapshot.events[0].text).toBe("a");
        expect(snapshot.events[1].text).toBe("b");
        // lastEventAt must reflect the run's latest buffered event, not just those after cursor
        expect(snapshot.lastEventAt).toBe(1000);
      }
    });

    it("sends only events after the cursor in snapshot, but lastEventAt reflects latest buffered", () => {
      now = 1000;
      collector.startRun(makeRun());
      collector.recordEvent("task_1", 1000, makeInput({ text: "a" })); // seq 1
      collector.recordEvent("task_1", 1000, makeInput({ text: "b" })); // seq 2
      now = 2000;
      collector.recordEvent("task_1", 1000, makeInput({ text: "c" })); // seq 3

      const { frames } = collectFrames(collector, "task_1", 1);

      const snapshot = frames.find((f) => f.kind === "snapshot");
      expect(snapshot).toBeDefined();
      if (snapshot?.kind === "snapshot") {
        expect(snapshot.events).toHaveLength(2);
        expect(snapshot.events[0].seq).toBe(2);
        expect(snapshot.events[1].seq).toBe(3);
        // lastEventAt = latest buffered event (seq 3), not just events in snapshot
        expect(snapshot.lastEventAt).toBe(2000);
      }

      // Heartbeat lastEventAt also reflects latest buffered
      const heartbeat = frames.find((f) => f.kind === "heartbeat");
      if (heartbeat?.kind === "heartbeat") {
        expect(heartbeat.lastEventAt).toBe(2000);
      }
    });

    it("sends snapshot even when cursor is ahead of all events (empty events array)", () => {
      now = 1000;
      collector.startRun(makeRun());
      collector.recordEvent("task_1", 1000, makeInput({ text: "a" }));

      const { frames } = collectFrames(collector, "task_1", 5);

      const snapshot = frames.find((f) => f.kind === "snapshot");
      expect(snapshot).toBeDefined();
      if (snapshot?.kind === "snapshot") {
        expect(snapshot.events).toHaveLength(0);
        // lastEventAt still reflects the latest buffered event
        expect(snapshot.lastEventAt).toBe(1000);
      }
    });

    it("heartbeat lastEventAt reflects latest buffered event for caught-up viewer", () => {
      now = 1000;
      collector.startRun(makeRun());
      collector.recordEvent("task_1", 1000, makeInput({ text: "a" }));
      collector.recordEvent("task_1", 1000, makeInput({ text: "b" }));

      // Subscriber with cursor=2 (caught up) should see lastEventAt=1000 in heartbeat
      const { frames } = collectFrames(collector, "task_1", 2);

      const heartbeat = frames.find((f) => f.kind === "heartbeat");
      expect(heartbeat).toBeDefined();
      if (heartbeat?.kind === "heartbeat") {
        expect(heartbeat.lastEventAt).toBe(1000);
        expect(heartbeat.transport).toBe("live");
      }
    });

    it("sends heartbeat with static transport when no run is active", () => {
      const { frames } = collectFrames(collector, "task_1", 0);

      const heartbeat = frames.find((f) => f.kind === "heartbeat");
      expect(heartbeat).toBeDefined();
      if (heartbeat?.kind === "heartbeat") {
        expect(heartbeat.transport).toBe("static");
        expect(heartbeat.lastEventAt).toBeNull();
      }
    });
  });

  // ── Subscriber fanout (append) ─────────────────────────────────────────

  describe("subscriber fanout", () => {
    it("delivers append frames to existing subscribers for new events", () => {
      now = 1000;
      collector.startRun(makeRun());

      const { frames } = collectFrames(collector, "task_1", 0);
      frames.length = 0;

      now = 2000;
      collector.recordEvent("task_1", 1000, makeInput({ text: "new" }));

      const append = frames.find((f) => f.kind === "append");
      expect(append).toBeDefined();
      if (append?.kind === "append") {
        expect(append.event.text).toBe("new");
        expect(append.event.seq).toBe(1);
      }
    });

    it("does not deliver events to subscribers for a different task", () => {
      now = 1000;
      collector.startRun(makeRun({ taskId: "task_1" }));
      collector.startRun(makeRun({ taskId: "task_2", runStartedAt: 2000, sessionId: "ses_2" }));

      const { frames: frames1 } = collectFrames(collector, "task_1", 0);
      const { frames: frames2 } = collectFrames(collector, "task_2", 0);

      frames1.length = 0;
      frames2.length = 0;

      collector.recordEvent("task_1", 1000, makeInput({ text: "t1" }));

      expect(frames1).toHaveLength(1);
      expect(frames1[0].kind).toBe("append");
      if (frames1[0].kind === "append") {
        expect(frames1[0].event.text).toBe("t1");
      }
      expect(frames2).toHaveLength(0);
    });

    it("does not deliver to unsubscribed callbacks", () => {
      now = 1000;
      collector.startRun(makeRun());

      const { frames, unsubscribe } = collectFrames(collector, "task_1", 0);
      frames.length = 0;
      unsubscribe();

      collector.recordEvent("task_1", 1000, makeInput({ text: "after" }));

      expect(frames).toHaveLength(0);
    });
  });

  // ── Ring buffer eviction / gaps ────────────────────────────────────────

  describe("ring buffer eviction and gaps", () => {
    it("evicts oldest events when buffer exceeds maxEvents", () => {
      const small = makeCollector({ maxEvents: 3 });
      now = 1000;
      small.startRun(makeRun());

      small.recordEvent("task_1", 1000, makeInput({ text: "a" }));
      small.recordEvent("task_1", 1000, makeInput({ text: "b" }));
      small.recordEvent("task_1", 1000, makeInput({ text: "c" }));
      small.recordEvent("task_1", 1000, makeInput({ text: "d" })); // a evicted

      const { frames } = collectFrames(small, "task_1", 0);

      const snapshot = frames.find((f) => f.kind === "snapshot");
      expect(snapshot).toBeDefined();
      if (snapshot?.kind === "snapshot") {
        expect(snapshot.events).toHaveLength(3);
        expect(snapshot.events[0].text).toBe("b");
        expect(snapshot.events[2].text).toBe("d");
      }
    });

    it("handles maxEvents=1 correctly with proper oldestSeq tracking", () => {
      const single = makeCollector({ maxEvents: 1 });
      now = 1000;
      single.startRun(makeRun());

      single.recordEvent("task_1", 1000, makeInput({ text: "a" })); // seq 1, keeps
      single.recordEvent("task_1", 1000, makeInput({ text: "b" })); // seq 2, replaces a

      const { frames } = collectFrames(single, "task_1", 0);

      const snapshot = frames.find((f) => f.kind === "snapshot");
      expect(snapshot).toBeDefined();
      if (snapshot?.kind === "snapshot") {
        expect(snapshot.events).toHaveLength(1);
        expect(snapshot.events[0].seq).toBe(2);
        expect(snapshot.events[0].text).toBe("b");
      }
    });

    it("gap detection works with maxEvents=1 after eviction", () => {
      const single = makeCollector({ maxEvents: 1 });
      now = 1000;
      single.startRun(makeRun());

      single.recordEvent("task_1", 1000, makeInput({ text: "a" })); // seq 1, evicted
      single.recordEvent("task_1", 1000, makeInput({ text: "b" })); // seq 2, kept

      // Subscriber with cursor=1 should get a gap since seq 1 was evicted
      const { frames } = collectFrames(single, "task_1", 1);

      const gap = frames.find((f) => f.kind === "gap");
      expect(gap).toBeDefined();
      if (gap?.kind === "gap") {
        expect(gap.afterSeq).toBe(1);
        expect(gap.reason).toContain("evicted");
      }

      const snapshot = frames.find((f) => f.kind === "snapshot");
      if (snapshot?.kind === "snapshot") {
        expect(snapshot.events).toHaveLength(1);
        expect(snapshot.events[0].seq).toBe(2);
      }
    });

    it("sends a gap frame when subscriber cursor is behind the oldest buffered event", () => {
      const small = makeCollector({ maxEvents: 2 });
      now = 1000;
      small.startRun(makeRun());

      small.recordEvent("task_1", 1000, makeInput({ text: "a" })); // seq 1, evicted
      small.recordEvent("task_1", 1000, makeInput({ text: "b" })); // seq 2, evicted
      small.recordEvent("task_1", 1000, makeInput({ text: "c" })); // seq 3
      small.recordEvent("task_1", 1000, makeInput({ text: "d" })); // seq 4

      const { frames } = collectFrames(small, "task_1", 1);

      const gap = frames.find((f) => f.kind === "gap");
      expect(gap).toBeDefined();
      if (gap?.kind === "gap") {
        expect(gap.afterSeq).toBe(1);
        expect(gap.reason).toContain("evicted");
      }

      const snapshot = frames.find((f) => f.kind === "snapshot");
      expect(snapshot).toBeDefined();
      if (snapshot?.kind === "snapshot") {
        expect(snapshot.events).toHaveLength(2);
        expect(snapshot.events[0].seq).toBe(3);
      }
    });

    it("does not send gap when cursor is 0 (initial connect)", () => {
      const small = makeCollector({ maxEvents: 2 });
      small.startRun(makeRun());
      small.recordEvent("task_1", 1000, makeInput({ text: "a" }));
      small.recordEvent("task_1", 1000, makeInput({ text: "b" }));
      small.recordEvent("task_1", 1000, makeInput({ text: "c" })); // a evicted

      const { frames } = collectFrames(small, "task_1", 0);

      const gaps = frames.filter((f) => f.kind === "gap");
      expect(gaps).toHaveLength(0);
    });

    it("emits an honest gap (not an ambiguous empty snapshot) when a reconnecting subscriber's cursor is from a replaced run (P3-3)", () => {
      now = 1000;
      collector.startRun(makeRun({ runStartedAt: 1000 }));
      collector.recordEvent("task_1", 1000, makeInput({ text: "a" })); // seq 1
      collector.recordEvent("task_1", 1000, makeInput({ text: "b" })); // seq 2
      collector.recordEvent("task_1", 1000, makeInput({ text: "c" })); // seq 3

      // Run is replaced (e.g. a fresh dispatcher attempt) — seq resets to 1.
      collector.startRun(makeRun({ runStartedAt: 2000, sessionId: "ses_2" }));

      // A subscriber reconnects with a cursor from the OLD run (seq 3), which
      // is now >= the new run's nextSeq. Without the fix this silently reads
      // as an empty/partial snapshot; with the fix it's an explicit gap.
      const { frames } = collectFrames(collector, "task_1", 3);

      const gap = frames.find((f) => f.kind === "gap");
      expect(gap).toBeDefined();
      if (gap?.kind === "gap") {
        expect(gap.afterSeq).toBe(3);
        expect(gap.reason).toContain("reset");
      }

      const snapshot = frames.find((f) => f.kind === "snapshot");
      expect(snapshot).toBeDefined();
      if (snapshot?.kind === "snapshot") {
        expect(snapshot.run.runStartedAt).toBe(2000);
        expect(snapshot.events).toHaveLength(0);
      }
    });

    it("does not emit a spurious gap for a subscriber resuming mid-run at a still-valid cursor", () => {
      now = 1000;
      collector.startRun(makeRun({ runStartedAt: 1000 }));
      collector.recordEvent("task_1", 1000, makeInput({ text: "a" })); // seq 1
      collector.recordEvent("task_1", 1000, makeInput({ text: "b" })); // seq 2

      // cursor=2 is the last real seq of the SAME still-active run — valid resume.
      const { frames } = collectFrames(collector, "task_1", 2);

      const gaps = frames.filter((f) => f.kind === "gap");
      expect(gaps).toHaveLength(0);
      const snapshot = frames.find((f) => f.kind === "snapshot");
      if (snapshot?.kind === "snapshot") {
        expect(snapshot.events).toHaveLength(0); // nothing after cursor yet
      }
    });
  });

  // ── Config validation ──────────────────────────────────────────────────

  describe("config validation", () => {
    it("clamps maxEvents=0 to default 1000", () => {
      const c = new SessionActivityCollector({ maxEvents: 0, clock: () => 0 });
      c.startRun(makeRun());
      for (let i = 0; i < 500; i++) {
        c.recordEvent("task_1", 1000, makeInput({ text: `e${i}` }));
      }
      const { frames } = collectFrames(c, "task_1", 0);
      const snapshot = frames.find((f) => f.kind === "snapshot");
      if (snapshot?.kind === "snapshot") {
        expect(snapshot.events).toHaveLength(500);
      }
    });

    it("clamps negative maxEvents to default 1000", () => {
      const c = new SessionActivityCollector({ maxEvents: -5, clock: () => 0 });
      c.startRun(makeRun());
      for (let i = 0; i < 200; i++) {
        c.recordEvent("task_1", 1000, makeInput({ text: `e${i}` }));
      }
      const { frames } = collectFrames(c, "task_1", 0);
      const snapshot = frames.find((f) => f.kind === "snapshot");
      if (snapshot?.kind === "snapshot") {
        expect(snapshot.events).toHaveLength(200);
      }
    });

    it("clamps NaN maxEvents to default 1000", () => {
      const c = new SessionActivityCollector({ maxEvents: NaN, clock: () => 0 });
      c.startRun(makeRun());
      c.recordEvent("task_1", 1000, makeInput({ text: "x" }));
      const { frames } = collectFrames(c, "task_1", 0);
      const snapshot = frames.find((f) => f.kind === "snapshot");
      if (snapshot?.kind === "snapshot") {
        expect(snapshot.events).toHaveLength(1);
      }
    });

    it("clamps Infinity maxEvents to default 1000", () => {
      const c = new SessionActivityCollector({ maxEvents: Infinity, clock: () => 0 });
      c.startRun(makeRun());
      c.recordEvent("task_1", 1000, makeInput({ text: "x" }));
      const { frames } = collectFrames(c, "task_1", 0);
      const snapshot = frames.find((f) => f.kind === "snapshot");
      if (snapshot?.kind === "snapshot") {
        expect(snapshot.events).toHaveLength(1);
      }
    });

    it("truncates non-integer maxEvents to integer", () => {
      const c = new SessionActivityCollector({ maxEvents: 3.7, clock: () => 0 });
      c.startRun(makeRun());
      c.recordEvent("task_1", 1000, makeInput({ text: "a" }));
      c.recordEvent("task_1", 1000, makeInput({ text: "b" }));
      c.recordEvent("task_1", 1000, makeInput({ text: "c" }));
      c.recordEvent("task_1", 1000, makeInput({ text: "d" })); // should evict a

      const { frames } = collectFrames(c, "task_1", 0);
      const snapshot = frames.find((f) => f.kind === "snapshot");
      if (snapshot?.kind === "snapshot") {
        expect(snapshot.events).toHaveLength(3);
        expect(snapshot.events[0].text).toBe("b");
      }
    });
  });

  // ── Transport state transitions ────────────────────────────────────────

  describe("transport state", () => {
    it("emits heartbeat to subscribers on setTransport", () => {
      now = 1000;
      collector.startRun(makeRun());
      collector.recordEvent("task_1", 1000, makeInput({ text: "a" }));

      const { frames } = collectFrames(collector, "task_1", 0);
      frames.length = 0;

      collector.setTransport("task_1", 1000, "reconnecting");

      const heartbeats = frames.filter((f) => f.kind === "heartbeat");
      expect(heartbeats).toHaveLength(1);
      if (heartbeats[0]?.kind === "heartbeat") {
        expect(heartbeats[0].transport).toBe("reconnecting");
        expect(heartbeats[0].lastEventAt).toBe(1000);
      }
    });

    it("transitions live -> reconnecting -> static -> live", () => {
      now = 1000;
      collector.startRun(makeRun());

      const { frames } = collectFrames(collector, "task_1", 0);
      frames.length = 0;

      collector.setTransport("task_1", 1000, "reconnecting");
      collector.setTransport("task_1", 1000, "static");
      collector.setTransport("task_1", 1000, "live");

      const heartbeats = frames.filter((f) => f.kind === "heartbeat");
      expect(heartbeats).toHaveLength(3);
      const transports = heartbeats.map((h) => (h.kind === "heartbeat" ? h.transport : null));
      expect(transports).toEqual(["reconnecting", "static", "live"]);
    });

    it("ignores setTransport for stale run identity", () => {
      now = 1000;
      collector.startRun(makeRun({ runStartedAt: 1000 }));

      const { frames } = collectFrames(collector, "task_1", 0);
      frames.length = 0;

      collector.setTransport("task_1", 9999, "reconnecting");
      expect(frames).toHaveLength(0);
    });

    it("ignores setTransport after terminal", () => {
      now = 1000;
      collector.startRun(makeRun());
      collector.endRun("task_1", 1000, "complete");

      const { frames } = collectFrames(collector, "task_1", 0);
      frames.length = 0;

      collector.setTransport("task_1", 1000, "static");
      expect(frames.filter((f) => f.kind === "heartbeat")).toHaveLength(0);
    });
  });

  // ── Terminal frames ────────────────────────────────────────────────────

  describe("terminal frames", () => {
    it("emits terminal frame to subscribers on endRun", () => {
      now = 1000;
      collector.startRun(makeRun());

      const { frames } = collectFrames(collector, "task_1", 0);
      frames.length = 0;

      collector.endRun("task_1", 1000, "complete");

      const terminal = frames.find((f) => f.kind === "terminal");
      expect(terminal).toBeDefined();
      if (terminal?.kind === "terminal") {
        expect(terminal.status).toBe("complete");
      }
    });

    it("supports all three terminal statuses", () => {
      const statuses: Array<"complete" | "error" | "aborted"> = ["complete", "error", "aborted"];
      for (let i = 0; i < statuses.length; i++) {
        const status = statuses[i];
        const c = makeCollector();
        c.startRun(makeRun({ taskId: `task_${status}`, runStartedAt: i }));
        const { frames } = collectFrames(c, `task_${status}`, 0);
        frames.length = 0;
        c.endRun(`task_${status}`, i, status);
        const terminal = frames.find((f) => f.kind === "terminal");
        expect(terminal).toBeDefined();
        if (terminal?.kind === "terminal") {
          expect(terminal.status).toBe(status);
        }
      }
    });

    it("rejects recordEvent after terminal", () => {
      now = 1000;
      collector.startRun(makeRun());
      collector.endRun("task_1", 1000, "complete");

      const seq = collector.recordEvent("task_1", 1000, makeInput({ text: "late" }));
      expect(seq).toBeNull();
    });

    it("sends terminal frame to late-joining subscriber", () => {
      now = 1000;
      collector.startRun(makeRun());
      collector.recordEvent("task_1", 1000, makeInput({ text: "a" }));
      collector.endRun("task_1", 1000, "error");

      const { frames } = collectFrames(collector, "task_1", 0);

      const terminal = frames.find((f) => f.kind === "terminal");
      expect(terminal).toBeDefined();
      if (terminal?.kind === "terminal") {
        expect(terminal.status).toBe("error");
      }
    });

    it("ignores endRun for stale run identity", () => {
      now = 1000;
      collector.startRun(makeRun({ runStartedAt: 1000 }));

      const { frames } = collectFrames(collector, "task_1", 0);
      frames.length = 0;

      collector.endRun("task_1", 9999, "complete");
      expect(frames).toHaveLength(0);
    });

    it("ignores duplicate endRun", () => {
      now = 1000;
      collector.startRun(makeRun());

      const { frames } = collectFrames(collector, "task_1", 0);
      frames.length = 0;

      collector.endRun("task_1", 1000, "complete");
      expect(frames.filter((f) => f.kind === "terminal")).toHaveLength(1);

      frames.length = 0;
      collector.endRun("task_1", 1000, "error");
      expect(frames.filter((f) => f.kind === "terminal")).toHaveLength(0);
    });
  });

  // ── Stale-run rejection ────────────────────────────────────────────────

  describe("stale-run rejection", () => {
    it("rejects recordEvent when runStartedAt does not match the active run", () => {
      now = 1000;
      collector.startRun(makeRun({ runStartedAt: 1000 }));
      collector.startRun(makeRun({ runStartedAt: 2000, sessionId: "ses_2" }));

      const seq = collector.recordEvent("task_1", 1000, makeInput({ sessionId: "ses_2" }));
      expect(seq).toBeNull();
    });

    it("rejects recordEvent for a task that was never started", () => {
      const seq = collector.recordEvent("task_unknown", 1000, makeInput());
      expect(seq).toBeNull();
    });

    it("accepts events for the new run after replacement", () => {
      now = 1000;
      collector.startRun(makeRun({ runStartedAt: 1000 }));
      collector.recordEvent("task_1", 1000, makeInput({ text: "old" }));

      collector.startRun(makeRun({ runStartedAt: 2000, sessionId: "ses_2" }));
      now = 2000;
      const seq = collector.recordEvent("task_1", 2000, makeInput({ text: "new", sessionId: "ses_2" }));

      expect(seq).toBe(1);
    });
  });

  // ── Run replacement semantics ──────────────────────────────────────────

  describe("run replacement", () => {
    it("existing subscribers receive gap + new-run snapshot on replacement", () => {
      now = 1000;
      collector.startRun(makeRun({ runStartedAt: 1000 }));
      collector.recordEvent("task_1", 1000, makeInput({ text: "old event" }));

      // Subscribe to the old run
      const { frames } = collectFrames(collector, "task_1", 0);
      frames.length = 0; // clear initial snapshot/heartbeat

      // Replace the run
      collector.startRun(makeRun({ runStartedAt: 2000, sessionId: "ses_2" }));

      // Should receive gap + snapshot for the new run
      const gap = frames.find((f) => f.kind === "gap");
      expect(gap).toBeDefined();
      if (gap?.kind === "gap") {
        expect(gap.afterSeq).toBe(1); // old run's last seq
        expect(gap.reason).toContain("replaced");
      }

      const snapshots = frames.filter((f) => f.kind === "snapshot");
      expect(snapshots.length).toBeGreaterThanOrEqual(1);
      // Last snapshot should be the new empty run
      const lastSnapshot = snapshots[snapshots.length - 1];
      if (lastSnapshot?.kind === "snapshot") {
        expect(lastSnapshot.run.runStartedAt).toBe(2000);
        expect(lastSnapshot.run.sessionId).toBe("ses_2");
        expect(lastSnapshot.events).toHaveLength(0);
      }
    });

    it("deep-clones the run input so caller mutations don't leak in", () => {
      const mutableRun: SessionActivityRun = {
        taskId: "task_mut",
        runStartedAt: 1000,
        sessionId: "ses_orig",
        rootSessionId: "ses_root",
        harness: "opencode",
      };

      collector.startRun(mutableRun);

      // Mutate the original object
      mutableRun.sessionId = "ses_mutated";
      mutableRun.runStartedAt = 9999;

      // The stored run should be unaffected
      collector.recordEvent("task_mut", 1000, makeInput({ sessionId: "ses_orig", text: "safe" }));

      const { frames } = collectFrames(collector, "task_mut", 0);
      const snapshot = frames.find((f) => f.kind === "snapshot");
      if (snapshot?.kind === "snapshot") {
        expect(snapshot.run.sessionId).toBe("ses_orig");
        expect(snapshot.run.runStartedAt).toBe(1000);
      }
    });

    it("deep-clones event inputs so caller mutations don't leak in", () => {
      now = 1000;
      collector.startRun(makeRun());

      const mutableInput = makeInput({ text: "original" });
      collector.recordEvent("task_1", 1000, mutableInput);

      // Mutate after recording
      mutableInput.text = "mutated";

      const { frames } = collectFrames(collector, "task_1", 0);
      const snapshot = frames.find((f) => f.kind === "snapshot");
      if (snapshot?.kind === "snapshot") {
        expect(snapshot.events[0].text).toBe("original");
      }
    });

    it("a subscriber mutating its delivered snapshot run/events cannot corrupt another subscriber's view (P3-4)", () => {
      now = 1000;
      collector.startRun(makeRun());
      collector.recordEvent("task_1", 1000, makeInput({ text: "shared" }));

      const subA = collectFrames(collector, "task_1", 0);
      const subB = collectFrames(collector, "task_1", 0);

      const snapshotA = subA.frames.find((f) => f.kind === "snapshot");
      if (snapshotA?.kind === "snapshot") {
        // Subscriber A mutates its own delivered copy.
        (snapshotA.run as { sessionId: string }).sessionId = "corrupted";
        (snapshotA.events[0] as { text?: string }).text = "corrupted";
      }

      const snapshotB = subB.frames.find((f) => f.kind === "snapshot");
      if (snapshotB?.kind === "snapshot") {
        expect(snapshotB.run.sessionId).toBe("ses_1");
        expect(snapshotB.events[0].text).toBe("shared");
      }

      // Internal state is unaffected too — a fresh subscribe sees clean data.
      const subC = collectFrames(collector, "task_1", 0);
      const snapshotC = subC.frames.find((f) => f.kind === "snapshot");
      if (snapshotC?.kind === "snapshot") {
        expect(snapshotC.run.sessionId).toBe("ses_1");
        expect(snapshotC.events[0].text).toBe("shared");
      }
    });

    it("mutating an append frame's event does not corrupt another subscriber's copy (P3-4)", () => {
      now = 1000;
      collector.startRun(makeRun());

      const subA = collectFrames(collector, "task_1", 0);
      const subB = collectFrames(collector, "task_1", 0);
      subA.frames.length = 0;
      subB.frames.length = 0;

      collector.recordEvent("task_1", 1000, makeInput({ text: "appended" }));

      const appendA = subA.frames.find((f) => f.kind === "append");
      if (appendA?.kind === "append") {
        (appendA.event as { text?: string }).text = "corrupted";
      }

      const appendB = subB.frames.find((f) => f.kind === "append");
      if (appendB?.kind === "append") {
        expect(appendB.event.text).toBe("appended");
      }
    });
  });

  // ── Subscriber cleanup ─────────────────────────────────────────────────

  describe("subscriber cleanup", () => {
    it("unsubscribe removes the callback from the fanout set", () => {
      now = 1000;
      collector.startRun(makeRun());

      const { frames, unsubscribe } = collectFrames(collector, "task_1", 0);
      frames.length = 0;
      unsubscribe();

      collector.recordEvent("task_1", 1000, makeInput({ text: "post" }));
      expect(frames).toHaveLength(0);
    });

    it("multiple subscribers can independently unsubscribe", () => {
      now = 1000;
      collector.startRun(makeRun());

      const sub1 = collectFrames(collector, "task_1", 0);
      const sub2 = collectFrames(collector, "task_1", 0);

      sub1.frames.length = 0;
      sub2.frames.length = 0;

      sub1.unsubscribe();
      collector.recordEvent("task_1", 1000, makeInput({ text: "x" }));

      expect(sub1.frames).toHaveLength(0);
      expect(sub2.frames).toHaveLength(1);
    });

    it("reset clears all subscribers and runs", () => {
      now = 1000;
      collector.startRun(makeRun());
      collector.recordEvent("task_1", 1000, makeInput({ text: "a" }));

      const { frames } = collectFrames(collector, "task_1", 0);
      frames.length = 0;

      collector.reset();

      collector.startRun(makeRun());
      collector.recordEvent("task_1", 1000, makeInput({ text: "after reset" }));

      expect(frames).toHaveLength(0);

      const newSub = collectFrames(collector, "task_1", 0);
      const snapshot = newSub.frames.find((f) => f.kind === "snapshot");
      expect(snapshot).toBeDefined();
      if (snapshot?.kind === "snapshot") {
        expect(snapshot.events).toHaveLength(1);
        expect(snapshot.events[0].text).toBe("after reset");
      }
    });
  });

  // ── Throwing subscriber isolation ──────────────────────────────────────

  describe("throwing subscriber isolation", () => {
    it("a throwing subscriber does not prevent other subscribers from receiving frames", () => {
      now = 1000;
      collector.startRun(makeRun());

      const goodFrames: SessionActivityFrame[] = [];
      collector.subscribe("task_1", 0, (_frame) => {
        throw new Error("simulated subscriber crash");
      });

      const goodUnsub = collector.subscribe("task_1", 0, (frame) => {
        goodFrames.push(frame);
      });

      // Clear initial snapshot/heartbeat
      goodFrames.length = 0;

      // Record event - good subscriber should still get it
      collector.recordEvent("task_1", 1000, makeInput({ text: "survives" }));

      expect(goodFrames).toHaveLength(1);
      expect(goodFrames[0].kind).toBe("append");
      if (goodFrames[0].kind === "append") {
        expect(goodFrames[0].event.text).toBe("survives");
      }

      goodUnsub();
    });

    it("a throwing subscriber does not break setTransport fanout", () => {
      now = 1000;
      collector.startRun(makeRun());

      const goodFrames: SessionActivityFrame[] = [];

      collector.subscribe("task_1", 0, (_frame) => {
        throw new Error("crash");
      });

      const goodUnsub = collector.subscribe("task_1", 0, (frame) => {
        goodFrames.push(frame);
      });

      goodFrames.length = 0;

      collector.setTransport("task_1", 1000, "reconnecting");

      const heartbeats = goodFrames.filter((f) => f.kind === "heartbeat");
      expect(heartbeats).toHaveLength(1);

      goodUnsub();
    });

    it("a throwing subscriber does not break endRun fanout", () => {
      now = 1000;
      collector.startRun(makeRun());

      const goodFrames: SessionActivityFrame[] = [];

      collector.subscribe("task_1", 0, (_frame) => {
        throw new Error("crash");
      });

      const goodUnsub = collector.subscribe("task_1", 0, (frame) => {
        goodFrames.push(frame);
      });

      goodFrames.length = 0;

      collector.endRun("task_1", 1000, "aborted");

      const terminals = goodFrames.filter((f) => f.kind === "terminal");
      expect(terminals).toHaveLength(1);

      goodUnsub();
    });

    it("a throwing subscriber on subscribe does not break subscription registration", () => {
      now = 1000;
      collector.startRun(makeRun());

      // This subscriber throws on the initial frames (snapshot/heartbeat)
      collector.subscribe("task_1", 0, (_frame) => {
        throw new Error("initial crash");
      });

      // Second subscriber should still get initial frames
      const goodFrames: SessionActivityFrame[] = [];
      collector.subscribe("task_1", 0, (frame) => {
        goodFrames.push(frame);
      });

      const snapshot = goodFrames.find((f) => f.kind === "snapshot");
      expect(snapshot).toBeDefined();
      const heartbeat = goodFrames.find((f) => f.kind === "heartbeat");
      expect(heartbeat).toBeDefined();
    });
  });

  // ── Sanitization / bounds ──────────────────────────────────────────────

  describe("sanitization and bounds", () => {
    it("events carry only contract-defined fields (no raw provider IDs, secrets, metadata)", () => {
      now = 1000;
      collector.startRun(makeRun());
      collector.recordEvent("task_1", 1000, makeInput({ text: "safe text" }));

      const { frames } = collectFrames(collector, "task_1", 0);
      const snapshot = frames.find((f) => f.kind === "snapshot");
      if (snapshot?.kind === "snapshot") {
        const event = snapshot.events[0];
        const allowedKeys = [
          "seq", "taskId", "runStartedAt", "sessionId", "rootSessionId",
          "parentSessionId", "harness", "occurredAt", "kind", "role", "text", "tool",
        ];
        const actualKeys = Object.keys(event).sort();
        expect(actualKeys).toEqual(allowedKeys.sort());
        expect(event).not.toHaveProperty("rawInput");
        expect(event).not.toHaveProperty("rawOutput");
        expect(event).not.toHaveProperty("nativeProviderId");
        expect(event).not.toHaveProperty("secret");
        expect(event).not.toHaveProperty("metadata");
      }
    });

    it("truncates oversize text to MAX_TEXT_LENGTH with sentinel", () => {
      now = 1000;
      collector.startRun(makeRun());

      const longText = "x".repeat(20_000);
      collector.recordEvent("task_1", 1000, makeInput({ text: longText }));

      const { frames } = collectFrames(collector, "task_1", 0);
      const snapshot = frames.find((f) => f.kind === "snapshot");
      if (snapshot?.kind === "snapshot") {
        const text = snapshot.events[0].text!;
        expect(text.length).toBeLessThan(20_000);
        expect(text.endsWith("[...truncated]")).toBe(true);
      }
    });

    it("truncates tool name exceeding MAX_NAME_LENGTH", () => {
      now = 1000;
      collector.startRun(makeRun());

      const longName = "x".repeat(500);
      collector.recordEvent("task_1", 1000, makeInput({
        kind: "tool",
        tool: { name: longName, status: "started" },
      }));

      const { frames } = collectFrames(collector, "task_1", 0);
      const snapshot = frames.find((f) => f.kind === "snapshot");
      if (snapshot?.kind === "snapshot") {
        const tool = snapshot.events[0].tool!;
        expect(tool.name.length).toBe(256);
      }
    });

    it("truncates tool callId exceeding MAX_NAME_LENGTH", () => {
      now = 1000;
      collector.startRun(makeRun());

      const longId = "y".repeat(500);
      collector.recordEvent("task_1", 1000, makeInput({
        kind: "tool",
        tool: { name: "bash", callId: longId, status: "complete" },
      }));

      const { frames } = collectFrames(collector, "task_1", 0);
      const snapshot = frames.find((f) => f.kind === "snapshot");
      if (snapshot?.kind === "snapshot") {
        expect(snapshot.events[0].tool!.callId!.length).toBe(256);
      }
    });

    it("clamps negative durationMs to 0", () => {
      now = 1000;
      collector.startRun(makeRun());

      collector.recordEvent("task_1", 1000, makeInput({
        kind: "tool",
        tool: { name: "bash", status: "complete", durationMs: -42 },
      }));

      const { frames } = collectFrames(collector, "task_1", 0);
      const snapshot = frames.find((f) => f.kind === "snapshot");
      if (snapshot?.kind === "snapshot") {
        expect(snapshot.events[0].tool!.durationMs).toBe(0);
      }
    });

    it("clamps negative outputBytes to 0", () => {
      now = 1000;
      collector.startRun(makeRun());

      collector.recordEvent("task_1", 1000, makeInput({
        kind: "tool",
        tool: { name: "bash", status: "complete", outputBytes: -100 },
      }));

      const { frames } = collectFrames(collector, "task_1", 0);
      const snapshot = frames.find((f) => f.kind === "snapshot");
      if (snapshot?.kind === "snapshot") {
        expect(snapshot.events[0].tool!.outputBytes).toBe(0);
      }
    });

    it("clamps NaN durationMs to 0", () => {
      now = 1000;
      collector.startRun(makeRun());

      collector.recordEvent("task_1", 1000, makeInput({
        kind: "tool",
        tool: { name: "bash", status: "complete", durationMs: NaN },
      }));

      const { frames } = collectFrames(collector, "task_1", 0);
      const snapshot = frames.find((f) => f.kind === "snapshot");
      if (snapshot?.kind === "snapshot") {
        expect(snapshot.events[0].tool!.durationMs).toBe(0);
      }
    });

    it("clamps oversize integers to Number.MAX_SAFE_INTEGER", () => {
      now = 1000;
      collector.startRun(makeRun());

      collector.recordEvent("task_1", 1000, makeInput({
        kind: "tool",
        tool: { name: "bash", status: "complete", durationMs: Number.MAX_VALUE, outputBytes: 1e20 },
      }));

      const { frames } = collectFrames(collector, "task_1", 0);
      const snapshot = frames.find((f) => f.kind === "snapshot");
      if (snapshot?.kind === "snapshot") {
        expect(snapshot.events[0].tool!.durationMs).toBe(Number.MAX_SAFE_INTEGER);
        expect(snapshot.events[0].tool!.outputBytes).toBe(Number.MAX_SAFE_INTEGER);
      }
    });

    it("rejects tool kind without tool data (impossible shape)", () => {
      now = 1000;
      collector.startRun(makeRun());

      const seq = collector.recordEvent("task_1", 1000, {
        ...makeInput(),
        kind: "tool" as const,
        tool: undefined,
      } as SessionActivityEventInput);
      expect(seq).toBeNull();
    });

    it("drops tool data from non-tool kind events rather than rejecting", () => {
      now = 1000;
      collector.startRun(makeRun());

      const seq = collector.recordEvent("task_1", 1000, makeInput({
        kind: "text",
        text: "msg",
        tool: { name: "bash", status: "started" }, // extraneous tool data
      }));

      expect(seq).toBe(1); // accepted, but tool stripped

      const { frames } = collectFrames(collector, "task_1", 0);
      const snapshot = frames.find((f) => f.kind === "snapshot");
      if (snapshot?.kind === "snapshot") {
        expect(snapshot.events[0].tool).toBeUndefined();
        expect(snapshot.events[0].text).toBe("msg");
      }
    });

    it("handles all event kinds", () => {
      const kinds = ["text", "tool", "status", "permission", "warning"] as const;
      now = 1000;
      collector.startRun(makeRun());

      for (const kind of kinds) {
        const input: SessionActivityEventInput = kind === "tool"
          ? makeInput({ kind, tool: { name: "bash", status: "started" } })
          : makeInput({ kind, text: kind === "text" ? "msg" : undefined });
        collector.recordEvent("task_1", 1000, input);
      }

      const { frames } = collectFrames(collector, "task_1", 0);
      const snapshot = frames.find((f) => f.kind === "snapshot");
      if (snapshot?.kind === "snapshot") {
        expect(snapshot.events).toHaveLength(5);
        const eventKinds = snapshot.events.map((e) => e.kind);
        expect(eventKinds).toEqual(["text", "tool", "status", "permission", "warning"]);
      }
    });

    it("handles role variants", () => {
      const roles = ["assistant", "user", "system"] as const;
      now = 1000;
      collector.startRun(makeRun());

      for (const role of roles) {
        collector.recordEvent("task_1", 1000, makeInput({ role, text: `msg from ${role}` }));
      }

      const { frames } = collectFrames(collector, "task_1", 0);
      const snapshot = frames.find((f) => f.kind === "snapshot");
      if (snapshot?.kind === "snapshot") {
        expect(snapshot.events.map((e) => e.role)).toEqual(["assistant", "user", "system"]);
      }
    });

    it("defaults maxEvents to 1000", () => {
      const c = makeCollector();
      c.startRun(makeRun());

      for (let i = 0; i < 500; i++) {
        c.recordEvent("task_1", 1000, makeInput({ text: `event ${i}` }));
      }

      const { frames } = collectFrames(c, "task_1", 0);
      const snapshot = frames.find((f) => f.kind === "snapshot");
      if (snapshot?.kind === "snapshot") {
        expect(snapshot.events).toHaveLength(500);
      }
    });

    it("tool events carry only name, callId, status, durationMs, outputBytes", () => {
      now = 1000;
      collector.startRun(makeRun());

      collector.recordEvent("task_1", 1000, makeInput({
        kind: "tool",
        tool: {
          name: "bash",
          callId: "call_1",
          status: "complete",
          durationMs: 42,
          outputBytes: 1024,
        },
      }));

      const { frames } = collectFrames(collector, "task_1", 0);
      const snapshot = frames.find((f) => f.kind === "snapshot");
      if (snapshot?.kind === "snapshot") {
        const tool = snapshot.events[0].tool!;
        expect(tool.name).toBe("bash");
        expect(tool.callId).toBe("call_1");
        expect(tool.status).toBe("complete");
        expect(tool.durationMs).toBe(42);
        expect(tool.outputBytes).toBe(1024);
        expect(tool).not.toHaveProperty("input");
        expect(tool).not.toHaveProperty("output");
        expect(tool).not.toHaveProperty("inputSummary");
        expect(tool).not.toHaveProperty("outputSummary");
      }
    });

    it("truncates sessionId/rootSessionId/parentSessionId exceeding MAX_ID_LENGTH (P3-2)", () => {
      now = 1000;
      const longId = "s".repeat(500);
      collector.startRun(makeRun({ sessionId: longId, rootSessionId: longId }));

      collector.recordEvent("task_1", 1000, makeInput({
        sessionId: longId,
        rootSessionId: longId,
        parentSessionId: longId,
      }));

      const { frames } = collectFrames(collector, "task_1", 0);
      const snapshot = frames.find((f) => f.kind === "snapshot");
      if (snapshot?.kind === "snapshot") {
        expect(snapshot.run.sessionId.length).toBe(256);
        expect(snapshot.run.rootSessionId.length).toBe(256);
        expect(snapshot.events[0].sessionId.length).toBe(256);
        expect(snapshot.events[0].rootSessionId.length).toBe(256);
        expect(snapshot.events[0].parentSessionId).toHaveLength(256);
      }
    });

    it("leaves null/undefined parentSessionId untouched (P3-2)", () => {
      now = 1000;
      collector.startRun(makeRun());
      collector.recordEvent("task_1", 1000, makeInput({ parentSessionId: null }));

      const { frames } = collectFrames(collector, "task_1", 0);
      const snapshot = frames.find((f) => f.kind === "snapshot");
      if (snapshot?.kind === "snapshot") {
        expect(snapshot.events[0].parentSessionId).toBeNull();
      }
    });
  });

  // ── Integration scenarios ──────────────────────────────────────────────

  describe("integration scenarios", () => {
    it("handles the full lifecycle: start -> events -> transport -> terminal", () => {
      now = 1000;
      const allFrames: SessionActivityFrame[] = [];

      collector.startRun(makeRun());
      collector.subscribe("task_1", 0, (frame) => allFrames.push(frame));
      allFrames.length = 0;

      now = 1001;
      collector.recordEvent("task_1", 1000, makeInput({ text: "starting" }));
      now = 1002;
      collector.recordEvent("task_1", 1000, makeInput({ kind: "tool", tool: { name: "bash", status: "started" } }));
      now = 1003;
      collector.recordEvent("task_1", 1000, makeInput({ kind: "tool", tool: { name: "bash", status: "complete", durationMs: 100 } }));

      collector.setTransport("task_1", 1000, "reconnecting");
      collector.setTransport("task_1", 1000, "live");

      collector.endRun("task_1", 1000, "complete");

      const kinds = allFrames.map((f) => f.kind);
      expect(kinds).toEqual([
        "append", "append", "append",
        "heartbeat", "heartbeat",
        "terminal",
      ]);
    });

    it("handles multiple tasks independently", () => {
      now = 1000;

      collector.startRun(makeRun({ taskId: "task_a", runStartedAt: 1000 }));
      collector.startRun(makeRun({ taskId: "task_b", runStartedAt: 2000, sessionId: "ses_b" }));

      collector.recordEvent("task_a", 1000, makeInput({ sessionId: "ses_a", text: "a1" }));
      collector.recordEvent("task_b", 2000, makeInput({ sessionId: "ses_b", text: "b1" }));
      collector.recordEvent("task_a", 1000, makeInput({ sessionId: "ses_a", text: "a2" }));

      const { frames: framesA } = collectFrames(collector, "task_a", 0);
      const { frames: framesB } = collectFrames(collector, "task_b", 0);

      const snapshotA = framesA.find((f) => f.kind === "snapshot") as Extract<SessionActivityFrame, { kind: "snapshot" }> | undefined;
      const snapshotB = framesB.find((f) => f.kind === "snapshot") as Extract<SessionActivityFrame, { kind: "snapshot" }> | undefined;

      expect(snapshotA?.events.map((e) => e.text)).toEqual(["a1", "a2"]);
      expect(snapshotB?.events.map((e) => e.text)).toEqual(["b1"]);
    });

    it("collapses identical assistant echoes within one user turn but resets at the next user message", () => {
      collector.startRun(makeRun());
      collector.recordEvent("task_1", 1000, makeInput({ role: "user", text: "first" }));
      collector.recordEvent("task_1", 1000, makeInput({ role: "assistant", text: "YES" }));
      expect(collector.recordEvent("task_1", 1000, makeInput({ role: "assistant", text: "YES" }))).toBeNull();
      collector.recordEvent("task_1", 1000, makeInput({ role: "user", text: "second" }));
      expect(collector.recordEvent("task_1", 1000, makeInput({ role: "assistant", text: "YES" }))).not.toBeNull();

      const { frames } = collectFrames(collector, "task_1", 0);
      const snapshot = frames.find((frame) => frame.kind === "snapshot");
      expect(snapshot?.kind === "snapshot" ? snapshot.events.map((event) => event.text) : []).toEqual(["first", "YES", "second", "YES"]);
    });

    it("reconnect with cursor: subscriber gets gap + snapshot + heartbeat", () => {
      const small = makeCollector({ maxEvents: 2 });
      now = 1000;
      small.startRun(makeRun());

      small.recordEvent("task_1", 1000, makeInput({ text: "a" })); // seq 1
      small.recordEvent("task_1", 1000, makeInput({ text: "b" })); // seq 2
      small.recordEvent("task_1", 1000, makeInput({ text: "c" })); // seq 3 (a evicted)
      small.recordEvent("task_1", 1000, makeInput({ text: "d" })); // seq 4 (b evicted)

      const { frames } = collectFrames(small, "task_1", 1);

      const kinds = frames.map((f) => f.kind);
      expect(kinds).toContain("gap");
      expect(kinds).toContain("snapshot");
      expect(kinds).toContain("heartbeat");

      const gap = frames.find((f) => f.kind === "gap");
      if (gap?.kind === "gap") {
        expect(gap.afterSeq).toBe(1);
      }

      const snapshot = frames.find((f) => f.kind === "snapshot");
      if (snapshot?.kind === "snapshot") {
        expect(snapshot.events).toHaveLength(2);
        expect(snapshot.events[0].seq).toBe(3);
      }
    });

    it("late-joining subscriber receives terminal after run is done", () => {
      now = 1000;
      collector.startRun(makeRun());
      collector.recordEvent("task_1", 1000, makeInput({ text: "a" }));
      collector.endRun("task_1", 1000, "aborted");

      const { frames } = collectFrames(collector, "task_1", 0);

      const terminal = frames.find((f) => f.kind === "terminal");
      expect(terminal).toBeDefined();
      if (terminal?.kind === "terminal") {
        expect(terminal.status).toBe("aborted");
      }

      const snapshot = frames.find((f) => f.kind === "snapshot");
      if (snapshot?.kind === "snapshot") {
        expect(snapshot.events).toHaveLength(1);
      }
    });
  });
});
