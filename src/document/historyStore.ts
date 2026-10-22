// The recent part of a design's edit history, kept across reloads.
//
// The undo stack itself lives in memory (zundo, in store.ts) and is nearly
// free there: an edit rebuilds only the nodes on the path it touched, so
// every other subtree is shared by reference with the snapshot before it.
// Written out that sharing is gone — each snapshot serialises in full — so
// only a window of the most recent steps is kept, and it goes to IndexedDB
// for the same reason imported meshes do (see blobStore.ts): localStorage is
// a fixed ~5MB for the whole origin, which the designs, their thumbnails and
// the index already share, while IndexedDB draws on a quota measured in
// gigabytes. Raising the localStorage limit is not an option — no API offers
// it, and it is not a setting; moving the data is the only way.
//
// The window is gzipped before it is stored. These trees compress around
// 10:1, and one compact byte array is also far quicker for IndexedDB to
// write and read back than two dozen deep object graphs.
//
// Deliberately NOT requesting navigator.storage.persist(): in Firefox that
// raises a permission prompt the person never asked for, and losing this
// data to eviction costs them their undo history, not their work — the
// designs themselves are saved separately. One line here if that changes.
import { gunzipSync, gzipSync, strFromU8, strToU8 } from "fflate";
import type { SceneNode } from "./types";

/** One state of the document as the undo stack holds it. */
export type HistorySnapshot = { nodes: SceneNode[]; historyLabel: string };

/** How many steps either side of the present survive a reload. The in-memory
 *  stack keeps far more (see `limit` in store.ts) because it costs almost
 *  nothing; this is the number that gets serialised, so it is the one that
 *  has to stay modest on a design of any size. Tune it here. */
export const PERSISTED_HISTORY_STEPS = 25;

/** A design's history as it is stored: the steps behind the present, the
 *  ones undone and still ahead of it, and what the present itself is called. */
export type HistoryWindow = {
  past: HistorySnapshot[];
  future: HistorySnapshot[];
  label: string;
};

/** Bumped if the shape of a stored window ever changes; anything else is
 *  ignored rather than half-understood. */
const FORMAT = 1;

const DB_NAME = "shapeforge-history";
const STORE = "windows";

/**
 * The part of the stack worth keeping, nearest the present first to go.
 *
 * Both of zundo's stacks grow away from the present — `past` forwards,
 * `future` backwards, since redo pops from its end — so in both cases it is
 * the TAIL that sits closest to where the person is now, and the tail is
 * what survives.
 */
export function trimHistoryWindow(
  past: Partial<HistorySnapshot>[],
  future: Partial<HistorySnapshot>[],
  label: string,
  limit = PERSISTED_HISTORY_STEPS,
): HistoryWindow {
  // Not slice(-keep): -0 is 0, which slices from the front and would keep
  // everything exactly when the intent was to keep nothing.
  const keep = Math.max(0, limit);
  const usable = (states: Partial<HistorySnapshot>[]): HistorySnapshot[] =>
    (keep === 0 ? [] : states.filter((s): s is HistorySnapshot => Array.isArray(s.nodes)).slice(-keep))
      .map((s) => ({ nodes: s.nodes, historyLabel: s.historyLabel ?? "Edit" }));
  return { past: usable(past), future: usable(future), label };
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Saves one design's window, replacing whatever was there. */
export async function saveHistory(projectId: string, window: HistoryWindow): Promise<void> {
  const packed = gzipSync(strToU8(JSON.stringify({ v: FORMAT, ...window })));
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

/** The saved window for a design, or null if it has none or it cannot be
 *  read. A window that will not load is never worth an error: the design is
 *  stored separately and opens regardless, just without its history. */
export async function loadHistory(projectId: string): Promise<HistoryWindow | null> {
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
  if (!packed) return null;
  try {
    const parsed = JSON.parse(strFromU8(gunzipSync(packed))) as Partial<HistoryWindow> & { v?: number };
    if (parsed.v !== FORMAT || !Array.isArray(parsed.past) || !Array.isArray(parsed.future)) return null;
    return trimHistoryWindow(parsed.past, parsed.future, parsed.label ?? "Open");
  } catch {
    return null;
  }
}

/** Drops a design's window — when the design goes, or when a file import
 *  replaces what was under that id with something else entirely. */
export async function deleteHistory(projectId: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(projectId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
