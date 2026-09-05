// The CAD kernel runs here, off the main thread. OCCT operations are
// synchronous and can block for hundreds of ms; keeping them in a worker is
// what stops the UI freezing mid-drag.
import * as Comlink from "comlink";
import opencascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import ManifoldModule from "manifold-3d";
import manifoldWasmUrl from "manifold-3d/manifold.wasm?url";
import { setOC, setManifold, measureVolume, MeshShape, getManifold } from "replicad";
import type { Shape3D } from "replicad";
import {
  applyPushPullPreview,
  combine,
  decompose,
  isEmptySolid,
  tessellatesEmpty,
  unionKeptEverything,
  hasImport,
  isMesh,
  getSolidBounds,
  makeLocal,
  makeWorld,
  makePushPullPreviewBase,
  place,
  survivingOps,
  boundsOf,
} from "./shape";
import { SVG_IMPORT_REVISION } from "./svgSolid";
import { loadSTLPreview } from "./stlPreview";
import type { AnySolid } from "./shape";
import { RETRYABLE_MESH_ERROR } from "./types";
import type {
  BuildError,
  CellPart,
  DisplayedSceneItem,
  ExportQuality,
  FaceInfo,
  KernelMesh,
  MeshedEdges,
  MeshedFaces,
  NodeSpec,
  ObjectSpec,
  PreviewBuild,
  ScenePart,
  SceneBuild,
  ResultBuild,
} from "./types";
import type { EditOp, PushPullOp, Vec3 } from "../document/types";

let booted: Promise<void> | null = null;

function initOC(): Promise<void> {
  if (!booted) {
    booted = opencascade({ locateFile: () => wasmUrl }).then((OC: unknown) => {
      setOC(OC as never);
    });
  }
  return booted;
}

// manifold-3d is a second, separate WASM module (~530KB, negligible next to
// OCCT's 22MB) — needed for imported STL geometry. importSTL() (OCCT's own
// BRep import path) hits a raw, uncatchable WebAssembly exception partway
// through solid reconstruction in this build — reproduced even round-tripping
// OCCT's own STL export back through its own importer, so it is not a
// malformed-file issue, it is this build. Imports go through importSTLAsMesh
// (manifold-3d) instead — see shape.ts for how that composes with ordinary
// OCCT primitives in the same boolean.
let manifoldBooted: Promise<void> | null = null;

/** The stable part of the most recent live push/pull preview. One entry is
 * enough because the worker is single-threaded and the UI coalesces each drag
 * to its newest distance. Replacing it also prevents an unbounded shape cache. */
let pushPullPreviewCache: { key: string; solid: Shape3D } | null = null;

function initManifold(): Promise<void> {
  if (!manifoldBooted) {
    manifoldBooted = ManifoldModule({ locateFile: () => manifoldWasmUrl }).then((wasm) => {
      wasm.setup();
      setManifold(wasm);
    });
  }
  return manifoldBooted;
}

function init(): Promise<void> {
  return Promise.all([initOC(), initManifold()]).then(() => undefined);
}

interface MeshQuality {
  tolerance: number;
  angularTolerance: number;
}

/**
 * Tessellation quality for the live editing view — favors speed. OCCT's
 * default tolerance (~0.001mm) is an ABSOLUTE deviation, so a curved
 * primitive's triangle count grows with its own size, not just its
 * curvature: a 20mm-radius sphere alone came out to 201,198 triangles and
 * took 3.3 seconds to tessellate at the default; a 100mm one didn't finish
 * before exhausting the WASM instance's memory and crashing it. A box or
 * cylinder never showed this because flat faces need only 2 triangles
 * regardless of size, and a cylinder is curved in only one direction — a
 * sphere is curved everywhere, so it is by far the worst case.
 *
 * This setting keeps any single primitive at a few thousand triangles and
 * comfortably under 100ms even at a 100mm radius (measured), which is
 * already smoother than a viewport needs while dragging a slider live.
 */
const EDIT_QUALITY: MeshQuality = { tolerance: 0.05, angularTolerance: 0.4 };

/**
 * Tessellation quality for an STL export, chosen per export by the user (the
 * Export quality control beside the Export STL button).
 *
 * Curved faces are what this decides: a facet angle is what shows up in a
 * slicer's flat shading as banding across a spherical pocket, and halving it
 * costs roughly four times the triangles and four times the time. Measured
 * here on a 40x30x15 box with a 10mm spherical bowl cut into it:
 *
 *   draft     7.9 deg median facet     1,198 triangles     ~0.1s
 *   standard  5.1 deg                  2,588               ~0.05s
 *   fine      1.2 deg                 45,150               ~6.5s
 *
 * The cost scales with the curved area, not the part: a lone 40mm-radius
 * sphere takes 20s at a setting between standard and fine, which is why this
 * is the user's choice and not one hardcoded number. None of them is coarse
 * enough to matter dimensionally — even draft's deviation is 0.05mm — so the
 * choice is about how the surface LOOKS, and how long you are willing to wait.
 *
 * OCCT's own default (~0.001mm, no argument passed) is deliberately not an
 * option: it is the setting that turns a single large sphere into six figures
 * of triangles and can exhaust the WASM heap outright.
 */
const EXPORT_PRESETS: Record<ExportQuality, MeshQuality> = {
  draft: { tolerance: 0.05, angularTolerance: 0.4 },
  standard: { tolerance: 0.02, angularTolerance: 0.3 },
  // Keep the original high-quality tessellation. The timeout was caused by
  // converting that dense mesh through Manifold before writing it, not by
  // OCCT's tessellation itself; the refined-shell path below writes those
  // triangles directly and therefore retains the old smoothness.
  fine: { tolerance: 0.002, angularTolerance: 0.03 },
};

/** What the merged-result preview meshes at — a screen preview, so it takes
 *  the middle setting rather than whatever an export happens to ask for. */
const EXPORT_QUALITY: MeshQuality = EXPORT_PRESETS.standard;

/** MeshShape (imports, or anything combined with one) has no OCCT face
 *  topology to preserve, so it becomes one single pickable "face" covering
 *  the whole triangle set, and there is no separate edge/wireframe data —
 *  syncGeometries on the Three.js side treats edges as optional. */
function meshFromMeshShape(m: MeshShape): { faces: MeshedFaces; edges: MeshedEdges } {
  const raw = m.mesh();
  const triangleCount = raw.triangles.length / 3;
  const numVerts = raw.vertices.length / 3;

  // Ultra-fast smooth vertex normal accumulation
  const smoothNormals = new Float32Array(raw.vertices.length);
  for (let t = 0; t < triangleCount; t++) {
    const i0 = raw.triangles[t * 3] * 3;
    const i1 = raw.triangles[t * 3 + 1] * 3;
    const i2 = raw.triangles[t * 3 + 2] * 3;

    const ax = raw.vertices[i0], ay = raw.vertices[i0 + 1], az = raw.vertices[i0 + 2];
    const bx = raw.vertices[i1], by = raw.vertices[i1 + 1], bz = raw.vertices[i1 + 2];
    const cx = raw.vertices[i2], cy = raw.vertices[i2 + 1], cz = raw.vertices[i2 + 2];

    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;

    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;

    smoothNormals[i0] += nx; smoothNormals[i0 + 1] += ny; smoothNormals[i0 + 2] += nz;
    smoothNormals[i1] += nx; smoothNormals[i1 + 1] += ny; smoothNormals[i1 + 2] += nz;
    smoothNormals[i2] += nx; smoothNormals[i2 + 1] += ny; smoothNormals[i2 + 2] += nz;
  }

  for (let v = 0; v < numVerts; v++) {
    const i = v * 3;
    const len = Math.hypot(smoothNormals[i], smoothNormals[i + 1], smoothNormals[i + 2]) || 1;
    smoothNormals[i] /= len;
    smoothNormals[i + 1] /= len;
    smoothNormals[i + 2] /= len;
  }

  const faceGroups = [{ start: 0, count: raw.triangles.length, faceId: 0 }];

  return {
    faces: {
      vertices: Float32Array.from(raw.vertices),
      triangles: Uint32Array.from(raw.triangles),
      normals: smoothNormals,
      faceGroups,
    },
    edges: { lines: new Float32Array(0), edgeGroups: [] },
  };
}

/** Rebuild display normals independently for every CAD face.
 *
 * OCCT occasionally returns a misleading vertex normal at a corner where a
 * fillet terminates against a chamfer.  The triangles themselves are sound
 * (and therefore export correctly), but sharing that normal across adjacent
 * faces produces a dark triangular "dent" in the viewport.  Welding only
 * equal positions inside one face gives curved faces smooth shading while
 * keeping every real B-Rep boundary sharp. */
function normalsPerCadFace(faces: MeshedFaces): MeshedFaces {
  const sourceVertices = faces.vertices;
  const sourceTriangles = faces.triangles;
  if (!sourceTriangles.length || !faces.faceGroups.length) return faces;

  const vertices: number[] = [];
  const triangles = new Array<number>(sourceTriangles.length);
  const normals: number[] = [];

  for (const face of faces.faceGroups) {
    const baseVertex = vertices.length / 3;
    const local = new Map<string, number>();
    const accumulated: number[] = [];
    for (let offset = face.start; offset < face.start + face.count; offset += 3) {
      const sourceIds = [sourceTriangles[offset], sourceTriangles[offset + 1], sourceTriangles[offset + 2]];
      const points = sourceIds.map((id) => {
        const at = id * 3;
        return [sourceVertices[at], sourceVertices[at + 1], sourceVertices[at + 2]];
      });
      const ab = [points[1][0] - points[0][0], points[1][1] - points[0][1], points[1][2] - points[0][2]];
      const ac = [points[2][0] - points[0][0], points[2][1] - points[0][1], points[2][2] - points[0][2]];
      // Keep the cross product unnormalised so larger triangles contribute
      // proportionally more to the smooth normal.
      const cross = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
      ];
      for (let corner = 0; corner < 3; corner++) {
        const point = points[corner];
        const key = `${Math.round(point[0] * 1e6)},${Math.round(point[1] * 1e6)},${Math.round(point[2] * 1e6)}`;
        let index = local.get(key);
        if (index === undefined) {
          index = vertices.length / 3;
          local.set(key, index);
          vertices.push(point[0], point[1], point[2]);
          accumulated.push(0, 0, 0);
        }
        triangles[offset + corner] = index;
        const localIndex = index - baseVertex;
        accumulated[localIndex * 3] += cross[0];
        accumulated[localIndex * 3 + 1] += cross[1];
        accumulated[localIndex * 3 + 2] += cross[2];
      }
    }
    for (let index = 0; index < accumulated.length / 3; index++) {
      const x = accumulated[index * 3];
      const y = accumulated[index * 3 + 1];
      const z = accumulated[index * 3 + 2];
      const length = Math.hypot(x, y, z) || 1;
      normals.push(x / length, y / length, z / length);
    }
  }
  return { ...faces, vertices, triangles, normals };
}

