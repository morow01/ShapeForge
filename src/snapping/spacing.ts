import * as THREE from "three";
import type { SceneNode, Vec3 } from "../document/types";
import type { KernelMesh } from "../kernel/types";
import type { Bounds3, SnapAnchor, SnapAxis } from "./snap";

const DEG = Math.PI / 180;

/** World-space bounds of a kernel mesh after applying its document transform. */
export function meshBounds(mesh: KernelMesh, node: SceneNode): Bounds3 {
  const vertices = mesh.faces.vertices;
  const rotation = new THREE.Euler(
    node.rotation[0] * DEG,
    node.rotation[1] * DEG,
    node.rotation[2] * DEG,
    "XYZ",
  );
  const point = new THREE.Vector3();
  const localMin = new THREE.Vector3(Infinity, Infinity, Infinity);
  const localMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < vertices.length; i += 3) {
    point.set(vertices[i], vertices[i + 1], vertices[i + 2]);
    localMin.min(point);
    localMax.max(point);
  }
  const localCentre = localMin.add(localMax).multiplyScalar(0.5);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];

  for (let i = 0; i < vertices.length; i += 3) {
    point.set(vertices[i], vertices[i + 1], vertices[i + 2]);
    point.sub(localCentre).multiply(new THREE.Vector3(...node.scale)).add(localCentre);
    point.applyEuler(rotation);
    point.x += node.position[0];
    point.y += node.position[1];
    point.z += node.position[2];
    min[0] = Math.min(min[0], point.x);
    min[1] = Math.min(min[1], point.y);
    min[2] = Math.min(min[2], point.z);
    max[0] = Math.max(max[0], point.x);
    max[1] = Math.max(max[1], point.y);
    max[2] = Math.max(max[2], point.z);
  }

  return { min, max };
}

/** Moves one chosen reference on the moving object an exact signed distance
 * from a chosen reference on the fixed object. */
export function positionWithReferenceGap(
  fixedNode: SceneNode,
  fixedMesh: KernelMesh,
  movingNode: SceneNode,
  movingMesh: KernelMesh,
  axis: SnapAxis,
  fixedAnchor: SnapAnchor,
  movingAnchor: SnapAnchor,
  gap: number,
  direction: -1 | 1,
): Vec3 {
  const fixed = meshBounds(fixedMesh, fixedNode);
  const moving = meshBounds(movingMesh, movingNode);
  const i = axis === "x" ? 0 : axis === "y" ? 1 : 2;
  const fixedReference = coordinate(fixed, i, fixedAnchor);
  const movingReference = coordinate(moving, i, movingAnchor);
  const delta = fixedReference + direction * gap - movingReference;
  const position = [...movingNode.position] as Vec3;
  position[i] += delta;
  return position;
}

function coordinate(bounds: Bounds3, axis: number, anchor: SnapAnchor): number {
  if (anchor === "min") return bounds.min[axis];
  if (anchor === "max") return bounds.max[axis];
  return (bounds.min[axis] + bounds.max[axis]) / 2;
}

/** How close two faces can sit and still count as "touching" for
 *  findTouchingSeam — generous enough to forgive a part placed a shade off
 *  flush, tight enough that two objects across the workplane from each
 *  other never qualify. */
const TOUCH_TOLERANCE = 2;

export interface TouchingSeam {
  /** Which world axis the two objects are butted together along. */
  axis: 0 | 1 | 2;
  /** World point at the centre of the shared wall — where a connector
   *  should be centred. */
  point: Vec3;
  /** Unit vector along `axis`, pointing from `nodeA` toward `nodeB`. A
   *  primitive's local +Z rotated onto this normal (the same convention
   *  face-placement already uses) sits flush on A and protrudes toward B. */
  normal: Vec3;
  /** Extent of the shared wall on the two axes other than `axis`, in
   *  (axis+1)%3, (axis+2)%3 order — how much room a connector has to sit
   *  in without overhanging either object's edge. */
  footprint: [number, number];
  /** Solid depth available behind the contact patch in both objects. */
  availableDepth?: number;
  depthA?: number;
  depthB?: number;
  /** Extra height of the socket object above the contact patch along the rail (+V). */
  socketTopExtension?: number;
  /** Extra height of the socket object below the contact patch along the rail (-V). */
  socketBottomExtension?: number;
}

