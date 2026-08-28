import type { SceneNode, Vec3 } from "../document/types";
import type { KernelMesh } from "../kernel/types";

export interface WorldBounds {
  min: Vec3;
  max: Vec3;
}

function meshTransform(mesh: KernelMesh, node: SceneNode) {
  const vertices = mesh.faces.vertices;
  const boundsMin: Vec3 = [Infinity, Infinity, Infinity];
  const boundsMax: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = Number(vertices[i + axis]);
      boundsMin[axis] = Math.min(boundsMin[axis], value);
      boundsMax[axis] = Math.max(boundsMax[axis], value);
    }
  }
  const center: Vec3 = [
    (boundsMin[0] + boundsMax[0]) / 2,
    (boundsMin[1] + boundsMax[1]) / 2,
    (boundsMin[2] + boundsMax[2]) / 2,
  ];
  const radians = node.rotation.map((v) => v * Math.PI / 180) as Vec3;

  return (index: number): Vec3 => {
    let x = (Number(vertices[index * 3]) - center[0]) * node.scale[0] + center[0];
    let y = (Number(vertices[index * 3 + 1]) - center[1]) * node.scale[1] + center[1];
    let z = (Number(vertices[index * 3 + 2]) - center[2]) * node.scale[2] + center[2];
    const [rx, ry, rz] = radians;
    if (rx) [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
    if (ry) [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
    if (rz) [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
    return [x + node.position[0], y + node.position[1], z + node.position[2]];
  };
}

/** World-space bounds of the exact mesh shown in the viewport. Used to keep
 * a large, unrelated scan out of a Hole boolean during the timeout fallback. */
export function displayedMeshBounds(mesh: KernelMesh, node: SceneNode): WorldBounds {
  const point = meshTransform(mesh, node);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.faces.vertices.length / 3; i++) {
    const p = point(i);
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], p[axis]);
      max[axis] = Math.max(max[axis], p[axis]);
    }
  }
  return { min, max };
}

export function displayedBoundsOverlap(a: WorldBounds, b: WorldBounds): boolean {
  const epsilon = 1e-5;
  return [0, 1, 2].every(
    (axis) => a.max[axis] >= b.min[axis] - epsilon && b.max[axis] >= a.min[axis] - epsilon,
  );
}

/** Binary STL from the already-built editing mesh. This is the fast path for
 * one top-level solid: that mesh is already the evaluated result of every
 * group boolean and push/pull edit, so rebuilding the CAD history adds delay
 * without changing the model materially (edit-view tolerance is 0.05 mm). */
export function displayedMeshSTL(mesh: KernelMesh, node: SceneNode): Blob {
  return displayedSceneSTL([{ mesh, node }]);
}

/** Writes every already-rendered top-level solid into one binary STL. STL
 * supports multiple disconnected/overlapping closed shells, and slicers treat
 * them as one printable scene. This is the complete-scene fallback when the
 * optional high-detail boolean union exceeds the browser watchdog: unlike
 * skipping the blamed object, it preserves everything the user can see. */
export function displayedSceneSTL(
  items: { mesh: KernelMesh; node: SceneNode }[],
): Blob {
  const triangleCount = items.reduce(
    (sum, item) => sum + Math.floor(item.mesh.faces.triangles.length / 3),
    0,
  );
  const buffer = new ArrayBuffer(84 + triangleCount * 50);
  const view = new DataView(buffer);
  view.setUint32(80, triangleCount, true);

  let triangleNumber = 0;
  for (const { mesh, node } of items) {
    const triangles = mesh.faces.triangles;
    const itemTriangleCount = Math.floor(triangles.length / 3);
    const point = meshTransform(mesh, node);

    for (let triangle = 0; triangle < itemTriangleCount; triangle++) {
      const a = point(Number(triangles[triangle * 3]));
      const b = point(Number(triangles[triangle * 3 + 1]));
      const c = point(Number(triangles[triangle * 3 + 2]));
      const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      let nx = ab[1] * ac[2] - ab[2] * ac[1];
      let ny = ab[2] * ac[0] - ab[0] * ac[2];
      let nz = ab[0] * ac[1] - ab[1] * ac[0];
      const length = Math.hypot(nx, ny, nz) || 1;
      nx /= length; ny /= length; nz /= length;

      let offset = 84 + triangleNumber++ * 50;
      for (const value of [nx, ny, nz, ...a, ...b, ...c]) {
        view.setFloat32(offset, value, true);
        offset += 4;
      }
      view.setUint16(offset, 0, true);
    }
  }

  return new Blob([buffer], { type: "model/stl" });
}

/** Joins binary STL shells without rebuilding or booleaning them. The worker
 * uses this split path for just the solids touched by top-level Holes, while
 * unrelated large meshes stay byte-for-byte on the fast displayed path. */
export async function mergeBinarySTLs(blobs: Blob[]): Promise<Blob> {
  const buffers = await Promise.all(blobs.filter((blob) => blob.size >= 84).map((blob) => blob.arrayBuffer()));
  const triangleCount = buffers.reduce(
    (sum, buffer) => sum + new DataView(buffer).getUint32(80, true),
    0,
  );
  const output = new Uint8Array(84 + triangleCount * 50);
  new DataView(output.buffer).setUint32(80, triangleCount, true);
  let offset = 84;
  for (const buffer of buffers) {
    const view = new DataView(buffer);
    const bytes = view.getUint32(80, true) * 50;
    output.set(new Uint8Array(buffer, 84, bytes), offset);
    offset += bytes;
  }
  return new Blob([output], { type: "model/stl" });
}
