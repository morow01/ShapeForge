import type { BufferGeometry } from "three";

/** Batch consecutive faces with the same material without changing face IDs
 * used by picking. Callers restore the original groups after rendering. */
export function mergedRenderGroups(groups: BufferGeometry["groups"]): BufferGeometry["groups"] {
  const merged: BufferGeometry["groups"] = [];
  for (const group of groups) {
    const previous = merged[merged.length - 1];
    if (previous && previous.materialIndex === group.materialIndex && previous.start + previous.count === group.start) {
      previous.count += group.count;
    } else merged.push({ ...group });
  }
  return merged;
}
