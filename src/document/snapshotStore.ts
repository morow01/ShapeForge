// Named snapshots of a design, like Photoshop's: a state worth coming back to,
// kept next to the history steps instead of being scrolled out of them.
//
// A snapshot is the whole node tree at that moment (no geometry — the kernel
// rebuilds that), gzipped into IndexedDB under the design's id. IndexedDB for
// the same reason the history window and imported meshes use it: localStorage
// is ~5MB for the whole origin and the designs already share it.
import { gunzipSync, gzipSync, strFromU8, strToU8 } from "fflate";
import type { SceneNode } from "./types";

export type DesignSnapshot = { id: string; name: string; at: number; nodes: SceneNode[] };

const FORMAT = 1;
const DB_NAME = "shapeforge-snapshots";
const STORE = "snapshots";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Replaces a design's whole list of snapshots. */
export async function saveSnapshots(projectId: string, snapshots: DesignSnapshot[]): Promise<void> {
  const packed = gzipSync(strToU8(JSON.stringify({ v: FORMAT, snapshots })));
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(packed, projectId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** A design's snapshots, newest first; empty when it has none or they cannot be read. */
export async function loadSnapshots(projectId: string): Promise<DesignSnapshot[]> {
  const db = await openDb();
  let packed: Uint8Array | null;
  try {
    packed = await new Promise<Uint8Array | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(projectId);
      req.onsuccess = () => resolve((req.result as Uint8Array | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
  if (!packed) return [];
  try {
    const parsed = JSON.parse(strFromU8(gunzipSync(packed))) as { v?: number; snapshots?: DesignSnapshot[] };
    if (parsed.v !== FORMAT || !Array.isArray(parsed.snapshots)) return [];
    return parsed.snapshots.filter((s) => s && Array.isArray(s.nodes));
  } catch {
    return [];
  }
}
