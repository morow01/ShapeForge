import type { Vec3 } from "./types";

/**
 * The little bit of rotation algebra the document itself needs.
 *
 * Kept here rather than reaching for three.js: this layer is plain data, and
 * the kernel (which has no three.js either) has to agree with it exactly.
 *
 * A node's rotation is three angles in degrees applied about the WORLD axes,
 * X then Y then Z — see place() in kernel/shape.ts, which rotates the solid
 * once per axis in that order. Composed as matrices that is Rz·Ry·Rx.
 */

/** Row-major 3x3. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

const DEG = Math.PI / 180;

export function eulerToMatrix([rx, ry, rz]: Vec3): Mat3 {
  const [sx, cx] = [Math.sin(rx * DEG), Math.cos(rx * DEG)];
  const [sy, cy] = [Math.sin(ry * DEG), Math.cos(ry * DEG)];
  const [sz, cz] = [Math.sin(rz * DEG), Math.cos(rz * DEG)];
  return [
    cy * cz, sx * sy * cz - cx * sz, cx * sy * cz + sx * sz,
    cy * sz, sx * sy * sz + cx * cz, cx * sy * sz - sx * cz,
    -sy,     sx * cy,                cx * cy,
  ];
}

/** The inverse of eulerToMatrix, in degrees. */
export function matrixToEuler(m: Mat3): Vec3 {
  const [m00, m01, , m10, m11, , m20, m21, m22] = m;
  // Straight up or down: Y is ±90°, X and Z become the same rotation, so all
  // of it is handed to Z and X is zeroed rather than left to numeric noise.
  if (Math.abs(m20) > 0.999999) {
    const ry = m20 < 0 ? 90 : -90;
    return [0, ry, (Math.atan2(-m01, m11) / DEG)];
  }
  return [
    Math.atan2(m21, m22) / DEG,
    Math.asin(-Math.max(-1, Math.min(1, m20))) / DEG,
    Math.atan2(m10, m00) / DEG,
  ];
}

export function multiplyMatrix(a: Mat3, b: Mat3): Mat3 {
  const out = new Array(9).fill(0) as number[];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      out[row * 3 + col] =
        a[row * 3] * b[col] + a[row * 3 + 1] * b[3 + col] + a[row * 3 + 2] * b[6 + col];
    }
  }
  return out as Mat3;
}

export function applyMatrix(m: Mat3, [x, y, z]: Vec3): Vec3 {
  return [
    m[0] * x + m[1] * y + m[2] * z,
    m[3] * x + m[4] * y + m[5] * z,
    m[6] * x + m[7] * y + m[8] * z,
  ];
}

/** Rounds away the 1e-15 dust matrix round-trips leave behind, so a node that
 *  was never rotated does not come back at 0.0000000000000002 degrees. */
export function tidy([x, y, z]: Vec3): Vec3 {
  const r = (v: number) => (Math.abs(v) < 1e-9 ? 0 : Math.round(v * 1e6) / 1e6);
  return [r(x), r(y), r(z)];
}

/** Rotations are orthogonal, so this is also their inverse. */
export function transposeMatrix(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}
