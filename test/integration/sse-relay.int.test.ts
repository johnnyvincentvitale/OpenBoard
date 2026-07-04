/**
 * Phase 4 integration test — exercises the REAL EventBridge against a REAL
 * ephemeral `opencode serve` process: subscribes to the bridge, creates a
 * real session via the SDK client, and asserts a board-shaped frame for
 * that session arrives via the live `/event` relay (not a direct fetch).
 * Self-skips if an ephemeral OpenCode server can't be started in this
 * environment (e.g. CI without the binary).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config";
import { startOrConnect, type OpencodeHandle } from "../../src/server/opencode";
import { SqliteColumnStore } from "../../src/db/board-store";
import { EventBridge } from "../../src/server/event-bridge";
import type { BoardFrame } from "../../src/shared";
import {
  opencodeAvailable,
  startEphemeralOpencodeServer,
  type EphemeralOpencodeServer,
} from "../helpers/ephemeral-opencode-server";

const available = await opencodeAvailable();

const FRAME_WAIT_TIMEOUT_MS = 10_000;
const TEST_TIMEOUT_MS = 20_000;

describe.skipIf(!available)("SSE relay (integration)", () => {
  let ephemeral: EphemeralOpencodeServer;
  let handle: OpencodeHandle;
  let store: SqliteColumnStore;
  let bridge: EventBridge;

  beforeAll(async () => {
    ephemeral = await startEphemeralOpencodeServer();

    const config = loadConfig({
      ...process.env,
      OPENCODE_BASE_URL: ephemeral.url,
    });
    handle = await startOrConnect(config);

    store = new SqliteColumnStore(":memory:");
    bridge = new EventBridge({ client: handle.client, store });
    bridge.start();
  });

  afterAll(async () => {
    bridge?.stop();
    await handle?.shutdown();
    store?.close();
    await ephemeral?.close();
  });

  it(
    "relays an upsert/snapshot BoardFrame for a newly created session",
    async () => {
      const frames: BoardFrame[] = [];
      let resolveFound: (() => void) | undefined;
      const found = new Promise<void>((resolve) => {
        resolveFound = resolve;
      });

      const matchesSession = (frame: BoardFrame, sessionId: string): boolean => {
        if (frame.kind === "upsert") return frame.card.sessionId === sessionId;
        if (frame.kind === "snapshot") return frame.cards.some((c) => c.sessionId === sessionId);
        return false;
      };

      // Subscribe first (no replay needed — fromSeq omitted), then create the
      // session so we know any matching frame arrived live off the relay.
      let sessionId: string | undefined;
      const unsubscribe = bridge.subscribe(undefined, (frame) => {
        frames.push(frame);
        if (sessionId && matchesSession(frame, sessionId)) {
          resolveFound?.();
        }
      });

      try {
        const createResult = await handle.client.session.create({
          title: "integration-test-sse-session",
        });
        expect(createResult.error).toBeFalsy();
        expect(createResult.data).toBeTruthy();
        sessionId = createResult.data!.id;

        // In case the matching frame arrived between session creation and
        // the id being assigned above, check what's already buffered too.
        if (frames.some((f) => matchesSession(f, sessionId!))) {
          resolveFound?.();
        }

        const timeout = new Promise<void>((_, reject) => {
          setTimeout(
            () => reject(new Error("Timed out waiting for a matching BoardFrame")),
            FRAME_WAIT_TIMEOUT_MS,
          );
        });

        await Promise.race([found, timeout]);
      } finally {
        unsubscribe();
      }

      expect(sessionId).toBeTruthy();
      expect(frames.some((f) => matchesSession(f, sessionId!))).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
