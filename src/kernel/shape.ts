import {
  makeBaseBox,
  makeCylinder,
  makeSphere,
  makeCompound,
  basicFaceExtrusion,
  cast,
  Vector,
  draw,
  importSTLAsMesh,
  loft,
  makeFace,
  measureVolume,
  MeshShape,
  getManifold,
  getOC,
  sketchFaceOffset,
} from "replicad";
import type { Face, Shape3D, Sketch } from "replicad";
import { InvalidShapeError, solveTriangle, solveScaledTriangle } from "../geometry/triangle";
import { getBlob, putBlob } from "../document/blobStore";
import { svgMeshSolid } from "./svgSolid";
import { makeThreadedRodSolid, makeThreadedNutSolid } from "./threads";
import { makeSpringSolid } from "./spring";
import { makeHingeSolid } from "./hinge";
import { meshShellOpening, offsetExtrudeMesh, resizeMeshFace } from "./meshFace";
import type { SvgCommand } from "../svg/parse";
import type { EditOp, OffsetExtrudeOp, PushPullOp, ResizeFaceOp, ShellOp, Vec3 } from "../document/types";
import { rotateLocalOffset } from "../document/bake";
import type { BuildSpec, EditSpec, ImportSpec, NodeSpec, ObjectSpec } from "./types";

export { InvalidShapeError };

/**
 * A node's local geometry is a Shape3D (OCCT/BRep) for every ordinary
 * primitive and boolean, or a MeshShape (manifold-3d) specifically for an
 * imported STL — see makeImport() for why. Any node that combines the two
 * (a group containing an import, at any depth) is resolved entirely in
 * MeshShape terms; see combine().
 */
export type AnySolid = Shape3D | MeshShape;

const isMesh = (s: AnySolid): s is MeshShape => s instanceof MeshShape;
const FALLBACK_MESH_QUALITY = { tolerance: 0.08, angularTolerance: 0.20 };

/**
 * Rounds the 2D corners of any closed polygon using smooth tangent arcs.
 * Infallible, mathematically exact, and produces clean G1 manifold extrusions.
 */
function roundPolygon2D(
  vertices: [number, number][],
  cornerRadius: number | number[],
  arcSteps = 8
): [number, number][] {
  const n = vertices.length;
  const radii = Array.isArray(cornerRadius)
    ? vertices.map((_, i) => Math.max(0, cornerRadius[i] ?? 0))
    : vertices.map(() => Math.max(0, cornerRadius));
  if (n < 3 || radii.every((radius) => radius <= 0.01)) return vertices;

  const result: [number, number][] = [];

  for (let i = 0; i < n; i++) {
    const radius = radii[i];
    if (radius <= 0.01) {
      result.push(vertices[i]);
      continue;
    }
    const prev = vertices[(i - 1 + n) % n];
    const curr = vertices[i];
    const next = vertices[(i + 1) % n];

    const v1x = prev[0] - curr[0];
    const v1y = prev[1] - curr[1];
    const len1 = Math.hypot(v1x, v1y);

    const v2x = next[0] - curr[0];
    const v2y = next[1] - curr[1];
    const len2 = Math.hypot(v2x, v2y);

    if (len1 < 1e-4 || len2 < 1e-4) {
      result.push(curr);
      continue;
    }

    const u1x = v1x / len1;
    const u1y = v1y / len1;
    const u2x = v2x / len2;
    const u2y = v2y / len2;

    const dot = u1x * u2x + u1y * u2y;
    const cross = u1x * u2y - u1y * u2x; // 2D cross product for turn direction

    const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
    if (angle < 0.05 || angle > Math.PI - 0.05 || Math.abs(cross) < 1e-4) {
      result.push(curr);
      continue;
    }

    const halfAngle = angle / 2;
    // Stop just short of the neighbouring vertex. The former 48% guard left
    // a visible straight spot when a corner slider reached its maximum.
    const maxD = Math.min(len1, len2) * 0.499;
    const desiredD = radius / Math.tan(halfAngle);
    const d = Math.min(desiredD, maxD);
    const rEff = d * Math.tan(halfAngle);

    // Tangent points
    const t1: [number, number] = [curr[0] + u1x * d, curr[1] + u1y * d];
    const t2: [number, number] = [curr[0] + u2x * d, curr[1] + u2y * d];

    // Bisector vector
    const bx = u1x + u2x;
    const by = u1y + u2y;
    const bLen = Math.hypot(bx, by);
    if (bLen < 1e-4) {
      result.push(curr);
      continue;
    }

    const centerDist = rEff / Math.sin(halfAngle);
    const cx = curr[0] + (bx / bLen) * centerDist;
    const cy = curr[1] + (by / bLen) * centerDist;

    // Angles from center to tangent points
    const a1 = Math.atan2(t1[1] - cy, t1[0] - cx);
    const a2 = Math.atan2(t2[1] - cy, t2[0] - cx);

    // Interpolate in the correct angular direction
    let diff = a2 - a1;
    if (cross > 0) {
      while (diff > 0) diff -= 2 * Math.PI;
    } else {
      while (diff < 0) diff += 2 * Math.PI;
    }

    for (let s = 0; s <= arcSteps; s++) {
      const frac = s / arcSteps;
      const curA = a1 + frac * diff;
      result.push([cx + rEff * Math.cos(curA), cy + rEff * Math.sin(curA)]);
    }
  }

  return result;
}

/** Samples one tangent circular fillet while walking prev -> corner -> next. */
function roundedCornerPoints(
  prev: [number, number],
  corner: [number, number],
  next: [number, number],
  radius: number,
  steps = 24,
): [number, number][] {
  if (radius <= 0) return [corner];
  const ax = prev[0] - corner[0], ay = prev[1] - corner[1];
  const bx = next[0] - corner[0], by = next[1] - corner[1];
  const lenA = Math.hypot(ax, ay), lenB = Math.hypot(bx, by);
  const ux = ax / lenA, uy = ay / lenA, vx = bx / lenB, vy = by / lenB;
  const angle = Math.acos(Math.max(-1, Math.min(1, ux * vx + uy * vy)));
  const tangentDistance = Math.min(radius / Math.tan(angle / 2), Math.min(lenA, lenB) * 0.499);
  const effectiveRadius = tangentDistance * Math.tan(angle / 2);
  const start: [number, number] = [corner[0] + ux * tangentDistance, corner[1] + uy * tangentDistance];
  const end: [number, number] = [corner[0] + vx * tangentDistance, corner[1] + vy * tangentDistance];
  const bisectorX = ux + vx, bisectorY = uy + vy;
  const bisectorLength = Math.hypot(bisectorX, bisectorY);
  const centreDistance = effectiveRadius / Math.sin(angle / 2);
  const centre: [number, number] = [
    corner[0] + bisectorX / bisectorLength * centreDistance,
    corner[1] + bisectorY / bisectorLength * centreDistance,
  ];
  const startAngle = Math.atan2(start[1] - centre[1], start[0] - centre[0]);
  let sweep = Math.atan2(end[1] - centre[1], end[0] - centre[0]) - startAngle;
  const cross = ux * vy - uy * vx;
  if (cross > 0) while (sweep > 0) sweep -= 2 * Math.PI;
  else while (sweep < 0) sweep += 2 * Math.PI;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const at = startAngle + sweep * i / steps;
    return [centre[0] + effectiveRadius * Math.cos(at), centre[1] + effectiveRadius * Math.sin(at)];
  });
}

/**
 * Builds joinery and connector components (dovetails, dowels/pins, keys, tenons, screw standoffs).
 * Plug mode produces male pins/standoffs, while Socket mode produces negative mating volumes
 * with built-in 3D printing clearance.
 */
function makeConnectorSolid(p: Record<string, number>): Shape3D {
  const shape = Math.round(p.shape ?? 0);
  const fit = Math.round(p.fit ?? 0); // 0 = Plug (male), 1 = Socket (female)
  const clearance = fit === 1 ? Math.max(0.01, Math.min(5, p.clearance ?? 0.2)) : 0;

  switch (shape) {
    case 0: {
      // 0: Dovetail (Sliding Rail)
      const baseW = Math.max(1, p.width ?? 14);
      const angleDeg = Math.min(45, Math.max(2, p.taperAngle ?? 20));
      const angleRad = (angleDeg * Math.PI) / 180;
      const H = Math.max(0.5, p.height ?? 6);
      const L = Math.max(1, p.length ?? 12);
      const seamBleed = fit === 1 ? 1.0 : 0;
      const stopped = Math.round(p.stopped ?? 1) === 1;
      const stopEnd = Math.round(p.stopEnd ?? 0); // 0 = bottom, 1 = top
      const entryExtension = Math.max(0, p.entryExtension ?? 0);

      // Sliding dovetails:
      // Tight (0.05mm), Standard (0.10mm - previous tight), Loose (0.15mm - previous standard)
      const c = fit === 1
        ? Math.max(0.01, Math.min(2, clearance <= 0.10 ? 0.05 : (clearance <= 0.16 ? 0.10 : 0.15)))
        : 0;

      let effL: number;
      let yShift = 0;

      if (!stopped) {
        // Through Dovetail: cutter bleeds through both ends
        effL = fit === 1 ? L + 2 * c + 2.0 + entryExtension : L;
        yShift = 0;
      } else {
        // Stopped (Blind) Dovetail:
        // One end is open for sliding in (bleeds by 2mm + entryExtension through the open surface).
        // The other end is a solid stop with clearance c at the floor.
        if (fit === 1) {
          effL = L + 2.0 + c + entryExtension;
          // stopEnd === 0 (Stop at Bottom): top (+Y) bleeds out by +2.0 + entryExtension, bottom (-Y) stops at -L/2 - c
          // stopEnd === 1 (Stop at Top): bottom (-Y) bleeds out by -2.0 - entryExtension, top (+Y) stops at +L/2 + c
          yShift = stopEnd === 0 ? (2.0 - c + entryExtension) / 2 : -(2.0 - c + entryExtension) / 2;
        } else {
          effL = L;
          yShift = 0;
        }
      }

      let pts: [number, number][];
      if (fit === 1) {
        // Uniform normal clearance c on all flanks
        const deltaX = c / Math.cos(angleRad);
        const halfB_sock = baseW / 2 + deltaX;
        const halfT_sock = halfB_sock + (H + c) * Math.tan(angleRad);
        // Project flank line backwards through the seam (y=0) to y=-seamBleed preserving exact angleRad slope
        const effBleed = Math.min(seamBleed, Math.max(0.1, (halfB_sock - 0.2) / Math.tan(angleRad)));
        const halfBleed_sock = halfB_sock - effBleed * Math.tan(angleRad);

        pts = [
          [-halfBleed_sock, -effBleed],
          [halfBleed_sock, -effBleed],
          [halfT_sock, H + c],
          [-halfT_sock, H + c],
        ];
      } else {
        const flare = H * Math.tan(angleRad);
        const halfB = baseW / 2;
        const halfT = halfB + flare;
        pts = [
          [-halfB, 0],
          [halfB, 0],
          [halfT, H],
          [-halfT, H],
        ];
      }

      let pen = draw(pts[0]);
      for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);
      return (pen.close().sketchOnPlane("XZ").extrude(effL) as Shape3D).translate([0, effL / 2 + yShift, 0]);
    }

    case 1: {
      // 1: Round Pin / Dowel
      const baseR = Math.max(0.5, p.radius ?? 5);
      const baseL = Math.max(1, p.length ?? 12);
      const rawChamfer = Math.max(0, p.chamfer ?? 1);
      const seamBleed = fit === 1 ? 1.0 : 0;

      if (fit === 1) {
        const sR = baseR + clearance;
        const sL = baseL + clearance + seamBleed;
        return (makeCylinder(sR, sL) as Shape3D).translate([0, 0, -seamBleed]);
      }

      const maxCh = Math.min(baseR * 0.5, baseL * 0.5);
      const ch = Math.min(rawChamfer, maxCh);

      if (ch <= 0.01) {
        return makeCylinder(baseR, baseL) as Shape3D;
      }

      const pen = draw([0, 0])
        .lineTo([baseR, 0])
        .lineTo([baseR, baseL - ch])
        .lineTo([baseR - ch, baseL])
        .lineTo([0, baseL]);
      return pen.close().sketchOnPlane("XZ").revolve([0, 0, 1]) as Shape3D;
    }

    case 2: {
      // 2: Square Pin / Key
      const baseW = Math.max(1, p.width ?? 10);
      const baseL = Math.max(1, p.length ?? 12);
      const rawChamfer = Math.max(0, p.chamfer ?? 1);
      const seamBleed = fit === 1 ? 1.0 : 0;

      if (fit === 1) {
        const sW = baseW + 2 * clearance;
        const sL = baseL + clearance + seamBleed;
        return (makeBaseBox(sW, sW, sL) as Shape3D).translate([0, 0, -seamBleed]);
      }

      const maxCh = Math.min(baseW * 0.45, baseL * 0.5);
      const ch = Math.min(rawChamfer, maxCh);

      if (ch <= 0.01) {
        return makeBaseBox(baseW, baseW, baseL) as Shape3D;
      }

      const bodyH = baseL - ch;
      const halfBase = baseW / 2;
      const skBottom = draw([-halfBase, -halfBase])
        .lineTo([halfBase, -halfBase])
        .lineTo([halfBase, halfBase])
        .lineTo([-halfBase, halfBase])
        .close()
        .sketchOnPlane("XY", 0);

      const skMid = draw([-halfBase, -halfBase])
        .lineTo([halfBase, -halfBase])
        .lineTo([halfBase, halfBase])
        .lineTo([-halfBase, halfBase])
        .close()
        .sketchOnPlane("XY", bodyH);

      const halfTip = halfBase - ch;
      const skTop = draw([-halfTip, -halfTip])
        .lineTo([halfTip, -halfTip])
        .lineTo([halfTip, halfTip])
        .lineTo([-halfTip, halfTip])
        .close()
        .sketchOnPlane("XY", baseL);

      return (skBottom as Sketch).loftWith([skMid as Sketch, skTop as Sketch], { ruled: true }) as Shape3D;
    }

    case 3: {
      // 3: Tenon & Mortise
      const baseW = Math.max(1, p.width ?? 20);
      const baseT = Math.max(0.5, p.thickness ?? 6);
      const baseL = Math.max(1, p.length ?? 15);
      const rawFillet = Math.max(0, p.fillet ?? 0);
      const seamBleed = fit === 1 ? 1.0 : 0;

      const effW = fit === 1 ? baseW + 2 * clearance : baseW;
      const effT = fit === 1 ? baseT + 2 * clearance : baseT;
      const effL = fit === 1 ? baseL + clearance + seamBleed : baseL;

      const maxFillet = Math.min(effW, effT) * 0.499;
      const effFillet = rawFillet > 0
        ? Math.min(rawFillet + (fit === 1 ? clearance : 0), maxFillet)
        : maxFillet; // Default to full rounded Domino ends

      if (effFillet <= 0.01) {
        const s = makeBaseBox(effW, effT, effL) as Shape3D;
        return fit === 1 ? (s.translate([0, 0, -seamBleed]) as Shape3D) : s;
      }

      const hw = effW / 2;
      const ht = effT / 2;
      const rectCorners: [number, number][] = [
        [-hw, -ht],
        [hw, -ht],
        [hw, ht],
        [-hw, ht],
      ];
      const roundedPts = roundPolygon2D(rectCorners, effFillet, 12);
      let pen = draw(roundedPts[0]);
      for (let i = 1; i < roundedPts.length; i++) pen = pen.lineTo(roundedPts[i]);
      const s = pen.close().sketchOnPlane("XY").extrude(effL) as Shape3D;
      return fit === 1 ? (s.translate([0, 0, -seamBleed]) as Shape3D) : s;
    }

    case 4: {
      // 4: Screw Boss / Standoff
      const rOut = Math.max(1, p.outerRadius ?? 4);
      const rIn = Math.min(Math.max(0.5, p.innerRadius ?? 1.5), rOut - 0.5);
      const L = Math.max(1, p.length ?? 10);

      if (fit === 1) {
        const overshoot = 0.5;
        const sROut = rOut + clearance;
        const sRIn = rIn + clearance;
        const headR = Math.min(sROut, Math.max(sRIn * 1.8, sRIn + 1.5));
        const headH = Math.min(L * 0.5, 4);
        const lipH = Math.min(1.5, L * 0.25);
        const midH = Math.max(0.1, L - headH);

        const pen = draw([0, -overshoot])
          .lineTo([sROut, -overshoot])
          .lineTo([sROut, lipH])
          .lineTo([sRIn, lipH])
          .lineTo([sRIn, midH])
          .lineTo([headR, midH])
          .lineTo([headR, L])
          .lineTo([0, L]);
        return pen.close().sketchOnPlane("XZ").revolve([0, 0, 1]) as Shape3D;
      }

      const pen = draw([rIn, 0])
        .lineTo([rOut, 0])
        .lineTo([rOut, L])
        .lineTo([rIn, L]);
      return pen.close().sketchOnPlane("XZ").revolve([0, 0, 1]) as Shape3D;
    }

    case 5: {
      // 5: Print-in-Place Hinge with Self-Supporting 45° Conical Pivots (Cone & Cup)
      // 100% self-supporting FDM design: zero horizontal sagging, zero mid-air droop, cannot weld!
      const L = Math.max(8, p.length ?? 30);
      const Rk = Math.max(1.5, p.radius ?? 4);
      const rawN = Math.max(3, Math.min(15, Math.round(p.knuckleCount ?? 3)));
      const effN = rawN % 2 === 0 ? rawN + 1 : rawN;
      const userC = (p.clearance !== undefined && p.clearance > 0) ? p.clearance : (clearance > 0 ? clearance : 0.20);
      const c = Math.max(0.08, Math.min(0.50, userC));
      const totalGaps = (effN - 1) * c;
      const kLen = Math.max(1.5, (L - totalGaps) / effN);
      const yStartAll = -L / 2;

      const Rcone = Math.max(0.8, Math.min(Rk * 0.62, kLen * 0.55));
      const rTip = Math.max(0.3, Rcone * 0.22);
      const Hcone = Rcone - rTip; // 45° cone slope: height = deltaR
      const ch = Math.min(0.4, kLen * 0.1); // outer bevel chamfer to prevent perimeter welding

      const buildKnuckle = (i: number): Shape3D => {
        const yB = yStartAll + i * (kLen + c);
        const yT = yB + kLen;
        const hasBottomSocket = i > 0;
        const hasTopCone = i < effN - 1;

        const pts: [number, number][] = [];

        if (hasBottomSocket) {
          // Socket interior apex with snug axial clearance (c + 0.08mm):
          pts.push([0, yB + Hcone + c + 0.08]);
          pts.push([rTip + c, yB + Hcone + c + 0.08]);
          pts.push([Rcone + c, yB]);
          pts.push([Rk - ch, yB]);
          pts.push([Rk, yB + ch]);
        } else {
          // Flat bottom at yB
          pts.push([0, yB]);
          pts.push([Rk, yB]);
        }

        // Cylindrical barrel:
        if (hasTopCone) {
          pts.push([Rk, yT - ch]);
          pts.push([Rk - ch, yT]);
          pts.push([Rcone, yT]);
          pts.push([rTip, yT + Hcone]);
          pts.push([0, yT + Hcone]);
        } else {
          // Flat top at yT
          pts.push([Rk, yT]);
          pts.push([0, yT]);
        }

        let pen = draw(pts[0]);
        for (let j = 1; j < pts.length; j++) pen = pen.lineTo(pts[j]);
        const cyl = pen.close().sketchOnPlane("XZ").revolve([0, 0, 1]) as Shape3D;
        return cyl.rotate(-90, [0, 0, 0], [1, 0, 0]) as Shape3D;
      };

      if (fit === 0) {
        // Plug solid: Leaf 1 knuckles (even indices: 0, 2, ...) with self-supporting 45° conical pivots
        let solid: Shape3D = buildKnuckle(0);
        for (let i = 2; i < effN; i += 2) {
          solid = solid.fuse(buildKnuckle(i)) as Shape3D;
        }
        return solid;
      } else if (fit === 1) {
        // Socket solid: Leaf 2 knuckles (odd indices: 1, 3, ...) with 45° sockets and top 45° cone
        let solid: Shape3D = buildKnuckle(1);
        for (let i = 3; i < effN; i += 2) {
          solid = solid.fuse(buildKnuckle(i)) as Shape3D;
        }
        return solid;
      } else if (fit === 2) {
        // Leaf 2 clearance pocket cutter for Part A: clears odd knuckles (1, 3, ...)
        let cutter: Shape3D | null = null;
        for (let i = 1; i < effN; i += 2) {
          const yK = yStartAll + i * (kLen + c) - c;
          const kPocketLen = kLen + 2 * c;
          const outerCyl = (makeCylinder(Rk + c, kPocketLen).rotate(-90, [0, 0, 0], [1, 0, 0]) as Shape3D)
            .translate([0, yK, 0]) as Shape3D;
          cutter = cutter ? (cutter.fuse(outerCyl) as Shape3D) : outerCyl;
        }
        return cutter ?? (makeCylinder(Rk + c, kLen + 2 * c) as Shape3D);
      } else {
        // Leaf 1 clearance pocket cutter for Part B: clears even knuckles (0, 2, ...)
        let cutter: Shape3D | null = null;
        for (let i = 0; i < effN; i += 2) {
          const isBottom = i === 0;
          const isTop = i === effN - 1;
          const bleed = 10; // 10mm generous bleed ensures zero razor flaps at top/bottom box faces
          const yK = isBottom
            ? yStartAll - bleed
            : yStartAll + i * (kLen + c) - c;
          const kPocketLen = isBottom
            ? bleed + kLen + c
            : (isTop ? kLen + c + bleed : kLen + 2 * c);
          const outerCyl = (makeCylinder(Rk + c, kPocketLen).rotate(-90, [0, 0, 0], [1, 0, 0]) as Shape3D)
            .translate([0, yK, 0]) as Shape3D;
          cutter = cutter ? (cutter.fuse(outerCyl) as Shape3D) : outerCyl;
        }
        return cutter ?? (makeCylinder(Rk + c, L + 20) as Shape3D);
      }
    }

    case 6: {
      // 6: Split-Prong Snap Pin (Collet / Dowel Snap Joint)
      // Engineered 3D-printable compliant snap joint with flexible hollow-core prongs
      const baseD = Math.max(3.5, p.thickness ?? (p.width ? Math.min(p.width, 12) : 6.0));
      const R = baseD / 2;
      const L = Math.max(8.0, p.length ?? 14.0);
      const hookH = Math.max(0.25, Math.min(0.60, p.hookDepth ?? 0.40));
      const seamBleed = fit === 1 ? 1.0 : 0;
      const c = fit === 1 ? Math.max(0.15, Math.min(1.0, clearance || 0.25)) : 0;

      const beadLen = Math.max(3.2, hookH * 4.5);
      const zBeadStart = L - beadLen;
      const retL = Math.max(0.8, hookH * 1.6); // ~35°-40° return ramp for detaching
      const zApex = zBeadStart + retL;
      const slotW = Math.max(1.0, Math.min(2.0, R * 0.50)); // Expansion slot width
      const rootCollar = Math.max(1.5, L * 0.15); // Solid root collar before slot starts
      const rCore = Math.max(0.8, R * 0.52); // Central hollow core bore for spring compliance

      if (fit === 0) {
        // Male Split-Prong Snap Pin (extending along +Z from Z = 0)
        // 1. Revolved pin with annular retention bead and gentle 18° lead-in cone
        const pts: [number, number][] = [
          [0, 0],
          [R, 0],
          [R, zBeadStart],
          [R + hookH, zApex],
          [Math.max(0.5, R - 0.5), L],
          [0, L],
        ];
        let pen = draw(pts[0]);
        for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);
        let pinSolid = pen.close().sketchOnPlane("XZ").revolve([0, 0, 1]) as Shape3D;

        // 2. Hollow center core to give prongs elastic spring compliance (not solid plastic)
        const coreBore = (makeCylinder(rCore, L - rootCollar + 1) as Shape3D)
          .translate([0, 0, rootCollar]) as Shape3D;
        pinSolid = pinSolid.cut(coreBore) as Shape3D;

        // 3. Center expansion slot splitting the pin into two compliant spring prongs
        const slotBox = makeBaseBox(slotW, (R + hookH + 2) * 2, L - rootCollar + 2)
          .translate([0, 0, rootCollar]) as Shape3D;
        const reliefCyl = (makeCylinder(slotW * 0.65, (R + hookH + 2) * 2)
          .rotate(-90, [0, 0, 0], [1, 0, 0]) as Shape3D)
          .translate([0, -(R + hookH + 2), rootCollar]) as Shape3D;
        const cutter = slotBox.fuse(reliefCyl) as Shape3D;

        return pinSolid.cut(cutter) as Shape3D;
      } else {
        // Female Socket Hole with internal annular retention groove
        const effR = R + c;
        const effHookH = hookH + c;
        const effL = L + c + seamBleed;
        const zGrooveStart = zBeadStart - c;
        const zGrooveApex = zApex;
        const zGrooveEnd = zBeadStart + beadLen + c;

        // Revolved socket cavity with generous entrance lead-in chamfer
        const pts: [number, number][] = [
          [0, -seamBleed],
          [effR + 1.0, -seamBleed], // 1mm wide 45° entrance lead-in chamfer
          [effR, 1.0],
          [effR, zGrooveStart],
          [effR + effHookH, zGrooveApex], // Internal retention groove
          [effR, zGrooveEnd],
          [effR, effL],
          [0, effL],
        ];
        let pen = draw(pts[0]);
        for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);
        return pen.close().sketchOnPlane("XZ").revolve([0, 0, 1]) as Shape3D;
      }
    }

    default:
      return makeBaseBox(10, 10, 10) as Shape3D;
  }
}

/**
 * Parametric Screw Hole cutter solid.
 * Anchored with Z=0 as the mounting face surface, centered in XY.
 * Extends downwards into -Z to depth, with a 0.5mm bleed into +Z so boolean cuts
 * never leave coplanar boundary artifacts at the surface.
 */
