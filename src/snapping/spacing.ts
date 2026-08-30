import * as THREE from "three";
import type { SceneNode, Vec3 } from "../document/types";
import type { KernelMesh } from "../kernel/types";
import type { Bounds3, SnapAnchor, SnapAxis } from "./snap";

const DEG = Math.PI / 180;

/** World-space bounds of a kernel mesh after applying its document transform. */
export function meshBounds(mesh: KernelMesh, node: SceneNode): Bounds3 {
  const vertices = mesh.faces.vertices;
  const rotation = new THREE.Euler(
    node.rotation[0] * DEG,
    node.rotation[1] * DEG,
    node.rotation[2] * DEG,
    "XYZ",
  );
  const point = new THREE.Vector3();
  const localMin = new THREE.Vector3(Infinity, Infinity, Infinity);
  const localMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < vertices.length; i += 3) {
    point.set(vertices[i], vertices[i + 1], vertices[i + 2]);
    localMin.min(point);
    localMax.max(point);
  }
  const localCentre = localMin.add(localMax).multiplyScalar(0.5);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];

  for (let i = 0; i < vertices.length; i += 3) {
    point.set(vertices[i], vertices[i + 1], vertices[i + 2]);
    point.sub(localCentre).multiply(new THREE.Vector3(...node.scale)).add(localCentre);
    point.applyEuler(rotation);
    point.x += node.position[0];
    point.y += node.position[1];
    point.z += node.position[2];
    min[0] = Math.min(min[0], point.x);
    min[1] = Math.min(min[1], point.y);
    min[2] = Math.min(min[2], point.z);
    max[0] = Math.max(max[0], point.x);
    max[1] = Math.max(max[1], point.y);
    max[2] = Math.max(max[2], point.z);
  }

  return { min, max };
}

/** Moves one chosen reference on the moving object an exact signed distance
 * from a chosen reference on the fixed object. */
export function positionWithReferenceGap(
  fixedNode: SceneNode,
  fixedMesh: KernelMesh,
  movingNode: SceneNode,
  movingMesh: KernelMesh,
  axis: SnapAxis,
  fixedAnchor: SnapAnchor,
  movingAnchor: SnapAnchor,
  gap: number,
  direction: -1 | 1,
): Vec3 {
  const fixed = meshBounds(fixedMesh, fixedNode);
  const moving = meshBounds(movingMesh, movingNode);
  const i = axis === "x" ? 0 : axis === "y" ? 1 : 2;
  const fixedReference = coordinate(fixed, i, fixedAnchor);
  const movingReference = coordinate(moving, i, movingAnchor);
  const delta = fixedReference + direction * gap - movingReference;
  const position = [...movingNode.position] as Vec3;
  position[i] += delta;
  return position;
}

function coordinate(bounds: Bounds3, axis: number, anchor: SnapAnchor): number {
  if (anchor === "min") return bounds.min[axis];
  if (anchor === "max") return bounds.max[axis];
  return (bounds.min[axis] + bounds.max[axis]) / 2;
}

/** How close two faces can sit and still count as "touching" for
 *  findTouchingSeam — generous enough to forgive a part placed a shade off
 *  flush, tight enough that two objects across the workplane from each
 *  other never qualify. */
const TOUCH_TOLERANCE = 2;

export interface TouchingSeam {
  /** Which world axis the two objects are butted together along. */
  axis: 0 | 1 | 2;
  /** World point at the centre of the shared wall — where a connector
   *  should be centred. */
  point: Vec3;
  /** Unit vector along `axis`, pointing from `nodeA` toward `nodeB`. A
   *  primitive's local +Z rotated onto this normal (the same convention
   *  face-placement already uses) sits flush on A and protrudes toward B. */
  normal: Vec3;
  /** Extent of the shared wall on the two axes other than `axis`, in
   *  (axis+1)%3, (axis+2)%3 order — how much room a connector has to sit
   *  in without overhanging either object's edge. */
  footprint: [number, number];
}

/**
 * Finds the shared wall between two objects that are butted directly against
 * each other along exactly one axis — the touching face a connector should
 * straddle. Tries all three axes and both arrangements (A on the low side or
 * the high side) and keeps whichever pair actually overlaps in footprint on
 * the other two axes with the smallest gap. Returns null if nothing is close
 * enough on any axis, or the two only meet at an edge/corner with no shared
 * wall area to put a joint on.
 */
export function findTouchingSeam(
  nodeA: SceneNode,
  meshA: KernelMesh,
  nodeB: SceneNode,
  meshB: KernelMesh,
): TouchingSeam | null {
  const a = meshBounds(meshA, nodeA);
  const b = meshBounds(meshB, nodeB);
  let best: TouchingSeam | null = null;
  let bestGap = TOUCH_TOLERANCE;

  for (let axis = 0; axis < 3; axis++) {
    const j = (axis + 1) % 3;
    const k = (axis + 2) % 3;
    const overlapJ0 = Math.max(a.min[j], b.min[j]);
    const overlapJ1 = Math.min(a.max[j], b.max[j]);
    const overlapK0 = Math.max(a.min[k], b.min[k]);
    const overlapK1 = Math.min(a.max[k], b.max[k]);
    // No shared footprint on this axis pair — touching at most at an edge.
    if (overlapJ1 <= overlapJ0 || overlapK1 <= overlapK0) continue;

    const consider = (gap: number, aIsLow: boolean) => {
      if (gap >= bestGap) return;
      const seamCoord = aIsLow ? (a.max[axis] + b.min[axis]) / 2 : (b.max[axis] + a.min[axis]) / 2;
      const point: Vec3 = [0, 0, 0];
      point[axis] = seamCoord;
      point[j] = (overlapJ0 + overlapJ1) / 2;
      point[k] = (overlapK0 + overlapK1) / 2;
      const normal: Vec3 = [0, 0, 0];
      normal[axis] = aIsLow ? 1 : -1;
      bestGap = gap;
      best = { axis: axis as 0 | 1 | 2, point, normal, footprint: [overlapJ1 - overlapJ0, overlapK1 - overlapK0] };
    };
    consider(Math.abs(b.min[axis] - a.max[axis]), true); // A on the low side, B on the high side
    consider(Math.abs(a.min[axis] - b.max[axis]), false); // B on the low side, A on the high side
  }
  return best;
}
