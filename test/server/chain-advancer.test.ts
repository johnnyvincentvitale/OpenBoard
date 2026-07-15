import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SqliteTaskStore } from "../../src/db/task-store";
import { createChainAdvancer } from "../../src/server/chain-advancer";
import { ArchivedTaskActionError, DependencyGateError, RunDispatchClaimError } from "../../src/server/dispatcher";
import type { CreateTaskInput } from "../../src/shared";

function parentInput(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return { title: "Parent", description: "", directory: "/repo", ...overrides };
}

describe("chain advancer", () => {
  let store: SqliteTaskStore;

  beforeEach(() => {
    store = new SqliteTaskStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  function readyChild(parentIds: string[], overrides: Partial<CreateTaskInput> = {}) {
    const child = store.create({
      title: "Child",
      description: "",
      directory: "/repo",
      isolation: "worktree",
      autoRun: true,
      ...overrides,
    });
    for (const parentId of parentIds) store.addLink(parentId, child.id);
    return child;
  }

  function fakeRunTask() {
    return vi.fn(async (taskId: string) => {
      store.update(taskId, { runState: "running", column: "in_progress" });
      return store.get(taskId)!;
    });
  }

  it("dispatches a ready child whose sole parent just satisfied", async () => {
    const parent = store.create(parentInput());
    store.move(parent.id, "done", 0);
    const child = readyChild([parent.id]);
    const runTask = fakeRunTask();
    const advancer = createChainAdvancer({ store, runTask });

    await advancer.advanceReadyChildren(parent.id);

    expect(runTask).toHaveBeenCalledWith(child.id);
    const events = store.listEvents(child.id);
    expect(events.some((e) => e.type === "task_auto_dispatched" && e.body.parentId === parent.id)).toBe(true);
  });

  it("dispatches a ready fenced in-place child (edit+bash deny)", async () => {
    const parent = store.create(parentInput());
    store.move(parent.id, "done", 0);
    const child = readyChild([parent.id], {
      isolation: "in-place",
      permissionOverrides: { edit: "deny", bash: "deny" },
    });
    const runTask = fakeRunTask();
    const advancer = createChainAdvancer({ store, runTask });

    await advancer.advanceReadyChildren(parent.id);

    expect(runTask).toHaveBeenCalledWith(child.id);
    const events = store.listEvents(child.id);
    expect(events.some((e) => e.type === "task_auto_dispatched" && e.body.parentId === parent.id)).toBe(true);
  });

  it("skips an unfenced in-place child (bash not denied) despite a stored autoRun flag", async () => {
    const parent = store.create(parentInput());
    store.move(parent.id, "done", 0);
    const child = readyChild([parent.id], {
      isolation: "in-place",
      permissionOverrides: { edit: "deny", bash: "ask" },
    });
    const runTask = fakeRunTask();
    const advancer = createChainAdvancer({ store, runTask });

    await advancer.advanceReadyChildren(parent.id);

    expect(runTask).not.toHaveBeenCalled();
    expect(store.get(child.id)?.column).toBe("todo");
  });

  it("skips a child with a second unmet parent", async () => {
    const parent1 = store.create(parentInput({ title: "P1" }));
    store.move(parent1.id, "done", 0);
    const parent2 = store.create(parentInput({ title: "P2" })); // stays in todo — unmet
    const child = readyChild([parent1.id, parent2.id]);
    const runTask = fakeRunTask();
    const advancer = createChainAdvancer({ store, runTask });

    await advancer.advanceReadyChildren(parent1.id);

    expect(runTask).not.toHaveBeenCalled();
    expect(store.get(child.id)?.column).toBe("todo");
  });

  it("does not fire when the parent reported blocked", async () => {
    const parent = store.create(parentInput());
    store.setCompletion(
      parent.id,
      { outcome: "blocked", summary: "s", changedFiles: [], verification: [], residualRisk: "r", reportedAt: 1 },
      "reported",
    );
    readyChild([parent.id]);
    const runTask = fakeRunTask();
    const advancer = createChainAdvancer({ store, runTask });

    await advancer.advanceReadyChildren(parent.id);

    expect(runTask).not.toHaveBeenCalled();
  });

  it("does not fire when the parent went idle without reporting (idle-fallback)", async () => {
    const parent = store.create(parentInput());
    store.update(parent.id, { runState: "idle", completion: null, completionSource: "idle-fallback" });
    readyChild([parent.id]);
    const runTask = fakeRunTask();
    const advancer = createChainAdvancer({ store, runTask });

    await advancer.advanceReadyChildren(parent.id);

    expect(runTask).not.toHaveBeenCalled();
  });

  it("skips archived, non-autoRun, in-place, manual, and already-running children", async () => {
    const parent = store.create(parentInput());
    store.move(parent.id, "done", 0);

    const archived = readyChild([parent.id], { title: "archived" });
    store.setArchived(archived.id, true);

    const notAutoRun = store.create({ title: "no-auto-run", description: "", directory: "/repo", isolation: "worktree" });
    store.addLink(parent.id, notAutoRun.id);

    // Store-level rows can carry a shape the route validation would never
    // allow (autoRun without worktree isolation) — that gap is exactly what
    // the advancer's own re-check must defend against.
    const inPlace = store.create({ title: "in-place", description: "", directory: "/repo", isolation: "in-place", autoRun: true });
    store.addLink(parent.id, inPlace.id);

    const manual = store.create({ type: "manual", title: "manual", description: "", directory: "/repo" });
    store.update(manual.id, { isolation: "worktree", autoRun: true });
    store.addLink(parent.id, manual.id);

    const alreadyRunning = readyChild([parent.id], { title: "already-running" });
    store.update(alreadyRunning.id, { runState: "running" });

    const runTask = fakeRunTask();
    const advancer = createChainAdvancer({ store, runTask });

    await advancer.advanceReadyChildren(parent.id);

    expect(runTask).not.toHaveBeenCalled();
  });

  it("records a task_warning and leaves the card in To-Do when runTask throws", async () => {
    const parent = store.create(parentInput());
    store.move(parent.id, "done", 0);
    const child = readyChild([parent.id]);
    const runTask = vi.fn(async () => {
      throw new Error("boom");
    });
    const advancer = createChainAdvancer({ store, runTask });

    await advancer.advanceReadyChildren(parent.id);

    const fresh = store.get(child.id)!;
    expect(fresh.column).toBe("todo");
    expect(fresh.runState).not.toBe("running");
    const events = store.listEvents(child.id);
    expect(events.some((e) => e.type === "task_warning" && String(e.body.warning).includes("boom"))).toBe(true);
  });

  it("skips silently on a dependency-gate guard error, no warning", async () => {
    const parent = store.create(parentInput());
    store.move(parent.id, "done", 0);
    const child = readyChild([parent.id]);
    const runTask = vi.fn(async () => {
      throw new DependencyGateError([{ id: parent.id, title: parent.title, why: "unmet" }]);
    });
    const advancer = createChainAdvancer({ store, runTask });

    await advancer.advanceReadyChildren(parent.id);

    const fresh = store.get(child.id)!;
    expect(fresh.runState).not.toBe("running");
    expect(fresh.column).toBe("todo");
    expect(store.listEvents(child.id).some((e) => e.type === "task_warning")).toBe(false);
  });

  it("skips silently on an archived-task guard error, no warning", async () => {
    const parent = store.create(parentInput());
    store.move(parent.id, "done", 0);
    const child = readyChild([parent.id]);
    const runTask = vi.fn(async () => {
      throw new ArchivedTaskActionError("run");
    });
    const advancer = createChainAdvancer({ store, runTask });

    await advancer.advanceReadyChildren(parent.id);

    expect(store.listEvents(child.id).some((e) => e.type === "task_warning")).toBe(false);
  });

  it("skips silently when a manual run already owns the dispatch window", async () => {
    const parent = store.create(parentInput());
    store.move(parent.id, "done", 0);
    const child = readyChild([parent.id]);
    const runTask = vi.fn(async () => {
      throw new RunDispatchClaimError(child.id);
    });
    const advancer = createChainAdvancer({ store, runTask });

    await advancer.advanceReadyChildren(parent.id);

    expect(store.get(child.id)?.runState).not.toBe("running");
    expect(store.listEvents(child.id).some((e) => e.type === "task_warning")).toBe(false);
  });

  it("does not roll back a manual winner that persists run ownership before the claim rejection is handled", async () => {
    const parent = store.create(parentInput());
    store.move(parent.id, "done", 0);
    const child = readyChild([parent.id]);
    const runTask = vi.fn(async () => {
      store.move(child.id, "in_progress", 0);
      store.update(child.id, {
        runState: "running",
        runStartedAt: 7000,
        sessionId: "ses_manual_winner",
      });
      throw new RunDispatchClaimError(child.id);
    });
    const advancer = createChainAdvancer({ store, runTask });

    await advancer.advanceReadyChildren(parent.id);

    expect(store.get(child.id)).toMatchObject({
      column: "in_progress",
      runState: "running",
      runStartedAt: 7000,
      sessionId: "ses_manual_winner",
    });
    expect(store.listEvents(child.id).some((e) => e.type === "task_warning")).toBe(false);
  });

  it("dispatches a child exactly once under a double-trigger race from two parents satisfied near-simultaneously", async () => {
    const parent1 = store.create(parentInput({ title: "P1" }));
    const parent2 = store.create(parentInput({ title: "P2" }));
    store.move(parent1.id, "done", 0);
    store.move(parent2.id, "done", 0);
    const child = readyChild([parent1.id, parent2.id]);

    let dispatchCount = 0;
    const runTask = vi.fn(async (taskId: string) => {
      dispatchCount += 1;
      store.update(taskId, { runState: "running", column: "in_progress" });
      return store.get(taskId)!;
    });
    const advancer = createChainAdvancer({ store, runTask });

    await Promise.all([
      advancer.advanceReadyChildren(parent1.id),
      advancer.advanceReadyChildren(parent2.id),
    ]);

    expect(dispatchCount).toBe(1);
    expect(store.listEvents(child.id).filter((e) => e.type === "task_warning")).toHaveLength(0);
    expect(store.listEvents(child.id).filter((e) => e.type === "task_auto_dispatched")).toHaveLength(1);
  });
});
