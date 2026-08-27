import { draw, getManifold, MeshShape } from "replicad";
import type { Drawing, Shape3D } from "replicad";
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

function toDrawing(commands: SvgCommand[]): Drawing | null {
  const start = commands[0];
  if (!start || start[0] !== "M") return null;
  let pen = draw([start[1], start[2]]);
  let cursor: [number, number] = [start[1], start[2]];
  let drew = false;
  for (const c of commands.slice(1)) {
    if (c[0] === "M") break; // one outline per drawing; subpaths arrive separately
    if (c[0] === "L") {
      // A rounded rectangle whose radius is exactly half its height (a pill)
      // legitimately produces a zero-length V segment after SVG shorthand is
      // expanded. OCCT cannot construct that degenerate line and exposes it as
      // "This object has been deleted", so simply omit the no-op segment.
      if (Math.hypot(c[1] - cursor[0], c[2] - cursor[1]) < 1e-9) continue;
      pen = pen.lineTo([c[1], c[2]]);
      cursor = [c[1], c[2]];
      drew = true;
    } else if (c[0] === "C") {
      pen = pen.cubicBezierCurveTo([c[5], c[6]], [c[1], c[2]], [c[3], c[4]]);
      cursor = [c[5], c[6]];
      drew = true;
    }
  }
  if (!drew) return null;
  return pen.close();
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

interface Outline {
  drawing: Drawing;
  points: [number, number][];
  inside: [number, number];
  area: number;
}

/**
 * One extruded solid per shape in the artwork — a letter, a logo mark, an
 * island — each already carrying its own holes.
 *
 * Deliberately NOT one accumulated 2D region for the whole file. Fusing or
 * cutting every outline into a single running drawing made the shapes depend
 * on one another, so one misjudged counter could cut a hole out of a
 * neighbouring letter or remove it outright. Separate solids keep a mistake
 * local, and the caller unions them through the same boolean path the rest
 * of the app uses.
 *
 * Holes are decided by containment, not by winding rule: the counter in an O
 * is a hole whichever way it happens to wind, and exported artwork is not
 * consistent about that. Depth — how many outlines enclose a shape —
 * alternates solid, hole, solid, the way even-odd does.
 */
export function svgSolids(paths: SvgCommand[][], thickness: number): Shape3D[] {
  const outlines: Outline[] = [];
  for (const [pathIndex, path] of paths.entries()) {
    for (const [subIndex, sub] of splitSubpaths(path).entries()) {
      const points = flatten(sub);
      if (points.length < 3) continue;
      let drawing: Drawing | null;
      try {
        drawing = toDrawing(sub);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`SVG path ${pathIndex + 1}, outline ${subIndex + 1}: ${message}`);
      }
      if (!drawing) continue;
      outlines.push({ drawing, points, inside: interiorPoint(points), area: areaOf(points) });
    }
  }
  if (!outlines.length) return [];

  // Which outlines enclose each one. Only bigger outlines can, which keeps
  // this from depending on the arbitrary order shapes appear in the file.
  const containers = outlines.map((outline, i) =>
    outlines
      .map((other, j) => ({ other, j }))
      .filter(
        ({ other, j }) =>
          j !== i && other.area > outline.area && pointInPolygon(outline.inside, other.points),
      ),
  );

  const solids: Shape3D[] = [];
  outlines.forEach((outline, i) => {
    if (containers[i].length % 2 === 1) return; // a hole, not a shape

    try {
      // Extrude the outer contour first, then cut counters as complete 3D
      // tools. Illustrator compound paths can make OCCT's 2D Drawing.cut()
      // produce an uncapped face (the supplied capital A exposed it). A
      // slightly overlong 3D cutter crosses both caps unambiguously and keeps
      // the letter a closed solid.
      let solid = outline.drawing.sketchOnPlane("XY").extrude(thickness) as Shape3D;
      outlines.forEach((hole, j) => {
        if (j === i || containers[j].length !== containers[i].length + 1) return;
        // The hole's immediate container is the smallest thing enclosing it,
        // so a letter never claims a counter belonging to another letter.
        let immediate: { other: Outline; j: number } | null = null;
        for (const candidate of containers[j]) {
          if (!immediate || candidate.other.area < immediate.other.area) immediate = candidate;
        }
        if (!immediate || immediate.j !== i) return;
        // Cross both caps by a comfortable modelling tolerance. A 0.001 mm
        // overlap was technically non-coplanar but still close enough for
        // OCCT to lose the whole top cap on block-style counters such as D.
        const overlap = Math.max(0.05, thickness * 0.05);
        const cutter = (hole.drawing.sketchOnPlane("XY").extrude(thickness + overlap * 2) as Shape3D)
          .translateZ(-overlap);
        solid = solid.cut(cutter) as Shape3D;
      });
      solids.push(solid);
    } catch {
      // One unbuildable outline must not cost the rest of the artwork.
    }
  });

  return solids;
}

/**
 * Builds SVG artwork the same way a vector importer does: each source element
 * becomes one even-odd 2D region (so compound letter counters remain holes),
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
