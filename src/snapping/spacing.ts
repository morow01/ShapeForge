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
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];

  for (let i = 0; i < vertices.length; i += 3) {
    point.set(vertices[i], vertices[i + 1], vertices[i + 2]);
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
