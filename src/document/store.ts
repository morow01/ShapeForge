import { create } from "zustand";
import { useStore } from "zustand";
import { temporal } from "zundo";
import type { TemporalState } from "zundo";
import { PRIMITIVES, isGroup } from "./types";
import { extractNodes, findNode, firstRootIndex, updateNode, walk } from "./tree";
import { clearDocument, highestIdSuffix, loadDocument, saveDocument } from "./persist";
import {
  TRI_BY_ANGLES,
  applyTriangleAngle,
  isTriangleAngleKey,
  normaliseTriangleAngles,
} from "../geometry/triangle";
import type { BooleanOp, GroupNode, ObjectNode, PrimitiveKind, SceneNode, Vec3 } from "./types";

// Restored synchronously at module load, so the first render already has the
// saved document — no hydration flash, and no bogus entry in the undo history.
const restored = loadDocument();

let counter = highestIdSuffix(restored);
const nextId = () => `n-${++counter}`;

/* ---- undo batching -------------------------------------------------------
 * A gizmo drag fires a state change on every animation frame, and a slider
 * fires one per pixel. Recorded individually they bury the history under
 * hundreds of near-identical entries, so undo replays the drag frame by frame.
 *
 * A batch records the FIRST change of a burst — that is what captures the
 * pre-drag state to return to — then stops recording until the burst ends.
 * One drag, one undo step.
 */
let armed = false;

/** Call when a continuous interaction starts (drag, slider sweep, typing). */
export function beginHistoryBatch() {
  armed = true;
}

/** Call when it ends. Safe to call unpaired. */
export function endHistoryBatch() {
  armed = false;
  useDoc.temporal.getState().resume();
}

/** Runs after every mutation that can be part of a burst. */
function afterBatchedMutation() {
  if (!armed) return;
  armed = false;
  useDoc.temporal.getState().pause();
}

/**
 * Applies a parameter edit, honouring the couplings a primitive needs.
 * Only the triangle has any: in Angles mode its three corners must sum to 180.
 */
function nextParams(o: ObjectNode, key: string, value: number): Record<string, number> {
  if (o.kind !== "triangle") return { ...o.params, [key]: value };

  // Entering Angles mode from a mode where the angles were independent — they
  // may no longer sum to 180, so make them consistent before use.
  if (key === "mode") {
    const params = { ...o.params, mode: value };
    return value === TRI_BY_ANGLES ? normaliseTriangleAngles(params) : params;
  }

  if (o.params.mode === TRI_BY_ANGLES && isTriangleAngleKey(key)) {
    return applyTriangleAngle(o.params, key, value);
  }
  return { ...o.params, [key]: value };
}

interface DocState {
  nodes: SceneNode[];
  /** Multi-select, in click order. */
  selectedIds: string[];
  /** When true the viewport shows the fully booleaned result. */
  showResult: boolean;
  /** Timestamp of the last successful autosave. */
  savedAt: number | null;
  /** Set when localStorage refuses writes (quota, or private browsing). */
  storageBlocked: boolean;

  addPrimitive: (kind: PrimitiveKind) => void;
  removeSelected: () => void;
  select: (id: string | null, additive?: boolean) => void;
  selectMany: (ids: string[], additive?: boolean) => void;
  setParam: (id: string, key: string, value: number) => void;
  setTransform: (id: string, patch: { position?: Vec3; rotation?: Vec3 }) => void;
  setHole: (id: string, isHole: boolean) => void;
  setGroupOp: (id: string, op: BooleanOp) => void;
  toggleCollapsed: (id: string) => void;
  rename: (id: string, name: string) => void;
  group: () => void;
  ungroup: () => void;
  setShowResult: (v: boolean) => void;
  /** Discards the document and the saved copy. */
  clearAll: () => void;
}

