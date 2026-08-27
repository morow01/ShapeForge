import { draw } from "replicad";
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
const CURVE_SAMPLES = 8;

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

function areaOf(points: [number, number][]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area / 2);
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
  let drew = false;
  for (const c of commands.slice(1)) {
    if (c[0] === "M") break; // one outline per drawing; subpaths arrive separately
    if (c[0] === "L") {
      pen = pen.lineTo([c[1], c[2]]);
      drew = true;
    } else if (c[0] === "C") {
      pen = pen.cubicBezierCurveTo([c[5], c[6]], [c[1], c[2]], [c[3], c[4]]);
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
  for (const path of paths) {
    for (const sub of splitSubpaths(path)) {
      const points = flatten(sub);
      if (points.length < 3) continue;
      const drawing = toDrawing(sub);
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

    let region = outline.drawing;
    outlines.forEach((hole, j) => {
      if (j === i || containers[j].length !== containers[i].length + 1) return;
      // The hole's immediate container is the smallest thing enclosing it, so
      // a letter never claims a counter belonging to a letter nested inside
      // its own bounding box.
      let immediate: { other: Outline; j: number } | null = null;
      for (const candidate of containers[j]) {
        if (!immediate || candidate.other.area < immediate.other.area) immediate = candidate;
      }
      if (immediate && immediate.j === i) region = region.cut(hole.drawing);
    });

    try {
      solids.push(region.sketchOnPlane("XY").extrude(thickness) as Shape3D);
    } catch {
      // One unbuildable outline must not cost the rest of the artwork.
    }
  });

  return solids;
}
