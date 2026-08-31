import type { ObjectNode, Vec3 } from "./types";
import { solveScaledTriangle } from "../geometry/triangle";

/**
 * Rewrites a primitive's own parameters so a non-uniform scale becomes real
 * size, and returns it with scale [1, 1, 1].
 *
 * A node's scale is applied by place() at the very end, AFTER any edit ops
 * have run — so an op that is uniform in the node's own frame comes out
 * uneven on screen. Hollowing a box that had been resized to a rectangle
 * gave walls of 2mm, 5mm and 1.2mm from one "2mm" setting, which is
 * invisible in the viewport and ruins the print. Baking first means the op
 * runs at true size and every wall is the thickness that was asked for.
 *
 * Deliberately the same rewrite (and the same z re-normalisation) the kernel
 * does in bakeNonUniformScale — a primitive is built axis-aligned and
 * normalised with its base on z = 0, so "scale by s" and "build it s times
 * bigger" describe the same solid, as long as the conditions below hold.
 *
 * Returns null when the scale cannot be folded in exactly, which is the
 * caller's cue that the op will be uneven and the user should be told.
 */
export function bakeScale(node: ObjectNode): ObjectNode | null {
  const [sx, sy, sz] = node.scale;
  if (sx === 1 && sy === 1 && sz === 1) return node;
  if (!(sx > 0 && sy > 0 && sz > 0)) return null;
  // Rotation about X or Y turns the scale axes away from the parameter axes,
  // so width/depth/height no longer describe what the scale stretches.
  const [rx, ry] = node.rotation;
  if (rx !== 0 || ry !== 0) return null;

  const p = node.params;
  let params: Record<string, number>;
  let height: number;
  if (node.kind === "box") {
    // Round edges would turn elliptical; rebuilding at the new size would not
    // reproduce them.
    if ((p.fillet ?? 0) > 0 && !(sx === sy && sy === sz)) return null;
    height = p.height;
    params = {
      ...p,
      width: p.width * sx,
      depth: p.depth * sy,
      height: p.height * sz,
      fillet: (p.fillet ?? 0) * (sx === sy && sy === sz ? sx : 1),
    };
  } else if (node.kind === "cylinder" && sx === sy) {
    height = p.height;
    params = { ...p, radius: p.radius * sx, height: p.height * sz };
  } else if (node.kind === "sphere" && sx === sy && sy === sz) {
    height = p.radius * 2;
    params = { ...p, radius: p.radius * sx };
  } else if (node.kind === "cone" && sx === sy) {
    height = p.height;
    params = {
      ...p,
      bottomRadius: p.bottomRadius * sx,
      topRadius: p.topRadius * sx,
      height: p.height * sz,
    };
  } else if (node.kind === "triangle") {
    height = p.thickness;
    try {
      const solved = solveScaledTriangle(p, [sx, sy, 1]);
      params = {
        ...p,
        base: Math.round(solved.sides.base * 100) / 100,
        sideLeft: Math.round(solved.sides.left * 100) / 100,
        sideRight: Math.round(solved.sides.right * 100) / 100,
        angleLeft: Math.round(solved.angles.left * 100) / 100,
        angleRight: Math.round(solved.angles.right * 100) / 100,
        angleApex: Math.round(solved.angles.apex * 100) / 100,
        thickness: p.thickness * sz,
      };
    } catch {
      return null;
    }
  } else if (node.kind === "torus" && sx === sy && sy === sz) {
    height = p.tubeRadius * 2;
    params = { ...p, radius: p.radius * sx, tubeRadius: p.tubeRadius * sx };
  } else if (node.kind === "pyramid" && sx === sy) {
    height = p.height;
    params = {
      ...p,
      radius: p.radius * sx,
      height: p.height * sz,
    };
  } else if (node.kind === "wedge") {
    height = p.height;
    params = {
      ...p,
      width: p.width * sx,
      length: p.length * sy,
      height: p.height * sz,
    };
  } else if (node.kind === "polygonPrism" && sx === sy) {
    height = p.height;
    params = {
      ...p,
      radius: p.radius * sx,
      height: p.height * sz,
    };
  } else if (node.kind === "hemisphere" && sx === sy && sy === sz) {
    height = p.radius;
    params = {
      ...p,
      radius: p.radius * sx,
    };
  } else if (node.kind === "capsule" && sx === sy && sy === sz) {
    height = p.height;
    params = {
      ...p,
      radius: p.radius * sx,
      height: p.height * sz,
    };
  } else if (node.kind === "tube" && sx === sy) {
    height = p.height;
    params = {
      ...p,
      radius: p.radius * sx,
      wallThickness: p.wallThickness * sx,
      height: p.height * sz,
    };
  } else if (node.kind === "paraboloid" && sx === sy) {
    height = p.height;
    params = {
      ...p,
      radius: p.radius * sx,
      height: p.height * sz,
    };
  } else if (node.kind === "text" && sx === sy) {
    height = p.thickness;
    params = {
      ...p,
      size: p.size * sx,
      thickness: p.thickness * sz,
    };
  } else {
    return null;
  }

  const [px, py, pz] = node.position;
  const position: Vec3 = [px, py, pz + (height * (1 - sz)) / 2];
  return { ...node, params, scale: [1, 1, 1], position };
}
