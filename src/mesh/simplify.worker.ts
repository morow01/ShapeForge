import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { SimplifyModifier } from "three/examples/jsm/modifiers/SimplifyModifier.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";

self.onmessage = (e: MessageEvent<{ id: number; buffer: ArrayBuffer; ratio: number }>) => {
  const { id, buffer, ratio } = e.data;
  try {
    const loader = new STLLoader();
    const loaded = loader.parse(buffer);
    const trianglesBefore = loaded.attributes.position.count / 3;

    // Merge non-indexed vertices so edge collapse finds shared edges
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

    (self as any).postMessage(
      {
        id,
        success: true,
        buffer: resultBuffer,
        trianglesBefore,
        trianglesAfter,
      },
      [resultBuffer],
    );
  } catch (err: any) {
    (self as any).postMessage({
      id,
      success: false,
      error: err?.message || String(err),
    });
  }
};