function getTransformedMeshVertices(mesh: KernelMesh, node: SceneNode): Float32Array {
  const vertices = mesh.faces.vertices;
  const count = Math.floor(vertices.length / 3);
  const out = new Float32Array(count * 3);
  const rotation = new THREE.Euler(
    node.rotation[0] * DEG,
    node.rotation[1] * DEG,
    node.rotation[2] * DEG,
    "XYZ",
  );
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < count * 3; i += 3) {
    const x = Number(vertices[i]), y = Number(vertices[i + 1]), z = Number(vertices[i + 2]);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  const sx = node.scale[0], sy = node.scale[1], sz = node.scale[2];
  const px = node.position[0], py = node.position[1], pz = node.position[2];

  const p = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const idx = i * 3;
    p.set(
      (Number(vertices[idx]) - cx) * sx + cx,
      (Number(vertices[idx + 1]) - cy) * sy + cy,
      (Number(vertices[idx + 2]) - cz) * sz + cz,
    );
    p.applyEuler(rotation);
    out[idx] = p.x + px;
    out[idx + 1] = p.y + py;
    out[idx + 2] = p.z + pz;
  }
  return out;
}

interface ContactPatch {
  minU: number;
  minV: number;
  maxU: number;
  maxV: number;
  depthA: number;
  depthB: number;
  socketTopExtension: number;
  socketBottomExtension: number;
}

interface FaceTri {
  z: number;
  minU: number;
  maxU: number;
  minV: number;
  maxV: number;
}

interface PlanarLevel {
  avgZ: number;
  tris: FaceTri[];
}

function extractPlanarLevels(
  verts: Float32Array,
  tris: ArrayLike<number>,
  axis: 0 | 1 | 2,
  j: number,
  k: number,
  dir: 1 | -1,
): PlanarLevel[] {
  const candidateTris: FaceTri[] = [];
  for (let i = 0; i < tris.length; i += 3) {
    const i0 = Number(tris[i]) * 3;
    const i1 = Number(tris[i + 1]) * 3;
    const i2 = Number(tris[i + 2]) * 3;

    const abX = verts[i1] - verts[i0], abY = verts[i1 + 1] - verts[i0 + 1], abZ = verts[i1 + 2] - verts[i0 + 2];
    const acX = verts[i2] - verts[i0], acY = verts[i2 + 1] - verts[i0 + 1], acZ = verts[i2 + 2] - verts[i0 + 2];
    let nAxis = 0;
    if (axis === 0) nAxis = abY * acZ - abZ * acY;
    else if (axis === 1) nAxis = abZ * acX - abX * acZ;
    else nAxis = abX * acY - abY * acX;

    const len = Math.hypot(abY * acZ - abZ * acY, abZ * acX - abX * acZ, abX * acY - abY * acX);
    if (len > 1e-6) nAxis /= len;

    if (dir > 0 ? nAxis < 0.65 : nAxis > -0.65) continue;

    const z = (verts[i0 + axis] + verts[i1 + axis] + verts[i2 + axis]) / 3;
    const u0 = verts[i0 + j], u1 = verts[i1 + j], u2 = verts[i2 + j];
    const v0 = verts[i0 + k], v1 = verts[i1 + k], v2 = verts[i2 + k];

    candidateTris.push({
      z,
      minU: Math.min(u0, u1, u2),
      maxU: Math.max(u0, u1, u2),
      minV: Math.min(v0, v1, v2),
      maxV: Math.max(v0, v1, v2),
    });
  }

  if (!candidateTris.length) return [];

  candidateTris.sort((a, b) => a.z - b.z);
  const levels: PlanarLevel[] = [];
  let currentLevel: FaceTri[] = [candidateTris[0]];
  let sumZ = candidateTris[0].z;

  for (let i = 1; i < candidateTris.length; i++) {
    const t = candidateTris[i];
    if (Math.abs(t.z - sumZ / currentLevel.length) <= 0.6) {
      currentLevel.push(t);
      sumZ += t.z;
    } else {
      levels.push({ avgZ: sumZ / currentLevel.length, tris: currentLevel });
      currentLevel = [t];
      sumZ = t.z;
    }
  }
  if (currentLevel.length) {
    levels.push({ avgZ: sumZ / currentLevel.length, tris: currentLevel });
  }

  return levels;
}

