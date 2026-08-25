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

    const parts: ScenePart[] = [];
    for (const spec of specs) {
      try {
        const solid = makeLocal(spec, onError);
        if (solid) parts.push({ id: spec.id, isHole: spec.isHole, mesh: toMesh(spec.id, solid) });
      } catch (e) {
        onError(spec.id, message(e));
      }
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
