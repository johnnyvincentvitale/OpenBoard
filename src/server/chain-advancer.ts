/**
 * The chain advancer — after a parent task becomes satisfied, auto-dispatches
 * any `autoRun` children whose full parent set is now satisfied. Only ever
 * looks one generation down: each dispatched child's own completion triggers
 * its own advance at the next parent-satisfaction site, so there is no
 * recursion here.
 *
 * Dependency-injected ({ store, runTask }) rather than importing the
 * dispatcher directly, so this module stays a one-way dependency on
 * dispatcher.ts (for `unmetReason` and its guard error classes) without ever
 * being imported back by it — see dispatcher.ts's TaskDispatcherDeps doc
 * comment for how the two are wired together at integration time.
 */
import type { Task, TaskStore } from "../shared";
import { ArchivedTaskActionError, DependencyGateError, unmetReason } from "./dispatcher";

export interface ChainAdvancerDeps {
  store: TaskStore;
  /** Dispatches a task by id — bound to dispatcher.run() at wiring time. */
  runTask: (taskId: string) => Promise<Task>;
}

export interface ChainAdvancer {
  /** Check `parentId`'s children and dispatch any that are now ready. */
  advanceReadyChildren(parentId: string): Promise<void>;
}

function chainErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A 409 raised by the dispatcher's own guards (unmet dependency, archived
 * task) means a concurrent trigger already claimed or blocked this child —
 * the dispatcher is the final arbiter, so this is not a failure worth
 * warning about.
 */
function isDispatcherGuardError(err: unknown): boolean {
  return err instanceof DependencyGateError || err instanceof ArchivedTaskActionError;
}

/**
 * Re-derives whether a stored task is actually eligible for auto-dispatch.
 * Deliberately re-checks every condition against the freshly-fetched row
 * instead of trusting the stored `autoRun` flag alone — the same
 * defense-in-depth convention as resolveOpenCodePermissionRules never
 * reading permissionOverrides for worktree runs (src/shared/task.ts).
 */
function isAutoRunEligible(task: Task | undefined): task is Task {
  return (
    !!task &&
    task.autoRun === true &&
    task.column === "todo" &&
    !task.archived &&
    task.runState !== "running" &&
    (task.type ?? "agent") === "agent" &&
    task.isolation === "worktree"
  );
}

function allParentsSatisfied(store: TaskStore, child: Task): boolean {
  const parentIds = child.parentIds ?? store.getParentIds(child.id);
  return parentIds.every((parentId) => {
    const parent = store.get(parentId);
    return !!parent && unmetReason(parent) === null;
  });
}

export function createChainAdvancer(deps: ChainAdvancerDeps): ChainAdvancer {
  const { store, runTask } = deps;

  return {
    async advanceReadyChildren(parentId: string): Promise<void> {
      const childIds = store.getChildIds(parentId);

      for (const childId of childIds) {
        const child = store.get(childId);
        if (!isAutoRunEligible(child)) continue;
        if (!allParentsSatisfied(store, child)) continue;

        // Synchronous claim before the first await: a second advance
        // triggered near-simultaneously (e.g. two parents satisfied close
        // together) re-fetches this child and sees runState "running" here,
        // so it skips instead of double-dispatching. The dispatcher's own
        // run() reconciles/overwrites this state as part of its normal
        // dispatch; on failure below we revert it.
        const preClaimRunState = child.runState;
        const claimed = store.update(childId, { runState: "running" });
        if (!claimed) continue;

        try {
          await runTask(childId);
          store.addEvent({ taskId: childId, type: "task_auto_dispatched", body: { parentId } });
        } catch (err) {
          store.update(childId, { runState: preClaimRunState });
          if (isDispatcherGuardError(err)) continue;
          store.addEvent({
            taskId: childId,
            type: "task_warning",
            body: { warning: `Auto-dispatch failed: ${chainErrorMessage(err)}` },
          });
        }
      }
    },
  };
}

/**
 * Fire an advance for `parentId` without blocking the caller. Any advancer
 * failure (beyond the per-child handling inside advanceReadyChildren) is
 * recorded as a task_warning on the parent rather than becoming an
 * unhandled rejection. Returns the promise so callers can `void` it at the
 * call site while tests still have a handle to await.
 */
export function fireChainAdvance(advancer: ChainAdvancer | undefined, store: TaskStore, parentId: string): Promise<void> {
  if (!advancer) return Promise.resolve();
  return advancer.advanceReadyChildren(parentId).catch((err) => {
    store.addEvent({
      taskId: parentId,
      type: "task_warning",
      body: { warning: `Auto-dispatch chain check failed: ${chainErrorMessage(err)}` },
    });
  });
}
