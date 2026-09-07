import {
  makeBaseBox,
  makeCylinder,
  makeCompound,
  draw,
} from "replicad";
import type { Shape3D } from "replicad";

export interface HingeParams {
  hingeType?: number; // 0 = Knuckle (Print-in-Place), 1 = Living Hinge (Compliant), 2 = Butterfly Leaf
  length?: number; // Total length along hinge axis (Y)
  leafWidth?: number; // Width of each leaf wing (X)
  leafThickness?: number; // Thickness of mounting leaves (Z)
  knuckleCount?: number; // Number of alternating knuckles (3, 5, 7, 9)
  pinDiameter?: number; // Outer diameter of knuckle barrels
  clearance?: number; // 3D print clearance gap (default 0.35mm)
  angle?: number; // Opening angle (0 = flat open, 90 = right angle, 180 = closed)
  pinStyle?: number; // 0 = Captive Cylindrical Pin, 1 = 45° Conical Pivot Pins
  screwHoles?: number; // 0 = None, 1 = Straight Cylindrical, 2 = Countersunk (M3/M4)
  holeCount?: number; // Holes per leaf (1 to 4)
  holeDiameter?: number; // Screw clearance hole diameter (e.g. 3.5mm for M3, 4.5mm for M4)
  cornerFillet?: number; // Radius for outer leaf corners
  // Living Hinge specific parameters:
  bridgeThickness?: number; // Flexible membrane thickness (0.4mm to 1.2mm, default 0.6mm)
  bridgeWidth?: number; // Flexible bridge span (2mm to 10mm, default 4.0mm)
}

/**
 * Creates a cylinder lying along the Y axis.
 * In Replicad, makeCylinder is along Z [0, height].
 * Rotating by -90 deg about X transforms Z into Y: (x, y, z) -> (x, z, -y).
 */
function makeCylinderY(radius: number, length: number, cx = 0, yStart = 0, cz = 0): Shape3D {
  const r = Math.max(0.1, radius);
  const len = Math.max(0.1, length);
  const cyl = makeCylinder(r, len).rotate(-90, [0, 0, 0], [1, 0, 0]) as Shape3D;
  return cyl.translate([cx, yStart, cz]) as Shape3D;
}

/**
 * Creates a cone lying along the Y axis (from yStart to yStart + length).
 * Revolved around Z then rotated -90 deg about X.
 */
function makeConeY(rStart: number, rEnd: number, length: number, cx = 0, yStart = 0, cz = 0): Shape3D {
  const rs = Math.max(0.05, rStart);
  const re = Math.max(0.05, rEnd);
  const len = Math.max(0.1, length);
  const pen = draw([0, 0])
    .lineTo([rs, 0])
    .lineTo([re, len])
    .lineTo([0, len]);
  const cone = pen.close().sketchOnPlane("XZ").revolve([0, 0, 1]).rotate(-90, [0, 0, 0], [1, 0, 0]) as Shape3D;
  return cone.translate([cx, yStart, cz]) as Shape3D;
}

/**
 * Generates vertical screw hole cutters (cylindrical or countersunk flathead M3/M4)
 * centered in Z and positioned at the given X and Y coordinates.
 */
function makeScrewHoleCutter(
  x: number,
  y: number,
  leafThickness: number,
  style: number,
  holeDia = 3.5
): Shape3D {
  const rHole = Math.max(0.5, holeDia / 2);
  const h = leafThickness + 4;
  // Base through-hole cylinder extending through top and bottom
  const throughHole = makeCylinder(rHole, h).translate([x, y, -2]) as Shape3D;

  if (style !== 2) {
    return throughHole;
  }

  // Countersunk conical bevel at the top surface (z = leafThickness)
  // Standard 90° countersink: bevel height = bevel radius
  const rTop = rHole * 1.9; // e.g. ~3.3mm radius (6.6mm dia for M3)
  const bevelH = rTop - rHole;
  const bevelZ = leafThickness - bevelH;

  const pen = draw([0, bevelZ])
    .lineTo([rHole, bevelZ])
    .lineTo([rTop, leafThickness + 0.2])
    .lineTo([0, leafThickness + 0.2]);
  const coneBevel = pen.close().sketchOnPlane("XZ").revolve([0, 0, 1]).translate([x, y, 0]) as Shape3D;

  return throughHole.fuse(coneBevel) as Shape3D;
}