function toMesh(name: string, s: AnySolid, quality: MeshQuality): KernelMesh {
  if (isMesh(s)) {
    const { faces, edges } = meshFromMeshShape(s);
    return { name, faces, edges };
  }
  return { name, faces: normalsPerCadFace(s.mesh(quality)), edges: s.meshEdges(quality) };
}

/** An ellipsoid is created through Manifold rather than as an OCCT analytic
 * surface. Its mesh can contain split vertices, so averaged triangle normals
 * still reveal polygon bands. The gradient of the ellipsoid equation gives
 * the exact smooth normal at every vertex, independent of mesh topology. */
function withEllipsoidNormals(mesh: KernelMesh): KernelMesh {
  const bounds = meshBounds(mesh);
  if (!bounds) return mesh;
  const cx = (bounds.min[0] + bounds.max[0]) / 2;
  const cy = (bounds.min[1] + bounds.max[1]) / 2;
  const cz = (bounds.min[2] + bounds.max[2]) / 2;
  const rx = Math.max((bounds.max[0] - bounds.min[0]) / 2, 1e-9);
  const ry = Math.max((bounds.max[1] - bounds.min[1]) / 2, 1e-9);
  const rz = Math.max((bounds.max[2] - bounds.min[2]) / 2, 1e-9);
  const vertices = mesh.faces.vertices;
  const normals = new Float32Array(vertices.length);
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    const nx = (vertices[i] - cx) / (rx * rx);
    const ny = (vertices[i + 1] - cy) / (ry * ry);
    const nz = (vertices[i + 2] - cz) / (rz * rz);
    const length = Math.hypot(nx, ny, nz) || 1;
    normals[i] = nx / length;
    normals[i + 1] = ny / length;
    normals[i + 2] = nz / length;
  }
  return { ...mesh, faces: { ...mesh.faces, normals } };
}

function getBaseObjectSpec(spec: NodeSpec): ObjectSpec | null {
  if (spec.type === "object") return spec;
  if (spec.type === "edit") return getBaseObjectSpec(spec.base);
  return null;
}

/** Hide only a polygon-cylinder's vertical facet boundaries while retaining
 * its top/bottom silhouette and any rounded-rim edges. The faces themselves
 * are untouched, so Sides still controls the real model and its exports. */
function withoutExtrusionSideEdges(mesh: KernelMesh, axis = 2): KernelMesh {
  const source = mesh.edges.lines;
  const lines: number[] = [];
  const edgeGroups: MeshedEdges["edgeGroups"] = [];

  for (const group of mesh.edges.edgeGroups) {
    let groupMin = Infinity;
    let groupMax = -Infinity;
    for (let vertex = group.start; vertex < group.start + group.count; vertex++) {
      const value = source[vertex * 3 + axis];
      groupMin = Math.min(groupMin, value);
      groupMax = Math.max(groupMax, value);
    }
    const liesOnEnd = groupMax - groupMin < 1e-4;
    if (!liesOnEnd) continue;
    const start = lines.length / 3;
    for (let vertex = group.start; vertex < group.start + group.count; vertex++) {
      const offset = vertex * 3;
      lines.push(source[offset], source[offset + 1], source[offset + 2]);
    }
    edgeGroups.push({ ...group, start });
  }

  return { ...mesh, edges: { lines, edgeGroups } };
}

/** Mesh-based threaded nuts do not carry OCCT edge topology. Recreate only
 * the useful rounded-body guide rings when the user asks to see them, rather
 * than exposing the thousands of triangle edges belonging to the thread. */
function withNutCornerLines(mesh: KernelMesh, params: Record<string, number>): KernelMesh {
  const shape = Math.round(params.shape ?? 0);
  if (shape !== 0 && shape !== 1) return mesh;
  const sides = shape === 0 ? 6 : 4;
  const outerWidth = Math.max(params.outerWidth ?? 13, 0.1);
  const height = Math.max(params.height ?? 6.5, 0.1);
  const fullRadius = shape === 0 ? outerWidth / Math.sqrt(3) : outerWidth / Math.sqrt(2);
  const rotation = shape === 0 ? 0 : Math.PI / 4;
  const diameter = Math.max(params.diameter ?? 8, 2);
  const clearance = Math.max(params.clearance ?? 0.2, 0);
  const maxCorner = Math.max(0, Math.min(height / 2, (outerWidth - diameter - clearance * 2) / 2) - 0.01);
  const top = Math.min(Math.max(params.topFillet ?? 0, 0), maxCorner);
  const bottom = Math.min(Math.max(params.bottomFillet ?? 0, 0), maxCorner);
  const steps = Math.max(1, Math.min(32, Math.round(params.cornerSteps ?? 16)));
  const rings: Array<{ radius: number; z: number }> = [];
  for (let i = 0; bottom > 0 && i <= steps; i++) {
    const angle = Math.PI / 2 * i / steps;
    rings.push({ radius: fullRadius - bottom * (1 - Math.sin(angle)), z: bottom * (1 - Math.cos(angle)) });
  }
  for (let i = 0; top > 0 && i <= steps; i++) {
    const angle = Math.PI / 2 * i / steps;
    rings.push({ radius: fullRadius - top * (1 - Math.cos(angle)), z: height - top + top * Math.sin(angle) });
  }
  const lines: number[] = [];
  const edgeGroups: MeshedEdges["edgeGroups"] = [];
  let edgeId = 0;
  for (const ring of rings) {
    for (let side = 0; side < sides; side++) {
      const a = rotation + side * 2 * Math.PI / sides;
      const b = rotation + (side + 1) * 2 * Math.PI / sides;
      const start = lines.length / 3;
      lines.push(
        ring.radius * Math.cos(a), ring.radius * Math.sin(a), ring.z,
        ring.radius * Math.cos(b), ring.radius * Math.sin(b), ring.z,
      );
      edgeGroups.push({ start, count: 2, edgeId: edgeId++ });
    }
  }
  return { ...mesh, edges: { lines: Float32Array.from(lines), edgeGroups } };
}

function withThreadedHeadCornerLines(mesh: KernelMesh, params: Record<string, number>): KernelMesh {
  const headType = Math.round(params.headType ?? 0);
  const headSize = Math.max(params.headSize ?? 13, 0.1);
  const diameter = Math.max(params.diameter ?? 8, 0.1);
  const height = Math.max(params.headHeight ?? 5.5, 0.1);
  let baseRadii: number[];
  if (headType === 1) {
    baseRadii = Array(6).fill(headSize / Math.sqrt(3));
  } else if (headType === 3) {
    const count = Math.max(12, Math.min(48, Math.max(16, Math.round(headSize * 1.6)))) * 2;
    const crest = headSize / 2;
    const depth = Math.max(0.35, Math.min(1.2, headSize * 0.05));
    baseRadii = Array.from({ length: count }, (_, index) => index % 2 === 0 ? crest : crest - depth);
  } else {
    baseRadii = Array(64).fill(headSize / 2);
  }
  const styleFraction = headType === 2 ? 0.25 : 0.15;
  const maxCorner = Math.max(0, Math.min(
    height * styleFraction,
    (headSize - diameter) / 2,
  ) - 0.01);
  const top = Math.min(Math.max(params.topFillet ?? 0, 0), maxCorner);
  const bottom = Math.min(Math.max(params.bottomFillet ?? 0, 0), maxCorner);
  const steps = Math.max(1, Math.min(32, Math.round(params.cornerSteps ?? 16)));
  const guideSteps = Math.max(2, Math.min(12, steps));
  const rings: Array<{ inset: number; z: number }> = [];
  for (let i = 0; top > 0 && i <= guideSteps; i++) {
    const angle = Math.PI / 2 * i / guideSteps;
    rings.push({ inset: top * (1 - Math.sin(angle)), z: top * (1 - Math.cos(angle)) });
  }
  for (let i = 0; bottom > 0 && i <= guideSteps; i++) {
    const angle = Math.PI / 2 * i / guideSteps;
    rings.push({ inset: bottom * (1 - Math.cos(angle)), z: height - bottom + bottom * Math.sin(angle) });
  }
  const lines: number[] = [];
  const edgeGroups: MeshedEdges["edgeGroups"] = [];
  let edgeId = 0;
  const sides = baseRadii.length;
  for (const ring of rings) {
    for (let side = 0; side < sides; side++) {
      const a = side * 2 * Math.PI / sides;
      const b = (side + 1) * 2 * Math.PI / sides;
      const radiusA = Math.max(0.05, baseRadii[side] - ring.inset) + 0.01;
      const radiusB = Math.max(0.05, baseRadii[(side + 1) % sides] - ring.inset) + 0.01;
      const start = lines.length / 3;
      lines.push(
        radiusA * Math.cos(a), radiusA * Math.sin(a), ring.z,
        radiusB * Math.cos(b), radiusB * Math.sin(b), ring.z,
      );
      edgeGroups.push({ start, count: 2, edgeId: edgeId++ });
    }
  }
  return { ...mesh, edges: { lines: Float32Array.from(lines), edgeGroups } };
}

/** Draw clean height contours from the final tessellated surface. Slicing the
 * finished mesh keeps the guides attached to fillets without exposing every
 * internal triangle (which made the Dome look like a wireframe). */
function withSurfaceContourLines(mesh: KernelMesh, requestedSteps: number): KernelMesh {
  const vertices = mesh.faces.vertices;
  const triangles = mesh.faces.triangles;
  const lines: number[] = [];
  const edgeGroups: MeshedEdges["edgeGroups"] = [];
  let edgeId = 0;

  if (!vertices.length || !triangles.length) return mesh;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    minX = Math.min(minX, vertices[i]); maxX = Math.max(maxX, vertices[i]);
    minY = Math.min(minY, vertices[i + 1]); maxY = Math.max(maxY, vertices[i + 1]);
    minZ = Math.min(minZ, vertices[i + 2]); maxZ = Math.max(maxZ, vertices[i + 2]);
  }
  const centreX = (minX + maxX) / 2;
  const centreY = (minY + maxY) / 2;
  const contourCount = Math.max(3, Math.min(12, Math.round(requestedSteps / 4)));
  const epsilon = Math.max(1e-7, (maxZ - minZ) * 1e-7);

  const addSegment = (a: number[], b: number[]) => {
    const start = lines.length / 3;
    for (const point of [a, b]) {
      const dx = point[0] - centreX;
      const dy = point[1] - centreY;
      const radius = Math.hypot(dx, dy);
      const lift = radius > epsilon ? 0.01 / radius : 0;
      lines.push(
        point[0] + dx * lift,
        point[1] + dy * lift,
        point[2],
      );
    }
    edgeGroups.push({ start, count: 2, edgeId: edgeId++ });
  };

  for (let level = 1; level <= contourCount; level++) {
    const z = minZ + (maxZ - minZ) * level / (contourCount + 1);
    for (let i = 0; i + 2 < triangles.length; i += 3) {
      const indices = [triangles[i], triangles[i + 1], triangles[i + 2]];
      const intersections: number[][] = [];
      for (let edge = 0; edge < 3; edge++) {
        const ai = indices[edge] * 3;
        const bi = indices[(edge + 1) % 3] * 3;
        const az = vertices[ai + 2], bz = vertices[bi + 2];
        if (!((az < z && bz >= z) || (bz < z && az >= z))) continue;
        const t = (z - az) / (bz - az);
        const point = [
          vertices[ai] + (vertices[bi] - vertices[ai]) * t,
          vertices[ai + 1] + (vertices[bi + 1] - vertices[ai + 1]) * t,
          z,
        ];
        if (!intersections.some((other) => Math.hypot(point[0] - other[0], point[1] - other[1]) < epsilon)) {
          intersections.push(point);
        }
      }
      if (intersections.length === 2) addSegment(intersections[0], intersections[1]);
    }
  }
  return { ...mesh, edges: { lines: Float32Array.from(lines), edgeGroups } };
}

