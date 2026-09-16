import type { SketchPath, Vec3 } from "../document/types";
import { cubicPoint, segmentCount, segmentCubic } from "../sketch/geometry";

export interface TransformPatch {
  position: Vec3;
  rotation: Vec3;
}

export interface CircularPatternOptions {
  count: number;
  totalAngle: number; // in degrees, e.g. 360
  axis: 0 | 1 | 2; // 0: X, 1: Y, 2: Z (default)
  center?: Vec3; // [cx, cy, cz], default [0,0,0]
  rotateCopies?: boolean; // if true, rotate copies to follow the circle
}

export interface GridPatternOptions {
  rows: number;
  cols: number;
  spacingX: number;
  spacingY: number;
  stagger?: "none" | "hex" | "row50";
  centerGrid?: boolean;
  plane?: "XY" | "XZ" | "YZ";
}

export interface PathPatternOptions {
  path: SketchPath;
  count: number;
  followTangent?: boolean;
  startOffset?: number; // 0 to 1
  plane?: "XY" | "XZ" | "YZ";
  sketchOrigin?: Vec3;
  sketchRotation?: Vec3;
}

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/**
 * Generates transform patches for a circular / radial pattern.
 * The source object is placed at index 0, and (count - 1) additional copies are distributed.
 */
export function generateCircularTransforms(
  sourcePos: Vec3,
  sourceRot: Vec3,
  options: CircularPatternOptions,
): TransformPatch[] {
  const count = Math.max(2, Math.min(360, Math.round(options.count)));
  const totalAngle = options.totalAngle ?? 360;
  const axis = options.axis ?? 2;
  const center: Vec3 = options.center ?? [0, 0, 0];
  const rotateCopies = options.rotateCopies ?? true;

  // Closed loop (360) divides by count; partial arc divides by (count - 1)
  const isFullCircle = Math.abs(Math.abs(totalAngle) - 360) < 1e-4;
  const stepAngle = isFullCircle ? totalAngle / count : count > 1 ? totalAngle / (count - 1) : 0;

  // Vector from rotation center to source position
  const relX = sourcePos[0] - center[0];
  const relY = sourcePos[1] - center[1];
  const relZ = sourcePos[2] - center[2];

  const results: TransformPatch[] = [];

  for (let i = 0; i < count; i++) {
    const angleDeg = i * stepAngle;
    const angleRad = angleDeg * DEG2RAD;
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);

    let newX = relX;
    let newY = relY;
    let newZ = relZ;

    if (axis === 2) {
      // Rotate around Z axis
      newX = relX * cos - relY * sin;
      newY = relX * sin + relY * cos;
    } else if (axis === 0) {
      // Rotate around X axis
      newY = relY * cos - relZ * sin;
      newZ = relY * sin + relZ * cos;
    } else if (axis === 1) {
      // Rotate around Y axis
      newX = relX * cos + relZ * sin;
      newZ = -relX * sin + relZ * cos;
    }

    const pos: Vec3 = [
      center[0] + newX,
      center[1] + newY,
      center[2] + newZ,
    ];

    const rot: Vec3 = [...sourceRot];
    if (rotateCopies) {
      if (axis === 2) rot[2] = (rot[2] + angleDeg) % 360;
      else if (axis === 0) rot[0] = (rot[0] + angleDeg) % 360;
      else if (axis === 1) rot[1] = (rot[1] + angleDeg) % 360;
    }

    results.push({ position: pos, rotation: rot });
  }

  return results;
}

/**
 * Generates transform patches for a 2D Grid / Matrix / Honeycomb pattern.
 */
export function generateGridTransforms(
  sourcePos: Vec3,
  sourceRot: Vec3,
  options: GridPatternOptions,
): TransformPatch[] {
  const rows = Math.max(1, Math.min(100, Math.round(options.rows)));
  const cols = Math.max(1, Math.min(100, Math.round(options.cols)));
  const spacingX = Math.max(0.1, options.spacingX);
  const spacingY = Math.max(0.1, options.spacingY);
  const stagger = options.stagger ?? "none";
  const centerGrid = options.centerGrid ?? true;
  const plane = options.plane ?? "XY";

  // Effective row spacing for equilateral honeycomb geometry
  const effectiveSpacingY = stagger === "hex" ? spacingY * (Math.sqrt(3) / 2) : spacingY;

  const totalWidth = (cols - 1) * spacingX + (stagger !== "none" && rows > 1 ? spacingX * 0.5 : 0);
  const totalHeight = (rows - 1) * effectiveSpacingY;

  const originOffsetX = centerGrid ? -totalWidth / 2 : 0;
  const originOffsetY = centerGrid ? -totalHeight / 2 : 0;

  const results: TransformPatch[] = [];

  for (let r = 0; r < rows; r++) {
    const rowOffset = (stagger !== "none" && r % 2 === 1) ? spacingX * 0.5 : 0;
    const yOffset = originOffsetY + r * effectiveSpacingY;

    for (let c = 0; c < cols; c++) {
      const xOffset = originOffsetX + c * spacingX + rowOffset;

      let pos: Vec3;
      if (plane === "XY") {
        pos = [sourcePos[0] + xOffset, sourcePos[1] + yOffset, sourcePos[2]];
      } else if (plane === "XZ") {
        pos = [sourcePos[0] + xOffset, sourcePos[1], sourcePos[2] + yOffset];
      } else {
        // YZ
        pos = [sourcePos[0], sourcePos[1] + xOffset, sourcePos[2] + yOffset];
      }

      results.push({ position: pos, rotation: [...sourceRot] });
    }
  }

  return results;
}

