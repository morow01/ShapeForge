import type { AnchorMode, SketchAnchor, SketchData, SketchPath } from "../document/types";
import type { SvgCommand } from "../svg/parse";

/**
 * Bézier path maths for sketches, free of DOM and React so the editor, the
 * document loader and the tests share one definition of what a path is.
 */

export type Pt = [number, number];

/** A segment's four control points: start, start handle, end handle, end. */
export type Cubic = [Pt, Pt, Pt, Pt];

export const anchor = (x: number, y: number): SketchAnchor =>
  ({ x, y, inX: 0, inY: 0, outX: 0, outY: 0, mode: "corner" });

/**
 * After one handle of an anchor has moved, brings the other into line with
 * the anchor's type: a smooth anchor turns it opposite, keeping its length; a
 * symmetric one mirrors it exactly; a corner leaves it alone.
 */
export function linkHandles(a: SketchAnchor, moved: "in" | "out"): SketchAnchor {
  if (a.mode === "corner") return a;
  const hx = moved === "out" ? a.outX : a.inX, hy = moved === "out" ? a.outY : a.inY;
  const len = Math.hypot(hx, hy);
  if (len < 1e-9) return a;
  const otherLen = moved === "out" ? Math.hypot(a.inX, a.inY) : Math.hypot(a.outX, a.outY);
  const keep = a.mode === "symmetric" || otherLen < 1e-9 ? len : otherLen;
  const ox = (-hx / len) * keep, oy = (-hy / len) * keep;
  return moved === "out" ? { ...a, inX: ox, inY: oy } : { ...a, outX: ox, outY: oy };
}

/**
 * Changes an anchor's type. Corner keeps the handles exactly where they are,
 * so the shape does not change — the handles just stop moving together.
 * Smooth and symmetric line existing handles up (symmetric also evens their
 * lengths); an anchor without handles gets them along the line between its
 * neighbours, a third of the way to each.
 */
export function convertAnchor(path: SketchPath, index: number, mode: AnchorMode): SketchAnchor {
  const a = path.anchors[index];
  if (mode === "corner") return { ...a, mode };
  let inX = a.inX, inY = a.inY, outX = a.outX, outY = a.outY;
  if (!hasHandle(inX, inY) && !hasHandle(outX, outY)) {
    const n = path.anchors.length;
    const prev = index > 0 ? path.anchors[index - 1] : path.closed ? path.anchors[n - 1] : null;
    const next = index < n - 1 ? path.anchors[index + 1] : path.closed ? path.anchors[0] : null;
    const from = prev ?? a, to = next ?? a;
    const dx = to.x - from.x, dy = to.y - from.y, len = Math.hypot(dx, dy);
    const ux = len > 1e-9 ? dx / len : 1, uy = len > 1e-9 ? dy / len : 0;
    const back = prev ? Math.hypot(a.x - prev.x, a.y - prev.y) / 3 : next ? Math.hypot(next.x - a.x, next.y - a.y) / 3 : 5;
    const ahead = next ? Math.hypot(next.x - a.x, next.y - a.y) / 3 : back;
    inX = -ux * back; inY = -uy * back; outX = ux * ahead; outY = uy * ahead;
  } else {
    let dx = outX - inX, dy = outY - inY;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    let inLen = Math.hypot(inX, inY), outLen = Math.hypot(outX, outY);
    // A handle that was retracted comes back as long as the other one.
    if (inLen < 1e-9) inLen = outLen;
    if (outLen < 1e-9) outLen = inLen;
    inX = -dx * inLen; inY = -dy * inLen; outX = dx * outLen; outY = dy * outLen;
  }
  if (mode === "symmetric") {
    const len = (Math.hypot(inX, inY) + Math.hypot(outX, outY)) / 2;
    const ol = Math.hypot(outX, outY) || 1;
    outX = (outX / ol) * len; outY = (outY / ol) * len;
    inX = -outX; inY = -outY;
  }
  return { ...a, inX, inY, outX, outY, mode };
}

export const hasHandle = (dx: number, dy: number) => Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9;

/** Segments of a path in order; a closed path adds the one back to its start. */
export function segmentCount(path: SketchPath): number {
  const n = path.anchors.length;
  if (n < 2) return 0;
  return path.closed ? n : n - 1;
}

