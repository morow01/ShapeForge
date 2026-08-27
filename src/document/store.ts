import { create } from "zustand";
import { useStore } from "zustand";
import { temporal } from "zundo";
import type { TemporalState } from "zundo";
import { PRIMITIVES, isGroup } from "./types";
import { extractNodes, findNode, firstRootIndex, updateNode, walk } from "./tree";
import {
  deleteProjectStorage,
  exportProjectFile,
  getActiveProjectId,
  highestIdSuffix,
  listProjects,
  loadCameraState,
  loadProject,
  parseProjectFile,
  saveProject,
  setActiveProjectId,
} from "./persist";
import {
  TRI_BY_ANGLES,
  applyTriangleAngle,
  isTriangleAngleKey,
  normaliseTriangleAngles,
  solveScaledTriangle,
  solveTriangle,
} from "../geometry/triangle";
import type {
  BooleanOp,
  BuildNode,
  EditNode,
  GroupNode,
  ImportNode,
  ObjectNode,
  PrimitiveKind,
  ProjectData,
  ProjectMeta,
  PushPullOp,
  SceneNode,
  Vec3,
} from "./types";

// Restored synchronously at module load, so the first render already has the
// saved document — no hydration flash, and no bogus entry in the undo history.
const initialProjectList = listProjects();
const activeId = getActiveProjectId();
let activeProject = loadProject(activeId);
if (!activeProject && initialProjectList.length > 0) {
  activeProject = loadProject(initialProjectList[0].id);
}
if (!activeProject) {
  activeProject = {
    version: 1,
    id: `p-${Date.now()}`,
    name: "Untitled Project",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    nodes: [],
  };
  saveProject(activeProject);
}

const initialProjects = listProjects();
const restored = activeProject.nodes;

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

/**
 * Whether a transform patch would change anything at all.
 *
 * Worth checking because a placement makes a round trip: the document moves a
 * node, the kernel rebuilds, the viewport re-applies the transform, and the
 * gizmo reports that same position back as if the user had dragged it. Written
 * blindly, that echo produces a second, identical `nodes` array a moment after
 * the real edit — which undo faithfully records, so one align or drop then took
 * two presses of Ctrl+Z to reverse, the first appearing to do nothing.
 */
function sameTransform(node: SceneNode, patch: { position?: Vec3; rotation?: Vec3; scale?: Vec3 }): boolean {
  // Not exact equality: the echo arrives having been through a Three.js
  // matrix and comes back a float ULP away (20 leaves, 20.000000000000004
  // returns), which an === test reads as a real edit. A nanometre is many
  // orders of magnitude below anything this app can model or display.
  const EPS = 1e-6;
  const same = (a: Vec3, b?: Vec3) =>
    !b || (Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS && Math.abs(a[2] - b[2]) < EPS);
  return (
    same(node.position, patch.position) &&
    same(node.rotation, patch.rotation) &&
    same(node.scale, patch.scale)
  );
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

  // Entering a new mode: sync all derived sides and angles first so switching
  // modes preserves the current triangle shape.
  if (key === "mode") {
    try {
      const solved = solveTriangle(o.params);
      const synced = {
        ...o.params,
        base: Math.round(solved.sides.base * 100) / 100,
        sideLeft: Math.round(solved.sides.left * 100) / 100,
        sideRight: Math.round(solved.sides.right * 100) / 100,
        angleLeft: Math.round(solved.angles.left * 100) / 100,
        angleRight: Math.round(solved.angles.right * 100) / 100,
        angleApex: Math.round(solved.angles.apex * 100) / 100,
        mode: value,
      };
      return value === TRI_BY_ANGLES ? normaliseTriangleAngles(synced) : synced;
    } catch {
      const params = { ...o.params, mode: value };
      return value === TRI_BY_ANGLES ? normaliseTriangleAngles(params) : params;
    }
  }

  let updated: Record<string, number>;
  if (o.params.mode === TRI_BY_ANGLES && isTriangleAngleKey(key)) {
    updated = applyTriangleAngle(o.params, key, value);
  } else {
    updated = { ...o.params, [key]: value };
  }

  try {
    const solved = solveTriangle(updated);
    return {
      ...updated,
      sideLeft: Math.round(solved.sides.left * 100) / 100,
      sideRight: Math.round(solved.sides.right * 100) / 100,
      angleLeft: Math.round(solved.angles.left * 100) / 100,
      angleRight: Math.round(solved.angles.right * 100) / 100,
      angleApex: Math.round(solved.angles.apex * 100) / 100,
    };
  } catch {
    return updated;
  }
}

