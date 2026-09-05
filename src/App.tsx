import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as THREE from "three";
import { EXPORT_MESHES_WATCHDOG_MS, EXPORT_WATCHDOG_MS, kernel, KernelTimeoutError, WATCHDOG_MS } from "./kernel/client";
import { Viewport } from "./viewport/Viewport";
import { Inspector } from "./ui/Inspector";
import { Tree } from "./ui/Tree";
import { ProjectsModal } from "./ui/ProjectsModal";
import {
  AlignNodeIcon,
  AlignToolIcon,
  BuildPlateIcon,
  ChevronDownIcon,
  CollisionHighlightIcon,
  CombineIcon,
  CornerFlyoutMark,
  DirectionArrowIcon,
  DropIcon,
  EdgeToolIcon,
  ExportIcon,
  FaceModifierIcon,
  GroupIcon,
  ImportIcon,
  MagnetIcon,
  MoveToolIcon,
  NewDesignIcon,
  ObjectsIcon,
  OrthographicIcon,
  PencilIcon,
  PerspectiveIcon,
  PrimitiveShapeIcon,
  ProjectsIcon,
  RedoIcon,
  RotateToolIcon,
  SaveFileIcon,
  SelectIcon,
  SettingsIcon,
  ShapeBuilderIcon,
  SolidCubeIcon,
  TextToolIcon,
  TransparencyIcon,
  UndoIcon,
  UngroupIcon,
  WireframeIcon,
  ZoomToFitIcon,
} from "./ui/icons";
import { buildThreeMF } from "./export/threemf";
import { SvgImportModal } from "./ui/SvgImportModal";
import { TextModal } from "./ui/TextModal";
import { SettingsModal } from "./ui/SettingsModal";
import type { BuildPlateSize } from "./ui/SettingsModal";
import { ExportModal } from "./ui/ExportModal";
import { displayStep, formatLength, fromMillimetres, toMillimetres } from "./measurement";
import type { AppearancePreference, DisplayUnit } from "./measurement";
import type { TextConfig } from "./ui/TextModal";
import { NO_FONT_LISTING, getCachedTextPaths, resolveTextPaths } from "./text/systemFonts";
import type { LocalFontData } from "./text/systemFonts";
import {
  beginHistoryBatch,
  copySelected,
  endHistoryBatch,
  pasteClipboard,
  useDoc,
  useTemporal,
} from "./document/store";
import { MAX_BUILD_SOURCES, PRIMITIVES, PRIMITIVE_CATEGORIES, isGroup } from "./document/types";
import { findNode, parentOf, resolveNodeTransparent, resolveNodeColor, updateNode, walk } from "./document/tree";
import { bakeScale } from "./document/bake";
import { putBlob } from "./document/blobStore";
import { loadCameraState } from "./document/persist";
import type { EditOp, GroupNode, PrimitiveKind, SceneNode, ShellOp, Vec3 } from "./document/types";
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
  if (n.kind === "text") {
    const cachedPaths = getCachedTextPaths(n.fontName, n.text ?? "TEXT", n.params.size ?? 20);
    return {
      type: "object",
      id: n.id,
      kind: n.kind,
      params: n.params,
      text: n.text,
      fontName: n.fontName,
      textPaths: cachedPaths,
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
    text: n.text,
    fontName: n.fontName,
    position: n.position,
    rotation: n.rotation,
    scale: n.scale,
    isHole: n.isHole,
  };
};

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

/** Collects specs for the kernel, flattening assembly groups so their children build independently. */
function flattenSpecs(nodes: SceneNode[]): NodeSpec[] {
  const out: NodeSpec[] = [];
  for (const n of nodes) {
    if (isGroup(n) && n.op === "assembly") {
      out.push(...flattenSpecs(n.children.filter((c) => !c.hidden)));
    } else {
      out.push(toSpec(n));
    }
  }
  return out;
}

/** Geometry-defining shape of a node, ignoring its own placement. A group's
 *  shape does depend on where its children sit, so those stay included. */