export function segmentCubic(path: SketchPath, index: number): Cubic {
  const a = path.anchors[index];
  const b = path.anchors[(index + 1) % path.anchors.length];
  return [[a.x, a.y], [a.x + a.outX, a.y + a.outY], [b.x + b.inX, b.y + b.inY], [b.x, b.y]];
}

export function isStraight(path: SketchPath, index: number): boolean {
  const a = path.anchors[index];
  const b = path.anchors[(index + 1) % path.anchors.length];
  return !hasHandle(a.outX, a.outY) && !hasHandle(b.inX, b.inY);
}

export function cubicPoint([p0, c1, c2, p1]: Cubic, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * p0[0] + b * c1[0] + c * c2[0] + d * p1[0], a * p0[1] + b * c1[1] + c * c2[1] + d * p1[1]];
}

const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** de Casteljau: the two halves of a cubic cut at t, which trace it exactly. */
export function splitCubic([p0, c1, c2, p1]: Cubic, t: number): [Cubic, Cubic] {
  const a = lerp(p0, c1, t), b = lerp(c1, c2, t), c = lerp(c2, p1, t);
  const d = lerp(a, b, t), e = lerp(b, c, t);
  const m = lerp(d, e, t);
  return [[p0, a, d, m], [m, e, c, p1]];
}

/** Closest point on a cubic: coarse sampling, then a local refinement. */
export function nearestOnCubic(cubic: Cubic, p: Pt): { t: number; point: Pt; distance: number } {
  const dist2 = (q: Pt) => (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
  const SAMPLES = 48;
  let bestT = 0, best = Infinity;
  for (let i = 0; i <= SAMPLES; i++) {
    const d = dist2(cubicPoint(cubic, i / SAMPLES));
    if (d < best) { best = d; bestT = i / SAMPLES; }
  }
  let step = 1 / SAMPLES;
  for (let round = 0; round < 12; round++) {
    step /= 2;
    for (const t of [bestT - step, bestT + step]) {
      if (t < 0 || t > 1) continue;
      const d = dist2(cubicPoint(cubic, t));
      if (d < best) { best = d; bestT = t; }
    }
  }
  return { t: bestT, point: cubicPoint(cubic, bestT), distance: Math.sqrt(best) };
}

/**
 * Inserts an anchor on segment `index` at `t` without changing the path's
 * shape — hovering a curve with the Pen tool. Neighbouring handles are shortened to
 * the halves of the split curve, and the new anchor is smooth — its handles
 * are in line but, cut anywhere but the middle, not equally long.
 */
export function insertAnchor(path: SketchPath, index: number, t: number): SketchPath {
  const anchors = path.anchors.map((a) => ({ ...a }));
  const nextIndex = (index + 1) % anchors.length;
  const a = anchors[index], b = anchors[nextIndex];
  if (isStraight(path, index)) {
    // t is the curve's own parameter (as nearestOnCubic returns it), and a
    // straight segment's handles sit on its ends, so t does not run evenly
    // along the line: the point is where the curve is at t, not a lerp by t,
    // which put new anchors away from the click.
    const [x, y] = cubicPoint(segmentCubic(path, index), t);
    anchors.splice(index + 1, 0, anchor(x, y));
    return { ...path, anchors };
  }
  const [left, right] = splitCubic(segmentCubic(path, index), t);
  a.outX = left[1][0] - a.x; a.outY = left[1][1] - a.y;
  b.inX = right[2][0] - b.x; b.inY = right[2][1] - b.y;
  // Shortening one handle leaves a symmetric neighbour's handles unequal:
  // it is still smooth, no longer symmetric.
  if (a.mode === "symmetric") a.mode = "smooth";
  if (b.mode === "symmetric") b.mode = "smooth";
  const m = left[3];
  const inserted: SketchAnchor = {
    x: m[0], y: m[1],
    inX: left[2][0] - m[0], inY: left[2][1] - m[1],
    outX: right[1][0] - m[0], outY: right[1][1] - m[1],
    mode: "smooth",
  };
  anchors.splice(index + 1, 0, inserted);
  return { ...path, anchors };
}

/**
 * Cuts a path at anchors — Illustrator's Scissors. Each cut anchor becomes two
 * ends lying on top of each other, one finishing the piece before it and one
 * starting the piece after, so they can be dragged apart. The shape is not
 * changed: each end keeps the handle on its own side. A closed path cut once
 * opens there; an open path cut inside splits in two. Cutting an open path's
 * end does nothing. The first piece keeps the path's id.
 */
export function breakPath(path: SketchPath, indices: number[], newId: () => string): SketchPath[] {
  const n = path.anchors.length;
  const cuts = [...new Set(indices)].filter((i) => i >= 0 && i < n).sort((a, b) => a - b);
  let sequence: SketchAnchor[];
  let bounds: number[];
  if (path.closed) {
    if (!cuts.length || n < 2) return [path];
    const start = cuts[0];
    sequence = [...path.anchors.slice(start), ...path.anchors.slice(0, start), path.anchors[start]];
    bounds = [...cuts.map((i) => i - start), n];
  } else {
    const inner = cuts.filter((i) => i > 0 && i < n - 1);
    if (!inner.length) return [path];
    sequence = path.anchors;
    bounds = [0, ...inner, n - 1];
  }
  const pieces: SketchPath[] = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const anchors = sequence.slice(bounds[k], bounds[k + 1] + 1).map((a) => ({ ...a }));
    if (anchors.length < 2) continue;
    const first = anchors[0], last = anchors[anchors.length - 1];
    // An end has one side only: drop the handle that pointed off the piece.
    anchors[0] = { ...first, inX: 0, inY: 0, mode: "corner" };
    anchors[anchors.length - 1] = { ...last, outX: 0, outY: 0, mode: "corner" };
    pieces.push({ id: pieces.length ? newId() : path.id, anchors, closed: false });
  }
  return pieces.length ? pieces : [path];
}

