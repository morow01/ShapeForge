import { unzipSync } from "fflate";

/** One build item, flattened into world space and handed on as binary STL so
 *  it can travel the same route an imported STL already takes. */
export interface ThreeMFPart {
  name: string;
  triangles: number;
  stl: ArrayBuffer;
  /**
   * Where this part belongs, as the import pipeline measures placement.
   *
   * An imported mesh is normalised on the way in — centred in X and Y, base
   * set on z = 0 — so world coordinates baked into the triangles are thrown
   * away and every part would land on top of the last. Handing this back as
   * the node's position undoes that normalisation and keeps an assembly
   * assembled: the centre of its footprint, and the bottom of it.
   */
  anchor: [number, number, number];
}

/** 3MF states its units; everything downstream is millimetres. */
const UNIT_MM: Record<string, number> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

/** A 3MF transform is twelve numbers: three basis rows then the translation.
 *  Points are ROW vectors, so a point is multiplied from the left. */
type Matrix = number[]; // length 12

const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

function parseMatrix(raw: string | null): Matrix {
  if (!raw) return IDENTITY;
  const values = raw.trim().split(/\s+/).map(Number);
  return values.length === 12 && values.every(Number.isFinite) ? values : IDENTITY;
}

/** b applied first, then a — the order needed when walking down a component
 *  tree, where each level's transform sits outside the ones below it. */
function multiply(a: Matrix, b: Matrix): Matrix {
  const out = new Array<number>(12).fill(0);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      out[row * 3 + col] =
        b[row * 3] * a[col] + b[row * 3 + 1] * a[3 + col] + b[row * 3 + 2] * a[6 + col];
    }
  }
  for (let col = 0; col < 3; col++) {
    out[9 + col] = b[9] * a[col] + b[10] * a[3 + col] + b[11] * a[6 + col] + a[9 + col];
  }
  return out;
}

function apply(m: Matrix, x: number, y: number, z: number): [number, number, number] {
  return [
    x * m[0] + y * m[3] + z * m[6] + m[9],
    x * m[1] + y * m[4] + z * m[7] + m[10],
    x * m[2] + y * m[5] + z * m[8] + m[11],
  ];
}

/** Binary STL of already-world-space triangles. The kernel's import path
 *  already reads this format, and reusing it means a 3MF object arrives by
 *  exactly the route an STL does — same preview, same repair, same limits. */
function binarySTL(triangles: [number, number, number][][]): ArrayBuffer {
  const buffer = new ArrayBuffer(84 + triangles.length * 50);
  const view = new DataView(buffer);
  view.setUint32(80, triangles.length, true);
  let at = 84;
  for (const [a, b, c] of triangles) {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const nx = ab[1] * ac[2] - ab[2] * ac[1];
    const ny = ab[2] * ac[0] - ab[0] * ac[2];
    const nz = ab[0] * ac[1] - ab[1] * ac[0];
    const length = Math.hypot(nx, ny, nz) || 1;
    view.setFloat32(at, nx / length, true);
    view.setFloat32(at + 4, ny / length, true);
    view.setFloat32(at + 8, nz / length, true);
    at += 12;
    for (const point of [a, b, c]) {
      view.setFloat32(at, point[0], true);
      view.setFloat32(at + 4, point[1], true);
      view.setFloat32(at + 8, point[2], true);
      at += 12;
    }
    view.setUint16(at, 0, true);
    at += 2;
  }
  return buffer;
}

/**
 * Reads a 3MF package into one part per build item.
 *
 * A 3MF is a ZIP: a relationship file points at the model XML, and the model
 * holds resources (objects, each either a mesh or a list of COMPONENTS that
 * reference other objects with their own transforms) plus a build section
 * saying which objects are actually placed, and where. Only build items
 * become parts — an object referenced solely as a component is a building
 * block, not something on the plate.
 *
 * Kept on the main thread for the same reason SVG is: this needs DOMParser,
 * which the kernel worker does not have.
 */
export function parseThreeMF(bytes: ArrayBuffer): ThreeMFPart[] {
  const files = unzipSync(new Uint8Array(bytes));
  const decoder = new TextDecoder();

  // The relationship file names the model part; only fall back to the
  // conventional path when it cannot be read.
  let modelPath = "3D/3dmodel.model";
  const rels = files["_rels/.rels"];
  if (rels) {
    const target = /Target="([^"]+)"[^>]*3dmodel/i.exec(decoder.decode(rels))
      ?? /3dmodel[^>]*Target="([^"]+)"/i.exec(decoder.decode(rels));
    if (target) modelPath = target[1].replace(/^\//, "");
  }
  const modelBytes = files[modelPath] ?? files["3D/3dmodel.model"];
  if (!modelBytes) throw new Error("no 3D model part inside the 3MF package");

  const doc = new DOMParser().parseFromString(decoder.decode(modelBytes), "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("the 3D model inside it is not valid XML");

  const model = doc.documentElement;
  const scale = UNIT_MM[model.getAttribute("unit") ?? "millimeter"] ?? 1;

  const objects = new Map<string, Element>();
  for (const object of Array.from(doc.getElementsByTagName("object"))) {
    const id = object.getAttribute("id");
    if (id) objects.set(id, object);
  }

  /** Triangles of one object, in the frame `matrix` puts it in. `seen` breaks
   *  a components cycle rather than recursing until the stack gives out. */
  const collect = (
    object: Element,
    matrix: Matrix,
    seen: Set<string>,
  ): [number, number, number][][] => {
    const out: [number, number, number][][] = [];
    const mesh = object.getElementsByTagName("mesh")[0];
    if (mesh) {
      const points: [number, number, number][] = [];
      for (const vertex of Array.from(mesh.getElementsByTagName("vertex"))) {
        points.push(apply(
          matrix,
          Number(vertex.getAttribute("x")) * scale,
          Number(vertex.getAttribute("y")) * scale,
          Number(vertex.getAttribute("z")) * scale,
        ));
      }
      for (const triangle of Array.from(mesh.getElementsByTagName("triangle"))) {
        const a = points[Number(triangle.getAttribute("v1"))];
        const b = points[Number(triangle.getAttribute("v2"))];
        const c = points[Number(triangle.getAttribute("v3"))];
        if (a && b && c) out.push([a, b, c]);
      }
    }
    for (const component of Array.from(object.getElementsByTagName("component"))) {
      const id = component.getAttribute("objectid");
      if (!id || seen.has(id)) continue;
      const child = objects.get(id);
      if (!child) continue;
      out.push(...collect(
        child,
        multiply(matrix, parseMatrix(component.getAttribute("transform"))),
        new Set([...seen, id]),
      ));
    }
    return out;
  };

  const parts: ThreeMFPart[] = [];
  const items = Array.from(doc.getElementsByTagName("item"));
  for (const item of items) {
    const id = item.getAttribute("objectid");
    const object = id ? objects.get(id) : undefined;
    if (!object || !id) continue;
    const triangles = collect(object, parseMatrix(item.getAttribute("transform")), new Set([id]));
    if (!triangles.length) continue;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity;
    for (const triangle of triangles) {
      for (const [x, y, z] of triangle) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
      }
    }
    parts.push({
      name: object.getAttribute("name")?.trim() || `Object ${parts.length + 1}`,
      triangles: triangles.length,
      stl: binarySTL(triangles),
      anchor: [(minX + maxX) / 2, (minY + maxY) / 2, minZ],
    });
  }
  return parts;
}