/**
 * Computes the solid material depth behind a contact patch on a mesh
 * by raycasting inward through mesh triangles at multiple sample points across the patch.
 */
function computePatchDepth(
  verts: Float32Array,
  tris: ArrayLike<number>,
  axis: 0 | 1 | 2,
  j: number,
  k: number,
  seamCoord: number,
  minU: number,
  maxU: number,
  minV: number,
  maxV: number,
  inwardDir: 1 | -1,
): number {
  // 1. Raycast into the mesh triangles at sample points on the contact patch.
  // Sample the center and 4 quadrants (where pins / joints typically sit).
  const samplePoints: [number, number][] = [
    [(minU + maxU) * 0.5, (minV + maxV) * 0.5],
    [minU * 0.75 + maxU * 0.25, minV * 0.75 + maxV * 0.25],
    [minU * 0.25 + maxU * 0.75, minV * 0.75 + maxV * 0.25],
    [minU * 0.75 + maxU * 0.25, minV * 0.25 + maxV * 0.75],
    [minU * 0.25 + maxU * 0.75, minV * 0.25 + maxV * 0.75],
  ];

  let bestRayDepth = Infinity;
  let rayHits = 0;

  for (const [u, v] of samplePoints) {
    let pointMinDepth = Infinity;

    for (let i = 0; i < tris.length; i += 3) {
      const i0 = Number(tris[i]) * 3;
      const i1 = Number(tris[i + 1]) * 3;
      const i2 = Number(tris[i + 2]) * 3;

      const u0 = verts[i0 + j], v0 = verts[i0 + k];
      const u1 = verts[i1 + j], v1 = verts[i1 + k];
      const u2 = verts[i2 + j], v2 = verts[i2 + k];

      const minTriU = Math.min(u0, u1, u2);
      const maxTriU = Math.max(u0, u1, u2);
      const minTriV = Math.min(v0, v1, v2);
      const maxTriV = Math.max(v0, v1, v2);
      if (u < minTriU - 1e-3 || u > maxTriU + 1e-3 || v < minTriV - 1e-3 || v > maxTriV + 1e-3) {
        continue;
      }

      const denom = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
      if (Math.abs(denom) < 1e-7) continue;

      const w0 = ((v1 - v2) * (u - u2) + (u2 - u1) * (v - v2)) / denom;
      if (w0 < -1e-3 || w0 > 1.001) continue;

      const w1 = ((v2 - v0) * (u - u2) + (u0 - u2) * (v - v2)) / denom;
      if (w1 < -1e-3 || w1 > 1.001) continue;

      const w2 = 1 - w0 - w1;
      if (w2 < -1e-3 || w2 > 1.001) continue;

      const z0 = verts[i0 + axis];
      const z1 = verts[i1 + axis];
      const z2 = verts[i2 + axis];
      const zHit = w0 * z0 + w1 * z1 + w2 * z2;

      const dist = (zHit - seamCoord) * inwardDir;
      // Filter out front seam face intersections (< 0.8mm)
      if (dist >= 0.8 && dist < pointMinDepth) {
        pointMinDepth = dist;
      }
    }

    if (Number.isFinite(pointMinDepth)) {
      rayHits++;
      if (pointMinDepth < bestRayDepth) {
        bestRayDepth = pointMinDepth;
      }
    }
  }

  if (rayHits > 0 && Number.isFinite(bestRayDepth) && bestRayDepth >= 0.8) {
    return bestRayDepth;
  }

  // 2. Vertex-extent fallback: check vertices in the shadow of the patch with a 30% margin
  const spanU = maxU - minU;
  const spanV = maxV - minV;
  const uMargin = Math.max(2.0, spanU * 0.3);
  const vMargin = Math.max(2.0, spanV * 0.3);

  let shadowDepth = 0;
  for (let i = 0; i < verts.length; i += 3) {
    const u = verts[i + j], v = verts[i + k];
    if (u >= minU - uMargin && u <= maxU + uMargin && v >= minV - vMargin && v <= maxV + vMargin) {
      const dist = (verts[i + axis] - seamCoord) * inwardDir;
      if (dist > shadowDepth) shadowDepth = dist;
    }
  }

  if (shadowDepth >= 1.0) {
    return shadowDepth;
  }

  // 3. Overall bounding extent of the mesh along inwardDir
  let boundDepth = 0;
  for (let i = 0; i < verts.length; i += 3) {
    const dist = (verts[i + axis] - seamCoord) * inwardDir;
    if (dist > boundDepth) boundDepth = dist;
  }

  return Math.max(0, boundDepth);
}