export interface AnchorRef { pathId: string; index: number }

/**
 * Merges two anchors into one, placed halfway between them — Illustrator's
 * Join with Average. The new anchor is a corner that keeps the handle each
 * side had, so the curves either side keep their shape.
 *
 * - Neighbours on one path: the segment between them collapses.
 * - The two ends of one open path: the path closes.
 * - Ends of two different open paths: they join into one path.
 *
 * Anything else (say, two anchors in the middle of different paths) cannot be
 * joined without inventing a branch, so returns null; so does a merge that
 * would leave a path of a single anchor.
 */
export function mergeAnchors(paths: SketchPath[], a: AnchorRef, b: AnchorRef): { paths: SketchPath[]; merged: AnchorRef } | null {
  const pa = paths.find((p) => p.id === a.pathId), pb = paths.find((p) => p.id === b.pathId);
  if (!pa || !pb || !pa.anchors[a.index] || !pb.anchors[b.index]) return null;
  const joined = (from: SketchAnchor, to: SketchAnchor): SketchAnchor => ({
    x: (from.x + to.x) / 2, y: (from.y + to.y) / 2,
    inX: from.inX, inY: from.inY, outX: to.outX, outY: to.outY,
    mode: "corner",
  });
  if (pa === pb) {
    if (a.index === b.index) return null;
    const path = pa, n = path.anchors.length;
    const [i, j] = a.index < b.index ? [a.index, b.index] : [b.index, a.index];
    if (j === i + 1) {
      if (n - 1 < 2) return null;
      const anchors = path.anchors.slice();
      anchors.splice(i, 2, joined(path.anchors[i], path.anchors[j]));
      return { paths: paths.map((p) => (p === path ? { ...p, anchors } : p)), merged: { pathId: path.id, index: i } };
    }
    if (i === 0 && j === n - 1) {
      if (path.closed) {
        // Neighbours across the closing segment.
        if (n - 1 < 2) return null;
        const anchors = [joined(path.anchors[j], path.anchors[i]), ...path.anchors.slice(1, j)];
        return { paths: paths.map((p) => (p === path ? { ...p, anchors } : p)), merged: { pathId: path.id, index: 0 } };
      }
      if (n < 3) return null;
      const anchors = [joined(path.anchors[j], path.anchors[i]), ...path.anchors.slice(1, j)];
      return { paths: paths.map((p) => (p === path ? { ...p, anchors, closed: true } : p)), merged: { pathId: path.id, index: 0 } };
    }
    return null;
  }
  const isEnd = (p: SketchPath, index: number) => !p.closed && (index === 0 || index === p.anchors.length - 1);
  if (!isEnd(pa, a.index) || !isEnd(pb, b.index)) return null;
  const flip = (p: SketchPath): SketchPath => ({
    ...p,
    anchors: p.anchors.slice().reverse().map((x) => ({ ...x, inX: x.outX, inY: x.outY, outX: x.inX, outY: x.inY })),
  });
  // First path runs up to its merged end; the second runs on from its merged start.
  const head = a.index === pa.anchors.length - 1 ? pa : flip(pa);
  const tail = b.index === 0 ? pb : flip(pb);
  const anchors = [
    ...head.anchors.slice(0, -1),
    joined(head.anchors[head.anchors.length - 1], tail.anchors[0]),
    ...tail.anchors.slice(1),
  ];
  const merged: AnchorRef = { pathId: pa.id, index: head.anchors.length - 1 };
  return {
    paths: paths.filter((p) => p !== pb).map((p) => (p === pa ? { ...p, anchors, closed: false } : p)),
    merged,
  };
}

