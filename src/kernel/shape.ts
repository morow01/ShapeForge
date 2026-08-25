import { makeBaseBox, makeCylinder, makeSphere, draw, measureVolume } from "replicad";
import type { Shape3D } from "replicad";
import { InvalidShapeError, solveTriangle } from "../geometry/triangle";
import type { Vec3 } from "../document/types";
import type { NodeSpec, ObjectSpec } from "./types";

export { InvalidShapeError };

/**
 * Builds a primitive in LOCAL space: centred in XY with its base on z = 0,
 * with no position or rotation applied. Placement lives on the Three.js side
 * so dragging an object never needs a kernel rebuild.
 */
export function makePrimitive(spec: ObjectSpec): Shape3D {
  const p = spec.params;
  let s: Shape3D;

  switch (spec.kind) {
    case "box": {
      s = makeBaseBox(p.width, p.depth, p.height);
      // Clamp so the fillet can never exceed half the smallest side, which
      // would make OCCT throw instead of returning a shape.
      const maxR = Math.min(p.width, p.depth) / 2 - 0.01;
      const r = Math.min(p.fillet ?? 0, maxR);
      if (r > 0) s = s.fillet(r, (e) => e.inDirection("Z"));
      break;
    }
    case "cylinder":
      s = makeCylinder(p.radius, p.height);
      break;
    case "sphere":
      s = makeSphere(p.radius);
      break;
    case "cone": {
      const rb = Math.max(p.bottomRadius, 0);
      const rt = Math.max(p.topRadius, 0);
      // Revolve a profile in the XZ plane about Z. A zero top radius closes to
      // a true point rather than a degenerate zero-width face.
      let pen = draw([0, 0]).lineTo([Math.max(rb, 0.001), 0]);
      pen = rt > 0 ? pen.lineTo([rt, p.height]).lineTo([0, p.height]) : pen.lineTo([0, p.height]);
      s = pen.close().sketchOnPlane("XZ").revolve([0, 0, 1]) as Shape3D;
      break;
    }
    case "triangle": {
      if (p.thickness <= 0) throw new InvalidShapeError("Thickness must be greater than zero.");
      const { apexPoint } = solveTriangle(p);
      s = draw([0, 0])
        .lineTo([p.base, 0])
        .lineTo([apexPoint.x, apexPoint.y])
        .close()
        .sketchOnPlane("XY")
        .extrude(p.thickness) as Shape3D;
      break;
    }
  }

  // Normalise to one origin convention regardless of how each constructor
  // happens to place its shape.
  const [min, max] = s.boundingBox.bounds;
  return s.translate([-(min[0] + max[0]) / 2, -(min[1] + max[1]) / 2, -min[2]]) as Shape3D;
}

/**
 * Combines already-placed children. Children keep their own world transforms,
 * so a group introduces no frame of its own beyond its node transform.
 */
export function combine(
  op: GroupOp,
  children: { solid: Shape3D; isHole: boolean }[],
): Shape3D | null {
  if (!children.length) return null;

  if (op === "subtract") {
    // First child minus the rest, regardless of hole flags — the flag is what
    // "union" uses, this op is the explicit version.
    let result = children[0].solid;
    for (let i = 1; i < children.length; i++) {
      result = result.cut(children[i].solid) as Shape3D;
    }
    return result;
  }

  if (op === "intersect") {
    let result = children[0].solid;
    for (let i = 1; i < children.length; i++) {
      result = result.intersect(children[i].solid) as Shape3D;
    }
    return result;
  }

  // union: fuse the solids, then cut away anything flagged as a hole.
  const solids = children.filter((c) => !c.isHole);
  const holes = children.filter((c) => c.isHole);
  if (!solids.length) return null;

  let result = solids[0].solid;
  for (let i = 1; i < solids.length; i++) {
    result = result.fuse(solids[i].solid) as Shape3D;
  }
  for (const h of holes) {
    result = result.cut(h.solid) as Shape3D;
  }
  return result;
}