function withTorusSurfaceLines(mesh: KernelMesh, params: Record<string, number>): KernelMesh {
  const R = Math.max(params.radius ?? 15, 1);
  const r = Math.min(Math.max(params.tubeRadius ?? 5, 0.2), R - 0.05);
  const ringSteps = Math.max(8, Math.min(64, Math.round(params.ringSteps ?? 48)));
  const tubeSteps = Math.max(8, Math.min(64, Math.round(params.tubeSteps ?? 32)));
  const ringGuides = Math.max(4, Math.min(12, Math.round(ringSteps / 4)));
  const tubeGuides = Math.max(4, Math.min(12, Math.round(tubeSteps / 4)));
  const lines: number[] = [];
  const edgeGroups: MeshedEdges["edgeGroups"] = [];
  let edgeId = 0;
  const point = (u: number, v: number): [number, number, number] => {
    const lift = 0.01;
    const radial = R + (r + lift) * Math.cos(v);
    return [radial * Math.cos(u), radial * Math.sin(u), r + (r + lift) * Math.sin(v)];
  };
  const add = (a: [number, number, number], b: [number, number, number]) => {
    const start = lines.length / 3;
    lines.push(...a, ...b);
    edgeGroups.push({ start, count: 2, edgeId: edgeId++ });
  };
  for (let guide = 0; guide < tubeGuides; guide++) {
    const v = guide * 2 * Math.PI / tubeGuides;
    for (let ring = 0; ring < ringSteps; ring++) {
      add(point(ring * 2 * Math.PI / ringSteps, v), point((ring + 1) * 2 * Math.PI / ringSteps, v));
    }
  }
  for (let guide = 0; guide < ringGuides; guide++) {
    const u = guide * 2 * Math.PI / ringGuides;
    for (let tube = 0; tube < tubeSteps; tube++) {
      add(point(u, tube * 2 * Math.PI / tubeSteps), point(u, (tube + 1) * 2 * Math.PI / tubeSteps));
    }
  }
  return { ...mesh, edges: { lines: Float32Array.from(lines), edgeGroups } };
}

function withSphereSurfaceLines(mesh: KernelMesh, params: Record<string, number>): KernelMesh {
  const radius = Math.max(params.radius ?? 10, 0.1);
  const steps = Math.max(8, Math.min(64, Math.round(params.surfaceSteps ?? 48)));
  const guideCount = Math.max(4, Math.min(12, Math.round(steps / 4)));
  // Guide curves are display-only. They need a denser sampling than a low-poly
  // sphere; otherwise each straight guide segment cuts back through the
  // curved surface and appears as a row of disconnected dashes.
  const samples = Math.max(64, steps * 2);
  const displayRadius = radius + 0.02;
  const lines: number[] = [];
  const edgeGroups: MeshedEdges["edgeGroups"] = [];
  let edgeId = 0;
  const point = (longitude: number, latitude: number): [number, number, number] => {
    const ringRadius = displayRadius * Math.cos(latitude);
    return [
      ringRadius * Math.cos(longitude),
      ringRadius * Math.sin(longitude),
      radius + displayRadius * Math.sin(latitude),
    ];
  };
  const add = (a: [number, number, number], b: [number, number, number]) => {
    const start = lines.length / 3;
    lines.push(...a, ...b);
    edgeGroups.push({ start, count: 2, edgeId: edgeId++ });
  };

  for (let guide = 1; guide <= guideCount; guide++) {
    const latitude = -Math.PI / 2 + Math.PI * guide / (guideCount + 1);
    for (let sample = 0; sample < samples; sample++) {
      add(
        point(sample * 2 * Math.PI / samples, latitude),
        point((sample + 1) * 2 * Math.PI / samples, latitude),
      );
    }
  }
  for (let guide = 0; guide < guideCount; guide++) {
    const longitude = guide * Math.PI / guideCount;
    for (let sample = 0; sample < samples; sample++) {
      const latitudeA = -Math.PI / 2 + Math.PI * sample / samples;
      const latitudeB = -Math.PI / 2 + Math.PI * (sample + 1) / samples;
      add(point(longitude, latitudeA), point(longitude, latitudeB));
    }
  }
  return { ...mesh, edges: { lines: Float32Array.from(lines), edgeGroups } };
}

/**
 * The BRep can report correct bounds and still occasionally tessellate with
 * displaced/stray vertices after repeated boolean rebuilds. The viewport
 * measures and renders the mesh, so validating only the source solid misses
 * the exact failure the user sees. Reject any tessellation whose visible
 * vertex envelope does not agree with its source solid.
 */
function meshMatchesSolidBounds(mesh: KernelMesh, solid: AnySolid): boolean {
  try {
    const [expectedMin, expectedMax] = getSolidBounds(solid);
    const vertices = mesh.faces.vertices;
    if (!vertices.length) return false;
    const gotMin = [Infinity, Infinity, Infinity];
    const gotMax = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i + 2 < vertices.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const value = vertices[i + axis];
        if (!Number.isFinite(value)) return false;
        gotMin[axis] = Math.min(gotMin[axis], value);
        gotMax[axis] = Math.max(gotMax[axis], value);
      }
    }
    // Curved tessellation is an inscribed approximation. Requiring its bounds
    // to agree more closely than the requested 0.05 mm mesh tolerance falsely
    // rejects legitimate fillets (often by almost exactly 0.05 mm). Keep a
    // small multiple of that tolerance: still tiny enough to catch the
    // displaced-vertex failures this guard exists for, without classifying a
    // correctly rounded edge as a broken mesh.
    const span = [0, 1, 2].map((axis) => expectedMax[axis] - expectedMin[axis]);
    // Angular deflection can dominate linear tolerance at a rounded extreme:
    // an inscribed facet may legitimately stop short of the exact B-Rep bound
    // by the sagitta implied by angularTolerance. The old fixed 0.15 mm check
    // therefore rejected valid larger fillets even though their STL and B-Rep
    // were sound. Bound that expected shortfall from the part's radius scale;
    // displaced vertices still fail because they overshoot by far more.
    const angularSagitta = Math.max(...span) / 2 *
      (1 - Math.cos(EDIT_QUALITY.angularTolerance / 2)) * 1.5;
    // This guard is for catastrophic stray/displaced vertices, not for
    // judging tessellation fidelity. Five percent is still far below the
    // multi-part jumps produced by the OCCT failure it catches, while curved
    // edit chains can legitimately miss an analytic extremum by more than
    // the nominal deflection after several transitions.
    const tolerance = Math.max(EDIT_QUALITY.tolerance * 3, angularSagitta, Math.max(...span) * 0.05) + 1e-6;
    return [0, 1, 2].every(
      (axis) =>
        Math.abs(gotMin[axis] - expectedMin[axis]) <= tolerance &&
        Math.abs(gotMax[axis] - expectedMax[axis]) <= tolerance,
    );
  } catch {
    return false;
  }
}

/** Every face of a top-level part, in its own local frame — lets the
 *  viewport highlight whichever one the pointer is directly over (planar or
 *  curved) and, for a planar one, push/pull it. Skipped for a MeshShape (an
 *  import, or anything a boolean touched an import in): those have no OCCT
 *  face topology to walk. faceId is just this loop's own index, matching
 *  s.mesh()'s faceGroups[].faceId — both are built by walking the same
 *  solid's s.faces list, so the two line up without needing to agree on it
 *  through any other channel. */
function faceInfoOf(mesh: KernelMesh): FaceInfo[] {
  // Triangle-backed solids now use the manifold prism fallback in shape.ts,
  // so their reconstructed planar faces are valid push/pull targets too.
  const pushPullable = true;
  const { vertices, triangles, normals, faceGroups } = mesh.faces;
  return faceGroups.map((group): FaceInfo => {
    const firstVertex = triangles[group.start];
    if (firstVertex === undefined) return { planar: false, point: [0, 0, 0], normal: [0, 0, 1] };

    const nx = normals[firstVertex * 3] ?? 0;
    const ny = normals[firstVertex * 3 + 1] ?? 0;
    const nz = normals[firstVertex * 3 + 2] ?? 1;
    const px = vertices[firstVertex * 3];
    const py = vertices[firstVertex * 3 + 1];
    const pz = vertices[firstVertex * 3 + 2];
    let interiorPoint: [number, number, number] = [px, py, pz];
    let largestTriangleArea = -1;
    let planar = true;
    for (let offset = group.start; offset < group.start + group.count; offset++) {
      const vertex = triangles[offset];
      const distance = nx * (vertices[vertex * 3] - px) +
        ny * (vertices[vertex * 3 + 1] - py) +
        nz * (vertices[vertex * 3 + 2] - pz);
      if (Math.abs(distance) > 1e-4) {
        planar = false;
        break;
      }
    }

    // A face group's first vertex is commonly on an outer/bottom edge. That
    // made the handle look misplaced and, more importantly, gave OCCT an
    // ambiguous edge point when it tried to find the face again for a pull.
    // The centroid of the largest tessellation triangle is guaranteed to be
    // inside this face and tends to place the handle in its broadest region.
    for (let offset = group.start; offset + 2 < group.start + group.count; offset += 3) {
      const ia = triangles[offset] * 3;
      const ib = triangles[offset + 1] * 3;
      const ic = triangles[offset + 2] * 3;
      const abx = vertices[ib] - vertices[ia];
      const aby = vertices[ib + 1] - vertices[ia + 1];
      const abz = vertices[ib + 2] - vertices[ia + 2];
      const acx = vertices[ic] - vertices[ia];
      const acy = vertices[ic + 1] - vertices[ia + 1];
      const acz = vertices[ic + 2] - vertices[ia + 2];
      const area = Math.hypot(
        aby * acz - abz * acy,
        abz * acx - abx * acz,
        abx * acy - aby * acx,
      );
      if (area > largestTriangleArea) {
        largestTriangleArea = area;
        interiorPoint = [
          (vertices[ia] + vertices[ib] + vertices[ic]) / 3,
          (vertices[ia + 1] + vertices[ib + 1] + vertices[ic + 1]) / 3,
          (vertices[ia + 2] + vertices[ib + 2] + vertices[ic + 2]) / 3,
        ];
      }
    }

    // Reduce the face's tessellation triangles back to its outer boundary.
    // Internal diagonals occur twice; a real face-border segment occurs once.
    const boundary = new Map<string, { count: number; midpoint: [number, number, number] }>();
    const vertexPoint = (index: number): [number, number, number] => [
      vertices[index * 3], vertices[index * 3 + 1], vertices[index * 3 + 2],
    ];
    const pointKey = (point: [number, number, number]) =>
      point.map((value) => Math.round(value * 1e5)).join(",");
    for (let offset = group.start; offset + 2 < group.start + group.count; offset += 3) {
      const ids = [triangles[offset], triangles[offset + 1], triangles[offset + 2]];
      for (const [aIndex, bIndex] of [[ids[0], ids[1]], [ids[1], ids[2]], [ids[2], ids[0]]]) {
        const a = vertexPoint(aIndex);
        const b = vertexPoint(bIndex);
        const keys = [pointKey(a), pointKey(b)].sort();
        const key = `${keys[0]}|${keys[1]}`;
        const existing = boundary.get(key);
        if (existing) existing.count += 1;
        else boundary.set(key, {
          count: 1,
          midpoint: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
        });
      }
    }

    return {
      planar,
      pushPullable,
      point: interiorPoint,
      normal: [nx, ny, nz],
      boundaryEdges: [...boundary.values()].filter((edge) => edge.count === 1).map((edge) => edge.midpoint),
    };
  });
}

