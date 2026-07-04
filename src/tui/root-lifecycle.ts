/**
 * Root render-tree lifecycle for the OpenBoard TUI.
 *
 * OpenTUI's `remove(id)` only detaches a renderable — it never frees the native
 * yoga nodes or framebuffers underneath it. Replacing the root tree without
 * calling `destroyRecursively()` leaks natively on every render and eventually
 * hard-crashes the renderer (the 2026-07-02 black-screen bug). This module is
 * the single sanctioned way to swap the root tree: every mount destroys the
 * previous tree first, and every destroy frees natively even when detach fails.
 */

/** The members of an OpenTUI Renderable the lifecycle touches. */
export interface RootRenderable {
  id: string;
  parent?: { remove(id: string): void } | null;
  destroyRecursively(): void;
}

/** The members of the renderer's root container the lifecycle touches. */
export interface RootContainer<TTree> {
  add(tree: TTree): void;
  remove(id: string): void;
  getRenderable(id: string): RootRenderable | undefined;
}

export interface RootLifecycle<TTree> {
  /**
   * Detach and natively free a root tree. Defaults to the currently mounted
   * tree, falling back to whatever is registered under `rootId` — so a
   * partially attached tree from a failed mount still gets destroyed.
   */
  destroyRoot(root?: RootRenderable): void;
  /** Destroy the previous tree, attach `tree`, and track the mounted root. */
  mountRoot(tree: TTree): void;
  /** The root renderable currently believed mounted (undefined after destroy). */
  readonly mounted: RootRenderable | undefined;
}

export function createRootLifecycle<TTree>(
  rootId: string,
  container: RootContainer<TTree>,
): RootLifecycle<TTree> {
  let mounted: RootRenderable | undefined;

  const destroyRoot = (root: RootRenderable | undefined = mounted ?? container.getRenderable(rootId)): void => {
    if (!root) return;

    try {
      if (root.parent) {
        root.parent.remove(root.id);
      } else {
        container.remove(root.id);
      }
    } catch {
      // The node may already be detached. Destruction below still frees native resources.
    }

    root.destroyRecursively();
    if (mounted === root || root.id === rootId) mounted = undefined;
  };

  const mountRoot = (tree: TTree): void => {
    destroyRoot();
    container.add(tree);
    mounted = container.getRenderable(rootId);
    if (!mounted) throw new Error(`OpenTUI did not mount ${rootId}`);
  };

  return {
    destroyRoot,
    mountRoot,
    get mounted() {
      return mounted;
    },
  };
}
