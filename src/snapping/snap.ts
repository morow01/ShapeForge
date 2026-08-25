export type SnapAxis = "x" | "y" | "z";
export type SnapAnchor = "min" | "center" | "max";

export interface Bounds3 {
  min: [number, number, number];
  max: [number, number, number];
}

export interface SnapTarget {
  id: string;
  bounds: Bounds3;
}

export interface ActiveSnap {
  axis: SnapAxis;
  movingAnchor: SnapAnchor;
  targetAnchor: SnapAnchor;
  value: number;
  targetId: string;
  targetBounds: Bounds3;
}

export interface SnapResult {
  delta: [number, number, number];
  active: ActiveSnap[];
}

const AXES: SnapAxis[] = ["x", "y", "z"];
const ANCHORS: SnapAnchor[] = ["min", "center", "max"];

const coordinate = (bounds: Bounds3, axis: number, anchor: SnapAnchor): number => {
  if (anchor === "min") return bounds.min[axis];
  if (anchor === "max") return bounds.max[axis];
  return (bounds.min[axis] + bounds.max[axis]) / 2;
};

/** Finds the closest min/centre/max bounds alignment on each world axis. */
export function snapBounds(moving: Bounds3, targets: SnapTarget[], tolerance: number): SnapResult {
  const delta: [number, number, number] = [0, 0, 0];
  const active: ActiveSnap[] = [];

  for (let axisIndex = 0; axisIndex < AXES.length; axisIndex++) {
    let best:
      | { distance: number; snap: ActiveSnap }
      | undefined;

    for (const target of targets) {
      for (const movingAnchor of ANCHORS) {
        const from = coordinate(moving, axisIndex, movingAnchor);
        for (const targetAnchor of ANCHORS) {
          const value = coordinate(target.bounds, axisIndex, targetAnchor);
          const distance = value - from;
          if (Math.abs(distance) > tolerance) continue;
          if (!best || Math.abs(distance) < Math.abs(best.distance)) {
            best = {
              distance,
              snap: {
                axis: AXES[axisIndex],
                movingAnchor,
                targetAnchor,
                value,
                targetId: target.id,
                targetBounds: target.bounds,
              },
            };
          }
        }
      }
    }

    if (best) {
      delta[axisIndex] = best.distance;
      active.push(best.snap);
    }
  }

  return { delta, active };
}
