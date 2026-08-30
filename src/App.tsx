import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as THREE from "three";
import { EXPORT_WATCHDOG_MS, kernel, KernelTimeoutError, WATCHDOG_MS } from "./kernel/client";
import { Viewport } from "./viewport/Viewport";
import { Inspector } from "./ui/Inspector";
import { Tree } from "./ui/Tree";
import { DropIcon, MagnetIcon, ShapeBuilderIcon, SolidCubeIcon, TransparencyIcon, WireframeIcon, ZoomToFitIcon } from "./ui/icons";
import { ProjectsModal } from "./ui/ProjectsModal";
import { buildThreeMF } from "./export/threemf";
import { SvgImportModal } from "./ui/SvgImportModal";
import { TextModal } from "./ui/TextModal";
import type { TextConfig } from "./ui/TextModal";
import { NO_FONT_LISTING } from "./text/systemFonts";
import type { LocalFontData } from "./text/systemFonts";
import {
  beginHistoryBatch,
  copySelected,
  endHistoryBatch,
  pasteClipboard,
  useDoc,
  useTemporal,
} from "./document/store";
import { MAX_BUILD_SOURCES, PRIMITIVES, isGroup } from "./document/types";
import { findNode, parentOf, resolveNodeTransparent, resolveNodeColor } from "./document/tree";
import { putBlob } from "./document/blobStore";
import { loadCameraState } from "./document/persist";
import type { GroupNode, PrimitiveKind, SceneNode, Vec3 } from "./document/types";
import { RETRYABLE_MESH_ERROR } from "./kernel/types";
import type { EditSpec, ExportQuality, NodeSpec, PreviewBuild, ScenePart } from "./kernel/types";
import type { CameraMode, Scene, ToolMode, WireframeMode } from "./viewport/scene";
import { APP_NAME, APP_VERSION } from "./version";

/** Shown when Hollow is pressed with nothing selected; cleared as soon as a
 *  face is. Named so the clearing effect can recognise its own message and
 *  leave any other error alone. */
const NEEDS_FACE = "Click a face first, then press Apply.";

const NEXT_WIREFRAME: Record<WireframeMode, WireframeMode> = {
  off: "outlined",
  outlined: "edges",
  edges: "mesh",
  mesh: "xray",
  xray: "transparent",
  transparent: "off",
};
import {
  displayedBoundsOverlap,
  displayedMeshBounds,
  displayedSceneSTL,
  localMeshBounds,
  mergeBinarySTLs,
} from "./export/stl";
import { findTouchingSeam, positionWithReferenceGap } from "./snapping/spacing";
import type { SnapAnchor, SnapAxis } from "./snapping/snap";

/** Only the fields the kernel cares about — so renaming or collapsing a node
 *  never triggers a rebuild. */
const toSpec = (n: SceneNode): NodeSpec => {
  if (isGroup(n)) {
    return {
      type: "group",
      id: n.id,
      op: n.op,
      // A hidden TOP-LEVEL node still builds normally (see NodeBase.hidden) —
      // only Scene.applyMaterials toggles its visibility, instantly, with no
      // rebuild. A hidden node NESTED in a group has no ScenePart of its own
      // to hide, since the group renders as one unioned solid; excluding it
      // here, from the boolean itself, is the only way "hidden" can mean
      // anything for it.
      children: n.children.filter((c) => !c.hidden).map(toSpec),
      position: n.position,
      rotation: n.rotation,
      scale: n.scale,
      isHole: n.isHole,
    };
  }
  if (n.type === "import") {
    return {
      type: "import",
      id: n.id,
      blobId: n.blobId,
      svg: n.svg ? { thickness: n.svg.thickness } : undefined,
      position: n.position,
      rotation: n.rotation,
      scale: n.scale,
      isHole: n.isHole,
    };
  }
  if (n.type === "build") {
    return {
      type: "build",
      id: n.id,
      sources: n.sources.map(toSpec),
      keep: n.keep,
      position: n.position,
      rotation: n.rotation,
      scale: n.scale,
      isHole: n.isHole,
    };
  }
  if (n.type === "edit") {
    return {
      type: "edit",
      id: n.id,
      base: toSpec(n.base),
      ops: n.ops,
      position: n.position,
      rotation: n.rotation,
      scale: n.scale,
      isHole: n.isHole,
    };
  }
  return {
    type: "object",
    id: n.id,
    kind: n.kind,
    params: n.params,
    position: n.position,
    rotation: n.rotation,
    scale: n.scale,
    isHole: n.isHole,
  };
};

const DEAD_PUSH_PULL_ERROR = "A pushed/pulled face could not be found after rebuilding";

/** Removes a skipped node from anywhere in the tree, not just the top level —
 *  a timed-out import nested inside a group must actually come out of that
 *  group's children, or the group (still top-level, so not itself excluded)
 *  keeps resending the exact same slow node on every rebuild. A group left
 *  with no children is dropped too, rather than sent to the kernel empty. */
function pruneSkipped(list: SceneNode[], skippedIds: Set<string>): SceneNode[] {
  const out: SceneNode[] = [];
  for (const n of list) {
    if (skippedIds.has(n.id)) continue;
    if (isGroup(n)) {
      const children = pruneSkipped(n.children, skippedIds);
      if (!children.length) continue;
      out.push(children === n.children ? n : { ...n, children });
    } else {
      out.push(n);
    }
  }
  return out;
}

/** Adds an id to a skip set without a spurious new reference when it is
 *  already there — this feeds a useEffect dependency array, so returning a
 *  fresh Set every time (even a content-identical one) would re-trigger the
 *  rebuild effect forever once a node is already skipped. */
function addSkip(prev: Set<string>, id: string): Set<string> {
  if (prev.has(id)) return prev;
  return new Set(prev).add(id);
}

/** Geometry-defining shape of a node, ignoring its own placement. A group's
 *  shape does depend on where its children sit, so those stay included. */
const shapeOf = (n: SceneNode): unknown => {
  if (isGroup(n)) {
    return [
      n.id,
      "g",
      n.op,
      // A child's hole flag affects this group's boolean, while this group's
      // own hole flag only affects its parent (or root display material).
      // A child's HIDDEN flag is the same story: toSpec drops a hidden child
      // out of this group's boolean entirely (see toSpec in this file), so
      // toggling it changes what gets built here — even though a TOP-LEVEL
      // node's own hidden flag deliberately does not appear anywhere in
      // shapeOf, since hiding one of those is a free viewport toggle with
      // nothing for the kernel to redo.
      n.children.map((c) => [shapeOf(c), c.position, c.rotation, c.scale, c.isHole, c.hidden]),
    ];
  }
  // blobId never changes for an import node, so this is stable — importSTL()
  // never re-runs just because the node moved.
  // Thickness is part of the shape for artwork, so a change to it rebuilds.
  if (n.type === "import") return [n.id, "import", n.blobId, n.svg?.thickness];
  if (n.type === "edit") return [n.id, "edit", shapeOf(n.base), n.ops];
  if (n.type === "build") return [n.id, "build", n.sources.map(shapeOf), n.keep];
  return [n.id, n.kind, n.params];
};

/** Safe to rebuild independently during an export fallback. Primitive-only
 * groups include the common box-with-sphere-Hole case, while imported scans,
 * SVG artwork, edited faces and Shape Builder results retain their already
 * verified displayed mesh instead of risking another long kernel call. */
const canRefineExportFallback = (n: SceneNode): boolean =>
  n.type === "object" || (isGroup(n) && n.children.every(canRefineExportFallback));

const EXPORT_QUALITY_KEY = "cad.exportQuality";
const EXPORT_FORMAT_KEY = "cad.exportFormat";
const SNAP_KEY = "cad.smartGuides";
const OBJECTS_PANEL_KEY = "cad.objectsPanelOpen";
const VIEW_STYLE_KEY = "cad.viewStyle";
const RESIZE_CONSTRAINED_KEY = "cad.resizeConstrained";

/** What each preset costs, so the choice is not guesswork — measured on a
 *  40x30x15 box with a 10mm spherical bowl (see EXPORT_PRESETS in worker.ts). */
const EXPORT_QUALITY_HINT: Record<ExportQuality, string> = {
  draft: "Draft — fastest, visibly faceted curves. Good for test prints.",
  standard: "Standard — faint facets on curved surfaces, exports in a moment.",
  fine: "Fine — smooth curves, but a curved part can take several seconds.",
};

type FileOperation = {
  label: string;
  startedAt: number;
  /** False while the browser is still reading/parsing the selected file. */
  waitingForScene: boolean;
  /** Opening/importing is only finished after the rebuilt scene has appeared. */
  sawSceneBusy: boolean;
};

