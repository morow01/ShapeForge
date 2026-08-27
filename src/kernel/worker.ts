// The CAD kernel runs here, off the main thread. OCCT operations are
// synchronous and can block for hundreds of ms; keeping them in a worker is
// what stops the UI freezing mid-drag.
import * as Comlink from "comlink";
import opencascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import ManifoldModule from "manifold-3d";
import manifoldWasmUrl from "manifold-3d/manifold.wasm?url";
import { setOC, setManifold, measureVolume, MeshShape } from "replicad";
import type { Shape3D } from "replicad";
import {
  applyPushPullPreview,
  combine,
  decompose,
  hasImport,
  isMesh,
  makeLocal,
  makeWorld,
  makePushPullPreviewBase,
  place,
  survivingOps,
} from "./shape";
import { SVG_IMPORT_REVISION } from "./svgSolid";
import { loadSTLPreview } from "./stlPreview";
import type { AnySolid } from "./shape";
import type {
  BuildError,
  CellPart,
  ExportQuality,
  FaceInfo,
  KernelMesh,
  MeshedEdges,
  MeshedFaces,
  NodeSpec,
  PreviewBuild,
  ScenePart,
  SceneBuild,
  ResultBuild,
} from "./types";
import type { PushPullOp, Vec3 } from "../document/types";

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
  const descriptions = Array.from({ length: triangleCount }, (_, triangle) => {
    const ia = raw.triangles[triangle * 3] * 3;
    const ib = raw.triangles[triangle * 3 + 1] * 3;
    const ic = raw.triangles[triangle * 3 + 2] * 3;
    const ab = [raw.vertices[ib] - raw.vertices[ia], raw.vertices[ib + 1] - raw.vertices[ia + 1], raw.vertices[ib + 2] - raw.vertices[ia + 2]];
    const ac = [raw.vertices[ic] - raw.vertices[ia], raw.vertices[ic + 1] - raw.vertices[ia + 1], raw.vertices[ic + 2] - raw.vertices[ia + 2]];
    const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const length = Math.hypot(...cross) || 1;
    const normal = cross.map((value) => value / length);
    return { normal, plane: normal[0] * raw.vertices[ia] + normal[1] * raw.vertices[ia + 1] + normal[2] * raw.vertices[ia + 2] };
  });
  const byEdge = new Map<string, number[]>();
  const positionKey = (vertex: number) => {
    const i = vertex * 3;
    // Manifold may duplicate a vertex for normals/material runs even though
    // it occupies the same geometric point. Quantising removes harmless
    // floating-point noise while keeping genuinely separate edges apart.
    return `${Math.round(raw.vertices[i] * 1e5)},${Math.round(raw.vertices[i + 1] * 1e5)},${Math.round(raw.vertices[i + 2] * 1e5)}`;
  };
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    for (let edge = 0; edge < 3; edge++) {
      const a = raw.triangles[triangle * 3 + edge];
      const b = raw.triangles[triangle * 3 + (edge + 1) % 3];
      const ka = positionKey(a);
      const kb = positionKey(b);
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const list = byEdge.get(key) ?? [];
      list.push(triangle);
      byEdge.set(key, list);
    }
  }
  const neighbours = Array.from({ length: triangleCount }, () => new Set<number>());
  for (const list of byEdge.values()) for (const a of list) for (const b of list) if (a !== b) neighbours[a].add(b);
  const seen = new Uint8Array(triangleCount);
  const ordered: number[] = [];
  const faceGroups: { start: number; count: number; faceId: number }[] = [];
  for (let seed = 0; seed < triangleCount; seed++) {
    if (seen[seed]) continue;
    const start = ordered.length;
    const queue = [seed];
    seen[seed] = 1;
    while (queue.length) {
      const triangle = queue.pop()!;
      ordered.push(raw.triangles[triangle * 3], raw.triangles[triangle * 3 + 1], raw.triangles[triangle * 3 + 2]);
      for (const next of neighbours[triangle]) {
        const a = descriptions[seed];
        const b = descriptions[next];
        if (!seen[next] && a.normal[0] * b.normal[0] + a.normal[1] * b.normal[1] + a.normal[2] * b.normal[2] > 0.9999 && Math.abs(a.plane - b.plane) < 1e-4) {
          seen[next] = 1;
          queue.push(next);
        }
      }
    }
    faceGroups.push({ start, count: ordered.length - start, faceId: faceGroups.length });
  }
  return {
    faces: {
      vertices: raw.vertices,
      triangles: Uint32Array.from(ordered),
      normals: raw.normals,
      faceGroups,
    },
    edges: { lines: [], edgeGroups: [] },
  };
}