function volumeOf(s: AnySolid): number {
  return isMesh(s) ? s.volume() : measureVolume(s);
}

function faceCountOf(s: AnySolid): number {
  return isMesh(s) ? s.numTri() : s.faces.length;
}

function blobSTLOf(s: AnySolid, quality: MeshQuality): Blob {
  // Deliberately NOT routed through meshShape()/manifold to "heal" the mesh
  // first. OCCT can leave T-junction cracks between a curved face and its
  // neighbour on a solid built from a long boolean/push-pull chain, but
  // manifold cannot repair those: meshShape() only merges COINCIDENT
  // vertices, and a T-junction's vertices genuinely do not pair up
  // (measured: 25 open edges survive even a 0.1mm weld). Worse, feeding it
  // such a mesh raises a "Not manifold" error out of the WASM module that
  // does not reliably surface as a catchable JS exception, so the attempt
  // turned a slightly-imperfect export into a failed one.
  return isMesh(s) ? s.blobSTL({ binary: true }) : s.blobSTL({ ...quality, binary: true });
}

/** Binary STL containing several already-evaluated closed shells. STL does
 * not require one topological body, and slicers routinely accept multiple
 * overlapping shells in one file. This is the safe fallback when manifold
 * cannot perform the optional final union of otherwise valid scene roots. */
function blobSTLOfMany(solids: AnySolid[], quality: MeshQuality): Blob {
  const meshes = solids.map((solid) => isMesh(solid) ? solid.mesh() : solid.mesh(quality));
  const triangleCount = meshes.reduce((sum, mesh) => sum + Math.floor(mesh.triangles.length / 3), 0);
  const buffer = new ArrayBuffer(84 + triangleCount * 50);
  const output = new DataView(buffer);
  output.setUint32(80, triangleCount, true);
  let triangleNumber = 0;
  for (const mesh of meshes) {
    for (let offset = 0; offset + 2 < mesh.triangles.length; offset += 3) {
      const ids = [mesh.triangles[offset], mesh.triangles[offset + 1], mesh.triangles[offset + 2]];
      const points = ids.map((id) => [mesh.vertices[id * 3], mesh.vertices[id * 3 + 1], mesh.vertices[id * 3 + 2]]);
      const [a, b, c] = points;
      const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      let nx = ab[1] * ac[2] - ab[2] * ac[1];
      let ny = ab[2] * ac[0] - ab[0] * ac[2];
      let nz = ab[0] * ac[1] - ab[1] * ac[0];
      const length = Math.hypot(nx, ny, nz) || 1;
      nx /= length; ny /= length; nz /= length;
      let byteOffset = 84 + triangleNumber++ * 50;
      for (const value of [nx, ny, nz, ...a, ...b, ...c]) {
        output.setFloat32(byteOffset, value, true);
        byteOffset += 4;
      }
      output.setUint16(byteOffset, 0, true);
    }
  }
  return new Blob([buffer], { type: "model/stl" });
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * A string that changes if and only if a node's LOCAL mesh (what makeLocal()
 * would produce) changes. A plain object's own position/rotation are excluded
 * — makeLocal() never reads them, only place() does, later. A group's key
 * does include each child's position/rotation/isHole, since those feed into
 * the group's own combined boolean. An import's key is just its blobId, which
 * never changes for a given node — importSTLAsMesh() only ever runs once.
 */
export const KERNEL_REVISION = 5;

function localKey(spec: NodeSpec): string {
  if (spec.type === "group") {
    return JSON.stringify([
      spec.type,
      spec.op,
      spec.children.map((c) => [localKey(c), c.position, c.rotation, c.scale, c.isHole]),
      KERNEL_REVISION,
    ]);
  }
  if (spec.type === "import") {
    return JSON.stringify([
      spec.type,
      spec.blobId,
      spec.svg ? [spec.svg.thickness, SVG_IMPORT_REVISION] : null,
      KERNEL_REVISION,
    ]);
  }
  if (spec.type === "edit") return JSON.stringify([spec.type, localKey(spec.base), spec.ops, KERNEL_REVISION]);
  if (spec.type === "build") {
    return JSON.stringify([
      spec.type,
      spec.sources.map((s) => [localKey(s), s.position, s.rotation, s.scale]),
      spec.keep,
      KERNEL_REVISION,
    ]);
  }
  return JSON.stringify([spec.type, spec.kind, spec.params, spec.text, spec.fontName, spec.textPaths, KERNEL_REVISION]);
}

/**
 * Per-node mesh cache, keyed by node id. Without this, dragging a slider on
 * one object rebuilds every OTHER object in the scene too — buildScene() has
 * no way to know only one node changed — so editing got slower the more
 * objects existed, even though only one of them was actually being touched.
 * A cache hit skips the OCCT call entirely, not just the retriangulation.
 */
const meshCache = new Map<string, { key: string; mesh: KernelMesh; faces?: FaceInfo[]; solid?: AnySolid }>();
/** How long one node may spend re-rolling an intermittent build failure
 *  before it settles for what it has. See the retry loop in buildScene. */
const RETRY_BUDGET_MS = 4000;
/** A scene build slower than this reports its per-node timings. */
const SLOW_BUILD_MS = 1500;
const MAX_MESH_CACHE_ENTRIES = 256;
const geometryCache = new Map<string, { mesh: KernelMesh; faces?: FaceInfo[]; solid: AnySolid }>();
const MAX_GEOMETRY_CACHE_ENTRIES = 128;

type NumericBounds = { min: number[]; max: number[] };

function meshBounds(mesh: KernelMesh): NumericBounds | null {
  const vertices = mesh.faces.vertices;
  if (!vertices.length) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = vertices[i + axis];
      if (!Number.isFinite(value)) return null;
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  return { min, max };
}

function solidBoundsOverlap(a: AnySolid, b: AnySolid): boolean {
  const [aMin, aMax] = getSolidBounds(a);
  const [bMin, bMax] = getSolidBounds(b);
  const epsilon = 1e-5;
  return [0, 1, 2].every(
    (axis) => aMax[axis] >= bMin[axis] - epsilon && bMax[axis] >= aMin[axis] - epsilon,
  );
}

/** Reconstructs a mesh-kernel solid from the verified triangles already shown
 * in the viewport. OCCT repeats vertices along face/material boundaries, so
 * weld coincident positions before handing the mesh to Manifold. */
function meshShapeFromDisplayed(mesh: KernelMesh): MeshShape {
  const manifold = getManifold();
  const sourceVertices = mesh.faces.vertices;
  const sourceTriangles = mesh.faces.triangles;
  const vertices: number[] = [];
  const triangles: number[] = [];
  const byPosition = new Map<string, number>();

  const canonical = (sourceId: number) => {
    const offset = sourceId * 3;
    const x = Number(sourceVertices[offset]);
    const y = Number(sourceVertices[offset + 1]);
    const z = Number(sourceVertices[offset + 2]);
    const key = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
    let id = byPosition.get(key);
    if (id === undefined) {
      id = vertices.length / 3;
      byPosition.set(key, id);
      vertices.push(x, y, z);
    }
    return id;
  };

  for (let i = 0; i + 2 < sourceTriangles.length; i += 3) {
    triangles.push(
      canonical(Number(sourceTriangles[i])),
      canonical(Number(sourceTriangles[i + 1])),
      canonical(Number(sourceTriangles[i + 2])),
    );
  }
  return new MeshShape(new manifold.Manifold(new manifold.Mesh({
    numProp: 3,
    vertProperties: Float32Array.from(vertices),
    triVerts: Uint32Array.from(triangles),
  })));
}

function boundsAgree(a: NumericBounds, b: NumericBounds): boolean {
  return [0, 1, 2].every(
    (axis) => Math.abs(a.min[axis] - b.min[axis]) < 0.05 && Math.abs(a.max[axis] - b.max[axis]) < 0.05,
  );
}

/** Bounds of the exact child meshes currently shown before Group is clicked. */
function displayedChildrenBounds(spec: NodeSpec): NumericBounds | null {
  if (spec.type !== "group" || spec.op !== "union" || spec.children.some((child) => child.isHole)) return null;
  const combined: NumericBounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const child of spec.children) {
    const cached = meshCache.get(child.id);
    if (!cached || cached.key !== localKey(child)) return null;
    const raw = meshBounds(cached.mesh);
    if (!raw) return null;
    const center = [0, 1, 2].map((axis) => (raw.min[axis] + raw.max[axis]) / 2);
    const [sx, sy, sz] = child.scale;
    const [rx, ry, rz] = child.rotation.map((degrees) => degrees * Math.PI / 180);
    const sinX = Math.sin(rx), cosX = Math.cos(rx);
    const sinY = Math.sin(ry), cosY = Math.cos(ry);
    const sinZ = Math.sin(rz), cosZ = Math.cos(rz);
    for (const x of [raw.min[0], raw.max[0]]) for (const y of [raw.min[1], raw.max[1]]) for (const z of [raw.min[2], raw.max[2]]) {
      let px = center[0] + (x - center[0]) * sx;
      let py = center[1] + (y - center[1]) * sy;
      let pz = center[2] + (z - center[2]) * sz;
      [py, pz] = [py * cosX - pz * sinX, py * sinX + pz * cosX];
      [px, pz] = [px * cosY + pz * sinY, -px * sinY + pz * cosY];
      [px, py] = [px * cosZ - py * sinZ, px * sinZ + py * cosZ];
      const point = [px + child.position[0], py + child.position[1], pz + child.position[2]];
      for (let axis = 0; axis < 3; axis++) {
        combined.min[axis] = Math.min(combined.min[axis], point[axis]);
        combined.max[axis] = Math.max(combined.max[axis], point[axis]);
      }
    }
  }
  return combined.min.every(Number.isFinite) ? combined : null;
}

