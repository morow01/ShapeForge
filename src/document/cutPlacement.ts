import * as THREE from "three";
import type { Vec3 } from "./types";

/**
 * Where to put the pieces a plane cut produces.
 *
 * The kernel hands back each piece as an STL in WORLD coordinates. An imported
 * STL is not shown in those coordinates, though: the kernel re-bases it
 * (normalise() in kernel/shape.ts) so its footprint is centred on the origin
 * with its lowest point at Z=0, and the node's `position` is where that
 * footprint centre / base ends up. The node's `rotation` is applied about the
 * re-based origin, before `position`. So to leave a piece exactly where the
 * cut found it, its position must be the original bbox centre (x, y) and
 * bottom (z) — a zero position sends every piece to the origin.
 */

export interface CutPieceData {
  buffer: ArrayBuffer;
  bbox: { min: Vec3; max: Vec3; center: Vec3 };
}

export interface CutPieceInput {
  data: CutPieceData;
  /** +1 for the piece on the positive side of the plane normal, -1 for the other. */
  side: 1 | -1;
}

export interface CutPlacementOptions {
  /** Turn each piece so its cut face lies on the bed. */
  layFlat: boolean;
  /** Set the pieces on the bed, `gap` mm apart. */
  separate: boolean;
  gap: number;
  planeNormal: Vec3;
}

export interface CutPiecePlacement {
  position: Vec3;
  rotation: Vec3;
}

interface Scan {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  /** Range of the rotated piece projected onto the separation direction. */
  projMin: number;
  projMax: number;
}

/** One pass over a binary STL: bounds of the piece after `q`, about `origin`. */
function scanPiece(
  buffer: ArrayBuffer,
  origin: Vec3,
  q: THREE.Quaternion,
  dir: [number, number],
): Scan {
  const dv = new DataView(buffer);
  const triCount = dv.getUint32(80, true);
  const v = new THREE.Vector3();
  const s: Scan = {
    minX: Infinity, maxX: -Infinity,
    minY: Infinity, maxY: -Infinity,
    minZ: Infinity,
    projMin: Infinity, projMax: -Infinity,
  };
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const off = 84 + t * 50 + 12 + k * 12;
      v.set(
        dv.getFloat32(off, true) - origin[0],
        dv.getFloat32(off + 4, true) - origin[1],
        dv.getFloat32(off + 8, true) - origin[2],
      ).applyQuaternion(q);
      if (v.x < s.minX) s.minX = v.x;
      if (v.x > s.maxX) s.maxX = v.x;
      if (v.y < s.minY) s.minY = v.y;
      if (v.y > s.maxY) s.maxY = v.y;
      if (v.z < s.minZ) s.minZ = v.z;
      const p = v.x * dir[0] + v.y * dir[1];
      if (p < s.projMin) s.projMin = p;
      if (p > s.projMax) s.projMax = p;
    }
  }
  return s;
}

export function placeCutPieces(
  pieces: CutPieceInput[],
  opts: CutPlacementOptions,
): CutPiecePlacement[] {
  const n = new THREE.Vector3(...opts.planeNormal).normalize();

  // Pieces separate along the plane's horizontal direction. A near-vertical
  // normal (a horizontal cut) has none, so those slide apart along Y.
  const hl = Math.hypot(n.x, n.y);
  const dir: [number, number] = hl > 0.35 ? [n.x / hl, n.y / hl] : [0, 1];

  const drop = opts.layFlat || opts.separate;
  const down = new THREE.Vector3(0, 0, -1);

  const placed = pieces.map(({ data, side }) => {
    // The cut face of the +side piece looks back along -normal, and vice versa.
    const cutFace = n.clone().multiplyScalar(-side);
    const q = opts.layFlat
      ? new THREE.Quaternion().setFromUnitVectors(cutFace, down)
      : new THREE.Quaternion();
    const euler = new THREE.Euler().setFromQuaternion(q, "XYZ");
    // Scan with the rotation the node will actually carry, not the one asked
    // for, so the two can never disagree.
    const qNode = new THREE.Quaternion().setFromEuler(euler);

    const origin: Vec3 = [data.bbox.center[0], data.bbox.center[1], data.bbox.min[2]];
    const scan = scanPiece(data.buffer, origin, qNode, dir);

    const position: Vec3 = [
      data.bbox.center[0] - (scan.minX + scan.maxX) / 2,
      data.bbox.center[1] - (scan.minY + scan.maxY) / 2,
      drop ? -scan.minZ : data.bbox.min[2] - scan.minZ,
    ];
    const rotation: Vec3 = [
      (euler.x * 180) / Math.PI,
      (euler.y * 180) / Math.PI,
      (euler.z * 180) / Math.PI,
    ];
    return { side, scan, position, rotation };
  });

  if (opts.separate && placed.length === 2) {
    const pos = placed.find((p) => p.side === 1)!;
    const neg = placed.find((p) => p.side === -1)!;
    // Clearance between the pieces along `dir`, with `pos` on the far side.
    const posLow = pos.scan.projMin + pos.position[0] * dir[0] + pos.position[1] * dir[1];
    const negHigh = neg.scan.projMax + neg.position[0] * dir[0] + neg.position[1] * dir[1];
    const shift = Math.max(0, opts.gap - (posLow - negHigh)) / 2;
    pos.position[0] += dir[0] * shift;
    pos.position[1] += dir[1] * shift;
    neg.position[0] -= dir[0] * shift;
    neg.position[1] -= dir[1] * shift;
  }

  return placed.map(({ position, rotation }) => ({ position, rotation }));
}
