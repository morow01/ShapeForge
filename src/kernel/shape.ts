import {
  makeBaseBox,
  makeCylinder,
  makeSphere,
  basicFaceExtrusion,
  Vector,
  draw,
  drawCircle,
  importSTLAsMesh,
  measureVolume,
  MeshShape,
  getManifold,
  getOC,
  Plane,
  sketchFaceOffset,
} from "replicad";
import type { Face, Shape3D } from "replicad";
import { InvalidShapeError, solveTriangle, solveScaledTriangle } from "../geometry/triangle";
import { getBlob } from "../document/blobStore";
import { svgMeshSolid } from "./svgSolid";
import { makeThreadedRodSolid, makeThreadedNutSolid } from "./threads";
import type { SvgCommand } from "../svg/parse";
import type { EditOp, OffsetExtrudeOp, PushPullOp, ResizeFaceOp, ShellOp, Vec3 } from "../document/types";
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

/**
 * Rounds the 2D corners of any closed polygon using smooth tangent arcs.
 * Infallible, mathematically exact, and produces clean G1 manifold extrusions.
 */
function roundPolygon2D(
  vertices: [number, number][],
  cornerRadius: number,
  arcSteps = 8
): [number, number][] {
  const n = vertices.length;
  if (n < 3 || cornerRadius <= 0.01) return vertices;

  const result: [number, number][] = [];

  for (let i = 0; i < n; i++) {
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
    const maxD = Math.min(len1, len2) * 0.48;
    const desiredD = cornerRadius / Math.tan(halfAngle);
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

/**
 * Builds a primitive in LOCAL space: centred in XY with its base on z = 0,
 * with no position or rotation applied. Placement lives on the Three.js side
 * so dragging an object never needs a kernel rebuild.
 */
export function makePrimitive(spec: ObjectSpec): AnySolid {
  const p = spec.params;
  let s: AnySolid;

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
      const fillet = Math.max(p.fillet ?? 0, 0);
      const basePts: [number, number][] = [[0, 0], [p.base, 0], [apexPoint.x, apexPoint.y]];
      const pts = roundPolygon2D(basePts, fillet);
      let pen = draw(pts[0]);
      for (let i = 1; i < pts.length; i++) {
        pen = pen.lineTo(pts[i]);
      }
      s = pen.close().sketchOnPlane("XY").extrude(p.thickness) as Shape3D;
      break;
    }
    case "torus": {
      const R = Math.max(p.radius, 1);
      const r = Math.min(Math.max(p.tubeRadius, 0.2), R - 0.05);
      // Revolve a circular profile centered at (R, 0) in the XZ plane about Z,
      // then lift by `r` so its base rests flat on local Z = 0.
      s = drawCircle(r)
        .translate([R, 0])
        .sketchOnPlane("XZ")
        .revolve([0, 0, 1]) as Shape3D;
      s = s.translate([0, 0, r]);
      break;
    }
    case "pyramid": {
      const sides = Math.max(3, Math.min(32, Math.round(p.sides ?? 4)));
      const r = Math.max(p.radius ?? (p.width ? p.width / 2 : 10), 0.1);
      const h = Math.max(p.height ?? 20, 0.1);
      const d = r * Math.cos(Math.PI / sides);
      const size = r * 3;

      let solid = makeBaseBox(size * 2, size * 2, h);

      for (let i = 0; i < sides; i++) {
        const angleDeg = (i * 360) / sides;
        const cutter = draw([d, -1])
          .lineTo([size * 2, -1])
          .lineTo([size * 2, h + 1])
          .lineTo([0, h])
          .close()
          .sketchOnPlane("XZ", -size)
          .extrude(size * 2)
          .rotate(angleDeg, [0, 0, 0], [0, 0, 1]) as Shape3D;
        solid = solid.cut(cutter) as Shape3D;
      }
      s = solid;
      break;
    }
    case "wedge": {
      const w = Math.max(p.width ?? 20, 0.1);
      const len = Math.max(p.length ?? 20, 0.1);
      const h = Math.max(p.height ?? 20, 0.1);
      const maxR = Math.min(w, len, h) / 2 - 0.01;
      const r = Math.min(Math.max(p.fillet ?? 0, 0), maxR);
      let wedgeSolid = draw([0, 0])
        .lineTo([len, 0])
        .lineTo([len, h])
        .close()
        .sketchOnPlane("YZ")
        .extrude(w) as Shape3D;
      if (r > 0) {
        try {
          wedgeSolid = wedgeSolid.fillet(r, (e) => e.inDirection("X"));
        } catch {
          try {
            wedgeSolid = wedgeSolid.fillet(r);
          } catch {}
        }
      }
      s = wedgeSolid;
      break;
    }
    case "polygonPrism": {
      const sides = Math.max(3, Math.min(32, Math.round(p.sides ?? 6)));
      const r = Math.max(p.radius ?? 10, 0.1);
      const h = Math.max(p.height ?? 20, 0.1);
      const fillet = Math.max(p.fillet ?? 0, 0);
      const basePts: [number, number][] = [];
      for (let i = 0; i < sides; i++) {
        const a = (i * 2 * Math.PI) / sides;
        basePts.push([r * Math.cos(a), r * Math.sin(a)]);
      }
      const pts = roundPolygon2D(basePts, fillet);
      let pen = draw(pts[0]);
      for (let i = 1; i < pts.length; i++) {
        pen = pen.lineTo(pts[i]);
      }
      s = pen.close().sketchOnPlane("XY").extrude(h) as Shape3D;
      break;
    }
    case "hemisphere": {
      const r = Math.max(p.radius ?? 10, 0.1);
      const sphere = makeSphere(r);
      const cutBox = makeBaseBox(r * 4, r * 4, r * 2).translate([0, 0, -r * 2]);
      s = sphere.cut(cutBox) as Shape3D;
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
      const bevel = Math.min(Math.max(p.bevel ?? 0, 0), wall / 2 - 0.01, h / 2 - 0.01);

      let outer: Shape3D;
      let inner: Shape3D;

      if (sides >= 32) {
        outer = makeCylinder(rOut, h);
        inner = makeCylinder(rIn, h + 2).translate([0, 0, -1]);
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
        outer = penOut.close().sketchOnPlane("XY").extrude(h) as Shape3D;
        inner = penIn.close().sketchOnPlane("XY").extrude(h + 2).translate([0, 0, -1]) as Shape3D;
      }

      let tubeSolid = outer.cut(inner);
      if (bevel > 0) {
        try {
          tubeSolid = tubeSolid.chamfer(bevel, (e) => e.inPlane("XY"));
        } catch {
          try {
            tubeSolid = tubeSolid.fillet(bevel, (e) => e.inPlane("XY"));
          } catch {}
        }
      }
      s = tubeSolid;
      break;
    }
    case "paraboloid": {
      const R = Math.max(p.radius ?? 10, 0.1);
      const h = Math.max(p.height ?? 20, 0.1);
      const steps = 24;
      let pen = draw([0, 0]).lineTo([R, 0]);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const r_i = R * (1 - t);
        const z_i = h * (1 - (r_i / R) ** 2);
        pen = pen.lineTo([r_i, z_i]);
      }
      s = pen.close().sketchOnPlane("XZ").revolve([0, 0, 1]) as Shape3D;
      break;
    }
    case "text": {
      const thickness = Math.max(p.thickness ?? 4, 0.1);
      const size = Math.max(p.size ?? 20, 1);
      if (spec.textPaths && spec.textPaths.length) {
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
      // Socket (female) is the SAME profile as plug (male), just grown by
      // `clearance` before it's built — never modelled separately — so the
      // two can never drift out of fit with each other as the shape is
      // tuned. Growing width/height (not just width) keeps the gap uniform
      // all the way up a dovetail's flare (see the derivation this relies
      // on in the PR notes); growing radius/length the same way for a pin.
      const isSocket = (p.fit ?? 0) === 1;
      const clearance = isSocket ? Math.max(p.clearance ?? 0, 0) : 0;
      if ((p.shape ?? 0) === 0) {
        // Dovetail: a keystone trapezoid (X = width, Z = height) extruded
        // along Y (the slide-together direction). Wider at the top than at
        // the base means it can be slid into a matching socket but not
        // pulled straight out — the socket's own top-heavy taper is what
        // actually blocks the pull, plug and socket both need the SAME
        // angle for their flat sides to stay parallel, so `angle` is never
        // adjusted for clearance, only width/height are.
        const width = Math.max(p.width, 0.01) + clearance * 2;
        const height = Math.max(p.height, 0.01) + clearance;
        const angle = Math.min(Math.max(p.taperAngle ?? 12, 0), 45);
        const extra = height * Math.tan((angle * Math.PI) / 180);
        const len = Math.max(p.length, 0.01) + clearance * 2;
        s = draw([-width / 2, 0])
          .lineTo([width / 2, 0])
          .lineTo([width / 2 + extra, height])
          .lineTo([-width / 2 - extra, height])
          .close()
          .sketchOnPlane("XZ")
          .extrude(len) as Shape3D;
      } else {
        // Round pin: a cylinder that tapers to a point over the last
        // `chamfer` mm — the same true-point revolve as the cone case
        // above, just capped by a straight body instead of starting
        // tapered from the base. Self-centers on the way into a socket
        // even when the alignment is not perfect yet.
        const r = Math.max(p.radius, 0.01) + clearance;
        const len = Math.max(p.length, 0.01) + clearance;
        const lead = Math.min(Math.max(p.chamfer ?? 0, 0), Math.max(len - 0.05, 0));
        let pen = draw([0, 0]).lineTo([r, 0]).lineTo([r, len - lead]);
        pen = pen.lineTo([0, len]);
        s = pen.close().sketchOnPlane("XZ").revolve([0, 0, 1]) as Shape3D;
      }
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
        const fillet = Math.max(p.fillet ?? 0, 0);
        const pts = roundPolygon2D(rawPts, fillet);
        let pen = draw(pts[0]);
        for (let i = 1; i < pts.length; i++) {
          pen = pen.lineTo(pts[i]);
        }
        s = pen.close().sketchOnPlane("XY").extrude(height) as Shape3D;
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
      const density = p.density ?? 1;
      const divs = density === 0 ? 16 : density === 2 ? 64 : density === 3 ? 128 : 32;
      const manifold = getManifold();
      const sphere = manifold.Manifold.sphere(1, divs).scale([rx, ry, rz]);
      s = new MeshShape(sphere);
      break;
    }
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
  const selectFaces = (faces: import("replicad").FaceFinder) =>
    faces.either(op.points.map((point) => (finder: import("replicad").FaceFinder) => finder.containsPoint(point)));
  return solid.shell(op.thickness, selectFaces) as Shape3D;
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
const EDGE_ANCHOR_TOLERANCE = 0.02;

function edgesAt(
  anchors: Vec3[],
): (edges: import("replicad").EdgeFinder) => import("replicad").EdgeFinder {
  return (edges) => edges.either(
    anchors.map((point) => (finder) => finder.withinDistance(EDGE_ANCHOR_TOLERANCE, point)),
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
function resizePlanarFace(solid: Shape3D, face: Face, op: ResizeFaceOp): Shape3D {
  if (Math.abs(op.offset) < 1e-6) return solid;
  const center = face.center;
  const rawNormal = face.normalAt(center);
  const normal = new Vector([rawNormal.x, rawNormal.y, rawNormal.z]).normalized();
  const faceProjection = center.x * normal.x + center.y * normal.y + center.z * normal.z;
  const [min, max] = solid.boundingBox.bounds;
  let oppositeProjection = Infinity;
  for (const x of [min[0], max[0]]) {
    for (const y of [min[1], max[1]]) {
      for (const z of [min[2], max[2]]) {
        oppositeProjection = Math.min(oppositeProjection, x * normal.x + y * normal.y + z * normal.z);
      }
    }
  }
  const height = faceProjection - oppositeProjection;
  if (!Number.isFinite(height) || height < 0.1) {
    throw new Error("The opposite side of this face could not be found.");
  }

  const boundary = face.edges;
  const adjoining = solid.faces.filter((candidate) =>
    !candidate.isSame(face) &&
    candidate.edges.some((edge) => boundary.some((selectedEdge) => edge.isSame(selectedEdge))),
  );
  if (!adjoining.length) throw new Error("No adjoining faces could be resized.");

  // Positive OCCT draft angles taper IN, so negate the angle to make the
  // user-facing positive value mean grow/outset.
  const angle = -Math.atan(op.offset / height) * 180 / Math.PI;
  if (!Number.isFinite(angle) || Math.abs(angle) >= 80) {
    throw new Error("That resize is too large for this face.");
  }
  const origin: Vec3 = [
    center.x - normal.x * height,
    center.y - normal.y * height,
    center.z - normal.z * height,
  ];
  const helper = Math.abs(normal.z) < 0.9 ? new Vector([0, 0, 1]) : new Vector([1, 0, 0]);
  const xDirection = helper.cross(normal).normalized();
  const neutral = new Plane(origin, [xDirection.x, xDirection.y, xDirection.z], [normal.x, normal.y, normal.z]);
  try {
    return solid.draft(
      angle,
      (finder) => finder.inList(adjoining.map((candidate) => candidate.clone())),
      neutral,
    ).asShape3D();
  } finally {
    neutral.delete();
  }
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
        onError?.(spec.id, "Edge finishing is unavailable after a mesh-based edit.");
        continue;
      }
      try {
        const anchors = op.points?.length ? op.points : [op.point];
        const candidate = op.kind === "fillet"
          ? solid.fillet(op.distance, edgesAt(anchors))
          : solid.chamfer(op.distance, edgesAt(anchors));
        if (!isOcctValid(candidate) || tessellatesEmpty(candidate) || !isWatertight(candidate)) {
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
      if (isMesh(solid)) {
        onError?.(spec.id, "Hollowing is unavailable after a mesh-based edit.");
        continue;
      }
      if (!op.points.length) {
        onError?.(spec.id, "That hollow has no opening face left after rebuilding — try redoing it.");
        continue;
      }
      try {
        const candidate = shellSolid(solid, op);
        if (!isOcctValid(candidate) || tessellatesEmpty(candidate) || !isWatertight(candidate)) {
          onError?.(spec.id, "That wall is too thick for this shape; the previous shape was kept.");
        } else {
          solid = candidate;
        }
      } catch {
        onError?.(spec.id, "That wall is too thick for this shape; the previous shape was kept.");
      }
      continue;
    }
    if (op.kind === "resizeFace") {
      if (isMesh(solid)) {
        onError?.(spec.id, "Face resize is unavailable after a mesh-based edit.");
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
        onError?.(spec.id, "Offset and extrude is unavailable after a mesh-based edit.");
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
  if (!base || isMesh(base)) return spec.ops; // nothing to replay against — leave as-is
  let solid = base;
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
      const anchors = op.points?.length ? op.points : [op.point];
      const candidate = settled(() => (op.kind === "fillet"
        ? solid.fillet(op.distance, edgesAt(anchors))
        : solid.chamfer(op.distance, edgesAt(anchors))) as Shape3D);
      if (candidate) {
        solid = candidate;
        kept.push(op);
      }
      continue;
    }
    if (op.kind === "shell") {
      const candidate = op.points.length ? settled(() => shellSolid(solid, op)) : null;
      if (candidate) {
        solid = candidate;
        kept.push(op);
      }
      continue;
    }
    if (op.kind === "offsetExtrude") {
      const candidate = settled(() => {
        const face = findFace(solid, op.point, op.normal);
        return face ? offsetExtrudeFace(solid, face, op) : null;
      });
      if (candidate) {
        solid = candidate;
        kept.push(op);
      }
      continue;
    }
    if (op.kind === "resizeFace") {
      const candidate = settled(() => {
        const face = findFace(solid, op.point, op.normal);
        return face ? resizePlanarFace(solid, face, op) : null;
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
    const face = findFace(solid, faceOp.point, faceOp.normal);
    if (!face) continue;
    solid = pushPullFace(solid, face, faceOp.distance);
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
  const boundsHold = (candidate: AnySolid, expected: { min: Vec3; max: Vec3 } | null) =>
    op !== "union" || !expected ||
    (cutsHoles ? withinBounds(candidate, expected) : matchesBounds(candidate, expected));

  const usable = (candidate: AnySolid | null, expected: { min: Vec3; max: Vec3 } | null) =>
    !!candidate &&
    !isEmptySolid(candidate) &&
    !tessellatesEmpty(candidate) &&
    boundsHold(candidate, expected);

  // A failed manifold boolean does not necessarily throw; on this model it
  // occasionally returns a perfectly renderable union with one operand in
  // the wrong place. Every attempt needs fresh wrappers, and only a result
  // whose bounds match the immutable inputs is allowed out.
  const retryMesh = (attempts = 8): MeshShape | null => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const meshed = asMeshed();
      // Judge a MESHED result against MESHED operands. Tessellation inscribes
      // a curved surface — the triangles never quite reach it — so a meshed
      // shape is legitimately a hair smaller than the exact BRep envelope its
      // operands report, and at FALLBACK_MESH_QUALITY that gap is far wider
      // than the 0.05mm this is checked to. Measured on a Shape Builder
      // region of cylinder/box/sphere: every one of these eight attempts was
      // rejected on bounds alone and combine() returned null for a shape that
      // was never wrong — so the object was invisible and re-attempted, at
      // 1.3s a go, on every scene build.
      const expected = op === "union"
        ? unionBounds(meshed.filter((c) => !c.isHole).map((c) => c.solid))
        : null;
      const candidate = combineMesh(op, meshed);
      if (usable(candidate, expected)) return candidate;
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
  const [rx, ry] = spec.rotation;
  if (rx !== 0 || ry !== 0) return spec;

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
  // about the centre would have left it at height * (1 - sz) / 2.
  const [px, py, pz] = spec.position;
  return {
    ...spec,
    params,
    scale: [1, 1, 1],
    position: [px, py, pz + (height * (1 - sz)) / 2],
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
      const mesh = out.meshShape();
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
      const largest = Math.max(...kids.map((k) => measureVolume(k.solid as Shape3D)));
      return volume < largest - 1e-6;
    }
    if (op === "subtract") return volume <= 1e-9;
    return false;
  } catch {
    return true;
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
const SEAM_CHECK_QUALITY = { tolerance: 0.05, angularTolerance: 0.4 };

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
const FALLBACK_MESH_QUALITY = { tolerance: 0.05, angularTolerance: 0.4 };

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
function withinBounds(result: AnySolid, expected: { min: Vec3; max: Vec3 }): boolean {
  const got = boundsOf(result);
  if (!got) return false;
  return [0, 1, 2].every(
    (i) => got.min[i] > expected.min[i] - 0.05 && got.max[i] < expected.max[i] + 0.05,
  );
}

function matchesBounds(result: AnySolid, expected: { min: Vec3; max: Vec3 }): boolean {
  const got = boundsOf(result);
  if (!got) return false;
  return [0, 1, 2].every(
    (i) => Math.abs(got.min[i] - expected.min[i]) < 0.05 && Math.abs(got.max[i] - expected.max[i]) < 0.05,
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
 * A 0.05mm tolerance absorbs ordinary tessellation/kernel noise while still
 * rejecting the smallest observed failed placement, which was a full 1mm.
 */
export function unionKeptEverything(result: AnySolid, operands: AnySolid[]): boolean {
  const expected = unionBounds(operands);
  return expected ? matchesBounds(result, expected) : true;
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
