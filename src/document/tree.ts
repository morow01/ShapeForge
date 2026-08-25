import { isGroup } from "./types";
import type { SceneNode } from "./types";

/** Depth-first walk over the whole forest. */
export function* walk(nodes: SceneNode[]): Generator<SceneNode> {
  for (const n of nodes) {
    yield n;
    if (isGroup(n)) yield* walk(n.children);
  }
}

export function findNode(nodes: SceneNode[], id: string): SceneNode | null {
  for (const n of walk(nodes)) if (n.id === id) return n;
  return null;
}

/** Replaces one node in place, rebuilding only the branches that contain it. */
export function updateNode(
  nodes: SceneNode[],
  id: string,
  fn: (n: SceneNode) => SceneNode,
): SceneNode[] {
  return nodes.map((n) => {
    if (n.id === id) return fn(n);
    if (isGroup(n)) {
      const children = updateNode(n.children, id, fn);
      return children === n.children ? n : { ...n, children };
    }
    return n;
  });
}

/** Removes the given ids wherever they appear, returning what was removed. */
export function extractNodes(
  nodes: SceneNode[],
  ids: Set<string>,
): { remaining: SceneNode[]; removed: SceneNode[] } {
  const removed: SceneNode[] = [];

  const prune = (list: SceneNode[]): SceneNode[] => {
    const out: SceneNode[] = [];
    for (const n of list) {
      if (ids.has(n.id)) {
        removed.push(n);
        continue;
      }
      if (isGroup(n)) {
        const children = prune(n.children);
        out.push(children === n.children ? n : { ...n, children });
      } else {
        out.push(n);
      }
    }
    return out;
  };

  return { remaining: prune(nodes), removed };
}

/** The parent list containing `id`, or the roots when it is top level. */
export function parentOf(nodes: SceneNode[], id: string): SceneNode | null {
  for (const n of walk(nodes)) {
    if (isGroup(n) && n.children.some((c) => c.id === id)) return n;
  }
  return null;
}

/** True when any of `ids` sits inside a group rather than at the top level. */
export function anyNested(nodes: SceneNode[], ids: Set<string>): boolean {
  for (const id of ids) if (parentOf(nodes, id)) return true;
  return false;
}

/** Index of the first of `ids` among the roots, for insertion ordering. */
export function firstRootIndex(nodes: SceneNode[], ids: Set<string>): number {
  const i = nodes.findIndex((n) => ids.has(n.id));
  return i === -1 ? nodes.length : i;
}