/** The fully placed/booleaned root solid from the latest matching scene or
 * merged-result build. Export can tessellate this directly instead of
 * replaying an expensive combined object's entire edit history again. */
let resultSolidCache: {
  key: string;
  solid: AnySolid;
  /** Set only when `solid` is a MeshShape, whose triangles are already frozen
   *  at this preset — re-tessellating it is not possible, so an export at any
   *  OTHER quality has to rebuild rather than reuse it. A Shape3D carries no
   *  such limit (it re-meshes at whatever an export asks for), so it is null. */
  meshQuality?: ExportQuality | null;
} | null = null;

/** Whether the cached solid can serve an export at this quality. */
function cacheServes(key: string, quality: ExportQuality): boolean {
  if (!resultSolidCache || resultSolidCache.key !== key) return false;
  const baked = resultSolidCache.meshQuality;
  return !baked || baked === quality;
}

function resultKey(specs: NodeSpec[]): string {
  return JSON.stringify(specs.map((s) => [localKey(s), s.position, s.rotation, s.scale, s.isHole]));
}

/** Collects per-node failures so one bad node cannot blank the whole scene. */
function collector() {
  const errors: BuildError[] = [];
  return {
    errors,
    onError: (id: string, msg: string) => errors.push({ id, message: msg }),
  };
}