/**
 * Builds a Print-in-Place Knuckle / Barrel Hinge.
 * Alternating knuckles between Leaf 1 and Leaf 2 with internal pivot pins and 3D print clearance.
 */
function makeKnuckleHingeSolid(p: HingeParams): Shape3D {
  const L = Math.max(10, p.length ?? 40);
  const W = Math.max(5, p.leafWidth ?? 15);
  const T = Math.max(1.2, p.leafThickness ?? 3.0);
  const c = Math.max(0.05, Math.min(2.0, (p.clearance !== undefined && p.clearance > 0) ? p.clearance : 0.20)); // 3D print clearance (0.20 mm default)
  const rawN = Math.max(3, Math.min(15, Math.round(p.knuckleCount ?? 3)));
  // Standard odd knuckle count so outer ends belong to Leaf 1, keeping Leaf 2 captive
  const N = rawN % 2 === 0 ? rawN + 1 : rawN;
  const pinDia = Math.max(3.0, p.pinDiameter ?? 7.0);
  const Rk = Math.max(T * 0.65, pinDia / 2); // Knuckle barrel radius
  const Rpin = Math.max(0.8, Math.min(Rk - c - 0.8, Rk * 0.46)); // Central pivot pin radius
  const pinStyle = Math.round(p.pinStyle ?? 0); // 0 = Captive pin, 1 = Conical pivots
  const screwStyle = Math.round(p.screwHoles ?? 0);
  const holeCount = Math.max(1, Math.min(4, Math.round(p.holeCount ?? 2)));
  const holeDia = Math.max(1.5, p.holeDiameter ?? 3.5);
  const angleDeg = Math.max(0, Math.min(180, p.angle ?? 0));

  // Axial clearance between knuckles
  const totalGaps = (N - 1) * c;
  const kLen = Math.max(1.0, (L - totalGaps) / N);
  const yStartAll = -L / 2;

  // Hinge axis lies along Y at X=0, Z=Rk.
  // The knuckle barrels extend from X = -Rk to X = +Rk.
  // To ensure 100% print-in-place separation, the continuous back plate of each leaf
  // sits outside the knuckle cylinder by at least clearance c:
  // Leaf 1 plate: X <= -(Rk + c)
  // Leaf 2 plate: X >= +(Rk + c)
  const xNotch = Rk + c;

  // --- Build Leaf 1 Solid (Left, fixed) ---
  // Continuous mounting plate offset to X <= -xNotch
  const x1Center = -(xNotch + W / 2);
  let leaf1: Shape3D = makeBaseBox(W, L, T).translate([x1Center, 0, 0]) as Shape3D;

  // Add Leaf 1 knuckles (even indices: 0, 2, 4, ...) and connecting fingers ONLY
  for (let i = 0; i < N; i += 2) {
    const yKnuckleStart = yStartAll + i * (kLen + c);
    const knuckleCyl = makeCylinderY(Rk, kLen, 0, yKnuckleStart, Rk);
    // Finger bridging from X = -xNotch to X = 0 (into Knuckle i only)
    const finger = makeBaseBox(xNotch, kLen, T).translate([-xNotch / 2, yKnuckleStart + kLen / 2, 0]) as Shape3D;
    leaf1 = leaf1.fuse(knuckleCyl).fuse(finger) as Shape3D;
  }

  // --- Build Leaf 2 Solid (Right, movable) ---
  // Continuous mounting plate offset to X >= +xNotch
  const x2Center = xNotch + W / 2;
  let leaf2: Shape3D = makeBaseBox(W, L, T).translate([x2Center, 0, 0]) as Shape3D;

  // Add Leaf 2 knuckles (odd indices: 1, 3, 5, ...) and connecting fingers ONLY
  for (let i = 1; i < N; i += 2) {
    const yKnuckleStart = yStartAll + i * (kLen + c);
    const knuckleCyl = makeCylinderY(Rk, kLen, 0, yKnuckleStart, Rk);
    // Finger bridging from X = 0 to X = +xNotch (into Knuckle i only)
    const finger = makeBaseBox(xNotch, kLen, T).translate([xNotch / 2, yKnuckleStart + kLen / 2, 0]) as Shape3D;
    leaf2 = leaf2.fuse(knuckleCyl).fuse(finger) as Shape3D;
  }

  // --- Pivot Pin & Clearance Bores ---
  if (pinStyle === 0) {
    // Continuous Captive Pin Style:
    // Solid pin runs continuously through the hinge axis (X=0, Z=Rk), fused to Leaf 1
    const pin = makeCylinderY(Rpin, L, 0, yStartAll, Rk);
    leaf1 = leaf1.fuse(pin) as Shape3D;

    // Bore cutter for Leaf 2 knuckles: radius Rpin + c through every odd knuckle
    for (let i = 1; i < N; i += 2) {
      const yKnuckleStart = yStartAll + i * (kLen + c);
      const bore = makeCylinderY(Rpin + c, kLen + 2.0, 0, yKnuckleStart - 1.0, Rk);
      leaf2 = leaf2.cut(bore) as Shape3D;
    }
  } else {
    // 45° Conical Pivot Pins Style:
    // Support-free conical pivots between adjacent knuckles
    const coneH = Math.min(kLen * 0.38, Rpin);
    for (let i = 0; i < N - 1; i++) {
      const yFaceA = yStartAll + i * (kLen + c) + kLen;
      const yFaceB = yFaceA + c;

      if (i % 2 === 0) {
        // Knuckle i is Leaf 1 (male cone pointing +Y into Leaf 2)
        const maleCone = makeConeY(Rpin, 0.25, coneH, 0, yFaceA, Rk);
        leaf1 = leaf1.fuse(maleCone) as Shape3D;

        // Knuckle i+1 is Leaf 2 (female conical cavity with clearance c)
        const femaleSocket = makeConeY(Rpin + c, 0.25 + c, coneH + c, 0, yFaceB - 0.05, Rk);
        leaf2 = leaf2.cut(femaleSocket) as Shape3D;
      } else {
        // Knuckle i is Leaf 2 (male cone pointing -Y into Leaf 1)
        const maleCone = makeConeY(0.25, Rpin, coneH, 0, yFaceA - coneH, Rk);
        leaf2 = leaf2.fuse(maleCone) as Shape3D;

        // Knuckle i-1 is Leaf 1 (female socket)
        const femaleSocket = makeConeY(0.25 + c, Rpin + c, coneH + c, 0, yFaceA - coneH - c, Rk);
        leaf1 = leaf1.cut(femaleSocket) as Shape3D;
      }
    }
  }

  // --- Ensure Clean Axial Clearances & Anti-Elephant-Foot Bed Relief ---
  for (let i = 0; i < N - 1; i++) {
    const gapStart = yStartAll + (i + 1) * kLen + i * c;
    // Standard axial gap cutter
    const gapCutter = makeBaseBox((xNotch + 2) * 2, c, (Rk + 2) * 2)
      .translate([0, gapStart + c / 2, Rk]) as Shape3D;
    // Anti-elephant-foot bottom relief: subtle 0.10mm clearance at the first 0.8mm layers
    const bedRelief = makeBaseBox((xNotch + 2) * 2, c + 0.10, 0.8)
      .translate([0, gapStart + c / 2, 0]) as Shape3D;

    const fullCutter = gapCutter.fuse(bedRelief) as Shape3D;

    if (i % 2 === 0) {
      // Gap between Leaf 1 and Leaf 2 knuckle
      leaf2 = leaf2.cut(fullCutter) as Shape3D;
    } else {
      // Gap between Leaf 2 and Leaf 1 knuckle
      leaf1 = leaf1.cut(fullCutter) as Shape3D;
    }
  }

  // --- Add Screw Mounting Holes ---
  if (screwStyle > 0) {
    const ySpacing = L / (holeCount + 1);
    const x1 = -(xNotch + W * 0.5);
    const x2 = +(xNotch + W * 0.5);

    for (let h = 1; h <= holeCount; h++) {
      const yHole = yStartAll + h * ySpacing;
      const hole1 = makeScrewHoleCutter(x1, yHole, T, screwStyle, holeDia);
      const hole2 = makeScrewHoleCutter(x2, yHole, T, screwStyle, holeDia);
      leaf1 = leaf1.cut(hole1) as Shape3D;
      leaf2 = leaf2.cut(hole2) as Shape3D;
    }
  }

  // --- Rotate Leaf 2 if opening angle specified ---
  if (angleDeg > 0.01) {
    leaf2 = leaf2
      .translate([0, 0, -Rk])
      .rotate(angleDeg, [0, 0, 0], [0, 1, 0])
      .translate([0, 0, Rk]) as Shape3D;
  }

  return makeCompound([leaf1, leaf2]) as Shape3D;
}