function makeScrewHoleSolid(p: Record<string, number>): Shape3D {
  const holeDia = Math.max(0.4, p.holeDia ?? 3.4);
  const holeR = holeDia / 2;
  const style = Math.round(p.headStyle ?? 0); // 0 = Countersunk, 1 = Counterbored, 2 = Simple
  const bleed = 0.5; // Top bleed above Z=0 into +Z
  const pocketDepth = Math.max(0, p.pocketDepth ?? p.recess ?? 0);
  const topZ = bleed + pocketDepth;

  if (style === 2) {
    // Simple clearance hole cylinder
    const depth = Math.max(0.5, p.depth ?? 15);
    const pts: [number, number][] = [
      [0, topZ],
      [holeR, topZ],
      [holeR, 0],
      [holeR, -depth],
      [0, -depth],
    ];
    let pen = draw(pts[0]);
    for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);
    return pen.close().sketchOnPlane("XZ").revolve([0, 0, 1]) as Shape3D;
  }

  const headDia = Math.max(holeDia + 0.2, p.headDia ?? 6.5);
  const headR = headDia / 2;

  if (style === 1) {
    // Counterbored (stepped socket cap)
    const headDepth = Math.max(0.2, p.headDepth ?? 3.4);
    const depth = Math.max(headDepth + 0.5, p.depth ?? 15);
    const pts: [number, number][] = [
      [0, topZ],
      [headR, topZ],
      [headR, 0],
      [headR, -headDepth],
      [holeR, -headDepth],
      [holeR, -depth],
      [0, -depth],
    ];
    let pen = draw(pts[0]);
    for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);
    return pen.close().sketchOnPlane("XZ").revolve([0, 0, 1]) as Shape3D;
  }

  // Style 0: Countersunk (conical flathead)
  const headAngleDeg = Math.max(30, Math.min(150, p.headAngle ?? 90));
  const headAngleRad = (headAngleDeg * Math.PI) / 180;
  const coneH = (headR - holeR) / Math.tan(headAngleRad / 2);
  const depth = Math.max(coneH + 0.5, p.depth ?? 15);

  const pts: [number, number][] = [
    [0, topZ],
    [headR, topZ],
    [headR, 0],
    [holeR, -coneH],
    [holeR, -depth],
    [0, -depth],
  ];

  let pen = draw(pts[0]);
  for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);
  return pen.close().sketchOnPlane("XZ").revolve([0, 0, 1]) as Shape3D;
}

/**
 * Builds a primitive in LOCAL space: centred in XY with its base on z = 0,
 * with no position or rotation applied. Placement lives on the Three.js side
 * so dragging an object never needs a kernel rebuild.
 */
