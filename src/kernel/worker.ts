// The CAD kernel runs here, off the main thread. OCCT operations are
// synchronous and can block for hundreds of ms; keeping them in a worker is
// what stops the UI freezing mid-drag.
import * as Comlink from "comlink";
import opencascade from "replicad-opencascadejs";
import wasmUrl from "replicad-opencascadejs/wasm?url";
import { setOC, measureVolume } from "replicad";
import type { Shape3D } from "replicad";
import { makeLocal } from "./shape";
import type {
  BuildError,
  KernelMesh,
  NodeSpec,
  ScenePart,
  SceneBuild,
  ResultBuild,
} from "./types";

let booted: Promise<void> | null = null;

function init(): Promise<void> {
  if (!booted) {
    booted = opencascade({ locateFile: () => wasmUrl }).then((OC: unknown) => {
      setOC(OC as never);
    });
  }
  return booted;
}

function toMesh(name: string, s: Shape3D): KernelMesh {
  return { name, faces: s.mesh(), edges: s.meshEdges() };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * A string that changes if and only if a node's LOCAL mesh (what makeLocal()
 * would produce) changes. A plain object's own position/rotation are excluded
 * — makeLocal() never reads them, only place() does, later. A group's key
 * does include each child's position/rotation/isHole, since those feed into
 * the group's own combined boolean.
 */
function localKey(spec: NodeSpec): string {
  return JSON.stringify(
    spec.type === "group"
      ? [
          spec.type,
          spec.op,
          spec.children.map((c) => [localKey(c), c.position, c.rotation, c.isHole]),
        ]
      : [spec.type, spec.kind, spec.params],
  );
}

/**
 * Per-node mesh cache, keyed by node id. Without this, dragging a slider on
 * one object rebuilds every OTHER object in the scene too — buildScene() has
 * no way to know only one node changed — so editing got slower the more
 * objects existed, even though only one of them was actually being touched.
 * A cache hit skips the OCCT call entirely, not just the retriangulation.
 */
const meshCache = new Map<string, { key: string; mesh: KernelMesh }>();

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
function evaluateRoots(
  specs: NodeSpec[],
  onError: (id: string, msg: string) => void,
): Shape3D | null {
  return makeLocal(
    {
      type: "group",
      id: "__root",
      op: "union",
      children: specs,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      isHole: false,
    },
    onError,
  );
}

const api = {
  /**
   * Meshes each TOP-LEVEL node — the editing view. A group meshes as its
   * evaluated boolean, so grouping shows you the combined shape the way
   * TinkerCAD does. Placement is applied on the main thread, so moving a node
   * costs nothing here.
   */
  async buildScene(specs: NodeSpec[]): Promise<SceneBuild> {
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
        parts.push({ id: spec.id, isHole: spec.isHole, mesh: cached.mesh });
        continue;
      }

      try {
        const solid = makeLocal(spec, onError);
        if (solid) {
          const mesh = toMesh(spec.id, solid);
          meshCache.set(spec.id, { key, mesh });
          parts.push({ id: spec.id, isHole: spec.isHole, mesh });
        } else {
          meshCache.delete(spec.id);
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

    return { parts, errors, buildMs: performance.now() - t0 };
  },

  /** Applies every boolean in the tree and meshes the single resulting solid. */
  async buildResult(specs: NodeSpec[]): Promise<ResultBuild> {
    await init();
    const t0 = performance.now();
    const { errors, onError } = collector();

    const solid = evaluateRoots(specs, onError);
    if (!solid) return { mesh: null, volume: 0, faceCount: 0, errors, buildMs: 0 };

    return {
      mesh: toMesh("result", solid),
      volume: measureVolume(solid),
      faceCount: solid.faces.length,
      errors,
      buildMs: performance.now() - t0,
    };
  },

  /** Exports the fully booleaned result as a binary STL, ready for the slicer. */
  async exportSTL(specs: NodeSpec[]): Promise<Blob | null> {
    await init();
    const { onError } = collector();
    const solid = evaluateRoots(specs, onError);
    return solid ? solid.blobSTL() : null;
  },
};

export type KernelAPI = typeof api;
Comlink.expose(api);