/**
 * Builds a Print-in-Place Living Hinge (Compliant Joint).
 */
function makeLivingHingeSolid(p: HingeParams): Shape3D {
  const L = Math.max(10, p.length ?? 40);
  const W = Math.max(5, p.leafWidth ?? 15);
  const T = Math.max(1.5, p.leafThickness ?? 3.0);
  const bT = Math.max(0.4, Math.min(T * 0.6, p.bridgeThickness ?? 0.6));
  const bW = Math.max(1.5, Math.min(20, p.bridgeWidth ?? 4.0));
  const screwStyle = Math.round(p.screwHoles ?? 0);
  const holeCount = Math.max(1, Math.min(4, Math.round(p.holeCount ?? 2)));
  const holeDia = Math.max(1.5, p.holeDiameter ?? 3.5);

  const halfSpan = bW / 2;
  const leftOuter = -(W + halfSpan);
  const rightOuter = W + halfSpan;
  const chamferW = Math.min(halfSpan * 0.8, (T - bT) * 0.8);

  const pts: [number, number][] = [
    [leftOuter, 0],
    [rightOuter, 0],
    [rightOuter, T],
    [halfSpan + chamferW, T],
    [halfSpan, bT],
    [-halfSpan, bT],
    [-(halfSpan + chamferW), T],
    [leftOuter, T],
  ];

  let pen = draw(pts[0]);
  for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);

  let solid = pen.close().sketchOnPlane("XZ").extrude(L) as Shape3D;
  solid = solid.translate([0, -L / 2, 0]) as Shape3D;

  if (screwStyle > 0) {
    const ySpacing = L / (holeCount + 1);
    const x1 = -(halfSpan + W * 0.5);
    const x2 = halfSpan + W * 0.5;

    for (let h = 1; h <= holeCount; h++) {
      const yHole = -L / 2 + h * ySpacing;
      const hole1 = makeScrewHoleCutter(x1, yHole, T, screwStyle, holeDia);
      const hole2 = makeScrewHoleCutter(x2, yHole, T, screwStyle, holeDia);
      solid = solid.cut(hole1).cut(hole2) as Shape3D;
    }
  }

  return solid;
}

/**
 * Builds a Print-in-Place Butterfly / Surface Leaf Hinge.
 */
function makeButterflyHingeSolid(p: HingeParams): Shape3D {
  return makeKnuckleHingeSolid({
    ...p,
    screwHoles: p.screwHoles ?? 2,
    holeCount: p.holeCount ?? 2,
    knuckleCount: p.knuckleCount ?? 3,
    clearance: p.clearance ?? 0.35,
  });
}

/**
 * Main dispatcher for all 3D printable Hinge types.
 */
export function makeHingeSolid(p: Record<string, number>): Shape3D {
  const type = Math.round(p.hingeType ?? 0);
  switch (type) {
    case 1:
      return makeLivingHingeSolid(p);
    case 2:
      return makeButterflyHingeSolid(p);
    case 0:
    default:
      return makeKnuckleHingeSolid(p);
  }
}