/** Outline commands for the kernel: every closed path as one compound path,
 *  so a path drawn inside another becomes its hole. */
export function sketchCommands(sketch: SketchData | undefined): SvgCommand[][] {
  const subpaths: SvgCommand[] = [];
  for (const path of sketch?.paths ?? []) {
    if (!path.closed || path.anchors.length < 2) continue;
    const first = path.anchors[0];
    subpaths.push(["M", first.x, first.y]);
    for (let i = 0; i < segmentCount(path); i++) {
      const [, c1, c2, p1] = segmentCubic(path, i);
      if (isStraight(path, i)) subpaths.push(["L", p1[0], p1[1]]);
      else subpaths.push(["C", c1[0], c1[1], c2[0], c2[1], p1[0], p1[1]]);
    }
  }
  return subpaths.length ? [subpaths] : [];
}

/** SVG path data, in sketch coordinates, for drawing a path. */
export function pathData(path: SketchPath): string {
  if (!path.anchors.length) return "";
  const f = (v: number) => +v.toFixed(4);
  const first = path.anchors[0];
  let d = `M${f(first.x)} ${f(first.y)}`;
  for (let i = 0; i < segmentCount(path); i++) {
    const [, c1, c2, p1] = segmentCubic(path, i);
    d += isStraight(path, i)
      ? ` L${f(p1[0])} ${f(p1[1])}`
      : ` C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p1[0])} ${f(p1[1])}`;
  }
  if (path.closed) d += " Z";
  return d;
}

/** Parameters of interior extrema on either coordinate of a cubic. */
function cubicExtrema(cubic: Cubic): number[] {
  const roots: number[] = [];
  for (const axis of [0, 1]) {
    const [p0, p1, p2, p3] = cubic.map((p) => p[axis]);
    const d0 = p1 - p0, d1 = p2 - p1, d2 = p3 - p2;
    const a = d0 - 2 * d1 + d2, b = 2 * (d1 - d0), c = d0;
    const epsilon = Number.EPSILON * 16 * Math.max(Math.abs(a), Math.abs(b), Math.abs(c));
    if (Math.abs(a) <= epsilon) {
      if (Math.abs(b) > epsilon) roots.push(-c / b);
    } else {
      const discriminant = b * b - 4 * a * c;
      if (discriminant >= 0) {
        const q = -0.5 * (b + (b < 0 ? -1 : 1) * Math.sqrt(discriminant));
        if (q === 0) roots.push(-b / (2 * a));
        else roots.push(q / a, c / q);
      }
    }
  }
  return roots.filter((t) => t > 0 && t < 1);
}