type GroupOp = "union" | "subtract" | "intersect";

/** Applies rotation (about the node origin) then translation. */
export function place(s: Shape3D, spec: NodeSpec): Shape3D {
  const [rx, ry, rz] = spec.rotation;
  let out = s;
  if (rx) out = out.rotate(rx, [0, 0, 0], [1, 0, 0]) as Shape3D;
  if (ry) out = out.rotate(ry, [0, 0, 0], [0, 1, 0]) as Shape3D;
  if (rz) out = out.rotate(rz, [0, 0, 0], [0, 0, 1]) as Shape3D;
  return out.translate(spec.position) as Shape3D;
}

/**
 * A node in its own frame, before its transform is applied.
 * Leaves are normalised primitives; groups are their evaluated children.
 * Returns null when a group has nothing solid to show.
 */
/**
 * Cheap sanity checks that catch a silently-failed boolean:
 *  - a union can never be smaller than its largest operand;
 *  - a subtraction that removes *everything* is usually a failure, though it
 *    can legitimately happen when the first child is fully enclosed.
 */
function suspicious(
  op: GroupOp,
  result: Shape3D,
  kids: { solid: Shape3D; isHole: boolean }[],
): boolean {
  try {
    const volume = measureVolume(result);
    if (op === "union") {
      // A union that also cuts holes is legitimately smaller than its largest
      // part, so there is nothing to bound it by — checking would cry wolf on
      // a perfectly good model.
      if (kids.some((k) => k.isHole)) return false;
      const largest = Math.max(...kids.map((k) => measureVolume(k.solid)));
      return volume < largest - 1e-6;
    }
    if (op === "subtract") return volume <= 1e-9;
    return false;
  } catch {
    return true;
  }
}

/** Spins a sphere about its own axis: geometrically identical, but it moves
 *  the seam meridian, which is what OCCT actually trips over. */
function respin(spec: NodeSpec): NodeSpec {
  if (spec.type !== "object" || spec.kind !== "sphere") return spec;
  const [rx, ry, rz] = spec.rotation;
  return { ...spec, rotation: [rx, ry, rz + 90] as Vec3 };
}

export function makeLocal(
  spec: NodeSpec,
  onError?: (id: string, msg: string) => void,
): Shape3D | null {
  if (spec.type === "object") return makePrimitive(spec);

  const build = (spin: boolean, report?: (id: string, msg: string) => void) => {
    const kids: { solid: Shape3D; isHole: boolean }[] = [];
    for (const child of spec.children) {
      try {
        const solid = makeWorld(spin ? respin(child) : child, report);
        if (solid) kids.push({ solid, isHole: child.isHole });
      } catch (e) {
        report?.(child.id, e instanceof Error ? e.message : String(e));
      }
    }
    return kids;
  };

  const kids = build(false, onError);
  const result = combine(spec.op, kids);
  if (!result || !suspicious(spec.op, result, kids)) return result;

  // Known OCCT weakness: a sphere's seam meridian crossing the other shape's
  // boundary makes the boolean return an invalid solid. Spinning the seam away
  // is a no-op geometrically and fixes it — so it is only worth retrying when
  // there is actually a sphere involved.
  const hasSphere = spec.children.some((c) => c.type === "object" && c.kind === "sphere");
  if (hasSphere) {
    const retryKids = build(true);
    const retry = combine(spec.op, retryKids);
    if (retry && !suspicious(spec.op, retry, retryKids)) return retry;
  }

  // A union that is smaller than one of its own parts is provably broken; an
  // empty subtraction may simply mean the part was fully enclosed.
  if (spec.op === "union") {
    onError?.(spec.id, "This union produced an invalid solid — try moving or rotating a part.");
  }
  return result;
}

/** A node placed into its parent's frame. */
export function makeWorld(
  spec: NodeSpec,
  onError?: (id: string, msg: string) => void,
): Shape3D | null {
  const local = makeLocal(spec, onError);
  return local ? place(local, spec) : null;
}
