import { getManifold, MeshShape } from "replicad";
import type { SvgCommand } from "../svg/parse";

/**
 * Millimetre outlines (see svg/parse.ts) → extruded solids, one per shape.
 *
 * Runs in the worker. Everything DOM-shaped happened on the other side; what
 * arrives here is plain numbers.
 */

/**
 * Points sampled along each cubic, not just at its endpoints.
 *
 * Letters are nearly all curve: the outer boundary of an "e" is perhaps
 * eight segments, so endpoints alone approximate it as an octagon. Deciding
 * "is this counter inside that letter" against an octagon gets the answer
 * wrong often enough to matter — and a wrong answer there cuts a letter away
 * instead of adding it, which is what made whole letters disappear.
 */
const CURVE_SAMPLES = 24;

/** Bump when SVG-to-solid semantics change so live worker mesh caches rebuild. */
export const SVG_IMPORT_REVISION = 3;

function cubicAt(
  t: number,
  p0: [number, number],
  c1: [number, number],
  c2: [number, number],
  p1: [number, number],
): [number, number] {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [
    a * p0[0] + b * c1[0] + c * c2[0] + d * p1[0],
    a * p0[1] + b * c1[1] + c * c2[1] + d * p1[1],
  ];
}

/** A polygon that follows the outline closely enough to test against. */
function flatten(commands: SvgCommand[]): [number, number][] {
  const points: [number, number][] = [];
  let cursor: [number, number] = [0, 0];
  for (const c of commands) {
    if (c[0] === "M" || c[0] === "L") {
      cursor = [c[1], c[2]];
      points.push(cursor);
    } else if (c[0] === "C") {
      const p0 = cursor;
      const c1: [number, number] = [c[1], c[2]];
      const c2: [number, number] = [c[3], c[4]];
      const p1: [number, number] = [c[5], c[6]];
      for (let i = 1; i <= CURVE_SAMPLES; i++) {
        points.push(cubicAt(i / CURVE_SAMPLES, p0, c1, c2, p1));
      }
      cursor = p1;
    }
  }
  return points;
}

function signedAreaOf(points: [number, number][]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

function areaOf(points: [number, number][]): number {
  return Math.abs(signedAreaOf(points));
}

function pointInPolygon(point: [number, number], polygon: [number, number][]): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** A point genuinely inside the outline rather than on its edge. The centroid
 *  serves for letters; a shape it falls outside of (a crescent) keeps its
 *  first vertex instead. */
function interiorPoint(points: [number, number][]): [number, number] {
  const mid: [number, number] = [
    points.reduce((a, p) => a + p[0], 0) / points.length,
    points.reduce((a, p) => a + p[1], 0) / points.length,
  ];
  return pointInPolygon(mid, points) ? mid : points[0];
}

/** Splits a path's subpaths (each M starts one) into separate outlines. */
function splitSubpaths(commands: SvgCommand[]): SvgCommand[][] {
  const out: SvgCommand[][] = [];
  let current: SvgCommand[] = [];
  for (const c of commands) {
    if (c[0] === "M" && current.length) {
      out.push(current);
      current = [];
    }
    current.push(c);
  }
  if (current.length) out.push(current);
  return out;
}

/**
 * Builds SVG artwork the same way a vector importer does: each source element
 * becomes one 2D region whose contours are wound so that counters read as
 * holes (outer anticlockwise, nested clockwise, resolved NonZero),
 * the elements are unioned, and only then is the result extruded. This avoids
 * fragile per-counter OCCT face cuts that can lose a cap on glyphs such as D.
 */
export function svgMeshSolid(paths: SvgCommand[][], thickness: number): MeshShape | null {
  const manifold = getManifold();
  const solids: InstanceType<typeof manifold.Manifold>[] = [];

  for (const path of paths) {
    const polygons = splitSubpaths(path)
      .map(flatten)
      .filter((points) => points.length >= 3);
    if (!polygons.length) continue;

    try {
      // Illustrator mixes clockwise and counter-clockwise basic shapes, and
      // parseSvg's Y-axis flip reverses both. Manifold uses winding to decide
      // whether an extrusion is positive or negative, so normalize every
      // outer contour counter-clockwise and every nested counter clockwise.
      const oriented = polygons.map((points, i) => {
        const inside = interiorPoint(points);
        const depth = polygons.reduce(
          (count, other, j) =>
            count + (j !== i && areaOf(other) > areaOf(points) && pointInPolygon(inside, other) ? 1 : 0),
          0,
        );
        const shouldBePositive = depth % 2 === 0;
        const isPositive = signedAreaOf(points) > 0;
        return shouldBePositive === isPositive ? points : points.slice().reverse();
      });
      const region = new manifold.CrossSection(oriented, "NonZero");
      solids.push(region.extrude(thickness));
    } catch {
      // One malformed SVG element must not discard the rest of the artwork.
    }
  }

  if (!solids.length) return null;
  return new MeshShape(manifold.Manifold.union(solids));
}