/** Clones a node subtree with a fresh id at every level — a duplicated
 *  group's children get new ids too, not just the group itself, so the copy
 *  is fully independent of the original. Only the subtree's own root is
 *  offset; children keep their position relative to their parent group. */
function cloneSubtree(n: SceneNode, offset: Vec3): SceneNode {
  const position: Vec3 = [
    n.position[0] + offset[0],
    n.position[1] + offset[1],
    n.position[2] + offset[2],
  ];
  const clone = { ...n, id: nextId(), position };
  return isGroup(clone) ? { ...clone, children: clone.children.map((c) => cloneSubtree(c, [0, 0, 0])) } : clone;
}

interface DocState {
  currentProjectId: string;
  projectName: string;
  projects: ProjectMeta[];
  nodes: SceneNode[];
  /** Multi-select, in click order. */
  selectedIds: string[];
  /** When true the viewport shows the fully booleaned result. */
  showResult: boolean;
  /** Timestamp of the last successful autosave. */
  savedAt: number | null;
  /** Set when localStorage refuses writes (quota, or private browsing). */
  storageBlocked: boolean;

  newProject: (name?: string) => string;
  openProject: (id: string) => boolean;
  renameProject: (name: string) => void;
  duplicateProject: (id: string) => string | null;
  deleteProject: (id: string) => boolean;
  exportCurrentProject: () => void;
  importProjectFile: (file: File) => Promise<boolean>;
  importProjectData: (data: ProjectData) => string;
  refreshProjectsList: () => void;

  addPrimitive: (kind: PrimitiveKind) => void;
  /** Adds a node for a file already written to blobStore — the caller reads
   *  and stores the bytes first (both are async), so this stays a plain
   *  synchronous mutation like every other store action. */
  addImport: (blobId: string, fileName: string, byteSize: number) => void;
  removeSelected: () => void;
  select: (id: string | null, additive?: boolean) => void;
  selectMany: (ids: string[], additive?: boolean) => void;
  setParam: (id: string, key: string, value: number) => void;
  setTransform: (id: string, patch: { position?: Vec3; rotation?: Vec3; scale?: Vec3 }) => void;
  setPositions: (updates: { id: string; position: Vec3 }[]) => void;
  /** Clones whole subtrees (fresh ids throughout, so a cloned group's
   *  children are independent of the originals) offset by `offset`, appends
   *  them, and selects the new copies. Returns the new top-level ids, in the
   *  same order as `source`. */
  duplicateNodes: (source: SceneNode[], offset: Vec3) => string[];
  /** Push/pull: turns an ordinary object or group into an EditNode the first
   *  time it is called for that id (freezing its current definition as
   *  `base`), or appends another op if it already is one. */
  pushPullFace: (id: string, op: PushPullOp) => void;
  /** Replaces an edit node's ops wholesale — used to permanently drop an op
   *  that can never succeed again (see the kernel's pruneDeadOps/
   *  survivingOps), not to add one (pushPullFace does that). A no-op for
   *  any node that isn't an edit. */
  setOps: (id: string, ops: PushPullOp[]) => void;
  setHole: (id: string, isHole: boolean) => void;
  setColor: (id: string, color: string) => void;
  setTransparent: (id: string, transparent: boolean) => void;
  setGroupOp: (id: string, op: BooleanOp) => void;
  toggleCollapsed: (id: string) => void;
  rename: (id: string, name: string) => void;
  group: () => void;
  ungroup: () => void;
  setShowResult: (v: boolean) => void;
  /** Clears the canvas of the active project. */
  /** Shape Builder: replaces `sourceIds` with one node holding them frozen
   *  and the chosen cell masks. Sources keep their relative placement. */
  shapeBuild: (sourceIds: string[], keep: number[]) => void;
  clearAll: () => void;
}

