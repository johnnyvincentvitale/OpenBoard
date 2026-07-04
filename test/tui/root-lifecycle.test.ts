import { describe, expect, it } from "vitest";
import { createRootLifecycle } from "../../src/tui/root-lifecycle";
import type { RootContainer, RootRenderable } from "../../src/tui/root-lifecycle";

const ROOT_ID = "openboard-root";

interface FakeNode extends RootRenderable {
  destroyed: number;
  detached: number;
}

interface FakeTree {
  id: string;
  failAttach?: boolean;
  detachThrows?: boolean;
  orphan?: boolean;
}

// Mimics OpenTUI's id-map semantics: add() registers the tree under its id,
// remove() detaches without freeing, and destroyRecursively() is the only
// call that releases native resources.
function createFakeContainer(): { container: RootContainer<FakeTree>; nodes: FakeNode[] } {
  const registry = new Map<string, FakeNode>();
  const nodes: FakeNode[] = [];

  const container: RootContainer<FakeTree> = {
    add(tree: FakeTree) {
      if (tree.failAttach) throw new Error("attach failed");
      const node: FakeNode = {
        id: tree.id,
        parent: null,
        destroyed: 0,
        detached: 0,
        destroyRecursively() {
          node.destroyed += 1;
        },
      };
      if (!tree.orphan) {
        node.parent = {
          remove(id: string) {
            if (tree.detachThrows) throw new Error("already detached");
            if (id === node.id) {
              node.detached += 1;
              node.parent = null;
            }
          },
        };
      }
      registry.set(tree.id, node);
      nodes.push(node);
      return;
    },
    remove(id: string) {
      const node = registry.get(id);
      if (node) {
        node.detached += 1;
        registry.delete(id);
      }
    },
    getRenderable(id: string) {
      return registry.get(id);
    },
  };

  return { container, nodes };
}

describe("TUI root lifecycle", () => {
  it("destroys the previous tree on every mount", () => {
    const { container, nodes } = createFakeContainer();
    const lifecycle = createRootLifecycle<FakeTree>(ROOT_ID, container);

    lifecycle.mountRoot({ id: ROOT_ID });
    lifecycle.mountRoot({ id: ROOT_ID });
    lifecycle.mountRoot({ id: ROOT_ID });

    expect(nodes).toHaveLength(3);
    expect(nodes[0]?.destroyed).toBe(1);
    expect(nodes[1]?.destroyed).toBe(1);
    expect(nodes[2]?.destroyed).toBe(0);
    expect(lifecycle.mounted).toBe(nodes[2]);
  });

  it("frees natively even when detach throws", () => {
    const { container, nodes } = createFakeContainer();
    const lifecycle = createRootLifecycle<FakeTree>(ROOT_ID, container);

    lifecycle.mountRoot({ id: ROOT_ID, detachThrows: true });
    lifecycle.mountRoot({ id: ROOT_ID });

    expect(nodes[0]?.destroyed).toBe(1);
  });

  it("detaches through the container when the node has no parent", () => {
    const { container, nodes } = createFakeContainer();
    const lifecycle = createRootLifecycle<FakeTree>(ROOT_ID, container);

    lifecycle.mountRoot({ id: ROOT_ID, orphan: true });
    lifecycle.destroyRoot();

    expect(nodes[0]?.detached).toBe(1);
    expect(nodes[0]?.destroyed).toBe(1);
    expect(lifecycle.mounted).toBeUndefined();
  });

  it("throws when the mounted tree does not register under the root id", () => {
    const { container } = createFakeContainer();
    const lifecycle = createRootLifecycle<FakeTree>(ROOT_ID, container);

    expect(() => lifecycle.mountRoot({ id: "some-other-id" })).toThrow(ROOT_ID);
    expect(lifecycle.mounted).toBeUndefined();
  });

  it("destroys a partially attached tree by id lookup after a failed mount", () => {
    const { container, nodes } = createFakeContainer();
    const lifecycle = createRootLifecycle<FakeTree>(ROOT_ID, container);

    expect(() => lifecycle.mountRoot({ id: ROOT_ID, failAttach: true })).toThrow("attach failed");
    expect(lifecycle.mounted).toBeUndefined();

    // Simulate the partial attach OpenTUI can leave behind, then recover.
    container.add({ id: ROOT_ID });
    lifecycle.destroyRoot();

    expect(nodes[0]?.destroyed).toBe(1);
  });

  it("destroyRoot is a no-op when nothing is mounted", () => {
    const { container } = createFakeContainer();
    const lifecycle = createRootLifecycle<FakeTree>(ROOT_ID, container);

    expect(() => lifecycle.destroyRoot()).not.toThrow();
    expect(lifecycle.mounted).toBeUndefined();
  });
});