export function App() {
  const nodes = useDoc((s) => s.nodes);
  const selectedIds = useDoc((s) => s.selectedIds);
  const savedAt = useDoc((s) => s.savedAt);
  const storageBlocked = useDoc((s) => s.storageBlocked);
  const projectName = useDoc((s) => s.projectName);

  const [projectsModalOpen, setProjectsModalOpen] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(projectName);
  useEffect(() => setTitleDraft(projectName), [projectName]);

  const {
    addPrimitive,
    addImport,
    removeSelected,
    select,
    selectMany,
    setParam,
    setTransform,
    setPositions,
    duplicateNodes,
    duplicateWithParams,
    pushPullFace,
    finishEdit,
    setOps,
    setHole,
    setSvgThickness,
    shapeBuild,
    setColor,
    setTransparent,
    setGroupOp,
    toggleCollapsed,
    toggleHidden,
    rename,
    group,
    ungroup,
    clearAll,
    renameProject,
    newProject,
    exportCurrentProject,
  } = useDoc.getState();

  // Ticks the "Saved 2m ago" label without re-rendering on every frame.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  const undo = useTemporal((s) => s.undo);
  const redo = useTemporal((s) => s.redo);
  const canUndo = useTemporal((s) => s.pastStates.length > 0);
  const canRedo = useTemporal((s) => s.futureStates.length > 0);

  const [parts, setParts] = useState<ScenePart[]>([]);
  const [exporting, setExporting] = useState(false);
  const [exportStartedAt, setExportStartedAt] = useState<number | null>(null);
  const [readyExportUrl, setReadyExportUrl] = useState<string | null>(null);
  const [exportFileName, setExportFileName] = useState<string>("model.stl");
  const [exportReadyNoticeOpen, setExportReadyNoticeOpen] = useState(false);
  const [fileOperation, setFileOperation] = useState<FileOperation | null>(null);
  const [pendingSvg, setPendingSvg] = useState<{
    file: File;
    art: import("./svg/parse").SvgOutlines;
  } | null>(null);
  const [textFonts, setTextFonts] = useState<LocalFontData[] | null>(null);
  const [textModalOpen, setTextModalOpen] = useState(false);
  /** Per-node failures, keyed by node id. */
  const [invalid, setInvalid] = useState<Record<string, string>>({});
  // A rare OCCT tessellation failure can succeed on a clean replay of the
  // exact same edit history. One automatic retry avoids leaving a transient
  // red warning in the inspector until the user reloads the whole project.
  const [meshRecoveryNonce, setMeshRecoveryNonce] = useState(0);
  const meshRecoveryRef = useRef({ shapeKey: "", attempts: 0 });
  /** Top-level node ids excluded from kernel calls after a watchdog timeout —
   *  see KernelTimeoutError. Without this, the same node would just hang the
   *  next rebuild too, forever: the retry sends the exact same input to a
   *  freshly-booted worker and gets the exact same (non-)result. Keeping the
   *  node out of what gets sent is what lets everything ELSE in the scene
   *  render again; the node itself stays visible in the tree with a warning
   *  so the user can delete or replace it. */
  const [skippedIds, setSkippedIds] = useState<Set<string>>(new Set());
  const [cameraMode, setCameraMode] = useState<CameraMode>(() => loadCameraState()?.mode ?? "perspective");
  const [toolMode, setToolMode] = useState<ToolMode>("select");
  const [pendingPrimitive, setPendingPrimitive] = useState<PrimitiveKind | null>(null);
  const [edgeSelection, setEdgeSelection] = useState<{ id: string; points: Vec3[] } | null>(null);
  const [edgeKind, setEdgeKind] = useState<"fillet" | "chamfer">("fillet");
  const [edgeDistance, setEdgeDistance] = useState(2);
  /** The face the Face tool has selected, for Hollow. Held here rather than
   *  read from the scene so the bar re-renders when the selection changes. */
  const [faceSelection, setFaceSelection] = useState<{ id: string; point: Vec3; normal: Vec3; size: number } | null>(null);
  /** The node a Hollow was just asked for. A refusal from the kernel only
   *  writes a small marker into the tree, which next to the canvas reads as
   *  the button having done nothing at all — so watch for one and say it out
   *  loud instead. */
  /** The node a face edit was just asked for. A kernel refusal only writes a
   *  small marker into the tree, which next to the canvas reads as the button
   *  having done nothing at all — so watch for one and say it out loud. Any
   *  face edit, not just Hollow: an inset too big for the face failed exactly
   *  as silently. */
  const [editPending, setEditPending] = useState<string | null>(null);
  /**
   * The last face that WAS selected, kept even after the scene lets go of it.
   *
   * Clicking a face opens the push/pull pill and focuses it. Pressing a button
   * then blurs that pill, which resolves the pending push/pull, which clears
   * scene.selectedFace — and the frame loop reports that as "no face" before
   * the button's own click handler runs. A synthetic click never shows this
   * (every event lands in one task, so no frame runs in between); a human
   * click spans frames and does. Acting on the remembered face makes the
   * ordering irrelevant.
   */
  const lastFace = useRef<{ id: string; point: Vec3; normal: Vec3; size: number } | null>(null);
  /** Which of the three things a selected face can do. One field and one
   *  button serve all of them, so the bar stays the width of the edge bar
   *  rather than growing a row of controls. */
  const [faceOp, setFaceOp] = useState<"push" | "wall" | "resize" | "offset">("push");
  /** Offset & extrude is the one face operation that needs two numbers: how
   *  far in from the edge, and how far out from there. */
  const [faceHeight, setFaceHeight] = useState(3);
  const [faceValue, setFaceValue] = useState(2);
  // Remembered the same way Snap is — whether the padlock is on is a
  // working preference (how THIS person likes to resize things), not
  // something that should reset back to locked every time the page loads.
  const [resizeConstrained, setResizeConstrained] = useState(
    () => localStorage.getItem(RESIZE_CONSTRAINED_KEY) !== "off",
  );
  const [wireframe, setWireframe] = useState<WireframeMode>(() => {
    const saved = localStorage.getItem(VIEW_STYLE_KEY) as WireframeMode | null;
    if (saved === "off" || saved === "outlined" || saved === "edges" || saved === "mesh" || saved === "xray" || saved === "transparent") {
      return saved;
    }
    return "off";
  });
  const [wireframeMenuOpen, setWireframeMenuOpen] = useState(false);
  const wireframeMenuRef = useRef<HTMLDivElement>(null);
  // The flyout itself is portalled out to <body> (see the render below) so
  // the tool rail's own overflow-y:auto — needed to scroll a tall tool list
  // — cannot clip it: setting overflow on only one axis forces the other to
  // clip too, and this menu escapes the rail horizontally. Its screen
  // position is computed from the trigger button each time it opens.
  const wireframeFlyoutRef = useRef<HTMLDivElement>(null);
  const [wireframeFlyoutPos, setWireframeFlyoutPos] = useState<{ top: number; left: number } | null>(null);
  const cycleWireframe = useCallback(() => {
    setWireframe((curr) => NEXT_WIREFRAME[curr]);
  }, []);
  const zoomToSelected = useCallback(() => {
    sceneRef.current?.zoomToFit();
  }, []);

  const placePrimitive = useCallback((point: Vec3, normal: Vec3) => {
    if (!pendingPrimitive) return;
    const n = new THREE.Vector3(...normal).normalize();
    // Every kernel primitive is normalised with its base on local Z=0.
    // Node.position stores that local origin, not the displayed bounds
    // centre (the viewport adds its pivot separately). Offsetting by half the
    // height therefore lifted a newly placed part by exactly half its size.
    const base = new THREE.Vector3(...point).addScaledVector(n, 0.001);
    const rotation = new THREE.Euler().setFromQuaternion(
      new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n),
      "XYZ",
    );
    addPrimitive(pendingPrimitive);
    const id = useDoc.getState().selectedIds[0];
    if (id) setTransform(id, {
      position: base.toArray() as Vec3,
      rotation: [rotation.x / Math.PI * 180, rotation.y / Math.PI * 180, rotation.z / Math.PI * 180],
    });
    setPendingPrimitive(null);
    setToolMode("select");
  }, [addPrimitive, pendingPrimitive, setTransform]);

  useEffect(() => {
    if (!wireframeMenuOpen) {
      setWireframeFlyoutPos(null);
      return;
    }
    const button = wireframeMenuRef.current;
    if (button) {
      const rect = button.getBoundingClientRect();
      setWireframeFlyoutPos({ top: rect.top + rect.height / 2, left: rect.right + 10 });
    }
    const onDocClick = (e: PointerEvent | MouseEvent) => {
      const target = e.target as Node;
      // Portalled to <body>, so a click inside the flyout is no longer a
      // descendant of wireframeMenuRef — it needs its own ref checked too,
      // or every click on a view-mode button would count as "outside".
      if (
        wireframeMenuRef.current && !wireframeMenuRef.current.contains(target) &&
        wireframeFlyoutRef.current && !wireframeFlyoutRef.current.contains(target)
      ) {
        setWireframeMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", onDocClick);
    return () => window.removeEventListener("pointerdown", onDocClick);
  }, [wireframeMenuOpen]);
  // Remembered like the export quality: whether you want things snapping is
  // a working preference, not a per-session one.
  const [snapEnabled, setSnapEnabled] = useState(
    () => localStorage.getItem(SNAP_KEY) !== "off",
  );
  // The Objects panel is not always wanted — a single object needs it least
  // of all — so it is a toggle, remembered the same way Snap is.
  const [objectsPanelOpen, setObjectsPanelOpen] = useState(
    () => localStorage.getItem(OBJECTS_PANEL_KEY) !== "off",
  );
  /** Shape Builder session: the ids that were decomposed, in the order the
   *  cell masks index them. Null whenever the tool is not running. */
  const [buildSources, setBuildSources] = useState<string[] | null>(null);
  const [buildBusy, setBuildBusy] = useState(false);
  const [treeChangeBusy, setTreeChangeBusy] = useState(false);
  const [buildCells, setBuildCells] = useState<{ mask: number; kept: boolean }[]>([]);
  // Remembered across sessions: which quality you want is a property of how
  // you print, not of one export.
  /** STL states no units at all, so a slicer has to guess; 3MF says
   *  millimetres outright, keeps the objects apart and carries their colours.
   *  Remembered like the quality, since it is a per-user habit. */
  const [exportFormat, setExportFormat] = useState<"stl" | "3mf">(
    () => (localStorage.getItem(EXPORT_FORMAT_KEY) === "3mf" ? "3mf" : "stl"),
  );
  useEffect(() => { localStorage.setItem(EXPORT_FORMAT_KEY, exportFormat); }, [exportFormat]);
  const [exportQuality, setExportQuality] = useState<ExportQuality>(
    () => (localStorage.getItem(EXPORT_QUALITY_KEY) as ExportQuality | null) ?? "fine",
  );
  const [gapAxis, setGapAxis] = useState<SnapAxis>("x");
  const [gapMm, setGapMm] = useState(10);
  const [fixedAnchor, setFixedAnchor] = useState<SnapAnchor>("max");
  const [movingAnchor, setMovingAnchor] = useState<SnapAnchor>("min");
  const [gapDirection, setGapDirection] = useState<-1 | 1>(1);
  const [spacingSwapped, setSpacingSwapped] = useState(false);
  // Collapsed by default — six controls plus a hint line is a lot to force
  // open the instant two objects happen to be selected, when most of the
  // time that selection is for checking size/position, not for this one
  // specific tool. A person who wants it clicks the header open.
  const [spacingOpen, setSpacingOpen] = useState(false);
  const [connectorSwapped, setConnectorSwapped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sceneBusy, setSceneBusy] = useState(false);
  const busy = sceneBusy;
  // Timestamp sceneBusy last turned true, so the "still working" hint (below)
  // only shows up once it's genuinely been a while — an ordinary rebuild
  // finishes in well under a second, and flashing a "this can take minutes"
  // note for every routine edit would just be noise. Scoped to sceneBusy
  // specifically (see above) rather than the combined busy flag, so it can't
  // be left showing a stale multi-minute stretch attributable to a
  // buildResult call the user no longer cares about.
  const [busySince, setBusySince] = useState<number | null>(null);
  const [busyNow, setBusyNow] = useState(Date.now());
  useEffect(() => {
    if (!sceneBusy) {
      setBusySince(null);
      return;
    }
    setBusySince((prev) => prev ?? Date.now());
  }, [sceneBusy]);

  // Has the kernel finished building this document even once? Only the FIRST
  // build is the scene opening; every one after it is a rebuild of an edit
  // the user just made. Without this, pulling a face put an "Opening scene"
  // dialog back up on a scene that was plainly already open.
  const hasBuilt = useRef(false);
  const [sceneOpened, setSceneOpened] = useState(false);
  useEffect(() => {
    if (sceneBusy) hasBuilt.current = true;
    else if (hasBuilt.current) setSceneOpened(true);
  }, [sceneBusy]);

  // Keep the elapsed-time readout moving for every long-running operation.
  useEffect(() => {
    if (!sceneBusy && !exporting && !fileOperation) return;
    setBusyNow(Date.now());
    const t = setInterval(() => setBusyNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [sceneBusy, exporting, fileOperation]);

  // Project/file opening begins before the document changes, then continues
  // through the asynchronous kernel rebuild. Keep its progress card visible
  // until that rebuild has genuinely finished (and briefly handle an empty
  // project, which has no build phase at all).
  useEffect(() => {
    if (!fileOperation) return;
    // File reads do not have kernel progress events. Do not let the empty-
    // project fallback below dismiss the card while a large file is still
    // being read or parsed.
    if (!fileOperation.waitingForScene) return;
    if (sceneBusy && !fileOperation.sawSceneBusy) {
      setFileOperation((current) => current ? { ...current, sawSceneBusy: true } : null);
      return;
    }
    if (!sceneBusy && fileOperation.sawSceneBusy) {
      const t = window.setTimeout(() => setFileOperation(null), 250);
      return () => window.clearTimeout(t);
    }
    if (!sceneBusy && busyNow - fileOperation.startedAt > 1200) {
      setFileOperation(null);
    }
  }, [sceneBusy, fileOperation, busyNow]);

  const saveLabel = storageBlocked
    ? "⚠ Autosave unavailable — this browser is blocking local storage."
    : savedAt
      ? `Saved ${timeAgo(savedAt, now)}`
      : nodes.length
        ? "Saving…"
        : "Autosaves to this browser";

  const selected = selectedIds.length ? findNode(nodes, selectedIds[selectedIds.length - 1]) : null;
  // A compound shape (group/edit/build/import) has no width/depth/height
  // parameter to read the way a primitive does — its real size only exists
  // in its evaluated mesh. Measured in the node's own LOCAL frame (before
  // scale/rotation/position), matching exactly what a primitive's raw
  // parameter already describes, so the Inspector can show it the same way:
  // an editable millimetre field, not a bare percentage.
  const selectedLocalSize = useMemo((): Vec3 | null => {
    if (!selected) return null;
    const part = parts.find((p) => p.id === selected.id);
    if (!part) return null;
    const bounds = localMeshBounds(part.mesh);
    if (!bounds) return null;
    const size = bounds.max.map((v, i) => v - bounds.min[i]) as Vec3;
    return size.every((v) => v > 1e-6) ? size : null;
  }, [selected, parts]);
  // Multi-select has no single node to read a Size/Position from the way one
  // selected object (or a Group, which IS one node) does. Its own combined
  // WORLD bounding box is the only real answer — the same box the resize
  // cage already draws around a multi-selection (see Scene.
  // getSelectionBounds) — so this is that same computation done in plain
  // React state instead of read off the live viewport, to stay reactive the
  // same way selectedLocalSize above already is. Null below 2 selected, or
  // once none of them have a built mesh yet.
  const selectionBounds = useMemo((): { min: Vec3; max: Vec3 } | null => {
    if (selectedIds.length < 2) return null;
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    let count = 0;
    for (const id of selectedIds) {
      const node = findNode(nodes, id);
      const part = parts.find((p) => p.id === id);
      if (!node || node.hidden || !part) continue;
      const bounds = displayedMeshBounds(part.mesh, node);
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], bounds.min[axis]);
        max[axis] = Math.max(max[axis], bounds.max[axis]);
      }
      count++;
    }
    return count > 0 && min.every(Number.isFinite) ? { min, max } : null;
  }, [selectedIds, nodes, parts]);
  // Scales every selected object about the selection's own shared box
  // centre — see Scene.resizeSelectionAxis for the actual maths, the same
  // the multi-target resize DRAG already applies live. One undo step for
  // however many objects that touches, matching setPositions's own align-
  // click precedent.
  const resizeSelectionAxis = useCallback(
    (axis: 0 | 1 | 2, mm: number) => {
      const updates = sceneRef.current?.resizeSelectionAxis(axis, mm, resizeConstrained) ?? [];
      if (!updates.length) return;
      beginHistoryBatch();
      for (const { id, scale, position } of updates) setTransform(id, { scale, position });
      endHistoryBatch();
    },
    [resizeConstrained, setTransform],
  );
  // Translates the whole selection as one rigid body so its shared box
  // centre lands on the typed value — everything keeps its size and its
  // position relative to the rest of the selection.
  const moveSelectionAxis = useCallback(
    (axis: 0 | 1 | 2, mm: number) => {
      const updates = sceneRef.current?.moveSelectionAxis(axis, mm) ?? [];
      if (!updates.length) return;
      beginHistoryBatch();
      for (const { id, position } of updates) setTransform(id, { position });
      endHistoryBatch();
    },
    [setTransform],
  );
  const canGroup = selectedIds.length >= 2;
  const canUngroup = selectedIds.some((id) => {
    const n = findNode(nodes, id);
    return !!n && isGroup(n);
  });
  const spacingSelection = useMemo(() => {
    if (selectedIds.length !== 2) return null;
    const fixedId = selectedIds[spacingSwapped ? 1 : 0];
    const movingId = selectedIds[spacingSwapped ? 0 : 1];
    const fixedNode = findNode(nodes, fixedId);
    const movingNode = findNode(nodes, movingId);
    const fixedPart = parts.find((p) => p.id === fixedId);
    const movingPart = parts.find((p) => p.id === movingId);
    return fixedNode && movingNode && fixedPart && movingPart
      ? { fixedNode, movingNode, fixedPart, movingPart }
      : null;
  }, [nodes, parts, selectedIds, spacingSwapped]);

  useEffect(() => setSpacingSwapped(false), [selectedIds[0], selectedIds[1]]);

  // Only offers this between two TOP-LEVEL objects: meshBounds reads
  // position/rotation/scale as world-space, which is only true at the root —
  // a node nested in a group stores those relative to it (see liftToWorld's
  // own doc comment). `nodes.find` (not the recursive findNode) is what
  // enforces that restriction here.
  const connectorSeam = useMemo(() => {
    if (selectedIds.length !== 2) return null;
    const aId = selectedIds[connectorSwapped ? 1 : 0];
    const bId = selectedIds[connectorSwapped ? 0 : 1];
    const plugNode = nodes.find((n) => n.id === aId);
    const socketNode = nodes.find((n) => n.id === bId);
    const plugPart = parts.find((p) => p.id === aId);
    const socketPart = parts.find((p) => p.id === bId);
    if (!plugNode || !socketNode || !plugPart || !socketPart) return null;
    const seam = findTouchingSeam(plugNode, plugPart.mesh, socketNode, socketPart.mesh);
    return seam ? { plugNode, socketNode, seam } : null;
  }, [nodes, parts, selectedIds, connectorSwapped]);

  useEffect(() => setConnectorSwapped(false), [selectedIds[0], selectedIds[1]]);

  // Builds a Plug + Socket pair centred on the shared wall between two
  // touching objects and fuses each straight into its own part — a Group
  // (union) around [plugNode, plug] and another around [socketNode, socket]
  // (the socket held as isHole so that union actually subtracts it). Both
  // connectors get the exact same position and rotation, the same trick
  // "Copy as matching Socket/Plug" already relies on to keep a pair aligned,
  // just computed from the wall instead of copied from an existing node.
  const addConnectorJoint = useCallback(() => {
    if (!connectorSeam) return;
    const { plugNode, socketNode, seam } = connectorSeam;
    const { point, normal, footprint } = seam;

    // Same face-normal-to-rotation convention placePrimitive uses when a
    // shape is dropped onto a clicked face: local +Z lands on `normal`, so
    // the connector sits flush on the plug side and protrudes toward the
    // socket side.
    const rotation = new THREE.Euler().setFromQuaternion(
      new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...normal)),
      "XYZ",
    );
    const rotationDeg: Vec3 = [
      (rotation.x / Math.PI) * 180,
      (rotation.y / Math.PI) * 180,
      (rotation.z / Math.PI) * 180,
    ];

    // Round pin only — a dovetail can only be assembled by sliding it in
    // from an open edge (the flare that stops it pulling straight out is
    // exactly what stops it going in any other way), and a wall's centre,
    // which is all this tool can place anything at without the user
    // pointing at a specific edge themselves, is never that. A pin pushes
    // straight in instead, so it has no such requirement and works
    // anywhere on a flat wall.
    const wallSize = Math.min(footprint[0], footprint[1]);
    const clampSize = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    const sizeParams: Record<string, number> = {
      shape: 1,
      radius: clampSize(wallSize * 0.22, 2.5, 15),
      length: clampSize(wallSize * 0.55, 6, 35),
    };

    beginHistoryBatch();

    addPrimitive("connector");
    const plugConnId = useDoc.getState().selectedIds[0];
    if (plugConnId) {
      setTransform(plugConnId, { position: point, rotation: rotationDeg });
      for (const [k, v] of Object.entries(sizeParams)) setParam(plugConnId, k, v);
      setParam(plugConnId, "fit", 0);
      selectMany([plugNode.id, plugConnId], false);
      group();
    }

    addPrimitive("connector");
    const socketConnId = useDoc.getState().selectedIds[0];
    if (socketConnId) {
      setTransform(socketConnId, { position: point, rotation: rotationDeg });
      for (const [k, v] of Object.entries(sizeParams)) setParam(socketConnId, k, v);
      setParam(socketConnId, "fit", 1);
      setHole(socketConnId, true);
      selectMany([socketNode.id, socketConnId], false);
      group();
    }

    endHistoryBatch();
  }, [connectorSeam, addPrimitive, setTransform, setParam, setHole, selectMany, group]);

  // Deleting a skipped node should let its id go, not leak it for the rest
  // of the session — otherwise re-importing the same file under a new node
  // would still work (blobId is what actually gets skipped nowhere; only the
  // node id is), but the stale entry would just sit here doing nothing.
  useEffect(() => {
    setSkippedIds((prev) => {
      const live = new Set(nodes.map((n) => n.id));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [nodes]);

  const applyGap = useCallback(() => {
    if (!spacingSelection || !Number.isFinite(gapMm)) return;
    const position = positionWithReferenceGap(
      spacingSelection.fixedNode,
      spacingSelection.fixedPart.mesh,
      spacingSelection.movingNode,
      spacingSelection.movingPart.mesh,
      gapAxis,
      fixedAnchor,
      movingAnchor,
      Math.max(0, gapMm),
      gapDirection,
    );
    setTransform(spacingSelection.movingNode.id, { position });
  }, [fixedAnchor, gapAxis, gapDirection, gapMm, movingAnchor, setTransform, spacingSelection]);

  // Nodes actually sent to the kernel — skippedIds excludes anything a
  // watchdog timeout already blamed, so it is not retried into another hang.
  const buildableNodes = useMemo(
    () => pruneSkipped(nodes, skippedIds),
    [nodes, skippedIds],
  );

  // Rebuild only when geometry-defining data changes. Dragging a top-level node
  // changes its position, which the viewport applies itself without the kernel.
  const shapeKey = useMemo(() => JSON.stringify(buildableNodes.map(shapeOf)), [buildableNodes]);

  const sceneRef = useRef<Scene | null>(null);
  // A prepared STL is valid only for the exact document and quality used to
  // create it. The revision also catches a change made while export is still
  // running, before there is a URL for the invalidation effect to clear.
  const exportSceneRevisionRef = useRef(0);
  useEffect(() => {
    exportSceneRevisionRef.current += 1;
    setReadyExportUrl(null);
    setExportReadyNoticeOpen(false);
  }, [nodes, skippedIds, exportQuality]);
  useEffect(() => () => {
    if (readyExportUrl) URL.revokeObjectURL(readyExportUrl);
  }, [readyExportUrl]);
  useEffect(() => {
    if (!exportReadyNoticeOpen) return;
    const timer = window.setTimeout(() => setExportReadyNoticeOpen(false), 10_000);
    return () => window.clearTimeout(timer);
  }, [exportReadyNoticeOpen]);
  // Group/ungroup performs two asynchronous kernel measurements around the
  // document mutation. Never allow another tree change to interleave with
  // that sequence: an older check can otherwise restore a newer tree and
  // leave one child expressed in the wrong coordinate frame.
  const treeChangeBusyRef = useRef(false);
  const toolModeRef = useRef<ToolMode>("select");
  toolModeRef.current = toolMode;
  const buildId = useRef(0);
  const textFontInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  // A slider fires far more onChange events than there are meaningful
  // rebuilds worth doing — a short debounce coalesces a drag's burst into one
  // request shortly after it settles. 32ms is under a frame at 30fps, so it
  // still reads as live. The kernel-side per-node cache (see worker.ts) is
  // the fix for cost scaling with total object count; this cuts how often we
  // even ask, on top of that.
  useEffect(() => {
    if (meshRecoveryRef.current.shapeKey !== shapeKey) {
      meshRecoveryRef.current = { shapeKey, attempts: 0 };
    }
    const specs = pruneSkipped(useDoc.getState().nodes, skippedIds).map(toSpec);
    if (!specs.length) {
      setParts([]);
      setInvalid((prev) => (skippedIds.size ? prev : {}));
      return;
    }
    const id = ++buildId.current;
    const t = setTimeout(() => {
      setSceneBusy(true);
      kernel
        .buildScene(specs)
        .then((res) => {
          if (id !== buildId.current) return;
          setParts(res.parts);
          const hasRetryableMeshError = res.errors.some((issue) =>
            issue.message.startsWith(RETRYABLE_MESH_ERROR),
          );
          const retryMeshBuild = hasRetryableMeshError && meshRecoveryRef.current.attempts < 1;
          if (retryMeshBuild) meshRecoveryRef.current.attempts += 1;
          const visibleErrors = retryMeshBuild
            ? res.errors.filter((issue) => !issue.message.startsWith(RETRYABLE_MESH_ERROR))
            : res.errors;
          setInvalid((prev) => ({
            // Keep any skipped-node warnings already showing — this build
            // never even sent them, so it has no opinion on them.
            ...Object.fromEntries([...skippedIds].map((sid) => [sid, prev[sid]])),
            ...Object.fromEntries(visibleErrors.map((e) => [e.id, e.message])),
          }));
          setError(null);

          if (retryMeshBuild) {
            window.setTimeout(() => {
              if (id === buildId.current) setMeshRecoveryNonce((value) => value + 1);
            }, 120);
          }

          // A failed push/pull op has already been skipped by the kernel, so
          // leaving it in the document cannot affect the visible shape — it
          // only makes the same warning reappear on every future rebuild.
          // Verify the edit history has not changed while the repair runs,
          // then permanently retain only the operations the kernel can still
          // resolve. This is the automatic equivalent of the Inspector's
          // existing "Remove broken edit" action.
          for (const issue of res.errors) {
            if (!issue.message.startsWith(DEAD_PUSH_PULL_ERROR)) continue;
            const failed = findNode(useDoc.getState().nodes, issue.id);
            if (!failed || failed.type !== "edit") continue;
            const failedSpec = toSpec(failed) as EditSpec;
            const expectedOps = JSON.stringify(failed.ops);
            void kernel.pruneDeadOps(failedSpec).then((kept) => {
              const current = findNode(useDoc.getState().nodes, issue.id);
              if (
                kept && current?.type === "edit" &&
                JSON.stringify(current.ops) === expectedOps &&
                kept.length < current.ops.length
              ) {
                setOps(current.id, kept);
              }
            }).catch(() => {
              // Keep the warning and manual repair button if validation itself
              // cannot complete; never remove an operation speculatively.
            });
          }
        })
        .catch((e: unknown) => {
          if (id !== buildId.current) return;
          if (e instanceof KernelTimeoutError) {
            if (e.nodeId) {
              setInvalid((prev) => ({ ...prev, [e.nodeId!]: e.message }));
              setSkippedIds((prev) => addSkip(prev, e.nodeId!));
            } else {
              setError(e.message);
            }
          } else {
            setError(msg(e));
          }
        })
        .finally(() => {
          if (id === buildId.current) setSceneBusy(false);
        });
    }, 32);
    return () => clearTimeout(t);
  }, [shapeKey, skippedIds, meshRecoveryNonce]);


  useEffect(() => {
    try {
      localStorage.setItem(SNAP_KEY, snapEnabled ? "on" : "off");
    } catch {
      // Private mode / blocked storage: the choice just won't be remembered.
    }
  }, [snapEnabled]);

  useEffect(() => {
    try {
      localStorage.setItem(RESIZE_CONSTRAINED_KEY, resizeConstrained ? "on" : "off");
    } catch {
      // Private mode / blocked storage: the choice just won't be remembered.
    }
  }, [resizeConstrained]);

  useEffect(() => {
    try {
      localStorage.setItem(OBJECTS_PANEL_KEY, objectsPanelOpen ? "on" : "off");
    } catch {
      // Private mode / blocked storage: the choice just won't be remembered.
    }
  }, [objectsPanelOpen]);

  useEffect(() => {
    try {
      localStorage.setItem(EXPORT_QUALITY_KEY, exportQuality);
    } catch {
      // Private mode / blocked storage: the choice just won't be remembered.
    }
  }, [exportQuality]);

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_STYLE_KEY, wireframe);
    } catch {
      // Private mode / blocked storage: the choice just won't be remembered.
    }
  }, [wireframe]);

  const onSelect = useCallback(
    (id: string | null, additive: boolean) => select(id, additive),
    [select],
  );
  const onSelectMany = useCallback(
    (ids: string[], additive: boolean) => selectMany(ids, additive),
    [selectMany],
  );
  const onTransform = useCallback(
    (id: string, patch: Parameters<typeof setTransform>[1]) => setTransform(id, patch),
    [setTransform],
  );
  // Alt-drag: the viewport clones the Three.js view itself (for an instant
  // drag start, with no rebuild to wait for) and only needs the new node's
  // id back, to know which id to keep dragging and reporting moves for.
  const onDuplicate = useCallback(
    (id: string) => {
      const node = findNode(useDoc.getState().nodes, id);
      if (!node) return null;
      return duplicateNodes([node], [0, 0, 0])[0] ?? null;
    },
    [duplicateNodes],
  );
  // Live push/pull preview — a real kernel rebuild of just this one node
  // with the dragged distance tentatively appended, never written to the
  // document (see Scene.onPreviewPushPull's own doc comment for why this
  // exists: a live-updating shape during the drag, not just the arrow).
  // Reads useDoc.getState() directly rather than depending on `nodes`, same
  // reasoning as the debounced kernel-call effects above — a fresh read on
  // every call, not a stale one from whenever this callback was last built.
  const onPreviewPushPull = useCallback(
    async (id: string, op: { point: Vec3; normal: Vec3; distance: number }): Promise<PreviewBuild | null> => {
      const node = findNode(useDoc.getState().nodes, id);
      if (!node) return null;
      const spec: EditSpec =
        node.type === "edit"
          ? { ...(toSpec(node) as EditSpec), ops: [...node.ops, op] }
          : {
              type: "edit",
              id: node.id,
              base: toSpec(node),
              ops: [op],
              position: node.position,
              rotation: node.rotation,
              scale: node.scale,
              isHole: node.isHole,
            };
      try {
        return await kernel.previewLocal(spec);
      } catch {
        // A watchdog timeout or other transient failure — this frame's
        // preview just doesn't update; the drag itself is unaffected, and
        // the eventual commit (see onPushPull) runs through the normal,
        // fully error-handled rebuild path regardless.
        return null;
      }
    },
    [],
  );
  // "Remove broken edit": permanently drops whichever op(s) in the SELECTED
  // node's own history can no longer find their target face, instead of
  // leaving them to keep re-failing (and re-showing the same error) on
  // every future rebuild — see kernel/shape.ts's survivingOps(). Reads the
  // current selection fresh at call time rather than closing over `selected`
  // from render, same reasoning as onPreviewPushPull above.
  const onPruneDeadOps = useCallback(async () => {
    const s = useDoc.getState();
    const id = s.selectedIds[s.selectedIds.length - 1];
    const node = id ? findNode(s.nodes, id) : null;
    if (!node || node.type !== "edit") return;
    try {
      const kept = await kernel.pruneDeadOps(toSpec(node) as EditSpec);
      if (kept) {
        if (kept.length < node.ops.length) setOps(node.id, kept);
        // If every op survived, the repair action has proved that this is not
        // a broken-edit warning. An identical setOps() does not change
        // shapeKey, so the old banner otherwise remains forever even though
        // there is nothing to remove.
        setInvalid((prev) => {
          if (!(node.id in prev)) return prev;
          const next = { ...prev };
          delete next[node.id];
          return next;
        });
      }
    } catch (e) {
      setError(msg(e));
    }
  }, [setOps]);
  // A gizmo drag emits a change every frame; collapse the whole drag into one
  // undo step so undo jumps back to where the drag started.
  const onDragChange = useCallback(
    (dragging: boolean) => (dragging ? beginHistoryBatch() : endHistoryBatch()),
    [],
  );

  /** Soft cap so a huge/wrong file gives a clear message instead of hanging
   *  the tab on an import a browser tab realistically cannot chew through. */
  const MAX_IMPORT_BYTES = 200 * 1024 * 1024;

  /**
   * A real-world scanned STL (a downloaded skull, say) can carry far more
   * triangles than a browser-side WASM mesh-repair pass can chew through in
   * any reasonable time — and unlike file size, triangle count is what
   * actually drives that cost. Binary STL (the common case for anything
   * exported by a scanner or downloaded from a model site) puts the count
   * right in the header, so this catches the worst offenders BEFORE they
   * ever reach the kernel, rather than relying solely on the watchdog in
   * kernel/client.ts to notice after the fact. ASCII STL has no such shortcut
   * (its triangle count is not known without scanning the whole file) and is
   * rare for large scans in practice, so it is left to the watchdog.
   */
  const MAX_IMPORT_TRIANGLES = 1_500_000;

  /** Binary STL: 80-byte header, then a uint32 triangle count, then 50 bytes
   *  per triangle. A file whose size doesn't match that formula for the
   *  count it claims is not a binary STL (most likely ASCII) — ignored, not
   *  rejected, since ASCII files can't be triangle-counted this cheaply. */
  function peekBinaryTriangleCount(bytes: ArrayBuffer): number | null {
    if (bytes.byteLength < 84) return null;
    const view = new DataView(bytes);
    const count = view.getUint32(80, true);
    return bytes.byteLength === 84 + count * 50 ? count : null;
  }

  const importSTLFile = async (file: File) => {
    if (file.size > MAX_IMPORT_BYTES) {
      setError(`${file.name} is ${(file.size / (1024 * 1024)).toFixed(0)} MB — too large to import.`);
      return;
    }
    setFileOperation({
      label: `Opening ${file.name}`,
      startedAt: Date.now(),
      waitingForScene: false,
      sawSceneBusy: false,
    });
    try {
      if (/.svg$/i.test(file.name)) {
        // Vector artwork is parsed here, on the main thread: reading it needs
        // DOMParser, which the kernel worker does not have.
        const { parseSvg } = await import("./svg/parse");
        const art = parseSvg(await file.text());
        setFileOperation(null);
        if (!art.paths.length) {
          setError(`${file.name} has no shapes to build from — outline any text before exporting.`);
          return;
        }
        setError(null);
        setPendingSvg({ file, art });
        return;
      }

      const bytes = await file.arrayBuffer();

      if (/.3mf$/i.test(file.name)) {
        // Like SVG, parsed here rather than in the kernel: reading the package
        // needs DOMParser. Each build item becomes its own object, which is
        // the point of the format — a 3MF that holds four parts should arrive
        // as four things you can move apart, not one welded lump.
        const { parseThreeMF } = await import("./import/threemf");
        const parts = parseThreeMF(bytes, MAX_IMPORT_TRIANGLES);
        if (!parts.length) {
          setFileOperation(null);
          setError(`${file.name} has no printable objects in it.`);
          return;
        }
        for (const part of parts) {
          const partId = crypto.randomUUID();
          await putBlob(partId, part.stl);
          // Origin, not the usual fan-out: each part's vertices already sit
          // in the model's own coordinates, so this is what keeps an
          // assembly assembled.
          addImport(partId, `${part.name}.stl`, part.stl.byteLength, undefined, part.anchor);
        }
        setFileOperation((current) => current ? { ...current, waitingForScene: true } : null);
        setError(null);
        return;
      }

      const triangles = peekBinaryTriangleCount(bytes);
      if (triangles !== null && triangles > MAX_IMPORT_TRIANGLES) {
        setFileOperation(null);
        setError(
          `${file.name} has ${triangles.toLocaleString()} triangles — too complex to import here. ` +
            `Try simplifying/decimating it in a mesh tool first (aim under ${MAX_IMPORT_TRIANGLES.toLocaleString()}).`,
        );
        return;
      }
      const blobId = crypto.randomUUID();
      await putBlob(blobId, bytes);
      addImport(blobId, file.name, file.size);
      setFileOperation((current) => current ? { ...current, waitingForScene: true } : null);
      setError(null);
    } catch (e) {
      setFileOperation(null);
      setError(`Could not read ${file.name}: ${msg(e)}`);
    }
  };

  const confirmSvgImport = async (config: { width: number; height: number; thickness: number }) => {
    if (!pendingSvg) return;
    const { file, art } = pendingSvg;
    setPendingSvg(null);

    setFileOperation({
      label: `Importing ${file.name}`,
      startedAt: Date.now(),
      waitingForScene: false,
      sawSceneBusy: false,
    });

    try {
      const { scaleSvgCommands } = await import("./svg/parse");
      const scaleX = art.width > 0 ? config.width / art.width : 1;
      const scaleY = art.height > 0 ? config.height / art.height : 1;
      const scaledPaths = scaleSvgCommands(art.paths, scaleX, scaleY);

      const blobId = crypto.randomUUID();
      const json = new TextEncoder().encode(JSON.stringify(scaledPaths));
      await putBlob(blobId, json.buffer as ArrayBuffer);
      addImport(blobId, file.name, file.size, {
        thickness: config.thickness,
        width: config.width,
        height: config.height,
      });
      setFileOperation((current) => current ? { ...current, waitingForScene: true } : null);
      setError(null);
    } catch (e) {
      setFileOperation(null);
      setError(`Could not import ${file.name}: ${msg(e)}`);
    }
  };

  const openTextTool = async () => {
    try {
      const { systemFonts } = await import("./text/systemFonts");
      const fonts = textFonts ?? await systemFonts();
      if (!fonts.length) throw new Error("No system fonts were returned.");
      setTextFonts(fonts);
      setTextModalOpen(true);
      setError(null);
    } catch (e) {
      const reason = msg(e);
      // queryLocalFonts is Chromium-only. In Firefox and Safari there is no
      // permission to grant, so telling the user to allow font access sent
      // them hunting for a setting that does not exist. Offer the route that
      // works in every browser instead: point at a font file.
      if (reason.includes(NO_FONT_LISTING)) {
        // Open the dialog with an empty font list rather than firing an OS
        // file picker straight at the user — reported as "it shows open
        // dialog and wants me to open fonts". The dialog explains why there
        // is no list and offers the picker as a deliberate choice.
        setTextFonts([]);
        setTextModalOpen(true);
        setError(null);
        return;
      }
      setError(`Could not access system fonts: ${reason} Allow font access in the browser and try again.`);
    }
  };

  /** The everywhere-fallback: fonts chosen from disk, kept for the session so
   *  a second piece of text does not mean finding the file again. */
  const useFontFile = async (file: File) => {
    try {
      const { fontFromFile } = await import("./text/systemFonts");
      const font = fontFromFile(file);
      setTextFonts((previous) => {
        const rest = (previous ?? []).filter((f) => f.postscriptName !== font.postscriptName);
        return [...rest, font];
      });
      setTextModalOpen(true);
      setError(null);
    } catch (e) {
      setError(`Could not read ${file.name}: ${msg(e)}`);
    }
  };

  const createText = async (config: TextConfig) => {
    setTextModalOpen(false);
    setFileOperation({ label: `Creating “${config.text}”`, startedAt: Date.now(), waitingForScene: false, sawSceneBusy: false });
    try {
      const { textOutlines } = await import("./text/systemFonts");
      const art = await textOutlines(config.font, config.text, config.size);
      const blobId = crypto.randomUUID();
      const json = new TextEncoder().encode(JSON.stringify(art.paths));
      await putBlob(blobId, json.buffer as ArrayBuffer);
      addImport(blobId, `${config.text}.text`, json.byteLength, {
        thickness: config.thickness,
        width: art.width,
        height: art.height,
      });
      setFileOperation((current) => current ? { ...current, waitingForScene: true } : null);
      setError(null);
    } catch (e) {
      setFileOperation(null);
      setError(`Could not create text: ${msg(e)}`);
    }
  };

  const downloadReadySTL = () => {
    if (!readyExportUrl) return;
    const a = document.createElement("a");
    a.href = readyExportUrl;
    a.download = exportFileName || "model.stl";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setExportReadyNoticeOpen(false);
    setReadyExportUrl(null);
  };

  const exportSTL = async () => {
    if (exporting) return;
    // The download click must happen inside a fresh user gesture. The first
    // click prepares the Blob; the ready dialog or header button supplies that
    // second click after even a long-running export.
    if (readyExportUrl) {
      downloadReadySTL();
      return;
    }
    setExporting(true);
    setExportStartedAt(Date.now());
    setError(null);
    setExportReadyNoticeOpen(false);
    const finishExport = async (blob: Blob) => {
      setReadyExportUrl(URL.createObjectURL(blob));
      setExportReadyNoticeOpen(true);
    };

    try {
      let exportRevision = exportSceneRevisionRef.current;
      const docNodes = useDoc.getState().nodes;
      const activeSelection = useDoc.getState().selectedIds;

      let exportNodes: SceneNode[];
      if (activeSelection.length > 0) {
        const matched: SceneNode[] = [];
        for (const id of activeSelection) {
          const node = findNode(docNodes, id);
          if (node && !matched.some((n) => n.id === node.id)) {
            matched.push(node);
          }
        }
        exportNodes = matched.length > 0 ? matched : docNodes;
      } else {
        // Exporting the whole scene leaves out anything hidden — a hidden
        // object is being kept out of the way, not asked to be printed. An
        // EXPLICIT selection above is a different signal: picking a hidden
        // object by name in the tree and pressing Export means export it, so
        // that branch never filters on hidden.
        exportNodes = docNodes.filter((n) => !n.hidden);
      }

      let currentNodes = pruneSkipped(exportNodes, skippedIds);
      if (currentNodes.length === 0) {
        setExporting(false);
        setError("No shapes available to export.");
        return;
      }

      let baseName = projectName.trim() || "model";
      if (activeSelection.length === 1) {
        const single = findNode(docNodes, activeSelection[0]);
        if (single?.name) {
          baseName = single.name.trim();
        }
      } else if (activeSelection.length > 1) {
        baseName = `${baseName}-selected`;
      }
      const safeName = baseName.replace(/[^a-zA-Z0-9_-]/g, "_") || "model";
      setExportFileName(`${safeName}.${exportFormat}`);

      if (exportFormat === "3mf") {
        // One object per shape rather than the single fused body an STL gets,
        // each keeping the name and colour it has in the tree.
        const meshes = await kernel.exportMeshes(currentNodes.map(toSpec), exportQuality);
        if (!meshes.length) {
          setExporting(false);
          setError("Nothing solid to export — every shape in the selection is a hole.");
          return;
        }
        const named = meshes.map((mesh) => {
          const node = findNode(docNodes, mesh.id);
          return {
            name: node?.name ?? "Shape",
            color: resolveNodeColor(node),
            vertices: mesh.vertices,
            triangles: mesh.triangles,
          };
        });
        await finishExport(buildThreeMF(named));
        setExporting(false);
        return;
      }

      // Always export from the kernel, even for a single object. Re-using the
      // mesh already on screen is faster, but the viewport mesh is built at
      // EDIT_QUALITY and inherits whatever tessellation cracks that pass left
      // — measured on a reported model, exporting the displayed mesh produced
      // an STL with 29 open edges. The saved file is the one artifact of this
      // app that has to be right, so it gets the export-quality, healed path
      // (see blobSTLOf in worker.ts); the worker's own result cache is what
      // keeps that fast.
      let blob: Blob | null;
      try {
        blob = await kernel.exportSTL(currentNodes.map(toSpec), exportQuality);
      } catch (e) {
        if (!(e instanceof KernelTimeoutError) || !e.nodeId) throw e;

        // The high-detail merged export can spend minutes rebuilding one
        // complicated history even though its verified editing mesh is
        // already on screen. Preserve every visible root as an STL shell
        // instead of excluding the blamed object. Internal group holes and
        // booleans are already baked into each displayed root mesh.
        const timedOutId = e.nodeId;
        const timedOutNode = findNode(useDoc.getState().nodes, timedOutId);
        const fallbackItems = currentNodes.map((node) => {
          const part = parts.find((candidate) => candidate.id === node.id);
          return part ? { node, mesh: part.mesh } : null;
        });
        const missing = fallbackItems.filter((item) => !item).length;
        if (missing) {
          throw new Error(
            `${timedOutNode?.name ?? "One object"} took too long and ${missing} visible ` +
              `shape${missing === 1 ? " was" : "s were"} not ready for the complete-scene fallback.`,
          );
        }
        const completeItems = fallbackItems.filter(
          (item): item is NonNullable<typeof item> => item !== null,
        );
        const solids = completeItems.filter(({ node }) => !node.isHole);
        const holes = completeItems.filter(({ node }) => node.isHole);
        const solidBounds = new Map(
          solids.map((item) => [item.node.id, displayedMeshBounds(item.mesh, item.node)]),
        );
        const holeBounds = new Map(
          holes.map((item) => [item.node.id, displayedMeshBounds(item.mesh, item.node)]),
        );
        const affectedSolids = solids.filter((solid) =>
          holes.some((hole) =>
            displayedBoundsOverlap(solidBounds.get(solid.node.id)!, holeBounds.get(hole.node.id)!),
          ),
        );
        const affectedIds = new Set(affectedSolids.map(({ node }) => node.id));
        const relevantHoles = holes.filter((hole) =>
          affectedSolids.some((solid) =>
            displayedBoundsOverlap(solidBounds.get(solid.node.id)!, holeBounds.get(hole.node.id)!),
          ),
        );
        const unaffectedSolids = solids.filter(({ node }) => !affectedIds.has(node.id));
        const holesFor = (solid: (typeof solids)[number]) => holes.filter((hole) =>
          displayedBoundsOverlap(solidBounds.get(solid.node.id)!, holeBounds.get(hole.node.id)!),
        );
        const refinedAffectedSolids = affectedSolids.filter(
          (solid) =>
            canRefineExportFallback(solid.node) &&
            holesFor(solid).every(({ node }) => canRefineExportFallback(node)),
        );
        const refinedAffectedIds = new Set(refinedAffectedSolids.map(({ node }) => node.id));
        const refinedHoles = holes.filter(
          (hole) =>
            canRefineExportFallback(hole.node) &&
            refinedAffectedSolids.some((solid) =>
              displayedBoundsOverlap(solidBounds.get(solid.node.id)!, holeBounds.get(hole.node.id)!),
            ),
        );
        const displayedAffectedSolids = affectedSolids.filter(
          ({ node }) => !refinedAffectedIds.has(node.id),
        );
        const displayedRelevantHoles = relevantHoles.filter((hole) =>
          displayedAffectedSolids.some((solid) =>
            displayedBoundsOverlap(solidBounds.get(solid.node.id)!, holeBounds.get(hole.node.id)!),
          ),
        );
        const refinedFallbackItems = [
          ...unaffectedSolids.filter(({ node }) => canRefineExportFallback(node)),
          ...refinedAffectedSolids,
          ...refinedHoles,
        ];
        const refinedIds = new Set(refinedFallbackItems.map(({ node }) => node.id));
        const displayedFallbackItems = unaffectedSolids.filter(
          ({ node }) => !refinedIds.has(node.id),
        );
        const fallbackBlobs: Blob[] = [];

        if (displayedFallbackItems.length) {
          fallbackBlobs.push(displayedSceneSTL(displayedFallbackItems));
        }

        if (refinedFallbackItems.length) {
          try {
            const refined = await kernel.exportRefinedSTL(
              refinedFallbackItems.map(({ node }) => toSpec(node)),
              exportQuality,
            );
            if (refined) fallbackBlobs.push(refined);
          } catch {
            // Refining primitive-only roots is an improvement, not a reason
            // to lose an otherwise complete export. Retain their verified
            // displayed shells if this optional pass cannot finish.
            fallbackBlobs.push(displayedSceneSTL(refinedFallbackItems));
          }
        }

        // Only meshes whose world-space boxes touch a Hole enter the boolean
        // fallback. A distant high-triangle scan is written directly from its
        // verified viewport mesh and cannot stall an unrelated subtraction.
        if (displayedAffectedSolids.length) {
          let drilled: Blob | null;
          try {
            drilled = await kernel.exportDisplayedSTL(
              [...displayedAffectedSolids, ...displayedRelevantHoles].map(({ node, mesh }) => ({
                spec: toSpec(node),
                mesh,
              })),
            );
          } catch (fallbackError) {
            if (fallbackError instanceof KernelTimeoutError) {
              throw new Error(
                "The visible Hole subtraction also exceeded 30 seconds. No incomplete STL was created; " +
                  "group each Hole with the solid it cuts, or simplify that affected object, then export again.",
              );
            }
            throw fallbackError;
          }
          if (!drilled) throw new Error("The visible Hole fallback did not produce an STL.");
          fallbackBlobs.push(drilled);
        }
        if (!fallbackBlobs.length) throw new Error("The complete-scene fallback produced no solids.");
        blob = fallbackBlobs.length === 1
          ? fallbackBlobs[0]
          : await mergeBinarySTLs(fallbackBlobs);
      }
      if (!blob) {
        setError("Nothing to export — add at least one solid.");
        return;
      }
      // Do not offer an already-stale download if the user edited the scene
      // while the worker was preparing it. The button naturally returns to
      // Export STL and the next click builds the current document.
      if (exportSceneRevisionRef.current !== exportRevision) return;
      await finishExport(blob);
    } catch (e) {
      if (e instanceof KernelTimeoutError && e.nodeId) {
        setInvalid((prev) => ({ ...prev, [e.nodeId!]: e.message }));
      }
      setError(msg(e));
    } finally {
      setExporting(false);
      setExportStartedAt(null);
    }
  };

  /** Transparency, TinkerCAD-style: every selected solid becomes see-through
   *  (or opaque again) together. Holes are skipped — they already render in
   *  their own material — and a child's group mirrors the change, so a shape
   *  inside a group looks the same as the identical one outside it. */
  const applyTransparent = useCallback(
    (value: boolean) => {
      const s = useDoc.getState();
      if (!s.selectedIds.length) return;
      beginHistoryBatch();
      for (const id of s.selectedIds) {
        const node = findNode(s.nodes, id);
        if (!node || node.isHole) continue;
        setTransparent(id, value);
        const parent = parentOf(s.nodes, id);
        if (parent && isGroup(parent)) setTransparent(parent.id, value);
      }
      endHistoryBatch();
    },
    [setTransparent],
  );

  /** T flips whatever the last-selected object is actually showing right now,
   *  so the whole selection lands on one state rather than each inverting. */
  const toggleTransparency = useCallback(() => {
    const s = useDoc.getState();
    if (!s.selectedIds.length) return;
    const primary = findNode(s.nodes, s.selectedIds[s.selectedIds.length - 1]);
    applyTransparent(!resolveNodeTransparent(primary));
  }, [applyTransparent]);

  const selectionTransparent = useMemo(
    () =>
      selectedIds.length
        ? resolveNodeTransparent(findNode(nodes, selectedIds[selectedIds.length - 1]))
        : false,
    [nodes, selectedIds],
  );

  // Entering Shape Builder decomposes the selection once; leaving it, by any
  // route, tears the session down. The ids are captured here because the
  // commit has to consume exactly what was decomposed, whatever the selection
  // has become by then.
  useEffect(() => {
    if (toolMode !== "build") {
      setBuildSources(null);
      sceneRef.current?.setCells(null);
      return;
    }
    const ids = useDoc.getState().selectedIds;
    const sources = ids
      .map((id) => findNode(useDoc.getState().nodes, id))
      .filter((n): n is SceneNode => !!n && !n.isHole);
    if (sources.length < 2) {
      setError("Shape Builder needs at least two overlapping shapes selected.");
      setToolMode("select");
      return;
    }
    if (sources.length > MAX_BUILD_SOURCES) {
      setError(`Shape Builder handles up to ${MAX_BUILD_SOURCES} shapes at once.`);
      setToolMode("select");
      return;
    }

    let stale = false;
    setBuildBusy(true);
    setError(null);
    kernel
      .buildCells(sources.map(toSpec))
      .then((cells) => {
        if (stale) return;
        if (!cells.length) {
          setError("Those shapes do not overlap, so there are no regions to build from.");
          setToolMode("select");
          return;
        }
        setBuildSources(sources.map((n) => n.id));
        sceneRef.current?.setCells(cells);
      })
      .catch((e: unknown) => {
        if (stale) return;
        setError(msg(e));
        setToolMode("select");
      })
      .finally(() => !stale && setBuildBusy(false));

    return () => {
      stale = true;
    };
  }, [toolMode]);

  /** "Box 1", "Sphere 1", "Box 1 + Sphere 1" — a region named by which of the
   *  source shapes contain it, which is exactly what its mask records. */
  const cellLabel = useCallback(
    (mask: number) => {
      const names = (buildSources ?? [])
        .map((id, i) => ((mask >> i) & 1 ? findNode(nodes, id)?.name ?? `Shape ${i + 1}` : null))
        .filter((n): n is string => !!n);
      return names.join(" + ");
    },
    [buildSources, nodes],
  );

  const keptCount = buildCells.filter((c) => c.kept).length;

  /** Commits the session: the kept regions become one built shape. */
  const commitBuild = useCallback(() => {
    const kept = sceneRef.current?.keptCells() ?? [];
    if (!kept.length) {
      setError("Click at least one region to put it in the shape, then press Enter.");
      return;
    }
    if (buildSources) shapeBuild(buildSources, kept);
    setToolMode("select");
  }, [buildSources, shapeBuild]);

  /** Drop (D): let the selection fall onto whatever is underneath it. The
   *  geometry that answers "what is underneath" only exists in the viewport,
   *  so the scene works out the distances and the document records them. */
  /** Ungroup needs each group's world centre, which only the viewport can
   *  measure — see the store's ungroup(). */
  /**
   * Bounding-box centres for the groups a regroup will dissolve and for the
   * nodes moving between frames — from the KERNEL, not the viewport.
   *
   * The viewport can only measure a top-level part, and only once it has
   * finished rebuilding. Group and ungroup in quick succession and the part
   * being asked about may not exist yet, which used to leave the composition
   * guessing and fling a shape across the model. The kernel can always answer,
   * for a nested child as readily as a root.
   *
   * A group is asked about with its own transform stripped, because what the
   * scaling turns around is the centre of its contents in its own frame.
   */
  const regroupCentres = useCallback(async (): Promise<Record<string, Vec3>> => {
    const { nodes, selectedIds } = useDoc.getState();
    const wanted = new Map<string, NodeSpec>();
    const isScaled = (group: GroupNode) => group.scale.some((value) => Math.abs(value - 1) > 1e-9);
    const collect = (list: SceneNode[], ancestors: GroupNode[]) => {
      for (const n of list) {
        if (selectedIds.includes(n.id) && ancestors.length) {
          const scaledAncestors = ancestors.filter(isScaled);
          if (scaledAncestors.length) wanted.set(n.id, toSpec(n));
          for (const g of scaledAncestors) {
            wanted.set(g.id, { ...toSpec(g), position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
          }
        }
        if (isGroup(n)) {
          // A group that is itself selected is about to be dissolved, so its
          // children are moving frames too. Unit-scale groups need no kernel
          // centres at all: their child offsets are already exact.
          if (selectedIds.includes(n.id) && isScaled(n)) {
            wanted.set(n.id, { ...toSpec(n), position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
            for (const child of n.children) wanted.set(child.id, toSpec(child));
          }
          collect(n.children, [...ancestors, n]);
        }
      }
    };
    collect(nodes, []);
    if (!wanted.size) return {};
    try {
      return await kernel.centresOf([...wanted.values()]);
    } catch {
      // No centres means a scaled group keeps its frame rather than being
      // flattened wrongly — see liftToWorld.
      return {};
    }
  }, []);

  /** Serialises tree changes, but never runs a whole-scene STL export merely
   * to permit Group/Ungroup. That safety check hit the same complex-object
   * watchdog as export and made the Group button appear broken for 30 seconds.
   * Frame preservation lives in the store and the worker's verified caches;
   * this lock prevents two regroup operations from interleaving. */
  const applyTreeChange = useCallback(
    async (apply: (centres: Record<string, Vec3>) => void) => {
      if (treeChangeBusyRef.current) return;
      treeChangeBusyRef.current = true;
      setTreeChangeBusy(true);
      try {
        const centres = await regroupCentres();
        apply(centres);
      } finally {
        treeChangeBusyRef.current = false;
        setTreeChangeBusy(false);
      }
    },
    [regroupCentres],
  );

  const ungroupSelected = useCallback(
    () => applyTreeChange((centres) => ungroup(centres)),
    [ungroup, applyTreeChange],
  );

  const groupSelected = useCallback(
    () => applyTreeChange((centres) => group(centres)),
    [group, applyTreeChange],
  );

  const dropSelected = useCallback(() => {
    const updates = sceneRef.current?.dropSelected() ?? [];
    if (updates.length) setPositions(updates);
  }, [setPositions]);

  // Shortcuts, ignored while typing in an input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;

      if ((e.key === "Delete" || e.key === "Backspace") && useDoc.getState().selectedIds.length) {
        e.preventDefault();
        removeSelected();
      } else if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        selectMany(useDoc.getState().nodes.map((node) => node.id));
      } else if (mod && e.key.toLowerCase() === "o") {
        e.preventDefault();
        setProjectsModalOpen(true);
      } else if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        exportCurrentProject();
      } else if (mod && e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        const name = prompt("Enter project name:", "Untitled Project");
        if (name !== null) newProject(name);
      } else if (mod && e.key.toLowerCase() === "g") {
        e.preventDefault();
        if (e.shiftKey) ungroupSelected();
        else groupSelected();
      } else if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === "c") {
        e.preventDefault();
        copySelected();
      } else if (mod && e.key.toLowerCase() === "v") {
        e.preventDefault();
        pasteClipboard();
      } else if (!mod && e.key.toLowerCase() === "v") {
        setToolMode("select");
      } else if (!mod && e.key.toLowerCase() === "f") {
        setToolMode("face");
      } else if (!mod && e.key.toLowerCase() === "e") {
        setToolMode("edge");
        setEdgeSelection(null);
      } else if (!mod && e.key.toLowerCase() === "m") {
        setToolMode("move");
      } else if (!mod && e.key.toLowerCase() === "r") {
        setToolMode("rotate");
      } else if (!mod && e.key.toLowerCase() === "a") {
        setToolMode("align");
      } else if (!mod && e.key.toLowerCase() === "t") {
        e.preventDefault();
        toggleTransparency();
      } else if (!mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setToolMode("build");
      } else if (e.key === "Enter" && useDoc.getState().selectedIds.length >= 0 && toolModeRef.current === "build") {
        e.preventDefault();
        commitBuild();
      } else if (!mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        dropSelected();
      } else if (!mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        zoomToSelected();
      } else if (!mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        setSnapEnabled((v) => !v);
      } else if (!mod && e.key.toLowerCase() === "w") {
        e.preventDefault();
        cycleWireframe();
      } else if (e.key === "Escape") {
        setPendingPrimitive(null);
        setToolMode("select");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [removeSelected, selectMany, undo, redo, group, ungroup, toggleTransparency, dropSelected, ungroupSelected, groupSelected, commitBuild, exportCurrentProject, newProject, cycleWireframe, zoomToSelected]);

  // The big card is for work the user is WAITING on: opening a file,
  // exporting, the first build of a document. A rebuild triggered by an edit
  // is not that — the shape is already on screen and the user is still
  // working — so parking a dialog over the model every time a face is pulled
  // was pure obstruction. Those get the quiet corner chip below instead.
  const sceneOpening = sceneBusy && !sceneOpened && busySince && busyNow - busySince >= 500;
  // Nagging is for as long as the problem lasts, not forever: the moment a
  // face IS selected, the note asking for one has served its purpose.
  useEffect(() => {
    if (!faceSelection) return;
    setError((current) => (current === NEEDS_FACE ? null : current));
  }, [faceSelection]);

  useEffect(() => {
    if (faceOp === "resize") setFaceValue(2);
    if (faceOp === "wall") setFaceValue(2);
    if (faceOp === "push") setFaceValue(5);
    if (faceOp === "offset") setFaceValue(2);
  }, [faceOp]);

  // Leaving Face mode is the one unambiguous "done with that face".
  useEffect(() => {
    if (toolMode !== "face") lastFace.current = null;
  }, [toolMode]);

  useEffect(() => {
    if (!editPending) return;
    const complaint = invalid[editPending];
    if (!complaint) return;
    // A dead op re-reports on EVERY rebuild, so this can easily be an older
    // edit complaining while the one just applied worked perfectly — reported
    // as "I got error message but it performed the offset anyway". Say which
    // it is, and name the cure, instead of letting it read as "your edit
    // failed".
    setError(complaint.includes("could not be found after rebuilding")
      ? `${complaint} This is an earlier edit on that object, not the one you just made — select it and press "Remove broken edit" to clear it.`
      : complaint);
    setEditPending(null);
  }, [editPending, invalid]);

  const progressLabel = exporting
    ? "Exporting STL"
    : fileOperation?.label ?? (sceneOpening ? "Opening scene" : null);
  /** An unobtrusive "still working" chip for edit rebuilds — corner of the
   *  canvas, nothing covered, no elapsed-time drama. */
  const workingLabel = !progressLabel && sceneBusy && busySince && busyNow - busySince >= 500
    ? `Updating shape · ${Math.max(0, Math.floor((busyNow - busySince) / 1000))}s`
    : null;
  const progressStartedAt = exporting
    ? exportStartedAt
    : fileOperation?.startedAt ?? busySince;
  const progressElapsed = progressStartedAt
    ? Math.max(0, Math.floor((busyNow - progressStartedAt) / 1000))
    : 0;

  return (
    <div className={`app-shell${objectsPanelOpen ? "" : " objects-collapsed"}`}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">S</span>
          <span className="brand-name">{APP_NAME}</span>
          <span className="brand-version">v{APP_VERSION}</span>
        </div>

        <div className="project-title-container">
          {isEditingTitle ? (
            <input
              type="text"
              className="project-title-input"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => {
                setIsEditingTitle(false);
                if (titleDraft.trim()) renameProject(titleDraft.trim());
                else setTitleDraft(projectName);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setIsEditingTitle(false);
                  if (titleDraft.trim()) renameProject(titleDraft.trim());
                } else if (e.key === "Escape") {
                  setIsEditingTitle(false);
                  setTitleDraft(projectName);
                }
              }}
              autoFocus
            />
          ) : (
            <button
              className="project-title-btn"
              onClick={() => setIsEditingTitle(true)}
              title="Click to rename design"
            >
              <span className="project-title-text">{projectName}</span>
              <span className="project-title-edit-icon">✏️</span>
            </button>
          )}
        </div>

        <div className="toolbar-group project-actions-group">
          <button
            onClick={() => setProjectsModalOpen(true)}
            className="projects-nav-btn"
            title="Open Projects Library (Ctrl+O)"
          >
            📁 Projects
          </button>
          <button
            onClick={() => {
              const name = prompt("Enter project name:", "Untitled Project");
              if (name !== null) newProject(name);
            }}
            title="New design (Ctrl+Alt+N)"
          >
            ＋ New
          </button>
        </div>

        <div className="toolbar-group">
          <button onClick={() => undo()} disabled={!canUndo} title="Undo (Ctrl+Z)">↶ Undo</button>
          <button onClick={() => redo()} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">↷ Redo</button>
        </div>
        <div className="toolbar-group">
          <button onClick={() => groupSelected()} disabled={!canGroup || treeChangeBusy} title="Ctrl+G">Group</button>
          <button onClick={() => ungroupSelected()} disabled={!canUngroup || treeChangeBusy} title="Ctrl+Shift+G">Ungroup</button>
        </div>
        <div className="toolbar-group view-tools">
          <button
            className={objectsPanelOpen ? "on" : ""}
            onClick={() => setObjectsPanelOpen((v) => !v)}
            title={objectsPanelOpen ? "Hide the Objects panel" : "Show the Objects panel"}
            aria-pressed={objectsPanelOpen}
          >
            Objects
          </button>
          <button className={cameraMode === "perspective" ? "on" : ""} onClick={() => setCameraMode("perspective")}>Perspective</button>
          <button className={cameraMode === "orthographic" ? "on" : ""} onClick={() => setCameraMode("orthographic")}>Ortho</button>
          <button
            className={`snap-toggle ${snapEnabled ? "on" : ""}`}
            onClick={() => setSnapEnabled((v) => !v)}
            title={
              snapEnabled
                ? "Smart Guides on — objects snap to each other while dragging (S). Hold Alt to bypass for one drag."
                : "Smart Guides off — drags go exactly where the pointer goes (S)"
            }
            aria-pressed={snapEnabled}
          >
            <MagnetIcon className="snap-icon" />
            Snap
          </button>
        </div>
        <div className="toolbar-spacer" />
        <span className={["status-pill", error ? "error" : busy || exporting || buildBusy ? "busy" : ""].filter(Boolean).join(" ")}>
          {error
            ? "Needs attention"
            : exporting
              ? "Exporting…"
              : buildBusy
                ? "Finding regions…"
                : readyExportUrl
                  ? "STL ready"
                  : busy
                    ? "Building…"
                    : "Ready"}
        </span>
        <button
          className="export-project-btn"
          onClick={exportCurrentProject}
          title="Save project file (.shapeforge) to computer (Ctrl+S)"
        >
          💾 Save File
        </button>
        <label className="export-quality" title={EXPORT_QUALITY_HINT[exportQuality]}>
          <span>Quality</span>
          <select
            value={exportQuality}
            onChange={(e) => setExportQuality(e.target.value as ExportQuality)}
            disabled={exporting}
            aria-label="STL export quality"
          >
            <option value="draft">Draft</option>
            <option value="standard">Standard</option>
            <option value="fine">Fine</option>
          </select>
        </label>
        <label className="export-quality">
          FORMAT
          <select
            value={exportFormat}
            onChange={(e) => setExportFormat(e.target.value as "stl" | "3mf")}
            disabled={exporting}
            aria-label="Export file format"
            title="STL states no units, so a slicer has to guess the scale. 3MF states millimetres, keeps each object separate and carries its colour."
          >
            <option value="stl">STL</option>
            <option value="3mf">3MF</option>
          </select>
        </label>
        <button
          className="export-btn"
          onClick={exportSTL}
          disabled={exporting}
          title={
            selectedIds.length
              ? `Export ${selectedIds.length} selected object${selectedIds.length > 1 ? "s" : ""} to ${exportFormat.toUpperCase()}`
              : `Export entire scene to ${exportFormat.toUpperCase()}`
          }
        >
          {exporting
            ? "Exporting…"
            : readyExportUrl
            ? `Download ${exportFormat.toUpperCase()}`
            : selectedIds.length === 1
            ? "Export Selected"
            : selectedIds.length > 1
            ? `Export Selected (${selectedIds.length})`
            : `Export ${exportFormat.toUpperCase()}`}
        </button>
      </header>

      {readyExportUrl && exportReadyNoticeOpen && (
        <div className="export-ready-notice" role="status" aria-live="polite">
          <div className="export-ready-icon" aria-hidden="true">✓</div>
          <div className="export-ready-copy">
            <strong>Your {exportFormat.toUpperCase()} is ready ({exportFileName})</strong>
            <span>You can download it now.</span>
          </div>
          <button className="export-ready-download" onClick={downloadReadySTL}>
            Download
          </button>
          <button
            className="export-ready-dismiss"
            onClick={() => setExportReadyNoticeOpen(false)}
            aria-label="Dismiss export notification"
            title="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      <div className="tool-rail" role="toolbar" aria-label="Design tools">
        <button
          className={toolMode === "select" ? "active" : ""}
          onClick={() => setToolMode("select")}
          title="Select and resize (V)"
          aria-label="Select tool"
        ><span className="tool-symbol cursor-symbol">➤</span></button>
        <button
          className={toolMode === "face" ? "active" : ""}
          onClick={() => setToolMode("face")}
          title="Select a face to push/pull (F)"
          aria-label="Face tool"
        >
          {/* A cube with its top face picked out — the one face lit against
              two plain ones is what distinguishes "edit a face" from the
              shape library's solid Box icon. */}
          <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M12 3 20 7.4 12 11.8 4 7.4Z" fill="currentColor" />
            <path d="M4 8.9 11.4 13v7.9L4 16.8Z" fill="currentColor" opacity=".3" />
            <path d="M20 8.9 12.6 13v7.9L20 16.8Z" fill="currentColor" opacity=".45" />
          </svg>
        </button>
        <button
          className={toolMode === "edge" ? "active" : ""}
          onClick={() => { setToolMode("edge"); setEdgeSelection(null); }}
          title="Select an edge to fillet or chamfer (E)"
          aria-label="Edge finishing tool"
        ><span className="tool-symbol">⌞</span></button>
        <button
          onClick={() => void openTextTool()}
          title="Add 3D text using an installed system font"
          aria-label="Add text tool"
        ><span className="tool-symbol text-tool-symbol">T</span></button>
        <button
          className={toolMode === "move" ? "active" : ""}
          onClick={() => setToolMode("move")}
          title="Move with axis controls (M)"
          aria-label="Move tool"
        ><span className="tool-symbol">✥</span></button>
        <button
          className={toolMode === "rotate" ? "active" : ""}
          onClick={() => setToolMode("rotate")}
          title="Rotate (R)"
          aria-label="Rotate tool"
        ><span className="tool-symbol">↻</span></button>
        <button
          className={toolMode === "align" ? "active" : ""}
          onClick={() => setToolMode("align")}
          title="Align selected objects (A)"
          aria-label="Align tool"
          disabled={selectedIds.length < 2}
        ><span className="tool-symbol">⋮</span></button>
        <button
          className={toolMode === "build" ? "active" : ""}
          onClick={() => setToolMode("build")}
          title="Shape Builder: combine overlapping shapes region by region (B)"
          aria-label="Shape Builder tool"
          disabled={selectedIds.length < 2}
        >
          <ShapeBuilderIcon />
        </button>
        {/* Not a mode — a toggle on the selection, so it sits below a rule
            rather than in the run of tools that light each other out. */}
        <span className="tool-rail-sep" />
        <button
          className={selectionTransparent ? "active" : ""}
          onClick={toggleTransparency}
          title="Make the selection see-through (T)"
          aria-label="Toggle transparency"
          aria-pressed={selectionTransparent}
          disabled={!selectedIds.length}
        >
          <TransparencyIcon />
        </button>
        <div className="tool-rail-item-container" ref={wireframeMenuRef}>
          <button
            className={wireframe !== "off" || wireframeMenuOpen ? "active" : ""}
            onClick={() => setWireframeMenuOpen((v) => !v)}
            title={
              wireframe === "outlined"
                ? "View: Outlined Solid (W) — click to toggle menu"
                : wireframe === "edges"
                ? "View: Clean Edges (W) — click to toggle menu"
                : wireframe === "mesh"
                ? "View: Full Mesh (W) — click to toggle menu"
                : wireframe === "xray"
                ? "View: X-Ray (W) — click to toggle menu"
                : wireframe === "transparent"
                ? "View: Transparent (W) — click to toggle menu"
                : "View Modes (W) — click to toggle menu"
            }
            aria-label={`View mode options, currently ${wireframe}`}
            aria-expanded={wireframeMenuOpen}
          >
            <WireframeIcon mode={wireframe} />
          </button>
          {wireframeMenuOpen && wireframeFlyoutPos && createPortal(
            <div
              ref={wireframeFlyoutRef}
              className="tool-rail-flyout"
              role="menu"
              aria-label="View modes"
              style={{ position: "fixed", top: wireframeFlyoutPos.top, left: wireframeFlyoutPos.left, transform: "translateY(-50%)" }}
            >
              <button
                className={wireframe === "off" ? "active" : ""}
                onClick={() => setWireframe("off")}
                title="Solid Shaded View"
              >
                <span className="flyout-icon"><SolidCubeIcon /></span>
                <span className="flyout-label">Solid</span>
              </button>
              <button
                className={wireframe === "outlined" ? "active" : ""}
                onClick={() => setWireframe("outlined")}
                title="Transparent-view lines with completely invisible faces"
              >
                <span className="flyout-icon"><WireframeIcon mode="outlined" /></span>
                <span className="flyout-label">Outlined</span>
              </button>
              <button
                className={wireframe === "edges" ? "active" : ""}
                onClick={() => setWireframe("edges")}
                title="Clean CAD Edges (No diagonal mesh lines)"
              >
                <span className="flyout-icon"><WireframeIcon mode="edges" /></span>
                <span className="flyout-label">Clean Edges</span>
              </button>
              <button
                className={wireframe === "mesh" ? "active" : ""}
                onClick={() => setWireframe("mesh")}
                title="Full Mesh (Original wireframe with all triangles)"
              >
                <span className="flyout-icon"><WireframeIcon mode="mesh" /></span>
                <span className="flyout-label">Full Mesh</span>
              </button>
              <button
                className={wireframe === "xray" ? "active" : ""}
                onClick={() => setWireframe("xray")}
                title="X-Ray See-Through Wireframe"
              >
                <span className="flyout-icon"><WireframeIcon mode="xray" /></span>
                <span className="flyout-label">X-Ray</span>
              </button>
              <button
                className={wireframe === "transparent" ? "active" : ""}
                onClick={() => setWireframe("transparent")}
                title="All Objects Transparent / Ghosted"
              >
                <span className="flyout-icon"><WireframeIcon mode="transparent" /></span>
                <span className="flyout-label">Transparent</span>
              </button>
            </div>,
            document.body,
          )}
        </div>
        {/* An action, not a mode and not a view toggle — its own group. */}
        <span className="tool-rail-sep" />
        <button
          onClick={zoomToSelected}
          title={selectedIds.length ? "Zoom to selected object (Z)" : "Fit all objects in view (Z)"}
          aria-label="Zoom to selected"
        >
          <ZoomToFitIcon />
        </button>
        <button
          onClick={dropSelected}
          title="Drop onto what is below (D)"
          aria-label="Drop"
          disabled={!selectedIds.length}
        >
          <DropIcon />
        </button>
      </div>

      {objectsPanelOpen && (
        <aside className="panel object-panel">
          <div className="panel-heading">
            <div>
              <h1>Objects</h1>
              <p>{nodes.length} in design</p>
            </div>
            <button
              className="icon-button"
              onClick={() => {
                if (!nodes.length || confirm("Discard this design and start a new one?")) clearAll();
              }}
              disabled={!nodes.length}
              title="New design"
            >
              ＋
            </button>
          </div>
          {nodes.length === 0 && <div className="empty-state">Add a shape from the library to begin.</div>}
          <Tree
            nodes={nodes}
            selectedIds={selectedIds}
            invalid={invalid}
            onSelect={onSelect}
            onToggleCollapsed={toggleCollapsed}
            onToggleHidden={toggleHidden}
            onRename={rename}
          />
          <div className="panel-footer">
            <span>{saveLabel}</span>
            <span>{selectedIds.length} selected</span>
          </div>
        </aside>
      )}

      <main className="workspace">
        <Viewport
          parts={parts}
          nodes={nodes}
          selectedIds={selectedIds}
          cameraMode={cameraMode}
          toolMode={toolMode}
          placementKind={pendingPrimitive}
          resizeConstrained={resizeConstrained}
          alignFixedId={spacingSelection ? spacingSelection.fixedNode.id : null}
          wireframe={wireframe}
          snapEnabled={snapEnabled}
          onSceneReady={(scene) => { sceneRef.current = scene; }}
          onCellsChanged={setBuildCells}
          onSelect={onSelect}
          onSelectMany={onSelectMany}
          onTransform={onTransform}
          onAlign={setPositions}
          onDuplicate={onDuplicate}
          onPushPull={pushPullFace}
          onPreviewPushPull={onPreviewPushPull}
          onSelectEdges={(id, points) => setEdgeSelection(id && points.length ? { id, points } : null)}
          onSelectFace={(id, point, normal, size) => {
            const next = id && point && normal ? { id, point, normal, size } : null;
            if (next) lastFace.current = next;
            setFaceSelection(next);
          }}
          onPlaceSurface={placePrimitive}
          onDragChange={onDragChange}
        />
        {toolMode === "place" && pendingPrimitive && (
          <div className="edge-bar placement-bar">
            <strong>Place {PRIMITIVES[pendingPrimitive].label}</strong>
            <span>Choose a face or the workplane</span>
            <button onClick={() => { setPendingPrimitive(null); setToolMode("select"); }}>Cancel</button>
          </div>
        )}
        {toolMode === "face" && (
          <div className="edge-bar">
            <strong>{faceSelection ? "Face selected" : "Select a face"}</strong>
            <select value={faceOp} onChange={(e) => setFaceOp(e.target.value as typeof faceOp)}>
              <option value="push">Push / pull</option>
              <option value="wall">Wall</option>
              <option value="resize">Resize face</option>
              <option value="offset">Offset &amp; extrude</option>
            </select>
            <label>
              {faceOp === "wall" ? "Thickness"
                : faceOp === "resize" ? "Inset / outset"
                : faceOp === "offset" ? "Inset"
                : "Distance"}
              <input type="number" step="0.5" value={faceValue}
                onChange={(e) => setFaceValue(Number(e.target.value) || 0)} /> mm
            </label>
            {faceOp === "offset" && (
              <label>
                Height
                <input type="number" step="0.5" value={faceHeight}
                  onChange={(e) => setFaceHeight(Number(e.target.value) || 0)} /> mm
              </label>
            )}
            <button
              title={faceOp === "wall"
                ? "Hollow this object out, leaving a wall of this thickness and opening the selected face"
                : faceOp === "resize"
                ? "Resize the selected face in its own plane: positive grows it, negative insets it"
                : faceOp === "offset"
                ? "Inset the face's own outline, then extrude it: positive height raises a rim, negative sinks a pocket"
                : "Move this face out (positive) or in (negative)"}
              // Keep focus where it is: without this the press blurs the
              // push/pull pill, which drops the face selection out from
              // under the very click trying to use it.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                // Deliberately NOT disabled without a face. A greyed-out
                // button that does nothing when clicked is indistinguishable
                // from a broken one; say what is missing instead.
                const target = faceSelection ?? lastFace.current;
                if (!target) {
                  setError(NEEDS_FACE);
                  return;
                }
                if (faceOp === "push") {
                  const travel = faceValue;
                  // The kernel ignores anything under half a millimetre, so
                  // say that rather than letting the press look ignored.
                  if (Math.abs(travel) < 0.5) {
                    setError("Type a distance of at least 0.5 mm.");
                    return;
                  }
                  setError(null);
                  if (!sceneRef.current?.pushSelectedFace(travel)) {
                    setError("Click the face again, then set the distance.");
                    return;
                  }
                  // Remember the selected face at its new location so a
                  // second typed Push/Pull does not require another click.
                  const grown = { ...target, size: target.size + travel };
                  lastFace.current = grown;
                  setFaceSelection(grown);
                  return;
                }
                const node = findNode(nodes, target.id);
                if (node && (node.type === "import" || node.type === "build")) {
                  // finishEdit returns these unchanged, which is the other
                  // way this button can look broken.
                  setError(faceOp === "wall"
                    ? node.type === "import"
                      ? "An imported shape cannot be hollowed — build the container from a box instead."
                      : "A Shape Builder result cannot be hollowed yet."
                    : "An imported or Shape Builder result cannot resize individual faces yet.");
                  return;
                }
                // Close the typed-distance pill FIRST. Left open it resolves
                // later and restores its pre-edit snapshot over the top of
                // the new shape, which looked like the wall disappearing
                // until the face was pushed or pulled.
                sceneRef.current?.dismissFaceInput();
                setError(null);
                // These three change the face's identity rather than just
                // moving it, so nothing may keep pointing at the old one.
                const releaseSelection = () => {
                  sceneRef.current?.releaseFace();
                  lastFace.current = null;
                  setFaceSelection(null);
                };
                if (faceOp === "wall") {
                  setEditPending(target.id);
                  finishEdit(target.id, {
                    kind: "shell",
                    thickness: Math.max(0.1, faceValue),
                    points: [target.point],
                  });
                  releaseSelection();
                } else if (faceOp === "offset") {
                  if (Math.abs(faceHeight) < 0.1) {
                    setError("Type a height of at least 0.1 mm — that is how far the offset face is extruded.");
                    return;
                  }
                  setEditPending(target.id);
                  finishEdit(target.id, {
                    kind: "offsetExtrude",
                    inset: faceValue,
                    height: faceHeight,
                    point: target.point,
                    normal: target.normal,
                  });
                  releaseSelection();
                } else {
                  if (Math.abs(faceValue) < 0.1) {
                    setError("Type an inset or outset of at least 0.1 mm.");
                    return;
                  }
                  setEditPending(target.id);
                  finishEdit(target.id, {
                    kind: "resizeFace",
                    offset: faceValue,
                    point: target.point,
                    normal: target.normal,
                  });
                  releaseSelection();
                }
              }}>{faceOp === "wall" ? "Hollow" : "Apply"}</button>
          </div>
        )}
        {toolMode === "edge" && (
          <div className="edge-bar">
            <strong>{edgeSelection ? `${edgeSelection.points.length} edge${edgeSelection.points.length === 1 ? "" : "s"} selected` : "Select edges"}</strong>
            <select value={edgeKind} onChange={(e) => setEdgeKind(e.target.value as "fillet" | "chamfer")}>
              <option value="fillet">Fillet</option>
              <option value="chamfer">Chamfer</option>
            </select>
            <label>
              Size
              <input type="number" min="0.1" step="0.5" value={edgeDistance}
                onChange={(e) => setEdgeDistance(Math.max(0.1, Number(e.target.value) || 0.1))} /> mm
            </label>
            <button disabled={!edgeSelection} onClick={() => {
              if (!edgeSelection) return;
              finishEdit(edgeSelection.id, {
                kind: edgeKind,
                point: edgeSelection.points[0],
                points: edgeSelection.points,
                distance: edgeDistance,
              });
              setEdgeSelection(null);
            }}>Apply</button>
          </div>
        )}
        {toolMode === "build" && !buildBusy && buildCells.length > 0 && (
          // Finishing has to be visible. Enter alone was not: Esc is the key
          // people reach for to get out of a mode, and Esc throws the session
          // away — so the work looked like it had simply not applied.
          <div className="build-bar">
            <div className="build-regions">
              <span className="build-count">
                <strong>{keptCount}</strong> of {buildCells.length} regions kept
              </span>
              {/* One toggle per region. A region enclosed inside another — the
                  half of a sphere buried in the box around it — has no visible
                  surface to click in the viewport, so this list is the only way
                  to reach it. Hovering highlights it in 3D. */}
              <div className="build-chips">
                {buildCells.map((cell) => (
                  <button
                    key={cell.mask}
                    className={`build-chip ${cell.kept ? "on" : ""}`}
                    onClick={() => sceneRef.current?.setCellKept(cell.mask, !cell.kept)}
                    onMouseEnter={() => sceneRef.current?.previewCell(cell.mask)}
                    onMouseLeave={() => sceneRef.current?.previewCell(null)}
                    title={cell.kept ? "In the shape — click to remove" : "Removed — click to put back"}
                  >
                    {cellLabel(cell.mask)}
                  </button>
                ))}
              </div>
            </div>
            <div className="build-actions">
              <button className="build-cancel" onClick={() => setToolMode("select")}>
                Cancel (Esc)
              </button>
              <button className="build-apply" onClick={commitBuild} disabled={!keptCount}>
                Build shape (Enter)
              </button>
            </div>
          </div>
        )}
        {workingLabel && (
          <div className="canvas-working" role="status">
            <span className="canvas-working-dot" aria-hidden="true" />
            {workingLabel}
          </div>
        )}
        <div className="canvas-help">
          {toolMode === "build"
            ? buildBusy
              ? "Working out the regions…"
              : "Alt-click a shape to subtract it · Click to add it back · Use the region chips below for one region at a time"
            : toolMode === "align"
            ? "Click a dot to align minimum, centre, or maximum · A Align · Esc Select"
            : toolMode === "face"
            ? faceOp === "wall"
              ? "Select the face to leave open, set a thickness, then Hollow · Esc Select · Right-drag orbit"
              : faceOp === "resize"
                ? "Select a flat face, then use a positive value to grow its outline or a negative value to inset it · Esc Select · Right-drag orbit"
                : "Click a flat face, then drag its arrow or type a distance to push/pull · Esc Select · Right-drag orbit"
            : toolMode === "edge"
            ? "Click edges to add or remove them · Choose Fillet or Chamfer, then Apply · Esc Select · Right-drag orbit"
            : "V Select · F Face · M Move · R Rotate · A Align · Z Zoom · T Transparent · W Wireframe · D Drop · S Snapping · Drag an object to move it · Alt-drag duplicate · Shift-drag straight · Right-drag orbit"}
        </div>
        {/* One centred stack. The progress card and the slow-file warning
            were each pinned to top: 14px of their own, so whichever drew
            second simply covered the other — reported as "the opening dialog
            covers the other dialog". */}
        <div className="canvas-banners">
          {progressLabel && (
            <div
              className="operation-progress"
              role="progressbar"
              aria-label={progressLabel}
              aria-valuetext={`${progressElapsed} seconds elapsed`}
            >
              <div className="operation-progress-heading">
                <strong>{progressLabel}</strong>
                <span>{progressElapsed}s elapsed</span>
              </div>
              <div className="operation-progress-track" aria-hidden="true">
                <span />
              </div>
              <small>
                {exporting && progressElapsed >= Math.round(EXPORT_WATCHDOG_MS / 1000)
                  ? "Switching to the complete visible-mesh fallback…"
                  : progressElapsed >= 8
                  ? exporting
                    ? `High-detail export gets ${Math.round(EXPORT_WATCHDOG_MS / 1000)}s before the complete fallback.`
                    : `Complex models can take up to ${Math.round(WATCHDOG_MS / 60_000)} min.`
                  : "Preparing geometry…"}
              </small>
            </div>
          )}
          {error && <div className="canvas-error">{error}</div>}
          {/* Only while a FILE is opening. During an ordinary edit this read
              as a warning about a file the user was not opening. */}
          {!error && progressLabel && !exporting && busySince && busyNow - busySince > 8000 && (
            <div className="canvas-notice">
              Large or complex files can take a few minutes. ShapeForge will stop after {Math.round(WATCHDOG_MS / 60_000)} min.
            </div>
          )}
        </div>
      </main>

      <aside className="panel tools-panel">
        <section className="tool-section shape-library">
          <div className="panel-heading compact">
            <div><h1>Shape library</h1><p>Drag or click to add</p></div>
          </div>
          <div className="shape-grid">
            {(Object.keys(PRIMITIVES) as PrimitiveKind[]).map((kind) => (
              <button key={kind} className={`shape-card ${pendingPrimitive === kind ? "active" : ""}`} onClick={() => {
                setPendingPrimitive(kind);
                setToolMode("place");
                select(null);
              }}>
                <span className={`shape-icon shape-${kind}`} />
                <span>{PRIMITIVES[kind].label}</span>
              </button>
            ))}
          </div>
          <button className="import-btn" onClick={() => importInputRef.current?.click()}>↑ Import STL, 3MF or SVG</button>
        </section>
        <input
          ref={textFontInputRef}
          type="file"
          accept=".ttf,.otf,.woff,font/ttf,font/otf,font/woff"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = ""; // so picking the same file twice still fires onChange
            if (file) void useFontFile(file);
          }}
        />
        <input
          ref={importInputRef}
          type="file"
          accept=".stl,.3mf,.svg,image/svg+xml,model/3mf,model/stl,model/x.stl-binary,model/x.stl-ascii"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = ""; // so picking the same file twice still fires onChange
            if (file) void importSTLFile(file);
          }}
        />
        <section className="tool-section inspector-section">
          <div className="panel-heading compact">
            <div>
              <h1>Properties</h1>
              <p>{selectedIds.length > 1 ? `Shapes (${selectedIds.length})` : selected ? selected.name : "Nothing selected"}</p>
            </div>
          </div>
          {selected ? (
            <Inspector
              node={selected}
              localSize={selectedLocalSize}
              selectedCount={selectedIds.length}
              selectionBounds={selectionBounds}
              onResizeSelectionAxis={resizeSelectionAxis}
              onMoveSelectionAxis={moveSelectionAxis}
              error={invalid[selected.id] ?? null}
              onParam={(k, v) => setParam(selected.id, k, v)}
              onTransform={(patch) => setTransform(selected.id, patch)}
              resizeConstrained={resizeConstrained}
              onResizeConstrained={setResizeConstrained}
              onHole={(h) => {
                beginHistoryBatch();
                const ids = selectedIds.length ? selectedIds : (selected ? [selected.id] : []);
                for (const id of ids) setHole(id, h);
                endHistoryBatch();
              }}
              onColor={(c) => {
                beginHistoryBatch();
                const ids = selectedIds.length ? selectedIds : (selected ? [selected.id] : []);
                for (const id of ids) {
                  setColor(id, c);
                  const parent = parentOf(nodes, id);
                  if (parent && isGroup(parent)) {
                    setColor(parent.id, c);
                  }
                }
                endHistoryBatch();
              }}
              onTransparent={applyTransparent}
              onSvgThickness={(mm) => setSvgThickness(selected.id, mm)}
              onOp={(op) => setGroupOp(selected.id, op)}
              onRename={(n) => rename(selected.id, n)}
              onDelete={removeSelected}
              onPruneDeadOps={onPruneDeadOps}
              onDuplicateWithParams={(params) => duplicateWithParams(selected.id, params)}
            />
          ) : <div className="empty-state small">Select an object to edit its dimensions and position.</div>}
        </section>

        {/* Parked: selecting the wall this is meant to attach to did not work
         *  as expected and needs a rethink, not a quick patch. Left visible-
         *  but-disabled rather than removed so the feature is easy to pick
         *  back up. See connectorSeam/addConnectorJoint above, still intact
         *  and unused while this stays disabled. */}
        {selectedIds.length === 2 && (
        <section className="tool-section connector-section paused" aria-disabled="true">
          <div className="panel-heading compact">
            <div><h1>Add connector</h1><p>Paused for now — coming back to this soon</p></div>
          </div>
          <div className="spacing-objects">
            <div>
              <span className="field-label">Plug goes on</span>
              <strong>—</strong>
            </div>
            <button type="button" disabled>Swap</button>
            <div>
              <span className="field-label">Socket goes on</span>
              <strong>—</strong>
            </div>
          </div>
          <button className="primary" disabled onClick={addConnectorJoint}>
            Add connector
          </button>
        </section>
        )}

        {selectedIds.length === 2 && (
        <section className="tool-section spacing-section">
          <button
            type="button"
            className={`panel-heading compact disclosure-trigger${spacingOpen ? " open" : ""}`}
            onClick={() => setSpacingOpen((v) => !v)}
            aria-expanded={spacingOpen}
          >
            <div><h1>Exact spacing</h1><p>Set the gap between two objects</p></div>
            <span className="disclosure-caret">▸</span>
          </button>
          {spacingOpen && (
          <>
          <div className="spacing-objects">
          <div>
            <span className="field-label">Stays fixed</span>
            <strong>{spacingSelection?.fixedNode.name ?? "First selected object"}</strong>
          </div>
          <button
            disabled={!spacingSelection}
            onClick={() => setSpacingSwapped((v) => !v)}
            title="Exchange the fixed and moving objects"
          >
            Swap
          </button>
          <div>
            <span className="field-label">Moves</span>
            <strong>{spacingSelection?.movingNode.name ?? "Second selected object"}</strong>
          </div>
          </div>
          <div className="row axis-row">
          {(["x", "y", "z"] as SnapAxis[]).map((axis) => (
            <button
              key={axis}
              className={gapAxis === axis ? "on" : ""}
              onClick={() => setGapAxis(axis)}
            >
              {axis.toUpperCase()}
            </button>
          ))}
          </div>
          <label className="field">
          <span className="field-label">Measure from fixed object</span>
          <select
            className="num"
            value={fixedAnchor}
            onChange={(e) => setFixedAnchor(e.target.value as SnapAnchor)}
          >
            <option value="min">Minimum edge</option>
            <option value="center">Centre</option>
            <option value="max">Maximum edge</option>
          </select>
          </label>
          <label className="field">
          <span className="field-label">Measure to moving object</span>
          <select
            className="num"
            value={movingAnchor}
            onChange={(e) => setMovingAnchor(e.target.value as SnapAnchor)}
          >
            <option value="min">Minimum edge</option>
            <option value="center">Centre</option>
            <option value="max">Maximum edge</option>
          </select>
          </label>
          <span className="field-label">Direction from fixed reference</span>
          <div className="row">
          <button className={gapDirection === -1 ? "on" : ""} onClick={() => setGapDirection(-1)}>
            Negative
          </button>
          <button className={gapDirection === 1 ? "on" : ""} onClick={() => setGapDirection(1)}>
            Positive
          </button>
          </div>
          <label className="field">
          <span className="field-label">Gap (mm)</span>
          <input
            className="num"
            type="number"
            min={0}
            step={0.5}
            value={gapMm}
            onChange={(e) => setGapMm(Number(e.target.value))}
          />
          </label>
          <button className="primary" disabled={!spacingSelection} onClick={applyGap}>Set exact gap</button>
          <p className="hint spacing-hint">
          {spacingSelection
            ? `${spacingSelection.fixedNode.name} stays fixed; ${spacingSelection.movingNode.name} moves along ${gapAxis.toUpperCase()}.`
            : "Select exactly two top-level objects. The first stays fixed."}
          </p>
          </>
          )}
        </section>
        )}

      </aside>

      <ProjectsModal
        isOpen={projectsModalOpen}
        onClose={() => setProjectsModalOpen(false)}
        onProjectLoadStart={(name) => {
          setError(null);
          setFileOperation({
            label: `Opening ${name}`,
            startedAt: Date.now(),
            waitingForScene: false,
            sawSceneBusy: false,
          });
        }}
        onProjectLoadApplied={() => {
          setFileOperation((current) => current ? { ...current, waitingForScene: true } : null);
        }}
        onProjectLoadFailed={() => setFileOperation(null)}
      />

      {pendingSvg && (
        <SvgImportModal
          isOpen={true}
          fileName={pendingSvg.file.name}
          initialWidth={pendingSvg.art.width}
          initialHeight={pendingSvg.art.height}
          rawWidth={pendingSvg.art.rawWidth}
          rawHeight={pendingSvg.art.rawHeight}
          detectedPreset={pendingSvg.art.unitPreset}
          onClose={() => setPendingSvg(null)}
          onImport={confirmSvgImport}
        />
      )}
      {textModalOpen && textFonts && (
        <TextModal fonts={textFonts ?? []} onClose={() => setTextModalOpen(false)} onCreate={(config) => void createText(config)} onPickFile={() => textFontInputRef.current?.click()} />
      )}
    </div>
  );
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function timeAgo(then: number, now: number): string {
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  return mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
}