export function makePrimitive(spec: ObjectSpec): AnySolid {
  const p = spec.params;
  let s: AnySolid;
  let fixedXYCentre: [number, number] | null = null;

  switch (spec.kind) {
    case "box": {
      s = makeBaseBox(p.width, p.depth, p.height);
      const everywhere = (p.filletMode ?? 0) === 1;
      // Clamp so the fillet can never exceed half the smallest side, which
      // would make OCCT throw instead of returning a shape. Rounding every
      // edge also rounds the top/bottom rims, so height limits it too.
      const maxR = everywhere
        ? Math.min(p.width, p.depth, p.height) / 2 - 0.01
        : Math.min(p.width, p.depth) / 2 - 0.01;
      const r = Math.min(p.fillet ?? 0, maxR);
      // Side edges only (the original behaviour) vs. every edge, including
      // the top and bottom rims — a fully rounded box, not just a rounded
      // rectangle extruded straight up.
      if (r > 0) s = everywhere ? s.fillet(r) : s.fillet(r, (e) => e.inDirection("Z"));
      break;
    }
    case "cylinder": {
      const sides = Math.max(3, Math.min(96, Math.round(p.sides ?? 48)));
      const legacyPosition = p.filletPosition ?? 2;
      let topCorner = Math.min(
        Math.max(p.topFillet ?? (legacyPosition !== 1 ? (p.fillet ?? 0) : 0), 0),
        Math.max(0, Math.min(p.radius, p.height)),
      );
      let bottomCorner = Math.min(
        Math.max(p.bottomFillet ?? (legacyPosition !== 0 ? (p.fillet ?? 0) : 0), 0),
        Math.max(0, Math.min(p.radius, p.height)),
      );
      const heightBudget = Math.max(0, p.height);
      if (topCorner + bottomCorner > heightBudget) {
        const scale = heightBudget / (topCorner + bottomCorner);
        topCorner *= scale;
        bottomCorner *= scale;
      }
      if (sides >= 32) {
        if (topCorner <= 0 && bottomCorner <= 0) {
          s = makeCylinder(p.radius, p.height);
        } else {
          let pen = draw([0, 0]);
          const baseRadius = p.radius - bottomCorner;
          if (baseRadius > 1e-7) {
            pen = pen.lineTo([baseRadius, 0]);
          }
          if (bottomCorner > 0) {
            const mid = [
              p.radius - bottomCorner + bottomCorner * Math.cos(-Math.PI / 4),
              bottomCorner + bottomCorner * Math.sin(-Math.PI / 4),
            ] as [number, number];
            pen = pen.threePointsArcTo([p.radius, bottomCorner], mid);
          }
          pen = pen.lineTo([p.radius, p.height - topCorner]);
          if (topCorner > 0) {
            const mid = [
              p.radius - topCorner + topCorner * Math.cos(Math.PI / 4),
              p.height - topCorner + topCorner * Math.sin(Math.PI / 4),
            ] as [number, number];
            pen = pen.threePointsArcTo([p.radius - topCorner, p.height], mid);
          }
          pen = pen.lineTo([0, p.height]);
          s = pen.close().sketchOnPlane("XZ").revolve([0, 0, 1]) as Shape3D;
        }
      } else {
        const polygonSketch = (radius: number, z: number) => {
          const points: [number, number][] = Array.from({ length: sides }, (_, i) => {
            const angle = 2 * Math.PI * i / sides;
            return [radius * Math.cos(angle), radius * Math.sin(angle)];
          });
          let pen = draw(points[0]);
          for (let i = 1; i < points.length; i++) pen = pen.lineTo(points[i]);
          return pen.close().sketchOnPlane("XY", z) as Sketch;
        };
        if (topCorner <= 0 && bottomCorner <= 0) {
          s = polygonSketch(p.radius, 0).extrude(p.height) as Shape3D;
        } else {
          const axialProfile: [number, number][] = [];
          const curveSteps = 24;
          if (bottomCorner > 0) {
            const centreR = p.radius - bottomCorner;
            for (let i = 0; i <= curveSteps; i++) {
              const angle = -Math.PI / 2 + (Math.PI / 2) * i / curveSteps;
              axialProfile.push([
                centreR + bottomCorner * Math.cos(angle),
                bottomCorner + bottomCorner * Math.sin(angle),
              ]);
            }
          } else {
            axialProfile.push([p.radius, 0]);
          }
          if (topCorner > 0) {
            const centreR = p.radius - topCorner;
            const centreZ = p.height - topCorner;
            for (let i = 0; i <= curveSteps; i++) {
              const angle = (Math.PI / 2) * i / curveSteps;
              axialProfile.push([
                centreR + topCorner * Math.cos(angle),
                centreZ + topCorner * Math.sin(angle),
              ]);
            }
          } else {
            axialProfile.push([p.radius, p.height]);
          }
          const startsAtPoint = axialProfile[0][0] <= 1e-7;
          const endsAtPoint = axialProfile[axialProfile.length - 1][0] <= 1e-7;
          const ringProfile = axialProfile.filter(([radius]) => radius > 1e-7);
          const rings = ringProfile.map(([radius, z]) => polygonSketch(radius, z));
          s = rings[0].loftWith(rings.slice(1), {
            ruled: true,
            ...(startsAtPoint ? { startPoint: [0, 0, axialProfile[0][1]] as [number, number, number] } : {}),
            ...(endsAtPoint
              ? { endPoint: [0, 0, axialProfile[axialProfile.length - 1][1]] as [number, number, number] }
              : {}),
          }) as Shape3D;
        }
      }
      break;
    }
    case "sphere": {
      // A sphere is normally an exact B-Rep ball with no side count at all.
      // Low poly injects one (see lowPolyPrimitiveSpec) and that switches the
      // build to a geodesic mesh: evenly sized triangles, poles included, and
      // the radius held exactly. Decimating the smooth ball instead gave
      // crystalline facets and a lopsided silhouette — 19.4 x 18.6 x 20 on a
      // 20mm sphere — because simplify() keeps whichever vertices happen to
      // fit the tolerance and knows nothing about symmetry.
      const sides = p.sides;
      if (typeof sides === "number" && Number.isFinite(sides) && sides < SPHERE_SMOOTH_SIDES) {
        const n = Math.max(4, Math.min(SPHERE_SMOOTH_SIDES, Math.round(sides)));
        s = new MeshShape(getManifold().Manifold.sphere(Math.max(p.radius, 0.1), n));
      } else {
        s = makeSphere(p.radius);
      }
      break;
    }
    case "cone": {
      const rb = Math.max(p.bottomRadius, 0);
      const rt = Math.max(p.topRadius, 0);
      // Read the old shared-radius fields as a fallback so designs saved by
      // the short-lived first version of cone rounding still open correctly.
      const legacyPosition = p.filletPosition ?? 1;
      const requestedTop = Math.max(
        p.topFillet ?? (legacyPosition !== 1 ? (p.fillet ?? 0) : 0),
        0,
      );
      const requestedBottom = Math.max(
        p.bottomFillet ?? (legacyPosition !== 0 ? (p.fillet ?? 0) : 0),
        0,
      );
      const cornerSteps = Math.max(1, Math.min(64, Math.round(p.cornerSteps ?? 24)));
      // A pointed cone has a vertex rather than a top edge, so its nose has
      // to be rounded in the 2D profile before revolution. The half-angle
      // limit keeps both tangent points on the cone's side and centre line.
      const slant = Math.hypot(rb, p.height);
      const radiusDelta = rb - rt;
      const tipLimit = rt === 0 && rb > 0 && p.height > 0
        ? p.height * rb / (slant + p.height)
        : 0;
      // A profile fillet consumes r / tan(angle / 2) along each adjoining
      // line. Limit each corner using the real cone angle, then share the
      // sloped side between the two ends so their tangent arcs cannot overlap.
      const bottomSlopeFactor = p.height > 0 ? (slant + radiusDelta) / p.height : Infinity;
      const topSlopeFactor = rt > 0 && p.height > 0 ? (slant - radiusDelta) / p.height : 0;
      const bottomLimit = bottomSlopeFactor > 0
        ? Math.min(rb, slant) / bottomSlopeFactor
        : 0;
      const topLimit = rt > 0
        ? (topSlopeFactor > 0 ? Math.min(rt, slant) / topSlopeFactor : 0)
        : tipLimit;
      let topCorner = Math.min(requestedTop, Math.max(0, topLimit - 0.01));
      let bottomCorner = Math.min(requestedBottom, Math.max(0, bottomLimit - 0.01));
      const topSlopeUse = rt > 0 ? topCorner * topSlopeFactor : topCorner * p.height / rb;
      const bottomSlopeUse = bottomCorner * bottomSlopeFactor;
      const slopeBudget = Math.max(0, slant - 0.01);
      if (topSlopeUse + bottomSlopeUse > slopeBudget) {
        const scale = slopeBudget / (topSlopeUse + bottomSlopeUse);
        topCorner *= scale;
        bottomCorner *= scale;
      }
      // Cone UI starts at 8, while Pyramid deliberately reuses this builder
      // and must be allowed to request a triangular (3-sided) profile.
      const sides = Math.max(3, Math.min(96, Math.round(p.sides ?? 48)));
      if (rt === 0 && (topCorner > 0 || bottomCorner > 0)) {
        // Use a circular cap centred on the revolution axis. It is tangent to
        // the cone wall and reaches the axis at its pole, avoiding the pinched
        // centre produced by filleting the wall-to-axis corner directly.
        const centreZ = topCorner > 0 ? p.height - topCorner * slant / rb : p.height;
        const lineT = topCorner > 0 ? (rb * rb + p.height * centreZ) / (slant * slant) : 1;
        const tangent: [number, number] = topCorner > 0
          ? [rb * (1 - lineT), p.height * lineT]
          : [0, p.height];
        const pole: [number, number] = [0, topCorner > 0 ? centreZ + topCorner : p.height];
        const bottomProfile = bottomCorner > 0
          ? roundedCornerPoints([0, 0], [rb, 0], tangent, bottomCorner, cornerSteps)
          : [[rb, 0] as [number, number]];
        const capStartAngle = topCorner > 0 ? Math.atan2(tangent[1] - centreZ, tangent[0]) : 0;
        const capProfile: [number, number][] = topCorner > 0
          ? Array.from({ length: cornerSteps + 1 }, (_, i) => {
              const angle = capStartAngle + (Math.PI / 2 - capStartAngle) * i / cornerSteps;
              return [topCorner * Math.cos(angle), centreZ + topCorner * Math.sin(angle)];
            })
          : [tangent];
        const axialProfile = [...bottomProfile, ...capProfile.slice(1)];
        const polygonSketch = (radius: number, z: number) => {
          const points: [number, number][] = Array.from({ length: sides }, (_, i) => {
            const angle = 2 * Math.PI * i / sides;
            return [radius * Math.cos(angle), radius * Math.sin(angle)];
          });
          let pen = draw(points[0]);
          for (let i = 1; i < points.length; i++) pen = pen.lineTo(points[i]);
          return pen.close().sketchOnPlane("XY", z) as Sketch;
        };
        const ringProfile = axialProfile.filter(([radius]) => radius > 1e-7);
        const rings = ringProfile.map(([radius, z]) => polygonSketch(radius, z));
        s = rings[0].loftWith(rings.slice(1), {
          ruled: true,
          endPoint: [0, 0, pole[1]],
        }) as Shape3D;
      } else {
        // A regular polygon profile makes Sides part of the real solid. A
        // linear extrusion profile scales that polygon to the requested top
        // radius, including all the way to a true point.
        const profile: [number, number][] = Array.from({ length: sides }, (_, i) => {
          const angle = 2 * Math.PI * i / sides;
          return [rb * Math.cos(angle), rb * Math.sin(angle)];
        });
        let pen = draw(profile[0]);
        for (let i = 1; i < profile.length; i++) pen = pen.lineTo(profile[i]);
        s = pen.close().sketchOnPlane("XY").extrude(p.height, {
          extrusionProfile: { profile: "linear", endFactor: rb > 0 ? rt / rb : 0 },
        }) as Shape3D;
        if (topCorner > 0 || bottomCorner > 0) {
          s = s.fillet((edge) => {
            const z = edge.boundingBox.center[2];
            if (topCorner > 0 && Math.abs(z - p.height) < 1e-5) return topCorner;
            if (bottomCorner > 0 && Math.abs(z) < 1e-5) return bottomCorner;
            return null;
          });
        }
      }
      break;
    }
    case "triangle": {
      if (p.thickness <= 0) throw new InvalidShapeError("Thickness must be greater than zero.");
      const { apexPoint } = solveTriangle(p);
      const legacyFillet = Math.max(p.fillet ?? 0, 0);
      const cornerRadii = [
        Math.max(p.leftFillet ?? legacyFillet, 0),
        Math.max(p.rightFillet ?? legacyFillet, 0),
        Math.max(p.apexFillet ?? legacyFillet, 0),
      ];
      const basePts: [number, number][] = [[0, 0], [p.base, 0], [apexPoint.x, apexPoint.y]];
      // A triangle's document origin belongs to its unrounded construction
      // triangle. If normalise() instead centres the changing rounded bounds,
      // an asymmetric Right or Apex radius visibly slides the whole object.
      const baseXs = basePts.map(([x]) => x);
      const baseYs = basePts.map(([, y]) => y);
      fixedXYCentre = [
        (Math.min(...baseXs) + Math.max(...baseXs)) / 2,
        (Math.min(...baseYs) + Math.max(...baseYs)) / 2,
      ];
      // Triangle corner radii are often viewed edge-on, where the default
      // eight-segment approximation reads as a visibly faceted arc. Use a
      // denser profile here so the extrusion stays smooth at normal zoom.
      const cornerSteps = Math.max(1, Math.min(64, Math.round(p.cornerSteps ?? 32)));
      const pts = roundPolygon2D(basePts, cornerRadii, cornerSteps);
      // Keep the rounded profile in the original sharp triangle's coordinate
      // frame. The viewport already compensates for changing visible bounds;
      // translating the profile to its new bounding-box centre would move the
      // untouched edges whenever an asymmetric corner radius changes.
      let pen = draw(pts[0]);
      for (let i = 1; i < pts.length; i++) {
        pen = pen.lineTo(pts[i]);
      }
      s = pen.close().sketchOnPlane("XY").extrude(p.thickness) as Shape3D;
      break;
    }
    case "torus": {
      const R = Math.max(p.radius ?? 15, 0.05);
      const r = Math.min(Math.max(p.tubeRadius ?? 5, 0.01), R - 0.005);
      const ringSteps = Math.max(8, Math.min(128, Math.round(p.ringSteps ?? 48)));
      const tubeSteps = Math.max(8, Math.min(128, Math.round(p.tubeSteps ?? 32)));
      const vertices: number[] = [];
      const triangles: number[] = [];
      for (let ring = 0; ring < ringSteps; ring++) {
        const u = ring * 2 * Math.PI / ringSteps;
        for (let tube = 0; tube < tubeSteps; tube++) {
          const v = tube * 2 * Math.PI / tubeSteps;
          const radial = R + r * Math.cos(v);
          vertices.push(radial * Math.cos(u), radial * Math.sin(u), r + r * Math.sin(v));
        }
      }
      for (let ring = 0; ring < ringSteps; ring++) {
        const nextRing = (ring + 1) % ringSteps;
        for (let tube = 0; tube < tubeSteps; tube++) {
          const nextTube = (tube + 1) % tubeSteps;
          const a = ring * tubeSteps + tube;
          const b = nextRing * tubeSteps + tube;
          const c = nextRing * tubeSteps + nextTube;
          const d = ring * tubeSteps + nextTube;
          triangles.push(a, b, c, a, c, d);
        }
      }
      const manifold = getManifold();
      const torusMesh = new manifold.Mesh({
        vertProperties: new Float32Array(vertices),
        triVerts: new Uint32Array(triangles),
        numProp: 3,
      });
      s = new MeshShape(new manifold.Manifold(torusMesh));
      break;
    }
    case "pyramid": {
      const sides = Math.max(3, Math.min(32, Math.round(p.sides ?? 4)));
      const r = Math.max(p.radius ?? (p.width ? p.width / 2 : 10), 0.1);
      const h = Math.max(p.height ?? 20, 0.1);
      // A pyramid is the pointed form of the same polygonal loft used by a
      // cone. Reusing that profile gives it reliable, independent rounding
      // at the tip and base instead of trying to fillet several converging
      // BRep edges at once (which commonly fails at the apex).
      s = makePrimitive({
        ...spec,
        kind: "cone",
        params: {
          bottomRadius: r,
          topRadius: 0,
          height: h,
          sides,
          topFillet: Math.max(p.topFillet ?? 0, 0),
          bottomFillet: Math.max(p.bottomFillet ?? 0, 0),
          cornerSteps: Math.max(1, Math.min(64, Math.round(p.cornerSteps ?? 24))),
        },
      });
      break;
    }
    case "wedge": {
      const w = Math.max(p.width ?? 20, 0.1);
      const len = Math.max(p.length ?? 20, 0.1);
      const h = Math.max(p.height ?? 20, 0.1);
      // Like Triangle, a Wedge's origin belongs to its original sharp
      // construction profile. Rounding both lower corners removes the Y
      // extremes, so centring from the rounded bounds would slide the object.
      fixedXYCentre = [w / 2, len / 2];
      const legacyFillet = Math.max(p.fillet ?? 0, 0);
      const topCorner = Math.max(p.topFillet ?? legacyFillet, 0);
      const bottomCorner = Math.max(p.bottomFillet ?? legacyFillet, 0);
      const cornerSteps = Math.max(1, Math.min(64, Math.round(p.cornerSteps ?? 24)));
      const profile = roundPolygon2D(
        [[0, 0], [len, 0], [len, h]],
        [bottomCorner, bottomCorner, topCorner],
        cornerSteps,
      );
      let pen = draw(profile[0]);
      for (let i = 1; i < profile.length; i++) pen = pen.lineTo(profile[i]);
      s = pen.close().sketchOnPlane("YZ").extrude(w) as Shape3D;
      break;
    }
    case "polygonPrism": {
      const sides = Math.max(3, Math.min(32, Math.round(p.sides ?? 6)));
      const r = Math.max(p.radius ?? 10, 0.1);
      const h = Math.max(p.height ?? 20, 0.1);
      const fillet = Math.max(p.fillet ?? 0, 0);
      // The lofted rim can safely shrink all the way to the centre. Limiting
      // this to the polygon inradius left an unavoidable flat cap, especially
      // visible on polygons with fewer sides.
      const rimLimit = Math.max(0, Math.min(r, h));
      let topCorner = Math.min(Math.max(p.topFillet ?? 0, 0), rimLimit);
      let bottomCorner = Math.min(Math.max(p.bottomFillet ?? 0, 0), rimLimit);
      if (topCorner + bottomCorner > h) {
        const scale = h / (topCorner + bottomCorner);
        topCorner *= scale;
        bottomCorner *= scale;
      }
      const basePts: [number, number][] = [];
      for (let i = 0; i < sides; i++) {
        const a = (i * 2 * Math.PI) / sides;
        basePts.push([r * Math.cos(a), r * Math.sin(a)]);
      }
      const xs = basePts.map(([x]) => x);
      const ys = basePts.map(([, y]) => y);
      fixedXYCentre = [
        (Math.min(...xs) + Math.max(...xs)) / 2,
        (Math.min(...ys) + Math.max(...ys)) / 2,
      ];
      const cornerSteps = Math.max(1, Math.min(64, Math.round(p.cornerSteps ?? 24)));
      const pts = roundPolygon2D(basePts, fillet, cornerSteps);
      let pen = draw(pts[0]);
      for (let i = 1; i < pts.length; i++) {
        pen = pen.lineTo(pts[i]);
      }
      if (topCorner <= 0 && bottomCorner <= 0) {
        s = pen.close().sketchOnPlane("XY").extrude(h) as Shape3D;
      } else {
        // Applying a BRep fillet to this rim treats every small segment of a
        // rounded side corner as a separate edge. Their fillet patches can
        // cross one another and produce the pinched/star-shaped solid. Build
        // the end rounds as matching profile rings instead, so Side, Top and
        // Bottom radius remain compatible.
        const axialSteps = Math.max(4, Math.min(24, cornerSteps));
        const rings: Array<{ inset: number; z: number }> = [];
        if (bottomCorner > 0) {
          for (let i = 0; i <= axialSteps; i++) {
            const angle = (Math.PI / 2) * i / axialSteps;
            rings.push({
              inset: bottomCorner * (1 - Math.sin(angle)),
              z: bottomCorner * (1 - Math.cos(angle)),
            });
          }
        } else {
          rings.push({ inset: 0, z: 0 });
        }
        if (topCorner > 0) {
          for (let i = 0; i <= axialSteps; i++) {
            const angle = (Math.PI / 2) * i / axialSteps;
            const ring = {
              inset: topCorner * (1 - Math.cos(angle)),
              z: h - topCorner + topCorner * Math.sin(angle),
            };
            const previous = rings[rings.length - 1];
            if (!previous || Math.abs(previous.z - ring.z) > 1e-7) rings.push(ring);
          }
        } else if (Math.abs(rings[rings.length - 1].z - h) > 1e-7) {
          rings.push({ inset: 0, z: h });
        }
        const startsAtPoint = rings[0].inset >= r - 1e-7;
        const endsAtPoint = rings[rings.length - 1].inset >= r - 1e-7;
        const solidRings = rings.filter(({ inset }) => inset < r - 1e-7);
        const profileSketch = ({ inset, z }: { inset: number; z: number }) => {
          const scale = (r - inset) / r;
          const ringPts = pts.map(([x, y]) => [x * scale, y * scale] as [number, number]);
          let ringPen = draw(ringPts[0]);
          for (let i = 1; i < ringPts.length; i++) ringPen = ringPen.lineTo(ringPts[i]);
          return ringPen.close().sketchOnPlane("XY", z) as Sketch;
        };
        const sketches = solidRings.map(profileSketch);
        s = sketches[0].loftWith(sketches.slice(1), {
          ruled: true,
          ...(startsAtPoint ? { startPoint: [0, 0, 0] as [number, number, number] } : {}),
          ...(endsAtPoint ? { endPoint: [0, 0, h] as [number, number, number] } : {}),
        }) as Shape3D;
      }
      break;
    }
    case "hemisphere": {
      const r = Math.max(p.radius ?? 10, 0.1);
      const sphere = makeSphere(r);
      const cutBox = makeBaseBox(r * 4, r * 4, r * 2).translate([0, 0, -r * 2]);
      s = sphere.cut(cutBox) as Shape3D;
      const bottomCorner = Math.min(Math.max(p.bottomFillet ?? 0, 0), r * 0.49);
      if (bottomCorner > 0) {
        try {
          s = s.fillet(bottomCorner, (edge) => edge.inPlane("XY", 0));
        } catch {
          // Retain the valid unrounded dome if OCCT rejects an extreme value.
        }
      }
      break;
    }
    case "capsule": {
      const r = Math.max(p.radius ?? 5, 0.1);
      const totalH = Math.max(p.height ?? 20, r * 2);
      const cylinderH = Math.max(totalH - 2 * r, 0.001);
      const cylinder = makeCylinder(r, cylinderH).translate([0, 0, r]);
      const bottomSphere = makeSphere(r).translate([0, 0, r]);
      const topSphere = makeSphere(r).translate([0, 0, r + cylinderH]);
      s = cylinder.fuse(bottomSphere).fuse(topSphere) as Shape3D;
      break;
    }
    case "tube": {
      const rOut = Math.max(p.radius ?? 15, 0.1);
      const wall = Math.min(Math.max(p.wallThickness ?? 3, 0.05), rOut - 0.05);
      const rIn = Math.max(rOut - wall, 0.01);
      const h = Math.max(p.height ?? 10, 0.1);
      const sides = Math.max(3, Math.min(64, Math.round(p.sides ?? 32)));
      const legacyBevel = Math.max(p.bevel ?? 0, 0);
      const maxRim = Math.max(0, Math.min(wall / 2, h / 2) - 0.001);
      const outerTop = Math.min(Math.max(p.outerTopFillet ?? legacyBevel, 0), maxRim);
      const outerBottom = Math.min(Math.max(p.outerBottomFillet ?? legacyBevel, 0), maxRim);
      const innerTop = Math.min(Math.max(p.innerTopFillet ?? legacyBevel, 0), maxRim);
      const innerBottom = Math.min(Math.max(p.innerBottomFillet ?? legacyBevel, 0), maxRim);

      if (sides >= 32) {
        // Revolve the 2D annular profile directly with true circular arcs.
        // This avoids OCCT BRepFillet seam artifacts while producing an exact analytic
        // toroidal blend surface for each rounded rim.
        let pen = draw([rIn, h - innerTop]);

        // Inner vertical wall down
        pen = pen.lineTo([rIn, innerBottom]);

        // Bottom-inner corner
        if (innerBottom > 0) {
          const cx = rIn + innerBottom;
          const cy = innerBottom;
          const mid = [cx + innerBottom * Math.cos(5 * Math.PI / 4), cy + innerBottom * Math.sin(5 * Math.PI / 4)] as [number, number];
          pen = pen.threePointsArcTo([rIn + innerBottom, 0], mid);
        }

        // Bottom wall
        pen = pen.lineTo([rOut - outerBottom, 0]);

        // Bottom-outer corner
        if (outerBottom > 0) {
          const cx = rOut - outerBottom;
          const cy = outerBottom;
          const mid = [cx + outerBottom * Math.cos(-Math.PI / 4), cy + outerBottom * Math.sin(-Math.PI / 4)] as [number, number];
          pen = pen.threePointsArcTo([rOut, outerBottom], mid);
        }

        // Outer vertical wall up
        pen = pen.lineTo([rOut, h - outerTop]);

        // Top-outer corner
        if (outerTop > 0) {
          const cx = rOut - outerTop;
          const cy = h - outerTop;
          const mid = [cx + outerTop * Math.cos(Math.PI / 4), cy + outerTop * Math.sin(Math.PI / 4)] as [number, number];
          pen = pen.threePointsArcTo([rOut - outerTop, h], mid);
        }

        // Top wall
        pen = pen.lineTo([rIn + innerTop, h]);

        // Top-inner corner
        if (innerTop > 0) {
          const cx = rIn + innerTop;
          const cy = h - innerTop;
          const mid = [cx + innerTop * Math.cos(3 * Math.PI / 4), cy + innerTop * Math.sin(3 * Math.PI / 4)] as [number, number];
          pen = pen.threePointsArcTo([rIn, h - innerTop], mid);
        }

        s = pen.close().sketchOnPlane("XZ").revolve([0, 0, 1]) as Shape3D;
      } else {
        const dTheta = (2 * Math.PI) / sides;
        const outPts: [number, number][] = [];
        const inPts: [number, number][] = [];
        for (let i = 0; i < sides; i++) {
          const a = i * dTheta;
          outPts.push([rOut * Math.cos(a), rOut * Math.sin(a)]);
          inPts.push([rIn * Math.cos(a), rIn * Math.sin(a)]);
        }
        let penOut = draw(outPts[0]);
        let penIn = draw(inPts[0]);
        for (let i = 1; i < sides; i++) {
          penOut = penOut.lineTo(outPts[i]);
          penIn = penIn.lineTo(inPts[i]);
        }
        const outer = penOut.close().sketchOnPlane("XY").extrude(h) as Shape3D;
        const inner = penIn.close().sketchOnPlane("XY").extrude(h + 2).translate([0, 0, -1]) as Shape3D;
        s = outer.cut(inner) as Shape3D;
      }
      break;
    }
    case "paraboloid": {
      const R = Math.max(p.radius ?? 10, 0.1);
      const h = Math.max(p.height ?? 20, 0.1);
      const steps = Math.max(4, Math.min(64, Math.round(p.surfaceSteps ?? 32)));
      const bottomCorner = Math.min(Math.max(p.bottomFillet ?? 0, 0), R, h - 0.01);
      const baseRadius = Math.max(0, R - bottomCorner);
      let pen = draw([0, 0]);
      // At the maximum radius the bottom closes at the axis, so there is no
      // flat base segment to add. A centre-to-centre line is zero length and
      // makes the revolved profile invalid.
      if (baseRadius > 1e-7) pen = pen.lineTo([baseRadius, 0]);
      if (bottomCorner > 0) {
        // i=0 is already the endpoint of the base line above. Starting at 1
        // avoids a zero-length segment that OCCT rejects during revolve.
        for (let i = 1; i <= steps; i++) {
          const angle = -Math.PI / 2 + Math.PI / 2 * i / steps;
          pen = pen.lineTo([
            R - bottomCorner + bottomCorner * Math.cos(angle),
            bottomCorner + bottomCorner * Math.sin(angle),
          ]);
        }
      }
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const r_i = R * (1 - t);
        const z_i = bottomCorner + (h - bottomCorner) * (1 - (r_i / R) ** 2);
        pen = pen.lineTo([r_i, z_i]);
      }
      s = pen.close().sketchOnPlane("XZ").revolve([0, 0, 1]) as Shape3D;
      break;
    }
    case "text": {
      const thickness = Math.max(p.thickness ?? 4, 0.1);
      const size = Math.max(p.size ?? 20, 1);
      if (spec.textPaths && spec.textPaths.length) {
        // Text stays a direct extrusion. Saved files from the experimental
        // rounded-text versions may still contain radius/smoothness params;
        // deliberately ignore them so those scenes recover and open quickly.
        const solid = svgMeshSolid(spec.textPaths as any, thickness);
        if (solid) {
          s = normalise(solid);
          break;
        }
      }
      s = makeBaseBox(size * 2.5, size * 0.7, thickness);
      break;
    }
    case "connector": {
      s = makeConnectorSolid(p);
      break;
    }
    case "screwHole": {
      s = makeScrewHoleSolid(p);
      break;
    }
    case "hinge": {
      s = makeHingeSolid(p);
      break;
    }
    case "threadedRod": {
      s = makeThreadedRodSolid(p);
      break;
    }
    case "threadedNut": {
      s = makeThreadedNutSolid(p);
      break;
    }
    case "star": {
      const numPoints = Math.max(3, Math.min(32, Math.round(p.points ?? 5)));
      const rOut = Math.max(p.outerRadius ?? 15, 0.1);
      const rIn = Math.max(p.innerRadius ?? 7.5, 0.1);
      const height = Math.max(p.height ?? 10, 0.1);
      const style = p.style ?? 0;

      if (style === 0) {
        // Flat extruded 2D Star Prism with optional corner radius
        const dTheta = Math.PI / numPoints;
        const rawPts: [number, number][] = [];
        for (let i = 0; i < numPoints * 2; i++) {
          const r = i % 2 === 0 ? rOut : rIn;
          const a = i * dTheta - Math.PI / 2;
          rawPts.push([r * Math.cos(a), r * Math.sin(a)]);
        }
        const rawXs = rawPts.map(([x]) => x);
        const rawYs = rawPts.map(([, y]) => y);
        fixedXYCentre = [
          (Math.min(...rawXs) + Math.max(...rawXs)) / 2,
          (Math.min(...rawYs) + Math.max(...rawYs)) / 2,
        ];
        const legacyFillet = Math.max(p.fillet ?? 0, 0);
        const outerFillet = Math.max(p.outerFillet ?? legacyFillet, 0);
        const innerFillet = Math.max(p.innerFillet ?? legacyFillet, 0);
        const cornerSteps = Math.max(1, Math.min(64, Math.round(p.cornerSteps ?? 24)));
        const cornerRadii = rawPts.map((_, i) => i % 2 === 0 ? outerFillet : innerFillet);
        const pts = roundPolygon2D(rawPts, cornerRadii, cornerSteps);
        const topCorner = Math.min(Math.max(p.topFillet ?? 0, 0), rOut);
        const bottomCorner = Math.min(Math.max(p.bottomFillet ?? 0, 0), rOut);
        // Radial inset and vertical span are separate. A short, wide Star can
        // still close at the centre, while both end rounds share the available
        // height instead of one slider disabling the other.
        const requestedSpan = topCorner + bottomCorner;
        const spanScale = requestedSpan > height ? height / requestedSpan : 1;
        const topSpan = topCorner * spanScale;
        const bottomSpan = bottomCorner * spanScale;
        const profileSketch = (scale: number, z: number) => {
          const ringPts = pts.map(([x, y]) => [x * scale, y * scale] as [number, number]);
          let ringPen = draw(ringPts[0]);
          for (let i = 1; i < ringPts.length; i++) ringPen = ringPen.lineTo(ringPts[i]);
          return ringPen.close().sketchOnPlane("XY", z) as Sketch;
        };
        if (topCorner <= 0 && bottomCorner <= 0) {
          s = profileSketch(1, 0).extrude(height) as Shape3D;
        } else {
          const axialSteps = Math.max(4, Math.min(24, cornerSteps));
          const rings: Array<{ scale: number; z: number }> = [];
          if (bottomCorner > 0) {
            for (let i = 0; i <= axialSteps; i++) {
              const angle = Math.PI / 2 * i / axialSteps;
              rings.push({
                scale: 1 - bottomCorner * (1 - Math.sin(angle)) / rOut,
                z: bottomSpan * (1 - Math.cos(angle)),
              });
            }
          } else rings.push({ scale: 1, z: 0 });
          if (topCorner > 0) {
            for (let i = 0; i <= axialSteps; i++) {
              const angle = Math.PI / 2 * i / axialSteps;
              const ring = {
                scale: 1 - topCorner * (1 - Math.cos(angle)) / rOut,
                z: height - topSpan + topSpan * Math.sin(angle),
              };
              if (Math.abs(rings[rings.length - 1].z - ring.z) > 1e-7) rings.push(ring);
            }
          } else if (Math.abs(rings[rings.length - 1].z - height) > 1e-7) {
            rings.push({ scale: 1, z: height });
          }
          const startsAtPoint = rings[0].scale <= 1e-7;
          const endsAtPoint = rings[rings.length - 1].scale <= 1e-7;
          const sketches = rings.filter(({ scale }) => scale > 1e-7).map(({ scale, z }) => profileSketch(scale, z));
          s = sketches[0].loftWith(sketches.slice(1), {
            ruled: true,
            ...(startsAtPoint ? { startPoint: [0, 0, 0] as [number, number, number] } : {}),
            ...(endsAtPoint ? { endPoint: [0, 0, height] as [number, number, number] } : {}),
          }) as Shape3D;
        }
      } else {
        // Faceted 3D Star (Pyramidal Star with center apex)
        const manifold = getManifold();
        const dTheta = Math.PI / numPoints;
        const verts: number[] = [];
        const tris: number[] = [];

        // Perimeter base vertices [0 ... 2*numPoints - 1]
        for (let i = 0; i < numPoints * 2; i++) {
          const r = i % 2 === 0 ? rOut : rIn;
          const a = i * dTheta - Math.PI / 2;
          verts.push(r * Math.cos(a), r * Math.sin(a), 0);
        }

        const cBot = numPoints * 2;
        verts.push(0, 0, 0); // Bottom center

        const cTop = numPoints * 2 + 1;
        verts.push(0, 0, height); // Top apex

        const N = numPoints * 2;
        for (let i = 0; i < N; i++) {
          const next = (i + 1) % N;
          // Top sloping triangular facets
          tris.push(cTop, i, next);
          // Bottom flat base fan
          tris.push(cBot, next, i);
        }

        const starMesh = new manifold.Mesh({
          vertProperties: new Float32Array(verts),
          triVerts: new Uint32Array(tris),
          numProp: 3,
        });
        s = new MeshShape(new manifold.Manifold(starMesh));
      }
      break;
    }
    case "tray": {
      const w = Math.max(p.width ?? 60, 2);
      const d = Math.max(p.depth ?? 30, 2);
      const h = Math.max(p.height ?? 20, 1);
      const wall = Math.min(Math.max(p.wallThickness ?? 2, 0.4), Math.min(w, d) / 2 - 0.2);
      const floor = Math.min(Math.max(p.floorThickness ?? 2, 0.4), h - 0.5);
      const maxFillet = Math.min(w, d) / 2 - 0.01;
      const cornerR = Math.min(Math.max(p.cornerRadius ?? 4, 0), maxFillet);
      const inCornerR = Math.max(0, cornerR - wall);
      const maxInsideFillet = Math.min(h - floor - 0.2, (Math.min(w, d) - wall * 2) / 2 - 0.2);
      const insideFillet = Math.min(Math.max(p.internalFillet ?? 0, 0), Math.max(0, maxInsideFillet));

      // 1. Outer solid with uniform corner radius via 2D sketch
      const outerRect: [number, number][] = [
        [-w / 2, -d / 2],
        [w / 2, -d / 2],
        [w / 2, d / 2],
        [-w / 2, d / 2],
      ];
      const outerPts = roundPolygon2D(outerRect, cornerR, 12);
      let penOut = draw(outerPts[0]);
      for (let i = 1; i < outerPts.length; i++) penOut = penOut.lineTo(outerPts[i]);
      const outer = penOut.close().sketchOnPlane("XY").extrude(h) as Shape3D;

      // 2. Inner cavity with matching corner radius and uniform walls
      const inW = w - wall * 2;
      const inD = d - wall * 2;
      const inH = h - floor + 2;

      const innerRect: [number, number][] = [
        [-inW / 2, -inD / 2],
        [inW / 2, -inD / 2],
        [inW / 2, inD / 2],
        [-inW / 2, inD / 2],
      ];
      const innerPts = roundPolygon2D(innerRect, inCornerR, 12);
      let penIn = draw(innerPts[0]);
      for (let i = 1; i < innerPts.length; i++) penIn = penIn.lineTo(innerPts[i]);
      let inner = penIn.close().sketchOnPlane("XY").extrude(inH) as Shape3D;

      if (insideFillet > 0.05) {
        try {
          inner = inner.fillet(insideFillet, (e) => e.inPlane("XY", 0));
        } catch {
          try {
            inner = inner.fillet(insideFillet, (e) => e.inPlane("XY"));
          } catch {}
        }
      }

      // 3. Cut inner pocket from outer solid
      s = outer.cut(inner.translate([0, 0, floor]));
      break;
    }
    case "ellipsoid": {
      const rx = Math.max(p.radiusX ?? 15, 0.1);
      const ry = Math.max(p.radiusY ?? 10, 0.1);
      const rz = Math.max(p.radiusZ ?? 10, 0.1);
      // Older documents stored one of four density presets. New documents use
      // a direct, predictable surface-step value, while this fallback keeps
      // those saved shapes looking as they did before.
      const legacyDensity = p.density ?? 1;
      const legacySteps = legacyDensity === 0 ? 16 : legacyDensity === 2 ? 64 : legacyDensity === 3 ? 64 : 32;
      const divs = Math.max(8, Math.min(64, Math.round(p.surfaceSteps ?? legacySteps)));
      const manifold = getManifold();
      const sphere = manifold.Manifold.sphere(1, divs).scale([rx, ry, rz]);
      s = new MeshShape(sphere);
      break;
    }
    case "gear": {
      const z = Math.max(4, Math.min(100, Math.round(p.teeth ?? 16)));
      const height = Math.max(p.height ?? 6, 0.1);
      const sizeBy = p.sizeBy ?? 0;

      let m: number;
      let rp: number;
      if (sizeBy === 1) {
        m = Math.max(0.2, p.module ?? 1.5);
        rp = (m * z) / 2;
      } else {
        rp = Math.max(1, p.radius ?? 15);
        m = (2 * rp) / z;
      }

      const kStub = Math.min(1.0, 0.45 + z / 22);
      const ha = m * 0.88 * kStub;
      const hf = m * 1.08 * kStub;
      const ra = rp + ha;
      const rf = Math.max(rp * 0.35, rp - hf);
      const rootRadius = rf;

      const toothPitch = (2 * Math.PI) / z;
      const psiPitch = (toothPitch / 4) * 0.94;
      const psiRoot = Math.min(toothPitch * 0.31, psiPitch * 1.32);
      const psiTip = psiPitch * 0.40;
      const rMid = (rp + ra) / 2;
      const psiMid = ((psiPitch + psiTip) / 2) * 1.03;
      const rLow = (rf + rp) / 2;
      const psiLow = ((psiRoot + psiPitch) / 2) * 0.98;

      const pts: [number, number][] = [];
      for (let i = 0; i < z; i++) {
        const ca = i * toothPitch;
        pts.push([rf * Math.cos(ca - psiRoot), rf * Math.sin(ca - psiRoot)]);
        pts.push([rLow * Math.cos(ca - psiLow), rLow * Math.sin(ca - psiLow)]);
        pts.push([rp * Math.cos(ca - psiPitch), rp * Math.sin(ca - psiPitch)]);
        pts.push([rMid * Math.cos(ca - psiMid), rMid * Math.sin(ca - psiMid)]);
        pts.push([ra * Math.cos(ca - psiTip), ra * Math.sin(ca - psiTip)]);
        pts.push([ra * Math.cos(ca + psiTip), ra * Math.sin(ca + psiTip)]);
        pts.push([rMid * Math.cos(ca + psiMid), rMid * Math.sin(ca + psiMid)]);
        pts.push([rp * Math.cos(ca + psiPitch), rp * Math.sin(ca + psiPitch)]);
        pts.push([rLow * Math.cos(ca + psiLow), rLow * Math.sin(ca + psiLow)]);
        pts.push([rf * Math.cos(ca + psiRoot), rf * Math.sin(ca + psiRoot)]);
        const vMid = ca + toothPitch * 0.5;
        const v1 = ca + psiRoot + (vMid - (ca + psiRoot)) * 0.45;
        const v2 = vMid + ((ca + toothPitch - psiRoot) - vMid) * 0.55;
        pts.push([rf * Math.cos(v1), rf * Math.sin(v1)]);
        pts.push([rf * Math.cos(v2), rf * Math.sin(v2)]);
      }

      let pen = draw(pts[0]);
      for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);
      s = pen.close().sketchOnPlane("XY").extrude(height) as Shape3D;

      const shaft = p.shaftType ?? 0;
      const maxBore = shaft === 2 ? (rootRadius - 0.5) / Math.SQRT2 : rootRadius - 0.5;
      const boreRadius = Math.min(Math.max(p.boreRadius ?? 0, 0), Math.max(0, maxBore));
      if (boreRadius > 0) {
        if (shaft === 1) {
          const flatDist = boreRadius * 0.75;
          const boxW = boreRadius * 4;
          const boxD = boreRadius * 2;
          const boxH = height * 2;
          const flatBox = makeBaseBox(boxW, boxD, boxH).translate([
            0,
            flatDist + boxD / 2,
            -height * 0.5,
          ]);
          const dShaftCutter = makeCylinder(boreRadius, height).cut(flatBox);
          s = s.cut(dShaftCutter) as Shape3D;
        } else if (shaft === 2) {
          const side = boreRadius * 2;
          const sqBox = makeBaseBox(side, side, height * 2).translate([0, 0, -height * 0.5]);
          s = s.cut(sqBox) as Shape3D;
        } else {
          s = s.cut(makeCylinder(boreRadius, height)) as Shape3D;
        }
      }
      break;
    }
    case "washer": {
      const outerRadius = Math.max(p.outerRadius ?? 10, 0.1);
      const innerRadius = Math.min(Math.max(p.innerRadius ?? 4, 0.01), outerRadius - 0.05);
      const height = Math.max(p.height ?? 2, 0.1);
      s = makeCylinder(outerRadius, height).cut(makeCylinder(innerRadius, height)) as Shape3D;
      break;
    }
    case "bearing": {
      const R = Math.max(p.outerRadius ?? 11, 0.5);
      const r = Math.min(Math.max(p.innerRadius ?? 4, 0.2), R - 0.5);
      const H = Math.max(p.height ?? 7, 0.5);
      const span = R - r;
      const tOut = Math.max(0.6, Math.min(span * 0.28, 4));
      const tIn = Math.max(0.6, Math.min(span * 0.28, 4));
      const rInnerOuter = r + tIn;
      const rOuterInner = R - tOut;
      const ch = Math.max(0, Math.min(p.chamfer ?? 0.5, Math.min(tIn, tOut) * 0.65, H * 0.3));
      const chRace = Math.min(ch * 0.6, Math.min(tIn, tOut) * 0.3);
      const isOpen = (p.style ?? 0) === 1;

      if (!isOpen) {
        const rec = Math.max(0.1, Math.min(p.shieldRecess ?? 0.6, H * 0.25));
        let pen = draw([r + ch, 0])
          .lineTo([rInnerOuter, 0])
          .lineTo([rInnerOuter, rec])
          .lineTo([rOuterInner, rec])
          .lineTo([rOuterInner, 0])
          .lineTo([R - ch, 0]);

        if (ch > 0) {
          pen = pen.lineTo([R, ch]).lineTo([R, H - ch]).lineTo([R - ch, H]);
        } else {
          pen = pen.lineTo([R, H]);
        }

        pen = pen
          .lineTo([rOuterInner, H])
          .lineTo([rOuterInner, H - rec])
          .lineTo([rInnerOuter, H - rec])
          .lineTo([rInnerOuter, H])
          .lineTo([r + ch, H]);

        if (ch > 0) {
          pen = pen.lineTo([r, H - ch]).lineTo([r, ch]);
        } else {
          pen = pen.lineTo([r, 0]);
        }

        s = pen.close().sketchOnPlane("XZ").revolve([0, 0, 1]) as Shape3D;
      } else {
        const rPitch = (rInnerOuter + rOuterInner) / 2;
        const channelWidth = rOuterInner - rInnerOuter;
        const rawBallRadius = Math.min(channelWidth / 2 * 0.92, H * 0.42);
        const clearance = Math.max(0.1, Math.min(p.clearance ?? 0.35, 1.0));
        const ballRadius = Math.max(0.2, rawBallRadius - clearance / 2);
        const grooveDepth = Math.max(0.1, Math.min(ballRadius * 0.35, 1.0));
        const grooveHalfH = Math.min(ballRadius * 0.8, H * 0.35);

        const outerProfile: [number, number][] = [];
        if (chRace > 0) {
          outerProfile.push([rOuterInner + chRace, 0]);
        } else {
          outerProfile.push([rOuterInner, 0]);
        }
        if (ch > 0) {
          outerProfile.push([R - ch, 0], [R, ch], [R, H - ch], [R - ch, H]);
        } else {
          outerProfile.push([R, 0], [R, H]);
        }
        if (chRace > 0) {
          outerProfile.push([rOuterInner + chRace, H], [rOuterInner, H - chRace]);
        } else {
          outerProfile.push([rOuterInner, H]);
        }
        outerProfile.push([rOuterInner, H / 2 + grooveHalfH]);
        outerProfile.push([rOuterInner + grooveDepth, H / 2]);
        outerProfile.push([rOuterInner, H / 2 - grooveHalfH]);
        if (chRace > 0) {
          outerProfile.push([rOuterInner, chRace]);
        }

        let penOut = draw(outerProfile[0]);
        for (let i = 1; i < outerProfile.length; i++) penOut = penOut.lineTo(outerProfile[i]);
        const outerSolid = penOut.close().sketchOnPlane("XZ").revolve([0, 0, 1]) as Shape3D;

        const innerProfile: [number, number][] = [];
        if (ch > 0) {
          innerProfile.push([r + ch, 0]);
        } else {
          innerProfile.push([r, 0]);
        }
        if (chRace > 0) {
          innerProfile.push([rInnerOuter - chRace, 0], [rInnerOuter, chRace]);
        } else {
          innerProfile.push([rInnerOuter, 0]);
        }
        innerProfile.push([rInnerOuter, H / 2 - grooveHalfH]);
        innerProfile.push([rInnerOuter - grooveDepth, H / 2]);
        innerProfile.push([rInnerOuter, H / 2 + grooveHalfH]);
        if (chRace > 0) {
          innerProfile.push([rInnerOuter, H - chRace], [rInnerOuter - chRace, H]);
        } else {
          innerProfile.push([rInnerOuter, H]);
        }
        if (ch > 0) {
          innerProfile.push([r + ch, H], [r, H - ch], [r, ch]);
        } else {
          innerProfile.push([r, H]);
        }

        let penIn = draw(innerProfile[0]);
        for (let i = 1; i < innerProfile.length; i++) penIn = penIn.lineTo(innerProfile[i]);
        const innerSolid = penIn.close().sketchOnPlane("XZ").revolve([0, 0, 1]) as Shape3D;

        const count = Math.max(5, Math.min(16, Math.round(p.ballCount ?? 8)));
        const ballSolids: Shape3D[] = [];
        for (let i = 0; i < count; i++) {
          const theta = i * (2 * Math.PI / count);
          const bx = rPitch * Math.cos(theta);
          const by = rPitch * Math.sin(theta);
          const bz = H / 2;
          ballSolids.push(makeSphere(ballRadius).translate([bx, by, bz]));
        }

        const solids: Shape3D[] = [outerSolid, innerSolid, ...ballSolids];

        const showCage = (p.cage ?? 1) === 1;
        if (showCage) {
          const cageHalfWidth = Math.min(channelWidth * 0.32, ballRadius * 0.75);
          const cageRIn = rPitch - cageHalfWidth;
          const cageROut = rPitch + cageHalfWidth;
          const baseH = Math.max(0.3, Math.min(ballRadius * 0.38, H * 0.14));
          const zBase0 = Math.max(0.15, H / 2 - ballRadius * 0.92);
          const dBall = 2 * rPitch * Math.sin(Math.PI / count);
          const gap = Math.max(0.1, dBall - 2 * ballRadius);
          const pillarR = Math.max(0.15, Math.min(gap * 0.35, cageHalfWidth * 0.85));
          const pillarH = (H / 2 + ballRadius * 0.45) - zBase0;

          const baseRing = makeCylinder(cageROut, baseH)
            .cut(makeCylinder(cageRIn, baseH))
            .translate([0, 0, zBase0]) as Shape3D;

          const cageParts: Shape3D[] = [baseRing];
          for (let i = 0; i < count; i++) {
            const midTheta = (i + 0.5) * (2 * Math.PI / count);
            const px = rPitch * Math.cos(midTheta);
            const py = rPitch * Math.sin(midTheta);
            cageParts.push(makeCylinder(pillarR, pillarH).translate([px, py, zBase0]) as Shape3D);
          }

          try {
            let fused = cageParts[0];
            for (let k = 1; k < cageParts.length; k++) {
              fused = fused.fuse(cageParts[k]) as Shape3D;
            }
            solids.push(fused);
          } catch {
            solids.push(...cageParts);
          }
        }

        s = makeCompound(solids) as Shape3D;
      }
      break;
    }
    case "spring": {
      s = makeSpringSolid(p);
      break;
    }
  }

  if (spec.kind === "connector" || spec.kind === "screwHole") {
    // Connector and screwHole solids already define their exact mounting plane (z=0 is surface,
    // centered in XY). They must never be normalized or shifted by normalise().
    return s;
  }

  if (fixedXYCentre) {
    const [min] = getSolidBounds(s);
    return s.translate([-fixedXYCentre[0], -fixedXYCentre[1], -min[2]]);
  }
  return normalise(s);
}

export function getSolidBounds(s: AnySolid): [[number, number, number], [number, number, number]] {
  if (isMesh(s)) {
    try {
      const wrapped = (s as any).wrapped;
      if (wrapped && typeof wrapped.boundingBox === "function") {
        const box = wrapped.boundingBox();
        if (box && box.min && box.max) {
          const getVal = (obj: any, idx: number, key: string) => Number(obj[idx] ?? obj[key]);
          const min: [number, number, number] = [getVal(box.min, 0, "x"), getVal(box.min, 1, "y"), getVal(box.min, 2, "z")];
          const max: [number, number, number] = [getVal(box.max, 0, "x"), getVal(box.max, 1, "y"), getVal(box.max, 2, "z")];
          if (Number.isFinite(min[0]) && Number.isFinite(min[1]) && Number.isFinite(min[2]) &&
              Number.isFinite(max[0]) && Number.isFinite(max[1]) && Number.isFinite(max[2])) {
            return [min, max];
          }
        }
      }
    } catch {}

    try {
      const b = (s as any).boundingBox?.bounds;
      if (b && b[0] && b[1]) {
        const min: [number, number, number] = [Number(b[0][0] ?? b[0].x), Number(b[0][1] ?? b[0].y), Number(b[0][2] ?? b[0].z)];
        const max: [number, number, number] = [Number(b[1][0] ?? b[1].x), Number(b[1][1] ?? b[1].y), Number(b[1][2] ?? b[1].z)];
        if (Number.isFinite(min[0]) && Number.isFinite(max[0])) {
          return [min, max];
        }
      }
    } catch {}

    const raw = (s as any).mesh ? (s as any).mesh() : (s as any).wrapped?.getMesh?.();
    const vertices = raw?.vertProperties || raw?.vertices || [];
    const stride = raw?.numProp || 3;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < vertices.length; i += stride) {
      const x = Number(vertices[i]), y = Number(vertices[i + 1]), z = Number(vertices[i + 2]);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    if (!Number.isFinite(minX)) return [[0, 0, 0], [0, 0, 0]];
    return [[minX, minY, minZ], [maxX, maxY, maxZ]];
  }
  const [min, max] = s.boundingBox.bounds;
  return [min, max];
}