const shapeOf = (n: SceneNode): unknown => {
  if (isGroup(n)) {
    if (n.op === "assembly") {
      return [n.id, "assembly", n.children.filter((c) => !c.hidden).map(shapeOf)];
    }
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
  return [n.id, n.kind, n.params, n.text, n.fontName];
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
const GRID_SNAP_KEY = "cad.gridSnap";
const SELECTED_COLLISIONS_KEY = "cad.showSelectedCollisions";
const RANDOM_NEW_OBJECT_COLORS_KEY = "cad.randomNewObjectColors";
const OBJECTS_PANEL_KEY = "cad.objectsPanelOpen";
const VIEW_STYLE_KEY = "cad.viewStyle";
const RESIZE_CONSTRAINED_KEY = "cad.resizeConstrained";
const DISPLAY_UNIT_KEY = "cad.displayUnit";
const DECIMAL_PLACES_KEY = "cad.decimalPlaces.v2";
const APPEARANCE_KEY = "cad.appearance";
const BUILD_PLATE_VISIBLE_KEY = "cad.buildPlateVisible";
const BUILD_PLATE_SIZE_KEY = "cad.buildPlateSize";

/** What each preset costs, so the choice is not guesswork — measured on a
 *  40x30x15 box with a 10mm spherical bowl (see EXPORT_PRESETS in worker.ts). */
function SignedMeasurementInput({ valueMm, unit, decimals, onValue, onEnter }: {
  valueMm: number;
  unit: DisplayUnit;
  decimals: number;
  onValue: (valueMm: number) => void;
  onEnter: () => void;
}) {
  const [draft, setDraft] = useState(() => formatLength(valueMm, unit, decimals));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(formatLength(valueMm, unit, decimals));
  }, [valueMm, unit, decimals]);
  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft}
      onFocus={() => { focused.current = true; }}
      onChange={(e) => {
        const next = e.target.value;
        setDraft(next);
        if (["", "-", ".", "-."].includes(next.trim())) return;
        const parsed = Number(next);
        if (Number.isFinite(parsed)) onValue(toMillimetres(parsed, unit));
      }}
      onBlur={() => {
        focused.current = false;
        setDraft(formatLength(valueMm, unit, decimals));
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onEnter();
        }
      }}
    />
  );
}

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const fileMenuRef = useRef<HTMLDivElement>(null);
  const [displayUnit, setDisplayUnit] = useState<DisplayUnit>(() => {
    const saved = localStorage.getItem(DISPLAY_UNIT_KEY);
    return saved === "cm" || saved === "in" ? saved : "mm";
  });
  const [decimalPlaces, setDecimalPlaces] = useState(() => {
    const raw = localStorage.getItem(DECIMAL_PLACES_KEY);
    if (raw === null) return 1;
    const saved = Number(raw);
    return Number.isInteger(saved) && saved >= 0 && saved <= 3 ? saved : 1;
  });
  const [appearance, setAppearance] = useState<AppearancePreference>(() =>
    localStorage.getItem(APPEARANCE_KEY) === "dark" || localStorage.getItem(APPEARANCE_KEY) === "system"
      ? localStorage.getItem(APPEARANCE_KEY) as AppearancePreference
      : "light",
  );
  useEffect(() => localStorage.setItem(DISPLAY_UNIT_KEY, displayUnit), [displayUnit]);
  useEffect(() => localStorage.setItem(DECIMAL_PLACES_KEY, String(decimalPlaces)), [decimalPlaces]);
  useEffect(() => localStorage.setItem(APPEARANCE_KEY, appearance), [appearance]);
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
    resetParams,
    setText,
    setFontName,
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
    combine,
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
  /** Set when the full-detail export path ran out of time and a lower-
   *  quality fallback (viewport-resolution meshes, not the chosen Draft/
   *  Standard/Fine setting) was substituted instead — see the 3MF and STL
   *  export handlers below. The fallback exists so an export always
   *  finishes with SOMETHING rather than hanging forever, but it must never
   *  do that silently: this drives a visible warning alongside the ready
   *  notice instead of a quietly lower-quality file. */
  const [exportDowngraded, setExportDowngraded] = useState(false);
  const [fileOperation, setFileOperation] = useState<FileOperation | null>(null);
  const [pendingSvg, setPendingSvg] = useState<{
    file: File;
    art: import("./svg/parse").SvgOutlines;
  } | null>(null);
  const [textFonts, setTextFonts] = useState<LocalFontData[] | null>(null);
  const [textModalOpen, setTextModalOpen] = useState(false);

  useEffect(() => {
    if ("queryLocalFonts" in window) {
      import("./text/systemFonts")
        .then(({ systemFonts }) => systemFonts())
        .then((fonts) => {
          if (fonts && fonts.length) setTextFonts(fonts);
        })
        .catch(() => {});
    }
  }, []);
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
  const [openCategories, setOpenCategories] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem("cad.primitiveCategoriesOpen");
      if (saved) return JSON.parse(saved);
    } catch {}
    return { basic: true, curved: false, profiles: false, hardware: false };
  });

  const toggleCategory = useCallback((catId: string) => {
    setOpenCategories((prev) => {
      const next = { ...prev, [catId]: !prev[catId] };
      try {
        localStorage.setItem("cad.primitiveCategoriesOpen", JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  const allCategoriesOpen = PRIMITIVE_CATEGORIES.every((c) => openCategories[c.id]);

  const toggleAllCategories = useCallback(() => {
    setOpenCategories((prev) => {
      const allOpen = PRIMITIVE_CATEGORIES.every((c) => prev[c.id]);
      const nextVal = !allOpen;
      const next: Record<string, boolean> = {};
      for (const c of PRIMITIVE_CATEGORIES) {
        next[c.id] = nextVal;
      }
      try {
        localStorage.setItem("cad.primitiveCategoriesOpen", JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);
  const [edgeSelection, setEdgeSelection] = useState<{ id: string; points: Vec3[] } | null>(null);
  const [edgeKind, setEdgeKind] = useState<"fillet" | "chamfer">("fillet");
  const [edgeDistance, setEdgeDistance] = useState(2);
  /** The face the Face tool has selected, for Hollow. Held here rather than
   *  read from the scene so the bar re-renders when the selection changes. */
  const [faceSelection, setFaceSelection] = useState<{ id: string; point: Vec3; normal: Vec3; size: number; edges: Vec3[] } | null>(null);
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
  const lastFace = useRef<{ id: string; point: Vec3; normal: Vec3; size: number; edges: Vec3[] } | null>(null);
  /** The face operation is selected directly from the tool rail. The bottom
   *  bar only configures and applies that one operation; it must never act as
   *  a second, conflicting tool picker. */
  const [faceOp, setFaceOp] = useState<"push" | "wall" | "resize" | "offset" | "fillet" | "chamfer">("push");
  /** Offset & extrude is the one face operation that needs two numbers: how
   *  far in from the edge, and how far out from there. */
  const [faceHeight, setFaceHeight] = useState(3);
  const [faceValue, setFaceValue] = useState(2);
  const [alignSubMode, setAlignSubMode] = useState<"box" | "points">("box");
  const [alignAnchorId, setAlignAnchorId] = useState<string | null>(null);
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
  const [dropMenuOpen, setDropMenuOpen] = useState(false);
  const [dropDirection, setDropDirection] = useState<{ label: string; vector: Vec3 }>({
    label: "Down",
    vector: [0, 0, -1],
  });
  const dropMenuRef = useRef<HTMLDivElement>(null);
  const dropFlyoutRef = useRef<HTMLDivElement>(null);
  const [dropFlyoutPos, setDropFlyoutPos] = useState<{ top: number; left: number } | null>(null);
  // Illustrator-style tool flyout: holding the Drop button opens the
  // direction picker instead of dropping; a plain click still drops.
  const dropPressTimerRef = useRef<number | null>(null);
  const dropLongPressFiredRef = useRef(false);
  const cancelDropPressTimer = useCallback(() => {
    if (dropPressTimerRef.current !== null) {
      window.clearTimeout(dropPressTimerRef.current);
      dropPressTimerRef.current = null;
    }
  }, []);
  const startDropPressTimer = useCallback(() => {
    dropLongPressFiredRef.current = false;
    cancelDropPressTimer();
    dropPressTimerRef.current = window.setTimeout(() => {
      dropLongPressFiredRef.current = true;
      dropPressTimerRef.current = null;
      setDropMenuOpen(true);
    }, 400);
  }, [cancelDropPressTimer]);
  const [alignMenuOpen, setAlignMenuOpen] = useState(false);
  const alignMenuRef = useRef<HTMLDivElement>(null);
  const alignFlyoutRef = useRef<HTMLDivElement>(null);
  const [alignFlyoutPos, setAlignFlyoutPos] = useState<{ top: number; left: number } | null>(null);
  const alignPressTimerRef = useRef<number | null>(null);
  const alignLongPressFiredRef = useRef(false);
  const cancelAlignPressTimer = useCallback(() => {
    if (alignPressTimerRef.current !== null) {
      window.clearTimeout(alignPressTimerRef.current);
      alignPressTimerRef.current = null;
    }
  }, []);
  const startAlignPressTimer = useCallback(() => {
    alignLongPressFiredRef.current = false;
    cancelAlignPressTimer();
    alignPressTimerRef.current = window.setTimeout(() => {
      alignLongPressFiredRef.current = true;
      alignPressTimerRef.current = null;
      setAlignMenuOpen(true);
    }, 400);
  }, [cancelAlignPressTimer]);
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
    addPrimitive(
      pendingPrimitive,
      base.toArray() as Vec3,
      [rotation.x / Math.PI * 180, rotation.y / Math.PI * 180, rotation.z / Math.PI * 180],
    );
    setPendingPrimitive(null);
    setToolMode("select");
  }, [addPrimitive, pendingPrimitive]);

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
  useEffect(() => {
    // The topbar doesn't clip its own children, so unlike the tool-rail
    // flyouts, this dropdown doesn't need a portal or computed position —
    // a plain ref covering both the button and the menu is enough.
    if (!fileMenuOpen) return;
    const onDocClick = (e: PointerEvent | MouseEvent) => {
      const target = e.target as Node;
      if (fileMenuRef.current && !fileMenuRef.current.contains(target)) setFileMenuOpen(false);
    };
    window.addEventListener("pointerdown", onDocClick);
    return () => window.removeEventListener("pointerdown", onDocClick);
  }, [fileMenuOpen]);
  useEffect(() => {
    if (!dropMenuOpen) {
      setDropFlyoutPos(null);
      return;
    }
    const trigger = dropMenuRef.current;
    if (trigger) {
      const rect = trigger.getBoundingClientRect();
      setDropFlyoutPos({ top: rect.top + rect.height / 2, left: rect.right + 10 });
    }
    const onDocClick = (e: PointerEvent | MouseEvent) => {
      const target = e.target as Node;
      if (
        dropMenuRef.current && !dropMenuRef.current.contains(target) &&
        dropFlyoutRef.current && !dropFlyoutRef.current.contains(target)
      ) setDropMenuOpen(false);
    };
    window.addEventListener("pointerdown", onDocClick);
    return () => window.removeEventListener("pointerdown", onDocClick);
  }, [dropMenuOpen]);
  useEffect(() => {
    if (!alignMenuOpen) {
      setAlignFlyoutPos(null);
      return;
    }
    const trigger = alignMenuRef.current;
    if (trigger) {
      const rect = trigger.getBoundingClientRect();
      setAlignFlyoutPos({ top: rect.top + rect.height / 2, left: rect.right + 10 });
    }
    const onDocClick = (e: PointerEvent | MouseEvent) => {
      const target = e.target as Node;
      if (
        alignMenuRef.current && !alignMenuRef.current.contains(target) &&
        alignFlyoutRef.current && !alignFlyoutRef.current.contains(target)
      ) setAlignMenuOpen(false);
    };
    window.addEventListener("pointerdown", onDocClick);
    return () => window.removeEventListener("pointerdown", onDocClick);
  }, [alignMenuOpen]);
  // Remembered like the export quality: whether you want things snapping is
  // a working preference, not a per-session one.
  const [snapEnabled, setSnapEnabled] = useState(
    () => localStorage.getItem(SNAP_KEY) !== "off",
  );
  const [gridSnapEnabled, setGridSnapEnabled] = useState(
    () => localStorage.getItem(GRID_SNAP_KEY) === "on",
  );
  const [showSelectedCollisionContacts, setShowSelectedCollisionContacts] = useState(
    () => localStorage.getItem(SELECTED_COLLISIONS_KEY) !== "off",
  );
  const [randomNewObjectColors, setRandomNewObjectColors] = useState(
    () => localStorage.getItem(RANDOM_NEW_OBJECT_COLORS_KEY) === "on",
  );
  const [plateVisible, setPlateVisible] = useState(
    () => localStorage.getItem(BUILD_PLATE_VISIBLE_KEY) !== "off",
  );
  useEffect(() => {
    localStorage.setItem(BUILD_PLATE_VISIBLE_KEY, plateVisible ? "on" : "off");
  }, [plateVisible]);

  const [plateSize, setPlateSize] = useState<BuildPlateSize>(() => {
    try {
      const saved = localStorage.getItem(BUILD_PLATE_SIZE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Number.isFinite(parsed.width) && Number.isFinite(parsed.depth) && parsed.width > 0 && parsed.depth > 0) {
          return { width: Math.round(parsed.width), depth: Math.round(parsed.depth) };
        }
      }
    } catch {}
    return { width: 256, depth: 256 };
  });
  useEffect(() => {
    localStorage.setItem(BUILD_PLATE_SIZE_KEY, JSON.stringify(plateSize));
  }, [plateSize]);
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

  const [rightPanelTab, setRightPanelTab] = useState<"shapes" | "properties">("shapes");
  const prevSelectionKeyRef = useRef<string>("");

  useEffect(() => {
    const currentKey = selectedIds.join(",");
    const wasEmpty = prevSelectionKeyRef.current === "";
    const isNowEmpty = currentKey === "";

    if (wasEmpty && !isNowEmpty) {
      setRightPanelTab("properties");
    } else if (!wasEmpty && isNowEmpty) {
      setRightPanelTab("shapes");
    } else if (!wasEmpty && !isNowEmpty && currentKey !== prevSelectionKeyRef.current) {
      setRightPanelTab("properties");
    }
    prevSelectionKeyRef.current = currentKey;
  }, [selectedIds]);
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
  useEffect(() => {
    if (selectedIds.length === 2) {
      setAlignAnchorId(selectedIds[1]);
    } else {
      setAlignAnchorId(null);
    }
  }, [selectedIds[0], selectedIds[1], selectedIds.length]);

  useEffect(() => {
    if (toolMode === "align" && selectedIds.length < 2) {
      setToolMode("select");
    }
  }, [toolMode, selectedIds.length]);

  const effectiveAlignFixedId = alignAnchorId;
  const currentAnchorNode = effectiveAlignFixedId ? findNode(nodes, effectiveAlignFixedId) : null;
  const currentAnchorName = currentAnchorNode ? currentAnchorNode.name : "None (align to bounds)";

  const currentMovingId = selectedIds.length === 2 && effectiveAlignFixedId
    ? (selectedIds[0] === effectiveAlignFixedId ? selectedIds[1] : selectedIds[0])
    : null;
  const currentMovingNode = currentMovingId ? findNode(nodes, currentMovingId) : null;

  const handleSelectAnchor = useCallback((id: string | null) => {
    setAlignAnchorId(id);
    if (id && selectedIds.length === 2) {
      setSpacingSwapped(id === selectedIds[1]);
    }
  }, [selectedIds]);

  const handleSwapAlign = useCallback(() => {
    if (selectedIds.length === 2) {
      const current = effectiveAlignFixedId ?? selectedIds[1];
      const next = current === selectedIds[0] ? selectedIds[1] : selectedIds[0];
      setAlignAnchorId(next);
      setSpacingSwapped(next === selectedIds[1]);
      sceneRef.current?.setAlignFixedId(next);
    }
  }, [selectedIds, effectiveAlignFixedId]);

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

  const [textRebuildNonce, setTextRebuildNonce] = useState(0);

  useEffect(() => {
    let unmounted = false;
    const promises: Promise<any>[] = [];
    for (const node of walk(nodes)) {
      if (node.type === "object" && node.kind === "text") {
        const text = node.text ?? "TEXT";
        const size = node.params.size ?? 20;
        const fontName = node.fontName;
        if (!getCachedTextPaths(fontName, text, size)) {
          promises.push(resolveTextPaths(fontName, text, size, textFonts ?? undefined));
        }
      }
    }
    if (promises.length > 0) {
      Promise.all(promises).then(() => {
        if (!unmounted) {
          setTextRebuildNonce((n) => n + 1);
        }
      });
    }
    return () => {
      unmounted = true;
    };
  }, [nodes, textFonts]);

  // Nodes actually sent to the kernel — skippedIds excludes anything a
  // watchdog timeout already blamed, so it is not retried into another hang.
  const buildableNodes = useMemo(
    () => pruneSkipped(nodes, skippedIds),
    [nodes, skippedIds],
  );

  // Rebuild only when geometry-defining data changes. Dragging a top-level node
  // changes its position, which the viewport applies itself without the kernel.
  const shapeKey = useMemo(
    () => JSON.stringify([...buildableNodes.map(shapeOf), textRebuildNonce]),
    [buildableNodes, textRebuildNonce],
  );

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
  const faceApplyButtonRef = useRef<HTMLButtonElement>(null);
  const edgePreviewRequestRef = useRef(0);

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
    const specs = flattenSpecs(pruneSkipped(useDoc.getState().nodes, skippedIds));
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

          // An edit whose old face/edge anchor no longer exists has already
          // been skipped by the kernel. Leaving it in the document cannot
          // affect the visible shape — it only repeats the warning forever.
          // Verify the edit history has not changed while the repair runs,
          // then permanently retain only the operations the kernel can still
          // resolve. This is the automatic equivalent of the Inspector's
          // existing "Remove broken edit" action.
          for (const issue of res.errors) {
            if (!issue.message.includes("could not be found after rebuilding")) continue;
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
      localStorage.setItem(GRID_SNAP_KEY, gridSnapEnabled ? "on" : "off");
    } catch {
      // Private mode / blocked storage: the choice just won't be remembered.
    }
  }, [gridSnapEnabled]);

  useEffect(() => {
    try {
      localStorage.setItem(SELECTED_COLLISIONS_KEY, showSelectedCollisionContacts ? "on" : "off");
    } catch {
      // Private mode / blocked storage: the choice just won't be remembered.
    }
  }, [showSelectedCollisionContacts]);

  useEffect(() => {
    try {
      localStorage.setItem(RANDOM_NEW_OBJECT_COLORS_KEY, randomNewObjectColors ? "on" : "off");
    } catch {
      // Private mode / blocked storage: the choice just won't be remembered.
    }
  }, [randomNewObjectColors]);

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
    (dragging: boolean) => {
      if (dragging) {
        beginHistoryBatch();
      } else {
        const state = useDoc.getState();
        for (const id of state.selectedIds) {
          const node = findNode(state.nodes, id);
          if (
            node?.type === "object" &&
            node.scale.some((s) => Math.abs(s - 1) > 1e-4)
          ) {
            const baked = bakeScale(node);
            if (baked) {
              useDoc.setState((s) => ({
                nodes: updateNode(s.nodes, id, () => baked),
              }));
            }
          }
        }
        endHistoryBatch();
      }
    },
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

  const requestSystemFonts = async () => {
    try {
      const { systemFonts } = await import("./text/systemFonts");
      const fonts = await systemFonts();
      if (fonts.length) {
        setTextFonts(fonts);
        setError(null);
      }
    } catch (e) {
      const reason = msg(e);
      if (!reason.includes(NO_FONT_LISTING)) {
        setError(`Could not access system fonts: ${reason}`);
      }
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
      if (selected && selected.type === "object" && selected.kind === "text") {
        setFontName(selected.id, font.fullName || font.family);
      }
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
    setExportDowngraded(false);
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
        let meshes: { id: string; vertices: number[]; triangles: number[] }[];
        try {
          meshes = await kernel.exportMeshes(currentNodes.map(toSpec), exportQuality);
        } catch (e) {
          if (!(e instanceof KernelTimeoutError)) throw e;

          // Surgical fallback: retry ONE top-level solid at a time, each
          // paired only with the Holes that actually overlap it (worker.ts's
          // exportMeshes already cuts every solid independently of the
          // others in the same call, so this reproduces exactly what the
          // full-scene call would have done for THIS solid — just without
          // every other object's work competing for the same time budget).
          // A slow object now degrades on its own instead of dragging the
          // whole scene down to viewport resolution with it, the same trade
          // STL's own exportRefinedSTL fallback already makes.
          const fallbackItems = currentNodes.map((node) => {
            const part = parts.find((candidate) => candidate.id === node.id);
            return part ? { node, mesh: part.mesh } : null;
          });
          const completeItems = fallbackItems.filter(
            (item): item is NonNullable<typeof item> => item !== null,
          );
          if (!completeItems.length) throw e;

          const solids = completeItems.filter(({ node }) => !node.isHole);
          const holes = completeItems.filter(({ node }) => node.isHole);
          const solidBounds = new Map(
            solids.map((item) => [item.node.id, displayedMeshBounds(item.mesh, item.node)]),
          );
          const holeBounds = new Map(
            holes.map((item) => [item.node.id, displayedMeshBounds(item.mesh, item.node)]),
          );

          const results: { id: string; vertices: number[]; triangles: number[] }[] = [];
          let anyDowngraded = false;
          for (const solid of solids) {
            const relevantHoles = holes.filter((hole) =>
              displayedBoundsOverlap(solidBounds.get(solid.node.id)!, holeBounds.get(hole.node.id)!),
            );
            let own: { id: string; vertices: number[]; triangles: number[] } | undefined;
            try {
              const refined = await kernel.exportMeshesRefine(
                [solid.node, ...relevantHoles.map((h) => h.node)].map(toSpec),
                exportQuality,
              );
              own = refined.find((m) => m.id === solid.node.id);
            } catch (err) {
              if (!(err instanceof KernelTimeoutError)) throw err;
            }
            if (own) {
              results.push(own);
              continue;
            }
            // The per-object retry itself timed out (or — every source in
            // it turned out to be a hole, which should not happen here —
            // came back without this solid). Its own overlapping Holes are
            // NOT cut into this fallback, same acceptable last-resort trade
            // STL's own double-failure case already makes: keeping the
            // object in the export, uncut, beats dropping it silently.
            anyDowngraded = true;
            results.push({
              id: solid.node.id,
              vertices: Array.from(solid.mesh.faces.vertices),
              triangles: Array.from(solid.mesh.faces.triangles),
            });
          }
          if (anyDowngraded) setExportDowngraded(true);
          meshes = results;
        }

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
          // Genuinely lower quality than requested (viewport resolution,
          // not exportQuality) — unlike the refined branch below, there is
          // no recovery for these, so this is the one place that actually
          // needs the warning.
          setExportDowngraded(true);
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
            setExportDowngraded(true);
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

  const combineSelected = useCallback(
    (op: "union" | "subtract" | "intersect" = "union") =>
      applyTreeChange((centres) => combine(op, centres)),
    [combine, applyTreeChange],
  );

  const dropSelected = useCallback(() => {
    const updates = sceneRef.current?.dropSelectedDirection(dropDirection.vector) ?? [];
    if (updates.length) {
      setPositions(updates);
      setError(null);
    } else {
      setError("Nothing to drop onto in that direction.");
    }
  }, [dropDirection, setPositions]);

  const selectDropDirection = useCallback((label: string, vector: Vec3) => {
    setDropDirection({ label, vector });
    setDropMenuOpen(false);
    setError(null);
  }, []);

  const edgeCandidate = useCallback(() => {
    if (!edgeSelection) return null;
    const op = {
      kind: edgeKind,
      point: edgeSelection.points[0],
      points: edgeSelection.points,
      distance: edgeDistance,
    } as const;
    const node = findNode(useDoc.getState().nodes, edgeSelection.id);
    if (!node || node.type === "import") return null;
    const candidate: EditSpec = node.type === "edit"
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
    return { op, candidate };
  }, [edgeSelection, edgeKind, edgeDistance]);

  // Edge finishing can be expensive, so wait until the value has paused for
  // a moment and coalesce stale requests. The preview never touches history.
  useEffect(() => {
    const request = ++edgePreviewRequestRef.current;
    if (toolMode !== "edge" || !edgeSelection) {
      sceneRef.current?.setEdgePreview(null, null);
      return;
    }
    const timer = window.setTimeout(() => {
      const pending = edgeCandidate();
      if (!pending) return;
      void kernel.previewLocal(pending.candidate).then((preview) => {
        if (request !== edgePreviewRequestRef.current) return;
        sceneRef.current?.setEdgePreview(edgeSelection.id, preview);
      }).catch(() => {
        if (request === edgePreviewRequestRef.current) {
          sceneRef.current?.setEdgePreview(null, null);
        }
      });
    }, 280);
    return () => window.clearTimeout(timer);
  }, [toolMode, edgeSelection, edgeCandidate]);

  const applyEdgeFinish = useCallback(async () => {
    if (!edgeSelection) return;
    const pending = edgeCandidate();
    if (!pending) return;
    try {
      const surviving = await kernel.pruneDeadOps(pending.candidate);
      if (!surviving || surviving.length !== pending.candidate.ops.length) {
        setError("That edge finish cannot be applied at this size.");
        return;
      }
    } catch (e) {
      setError(msg(e));
      return;
    }
    sceneRef.current?.setEdgePreview(null, null);
    setError(null);
    finishEdit(edgeSelection.id, pending.op);
    setEdgeSelection(null);
  }, [edgeSelection, edgeCandidate, finishEdit]);

  const toggleHoleSelected = useCallback(() => {
    const state = useDoc.getState();
    if (!state.selectedIds.length) return;
    const makeHole = !state.selectedIds.every((id) => findNode(state.nodes, id)?.isHole);
    beginHistoryBatch();
    for (const id of state.selectedIds) setHole(id, makeHole);
    endHistoryBatch();
  }, [setHole]);

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
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        combineSelected("union");
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
        setFaceOp("push");
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
      } else if (!mod && e.key === "Home") {
        e.preventDefault();
        sceneRef.current?.resetView();
      } else if (!mod && e.key.toLowerCase() === "h") {
        e.preventDefault();
        toggleHoleSelected();
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
  }, [removeSelected, selectMany, undo, redo, group, ungroup, toggleTransparency, dropSelected, ungroupSelected, groupSelected, commitBuild, exportCurrentProject, newProject, cycleWireframe, zoomToSelected, toggleHoleSelected]);

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
    // Stale topology anchors are pruned automatically by the build handler.
    // Do not flash an alarming failure for the new operation while that
    // repair completes; the Inspector retains the warning if pruning fails.
    if (!complaint.includes("could not be found after rebuilding")) setError(complaint);
    setEditPending(null);
  }, [editPending, invalid]);

  const progressLabel = exporting
    ? `Exporting ${exportFormat.toUpperCase()}`
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
        <div className="topbar-left">
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
                <PencilIcon className="project-title-edit-icon" />
              </button>
            )}
          </div>

          <div className="file-menu-container" ref={fileMenuRef}>
            <button
              className={`topbar-btn file-menu-btn ${fileMenuOpen ? "on" : ""}`}
              onClick={() => setFileMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={fileMenuOpen}
              aria-label="File menu"
            >
              <ProjectsIcon className="topbar-icon" />
              <span>File</span>
              <ChevronDownIcon className="file-menu-chevron" />
            </button>
            {fileMenuOpen && (
              <div className="file-menu-dropdown" role="menu" aria-label="File">
                <button
                  role="menuitem"
                  onClick={() => {
                    setFileMenuOpen(false);
                    const name = prompt("Enter project name:", "Untitled Project");
                    if (name !== null) newProject(name);
                  }}
                >
                  <NewDesignIcon className="topbar-icon" />
                  <span className="item-label">New Design</span>
                  <span className="item-key">Ctrl+Alt+N</span>
                </button>
                <button
                  role="menuitem"
                  onClick={() => { setFileMenuOpen(false); setProjectsModalOpen(true); }}
                >
                  <ProjectsIcon className="topbar-icon" />
                  <span className="item-label">Open…</span>
                  <span className="item-key">Ctrl+O</span>
                </button>
                <button
                  role="menuitem"
                  onClick={() => { setFileMenuOpen(false); importInputRef.current?.click(); }}
                >
                  <ImportIcon className="topbar-icon" />
                  <span className="item-label">Import…</span>
                </button>
                <hr />
                <button
                  role="menuitem"
                  onClick={() => { setFileMenuOpen(false); exportCurrentProject(); }}
                >
                  <SaveFileIcon className="topbar-icon" />
                  <span className="item-label">Save</span>
                  <span className="item-key">Ctrl+S</span>
                </button>
                <button
                  role="menuitem"
                  onClick={() => { setFileMenuOpen(false); setExportModalOpen(true); }}
                >
                  <ExportIcon className="topbar-icon" />
                  <span className="item-label">Export…</span>
                </button>
              </div>
            )}
          </div>

          <div className="topbar-divider" aria-hidden="true" />

          <div className="topbar-group" role="group" aria-label="History">
            <button
              className="topbar-icon-btn"
              onClick={() => undo()}
              disabled={!canUndo}
              title="Undo (Ctrl+Z)"
              aria-label="Undo"
            >
              <UndoIcon className="topbar-icon" />
            </button>
            <button
              className="topbar-icon-btn"
              onClick={() => redo()}
              disabled={!canRedo}
              title="Redo (Ctrl+Shift+Z)"
              aria-label="Redo"
            >
              <RedoIcon className="topbar-icon" />
            </button>
          </div>

          <div className="topbar-divider" aria-hidden="true" />

          <div className="topbar-group" role="group" aria-label="Arrange">
            <button
              className="topbar-icon-btn"
              onClick={groupSelected}
              disabled={!canGroup || treeChangeBusy}
              title={canGroup ? "Group / Assembly (Ctrl+G) — Link objects to move together" : "Group (Ctrl+G) — Select 2 or more objects"}
              aria-label="Group"
            >
              <GroupIcon className="topbar-icon" />
            </button>
            <button
              className="topbar-icon-btn"
              onClick={() => combineSelected("union")}
              disabled={!canGroup || treeChangeBusy}
              title={canGroup ? "Combine Solid (Ctrl+Shift+B) — Fuse overlapping solids into one" : "Combine — Select 2 or more objects"}
              aria-label="Combine Solid"
            >
              <CombineIcon className="topbar-icon" />
            </button>
            <button
              className={`topbar-icon-btn ${canUngroup ? "on" : ""}`}
              onClick={ungroupSelected}
              disabled={!canUngroup || treeChangeBusy}
              title={canUngroup ? "Ungroup / Separate (Ctrl+Shift+G)" : "Ungroup — Select a group or combined solid"}
              aria-label="Ungroup"
            >
              <UngroupIcon className="topbar-icon" />
            </button>
          </div>

          <div className="topbar-divider" aria-hidden="true" />

          <div className="topbar-group" role="group" aria-label="View">
            <button
              className={`topbar-icon-btn ${objectsPanelOpen ? "on" : ""}`}
              onClick={() => setObjectsPanelOpen((v) => !v)}
              title={objectsPanelOpen ? "Hide Objects panel" : "Show Objects panel"}
              aria-pressed={objectsPanelOpen}
              aria-label="Toggle Objects panel"
            >
              <ObjectsIcon className="topbar-icon" />
            </button>
            <button
              className="topbar-icon-btn"
              onClick={() => setCameraMode((m) => (m === "perspective" ? "orthographic" : "perspective"))}
              title={
                cameraMode === "perspective"
                  ? "Perspective View (Click to switch to Orthographic)"
                  : "Orthographic View (Click to switch to Perspective)"
              }
              aria-label={
                cameraMode === "perspective"
                  ? "Perspective View"
                  : "Orthographic View"
              }
            >
              {cameraMode === "perspective" ? (
                <PerspectiveIcon className="topbar-icon" />
              ) : (
                <OrthographicIcon className="topbar-icon" />
              )}
            </button>
            <button
              className={`topbar-icon-btn ${plateVisible ? "on" : ""}`}
              onClick={() => setPlateVisible((v) => !v)}
              title={plateVisible ? "Hide build plate" : "Show build plate"}
              aria-pressed={plateVisible}
              aria-label="Toggle build plate"
            >
              <BuildPlateIcon className="topbar-icon" />
            </button>
            <button
              className={`topbar-icon-btn snap-toggle ${snapEnabled ? "on" : ""}`}
              onClick={() => setSnapEnabled((v) => !v)}
              title={
                snapEnabled
                  ? "Snap to objects on — Smart Guides appear while dragging (S). Hold Alt to bypass for one drag."
                  : "Snap to objects off (S)"
              }
              aria-pressed={snapEnabled}
              aria-label="Toggle Snap to Objects"
            >
              <MagnetIcon className="topbar-icon snap-icon" />
            </button>
            <button
              className={`topbar-icon-btn ${showSelectedCollisionContacts ? "on" : ""}`}
              onClick={() => setShowSelectedCollisionContacts((v) => !v)}
              title={
                showSelectedCollisionContacts
                  ? "Show selected collisions on — keeps touching areas highlighted after selecting an object"
                  : "Show selected collisions off"
              }
              aria-pressed={showSelectedCollisionContacts}
              aria-label="Toggle Show Selected Collisions"
            >
              <CollisionHighlightIcon className="topbar-icon" />
            </button>
          </div>
        </div>

        <div className="toolbar-spacer" />

        <div className="topbar-right">
          <span className={["status-pill", error ? "error" : busy || exporting || buildBusy ? "busy" : ""].filter(Boolean).join(" ")}>
            {error
              ? "Needs attention"
              : exporting
                ? "Exporting…"
                : buildBusy
                  ? "Finding regions…"
                  : readyExportUrl
                    ? `${exportFileName.split(".").pop()?.toUpperCase() ?? "Export"} ready`
                    : busy
                      ? "Building…"
                      : "Ready"}
          </span>

          <button
            className="topbar-btn topbar-export-btn"
            onClick={() => {
              if (readyExportUrl) {
                const a = document.createElement("a");
                a.href = readyExportUrl;
                a.download = exportFileName;
                a.click();
              } else {
                setExportModalOpen(true);
              }
            }}
            disabled={exporting}
            title="Export 3D Model (STL / 3MF)"
            aria-label="Export"
          >
            <ExportIcon className="topbar-icon" />
            <span>{exporting ? "Exporting…" : readyExportUrl ? "Download" : "Export"}</span>
          </button>

          <button
            className="topbar-icon-btn"
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            aria-label="Settings"
          >
            <SettingsIcon className="topbar-icon" />
          </button>
        </div>
      </header>

      {readyExportUrl && exportReadyNoticeOpen && (
        <div
          className={`export-ready-notice${exportDowngraded ? " downgraded" : ""}`}
          role="status"
          aria-live="polite"
        >
          <div className="export-ready-icon" aria-hidden="true">{exportDowngraded ? "!" : "✓"}</div>
          <div className="export-ready-copy">
            <strong>Your {exportFormat.toUpperCase()} is ready ({exportFileName})</strong>
            {exportDowngraded ? (
              <span>
                Part of this scene took too long to finish at {exportQuality[0].toUpperCase()}
                {exportQuality.slice(1)} quality and fell back to preview resolution instead — try a lower
                quality, or export fewer objects at once for full detail.
              </span>
            ) : (
              <span>You can download it now.</span>
            )}
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
        {/* Category 1: Selection & Transform */}
        <button
          className={toolMode === "select" ? "active" : ""}
          onClick={() => setToolMode("select")}
          title="Select and resize (V)"
          aria-label="Select tool"
        ><SelectIcon /></button>
        <button
          className={toolMode === "move" ? "active" : ""}
          onClick={() => setToolMode("move")}
          title="Move with axis controls (M)"
          aria-label="Move tool"
        ><MoveToolIcon /></button>
        <button
          className={toolMode === "rotate" ? "active" : ""}
          onClick={() => setToolMode("rotate")}
          title="Rotate (R)"
          aria-label="Rotate tool"
        ><RotateToolIcon /></button>
        <div className="tool-rail-item-container align-tool" ref={alignMenuRef}>
          <button
            className={toolMode === "align" ? "active" : ""}
            onPointerDown={(e) => { if (e.button === 0 && selectedIds.length >= 2) startAlignPressTimer(); }}
            onPointerUp={cancelAlignPressTimer}
            onPointerLeave={cancelAlignPressTimer}
            onContextMenu={(e) => {
              if (selectedIds.length >= 2) {
                e.preventDefault();
                setAlignMenuOpen((v) => !v);
              }
            }}
            onClick={() => {
              if (alignLongPressFiredRef.current) {
                alignLongPressFiredRef.current = false;
                return;
              }
              setToolMode("align");
            }}
            title={
              selectedIds.length < 2
                ? "Align (A) — select at least 2 objects"
                : alignSubMode === "box"
                  ? "Box Align (A) — hold for align options"
                  : "Node Align (A) — hold for align options"
            }
            aria-label="Align tool"
            disabled={selectedIds.length < 2}
          >
            {alignSubMode === "points" ? <AlignNodeIcon /> : <AlignToolIcon />}
          </button>
          <CornerFlyoutMark className="corner-flyout-mark align-corner-mark" />
          {alignMenuOpen && alignFlyoutPos && createPortal(
            <div
              ref={alignFlyoutRef}
              className="tool-rail-flyout align-submode-flyout"
              role="menu"
              aria-label="Align mode"
              style={{ position: "fixed", top: alignFlyoutPos.top, left: alignFlyoutPos.left, transform: "translateY(-50%)" }}
            >
              <button
                className={alignSubMode === "box" ? "active" : ""}
                onClick={() => {
                  setAlignSubMode("box");
                  setToolMode("align");
                  setAlignMenuOpen(false);
                }}
                title="Box Align — align edges, centres, or faces with anchor"
              >
                <span className="flyout-icon"><AlignToolIcon /></span>
                <span className="flyout-label">Box Align</span>
              </button>
              <button
                className={alignSubMode === "points" ? "active" : ""}
                onClick={() => {
                  setAlignSubMode("points");
                  setToolMode("align");
                  setAlignMenuOpen(false);
                }}
                title="Node Align — drag node to node"
              >
                <span className="flyout-icon"><AlignNodeIcon /></span>
                <span className="flyout-label">Node Align</span>
              </button>
            </div>,
            document.body,
          )}
        </div>
        <div className="tool-rail-item-container drop-tool" ref={dropMenuRef}>
          <button
            onPointerDown={(e) => { if (e.button === 0) startDropPressTimer(); }}
            onPointerUp={cancelDropPressTimer}
            onPointerLeave={cancelDropPressTimer}
            onClick={() => {
              // The timer already opened the menu on this same press — a
              // held-then-released click shouldn't also drop the selection.
              if (dropLongPressFiredRef.current) {
                dropLongPressFiredRef.current = false;
                return;
              }
              dropSelected();
            }}
            title={"Drop " + dropDirection.label.toLowerCase() + " (D) — hold for directions"}
            aria-label={"Drop " + dropDirection.label.toLowerCase()}
            disabled={!selectedIds.length}
          >
            <DropIcon />
          </button>
          <CornerFlyoutMark className="corner-flyout-mark drop-corner-mark" />
          {dropMenuOpen && dropFlyoutPos && createPortal(
            <div
              ref={dropFlyoutRef}
              className="tool-rail-flyout drop-direction-flyout"
              role="menu"
              aria-label="Drop direction"
              style={{ position: "fixed", top: dropFlyoutPos.top, left: dropFlyoutPos.left, transform: "translateY(-50%)" }}
            >
              {([
                ["left", "Left", [-1, 0, 0]],
                ["right", "Right", [1, 0, 0]],
                ["back", "Back", [0, -1, 0]],
                ["front", "Front", [0, 1, 0]],
                ["down", "Down", [0, 0, -1]],
                ["up", "Up", [0, 0, 1]],
              ] as [Parameters<typeof DirectionArrowIcon>[0]["direction"], string, Vec3][]).map(([arrowDir, label, direction]) => (
                <button
                  key={label}
                  className={dropDirection.label === label ? "active" : ""}
                  onClick={() => selectDropDirection(label, direction)}
                  title={"Use " + label.toLowerCase() + " for D"}
                >
                  <span className="drop-direction-arrow"><DirectionArrowIcon direction={arrowDir} /></span>
                  <span className="flyout-label">{label}</span>
                </button>
              ))}
            </div>,
            document.body,
          )}
        </div>

        <span className="tool-rail-sep" role="separator" />

        {/* Category 2: Direct Geometry Editing (Face & Edge) */}
        {([
          ["push", "Push/Pull", "Select a face to push or pull (F)"],
          ["wall", "Wall", "Hollow a shape through the selected face"],
          ["resize", "Resize Face", "Resize the selected face"],
          ["offset", "Offset & Extrude", "Offset and extrude the selected face"],
          ["fillet", "Fillet Face Border", "Round the selected face border"],
          ["chamfer", "Chamfer Face Border", "Bevel the selected face border"],
        ] as const).map(([operation, label, title]) => (
          <button
            key={operation}
            className={toolMode === "face" && faceOp === operation ? "active" : ""}
            onClick={() => { setFaceOp(operation); setToolMode("face"); }}
            title={title}
            aria-label={label}
          >
            <FaceModifierIcon kind={operation} />
          </button>
        ))}
        <button
          className={toolMode === "edge" ? "active" : ""}
          onClick={() => { setToolMode("edge"); setEdgeSelection(null); }}
          title="Select an edge to fillet or chamfer (E)"
          aria-label="Edge finishing tool"
        ><EdgeToolIcon /></button>

        <span className="tool-rail-sep" role="separator" />

        {/* Category 3: Creation & Booleans */}
        <button
          onClick={() => void openTextTool()}
          title="Add 3D text using an installed system font"
          aria-label="Add text tool"
        ><TextToolIcon /></button>
        <button
          className={toolMode === "build" ? "active" : ""}
          onClick={() => setToolMode("build")}
          title="Shape Builder: combine overlapping shapes region by region (B)"
          aria-label="Shape Builder tool"
          disabled={selectedIds.length < 2}
        >
          <ShapeBuilderIcon />
        </button>

        <span className="tool-rail-sep" role="separator" />

        {/* Category 4: View & Navigation */}
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
        <button
          onClick={zoomToSelected}
          title={selectedIds.length ? "Zoom to selected object (Z)" : "Fit all objects in view (Z)"}
          aria-label="Zoom to selected"
        >
          <ZoomToFitIcon />
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
          alignSubMode={alignSubMode}
          facePushPullEnabled={faceOp === "push"}
          placementKind={pendingPrimitive}
          resizeConstrained={resizeConstrained}
          alignFixedId={effectiveAlignFixedId}
          onSelectAnchor={handleSelectAnchor}
          wireframe={wireframe}
          snapEnabled={snapEnabled}
          gridSnapEnabled={gridSnapEnabled}
          showSelectedCollisionContacts={showSelectedCollisionContacts}
          plateVisible={plateVisible}
          plateSize={plateSize}
          displayUnit={displayUnit}
          decimalPlaces={decimalPlaces}
          onSceneReady={(scene) => { sceneRef.current = scene; }}
          onCellsChanged={setBuildCells}
          onSelect={onSelect}
          onSelectMany={onSelectMany}
          onTransform={onTransform}
          onAlign={setPositions}
          onDuplicate={onDuplicate}
          onPushPull={pushPullFace}
          onPreviewPushPull={onPreviewPushPull}
          onPushPullDistanceChange={setFaceValue}
          onSelectEdges={(id, points) => setEdgeSelection(id && points.length ? { id, points } : null)}
          onSelectFace={(id, point, normal, size, edges) => {
            const next = id && point && normal ? { id, point, normal, size, edges } : null;
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
            <strong>
              {faceOp === "push" ? "Push/Pull"
                : faceOp === "wall" ? "Wall"
                : faceOp === "resize" ? "Resize Face"
                : faceOp === "offset" ? "Offset & Extrude"
                : faceOp === "fillet" ? "Fillet Face Border"
                : "Chamfer Face Border"}
            </strong>
            <span className="face-selection-state">{faceSelection ? "Face selected" : "Select a face"}</span>
            <label>
              {faceOp === "wall" ? "Thickness"
                : faceOp === "resize" ? "Inset / outset"
                : faceOp === "offset" ? "Inset"
                : faceOp === "fillet" || faceOp === "chamfer" ? "Size"
                : "Distance"}
              <SignedMeasurementInput
                valueMm={faceValue}
                unit={displayUnit}
                decimals={decimalPlaces}
                onValue={(value) => {
                  setFaceValue(value);
                }}
                onEnter={() => faceApplyButtonRef.current?.click()}
              /> {displayUnit}
            </label>
            {faceOp === "offset" && (
              <label>
                Height
                <input type="number" step={displayStep(displayUnit, decimalPlaces)} value={fromMillimetres(faceHeight, displayUnit)}
                  onChange={(e) => setFaceHeight(toMillimetres(Number(e.target.value) || 0, displayUnit))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      faceApplyButtonRef.current?.click();
                    }
                  }} /> {displayUnit}
              </label>
            )}
            <button
              ref={faceApplyButtonRef}
              title={faceOp === "wall"
                ? "Hollow this object out, leaving a wall of this thickness and opening the selected face"
                : faceOp === "resize"
                ? "Resize the selected face in its own plane: positive grows it, negative insets it"
                : faceOp === "offset"
                ? "Inset the face's own outline, then extrude it: positive height raises a rim, negative sinks a pocket"
                : faceOp === "fillet"
                ? "Round every edge around the selected face"
                : faceOp === "chamfer"
                ? "Bevel every edge around the selected face"
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
                if (faceOp === "fillet" || faceOp === "chamfer") {
                  const distance = Math.max(0.1, Math.abs(faceValue));
                  const op: EditOp = {
                    kind: faceOp,
                    point: target.point,
                    face: { point: target.point, normal: target.normal },
                    distance,
                  };
                  const candidate: EditSpec = node?.type === "edit"
                    ? { ...(toSpec(node) as EditSpec), ops: [...node.ops, op] }
                    : {
                        type: "edit",
                        id: target.id,
                        base: toSpec(node!),
                        ops: [op],
                        position: node!.position,
                        rotation: node!.rotation,
                        scale: node!.scale,
                        isHole: node!.isHole,
                      };
                  void kernel.pruneDeadOps(candidate).then((surviving) => {
                    if (!surviving || surviving.length !== candidate.ops.length) {
                      setError(`That ${faceOp} cannot be applied to this face border at ${distance} mm.`);
                      return;
                    }
                    setError(null);
                    finishEdit(target.id, op);
                    releaseSelection();
                  }).catch((e) => setError(msg(e)));
                } else if (faceOp === "wall") {
                  const op: ShellOp = {
                    kind: "shell",
                    thickness: Math.max(0.1, faceValue),
                    points: [target.point],
                    normal: target.normal,
                  };
                  const candidate: EditSpec = node?.type === "edit"
                    ? { ...(toSpec(node) as EditSpec), ops: [...node.ops, op] }
                    : {
                        type: "edit",
                        id: target.id,
                        base: toSpec(node!),
                        ops: [op],
                        position: node!.position,
                        rotation: node!.rotation,
                        scale: node!.scale,
                        isHole: node!.isHole,
                      };
                  void kernel.pruneDeadOps(candidate).then((surviving) => {
                    const latestSurvived = !!surviving?.length &&
                      JSON.stringify(surviving[surviving.length - 1]) === JSON.stringify(op);
                    if (!surviving || !latestSurvived) {
                      setError("That wall cannot be created on this face at the selected thickness.");
                      return;
                    }
                    setError(null);
                    setEditPending(target.id);
                    if (node?.type === "edit" && surviving.length < candidate.ops.length) {
                      // A successful new wall should not keep replaying stale
                      // edge edits that the same validation proved dead.
                      setOps(target.id, surviving);
                    } else {
                      finishEdit(target.id, op);
                    }
                    releaseSelection();
                  }).catch((e) => setError(msg(e)));
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
            <div className="edge-selection-summary">
              <strong>{edgeSelection ? `${edgeSelection.points.length} edge${edgeSelection.points.length === 1 ? "" : "s"} selected` : "Select edges"}</strong>
              {edgeSelection && (
                <button
                  className="edge-clear-selection"
                  onClick={() => {
                    sceneRef.current?.clearSelectedEdges?.();
                    setEdgeSelection(null);
                  }}
                  aria-label="Clear selected edges"
                  title="Clear selected edges"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M4.5 4.5l7 7m0-7-7 7" />
                  </svg>
                </button>
              )}
            </div>
            <div className="edge-kind-buttons" role="group" aria-label="Edge finish type">
              <button
                className={edgeKind === "fillet" ? "active" : ""}
                onClick={() => setEdgeKind("fillet")}
                title="Fillet — rounded edge"
                aria-label="Fillet"
                aria-pressed={edgeKind === "fillet"}
              >
                <FaceModifierIcon kind="fillet" />
              </button>
              <button
                className={edgeKind === "chamfer" ? "active" : ""}
                onClick={() => setEdgeKind("chamfer")}
                title="Chamfer — bevelled edge"
                aria-label="Chamfer"
                aria-pressed={edgeKind === "chamfer"}
              >
                <FaceModifierIcon kind="chamfer" />
              </button>
            </div>
            <label>
              Size
              <input type="number" min="0.1" step="0.5" value={edgeDistance}
                onChange={(e) => setEdgeDistance(Math.max(0.1, Number(e.target.value) || 0.1))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void applyEdgeFinish();
                  }
                }} /> mm
            </label>
            <button disabled={!edgeSelection} onClick={() => void applyEdgeFinish()}>Apply</button>
          </div>
        )}
        {toolMode === "align" && (
          <div className="edge-bar align-bar">
            <div className="edge-kind-buttons" role="group" aria-label="Align mode">
              <button
                type="button"
                className={alignSubMode === "box" ? "active" : ""}
                onClick={() => setAlignSubMode("box")}
                title="Box Align — align edges, centres, or faces with anchor"
                aria-label="Box Align"
              >
                <span style={{ fontSize: 11, fontWeight: 700 }}>Box</span>
              </button>
              <button
                type="button"
                className={alignSubMode === "points" ? "active" : ""}
                onClick={() => setAlignSubMode("points")}
                title="Node Align — drag node to node"
                aria-label="Node Align"
              >
                <span style={{ fontSize: 11, fontWeight: 700 }}>Node</span>
              </button>
            </div>

            {alignSubMode === "box" && (
              <>
                {selectedIds.length === 2 && currentAnchorNode && currentMovingNode ? (
                  <div className="align-bar-objects">
                    <div className="align-obj-badge anchor" title="Stationary anchor (does not move)">
                      <span className="align-badge-label">Anchor:</span>
                      <strong className="align-badge-name">{currentAnchorNode.name}</strong>
                    </div>
                    <button
                      type="button"
                      className="align-swap-btn"
                      onClick={handleSwapAlign}
                      title="Swap anchor and moving object"
                      aria-label="Swap anchor and moving object"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m7 16-4-4 4-4M3 12h14M17 8l4 4-4 4M21 12H7" />
                      </svg>
                      <span>Swap</span>
                    </button>
                    <div className="align-obj-badge moving" title="Moving object (aligns to anchor)">
                      <span className="align-badge-label">Moving:</span>
                      <strong className="align-badge-name">{currentMovingNode.name}</strong>
                    </div>
                  </div>
                ) : (
                  <div className="align-bar-anchor">
                    <span style={{ color: "#6e828d", fontSize: 11 }}>Anchor:</span>
                    <strong>{currentAnchorName}</strong>
                    {selectedIds.length === 2 && (
                      <button
                        type="button"
                        className="align-swap-btn"
                        onClick={handleSwapAlign}
                        title="Designate an anchor object"
                      >
                        Set Anchor
                      </button>
                    )}
                    {selectedIds.length > 2 && (
                      <span style={{ color: "#8a9ba5", fontSize: 10 }}>
                        ({selectedIds.length - (effectiveAlignFixedId ? 1 : 0)} moving)
                      </span>
                    )}
                  </div>
                )}
                <div className="align-bar-axes">
                  <div className="align-axis-group">
                    <span className="align-axis-badge x">X</span>
                    <button type="button" className="align-axis-btn" onClick={() => sceneRef.current?.alignSelection(0, "min")} title="Align X Minimum">Min</button>
                    <button type="button" className="align-axis-btn" onClick={() => sceneRef.current?.alignSelection(0, "center")} title="Align X Centre">Mid</button>
                    <button type="button" className="align-axis-btn" onClick={() => sceneRef.current?.alignSelection(0, "max")} title="Align X Maximum">Max</button>
                  </div>
                  <div className="align-axis-group">
                    <span className="align-axis-badge y">Y</span>
                    <button type="button" className="align-axis-btn" onClick={() => sceneRef.current?.alignSelection(1, "min")} title="Align Y Minimum">Min</button>
                    <button type="button" className="align-axis-btn" onClick={() => sceneRef.current?.alignSelection(1, "center")} title="Align Y Centre">Mid</button>
                    <button type="button" className="align-axis-btn" onClick={() => sceneRef.current?.alignSelection(1, "max")} title="Align Y Maximum">Max</button>
                  </div>
                  <div className="align-axis-group">
                    <span className="align-axis-badge z">Z</span>
                    <button type="button" className="align-axis-btn" onClick={() => sceneRef.current?.alignSelection(2, "min")} title="Align Z Minimum">Min</button>
                    <button type="button" className="align-axis-btn" onClick={() => sceneRef.current?.alignSelection(2, "center")} title="Align Z Centre">Mid</button>
                    <button type="button" className="align-axis-btn" onClick={() => sceneRef.current?.alignSelection(2, "max")} title="Align Z Maximum">Max</button>
                  </div>
                </div>
              </>
            )}

            {alignSubMode === "points" && (
              <span className="align-hint">Drag a coloured node to a target node to snap</span>
            )}

            <button
              type="button"
              className="align-done-btn"
              onClick={() => setToolMode("select")}
              title="Finish aligning (Esc)"
            >
              Done
            </button>
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
            ? alignSubMode === "points"
              ? "Drag a coloured node onto a node on the other object · yellow marks the current target · release to align · Esc Select"
              : "Click a dot to align min, centre, or max · Click an object to set as anchor · Esc Select"
            : toolMode === "face"
            ? faceOp === "wall"
              ? "Select the face to leave open, set a thickness, then Hollow · Esc Select · Right-drag orbit"
              : faceOp === "resize"
              ? "Select a flat face, then use a positive value to grow its outline or a negative value to inset it · Esc Select · Right-drag orbit"
              : faceOp === "offset"
                ? "Select a flat face, set its inset and extrusion height, then Apply · Esc Select · Right-drag orbit"
              : faceOp === "fillet"
                ? "Select a face, set the border radius, then Apply · Esc Select · Right-drag orbit"
              : faceOp === "chamfer"
                ? "Select a face, set the border bevel size, then Apply · Esc Select · Right-drag orbit"
                : "Click a flat face, then drag its arrow or type a distance to push/pull · Esc Select · Right-drag orbit"
            : toolMode === "edge"
            ? "Click edges to add or remove them · adjust Size for a live preview · Enter or Apply to finish · Esc cancels · Right-drag orbit"
            : "V Select · F Face · M Move · R Rotate · A Align · Z Zoom · H Hole · T Transparent · W Wireframe · D Drop · S Snapping · Home Reset view · Drag an object to move it · Alt-drag duplicate · Shift-drag straight · Right-drag orbit"}
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
                {(() => {
                  const exportWatchdogMs = exportFormat === "3mf" ? EXPORT_MESHES_WATCHDOG_MS : EXPORT_WATCHDOG_MS;
                  return exporting && progressElapsed >= Math.round(exportWatchdogMs / 1000)
                    ? "Switching to the complete visible-mesh fallback…"
                    : progressElapsed >= 8
                    ? exporting
                      ? `High-detail export gets ${Math.round(exportWatchdogMs / 1000)}s before the complete fallback.`
                      : `Complex models can take up to ${Math.round(WATCHDOG_MS / 60_000)} min.`
                    : "Preparing geometry…";
                })()}
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
        <div className="tools-panel-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={rightPanelTab === "shapes"}
            className={`tools-panel-tab ${rightPanelTab === "shapes" ? "active" : ""}`}
            onClick={() => setRightPanelTab("shapes")}
          >
            <span>Shapes</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={rightPanelTab === "properties"}
            className={`tools-panel-tab ${rightPanelTab === "properties" ? "active" : ""}`}
            onClick={() => setRightPanelTab("properties")}
          >
            <span>Properties</span>
            {selectedIds.length > 0 && (
              <span className="tools-panel-tab-badge">{selectedIds.length}</span>
            )}
          </button>
        </div>

        {rightPanelTab === "shapes" && (
          <section className="tool-section shape-library">
          <div className="panel-heading compact shape-library-header">
            <div><h1>Shape library</h1><p>Drag or click to add</p></div>
            <button
              type="button"
              className="shape-lib-toggle-all"
              onClick={toggleAllCategories}
              title={allCategoriesOpen ? "Collapse all categories" : "Expand all categories"}
            >
              {allCategoriesOpen ? "Collapse all" : "Expand all"}
            </button>
          </div>
          <div className="shape-categories-list">
            {PRIMITIVE_CATEGORIES.map((cat) => {
              const isOpen = !!openCategories[cat.id];
              return (
                <div key={cat.id} className={`shape-category ${isOpen ? "is-open" : "is-collapsed"}`}>
                  <button
                    type="button"
                    className="shape-category-header"
                    onClick={() => toggleCategory(cat.id)}
                    aria-expanded={isOpen}
                  >
                    <span className="shape-category-title-wrap">
                      <ChevronDownIcon className={`shape-category-chevron ${isOpen ? "open" : ""}`} />
                      <span className="shape-category-title">{cat.label}</span>
                    </span>
                    <span className="shape-category-count">{cat.kinds.length}</span>
                  </button>
                  <div className={`shape-category-body ${isOpen ? "is-open" : "is-closed"}`}>
                    <div className="shape-category-content">
                      <div className="shape-grid">
                        {cat.kinds.map((kind) => {
                          // Parked alongside the two-object auto-connector — the whole
                          // feature is paused, not just that one panel, so the entry
                          // point that lets someone place a Connector at all needs to be
                          // off too.
                          const paused = kind === "connector";
                          return (
                            <button
                              key={kind}
                              className={`shape-card ${pendingPrimitive === kind ? "active" : ""} ${paused ? "paused" : ""}`}
                              disabled={paused}
                              tabIndex={isOpen ? 0 : -1}
                              title={paused ? "Paused for now — coming back to this soon" : undefined}
                              onClick={() => {
                                setPendingPrimitive(kind);
                                setToolMode("place");
                                select(null);
                              }}
                            >
                              <PrimitiveShapeIcon kind={kind} className="shape-icon-svg" />
                              <span>{PRIMITIVES[kind].label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <button className="import-btn" onClick={() => importInputRef.current?.click()}>↑ Import STL, 3MF or SVG</button>
        </section>
        )}
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
        {rightPanelTab === "properties" && (
          <div className="tools-panel-inspector-wrap">
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
              onResetParams={() => resetParams(selected.id)}
              onCreateMatchingThreadPart={() => {
                const source = selected.type === "edit" && selected.base.type === "object" ? selected.base : selected;
                if (source.type !== "object" || (source.kind !== "threadedRod" && source.kind !== "threadedNut")) return;
                const target = source.kind === "threadedRod" ? "threadedNut" : "threadedRod";
                const spacing = Math.max(source.params.headSize ?? 0, source.params.outerWidth ?? 0, source.params.diameter ?? 8) + 10;
                beginHistoryBatch();
                addPrimitive(target, [selected.position[0] + spacing, selected.position[1], selected.position[2]], selected.rotation);
                const newId = useDoc.getState().selectedIds[0];
                const preset = source.params.preset ?? 0;
                setParam(newId, "preset", preset);
                if (preset === 0) {
                  setParam(newId, "diameter", source.params.diameter ?? 8);
                  setParam(newId, "pitch", source.params.pitch ?? 1.25);
                }
                endHistoryBatch();
              }}
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
              onText={(t) => setText(selected.id, t)}
              onFontName={(fn) => setFontName(selected.id, fn)}
              fonts={textFonts}
              onPickFontFile={() => textFontInputRef.current?.click()}
              onRequestSystemFonts={requestSystemFonts}
              displayUnit={displayUnit}
              decimalPlaces={decimalPlaces}
            />
          ) : (
            <div className="inspector-empty-state">
              <div className="inspector-empty-icon">↖</div>
              <p className="inspector-empty-title">No shape selected</p>
              <p className="inspector-empty-desc">
                Click an object on the plate or in the Objects tree to view and edit its dimensions, hole toggle, and colors.
              </p>
              <button type="button" className="inspector-empty-action" onClick={() => setRightPanelTab("shapes")}>
                Browse Shapes
              </button>
            </div>
          )}
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
          </div>
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

      <SettingsModal
        open={settingsOpen}
        unit={displayUnit}
        decimals={decimalPlaces}
        appearance={appearance}
        plateVisible={plateVisible}
        plateSize={plateSize}
        snapToGrid={gridSnapEnabled}
        snapToObjects={snapEnabled}
        showSelectedCollisionContacts={showSelectedCollisionContacts}
        randomNewObjectColors={randomNewObjectColors}
        onUnit={setDisplayUnit}
        onDecimals={setDecimalPlaces}
        onAppearance={setAppearance}
        onPlateVisible={setPlateVisible}
        onPlateSize={setPlateSize}
        onSnapToGrid={setGridSnapEnabled}
        onSnapToObjects={setSnapEnabled}
        onShowSelectedCollisionContacts={setShowSelectedCollisionContacts}
        onRandomNewObjectColors={setRandomNewObjectColors}
        onClose={() => setSettingsOpen(false)}
      />

      <ExportModal
        open={exportModalOpen}
        quality={exportQuality}
        format={exportFormat}
        exporting={exporting}
        readyExportUrl={readyExportUrl}
        selectedCount={selectedIds.length}
        onQuality={setExportQuality}
        onFormat={setExportFormat}
        onExport={exportSTL}
        onClose={() => setExportModalOpen(false)}
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
