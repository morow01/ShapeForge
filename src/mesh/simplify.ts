import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { SimplifyModifier } from "three/examples/jsm/modifiers/SimplifyModifier.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export interface SimplifyResult {
  buffer: ArrayBuffer;
  trianglesBefore: number;
  trianglesAfter: number;
}

/**
 * Reads the triangle count from a binary STL header in O(1) time.
 * Falls back to ASCII scan or null if unrecognized.
 */
export function getStlTriangleCount(buffer: ArrayBuffer): number | null {
  if (buffer.byteLength < 84) return null;
  const view = new DataView(buffer);
  const numFaces = view.getUint32(80, true);

  // Exact binary STL check: 80-byte header + 4-byte count + 50 bytes per face
  if (84 + numFaces * 50 === buffer.byteLength) {
    return numFaces;
  }

  // Common real-world variation: binary STL with slight trailing padding
  if (
    numFaces > 0 &&
    numFaces < 50_000_000 &&
    Math.abs(84 + numFaces * 50 - buffer.byteLength) < 1000
  ) {
    return numFaces;
  }

  // Fallback for ASCII STL files
  try {
    const textSample = new TextDecoder().decode(
      buffer.slice(0, Math.min(buffer.byteLength, 1024)),
    );
    if (textSample.trim().startsWith("solid")) {
      const fullText = new TextDecoder().decode(buffer);
      const matches = fullText.match(/endfacet/g);
      return matches ? matches.length : null;
    }
  } catch {}

  return null;
}

/** Direct fallback mesh simplification on the main thread if workers are unavailable */
export function simplifySTLDirect(buffer: ArrayBuffer, ratio: number): SimplifyResult {
  const loader = new STLLoader();
  const loaded = loader.parse(buffer);
  const trianglesBefore = loaded.attributes.position.count / 3;

  const merged = mergeVertices(loaded);
  const vertexCount = merged.attributes.position.count;
  const removeCount = Math.floor(vertexCount * Math.max(0.05, Math.min(0.95, ratio)));
  const actualRemove = Math.max(0, Math.min(vertexCount - 4, removeCount));

  let resultGeom: THREE.BufferGeometry = merged;
  if (actualRemove > 0) {
    const modifier = new SimplifyModifier();
    resultGeom = modifier.modify(merged, actualRemove);
  }

  const exporter = new STLExporter();
  const out = exporter.parse(
    new THREE.Mesh(resultGeom, new THREE.MeshBasicMaterial()),
    { binary: true },
  ) as DataView;

  const resultBuffer = (out.buffer as ArrayBuffer).slice(
    out.byteOffset,
    out.byteOffset + out.byteLength,
  );
  const view = new DataView(resultBuffer);
  const trianglesAfter = view.getUint32(80, true);

  return {
    buffer: resultBuffer,
    trianglesBefore,
    trianglesAfter,
  };
}

let workerInstance: Worker | null = null;
let nextReqId = 1;
const pendingRequests = new Map<
  number,
  {
    resolve: (res: SimplifyResult) => void;
    reject: (err: Error) => void;
  }
>();

function getWorker(): Worker | null {
  if (typeof window === "undefined" || !window.Worker) return null;
  if (!workerInstance) {
    try {
      workerInstance = new Worker(
        new URL("./simplify.worker.ts", import.meta.url),
        { type: "module" },
      );
      workerInstance.onmessage = (
        e: MessageEvent<
          | { id: number; success: true; buffer: ArrayBuffer; trianglesBefore: number; trianglesAfter: number }
          | { id: number; success: false; error: string }
        >,
      ) => {
        const handler = pendingRequests.get(e.data.id);
        if (!handler) return;
        pendingRequests.delete(e.data.id);
        if (e.data.success) {
          handler.resolve({
            buffer: e.data.buffer,
            trianglesBefore: e.data.trianglesBefore,
            trianglesAfter: e.data.trianglesAfter,
          });
        } else {
          handler.reject(new Error(e.data.error || "Mesh simplification failed"));
        }
      };
      workerInstance.onerror = (err) => {
        for (const [, req] of pendingRequests) {
          req.reject(new Error(`Worker error: ${err.message || "Unknown worker error"}`));
        }
        pendingRequests.clear();
        workerInstance?.terminate();
        workerInstance = null;
      };
    } catch {
      workerInstance = null;
    }
  }
  return workerInstance;
}

/**
 * Simplifies an STL ArrayBuffer by the given reduction ratio (e.g. 0.5 for 50% fewer vertices).
 * Executes in a Web Worker to avoid freezing the main UI thread.
 */
export async function simplifyMesh(
  buffer: ArrayBuffer,
  ratio: number,
): Promise<SimplifyResult> {
  const worker = getWorker();
  if (!worker) {
    return simplifySTLDirect(buffer, ratio);
  }

  const id = nextReqId++;
  return new Promise<SimplifyResult>((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    // Clone buffer so transfer doesn't neuter the caller's copy if needed
    const copy = buffer.slice(0);
    worker.postMessage({ id, buffer: copy, ratio }, [copy]);
  });
}
