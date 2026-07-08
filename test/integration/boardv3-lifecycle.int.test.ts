/**
 * BoardV3 seam integration test — proves the five BoardV3 features (frozen
 * shared contracts, the explicit completion contract, archive+filters,
 * multi-instance config, and dependency gating + parent-handoff injection)
 * work TOGETHER through the real adapter (real `createApp`, real
 * `TaskDispatcher`, real `SqliteTaskStore`, real ephemeral `opencode serve`),
 * not just in isolation.
 *
 * Follows the existing integration-test harness pattern (see
 * `session-routes.int.test.ts` / `sse-relay.int.test.ts`): a real ephemeral
 * OpenCode backend via `startEphemeralOpencodeServer()`, self-skipping via
 * `opencodeAvailable()` when the `opencode` binary/runtime isn't available in
 * this environment (e.g. some CI). No mocks of the dispatcher, store, or
 * routes — only the "did the assistant actually finish its turn" wait is
 * avoided for the parent task (per the card's guidance to drive completion
 * via a minimal-stub session path rather than paying real model
 * latency/cost for every leg of this lifecycle): the parent's session is
 * created for real and prompted for real (so its dispatch, in_progress move,
 * and PARENT CONTEXT injection are all exercised through the real dispatcher
 * and real OpenCode session), but the *completion report* is supplied via the
 * documented external contract (`POST /api/tasks/:id/complete`) rather than
 * waiting on a real model turn to finish and self-report — exactly the path
 * a real agent takes when it calls that contract as its final action.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config";
import { startOrConnect, type OpencodeHandle } from "../../src/server/opencode";
import { SqliteTaskStore } from "../../src/db/task-store";
import { GlobalArchiveStore } from "../../src/db/global-archive-store";
import { TaskDispatcher } from "../../src/server/dispatcher";
import { createApp } from "../../src/server/app";
import type { Task } from "../../src/shared";
import {
  opencodeAvailable,
  startEphemeralOpencodeServer,
  type EphemeralOpencodeServer,
} from "../helpers/ephemeral-opencode-server";

const available = await opencodeAvailable();
const BOARD_TOKEN = "test-token";
const AUTH_HEADERS = { authorization: `Bearer ${BOARD_TOKEN}` } as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 20_000,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await probe();
    if (value !== undefined) return value;
    await sleep(300);
  }
  throw new Error("waitFor timed out");
}

const validCompletion = {
  summary: "parent work complete",
  changedFiles: ["src/parent-file.ts"],
  verification: [{ command: "npm test", result: "passed" }],
  residualRisk: "none",
};

describe.skipIf(!available)("BoardV3 lifecycle seam (integration)", () => {
  let ephemeral: EphemeralOpencodeServer;
  let handle: OpencodeHandle;
  let taskStore: SqliteTaskStore;
  let dispatcher: TaskDispatcher;
  let app: ReturnType<typeof createApp>;
  let boardWorkspace: string;
  let taskDir: string;
  let previousBoardWorkspace: string | undefined;

  beforeAll(async () => {
    ephemeral = await startEphemeralOpencodeServer();
    previousBoardWorkspace = process.env.BOARD_WORKSPACE;
    boardWorkspace = mkdtempSync(join(tmpdir(), "openboard-boardv3-workspace-"));
    process.env.BOARD_WORKSPACE = boardWorkspace;

    const config = loadConfig({
      ...process.env,
      OPENCODE_BASE_URL: ephemeral.url,
    });
    handle = await startOrConnect(config);

    taskStore = new SqliteTaskStore(":memory:");
    dispatcher = new TaskDispatcher({ client: handle.client, store: taskStore, boardToken: BOARD_TOKEN });
    dispatcher.start();

    app = createApp({
      client: handle.client,
      taskStore,
      dispatcher,
      opencodeBaseUrl: handle.baseUrl,
      globalArchiveStore: new GlobalArchiveStore(":memory:"),
      sourceInstance: { port: 0, workspace: "/test", dbPath: ":memory:" },
      boardToken: BOARD_TOKEN,
      opencodeMode: "connect",
    });

    taskDir = mkdtempSync(join(boardWorkspace, "task-"));
  });

  afterAll(async () => {
    dispatcher?.shutdown();
    await handle?.shutdown();
    taskStore?.close();
    await ephemeral?.close();
    if (previousBoardWorkspace === undefined) delete process.env.BOARD_WORKSPACE;
    else process.env.BOARD_WORKSPACE = previousBoardWorkspace;
    if (boardWorkspace) rmSync(boardWorkspace, { recursive: true, force: true });
  });

  it(
    "full loop: link -> gated 409 -> parent completes -> parent to done -> gate opens -> child dispatch carries the handoff -> archive/unarchive round-trips",
    async () => {
      // --- 1. Create parent + child tasks -----------------------------------
      const parentRes = await app.request("/api/tasks", {
        method: "POST",
        headers: { ...AUTH_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({
          title: "BoardV3 seam parent",
          description: "Parent task doing setup work.",
          directory: taskDir,
        }),
      });
      expect(parentRes.status).toBe(201);
      const parent = (await parentRes.json()) as Task;

      const childRes = await app.request("/api/tasks", {
        method: "POST",
        headers: { ...AUTH_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({
          title: "BoardV3 seam child",
          description: "Child task that depends on the parent.",
          directory: taskDir,
        }),
      });
      expect(childRes.status).toBe(201);
      const child = (await childRes.json()) as Task;

      // --- 2. Link child -> parent -------------------------------------------
      const linkRes = await app.request(`/api/tasks/${child.id}/links`, {
        method: "POST",
        headers: { ...AUTH_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({ parentId: parent.id }),
      });
      expect(linkRes.status).toBe(200);
      const linkedChild = (await linkRes.json()) as Task;
      expect(linkedChild.parentIds).toEqual([parent.id]);

      // --- 3. Attempt to run the child -> 409 naming the unmet parent --------
      const gatedRes = await app.request(`/api/tasks/${child.id}/run`, { method: "POST", headers: AUTH_HEADERS });
      expect(gatedRes.status).toBe(409);
      const gatedBody = await gatedRes.json();
      expect(gatedBody.error.unmetParents).toEqual([
        { id: parent.id, title: "BoardV3 seam parent", why: "parent is in todo" },
      ]);

      // --- 4. Run the parent for real (real session, real dispatch) ----------
      const parentRunRes = await app.request(`/api/tasks/${parent.id}/run`, { method: "POST", headers: AUTH_HEADERS });
      expect(parentRunRes.status).toBe(202);
      const parentRunning = (await parentRunRes.json()) as Task;
      expect(parentRunning.column).toBe("in_progress");
      expect(parentRunning.runState).toBe("running");
      expect(parentRunning.sessionId).toBeTruthy();

      // Confirm the real OpenCode session actually received the prompt (the
      // completion-contract footer travels on every dispatched prompt).
      const parentMessages = await waitFor(async () => {
        const result = await handle.client.session.messages({
          sessionID: parentRunning.sessionId!,
        });
        if (result.error) return undefined;
        const userMsg = result.data?.find((m) => m.info.role === "user");
        return userMsg ? result.data : undefined;
      });
      const parentPromptText = (
        parentMessages.find((m) => m.info.role === "user")?.parts as Array<{
          type: string;
          text?: string;
        }>
      )?.find((p) => p.type === "text")?.text;
      expect(parentPromptText).toContain("OPENBOARD COMPLETION CONTRACT");
      expect(parentPromptText).toContain(`Task id: ${parent.id}`);
      expect(parentPromptText).toContain(`Authorization: Bearer ${BOARD_TOKEN}`);

      // --- 5. Simulate the parent reaching a completion report via POST /complete
      const completeRes = await app.request(`/api/tasks/${parent.id}/complete`, {
        method: "POST",
        headers: { ...AUTH_HEADERS, "content-type": "application/json" },
        body: JSON.stringify(validCompletion),
      });
      expect(completeRes.status).toBe(200);
      const completedParent = (await completeRes.json()) as Task;
      expect(completedParent.column).toBe("review");
      expect(completedParent.runState).toBe("idle");
      expect(completedParent.completionSource).toBe("reported");
      expect(completedParent.completion?.outcome).toBe("complete");
      expect(completedParent.completion?.summary).toBe(validCompletion.summary);

      // Abort the parent's real session now that we've driven completion via
      // the explicit contract rather than waiting for the model turn.
      await handle.client.session.abort({ sessionID: parentRunning.sessionId! }).catch(() => {});

      // --- 6. Move parent to done ---------------------------------------------
      // (Per the dispatcher's gate, a "reported complete" parent already
      // satisfies its children regardless of column — see
      // `unmetReason()`/`assertParentsSatisfied()` in dispatcher.ts, and the
      // matching unit coverage in test/server/dispatcher.test.ts /
      // test/server/routes/tasks.test.ts. This move exercises the manual
      // "move to done" path from the lifecycle description and confirms it
      // also keeps the gate open, rather than proving the gate was closed
      // beforehand.)
      const moveRes = await app.request(`/api/tasks/${parent.id}/move`, {
        method: "POST",
        headers: { ...AUTH_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({ column: "done", position: 0 }),
      });
      expect(moveRes.status).toBe(200);
      const parentInDone = ((await moveRes.json()) as Task[]).find((t) => t.id === parent.id);
      expect(parentInDone?.column).toBe("done");

      // --- 7. Run the child -> gate opens, dispatch succeeds ------------------
      const childRunRes = await app.request(`/api/tasks/${child.id}/run`, { method: "POST", headers: AUTH_HEADERS });
      expect(childRunRes.status).toBe(202);
      const childRunning = (await childRunRes.json()) as Task;
      expect(childRunning.column).toBe("in_progress");
      expect(childRunning.runState).toBe("running");
      expect(childRunning.sessionId).toBeTruthy();

      // Assert the dispatched prompt actually contains the PARENT CONTEXT
      // section with the parent's report fields. The dispatcher writes the
      // full prompt (description + PARENT CONTEXT + completion contract) as
      // a single user message part, observable via the real session's
      // message history — so we can assert on the real prompt text, not just
      // that the gate opened.
      const childMessages = await waitFor(async () => {
        const result = await handle.client.session.messages({
          sessionID: childRunning.sessionId!,
        });
        if (result.error) return undefined;
        const userMsg = result.data?.find((m) => m.info.role === "user");
        return userMsg ? result.data : undefined;
      });
      const childPromptText = (
        childMessages.find((m) => m.info.role === "user")?.parts as Array<{
          type: string;
          text?: string;
        }>
      )?.find((p) => p.type === "text")?.text;

      expect(childPromptText).toBeTruthy();
      expect(childPromptText).toContain("PARENT CONTEXT");
      expect(childPromptText).toContain("PARENT-000: BoardV3 seam parent");
      expect(childPromptText).toContain(`PARENT-000 TASK ID: ${parent.id}`);
      expect(childPromptText).toContain(`PARENT-000 SUMMARY: ${validCompletion.summary}`);
      expect(childPromptText).toContain("PARENT-000 Changed files:");
      for (const file of validCompletion.changedFiles) {
        expect(childPromptText).toContain(`- ${file}`);
      }
      expect(childPromptText).toContain(
        `- ${validCompletion.verification[0]!.command}: ${validCompletion.verification[0]!.result}`,
      );
      expect(childPromptText).toContain(`PARENT-000 Residual risk: ${validCompletion.residualRisk}`);
      // PARENT CONTEXT must precede the completion contract in the same prompt.
      expect(childPromptText!.indexOf("PARENT CONTEXT")).toBeLessThan(
        childPromptText!.indexOf("OPENBOARD COMPLETION CONTRACT"),
      );

      await handle.client.session.abort({ sessionID: childRunning.sessionId! }).catch(() => {});

      // --- 8. Complete the child too, then move it to done for archiving -----
      const childCompleteRes = await app.request(`/api/tasks/${child.id}/complete`, {
        method: "POST",
        headers: { ...AUTH_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({
          summary: "child work complete",
          changedFiles: [],
          verification: [],
          residualRisk: "none",
        }),
      });
      expect(childCompleteRes.status).toBe(200);

      const childToDoneRes = await app.request(`/api/tasks/${child.id}/move`, {
        method: "POST",
        headers: { ...AUTH_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({ column: "done", position: 0 }),
      });
      expect(childToDoneRes.status).toBe(200);

      // --- 9. Archive the done child -> disappears from default list ---------
      const archiveRes = await app.request(`/api/tasks/${child.id}/archive`, { method: "POST", headers: AUTH_HEADERS });
      expect(archiveRes.status).toBe(200);
      const archivedChild = await archiveRes.json();
      expect(archivedChild.archived).toBe(true);

      const defaultListRes = await app.request("/api/tasks", { headers: AUTH_HEADERS });
      expect(defaultListRes.status).toBe(200);
      const defaultList = (await defaultListRes.json()) as Task[];
      expect(defaultList.map((t) => t.id)).not.toContain(child.id);

      // --- 10. ?archived=true surfaces it; unarchive restores it --------------
      const archivedListRes = await app.request("/api/tasks?archived=true", { headers: AUTH_HEADERS });
      expect(archivedListRes.status).toBe(200);
      const archivedList = (await archivedListRes.json()) as Task[];
      expect(archivedList.map((t) => t.id)).toContain(child.id);

      const unarchiveRes = await app.request(`/api/tasks/${child.id}/unarchive`, {
        method: "POST",
        headers: AUTH_HEADERS,
      });
      expect(unarchiveRes.status).toBe(200);
      const unarchivedChild = await unarchiveRes.json();
      expect(unarchivedChild.archived).toBe(false);

      const restoredListRes = await app.request("/api/tasks", { headers: AUTH_HEADERS });
      expect(restoredListRes.status).toBe(200);
      const restoredList = (await restoredListRes.json()) as Task[];
      expect(restoredList.map((t) => t.id)).toContain(child.id);
    },
    90_000,
  );
});