function toMesh(name: string, s: AnySolid, quality: MeshQuality): KernelMesh {
  if (isMesh(s)) {
    const { faces, edges } = meshFromMeshShape(s);
    return { name, faces, edges };
  }
  return { name, faces: s.mesh(quality), edges: s.meshEdges(quality) };
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

    return {
      planar,
      pushPullable,
      point: interiorPoint,
      normal: [nx, ny, nz],
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
function localKey(spec: NodeSpec): string {
  if (spec.type === "group") {
    return JSON.stringify([
      spec.type,
      spec.op,
      spec.children.map((c) => [localKey(c), c.position, c.rotation, c.scale, c.isHole]),
    ]);
  }
  if (spec.type === "import") {
    return JSON.stringify([
      spec.type,
      spec.blobId,
      spec.svg ? [spec.svg.thickness, SVG_IMPORT_REVISION] : null,
    ]);
  }
  if (spec.type === "edit") return JSON.stringify([spec.type, localKey(spec.base), spec.ops]);
  if (spec.type === "build") {
    return JSON.stringify([
      spec.type,
      spec.sources.map((s) => [localKey(s), s.position, s.rotation, s.scale]),
      spec.keep,
    ]);
  }
  return JSON.stringify([spec.type, spec.kind, spec.params]);
}

/**
 * Per-node mesh cache, keyed by node id. Without this, dragging a slider on
 * one object rebuilds every OTHER object in the scene too — buildScene() has
 * no way to know only one node changed — so editing got slower the more
 * objects existed, even though only one of them was actually being touched.
 * A cache hit skips the OCCT call entirely, not just the retriangulation.
 */
const meshCache = new Map<string, { key: string; mesh: KernelMesh; faces?: FaceInfo[]; solid?: AnySolid }>();

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
    for (const spec of specs) {
      seen.add(spec.id);
      const key = localKey(spec);
      const cached = meshCache.get(spec.id);

      if (cached && cached.key === key) {
        parts.push({ id: spec.id, isHole: spec.isHole, mesh: cached.mesh, faces: cached.faces });
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
          const solid = await makeLocal(spec, onError, onProgress);
          if (solid) {
            const mesh = toMesh(spec.id, solid, EDIT_QUALITY);
            const faces = faceInfoOf(mesh);
            meshCache.set(spec.id, { key, mesh, faces, solid });
            parts.push({ id: spec.id, isHole: spec.isHole, mesh, faces });
          } else {
            meshCache.delete(spec.id);
          }
        }
      } catch (e) {
        meshCache.delete(spec.id);
        onError(spec.id, message(e));
      }
    }

    // Drop entries for nodes that no longer exist, so deleting objects over a
    // long session does not leak memory here.
    for (const id of meshCache.keys()) {
      if (!seen.has(id)) meshCache.delete(id);
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
        const [min, max] = solid.boundingBox.bounds;
        centres[spec.id] = [
          (min[0] + max[0]) / 2,
          (min[1] + max[1]) / 2,
          (min[2] + max[2]) / 2,
        ];
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

  /** Exports the fully booleaned result as a binary STL, ready for the slicer.
   * Uses the same Manifold-first top-level union as buildResult for robustness. */
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
    const { onError } = collector();
    const evaluated: { solid: AnySolid; isHole: boolean }[] = [];
    for (const spec of specs) {
      const world = await makeWorld(spec, onError, onProgress);
      if (!world) continue;
      evaluated.push({ solid: world, isHole: spec.isHole });
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
    if (!solid) return null;
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
      if (spec.type === "edit" && spec.ops.length > 0 && !hasImport(spec.base)) {
        const finalOp = spec.ops[spec.ops.length - 1];
        const key = JSON.stringify({ base: spec.base, ops: spec.ops.slice(0, -1) });
        if (pushPullPreviewCache?.key !== key) {
          const base = await makePushPullPreviewBase(spec);
          pushPullPreviewCache = base ? { key, solid: base } : null;
        }
        solid = pushPullPreviewCache ? applyPushPullPreview(pushPullPreviewCache.solid, finalOp) : null;
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
  async pruneDeadOps(spec: NodeSpec): Promise<PushPullOp[] | null> {
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