function findContactPatchBetweenLevels(
  levelA: PlanarLevel,
  levelB: PlanarLevel,
  vertsA: Float32Array,
  trisA: ArrayLike<number>,
  vertsB: Float32Array,
  trisB: ArrayLike<number>,
  axis: 0 | 1 | 2,
  j: number,
  k: number,
  seamCoord: number,
  aIsLow: boolean,
): ContactPatch | null {
  const overlapBoxes: [number, number, number, number][] = [];
  for (const ta of levelA.tris) {
    for (const tb of levelB.tris) {
      const oMinU = Math.max(ta.minU, tb.minU);
      const oMaxU = Math.min(ta.maxU, tb.maxU);
      const oMinV = Math.max(ta.minV, tb.minV);
      const oMaxV = Math.min(ta.maxV, tb.maxV);
      if (oMaxU > oMinU + 0.05 && oMaxV > oMinV + 0.05) {
        overlapBoxes.push([oMinU, oMinV, oMaxU, oMaxV]);
      }
    }
  }

  if (!overlapBoxes.length) return null;

  const clusters: [number, number, number, number][] = [];
  const padding = 2.0;
  for (const b of overlapBoxes) {
    let merged = false;
    for (const c of clusters) {
      if (
        b[0] <= c[2] + padding &&
        b[2] >= c[0] - padding &&
        b[1] <= c[3] + padding &&
        b[3] >= c[1] - padding
      ) {
        c[0] = Math.min(c[0], b[0]);
        c[1] = Math.min(c[1], b[1]);
        c[2] = Math.max(c[2], b[2]);
        c[3] = Math.max(c[3], b[3]);
        merged = true;
        break;
      }
    }
    if (!merged) clusters.push([...b]);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < clusters.length; i++) {
      for (let m = i + 1; m < clusters.length; m++) {
        const c1 = clusters[i], c2 = clusters[m];
        if (
          c1[0] <= c2[2] + padding &&
          c1[2] >= c2[0] - padding &&
          c1[1] <= c2[3] + padding &&
          c1[3] >= c2[1] - padding
        ) {
          c1[0] = Math.min(c1[0], c2[0]);
          c1[1] = Math.min(c1[1], c2[1]);
          c1[2] = Math.max(c1[2], c2[2]);
          c1[3] = Math.max(c1[3], c2[3]);
          clusters.splice(m, 1);
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }

  let bestCluster = clusters[0];
  let maxArea = (bestCluster[2] - bestCluster[0]) * (bestCluster[3] - bestCluster[1]);
  for (let i = 1; i < clusters.length; i++) {
    const area = (clusters[i][2] - clusters[i][0]) * (clusters[i][3] - clusters[i][1]);
    if (area > maxArea) {
      maxArea = area;
      bestCluster = clusters[i];
    }
  }

  const [minU, minV, maxU, maxV] = bestCluster;

  // Exact solid depths behind the patch computed via raycasting & solid extents
  const inwardDirA: 1 | -1 = aIsLow ? -1 : 1;
  const inwardDirB: 1 | -1 = aIsLow ? 1 : -1;

  const depthA = computePatchDepth(vertsA, trisA, axis, j, k, seamCoord, minU, maxU, minV, maxV, inwardDirA);
  const depthB = computePatchDepth(vertsB, trisB, axis, j, k, seamCoord, minU, maxU, minV, maxV, inwardDirB);

  // Top and bottom socket extensions for dovetail
  let minVB = Infinity;
  let maxVB = -Infinity;
  for (let i = 0; i < vertsB.length; i += 3) {
    const u = vertsB[i + j], v = vertsB[i + k];
    if (u >= minU - 1 && u <= maxU + 1) {
      const dist = (vertsB[i + axis] - seamCoord) * inwardDirB;
      if (dist >= -1.0) {
        if (v < minVB) minVB = v;
        if (v > maxVB) maxVB = v;
      }
    }
  }

  const socketTopExtension = Number.isFinite(maxVB) ? Math.max(0, maxVB - maxV) : 0;
  const socketBottomExtension = Number.isFinite(minVB) ? Math.max(0, minV - minVB) : 0;

  return { minU, minV, maxU, maxV, depthA, depthB, socketTopExtension, socketBottomExtension };
}

/**
 * Finds the shared wall between two objects that are butted directly against
 * each other along exactly one axis — the touching face a connector should
 * straddle.
 *
 * Directly scans the actual mesh triangles of both objects to find coplanar
 * opposing contact faces, making it robust for compound solids with steps,
 * cutouts, angled faces, or protruding flanges.
 */
export function findTouchingSeam(
  nodeA: SceneNode,
  meshA: KernelMesh,
  nodeB: SceneNode,
  meshB: KernelMesh,
): TouchingSeam | null {
  const vertsA = getTransformedMeshVertices(meshA, nodeA);
  const vertsB = getTransformedMeshVertices(meshB, nodeB);
  const trisA = meshA.faces.triangles;
  const trisB = meshB.faces.triangles;

  let best: TouchingSeam | null = null;
  let bestScore = 0;

  for (let axis = 0; axis < 3; axis++) {
    const j = (axis + 1) % 3;
    const k = (axis + 2) % 3;

    // Test both relative orientations (A low vs B low)
    const testOrientations: { aIsLow: boolean; dirA: 1 | -1; dirB: 1 | -1 }[] = [
      { aIsLow: true, dirA: 1, dirB: -1 },
      { aIsLow: false, dirA: -1, dirB: 1 },
    ];

    for (const { aIsLow, dirA, dirB } of testOrientations) {
      const levelsA = extractPlanarLevels(vertsA, trisA, axis as 0 | 1 | 2, j, k, dirA);
      const levelsB = extractPlanarLevels(vertsB, trisB, axis as 0 | 1 | 2, j, k, dirB);
      if (!levelsA.length || !levelsB.length) continue;

      for (const la of levelsA) {
        for (const lb of levelsB) {
          const gap = aIsLow ? lb.avgZ - la.avgZ : la.avgZ - lb.avgZ;
          // Allow slight interpenetration (-0.8mm) up to touch tolerance (2.0mm)
          if (gap < -0.8 || gap > TOUCH_TOLERANCE) continue;

          const seamCoord = (la.avgZ + lb.avgZ) / 2;
          const patch = findContactPatchBetweenLevels(la, lb, vertsA, trisA, vertsB, trisB, axis as 0 | 1 | 2, j, k, seamCoord, aIsLow);
          if (!patch) continue;

          const widthU = patch.maxU - patch.minU;
          const widthV = patch.maxV - patch.minV;
          if (widthU < 2 || widthV < 2) continue;

          const area = widthU * widthV;
          const score = area / (1.0 + Math.abs(gap) * 0.5);

          if (score > bestScore) {
            bestScore = score;
            const point: Vec3 = [0, 0, 0];
            point[axis] = seamCoord;
            point[j] = (patch.minU + patch.maxU) / 2;
            point[k] = (patch.minV + patch.maxV) / 2;

            const normal: Vec3 = [0, 0, 0];
            normal[axis] = aIsLow ? 1 : -1;

            const effDepthA = patch.depthA >= 1.0 ? patch.depthA : undefined;
            const effDepthB = patch.depthB >= 1.0 ? patch.depthB : undefined;
            // The socket receiving part (Part B / socketNode) is where holes are cut
            const availableDepth = effDepthB ?? effDepthA;

            best = {
              axis: axis as 0 | 1 | 2,
              point,
              normal,
              footprint: [widthU, widthV],
              availableDepth,
              depthA: effDepthA,
              depthB: effDepthB,
              socketTopExtension: patch.socketTopExtension,
              socketBottomExtension: patch.socketBottomExtension,
            };
          }
        }
      }
    }
  }

  if (best) return best;

  // Fallback: use bounding-box overlap if mesh patch analysis wasn't available
  const a = meshBounds(meshA, nodeA);
  const b = meshBounds(meshB, nodeB);
  let bestGap = TOUCH_TOLERANCE;

  for (let axis = 0; axis < 3; axis++) {
    const j = (axis + 1) % 3;
    const k = (axis + 2) % 3;
    const overlapJ0 = Math.max(a.min[j], b.min[j]);
    const overlapJ1 = Math.min(a.max[j], b.max[j]);
    const overlapK0 = Math.max(a.min[k], b.min[k]);
    const overlapK1 = Math.min(a.max[k], b.max[k]);
    if (overlapJ1 <= overlapJ0 || overlapK1 <= overlapK0) continue;

    const consider = (gap: number, aIsLow: boolean) => {
      if (gap >= bestGap) return;
      const seamCoord = aIsLow ? (a.max[axis] + b.min[axis]) / 2 : (b.max[axis] + a.min[axis]) / 2;
      const point: Vec3 = [0, 0, 0];
      point[axis] = seamCoord;
      point[j] = (overlapJ0 + overlapJ1) / 2;
      point[k] = (overlapK0 + overlapK1) / 2;
      const normal: Vec3 = [0, 0, 0];
      normal[axis] = aIsLow ? 1 : -1;
      bestGap = gap;

      const rawDepthA = Math.max(0, aIsLow ? seamCoord - a.min[axis] : a.max[axis] - seamCoord);
      const rawDepthB = Math.max(0, aIsLow ? b.max[axis] - seamCoord : seamCoord - b.min[axis]);
      const effDepthA = rawDepthA >= 1.0 ? rawDepthA : undefined;
      const effDepthB = rawDepthB >= 1.0 ? rawDepthB : undefined;
      const availableDepth = effDepthB ?? effDepthA;

      best = {
        axis: axis as 0 | 1 | 2,
        point,
        normal,
        footprint: [overlapJ1 - overlapJ0, overlapK1 - overlapK0],
        availableDepth,
        depthA: effDepthA,
        depthB: effDepthB,
      };
    };
    consider(Math.abs(b.min[axis] - a.max[axis]), true);
    consider(Math.abs(a.min[axis] - b.max[axis]), false);
  }

  return best;
}