export const useDoc = create<DocState>()(
  temporal(
    (set) => ({
      nodes: restored,
      selectedIds: [],
      showResult: false,
      // A restored document is already on disk, so it counts as saved.
      savedAt: restored.length ? Date.now() : null,
      storageBlocked: false,

      addPrimitive: (kind) =>
        set((s) => {
          const def = PRIMITIVES[kind];
          // Count the whole tree, not just the roots, so a part nested in a
          // group does not leave two "Box 1"s on screen.
          let n = 1;
          for (const node of walk(s.nodes)) {
            if (node.type === "object" && node.kind === kind) n++;
          }
          const node: ObjectNode = {
            type: "object",
            id: nextId(),
            kind,
            name: `${def.label} ${n}`,
            params: { ...def.defaults },
            // Offset each new part so they do not stack invisibly.
            position: [s.nodes.length * 6, 0, 0],
            rotation: [0, 0, 0],
            isHole: false,
          };
          return { nodes: [...s.nodes, node], selectedIds: [node.id] };
        }),

      removeSelected: () =>
        set((s) => ({
          nodes: extractNodes(s.nodes, new Set(s.selectedIds)).remaining,
          selectedIds: [],
        })),

      select: (id, additive = false) =>
        set((s) => {
          if (id === null) return { selectedIds: [] };
          if (!additive) return { selectedIds: [id] };
          return s.selectedIds.includes(id)
            ? { selectedIds: s.selectedIds.filter((x) => x !== id) }
            : { selectedIds: [...s.selectedIds, id] };
        }),

      /** Marquee (rubber-band) select — replaces the selection with `ids` in
       *  one atomic update, or unions it into the current one when additive
       *  (shift/ctrl held). Order matters (the LAST id drives the gizmo), so
       *  additive appends newly-caught ids after the ones already selected. */
      selectMany: (ids, additive = false) =>
        set((s) => {
          if (!additive) return { selectedIds: ids };
          const merged = [...s.selectedIds];
          for (const id of ids) if (!merged.includes(id)) merged.push(id);
          return { selectedIds: merged };
        }),

      setParam: (id, key, value) => {
        set((s) => ({
          nodes: updateNode(s.nodes, id, (n) =>
            n.type === "object" ? { ...n, params: nextParams(n, key, value) } : n,
          ),
        }));
        afterBatchedMutation();
      },

      setTransform: (id, patch) => {
        set((s) => ({ nodes: updateNode(s.nodes, id, (n) => ({ ...n, ...patch })) }));
        afterBatchedMutation();
      },

      setHole: (id, isHole) =>
        set((s) => ({ nodes: updateNode(s.nodes, id, (n) => ({ ...n, isHole })) })),

      setGroupOp: (id, op) =>
        set((s) => ({
          nodes: updateNode(s.nodes, id, (n) => (isGroup(n) ? { ...n, op } : n)),
        })),

      toggleCollapsed: (id) =>
        set((s) => ({
          nodes: updateNode(s.nodes, id, (n) =>
            isGroup(n) ? { ...n, collapsed: !n.collapsed } : n,
          ),
        })),

      rename: (id, name) => {
        set((s) => ({ nodes: updateNode(s.nodes, id, (n) => ({ ...n, name })) }));
        afterBatchedMutation();
      },

      /**
       * Wraps the selection in a new group, inserted where the first selected
       * node was. Children keep their world transforms; the group starts at the
       * origin so grouping never moves anything.
       */
      group: () =>
        set((s) => {
          if (s.selectedIds.length < 2) return {};
          const ids = new Set(s.selectedIds);
          const at = firstRootIndex(s.nodes, ids);
          const { remaining, removed } = extractNodes(s.nodes, ids);
          if (removed.length < 2) return {};

          // Preserve the order the nodes appeared in, which matters for subtract.
          const order = new Map(s.selectedIds.map((id, i) => [id, i]));
          removed.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

          const groupCount = s.nodes.filter(isGroup).length + 1;
          const node: GroupNode = {
            type: "group",
            id: nextId(),
            name: `Group ${groupCount}`,
            op: "union",
            children: removed,
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            isHole: false,
          };
          const nodes = [...remaining];
          nodes.splice(Math.min(at, nodes.length), 0, node);
          return { nodes, selectedIds: [node.id] };
        }),

      /** Dissolves selected groups, lifting their children into their place. */
      ungroup: () =>
        set((s) => {
          const targets = s.selectedIds
            .map((id) => findNode(s.nodes, id))
            .filter((n): n is GroupNode => !!n && isGroup(n));
          if (!targets.length) return {};

          const lifted: string[] = [];
          const expand = (list: SceneNode[]): SceneNode[] =>
            list.flatMap((n) => {
              if (isGroup(n)) {
                if (targets.some((t) => t.id === n.id)) {
                  lifted.push(...n.children.map((c) => c.id));
                  return n.children;
                }
                return [{ ...n, children: expand(n.children) }];
              }
              return [n];
            });

          return { nodes: expand(s.nodes), selectedIds: lifted };
        }),

      setShowResult: (v) => set({ showResult: v }),

      clearAll: () => {
        clearDocument();
        set({ nodes: [], selectedIds: [] });
      },
    }),
    {
      // Only geometry belongs in the undo history — selection and view toggles
      // would otherwise make undo feel like it "does nothing".
      partialize: (s) => ({ nodes: s.nodes }),
      limit: 200,
    },
  ),
);

/** Subscribe to undo/redo state. zundo keeps its history in a separate store. */
export function useTemporal<T>(selector: (s: TemporalState<{ nodes: SceneNode[] }>) => T): T {
  return useStore(useDoc.temporal, selector);
}

/* ---- autosave ------------------------------------------------------------
 * Writes are debounced so a gizmo drag does not serialise the document on
 * every frame, and flushed on hide so the last edit is never lost.
 */
const SAVE_DEBOUNCE_MS = 400;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pending: SceneNode[] | null = null;

function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!pending) return;
  const ok = saveDocument(pending);
  pending = null;
  useDoc.setState(ok ? { savedAt: Date.now(), storageBlocked: false } : { storageBlocked: true });
}

useDoc.subscribe((state, prev) => {
  if (state.nodes === prev.nodes) return;
  pending = state.nodes;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
});

if (typeof window !== "undefined") {
  // pagehide is the reliable one — beforeunload does not always fire, and
  // neither does unload on mobile. visibilitychange covers tab switches.
  window.addEventListener("pagehide", flushSave);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSave();
  });
}