/** Centres a shape in XY and drops its base to z = 0 — the one origin
 *  convention every local shape shares, primitive or imported. */
function normalise<T extends AnySolid>(s: T): T {
  const [min, max] = getSolidBounds(s);
  const offset: [number, number, number] = [
    -(min[0] + max[0]) / 2,
    -(min[1] + max[1]) / 2,
    -min[2],
  ];
  if (isMesh(s)) {
    return new MeshShape(s.wrapped.translate(offset)) as T;
  }
  return s.translate(offset) as T;
}

/**
 * Loads a previously-imported STL. The file bytes live in IndexedDB (see
 * blobStore.ts), keyed by blobId — the worker fetches them itself rather than
 * having the main thread ship the bytes over postMessage on every build.
 *
 * Uses importSTLAsMesh (manifold-3d), not importSTL (OCCT/BRep): the BRep
 * path hits a raw, uncatchable WebAssembly exception partway through solid
 * reconstruction in this WASM build — reproduced even round-tripping OCCT's
 * OWN STL export back through its OWN importer, so it is not a malformed-file
 * issue, it is this build. importSTLAsMesh sidesteps that path entirely.
 * See combine() for how this then composes with ordinary Shape3D primitives.
 *
 * Memoized by blobId (never a cache-miss twice for the same file): parsing +
 * manifold repair is the single most expensive step an import can trigger,
 * and blobId never changes for a node's lifetime, so every caller — the edit
 * view, the merged-result preview, export, or the same file imported more
 * than once — shares one parse instead of repeating it.
 */
const importCache = new Map<string, Promise<MeshShape>>();

async function makeImport(spec: ImportSpec): Promise<AnySolid> {
  // Vector artwork: the blob is millimetre outlines, and the solid is those
  // outlines extruded. Nothing here needs the mesh kernel.
  if (spec.svg) {
    const blob = await getBlob(spec.blobId);
    if (!blob) throw new Error("The artwork for this import is missing.");
    const paths = JSON.parse(new TextDecoder().decode(blob)) as SvgCommand[][];
    const solid = svgMeshSolid(paths, Math.max(0.01, spec.svg.thickness));
    if (!solid) throw new Error("No closed outlines in that artwork to build from.");
    return normalise(solid);
  }

  let cached = importCache.get(spec.blobId);
  if (!cached) {
    cached = loadImport(spec.blobId);
    // A failed parse must not stick around as a poisoned cache entry — the
    // next attempt (e.g. after the user re-imports) should get a clean try.
    cached.catch(() => importCache.delete(spec.blobId));
    importCache.set(spec.blobId, cached);
  }
  return cached;
}

async function loadImport(blobId: string): Promise<MeshShape> {
  const bytes = await getBlob(blobId);
  if (!bytes) {
    throw new InvalidShapeError(
      "This imported file is missing from browser storage (site data may have been cleared).",
    );
  }
  const blob = new Blob([bytes], { type: "model/stl" });
  const shape = await importSTLAsMesh(blob);
  return normalise(shape);
}

export function exportManifoldToBinarySTL(mesh: {
  numProp: number;
  vertProperties: Float32Array;
  triVerts: Uint32Array;
}): ArrayBuffer {
  const numTri = mesh.triVerts.length / 3;
  const numProp = mesh.numProp;
  const buffer = new ArrayBuffer(84 + numTri * 50);
  const view = new DataView(buffer);
  view.setUint32(80, numTri, true);
  let offset = 84;
  const vp = mesh.vertProperties;
  const tv = mesh.triVerts;
  for (let t = 0; t < numTri; t++) {
    const i0 = tv[t * 3] * numProp;
    const i1 = tv[t * 3 + 1] * numProp;
    const i2 = tv[t * 3 + 2] * numProp;
    const ax = vp[i0], ay = vp[i0 + 1], az = vp[i0 + 2];
    const bx = vp[i1], by = vp[i1 + 1], bz = vp[i1 + 2];
    const cx = vp[i2], cy = vp[i2 + 1], cz = vp[i2 + 2];
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-12) {
      nx /= len;
      ny /= len;
      nz /= len;
    } else {
      nx = 0;
      ny = 0;
      nz = 0;
    }
    view.setFloat32(offset, nx, true);
    view.setFloat32(offset + 4, ny, true);
    view.setFloat32(offset + 8, nz, true);
    view.setFloat32(offset + 12, ax, true);
    view.setFloat32(offset + 16, ay, true);
    view.setFloat32(offset + 20, az, true);
    view.setFloat32(offset + 24, bx, true);
    view.setFloat32(offset + 28, by, true);
    view.setFloat32(offset + 32, bz, true);
    view.setFloat32(offset + 36, cx, true);
    view.setFloat32(offset + 40, cy, true);
    view.setFloat32(offset + 44, cz, true);
    view.setUint16(offset + 48, 0, true);
    offset += 50;
  }
  return buffer;
}

export async function simplifyImport(
  blobId: string,
  targetRatio: number,
): Promise<{
  newBlobId: string;
  byteSize: number;
  trianglesBefore: number;
  trianglesAfter: number;
}> {
  const shape = await loadImport(blobId);
  const rawManifold = (shape as any).wrapped;
  const initialTri = rawManifold.numTri();

  if (initialTri <= 12) {
    return {
      newBlobId: blobId,
      byteSize: (await getBlob(blobId))?.byteLength ?? 0,
      trianglesBefore: initialTri,
      trianglesAfter: initialTri,
    };
  }

  const bb = rawManifold.boundingBox();
  const diag = Math.hypot(
    bb.max[0] - bb.min[0],
    bb.max[1] - bb.min[1],
    bb.max[2] - bb.min[2],
  );

  const safeRatio = Math.max(0.05, Math.min(0.95, targetRatio));
  const targetTri = initialTri * (1 - safeRatio);

  let low = Math.max(1e-5, diag * 0.0001);
  let high = Math.max(0.1, diag * 0.05);
  let best = rawManifold.simplify(diag * 0.002);

  for (let iter = 0; iter < 8; iter++) {
    const mid = (low + high) / 2;
    const test = rawManifold.simplify(mid);
    const count = test.numTri();
    if (Math.abs(count - targetTri) < Math.abs(best.numTri() - targetTri)) {
      best = test;
    }
    if (count > targetTri) {
      low = mid;
    } else {
      high = mid;
    }
  }

  const outMesh = best.getMesh();
  const resultBuffer = exportManifoldToBinarySTL(outMesh);
  const newBlobId = crypto.randomUUID();
  await putBlob(newBlobId, resultBuffer);

  const simplifiedShape = normalise(new MeshShape(best));
  importCache.set(newBlobId, Promise.resolve(simplifiedShape));

  return {
    newBlobId,
    byteSize: resultBuffer.byteLength,
    trianglesBefore: initialTri,
    trianglesAfter: best.numTri(),
  };
}

/**
 * Rebuilds a solid as a deliberately faceted, low-poly version of itself.
 *
 * This is real geometry, not a shading trick: the result is what gets sliced
 * and printed. Manifold's simplify() only ever collapses to a subset of the
 * existing vertices and keeps every surface within `facet` of where it was,
 * so the shape stays watertight and printable however coarse it gets.
 *
 * `even` first remeshes to a roughly uniform edge length. Without it a
 * cylinder decimates into long stringy slivers — its tessellation is dense
 * around the curve and sparse along the length, and simplify() can only work
 * with the vertices it is given. Remeshing first spreads vertices evenly, so
 * what survives reads as deliberate facets rather than damage. It costs
 * triangles up front, hence its own control rather than always-on.
 */
export interface LowPolySettings {
  /** How far a surface may move, in mm. Bigger means chunkier facets. */
  facet: number;
  /** Target edge length for the pre-pass, in mm. 0 skips it. */
  even: number;
}

/**
 * Faceting for a primitive that is a profile swept round an axis — anything
 * carrying a `sides` count (cylinder, cone, tube, polygon prism …).
 *
 * These have an obviously correct low-poly form: a REGULAR n-sided prism.
 * Decimating them instead gives an irregular one — simplify() collapses
 * whichever vertices happen to fit the tolerance, with no notion of symmetry,
 * so a cylinder came out with uneven side widths and a lopsided cap. Rebuilding
 * the primitive at a lower side count is both prettier and cheaper, and it
 * keeps the exact radius instead of pulling the surface inward.
 *
 * The side count is derived from the same "how far may a surface move"
 * measure the slider means everywhere else: a polygon inscribed in radius r
 * sits at most r(1 - cos(pi/n)) inside the circle, so solving that for n
 * turns a facet size in mm into a side count.
 *
 * Doubly-curved surfaces come through here too, via their own knobs — a
 * sphere's geodesic side count, an ellipsoid's surface steps, a torus's ring
 * and tube steps. They were left on decimation at first on the theory that
 * crystalline facets suited them; they do not. Decimation moved a 20mm
 * sphere's silhouette by more than a millimetre and by a different amount on
 * each axis, which is both ugly and wrong for a print.
 */

/** Sides needed for an inscribed polygon to stay within `facet` mm of a circle
 *  of radius r: the sagitta is r(1 - cos(pi/n)), solved for n. */
function sidesForFacet(radius: number, facet: number): number {
  const ratio = 1 - facet / radius;
  // A facet at or beyond the radius has no polygon solution; take the coarsest.
  if (ratio <= -1) return 3;
  return Math.floor(Math.PI / Math.acos(Math.max(-1, Math.min(1, ratio))));
}

/** The smooth-sphere side count. At or above this the sphere builder uses the
 *  exact B-Rep ball rather than a geodesic mesh. */
const SPHERE_SMOOTH_SIDES = 64;

type LowPolyKnob = { name: string; current: number; radius: number; floor: number };

/**
 * The parameter(s) that coarsen a primitive's curved surface, each paired with
 * the radius it is spread around and the lowest value its builder accepts.
 */
function lowPolyKnobs(spec: ObjectSpec): LowPolyKnob[] {
  const p = spec.params;
  const num = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  switch (spec.kind) {
    case "sphere":
      return [{
        name: "sides",
        current: num(p.sides, SPHERE_SMOOTH_SIDES),
        radius: num(p.radius, 10),
        floor: 4,
      }];
    case "ellipsoid":
      return [{
        name: "surfaceSteps",
        current: num(p.surfaceSteps, 32),
        radius: Math.max(num(p.radiusX, 10), num(p.radiusY, 10), num(p.radiusZ, 10)),
        floor: 8,
      }];
    case "torus":
      return [
        {
          name: "ringSteps",
          current: num(p.ringSteps, 48),
          radius: num(p.radius, 15) + num(p.tubeRadius, 5),
          floor: 8,
        },
        {
          name: "tubeSteps",
          current: num(p.tubeSteps, 32),
          radius: num(p.tubeRadius, 5),
          floor: 8,
        },
      ];
    default: {
      if (typeof p.sides !== "number" || !Number.isFinite(p.sides)) return [];
      const radius = [p.radius, p.outerRadius, p.bottomRadius, p.topRadius]
        .find((v): v is number => typeof v === "number" && v > 0)
        ?? Math.max(p.width ?? 0, p.depth ?? 0) / 2;
      return [{ name: "sides", current: p.sides, radius, floor: 3 }];
    }
  }
}

function lowPolyPrimitiveSpec(spec: ObjectSpec, settings: LowPolySettings): ObjectSpec | null {
  const facet = Math.max(0, settings.facet);
  if (facet <= 1e-6) return null;

  const params = { ...spec.params };
  let coarsened = false;
  for (const knob of lowPolyKnobs(spec)) {
    if (!(knob.radius > 0)) continue;
    const current = Math.round(knob.current);
    // Never ADD detail — this control only ever coarsens.
    const next = Math.max(knob.floor, Math.min(current, sidesForFacet(knob.radius, facet)));
    if (next < current) {
      params[knob.name] = next;
      coarsened = true;
    }
  }
  return coarsened ? { ...spec, params } : null;
}

function applyLowPoly(solid: AnySolid, settings: LowPolySettings): AnySolid {
  const facet = Math.max(0, settings.facet);
  if (facet <= 1e-6) return solid;
  const mesh = isMesh(solid) ? solid : (solid as Shape3D).meshShape(FALLBACK_MESH_QUALITY);
  let m = mesh.wrapped as unknown as {
    refineToLength(l: number): unknown;
    simplify(t: number): unknown;
    numTri(): number;
    volume(): number;
  };
  const even = Math.max(0, settings.even);
  if (even > 1e-6) m = m.refineToLength(even) as typeof m;
  m = m.simplify(facet) as typeof m;
  if (m.numTri() < 4 || m.volume() <= 1e-9) return solid;
  return new MeshShape(m as never);
}

/** True if a node or any of its descendants is an imported STL — those are
 *  MeshShapes, not Shape3Ds, so a group containing one anywhere below it must
 *  combine in MeshShape terms all the way up, not just at that one group. */
function hasImport(spec: NodeSpec): boolean {
  if (spec.type === "import") return true;
  if (spec.type === "group") return spec.children.some(hasImport);
  if (spec.type === "edit") return hasImport(spec.base);
  if (spec.type === "build") return spec.sources.some(hasImport);
  return false;
}

/**
 * Re-locates, on the CURRENT shape, the same planar face a PushPullOp was
 * created against — it cannot be addressed by index, since a later op's
 * target face is only created once earlier ops have already reshaped the
 * solid. "Same face" here means: still planar, facing the same way, lying
 * in the same plane as the point recorded when the op was made, AND that
 * point actually falling within (near) THIS face's own extent — not just
 * its infinite plane. That last check matters once a shape has had enough
 * edits done to it: two genuinely distinct faces (say, two separate walls
 * either side of a notch) can end up coplanar without being anywhere near
 * each other, and matching by plane distance alone picked whichever one
 * happened to be closest to the recorded point ALONG THE PLANE'S OWN
 * NORMAL — which says nothing about whether the point is anywhere near
 * that face's actual footprint. A generous 1mm pad on the bounding-box
 * check absorbs minor shifts from earlier ops in the sequence (this face
 * may have been slightly resized by one of them) without being loose
 * enough to also match a truly separate, merely-coplanar face — a real
 * failure mode this project actually hit (see the commit fixing this).
 * Still a plain nearest-match search, not true topological naming, and
 * still only sound as long as the base shape upstream of these ops never
 * itself changes (the deal a node makes once it has been pushed/pulled —
 * see EditNode in document/types.ts) — but considerably harder to fool.
 */
function findFace(solid: Shape3D, point: Vec3, normal: Vec3, tolerance = 0.05): Face | null {
  const FOOTPRINT_PAD = 1; // mm
  let best: Face | null = null;
  let bestDistance = Infinity;
  for (const face of solid.faces) {
    if (face.geomType !== "PLANE") continue;
    const c = face.center;
    const n = face.normalAt(c);
    const facing = n.x * normal[0] + n.y * normal[1] + n.z * normal[2];
    if (facing < 0.9) continue; // not (close enough to) the same outward direction
    const planeDistance = Math.abs(
      (point[0] - c.x) * n.x + (point[1] - c.y) * n.y + (point[2] - c.z) * n.z,
    );
    if (planeDistance > tolerance) continue;
    const [min, max] = face.boundingBox.bounds;
    const withinFootprint =
      point[0] >= min[0] - FOOTPRINT_PAD && point[0] <= max[0] + FOOTPRINT_PAD &&
      point[1] >= min[1] - FOOTPRINT_PAD && point[1] <= max[1] + FOOTPRINT_PAD &&
      point[2] >= min[2] - FOOTPRINT_PAD && point[2] <= max[2] + FOOTPRINT_PAD;
    if (!withinFootprint) continue;
    if (planeDistance < bestDistance) {
      bestDistance = planeDistance;
      best = face;
    }
  }
  return best;
}

/**
 * The border edges of `face` that are still a genuine sharp corner, dropping
 * any that a previous fillet or chamfer has already softened.
 *
 * "Bevel every edge around this face" run on two touching faces in turn hits
 * their shared edge twice: the second pass finds the boundary of the *band*
 * the first pass left behind and bevels that too, which is where the thin
 * ridge down a re-chamfered corner comes from. A fillet fares worse — the
 * band's boundary is tangent, OCCT refuses it, and the whole second pass
 * fails rather than just that one edge.
 *
 * An edge is judged by the angle between the two faces meeting along it:
 * a raw box corner puts their outward normals 90 degrees apart (dot 0), a
 * 45-degree chamfer band 45 degrees apart (dot ~0.71), and a fillet band is
 * tangent (dot ~1). Anything at or past the halfway mark is already soft and
 * is left alone.
 */
const SOFT_EDGE_NORMAL_DOT = 0.5;

function sharpBorderEdges(solid: Shape3D, face: Face): import("replicad").Edge[] {
  const border = face.edges;
  const faceNormal = face.normalAt(face.center);
  // Identify the selected face by where it sits, not by shape identity: the
  // Face handed in came from its own pass over solid.faces, so it is a
  // different wrapper than the ones iterated here.
  const centre = face.center;
  const isSelf = (f: Face) => {
    const c = f.center;
    return Math.hypot(c.x - centre.x, c.y - centre.y, c.z - centre.z) < 1e-6;
  };
  const others = solid.faces.filter((f) => !isSelf(f));
  const kept = border.filter((edge) => {
    const mid = edge.pointAt(0.5);
    const neighbour = others.find((f) => f.edges.some((e) => e.isSame(edge)));
    if (!neighbour) return true; // no partner found — leave the decision to OCCT
    const n = neighbour.normalAt(neighbour.geomType === "PLANE" ? neighbour.center : mid);
    const dot = n.x * faceNormal.x + n.y * faceNormal.y + n.z * faceNormal.z;
    return dot < SOFT_EDGE_NORMAL_DOT;
  });
  // Never let the filter turn the whole operation into a no-op: if it would
  // reject everything, this is not a shape it understands, so hand the full
  // border back and let OCCT answer as it did before.
  return kept.length ? kept : border;
}

/**
 * Extrudes `face` into a prism `distance` deep along its own outward normal
 * and fuses that volume into `solid` (pulling, distance > 0) or cuts it away
 * (pushing, distance < 0) — a push/pull.
 *
 * The prism is always built along the OUTWARD normal, even when pushing:
 * cutting wants the solid material sitting just inside the face, which is
 * the same prism mirrored, so a push extrudes inward (-normal) instead. Both
 * directions therefore start from the face itself and never leave a sliver
 * behind it.
 */
/**
 * Hollows `solid` out, opening the faces anchored by `points`.
 *
 * replicad negates the thickness before handing it to OCCT
 * (MakeThickSolidByJoin with -thickness), so a POSITIVE thickness walls the
 * shape inwards and the outside keeps the size it had — which is what a
 * container wants: a 40mm box with a 2mm wall is still 40mm on the outside.
 */
function shellSolid(solid: Shape3D, op: ShellOp): Shape3D {
  // Resolve the Float32 viewport anchor to an actual OCCT face first, then
  // feed that face's own double-precision centre back to FaceFinder. Passing
  // the viewport point directly could select no face on rounded boxes;
  // OCCT would still return a valid closed offset, so the operation looked
  // successful but left the selected top in place.
  const matched = op.normal
    ? op.points.map((point) => findFace(solid, point, op.normal!, 0.08)).filter((face): face is Face => !!face)
    : [];
  if (op.normal && !matched.length) throw new Error("The selected opening face could not be found");
  const selectFaces = (faces: import("replicad").FaceFinder) => matched.length
    ? faces.either(matched.map((face) => (finder: import("replicad").FaceFinder) => finder.containsPoint(face.center)))
    : faces.either(op.points.map((point) => (finder: import("replicad").FaceFinder) => finder.withinDistance(0.02, point)));
  return solid.shell(op.thickness, selectFaces) as Shape3D;
}

/** Reliable fallback for a heavily edited Box when OCCT cannot offset its
 * accumulated topology. The cavity follows the edited solid's current bounds,
 * leaves `thickness` on five sides, and crosses only the selected opening
 * side. This intentionally remains an OCCT solid so later face edits continue
 * to work. */
function hollowEditedBox(solid: Shape3D, op: ShellOp): Shape3D | null {
  const [min, max] = solid.boundingBox.bounds;
  const bboxVol = (max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]);
  try {
    if (measureVolume(solid) < 0.90 * bboxVol) return null;
  } catch { /* proceed */ }
  const t = Math.max(0.01, op.thickness);
  const innerMin: Vec3 = [min[0] + t, min[1] + t, min[2] + t];
  const innerMax: Vec3 = [max[0] - t, max[1] - t, max[2] - t];
  if ([0, 1, 2].some((axis) => innerMax[axis] <= innerMin[axis] + 0.01)) return null;

  // The stored point is inside the chosen face. Its nearest bounding plane
  // identifies which side should be open without relying on a stale face id.
  const point = op.points[0];
  let openingAxis = 0;
  let openingAtMax = false;
  if (op.normal) {
    openingAxis = Math.abs(op.normal[1]) > Math.abs(op.normal[openingAxis]) ? 1 : openingAxis;
    openingAxis = Math.abs(op.normal[2]) > Math.abs(op.normal[openingAxis]) ? 2 : openingAxis;
    openingAtMax = op.normal[openingAxis] >= 0;
  } else {
    let nearest = Infinity;
    for (let axis = 0; axis < 3; axis++) {
      const toMin = Math.abs(point[axis] - min[axis]);
      const toMax = Math.abs(point[axis] - max[axis]);
      if (toMin < nearest) { nearest = toMin; openingAxis = axis; openingAtMax = false; }
      if (toMax < nearest) { nearest = toMax; openingAxis = axis; openingAtMax = true; }
    }
  }

  const overlap = Math.max(0.1, t * 0.1);
  if (openingAtMax) innerMax[openingAxis] = max[openingAxis] + overlap;
  else innerMin[openingAxis] = min[openingAxis] - overlap;
  const size: Vec3 = [
    innerMax[0] - innerMin[0],
    innerMax[1] - innerMin[1],
    innerMax[2] - innerMin[2],
  ];
  const cutter = makeBaseBox(size[0], size[1], size[2]).translate([
    (innerMin[0] + innerMax[0]) / 2,
    (innerMin[1] + innerMax[1]) / 2,
    innerMin[2],
  ]) as Shape3D;
  return solid.cut(cutter) as Shape3D;
}

function getBaseObjectSpec(spec: NodeSpec): ObjectSpec | null {
  if (spec.type === "object") return spec;
  if (spec.type === "edit") return getBaseObjectSpec(spec.base);
  return null;
}

function isBoxBased(spec: NodeSpec): boolean {
  if (spec.type === "object") return spec.kind === "box";
  if (spec.type === "edit") return isBoxBased(spec.base);
  return false;
}

function isCylinderBased(spec: NodeSpec): boolean {
  if (spec.type === "object") return spec.kind === "cylinder";
  if (spec.type === "edit") return isCylinderBased(spec.base);
  return false;
}

/** Reliable fallback for Cylinder (including cylinders with rounded top/bottom corners)
 * when OCCT's offset shell fails on multi-patch lofted fillets. Creates an inner
 * cylindrical cavity leaving `thickness` on the wall and closed floor/ceiling. */
function hollowEditedCylinder(solid: Shape3D, op: ShellOp, baseNode?: NodeSpec): Shape3D | null {
  const [min, max] = solid.boundingBox.bounds;
  const t = Math.max(0.01, op.thickness);

  const xCenter = (min[0] + max[0]) / 2;
  const yCenter = (min[1] + max[1]) / 2;
  const rx = (max[0] - min[0]) / 2;
  const ry = (max[1] - min[1]) / 2;
  const zMin = min[2];
  const zMax = max[2];
  const height = zMax - zMin;

  const innerRx = rx - t;
  const innerRy = ry - t;
  if (innerRx <= 0.01 || innerRy <= 0.01 || height <= t + 0.01) return null;

  const baseSpec = baseNode ? getBaseObjectSpec(baseNode) : null;
  const sides = baseSpec && baseSpec.kind === "cylinder" && baseSpec.params.sides
    ? Math.max(3, Math.min(96, Math.round(baseSpec.params.sides)))
    : 48;

  let opensTop = false;
  let opensBottom = false;

  if (op.normal) {
    if (op.normal[2] > 0.5) opensTop = true;
    else if (op.normal[2] < -0.5) opensBottom = true;
    else {
      // User picked a side wall face; let standard shell try or handle it
      return null;
    }
  } else {
    const point = op.points[0];
    if (point) {
      const distToTop = Math.abs(point[2] - zMax);
      const distToBottom = Math.abs(point[2] - zMin);
      if (distToTop < distToBottom && distToTop < height * 0.4) {
        opensTop = true;
      } else if (distToBottom <= distToTop && distToBottom < height * 0.4) {
        opensBottom = true;
      } else {
        return null;
      }
    }
  }

  if (op.points.length > 1) {
    const hasTop = op.points.some((p) => Math.abs(p[2] - zMax) < height * 0.3);
    const hasBottom = op.points.some((p) => Math.abs(p[2] - zMin) < height * 0.3);
    if (hasTop && hasBottom) {
      opensTop = true;
      opensBottom = true;
    }
  }

  if (!opensTop && !opensBottom) return null;

  const overlap = Math.max(0.1, t * 0.1);
  let cutterZMin: number;
  let cutterZMax: number;

  if (opensTop && opensBottom) {
    cutterZMin = zMin - overlap;
    cutterZMax = zMax + overlap;
  } else if (opensTop) {
    cutterZMin = zMin + t;
    cutterZMax = zMax + overlap;
  } else {
    cutterZMin = zMin - overlap;
    cutterZMax = zMax - t;
  }

  const cutterHeight = cutterZMax - cutterZMin;
  if (cutterHeight <= 0.01) return null;

  if (Math.abs(innerRx - innerRy) < 1e-4 && sides >= 32) {
    const cutter = makeCylinder(innerRx, cutterHeight).translate([xCenter, yCenter, cutterZMin]) as Shape3D;
    return solid.cut(cutter) as Shape3D;
  }

  const points: [number, number][] = Array.from({ length: sides }, (_, i) => {
    const angle = (2 * Math.PI * i) / sides;
    return [innerRx * Math.cos(angle), innerRy * Math.sin(angle)];
  });

  let pen = draw(points[0]);
  for (let i = 1; i < points.length; i++) pen = pen.lineTo(points[i]);
  const sketch = pen.close().sketchOnPlane("XY", 0) as Sketch;
  const cutter = sketch.extrude(cutterHeight).translate([xCenter, yCenter, cutterZMin]) as Shape3D;

  return solid.cut(cutter) as Shape3D;
}

