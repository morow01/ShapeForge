import { draw } from "replicad";
import type { Drawing, Shape3D } from "replicad";
import type { SvgCommand } from "../svg/parse";

/**
 * Millimetre outlines (see svg/parse.ts) → an extruded solid.
 *
 * Runs in the worker. Everything DOM-shaped happened on the other side; what
 * arrives here is plain numbers.
 */

/** Signed area of an outline, sampling curves at their endpoints only —
 *  enough to tell inside from outside and which way a loop winds. */
function signedArea(points: [number, number][]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

function outlinePoints(commands: SvgCommand[]): [number, number][] {
  const points: [number, number][] = [];
  for (const c of commands) {
    if (c[0] === "M" || c[0] === "L") points.push([c[1], c[2]]);
    else if (c[0] === "C") points.push([c[5], c[6]]);
  }
  return points;
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

/** One outline as a closed replicad drawing. */
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
  // close() adds the closing segment when the outline does not already end
  // where it started, which hand-written and exported SVG both do freely.
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
  return out.filter((sub) => outlinePoints(sub).length >= 3);
}

/**
 * Builds the 2D region the artwork describes, then extrudes it.
 *
 * Holes are resolved by containment rather than by winding rule: a counter
 * inside an O is a hole whatever direction it happens to wind, and exported
 * artwork is not consistent about that. Outlines are taken largest first, so
 * by the time a hole is considered, the shape it sits in has already been
 * added, and nesting deeper than one level alternates solid/hole the way
 * even-odd does.
 */
export function svgSolid(paths: SvgCommand[][], thickness: number): Shape3D | null {
  const outlines: { drawing: Drawing; points: [number, number][]; area: number }[] = [];
  for (const path of paths) {
    for (const sub of splitSubpaths(path)) {
      const drawing = toDrawing(sub);
      if (!drawing) continue;
      const points = outlinePoints(sub);
      outlines.push({ drawing, points, area: Math.abs(signedArea(points)) });
    }
  }
  if (!outlines.length) return null;

  outlines.sort((a, b) => b.area - a.area);

  let region: Drawing | null = null;
  for (const outline of outlines) {
    // How many bigger outlines enclose this one: even means solid, odd means
    // it is a hole in the one above it.
    const inner = outlines.filter(
      (other) =>
        other !== outline &&
        other.area > outline.area &&
        pointInPolygon(outline.points[0], other.points),
    ).length;
    if (!region) {
      region = outline.drawing;
      continue;
    }
    region = inner % 2 === 1 ? region.cut(outline.drawing) : region.fuse(outline.drawing);
  }
  if (!region) return null;

  return region.sketchOnPlane("XY").extrude(thickness) as Shape3D;
}