export const useDoc = create<DocState>()(
  temporal(
    (set, get) => ({
      currentProjectId: activeProject.id,
      projectName: activeProject.name,
      projects: initialProjects,
      nodes: restored,
      selectedIds: [],
      showResult: false,
      // A restored document is already on disk, so it counts as saved.
      savedAt: restored.length ? Date.now() : null,
      storageBlocked: false,

      newProject: (name) => {
        flushSave();
        const newId = `p-${Date.now()}`;
        const newProjName = name?.trim() || "Untitled Project";
        const newProj: ProjectData = {
          version: 1,
          id: newId,
          name: newProjName,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          nodes: [],
        };
        saveProject(newProj);
        setActiveProjectId(newId);
        const updatedProjects = listProjects();

        useDoc.temporal.getState().clear();
        set({
          currentProjectId: newId,
          projectName: newProjName,
          projects: updatedProjects,
          nodes: [],
          selectedIds: [],
          savedAt: Date.now(),
        });
        return newId;
      },

      openProject: (id) => {
        flushSave();
        const proj = loadProject(id);
        if (!proj) return false;
        setActiveProjectId(proj.id);
        counter = Math.max(counter, highestIdSuffix(proj.nodes));
        const updatedProjects = listProjects();

        useDoc.temporal.getState().clear();
        set({
          currentProjectId: proj.id,
          projectName: proj.name,
          projects: updatedProjects,
          nodes: proj.nodes,
          selectedIds: [],
          savedAt: Date.now(),
        });
        return true;
      },

      renameProject: (name) => {
        const trimmed = name.trim() || "Untitled Project";
        const s = get();
        const proj = loadProject(s.currentProjectId) ?? {
          version: 1,
          id: s.currentProjectId,
          name: trimmed,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          nodes: s.nodes,
        };
        proj.name = trimmed;
        proj.updatedAt = Date.now();
        proj.nodes = s.nodes;
        saveProject(proj);
        set({ projectName: trimmed, projects: listProjects() });
      },

      duplicateProject: (id) => {
        flushSave();
        const source = loadProject(id);
        if (!source) return null;
        const newId = `p-${Date.now()}`;
        const newName = `${source.name} (Copy)`;
        const newProj: ProjectData = {
          ...source,
          id: newId,
          name: newName,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        saveProject(newProj);
        set({ projects: listProjects() });
        return newId;
      },

      deleteProject: (id) => {
        flushSave();
        const s = get();
        deleteProjectStorage(id);
        const remaining = listProjects();
        if (s.currentProjectId === id) {
          if (remaining.length > 0) {
            s.openProject(remaining[0].id);
          } else {
            s.newProject("Untitled Project");
          }
        } else {
          set({ projects: remaining });
        }
        return true;
      },

      exportCurrentProject: () => {
        flushSave();
        const s = get();
        const proj: ProjectData = {
          version: 1,
          id: s.currentProjectId,
          name: s.projectName,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          nodes: s.nodes,
          camera: loadCameraState(),
        };
        exportProjectFile(proj);
      },

      importProjectFile: async (file) => {
        try {
          const text = await file.text();
          const fallback = file.name.replace(/\.(shapeforge|json)$/i, "");
          const proj = parseProjectFile(text, fallback);
          if (!proj) return false;
          get().importProjectData(proj);
          return true;
        } catch {
          return false;
        }
      },

      importProjectData: (proj) => {
        flushSave();
        saveProject(proj);
        setActiveProjectId(proj.id);
        counter = Math.max(counter, highestIdSuffix(proj.nodes));
        const updatedProjects = listProjects();

        useDoc.temporal.getState().clear();
        set({
          currentProjectId: proj.id,
          projectName: proj.name,
          projects: updatedProjects,
          nodes: proj.nodes,
          selectedIds: [],
          savedAt: Date.now(),
        });
        return proj.id;
      },

      refreshProjectsList: () => {
        set({ projects: listProjects() });
      },

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
            scale: [1, 1, 1],
            isHole: false,
          };
          return { nodes: [...s.nodes, node], selectedIds: [node.id] };
        }),

      addImport: (blobId, fileName, byteSize) =>
        set((s) => {
          const node: ImportNode = {
            type: "import",
            id: nextId(),
            blobId,
            fileName,
            byteSize,
            // Strip a .stl extension for the display name; keep everything
            // else so two imports of similarly-named files stay distinct.
            name: fileName.replace(/\.stl$/i, ""),
            position: [s.nodes.length * 6, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
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
          nodes: updateNode(s.nodes, id, (n) => {
            if (n.type !== "object") return n;
            if (
              n.kind === "triangle" &&
              (Math.abs(n.scale[0] - 1) > 1e-4 ||
                Math.abs(n.scale[1] - 1) > 1e-4 ||
                Math.abs(n.scale[2] - 1) > 1e-4)
            ) {
              try {
                const solved = solveScaledTriangle(n.params, n.scale);
                const bakedParams = {
                  ...n.params,
                  base: solved.sides.base,
                  sideLeft: solved.sides.left,
                  sideRight: solved.sides.right,
                  angleLeft: solved.angles.left,
                  angleRight: solved.angles.right,
                  angleApex: solved.angles.apex,
                  thickness: Math.round(n.params.thickness * n.scale[2] * 100) / 100,
                };
                const updated = nextParams({ ...n, params: bakedParams }, key, value);
                return { ...n, params: updated, scale: [1, 1, 1] as Vec3 };
              } catch {
                return { ...n, params: nextParams(n, key, value) };
              }
            }
            return { ...n, params: nextParams(n, key, value) };
          }),
        }));
        afterBatchedMutation();
      },

      setTransform: (id, patch) => {
        set((s) => ({
          nodes: updateNode(s.nodes, id, (n) => (sameTransform(n, patch) ? n : { ...n, ...patch })),
        }));
        afterBatchedMutation();
      },

      // One alignment click may move several objects, but it is one user
      // action and therefore one immutable state transition / undo step.
      setPositions: (updates) => {
        const byId = new Map(updates.map((update) => [update.id, update.position]));
        set((s) => ({
          nodes: s.nodes.map((node) => {
            const position = byId.get(node.id);
            return position ? { ...node, position } : node;
          }),
        }));
      },

      duplicateNodes: (source, offset) => {
        const clones = source.map((n) => cloneSubtree(n, offset));
        set((s) => ({ nodes: [...s.nodes, ...clones], selectedIds: clones.map((c) => c.id) }));
        afterBatchedMutation();
        return clones.map((c) => c.id);
      },

      pushPullFace: (id, op) => {
        set((s) => ({
          nodes: updateNode(s.nodes, id, (n) => {
            if (n.type === "edit") {
              const color = n.color || n.base.color;
              const transparent = n.transparent ?? n.base.transparent;
              return {
                ...n,
                color,
                transparent,
                base: { ...n.base, color, transparent },
                ops: [...n.ops, op],
              };
            }
            // Neither is parametric any more, and the UI offers push/pull on
            // neither: an import has no face topology, and a build's shape is
            // owned by its cell selection.
            if (n.type === "import" || n.type === "build") return n;
            const base: ObjectNode | GroupNode = {
              ...n,
              position: [0, 0, 0],
              rotation: [0, 0, 0],
              scale: [1, 1, 1],
            };
            const edit: EditNode = {
              type: "edit",
              id: n.id,
              name: n.name,
              position: n.position,
              rotation: n.rotation,
              scale: n.scale,
              isHole: n.isHole,
              color: n.color,
              transparent: n.transparent,
              base,
              ops: [op],
            };
            return edit;
          }),
        }));
        afterBatchedMutation();
      },

      setOps: (id, ops) => {
        set((s) => ({
          nodes: updateNode(s.nodes, id, (n) => (n.type === "edit" ? { ...n, ops } : n)),
        }));
        afterBatchedMutation();
      },

      setHole: (id, isHole) =>
        set((s) => ({ nodes: updateNode(s.nodes, id, (n) => ({ ...n, isHole })) })),

      setColor: (id, color) => {
        set((s) => ({
          nodes: updateNode(s.nodes, id, (n) => {
            if (n.type === "edit") {
              return { ...n, color, base: { ...n.base, color } };
            }
            return { ...n, color };
          }),
        }));
        afterBatchedMutation();
      },

      setTransparent: (id, transparent) => {
        set((s) => ({
          nodes: updateNode(s.nodes, id, (n) => {
            if (n.type === "edit") {
              return { ...n, transparent, base: { ...n.base, transparent } };
            }
            return { ...n, transparent };
          }),
        }));
        afterBatchedMutation();
      },

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
            scale: [1, 1, 1],
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

      shapeBuild: (sourceIds, keep) =>
        set((s) => {
          if (sourceIds.length < 2 || !keep.length) return {};
          const ids = new Set(sourceIds);
          const at = firstRootIndex(s.nodes, ids);
          const { remaining, removed } = extractNodes(s.nodes, ids);
          if (removed.length < 2) return {};

          // Cell masks are bit positions over the sources IN ORDER, so the
          // order the caller decomposed in is the order that has to be stored.
          const order = new Map(sourceIds.map((id, i) => [id, i]));
          removed.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

          const buildCount = s.nodes.filter((n) => n.type === "build").length + 1;
          const node: BuildNode = {
            type: "build",
            id: nextId(),
            name: `Built ${buildCount}`,
            sources: removed,
            keep: [...keep].sort((a, b) => a - b),
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
            isHole: false,
          };
          const nodes = [...remaining];
          nodes.splice(Math.min(at, nodes.length), 0, node);
          return { nodes, selectedIds: [node.id] };
        }),

      clearAll: () => {
        set({ nodes: [], selectedIds: [] });
      },
    }),
    {
      // Only geometry belongs in the undo history — selection and view toggles
      // would otherwise make undo feel like it "does nothing".
      partialize: (s) => ({ nodes: s.nodes }),
      // partialize alone does not achieve that: it runs on every write and
      // hands zundo a brand-new { nodes } wrapper each time, which the default
      // Object.is comparison always reads as "changed". So a write that never
      // touched a node — the autosave stamping savedAt a second after an edit
      // is the common one — still recorded an undo step holding the identical
      // geometry, and the first Ctrl+Z after any edit visibly did nothing
      // because it was reversing that. Comparing the node list by reference is
      // what the intent above actually requires: every action here rebuilds
      // that array when, and only when, something in it really changed.
      equality: (a, b) => a.nodes === b.nodes,
      limit: 200,
    },
  ),
);

