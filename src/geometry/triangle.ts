/**
 * Triangle solving, shared by the UI and the kernel. Pure maths — no replicad
 * imports — so the inspector can show derived values without a worker round-trip.
 *
 * Between them the three modes cover every classical way to pin down a
 * triangle: SSS (three sides), ASA/AAS (a side and the angles), and SAS (two
 * sides with the angle between them).
 */

/** Triangle definition mode. */
export const TRI_BY_SIDES = 0;
export const TRI_BY_ANGLES = 1;
/** Two sides and the angle between them. */
export const TRI_BY_SIDE_ANGLE = 2;

/** Thrown when parameters cannot describe a real solid. Surfaced in the UI
 *  rather than crashing the whole scene build. */
export class InvalidShapeError extends Error {}

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export const TRI_ANGLE_KEYS = ["angleLeft", "angleRight", "angleApex"] as const;
export type TriAngleKey = (typeof TRI_ANGLE_KEYS)[number];

/** Smallest angle we allow at any corner, in degrees. */
const MIN_ANGLE = 1;

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface TriangleSolution {
  /** Corner angles in degrees; always sums to 180. */
  angles: { left: number; right: number; apex: number };
  /** Side lengths in mm. `base` runs from the left corner to the right. */
  sides: { base: number; left: number; right: number };
  /** Apex position, with the base running from (0,0) to (base, 0). */
  apexPoint: { x: number; y: number };
  /** Cross-sectional area in mm². */
  area: number;
}

/**
 * Locates the apex for each mode. Everything else about the triangle is then
 * derived from the base and this one point, so the three modes cannot drift
 * out of agreement with each other.
 */
function findApex(p: Record<string, number>, base: number): { x: number; y: number } {
  if (p.mode === TRI_BY_ANGLES) {
    const left = p.angleLeft;
    const right = p.angleRight;
    if (!(left > 0) || !(right > 0)) {
      throw new InvalidShapeError("Angles must be greater than zero.");
    }
    if (left + right >= 180) {
      throw new InvalidShapeError(
        `Angles ${left}° + ${right}° = ${round2(
          left + right,
        )}°, which leaves nothing for the third corner (must be under 180°).`,
      );
    }
    // Law of sines: each side is proportional to the sine of its opposite angle.
    const apexAngle = 180 - left - right;
    const leftSide = (base * Math.sin(right * RAD)) / Math.sin(apexAngle * RAD);
    return { x: leftSide * Math.cos(left * RAD), y: leftSide * Math.sin(left * RAD) };
  }

  if (p.mode === TRI_BY_SIDE_ANGLE) {
    const leftSide = p.sideLeft;
    const angle = p.angleLeft;
    if (!(leftSide > 0)) throw new InvalidShapeError("Left side must be greater than zero.");
    if (!(angle > 0) || angle >= 180) {
      throw new InvalidShapeError("The angle between the sides must be between 0° and 180°.");
    }
    // The included angle places the apex directly.
    return { x: leftSide * Math.cos(angle * RAD), y: leftSide * Math.sin(angle * RAD) };
  }

  const left = p.sideLeft;
  const right = p.sideRight;
  if (!(left > 0) || !(right > 0)) {
    throw new InvalidShapeError("Sides must be greater than zero.");
  }
  // Triangle inequality — every side must be shorter than the other two combined.
  if (left + right <= base || left + base <= right || right + base <= left) {
    throw new InvalidShapeError(
      `Sides ${base}, ${left} and ${right} cannot close into a triangle.`,
    );
  }
  const x = (left * left + base * base - right * right) / (2 * base);
  const y2 = left * left - x * x;
  if (y2 <= 0) throw new InvalidShapeError("Those sides give a degenerate (flat) triangle.");
  return { x, y: Math.sqrt(y2) };
}

/**
 * Resolves a triangle from side lengths, corner angles, or a mix of the two.
 * Throws InvalidShapeError with a plain-English reason when the numbers cannot
 * close into a triangle.
 */
export function solveTriangle(p: Record<string, number>): TriangleSolution {
  const base = p.base;
  if (!(base > 0)) throw new InvalidShapeError("Base must be greater than zero.");

  const apexPoint = findApex(p, base);
  if (!(apexPoint.y > 0)) {
    throw new InvalidShapeError("Those values give a degenerate (flat) triangle.");
  }

  // Derive every other property from the base and the apex, so all modes agree.
  const angleLeft = Math.atan2(apexPoint.y, apexPoint.x) * DEG;
  const angleRight = Math.atan2(apexPoint.y, base - apexPoint.x) * DEG;

  return {
    angles: { left: angleLeft, right: angleRight, apex: 180 - angleLeft - angleRight },
    sides: {
      base,
      left: Math.hypot(apexPoint.x, apexPoint.y),
      right: Math.hypot(base - apexPoint.x, apexPoint.y),
    },
    apexPoint,
    area: 0.5 * base * apexPoint.y,
  };
}

/**
 * Sets one corner angle and rebalances the other two so all three still sum to
 * 180°. The remainder is shared in proportion to the other corners' current
 * values, so nudging one angle keeps the triangle's overall character rather
 * than snapping it to something arbitrary.
 *
 * Only meaningful in TRI_BY_ANGLES mode — elsewhere the angles are independent.
 */
export function applyTriangleAngle(
  params: Record<string, number>,
  key: TriAngleKey,
  value: number,
): Record<string, number> {
  const maxAngle = 180 - 2 * MIN_ANGLE;
  const edited = round2(Math.min(maxAngle, Math.max(MIN_ANGLE, value)));
  const [k1, k2] = TRI_ANGLE_KEYS.filter((k) => k !== key);

  const remaining = 180 - edited;
  const current = (params[k1] ?? 0) + (params[k2] ?? 0);

  let first = current > 0 ? ((params[k1] ?? 0) * remaining) / current : remaining / 2;
  first = round2(first);
  let second = round2(remaining - first);

  // Never let a rebalance push a corner below the minimum.
  if (first < MIN_ANGLE) {
    first = MIN_ANGLE;
    second = round2(remaining - MIN_ANGLE);
  } else if (second < MIN_ANGLE) {
    second = MIN_ANGLE;
    first = round2(remaining - MIN_ANGLE);
  }

  return { ...params, [key]: edited, [k1]: first, [k2]: second };
}

/**
 * Makes the three stored angles consistent again. Needed when entering
 * TRI_BY_ANGLES from a mode where the angles were independent, since they may
 * no longer sum to 180.
 */
export function normaliseTriangleAngles(params: Record<string, number>): Record<string, number> {
  const sum = TRI_ANGLE_KEYS.reduce((n, k) => n + (params[k] ?? 0), 0);
  if (Math.abs(sum - 180) < 0.011) return params;
  return applyTriangleAngle(params, "angleLeft", params.angleLeft ?? 60);
}

export const isTriangleAngleKey = (key: string): key is TriAngleKey =>
  (TRI_ANGLE_KEYS as readonly string[]).includes(key);