/**
 * Re-finds edges selected in the viewport.
 *
 * The displayed wire is a Float32 tessellation, while OpenCascade keeps the
 * analytic edge in double precision. `containsPoint()` only tolerates about
 * one millionth of a millimetre, so an entirely ordinary rounding difference
 * on a long part made a selected inside edge resolve to no edge at all. The
 * 0.02 mm search is still far smaller than a modelling click target, but is
 * comfortably above display-mesh rounding and tessellation noise.
 */
const EDGE_ANCHOR_TOLERANCE = 0.15;
const EDGE_ANCHOR_FALLBACK_TOLERANCE = 0.35;

function edgesAt(
  anchors: Vec3[],
  tolerance = EDGE_ANCHOR_TOLERANCE,
): (edges: import("replicad").EdgeFinder) => import("replicad").EdgeFinder {
  return (edges) => edges.either(
    anchors.map((point) => (finder) => finder.withinDistance(tolerance, point)),
  );
}

/**
 * Insets/outsets a planar face without moving it along its normal.
 *
 * OpenCascade expresses this as a draft on every face immediately adjoining
 * the selected face. The plane at the solid's opposite extent is neutral, so
 * that far side remains fixed while the selected outline grows or shrinks and
 * its connecting faces become sloped. `offset` is per edge: +2 mm makes a
 * rectangular face 4 mm wider and 4 mm deeper.
 */
/** Below this many radians OCCT's draft may leave a face untouched (see
 *  resizePlanarFace): 0.0001 was ignored, 0.001 applied accurately. */
const NEAR_UPRIGHT_DRAFT = 0.001;

function resizePlanarFace(solid: Shape3D, face: Face, op: ResizeFaceOp): Shape3D {
  if (Math.abs(op.offset) < 1e-6) return solid;
  const center = face.center;
  const rawNormal = face.normalAt(center);
  const normal = new Vector([rawNormal.x, rawNormal.y, rawNormal.z]).normalized();
  const faceProjection = center.x * normal.x + center.y * normal.y + center.z * normal.z;

  const boundary = face.edges;
  const adjoining = solid.faces.filter((candidate) =>
    !candidate.isSame(face) &&
    candidate.edges.some((edge) => boundary.some((selectedEdge) => edge.isSame(selectedEdge))),
  );
  if (!adjoining.length) throw new Error("No adjoining faces could be resized.");

  // Stop the draft where the immediately adjoining faces end. Using the
  // complete solid's minimum made a face on top of a stepped/compound shape
  // taper all the way through the lower body instead of ending at its local
  // shoulder.
  let oppositeProjection = Infinity;
  for (const adjoiningFace of adjoining) {
    const [min, max] = adjoiningFace.boundingBox.bounds;
    for (const x of [min[0], max[0]]) {
      for (const y of [min[1], max[1]]) {
        for (const z of [min[2], max[2]]) {
          oppositeProjection = Math.min(oppositeProjection, x * normal.x + y * normal.y + z * normal.z);
        }
      }
    }
  }
  const height = faceProjection - oppositeProjection;
  if (!Number.isFinite(height) || height < 0.1) {
    throw new Error("The opposite side of this face could not be found.");
  }
  // OCCT's draft only tilts PLANAR neighbours: on a cylinder's round side it
  // throws from inside the WASM module, so the top of a plain cylinder could
  // never be resized. Where the neighbours are ruled walls of one slope (a
  // cylinder, or the cone an earlier resize made), the same result is built
  // directly as a loft instead.
  if (adjoining.some((candidate) => candidate.geomType !== "PLANE")) {
    const lofted = resizeRuledFace(solid, face, adjoining, normal, faceProjection, op.offset);
    if (lofted) return lofted;
  }
  // OCCT's draft angle is ABSOLUTE — the tilt a wall ends up with, measured
  // from the pull direction — not an amount to tilt it by. Handing every wall
  // the same atan(offset/height) therefore did nothing at all to a face that
  // had already been resized once: the walls were already at that angle, so
  // the second +2 left a box unchanged, and a +2 then -2 came out as a -2
  // on the original cube. Each wall's angle is its current lean plus the new
  // offset, so repeated resizes add up.
  //
  // Positive OCCT draft angles taper IN, so the angle is negated to make a
  // positive offset mean grow/outset.
  const tilts = adjoining.map((wall) => {
    const n = wall.normalAt(wall.center);
    const s = (n.x * normal.x + n.y * normal.y + n.z * normal.z) / Math.hypot(n.x, n.y, n.z);
    if (!(Math.abs(s) < 0.99)) throw new Error("That resize is too large for this face.");
    // How far this wall already leans out per mm of height: an outward normal
    // tipped down (s < 0) means the face is already wider than the far end.
    const lean = -s / Math.sqrt(1 - s * s);
    const angle = -Math.atan(lean + op.offset / height);
    if (!Number.isFinite(angle) || Math.abs(angle) >= (80 * Math.PI) / 180) {
      throw new Error("That resize is too large for this face.");
    }
    return { wall, angle };
  });

  // OCCT silently ignores a draft angle this close to upright — measured:
  // 0.0001 rad leaves a tilted wall exactly where it was, 0.001 rad applies —
  // so taking a resized face back to straight walls did nothing at all. Those
  // are built as a loft instead, which lands exactly on vertical.
  if (tilts.some(({ angle }) => Math.abs(angle) < NEAR_UPRIGHT_DRAFT)) {
    const lofted = resizeRuledFace(solid, face, adjoining, normal, faceProjection, op.offset);
    if (lofted) return lofted;
    throw new Error("These walls cannot be brought back exactly upright with a resize.");
  }

  const oc = getOC();
  const originVector = new Vector([
    center.x - normal.x * height,
    center.y - normal.y * height,
    center.z - normal.z * height,
  ]);
  const origin = originVector.toPnt();
  const direction = normal.toDir();
  const neutral = new oc.gp_Pln(origin, direction);
  // replicad's draft() takes a single angle for every face, which is exactly
  // what cannot work here, so the OCCT builder is driven directly.
  const drafter = new oc.BRepOffsetAPI_DraftAngle(solid.wrapped);
  try {
    for (const { wall, angle } of tilts) drafter.Add(wall.wrapped, direction, angle, neutral, false);
    drafter.Build();
    return (cast(drafter.ModifiedShape(solid.wrapped)) as Shape3D).asShape3D();
  } finally {
    drafter.delete();
    neutral.delete();
    direction.delete();
    origin.delete();
    originVector.delete();
  }
}

/**
 * resizePlanarFace for a face whose neighbours include curved walls.
 *
 * Applies where every neighbour is a ruled wall of one constant slope running
 * up to the selected face: a cylinder's side, or the cone a previous resize
 * left behind (so a face can be resized again), or flat walls sharing one
 * draft. The section above the pivot is swapped for a ruled loft whose outline
 * at the pivot is unchanged and whose outline at the face is offset — what the
 * draft produces on flat walls: a cylinder's top grows into a cone frustum.
 *
 * The pivot is where the walls meet the rest of the part, not the bottom of
 * the feature. A cylinder combined into a box with its lower part sunk inside
 * used to pivot at its buried bottom: the replacement cut through the box
 * there and left a groove round the cylinder in the box's top face.
 *
 * Returns null whenever the section is not like that (a rounded rim, a barrel
 * side, walls of differing slope, a hole through it, a face with holes), so
 * nothing is ever silently filled in or reshaped beyond what was selected.
 */
function resizeRuledFace(
  solid: Shape3D,
  face: Face,
  adjoining: Face[],
  normal: Vector,
  faceProjection: number,
  offset: number,
): Shape3D | null {
  // replicad's innerWires(), outerWire(), offset2D() and translate() DELETE
  // the shape they are called on, so each is asked of its own clone.
  if (face.clone().innerWires().length) return null;
  const along = (p: { x: number; y: number; z: number }) => p.x * normal.x + p.y * normal.y + p.z * normal.z;
  const TOLERANCE = 0.01;

  // Heights come from the walls' own edges rather than bounding boxes, which
  // OCCT pads on curved faces. Normals are sampled along those edges, never at
  // wall.center: a full cylinder's centroid lies ON its axis, where
  // normalAt() throws trying to project it.
  let slope: number | null = null;
  let pivot = -Infinity;
  for (const wall of adjoining) {
    if (wall.geomType !== "PLANE" && wall.geomType !== "CYLINDRE" && wall.geomType !== "CONE") return null;
    let reachesFace = false;
    for (const edge of wall.edges) {
      const points = [0, 0.25, 0.5, 0.75, 1].map((t) => edge.pointAt(t));
      const top = Math.max(...points.map(along));
      if (Math.abs(top - faceProjection) <= TOLERANCE) reachesFace = true;
      // An edge lying wholly below the face is where this wall meets the
      // rest of the part; the highest such point is as low as the taper can
      // pivot without cutting into that other material.
      else pivot = Math.max(pivot, top);
      for (const point of points.slice(1, 4)) {
        // normalAt() is NOT unit length on a cone — its size changes with
        // height — so it has to be normalised before slopes are compared.
        const n = wall.normalAt(point);
        const s = along(n) / Math.hypot(n.x, n.y, n.z);
        if (slope === null) slope = s;
        else if (Math.abs(s - slope) > 1e-4) return null;
      }
    }
    if (!reachesFace) return null;
  }
  if (slope === null || Math.abs(slope) > 0.99 || !Number.isFinite(pivot)) return null;
  const height = faceProjection - pivot;
  if (!(height > 0.1)) return null;

  // How much wider the outline is at the pivot than at the face, from the
  // walls' slope: 0 for a cylinder, positive for a cone narrowing upwards.
  const spread = (height * slope) / Math.sqrt(1 - slope * slope);
  const back = normal.multiply(-height);
  const outline = face.clone().outerWire();
  const atPivot = (Math.abs(spread) > 1e-6
    ? outline.clone().offset2D(spread, "intersection")
    : outline.clone()
  ).translate([back.x, back.y, back.z]);

  const current = loft([atPivot.clone(), outline.clone()], { ruled: true });
  const currentVolume = measureVolume(current);
  if (!(currentVolume > 1e-6)) return null;
  // Also catches a wall that is not what it seemed: if the loft does not lie
  // wholly inside the solid, or a hole crosses the section, stop here.
  const filled = measureVolume(solid.intersect(current) as Shape3D);
  if (Math.abs(filled - currentVolume) > currentVolume * 1e-4) return null;

  // Walls that end up exactly upright are extruded rather than lofted. A loft
  // between two polygons makes each flat wall a BSPLINE_SURFACE, which every
  // face tool afterwards — including the next resize — refuses as not flat.
  const upright = Math.abs(offset - spread) < 1e-6;
  const resizedOutline = outline.offset2D(offset, "intersection");
  const resized = upright
    ? (basicFaceExtrusion(makeFace(resizedOutline), back) as Shape3D)
    : loft([atPivot, resizedOutline], { ruled: true });
  const rest = solid.cut(current) as Shape3D;
  // The whole solid was that section (a plain cylinder): nothing to join.
  if (measureVolume(rest) < 1e-6) return resized;
  return rest.fuse(resized) as Shape3D;
}

/**
 * Insets a face's own outline and extrudes that, so the new feature follows
 * the real edge of the face — rounded corners included — rather than a box
 * laid over the top of it.
 *
 * sketchFaceOffset takes a NEGATIVE offset to move inside the face, so the
 * op's "inset" (positive = inwards, which is how anyone would read it) is
 * negated here rather than in the document, where the sign would be a trap
 * for every future reader.
 */
function offsetExtrudeFace(solid: Shape3D, face: Face, op: OffsetExtrudeOp): Shape3D {
  const prism = sketchFaceOffset(face, -op.inset).extrude(op.height) as Shape3D;
  // Extruding backwards along the normal produces the prism on the inside of
  // the solid, which is the material to remove.
  return (op.height >= 0 ? solid.fuse(prism) : solid.cut(prism)) as Shape3D;
}

function pushPullFace(solid: Shape3D, face: Face, distance: number): Shape3D {
  if (Math.abs(distance) < 1e-6) return solid;
  const n = face.normalAt(face.center);
  const direction = new Vector([n.x, n.y, n.z]).normalized().multiply(distance);
  const prism = basicFaceExtrusion(face, direction) as Shape3D;
  return (distance > 0 ? solid.fuse(prism) : solid.cut(prism)) as Shape3D;
}

/** Push/pull fallback for a triangle-backed solid (non-uniformly scaled
 * groups and imports). The selected coplanar triangles are each extruded
 * into a closed triangular prism; composing them before the boolean avoids
 * changing unrelated facets of the mesh. */
function pushPullMesh(solid: MeshShape, op: PushPullOp): MeshShape | null {
  if (Math.abs(op.distance) < 1e-6) return solid;
  const raw = solid.mesh();
  const [nx, ny, nz] = op.normal;
  const manifold = getManifold();
  const points: number[][] = [];
  const pointIndex = new Map<string, number>();
  const selected: number[][] = [];
  const edges = new Map<string, { a: number; b: number; count: number }>();
  const candidates: { rawIds: number[]; centreDistance: number }[] = [];
  const canonical = (rawId: number) => {
    const i = rawId * 3;
    const point = [raw.vertices[i], raw.vertices[i + 1], raw.vertices[i + 2]];
    const key = `${Math.round(point[0] * 1e5)},${Math.round(point[1] * 1e5)},${Math.round(point[2] * 1e5)}`;
    let id = pointIndex.get(key);
    if (id === undefined) {
      id = points.length;
      points.push(point);
      pointIndex.set(key, id);
    }
    return id;
  };
  const addSelectedTriangle = (rawIds: number[]) => {
    const ids = rawIds.map(canonical);
    selected.push(ids);
    for (let edge = 0; edge < 3; edge++) {
      const a = ids[edge];
      const b = ids[(edge + 1) % 3];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const existing = edges.get(key);
      if (existing) existing.count++;
      else edges.set(key, { a, b, count: 1 });
    }
  };

  for (let offset = 0; offset < raw.triangles.length; offset += 3) {
    const ids = [raw.triangles[offset], raw.triangles[offset + 1], raw.triangles[offset + 2]];
    const ia = ids[0] * 3;
    const ib = ids[1] * 3;
    const ic = ids[2] * 3;
    const ab = [raw.vertices[ib] - raw.vertices[ia], raw.vertices[ib + 1] - raw.vertices[ia + 1], raw.vertices[ib + 2] - raw.vertices[ia + 2]];
    const ac = [raw.vertices[ic] - raw.vertices[ia], raw.vertices[ic + 1] - raw.vertices[ia + 1], raw.vertices[ic + 2] - raw.vertices[ia + 2]];
    const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const length = Math.hypot(...cross) || 1;
    const tx = cross[0] / length;
    const ty = cross[1] / length;
    const tz = cross[2] / length;
    const aligned = tx * nx + ty * ny + tz * nz > 0.9999;
    const onPlane = Math.abs((raw.vertices[ia] - op.point[0]) * nx + (raw.vertices[ia + 1] - op.point[1]) * ny + (raw.vertices[ia + 2] - op.point[2]) * nz) < 1e-3;
    if (aligned && onPlane) {
      const cx = (raw.vertices[ia] + raw.vertices[ib] + raw.vertices[ic]) / 3;
      const cy = (raw.vertices[ia + 1] + raw.vertices[ib + 1] + raw.vertices[ic + 1]) / 3;
      const cz = (raw.vertices[ia + 2] + raw.vertices[ib + 2] + raw.vertices[ic + 2]) / 3;
      candidates.push({ rawIds: ids, centreDistance: Math.hypot(cx - op.point[0], cy - op.point[1], cz - op.point[2]) });
    }
  }
  if (!candidates.length) return null;

  // Several disconnected faces can be coplanar. Only grow from the triangle
  // containing (or nearest to) the picked interior point; otherwise a pull on
  // one top patch also extrudes every separate patch on the same Z plane.
  const candidateEdges = new Map<string, number[]>();
  const rawPositionKey = (rawId: number) => {
    const i = rawId * 3;
    return `${Math.round(raw.vertices[i] * 1e5)},${Math.round(raw.vertices[i + 1] * 1e5)},${Math.round(raw.vertices[i + 2] * 1e5)}`;
  };
  candidates.forEach((candidate, index) => {
    for (let edge = 0; edge < 3; edge++) {
      const ka = rawPositionKey(candidate.rawIds[edge]);
      const kb = rawPositionKey(candidate.rawIds[(edge + 1) % 3]);
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const list = candidateEdges.get(key) ?? [];
      list.push(index);
      candidateEdges.set(key, list);
    }
  });
  const neighbours = Array.from({ length: candidates.length }, () => new Set<number>());
  for (const list of candidateEdges.values()) for (const a of list) for (const b of list) if (a !== b) neighbours[a].add(b);
  let seed = 0;
  for (let i = 1; i < candidates.length; i++) if (candidates[i].centreDistance < candidates[seed].centreDistance) seed = i;
  const queue = [seed];
  const visited = new Uint8Array(candidates.length);
  visited[seed] = 1;
  while (queue.length) {
    const index = queue.pop()!;
    addSelectedTriangle(candidates[index].rawIds);
    for (const next of neighbours[index]) if (!visited[next]) {
      visited[next] = 1;
      queue.push(next);
    }
  }

  // Manifold booleans are unreliable when the cutter starts exactly on the
  // target surface: the coincident triangles can survive as zero-thickness
  // sheets. Cross both ends by a tiny amount so this is an unambiguous
  // overlapping volume without changing the requested dimension visibly.
  const overlap = 1e-3;
  const baseOffset = op.distance > 0 ? -overlap : overlap;
  const endOffset = op.distance > 0 ? op.distance + overlap : op.distance - overlap;
  const vertices = points.flatMap(([x, y, z]) => [x + nx * baseOffset, y + ny * baseOffset, z + nz * baseOffset]);
  vertices.push(...points.flatMap(([x, y, z]) => [x + nx * endOffset, y + ny * endOffset, z + nz * endOffset]));
  const top = points.length;
  const triangles: number[] = [];
  // The winding MUST depend on the sign, because the sign flips which end of
  // the prism the two vertex sets land on. The `a,b,c` set sits at
  // baseOffset and the `a+top` set at endOffset: for a pull (distance > 0)
  // that puts a,b,c BELOW and a+top ABOVE, but for a push (distance < 0) it
  // is the other way round. Manifold needs a consistently outward-wound
  // closed solid either way, so the cap that ends up facing along +normal
  // keeps the original triangle's winding and the one facing -normal is
  // reversed — which is the opposite assignment in each case. Feeding it a
  // prism wound for the wrong sign yields an inside-out solid, and its
  // boolean then silently does nothing (or worse) rather than erroring:
  // a push that visibly removes no material at all.
  const positive = op.distance > 0;
  for (const [a, b, c] of selected) {
    if (positive) triangles.push(a, c, b, a + top, b + top, c + top);
    else triangles.push(a, b, c, a + top, c + top, b + top);
  }
  for (const { a, b, count } of edges.values()) {
    if (count !== 1) continue;
    if (positive) triangles.push(a, b, b + top, a, b + top, a + top);
    else triangles.push(a, b + top, b, a, a + top, b + top);
  }
  const prism = new MeshShape(new manifold.Manifold(new manifold.Mesh({
    numProp: 3,
    vertProperties: Float32Array.from(vertices),
    triVerts: Uint32Array.from(triangles),
  })));
  return op.distance > 0 ? solid.fuse(prism) : solid.cut(prism);
}

/**
 * Resolves all boundary edge midpoint anchors of a planar face on a MeshShape.
 */
function findMeshFaceBoundaryAnchors(solid: MeshShape, point: Vec3, normal: Vec3): Vec3[] {
  const raw = solid.wrapped.getMesh();
  const numTris = raw.triVerts.length / 3;
  if (numTris === 0) return [];

  const [nx, ny, nz] = normal;
  const targetD = nx * point[0] + ny * point[1] + nz * point[2];
  // Plane + normal alone: every triangle on the same infinite plane, facing
  // the same way, anywhere in the mesh. A shape with repeated same-height
  // features (several prongs off one base, say) has more than one of those
  // — separate, disconnected patches that merely happen to be coplanar. Kept
  // apart here in coplanarTris/closest-seed so the flood-fill below can walk
  // out from only the patch actually under the click, the same distinction
  // findFace()'s footprint check already draws for the B-Rep path.
  const coplanarTris: number[] = [];
  let seed = -1;
  let seedDist = Infinity;

  for (let t = 0; t < numTris; t++) {
    const i0 = raw.triVerts[t * 3] * 3;
    const i1 = raw.triVerts[t * 3 + 1] * 3;
    const i2 = raw.triVerts[t * 3 + 2] * 3;
    const ax = raw.vertProperties[i0], ay = raw.vertProperties[i0 + 1], az = raw.vertProperties[i0 + 2];
    const bx = raw.vertProperties[i1], by = raw.vertProperties[i1 + 1], bz = raw.vertProperties[i1 + 2];
    const cx = raw.vertProperties[i2], cy = raw.vertProperties[i2 + 1], cz = raw.vertProperties[i2 + 2];
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    let tnx = aby * acz - abz * acy;
    let tny = abz * acx - abx * acz;
    let tnz = abx * acy - aby * acx;
    const len = Math.hypot(tnx, tny, tnz) || 1;
    tnx /= len; tny /= len; tnz /= len;
    const dot = tnx * nx + tny * ny + tnz * nz;
    if (dot > 0.98) {
      const d = tnx * ax + tny * ay + tnz * az;
      if (Math.abs(d - targetD) < 0.2) {
        coplanarTris.push(t);
        const cx3 = (ax + bx + cx) / 3, cy3 = (ay + by + cy) / 3, cz3 = (az + bz + cz) / 3;
        const dist = Math.hypot(cx3 - point[0], cy3 - point[1], cz3 - point[2]);
        if (dist < seedDist) { seedDist = dist; seed = t; }
      }
    }
  }
  if (seed === -1) return [];

  // Flood-fill from the triangle nearest the click, through shared edges,
  // staying inside the coplanar set — this is what actually confines the
  // result to the one connected patch under the cursor.
  const coplanarSet = new Set(coplanarTris);
  const edgeToTris = new Map<string, number[]>();
  for (const t of coplanarTris) {
    const v0 = raw.triVerts[t * 3];
    const v1 = raw.triVerts[t * 3 + 1];
    const v2 = raw.triVerts[t * 3 + 2];
    for (const [a, b] of [[v0, v1], [v1, v2], [v2, v0]]) {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const list = edgeToTris.get(key);
      if (list) list.push(t); else edgeToTris.set(key, [t]);
    }
  }
  const matchingTris = new Set<number>([seed]);
  const queue = [seed];
  while (queue.length) {
    const t = queue.pop()!;
    const v0 = raw.triVerts[t * 3];
    const v1 = raw.triVerts[t * 3 + 1];
    const v2 = raw.triVerts[t * 3 + 2];
    for (const [a, b] of [[v0, v1], [v1, v2], [v2, v0]]) {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      for (const other of edgeToTris.get(key) ?? []) {
        if (other !== t && coplanarSet.has(other) && !matchingTris.has(other)) {
          matchingTris.add(other);
          queue.push(other);
        }
      }
    }
  }

  const edgeCounts = new Map<string, number>();
  for (const t of matchingTris) {
    const v0 = raw.triVerts[t * 3];
    const v1 = raw.triVerts[t * 3 + 1];
    const v2 = raw.triVerts[t * 3 + 2];
    const edges = [
      v0 < v1 ? `${v0}:${v1}` : `${v1}:${v0}`,
      v1 < v2 ? `${v1}:${v2}` : `${v2}:${v1}`,
      v2 < v0 ? `${v2}:${v0}` : `${v0}:${v2}`,
    ];
    for (const e of edges) {
      edgeCounts.set(e, (edgeCounts.get(e) || 0) + 1);
    }
  }

  const anchors: Vec3[] = [];
  for (const [key, count] of edgeCounts.entries()) {
    if (count === 1) {
      const colon = key.indexOf(":");
      const v0 = Number(key.slice(0, colon));
      const v1 = Number(key.slice(colon + 1));
      anchors.push([
        (raw.vertProperties[v0 * 3] + raw.vertProperties[v1 * 3]) / 2,
        (raw.vertProperties[v0 * 3 + 1] + raw.vertProperties[v1 * 3 + 1]) / 2,
        (raw.vertProperties[v0 * 3 + 2] + raw.vertProperties[v1 * 3 + 2]) / 2,
      ]);
    }
  }
  return anchors;
}

/**
 * Applies a chamfer (bevel) or fillet (round) directly to feature edges of a MeshShape.
 * Constructs exact 3D cutter prisms along the selected sharp edges and applies them via Manifold.
 */
