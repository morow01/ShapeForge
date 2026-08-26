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
  hasImport,
  isMesh,
  makeLocal,
  makePushPullPreviewBase,
  place,
  survivingOps,
} from "./shape";
import { loadSTLPreview } from "./stlPreview";
import type { AnySolid } from "./shape";
import type {
  BuildError,
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
import type { PushPullOp } from "../document/types";

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
 * Tessellation quality for the merged result preview and STL export — a
 * one-time cost, so it can afford to be finer, but still nowhere near OCCT's
 * default: at 0.001mm that default is finer than any FDM or resin printer's
 * real-world accuracy (typically 0.05–0.2mm), so it is detail no printer can
 * express, paid for in file size, slicer load time, and the same crash risk
 * as above. 0.02mm is already smoother than what shows up in a print.
 */
const EXPORT_QUALITY: MeshQuality = { tolerance: 0.02, angularTolerance: 0.3 };

/** MeshShape (imports, or anything combined with one) has no OCCT face
 *  topology to preserve, so it becomes one single pickable "face" covering
 *  the whole triangle set, and there is no separate edge/wireframe data —
 *  syncGeometries on the Three.js side treats edges as optional. */
function meshFromMeshShape(m: MeshShape): { faces: MeshedFaces; edges: MeshedEdges } {
  const raw = m.mesh();
  return {
    faces: {
      vertices: raw.vertices,
      triangles: raw.triangles,
      normals: raw.normals,
      faceGroups: [{ start: 0, count: raw.triangles.length, faceId: 0 }],
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
function faceInfoOf(s: AnySolid): FaceInfo[] | undefined {
  if (isMesh(s)) return undefined;
  return s.faces.map((face): FaceInfo => {
    try {
      const c = face.center;
      const n = face.normalAt(c);
      return {
        planar: face.geomType === "PLANE",
        point: [c.x, c.y, c.z],
        normal: [n.x, n.y, n.z],
      };
    } catch {
      // Some non-planar geometries — a cylinder's curved side, confirmed —
      // throw a raw, uncatchable-looking WebAssembly exception straight out
      // of .center/.normalAt() in this replicad-opencascadejs build. Same
      // family of build-level quirk as importSTL()'s (see shape.ts) — not
      // fixable here, only worked around. Hover-highlighting this face only
      // needs its position in this array to line up with the mesh's own
      // faceGroups order, not a real point/normal, so fall back to a
      // placeholder and mark it non-planar — push/pull was never offered
      // for a curved face anyway.
      return { planar: false, point: [0, 0, 0], normal: [0, 0, 1] };
    }
  });
}

function volumeOf(s: AnySolid): number {
  return isMesh(s) ? s.volume() : measureVolume(s);
}

function faceCountOf(s: AnySolid): number {
  return isMesh(s) ? s.numTri() : s.faces.length;
}

function blobSTLOf(s: AnySolid, quality: MeshQuality): Blob {
  return isMesh(s) ? s.blobSTL({ binary: true }) : s.blobSTL({ ...quality, binary: true });
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
  if (spec.type === "import") return JSON.stringify([spec.type, spec.blobId]);
  if (spec.type === "edit") return JSON.stringify([spec.type, localKey(spec.base), spec.ops]);
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
let resultSolidCache: { key: string; solid: AnySolid } | null = null;

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

/**
 * Evaluates the top-level forest into a single solid. The roots behave exactly
 * like a union group — solids merge, holes cut — so they are evaluated as one,
 * which also gives them the invalid-union recovery for free.
 */
async function evaluateRoots(
  specs: NodeSpec[],
  onError: (id: string, msg: string) => void,
  onProgress?: (id: string) => void,
): Promise<AnySolid | null> {
  return makeLocal(
    {
      type: "group",
      id: "__root",
      op: "union",
      children: specs,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      isHole: false,
    },
    onError,
    onProgress,
  );
}

const api = {
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
        if (spec.type === "import") {
          onProgress?.(spec.id);
          const mesh = await loadSTLPreview(spec.id, spec.blobId);
          meshCache.set(spec.id, { key, mesh });
          parts.push({ id: spec.id, isHole: spec.isHole, mesh });
        } else {
          const solid = await makeLocal(spec, onError, onProgress);
          if (solid) {
            const mesh = toMesh(spec.id, solid, EDIT_QUALITY);
            const faces = faceInfoOf(solid);
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
        ? { key: resultKey(specs), solid: place(cached.solid, specs[0]) }
        : null;
    } else if (resultSolidCache?.key !== resultKey(specs)) {
      resultSolidCache = null;
    }

    return { parts, errors, buildMs: performance.now() - t0 };
  },

  /** Applies every boolean in the tree and meshes the single resulting solid. */
  async buildResult(specs: NodeSpec[], onProgress?: (id: string) => void): Promise<ResultBuild> {
    await init();
    const t0 = performance.now();
    const { errors, onError } = collector();

    const solid = await evaluateRoots(specs, onError, onProgress);
    if (!solid) return { mesh: null, volume: 0, faceCount: 0, errors, buildMs: 0 };
    resultSolidCache = { key: resultKey(specs), solid };

    return {
      mesh: toMesh("result", solid, EXPORT_QUALITY),
      volume: volumeOf(solid),
      faceCount: faceCountOf(solid),
      errors,
      buildMs: performance.now() - t0,
    };
  },

  /** Fast export path used on the interactive worker: it never rebuilds. If
   * the current scene/result solid is cached, only STL tessellation remains;
   * otherwise the client falls back to the isolated heavy worker. */
  async exportCachedSTL(specs: NodeSpec[]): Promise<Blob | null> {
    await init();
    const key = resultKey(specs);
    return resultSolidCache?.key === key
      ? blobSTLOf(resultSolidCache.solid, EXPORT_QUALITY)
      : null;
  },

  /** Exports the fully booleaned result as a binary STL, ready for the slicer. */
  async exportSTL(specs: NodeSpec[], onProgress?: (id: string) => void): Promise<Blob | null> {
    await init();
    const { onError } = collector();
    const key = resultKey(specs);
    const solid = resultSolidCache?.key === key
      ? resultSolidCache.solid
      : await evaluateRoots(specs, onError, onProgress);
    if (solid && resultSolidCache?.key !== key) resultSolidCache = { key, solid };
    // binary: true — smaller and faster to write/read than the ASCII default,
    // and every slicer (including Bambu Studio) reads it fine.
    return solid ? blobSTLOf(solid, EXPORT_QUALITY) : null;
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
      return { mesh: toMesh(spec.id, solid, EDIT_QUALITY), faces: faceInfoOf(solid) };
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
