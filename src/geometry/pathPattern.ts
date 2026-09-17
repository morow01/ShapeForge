import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import type { SketchPath, Vec3 } from "../document/types";
import { cubicPoint, segmentCount, segmentCubic } from "../sketch/geometry";

export interface PathPlacement { position: Vec3; rotation: Vec3 }
export interface PathPatternOptions {
  count: number; spacing?: number; follow: boolean; angle: number;
  origin: Vec3; rotation: Vec3; scale: Vec3; sourceRotation: Vec3;
}
const radians = (v: number) => v * Math.PI / 180;
const orientation = (v: Vec3) => new Quaternion().setFromEuler(new Euler(...v.map(radians) as Vec3, "XYZ"));

/** Measure after transforming the guide, so spacing remains in world millimetres. */
export function pathPlacements(path: SketchPath, options: PathPatternOptions): PathPlacement[] {
  const matrix = new Matrix4().compose(new Vector3(...options.origin), orientation(options.rotation), new Vector3(...options.scale));
  const points: Vector3[] = [];
  for (let i = 0; i < segmentCount(path); i++) {
    const cubic = segmentCubic(path, i);
    for (let j = 0; j <= 128; j++) {
      const [x, y] = cubicPoint(cubic, j / 128);
      const p = new Vector3(x, y, 0).applyMatrix4(matrix);
      if (!points.length || p.distanceToSquared(points[points.length - 1]) > 1e-16) points.push(p);
    }
  }
  if (points.length < 2) return [];
  const distances = [0];
  for (let i = 1; i < points.length; i++) distances.push(distances[i-1] + points[i].distanceTo(points[i-1]));
  const length = distances[distances.length-1];
  if (length < 1e-6) return [];
  const spacing = options.spacing;
  const count = spacing !== undefined
    ? (path.closed ? Math.ceil(length / spacing - 1e-9) : Math.floor(length / spacing + 1e-9) + 1)
    : Math.round(options.count);
  if (!Number.isFinite(count) || count < 1 || count > 300 || (spacing !== undefined && spacing <= 0)) throw new Error("Use 1–300 copies, or increase the spacing.");
  const normal = new Vector3(0, 0, 1).applyQuaternion(orientation(options.rotation));
  const source = orientation(options.sourceRotation);
  return Array.from({ length: count }, (_, i) => {
    const d = spacing !== undefined ? i * spacing : length * i / (path.closed ? count : Math.max(1, count-1));
    let j = 1;
    while (j < distances.length-1 && distances[j] < d) j++;
    const position = points[j-1].clone().lerp(points[j], (d-distances[j-1])/(distances[j]-distances[j-1]));
    let q = source.clone();
    if (options.follow) {
      const x = points[j].clone().sub(points[j-1]).normalize();
      const y = normal.clone().cross(x).normalize();
      q = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, normal)).multiply(source);
    }
    q.premultiply(new Quaternion().setFromAxisAngle(normal, radians(options.angle)));
    const euler = new Euler().setFromQuaternion(q, "XYZ");
    return { position: position.toArray() as Vec3, rotation: [euler.x, euler.y, euler.z].map(v => v*180/Math.PI) as Vec3 };
  });
}
