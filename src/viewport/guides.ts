import * as THREE from "three";
import type { ActiveSnap, Bounds3, SnapAxis } from "../snapping/snap";

const GUIDE_COLOUR = 0x43d9ff;
const PAD = 8;

/** Transient world-space lines that visualize active object alignments. */
export class SmartGuides {
  readonly group = new THREE.Group();

  constructor() {
    this.group.renderOrder = 10;
  }

  clear() {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      if (child instanceof THREE.Line) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
  }

  show(snaps: ActiveSnap[], moving: Bounds3) {
    this.clear();
    for (const snap of snaps) this.addLine(snap, moving);
  }

  private addLine(snap: ActiveSnap, moving: Bounds3) {
    const points = guideEndpoints(snap, moving);
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineDashedMaterial({
      color: GUIDE_COLOUR,
      dashSize: 2,
      gapSize: 1,
      depthTest: false,
      transparent: true,
      opacity: 0.95,
    });
    const line = new THREE.Line(geometry, material);
    line.computeLineDistances();
    line.renderOrder = 10;
    this.group.add(line);
  }

  dispose() {
    this.clear();
  }
}

function guideEndpoints(snap: ActiveSnap, moving: Bounds3): [THREE.Vector3, THREE.Vector3] {
  const combined = combine(moving, snap.targetBounds);
  const center = new THREE.Vector3(
    (combined.min[0] + combined.max[0]) / 2,
    (combined.min[1] + combined.max[1]) / 2,
    (combined.min[2] + combined.max[2]) / 2,
  );
  const axis = guideDirection(snap.axis);
  const start = center.clone();
  const end = center.clone();

  if (axis === "x") {
    start.x = combined.min[0] - PAD;
    end.x = combined.max[0] + PAD;
  } else if (axis === "y") {
    start.y = combined.min[1] - PAD;
    end.y = combined.max[1] + PAD;
  } else {
    start.z = combined.min[2] - PAD;
    end.z = combined.max[2] + PAD;
  }

  // Keep the line on the alignment plane while extending it in a perpendicular
  // direction, so aligned faces and centres read clearly from any camera angle.
  if (snap.axis === "x") start.x = end.x = snap.value;
  if (snap.axis === "y") start.y = end.y = snap.value;
  if (snap.axis === "z") start.z = end.z = snap.value;
  return [start, end];
}

function guideDirection(alignedAxis: SnapAxis): SnapAxis {
  if (alignedAxis === "x") return "z";
  if (alignedAxis === "y") return "z";
  return "x";
}

function combine(a: Bounds3, b: Bounds3): Bounds3 {
  return {
    min: [
      Math.min(a.min[0], b.min[0]),
      Math.min(a.min[1], b.min[1]),
      Math.min(a.min[2], b.min[2]),
    ],
    max: [
      Math.max(a.max[0], b.max[0]),
      Math.max(a.max[1], b.max[1]),
      Math.max(a.max[2], b.max[2]),
    ],
  };
}