function finishMeshEdge(
  solid: MeshShape,
  anchors: Vec3[],
  distance: number,
  kind: "chamfer" | "fillet" = "chamfer",
): MeshShape | null {
  if (Math.abs(distance) < 1e-6 || !anchors.length) return solid;
  const raw = solid.wrapped.getMesh();
  const numTris = raw.triVerts.length / 3;
  if (numTris === 0) return null;

  const triNormals: [number, number, number][] = [];
  for (let t = 0; t < numTris; t++) {
    const i0 = raw.triVerts[t * 3] * 3;
    const i1 = raw.triVerts[t * 3 + 1] * 3;
    const i2 = raw.triVerts[t * 3 + 2] * 3;
    const ax = raw.vertProperties[i0], ay = raw.vertProperties[i0 + 1], az = raw.vertProperties[i0 + 2];
    const bx = raw.vertProperties[i1], by = raw.vertProperties[i1 + 1], bz = raw.vertProperties[i1 + 2];
    const cx = raw.vertProperties[i2], cy = raw.vertProperties[i2 + 1], cz = raw.vertProperties[i2 + 2];
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    let nx = aby * acz - abz * acy;
    let ny = abz * acx - abx * acz;
    let nz = abx * acy - aby * acx;
    const len = Math.hypot(nx, ny, nz) || 1;
    triNormals.push([nx / len, ny / len, nz / len]);
  }

  const edgeToTris = new Map<string, number[]>();
  for (let t = 0; t < numTris; t++) {
    const v0 = raw.triVerts[t * 3];
    const v1 = raw.triVerts[t * 3 + 1];
    const v2 = raw.triVerts[t * 3 + 2];
    const edges = [
      v0 < v1 ? `${v0}:${v1}` : `${v1}:${v0}`,
      v1 < v2 ? `${v1}:${v2}` : `${v2}:${v1}`,
      v2 < v0 ? `${v2}:${v0}` : `${v0}:${v2}`,
    ];
    for (const e of edges) {
      let list = edgeToTris.get(e);
      if (!list) {
        list = [];
        edgeToTris.set(e, list);
      }
      list.push(t);
    }
  }

  interface SharpEdge {
    key: string;
    v0Idx: number;
    v1Idx: number;
    v0: [number, number, number];
    v1: [number, number, number];
    nA: [number, number, number];
    nB: [number, number, number];
    tA: number;
    tB: number;
    u: [number, number, number];
    len: number;
  }
  const sharpEdges: SharpEdge[] = [];
  const vertexToSharpEdges = new Map<number, SharpEdge[]>();

  for (const [key, tris] of edgeToTris.entries()) {
    if (tris.length >= 2) {
      const tA = tris[0], tB = tris[1];
      const nA = triNormals[tA], nB = triNormals[tB];
      const dot = nA[0] * nB[0] + nA[1] * nB[1] + nA[2] * nB[2];
      if (dot < 0.965) {
        const colon = key.indexOf(":");
        const v0Idx = Number(key.slice(0, colon));
        const v1Idx = Number(key.slice(colon + 1));
        const v0: [number, number, number] = [raw.vertProperties[v0Idx * 3], raw.vertProperties[v0Idx * 3 + 1], raw.vertProperties[v0Idx * 3 + 2]];
        const v1: [number, number, number] = [raw.vertProperties[v1Idx * 3], raw.vertProperties[v1Idx * 3 + 1], raw.vertProperties[v1Idx * 3 + 2]];
        const dx = v1[0] - v0[0], dy = v1[1] - v0[1], dz = v1[2] - v0[2];
        const len = Math.hypot(dx, dy, dz);
        if (len < 1e-6) continue;
        const u: [number, number, number] = [dx / len, dy / len, dz / len];
        const seg: SharpEdge = { key, v0Idx, v1Idx, v0, v1, nA, nB, tA, tB, u, len };
        sharpEdges.push(seg);

        if (!vertexToSharpEdges.has(v0Idx)) vertexToSharpEdges.set(v0Idx, []);
        vertexToSharpEdges.get(v0Idx)!.push(seg);
        if (!vertexToSharpEdges.has(v1Idx)) vertexToSharpEdges.set(v1Idx, []);
        vertexToSharpEdges.get(v1Idx)!.push(seg);
      }
    }
  }

  const matchedSegments = new Set<SharpEdge>();
  for (const anchor of anchors) {
    let bestSeg: SharpEdge | null = null;
    let bestDist = Infinity;
    for (const seg of sharpEdges) {
      const v0 = seg.v0, v1 = seg.v1;
      const wx = anchor[0] - v0[0], wy = anchor[1] - v0[1], wz = anchor[2] - v0[2];
      const vx = v1[0] - v0[0], vy = v1[1] - v0[1], vz = v1[2] - v0[2];
      const l2 = vx * vx + vy * vy + vz * vz;
      const t = l2 > 0 ? Math.max(0, Math.min(1, (wx * vx + wy * vy + wz * vz) / l2)) : 0;
      const cx = v0[0] + t * vx, cy = v0[1] + t * vy, cz = v0[2] + t * vz;
      const d = Math.hypot(anchor[0] - cx, anchor[1] - cy, anchor[2] - cz);
      if (d < bestDist) {
        bestDist = d;
        bestSeg = seg;
      }
    }
    if (bestSeg && bestDist < 1.5) {
      matchedSegments.add(bestSeg);
      const toCheck = [bestSeg];
      while (toCheck.length > 0) {
        const curr = toCheck.pop()!;
        for (const vIdx of [curr.v0Idx, curr.v1Idx]) {
          const neighbors = vertexToSharpEdges.get(vIdx) || [];
          for (const nb of neighbors) {
            if (matchedSegments.has(nb)) continue;
            const dotU = Math.abs(curr.u[0] * nb.u[0] + curr.u[1] * nb.u[1] + curr.u[2] * nb.u[2]);
            if (dotU > 0.99) {
              matchedSegments.add(nb);
              toCheck.push(nb);
            }
          }
        }
      }
    }
  }

  if (matchedSegments.size === 0) return null;

  // Boolean triangulation can split a straight border very near a corner.
  // Miter the whole straight run: mitering the tiny last fragment can turn
  // its cutter inside out and leave a notch or a square-ended strip.
  const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const sameFaces = (a: SharpEdge, b: SharpEdge) =>
    (dot3(a.nA, b.nA) > 0.99999 && dot3(a.nB, b.nB) > 0.99999) ||
    (dot3(a.nA, b.nB) > 0.99999 && dot3(a.nB, b.nA) > 0.99999);
  let merged = true;
  while (merged) {
    merged = false;
    for (const a of matchedSegments) {
      for (const b of matchedSegments) {
        if (a === b || !sameFaces(a, b) || Math.abs(dot3(a.u, b.u)) < 0.99999) continue;
        const shared = [a.v0Idx, a.v1Idx].find((id) => id === b.v0Idx || id === b.v1Idx);
        if (shared === undefined) continue;
        const v0Idx = a.v0Idx === shared ? a.v1Idx : a.v0Idx;
        const v1Idx = b.v0Idx === shared ? b.v1Idx : b.v0Idx;
        const v0 = a.v0Idx === shared ? a.v1 : a.v0;
        const v1 = b.v0Idx === shared ? b.v1 : b.v0;
        const len = Math.hypot(...v1.map((value, i) => value - v0[i]));
        if (len < 1e-6) continue;
        matchedSegments.delete(a);
        matchedSegments.delete(b);
        matchedSegments.add({ ...a, v0Idx, v1Idx, v0, v1, len,
          u: v1.map((value, i) => (value - v0[i]) / len) as Vec3 });
        merged = true;
        break;
      }
      if (merged) break;
    }
  }
  vertexToSharpEdges.clear();
  for (const edge of matchedSegments) {
    for (const id of [edge.v0Idx, edge.v1Idx]) {
      const edges = vertexToSharpEdges.get(id) ?? [];
      edges.push(edge);
      vertexToSharpEdges.set(id, edges);
    }
  }

  // Opposite borders on a narrow planar strip consume material from both
  // sides. Reject overlapping profiles instead of silently removing the
  // entire top face and leaving corner-dependent steps.
  for (const a of matchedSegments) for (const b of matchedSegments) {
    if (a === b || Math.abs(dot3(a.u, b.u)) < 0.99999) continue;
    for (const [faceA, sideA] of [[a.nA, a.nB], [a.nB, a.nA]]) {
      for (const [faceB, sideB] of [[b.nA, b.nB], [b.nB, b.nA]]) {
        if (dot3(faceA, faceB) < 0.99999 || dot3(sideA, sideB) > -0.99999) continue;
        if (Math.abs(dot3(faceA, sideA)) > 1e-5) continue;
        const offset = b.v0.map((value, i) => value - a.v0[i]) as Vec3;
        if (Math.abs(dot3(offset, faceA)) > 1e-4) continue;
        // The other edge must lie inside this face, not across an opening.
        const width = -dot3(offset, sideA);
        if (width <= 1e-5 || width >= 2 * distance + 1e-5) continue;
        const start = dot3(offset, a.u);
        const end = start + dot3(b.u, a.u) * b.len;
        if (Math.min(a.len, Math.max(start, end)) - Math.max(0, Math.min(start, end)) > 1e-5) return null;
      }
    }
  }

  const manifold = getManifold();
  let currentSolid = solid;

  for (const seg of matchedSegments) {
    const v0 = seg.v0, v1 = seg.v1;
    const u = seg.u;
    const mid: [number, number, number] = [(v0[0] + v1[0]) / 2, (v0[1] + v1[1]) / 2, (v0[2] + v1[2]) / 2];

    const getThird = (triIdx: number): [number, number, number] | null => {
      for (let j = 0; j < 3; j++) {
        const vi = raw.triVerts[triIdx * 3 + j];
        if (vi !== seg.v0Idx && vi !== seg.v1Idx) {
          const point: Vec3 = [raw.vertProperties[vi * 3], raw.vertProperties[vi * 3 + 1], raw.vertProperties[vi * 3 + 2]];
          const offset = point.map((value, i) => value - v0[i]) as Vec3;
          const along = dot3(offset, u);
          if (Math.hypot(...offset.map((value, i) => value - along * u[i])) > 1e-6) return point;
        }
      }
      return null;
    };
    const vA3 = getThird(seg.tA);
    const vB3 = getThird(seg.tB);
    if (!vA3 || !vB3) continue;

    const getDir = (vThird: [number, number, number]): [number, number, number] => {
      const diff = [vThird[0] - mid[0], vThird[1] - mid[1], vThird[2] - mid[2]];
      const dot = diff[0] * u[0] + diff[1] * u[1] + diff[2] * u[2];
      const perp = [diff[0] - dot * u[0], diff[1] - dot * u[1], diff[2] - dot * u[2]];
      const l = Math.hypot(perp[0], perp[1], perp[2]) || 1;
      return [perp[0] / l, perp[1] / l, perp[2] / l];
    };
    const dA = getDir(vA3);
    const dB = getDir(vB3);

    const signedDist = (vB3[0] - mid[0]) * seg.nA[0] + (vB3[1] - mid[1]) * seg.nA[1] + (vB3[2] - mid[2]) * seg.nA[2];
    const isConcave = signedDist > 1e-4;

    const nAvgRaw = [seg.nA[0] + seg.nB[0], seg.nA[1] + seg.nB[1], seg.nA[2] + seg.nB[2]];
    const nAvgL = Math.hypot(nAvgRaw[0], nAvgRaw[1], nAvgRaw[2]) || 1;
    const nAvg: [number, number, number] = [nAvgRaw[0] / nAvgL, nAvgRaw[1] / nAvgL, nAvgRaw[2] / nAvgL];

    // Adjacent selected borders must share a miter plane. Square caps leave
    // an uncut wedge at reentrant face corners; uniform extensions overcut
    // other corners. Move each profile vertex along this edge to the angle
    // bisector instead, so both profiles end at the same cross-section.
    const miterProfile = (point: Vec3, atStart: boolean): Vec3 => {
      const vertex = atStart ? v0 : v1;
      const vertexIdx = atStart ? seg.v0Idx : seg.v1Idx;
      const sign = atStart ? 1 : -1;
      const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      const neighbors = (vertexToSharpEdges.get(vertexIdx) ?? []).filter((other) =>
        other !== seg && matchedSegments.has(other) &&
        [seg.nA, seg.nB].some((normal) =>
          [other.nA, other.nB].some((otherNormal) => dot(normal, otherNormal) > 0.99999)),
      );
      // Multi-edge junctions need a corner patch, not an arbitrary pairing.
      if (neighbors.length !== 1) return point;
      const other = neighbors[0];
      const otherSign = other.v0Idx === vertexIdx ? 1 : -1;
      // Difference of directions pointing away from the shared endpoint is
      // normal to the miter plane (also handles collinear mesh subdivisions).
      const normal: Vec3 = u.map((value, i) => sign * value - otherSign * other.u[i]) as Vec3;
      const denominator = dot(u, normal);
      if (Math.abs(denominator) < 1e-6) return point;
      const offset: Vec3 = point.map((value, i) => value - vertex[i]) as Vec3;
      const shift = -dot(offset, normal) / denominator;
      return point.map((value, i) => value + shift * u[i]) as Vec3;
    };
    const extendEnd = 0;
    const overshoot = isConcave ? 0 : 0.05;

    const p0: [number, number, number] = [v0[0] - u[0] * extendEnd, v0[1] - u[1] * extendEnd, v0[2] - u[2] * extendEnd];
    const p1: [number, number, number] = [v1[0] + u[0] * extendEnd, v1[1] + u[1] * extendEnd, v1[2] + u[2] * extendEnd];

    if (kind === "chamfer") {
      const C0: [number, number, number] = [p0[0] + overshoot * nAvg[0], p0[1] + overshoot * nAvg[1], p0[2] + overshoot * nAvg[2]];
      const A0: [number, number, number] = [p0[0] + distance * dA[0], p0[1] + distance * dA[1], p0[2] + distance * dA[2]];
      const B0: [number, number, number] = [p0[0] + distance * dB[0], p0[1] + distance * dB[1], p0[2] + distance * dB[2]];

      const C1: [number, number, number] = [p1[0] + overshoot * nAvg[0], p1[1] + overshoot * nAvg[1], p1[2] + overshoot * nAvg[2]];
      const A1: [number, number, number] = [p1[0] + distance * dA[0], p1[1] + distance * dA[1], p1[2] + distance * dA[2]];
      const B1: [number, number, number] = [p1[0] + distance * dB[0], p1[1] + distance * dB[1], p1[2] + distance * dB[2]];

      const vCB = [B0[0] - C0[0], B0[1] - C0[1], B0[2] - C0[2]];
      const vCA = [A0[0] - C0[0], A0[1] - C0[1], A0[2] - C0[2]];
      const crossX = vCB[1] * vCA[2] - vCB[2] * vCA[1];
      const crossY = vCB[2] * vCA[0] - vCB[0] * vCA[2];
      const crossZ = vCB[0] * vCA[1] - vCB[1] * vCA[0];
      const dotU = crossX * u[0] + crossY * u[1] + crossZ * u[2];

      let verts: number[];
      if (dotU > 0) {
        verts = [
          C0[0], C0[1], C0[2],
          B0[0], B0[1], B0[2],
          A0[0], A0[1], A0[2],
          C1[0], C1[1], C1[2],
          B1[0], B1[1], B1[2],
          A1[0], A1[1], A1[2],
        ];
      } else {
        verts = [
          C0[0], C0[1], C0[2],
          A0[0], A0[1], A0[2],
          B0[0], B0[1], B0[2],
          C1[0], C1[1], C1[2],
          A1[0], A1[1], A1[2],
          B1[0], B1[1], B1[2],
        ];
      }
      const tris = [
        0, 2, 1,
        3, 4, 5,
        0, 1, 4, 0, 4, 3,
        1, 2, 5, 1, 5, 4,
        2, 0, 3, 2, 3, 5,
      ];

      for (let i = 0; i < 6; i++) {
        const point = miterProfile(verts.slice(i * 3, i * 3 + 3) as Vec3, i < 3);
        verts.splice(i * 3, 3, ...point);
      }

      const prismMesh = new manifold.Mesh({
        numProp: 3,
        vertProperties: Float32Array.from(verts),
        triVerts: Uint32Array.from(tris),
      });
      const prism = new MeshShape(new manifold.Manifold(prismMesh));
      currentSolid = isConcave ? currentSolid.fuse(prism) : currentSolid.cut(prism);
    } else {
      const arcSteps = 8;
      const profile0: [number, number, number][] = [];
      const profile1: [number, number, number][] = [];

      const C0: [number, number, number] = [p0[0] + overshoot * nAvg[0], p0[1] + overshoot * nAvg[1], p0[2] + overshoot * nAvg[2]];
      const C1: [number, number, number] = [p1[0] + overshoot * nAvg[0], p1[1] + overshoot * nAvg[1], p1[2] + overshoot * nAvg[2]];
      profile0.push(C0);
      profile1.push(C1);

      for (let s = 0; s <= arcSteps; s++) {
        const t = s / arcSteps;
        const theta = (Math.PI / 2) * t;
        const wA = 1 - Math.sin(theta);
        const wB = 1 - Math.cos(theta);
        profile0.push([
          p0[0] + distance * (wA * dA[0] + wB * dB[0]),
          p0[1] + distance * (wA * dA[1] + wB * dB[1]),
          p0[2] + distance * (wA * dA[2] + wB * dB[2]),
        ]);
        profile1.push([
          p1[0] + distance * (wA * dA[0] + wB * dB[0]),
          p1[1] + distance * (wA * dA[1] + wB * dB[1]),
          p1[2] + distance * (wA * dA[2] + wB * dB[2]),
        ]);
      }

      const v01 = [profile0[1][0] - profile0[0][0], profile0[1][1] - profile0[0][1], profile0[1][2] - profile0[0][2]];
      const v02 = [profile0[2][0] - profile0[0][0], profile0[2][1] - profile0[0][1], profile0[2][2] - profile0[0][2]];
      const crX = v01[1] * v02[2] - v01[2] * v02[1];
      const crY = v01[2] * v02[0] - v01[0] * v02[2];
      const crZ = v01[0] * v02[1] - v01[1] * v02[0];
      const dotU = crX * u[0] + crY * u[1] + crZ * u[2];

      const K = profile0.length;
      const verts: number[] = [];
      for (const p of profile0) verts.push(...miterProfile(p, true));
      for (const p of profile1) verts.push(...miterProfile(p, false));

      const tris: number[] = [];
      for (let i = 1; i < K - 1; i++) {
        if (dotU > 0) tris.push(0, i + 1, i);
        else tris.push(0, i, i + 1);
      }
      for (let i = 1; i < K - 1; i++) {
        if (dotU > 0) tris.push(K, K + i, K + i + 1);
        else tris.push(K, K + i + 1, K + i);
      }
      for (let i = 0; i < K; i++) {
        const next = (i + 1) % K;
        if (dotU > 0) {
          tris.push(i, next, K + next, i, K + next, K + i);
        } else {
          tris.push(i, K + next, next, i, K + i, K + next);
        }
      }

      const prismMesh = new manifold.Mesh({
        numProp: 3,
        vertProperties: Float32Array.from(verts),
        triVerts: Uint32Array.from(tris),
      });
      const prism = new MeshShape(new manifold.Manifold(prismMesh));
      currentSolid = isConcave ? currentSolid.fuse(prism) : currentSolid.cut(prism);
    }
  }

  if (currentSolid.isEmpty || currentSolid.volume() <= 1e-9) return null;

  // Boolean cuts at a corner can leave a detached offcut component.  Keep
  // the principal body so a thin floating strip cannot survive the finish.
  try {
    const parts = (currentSolid.wrapped as any).decompose?.() as any[] | undefined;
    if (parts && parts.length > 1) {
      let largest = parts[0];
      let largestVolume = typeof largest.volume === "function" ? largest.volume() : 0;
      for (let i = 1; i < parts.length; i++) {
        const candidateVolume = typeof parts[i].volume === "function" ? parts[i].volume() : 0;
        if (candidateVolume > largestVolume) {
          largest = parts[i];
          largestVolume = candidateVolume;
        }
      }
      currentSolid = new MeshShape(largest);
    }
  } catch {
    // Decomposition is a cleanup pass; retain the valid boolean result if
    // the backend does not expose it for this manifold version.
  }
  return currentSolid;
}

/**
 * Creates a hollow shell with wall thickness `op.thickness` on a MeshShape.
 * Uses Manifold's minkowskiDifference with a sphere to compute the exact inner cavity,
 * and extrudes the selected opening face(s) outward to connect the cavity through the exterior.
 */
function hollowMesh(solid: MeshShape, op: ShellOp): MeshShape | null {
  const thickness = Math.max(0.01, op.thickness);
  const raw = solid.wrapped.getMesh();
  const numTris = raw.triVerts.length / 3;
  if (numTris === 0) return null;

  const manifold = getManifold() as any;
  const ball = manifold._Sphere ? manifold._Sphere(thickness, 12) : manifold.sphere(thickness, 12);
  let inner: any;
  try {
    inner = solid.wrapped.minkowskiDifference(ball);
  } catch {
    return null;
  }
  if (inner.isEmpty() || inner.volume() <= 1e-6) {
    return null;
  }

  if (op.normal && op.bottomThickness !== undefined) {
    const n = op.normal;
    let lowest = Infinity;
    for (let i = 0; i < raw.vertProperties.length; i += raw.numProp) {
      lowest = Math.min(lowest, n[0] * raw.vertProperties[i] + n[1] * raw.vertProperties[i + 1] + n[2] * raw.vertProperties[i + 2]);
    }
    inner = inner.trimByPlane(n, lowest + Math.max(thickness, op.bottomThickness));
    if (inner.isEmpty()) return null;
  }
  const openingCutters = [];
  for (const point of op.points ?? []) {
    if (!op.normal) return null;
    const cutter = meshShellOpening(solid, point, op.normal, thickness, op.openingInset ?? thickness);
    if (!cutter || cutter.intersect(inner).volume() <= 1e-8) return null;
    openingCutters.push(cutter);
  }
  let fullCavity = inner;
  for (const cutter of openingCutters) {
    fullCavity = fullCavity.add(cutter);
  }

  try {
    const shelled = solid.wrapped.subtract(fullCavity);
    if (shelled.isEmpty() || shelled.volume() <= 1e-6) return null;
    return new MeshShape(shelled);
  } catch {
    return null;
  }
}

/**
 * Builds the stable portion of a live push/pull preview: the edit's base and
 * every already-committed operation, excluding the tentative final operation
 * whose distance changes on every pointer move. The worker caches this solid
 * for the duration of a drag, which is especially important when the base is
 * a group whose children require several boolean operations to combine.
 */
export async function makePushPullPreviewBase(spec: EditSpec): Promise<Shape3D | null> {
  const solid = await makeLocal({ ...spec, ops: spec.ops.slice(0, -1) });
  return !solid || isMesh(solid) ? null : solid;
}

/** Applies only the changing final operation to a cached preview base. */
export function applyPushPullPreview(base: Shape3D, op: PushPullOp): Shape3D | null {
  const face = findFace(base, op.point, op.normal);
  return face ? pushPullFace(base, face, op.distance) : null;
}

/** True if a sphere sits anywhere below this node — the seam bug's only
 *  possible source, so the only case worth rebuilding for. */
function hasSphereDeep(spec: NodeSpec): boolean {
  if (spec.type === "object") return spec.kind === "sphere";
  if (spec.type === "group") return spec.children.some(hasSphereDeep);
  if (spec.type === "edit") return hasSphereDeep(spec.base);
  if (spec.type === "build") return spec.sources.some(hasSphereDeep);
  return false;
}

/** respin() applied to every sphere below this node, wherever it sits. */
function respinDeep(spec: NodeSpec): NodeSpec {
  if (spec.type === "object") return respin(spec);
  if (spec.type === "group") return { ...spec, children: spec.children.map(respinDeep) };
  if (spec.type === "edit") return { ...spec, base: respinDeep(spec.base) };
  if (spec.type === "build") return { ...spec, sources: spec.sources.map(respinDeep) };
  return spec;
}

/**
 * Replays an edit's push/pull history, retrying once with the seam moved if
 * the result comes out cracked.
 *
 * The sphere-seam weakness is not confined to the boolean that first
 * introduces the sphere — makeLocal already guards that one. A base group can
 * combine perfectly cleanly (measured: watertight) and only crack once a
 * push/pull cuts a face that traces back to the sphere's surface, which is
 * work that happens here, after that guard has already passed. Moving the
 * seam is geometrically a no-op (a sphere is symmetric about its own axis,
 * and place() rotates it about an axis its centre already sits on), so the
 * rebuilt history describes the same shape — the recorded op points still
 * resolve — it simply avoids the parameterisation OCCT mishandles.
 */
/**
 * Which edits have already been found to need their seam moved, keyed by the
 * geometry that decides it (the base and the ops, not the node's placement).
 *
 * Worth caching because the discovery is expensive in a way the fix is not:
 * finding out costs a full replay of the history, a tessellation to inspect
 * it, a SECOND full replay against the respun base, and a second
 * tessellation. Acting on a known answer costs one replay and no
 * tessellation at all. Nothing about that answer changes between builds
 * while the base and ops are identical, so on a model heavy enough for this
 * to matter — measured at ~4.5s of the 11.2s merged build of a reported
 * document — every rebuild after the first pays a fraction of it.
 */
const seamRespinCache = new Map<string, boolean>();
const SEAM_CACHE_LIMIT = 64;

function rememberSeam(key: string, needsRespin: boolean) {
  // Plain FIFO eviction: this only ever holds one boolean per distinct edit,
  // so the cap exists to bound a long session, not to be clever about it.
  if (seamRespinCache.size >= SEAM_CACHE_LIMIT) {
    const oldest = seamRespinCache.keys().next().value;
    if (oldest !== undefined) seamRespinCache.delete(oldest);
  }
  seamRespinCache.set(key, needsRespin);
}

async function makeEdit(
  spec: EditSpec,
  onError?: (id: string, msg: string) => void,
  onProgress?: (id: string) => void,
): Promise<AnySolid | null> {
  // No sphere below it means no seam to move — the overwhelmingly common
  // case, and it must not pay for any of the machinery below.
  if (!hasSphereDeep(spec.base)) return replayEdit(spec, onError, onProgress);

  const key = JSON.stringify([spec.base, spec.ops]);
  const remembered = seamRespinCache.get(key);
  if (remembered !== undefined) {
    return replayEdit(
      remembered ? { ...spec, base: respinDeep(spec.base) } : spec,
      onError,
      onProgress,
    );
  }

  const first = await replayEdit(spec, onError, onProgress);
  if (!first) return first;
  if (isMesh(first) || isWatertight(first)) {
    rememberSeam(key, false);
    return first;
  }

  // Errors were already reported on the first pass; a second identical set
  // from the retry would just duplicate them.
  const retry = await replayEdit({ ...spec, base: respinDeep(spec.base) }, undefined, onProgress);
  if (retry && !isMesh(retry) && isWatertight(retry)) {
    rememberSeam(key, true);
    return retry;
  }
  // Neither form is clean, so there is nothing useful to remember: leaving it
  // uncached lets a later build try again rather than locking in a guess.
  return first;
}

