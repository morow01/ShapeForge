import { getBlob } from "../document/blobStore";
import type { KernelMesh, NumericArray } from "./types";

/**
 * Fast, non-repairing STL loader for the editing viewport. Slicers display STL
 * files this way: parse their triangles and render them directly. Expensive
 * manifold repair remains deferred until a boolean/result/export needs it.
 */
export async function loadSTLPreview(name: string, blobId: string): Promise<KernelMesh> {
  const bytes = await getBlob(blobId);
  if (!bytes) throw new Error("This imported file is missing from browser storage.");
  const faces = isBinarySTL(bytes) ? parseBinary(bytes) : parseAscii(bytes);
  normaliseToBed(faces.vertices);
  return {
    name,
    faces: {
      ...faces,
      faceGroups: [{ start: 0, count: faces.triangles.length, faceId: 0 }],
    },
    // Empty edge data avoids generating millions of triangle-edge lines for a
    // scan. The shaded surface is still fully pickable.
    edges: { lines: [], edgeGroups: [] },
  };
}

function isBinarySTL(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 84) return false;
  const count = new DataView(bytes).getUint32(80, true);
  return bytes.byteLength === 84 + count * 50;
}

function parseBinary(bytes: ArrayBuffer): {
  vertices: Float32Array;
  triangles: Uint32Array;
  normals: Float32Array;
} {
  const view = new DataView(bytes);
  const count = view.getUint32(80, true);
  const vertices = new Float32Array(count * 9);
  const normals = new Float32Array(count * 9);
  const triangles = new Uint32Array(count * 3);

  let offset = 84;
  for (let face = 0; face < count; face++, offset += 50) {
    const nx = view.getFloat32(offset, true);
    const ny = view.getFloat32(offset + 4, true);
    const nz = view.getFloat32(offset + 8, true);
    const base = face * 9;
    for (let corner = 0; corner < 3; corner++) {
      const at = offset + 12 + corner * 12;
      const out = base + corner * 3;
      vertices[out] = view.getFloat32(at, true);
      vertices[out + 1] = view.getFloat32(at + 4, true);
      vertices[out + 2] = view.getFloat32(at + 8, true);
      normals[out] = nx;
      normals[out + 1] = ny;
      normals[out + 2] = nz;
      triangles[face * 3 + corner] = face * 3 + corner;
    }
  }
  return { vertices, triangles, normals };
}

function parseAscii(bytes: ArrayBuffer): {
  vertices: Float32Array;
  triangles: Uint32Array;
  normals: Float32Array;
} {
  const text = new TextDecoder().decode(bytes);
  const values: number[] = [];
  const vertexPattern = /\bvertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
  let match: RegExpExecArray | null;
  while ((match = vertexPattern.exec(text))) {
    values.push(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  if (!values.length || values.length % 9 !== 0) {
    throw new Error("This does not appear to be a valid binary or ASCII STL file.");
  }

  const vertices = Float32Array.from(values);
  const triangles = new Uint32Array(vertices.length / 3);
  for (let i = 0; i < triangles.length; i++) triangles[i] = i;
  // Let Three.js compute smooth-enough display normals when ASCII facet
  // normals are absent or unreliable.
  return { vertices, triangles, normals: new Float32Array() };
}

function normaliseToBed(vertices: NumericArray) {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < vertices.length; i += 3) {
    minX = Math.min(minX, vertices[i]);
    maxX = Math.max(maxX, vertices[i]);
    minY = Math.min(minY, vertices[i + 1]);
    maxY = Math.max(maxY, vertices[i + 1]);
    minZ = Math.min(minZ, vertices[i + 2]);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  for (let i = 0; i < vertices.length; i += 3) {
    vertices[i] -= cx;
    vertices[i + 1] -= cy;
    vertices[i + 2] -= minZ;
  }
}
