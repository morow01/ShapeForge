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
export const SVG_IMPORT_REVISION = 6;

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

/** Removes degenerate consecutive vertices and closed loop duplicates. */
function cleanPolygon(raw: [number, number][]): [number, number][] {
  if (raw.length < 3) return [];
  const out: [number, number][] = [];
  for (const pt of raw) {
    if (!Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
    if (out.length > 0) {
      const prev = out[out.length - 1];
      const dx = pt[0] - prev[0];
      const dy = pt[1] - prev[1];
      if (dx * dx + dy * dy < 1e-8) continue;
    }
    out.push(pt);
  }
  // If last vertex equals first vertex, drop closing duplicate for Manifold CrossSection
  if (out.length >= 2) {
    const first = out[0];
    const last = out[out.length - 1];
    const dx = last[0] - first[0];
    const dy = last[1] - first[1];
    if (dx * dx + dy * dy < 1e-8) {
      out.pop();
    }
  }
  if (out.length < 3) return [];
  return out;
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
  return cleanPolygon(points);
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

function polygonBBox(points: [number, number][]): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function isPolygonInside(inner: [number, number][], outer: [number, number][]): boolean {
  if (areaOf(outer) <= areaOf(inner)) return false;
  const [iMinX, iMinY, iMaxX, iMaxY] = polygonBBox(inner);
  const [oMinX, oMinY, oMaxX, oMaxY] = polygonBBox(outer);
  // An interior hole must be completely enclosed within the outer bounding box
  if (iMinX < oMinX - 1e-3 || iMaxX > oMaxX + 1e-3 || iMinY < oMinY - 1e-3 || iMaxY > oMaxY + 1e-3) {
    return false;
  }
  const inside = interiorPoint(inner);
  return pointInPolygon(inside, outer);
}

/**
 * Builds SVG artwork the same way a vector importer does: each source element
 * becomes one 2D region whose contours are wound so that counters read as
 * holes (outer anticlockwise, nested clockwise, resolved NonZero),
 * the elements are unioned, and only then is the result extruded. This avoids
 * fragile per-counter OCCT face cuts that can lose a cap on glyphs such as D.
 */
export function svgMeshSolid(
  paths: SvgCommand[][],
  thickness: number,
  rounding?: { top: number; bottom: number; steps: number },
): MeshShape | null {
  const manifold = getManifold();
  const sections: InstanceType<typeof manifold.CrossSection>[] = [];

  for (const path of paths) {
    const polygons = splitSubpaths(path)
      .map(flatten)
      .filter((points) => points.length >= 3 && areaOf(points) > 1e-4);
    if (!polygons.length) continue;

    // Calculate containment and nesting depth for each polygon
    const depths = polygons.map((poly, i) => {
      return polygons.reduce(
        (count, other, j) => count + (j !== i && isPolygonInside(poly, other) ? 1 : 0),
        0,
      );
    });

    // Group holes under their immediate enclosing outer polygon
    const outerPolys: { outer: [number, number][]; holes: [number, number][][] }[] = [];

    for (let i = 0; i < polygons.length; i++) {
      if (depths[i] % 2 === 0) {
        outerPolys.push({ outer: polygons[i], holes: [] });
      }
    }

    for (let i = 0; i < polygons.length; i++) {
      if (depths[i] % 2 === 1) {
        let bestOuter: { outer: [number, number][]; holes: [number, number][][] } | null = null;
        let minArea = Infinity;

        for (const entry of outerPolys) {
          const a = areaOf(entry.outer);
          if (a > areaOf(polygons[i]) && a < minArea && isPolygonInside(polygons[i], entry.outer)) {
            minArea = a;
            bestOuter = entry;
          }
        }

        if (bestOuter) {
          bestOuter.holes.push(polygons[i]);
        }
      }
    }

    for (const group of outerPolys) {
      try {
        const outerCCW = signedAreaOf(group.outer) > 0 ? group.outer : group.outer.slice().reverse();
        const holesCW = group.holes.map((h) => (signedAreaOf(h) < 0 ? h : h.slice().reverse()));
        sections.push(new manifold.CrossSection([outerCCW, ...holesCW], "NonZero"));
      } catch {
        try {
          sections.push(new manifold.CrossSection([group.outer], "EvenOdd"));
        } catch {}
      }
    }
  }

  if (!sections.length) return null;
  // Merge the whole word before doing any offsets. The old implementation ran
  // the safety search and every rounded layer once per glyph, making build time
  // grow roughly as letters × steps. One combined section keeps it steps-only.
  const section = manifold.CrossSection.union(sections);
  const requestedTop = Math.max(0, rounding?.top ?? 0);
  const requestedBottom = Math.max(0, rounding?.bottom ?? 0);
  // Keep text rebuilding bounded. Unlike simple primitives, a single word may
  // contain dozens of contours and thousands of vertices. The UI exposes only
  // 2 or 3 layers so quality can improve without returning to scene-opening
  // stalls. More stacked offsets add both cost and distracting contour bands.
  const steps = Math.max(2, Math.min(3, Math.round(rounding?.steps ?? 2)));
  const contourCount = section.numContour();
  const safeInset = (requested: number) => {
    let low = 0, high = requested;
    // Three checks are sufficient for a safe preview and keep long words fast.
    for (let i = 0; i < 3; i++) {
      const mid = (low + high) / 2;
      try {
        const inset = section.offset(-mid, "Round", 2, steps * 4);
        if (!inset.isEmpty() && inset.numContour() === contourCount) low = mid;
        else high = mid;
      } catch {
        high = mid;
      }
    }
    return low;
  };
  const top = safeInset(Math.min(requestedTop, thickness / 2));
  const bottom = safeInset(Math.min(requestedBottom, thickness / 2));
  if (top <= 1e-4 && bottom <= 1e-4) return new MeshShape(section.extrude(thickness));

  const pieces: InstanceType<typeof manifold.Manifold>[] = [];
  const addRoundedEnd = (radius: number, fromTop: boolean) => {
    if (radius <= 1e-4) return;
    for (let i = 0; i < steps; i++) {
      const t0 = i / steps, t1 = (i + 1) / steps;
      const midAngle = Math.PI / 2 * (t0 + t1) / 2;
      const inset = fromTop
        ? radius * (1 - Math.cos(midAngle))
        : radius * (1 - Math.sin(midAngle));
      const z0 = fromTop ? thickness - radius + radius * t0 : radius * t0;
      const z1 = fromTop ? thickness - radius + radius * t1 : radius * t1;
      const layer = section.offset(-inset, "Round", 2, steps * 4);
      if (!layer.isEmpty()) pieces.push(layer.extrude(z1 - z0).translate([0, 0, z0]));
    }
  };
  addRoundedEnd(bottom, false);
  const coreBottom = bottom;
  const coreTop = thickness - top;
  if (coreTop > coreBottom + 1e-5) {
    pieces.push(section.extrude(coreTop - coreBottom).translate([0, 0, coreBottom]));
  }
  addRoundedEnd(top, true);
  if (!pieces.length) return null;
  let result = manifold.Manifold.union(pieces);
  if (steps > 2) {
    // Smooth only the shallow angles between adjacent radius layers; letter
    // corners and the top/side boundary remain sharp because their angle is
    // above this threshold. Refinement then evaluates the curved tangent
    // surface instead of merely shading a three-step staircase.
    result = result.smoothOut(45, 1).refine(2);
  }
  return new MeshShape(result);
}