async function replayEdit(
  spec: EditSpec,
  onError?: (id: string, msg: string) => void,
  onProgress?: (id: string) => void,
): Promise<AnySolid | null> {
  const base = await makeLocal(spec.base, onError, onProgress);
  if (!base) return null;

  // A skipped op, not an aborted chain: stopping here entirely (as this
  // once did) meant one unrecoverable op anywhere in the history — from an
  // edit made before findFace() got more precise, say — permanently froze
  // every op AFTER it too, including any brand new one a user tries to add
  // going forward (this is exactly the bug behind a report of "the shape
  // doesn't resize while dragging, then fails on release": the live preview
  // and the real commit both append the new op at the END of the list, so
  // both silently never got past the earlier failure to even try it).
  // Skipping instead means the object stays editable — go-forward edits
  // keep working — while still surfacing the same error for whichever op
  // could not be replayed.
  let solid = base;
  for (const op of spec.ops) {
    if (op.kind === "fillet" || op.kind === "chamfer") {
      if (isMesh(solid)) {
        let anchors = op.points?.length ? op.points : [op.point];
        if (op.face && !op.points?.length) {
          anchors = findMeshFaceBoundaryAnchors(solid, op.face.point, op.face.normal);
        }
        const edited = finishMeshEdge(solid, anchors, op.distance, op.kind);
        if (!edited) {
          onError?.(spec.id, `That ${op.kind} could not be applied at this size; the previous shape was kept.`);
        } else {
          solid = edited;
        }
        continue;
      }
      try {
        const anchors = op.points?.length ? op.points : [op.point];
        const targetFace = op.face ? findFace(solid, op.face.point, op.face.normal) : null;
        const faceEdges = targetFace ? sharpBorderEdges(solid, targetFace) : undefined;
        if (op.face && !targetFace?.edges.length) {
          onError?.(spec.id, "The selected face border could not be found after rebuilding — select it again.");
          continue;
        }
        if (op.face && !faceEdges?.length) {
          // Every edge round this face has already been softened by an
          // earlier pass, so there is nothing left to do rather than
          // anything wrong.
          continue;
        }
        // NOT finder.inList(faceEdges) — replicad's inList matches through
        // OCCT's IsSame(), which ignores Location and compares only the
        // underlying TShape. Duplicate features built by cloning the same
        // prototype (Alt-drag duplicate, say — four identical prongs off one
        // base box) share that TShape, so inList silently matched the same
        // edge on every duplicate instead of just the one on the selected
        // face. Anchoring by each edge's own 3D midpoint is Location-aware
        // and only ever matches the edges actually on that face.
        const edgeSelector = faceEdges
          ? edgesAt(faceEdges.map((edge) => edge.pointAt(0.5).toTuple()))
          : edgesAt(anchors);
        let candidate: Shape3D;
        try {
          candidate = (op.kind === "fillet"
            ? solid.fillet(op.distance, edgeSelector)
            : solid.chamfer(op.distance, edgeSelector)) as Shape3D;
        } catch (firstError) {
          if (!faceEdges && /no edge was selected/i.test(firstError instanceof Error ? firstError.message : String(firstError))) {
            const fallbackSelector = edgesAt(anchors, EDGE_ANCHOR_FALLBACK_TOLERANCE);
            candidate = (op.kind === "fillet"
              ? solid.fillet(op.distance, fallbackSelector)
              : solid.chamfer(op.distance, fallbackSelector)) as Shape3D;
          } else {
            throw firstError;
          }
        }
        if (
          !isOcctValid(candidate) || tessellatesEmpty(candidate) || !isWatertight(candidate) ||
          !noNewSplit(solid, candidate)
        ) {
          onError?.(spec.id, `That ${op.kind} would create an invalid shape; the previous shape was kept.`);
        } else {
          solid = candidate;
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        onError?.(
          spec.id,
          /no edge was selected/i.test(detail)
            ? "The selected edge could not be found after rebuilding — select it again."
            : `That ${op.kind} is too large for the selected edge.`,
        );
      }
      continue;
    }
    if (op.kind === "shell") {
      if (isMesh(solid) || op.bottomThickness !== undefined || op.openingInset !== undefined) {
        const candidate = hollowMesh(isMesh(solid) ? solid : solid.meshShape(FALLBACK_MESH_QUALITY), op);
        if (candidate) {
          solid = candidate;
        } else {
          onError?.(
            spec.id,
            "That wall cannot fit inside this shape. Try a smaller thickness; tightly rounded corners may need a thinner wall. The previous shape was kept.",
          );
        }
        continue;
      }
      if (!op.points.length) {
        onError?.(spec.id, "That hollow has no opening face left after rebuilding — try redoing it.");
        continue;
      }
      let hollow: AnySolid | null = null;
      const bRepSolid = solid as Shape3D;
      // Rounded boxes are a common container workflow, but OCCT can accept
      // their offset shell and only fail later while producing the display
      // mesh. Use the bounded cavity first for every box-based edit: it is a
      // simple, deterministic subtraction and preserves the outer rounded
      // solid exactly. Generic shapes still use the true offset shell below.
      if (isBoxBased(spec.base)) {
        try {
          const candidate = hollowEditedBox(bRepSolid, op);
          if (candidate && isOcctValid(candidate) && !tessellatesEmpty(candidate) && isWatertight(candidate)) hollow = candidate;
        } catch { /* Keep the original shape if even the bounded cavity fails. */ }
      }
      if (isCylinderBased(spec.base)) {
        try {
          const candidate = hollowEditedCylinder(bRepSolid, op, spec.base);
          if (candidate && isOcctValid(candidate) && !tessellatesEmpty(candidate) && isWatertight(candidate)) hollow = candidate;
        } catch { /* Fall back to shellSolid */ }
      }
      for (let attempt = 0; attempt < 3 && !hollow; attempt++) {
        try {
          const candidate = shellSolid(bRepSolid, op);
          if (isOcctValid(candidate) && !tessellatesEmpty(candidate) && isWatertight(candidate)) hollow = candidate;
        } catch { /* OCCT occasionally needs a clean retry for offset surfaces. */ }
      }
      if (!hollow && op.points.length) {
        try {
          const candidate = hollowMesh(bRepSolid.meshShape(FALLBACK_MESH_QUALITY), op);
          if (candidate) hollow = candidate;
        } catch { /* Fall back to mesh kernel */ }
      }
      if (hollow) {
        solid = hollow;
      } else {
        onError?.(
          spec.id,
          "That wall cannot fit inside this shape. Try a smaller thickness; tightly rounded corners may need a thinner wall. The previous shape was kept.",
        );
      }
      continue;
    }
    if (op.kind === "resizeFace") {
      if (isMesh(solid)) {
        let reason = "That face cannot be resized by this amount; the previous shape was kept.";
        const candidate = resizeMeshFace(solid, op, (message) => { reason = message; });
        if (candidate) solid = candidate;
        else onError?.(spec.id, reason);
        continue;
      }
      const face = findFace(solid, op.point, op.normal);
      if (!face) {
        onError?.(spec.id, "A resized face could not be found after rebuilding — try redoing that edit.");
        continue;
      }
      try {
        const candidate = resizePlanarFace(solid, face, op);
        if (!isOcctValid(candidate) || tessellatesEmpty(candidate) || !isWatertight(candidate)) {
          onError?.(spec.id, "That face resize would create an invalid shape; the previous shape was kept.");
        } else {
          solid = candidate;
        }
      } catch {
        onError?.(spec.id, "That face cannot be resized by this amount; the previous shape was kept.");
      }
      continue;
    }
    if (op.kind === "offsetExtrude") {
      if (isMesh(solid)) {
        const candidate = offsetExtrudeMesh(solid, op);
        if (candidate) solid = candidate;
        else onError?.(spec.id, "That offset cannot be extruded on this face; try a smaller inset. The previous shape was kept.");
        continue;
      }
      const face = findFace(solid, op.point, op.normal);
      if (!face) {
        onError?.(spec.id, "An offset face could not be found after rebuilding — try redoing that edit.");
        continue;
      }
      try {
        const candidate = offsetExtrudeFace(solid, face, op);
        if (!isOcctValid(candidate) || tessellatesEmpty(candidate) || !isWatertight(candidate)) {
          onError?.(spec.id, "That inset leaves nothing of the face to extrude; the previous shape was kept.");
        } else {
          solid = candidate;
        }
      } catch {
        onError?.(spec.id, "That inset leaves nothing of the face to extrude; the previous shape was kept.");
      }
      continue;
    }
    // Anything that is not a push/pull by now is an op this build of the
    // kernel does not know. That happens for real: the worker is NOT hot
    // reloaded, so a page left open across a kernel change keeps running the
    // old one — the UI offers an edit the kernel has never heard of, the op
    // lands in the document, and the shape quietly does not change. Falling
    // through to the push/pull branch made that look like nothing at all
    // (reported twice as "when I click hollow nothing happens"). Say it.
    if (op.kind !== undefined && op.kind !== "pushPull") {
      onError?.(
        spec.id,
        `This shape uses a "${op.kind}" edit that this session cannot build — reload the page (Ctrl+Shift+R) and try again.`,
      );
      continue;
    }
    const faceOp = op as PushPullOp;
    if (isMesh(solid)) {
      const edited = pushPullMesh(solid, faceOp);
      if (!edited) onError?.(spec.id, "A pushed/pulled face could not be found after rebuilding — try redoing that edit.");
      else solid = edited;
      continue;
    }
    const face = findFace(solid, faceOp.point, faceOp.normal);
    if (!face) {
      onError?.(
        spec.id,
        "A pushed/pulled face could not be found after rebuilding — try redoing that edit.",
      );
      continue;
    }
    solid = pushPullFace(solid, face, faceOp.distance);
  }
  return solid;
}

/**
 * Replays spec.ops the same way makeEdit() does and returns just the ones
 * that actually found their face — an op that fails here never can succeed
 * again (the face it targeted is permanently gone; nothing about a LATER
 * edit brings it back), so unlike makeEdit() itself, which skips a dead op
 * but leaves it in place to keep re-failing and re-reporting the same error
 * on every future rebuild forever, this is what lets the app permanently
 * drop it from the node's own ops list instead — see the "Remove broken
 * edit" action wired to this in the app layer. Mirrors makeEdit()'s replay
 * loop exactly; kept as a separate function rather than a flag on makeEdit
 * so that function's existing, already-verified behaviour is untouched.
 */
export async function survivingOps(
  spec: EditSpec,
  onError?: (id: string, msg: string) => void,
  onProgress?: (id: string) => void,
): Promise<EditOp[]> {
  const base = await makeLocal(spec.base, onError, onProgress);
  if (!base) return spec.ops;
  let solid: AnySolid = base;
  const kept: EditOp[] = [];

  /**
   * Runs an op, and only believes a failure after it has failed repeatedly.
   *
   * What this function leaves out is DESTRUCTIVE: pruneDeadOps writes the
   * surviving list straight back over the node's own ops, so an op dropped
   * here is gone from the document for good. And these failures are known to
   * be intermittent — the same OCCT flakiness the group build already retries
   * around — so a single bad roll must not delete a fillet the user made and
   * can still see on screen. A push/pull vanishing is at least obvious; a
   * fillet vanishing just looks like the corners went sharp by themselves.
   */
  const settled = (attempt: () => Shape3D | null): Shape3D | null => {
    for (let tries = 0; tries < 3; tries++) {
      try {
        const candidate = attempt();
        if (candidate && isOcctValid(candidate) && !tessellatesEmpty(candidate) && isWatertight(candidate)) {
          return candidate;
        }
      } catch { /* an intermittent failure earns another go */ }
    }
    return null;
  };

  for (const op of spec.ops) {
    if (op.kind === "fillet" || op.kind === "chamfer") {
      if (isMesh(solid)) {
        let anchors = op.points?.length ? op.points : [op.point];
        if (op.face && !op.points?.length) {
          anchors = findMeshFaceBoundaryAnchors(solid, op.face.point, op.face.normal);
        }
        const candidate = finishMeshEdge(solid, anchors, op.distance, op.kind);
        if (candidate) {
          solid = candidate;
          kept.push(op);
        }
        continue;
      }
      const bRepSolid = solid as Shape3D;
      const anchors = op.points?.length ? op.points : [op.point];
      const targetFace = op.face ? findFace(bRepSolid, op.face.point, op.face.normal) : null;
      const faceEdges = targetFace ? sharpBorderEdges(bRepSolid, targetFace) : undefined;
      if (op.face && !faceEdges?.length) continue;
      // See the matching comment in makeEdit — inList() matches through
      // Location-blind IsSame(), which is wrong for duplicated features.
      const edgeSelector = faceEdges
        ? edgesAt(faceEdges.map((edge) => edge.pointAt(0.5).toTuple()))
        : edgesAt(anchors);
      let candidate = settled(() => (op.kind === "fillet"
        ? bRepSolid.fillet(op.distance, edgeSelector)
        : bRepSolid.chamfer(op.distance, edgeSelector)) as Shape3D);
      if (candidate && !noNewSplit(bRepSolid, candidate)) candidate = null;
      if (!candidate && !faceEdges) {
        const fallbackSelector = edgesAt(anchors, EDGE_ANCHOR_FALLBACK_TOLERANCE);
        candidate = settled(() => (op.kind === "fillet"
          ? bRepSolid.fillet(op.distance, fallbackSelector)
          : bRepSolid.chamfer(op.distance, fallbackSelector)) as Shape3D);
        if (candidate && !noNewSplit(bRepSolid, candidate)) candidate = null;
      }
      if (candidate) {
        solid = candidate;
        kept.push(op);
      }
      continue;
    }
    if (op.kind === "shell") {
      if (isMesh(solid) || op.bottomThickness !== undefined || op.openingInset !== undefined) {
        const candidate = hollowMesh(isMesh(solid) ? solid : solid.meshShape(FALLBACK_MESH_QUALITY), op);
        if (candidate) {
          solid = candidate;
          kept.push(op);
        }
        continue;
      }
      const bRepSolid = solid as Shape3D;
      const candidate = op.points.length ? settled(() => {
        if (isBoxBased(spec.base)) return hollowEditedBox(bRepSolid, op) ?? shellSolid(bRepSolid, op);
        if (isCylinderBased(spec.base)) return hollowEditedCylinder(bRepSolid, op, spec.base) ?? shellSolid(bRepSolid, op);
        return shellSolid(bRepSolid, op);
      }) : null;
      if (candidate) {
        solid = candidate;
        kept.push(op);
      } else if (op.points.length) {
        try {
          const meshCandidate = hollowMesh(bRepSolid.meshShape(FALLBACK_MESH_QUALITY), op);
          if (meshCandidate) {
            solid = meshCandidate;
            kept.push(op);
          }
        } catch { /* Fall back to mesh kernel */ }
      }
      continue;
    }
    if (op.kind === "offsetExtrude") {
      if (isMesh(solid)) {
        const candidate = offsetExtrudeMesh(solid, op);
        if (candidate) { solid = candidate; kept.push(op); }
        continue;
      }
      const bRepSolid = solid as Shape3D;
      const candidate = settled(() => {
        const face = findFace(bRepSolid, op.point, op.normal);
        return face ? offsetExtrudeFace(bRepSolid, face, op) : null;
      });
      if (candidate) {
        solid = candidate;
        kept.push(op);
      }
      continue;
    }
    if (op.kind === "resizeFace") {
      if (isMesh(solid)) {
        const candidate = resizeMeshFace(solid, op);
        if (candidate) { solid = candidate; kept.push(op); }
        continue;
      }
      const bRepSolid = solid as Shape3D;
      const candidate = settled(() => {
        const face = findFace(bRepSolid, op.point, op.normal);
        return face ? resizePlanarFace(bRepSolid, face, op) : null;
      });
      if (candidate) {
        solid = candidate;
        kept.push(op);
      }
      continue;
    }
    // An op this build does not understand is not a DEAD op — dropping it
    // here would delete an edit the user made, permanently, just because the
    // worker predates the feature. Keep it and leave the solid alone.
    if (op.kind !== undefined && op.kind !== "pushPull") {
      kept.push(op);
      continue;
    }
    const faceOp = op as PushPullOp;
    if (isMesh(solid)) {
      const edited = pushPullMesh(solid, faceOp);
      if (edited) {
        solid = edited;
        kept.push(op);
      }
      continue;
    }
    const face = findFace(solid as Shape3D, faceOp.point, faceOp.normal);
    if (!face) continue;
    solid = pushPullFace(solid as Shape3D, face, faceOp.distance);
    kept.push(op);
  }
  return kept;
}

/** OpenCascade can return a closed, tessellatable solid whose local topology
 * is nevertheless invalid (self-intersecting transition wires are common at
 * mixed fillet/chamfer junctions). Those are the pinched corner artifacts a
 * watertight triangle check cannot see. */
function isOcctValid(shape: Shape3D): boolean {
  try {
    const analyzer = new (getOC()).BRepCheck_Analyzer(shape.wrapped, true, false, true);
    const valid = analyzer.IsValid();
    analyzer.delete();
    return valid;
  } catch {
    return false;
  }
}

/**
 * Can this solid actually be turned into triangles?
 *
 * Stronger than measuring it, and the two disagree: a fuse over parts that
 * meet on exactly coincident faces can hand back something OCCT still
 * measures a volume for but tessellates to nothing at all. On screen that is
 * a group that renders as empty space, with no error anywhere — the shape
 * simply vanishes the moment it is grouped.
 */
export function tessellatesEmpty(solid: AnySolid): boolean {
  try {
    const mesh = isMesh(solid) ? solid.mesh() : solid.mesh(SEAM_CHECK_QUALITY);
    return !mesh.triangles || mesh.triangles.length === 0;
  } catch {
    return true;
  }
}

/** Does this solid enclose any volume at all? A cell for a mask whose
 *  sources do not all overlap comes back empty, and empty solids must be
 *  dropped rather than fused into the result. */
export function isEmptySolid(solid: AnySolid): boolean {
  if (isMesh(solid)) return solid.isEmpty || solid.volume() <= 1e-9;
  try {
    return measureVolume(solid) <= 1e-9;
  } catch {
    // A region that cannot be measured is kept, not dropped. A spurious
    // region is visible in the list and can be clicked away; a missing one
    // is invisible, and its absence silently changes the result.
    return false;
  }
}

/**
 * One cell of the arrangement of `solids`: the region inside every source
 * whose bit is set in `mask` and outside all the others. Returns null when
 * that region is empty, which is the common case — most masks over three or
 * four bodies describe overlaps that do not actually happen.
 *
 * Each step falls back to the mesh kernel the same way combine() does, so one
 * OCCT boolean refusing a hard case degrades to manifold instead of losing
 * the cell.
 */
/**
 * One boolean step of a cell, with the empty result treated as suspect.
 *
 * OCCT does not only throw when it cannot do a boolean — it can also hand
 * back an empty solid for a region that plainly exists. A sphere sunk into a
 * box does it: the part of the sphere sticking out is real, visibly so, and
 * cutting the box out of the sphere returns nothing, because the sphere's
 * seam meridian crosses the box's boundary (the same OCCT weakness makeLocal
 * already retries around). Silently dropping that region is what made
 * "subtract the sphere" produce an untouched box: the region the user needed
 * to remove had never been offered.
 *
 * So an empty OCCT result is re-tried on manifold, which has no such seam,
 * and only an empty answer from BOTH kernels counts as genuinely empty.
 */
function cellStep(a: AnySolid, b: AnySolid, op: "intersect" | "cut"): AnySolid | null {
  const asMesh = (s: AnySolid): MeshShape => (isMesh(s) ? s : (s as Shape3D).meshShape(FALLBACK_MESH_QUALITY));

  if (!isMesh(a) && !isMesh(b)) {
    try {
      const out = (op === "intersect"
        ? (a as Shape3D).intersect(b as Shape3D)
        : (a as Shape3D).cut(b as Shape3D)) as AnySolid;
      if (!isEmptySolid(out)) return out;
    } catch {
      // Fall through to the mesh kernel.
    }
  }

  try {
    const out = op === "intersect"
      ? asMesh(a).intersect(asMesh(b))
      : asMesh(a).cut(asMesh(b));
    return isEmptySolid(out) ? null : out;
  } catch {
    return null;
  }
}

export function cellSolid(solids: AnySolid[], mask: number): AnySolid | null {
  const members = solids.filter((_, i) => (mask >> i) & 1);
  const others = solids.filter((_, i) => !((mask >> i) & 1));
  if (!members.length) return null;

  let result: AnySolid | null = members[0];
  for (const other of members.slice(1)) {
    result = cellStep(result, other, "intersect");
    if (!result) return null;
  }
  for (const other of others) {
    result = cellStep(result, other, "cut");
    if (!result) return null;
  }
  return result;
}

/** Every non-empty cell of the arrangement, in mask order. */
export function decompose(solids: AnySolid[]): { mask: number; solid: AnySolid }[] {
  const cells: { mask: number; solid: AnySolid }[] = [];
  for (let mask = 1; mask < 1 << solids.length; mask++) {
    const solid = cellSolid(solids, mask);
    if (solid) cells.push({ mask, solid });
  }
  return cells;
}

/**
 * Combines already-placed children. Children keep their own world transforms,
 * so a group introduces no frame of its own beyond its node transform.
 *
 * If nothing here is (or contains) an import, this runs entirely in Shape3D/
 * OCCT terms, unchanged from before imports existed. The moment an import is
 * involved, EVERY operand is converted to MeshShape first (Shape3D.meshShape()
 * is a direct, supported conversion) and the whole boolean runs on manifold-3d
 * instead — never the other direction, which is the broken path.
 */
export function combine(
  op: GroupOp,
  children: { solid: AnySolid; isHole: boolean }[],
): AnySolid | null {
  if (!children.length) return null;

  // Capture the union envelope before handing any wrapper to either boolean
  // kernel. OCCT operations can mutate more than the result wrapper (even
  // when invoked on a clone), so measuring the operands after an attempt can
  // make a displaced/dropped result validate against already-corrupted input.
  // Plain numbers cannot be changed underneath us and remain the authority
  // for every retry in this combine call.
  const expectedUnionBounds = op === "union"
    ? unionBounds(children.filter((c) => !c.isHole).map((c) => c.solid))
    : null;

  const asMeshed = () =>
    children.map((c) => ({
      solid: isMesh(c.solid) ? c.solid : (c.solid as Shape3D).meshShape(FALLBACK_MESH_QUALITY),
      isHole: c.isHole,
    }));

  // Holes are cut AFTER the fuse, so a hole that reaches the outside makes
  // the finished shape legitimately SMALLER than the envelope of the solids
  // that went into it. Demanding equality there rejects a perfectly correct
  // result — and, because both kernels are then retried and both "fail",
  // returns null for a group that is not broken at all.
  //
  // Measured on a reported document: a group of one solid plus two holes
  // could never build. Its object was invisible, its error said the shape
  // "could not be meshed at the correct position", and since a node that
  // fails is never cached, its full 5-second rebuild was re-attempted on
  // every single scene build for the life of the document. Two such nodes
  // put 10s on the clock of every edit, which is what made Delete look
  // broken.
  //
  // combineShape still holds the fuse ITSELF to the strict equality (see
  // unionKeptEverything) — that is where a dropped operand is detectable.
  // All the finished shape can be held to is that it stayed inside the
  // envelope, which still catches an operand that landed somewhere else.
  const cutsHoles = children.some((c) => c.isHole);
  const boundsHold = (candidate: AnySolid, expected: { min: Vec3; max: Vec3 } | null, tol = 0.25) =>
    op !== "union" || !expected ||
    (cutsHoles ? withinBounds(candidate, expected, tol) : matchesBounds(candidate, expected, tol));

  const usable = (candidate: AnySolid | null, expected: { min: Vec3; max: Vec3 } | null, tol = 0.25) =>
    !!candidate &&
    !isEmptySolid(candidate) &&
    !tessellatesEmpty(candidate) &&
    boundsHold(candidate, expected, tol);

  // A failed manifold boolean does not necessarily throw; on this model it
  // occasionally returns a perfectly renderable union with one operand in
  // the wrong place. Every attempt needs fresh wrappers, and only a result
  // whose bounds match the immutable inputs is allowed out.
  const retryMesh = (attempts = 2): MeshShape | null => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const meshed = asMeshed();
      // Judge a MESHED result against MESHED operands. Tessellation inscribes
      // a curved surface — the triangles never quite reach it — so a meshed
      // shape is legitimately a hair smaller than the exact BRep envelope its
      // operands report, and at FALLBACK_MESH_QUALITY that gap is wider than
      // 0.05mm. Attempt 0 tests strict bounds; attempt 1 allows 0.25mm facet tolerance.
      const expected = op === "union"
        ? unionBounds(meshed.filter((c) => !c.isHole).map((c) => c.solid))
        : null;
      const candidate = combineMesh(op, meshed);
      const tol = attempt === 0 ? 0.05 : 0.25;
      if (usable(candidate, expected, tol)) return candidate;
    }
    return null;
  };

  if (children.some((c) => isMesh(c.solid))) {
    // Manifold drops an operand from a union about as readily as OCCT does on
    // this kind of model — measured on a reported bracket, roughly one build
    // in eight lost a whole sub-assembly with no error raised. Whatever comes
    // back has to still reach as far as what went in. Never return the bad
    // candidate merely because the next attempt was bad too.
    return retryMesh();
  }

  const result = combineShape(op, children as { solid: Shape3D; isHole: boolean }[]);

  // OCCT does not only throw when a boolean defeats it. It can hand back an
  // empty solid, or one that measures a volume but cannot be turned into
  // triangles at all — parts meeting on exactly coincident faces do it, and
  // whether a given fuse survives is not stable from one attempt to the next.
  // combineShape's own retries only catch the throw, so on the bad attempts
  // the shape silently came out as nothing: a group that renders as empty
  // space, or worse, an STL with no triangles in it and no error anywhere.
  //
  // Manifold does not share the weakness, so anything unusable is checked
  // against it before being believed. Tessellating to check costs a mesh per
  // combine; a boolean already costs far more than that, and a silently empty
  // export costs a print.
  if (usable(result, expectedUnionBounds)) return result;

  const viaMesh = retryMesh();
  if (viaMesh) return viaMesh;

  // Both kernels agree there is nothing here, which a subtraction is entitled
  // to produce. Anything else keeps whatever OCCT managed.
  return op === "union" ? null : result;
}

function combineShape(
  op: GroupOp,
  children: { solid: Shape3D; isHole: boolean }[],
): AnySolid | null {
  if (op === "subtract") {
    // OCCT boolean builders may consume or mutate either wrapper handed to
    // them. Groups are rebuilt repeatedly, and reusing those wrappers made a
    // later build occasionally start from an already-altered child — the
    // visible part then jumped even though its document transform was still
    // unchanged. Keep the source solids immutable and boolean disposable
    // clones instead.
    let result = children[0].solid.clone();
    for (let i = 1; i < children.length; i++) {
      try {
        result = result.cut(children[i].solid.clone()) as Shape3D;
      } catch {
        const meshed = children.map((c) => ({
          solid: isMesh(c.solid) ? c.solid : (c.solid as Shape3D).meshShape(FALLBACK_MESH_QUALITY),
          isHole: c.isHole,
        }));
        return combineMesh(op, meshed);
      }
    }
    return result;
  }
  if (op === "intersect") {
    let result = children[0].solid.clone();
    for (let i = 1; i < children.length; i++) {
      try {
        result = result.intersect(children[i].solid.clone()) as Shape3D;
      } catch {
        const meshed = children.map((c) => ({
          solid: isMesh(c.solid) ? c.solid : (c.solid as Shape3D).meshShape(FALLBACK_MESH_QUALITY),
          isHole: c.isHole,
        }));
        return combineMesh(op, meshed);
      }
    }
    return result;
  }
  const solids = children.filter((c) => !c.isHole);
  const holes = children.filter((c) => c.isHole);
  if (!solids.length) return null;
  const meshedAll = () =>
    children.map((c) => ({
      solid: isMesh(c.solid) ? c.solid : (c.solid as Shape3D).meshShape(FALLBACK_MESH_QUALITY),
      isHole: c.isHole,
    }));
  let result = solids[0].solid.clone();
  for (let i = 1; i < solids.length; i++) {
    try {
      result = result.fuse(solids[i].solid.clone()) as Shape3D;
    } catch {
      const meshed = children.map((c) => ({
        solid: isMesh(c.solid) ? c.solid : (c.solid as Shape3D).meshShape(FALLBACK_MESH_QUALITY),
        isHole: c.isHole,
      }));
      return combineMesh(op, meshed);
    }
  }
  // Everything that went into the fuse has to still be in it. A dropped
  // operand is one failure mode and unionKeptEverything catches it by
  // bounds — but a self-intersecting fuse can keep the full envelope while
  // folding surface back on itself, which bounds cannot see at all: the
  // result still reaches every edge the operands did, it just measures
  // LESS material than its largest single operand, which a union can never
  // legitimately do. suspicious() is that second, volume-based check —
  // reported on a rotated filleted box unioned with a plain box, which
  // fused into exactly this kind of invalid solid on every attempt (not
  // intermittently, so retrying the same OCCT call alone never helped) and
  // surfaced only as "the group vanished, undo and retry" with nothing a
  // retry could actually fix.
  if (!unionKeptEverything(result, solids.map((c) => c.solid)) || suspicious("union", result, solids)) {
    const viaMesh = combineMesh("union", meshedAll());
    if (viaMesh) return viaMesh;
  }

  for (const h of holes) {
    try {
      result = result.cut(h.solid.clone()) as Shape3D;
    } catch {
      const meshed = children.map((c) => ({
        solid: isMesh(c.solid) ? c.solid : (c.solid as Shape3D).meshShape(FALLBACK_MESH_QUALITY),
        isHole: c.isHole,
      }));
      return combineMesh(op, meshed);
    }
  }
  return result;
}