/** Axis-aligned bounds of the actual Bézier outline, or null when empty. */
export function sketchBounds(sketch: SketchData): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = ([x, y]: Pt) => {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  };
  for (const path of sketch.paths) {
    if (path.anchors.length === 1) add([path.anchors[0].x, path.anchors[0].y]);
    for (let i = 0; i < segmentCount(path); i++) {
      const cubic = segmentCubic(path, i);
      add(cubic[0]);
      add(cubic[3]);
      for (const t of cubicExtrema(cubic)) add(cubicPoint(cubic, t));
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/** Translate selected completed paths as a group until the nearer of their two
 * bounds touches the axis — whichever side the shape already mostly sits on,
 * not always its minimum. Always aligning to the minimum would drag a shape
 * that is mostly on the negative side, and only barely crosses over, all the
 * way across to sit entirely on the positive side: a small nudge back turns
 * into a large, surprising jump. Handles are relative vectors, so translating
 * only anchors preserves every curve.
 */
export function snapShapeToAxis(paths: SketchPath[], selectedIds: ReadonlySet<string>, axis: 0 | 1): SketchPath[] {
  const selected = paths.filter((p) => selectedIds.has(p.id) && p.closed && p.anchors.length > 1);
  const bounds = sketchBounds({ paths: selected });
  if (!bounds) return paths;
  const [lo, hi] = axis === 0 ? [bounds.minX, bounds.maxX] : [bounds.minY, bounds.maxY];
  const offset = -(Math.abs(lo) <= Math.abs(hi) ? lo : hi);
  if (Math.abs(offset) <= 1e-10) return paths;
  const ids = new Set(selected.map((p) => p.id));
  return paths.map((p) => ids.has(p.id) ? {
    ...p,
    anchors: p.anchors.map((a) => ({ ...a, x: a.x + (axis === 0 ? offset : 0), y: a.y + (axis === 1 ? offset : 0) })),
  } : p);
}

/** Signed area of a closed path (positive anticlockwise), from its sampled outline. */
export function pathArea(path: SketchPath): number {
  const pts: Pt[] = [];
  for (let i = 0; i < segmentCount(path); i++) {
    const cubic = segmentCubic(path, i);
    for (let s = 0; s < 16; s++) pts.push(cubicPoint(cubic, s / 16));
  }
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

export function sampled(path: SketchPath): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < segmentCount(path); i++) {
    const cubic = segmentCubic(path, i);
    // Include exact extrema so the revolve preview reaches a snapped axis too.
    const parameters = new Set([...Array.from({ length: 16 }, (_, s) => s / 16), ...cubicExtrema(cubic)]);
    for (const t of [...parameters].sort((a, b) => a - b)) pts.push(cubicPoint(cubic, t));
  }
  return pts;
}

function pointInPolygon([x, y]: Pt, polygon: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * How many other closed paths each closed path sits inside, using the same
 * test the kernel uses (see svgMeshSolid): odd means it is cut as a hole,
 * even means it is solid. Open paths get -1.
 */
export function nestingDepths(paths: SketchPath[]): number[] {
  const polys = paths.map((p) => (p.closed ? sampled(p) : []));
  const areas = polys.map((poly) => {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a / 2);
  });
  const box = (poly: Pt[]) => poly.reduce(
    (b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
  const inside = (i: number, j: number) => {
    if (areas[j] <= areas[i]) return false;
    const [a0, a1, a2, a3] = box(polys[i]), [b0, b1, b2, b3] = box(polys[j]);
    if (a0 < b0 - 1e-3 || a2 > b2 + 1e-3 || a1 < b1 - 1e-3 || a3 > b3 + 1e-3) return false;
    const n = polys[i].length;
    const centroid: Pt = [polys[i].reduce((s, p) => s + p[0], 0) / n, polys[i].reduce((s, p) => s + p[1], 0) / n];
    const probe = pointInPolygon(centroid, polys[i]) ? centroid : polys[i][0];
    return pointInPolygon(probe, polys[j]);
  };
  return paths.map((p, i) => {
    if (!p.closed || polys[i].length < 3) return -1;
    return polys.reduce((count, poly, j) => count + (j !== i && poly.length >= 3 && inside(i, j) ? 1 : 0), 0);
  });
}

const finite = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** Rebuilds sketch data from a saved file, dropping anything malformed. */
export function parseSketch(raw: unknown): SketchData | undefined {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { paths?: unknown }).paths)) return undefined;
  const paths: SketchPath[] = [];
  for (const p of (raw as { paths: unknown[] }).paths) {
    if (!p || typeof p !== "object" || !Array.isArray((p as { anchors?: unknown }).anchors)) continue;
    const src = p as { id?: unknown; anchors: unknown[]; closed?: unknown };
    const anchors = src.anchors
      .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
      .filter((a) => typeof a.x === "number" && Number.isFinite(a.x) && typeof a.y === "number" && Number.isFinite(a.y))
      .map((a) => ({
        x: a.x as number, y: a.y as number,
        inX: finite(a.inX), inY: finite(a.inY), outX: finite(a.outX), outY: finite(a.outY),
        mode: (a.mode === "corner" || a.mode === "smooth" || a.mode === "symmetric"
          ? a.mode
          : a.smooth === true ? "smooth" : "corner") as AnchorMode,
      }));
    if (!anchors.length) continue;
    paths.push({
      id: typeof src.id === "string" ? src.id : crypto.randomUUID(),
      anchors,
      closed: src.closed === true && anchors.length > 1,
    });
  }
  return { paths };
}