/**
 * Computes sampled points along a SketchPath parameterized by cumulative arc-length.
 */
export function samplePathArcLength(path: SketchPath, numSamplesPerSegment = 32): { point: [number, number]; tangent: [number, number]; dist: number }[] {
  const segCount = segmentCount(path);
  if (segCount === 0) return [];

  const rawSamples: { point: [number, number]; tangent: [number, number] }[] = [];

  for (let s = 0; s < segCount; s++) {
    const cubic = segmentCubic(path, s);
    for (let i = 0; i < numSamplesPerSegment; i++) {
      const t = i / numSamplesPerSegment;
      const pt = cubicPoint(cubic, t);

      // Compute tangent by forward difference
      const nextT = Math.min(1, t + 0.005);
      const nextPt = cubicPoint(cubic, nextT);
      const dx = nextPt[0] - pt[0];
      const dy = nextPt[1] - pt[1];
      const len = Math.hypot(dx, dy) || 1;

      rawSamples.push({ point: pt, tangent: [dx / len, dy / len] });
    }
  }

  // Include end point for non-closed paths
  if (!path.closed && path.anchors.length > 0) {
    const last = path.anchors[path.anchors.length - 1];
    rawSamples.push({
      point: [last.x, last.y],
      tangent: rawSamples.length > 0 ? rawSamples[rawSamples.length - 1].tangent : [1, 0],
    });
  }

  // Calculate cumulative distances
  let totalDist = 0;
  const result: { point: [number, number]; tangent: [number, number]; dist: number }[] = [];
  result.push({ ...rawSamples[0], dist: 0 });

  for (let i = 1; i < rawSamples.length; i++) {
    const prev = rawSamples[i - 1].point;
    const curr = rawSamples[i].point;
    const d = Math.hypot(curr[0] - prev[0], curr[1] - prev[1]);
    totalDist += d;
    result.push({ ...rawSamples[i], dist: totalDist });
  }

  return result;
}

/**
 * Generates transform patches along a 2D sketch curve path.
 */
export function generatePathTransforms(
  sourcePos: Vec3,
  sourceRot: Vec3,
  options: PathPatternOptions,
): TransformPatch[] {
  const count = Math.max(2, Math.min(300, Math.round(options.count)));
  const followTangent = options.followTangent ?? true;
  const startOffset = Math.max(0, Math.min(1, options.startOffset ?? 0));
  const plane = options.plane ?? "XY";
  const sketchOrigin = options.sketchOrigin ?? [0, 0, 0];

  const samples = samplePathArcLength(options.path);
  if (samples.length < 2) return [{ position: sourcePos, rotation: sourceRot }];

  const totalLength = samples[samples.length - 1].dist;
  if (totalLength <= 1e-4) return [{ position: sourcePos, rotation: sourceRot }];

  const isClosed = options.path.closed;
  const results: TransformPatch[] = [];

  for (let i = 0; i < count; i++) {
    // Parameter t along the path [0, 1]
    const fraction = isClosed
      ? (startOffset + i / count) % 1
      : startOffset + (count > 1 ? (i / (count - 1)) * (1 - startOffset) : 0);

    const targetDist = fraction * totalLength;

    // Binary search / linear interpolate target point along cumulative arc length
    let idx = samples.findIndex((s) => s.dist >= targetDist);
    if (idx === -1) idx = samples.length - 1;
    if (idx === 0) idx = 1;

    const p0 = samples[idx - 1];
    const p1 = samples[idx];
    const segLen = p1.dist - p0.dist;
    const segT = segLen > 1e-5 ? (targetDist - p0.dist) / segLen : 0;

    const x2d = p0.point[0] + (p1.point[0] - p0.point[0]) * segT;
    const y2d = p0.point[1] + (p1.point[1] - p0.point[1]) * segT;

    const tx = p0.tangent[0] + (p1.tangent[0] - p0.tangent[0]) * segT;
    const ty = p0.tangent[1] + (p1.tangent[1] - p0.tangent[1]) * segT;
    const tangentAngleDeg = Math.atan2(ty, tx) * RAD2DEG;

    let worldPos: Vec3;
    if (plane === "XY") {
      worldPos = [sketchOrigin[0] + x2d, sketchOrigin[1] + y2d, sketchOrigin[2] + sourcePos[2]];
    } else if (plane === "XZ") {
      worldPos = [sketchOrigin[0] + x2d, sketchOrigin[1] + sourcePos[1], sketchOrigin[2] + y2d];
    } else {
      worldPos = [sketchOrigin[0] + sourcePos[0], sketchOrigin[1] + x2d, sketchOrigin[2] + y2d];
    }

    const rot: Vec3 = [...sourceRot];
    if (followTangent) {
      if (plane === "XY") rot[2] = (rot[2] + tangentAngleDeg) % 360;
      else if (plane === "XZ") rot[1] = (rot[1] + tangentAngleDeg) % 360;
      else rot[0] = (rot[0] + tangentAngleDeg) % 360;
    }

    results.push({ position: worldPos, rotation: rot });
  }

  return results;
}