/** Same three ops, run through manifold-3d instead of OCCT — used whenever an
 *  import is anywhere in the operands. */
function combineMesh(
  op: GroupOp,
  children: { solid: MeshShape; isHole: boolean }[],
): MeshShape | null {
  if (op === "subtract") {
    let result = children[0].solid.clone();
    for (let i = 1; i < children.length; i++) result = result.cut(children[i].solid.clone());
    return result;
  }
  if (op === "intersect") {
    let result = children[0].solid.clone();
    for (let i = 1; i < children.length; i++) result = result.intersect(children[i].solid.clone());
    return result;
  }
  const solids = children.filter((c) => !c.isHole);
  const holes = children.filter((c) => c.isHole);
  if (!solids.length) return null;
  let result = solids[0].solid.clone();
  for (let i = 1; i < solids.length; i++) result = result.fuse(solids[i].solid.clone());
  for (const h of holes) result = result.cut(h.solid.clone());
  return result;
}

type GroupOp = "union" | "subtract" | "intersect";

/**
 * Folds a NON-UNIFORM scale into a primitive's own parameters when doing so
 * is exactly equivalent, so the node never has to leave the OCCT/Shape3D
 * path at all.
 *
 * This matters far more than it looks. OCCT cannot scale non-uniformly, so
 * place() falls back to converting the solid to a MeshShape — and because
 * combine() resolves any group containing a MeshShape entirely in MeshShape
 * terms, ONE non-uniformly scaled child silently drags its whole group (and
 * every push/pull edit above it) onto the triangle-mesh path, which is far
 * newer and less robust than the BRep one. A user who merely dragged a
 * corner handle with "lock proportions" off has no way to know they just
 * changed which geometry kernel their model is built with.
 *
 * A primitive is built axis-aligned and then normalised (centred in XY,
 * base on z = 0) before place() scales it about its own bounding-box
 * centre, so for a box "scale by [sx,sy,sz]" and "build it sx/sy/sz times
 * bigger" describe the same solid — as long as the conditions below hold:
 *
 *  - fillet must be 0: scaling a filleted box non-uniformly turns its round
 *    edges elliptical, which re-building at the new size would not reproduce.
 *  - a cylinder may only be scaled uniformly in XY, or its circular section
 *    becomes an ellipse, which makeCylinder cannot express.
 *  - rx and ry must be 0. Scaling in Z moves the base off z = 0 (the shape
 *    is scaled about its centre, not its base), so the baked version needs a
 *    compensating Z shift. position is applied AFTER rotation, so that shift
 *    only stays a pure Z translation while nothing tips the Z axis over —
 *    rotation about Z alone is fine and stays allowed.
 */
function bakeNonUniformScale(spec: NodeSpec): NodeSpec {
  if (spec.type !== "object") return spec;
  const [sx, sy, sz] = spec.scale;
  if (sx === sy && sy === sz) return spec; // uniform — OCCT scales this directly
  if (!(sx > 0 && sy > 0 && sz > 0)) return spec;
  // Rotation is deliberately allowed here — see bakeScale in document/bake.ts
  // for why (place() scales in the node's own frame first) and what it costs
  // a face-snapped box when it is not.

  const p = spec.params;
  let params: Record<string, number>;
  let height: number;
  if (spec.kind === "box") {
    height = p.height;
    params = { ...p, width: p.width * sx, depth: p.depth * sy, height: p.height * sz };
  } else if (spec.kind === "cylinder" && sx === sy) {
    height = p.height;
    params = { ...p, radius: p.radius * sx, height: p.height * sz };
  } else if (spec.kind === "triangle") {
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
      return spec;
    }
  } else if (spec.kind === "tray") {
    height = p.height;
    params = {
      ...p,
      width: Math.round(p.width * sx * 100) / 100,
      depth: Math.round(p.depth * sy * 100) / 100,
      height: Math.round(p.height * sz * 100) / 100,
    };
  } else {
    return spec;
  }

  // Re-normalising puts the baked shape's base back on z = 0, while scaling
  // about the centre would have left it at height * (1 - sz) / 2. That offset
  // is along the node's own z, so it is rotated into world space the same way
  // place() rotates the solid — identity when there is no rotation.
  const [px, py, pz] = spec.position;
  const [ox, oy, oz] = rotateLocalOffset([0, 0, (height * (1 - sz)) / 2], spec.rotation);
  return {
    ...spec,
    params,
    scale: [1, 1, 1],
    position: [px + ox, py + oy, pz + oz],
  };
}

/**
 * Applies rotation (about the node origin) then translation. Works on either
 * kernel's solid — both expose the same translate/rotate signatures.
 *
 * Order matters here as much as the angles do. The viewport shows a
 * standalone object's rotation by setting a plain THREE.Group's rotation to
 * [rx, ry, rz] with Euler order 'XYZ' — which, despite the name, composes as
 * Rx·Ry·Rz (three.js's own Matrix4.makeRotationFromEuler for 'XYZ' builds
 * exactly that product). A GROUPED object's rotation, by contrast, is baked
 * directly into the returned solid's geometry by THIS function, on the
 * kernel side — so it has to reproduce that same Rx·Ry·Rz composition, not
 * just use the same three angles in the order they're listed.
 *
 * Reported: a compound-rotated filleted box read as visibly re-oriented
 * (~4° off a fitted surface normal, verified by sampling three points on a
 * flat face before/after) the instant it was grouped with anything, even
 * though nothing about its rotation value ever changed. Measured cause: this
 * function was rotating X, then Y, then Z — each about the fixed global
 * axis, which composes to Rz·Ry·Rx, the reverse product. Rz·Ry·Rx and
 * Rx·Ry·Rz only agree when the rotations commute, which three arbitrary
 * non-zero Euler angles essentially never do. Applying the SAME three
 * global-axis rotations in the opposite order — Z, then Y, then X — is what
 * actually composes to Rx·Ry·Rz, matching the viewport exactly.
 *
 * manifold-3d's own single-call rotate([x, y, z]) documents the identical
 * X-then-Y-then-Z global-axis composition (Rz·Ry·Rx) as the three
 * sequential OCCT .rotate() calls below, so the MeshShape branch needed the
 * same reversal — three single-axis calls, not one three-axis call.
 */
export function place(s: AnySolid, spec: NodeSpec): AnySolid {
  const [rx, ry, rz] = spec.rotation;
  let out = s;
  if (isMesh(out)) {
    const [min, max] = getSolidBounds(out);
    const center: Vec3 = [
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2,
    ];
    let wrapped = out.wrapped
      .translate([-center[0], -center[1], -center[2]])
      .scale(spec.scale)
      .translate(center);
    if (rz) wrapped = wrapped.rotate([0, 0, rz]);
    if (ry) wrapped = wrapped.rotate([0, ry, 0]);
    if (rx) wrapped = wrapped.rotate([rx, 0, 0]);
    return new MeshShape(wrapped.translate(spec.position));
  }
  if (spec.scale.some((v) => v !== 1)) {
    const [min, max] = out.boundingBox.bounds;
    const center: Vec3 = [
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2,
    ];
    const [sx, sy, sz] = spec.scale;
    if (Math.abs(sx - sy) < 1e-9 && Math.abs(sx - sz) < 1e-9) {
      out = out.scale(sx, center);
    } else {
      const mesh = out.meshShape(FALLBACK_MESH_QUALITY);
      let wrapped = mesh.wrapped
        .translate([-center[0], -center[1], -center[2]])
        .scale(spec.scale)
        .translate(center);
      if (rz) wrapped = wrapped.rotate([0, 0, rz]);
      if (ry) wrapped = wrapped.rotate([0, ry, 0]);
      if (rx) wrapped = wrapped.rotate([rx, 0, 0]);
      return new MeshShape(wrapped.translate(spec.position));
    }
  }
  if (rz) out = out.rotate(rz, [0, 0, 0], [0, 0, 1]);
  if (ry) out = out.rotate(ry, [0, 0, 0], [0, 1, 0]);
  if (rx) out = out.rotate(rx, [0, 0, 0], [1, 0, 0]);
  return out.translate(spec.position);
}

/**
 * Cheap sanity checks that catch a silently-failed boolean:
 *  - a union can never be smaller than its largest operand;
 *  - a subtraction that removes *everything* is usually a failure, though it
 *    can legitimately happen when the first child is fully enclosed.
 * Only meaningful for the Shape3D/OCCT path — the sphere-seam bug this guards
 * against is an OCCT quirk; manifold-3d's booleans do not have it.
 */
function suspicious(
  op: GroupOp,
  result: AnySolid,
  kids: { solid: AnySolid; isHole: boolean }[],
): boolean {
  if (isMesh(result)) return false;
  // MeshShape children cannot be measured with OCCT's measureVolume; their
  // presence also means the boolean ran through manifold-3d which doesn't
  // have the sphere-seam bug this check guards against — skip entirely.
  if (kids.some((k) => isMesh(k.solid))) return false;
  try {
    const volume = measureVolume(result);
    if (op === "union") {
      if (kids.some((k) => k.isHole)) return false;
      const largest = Math.max(
        ...kids.map((k) => {
          try {
            return measureVolume(k.solid as Shape3D);
          } catch {
            return 0;
          }
        }),
      );
      return volume < largest - 1e-6;
    }
    if (op === "subtract") return volume <= 1e-9;
    return false;
  } catch {
    return false;
  }
}

/**
 * Tessellation used only to probe a result for seam cracks — never to display
 * or export anything. Deliberately matches EDIT_QUALITY in worker.ts rather
 * than being cheaper: the cracks do NOT show up at any density (measured — a
 * 0.1mm probe reported the very shape this was written for as watertight,
 * while the 0.05mm display mesh of it had 29 open edges), because how finely
 * OCCT splits a shared edge is what decides whether the two faces either side
 * happen to agree. Probing at the density the mesh is actually built at is
 * what makes the check mean anything. Still nowhere near OCCT's default,
 * which is the setting that can exhaust the WASM heap on a sphere.
 */
const SEAM_CHECK_QUALITY = { tolerance: 0.08, angularTolerance: 0.20 };

/**
 * Tessellation used when a solid has to become a mesh so manifold can finish
 * a boolean OCCT could not.
 *
 * meshShape() with no argument takes OCCT's own default of about 0.001mm,
 * which this file already documents as the setting that turns one sphere into
 * six figures of triangles. Handing that to manifold for every operand of a
 * failed group boolean is how the rescue path came to fail as well, leaving
 * the group empty and the model gone. The display quality is plenty for a
 * boolean whose result is about to be tessellated at that quality anyway.
 */

/** World bounds of a solid, or null when it will not report any. */
export function boundsOf(solid: AnySolid): { min: Vec3; max: Vec3 } | null {
  try {
    const [min, max] = solid.boundingBox.bounds;
    const box = { min: min as Vec3, max: max as Vec3 };
    return box.min.every(Number.isFinite) && box.max.every(Number.isFinite) ? box : null;
  } catch {
    return null;
  }
}

function unionBounds(operands: AnySolid[]): { min: Vec3; max: Vec3 } | null {
  const bounds = { min: [Infinity, Infinity, Infinity] as Vec3, max: [-Infinity, -Infinity, -Infinity] as Vec3 };
  for (const operand of operands) {
    const box = boundsOf(operand);
    if (!box) return null;
    for (let i = 0; i < 3; i++) {
      bounds.min[i] = Math.min(bounds.min[i], box.min[i]);
      bounds.max[i] = Math.max(bounds.max[i], box.max[i]);
    }
  }
  return bounds.min.every(Number.isFinite) ? bounds : null;
}

/** A shape that never reaches OUTSIDE `expected`. All that can be asked of a
 *  union whose holes have since been cut out of it — see combine(). */
function withinBounds(result: AnySolid, expected: { min: Vec3; max: Vec3 }, tol = 0.25): boolean {
  const got = boundsOf(result);
  if (!got) return false;
  return [0, 1, 2].every(
    (i) => got.min[i] >= expected.min[i] - tol && got.max[i] <= expected.max[i] + tol,
  );
}

function matchesBounds(result: AnySolid, expected: { min: Vec3; max: Vec3 }, tol = 0.25): boolean {
  const got = boundsOf(result);
  if (!got) return false;
  return [0, 1, 2].every(
    (i) => Math.abs(got.min[i] - expected.min[i]) <= tol && Math.abs(got.max[i] - expected.max[i]) <= tol,
  );
}

/**
 * Did the fuse actually keep everything it was given?
 *
 * A union can only ever reach as far as its operands do, and it must reach
 * exactly that far — so its bounds are the union of theirs. When OCCT quietly
 * drops an operand the result is still a perfectly good solid, just missing a
 * part: it is not empty, it tessellates, and every check this file had passed
 * it. What the user sees is a group with a piece of the model gone or left
 * behind somewhere else.
 *
 * A 0.25mm tolerance absorbs ordinary tessellation/kernel noise while still
 * rejecting the smallest observed failed placement, which was a full 1mm.
 */
export function unionKeptEverything(result: AnySolid, operands: AnySolid[]): boolean {
  const expected = unionBounds(operands);
  return expected ? matchesBounds(result, expected, 0.25) : true;
}

/**
 * True when a solid tessellates into a closed surface — every edge shared by
 * exactly two triangles.
 *
 * This exists because suspicious() cannot see the failure mode it is paired
 * with. A sphere seam landing badly does not always produce a solid whose
 * VOLUME looks wrong; it can produce one that measures perfectly sensibly and
 * still meshes with cracks along the seam, because the two faces either side
 * discretise the shared edge differently. That is invisible in the viewport
 * (the gaps are hairline) but it is not invisible downstream: an STL with
 * holes is not a closed solid, so slicers have to guess how to patch it, and
 * converting such a shape to a MeshShape — which happens to EVERY operand as
 * soon as one sibling needs the mesh path — makes manifold reject the whole
 * boolean with "Not manifold", failing the export outright.
 */
function isWatertight(s: AnySolid): boolean {
  if (isMesh(s)) return true; // manifold's own invariant — nothing to check
  try {
    const { vertices, triangles } = s.mesh(SEAM_CHECK_QUALITY);
    const ids = new Map<string, number>();
    const canon: number[] = [];
    for (let i = 0; i < vertices.length; i += 3) {
      const key = `${Math.round(vertices[i] * 1e4)},${Math.round(vertices[i + 1] * 1e4)},${Math.round(vertices[i + 2] * 1e4)}`;
      let id = ids.get(key);
      if (id === undefined) {
        id = ids.size;
        ids.set(key, id);
      }
      canon.push(id);
    }
    const edges = new Map<string, number>();
    for (let t = 0; t < triangles.length; t += 3) {
      const a = canon[triangles[t]];
      const b = canon[triangles[t + 1]];
      const c = canon[triangles[t + 2]];
      if (a === b || b === c || a === c) continue; // zero-area, no edges to own
      for (const [x, y] of [[a, b], [b, c], [c, a]]) {
        const key = x < y ? `${x}:${y}` : `${y}:${x}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
    for (const count of edges.values()) if (count !== 2) return false;
    return true;
  } catch {
    // A probe that cannot run says nothing about the shape — treat it as fine
    // rather than forcing a pointless rebuild.
    return true;
  }
}

/**
 * Counts the shape's disconnected pieces (by triangle adjacency across
 * shared mesh edges). Returns null when the probe itself fails, same as
 * isWatertight's own catch-all — "unknown" rather than "broken".
 *
 * A fillet or chamfer edge selection that goes slightly wrong on a
 * multi-feature shape (several prongs off one base, say) can shear a sliver
 * off into its own closed shell instead of visibly failing: each piece is
 * independently watertight by isWatertight's own every-edge-shared-by-two
 * check, which is exactly why that check alone waves a split like this
 * through. This exists to compare the piece count before and after an edit
 * op — legitimately multi-body shapes (an assembly of loose parts, say) stay
 * whatever count they already were; an op that *increases* it went wrong.
 */
function meshComponentCount(s: AnySolid): number | null {
  if (isMesh(s)) return 1;
  try {
    const { vertices, triangles } = s.mesh(SEAM_CHECK_QUALITY);
    const ids = new Map<string, number>();
    const canon: number[] = [];
    for (let i = 0; i < vertices.length; i += 3) {
      const key = `${Math.round(vertices[i] * 1e4)},${Math.round(vertices[i + 1] * 1e4)},${Math.round(vertices[i + 2] * 1e4)}`;
      let id = ids.get(key);
      if (id === undefined) {
        id = ids.size;
        ids.set(key, id);
      }
      canon.push(id);
    }
    const triCount = triangles.length / 3;
    const parent = Array.from({ length: triCount }, (_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
      return i;
    };
    const union = (a: number, b: number) => {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    };
    const edgeTri = new Map<string, number>();
    for (let t = 0; t < triangles.length; t += 3) {
      const a = canon[triangles[t]];
      const b = canon[triangles[t + 1]];
      const c = canon[triangles[t + 2]];
      if (a === b || b === c || a === c) continue;
      const triIndex = t / 3;
      for (const [x, y] of [[a, b], [b, c], [c, a]]) {
        const key = x < y ? `${x}:${y}` : `${y}:${x}`;
        const other = edgeTri.get(key);
        if (other === undefined) edgeTri.set(key, triIndex);
        else union(other, triIndex);
      }
    }
    const roots = new Set<number>();
    for (let t = 0; t < triCount; t++) roots.add(find(t));
    return roots.size;
  } catch {
    return null;
  }
}

/**
 * True when `candidate` didn't come apart into more pieces than `before`
 * already had. Pass-through (true) when either mesh probe fails, or when
 * `before` itself couldn't be counted — this only ever adds a rejection on
 * top of isWatertight's own check, never a new way to block a valid edit.
 */
function noNewSplit(before: AnySolid, candidate: AnySolid): boolean {
  const beforeCount = meshComponentCount(before);
  if (beforeCount === null) return true;
  const afterCount = meshComponentCount(candidate);
  if (afterCount === null) return true;
  return afterCount <= beforeCount;
}

/** Spins a sphere about its own axis: geometrically identical, but it moves
 *  the seam meridian, which is what OCCT actually trips over. */
function respin(spec: NodeSpec): NodeSpec {
  if (spec.type !== "object" || spec.kind !== "sphere") return spec;
  const [rx, ry, rz] = spec.rotation;
  return { ...spec, rotation: [rx, ry, rz + 90] as Vec3 };
}

/**
 * A node in its own frame, before its transform is applied.
 * Leaves are normalised primitives or imports; groups are their evaluated
 * children. Returns null when a group has nothing solid to show.
 *
 * onProgress, when given, fires with a node's id right before that node's
 * OWN work starts (not for groups themselves — their children each report).
 * It exists so a caller racing this against a watchdog timeout (see
 * kernel/client.ts) can tell which node was actually in flight when a call
 * had to be abandoned — an import's mesh-repair step is the one piece of
 * this pipeline that can legitimately run long enough to matter.
 */
/**
 * Rebuilds a Shape Builder result: evaluate the frozen sources where they
 * stand, cut them into cells, and fuse back the ones that were kept.
 */
async function makeBuild(
  spec: BuildSpec,
  onError?: (id: string, msg: string) => void,
  onProgress?: (id: string) => void,
): Promise<AnySolid | null> {
  const solids: AnySolid[] = [];
  for (const source of spec.sources) {
    try {
      const solid = await makeWorld(source, onError, onProgress);
      if (solid) solids.push(solid);
    } catch (e) {
      onError?.(source.id, e instanceof Error ? e.message : String(e));
    }
  }
  if (solids.length < 2) return solids[0] ?? null;

  const kept = spec.keep
    .map((mask) => cellSolid(solids, mask))
    .filter((s): s is AnySolid => !!s);
  if (!kept.length) {
    onError?.(spec.id, "Nothing left in this shape — every region was removed.");
    return null;
  }
  return combine("union", kept.map((solid) => ({ solid, isHole: false })));
}

export async function makeLocal(
  spec: NodeSpec,
  onError?: (id: string, msg: string) => void,
  onProgress?: (id: string) => void,
): Promise<AnySolid | null> {
  // Faceting is the last thing that happens to a node's own shape, after
  // every edit in its history has been replayed onto it. Doing it here rather
  // than as another EditOp is what keeps a fillet or a wall working on the
  // real surface instead of on an already-decimated one.
  // A round-profile primitive is rebuilt with fewer sides rather than
  // decimated, which is what keeps its facets regular — see
  // lowPolyPrimitiveSpec. Everything else falls through to applyLowPoly.
  const coarse = spec.type === "object" && spec.lowPoly
    ? lowPolyPrimitiveSpec(spec, spec.lowPoly)
    : null;
  if (coarse) return buildLocal(coarse, onError, onProgress);

  const built = await buildLocal(spec, onError, onProgress);
  if (!built || !spec.lowPoly) return built;
  try {
    return applyLowPoly(built, spec.lowPoly);
  } catch {
    // Faceting is styling: a shape manifold cannot chew on is still a correct
    // shape, so keep it at full detail rather than failing the whole build.
    onError?.(spec.id, "This shape could not be faceted — showing it at full detail.");
    return built;
  }
}

async function buildLocal(
  spec: NodeSpec,
  onError?: (id: string, msg: string) => void,
  onProgress?: (id: string) => void,
): Promise<AnySolid | null> {
  if (spec.type === "object") {
    onProgress?.(spec.id);
    return makePrimitive(spec);
  }
  if (spec.type === "import") {
    onProgress?.(spec.id);
    return makeImport(spec);
  }
  if (spec.type === "edit") {
    onProgress?.(spec.id);
    return makeEdit(spec, onError, onProgress);
  }
  if (spec.type === "build") {
    onProgress?.(spec.id);
    return makeBuild(spec, onError, onProgress);
  }

  const build = async (spin: boolean, report?: (id: string, msg: string) => void) => {
    const kids: { solid: AnySolid; isHole: boolean }[] = [];
    let complete = true;
    for (const child of spec.children) {
      // Building the same child twice can give different answers: OCCT fails
      // on coincident faces intermittently, and a child that fails is a child
      // that quietly leaves the group — a piece of the model gone with no
      // error against the group itself. Measured on a reported bracket: five
      // identical group/ungroup cycles built it correctly, the sixth lost a
      // whole sub-assembly. So a failure is retried before it is believed.
      let solid: AnySolid | null = null;
      let failure = "";
      for (let attempt = 0; attempt < 8 && !solid; attempt++) {
        try {
          solid = await makeWorld(spin ? respin(child) : child, undefined, onProgress);
        } catch (e) {
          failure = e instanceof Error ? e.message : String(e);
        }
      }
      if (solid) kids.push({ solid, isHole: child.isHole });
      else {
        complete = false;
        report?.(child.id, failure || `${child.id} could not be built.`);
      }
    }
    return { kids, complete };
  };

  const built = await build(false, onError);
  // A partial group is never a valid preview. Continuing after one child
  // failed is what made rails/posts vanish for a single rebuild and then
  // return on the next group cycle. Keep the previous viewport mesh instead
  // of replacing it with a group that is missing pieces.
  if (!built.complete) return null;
  const kids = built.kids;
  const op: GroupOp = spec.op === "subtract" || spec.op === "intersect" ? spec.op : "union";
  const result = combine(op, kids);
  if (!result) return result;

  // Known OCCT weakness: a sphere's seam meridian crossing the other shape's
  // boundary makes the boolean return an invalid solid. Spinning the seam away
  // is a no-op geometrically and fixes it — so it is only worth retrying when
  // there is actually a sphere involved. (suspicious() already short-circuits
  // to false for MeshShape results, so this never fires on the import path.)
  const hasSphere = spec.children.some((c) => c.type === "object" && c.kind === "sphere");
  const invalid = suspicious(op, result, kids);
  // The same seam also has a quieter failure mode that suspicious() cannot
  // catch, because the solid it produces measures perfectly plausibly and
  // only misbehaves when tessellated — see isWatertight. Worth the extra
  // probe only when a sphere could actually be responsible.
  const cracked = !invalid && hasSphere && !isWatertight(result);
  if (!invalid && !cracked) return result;

  if (hasSphere) {
    const retryBuild = await build(true);
    if (!retryBuild.complete) return result;
    const retryKids = retryBuild.kids;
    const retry = combine(op, retryKids);
    // A retry has to actually be better, not merely different: when the first
    // attempt was outright invalid any sound solid is an improvement, but when
    // it was specifically cracked, only a watertight one is worth swapping in.
    if (retry && !suspicious(op, retry, retryKids) && (invalid || isWatertight(retry))) {
      return retry;
    }
  }

  if (invalid && op === "union") {
    onError?.(spec.id, "This union produced an invalid solid — try moving or rotating a part.");
  }
  return result;
}

/** A node placed into its parent's frame. */
/**
 * NOTE on caching the merge: a per-node cache of placed solids was tried here
 * and removed again. The merged result and the export run on their own worker
 * (see the two lanes in kernel/client.ts), so the per-node meshCache that
 * buildScene fills while editing is not visible to them, and re-evaluating
 * every object on every merge looks like the obvious waste to eliminate.
 * Measured on a reported five-object model with 70+ push/pull edits, it is
 * not: rebuilding after moving ONE object took 15.1s, 10.1s across runs,
 * against 11.5s to build all five from cold — the same range, no gain. The
 * time is going into the final union of the objects and the tessellation of
 * the single result, and both of those have to be redone whenever anything
 * moves, however many of the parts going into them were already built.
 * Anything faster has to attack that, not the per-object work.
 */
export async function makeWorld(
  spec: NodeSpec,
  onError?: (id: string, msg: string) => void,
  onProgress?: (id: string) => void,
): Promise<AnySolid | null> {
  // Both steps must see the SAME spec: baking rewrites the parameters and
  // the scale together, so building from one and placing with the other
  // would apply the scale twice.
  const baked = bakeNonUniformScale(spec);
  const local = await makeLocal(baked, onError, onProgress);
  return local ? place(local, baked) : null;
}

export { hasImport, isMesh };

