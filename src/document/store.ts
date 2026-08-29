import { create } from "zustand";
import { useStore } from "zustand";
import { temporal } from "zundo";
import type { TemporalState } from "zundo";
import { PRIMITIVES, isGroup } from "./types";
import { extractNodes, findNode, firstRootIndex, updateNode, walk } from "./tree";
import { bakeScale } from "./bake";
import {
  applyMatrix,
  eulerToMatrix,
  matrixToEuler,
  multiplyMatrix,
  tidy,
} from "./transform";
import {
  deleteProjectStorage,
  exportProjectFile,
  getActiveProjectId,
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
  EditOp,
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

const isPushPullOp = (op: EditOp): op is PushPullOp =>
  op.kind === undefined || op.kind === "pushPull";

const scaledPoint = (point: Vec3, scale: Vec3): Vec3 => [
  point[0] * scale[0],
  point[1] * scale[1],
  point[2] * scale[2],
];

/** A plane normal under a component-wise scale uses the inverse transpose. */
function scaledNormal(normal: Vec3, scale: Vec3): Vec3 {
  const x = normal[0] / scale[0];
  const y = normal[1] / scale[1];
  const z = normal[2] / scale[2];
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

/** Perpendicular distance produced on screen by one local millimetre. */
function distanceScale(normal: Vec3, scale: Vec3): number {
  const inverse = Math.hypot(
    normal[0] / scale[0],
    normal[1] / scale[1],
    normal[2] / scale[2],
  );
  return inverse > 1e-9 ? 1 / inverse : 1;
}

/** Re-anchors a newly requested edit after a primitive's display scale has
 * been folded into its real dimensions. Metric tool values (wall thickness,
 * edge radius and face offset) are already world millimetres and stay as-is;
 * Push/Pull is the exception because the viewport deliberately reports its
 * distance in the old local frame. */
function editAfterScaleBake(op: EditOp, scale: Vec3): EditOp {
  if (isPushPullOp(op)) {
    return {
      kind: "pushPull",
      point: scaledPoint(op.point, scale),
      normal: scaledNormal(op.normal, scale),
      distance: op.distance * distanceScale(op.normal, scale),
    };
  }
  if (op.kind === "shell") {
    return { ...op, points: op.points.map((point) => scaledPoint(point, scale)) };
  }
  if (op.kind === "resizeFace") {
    return {
      ...op,
      point: scaledPoint(op.point, scale),
      normal: scaledNormal(op.normal, scale),
    };
  }
  return {
    ...op,
    point: scaledPoint(op.point, scale),
    points: op.points?.map((point) => scaledPoint(point, scale)),
  };
}

/** Existing Push/Pull-only edits can be rebased exactly enough for ordinary
 * axis-aligned modelling. This is what lets a box be stretched long, pulled,
 * and then hollowed without the final display scale stretching its walls to
 * different thicknesses. More exotic edit histories are left untouched
 * rather than silently changing their geometry. */
function rebaseScaledPushPullEdit(node: EditNode): EditNode | null {
  const scale = node.scale;
  if (scale.every((value) => value === 1)) return node;
  if (node.base.type !== "object" || !node.ops.every(isPushPullOp)) return null;
  const proxy: ObjectNode = {
    ...node.base,
    position: node.position,
    rotation: node.rotation,
    scale,
  };
  const baked = bakeScale(proxy);
  if (!baked || baked === proxy) return null;
  const base: ObjectNode = {
    ...baked,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  };
  return {
    ...node,
    position: baked.position,
    rotation: baked.rotation,
    scale: [1, 1, 1],
    base,
    ops: node.ops.map((op) => editAfterScaleBake(op, scale)),
  };
}
const restored = activeProject.nodes;

// A numeric session counter is not safe for persisted projects. Live module
// reloads reset it, and opening/restoring a document can introduce IDs above
// its current value; the next Group then reuses an existing object's ID and
// the viewport updates that unrelated mesh. UUIDs remain unique across saved
// projects, reloads, undo restoration, and group/ungroup cycles.
const nextId = () => `n-${crypto.randomUUID()}`;

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

/**
 * Rewrites a child of `group` into the world frame, so lifting it out of the
 * group leaves it exactly where it was drawn.
 *
 * Rotation composes as matrices and comes back as angles; the child's offset
 * is scaled and rotated by the group before being added to the group's own
 * position; scales multiply per axis.
 *
 * Exact for any combination of move and rotate, which is what a group picks
 * up in ordinary use. A group that has also been SCALED is right to within
 * where its scaling centre sat: the kernel scales a shape about its own
 * bounding-box centre, and the group's centre is not the child's, a
 * difference the document cannot resolve because it holds no bounds.
 */
/**
 * Rewrites a child of `group` into the group's own frame, so lifting it out
 * leaves it exactly where it was drawn.
 *
 * Moving and turning compose as matrices. Scaling cannot: the kernel scales a
 * shape about the centre of its own bounds, so where a child lands depends on
 * both the group's centre and the child's — geometry the document does not
 * hold. Given both (see the kernel's centresOf), the placement is exact:
 *
 *   P' = Gp + R(Cg + s(Cc - Cg)) - R(Cc - Cp)
 *
 * where Cg is the group's centre in its own frame, Cc the child's centre as
 * its own transform alone would place it. Without them, a scaled group is not
 * flattened at all — the caller keeps the frame instead of guessing.
 */
function liftOutOf(
  group: GroupNode,
  child: SceneNode,
  centres?: { group?: Vec3; child?: Vec3 },
): SceneNode {
  const rotation = eulerToMatrix(group.rotation);
  const scaledGroup = group.scale.some((value) => Math.abs(value - 1) > 1e-9);
  const scaled: Vec3 =
    scaledGroup && centres?.group && centres.child
      ? (() => {
          const [cg, cc] = [centres.group!, centres.child!];
          return [0, 1, 2].map(
            (i) => cg[i] + (cc[i] - cg[i]) * group.scale[i] - (cc[i] - child.position[i]),
          ) as Vec3;
        })()
      : scaledGroup
        ? ([
          child.position[0] * group.scale[0],
          child.position[1] * group.scale[1],
          child.position[2] * group.scale[2],
        ] as Vec3)
        // The overwhelmingly common group/ungroup path has unit scale. Its
        // child position is already the exact offset we need; involving
        // bounding centres here only introduces cancellation and lets one
        // unstable boolean bound fling a child across the scene.
        : ([...child.position] as Vec3);
  const offset = applyMatrix(rotation, scaled);
  // Never let a bad number reach the document: one non-finite centre would
  // otherwise turn a position into NaN, and a node with no position never
  // builds again — the whole model disappears rather than one part moving.
  if (!offset.every(Number.isFinite)) return child;

  return {
    ...child,
    position: [
      group.position[0] + offset[0],
      group.position[1] + offset[1],
      group.position[2] + offset[2],
    ],
    rotation: tidy(matrixToEuler(multiplyMatrix(rotation, eulerToMatrix(child.rotation)))),
    scale: [
      child.scale[0] * group.scale[0],
      child.scale[1] * group.scale[1],
      child.scale[2] * group.scale[2],
    ],
  };
}

/**
 * Rewrites a node into the world frame by folding in every group it sits
 * inside, innermost first.
 *
 * Taking a node OUT of a group has the same problem as ungrouping one: its
 * stored transform is relative to the group, so re-parenting it anywhere else
 * without composing the group's own transform makes it jump. Grouping a
 * selection that reaches inside an existing group does exactly that, which is
 * how a group could rearrange the model the moment it was made.
 */
function liftToWorld(
  roots: SceneNode[],
  node: SceneNode,
  centres?: Record<string, Vec3>,
): SceneNode {
  const chain: GroupNode[] = [];
  const find = (list: SceneNode[], ancestors: GroupNode[]): boolean => {
    for (const n of list) {
      if (n.id === node.id) {
        chain.push(...ancestors);
        return true;
      }
      if (isGroup(n) && find(n.children, [...ancestors, n])) return true;
    }
    return false;
  };
  find(roots, []);
  if (!chain.length) return node;

  // Flattening is exact for moving and turning, and only for those. A group
  // that has been SCALED scales about the centre of its own bounds, and the
  // child's share of that depends on where the child's own geometry sits
  // inside itself — which the document does not know, so the child lands off
  // by (scale - 1) x its own centre offset. That is 8mm for a 20mm box in a
  // group scaled 1.8, and it is why grouping sometimes nudged parts.
  //
  // So a scaled frame is not flattened, it is kept: the child is wrapped in a
  // group carrying that same transform, which reproduces where it stood by
  // construction rather than by arithmetic.
  const flattenable = (g: GroupNode, child: SceneNode) =>
    (g.scale[0] === 1 && g.scale[1] === 1 && g.scale[2] === 1) ||
    (!!centres?.[g.id] && !!centres?.[child.id]);

  // Innermost group first: each step lifts the node one frame outwards. A
  // scaled group whose centres are unknown keeps its frame as a wrapper
  // rather than being flattened with arithmetic that cannot be right.
  return chain.reduceRight<SceneNode>(
    (carried, group) =>
      flattenable(group, carried)
        ? liftOutOf(group, carried, { group: centres?.[group.id], child: centres?.[carried.id] })
        : { ...group, id: nextId(), children: [carried], collapsed: true },
    node,
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
  addImport: (
    blobId: string,
    fileName: string,
    byteSize: number,
    svg?: { thickness: number; width: number; height: number },
  ) => void;
  /** Extrusion depth of an imported vector artwork, in mm. */
  setSvgThickness: (id: string, thickness: number) => void;
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
   *  `base`), or appends another op if it already is one.
   *
   *  `positionDelta` (world mm) is the correction that keeps the untouched
   *  side of a SCALED part still: place() scales a node about its solid's
   *  bounding-box centre, so an edit that moves that centre would otherwise
   *  slide the whole object — see pivotDrift() in viewport/scene.ts. Zero,
   *  and omitted, for unscaled parts. */
  pushPullFace: (id: string, op: PushPullOp, positionDelta?: Vec3) => void;
  /** Replaces an edit node's ops wholesale — used to permanently drop an op
   *  that can never succeed again (see the kernel's pruneDeadOps/
   *  survivingOps), not to add one (pushPullFace does that). A no-op for
   *  any node that isn't an edit. */
  setOps: (id: string, ops: EditOp[]) => void;
  /** Appends one edit op to a node, turning an ordinary object or group into
   *  an EditNode the first time. Takes any EditOp — a fillet, a chamfer, or a
   *  hollow — since the node does not care which; only the kernel's replay
   *  does. */
  finishEdit: (id: string, op: EditOp) => void;
  setHole: (id: string, isHole: boolean) => void;
  setColor: (id: string, color: string) => void;
  setTransparent: (id: string, transparent: boolean) => void;
  setGroupOp: (id: string, op: BooleanOp) => void;
  toggleCollapsed: (id: string) => void;
  rename: (id: string, name: string) => void;
  /** `centres` maps a group id to its world bounding-box centre — see
   *  ungroup(). Needed when a selection reaches inside a SCALED group, since
   *  the kernel scales about that point and the document holds no bounds. */
  group: (centres?: Record<string, Vec3>) => void;
  /** `centres` maps a group id to its world bounding-box centre, which only
   *  the viewport knows. Needed to undo a group's scaling, which the kernel
   *  applies about that point; without it a scaled group's children land
   *  wrong. Groups that were never scaled do not need it. */
  ungroup: (centres?: Record<string, Vec3>) => void;
  setShowResult: (v: boolean) => void;
  /** Clears the canvas of the active project. */
  /** Shape Builder: replaces `sourceIds` with one node holding them frozen
   *  and the chosen cell masks. Sources keep their relative placement. */
  shapeBuild: (sourceIds: string[], keep: number[], centres?: Record<string, Vec3>) => void;
  /** Puts the document back as it was — used to undo a grouping that turned
   *  out to change the model rather than just its arrangement. */
  restoreNodes: (nodes: SceneNode[], selectedIds: string[]) => void;
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

      addImport: (blobId, fileName, byteSize, svg) =>
        set((s) => {
          const node: ImportNode = {
            type: "import",
            id: nextId(),
            blobId,
            fileName,
            byteSize,
            svg,
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
            // Corner radius is a real millimetre value, not something that
            // should be stretched by the resize handles. A long box is often
            // still a 20 mm primitive carrying (say) scale [5, 1, 1]; applying
            // a radius before that scale turns its circular corners into
            // ellipses. Bake the visible box dimensions first, deliberately
            // without its old radius, then round the already-long box.
            if (
              n.kind === "box" && key === "fillet" &&
              n.scale.some((component) => Math.abs(component - 1) > 1e-4)
            ) {
              const unrounded: ObjectNode = {
                ...n,
                params: { ...n.params, fillet: 0 },
              };
              const baked = bakeScale(unrounded);
              if (baked && baked !== unrounded) {
                return {
                  ...baked,
                  params: nextParams(baked, key, value),
                };
              }
            }
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

      pushPullFace: (id, op, positionDelta) => {
        const moved = !!positionDelta &&
          positionDelta.every(Number.isFinite) &&
          positionDelta.some((d) => d !== 0);
        const shift = (p: Vec3): Vec3 =>
          moved
            ? [p[0] + positionDelta![0], p[1] + positionDelta![1], p[2] + positionDelta![2]]
            : p;
        set((s) => ({
          nodes: updateNode(s.nodes, id, (n) => {
            if (n.type === "edit") {
              const rebased = rebaseScaledPushPullEdit(n);
              const source = rebased ?? n;
              const nextOp = rebased && rebased !== n
                ? editAfterScaleBake(op, n.scale)
                : op;
              const color = source.color || source.base.color;
              const transparent = source.transparent ?? source.base.transparent;
              return {
                ...source,
                // pivotDrift is only needed while the display scale remains.
                // A successful rebase has made that scale real and reset it.
                position: rebased && rebased !== n ? source.position : shift(source.position),
                color,
                transparent,
                base: { ...source.base, color, transparent },
                ops: [...source.ops, nextOp],
              };
            }
            // Neither is parametric any more, and the UI offers push/pull on
            // neither: an import has no face topology, and a build's shape is
            // owned by its cell selection.
            if (n.type === "import" || n.type === "build") return n;
            const baked = n.type === "object" ? bakeScale(n) : null;
            const source = baked ?? n;
            const nextOp = baked && baked !== n
              ? editAfterScaleBake(op, n.scale)
              : op;
            const base: ObjectNode | GroupNode = {
              ...source,
              position: [0, 0, 0],
              rotation: [0, 0, 0],
              scale: [1, 1, 1],
            };
            const edit: EditNode = {
              type: "edit",
              id: source.id,
              name: source.name,
              position: baked && baked !== n ? source.position : shift(source.position),
              rotation: source.rotation,
              scale: source.scale,
              isHole: source.isHole,
              color: source.color,
              transparent: source.transparent,
              base,
              ops: [nextOp],
            };
            return edit;
          }),
        }));
        afterBatchedMutation();
      },

      finishEdit: (id, op) => {
        set((s) => ({
          nodes: updateNode(s.nodes, id, (n) => {
            if (n.type === "edit") {
              const rebased = rebaseScaledPushPullEdit(n);
              if (!rebased || rebased === n) return { ...n, ops: [...n.ops, op] };
              return {
                ...rebased,
                ops: [...rebased.ops, editAfterScaleBake(op, n.scale)],
              };
            }
            if (n.type === "import" || n.type === "build") return n;
            // Metric face tools have to run against the object's real size.
            // A node's scale is applied AFTER its ops, so a box stretched into
            // a rectangle and then hollowed in the old frame comes out with
            // different wall thicknesses on each axis. Fold a primitive's
            // display scale into its dimensions before its first geometry edit.
            // Existing Push/Pull-only histories take the rebase path above;
            // more exotic histories stay untouched rather than shifting old
            // geometry behind the user's back.
            const baked = n.type === "object" ? bakeScale(n) : null;
            const source = baked ?? n;
            // Baking moves the node's own frame, so an anchor captured against
            // the UNBAKED solid no longer lands on any face and the hollow
            // comes out sealed. The baked solid is the old one scaled about
            // its bounding-box centre and then re-normalised back onto z = 0;
            // work that through and the two shifts cancel exactly, leaving a
            // plain component-wise multiply.
            const placed = baked && baked !== n
              ? editAfterScaleBake(op, n.scale)
              : op;
            const base: ObjectNode | GroupNode = {
              ...source,
              position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
            };
            return {
              type: "edit", id: source.id, name: source.name,
              position: source.position, rotation: source.rotation, scale: source.scale,
              isHole: source.isHole, color: source.color, transparent: source.transparent,
              base, ops: [placed],
            } satisfies EditNode;
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

      setSvgThickness: (id, thickness) => {
        set((s) => ({
          nodes: updateNode(s.nodes, id, (n) =>
            n.type === "import" && n.svg
              ? { ...n, svg: { ...n.svg, thickness: Math.max(0.1, thickness) } }
              : n,
          ),
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
      group: (centres) =>
        set((s) => {
          if (s.selectedIds.length < 2) return {};
          const ids = new Set(s.selectedIds);
          const at = firstRootIndex(s.nodes, ids);
          const { remaining, removed } = extractNodes(s.nodes, ids);
          if (removed.length < 2) return {};

          // Preserve the order the nodes appeared in, which matters for subtract.
          const order = new Map(s.selectedIds.map((id, i) => [id, i]));
          removed.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

          // A selection can reach inside an existing group. Those nodes are
          // stored relative to it, so they have to be rewritten into world
          // terms before joining a group that knows nothing about it.
          const lifted = removed.map((n) => liftToWorld(s.nodes, n, centres));

          const groupCount = s.nodes.filter(isGroup).length + 1;
          const node: GroupNode = {
            type: "group",
            id: nextId(),
            name: `Group ${groupCount}`,
            op: "union",
            children: lifted,
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
      ungroup: (centres) =>
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
                  // Children live in the group's frame: what you see is the
                  // group's transform applied on top of each child's own (see
                  // place() in kernel/shape.ts). Handing them back untouched
                  // drops the group's half of that, so every child jumped by
                  // exactly however far the group had been moved, turned or
                  // scaled since it was made.
                  return n.children.map((child) =>
                    n.scale.every((v) => v === 1) || (centres?.[n.id] && centres?.[child.id])
                      ? liftOutOf(n, child, { group: centres?.[n.id], child: centres?.[child.id] })
                      : child,
                  );
                }
                return [{ ...n, children: expand(n.children) }];
              }
              return [n];
            });

          return { nodes: expand(s.nodes), selectedIds: lifted };
        }),

      setShowResult: (v) => set({ showResult: v }),

      shapeBuild: (sourceIds, keep, centres) =>
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
          // Same as grouping: a source taken out of a group carries that
          // group's transform with it or it moves.
          const sources = removed.map((n) => liftToWorld(s.nodes, n, centres));

          const buildCount = s.nodes.filter((n) => n.type === "build").length + 1;
          const node: BuildNode = {
            type: "build",
            id: nextId(),
            name: `Built ${buildCount}`,
            sources,
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

      restoreNodes: (nodes, selectedIds) => set({ nodes, selectedIds }),

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