/** Subscribe to undo/redo state. zundo keeps its history in a separate store. */
export function useTemporal<T>(selector: (s: TemporalState<{ nodes: SceneNode[] }>) => T): T {
  return useStore(useDoc.temporal, selector);
}

/* ---- clipboard -------------------------------------------------------
 * Lives outside the document itself: it is not part of any design, so it
 * must never enter undo history or get written to the autosave. A plain
 * module variable does that for free — it just lives for the tab's session.
 */
let clipboard: SceneNode[] | null = null;
/** How many times Ctrl+V has fired since the last Ctrl+C, so repeated pastes
 *  step further away from the original instead of stacking exactly on it. */
let pasteRun = 0;
const PASTE_STEP: Vec3 = [8, 8, 0];

/** Ctrl+C: snapshots the current selection. Copying again replaces it. */
export function copySelected() {
  const s = useDoc.getState();
  const ids = new Set(s.selectedIds);
  const picked = s.nodes.filter((n) => ids.has(n.id));
  if (!picked.length) return;
  clipboard = picked;
  pasteRun = 0;
}

/** Ctrl+V: pastes fresh copies of whatever was last copied, selecting them. */
export function pasteClipboard() {
  if (!clipboard?.length) return;
  pasteRun++;
  const offset: Vec3 = [PASTE_STEP[0] * pasteRun, PASTE_STEP[1] * pasteRun, PASTE_STEP[2] * pasteRun];
  useDoc.getState().duplicateNodes(clipboard, offset);
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
  const s = useDoc.getState();
  const proj: ProjectData = {
    version: 1,
    id: s.currentProjectId,
    name: s.projectName,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    nodes: pending,
    camera: loadCameraState(),
  };
  const ok = saveProject(proj);
  pending = null;
  useDoc.setState(
    ok
      ? { savedAt: Date.now(), storageBlocked: false, projects: listProjects() }
      : { storageBlocked: true },
  );
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