const api = {
  /** Pre-boots OCCT + Manifold WASM so subsequent calls don't pay the cold-
   *  start cost. Called immediately on the heavy worker from the client so
   *  the 22MB WASM download happens in the background, not when the user
   *  first clicks "Preview merged result". */
  async warmup(): Promise<void> {
    await init();
  },

  /**
   * Meshes each TOP-LEVEL node — the editing view. A group meshes as its
   * evaluated boolean, so grouping shows you the combined shape the way
   * TinkerCAD does. Placement is applied on the main thread, so moving a node
   * costs nothing here.
   */
  async buildScene(specs: NodeSpec[], onProgress?: (id: string) => void): Promise<SceneBuild> {
    await init();
    const t0 = performance.now();
    const { errors, onError } = collector();
    const seen = new Set<string>();

    const parts: ScenePart[] = [];
    /** Per-node wall time, reported (below) whenever a build runs long. A
     *  build that overruns WATCHDOG_MS costs the whole mesh cache — every
     *  later edit then rebuilds from cold and overruns again — so knowing
     *  WHICH node is expensive is the difference between fixing it and
     *  guessing. */
    const spent = new Map<string, number>();
    for (const spec of specs) {
      const specStartedAt = performance.now();
      seen.add(spec.id);
      const key = localKey(spec);
      const cached = meshCache.get(spec.id);

      /** A geometry edit is never allowed to turn a visible object into empty
       * space. Prefer the last verified mesh in this worker; after a refresh,
       * rebuild progressively shorter edit history until the newest sound
       * prefix is found. */
      const keepLastGood = async (): Promise<boolean> => {
        if (cached) {
          parts.push({ id: spec.id, isHole: spec.isHole, mesh: cached.mesh, faces: cached.faces });
          return true;
        }
        if (spec.type !== "edit") return false;
        for (let count = spec.ops.length - 1; count >= 0; count--) {
          try {
            const fallbackSpec = { ...spec, ops: spec.ops.slice(0, count) };
            const fallbackSolid = await makeLocal(fallbackSpec, undefined, onProgress);
            if (!fallbackSolid) continue;
            const fallbackMesh = toMesh(spec.id, fallbackSolid, EDIT_QUALITY);
            if (!meshMatchesSolidBounds(fallbackMesh, fallbackSolid)) continue;
            const faces = faceInfoOf(fallbackMesh);
            // This mesh represents a SHORTER edit prefix, not the full `key`
            // requested above. Labelling it with the full key makes the next
            // scene build accept the fallback as if the failed newest edit
            // had succeeded, so the warning disappears while the geometry
            // silently remains one edit behind. Keep its truthful key: the
            // next build will retry the complete history instead of poisoning
            // the cache with a visually plausible but stale result.
            meshCache.set(spec.id, {
              key: localKey(fallbackSpec),
              mesh: fallbackMesh,
              faces,
              solid: fallbackSolid,
            });
            parts.push({ id: spec.id, isHole: spec.isHole, mesh: fallbackMesh, faces });
            return true;
          } catch {
            // Try the next shorter, previously valid edit prefix.
          }
        }
        return false;
      };

      if (cached && cached.key === key) {
        // Refresh insertion order so repeatedly grouped/ungrouped children
        // remain recent and survive the bounded dormant-entry cache below.
        meshCache.delete(spec.id);
        meshCache.set(spec.id, cached);
        parts.push({ id: spec.id, isHole: spec.isHole, mesh: cached.mesh, faces: cached.faces });
        continue;
      }

      // A freshly created Group gets a new document id even when its contents
      // are byte-for-byte identical to the Group made one cycle ago. Reuse the
      // first verified local geometry by structural key instead of running the
      // same unstable boolean again. Placement remains document-side, so this
      // is valid for the same shape at any top-level position.
      const sameGeometry = geometryCache.get(key);
      if (sameGeometry) {
        geometryCache.delete(key);
        geometryCache.set(key, sameGeometry);
        const mesh: KernelMesh = {
          name: spec.id,
          faces: {
            ...sameGeometry.mesh.faces,
            vertices: sameGeometry.mesh.faces.vertices instanceof Float32Array
              ? sameGeometry.mesh.faces.vertices.slice()
              : Array.isArray(sameGeometry.mesh.faces.vertices)
              ? [...sameGeometry.mesh.faces.vertices]
              : sameGeometry.mesh.faces.vertices,
            triangles: sameGeometry.mesh.faces.triangles instanceof Uint32Array
              ? sameGeometry.mesh.faces.triangles.slice()
              : Array.isArray(sameGeometry.mesh.faces.triangles)
              ? [...sameGeometry.mesh.faces.triangles]
              : sameGeometry.mesh.faces.triangles,
            normals: sameGeometry.mesh.faces.normals instanceof Float32Array
              ? sameGeometry.mesh.faces.normals.slice()
              : Array.isArray(sameGeometry.mesh.faces.normals)
              ? [...sameGeometry.mesh.faces.normals]
              : sameGeometry.mesh.faces.normals,
            faceGroups: sameGeometry.mesh.faces.faceGroups.map((g) => ({ ...g })),
          },
          edges: {
            ...sameGeometry.mesh.edges,
            lines: sameGeometry.mesh.edges.lines instanceof Float32Array
              ? sameGeometry.mesh.edges.lines.slice()
              : Array.isArray(sameGeometry.mesh.edges.lines)
              ? [...sameGeometry.mesh.edges.lines]
              : sameGeometry.mesh.edges.lines,
            edgeGroups: sameGeometry.mesh.edges.edgeGroups.map((g) => ({ ...g })),
          },
        };
        const entry = { key, mesh, faces: sameGeometry.faces, solid: sameGeometry.solid.clone() };
        meshCache.set(spec.id, entry);
        parts.push({ id: spec.id, isHole: spec.isHole, mesh, faces: sameGeometry.faces });
        continue;
      }

      try {
        // A standalone import needs no repair or boolean work in the editing
        // view. Parse its triangles directly, like a slicer does. Imported
        // children inside a group still go through makeLocal because the
        // group's displayed shape is the evaluated boolean result.
        // Vector artwork has no triangles to parse — it is built, not loaded —
        // so only a mesh import takes the shortcut.
        if (spec.type === "import" && !spec.svg) {
          onProgress?.(spec.id);
          const mesh = await loadSTLPreview(spec.id, spec.blobId);
          meshCache.set(spec.id, { key, mesh });
          parts.push({ id: spec.id, isHole: spec.isHole, mesh });
        } else {
          const expectedDisplayedBounds = displayedChildrenBounds(spec);
          let solid: AnySolid | null = null;
          let mesh: KernelMesh | null = null;
          // Retrying pays off only because these failures are INTERMITTENT:
          // OCCT can give a different answer for the same input, so a second
          // go usually lands. Eight full rebuilds of an expensive node,
          // though, is minutes of a frozen scene — long enough for the
          // 3-minute watchdog to kill the worker and take the whole mesh
          // cache with it, which leaves every following edit just as slow.
          // Keep the retries, but spend a time budget rather than a fixed
          // count, and always allow a real second attempt.
          for (let attempt = 0; attempt < 8; attempt++) {
            try {
              solid = await makeLocal(spec, onError, onProgress);
            } catch {
              // OCCT reports some failed loft/fillet attempts as an opaque
              // WebAssembly.Exception. Treat that exactly like an invalid
              // candidate: retry briefly, then retain the last good mesh and
              // surface the normal recoverable geometry message below.
              solid = null;
            }
            if (solid) {
              const baseSpec = getBaseObjectSpec(spec);
              const meshQuality = baseSpec &&
                (baseSpec.kind === "hemisphere" || baseSpec.kind === "capsule" || baseSpec.kind === "sphere")
                ? {
                    ...EDIT_QUALITY,
                    angularTolerance: Math.PI /
                      Math.max(4, Math.min(64, Math.round(
                        baseSpec.params.surfaceSteps ?? (baseSpec.kind === "hemisphere" ? 24 : 48),
                      ))),
                  }
                : EDIT_QUALITY;
              let candidate = toMesh(spec.id, solid, meshQuality);
              if (baseSpec?.kind === "ellipsoid") {
                candidate = withEllipsoidNormals(candidate);
              }
              if (
                baseSpec && (baseSpec.kind === "cylinder" || baseSpec.kind === "cone" || baseSpec.kind === "pyramid") &&
                (baseSpec.params.sideEdges ?? 0) === 0
              ) {
                candidate = withoutExtrusionSideEdges(candidate);
              }
              if (
                baseSpec && baseSpec.kind === "triangle" &&
                (baseSpec.params.cornerEdges ?? 0) === 0 &&
                ((baseSpec.params.leftFillet ?? baseSpec.params.fillet ?? 0) > 0 ||
                  (baseSpec.params.rightFillet ?? baseSpec.params.fillet ?? 0) > 0 ||
                  (baseSpec.params.apexFillet ?? baseSpec.params.fillet ?? 0) > 0)
              ) {
                candidate = withoutExtrusionSideEdges(candidate);
              }
              if (
                baseSpec && baseSpec.kind === "wedge" &&
                (baseSpec.params.cornerEdges ?? 0) === 0 &&
                ((baseSpec.params.topFillet ?? baseSpec.params.fillet ?? 0) > 0 ||
                  (baseSpec.params.bottomFillet ?? baseSpec.params.fillet ?? 0) > 0)
              ) {
                candidate = withoutExtrusionSideEdges(candidate, 0);
              }
              if (
                baseSpec && baseSpec.kind === "polygonPrism" &&
                (baseSpec.params.cornerEdges ?? 0) === 0 &&
                ((baseSpec.params.fillet ?? 0) > 0 ||
                  (baseSpec.params.topFillet ?? 0) > 0 ||
                  (baseSpec.params.bottomFillet ?? 0) > 0)
              ) {
                candidate = withoutExtrusionSideEdges(candidate);
              }
              if (
                baseSpec && baseSpec.kind === "star" &&
                (baseSpec.params.style ?? 0) === 0 &&
                (baseSpec.params.cornerEdges ?? 0) === 0 &&
                ((baseSpec.params.outerFillet ?? baseSpec.params.fillet ?? 0) > 0 ||
                  (baseSpec.params.innerFillet ?? baseSpec.params.fillet ?? 0) > 0 ||
                  (baseSpec.params.topFillet ?? 0) > 0 ||
                  (baseSpec.params.bottomFillet ?? 0) > 0)
              ) {
                candidate = withoutExtrusionSideEdges(candidate);
              }
              if (
                baseSpec && baseSpec.kind === "threadedNut" &&
                (baseSpec.params.cornerEdges ?? 0) === 1
              ) {
                candidate = withNutCornerLines(candidate, baseSpec.params);
              }
              if (
                baseSpec && baseSpec.kind === "threadedRod" &&
                Math.round(baseSpec.params.headType ?? 0) >= 1
              ) {
                candidate = (baseSpec.params.cornerEdges ?? 0) === 1
                  ? withThreadedHeadCornerLines(candidate, baseSpec.params)
                  : { ...candidate, edges: { lines: new Float32Array(0), edgeGroups: [] } };
              }
              if (
                baseSpec && baseSpec.kind === "paraboloid" &&
                (baseSpec.params.surfaceEdges ?? 0) === 0
              ) {
                candidate = withoutExtrusionSideEdges(candidate);
              }
              if (
                baseSpec && baseSpec.kind === "tube" &&
                (baseSpec.params.cornerEdges ?? 0) === 0 &&
                ((baseSpec.params.outerTopFillet ?? baseSpec.params.bevel ?? 0) > 0 ||
                  (baseSpec.params.outerBottomFillet ?? baseSpec.params.bevel ?? 0) > 0 ||
                  (baseSpec.params.innerTopFillet ?? baseSpec.params.bevel ?? 0) > 0 ||
                  (baseSpec.params.innerBottomFillet ?? baseSpec.params.bevel ?? 0) > 0)
              ) {
                candidate = withoutExtrusionSideEdges(candidate);
              }
              if (
                baseSpec && baseSpec.kind === "hemisphere" &&
                (baseSpec.params.surfaceEdges ?? 0) === 0
              ) {
                candidate = { ...candidate, edges: { lines: new Float32Array(0), edgeGroups: [] } };
              } else if (
                baseSpec && baseSpec.kind === "hemisphere" &&
                (baseSpec.params.surfaceEdges ?? 0) === 1
              ) {
                candidate = withSurfaceContourLines(candidate, baseSpec.params.surfaceSteps ?? 24);
              }
              if (
                baseSpec && baseSpec.kind === "ellipsoid" &&
                (baseSpec.params.surfaceEdges ?? 0) === 0
              ) {
                candidate = { ...candidate, edges: { lines: new Float32Array(0), edgeGroups: [] } };
              } else if (
                baseSpec && baseSpec.kind === "ellipsoid" &&
                (baseSpec.params.surfaceEdges ?? 0) === 1
              ) {
                candidate = withSurfaceContourLines(candidate, baseSpec.params.surfaceSteps ?? 48);
              }
              if (
                baseSpec && baseSpec.kind === "capsule" &&
                (baseSpec.params.surfaceEdges ?? 0) === 0
              ) {
                candidate = { ...candidate, edges: { lines: new Float32Array(0), edgeGroups: [] } };
              } else if (
                baseSpec && baseSpec.kind === "capsule" &&
                (baseSpec.params.surfaceEdges ?? 0) === 1
              ) {
                candidate = withSurfaceContourLines(candidate, baseSpec.params.surfaceSteps ?? 48);
              }
              if (
                baseSpec && baseSpec.kind === "torus" &&
                (baseSpec.params.surfaceEdges ?? 0) === 0
              ) {
                candidate = { ...candidate, edges: { lines: new Float32Array(0), edgeGroups: [] } };
              } else if (
                baseSpec && baseSpec.kind === "torus" &&
                (baseSpec.params.surfaceEdges ?? 0) === 1
              ) {
                candidate = withTorusSurfaceLines(candidate, baseSpec.params);
              }
              if (
                baseSpec && baseSpec.kind === "sphere" &&
                (baseSpec.params.surfaceEdges ?? 0) === 0
              ) {
                candidate = { ...candidate, edges: { lines: new Float32Array(0), edgeGroups: [] } };
              } else if (
                baseSpec && baseSpec.kind === "sphere" &&
                (baseSpec.params.surfaceEdges ?? 0) === 1
              ) {
                candidate = withSphereSurfaceLines(candidate, baseSpec.params);
              }
              const candidateBounds = meshBounds(candidate);
              if (
                candidateBounds &&
                meshMatchesSolidBounds(candidate, solid) &&
                (!expectedDisplayedBounds || boundsAgree(candidateBounds, expectedDisplayedBounds))
              ) {
                mesh = candidate;
                break;
              }
            }
            if (attempt >= 1 && performance.now() - specStartedAt > RETRY_BUDGET_MS) break;
          }
          if (solid && mesh) {
            const faces = faceInfoOf(mesh);
            meshCache.set(spec.id, { key, mesh, faces, solid });
            geometryCache.set(key, { mesh, faces, solid: solid.clone() });
            if (geometryCache.size > MAX_GEOMETRY_CACHE_ENTRIES) {
              const oldest = geometryCache.keys().next().value;
              if (oldest !== undefined) geometryCache.delete(oldest);
            }
            parts.push({ id: spec.id, isHole: spec.isHole, mesh, faces });
          } else {
            await keepLastGood();
            onError(
              spec.id,
              `${RETRYABLE_MESH_ERROR} The last valid version is still shown — undo and retry the latest geometry edit.`,
            );
          }
        }
      } catch (e) {
        await keepLastGood();
        onError(spec.id, message(e));
      }
      // Only reached by nodes that actually rebuilt; a cache hit `continue`s
      // above and costs nothing worth reporting.
      spent.set(spec.id, performance.now() - specStartedAt);
    }

    // A slow build is the one failure here that snowballs, so name the nodes
    // that ate the time instead of leaving a silent multi-second freeze.
    const totalMs = performance.now() - t0;
    if (totalMs > SLOW_BUILD_MS) {
      const worst = [...spent.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([id, ms]) => `${id} ${Math.round(ms)}ms`);
      console.warn(`[kernel] scene build took ${Math.round(totalMs)}ms — slowest: ${worst.join(", ")}`);
    }

    // Do not immediately discard a node merely because Group temporarily
    // moved it below a new root. Ungroup needs the exact known-good mesh that
    // was visible beforehand; rebuilding a nested boolean from scratch on
    // every cycle is what eventually produced a displaced child. Keep dormant
    // entries, but cap them so genuinely deleted objects cannot leak memory
    // throughout a long session. Live roots are never chosen for eviction.
    if (meshCache.size > MAX_MESH_CACHE_ENTRIES) {
      for (const id of meshCache.keys()) {
        if (meshCache.size <= MAX_MESH_CACHE_ENTRIES) break;
        if (!seen.has(id)) meshCache.delete(id);
      }
    }

    // The common editing case is one top-level object (including one complex
    // combined/edited group). Its local solid was just evaluated above, so
    // retain the correctly placed result for a near-instant subsequent STL
    // export instead of evaluating the same history a second time.
    if (specs.length === 1 && !specs[0].isHole) {
      const cached = meshCache.get(specs[0].id);
      resultSolidCache = cached?.solid && cached.key === localKey(specs[0])
        ? { key: resultKey(specs), solid: place(cached.solid, specs[0]), meshQuality: null }
        : null;
    } else if (resultSolidCache?.key !== resultKey(specs)) {
      resultSolidCache = null;
    }

    return { parts, errors, buildMs: performance.now() - t0 };
  },

  /** Applies every boolean in the tree and meshes the single resulting solid.
   *
   * The top-level union deliberately runs through Manifold (meshShape path)
   * rather than OCCT's fuse(). OCCT fuse() is synchronous WASM — on 4+ objects
   * it can take minutes or hang the worker thread entirely with no way to cancel
   * it. Manifold handles the same union in milliseconds and is robust to
   * disjoint/non-intersecting shapes. Each individual spec's internal booleans
   * (holes cut into a group, push-pull edits, etc.) still evaluate through OCCT
   * exactly as in the editing view — only the outermost union uses Manifold.
   */
  async buildResult(specs: NodeSpec[], onProgress?: (id: string) => void): Promise<ResultBuild> {
    await init();
    const t0 = performance.now();
    const { errors, onError } = collector();

    try {
      // Evaluate each top-level spec in its own world frame (same as buildScene),
      // then convert all to MeshShape so the top-level union runs on Manifold.
      const kids: { solid: MeshShape; isHole: boolean }[] = [];
      for (const spec of specs) {
        const world = await makeWorld(spec, onError, onProgress);
        if (!world) continue;
        const mesh = isMesh(world) ? world : (world as Shape3D).meshShape();
        kids.push({ solid: mesh, isHole: spec.isHole });
      }

      if (!kids.length) return { mesh: null, volume: 0, faceCount: 0, errors, buildMs: 0 };

      // All children are MeshShape — combine() will route to Manifold.
      const solid = combine("union", kids);
      if (!solid) return { mesh: null, volume: 0, faceCount: 0, errors, buildMs: 0 };

      resultSolidCache = { key: resultKey(specs), solid, meshQuality: isMesh(solid) ? "standard" : null };

      return {
        mesh: toMesh("result", solid, EXPORT_QUALITY),
        volume: volumeOf(solid),
        faceCount: faceCountOf(solid),
        errors,
        buildMs: performance.now() - t0,
      };
    } catch (e) {
      console.error("[worker.buildResult] uncaught error:", e);
      return { mesh: null, volume: 0, faceCount: 0, errors: [...errors, { id: "__root", message: String(e) }], buildMs: 0 };
    }
  },

  /**
   * Bounding-box centre of each spec, keyed by its id.
   *
   * Regrouping needs these. The kernel scales a shape about the centre of its
   * own bounds, so moving a node between frames without knowing that centre
   * lands it in the wrong place — and only the kernel knows it. The viewport
   * can measure a top-level part, but not a child inside a group, and a part
   * that has not finished rebuilding cannot be measured at all: asking it
   * mid-rebuild is how a regroup could throw a part clean across the model.
   */
  async centresOf(specs: NodeSpec[]): Promise<Record<string, Vec3>> {
    await init();
    const { onError } = collector();
    const centres: Record<string, Vec3> = {};
    for (const spec of specs) {
      try {
        const solid = await makeWorld(spec, onError);
        if (!solid) continue;
        const [min, max] = getSolidBounds(solid);
        const centre: Vec3 = [
          (min[0] + max[0]) / 2,
          (min[1] + max[1]) / 2,
          (min[2] + max[2]) / 2,
        ];
        // An empty or degenerate solid reports an infinite box, and half of
        // infinity is not a centre. Offering it anyway put NaN into every
        // position the caller then computed, which wiped the model.
        if (centre.every(Number.isFinite)) centres[spec.id] = centre;
      } catch {
        // A spec that will not build has no centre to offer; the caller keeps
        // the frame instead of guessing one.
      }
    }
    return centres;
  },

  /**
   * Shape Builder: cuts the given top-level shapes into the regions their
   * boundaries divide space into, and meshes each one so the viewport can
   * show and hit-test them. Empty regions — masks describing an overlap that
   * does not actually happen — never come back, so what the user sees is only
   * what is really there.
   */
  async buildCells(specs: NodeSpec[]): Promise<CellPart[]> {
    await init();
    const { onError } = collector();
    const solids: AnySolid[] = [];
    for (const spec of specs) {
      const solid = await makeWorld(spec, onError);
      if (solid) solids.push(solid);
    }
    if (solids.length < 2) return [];
    return decompose(solids).map(({ mask, solid }) => ({
      mask,
      mesh: toMesh(`cell-${mask}`, solid, EDIT_QUALITY),
    }));
  },

  /** Fast export path used on the interactive worker: it never rebuilds. If
   * the current scene/result solid is cached, only STL tessellation remains;
   * otherwise the client falls back to the isolated heavy worker. */
  async exportCachedSTL(specs: NodeSpec[], quality: ExportQuality): Promise<Blob | null> {
    await init();
    const key = resultKey(specs);
    return cacheServes(key, quality)
      ? blobSTLOf(resultSolidCache!.solid, EXPORT_PRESETS[quality])
      : null;
  },

  /** Fast 3MF path used on the interactive worker: if all objects are cached,
   * extracts their meshes directly without rebuilding from scratch. */
  async exportCachedMeshes(
    specs: NodeSpec[],
    quality: ExportQuality,
  ): Promise<{ id: string; vertices: number[]; triangles: number[] }[] | null> {
    await init();
    const holes = specs.filter((s) => s.isHole);
    const solids = specs.filter((s) => !s.isHole);
    const result: { id: string; vertices: number[]; triangles: number[] }[] = [];

    for (const spec of solids) {
      const cached = meshCache.get(spec.id);
      if (!cached || !cached.solid) return null;
      let solid: AnySolid = place(cached.solid, spec);
      if (holes.length > 0) {
        for (const hole of holes) {
          const holeCached = meshCache.get(hole.id);
          if (!holeCached || !holeCached.solid) return null;
          const holeSolid = place(holeCached.solid, hole);
          if (solidBoundsOverlap(solid, holeSolid)) {
            const cutter = isMesh(holeSolid)
              ? holeSolid
              : (holeSolid as Shape3D).meshShape(EXPORT_PRESETS[quality]);
            const target = isMesh(solid)
              ? solid
              : (solid as Shape3D).meshShape(EXPORT_PRESETS[quality]);
            try {
              solid = (target as MeshShape).cut((cutter as MeshShape).clone());
            } catch {}
          }
        }
      }
      const mesh = isMesh(solid) ? solid.mesh() : (solid as Shape3D).mesh(EXPORT_PRESETS[quality]);
      result.push({
        id: spec.id,
        vertices: Array.from(mesh.vertices),
        triangles: Array.from(mesh.triangles),
      });
    }
    return result;
  },

  /** Fallback for 3MF timeout: converts displayed scene items into per-object
   * meshes with holes drilled. */
  async exportDisplayedMeshes(
    items: DisplayedSceneItem[],
  ): Promise<{ id: string; vertices: number[]; triangles: number[] }[]> {
    await init();
    const solids = items.filter(({ spec }) => !spec.isHole);
    const holes = items.filter(({ spec }) => spec.isHole);
    const out: { id: string; vertices: number[]; triangles: number[] }[] = [];

    for (const { spec, mesh } of solids) {
      let solid: AnySolid = place(meshShapeFromDisplayed(mesh), spec);
      for (const hole of holes) {
        const holeSolid = place(meshShapeFromDisplayed(hole.mesh), hole.spec);
        if (solidBoundsOverlap(solid, holeSolid)) {
          const cut = combine("subtract", [
            { solid, isHole: false },
            { solid: holeSolid, isHole: false },
          ]);
          if (cut) solid = cut;
        }
      }
      const raw = isMesh(solid) ? solid.mesh() : (solid as Shape3D).mesh(EXPORT_PRESETS.standard);
      out.push({
        id: spec.id,
        vertices: Array.from(raw.vertices),
        triangles: Array.from(raw.triangles),
      });
    }
    return out;
  },

  /** Complete-scene timeout fallback for the subset touched by top-level
   * Holes. Each solid is drilled independently; unioning every scene root
   * made a distant 887k-triangle scan participate in an unrelated Hole and
   * could spend another three minutes after the first timeout. */
  async exportDisplayedSTL(items: DisplayedSceneItem[]): Promise<Blob | null> {
    await init();
    if (!items.length) return null;
    const solids = items
      .filter(({ spec }) => !spec.isHole)
      .map(({ spec, mesh }) => place(meshShapeFromDisplayed(mesh), spec));
    const holes = items
      .filter(({ spec }) => spec.isHole)
      .map(({ spec, mesh }) => place(meshShapeFromDisplayed(mesh), spec));
    if (!solids.length) return null;
    const drilled = solids.map((shell) => {
      let out: AnySolid = shell;
      for (const hole of holes) {
        if (!solidBoundsOverlap(out, hole)) continue;
        const cut = combine("subtract", [
          { solid: out, isHole: false },
          { solid: hole, isHole: false },
        ]);
        if (cut) out = cut;
      }
      return out;
    });
    if (drilled.some((solid) => isEmptySolid(solid) || tessellatesEmpty(solid))) {
      throw new Error("A visible solid became empty while applying its Hole subtraction.");
    }
    return blobSTLOfMany(drilled, EDIT_QUALITY);
  },

  /** Rebuilds primitive-only roots (including groups whose internal Holes
   * create curved Boolean faces) for the timeout fallback. These remain cheap
   * and keep Standard/Fine distinct even when one unrelated imported or
   * edited scene object forced the global merge onto displayed meshes. */
  async exportRefinedSTL(specs: NodeSpec[], quality: ExportQuality): Promise<Blob | null> {
    await init();
    const evaluated: { solid: AnySolid; isHole: boolean }[] = [];
    for (const spec of specs) {
      const world = await makeWorld(spec);
      if (world) evaluated.push({ solid: world, isHole: spec.isHole });
    }
    const holes = evaluated.filter((item) => item.isHole).map((item) => item.solid);
    const solids = evaluated.filter((item) => !item.isHole).map((item) => item.solid);
    const drilled = solids.map((shell) => {
      let out = shell;
      for (const hole of holes) {
        if (!solidBoundsOverlap(out, hole)) continue;
        const cut = combine("subtract", [
          { solid: out, isHole: false },
          { solid: hole, isHole: false },
        ]);
        if (cut) out = cut;
      }
      return out;
    });
    return drilled.length ? blobSTLOfMany(drilled, EXPORT_PRESETS[quality]) : null;
  },

  /** Exports the fully booleaned result as a binary STL, ready for the slicer.
   * Uses the same Manifold-first top-level union as buildResult for robustness. */
  /**
   * One evaluated mesh per top-level SOLID, holes already cut out of them, at
   * export quality.
   *
   * Deliberately not the single unioned body exportSTL produces: 3MF can hold
   * several objects, each with its own name and colour, and losing that on the
   * way out would throw away the main reason to prefer the format. Holes are
   * still resolved here — a hole is not an object, it is an absence — so what
   * comes back is what should be printed.
   *
   * Same evaluation and the same refusal to lose a shape quietly as exportSTL:
   * a shape that will not build is retried once, and if it still will not, the
   * export FAILS rather than writing a file with a piece missing.
   */
  async exportMeshes(
    specs: NodeSpec[],
    quality: ExportQuality,
    onProgress?: (id: string) => void,
  ): Promise<{ id: string; vertices: number[]; triangles: number[] }[]> {
    await init();

    // An imported mesh is ALREADY triangles, and 3MF wants triangles. Sending
    // it through makeWorld would repair it into a manifold solid and mesh it
    // again — minutes of work on a 5.8MB scan, for a file that ends up holding
    // the same triangles it started with, and the reason a scan reported
    // "very complex and was skipped after taking too long" on export. Read
    // them straight out and apply the placement arithmetic instead.
    //
    // Only when nothing has to be cut out of it: a hole needs a real boolean,
    // and that needs the solid.
    const anyHoles = specs.some((spec) => spec.isHole);
    const straightThrough = async (spec: NodeSpec) => {
      if (anyHoles || spec.type !== "import" || spec.svg) return null;
      const mesh = await loadSTLPreview(spec.id, spec.blobId);
      const source = mesh.faces.vertices;
      const vertices: number[] = new Array(source.length);
      // Mirrors place(): scale about the mesh's own bounding-box centre, then
      // rotate Z, then Y, then X, each about the ORIGIN, then translate. That
      // order (not the X/Y/Z listing order the angles come in) is what
      // composes to the same Rx·Ry·Rz the viewport's THREE.Euler('XYZ')
      // produces — see place()'s own doc comment for the reasoning and the
      // reported bug this duplicated arithmetic shared with it.
      let min = [Infinity, Infinity, Infinity];
      let max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i + 2 < source.length; i += 3) {
        for (let axis = 0; axis < 3; axis++) {
          const value = source[i + axis];
          if (value < min[axis]) min[axis] = value;
          if (value > max[axis]) max[axis] = value;
        }
      }
      const centre = [0, 1, 2].map((axis) => (min[axis] + max[axis]) / 2);
      const [rx, ry, rz] = spec.rotation.map((degrees) => (degrees * Math.PI) / 180);
      const cx = Math.cos(rx), sx = Math.sin(rx);
      const cy = Math.cos(ry), sy = Math.sin(ry);
      const cz = Math.cos(rz), sz = Math.sin(rz);
      for (let i = 0; i + 2 < source.length; i += 3) {
        let x = centre[0] + (source[i] - centre[0]) * spec.scale[0];
        let y = centre[1] + (source[i + 1] - centre[1]) * spec.scale[1];
        let z = centre[2] + (source[i + 2] - centre[2]) * spec.scale[2];
        [x, y] = [x * cz - y * sz, x * sz + y * cz];
        [x, z] = [x * cy + z * sy, -x * sy + z * cy];
        [y, z] = [y * cx - z * sx, y * sx + z * cx];
        vertices[i] = x + spec.position[0];
        vertices[i + 1] = y + spec.position[1];
        vertices[i + 2] = z + spec.position[2];
      }
      return {
        id: spec.id,
        vertices,
        triangles: Array.from(mesh.faces.triangles),
      };
    };
    const { errors, onError } = collector();
    const evaluated: { id: string; solid: AnySolid; isHole: boolean }[] = [];
    const readyMeshes: { id: string; vertices: number[]; triangles: number[] }[] = [];
    const missing: string[] = [];
    for (const spec of specs) {
      const direct = await straightThrough(spec);
      if (direct) {
        readyMeshes.push(direct);
        continue;
      }
      let world = await makeWorld(spec, onError, onProgress);
      if (!world) world = await makeWorld(spec, onError, onProgress);
      if (!world) {
        missing.push(spec.id);
        continue;
      }
      evaluated.push({ id: spec.id, solid: world, isHole: spec.isHole });
    }
    if (missing.length) {
      const why = errors.map((e) => e.message).find(Boolean);
      throw new Error(
        `${missing.length} shape${missing.length > 1 ? "s" : ""} could not be built, so the ` +
          `export was stopped rather than saving a part with ${missing.length > 1 ? "them" : "it"} ` +
          `missing.${why ? ` (${why})` : ""}`,
      );
    }

    const holes = evaluated.filter((item) => item.isHole);
    const out: { id: string; vertices: number[]; triangles: number[] }[] = [];
    for (const ready of readyMeshes) out.push(ready);
    for (const item of evaluated) {
      if (item.isHole) continue;
      let solid: AnySolid = item.solid;
      if (holes.length > 0) {
        for (const hole of holes) {
          const a = boundsOf(solid);
          const b = boundsOf(hole.solid);
          if (!a || !b) continue;
          const apart = [0, 1, 2].some((i) => a.min[i] > b.max[i] || b.min[i] > a.max[i]);
          if (apart) continue;
          const cutter = isMesh(hole.solid)
            ? hole.solid
            : (hole.solid as Shape3D).meshShape(EXPORT_PRESETS[quality]);
          const target = isMesh(solid)
            ? solid
            : (solid as Shape3D).meshShape(EXPORT_PRESETS[quality]);
          try {
            solid = (target as MeshShape).cut((cutter as MeshShape).clone());
          } catch { /* leave the solid whole rather than losing it */ }
        }
      }
      const mesh = isMesh(solid) ? solid.mesh() : (solid as Shape3D).mesh(EXPORT_PRESETS[quality]);
      out.push({
        id: item.id,
        vertices: Array.from(mesh.vertices),
        triangles: Array.from(mesh.triangles),
      });
    }
    return out;
  },

  async exportSTL(
    specs: NodeSpec[],
    quality: ExportQuality,
    onProgress?: (id: string) => void,
  ): Promise<Blob | null> {
    await init();
    const key = resultKey(specs);
    // Re-use the cached solid from the most recent build if it can serve this
    // quality — a Shape3D always can; a MeshShape only at the preset it was
    // baked at (see resultSolidCache).
    if (cacheServes(key, quality)) {
      return blobSTLOf(resultSolidCache!.solid, EXPORT_PRESETS[quality]);
    }
    // Otherwise evaluate using the same Manifold-first path as buildResult.
    // Nothing may drop out of an export in silence. A shape that will not
    // build is retried once — the failures here are intermittent — and if it
    // still will not build the export FAILS rather than quietly writing a
    // file with a piece of the part missing. A wrong file that looks right is
    // the one outcome worth interrupting someone for.
    const { errors, onError } = collector();
    const evaluated: { solid: AnySolid; isHole: boolean }[] = [];
    const missing: string[] = [];
    for (const spec of specs) {
      let world = await makeWorld(spec, onError, onProgress);
      if (!world) world = await makeWorld(spec, onError, onProgress);
      if (!world) {
        missing.push(spec.id);
        continue;
      }
      evaluated.push({ solid: world, isHole: spec.isHole });
    }
    if (missing.length) {
      const why = errors.map((e) => e.message).find(Boolean);
      throw new Error(
        `${missing.length} shape${missing.length > 1 ? "s" : ""} could not be built, so the ` +
          `export was stopped rather than saving a part with ${missing.length > 1 ? "them" : "it"} ` +
          `missing.${why ? ` (${why})` : ""}`,
      );
    }
    if (!evaluated.length) return null;
    const evaluatedSolids = evaluated.filter((item) => !item.isHole).map((item) => item.solid);
    let solid: AnySolid | null;
    try {
      // EXPORT_QUALITY is not optional here. meshShape() with no argument
      // tessellates at OCCT's default tolerance (~0.001mm), which this file
      // already documents as the setting that turns a single sphere into six
      // figures of triangles. Measured on a reported model: the two objects
      // containing spheres came out at 22,322 and 35,824 triangles against
      // ~400 for the three without, and manifold then spent 16s booleaning
      // that — 81% of the whole export, for detail finer than any printer can
      // resolve and finer than the viewport ever asked for.
      const kids = evaluated.map(({ solid: world, isHole }) => ({
        solid: isMesh(world) ? world : (world as Shape3D).meshShape(EXPORT_PRESETS[quality]),
        isHole,
      }));
      solid = combine("union", kids);
    } catch (error) {
      if (/not manifold/i.test(message(error)) && evaluatedSolids.length) {
        return blobSTLOfMany(evaluatedSolids, EXPORT_PRESETS[quality]);
      }
      throw error;
    }
    // ...and an export missing a PIECE is the same failure wearing a
    // disguise: it opens, it looks like the part, and what comes off the
    // printer is wrong. If the union no longer reaches as far as the shapes
    // that went into it, something was dropped, and the shells are written
    // individually rather than saving the loss.
    if (solid && !unionKeptEverything(solid, evaluatedSolids)) solid = null;

    // An export that comes out empty is the worst outcome this app has: a
    // file that looks like a part, opens in a slicer, and contains nothing.
    // The union can produce one — manifold hands back an empty result rather
    // than throwing when an operand it dislikes reaches it — so the shells
    // are written individually rather than the emptiness being believed.
    // Holes are cut from each shell first, so the fallback still describes
    // the part that was modelled, not the part before its holes.
    if (!solid || isEmptySolid(solid) || tessellatesEmpty(solid)) {
      if (!evaluatedSolids.length) return null;
      const holes = evaluated.filter((item) => item.isHole).map((item) => item.solid);
      const drilled = evaluatedSolids.map((shell) => {
        let out = shell;
        for (const hole of holes) {
          const cut = combine("subtract", [
            { solid: out, isHole: false },
            { solid: hole, isHole: false },
          ]);
          if (cut) out = cut;
        }
        return out;
      });
      return blobSTLOfMany(drilled, EXPORT_PRESETS[quality]);
    }

    resultSolidCache = { key, solid, meshQuality: quality };
    // binary: true — smaller and faster to write/read than the ASCII default,
    // and every slicer (including Bambu Studio) reads it fine.
    return blobSTLOf(solid, EXPORT_PRESETS[quality]);
  },

  /**
   * Meshes ONE node's local shape on its own — no meshCache, no group
   * wrapping, no error collection beyond "null on failure" — for a live
   * push/pull drag's preview: the viewport calls this, throttled, with the
   * dragged distance appended as one more (tentative, not-yet-committed) op
   * on the spec, and swaps the result into that one part's Three.js geometry
   * directly. This is a REAL OCCT/manifold rebuild, same as any other edit —
   * there is no shortcut that keeps it both live AND exact — throttling
   * (client-side, see kernel/client.ts) is what keeps it from hammering the
   * worker every mouse-move; the coalesceLatest wrapper below caps how many
   * of those throttled calls can queue up if one runs long.
   */
  async previewLocal(spec: NodeSpec): Promise<PreviewBuild | null> {
    await init();
    try {
      let solid: AnySolid | null;
      if (spec.type === "edit" && spec.ops.length > 0 && !hasImport(spec.base) &&
          spec.ops[spec.ops.length - 1].kind !== "fillet" && spec.ops[spec.ops.length - 1].kind !== "chamfer") {
        const finalOp = spec.ops[spec.ops.length - 1];
        const key = JSON.stringify({ base: spec.base, ops: spec.ops.slice(0, -1) });
        if (pushPullPreviewCache?.key !== key) {
          const base = await makePushPullPreviewBase(spec);
          pushPullPreviewCache = base ? { key, solid: base } : null;
        }
        solid = pushPullPreviewCache ? applyPushPullPreview(pushPullPreviewCache.solid, finalOp as PushPullOp) : null;
      } else {
        solid = await makeLocal(spec);
      }
      if (!solid) return null;
      // Faces ride along too — not just for completeness: without this, the
      // push/pull arrow (positioned from a part's `faces`) stayed at its
      // pre-drag spot until the next REAL, committed rebuild eventually
      // updated it, a second or so later — the shape itself was already
      // right (see applyPreviewMesh in scene.ts), just the arrow marking it
      // wasn't, and then visibly snapped once that real rebuild landed.
      // Reported live as "the face I was moving jumps a little bit extra."
      const mesh = toMesh(spec.id, solid, EDIT_QUALITY);
      return { mesh, faces: faceInfoOf(mesh) };
    } catch {
      // A mid-drag distance can transiently describe something OCCT can't
      // build (e.g. pushing clean through the far side) — just skip this
      // frame's preview rather than surfacing an error for a value nobody
      // has committed to yet.
      return null;
    }
  },

  /**
   * Replays an edit node's ops and returns just the ones that could still
   * be found — for the "Remove broken edit" action: an op that fails here
   * can never succeed again (its target face is permanently gone), so
   * unlike an ordinary rebuild (which skips a dead op but leaves it in the
   * document to keep re-failing and re-reporting the same error forever),
   * this is what lets the app drop it for good. null for anything that
   * isn't an edit node — nothing to prune.
   */
  async pruneDeadOps(spec: NodeSpec): Promise<EditOp[] | null> {
    await init();
    if (spec.type !== "edit") return null;
    return survivingOps(spec);
  },
};

export type KernelAPI = typeof api;
Comlink.expose(api);

// Re-exported so a future caller can decide up front whether a build will
// need manifold-3d at all, without duplicating the recursive check.
export { hasImport };
