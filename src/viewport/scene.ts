import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { clearHighlights, getEdgeIndex, getFaceIndex, highlightInGeometry, syncGeometries } from "replicad-threejs-helper";
import type { ReplicadMesh, ThreeGeometry } from "replicad-threejs-helper";
import type { CellPart, FaceInfo, KernelMesh, PreviewBuild, ScenePart } from "../kernel/types";
import type { CameraMode, GroupNode, PrimitiveKind, SceneNode, Vec3 } from "../document/types";
import { DEFAULT_OBJECT_COLOR, isGroup } from "../document/types";
import { findNode, resolveNodeColor, resolveNodeTransparent } from "../document/tree";
import { loadCameraState, saveCameraState } from "../document/persist";
import { getEffectiveDefaults } from "../document/store";
import { snapBounds } from "../snapping/snap";
import type { Bounds3, SnapTarget } from "../snapping/snap";
import { SmartGuides } from "./guides";
import { CUBE_MARGIN_PX, CUBE_PX, NavCube } from "./navcube";
import { findApex, solveScaledTriangle } from "../geometry/triangle";
import { displayStep, formatLength, toMillimetres } from "../measurement";
import type { DisplayUnit } from "../measurement";

export type { CameraMode } from "../document/types";
export type ToolMode = "select" | "face" | "edge" | "place" | "move" | "rotate" | "align" | "build";
export type WireframeMode = "off" | "outlined" | "edges" | "mesh" | "xray" | "transparent";

/** How far the pointer may move between down and up and still count as a click
 *  rather than an orbit drag. */
// A mouse rarely stays within four physical pixels during a deliberate click,
// especially on a high-DPI display or when zoomed closely into a face. Seven
// pixels still makes drags engage promptly while preventing ordinary face
// clicks from being misclassified as tiny body moves.
const CLICK_SLOP_PX = 7;
const SNAP_TOLERANCE_PX = 10;
const DEG = Math.PI / 180;
/** How much a resize/align dot grows on hover — same modest pop the
 *  push/pull arrow's own hover already uses. A colour change alone read as
 *  too subtle to notice; the earlier 1.35x read as too much. */
const HOVER_GROW = 1.18;
/** Floor under a handle's world-space size — guards only the degenerate
 *  case (camera sitting on top of its own target), not a "don't get too
 *  small" minimum. worldSnapTolerance already converts a fixed on-screen
 *  size into whatever world size currently maps to it, which is what keeps
 *  a handle the same number of pixels at any zoom; a real minimum here
 *  would defeat that the moment zooming in pushed the true size below it,
 *  and the handle would stop shrinking while the model kept growing around
 *  it — reported as handles "zooming in too" when the camera zoomed in. */
const MIN_HANDLE_WORLD = 0.02;
/** Minimum gap between live push/pull preview rebuilds during a drag — each
 *  one is a real OCCT/manifold call, not free, so this bounds how often a
 *  fast mouse-move can ask for a new one. Short enough to read as live. */
const PUSH_PULL_PREVIEW_MS = 120;
const PUSH_PULL_HANDLE_SCALE = 1.7;

/**
 * One colour per axis, indexed X, Y, Z, shared by every measurement readout
 * and by the edge each one measures. Red/green/blue is the convention the
 * scene's own AxesHelper already establishes, so a reader who has seen the
 * axes needs nothing further explained; these are muted versions of it so
 * three of them can sit over a model without shouting.
 */
const AXIS_COLOR = ["#d2544c", "#3f9a55", "#4079d0"] as const;
const AXIS_COLOR_HEX = [0xd2544c, 0x3f9a55, 0x4079d0] as const;

interface GrabItem {
  id: string;
  startGroupPos: THREE.Vector3;
  pivot: THREE.Vector3;
  rotation: THREE.Euler;
}

interface BodyGrab {
  id: string;
  downScreen: { x: number; y: number };
  /** False until the pointer moves past the click threshold — before that it
   *  might still turn out to be a plain click, handled entirely by pick(). */
  active: boolean;
  /** Horizontal plane at the object's own height, so a body-drag slides it
   *  under the cursor at constant Z rather than dragging it down to Z=0. */
  plane: THREE.Plane;
  grabPoint: THREE.Vector3;
  startPos: THREE.Vector3;
  items: GrabItem[];
}

interface NavDrag {
  downScreen: { x: number; y: number };
  /** False until the pointer clears the click threshold — before that it
   *  might still turn out to be a plain click on a face (see onPointerUp). */
  active: boolean;
  target: THREE.Vector3;
  /** Aligns the world's actual up axis to +Y and back, so orbiting here uses
   *  the same up-agnostic spherical math OrbitControls itself relies on. */
  quat: THREE.Quaternion;
  quatInverse: THREE.Quaternion;
  startSpherical: THREE.Spherical;
}

interface Marquee {
  downScreen: { x: number; y: number };
  active: boolean;
  additive: boolean;
}

interface AlignPointDrag {
  sourceId: string;
  sourcePoint: THREE.Vector3;
  targetId: string | null;
  targetPoint: THREE.Vector3 | null;
}

interface PushPullDrag {
  id: string;
  /** The target face, in the kernel's ORIGINAL local frame (see
   *  kernelLocalPoint()) — what actually gets sent as the PushPullOp. */
  localPoint: Vec3;
  localNormal: Vec3;
  /** How a 2D mouse delta becomes a signed 1D distance: the screen-space
   *  (pixel) direction one world unit along the face normal projects to,
   *  and how many of those pixels correspond to that one world unit. */
  screenDir: { x: number; y: number };
  pixelsPerUnit: number;
  downScreen: { x: number; y: number };
  active: boolean;
  handle: THREE.Object3D;
  handleBasePosition: THREE.Vector3;
  worldNormal: THREE.Vector3;
  /** True when `handle` was spawned just for this one drag (a direct click
   *  on a hovered face, not a pooled arrow from updatePushPullOverlay) —
   *  onPointerUp must remove and dispose it rather than just repositioning
   *  it back, or it would be left behind as an orphan floating arrow. */
  ephemeral: boolean;
  /** The part being dragged, so the live preview (see requestPushPullPreview)
   *  can update its actual geometry, not just the arrow. */
  view: PartView;
  /** A clone of the part's geometry (and its matching pivot) as it stood
   *  before any preview update — restored exactly if the drag/pill is
   *  abandoned (Escape, or nothing ends up applied), since nothing else
   *  would otherwise revert a live preview back to the real, committed
   *  shape. Disposed once no longer needed either way (see
   *  restoreOriginalGeom/commitOrAbandonPushPull). */
  originalGeom: ThreeGeometry[];
  originalPivot: THREE.Vector3;
  /** performance.now() of the last previewLocal() call sent, so a fast drag
   *  samples at most every PUSH_PULL_PREVIEW_MS instead of on every single
   *  pointermove — each sample is a real OCCT/manifold rebuild. */
  lastPreviewAt: number;
  /** Only one expensive kernel preview may run at a time. While it is busy,
   *  pointer moves replace this value so the next rebuild jumps straight to
   *  the newest distance instead of replaying a backlog of stale positions. */
  previewInFlight: boolean;
  queuedPreviewDistance: number | null;
  /** How far the drag has reached, in WORLD millimetres — what the arrow,
   *  the pill and the user all deal in. Divide by worldPerLocal for anything
   *  the kernel sees. */
  currentDistance: number;
  /** World millimetres of face travel per millimetre of push/pull in the
   *  kernel's own frame. The two are only equal on an unscaled part — see
   *  worldPerLocalAlong(). */
  worldPerLocal: number;
}

/** What the typed-input pill would apply to while it is open. Named (rather
 *  than inlined on the field) so applyPushPull() can take one. */
interface PushPullPending {
  id: string;
  localPoint: Vec3;
  localNormal: Vec3;
  view: PartView;
  originalGeom: ThreeGeometry[];
  originalPivot: THREE.Vector3;
  worldPerLocal: number;
}

interface ResizeTarget {
  id: string;
  startScale: Vec3;
  startPosition: Vec3;
  startGroupPosition: THREE.Vector3;
  rawSize: Vec3;
  rotation: THREE.Quaternion;
}

interface ResizeDrag {
  id: string;
  targets: ResizeTarget[];
  startScale: Vec3;
  axis: 0 | 1 | 2 | null;
  lockAspectXY?: boolean;
  centreX: number;
  centreY: number;
  startDistance: number;
  startX: number;
  startY: number;
  startSize: Vec3;
  startBoxCentre: THREE.Vector3;
  cornerSigns: [number, number] | null;
  basisX: [number, number];
  basisY: [number, number];
  basisZ: [number, number];
  startPosition: Vec3;
  startGroupPosition: THREE.Vector3;
  rawSize: Vec3;
  handleSigns: Vec3;
  rotation: THREE.Quaternion;
  handleIndex: number;
}

interface PartView {
  group: THREE.Group;
  mesh: THREE.Mesh;
  wire: THREE.LineSegments;
  /** Wireframe view only: an invisible copy of the solid that fills the depth
   *  buffer, so lines on the far side are hidden by the near side. */
  occluder: THREE.Mesh;
  geom: ThreeGeometry[];
  /** Centre of the kernel geometry before it is shifted around the visual
   * pivot. Document positions still refer to the kernel's original origin. */
  pivot: THREE.Vector3;
  isHole: boolean;
  /** Planar faces, in the kernel's ORIGINAL (pre-pivot-shift) local frame —
   *  see kernelLocalPoint(). Undefined for a part with no OCCT topology. */
  faces?: FaceInfo[];
  /** How this part last resolved its appearance, from back when its node was
   *  still in the document. A part can briefly outlive its node — ungroup
   *  swaps a group for its children, and the children's meshes only arrive a
   *  rebuild later — and resolving a MISSING node hands back the default
   *  colour, so the object visibly flicked to blue for the whole wait.
   *  Reported as "when I start ungrouping the bracket it changes colour to
   *  blue". */
  lastColor?: string;
  lastTransparent?: boolean;
}

interface EdgePreviewState {
  id: string;
  originalGeom: ThreeGeometry[];
  originalPivot: THREE.Vector3;
  originalFaces?: FaceInfo[];
}

/** Straight down and straight up — the only directions gravity cares about. */
const DOWN = new THREE.Vector3(0, 0, -1);
const UP = new THREE.Vector3(0, 0, 1);

const MATERIALS = {
  wire: new THREE.LineBasicMaterial({ color: 0x38505f, transparent: true, opacity: 0.7 }),
  wireSelected: new THREE.LineBasicMaterial({ color: 0x00c4cc, transparent: true, opacity: 0.95 }),
  edgeHighlight: new THREE.LineBasicMaterial({ color: 0xff761a, depthTest: false }),
  solid: new THREE.MeshStandardMaterial({ color: 0x43aede, metalness: 0.04, roughness: 0.6 }),
  solidSelected: new THREE.MeshStandardMaterial({
    color: 0xf2a33a,
    metalness: 0.04,
    roughness: 0.45,
  }),
  // Holes are translucent but still participate in depth testing, so they are
  // properly occluded by opaque geometry in front of them.
  //
  // side is FrontSide (the default — matching `solid` below), not DoubleSide.
  // These primitives tessellate as closed, consistently-wound solids (every
  // triangle's winding faces outward — verified: see the browser diagnostic
  // in the commit that fixed this), so DoubleSide draws no faces FrontSide
  // does not already show. What it DOES do, combined with transparent +
  // depthWrite:false, is let a mesh's own back-facing (far side) triangles
  // compete with its front-facing (near side) triangles for the same pixels
  // with no per-triangle depth sort — WebGL only sorts transparent draws by
  // whole object, not by triangle. The two sides then alpha-blend in
  // arbitrary geometry order, and which one "wins" shifts with the camera
  // angle: as you orbit, the shading/silhouette warps, which reads as the
  // solid moving even though its transform never changes. FrontSide removes
  // the competing back faces entirely, so there is nothing left to mis-sort.
  hole: new THREE.MeshStandardMaterial({
    color: 0xe06a72,
    transparent: true,
    opacity: 0.38,
    depthWrite: false,
    depthTest: true,
    roughness: 0.6,
  }),
  holeSelected: new THREE.MeshStandardMaterial({
    color: 0xf2a33a,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    depthTest: true,
    roughness: 0.5,
  }),
  result: new THREE.MeshStandardMaterial({ color: 0x5bbf87, metalness: 0.04, roughness: 0.55 }),
  /** Used for individual parts while "Show merged result" is active — they
   *  show as faint translucent ghosts so the user can see the difference
   *  between the editable pieces and the final merged solid. */
  resultGhost: new THREE.MeshStandardMaterial({
    color: 0x8ab8cc,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
    depthTest: true,
    roughness: 0.6,
    side: THREE.FrontSide,
  }),
  /** TinkerCAD-style amber preview of where hovering an align dot would
   *  send an object — warmer and more visible than resultGhost since this
   *  is an active preview a person is meant to read, not a background
   *  dimming. */
  alignPreview: new THREE.MeshBasicMaterial({
    color: 0xff9f1a,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  }),
  // Material index 1 on every part's geometry (see applyMaterials) — painted
  // over whichever face group is currently hovered/clicked.
  // Using vibrant amber ensures high visibility across all solid colors
  // and prevents visual confusion with the default blue object color.
  faceHighlight: new THREE.MeshBasicMaterial({ color: 0xff9f1a, depthTest: true }),
  /** Shape Builder regions. Kept is ordinary solid; removed stays visible as
   *  a ghost so it can be clicked back rather than vanishing irretrievably;
   *  hovered is the same amber the face tool uses, so "the thing under your
   *  cursor" looks the same everywhere in the app. */
  // See-through for the whole session: every region has to be visible while
  // you decide about it, including the ones buried inside the overlap.
  cellKept: new THREE.MeshStandardMaterial({
    color: 0x43aede,
    metalness: 0.04,
    roughness: 0.55,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  }),
  cellRemoved: new THREE.MeshStandardMaterial({
    color: 0x9fb0bb,
    transparent: true,
    opacity: 0.1,
    depthWrite: false,
    roughness: 0.6,
  }),
  // Hover tints rather than repaints: a region already in the shape keeps
  // reading as part of it, and one that is still out reads as a preview of
  // what clicking would add.
  cellHover: new THREE.MeshStandardMaterial({
    color: 0x2bb3ba,
    metalness: 0.04,
    roughness: 0.5,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  }),
  cellHoverRemoved: new THREE.MeshStandardMaterial({
    color: 0xffc46b,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    roughness: 0.5,
  }),
  // Wireframe view: the actual tessellation, every triangle edge drawn and
  // nothing filled, so the far side of a shape shows through the near side.
  // The mesh stays a normal drawn object — making it invisible would take it
  // out of raycasting and leave nothing clickable.
  wireMesh: new THREE.MeshBasicMaterial({
    color: 0x8d9ba6,
    wireframe: true,
    transparent: true,
    // The tessellation is texture, not information — it says "this is a
    // wireframe" without competing with the edges that say what the shape is.
    opacity: 0.35,
  }),
  wireMeshSelected: new THREE.MeshBasicMaterial({
    color: 0x2bb3ba,
    wireframe: true,
    transparent: true,
    opacity: 0.5,
  }),
  /** Draws no colour, only depth — see PartView.occluder. The polygon offset
   *  pushes it a hair away from the camera so a shape's own lines, which sit
   *  exactly on its surface, still win the depth test against it. */
  wireOccluder: new THREE.MeshBasicMaterial({
    colorWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  }),
  /** Camera-facing silhouette for line-only mode. A sphere has only a seam as
   * a real B-Rep edge, so CAD edge lines alone make it nearly disappear. This
   * shader discards every face pixel except a roughly two-pixel band where
   * the surface normal is perpendicular to the view direction. */
  outlineSurface: new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    vertexShader: `
      varying vec3 vViewNormal;
      varying vec3 vViewPosition;
      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        vViewPosition = viewPosition.xyz;
        vViewNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: `
      varying vec3 vViewNormal;
      varying vec3 vViewPosition;
      void main() {
        float facing = abs(dot(normalize(vViewNormal), normalize(-vViewPosition)));
        float pixel = max(fwidth(facing), 0.002);
        float contour = 1.0 - smoothstep(0.0, pixel * 1.8, facing);
        if (contour < 0.02) discard;
        gl_FragColor = vec4(0.22, 0.31, 0.37, contour * 0.85);
      }
    `,
  }),
  outlineInvisible: new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: false,
  }),
  // The shape's own edges ride on top of the triangles, darker and at full
  // strength (no half-transparency, unlike over a shaded solid), so the real
  // silhouette still reads through the mesh behind it.
  wireOnly: new THREE.LineBasicMaterial({ color: 0x25313b }),
  wireOnlySelected: new THREE.LineBasicMaterial({ color: 0x00a9b7 }),
};

/**
 * Replicad's helper expects triangle indices as a plain number[]. Fast STL
 * previews deliberately use typed arrays to avoid ballooning a large scan in
 * memory, so build their Three.js buffers directly. Ordinary CAD meshes keep
 * using the helper unchanged.
 */
function syncKernelGeometry(mesh: KernelMesh, previous: ThreeGeometry[] = []): ThreeGeometry[] {
  if (Array.isArray(mesh.faces.triangles)) {
    return syncGeometries([mesh as unknown as ReplicadMesh], previous);
  }

  for (const geometry of previous) {
    geometry.faces.dispose();
    geometry.lines.dispose();
  }

  const faces = new THREE.BufferGeometry();
  const vertices =
    mesh.faces.vertices instanceof Float32Array
      ? mesh.faces.vertices.slice()
      : Float32Array.from(mesh.faces.vertices);
  const triangles =
    mesh.faces.triangles instanceof Uint32Array
      ? mesh.faces.triangles.slice()
      : Uint32Array.from(mesh.faces.triangles);
  faces.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
  faces.setIndex(new THREE.BufferAttribute(triangles, 1));

  if (mesh.faces.normals.length) {
    const normals =
      mesh.faces.normals instanceof Float32Array
        ? mesh.faces.normals.slice()
        : Float32Array.from(mesh.faces.normals);
    faces.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  } else {
    faces.computeVertexNormals();
  }
  for (const group of mesh.faces.faceGroups) faces.addGroup(group.start, group.count, 0);
  faces.computeBoundingBox();

  const lines = new THREE.BufferGeometry();
  const linePositions =
    mesh.edges.lines instanceof Float32Array
      ? mesh.edges.lines.slice()
      : Float32Array.from(mesh.edges.lines);
  lines.setAttribute("position", new THREE.BufferAttribute(linePositions, 3));
  for (const group of mesh.edges.edgeGroups) lines.addGroup(group.start, group.count, 0);
  return [{ faces, lines }];
}

/** One push/pull grip: a stubby arrow (shaft + cone) built pointing along
 *  +Y, so a single setFromUnitVectors aims it down any face normal. Drawn
 *  without depth testing so a face's own arrow is never buried in it. */
/** The centre of a kernel mesh's bounding box — the very point
 *  centreGeometry() derives a part's pivot from, read straight off a preview
 *  build without having to put it on screen first. Null for an empty mesh. */
function meshCentre(mesh: KernelMesh): THREE.Vector3 | null {
  const v = mesh.faces.vertices;
  if (!v.length) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < v.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const c = v[i + k];
      if (c < min[k]) min[k] = c;
      if (c > max[k]) max[k] = c;
    }
  }
  if (!min.every(Number.isFinite) || !max.every(Number.isFinite)) return null;
  return new THREE.Vector3(
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  );
}

function makeArrow(): THREE.Object3D {
  const material = new THREE.MeshBasicMaterial({ color: 0x2457ff, depthTest: false });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.3, 12), material);
  shaft.position.y = 0.65;
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.48, 0.85, 16), material);
  head.position.y = 1.72;
  // When a face points nearly at the camera, its normal-direction arrow is
  // foreshortened to a dot. This round grab target remains clearly visible
  // and clickable from that head-on view while still travelling on the same
  // push/pull axis.
  // Large but invisible: the old blue grab sphere covered most of the cone
  // from oblique views, making the control read as a blob pointing the wrong
  // way. Raycasting still sees this transparent mesh, so the arrow becomes
  // easier to grab without compromising its silhouette.
  const grabMaterial = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: false,
  });
  const grab = new THREE.Mesh(new THREE.SphereGeometry(0.62, 16, 12), grabMaterial);
  grab.position.y = 1.45;
  const group = new THREE.Group();
  group.add(shaft, head, grab);
  group.renderOrder = 26;
  shaft.renderOrder = 26;
  head.renderOrder = 26;
  grab.renderOrder = 27;
  return group;
}

function disposeArrow(handle: THREE.Object3D) {
  handle.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  });
}

export class Scene {
  private solidMaterialCache = new Map<string, THREE.MeshStandardMaterial>();
  private placementPreview: THREE.Mesh | null = null;

  private getSolidMaterial(
    colorHex: string = DEFAULT_OBJECT_COLOR,
    isSelected: boolean,
    transparent?: boolean,
  ): THREE.MeshStandardMaterial {
    const hex = (colorHex.startsWith("#") ? colorHex : `#${colorHex}`).toLowerCase();
    const key = `${hex}:${isSelected ? "1" : "0"}:${transparent ? "1" : "0"}`;
    let mat = this.solidMaterialCache.get(key);
    if (!mat) {
      const baseColor = new THREE.Color(hex);
      mat = new THREE.MeshStandardMaterial({
        color: baseColor,
        metalness: 0.04,
        roughness: 0.55,
        transparent: !!transparent,
        opacity: transparent ? 0.55 : 1,
        depthWrite: !transparent,
        depthTest: true,
      });
      this.solidMaterialCache.set(key, mat);
    }
    return mat;
  }

  private host: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  private controls: OrbitControls;
  private gizmo: TransformControls;
  private resizeBox = new THREE.Box3Helper(new THREE.Box3(), 0x00a9b7);
  private plateGroup = new THREE.Group();
  private plateVisible = true;
  private plateWidth = 256;
  private plateDepth = 256;
  private resizeHandles = new THREE.Group();
  private resizeHandleMeshes: THREE.Mesh[] = [];
  private resizeHoverIndex = -1;
  private resizeHoverMaterial = new THREE.MeshBasicMaterial({ color: 0xff9f1a, depthTest: false });
  /** Floating reminder shown only while a resize handle is actually being
   *  dragged — Shift/Alt are otherwise undiscoverable modifiers with no
   *  visible affordance anywhere else in the UI. The Shift/Alt keycaps
   *  light up live as each key is actually held (see updateScaleHint),
   *  not just statically listed, so it doubles as confirmation the
   *  modifier registered. */
  private scaleHintEl!: HTMLDivElement;
  private scaleHintShiftEl!: HTMLSpanElement;
  private scaleHintAltEl!: HTMLSpanElement;
  /** The align cage — always the union of every selected object, exactly
   *  like resizeBox in plain select mode (see updateResizeOverlay). Earlier
   *  attempts drew a second, separate outline per "moving" object to make
   *  the pairing legible, first amber then teal — asked back for plain: no
   *  new visual language, just the same selection cage select mode already
   *  draws, kept on screen while align is active. Depth-tested-off Box3
   *  edges over an unselected object in between read faintly rather than
   *  invisibly (see setupResizeOverlay's boxMaterial.depthTest = false) —
   *  that's the same look select mode already has with a gap between two
   *  selected objects, not a new trap. */
  private alignBox = new THREE.Box3Helper(new THREE.Box3(), 0x00a9b7);
  private alignHandles = new THREE.Group();
  private alignHandleMeshes: THREE.Mesh[] = [];
  private alignHandleGeometry: THREE.SphereGeometry | null = null;
  private alignHoverIndex = -1;
  private alignHoverMaterial = new THREE.MeshBasicMaterial({ color: 0xffe04b, depthTest: false });
  /** Faint ghosts of wherever hovering the current align dot would actually
   *  move things — shown instead of a person having to click it to find
   *  out, and cleared the instant the hover moves off. */
  private alignPreviewGroup = new THREE.Group();
  private alignPreviewMeshes: THREE.Mesh[] = [];
  private alignPointDrag: AlignPointDrag | null = null;
  private alignDragArrow = new THREE.ArrowHelper(
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1, 0xff5b13, 0.8, 0.35,
  );
  /** One arrow on the explicitly selected planar face — push/pull. */
  private pushPullHandles = new THREE.Group();
  private pushPullHandleMeshes: THREE.Object3D[] = [];
  /** id+face-count the handle pool was last built for, so it is only rebuilt
   *  when that actually changes (every other frame just repositions them). */
  private pushPullPoolKey = "";
  private pushPullDrag: PushPullDrag | null = null;
  /** Bumped whenever a push/pull drag starts, or whenever the pill actually
   *  resolves (commit or abandon) — see applyFinalPushPullPreview(). A
   *  preview response captures this at request time and checks it again on
   *  arrival: if it moved on, something newer already decided what this
   *  part's geometry should be, and a late response must not clobber that. */
  private pushPullGeneration = 0;
  /** The live push/pull readout — a real input, not just a label, so a plain
   *  click on a face (no drag) can show it ready to type an exact distance
   *  into, the same way the resize handles' dimension inputs work. See
   *  showPushPullInput()/commitOrAbandonPushPull(). */
  private pushPullLabelEl: HTMLInputElement;
  /** What the typed-input pill would apply to, while it's open — set by
   *  showPushPullInput(), read by commitOrAbandonPushPull(), cleared once it
   *  closes (blur/Enter/Escape). Carries the pre-drag geometry snapshot too,
   *  so abandoning can revert a live preview exactly. */
  private pushPullPending: PushPullPending | null = null;
  /**
   * The face a TYPED edit should act on, held independently of the pill.
   *
   * pushPullPending is torn down the moment the pill loses focus — and the
   * pill loses focus as soon as the user touches any other control, which
   * includes the operation dropdown and the distance field they have to use
   * to describe the edit in the first place. Anything driven from the bar
   * therefore cannot rely on it: by the time the button is pressed, the
   * face it was going to act on is already gone. Reported as "SIZE doesn't
   * do anything". Only originalGeom/originalPivot belong to the pill's own
   * undo snapshot; everything applyPushPull() needs is here.
   */
  private armedFace: {
    id: string;
    localPoint: Vec3;
    localNormal: Vec3;
    view: PartView;
    worldPerLocal: number;
  } | null = null;
  /** Whichever face the pointer is directly over right now — Shapr3D-style
   *  hover, independent of object selection: any face of any visible part,
   *  planar or curved, not just the arrows on a pre-selected object's own
   *  faces. Painted via faceHighlight (material index 1, see applyMaterials)
   *  on the group getFaceIndex() resolves the hit triangle to. */
  private hoverFace: { view: PartView; groupIndex: number } | null = null;
  /** A face stays selected after a click, Shapr3D-style. Only this face gets
   * the push/pull arrow; hovering no longer fills the canvas with grips. */
  private selectedFace: { partId: string; groupIndex: number } | null = null;
  private selectedEdges: { partId: string; groupIndex: number; point: Vec3; line: LineSegments2 }[] = [];
  private edgePreview: EdgePreviewState | null = null;
  private hoverEdgeLine: LineSegments2 | null = null;
  private pushPullHandleHovered = false;
  private dimensionInputs: HTMLInputElement[] = [];
  /** Floating corner labels for selected triangles (Left, Right, Apex). */
  private cornerBadges: HTMLDivElement[] = [];
  /** The positioned wrapper around each dimension input — the input itself no
   *  longer carries the layout, since it now sits beside an axis badge. */
  private dimensionPills: HTMLDivElement[] = [];
  /** A click (without a drag) on a resize handle pins its relevant dimension
   *  input open for direct Tinkercad-style numeric entry. */
  private dimensionPinnedHandleIndex = -1;
  /** Three dimension shafts plus four arrowhead strokes per axis. */
  private dimensionEdges = new THREE.LineSegments(
    new THREE.BufferGeometry()
      .setAttribute("position", new THREE.BufferAttribute(new Float32Array(90), 3))
      .setAttribute("color", new THREE.BufferAttribute(new Float32Array(90), 3)),
    new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true }),
  );
  /** Editable X/Y readouts of how far the object has moved from where the
   *  current move began — TinkerCAD's offset display. */
  private moveInputs: HTMLInputElement[] = [];
  private movePills: HTMLDivElement[] = [];
  /** Independent X/Y dimension legs on the build plate. Both terminate at
   *  the moved object, so their values never drift into empty space. */
  private moveGuide = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(12), 3),
    ),
    // depthTest stays ON, unlike the selection overlays: this leader lies on
    // the build plate, so letting the object occlude the stretch that runs
    // underneath it is what makes it read as measured along the floor rather
    // than painted across the model.
    new THREE.LineBasicMaterial({ color: 0x25313b, transparent: true, opacity: 0.7 }),
  );
  /** Where the object sat when the current move started, so the readout can
   *  show a delta rather than an absolute position. Survives the drag itself
   *  so the values stay on screen and editable afterwards, the way the
   *  push/pull pill does. Cleared by anything that makes "from there" stop
   *  meaning what it said — see clearMoveReadout. */
  private moveReadout: { id: string; startPos: THREE.Vector3 } | null = null;
  private resizeDrag: ResizeDrag | null = null;
  private resizeConstrained = true;
  private toolMode: ToolMode = "select";
  /** The face tool can select faces for several independent operations; only
   * Push/Pull is allowed to expose or drag the normal-direction arrow. */
  private facePushPullEnabled = true;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private downAt: { x: number; y: number } | null = null;
  private frame = 0;
  private altDown = false;
  private guides = new SmartGuides();
  private collisionContacts = new THREE.Group();
  /** Separate pass so no transparent model overlay can cover the gizmo. */
  private gizmoScene = new THREE.Scene();
  private collisionContactOwnerId: string | null = null;
  private collisionContactCache = new Map<string, import("../snapping/snap").ActiveSnap[]>();
  private showSelectedCollisionContacts = true;
  private collisionContactMaterial = new THREE.MeshBasicMaterial({
    color: 0xff6b35,
    transparent: true,
    opacity: 0.55,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  private parts = new Map<string, PartView>();
  private displayUnit: DisplayUnit = "mm";
  private decimalPlaces = 1;
  /**
   * A resize release folds a primitive's temporary display scale into its
   * real parameters.  The document update reaches the viewport before the
   * asynchronously rebuilt mesh does.  Keep the already-correct dragged
   * transform on screen during that short gap; otherwise the old mesh is
   * briefly drawn at unit scale and flashes back to its original size.
   */
  private pendingScaleBake = new Set<string>();
  private resultView: PartView | null = null;
  private showResult = false;
  /** Wireframe display mode: off, clean edges, full tessellated mesh, or xray. */
  private wireframe: WireframeMode = "off";
  /** Smart Guides. Off means a drag goes exactly where the pointer goes. */
  private snapEnabled = true;
  /** Independent 1 mm workplane grid snapping. */
  private gridSnapEnabled = false;
  /** Shape Builder: one view per region of the selection's arrangement, keyed
   *  by cell mask. Empty whenever the tool is not active. */
  private cellViews = new Map<number, { group: THREE.Group; mesh: THREE.Mesh; wire: THREE.LineSegments; kept: boolean }>();
  private hoverCell: number | null = null;
  /** Every region the current gesture would act on. Clicking a region that
   *  belongs to ONE shape acts on that whole shape — see cellGroup(). */
  private hoverGroup = new Set<number>();
  /** Set while the pointer is down in the builder: every region swept over
   *  takes this state, so a drag paints regions the way Illustrator's does. */
  private cellPaint: boolean | null = null;
  /** "+" or "−" next to the pointer while the builder is running: which of
   *  the two gestures a click would perform is otherwise invisible until
   *  after you have already done it. */
  private cellCursorEl: HTMLDivElement;
  /** Last pointer position over the canvas, so the badge can follow a change
   *  of modifier key without waiting for the mouse to move. */
  private cellCursorAt: { x: number; y: number } | null = null;
  private selectedIds: string[] = [];
  /** Most recent nodes passed to setPlacements, so a part that is (re)created
   *  by setParts — which runs on its own async schedule from the kernel and
   *  has no node data of its own — can be placed correctly the moment it
   *  exists, instead of sitting at the origin until some unrelated state
   *  change happens to call setPlacements again. */
  private lastNodes: SceneNode[] = [];
  /** Hierarchical containers for assembly groups so all children transform together. */
  private assemblyGroups: Map<string, THREE.Group> = new Map();
  /** Visual bounding-box center pivots for assembly groups so gizmos sit exactly on the objects. */
  private assemblyPivots: Map<string, THREE.Object3D> = new Map();
  private assemblyDragStart: { center: THREE.Vector3; position: Vec3; rotation: Vec3 } | null = null;
  /** In-progress click-and-drag-the-body move, TinkerCAD style — separate
   *  from the gizmo's own arrow-drag. See onPointerDown/onPointerMove. */
  private grab: BodyGrab | null = null;
  /** In-progress rubber-band select, started by dragging from empty space —
   *  TinkerCAD's way of selecting several objects at once. */
  private marquee: Marquee | null = null;
  private marqueeEl: HTMLDivElement;
  /** TinkerCAD-style view cube, rendered into a corner of this same canvas —
   *  see renderNavCube(). Click a face to snap to it; drag to orbit freely. */
  private navCube = new NavCube();
  private navCubeFrame: HTMLDivElement;
  private navDrag: NavDrag | null = null;
  private navAnimFrame = 0;

  private computeAssemblyCenter(gId: string): THREE.Vector3 {
    const gObj = this.assemblyGroups.get(gId);
    if (!gObj) return new THREE.Vector3();
    gObj.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(gObj);
    return box.isEmpty() ? gObj.position.clone() : box.getCenter(new THREE.Vector3());
  }

  private findRootOwner(targetId: string): string {
    const check = (list: SceneNode[]): string | null => {
      for (const node of list) {
        if (node.id === targetId) return node.id;
        if (isGroup(node) && node.op === "assembly") {
          const found = check(node.children);
          if (found) return node.id;
        }
      }
      return null;
    };
    return check(this.lastNodes) ?? targetId;
  }

  onSelectObject: ((id: string | null, additive: boolean) => void) | null = null;
  /** Marquee release: every id whose screen-space bounds landed fully inside
   *  the drawn rectangle, in no particular order. */
  onSelectMany: ((ids: string[], additive: boolean) => void) | null = null;
  onTransformObject:
    | ((id: string, patch: { position?: Vec3; rotation?: Vec3; scale?: Vec3 }) => void)
    | null = null;
  onAlignObjects: ((updates: { id: string; position: Vec3 }[]) => void) | null = null;
  /** The Exact Spacing panel's "stays fixed" object, when exactly two are
   *  selected. alignSelection() honours it: with a fixed object designated,
   *  a clicked align dot targets THAT object's own edge/centre rather than
   *  the pair's combined bounding box, so it is the one that actually never
   *  moves — matching what the panel's own label already promises, instead
   *  of the dot aligning both objects to a shared line that generally sits
   *  somewhere between them. */
  /** Shape Builder: every region and whether it is currently in the shape.
   *  The panel needs the whole list, not a count: a region enclosed inside
   *  another — a sphere's overlap with the box around it — has no visible
   *  surface to click, so the list is the only way to reach it. */
  onCellsChanged: ((cells: { mask: number; kept: boolean }[]) => void) | null = null;
  /** Fires as a gizmo drag begins and ends, so the whole drag can become a
   *  single undo step instead of one per frame. */
  onDragChange: ((dragging: boolean) => void) | null = null;
  /** Alt-drag: creates a document-side copy of `id` at its current position
   *  and returns the copy's id (or null if it no longer exists), all
   *  synchronously — the caller then drags that id instead of the original,
   *  with no kernel rebuild to wait for. */
  onDuplicateObject: ((id: string) => string | null) | null = null;
  /** Push/pull: a face on `id` was pushed or pulled by `distance` (mm, along
   *  the face's own outward normal — see PushPullOp in document/types.ts). */
  onPushPullFace:
    | ((
      id: string,
      op: { point: Vec3; normal: Vec3; distance: number },
      positionDelta: Vec3,
    ) => void)
    | null = null;
  /** Live preview during a push/pull drag — a real (throttled) kernel
   *  rebuild of just that one node with the dragged distance tentatively
   *  applied, NOT committed to the document; see requestPushPullPreview.
   *  Returns null on failure (a mid-drag distance can transiently describe
   *  something unbuildable) or if superseded by a newer request. */
  onPreviewPushPull:
    | ((id: string, op: { point: Vec3; normal: Vec3; distance: number }) => Promise<PreviewBuild | null>)
    | null = null;
  /** Live world-mm distance shown by both Push/Pull numeric controls. */
  onPushPullDistanceChange: ((distanceMm: number) => void) | null = null;
  onSelectEdges: ((id: string | null, points: Vec3[]) => void) | null = null;
  /** The face currently selected, and the kernel-local point that anchors it,
   *  so a whole-body edit driven by a face — Hollow — knows what it applies
   *  to. `point` is the same anchor push/pull stores, and it lies ON the
   *  face, which is what a FaceFinder needs to re-find it after a rebuild. */
  onSelectFace: ((id: string | null, point: Vec3 | null, normal: Vec3 | null, size: number, edges: Vec3[]) => void) | null = null;
  onPlaceSurface: ((point: Vec3, normal: Vec3) => void) | null = null;

  constructor(host: HTMLElement) {
    this.host = host;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(host.clientWidth, host.clientHeight);
    host.appendChild(this.renderer.domElement);

    // The marquee rectangle is inherently a 2D screen-space overlay, so it is
    // plain DOM/CSS rather than a projected 3D object — simpler and pixel-exact.
    this.marqueeEl = document.createElement("div");
    this.marqueeEl.style.cssText =
      "position:absolute;display:none;pointer-events:none;" +
      "border:1px solid #ffa53d;background:rgba(255,165,61,0.15);";
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    host.appendChild(this.marqueeEl);

    // Purely decorative — a soft panel behind the view cube. CSS anchors it
    // to the corner directly, so unlike the marquee it never needs updating
    // on resize; the WebGL viewport it frames is still computed in pixels
    // (see navRect()), independently, for the actual render and hit-testing.
    this.navCubeFrame = document.createElement("div");
    this.navCubeFrame.style.cssText =
      `position:absolute;top:${CUBE_MARGIN_PX}px;right:${CUBE_MARGIN_PX}px;` +
      `width:${CUBE_PX}px;height:${CUBE_PX}px;border-radius:12px;pointer-events:none;` +
      "box-shadow:0 2px 10px rgba(15,30,40,0.18);";
    host.appendChild(this.navCubeFrame);

    // The live push/pull readout ("12.5 mm") — plain DOM/CSS, same reasoning
    // as the marquee rectangle: a 2D overlay is simpler and pixel-exact here.
    // A real number input, styled like the resize handles' own dimension
    // pills (same white/teal look), not just a label: a plain click on a
    // face with no drag opens it ready to type an exact distance into,
    // same as typing an exact width/height there already works.
    this.cellCursorEl = document.createElement("div");
    this.cellCursorEl.className = "cell-cursor";
    this.cellCursorEl.setAttribute("aria-hidden", "true");
    host.appendChild(this.cellCursorEl);

    this.pushPullLabelEl = document.createElement("input");
    this.pushPullLabelEl.type = "number";
    this.pushPullLabelEl.className = "push-pull-measure";
    this.pushPullLabelEl.step = "0.5";
    this.pushPullLabelEl.title = "Push/pull distance in millimetres";
    this.pushPullLabelEl.setAttribute("aria-label", "Push/pull distance in millimetres");
    this.pushPullLabelEl.style.display = "none";
    this.pushPullLabelEl.addEventListener("input", () => {
      this.pushPullLabelEl.style.width = `${Math.max(4.2, this.pushPullLabelEl.value.length + 1.6)}ch`;
      const displayed = Number(this.pushPullLabelEl.value);
      if (Number.isFinite(displayed)) this.onPushPullDistanceChange?.(toMillimetres(displayed, this.displayUnit));
    });
    this.pushPullLabelEl.addEventListener("focus", () => this.onDragChange?.(true));
    this.pushPullLabelEl.addEventListener("blur", () => this.commitOrAbandonPushPull(true));
    this.pushPullLabelEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        this.pushPullLabelEl.blur();
      } else if (event.key === "Escape") {
        // Explicit abandon (reverts any live preview) before blur — blur's
        // own commitOrAbandonPushPull(true) call then finds pending already
        // cleared and no-ops, so this never double-applies or double-reverts.
        this.commitOrAbandonPushPull(false);
        this.pushPullLabelEl.blur();
      }
    });
    host.appendChild(this.pushPullLabelEl);

    this.setupResizeOverlay();
    this.setupAlignOverlay();
    this.setupScaleHint();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xedf1f4);
    // After the scene exists — this one adds itself to it, unlike the purely
    // DOM-side overlays set up above.
    this.setupMoveReadout();

    const savedCam = loadCameraState();
    const mode = savedCam?.mode ?? "perspective";
    const pos = savedCam?.position ?? [150, -150, 115];
    const tgt = savedCam?.target ?? [0, 0, 0];
    const posVec = new THREE.Vector3(...pos);
    const tgtVec = new THREE.Vector3(...tgt);
    const distance = posVec.distanceTo(tgtVec);

    if (mode === "orthographic") {
      const halfH = Math.tan(THREE.MathUtils.degToRad(45 / 2)) * distance;
      const halfW = halfH * this.aspect();
      const cam = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, 5000);
      cam.up.set(0, 0, 1);
      cam.position.copy(posVec);
      cam.lookAt(tgtVec);
      if (savedCam?.zoom) cam.zoom = savedCam.zoom;
      cam.updateProjectionMatrix();
      this.camera = cam;
    } else {
      const cam = this.makePerspective();
      cam.position.copy(posVec);
      cam.lookAt(tgtVec);
      if (savedCam?.zoom) cam.zoom = savedCam.zoom;
      cam.updateProjectionMatrix();
      this.camera = cam;
    }

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.applyControlBindings();
    this.controls.target.copy(tgtVec);
    this.controls.update();
    this.controls.addEventListener("change", this.onCameraChange);
    window.addEventListener("beforeunload", this.onBeforeUnload);

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    // Translation snapping follows the user's grid preference. It starts
    // free and is configured by setGridSnapEnabled after Scene creation.
    this.gizmo.setTranslationSnap(null);
    this.gizmo.setRotationSnap(15 * DEG);
    this.gizmo.showE = false;
    this.removeNegativeMoveArrowheads();
    this.gizmo.addEventListener("dragging-changed", this.onDraggingChanged);
    this.gizmo.addEventListener("objectChange", this.onGizmoChange);
    this.gizmoScene.add(this.gizmo.getHelper());
    this.scene.add(this.guides.group);
    this.collisionContacts.renderOrder = 10;
    this.scene.add(this.collisionContacts);
    this.scene.add(
      this.resizeBox,
      this.resizeHandles,
      this.alignBox,
      this.alignHandles,
      this.alignPreviewGroup,
      this.alignDragArrow,
    );
    this.scene.add(this.pushPullHandles);

    this.addLights();
    this.scene.add(this.plateGroup);
    this.rebuildPlate();

    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.addEventListener("pointermove", this.onPointerMove);
    this.renderer.domElement.addEventListener("pointerup", this.onPointerUp);
    // Right-click drives the camera (orbit), never the browser's menu.
    this.renderer.domElement.addEventListener("contextmenu", this.onContextMenu);
    // Capture phase on an ANCESTOR of the canvas — this is what lets it run
    // before TransformControls' own pointerdown listener (registered on the
    // canvas itself, and with no button check of its own) regardless of
    // which of the two was constructed first. See onGlobalPointerDown.
    this.host.addEventListener("pointerdown", this.onGlobalPointerDown, { capture: true });
    this.host.addEventListener("pointerup", this.onGlobalPointerUp, { capture: true });
    window.addEventListener("keydown", this.onModifierChange);
    window.addEventListener("keyup", this.onModifierChange);

    this.animate();
  }

  public setPlateVisible(visible: boolean) {
    this.plateVisible = visible;
    this.plateGroup.visible = visible;
  }

  public setPlateSize(width: number, depth: number) {
    const w = Math.max(10, Math.round(width));
    const d = Math.max(10, Math.round(depth));
    if (this.plateWidth === w && this.plateDepth === d) return;
    this.plateWidth = w;
    this.plateDepth = d;
    this.rebuildPlate();
  }

  public getPlateVisible(): boolean {
    return this.plateVisible;
  }

  public getPlateSize(): { width: number; depth: number } {
    return { width: this.plateWidth, depth: this.plateDepth };
  }

  private makePerspective(): THREE.PerspectiveCamera {
    const cam = new THREE.PerspectiveCamera(45, this.aspect(), 0.1, 5000);
    cam.up.set(0, 0, 1);
    return cam;
  }

  private aspect(): number {
    return this.host.clientWidth / Math.max(1, this.host.clientHeight);
  }

  private addLights() {
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(50, -80, 100);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.8);
    fill.position.set(-70, 40, -30);
    this.scene.add(fill);
  }

  private rebuildPlate() {
    while (this.plateGroup.children.length > 0) {
      const child = this.plateGroup.children[0];
      this.plateGroup.remove(child);
      if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments || child instanceof THREE.Line) {
        child.geometry?.dispose();
        if (Array.isArray(child.material)) {
          child.material.forEach((m) => m.dispose());
        } else {
          child.material?.dispose();
        }
      }
    }

    const w = this.plateWidth;
    const d = this.plateDepth;

    if (w === d) {
      const divisions = Math.max(2, Math.round(w / 8));
      const grid = new THREE.GridHelper(w, divisions, 0xd8e0e5, 0xd8e0e5);
      grid.rotation.x = Math.PI / 2;
      this.plateGroup.add(grid);
    } else {
      const base = Math.max(w, d);
      const divisions = Math.max(2, Math.round(base / 8));
      const grid = new THREE.GridHelper(base, divisions, 0xd8e0e5, 0xd8e0e5);
      grid.rotation.x = Math.PI / 2;
      grid.scale.set(w / base, 1, d / base);
      this.plateGroup.add(grid);
    }

    const axes = new THREE.AxesHelper(25);
    this.plateGroup.add(axes);

    this.plateGroup.visible = this.plateVisible;
  }

  private setupResizeOverlay() {
    this.resizeBox.visible = false;
    const boxMaterial = Array.isArray(this.resizeBox.material)
      ? this.resizeBox.material[0]
      : this.resizeBox.material;
    boxMaterial.depthTest = false;
    this.resizeBox.renderOrder = 20;

    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const cornerMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false });
    const axisMaterial = new THREE.MeshBasicMaterial({ color: 0x00a9b7, depthTest: false });
    for (let i = 0; i < 14; i++) {
      const handle = new THREE.Mesh(geometry, i < 8 ? cornerMaterial : axisMaterial);
      handle.userData.baseMaterial = handle.material;
      handle.renderOrder = 21;
      this.resizeHandles.add(handle);
      this.resizeHandleMeshes.push(handle);
    }
    this.resizeHandles.visible = false;

    const labels = ["Width", "Depth", "Height"] as const;
    for (let axis = 0; axis < labels.length; axis++) {
      const name = labels[axis];
      const { pill, input } = this.makeMeasurePill(name[0], AXIS_COLOR[axis], `${name} in millimetres`);
      pill.classList.add("dimension-pill");
      input.min = "0.01";
      input.step = "0.1";
      this.dimensionPills.push(pill);
      input.addEventListener("focus", () => this.onDragChange?.(true));
      input.addEventListener("blur", (event) => {
        this.applyTypedDimension(input);
        this.onDragChange?.(false);
        if (!this.dimensionInputs.includes(event.relatedTarget as HTMLInputElement)) {
          this.dimensionPinnedHandleIndex = -1;
          this.updateDimensionVisibility(this.resizeHoverIndex);
        }
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          input.blur();
        } else if (event.key === "Escape") {
          this.updateResizeOverlay();
          input.blur();
        }
      });
      this.host.appendChild(pill);
      this.dimensionInputs.push(input);
    }

    for (let i = 0; i < 3; i++) {
      const badge = document.createElement("div");
      badge.className = "triangle-corner-badge";
      badge.style.display = "none";
      this.host.appendChild(badge);
      this.cornerBadges.push(badge);
    }
  }

  /**
   * One floating measurement readout: a colour-coded axis badge next to an
   * editable value. The badge and border carry the axis's own colour, the same
   * one its edge is drawn in, which is what lets three numbers float over a
   * model without any of them being ambiguous about what they measure.
   */
  private makeMeasurePill(badge: string, color: string, title: string) {
    const pill = document.createElement("div");
    pill.className = "measure-pill";
    pill.style.setProperty("--axis", color);

    const axisLabel = document.createElement("span");
    axisLabel.className = "measure-axis";
    axisLabel.textContent = badge;
    pill.appendChild(axisLabel);

    const input = document.createElement("input");
    input.type = "number";
    input.title = title;
    input.setAttribute("aria-label", title);
    input.addEventListener("input", () => {
      input.style.width = `${Math.max(3.2, input.value.length + 0.6)}ch`;
    });
    pill.appendChild(input);
    return { pill, input };
  }

  /** The offset readout: one editable field per ground axis, plus the leader
   *  drawn between where the move started and where the object is now. */
  private setupMoveReadout() {
    this.moveGuide.visible = false;
    this.moveGuide.renderOrder = 21;
    this.moveGuide.frustumCulled = false;
    this.scene.add(this.moveGuide);
    this.dimensionEdges.visible = false;
    this.dimensionEdges.renderOrder = 22;
    this.dimensionEdges.frustumCulled = false;
    this.scene.add(this.dimensionEdges);

    for (let axis = 0; axis < 2; axis++) {
      const name = axis === 0 ? "X" : "Y";
      // Same axis colour as the matching size readout, so the axis is never in
      // question — the dashed border (is-offset) is what says this one is a
      // distance travelled rather than a dimension.
      const { pill, input } = this.makeMeasurePill(
        `→${name}`,
        AXIS_COLOR[axis],
        `Moved along ${name} in millimetres`,
      );
      pill.classList.add("is-offset");
      this.movePills.push(pill);
      input.step = "0.5";
      input.addEventListener("focus", () => this.onDragChange?.(true));
      input.addEventListener("blur", () => {
        this.applyTypedMove(input);
        this.onDragChange?.(false);
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") input.blur();
        else if (event.key === "Escape") {
          // Put back what it was showing, then let it close without applying.
          this.updateMoveReadout();
          input.blur();
        }
      });
      this.host.appendChild(pill);
      this.moveInputs.push(input);
    }
  }

  /** Starts (or restarts) the offset readout for a move of `id`. */
  private beginMoveReadout(id: string, startPos: THREE.Vector3) {
    this.moveReadout = { id, startPos: startPos.clone() };
  }

  private clearMoveReadout() {
    if (!this.moveReadout) return;
    this.moveReadout = null;
    this.moveGuide.visible = false;
    for (const pill of this.movePills) pill.style.display = "none";
  }

  /**
   * Positions the offset readout. Runs every frame alongside the other
   * overlays, so it follows the object and the camera without needing anything
   * to remember to refresh it.
   */
  private updateMoveReadout() {
    const readout = this.moveReadout;
    const view = readout ? this.parts.get(readout.id) : undefined;
    const visible =
      !!readout && !!view && this.toolMode === "select" && !this.showResult &&
      view.group.visible && this.selectedIds.includes(readout.id);
    this.moveGuide.visible = !!visible;
    if (!visible || !readout || !view) {
      for (const pill of this.movePills) pill.style.display = "none";
      return;
    }

    view.group.updateWorldMatrix(true, true);
    const now = view.group.position;
    const dx = now.x - readout.startPos.x;
    const dy = now.y - readout.startPos.y;

    // Draw on the build plate under the object rather than through it, so the
    // leader reads as a measurement on the ground the way TinkerCAD's does.
    // Lifted a hair off the object's base so it cannot z-fight the grid when
    // the object is sitting flat on the plate.
    const z = new THREE.Box3().setFromObject(view.group).min.z + 0.02;
    const to = new THREE.Vector3(now.x, now.y, z);
    const xFrom = new THREE.Vector3(readout.startPos.x, now.y, z);
    const yFrom = new THREE.Vector3(now.x, readout.startPos.y, z);
    const position = this.moveGuide.geometry.getAttribute("position") as THREE.BufferAttribute;
    position.setXYZ(0, xFrom.x, xFrom.y, xFrom.z);
    position.setXYZ(1, to.x, to.y, to.z);
    position.setXYZ(2, yFrom.x, yFrom.y, yFrom.z);
    position.setXYZ(3, to.x, to.y, to.z);
    position.needsUpdate = true;
    this.moveGuide.geometry.computeBoundingSphere();

    const rect = this.renderer.domElement.getBoundingClientRect();
    const legs = [
      { value: dx, from: xFrom, to },
      { value: dy, from: yFrom, to },
    ];
    const toScreen = (point: THREE.Vector3) => {
      const projected = point.clone().project(this.camera);
      return new THREE.Vector2(
        ((projected.x + 1) / 2) * rect.width,
        ((1 - projected.y) / 2) * rect.height,
      );
    };
    const legScreens = legs.map((leg) => ({ from: toScreen(leg.from), to: toScreen(leg.to) }));
    const labelPositions = legScreens.map(({ from, to: end }) => {
      const towardStart = from.clone().sub(end);
      const distance = Math.min(towardStart.length() / 2, 68);
      return towardStart.lengthSq() > 1e-6
        ? end.clone().addScaledVector(towardStart.normalize(), distance)
        : end.clone();
    });
    // Short moves still converge at the common object endpoint. Put the two
    // values into opposite narrow lanes instead of sending either one far
    // down its measurement line.
    if (Math.abs(dx) >= 0.005 && Math.abs(dy) >= 0.005 && labelPositions[0].distanceTo(labelPositions[1]) < 96) {
      const xDir = legScreens[0].to.clone().sub(legScreens[0].from).normalize();
      const yDir = legScreens[1].to.clone().sub(legScreens[1].from).normalize();
      labelPositions[0].add(new THREE.Vector2(-xDir.y, xDir.x).multiplyScalar(26));
      labelPositions[1].add(new THREE.Vector2(yDir.y, -yDir.x).multiplyScalar(26));
      if (labelPositions[0].distanceTo(labelPositions[1]) < 72) {
        labelPositions[1].addScaledVector(yDir.clone().negate(), 40);
      }
    }
    for (let i = 0; i < this.moveInputs.length; i++) {
      const input = this.moveInputs[i];
      const pill = this.movePills[i];
      const leg = legs[i];
      // A leg of zero length has no arrow to label and nowhere sensible to sit.
      if (Math.abs(leg.value) < 0.005) {
        pill.style.display = "none";
        continue;
      }
      const projectedFrom = leg.from.clone().project(this.camera);
      const projectedTo = leg.to.clone().project(this.camera);
      const fromScreen = new THREE.Vector2(
        ((projectedFrom.x + 1) / 2) * rect.width,
        ((1 - projectedFrom.y) / 2) * rect.height,
      );
      const toScreen = new THREE.Vector2(
        ((projectedTo.x + 1) / 2) * rect.width,
        ((1 - projectedTo.y) / 2) * rect.height,
      );
      let angle = Math.atan2(toScreen.y - fromScreen.y, toScreen.x - fromScreen.x) / DEG;
      if (angle > 90) angle -= 180;
      else if (angle < -90) angle += 180;
      pill.style.display = "flex";
      if (document.activeElement !== input) {
        input.value = formatLength(leg.value, this.displayUnit, this.decimalPlaces);
        input.style.width = `${Math.max(3.2, input.value.length + 0.6)}ch`;
      }
      pill.style.left = `${labelPositions[i].x}px`;
      pill.style.top = `${labelPositions[i].y}px`;
      pill.style.transform = `translate(-50%, -50%) rotate(${angle}deg)`;
    }
  }

  /** Moves the object so its offset along one axis equals the typed value,
   *  leaving the other axis (and its height) exactly where they are. */
  private applyTypedMove(input: HTMLInputElement) {
    const readout = this.moveReadout;
    const view = readout ? this.parts.get(readout.id) : undefined;
    const typed = toMillimetres(Number(input.value), this.displayUnit);
    if (!readout || !view || !Number.isFinite(typed)) {
      this.updateMoveReadout();
      return;
    }
    const axis = this.moveInputs.indexOf(input);
    const target = view.group.position.clone();
    if (axis === 0) target.x = readout.startPos.x + typed;
    else target.y = readout.startPos.y + typed;
    if (target.equals(view.group.position)) return;

    view.group.position.copy(target);
    view.group.updateWorldMatrix(true, true);
    // Same conversion the drag itself uses: the document stores a node's own
    // origin, while group.position carries the mesh pivot baked in.
    const rotatedPivot = view.pivot.clone().applyEuler(view.group.rotation);
    this.onTransformObject?.(readout.id, {
      position: [
        target.x - rotatedPivot.x,
        target.y - rotatedPivot.y,
        target.z - rotatedPivot.z,
      ],
    });
  }

  private setupAlignOverlay() {
    this.alignBox.visible = false;
    const boxMaterial = Array.isArray(this.alignBox.material)
      ? this.alignBox.material[0]
      : this.alignBox.material;
    boxMaterial.depthTest = false;
    boxMaterial.transparent = true;
    boxMaterial.opacity = 0.8;
    this.alignBox.renderOrder = 24;

    const geometry = new THREE.SphereGeometry(1, 20, 14);
    this.alignHandleGeometry = geometry;
    // Two sets of eight corner nodes. The first eight belong to the first
    // selected object and the second eight to the other object.
    for (let objectIndex = 0; objectIndex < 2; objectIndex++) {
      for (let corner = 0; corner < 8; corner++) {
        const handle = new THREE.Mesh(
          geometry,
          new THREE.MeshBasicMaterial({
            color: objectIndex === 0 ? 0xff8a4c : 0x7c68ee,
            depthTest: false,
          }),
        );
        handle.userData.alignObjectIndex = objectIndex;
        handle.userData.alignCorner = corner;
        handle.userData.baseMaterial = handle.material;
        handle.renderOrder = 25;
        this.alignHandles.add(handle);
        this.alignHandleMeshes.push(handle);
      }
    }
    this.alignHandles.visible = false;
    this.alignDragArrow.visible = false;
    (this.alignDragArrow.line.material as THREE.Material).depthTest = false;
    (this.alignDragArrow.cone.material as THREE.Material).depthTest = false;
    this.alignDragArrow.line.renderOrder = 26;
    this.alignDragArrow.cone.renderOrder = 26;
  }

  private ensureAlignHandleCount(count: number) {
    const geometry = this.alignHandleGeometry;
    if (!geometry) return;
    while (this.alignHandleMeshes.length < count) {
      const handle = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({ color: 0xffa066, depthTest: false }),
      );
      handle.userData.baseMaterial = handle.material;
      handle.renderOrder = 25;
      this.alignHandles.add(handle);
      this.alignHandleMeshes.push(handle);
    }
  }

  /** Real solid vertices from the CAD edge network. Long straight edges and
   * sampled curves contain many intermediate render points, so retain graph
   * junctions and genuine direction changes rather than rejecting the whole
   * object once it happens to contain more than a fixed number of points. */
  private alignFeaturePoints(view: PartView): THREE.Vector3[] {
    view.group.updateWorldMatrix(true, true);
    const position = view.geom[0].lines.getAttribute("position");
    const vertices = new Map<string, { point: THREE.Vector3; count: number; neighbours: Set<string> }>();
    const topologyEndpoints = new Set<string>();
    const keyFor = (point: THREE.Vector3) =>
      [point.x, point.y, point.z].map((value) => Math.round(value * 100) / 100).join("|");
    if (position) {
      for (let index = 0; index + 1 < position.count; index += 2) {
        const points = [index, index + 1].map((offset) =>
          new THREE.Vector3().fromBufferAttribute(position, offset).applyMatrix4(view.group.matrixWorld));
        const keys = points.map(keyFor);
        for (let endpoint = 0; endpoint < 2; endpoint++) {
          const key = keys[endpoint];
          const existing = vertices.get(key);
          if (existing) existing.count++;
          else vertices.set(key, { point: points[endpoint], count: 1, neighbours: new Set() });
          if (keys[0] !== keys[1]) vertices.get(key)!.neighbours.add(keys[1 - endpoint]);
        }
      }
      // Buffer groups mirror Replicad's topological CAD edges. Their first
      // and last rendered vertices are stable feature points even when the
      // edge between them is sampled into dozens of curve segments.
      for (const group of view.geom[0].lines.groups) {
        if (group.count < 1) continue;
        const firstIndex = group.start;
        const lastIndex = Math.min(position.count - 1, group.start + group.count - 1);
        topologyEndpoints.add(keyFor(
          new THREE.Vector3().fromBufferAttribute(position, firstIndex).applyMatrix4(view.group.matrixWorld),
        ));
        topologyEndpoints.add(keyFor(
          new THREE.Vector3().fromBufferAttribute(position, lastIndex).applyMatrix4(view.group.matrixWorld),
        ));
      }
    }
    const graphVertices = [...vertices.values()];
    const primaryPoints = [...vertices.entries()]
      .filter(([key, entry]) => topologyEndpoints.has(key) || entry.count >= 3 || entry.neighbours.size !== 2)
      .map(([, entry]) => entry.point);
    const featurePoints = graphVertices
      .filter((entry) => {
        if (entry.count >= 3 || entry.neighbours.size !== 2) return true;
        const [firstKey, secondKey] = [...entry.neighbours];
        const first = vertices.get(firstKey)?.point;
        const second = vertices.get(secondKey)?.point;
        if (!first || !second) return true;
        const a = first.clone().sub(entry.point).normalize();
        const b = second.clone().sub(entry.point).normalize();
        // A straight/smooth sample approaches 180 degrees. Keep a point only
        // when the edge changes direction by more than six degrees.
        return a.angleTo(b) < Math.PI - THREE.MathUtils.degToRad(6);
      })
      .map((entry) => entry.point);
    if (featurePoints.length >= 4 && featurePoints.length <= 96) return featurePoints;
    // Detailed booleans can contain hundreds of curve samples. In that case
    // keep their true edge endpoints/junctions rather than throwing every
    // feature away and reverting to an eight-corner bounding box.
    if (primaryPoints.length >= 4 && primaryPoints.length <= 96) return primaryPoints;
    const box = new THREE.Box3().setFromObject(view.group);
    const fallback: THREE.Vector3[] = [];
    for (let corner = 0; corner < 8; corner++) {
      fallback.push(new THREE.Vector3(
        corner & 1 ? box.max.x : box.min.x,
        corner & 2 ? box.max.y : box.min.y,
        corner & 4 ? box.max.z : box.min.z,
      ));
    }
    return fallback;
  }

  private setupScaleHint() {
    const el = document.createElement("div");
    el.className = "scale-hint";
    const shift = document.createElement("kbd");
    shift.textContent = "Shift";
    const alt = document.createElement("kbd");
    alt.textContent = "Alt";
    el.append(
      "Hold ",
      shift,
      " for uniform scale. ",
      alt,
      " to scale from centre",
    );
    el.style.display = "none";
    this.host.appendChild(el);
    this.scaleHintEl = el;
    this.scaleHintShiftEl = shift;
    this.scaleHintAltEl = alt;
  }

  /** Live-highlights whichever of Shift/Alt is actually held right now, so
   *  the hint doubles as confirmation a modifier registered rather than
   *  just a static legend. */
  private updateScaleHint(e: PointerEvent) {
    this.scaleHintShiftEl.classList.toggle("active", e.shiftKey);
    this.scaleHintAltEl.classList.toggle("active", e.altKey);
  }

  setResizeConstrained(value: boolean) {
    this.resizeConstrained = value;
  }

  setAlignFixedId(_id: string | null) {
    // Point-to-point Align makes the dragged object the mover and the other
    // endpoint the fixed reference, so no separate fixed-id state is needed.
  }

  /** Shares the part's own face geometry — never its own copy, so it stays in
   *  step when setParts() swaps the geometry out from under a rebuilt part.
   *  Drawn first (renderOrder -1) so the depth it lays down is already there
   *  when the lines are tested against it. */
  private makeOccluder(faces: ThreeGeometry["faces"]): THREE.Mesh {
    const occluder = new THREE.Mesh(faces, MATERIALS.wireOccluder);
    occluder.renderOrder = -1;
    occluder.visible = this.wireframe === "edges" || this.wireframe === "mesh";
    return occluder;
  }

  private makeView(mesh: KernelMesh, isHole: boolean, faces?: FaceInfo[], id?: string): PartView {
    const geom = syncKernelGeometry(mesh);
    const pivot = this.centreGeometry(geom);
    const group = new THREE.Group();
    const node = id ? findNode(this.lastNodes, id) : undefined;
    const color = resolveNodeColor(node);
    const transparent = resolveNodeTransparent(node);
    const isSelected = id ? this.selectedIds.includes(id) : false;
    const remembered = { lastColor: color, lastTransparent: transparent };

    const m = new THREE.Mesh(geom[0].faces, [
      isHole ? (isSelected ? MATERIALS.holeSelected : MATERIALS.hole) : this.getSolidMaterial(color, isSelected, transparent),
      MATERIALS.faceHighlight,
    ]);
    const wire = new THREE.LineSegments(
      geom[0].lines,
      isSelected ? MATERIALS.wireSelected : MATERIALS.wire,
    );
    const occluder = this.makeOccluder(geom[0].faces);
    group.add(m, wire, occluder);
    this.scene.add(group);
    return { group, mesh: m, wire, occluder, geom, pivot, isHole, faces, ...remembered };
  }

  /** Alt-drag needs a real Object3D to drag the instant the gesture starts —
   *  long before a document-side duplicate could round-trip through the
   *  kernel and arrive via setParts(). Cloning the source view's geometry
   *  stands in perfectly until then. The geometry buffers are deep-cloned
   *  (not shared) since setParts() later mutates a part's own geom in place
   *  as its shape changes — sharing them would let an edit to either node
   *  corrupt the other's mesh. Materials ARE shared: they are static
   *  singletons already (see MATERIALS), swapped by applyMaterials(), never
   *  owned by one part. setParts() will happily adopt this entry — reusing
   *  the id — once the duplicate's own build finally lands. */
  private cloneView(source: PartView): PartView {
    const faces = source.geom[0].faces.clone();
    const lines = source.geom[0].lines.clone();
    const geom: ThreeGeometry[] = [{ faces, lines }];
    const mesh = new THREE.Mesh(faces, Array.isArray(source.mesh.material) ? [...source.mesh.material] : source.mesh.material);
    const wire = new THREE.LineSegments(lines, source.wire.material);
    const occluder = this.makeOccluder(faces);
    const group = new THREE.Group();
    group.position.copy(source.group.position);
    group.rotation.copy(source.group.rotation);
    group.scale.copy(source.group.scale);
    group.add(mesh, wire, occluder);
    this.scene.add(group);
    return { group, mesh, wire, occluder, geom, pivot: source.pivot.clone(), isHole: source.isHole };
  }

  /** Centres both render geometries around their visible bounds. The outer
   * group can then be used as a true centre pivot for the transform gizmo. */
  private centreGeometry(geom: ThreeGeometry[]): THREE.Vector3 {
    const faces = geom[0].faces;
    faces.computeBoundingBox();
    const pivot = faces.boundingBox?.getCenter(new THREE.Vector3()) ?? new THREE.Vector3();
    faces.translate(-pivot.x, -pivot.y, -pivot.z);
    geom[0].lines.translate(-pivot.x, -pivot.y, -pivot.z);
    return pivot;
  }

  /** Replace the meshed parts. Only called when geometry actually changes. */
  setParts(parts: ScenePart[]) {
    const seen = new Set<string>();

    for (const part of parts) {
      seen.add(part.id);
      const existing = this.parts.get(part.id);
      if (existing) {
        if (this.selectedEdges.some((edge) => edge.partId === part.id)) this.clearEdgeSelection(true);
        existing.geom = syncKernelGeometry(part.mesh, existing.geom);
        existing.pivot = this.centreGeometry(existing.geom);
        existing.mesh.geometry = existing.geom[0].faces;
        existing.wire.geometry = existing.geom[0].lines;
        existing.occluder.geometry = existing.geom[0].faces;
        existing.isHole = part.isHole;
        existing.faces = part.faces;
        // A rebuild may return the same topological faces in a different
        // array order. Keep Push/Pull attached to the face's expected moved
        // position instead of blindly reusing the old group index, which can
        // highlight and arm an unrelated neighbouring face after Apply.
        if (
          this.selectedFace?.partId === part.id &&
          this.armedFace?.id === part.id &&
          part.faces?.length
        ) {
          const target = this.armedFace;
          let bestIndex = -1;
          let bestDistance = Infinity;
          for (let i = 0; i < part.faces.length; i++) {
            const candidate = part.faces[i];
            if (!candidate.planar || candidate.pushPullable === false) continue;
            const facing = candidate.normal[0] * target.localNormal[0] +
              candidate.normal[1] * target.localNormal[1] +
              candidate.normal[2] * target.localNormal[2];
            if (facing < 0.9) continue;
            const distance = Math.hypot(
              candidate.point[0] - target.localPoint[0],
              candidate.point[1] - target.localPoint[1],
              candidate.point[2] - target.localPoint[2],
            );
            if (distance < bestDistance) {
              bestDistance = distance;
              bestIndex = i;
            }
          }
          if (bestIndex >= 0) {
            this.selectedFace.groupIndex = bestIndex;
            this.armedFace = {
              ...target,
              localPoint: part.faces[bestIndex].point,
              localNormal: part.faces[bestIndex].normal,
              view: existing,
              worldPerLocal: this.worldPerLocalAlong(existing, part.faces[bestIndex].normal),
            };
          }
        }
      } else {
        this.parts.set(part.id, this.makeView(part.mesh, part.isHole, part.faces, part.id));
      }
      // This mesh now represents the baked dimensions, so its document
      // transform can safely replace the held live-drag transform.
      this.pendingScaleBake.delete(part.id);
    }

    for (const [id, view] of [...this.parts]) {
      if (seen.has(id)) continue;
      this.scene.remove(view.group);
      this.parts.delete(id);
    }
    // A part that was just created above has never had a node transform
    // applied to it (that is setPlacements' job, and nothing guarantees it
    // runs again just because the kernel finished) — apply the last-known
    // transforms now so it never renders at the origin, even momentarily.
    this.applyPlacements();
    this.applyMaterials();
    this.attachGizmo();
    // A snap against a recessed face cannot be rediscovered from the whole
    // object's outer bounds. Keep the already verified real-surface patch
    // while its owner remains selected instead of replacing it here.
    if (!this.collisionContactOwnerId || !this.selectedIds.includes(this.collisionContactOwnerId) || !this.collisionContacts.children.length) {
      this.refreshSelectedCollisionContacts();
    }
  }

  /** Shows a kernel-built fillet/chamfer without changing the document. */
  setEdgePreview(id: string | null, preview: PreviewBuild | null) {
    if (this.edgePreview && (id !== this.edgePreview.id || !preview)) {
      const saved = this.edgePreview;
      this.edgePreview = null;
      const view = this.parts.get(saved.id);
      if (view) {
        view.faces = saved.originalFaces;
        this.restoreGeom(view, saved.originalGeom, saved.originalPivot);
      } else {
        this.disposeGeom(saved.originalGeom);
      }
    }
    if (!id || !preview) return;
    const view = this.parts.get(id);
    if (!view) return;
    if (!this.edgePreview) {
      this.edgePreview = {
        id,
        originalGeom: this.cloneGeom(view.geom),
        originalPivot: view.pivot.clone(),
        originalFaces: view.faces,
      };
    }
    view.geom = syncKernelGeometry(preview.mesh, view.geom);
    view.pivot = this.centreGeometry(view.geom);
    view.mesh.geometry = view.geom[0].faces;
    view.wire.geometry = view.geom[0].lines;
    view.occluder.geometry = view.geom[0].faces;
    view.faces = preview.faces;
    this.applyPlacements();
    this.applyMaterials();
  }

  setMeasurementFormat(unit: DisplayUnit, decimalPlaces: number) {
    this.displayUnit = unit;
    this.decimalPlaces = Math.max(0, Math.min(3, decimalPlaces));
    for (const input of this.dimensionInputs) {
      input.step = String(displayStep(unit, this.decimalPlaces));
      input.setAttribute("aria-label", `Dimension in ${unit}`);
    }
    for (const input of this.moveInputs) {
      input.step = String(displayStep(unit, this.decimalPlaces));
      input.setAttribute("aria-label", `Movement in ${unit}`);
    }
    this.pushPullLabelEl.step = String(displayStep(unit, this.decimalPlaces));
    this.pushPullLabelEl.title = `Push/pull distance in ${unit}`;
    this.pushPullLabelEl.setAttribute("aria-label", `Push/pull distance in ${unit}`);
    this.updateResizeOverlay();
  }

  /** Cheap: placement and selection only, no kernel involvement. */
  setPlacements(objects: SceneNode[], selectedIds: string[]) {
    const previous = this.lastNodes;
    for (const id of selectedIds) {
      const before = findNode(previous, id);
      const after = findNode(objects, id);
      if (
        before?.type === "object" && after?.type === "object" &&
        before.scale.some((value) => Math.abs(value - 1) > 1e-4) &&
        after.scale.every((value) => Math.abs(value - 1) <= 1e-4)
      ) {
        this.pendingScaleBake.add(id);
      }
    }
    this.lastNodes = objects;
    this.dropDeletedParts(previous, objects);
    this.selectedIds = selectedIds;
    if (this.collisionContactOwnerId && !selectedIds.includes(this.collisionContactOwnerId)) {
      this.clearCollisionContacts();
    }
    if (this.selectedFace && !selectedIds.includes(this.selectedFace.partId)) {
      this.selectedFace = null;
    }
    if (this.selectedEdges.length && !selectedIds.includes(this.selectedEdges[0].partId)) {
      this.clearEdgeSelection(true);
      this.clearEdgeHover();
    }
    // "Moved this far from there" stops meaning anything once the object it
    // described is no longer the one selected.
    if (this.moveReadout && !selectedIds.includes(this.moveReadout.id)) {
      this.clearMoveReadout();
    }
    this.applyPlacements();
    this.applyMaterials();
    this.attachGizmo();
    if (!this.collisionContactOwnerId || !selectedIds.includes(this.collisionContactOwnerId) || !this.collisionContacts.children.length) {
      this.refreshSelectedCollisionContacts();
    }
  }

  /**
   * Takes deleted objects off screen at once, without waiting for the kernel.
   *
   * The document alone decides what EXISTS; the kernel only says what those
   * things look like. Leaving a deleted part up until the next rebuild landed
   * meant that on a heavy model Delete appeared to do nothing for as long as
   * the rebuild took — and the doomed part, having no node left to read a
   * colour from, sat there in the default blue while it waited.
   *
   * Re-parenting is not deletion. A child moved into a new group is still in
   * the tree, so grouping keeps showing the children until the group's own
   * mesh arrives, exactly as before.
   */
  private dropDeletedParts(previous: SceneNode[], objects: SceneNode[]) {
    const alive = new Set<string>();
    const walk = (nodes: SceneNode[]) => {
      for (const node of nodes) {
        alive.add(node.id);
        if (node.type === "group") walk(node.children);
        else if (node.type === "edit") walk([node.base]);
        else if (node.type === "build") walk(node.sources);
      }
    };
    walk(objects);

    for (const [id, view] of [...this.parts]) {
      if (alive.has(id)) continue;
      // Mid-gesture geometry belongs to that gesture until it resolves.
      if (this.pushPullDrag?.id === id || this.pushPullPending?.id === id) continue;
      // Restructuring is not deletion. Ungroup takes a group's id out of the
      // tree but every child it was made of is still there, and the parts
      // that replace it are already being built — so keep showing it until
      // they land, rather than blinking the object out of existence for the
      // length of a rebuild.
      if (this.beingReplaced(previous, id, alive)) continue;
      if (this.selectedFace?.partId === id) this.selectedFace = null;
      if (this.hoverFace?.view === view) this.hoverFace = null;
      // Matches setParts()' own removal: the geometry is not disposed here,
      // since a rebuild may hand the very same buffers straight back.
      this.scene.remove(view.group);
      this.parts.delete(id);
    }
  }

  /** Whether an id that has left the document was dismantled into pieces
   *  that are still in it (ungroup, or a build coming apart) rather than
   *  actually deleted. */
  private beingReplaced(previous: SceneNode[], id: string, alive: Set<string>): boolean {
    const was = findNode(previous, id);
    if (!was) return false;
    const pieces = was.type === "group" ? was.children : was.type === "build" ? was.sources : [];
    return pieces.length > 0 && pieces.every((piece) => alive.has(piece.id));
  }

  private applyPlacements() {
    const activeAssemblyIds = new Set<string>();

    for (const node of this.lastNodes) {
      if (isGroup(node) && node.op === "assembly") {
        activeAssemblyIds.add(node.id);
        let groupObj = this.assemblyGroups.get(node.id);
        if (!groupObj) {
          groupObj = new THREE.Group();
          groupObj.name = `Assembly-${node.id}`;
          this.scene.add(groupObj);
          this.assemblyGroups.set(node.id, groupObj);
        }

        // Only update transform if gizmo isn't actively dragging this group
        if (!this.gizmo.dragging || this.gizmo.object !== groupObj) {
          if (!this.grab?.active || !this.grab.items.some((item) => item.id === node.id)) {
            groupObj.position.set(...node.position);
            groupObj.rotation.set(node.rotation[0] * DEG, node.rotation[1] * DEG, node.rotation[2] * DEG);
            groupObj.scale.set(...node.scale);
          }
        }

        for (const child of node.children) {
          const childView = this.parts.get(child.id);
          if (!childView) continue;
          if (childView.group.parent !== groupObj) {
            groupObj.add(childView.group);
          }
          childView.group.rotation.set(child.rotation[0] * DEG, child.rotation[1] * DEG, child.rotation[2] * DEG);
          childView.group.scale.fromArray(child.scale);
          const rotatedPivot = childView.pivot.clone().applyEuler(childView.group.rotation);
          childView.group.position.set(
            child.position[0] + rotatedPivot.x,
            child.position[1] + rotatedPivot.y,
            child.position[2] + rotatedPivot.z,
          );
          childView.isHole = child.isHole;
        }
      } else {
        const view = this.parts.get(node.id);
        if (!view) continue;
        if (view.group.parent !== this.scene) {
          this.scene.add(view.group);
        }
        if (this.gizmo.dragging && this.gizmo.object === view.group) continue;
        if (this.grab?.active && this.grab.items.some((item) => item.id === node.id)) continue;
        if (this.pendingScaleBake.has(node.id)) continue;

        view.group.rotation.set(node.rotation[0] * DEG, node.rotation[1] * DEG, node.rotation[2] * DEG);
        view.group.scale.fromArray(node.scale);
        const rotatedPivot = view.pivot.clone().applyEuler(view.group.rotation);
        view.group.position.set(
          node.position[0] + rotatedPivot.x,
          node.position[1] + rotatedPivot.y,
          node.position[2] + rotatedPivot.z,
        );
        const previewing = this.pushPullDrag ?? this.pushPullPending;
        if (previewing?.id === node.id) {
          view.group.position.sub(this.pivotDrift(view, previewing.originalPivot, view.pivot));
        }
        view.isHole = node.isHole;
      }
    }

    // Clean up dismantled assembly groups and pivots
    for (const [id, groupObj] of this.assemblyGroups) {
      if (!activeAssemblyIds.has(id)) {
        this.scene.remove(groupObj);
        this.assemblyGroups.delete(id);
        const pivot = this.assemblyPivots.get(id);
        if (pivot) {
          this.scene.remove(pivot);
          this.assemblyPivots.delete(id);
        }
      }
    }
  }

  private applyMaterials() {
    for (const [id, view] of this.parts) {
      const isDirectlySelected = this.selectedIds.includes(id);
      const node = findNode(this.lastNodes, id);
      const isParentGroupSelected = this.selectedIds.some((sId) => {
        const p = findNode(this.lastNodes, sId);
        if (!p || !isGroup(p)) return false;
        const containsChild = (g: GroupNode): boolean =>
          g.children.some((c) => c.id === id || (isGroup(c) && containsChild(c)));
        return containsChild(p);
      });
      const isChildSelected = !!(node && isGroup(node) && node.children.some((c) => this.selectedIds.includes(c.id)));
      const sel = isDirectlySelected || isParentGroupSelected || isChildSelected;

      if (node) {
        view.lastColor = resolveNodeColor(node);
        view.lastTransparent = resolveNodeTransparent(node);
      }
      // Fall back to how it last looked, not to the default: see lastColor.
      const color = view.lastColor ?? resolveNodeColor(node);
      const transparent = view.lastTransparent ?? resolveNodeTransparent(node);

      // Index 1 (faceHighlight) is picked per-triangle-group by the geometry's
      // own .groups, set via highlightFace()/clearFaceHover() below — this
      // array is what makes that actually render as anything other than the
      // base material (a BufferGeometry's .groups are ignored entirely unless
      // .material is an array).
      const isOutlined = this.wireframe === "outlined";
      const isWire = isOutlined || this.wireframe === "edges" || this.wireframe === "mesh" || this.wireframe === "xray";
      const isEdgesOnly = this.wireframe === "edges";
      const isMesh = this.wireframe === "mesh";
      const isXray = this.wireframe === "xray";
      const isTransparentMode = this.wireframe === "transparent";

      if (isOutlined) {
        // Exactly Transparent view's clean CAD lines, with face opacity
        // reduced all the way to zero and no depth mask hiding rear lines.
        const sphereBase = node?.type === "object"
          ? node.kind === "sphere"
          : node?.type === "edit" && node.base.type === "object" && node.base.kind === "sphere";
        // The contour shader is only needed for a sphere, whose B-Rep has no
        // silhouette edge. On planar faces viewed edge-on it can become a
        // broad band, so ordinary edged solids keep a fully invisible mesh.
        view.mesh.material = [sphereBase ? MATERIALS.outlineSurface : MATERIALS.outlineInvisible, MATERIALS.faceHighlight];
        view.mesh.renderOrder = 0;
      } else if (isEdgesOnly) {
        // Clean CAD B-Rep edges: occluder hides back lines, mesh is invisible to color (writes depth/raycasts)
        view.mesh.material = [
          MATERIALS.wireOccluder,
          MATERIALS.faceHighlight,
        ];
        view.mesh.renderOrder = 0;
      } else if (isMesh || isXray) {
        // Tessellated mesh: triangle edges drawn
        view.mesh.material = [
          sel ? MATERIALS.wireMeshSelected : MATERIALS.wireMesh,
          MATERIALS.faceHighlight,
        ];
        view.mesh.renderOrder = 0;
      } else if (view.isHole) {
        view.mesh.material = [sel ? MATERIALS.holeSelected : MATERIALS.hole, MATERIALS.faceHighlight];
        // Draw after opaque solids while still respecting their depth.
        view.mesh.renderOrder = 2;
      } else {
        const isTrans = isTransparentMode || transparent;
        const mat = this.getSolidMaterial(color, sel, isTrans);
        view.mesh.material = [mat, MATERIALS.faceHighlight];
        view.mesh.renderOrder = isTrans ? 1 : 0;
      }
      const wireBase = isOutlined
        ? sel
          ? MATERIALS.wireSelected
          : MATERIALS.wire
        : isWire
        ? sel
          ? MATERIALS.wireOnlySelected
          : MATERIALS.wireOnly
        : sel
          ? MATERIALS.wireSelected
          : MATERIALS.wire;
      view.wire.material = [wireBase, MATERIALS.edgeHighlight];
      // A crease line sits exactly on the surface it borders. For an OCCT
      // part its edge tessellation comes from an independent pass over the
      // analytic curve, so it rarely lands on the exact same float as the
      // face mesh and depth-tests past it by accident. A manifold-tessellated
      // part's edge is built from the very same vertices as its faces —
      // truly coincident — and at equal depth, WHICHEVER of the two draws
      // second simply overwrites the other; the tie is otherwise decided by
      // material/object id, not by which one a person would want on top.
      // Ordering the wire strictly after its own mesh, every time, makes
      // "the line wins" the rule instead of an accident of the OCCT case.
      view.wire.renderOrder = view.mesh.renderOrder + 1;

      const hasActiveResult = this.showResult && !!this.resultView;
      view.occluder.visible = (isEdgesOnly || isMesh) && !hasActiveResult;
      // The eye icon in the Objects panel. A node nested in a group has no
      // ScenePart of its own (see toSpec in App.tsx), so this only ever
      // fires for a TOP-LEVEL id — exactly the case where hiding can be a
      // free visibility toggle rather than a kernel rebuild.
      const hiddenByUser = !!node?.hidden;
      if (hasActiveResult) {
        // Ghost the original part — still visible as a faint translucent
        // silhouette so the user can see what the merged result was built from.
        view.mesh.material = [MATERIALS.resultGhost, MATERIALS.faceHighlight];
        view.mesh.renderOrder = 3; // draw after the solid result
        view.wire.visible = false;
        view.group.visible = !hiddenByUser;
      } else {
        // A Shape Builder session replaces the sources with their regions;
        // leaving the sources drawn would z-fight the very geometry that came
        // out of them, and the two coincident surfaces stripe against each
        // other as the camera moves.
        view.group.visible = !this.cellViews.size && !hiddenByUser;
        view.wire.visible = true;
      }
    }
    if (this.resultView) {
      this.resultView.group.visible = this.showResult;
      if (this.wireframe === "outlined") {
        this.resultView.mesh.material = [MATERIALS.outlineInvisible, MATERIALS.faceHighlight];
        this.resultView.wire.material = MATERIALS.wire;
        this.resultView.wire.visible = true;
        this.resultView.occluder.visible = false;
      } else if (this.wireframe === "edges") {
        this.resultView.mesh.material = [MATERIALS.wireOccluder, MATERIALS.faceHighlight];
        this.resultView.wire.material = MATERIALS.wireOnly;
        this.resultView.wire.visible = true;
        this.resultView.occluder.visible = true;
      } else if (this.wireframe === "mesh" || this.wireframe === "xray") {
        this.resultView.mesh.material = [MATERIALS.wireMesh, MATERIALS.faceHighlight];
        this.resultView.wire.material = MATERIALS.wireOnly;
        this.resultView.wire.visible = true;
        this.resultView.occluder.visible = this.wireframe === "mesh";
      } else if (this.wireframe === "transparent") {
        this.resultView.mesh.material = [MATERIALS.resultGhost, MATERIALS.faceHighlight];
        this.resultView.wire.material = MATERIALS.wire;
        this.resultView.wire.visible = true;
        this.resultView.occluder.visible = false;
      } else {
        this.resultView.mesh.material = [MATERIALS.result, MATERIALS.faceHighlight];
        this.resultView.wire.material = MATERIALS.wire;
        this.resultView.wire.visible = true;
        this.resultView.occluder.visible = false;
      }
    }
    this.restoreSelectedFaceHighlight();
    this.updateResizeOverlay();
    this.updateAlignOverlay();
    this.updatePushPullOverlay();
    this.updateMoveReadout();
  }

  /** Draws a TinkerCAD-style bounds cage, eight corner handles, and editable
   * world-size readouts around the actively selected object(s). */
  private updateResizeOverlay() {
    const selectedObjects: THREE.Object3D[] = [];
    for (const id of this.selectedIds) {
      const g = this.assemblyGroups.get(id);
      if (g) {
        selectedObjects.push(g);
      } else {
        const v = this.parts.get(id);
        if (v && v.group.visible) selectedObjects.push(v.group);
      }
    }
    const visible =
      this.toolMode === "select" && !this.selectedFace && selectedObjects.length > 0 &&
      !this.showResult;
    this.resizeBox.visible = visible;
    this.resizeHandles.visible = visible;
    this.dimensionEdges.visible = false;
    for (const pill of this.dimensionPills) pill.style.display = "none";
    if (!visible) {
      if (this.resizeHoverIndex >= 0) {
        const handle = this.resizeHandleMeshes[this.resizeHoverIndex];
        handle.material = handle.userData.baseMaterial as THREE.Material;
        this.resizeHoverIndex = -1;
        for (const pill of this.dimensionPills) pill.classList.remove("hover");
      }
      for (const badge of this.cornerBadges) badge.style.display = "none";
      return;
    }

    const box = new THREE.Box3();
    for (const obj of selectedObjects) {
      obj.updateWorldMatrix(true, true);
      box.expandByObject(obj);
    }
    this.resizeBox.box.copy(box);
    this.resizeBox.updateMatrixWorld(true);

    const { min, max } = box;
    const centre = box.getCenter(new THREE.Vector3());
    let at = 0;
    for (const x of [min.x, max.x]) {
      for (const y of [min.y, max.y]) {
        for (const z of [min.z, max.z]) this.resizeHandleMeshes[at++].position.set(x, y, z);
      }
    }
    // Black one-axis handles sit at the middle of the four bottom edges,
    // matching TinkerCAD's resize controls. The final pair controls height.
    this.resizeHandleMeshes[8].position.set(min.x, centre.y, min.z);
    this.resizeHandleMeshes[9].position.set(max.x, centre.y, min.z);
    this.resizeHandleMeshes[10].position.set(centre.x, min.y, min.z);
    this.resizeHandleMeshes[11].position.set(centre.x, max.y, min.z);
    this.resizeHandleMeshes[12].position.set(centre.x, centre.y, min.z);
    this.resizeHandleMeshes[13].position.set(centre.x, centre.y, max.z);
    // worldSnapTolerance already converts a fixed SCREEN size into whatever
    // world size currently maps to it — that's what keeps the dot the same
    // number of pixels at any zoom. A `Math.max(0.6, …)` floor used to sit
    // here as a "never too small" guard, but a floor is a WORLD-space
    // minimum: once zoomed in close enough that the true constant-pixel
    // size drops under it, the dot stops shrinking while everything else on
    // screen keeps growing, so it visibly balloons the closer the camera
    // gets. MIN_HANDLE_WORLD only guards the literal-zero case (camera at
    // the target), not a "keep it visible" floor.
    const handleSize = Math.max(MIN_HANDLE_WORLD, this.worldSnapTolerance(centre) * 0.9);
    for (let i = 0; i < this.resizeHandleMeshes.length; i++) {
      const handle = this.resizeHandleMeshes[i];
      handle.userData.baseScale = handleSize;
      handle.scale.setScalar(handleSize * (i === this.resizeHoverIndex ? HOVER_GROW : 1));
    }

    const size = box.getSize(new THREE.Vector3());
    // Each readout measures ONE specific edge; drawing that edge in the same
    // colour as its pill is what makes three numbers over one model readable.
    // The three chosen edges meet end to end at two corners, so together they
    // trace a single path across the cage rather than looking scattered.
    // Stood off the cage rather than drawn along it. Laid on top of the teal
    // edge a 1px coloured line is nearly invisible (WebGL will not thicken
    // it), and it reads as part of the selection box instead of as a
    // measurement. Offsetting turns each into a dimension line clear of the
    // model, and takes its pill off the object with it. The gap is derived
    // from the same screen-space helper the handles size themselves by, so it
    // stays constant on screen at any zoom.
    const gap = Math.max(1, this.worldSnapTolerance(centre) * 2.1);
    const edges: [THREE.Vector3, THREE.Vector3][] = [
      [new THREE.Vector3(min.x, min.y - gap, min.z), new THREE.Vector3(max.x, min.y - gap, min.z)],
      [new THREE.Vector3(max.x + gap, min.y, min.z), new THREE.Vector3(max.x + gap, max.y, min.z)],
      [
        new THREE.Vector3(max.x + gap, max.y + gap, min.z),
        new THREE.Vector3(max.x + gap, max.y + gap, max.z),
      ],
    ];
    const edgePos = this.dimensionEdges.geometry.getAttribute("position") as THREE.BufferAttribute;
    const edgeCol = this.dimensionEdges.geometry.getAttribute("color") as THREE.BufferAttribute;
    const tint = new THREE.Color();
    let vertex = 0;
    for (let i = 0; i < edges.length; i++) {
      const [a, b] = edges[i];
      const direction = b.clone().sub(a).normalize();
      const perpendicular = i === 0
        ? new THREE.Vector3(0, 1, 0)
        : i === 1
          ? new THREE.Vector3(1, 0, 0)
          : new THREE.Vector3(1, 1, 0).normalize();
      const arrowLength = Math.min(a.distanceTo(b) * 0.12, gap * 0.75);
      const arrowWidth = arrowLength * 0.55;
      const segments: [THREE.Vector3, THREE.Vector3][] = [
        [a, b],
        [a, a.clone().addScaledVector(direction, arrowLength).addScaledVector(perpendicular, arrowWidth)],
        [a, a.clone().addScaledVector(direction, arrowLength).addScaledVector(perpendicular, -arrowWidth)],
        [b, b.clone().addScaledVector(direction, -arrowLength).addScaledVector(perpendicular, arrowWidth)],
        [b, b.clone().addScaledVector(direction, -arrowLength).addScaledVector(perpendicular, -arrowWidth)],
      ];
      tint.setHex(AXIS_COLOR_HEX[i]);
      for (const [from, to] of segments) {
        edgePos.setXYZ(vertex, from.x, from.y, from.z);
        edgeCol.setXYZ(vertex++, tint.r, tint.g, tint.b);
        edgePos.setXYZ(vertex, to.x, to.y, to.z);
        edgeCol.setXYZ(vertex++, tint.r, tint.g, tint.b);
      }
    }
    edgePos.needsUpdate = true;
    edgeCol.needsUpdate = true;
    this.dimensionEdges.geometry.computeBoundingSphere();

    const rect = this.renderer.domElement.getBoundingClientRect();
    const values = [size.x, size.y, size.z];
    const isSingle = this.selectedIds.length === 1;
    const singleNode = isSingle ? findNode(this.lastNodes, this.selectedIds[0]) : null;

    for (let i = 0; i < this.dimensionInputs.length; i++) {
      // Treat the value as part of the dimension line: exactly centred on its
      // midpoint, with the label's flat background creating a clean break in
      // the line. The line itself is already stood clear of the resize cage,
      // so this stays away from handles without looking like a floating card.
      const projectedA = edges[i][0].clone().project(this.camera);
      const projectedB = edges[i][1].clone().project(this.camera);
      const p = projectedA.clone().lerp(projectedB, 0.5);
      const labelPosition = new THREE.Vector2(
        ((p.x + 1) / 2) * rect.width,
        ((1 - p.y) / 2) * rect.height,
      );
      const aScreen = new THREE.Vector2(
        ((projectedA.x + 1) / 2) * rect.width,
        ((1 - projectedA.y) / 2) * rect.height,
      );
      const bScreen = new THREE.Vector2(
        ((projectedB.x + 1) / 2) * rect.width,
        ((1 - projectedB.y) / 2) * rect.height,
      );
      let labelAngle = Math.atan2(bScreen.y - aScreen.y, bScreen.x - aScreen.x) / DEG;
      // Dimension text follows the projected measurement line, but is always
      // read left-to-right/upward rather than being allowed to turn upside
      // down as the camera passes around the opposite side of the object.
      if (labelAngle > 90) labelAngle -= 180;
      else if (labelAngle < -90) labelAngle += 180;
      const input = this.dimensionInputs[i];
      if (document.activeElement !== input) {
        input.value = formatLength(values[i], this.displayUnit, this.decimalPlaces);
        input.style.width = `${Math.max(3.2, input.value.length + 0.6)}ch`;
      }
      input.dataset.nodeId = singleNode ? singleNode.id : "multi";
      input.dataset.currentSize = String(values[i]);
      const pill = this.dimensionPills[i];
      pill.style.left = `${labelPosition.x}px`;
      pill.style.top = `${labelPosition.y}px`;
      pill.style.transform = `translate(-50%, -50%) rotate(${labelAngle}deg)`;
    }

    // Position corner badges for selected triangle
    const isSingleTriangle =
      isSingle &&
      singleNode?.type === "object" &&
      singleNode?.kind === "triangle";

    if (!isSingleTriangle || !singleNode || singleNode.type !== "object") {
      for (const badge of this.cornerBadges) badge.style.display = "none";
    } else {
      const view = this.parts.get(singleNode.id);
      if (view) {
        try {
          const solved = solveScaledTriangle(singleNode.params, singleNode.scale);
          const rawApex = findApex(singleNode.params, singleNode.params.base ?? 0);
          const b = singleNode.params.base ?? 0;
          const ax = rawApex.x;
          const ay = rawApex.y;
          const thickness = singleNode.params.thickness ?? 5;

          const localCorners = [
            new THREE.Vector3(0, 0, thickness).sub(view.pivot),
            new THREE.Vector3(b, 0, thickness).sub(view.pivot),
            new THREE.Vector3(ax, ay, thickness).sub(view.pivot),
          ];

          const lockFlags = [
            !!singleNode.params.lockAngleLeft,
            !!singleNode.params.lockAngleRight,
            !!singleNode.params.lockAngleApex,
          ];
          const angleValues = [
            solved.angles.left,
            solved.angles.right,
            solved.angles.apex,
          ];
          const names = ["Left", "Right", "Apex"];

          view.group.updateWorldMatrix(true, true);

          for (let i = 0; i < 3; i++) {
            const worldPoint = localCorners[i].clone().applyMatrix4(view.group.matrixWorld);
            const screenP = worldPoint.project(this.camera);

            if (screenP.z > 1) {
              this.cornerBadges[i].style.display = "none";
              continue;
            }

            const badge = this.cornerBadges[i];
            const isLocked = lockFlags[i];
            badge.innerHTML = `
              <span class="corner-dot dot-${i}"></span>
              <span class="corner-name">${names[i]}</span>
              <span class="corner-angle">${angleValues[i].toFixed(1)}°</span>
              ${isLocked ? '<span class="corner-lock">🔒</span>' : ""}
            `;
            badge.className = `triangle-corner-badge ${isLocked ? "locked" : ""}`;
            badge.style.display = "flex";
            badge.style.left = `${((screenP.x + 1) / 2) * rect.width}px`;
            badge.style.top = `${((1 - screenP.y) / 2) * rect.height}px`;
          }
        } catch {
          for (const badge of this.cornerBadges) badge.style.display = "none";
        }
      } else {
        for (const badge of this.cornerBadges) badge.style.display = "none";
      }
    }
    this.updateDimensionVisibility(
      this.resizeDrag?.handleIndex ??
      (this.dimensionPinnedHandleIndex >= 0 ? this.dimensionPinnedHandleIndex : this.resizeHoverIndex),
    );
  }

  private updateDimensionVisibility(handleIndex: number) {
    const active = this.resizeHandles.visible && handleIndex >= 0;
    this.dimensionEdges.visible = active;
    if (!active) {
      this.dimensionEdges.geometry.setDrawRange(0, 0);
      for (const pill of this.dimensionPills) pill.style.display = "none";
      return;
    }
    let axis: number | null = null;
    if (handleIndex >= 8) {
      if (this.resizeDrag) {
        axis = this.resizeDrag.axis;
      } else {
        const firstId = this.selectedIds[0];
        const v = firstId ? this.parts.get(firstId) : null;
        if (v) {
          const invQuat = v.group.getWorldQuaternion(new THREE.Quaternion()).invert();
          const worldDir = new THREE.Vector3(
            handleIndex === 8 ? -1 : handleIndex === 9 ? 1 : 0,
            handleIndex === 10 ? -1 : handleIndex === 11 ? 1 : 0,
            handleIndex === 12 ? -1 : handleIndex === 13 ? 1 : 0,
          );
          const localDir = worldDir.applyQuaternion(invQuat);
          const ax = Math.abs(localDir.x);
          const ay = Math.abs(localDir.y);
          const az = Math.abs(localDir.z);
          axis = (ax >= ay && ax >= az) ? 0 : (ay >= ax && ay >= az) ? 1 : 2;
        } else {
          axis = Math.floor((handleIndex - 8) / 2);
        }
      }
    }
    this.dimensionEdges.geometry.setDrawRange(axis === null ? 0 : axis * 10, axis === null ? 30 : 10);
    for (let i = 0; i < this.dimensionPills.length; i++) {
      this.dimensionPills[i].style.display = axis === null || axis === i ? "flex" : "none";
    }
  }

  /** TinkerCAD-style hover state for the eight corner resize points. Besides
   * making the active point unmistakable, it calls attention to the three
   * live size readouts without starting a resize gesture. Applies to both
   * corner points and the six dark-blue single-axis handles. */
  private updateResizeHover(e: PointerEvent) {
    let next = -1;
    if (this.resizeHandles.visible && this.toolMode === "select") {
      const rect = this.renderer.domElement.getBoundingClientRect();
      let nearest = 16;
      for (let i = 0; i < this.resizeHandleMeshes.length; i++) {
        const p = this.resizeHandleMeshes[i].position.clone().project(this.camera);
        const x = rect.left + ((p.x + 1) / 2) * rect.width;
        const y = rect.top + ((1 - p.y) / 2) * rect.height;
        const distance = Math.hypot(e.clientX - x, e.clientY - y);
        if (distance < nearest) { nearest = distance; next = i; }
      }
    }
    if (next === this.resizeHoverIndex) return;
    if (this.resizeHoverIndex >= 0) {
      const old = this.resizeHandleMeshes[this.resizeHoverIndex];
      old.material = old.userData.baseMaterial as THREE.Material;
      old.scale.setScalar(old.userData.baseScale ?? 1);
    }
    this.resizeHoverIndex = next;
    if (next >= 0) {
      const handle = this.resizeHandleMeshes[next];
      handle.material = this.resizeHoverMaterial;
      handle.scale.setScalar((handle.userData.baseScale ?? 1) * HOVER_GROW);
    }
    for (const pill of this.dimensionPills) pill.classList.toggle("hover", next >= 0);
    this.updateDimensionVisibility(
      this.resizeDrag?.handleIndex ??
      (this.dimensionPinnedHandleIndex >= 0 ? this.dimensionPinnedHandleIndex : next),
    );
    this.renderer.domElement.style.cursor = next < 0 ? "" : next < 8 ? "nwse-resize" : "pointer";
  }

  /** Cage with TinkerCAD-style min/centre/max dots — around the pair's
   *  combined extent normally, but around just the Exact Spacing panel's
   *  fixed object when one is designated. Dots positioned off the combined
   *  box put "align to this object's own edge" out of reach the moment the
   *  OTHER object happened to stick out further — there was no dot left
   *  sitting on the fixed object at all for that axis, only on whichever
   *  object was currently the extreme. Since a fixed object is exactly what
   *  alignMoves already targets instead of the union, the dots now show
   *  where that reference actually is, not the union's own extent. */
  private updateAlignOverlay() {
    const entries = this.selectedIds
      .map((id) => ({ id, view: this.parts.get(id) }))
      .filter((item): item is { id: string; view: PartView } => !!item.view && item.view.group.visible);
    const visible = this.toolMode === "align" && entries.length === 2 && !this.showResult;
    this.alignBox.visible = visible;
    this.alignHandles.visible = visible;
    if (!visible) {
      if (this.alignHoverIndex >= 0) {
        const handle = this.alignHandleMeshes[this.alignHoverIndex];
        handle.material = handle.userData.baseMaterial as THREE.Material;
        this.alignHoverIndex = -1;
      }
      this.clearAlignPreview();
      return;
    }

    for (const { view } of entries) view.group.updateWorldMatrix(true, true);
    const union = new THREE.Box3();
    for (const { view } of entries) union.expandByObject(view.group);
    this.alignBox.box.copy(union);
    this.alignBox.updateMatrixWorld(true);

    const featurePoints = entries.map(({ view }) => this.alignFeaturePoints(view));
    const totalHandles = featurePoints.reduce((sum, points) => sum + points.length, 0);
    this.ensureAlignHandleCount(totalHandles);
    let handleIndex = 0;
    for (let objectIndex = 0; objectIndex < 2; objectIndex++) {
      for (let pointIndex = 0; pointIndex < featurePoints[objectIndex].length; pointIndex++) {
        const handle = this.alignHandleMeshes[handleIndex++];
        handle.visible = true;
        handle.position.copy(featurePoints[objectIndex][pointIndex]);
        handle.userData.alignObjectIndex = objectIndex;
        handle.userData.alignPointIndex = pointIndex;
        (handle.userData.baseMaterial as THREE.MeshBasicMaterial).color.setHex(
          objectIndex === 0 ? 0xff8a4c : 0x7c68ee,
        );
      }
    }
    for (; handleIndex < this.alignHandleMeshes.length; handleIndex++) this.alignHandleMeshes[handleIndex].visible = false;
    // See the matching comment in updateResizeOverlay — a world-space floor
    // here breaks the constant-screen-size these dots are meant to have.
    const handleSize = Math.max(MIN_HANDLE_WORLD, this.worldSnapTolerance(union.getCenter(new THREE.Vector3())) * 0.62);
    for (let i = 0; i < this.alignHandleMeshes.length; i++) {
      const handle = this.alignHandleMeshes[i];
      handle.userData.baseScale = handleSize;
      handle.scale.setScalar(handleSize * (i === this.alignHoverIndex ? HOVER_GROW : 1));
    }
  }

  /** Same nearest-on-screen hover as the resize corners (updateResizeHover):
   *  highlights whichever align dot the pointer is closest to, without
   *  requiring a pixel-perfect hit on a handle rendered at world scale. */
  private updateAlignHover(e: PointerEvent) {
    if (this.alignPointDrag) {
      this.updateAlignPointDrag(e);
      return;
    }
    let next = -1;
    if (this.alignHandles.visible) {
      const rect = this.renderer.domElement.getBoundingClientRect();
      let nearest = 16;
      for (let i = 0; i < this.alignHandleMeshes.length; i++) {
        if (!this.alignHandleMeshes[i].visible) continue;
        const p = this.alignHandleMeshes[i].position.clone().project(this.camera);
        const x = rect.left + ((p.x + 1) / 2) * rect.width;
        const y = rect.top + ((1 - p.y) / 2) * rect.height;
        const distance = Math.hypot(e.clientX - x, e.clientY - y);
        if (distance < nearest) { nearest = distance; next = i; }
      }
    }
    if (next === this.alignHoverIndex) return;
    if (this.alignHoverIndex >= 0) {
      const old = this.alignHandleMeshes[this.alignHoverIndex];
      old.material = old.userData.baseMaterial as THREE.Material;
      old.scale.setScalar(old.userData.baseScale ?? 1);
    }
    this.alignHoverIndex = next;
    if (next >= 0) {
      const handle = this.alignHandleMeshes[next];
      handle.material = this.alignHoverMaterial;
      handle.scale.setScalar((handle.userData.baseScale ?? 1) * HOVER_GROW);
    }
    if (this.alignHandles.visible) {
      this.renderer.domElement.style.cursor = next < 0 ? "" : "pointer";
    }
  }

  private beginAlign(e: PointerEvent): boolean {
    if (!this.alignHandles.visible) return false;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.alignHandleMeshes, false)[0]?.object as THREE.Mesh | undefined;
    if (!hit) return false;
    const objectIndex = hit.userData.alignObjectIndex as number;
    const sourceId = this.selectedIds[objectIndex];
    if (!sourceId) return false;
    this.alignPointDrag = {
      sourceId,
      sourcePoint: hit.position.clone(),
      targetId: null,
      targetPoint: null,
    };
    this.controls.enabled = false;
    this.gizmo.enabled = false;
    this.alignDragArrow.position.copy(hit.position);
    this.alignDragArrow.setLength(0.001, 0.001, 0.001);
    this.alignDragArrow.visible = true;
    this.onDragChange?.(true);
    e.preventDefault();
    return true;
  }

  private updateAlignPointDrag(e: PointerEvent) {
    const drag = this.alignPointDrag;
    if (!drag) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    let nearest: THREE.Mesh | null = null;
    let nearestDistance = 28;
    for (const handle of this.alignHandleMeshes) {
      if (!handle.visible) continue;
      const objectIndex = handle.userData.alignObjectIndex as number;
      if (this.selectedIds[objectIndex] === drag.sourceId) continue;
      const projected = handle.position.clone().project(this.camera);
      const x = rect.left + ((projected.x + 1) / 2) * rect.width;
      const y = rect.top + ((1 - projected.y) / 2) * rect.height;
      const distance = Math.hypot(e.clientX - x, e.clientY - y);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = handle;
      }
    }
    const targetObjectIndex = nearest?.userData.alignObjectIndex as number | undefined;
    drag.targetId = targetObjectIndex === undefined ? null : this.selectedIds[targetObjectIndex] ?? null;
    drag.targetPoint = nearest?.position.clone() ?? null;
    const end = drag.targetPoint ?? this.pointerWorldAtDepth(e, drag.sourcePoint);
    const direction = end.clone().sub(drag.sourcePoint);
    const length = direction.length();
    this.alignDragArrow.position.copy(drag.sourcePoint);
    if (length > 1e-6) {
      this.alignDragArrow.setDirection(direction.normalize());
      this.alignDragArrow.setLength(length, Math.min(length * 0.22, 1.2), Math.min(length * 0.12, 0.55));
    }
    this.clearAlignPreview();
    if (drag.targetPoint) this.showAlignPointPreview(drag.sourceId, drag.targetPoint.clone().sub(drag.sourcePoint));
    for (let index = 0; index < this.alignHandleMeshes.length; index++) {
      const handle = this.alignHandleMeshes[index];
      handle.material = handle === nearest ? this.alignHoverMaterial : handle.userData.baseMaterial as THREE.Material;
    }
  }

  private pointerWorldAtDepth(e: PointerEvent, reference: THREE.Vector3) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const projected = reference.clone().project(this.camera);
    return new THREE.Vector3(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
      projected.z,
    ).unproject(this.camera);
  }

  private showAlignPointPreview(id: string, delta: THREE.Vector3) {
    const view = this.parts.get(id);
    if (!view) return;
    const ghost = new THREE.Mesh(view.geom[0].faces, MATERIALS.alignPreview);
    ghost.position.copy(view.group.position).add(delta);
    ghost.rotation.copy(view.group.rotation);
    ghost.scale.copy(view.group.scale);
    ghost.renderOrder = 30;
    this.alignPreviewGroup.add(ghost);
    this.alignPreviewMeshes.push(ghost);
  }

  private finishAlignPointDrag() {
    const drag = this.alignPointDrag;
    this.alignPointDrag = null;
    this.alignDragArrow.visible = false;
    this.controls.enabled = true;
    this.gizmo.enabled = true;
    this.clearAlignPreview();
    this.onDragChange?.(false);
    if (!drag?.targetId || !drag.targetPoint) return;
    const node = findNode(this.lastNodes, drag.sourceId);
    const view = this.parts.get(drag.sourceId);
    if (!node || !view) return;
    const delta = drag.targetPoint.clone().sub(drag.sourcePoint);
    const position: Vec3 = [
      node.position[0] + delta.x,
      node.position[1] + delta.y,
      node.position[2] + delta.z,
    ];
    view.group.position.add(delta);
    this.onAlignObjects?.([{ id: drag.sourceId, position }]);
    this.updateAlignOverlay();
  }

  private clearAlignPreview() {
    if (!this.alignPreviewMeshes.length) return;
    for (const mesh of this.alignPreviewMeshes) this.alignPreviewGroup.remove(mesh);
    this.alignPreviewMeshes = [];
  }

  /**
   * A point in the kernel's ORIGINAL local frame (what FaceInfo/PushPullOp
   * use) converted to world space, and back. centreGeometry() shifts each
   * part's render geometry by -pivot and compensates on the group, so a
   * kernel-local point p sits at group.matrixWorld * (p - pivot).
   */
  private kernelLocalToWorld(view: PartView, p: Vec3): THREE.Vector3 {
    return new THREE.Vector3(p[0], p[1], p[2]).sub(view.pivot).applyMatrix4(view.group.matrixWorld);
  }

  /** Rotation and scale, never translation. A plane's normal transforms by
   *  the inverse transpose (n / s, not n * s), so on a non-uniformly scaled
   *  part this is what keeps the arrow square to the face actually on
   *  screen. Axis-aligned faces — every box face — come out the same either
   *  way; only slanted ones change. */
  private kernelNormalToWorld(view: PartView, n: Vec3): THREE.Vector3 {
    const s = view.group.scale;
    return new THREE.Vector3(n[0] / (s.x || 1), n[1] / (s.y || 1), n[2] / (s.z || 1))
      .applyQuaternion(view.group.getWorldQuaternion(new THREE.Quaternion()))
      .normalize();
  }

  /** Visual centre of the exact triangle group the user clicked. CAD face
   * anchors are ideal for replaying an edit, but after earlier modifiers an
   * interior topology point can lie close to another visible side. Handles
   * should follow the rendered face, not expose that implementation detail. */
  private renderedFaceCenter(view: PartView, groupIndex: number, fallback: Vec3): THREE.Vector3 {
    const geometry = view.mesh.geometry as THREE.BufferGeometry;
    const group = geometry.groups[groupIndex];
    const position = geometry.getAttribute("position");
    if (!group || !position || group.count < 1) return this.kernelLocalToWorld(view, fallback);
    const index = geometry.getIndex();
    const centre = new THREE.Vector3();
    let count = 0;
    for (let offset = group.start; offset < group.start + group.count; offset++) {
      const vertex = index ? index.getX(offset) : offset;
      centre.x += position.getX(vertex);
      centre.y += position.getY(vertex);
      centre.z += position.getZ(vertex);
      count++;
    }
    return count ? centre.multiplyScalar(1 / count).applyMatrix4(view.group.matrixWorld) : this.kernelLocalToWorld(view, fallback);
  }

  /**
   * How far a face moves on screen, in world millimetres, per millimetre of
   * push/pull in the kernel's own frame.
   *
   * A node's scale is NOT baked into its solid: place() applies it at the
   * end, about the solid's own bounding-box centre. So a 10 mm pull on a
   * part scaled 0.3 across that axis only moved the face 3 mm — and, because
   * the centre it scales about had moved too, slid the whole REST of the
   * object the other way to make up the difference. That was the reported
   * "the whole object is moving when pulling a face": measured on a part
   * scaled 0.3025, a 40 mm drag moved the pulled face 26.05 mm and the
   * untouched far side 13.95 mm. Dividing by this puts the drag back into
   * the kernel's units; pivotDrift() cancels what is left of the slide.
   */
  private worldPerLocalAlong(view: PartView, n: Vec3): number {
    const s = view.group.scale;
    const inverse = Math.hypot(n[0] / (s.x || 1), n[1] / (s.y || 1), n[2] / (s.z || 1));
    return inverse > 1e-9 ? 1 / inverse : 1;
  }

  /** The kernel-frame distance that shows up as `world` mm on screen. */
  private toLocalDistance(world: number, worldPerLocal: number): number {
    return worldPerLocal > 1e-9 ? world / worldPerLocal : world;
  }

  /**
   * How far a part's UNTOUCHED geometry slides when an edit moves the
   * solid's bounding-box centre from `from` to `to`. place() scales about
   * that centre, so a centre that moves by dC carries everything else along
   * by (1 - s) * dC. Zero on an unscaled part; on a scaled one this is what
   * has to be cancelled — live while previewing (applyPlacements) and for
   * real in the document (applyPushPull) — to keep the far side of the
   * object still while one face is pulled.
   */
  private pivotDrift(view: PartView, from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3 {
    const s = view.group.scale;
    return new THREE.Vector3(
      (to.x - from.x) * (1 - s.x),
      (to.y - from.y) * (1 - s.y),
      (to.z - from.z) * (1 - s.z),
    ).applyEuler(view.group.rotation);
  }

  /**
   * One small arrow per planar face of the single selected part, sitting on
   * the face and pointing out along its normal — Shapr3D's push/pull grips.
   * Only in Select mode, and only for a part the kernel gave face topology
   * for (never an import — see faceInfoOf() in kernel/worker.ts).
   */
  private updatePushPullOverlay() {
    // Pointer movement owns the handle for the duration of a drag. Live
    // geometry previews can reorder face indices, so recalculating from the
    // transient face list here would teleport the arrow elsewhere.
    if (this.pushPullDrag) {
      this.pushPullHandles.visible = this.facePushPullEnabled;
      return;
    }
    const id = this.selectedFace?.partId ?? null;
    const view = id ? this.parts.get(id) : undefined;
    const faces = view?.faces;
    const faceIndex = this.selectedFace?.groupIndex ?? -1;
    const face = faces?.[faceIndex];
    const visible =
      this.toolMode === "face" && this.facePushPullEnabled && !!view && !!face?.planar && face.pushPullable !== false && this.selectedIds.includes(id ?? "") &&
      !this.showResult && view.group.visible;
    this.pushPullHandles.visible = visible;
    if (!visible || !view || !face || !id) {
      this.pushPullPoolKey = "";
      this.pushPullHandleHovered = false;
      if (!this.gizmo.dragging) this.renderer.domElement.style.cursor = "";
      return;
    }

    // Rebuilding the arrows every frame would churn geometry for nothing —
    // only their placement actually changes as the camera or object moves.
    const key = `${id}:${faceIndex}`;
    if (this.pushPullPoolKey !== key) {
      this.rebuildPushPullPool(1);
      this.pushPullPoolKey = key;
    }

    view.group.updateWorldMatrix(true, true);
    const handle = this.pushPullHandleMeshes[0];
    const at = this.renderedFaceCenter(view, faceIndex, face.point);
    const normal = this.kernelNormalToWorld(view, face.normal);
    const scale = Math.max(MIN_HANDLE_WORLD, this.worldSnapTolerance(at) * PUSH_PULL_HANDLE_SCALE);
    handle.position.copy(at).addScaledVector(normal, scale * 0.2);
    handle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
    handle.scale.setScalar(scale * (this.pushPullHandleHovered ? 1.18 : 1));
    handle.traverse((child) => {
      const mesh = child as THREE.Mesh;
      const material = mesh.material as THREE.MeshBasicMaterial | undefined;
      if (mesh.isMesh && material?.color) {
        material.color.setHex(this.pushPullHandleHovered ? 0x43c7ff : 0x2457ff);
      }
    });
    handle.userData.faceIndex = faceIndex;
    handle.userData.partId = id;
  }

  /** Grows/shrinks the arrow pool to exactly `count`, reusing what exists. */
  private rebuildPushPullPool(count: number) {
    while (this.pushPullHandleMeshes.length > count) {
      const handle = this.pushPullHandleMeshes.pop()!;
      this.pushPullHandles.remove(handle);
      disposeArrow(handle);
    }
    while (this.pushPullHandleMeshes.length < count) {
      const handle = makeArrow();
      this.pushPullHandles.add(handle);
      this.pushPullHandleMeshes.push(handle);
    }
  }

  /** Paints material index 1 onto exactly one triangle group of a geometry —
   *  highlightInGeometry's own type declaration says it wants the {faces,
   *  lines} wrapper, but the actual implementation (see node_modules;
   *  geometry.groups.forEach(...)) operates on the raw BufferGeometry, same
   *  as clearHighlights/getFaceIndex/getFaceId right next to it — a mismatch
   *  in the package's own .d.ts, not a mistake here. */
  private highlightFace(groupIndex: number, geometry: THREE.BufferGeometry) {
    highlightInGeometry([groupIndex], geometry as unknown as Parameters<typeof highlightInGeometry>[1]);
  }

  private clearFaceHover() {
    if (!this.hoverFace) return;
    clearHighlights(this.hoverFace.view.mesh.geometry as THREE.BufferGeometry);
    this.hoverFace = null;
    this.restoreSelectedFaceHighlight();
  }

  private restoreSelectedFaceHighlight() {
    const selected = this.selectedFace;
    const view = selected ? this.parts.get(selected.partId) : undefined;
    if (view) this.highlightFace(selected!.groupIndex, view.mesh.geometry as THREE.BufferGeometry);
  }

  /** Makes the face under a plain click persistent and shows its sole arrow.
   * Returns false for empty/curved faces so ordinary object picking continues. */
  private selectFaceAt(e: PointerEvent): boolean {
    const found = this.raycastFace(e);
    if (!found) return false;
    const partId = [...this.parts.entries()].find(([, view]) => view === found.view)?.[0];
    const face = found.view.faces?.[found.groupIndex];
    if (!partId || !face) return false;
    this.clearFaceHover();
    this.selectedFace = { partId, groupIndex: found.groupIndex };
    this.selectedIds = [partId];
    this.onSelectObject?.(partId, false);
    this.restoreSelectedFaceHighlight();
    this.updatePushPullOverlay();
    const handle = this.facePushPullEnabled && face.planar && face.pushPullable !== false
      ? this.pushPullHandleMeshes[0]
      : undefined;
    if (handle) {
      this.showPushPullInputForFace(
        partId,
        face.point,
        face.normal,
        found.view,
        this.cloneGeom(found.view.geom),
        found.view.pivot.clone(),
        this.worldPerLocalAlong(found.view, face.normal),
        handle.position,
        0,
      );
    }
    return true;
  }

  /**
   * Whatever face (planar or curved) sits directly under the pointer RIGHT
   * NOW, on any visible part — a fresh raycast against the actual meshes,
   * not a cached lookup. beginPushPullFromHover deliberately calls this
   * itself rather than trusting this.hoverFace: that field is only updated
   * by pointermove, so it can go stale between a face-hover and a LATER,
   * unrelated pointerdown elsewhere (a synthetic/fast click sequence with no
   * intervening move event over the new spot, a marquee started far from
   * the last-hovered face, etc.) — confirmed live: without this re-check, a
   * marquee-select started well away from a previously-hovered face still
   * read the old hoverFace and began a push/pull nowhere near the click.
   */
  private raycastFace(e: PointerEvent): { view: PartView; groupIndex: number; point: Vec3; normal: Vec3 } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const candidates = [...this.parts.values()].filter((v) => v.group.visible);
    const hit = this.raycaster.intersectObjects(candidates.map((v) => v.mesh), false)[0];
    const faceIndex = hit?.faceIndex;
    if (faceIndex == null) return null;

    const view = candidates.find((v) => v.mesh === hit.object);
    const geometry = view?.mesh.geometry as THREE.BufferGeometry | undefined;
    if (!view || !geometry) return null;
    const groupIndex = getFaceIndex(faceIndex, geometry);
    if (groupIndex < 0 || !hit.face) return null;
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    return { view, groupIndex, point: hit.point.toArray() as Vec3, normal: normal.toArray() as Vec3 };
  }

  /**
   * Shapr3D-style face hover: whatever flat OR curved face the pointer is
   * directly over — on any visible part, selected or not — is painted red
   * (see MATERIALS.faceHighlight), so a face is something you can literally
   * see and click, not just something that appears once its parent object is
   * already selected. Skipped whenever some other gesture (an existing drag,
   * the gizmo, a marquee) already owns the pointer, so it never fights them.
   */
  private updateFaceHover(e: PointerEvent) {
    if (
      (this.toolMode !== "face" && this.toolMode !== "place") || this.showResult || this.gizmo.dragging ||
      this.pushPullDrag || this.navDrag || this.resizeDrag ||
      this.grab?.active || this.marquee?.active
    ) {
      if (!this.pushPullDrag) {
        this.pushPullHandleHovered = false;
        this.renderer.domElement.style.cursor = "";
      }
      this.clearFaceHover();
      return;
    }

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const overHandle = this.toolMode === "face" && this.pushPullHandles.visible &&
      this.raycaster.intersectObjects(this.pushPullHandleMeshes, true).length > 0;
    if (overHandle !== this.pushPullHandleHovered) {
      this.pushPullHandleHovered = overHandle;
      this.renderer.domElement.style.cursor = overHandle ? "pointer" : "";
      this.updatePushPullOverlay();
    }
    if (overHandle) {
      this.clearFaceHover();
      return;
    }

    const found = this.raycastFace(e);
    if (!found) {
      this.clearFaceHover();
      return;
    }
    if (this.hoverFace && this.hoverFace.view === found.view && this.hoverFace.groupIndex === found.groupIndex) {
      return; // same face as last frame — nothing to change
    }
    this.clearFaceHover();
    this.highlightFace(found.groupIndex, found.view.mesh.geometry as THREE.BufferGeometry);
    this.hoverFace = found;
  }

  private placementAt(e: PointerEvent): { point: THREE.Vector3; normal: THREE.Vector3 } | null {
    const face = this.raycastFace(e);
    if (face) {
      return { point: new THREE.Vector3(...face.point), normal: new THREE.Vector3(...face.normal) };
    }
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const point = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), point)
      ? { point, normal: new THREE.Vector3(0, 0, 1) }
      : null;
  }

  private placeAt(e: PointerEvent) {
    const placement = this.placementAt(e);
    if (placement) this.onPlaceSurface?.(placement.point.toArray() as Vec3, placement.normal.toArray() as Vec3);
  }

  private updatePlacementPreview(e: PointerEvent) {
    if (!this.placementPreview) return;
    const placement = this.placementAt(e);
    this.placementPreview.visible = !!placement;
    if (!placement) return;
    const normal = placement.normal.normalize();
    this.placementPreview.position.copy(placement.point).addScaledVector(normal, 0.001);
    this.placementPreview.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
  }

  setPlacementPreview(kind: PrimitiveKind | null) {
    if (this.placementPreview) {
      this.placementPreview.removeFromParent();
      this.placementPreview.geometry.dispose();
      (this.placementPreview.material as THREE.Material).dispose();
      this.placementPreview = null;
    }
    if (!kind) return;
    const p = getEffectiveDefaults(kind);
    let geometry: THREE.BufferGeometry;
    if (kind === "box") geometry = new THREE.BoxGeometry(p.width, p.depth, p.height).translate(0, 0, p.height / 2);
    else if (kind === "sphere") geometry = new THREE.SphereGeometry(p.radius, 32, 20).translate(0, 0, p.radius);
    else if (kind === "cylinder" || kind === "cone") {
      geometry = new THREE.CylinderGeometry(kind === "cone" ? p.topRadius : p.radius, kind === "cone" ? p.bottomRadius : p.radius, p.height, 32);
      geometry.rotateX(Math.PI / 2).translate(0, 0, p.height / 2);
    } else if (kind === "torus") {
      geometry = new THREE.TorusGeometry(p.radius, p.tubeRadius, 24, 48).translate(0, 0, p.tubeRadius);
    } else if (kind === "pyramid") {
      const sides = p.sides ?? 4;
      geometry = new THREE.ConeGeometry(p.radius ?? 10, p.height, sides);
      geometry.rotateY(Math.PI / sides);
      geometry.rotateX(Math.PI / 2).translate(0, 0, p.height / 2);
    } else if (kind === "wedge") {
      const w = p.width / 2;
      const l = p.length / 2;
      const h = p.height;
      const v0 = [-w, -l, 0], v1 = [w, -l, 0], v2 = [w, l, 0], v3 = [-w, l, 0];
      const v4 = [-w, l, h], v5 = [w, l, h];
      const positions = new Float32Array([
        // Bottom:
        ...v0, ...v3, ...v2,  ...v0, ...v2, ...v1,
        // Back:
        ...v2, ...v3, ...v4,  ...v2, ...v4, ...v5,
        // Sloped ramp:
        ...v0, ...v1, ...v5,  ...v0, ...v5, ...v4,
        // Left side:
        ...v0, ...v4, ...v3,
        // Right side:
        ...v1, ...v2, ...v5,
      ]);
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.computeVertexNormals();
    } else if (kind === "polygonPrism") {
      const sides = Math.max(3, Math.min(32, Math.round(p.sides ?? 6)));
      geometry = new THREE.CylinderGeometry(p.radius, p.radius, p.height, sides);
      geometry.rotateX(Math.PI / 2).translate(0, 0, p.height / 2);
    } else if (kind === "hemisphere") {
      geometry = new THREE.SphereGeometry(p.radius, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2);
      geometry.rotateX(Math.PI / 2);
    } else if (kind === "capsule") {
      const r = p.radius ?? 5;
      const totalH = p.height ?? 20;
      const cylinderH = Math.max(totalH - 2 * r, 0.001);
      geometry = new THREE.CapsuleGeometry(r, cylinderH, 16, 32);
      geometry.rotateX(Math.PI / 2).translate(0, 0, totalH / 2);
    } else if (kind === "tube") {
      const rOut = Math.max(p.radius ?? 15, 0.1);
      const wall = Math.min(Math.max(p.wallThickness ?? 3, 0.05), rOut - 0.05);
      const rIn = Math.max(rOut - wall, 0.01);
      const h = Math.max(p.height ?? 10, 0.1);
      const sides = Math.max(3, Math.min(64, Math.round(p.sides ?? 32)));

      const positions: number[] = [];
      const dTheta = (2 * Math.PI) / sides;

      for (let i = 0; i < sides; i++) {
        const a0 = i * dTheta;
        const a1 = (i + 1) * dTheta;
        const c0 = Math.cos(a0), s0 = Math.sin(a0);
        const c1 = Math.cos(a1), s1 = Math.sin(a1);

        const out0 = [rOut * c0, rOut * s0];
        const out1 = [rOut * c1, rOut * s1];
        const in0 = [rIn * c0, rIn * s0];
        const in1 = [rIn * c1, rIn * s1];

        // 1. Outer wall (z = 0 to z = h)
        positions.push(out0[0], out0[1], 0, out1[0], out1[1], 0, out1[0], out1[1], h);
        positions.push(out0[0], out0[1], 0, out1[0], out1[1], h, out0[0], out0[1], h);

        // 2. Inner wall (z = 0 to z = h, facing inward)
        positions.push(in0[0], in0[1], 0, in1[0], in1[1], h, in1[0], in1[1], 0);
        positions.push(in0[0], in0[1], 0, in0[0], in0[1], h, in1[0], in1[1], h);

        // 3. Bottom ring cap at z = 0
        positions.push(out0[0], out0[1], 0, in0[0], in0[1], 0, out1[0], out1[1], 0);
        positions.push(out1[0], out1[1], 0, in0[0], in0[1], 0, in1[0], in1[1], 0);

        // 4. Top ring cap at z = h
        positions.push(out0[0], out0[1], h, out1[0], out1[1], h, in0[0], in0[1], h);
        positions.push(out1[0], out1[1], h, in1[0], in1[1], h, in0[0], in0[1], h);
      }

      geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(positions), 3));
      geometry.computeVertexNormals();
    } else if (kind === "paraboloid") {
      const R = p.radius ?? 10;
      const h = p.height ?? 20;
      const rings = 16;
      const segs = 32;
      const positions: number[] = [];

      // 1. Bottom flat base disk (Z = 0):
      for (let k = 0; k < segs; k++) {
        const a1 = (k * 2 * Math.PI) / segs;
        const a2 = ((k + 1) * 2 * Math.PI) / segs;
        positions.push(
          0, 0, 0,
          R * Math.cos(a2), R * Math.sin(a2), 0,
          R * Math.cos(a1), R * Math.sin(a1), 0,
        );
      }

      // 2. Parabolic dome surface from rim (Z=0, r=R) to apex (Z=h, r=0):
      for (let j = 0; j < rings; j++) {
        const t1 = j / rings;
        const t2 = (j + 1) / rings;
        const r1 = R * (1 - t1);
        const z1 = h * (1 - (r1 / R) ** 2);
        const r2 = R * (1 - t2);
        const z2 = h * (1 - (r2 / R) ** 2);

        for (let k = 0; k < segs; k++) {
          const a1 = (k * 2 * Math.PI) / segs;
          const a2 = ((k + 1) * 2 * Math.PI) / segs;
          const cos1 = Math.cos(a1), sin1 = Math.sin(a1);
          const cos2 = Math.cos(a2), sin2 = Math.sin(a2);

          const p1 = [r1 * cos1, r1 * sin1, z1];
          const p2 = [r1 * cos2, r1 * sin2, z1];
          const p3 = [r2 * cos2, r2 * sin2, z2];
          const p4 = [r2 * cos1, r2 * sin1, z2];

          if (j === rings - 1) {
            positions.push(...p1, ...p2, ...p3);
          } else {
            positions.push(...p1, ...p2, ...p3, ...p1, ...p3, ...p4);
          }
        }
      }

      geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(positions), 3));
      geometry.computeVertexNormals();
    } else if (kind === "text") {
      const size = p.size ?? 20;
      const thickness = p.thickness ?? 4;
      geometry = new THREE.BoxGeometry(size * 2.5, size * 0.7, thickness).translate(0, 0, thickness / 2);
    } else if (kind === "connector") {
      // Rough box/cylinder stand-ins, not the real keystone/tapered-tip
      // profile — good enough for a drag-to-place ghost, and the real
      // kernel-built mesh replaces it the instant the object is dropped.
      if ((p.shape ?? 0) === 0) {
        geometry = new THREE.BoxGeometry(p.width, p.length, p.height).translate(0, 0, p.height / 2);
      } else {
        geometry = new THREE.CylinderGeometry(p.radius, p.radius, p.length, 24);
        geometry.rotateX(Math.PI / 2).translate(0, 0, p.length / 2);
      }
    } else if (kind === "threadedRod") {
      const dia = p.diameter ?? 8;
      const len = p.length ?? 30;
      const headType = p.headType ?? 1;
      const headH = p.headHeight ?? 5.5;
      const headS = p.headSize ?? 13;
      const hasHead = headType !== 0;
      const isHex = headType === 1;

      const positions: number[] = [];

      // 1. Head (if any) at z = [0, headH]
      let shaftZ0 = 0;
      if (hasHead) {
        shaftZ0 = headH;
        const sides = isHex ? 6 : 24;
        const rHead = isHex ? headS / Math.sqrt(3) : headS / 2;
        const pts: [number, number][] = [];
        for (let i = 0; i < sides; i++) {
          const a = (i * 2 * Math.PI) / sides + (isHex ? Math.PI / 6 : 0);
          pts.push([rHead * Math.cos(a), rHead * Math.sin(a)]);
        }
        // Head bottom cap at z = 0
        for (let i = 0; i < sides; i++) {
          const next = (i + 1) % sides;
          positions.push(0, 0, 0, pts[next][0], pts[next][1], 0, pts[i][0], pts[i][1], 0);
        }
        // Head top cap at z = headH
        for (let i = 0; i < sides; i++) {
          const next = (i + 1) % sides;
          positions.push(0, 0, headH, pts[i][0], pts[i][1], headH, pts[next][0], pts[next][1], headH);
        }
        // Head sides
        for (let i = 0; i < sides; i++) {
          const next = (i + 1) % sides;
          const x0 = pts[i][0], y0 = pts[i][1];
          const x1 = pts[next][0], y1 = pts[next][1];
          positions.push(x0, y0, 0, x1, y1, 0, x1, y1, headH);
          positions.push(x0, y0, 0, x1, y1, headH, x0, y0, headH);
        }
      }

      // 2. Shaft with ridged threaded rings from z = shaftZ0 to z = shaftZ0 + len
      const S = 24;
      const rCrest = dia / 2;
      const rRoot = (dia / 2) * 0.88;
      const numRings = Math.max(4, Math.round(len / 2.5));
      for (let ring = 0; ring < numRings; ring++) {
        const z0 = shaftZ0 + (ring / numRings) * len;
        const z1 = shaftZ0 + ((ring + 0.5) / numRings) * len;
        const z2 = shaftZ0 + ((ring + 1) / numRings) * len;

        for (let i = 0; i < S; i++) {
          const a0 = (i * 2 * Math.PI) / S;
          const a1 = ((i + 1) * 2 * Math.PI) / S;
          const c0 = Math.cos(a0), s0 = Math.sin(a0);
          const c1 = Math.cos(a1), s1 = Math.sin(a1);

          // Flank to crest
          positions.push(rRoot * c0, rRoot * s0, z0, rRoot * c1, rRoot * s1, z0, rCrest * c1, rCrest * s1, z1);
          positions.push(rRoot * c0, rRoot * s0, z0, rCrest * c1, rCrest * s1, z1, rCrest * c0, rCrest * s0, z1);

          // Flank to root
          positions.push(rCrest * c0, rCrest * s0, z1, rCrest * c1, rCrest * s1, z1, rRoot * c1, rRoot * s1, z2);
          positions.push(rCrest * c0, rCrest * s0, z1, rRoot * c1, rRoot * s1, z2, rRoot * c0, rRoot * s0, z2);
        }
      }

      // Shaft top cap at z = shaftZ0 + len
      const topZ = shaftZ0 + len;
      for (let i = 0; i < S; i++) {
        const a0 = (i * 2 * Math.PI) / S;
        const a1 = ((i + 1) * 2 * Math.PI) / S;
        positions.push(0, 0, topZ, rRoot * Math.cos(a0), rRoot * Math.sin(a0), topZ, rRoot * Math.cos(a1), rRoot * Math.sin(a1), topZ);
      }

      geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(positions), 3));
      geometry.computeVertexNormals();
    } else if (kind === "threadedNut") {
      const outerW = p.outerWidth ?? 13;
      const nutH = p.height ?? 6.5;
      const dia = p.diameter ?? 8;
      const isHex = (p.shape ?? 0) === 0;
      const isSq = (p.shape ?? 0) === 1;
      const shape = new THREE.Shape();
      const sides = isHex ? 6 : isSq ? 4 : 32;
      const rOuter = isHex ? outerW / Math.sqrt(3) : outerW / 2;
      for (let i = 0; i < sides; i++) {
        const a = (i * 2 * Math.PI) / sides + (isSq ? Math.PI / 4 : Math.PI / 6);
        const x = rOuter * Math.cos(a);
        const y = rOuter * Math.sin(a);
        if (i === 0) shape.moveTo(x, y);
        else shape.lineTo(x, y);
      }
      shape.closePath();
      const hole = new THREE.Path();
      hole.absarc(0, 0, dia / 2, 0, Math.PI * 2, true);
      shape.holes.push(hole);
      geometry = new THREE.ExtrudeGeometry(shape, { depth: nutH, bevelEnabled: false, curveSegments: 24 });
    } else if (kind === "star") {
      const numPoints = Math.max(3, Math.min(32, Math.round(p.points ?? 5)));
      const rOut = Math.max(p.outerRadius ?? 15, 0.1);
      const rIn = Math.max(p.innerRadius ?? 7.5, 0.1);
      const h = Math.max(p.height ?? 10, 0.1);
      const N = numPoints * 2;
      const dTheta = Math.PI / numPoints;

      const positions: number[] = [];
      const pts: [number, number][] = [];
      for (let i = 0; i < N; i++) {
        const r = i % 2 === 0 ? rOut : rIn;
        const a = i * dTheta - Math.PI / 2;
        pts.push([r * Math.cos(a), r * Math.sin(a)]);
      }

      // Bottom cap (facing -Z)
      for (let i = 0; i < N; i++) {
        const next = (i + 1) % N;
        positions.push(0, 0, 0, pts[next][0], pts[next][1], 0, pts[i][0], pts[i][1], 0);
      }
      // Top cap (facing +Z)
      for (let i = 0; i < N; i++) {
        const next = (i + 1) % N;
        positions.push(0, 0, h, pts[i][0], pts[i][1], h, pts[next][0], pts[next][1], h);
      }
      // Lateral sides
      for (let i = 0; i < N; i++) {
        const next = (i + 1) % N;
        const x0 = pts[i][0], y0 = pts[i][1];
        const x1 = pts[next][0], y1 = pts[next][1];
        positions.push(x0, y0, 0, x1, y1, 0, x1, y1, h);
        positions.push(x0, y0, 0, x1, y1, h, x0, y0, h);
      }

      geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(positions), 3));
      geometry.computeVertexNormals();
    } else if (kind === "tray") {
      const w = Math.max(p.width ?? 60, 2);
      const d = Math.max(p.depth ?? 30, 2);
      const h = Math.max(p.height ?? 20, 1);
      const wall = Math.min(Math.max(p.wallThickness ?? 2, 0.4), Math.min(w, d) / 2 - 0.2);
      const floor = Math.min(Math.max(p.floorThickness ?? 2, 0.4), h - 0.5);
      const cr = Math.min(Math.max(p.cornerRadius ?? 4, 0), Math.min(w, d) / 2 - 0.01);
      const inCr = Math.max(0, cr - wall);

      const segmentsPerCorner = 6;
      const getRoundedRectPts = (hw: number, hd: number, r: number): [number, number][] => {
        const pts: [number, number][] = [];
        const effR = Math.min(r, hw, hd);
        if (effR <= 0.01) {
          return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
        }
        const centers: [number, number, number][] = [
          [hw - effR, -hd + effR, -Math.PI / 2],
          [hw - effR, hd - effR, 0],
          [-hw + effR, hd - effR, Math.PI / 2],
          [-hw + effR, -hd + effR, Math.PI],
        ];
        for (const [cx, cy, startAngle] of centers) {
          for (let s = 0; s <= segmentsPerCorner; s++) {
            const a = startAngle + (s / segmentsPerCorner) * (Math.PI / 2);
            pts.push([cx + effR * Math.cos(a), cy + effR * Math.sin(a)]);
          }
        }
        return pts;
      };

      const outerPts = getRoundedRectPts(w / 2, d / 2, cr);
      const innerPts = getRoundedRectPts(w / 2 - wall, d / 2 - wall, inCr);
      const numOuter = outerPts.length;
      const numInner = innerPts.length;

      const positions: number[] = [];

      // 1. Bottom floor solid base at z = 0
      for (let i = 0; i < numOuter; i++) {
        const next = (i + 1) % numOuter;
        positions.push(0, 0, 0, outerPts[next][0], outerPts[next][1], 0, outerPts[i][0], outerPts[i][1], 0);
      }

      // 2. Outer side walls (z = 0 to z = h)
      for (let i = 0; i < numOuter; i++) {
        const next = (i + 1) % numOuter;
        const x0 = outerPts[i][0], y0 = outerPts[i][1];
        const x1 = outerPts[next][0], y1 = outerPts[next][1];
        positions.push(x0, y0, 0, x1, y1, 0, x1, y1, h);
        positions.push(x0, y0, 0, x1, y1, h, x0, y0, h);
      }

      // 3. Inner cavity floor at z = floor
      for (let i = 0; i < numInner; i++) {
        const next = (i + 1) % numInner;
        positions.push(0, 0, floor, innerPts[i][0], innerPts[i][1], floor, innerPts[next][0], innerPts[next][1], floor);
      }

      // 4. Inner side walls (z = floor to z = h, facing inward)
      for (let i = 0; i < numInner; i++) {
        const next = (i + 1) % numInner;
        const x0 = innerPts[i][0], y0 = innerPts[i][1];
        const x1 = innerPts[next][0], y1 = innerPts[next][1];
        positions.push(x0, y0, floor, x1, y1, h, x1, y1, floor);
        positions.push(x0, y0, floor, x0, y0, h, x1, y1, h);
      }

      // 5. Top rim connecting outer and inner boundary at z = h
      for (let i = 0; i < numOuter; i++) {
        const next = (i + 1) % numOuter;
        const o0 = outerPts[i], o1 = outerPts[next];
        const inIdx0 = Math.floor((i / numOuter) * numInner);
        const inIdx1 = Math.floor((next / numOuter) * numInner);
        const i0 = innerPts[inIdx0], i1 = innerPts[inIdx1];
        positions.push(o0[0], o0[1], h, i0[0], i0[1], h, o1[0], o1[1], h);
        positions.push(o1[0], o1[1], h, i0[0], i0[1], h, i1[0], i1[1], h);
      }

      geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(positions), 3));
      geometry.computeVertexNormals();
    } else if (kind === "ellipsoid") {
      const rx = Math.max(p.radiusX ?? 15, 0.1);
      const ry = Math.max(p.radiusY ?? 10, 0.1);
      const rz = Math.max(p.radiusZ ?? 10, 0.1);
      geometry = new THREE.SphereGeometry(1, 32, 20).scale(rx, ry, rz).translate(0, 0, rz);
    } else {
      const x = ((p.sideLeft ?? 20) ** 2 + (p.base ?? 20) ** 2 - (p.sideRight ?? 20) ** 2) / (2 * (p.base ?? 20));
      const y = Math.sqrt(Math.max(0, (p.sideLeft ?? 20) ** 2 - x ** 2));
      const b = p.base ?? 20;
      const shape = new THREE.Shape().moveTo(-b / 2, -y / 2).lineTo(b / 2, -y / 2).lineTo(x - b / 2, y / 2).closePath();
      geometry = new THREE.ExtrudeGeometry(shape, { depth: p.thickness ?? 10, bevelEnabled: false });
    }
    this.placementPreview = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
      color: 0x25b7bd, transparent: true, opacity: 0.42, depthWrite: false, roughness: 0.45, side: THREE.DoubleSide,
    }));
    this.placementPreview.renderOrder = 20;
    this.placementPreview.visible = false;
    this.scene.add(this.placementPreview);
  }

  /**
   * Starts a push/pull if the pointer went down on one of the face arrows.
   * The whole gesture resolves to a signed distance along the face normal,
   * so the projected screen direction of that normal is computed once here
   * rather than re-derived every move.
   */
  private beginPushPull(e: PointerEvent): boolean {
    if (!this.pushPullHandles.visible) return false;
    const id = this.selectedIds.length === 1 ? this.selectedIds[0] : null;
    const view = id ? this.parts.get(id) : undefined;
    const faces = view?.faces;
    if (!id || !view || !faces) return false;

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.pushPullHandleMeshes, true)[0];
    if (!hit) return false;

    // intersectObjects(recursive) can report a child cone/shaft, so walk up
    // to whichever ancestor actually carries the face index.
    let handle: THREE.Object3D | null = hit.object;
    while (handle && handle.userData.faceIndex === undefined) handle = handle.parent;
    if (!handle || handle.userData.partId !== id) return false;
    const face = faces[handle.userData.faceIndex as number];
    if (!face) return false;

    const at = this.renderedFaceCenter(view, handle.userData.faceIndex as number, face.point);
    const worldNormal = this.kernelNormalToWorld(view, face.normal);
    const project = (p: THREE.Vector3) => {
      const v = p.clone().project(this.camera);
      return { x: ((v.x + 1) / 2) * rect.width, y: ((1 - v.y) / 2) * rect.height };
    };
    const origin = project(at);
    const along = project(at.clone().add(worldNormal));
    const dx = along.x - origin.x;
    const dy = along.y - origin.y;
    const pixelsPerUnit = Math.hypot(dx, dy);
    // Face pointing (almost) straight at or away from the camera: its normal
    // barely projects to any screen direction, so a drag cannot express a
    // distance along it. Orbit slightly and try again.
    if (pixelsPerUnit < 1e-3) return false;

    this.pushPullDrag = {
      id,
      localPoint: face.point,
      localNormal: face.normal,
      screenDir: { x: dx / pixelsPerUnit, y: dy / pixelsPerUnit },
      pixelsPerUnit,
      downScreen: { x: e.clientX, y: e.clientY },
      active: false,
      handle,
      handleBasePosition: handle.position.clone(),
      worldNormal,
      ephemeral: false,
      view,
      originalGeom: this.cloneGeom(view.geom),
      originalPivot: view.pivot.clone(),
      lastPreviewAt: 0,
      previewInFlight: false,
      queuedPreviewDistance: null,
      currentDistance: 0,
      worldPerLocal: this.worldPerLocalAlong(view, face.normal),
    };
    this.pushPullGeneration++;
    this.controls.enabled = false;
    this.gizmo.enabled = false;
    e.preventDefault();
    return true;
  }

  /**
   * Starts the same push/pull gesture from anywhere on a planar face while the
   * Face tool is active. Requiring a precise hit on the small arrow made an
   * ordinary face drag fall through to the object's body-move gesture.
   */
  private beginPushPullFromFace(e: PointerEvent): boolean {
    if (
      this.toolMode !== "face" || this.showResult ||
      e.ctrlKey || e.metaKey || e.shiftKey
    ) return false;

    const found = this.raycastFace(e);
    if (!found) return false;
    const { view, groupIndex } = found;
    const partId = [...this.parts.entries()].find(([, candidate]) => candidate === view)?.[0];
    const face = view.faces?.[groupIndex];
    if (!partId || !face?.planar || face.pushPullable === false) return false;

    const rect = this.renderer.domElement.getBoundingClientRect();
    view.group.updateWorldMatrix(true, true);
    const at = this.renderedFaceCenter(view, groupIndex, face.point);
    const worldNormal = this.kernelNormalToWorld(view, face.normal);
    const project = (point: THREE.Vector3) => {
      const projected = point.clone().project(this.camera);
      return {
        x: ((projected.x + 1) / 2) * rect.width,
        y: ((1 - projected.y) / 2) * rect.height,
      };
    };
    const origin = project(at);
    const along = project(at.clone().add(worldNormal));
    const dx = along.x - origin.x;
    const dy = along.y - origin.y;
    const pixelsPerUnit = Math.hypot(dx, dy);
    if (pixelsPerUnit < 1e-3) return false;

    // This temporary arrow follows the drag even when it started away from the
    // selected face's centre. The normal pooled arrow is restored on release.
    const scale = Math.max(MIN_HANDLE_WORLD, this.worldSnapTolerance(at) * PUSH_PULL_HANDLE_SCALE);
    const handle = makeArrow();
    handle.position.copy(at).addScaledVector(worldNormal, scale * 0.2);
    handle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), worldNormal);
    handle.scale.setScalar(scale);
    this.pushPullHandles.add(handle);

    this.selectedFace = { partId, groupIndex };
    this.selectedIds = [partId];
    this.onSelectObject?.(partId, false);
    this.restoreSelectedFaceHighlight();
    this.pushPullDrag = {
      id: partId,
      localPoint: face.point,
      localNormal: face.normal,
      screenDir: { x: dx / pixelsPerUnit, y: dy / pixelsPerUnit },
      pixelsPerUnit,
      downScreen: { x: e.clientX, y: e.clientY },
      active: false,
      handle,
      handleBasePosition: handle.position.clone(),
      worldNormal,
      ephemeral: true,
      view,
      originalGeom: this.cloneGeom(view.geom),
      originalPivot: view.pivot.clone(),
      lastPreviewAt: 0,
      previewInFlight: false,
      queuedPreviewDistance: null,
      currentDistance: 0,
      worldPerLocal: this.worldPerLocalAlong(view, face.normal),
    };
    this.pushPullGeneration++;
    this.controls.enabled = false;
    this.gizmo.enabled = false;
    e.preventDefault();
    return true;
  }

  /** A deep copy of a part's current render geometry — used to snapshot the
   *  pre-drag shape so a live push/pull preview can be reverted exactly if
   *  the drag/pill is abandoned. Mirrors cloneView()'s own geometry clone. */
  private cloneGeom(geom: ThreeGeometry[]): ThreeGeometry[] {
    return geom.map((g) => ({ faces: g.faces.clone(), lines: g.lines.clone() }));
  }

  /** Distance (mm) the pointer currently represents, snapped to 0.5mm. */
  private pushPullDistance(e: PointerEvent, drag: PushPullDrag): number {
    const dx = e.clientX - drag.downScreen.x;
    const dy = e.clientY - drag.downScreen.y;
    const along = dx * drag.screenDir.x + dy * drag.screenDir.y;
    return Math.round((along / drag.pixelsPerUnit) * 2) / 2;
  }

  /**
   * Opens the push/pull pill for typing an exact distance, at the same
   * screen position the live-drag readout uses — either from a plain click
   * (no drag) on a face's arrow/hover-highlight, pre-filled at 0, or right
   * after a real drag ends, pre-filled with the distance it dragged to, so
   * that value stays reviewable/adjustable for one more correction instead
   * of vanishing the instant the mouse comes up (as it used to — a drag and
   * a plain click ending in two different states was the actual complaint).
   */
  private showPushPullInput(drag: PushPullDrag, initialValueMm = 0) {
    this.showPushPullInputForFace(
      drag.id,
      drag.localPoint,
      drag.localNormal,
      drag.view,
      drag.originalGeom,
      drag.originalPivot,
      drag.worldPerLocal,
      drag.handleBasePosition,
      initialValueMm,
    );
  }

  private showPushPullInputForFace(
    id: string,
    localPoint: Vec3,
    localNormal: Vec3,
    view: PartView,
    originalGeom: ThreeGeometry[],
    originalPivot: THREE.Vector3,
    worldPerLocal: number,
    labelWorldPosition: THREE.Vector3,
    initialValueMm = 0,
  ) {
    // This floating editor belongs only to Push/Pull. Face selection is
    // shared by Wall and the other face tools, so guard here as well as at
    // the caller against a same-frame toolbar switch followed by a click.
    if (!this.facePushPullEnabled) {
      this.pushPullLabelEl.style.display = "none";
      this.pushPullPending = null;
      return;
    }
    this.pushPullPending = {
      id,
      localPoint,
      localNormal,
      view,
      originalGeom,
      originalPivot,
      worldPerLocal,
    };
    this.armedFace = { id, localPoint, localNormal, view, worldPerLocal };
    this.pushPullLabelEl.style.display = "block";
    this.positionPushPullLabel(labelWorldPosition, this.kernelNormalToWorld(view, localNormal));
    this.pushPullLabelEl.value = formatLength(initialValueMm, this.displayUnit, this.decimalPlaces);
    this.pushPullLabelEl.style.width = `${Math.max(4.2, this.pushPullLabelEl.value.length + 1.6)}ch`;
    this.pushPullLabelEl.focus();
    this.pushPullLabelEl.select();
  }

  /** Keeps the value pill beside, never on top of, the arrow. The offset is
   * perpendicular to the face normal's current screen projection and biased
   * upward, so it remains stable and readable as the camera orbits. */
  private positionPushPullLabel(at: THREE.Vector3, worldNormal: THREE.Vector3) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const project = (p: THREE.Vector3) => {
      const v = p.clone().project(this.camera);
      return { x: ((v.x + 1) / 2) * rect.width, y: ((1 - v.y) / 2) * rect.height };
    };
    const base = project(at);
    const along = project(at.clone().add(worldNormal));
    const dx = along.x - base.x;
    const dy = along.y - base.y;
    const length = Math.hypot(dx, dy);
    let px = length > 1e-3 ? -dy / length : -1;
    let py = length > 1e-3 ? dx / length : -1;
    if (py > 0) { px = -px; py = -py; }
    this.pushPullLabelEl.style.left = `${base.x + px * 58}px`;
    this.pushPullLabelEl.style.top = `${base.y + py * 58}px`;
  }

  /**
   * Resolves whatever is in the push/pull pill, on blur/Enter/Escape.
   * `apply` is false only for an explicit Escape — everything else (blur
   * from clicking away, or Enter, which just blurs) tries to apply, but
   * still reverts if the value doesn't clear the same 0.5mm floor a drag
   * itself uses (a typed/dragged-to 0 is not an edit — never turn a
   * parametric node into a baked one for that).
   *
   * Either way ends with the part's geometry in a CORRECT state: applying
   * discards the pre-drag snapshot (the live preview already showing is
   * close enough until the real committed rebuild replaces it shortly);
   * reverting restores that snapshot exactly, since nothing else would
   * otherwise put an abandoned live-preview shape back to what is actually
   * still the document's real, committed state.
   */
  /**
   * Lets go of the selected face entirely.
   *
   * Push/pull can keep its face across an edit because the face survives — it
   * only moves, and pushSelectedFace advances the anchor to match. Hollow,
   * Offset & extrude and Resize face cannot: they SPLIT or remove the face
   * they act on (an offset turns one top face into a ring plus a new face on
   * top of the boss), so the anchor stops matching anything. Holding on to it
   * meant the next edit wrote an op whose face no longer existed, and every
   * rebuild from then on reported "could not be found after rebuilding".
   */
  releaseFace() {
    if (this.pushPullPending) this.commitOrAbandonPushPull(false);
    else this.pushPullLabelEl.style.display = "none";
    const held = this.selectedFace ? this.parts.get(this.selectedFace.partId) : undefined;
    this.armedFace = null;
    this.selectedFace = null;
    if (held) clearHighlights(held.mesh.geometry as THREE.BufferGeometry);
    this.pushPullHandles.visible = false;
    this.pushPullHandleHovered = false;
  }

  /** Closes the face's typed-distance pill without applying anything, putting
   *  the previewed geometry back. Call this BEFORE committing some other edit
   *  to the same face: left open, the pill resolves later and restores its
   *  pre-edit snapshot over the top of the new shape — which looked like the
   *  wall vanishing again until the face was pushed or pulled. */
  dismissFaceInput() {
    if (this.pushPullPending) this.commitOrAbandonPushPull(false);
  }

  /** Pushes or pulls the selected face by a distance in WORLD millimetres,
   *  through the same path (and the same scale conversion and position
   *  correction) a drag would take. Returns false when no face is armed, or
   *  when the distance is below the same 0.5mm floor a drag uses. */
  pushSelectedFace(worldDistance: number): boolean {
    const armed = this.armedFace;
    if (!armed || !Number.isFinite(worldDistance) || Math.abs(worldDistance) < 0.5) return false;
    // Close the pill first if it is still open, so it cannot resolve later
    // and restore its snapshot over the top of this edit.
    this.dismissFaceInput();
    void this.applyPushPull({
      ...armed,
      // Only the pill's revert path reads these; applyPushPull does not touch
      // originalGeom, and takes the pivot as it stands right now.
      originalGeom: [],
      originalPivot: armed.view.pivot.clone(),
    }, worldDistance);
    // The face is still there — it has simply moved. Keeping it armed, at
    // where it now is, means a second edit does not need the face clicking
    // again (which said "Click the face again, then set the distance." and
    // left a stale size behind, so a Size typed after one edit measured
    // against the shape BEFORE it).
    const travel = this.toLocalDistance(worldDistance, armed.worldPerLocal);
    this.armedFace = {
      ...armed,
      localPoint: [
        armed.localPoint[0] + armed.localNormal[0] * travel,
        armed.localPoint[1] + armed.localNormal[1] * travel,
        armed.localPoint[2] + armed.localNormal[2] * travel,
      ],
    };
    return true;
  }

  private commitOrAbandonPushPull(apply: boolean) {
    const pending = this.pushPullPending;
    this.pushPullPending = null;
    this.pushPullGeneration++; // invalidates any still-in-flight preview — see applyFinalPushPullPreview
    this.pushPullLabelEl.style.display = "none";
    this.onDragChange?.(false);
    if (!pending) return;

    const distance = toMillimetres(Number(this.pushPullLabelEl.value), this.displayUnit);
    const valid = apply && Number.isFinite(distance) && Math.abs(distance) >= 0.5;
    if (valid) {
      this.disposeGeom(pending.originalGeom);
      const travelled = this.toLocalDistance(distance, pending.worldPerLocal);
      this.armedFace = {
        id: pending.id,
        localPoint: [
          pending.localPoint[0] + pending.localNormal[0] * travelled,
          pending.localPoint[1] + pending.localNormal[1] * travelled,
          pending.localPoint[2] + pending.localNormal[2] * travelled,
        ],
        localNormal: pending.localNormal,
        view: pending.view,
        worldPerLocal: pending.worldPerLocal,
      };
      void this.applyPushPull(pending, distance);
    } else {
      this.restoreGeom(pending.view, pending.originalGeom, pending.originalPivot);
      this.restoreSelectedFaceHighlight();
    }
  }

  /**
   * Writes a finished push/pull to the document: the distance converted back
   * into the kernel's own frame, plus whatever position change keeps the
   * rest of the object exactly where it was.
   *
   * That correction needs the edited solid's NEW bounding-box centre, which
   * only the kernel knows, so this asks for one more local preview build
   * first — cheap, and the shape already on screen covers the wait. An
   * unscaled part never needs it (pivotDrift is identically zero there), so
   * the common case skips the round trip entirely. If the build fails the op
   * still goes through uncorrected: the shape is what matters, and the real
   * rebuild has its own retries.
   */
  private async applyPushPull(pending: PushPullPending, world: number) {
    const op = {
      point: pending.localPoint,
      normal: pending.localNormal,
      distance: this.toLocalDistance(world, pending.worldPerLocal),
    };
    let shift: Vec3 = [0, 0, 0];
    const scale = pending.view.group.scale;
    if (scale.x !== 1 || scale.y !== 1 || scale.z !== 1) {
      const preview = await this.onPreviewPushPull?.(pending.id, op);
      const centre = preview ? meshCentre(preview.mesh) : null;
      if (centre) {
        const drift = this.pivotDrift(pending.view, pending.originalPivot, centre);
        shift = [-drift.x, -drift.y, -drift.z];
      }
    }
    this.onPushPullFace?.(pending.id, op, shift);
  }

  /** Puts a part's render geometry (and its matching pivot) back to a saved
   *  snapshot, disposing whatever was showing before the restore. Used to
   *  revert an abandoned push/pull's live preview — see
   *  commitOrAbandonPushPull. */
  private restoreGeom(view: PartView, geom: ThreeGeometry[], pivot: THREE.Vector3) {
    const stale = view.geom;
    view.geom = geom;
    view.pivot = pivot;
    view.mesh.geometry = geom[0].faces;
    view.wire.geometry = geom[0].lines;
    clearHighlights(view.mesh.geometry as THREE.BufferGeometry);
    this.applyPlacements();
    this.applyMaterials();
    this.disposeGeom(stale);
  }

  private disposeGeom(geom: ThreeGeometry[]) {
    for (const g of geom) {
      g.faces.dispose();
      g.lines.dispose();
    }
  }

  /**
   * One live preview sample during a push/pull drag: a real (throttled, see
   * PUSH_PULL_PREVIEW_MS) kernel rebuild of just this node with `distance`
   * tentatively applied, swapped into the part's actual Three.js geometry —
   * not just the arrow sliding, the shape itself growing/shrinking, the way
   * every other drag in this app already shows its result live. Nothing is
   * written to the document; the real edit only happens once the drag ends
   * and the pill is committed (see commitOrAbandonPushPull).
   */
  private requestPushPullPreview(drag: PushPullDrag, distance: number) {
    drag.queuedPreviewDistance = distance;
    if (drag.previewInFlight) return;
    drag.previewInFlight = true;

    void (async () => {
      while (this.pushPullDrag === drag && drag.queuedPreviewDistance !== null) {
        const nextDistance = drag.queuedPreviewDistance;
        drag.queuedPreviewDistance = null;
        const preview = await this.onPreviewPushPull?.(drag.id, {
          point: drag.localPoint,
          normal: drag.localNormal,
          distance: this.toLocalDistance(nextDistance, drag.worldPerLocal),
        });
        // The drag may have ended (or a newer one started) while this was in
        // flight. Never let that stale result overwrite the current scene.
        if (this.pushPullDrag !== drag) break;
        if (preview) this.applyPreviewMesh(drag, preview);
      }
      drag.previewInFlight = false;
    })();
  }

  private applyPreviewMesh(drag: PushPullDrag, preview: PreviewBuild) {
    // syncKernelGeometry reuses/mutates drag.view.geom's existing
    // BufferGeometry objects in place whenever the array length already
    // matches (always true here — one mesh in, one geometry pair out), so
    // the returned array IS (by reference) the same one passed in. Nothing
    // new is allocated on an ordinary preview frame, so there is nothing to
    // dispose here — disposing what this returns would destroy buffers the
    // mesh is still actively using. drag.originalGeom (a separate CLONE
    // taken before the drag began) is what preserves the true pre-drag
    // state; it is untouched by any of this and is what gets disposed or
    // restored once the drag actually ends — see commitOrAbandonPushPull.
    drag.view.geom = syncKernelGeometry(preview.mesh, drag.view.geom);
    drag.view.pivot = this.centreGeometry(drag.view.geom);
    drag.view.mesh.geometry = drag.view.geom[0].faces;
    drag.view.wire.geometry = drag.view.geom[0].lines;
    // Faces too, not just geometry — this is what the push/pull arrow (and
    // findFace/beginPushPullFromHover, for starting the NEXT drag) reads.
    // Without updating this too, the arrow stayed at its pre-drag position
    // until the next real, committed rebuild eventually corrected it —
    // visibly snapping a second or so later even though the shape itself
    // was already right. updatePushPullOverlay() runs every frame (see
    // renderFrame), so this alone is enough to move the arrow immediately;
    // no extra call needed here.
    if (preview.faces) {
      drag.view.faces = preview.faces;
      if (this.selectedFace?.partId === drag.id) {
        const travelled = this.toLocalDistance(drag.currentDistance, drag.worldPerLocal);
        const expected: Vec3 = [
          drag.localPoint[0] + drag.localNormal[0] * travelled,
          drag.localPoint[1] + drag.localNormal[1] * travelled,
          drag.localPoint[2] + drag.localNormal[2] * travelled,
        ];
        let bestIndex = this.selectedFace.groupIndex;
        let bestDistance = Infinity;
        for (let i = 0; i < preview.faces.length; i++) {
          const candidate = preview.faces[i];
          if (!candidate.planar) continue;
          const facing = candidate.normal[0] * drag.localNormal[0] +
            candidate.normal[1] * drag.localNormal[1] +
            candidate.normal[2] * drag.localNormal[2];
          if (facing < 0.9) continue;
          const distance = Math.hypot(
            candidate.point[0] - expected[0],
            candidate.point[1] - expected[1],
            candidate.point[2] - expected[2],
          );
          if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = i;
          }
        }
        this.selectedFace.groupIndex = bestIndex;
      }
    }
    this.applyPlacements();
    this.applyMaterials();
    this.restoreSelectedFaceHighlight();
  }

  private applyTypedDimension(input: HTMLInputElement) {
    const id = input.dataset.nodeId;
    const current = Number(input.dataset.currentSize);
    const desired = toMillimetres(Number(input.value), this.displayUnit);
    if (!Number.isFinite(current) || current <= 0 || !Number.isFinite(desired) || desired <= 0) {
      this.updateResizeOverlay();
      return;
    }
    const ratio = desired / current;
    const axis = this.dimensionInputs.indexOf(input) as 0 | 1 | 2;

    if (id === "multi") {
      const selectedViews = this.selectedIds
        .map((sId) => ({ id: sId, view: this.parts.get(sId), node: findNode(this.lastNodes, sId) }))
        .filter((item): item is { id: string; view: PartView; node: SceneNode } => !!item.view && !!item.node);
      if (!selectedViews.length) return;

      const box = new THREE.Box3();
      for (const { view } of selectedViews) {
        box.expandByObject(view.group);
      }
      const centre = box.getCenter(new THREE.Vector3());

      const hasLocks = selectedViews.some(
        ({ node }) =>
          node.type === "object" &&
          node.kind === "triangle" &&
          !!(node.params.lockAngleLeft || node.params.lockAngleRight || node.params.lockAngleApex),
      );

      for (const { id: sId, node } of selectedViews) {
        const scale = [...node.scale] as Vec3;
        const position = [...node.position] as Vec3;
        if (this.resizeConstrained || (hasLocks && (axis === 0 || axis === 1))) {
          if (hasLocks && !this.resizeConstrained) {
            for (let i = 0; i < 2; i++) {
              scale[i] = Math.max(0.01, scale[i] * ratio);
              position[i] = centre.getComponent(i) + (position[i] - centre.getComponent(i)) * ratio;
            }
          } else {
            for (let i = 0; i < 3; i++) {
              scale[i] = Math.max(0.01, scale[i] * ratio);
              position[i] = centre.getComponent(i) + (position[i] - centre.getComponent(i)) * ratio;
            }
          }
        } else {
          scale[axis] = Math.max(0.01, scale[axis] * ratio);
          position[axis] = centre.getComponent(axis) + (position[axis] - centre.getComponent(axis)) * ratio;
        }
        this.onTransformObject?.(sId, { scale, position });
      }
      return;
    }

    const node = id ? findNode(this.lastNodes, id) : undefined;
    if (!node) {
      this.updateResizeOverlay();
      return;
    }
    const scale = [...node.scale] as Vec3;
    const hasLocks =
      node.type === "object" &&
      node.kind === "triangle" &&
      !!(node.params.lockAngleLeft || node.params.lockAngleRight || node.params.lockAngleApex);

    if (this.resizeConstrained || (hasLocks && (axis === 0 || axis === 1))) {
      if (hasLocks && !this.resizeConstrained) {
        scale[0] = Math.max(0.01, scale[0] * ratio);
        scale[1] = Math.max(0.01, scale[1] * ratio);
      } else {
        for (let i = 0; i < 3; i++) scale[i] = Math.max(0.01, scale[i] * ratio);
      }
    } else {
      scale[axis] = Math.max(0.01, scale[axis] * ratio);
    }
    this.onTransformObject?.(node.id, { scale });
  }

  setResult(mesh: KernelMesh | null) {
    if (this.resultView) {
      this.scene.remove(this.resultView.group);
      this.resultView = null;
    }
    if (mesh) {
      const view = this.makeView(mesh, false);
      // Result geometry has no document node/placement pass, so restore the
      // offset removed while centring its render geometry.
      view.group.position.copy(view.pivot);
      view.mesh.material = [MATERIALS.result, MATERIALS.faceHighlight];
      this.resultView = view;
    }
    this.applyMaterials();
  }

  setShowResult(v: boolean) {
    this.showResult = v;
    this.applyMaterials();
    this.attachGizmo();
  }

  /** How close counts as "already touching", in mm. Well under the display
   *  mesh's own 0.05mm tessellation, so it only ever absorbs float noise. */
  private static readonly DROP_EPS = 1e-4;

  /** Rays cast per direction, per part. A box needs 8; an imported scan has
   *  tens of thousands of vertices and does not deserve a ray each. */
  private static readonly DROP_SAMPLES = 400;

  /** Columns per axis across the footprint two parts share. 12x12 resolves a
   *  contact a millimetre or two across on a part the size of a bracket,
   *  which is the scale at which a wrong landing is visible. */
  private static readonly DROP_GRID = 12;

  /**
   * Gravity, one step at a time — the D shortcut. Each selected top-level part
   * falls straight down until it meets the nearest upward-facing surface below
   * it, or the ground plane.
   *
   * There is no stored notion of "which level am I on". Pressing D again just
   * runs this from the new position: the surface now underfoot is at distance
   * ~0 and is skipped, undersides never count (see below), so the next press
   * naturally finds the next real level down and the plane is where it ends.
   *
   * Selected parts are dropped bottom-up and each one's view is moved as it
   * lands, so a stack dropped together closes up instead of every part
   * measuring against where the others used to be.
   */
  dropSelected(): { id: string; position: Vec3 }[] {
    this.scene.updateMatrixWorld(true);
    const falling = this.selectedIds
      .map((id) => ({ id, view: this.parts.get(id) }))
      .filter((entry): entry is { id: string; view: PartView } => !!entry.view)
      .map((entry) => ({
        ...entry,
        node: findNode(this.lastNodes, entry.id),
        minZ: new THREE.Box3().setFromObject(entry.view.group).min.z,
      }))
      .filter((entry) => !!entry.node)
      .sort((a, b) => a.minZ - b.minZ);

    const updates: { id: string; position: Vec3 }[] = [];
    for (const { id, view, node } of falling) {
      const drop = this.dropDistance(id, view);
      if (drop === null || drop <= Scene.DROP_EPS) continue;
      // Move the view now so anything still to fall measures against where
      // this part actually ended up. setPlacements() re-applies the document's
      // own numbers moments later either way.
      view.group.position.z -= drop;
      view.group.updateMatrixWorld(true);
      // Rounded so a landing reads as the round number it visually is (10, not
      // 9.999999999999998) — the raw distance comes off float matrix maths.
      const landed = Math.round((node!.position[2] - drop) * 1e6) / 1e6;
      updates.push({ id, position: [node!.position[0], node!.position[1], landed] });
    }
    return updates;
  }

  /**
   * Moves the selected parts as one rigid set along a world axis until their
   * shared bounds first meet another visible solid. Unlike downward gravity,
   * the other five directions have no infinite workplane, so no target means
   * no movement — an object can never be launched out of view.
   */
  dropSelectedDirection(direction: Vec3): { id: string; position: Vec3 }[] {
    const axis = direction.findIndex((value) => Math.abs(value) > 0.5);
    if (axis < 0) return [];
    const sign = Math.sign(direction[axis]);
    if (axis === 2 && sign < 0) return this.dropSelected();

    this.scene.updateMatrixWorld(true);
    const selected = new Set(this.selectedIds);
    const moving = this.selectedIds
      .map((id) => ({ id, view: this.parts.get(id), node: findNode(this.lastNodes, id) }))
      .filter((entry): entry is { id: string; view: PartView; node: SceneNode } =>
        !!entry.view && entry.view.group.visible && !!entry.node);
    if (!moving.length) return [];

    const movingBox = new THREE.Box3();
    for (const { view } of moving) movingBox.expandByObject(view.group);
    const perpendicular = [0, 1, 2].filter((candidate) => candidate !== axis);
    let distance = Infinity;
    const travel = new THREE.Vector3(direction[0], direction[1], direction[2]).normalize();
    const targetMeshes = [...this.parts]
      .filter(([id, target]) => !selected.has(id) && target.group.visible && !target.isHole)
      .map(([, target]) => target.mesh);
    const movingMeshes = moving.map(({ view }) => view.mesh);
    const normalMatrix = new THREE.Matrix3();
    const hitNormal = new THREE.Vector3();
    const rayOrigins: THREE.Vector3[] = [];

    for (const { view } of moving) {
      rayOrigins.push(...this.sampleDirectionalFacePoints(view, travel, Scene.DROP_SAMPLES));
    }

    // Vertices alone miss a recess whose opening lies in the middle of a
    // broad face. Fill the selection's leading face with probe columns, then
    // cast backwards into the selected geometry so only columns that truly
    // belong to the moving shape are retained.
    const steps = Scene.DROP_GRID - 1;
    const [uAxis, vAxis] = perpendicular;
    const leading = sign > 0
      ? movingBox.max.getComponent(axis)
      : movingBox.min.getComponent(axis);
    const reverse = travel.clone().negate();
    for (let u = 0; u <= steps; u++) {
      for (let v = 0; v <= steps; v++) {
        const probe = movingBox.getCenter(new THREE.Vector3());
        probe.setComponent(axis, leading + sign);
        probe.setComponent(
          uAxis,
          movingBox.min.getComponent(uAxis) +
            (movingBox.max.getComponent(uAxis) - movingBox.min.getComponent(uAxis)) * u / steps,
        );
        probe.setComponent(
          vAxis,
          movingBox.min.getComponent(vAxis) +
            (movingBox.max.getComponent(vAxis) - movingBox.min.getComponent(vAxis)) * v / steps,
        );
        this.raycaster.set(probe, reverse);
        for (const hit of this.raycaster.intersectObjects(movingMeshes, false)) {
          if (!hit.face) continue;
          normalMatrix.getNormalMatrix(hit.object.matrixWorld);
          hitNormal.copy(hit.face.normal).applyNormalMatrix(normalMatrix);
          if (hitNormal.dot(travel) <= 0.05) continue;
          rayOrigins.push(hit.point.clone());
          break;
        }
      }
    }

    // Probe the actual rendered faces, not only each object's outer box. This
    // lets a second directional drop see a recess, ledge, or internal wall in
    // the same compound object after its outermost face is already touching.
    for (const origin of rayOrigins) {
      this.raycaster.set(origin, travel);
      for (const hit of this.raycaster.intersectObjects(targetMeshes, false)) {
        if (hit.distance <= Scene.DROP_EPS || !hit.face) continue;
        normalMatrix.getNormalMatrix(hit.object.matrixWorld);
        hitNormal.copy(hit.face.normal).applyNormalMatrix(normalMatrix);
        if (hitNormal.dot(travel) >= -0.05) continue;
        distance = Math.min(distance, hit.distance);
        break;
      }
    }

    for (const [id, target] of this.parts) {
      if (selected.has(id) || !target.group.visible || target.isHole) continue;
      const targetBox = new THREE.Box3().setFromObject(target.group);
      const overlapsPath = perpendicular.every((otherAxis) =>
        movingBox.max.getComponent(otherAxis) >= targetBox.min.getComponent(otherAxis) - Scene.DROP_EPS &&
        movingBox.min.getComponent(otherAxis) <= targetBox.max.getComponent(otherAxis) + Scene.DROP_EPS);
      if (!overlapsPath) continue;

      const gap = sign > 0
        ? targetBox.min.getComponent(axis) - movingBox.max.getComponent(axis)
        : movingBox.min.getComponent(axis) - targetBox.max.getComponent(axis);
      // Match normal gravity: a face already touching the selection is the
      // layer we are leaving, not a permanent lock. Ignore it and search for
      // the next object farther along the chosen direction. If there is no
      // farther target, the selection stays where it is.
      if (gap > Scene.DROP_EPS) distance = Math.min(distance, gap);
    }

    if (!Number.isFinite(distance)) return [];
    const delta = sign * distance;
    const updates = moving.map(({ id, view, node }) => {
      view.group.position.setComponent(axis, view.group.position.getComponent(axis) + delta);
      view.group.updateMatrixWorld(true);
      const position = [...node.position] as Vec3;
      position[axis] = Math.round((position[axis] + delta) * 1e6) / 1e6;
      return { id, position };
    });
    return updates;
  }

  /** Live world bounding box of the current selection (visible parts only),
   *  or null with nothing selected/visible — the same box the resize cage
   *  itself draws (see updateResizeOverlay), exposed so the Inspector can
   *  show real Size/Position numbers for a multi-object selection instead
   *  of nothing at all. A single node already has its own position/size to
   *  show; this is only useful once there is no single node to ask. */
  getSelectionBounds(): { min: Vec3; max: Vec3 } | null {
    const box = new THREE.Box3();
    let count = 0;
    for (const id of this.selectedIds) {
      const view = this.parts.get(id);
      if (!view || !view.group.visible) continue;
      view.group.updateWorldMatrix(true, true);
      box.expandByObject(view.group);
      count++;
    }
    if (count === 0 || box.isEmpty()) return null;
    return { min: box.min.toArray() as Vec3, max: box.max.toArray() as Vec3 };
  }

  /** Resizes every selected object together along one world axis, scaling
   *  each about the selection's own shared box centre — exactly the maths
   *  the multi-target resize DRAG already applies every frame (see the
   *  `resizeDrag.targets.length > 1` branch above), just solved for and
   *  committed once instead of live per pointer move. `constrained` mirrors
   *  the Lock Proportions checkbox: true scales all three axes by the same
   *  ratio the requested axis needed, not just that one axis. Returns the
   *  per-object updates for the caller to commit as a single undo step —
   *  this method touches no document state itself. */
  resizeSelectionAxis(
    axis: 0 | 1 | 2,
    newSizeMm: number,
    constrained: boolean,
  ): { id: string; scale: Vec3; position: Vec3 }[] {
    const entries = this.selectedIds
      .map((id) => ({ id, view: this.parts.get(id), node: findNode(this.lastNodes, id) }))
      .filter(
        (e): e is { id: string; view: PartView; node: SceneNode } =>
          !!e.view && e.view.group.visible && !!e.node,
      );
    if (!entries.length || !(newSizeMm > 0)) return [];

    const box = new THREE.Box3();
    for (const { view } of entries) {
      view.group.updateWorldMatrix(true, true);
      box.expandByObject(view.group);
    }
    if (box.isEmpty()) return [];
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    if (!(size.getComponent(axis) > 1e-6)) return [];

    const ratio = Math.max(0.01, newSizeMm / size.getComponent(axis));
    const factors: Vec3 = constrained ? [ratio, ratio, ratio] : [1, 1, 1];
    if (!constrained) factors[axis] = ratio;

    return entries.map(({ id, node }) => {
      const scale: Vec3 = [
        Math.max(0.01, node.scale[0] * factors[0]),
        Math.max(0.01, node.scale[1] * factors[1]),
        Math.max(0.01, node.scale[2] * factors[2]),
      ];
      const position: Vec3 = [
        centre.x + (node.position[0] - centre.x) * factors[0],
        centre.y + (node.position[1] - centre.y) * factors[1],
        centre.z + (node.position[2] - centre.z) * factors[2],
      ];
      return { id, scale, position };
    });
  }

  /** Moves every selected object together so the selection's shared box
   *  centre lands on `newValueMm` along one world axis — everything keeps
   *  its own size and its position relative to the rest of the selection,
   *  the whole group just translates as one rigid body. Same
   *  commit-not-mutate contract as resizeSelectionAxis. */
  moveSelectionAxis(axis: 0 | 1 | 2, newValueMm: number): { id: string; position: Vec3 }[] {
    const entries = this.selectedIds
      .map((id) => ({ id, view: this.parts.get(id), node: findNode(this.lastNodes, id) }))
      .filter(
        (e): e is { id: string; view: PartView; node: SceneNode } =>
          !!e.view && e.view.group.visible && !!e.node,
      );
    if (!entries.length) return [];

    const box = new THREE.Box3();
    for (const { view } of entries) {
      view.group.updateWorldMatrix(true, true);
      box.expandByObject(view.group);
    }
    if (box.isEmpty()) return [];
    const centre = box.getCenter(new THREE.Vector3());
    const delta = newValueMm - centre.getComponent(axis);
    if (!Number.isFinite(delta) || Math.abs(delta) < 1e-9) return [];

    return entries.map(({ id, node }) => {
      const position = [...node.position] as Vec3;
      position[axis] += delta;
      return { id, position };
    });
  }

  /** How far this part can fall before something stops it, or null if nothing
   *  does (it is already resting). */
  private dropDistance(movingId: string, view: PartView): number | null {
    const targets = [...this.parts]
      // A hole is subtractive: landing on one would be landing on nothing.
      .filter(([id, v]) => id !== movingId && v.group.visible && !v.isHole)
      .map(([, v]) => v);
    const meshes = targets.map((t) => t.mesh);
    const movingBox = new THREE.Box3().setFromObject(view.group);
    const normalMatrix = new THREE.Matrix3();
    const worldNormal = new THREE.Vector3();
    let best = Infinity;

    const upwardHit = (hit: THREE.Intersection, wantUp: boolean): boolean => {
      if (!hit.face) return false;
      normalMatrix.getNormalMatrix(hit.object.matrixWorld);
      worldNormal.copy(hit.face.normal).applyNormalMatrix(normalMatrix);
      return wantUp ? worldNormal.z > 0 : worldNormal.z < 0;
    };

    // Rays down from this part: where does its own geometry first meet a face
    // that points up? An underside cannot hold anything up, so those are
    // skipped — which is also what makes a second press sink through a step
    // rather than catching on its bottom face.
    for (const origin of this.sampleFacePoints(view, true, Scene.DROP_SAMPLES)) {
      this.raycaster.set(origin, DOWN);
      for (const hit of this.raycaster.intersectObjects(meshes, false)) {
        if (hit.distance <= Scene.DROP_EPS) continue;
        if (!upwardHit(hit, true)) continue;
        best = Math.min(best, hit.distance);
        break;
      }
    }

    // Rays up from what is underneath. Sampling only the falling part would
    // let a cone tip or sphere pole slip between its own sample points and be
    // sunk straight through; every point below gets to push back too.
    for (const target of targets) {
      const box = new THREE.Box3().setFromObject(target.group);
      if (box.min.x > movingBox.max.x || box.max.x < movingBox.min.x) continue;
      if (box.min.y > movingBox.max.y || box.max.y < movingBox.min.y) continue;
      if (box.min.z > movingBox.max.z) continue;
      for (const origin of this.sampleFacePoints(target, false, Scene.DROP_SAMPLES)) {
        if (origin.x < movingBox.min.x || origin.x > movingBox.max.x) continue;
        if (origin.y < movingBox.min.y || origin.y > movingBox.max.y) continue;
        if (origin.z > movingBox.max.z) continue;
        this.raycaster.set(origin, UP);
        for (const hit of this.raycaster.intersectObject(view.mesh, false)) {
          if (hit.distance <= Scene.DROP_EPS) continue;
          if (!upwardHit(hit, false)) continue;
          best = Math.min(best, hit.distance);
          break;
        }
      }
    }

    // Neither part's corners need lie over the other. Two bars crossing in
    // plan — a panel spanning a deck narrower than itself — overlap only
    // where their EDGES cross, so every vertex of each sits outside the
    // other's footprint and both passes above come back empty. The part then
    // has nothing to stand on and falls clean through to the plate, which is
    // exactly what a bracket's upright did.
    //
    // So the overlap itself gets sampled. Down each column of the shared
    // footprint: how low does this part reach, and what is the highest thing
    // under it there.
    for (const target of targets) {
      const box = new THREE.Box3().setFromObject(target.group);
      const minX = Math.max(box.min.x, movingBox.min.x);
      const maxX = Math.min(box.max.x, movingBox.max.x);
      const minY = Math.max(box.min.y, movingBox.min.y);
      const maxY = Math.min(box.max.y, movingBox.max.y);
      if (minX > maxX || minY > maxY) continue;
      if (box.min.z > movingBox.max.z) continue;

      const above = movingBox.max.z + 1;
      const steps = Scene.DROP_GRID - 1;
      for (let ix = 0; ix <= steps; ix++) {
        for (let iy = 0; iy <= steps; iy++) {
          const x = steps ? minX + ((maxX - minX) * ix) / steps : minX;
          const y = steps ? minY + ((maxY - minY) * iy) / steps : minY;
          // The underside is found from BELOW, not by taking the last hit of a
          // downward ray. Materials here are FrontSide, and the raycaster
          // honours that: a ray travelling down never reports the faces
          // pointing down, so "the last hit" is really the part's TOP surface
          // — which measured the drop from the wrong face and buried the part
          // below the plate. A ray coming up meets that underside head on.
          const fromBelow = new THREE.Vector3(x, y, movingBox.min.z - 1);
          this.raycaster.set(fromBelow, UP);
          const mine = this.raycaster.intersectObject(view.mesh, false)[0];
          if (!mine) continue;
          const underside = mine.point.z;

          // Highest upward-facing surface of the target below that.
          const from = new THREE.Vector3(x, y, above);
          this.raycaster.set(from, DOWN);
          let support = -Infinity;
          for (const hit of this.raycaster.intersectObject(target.mesh, false)) {
            if (hit.point.z > underside - Scene.DROP_EPS) continue;
            if (!upwardHit(hit, true)) continue;
            support = Math.max(support, hit.point.z);
            break;
          }
          if (support === -Infinity) continue;
          best = Math.min(best, underside - support);
        }
      }
    }

    // The build plate always catches whatever nothing else did — and nothing
    // may sink through it, however the probes above vote.
    if (movingBox.min.z > Scene.DROP_EPS) best = Math.min(best, movingBox.min.z);
    if (best > movingBox.min.z) best = Math.max(0, movingBox.min.z);

    return Number.isFinite(best) ? best : null;
  }

  /**
   * Up to `max` world-space vertices from the faces of a part that point down
   * (`wantDown`) or up.
   *
   * Which half matters: only a part's UNDERSIDE can land on something. Casting
   * from every vertex measures the top face's distance to the surface below it
   * too, and the moment a part is level with something — exactly the state a
   * second D press starts from — that spurious distance is the shortest one,
   * and the part sinks by its own height instead of to the next level.
   */
  private sampleFacePoints(view: PartView, wantDown: boolean, max: number): THREE.Vector3[] {
    const geometry = view.mesh.geometry;
    const position = geometry.getAttribute("position");
    const normal = geometry.getAttribute("normal");
    const matrix = view.mesh.matrixWorld;
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
    const facing = new THREE.Vector3();

    // Collect the whole half FIRST, then thin it out. Thinning first and
    // filtering after loses the underside entirely on a dense mesh: an
    // extruded import is mostly wall, so a stride that keeps one vertex in
    // twenty can step over every one of the few that face down — and a part
    // with no underside samples has nothing to stand on, so it falls straight
    // through whatever it was above, all the way to the plate.
    const facingHalf: number[] = [];
    for (let i = 0; i < position.count; i++) {
      if (normal) {
        facing.fromBufferAttribute(normal, i).applyNormalMatrix(normalMatrix);
        // A vertical wall (z ~ 0) belongs to neither half and is skipped: its
        // top and bottom rims already come from the caps they join.
        if (wantDown ? facing.z >= 0 : facing.z <= 0) continue;
      }
      facingHalf.push(i);
    }

    // No normals at all — a mesh from the manifold side can arrive without
    // them — so every vertex is a candidate rather than none.
    const indices = facingHalf.length
      ? facingHalf
      : Array.from({ length: position.count }, (_, i) => i);

    const stride = Math.max(1, Math.ceil(indices.length / max));
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < indices.length; i += stride) {
      points.push(new THREE.Vector3().fromBufferAttribute(position, indices[i]).applyMatrix4(matrix));
    }
    return points;
  }

  /** World-space samples from the side of a part facing the travel direction. */
  private sampleDirectionalFacePoints(
    view: PartView,
    direction: THREE.Vector3,
    max: number,
  ): THREE.Vector3[] {
    const geometry = view.mesh.geometry;
    const position = geometry.getAttribute("position");
    const normal = geometry.getAttribute("normal");
    const matrix = view.mesh.matrixWorld;
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
    const facing = new THREE.Vector3();
    const indices: number[] = [];
    for (let index = 0; index < position.count; index++) {
      if (normal) {
        facing.fromBufferAttribute(normal, index).applyNormalMatrix(normalMatrix);
        if (facing.dot(direction) <= 0.05) continue;
      }
      indices.push(index);
    }
    const candidates = indices.length
      ? indices
      : Array.from({ length: position.count }, (_, index) => index);
    const stride = Math.max(1, Math.ceil(candidates.length / max));
    const points: THREE.Vector3[] = [];
    for (let index = 0; index < candidates.length; index += stride) {
      points.push(new THREE.Vector3()
        .fromBufferAttribute(position, candidates[index])
        .applyMatrix4(matrix));
    }
    return points;
  }

  /**
   * Shows one clickable body per region of the selection's arrangement, and
   * hides the shapes they came from — from here on the regions ARE the model
   * as far as this tool is concerned. Every region starts kept, so a builder
   * session that touches nothing commits a plain union.
   *
   * Passing null ends the session and puts the original parts back.
   */
  setCells(cells: CellPart[] | null) {
    for (const view of this.cellViews.values()) {
      this.scene.remove(view.group);
      view.mesh.geometry.dispose();
      view.wire.geometry.dispose();
    }
    this.cellViews.clear();
    this.hoverCell = null;
    this.hoverGroup.clear();
    this.cellCursorEl.style.display = "none";

    if (cells) {
      for (const cell of cells) {
        const geom = syncKernelGeometry(cell.mesh);
        const mesh = new THREE.Mesh(geom[0].faces, MATERIALS.cellKept);
        const wire = new THREE.LineSegments(geom[0].lines, MATERIALS.wire);
        const group = new THREE.Group();
        group.add(mesh, wire);
        this.scene.add(group);
        // Regions start IN, so alt-click — "take this one out", the gesture
        // subtract is made of — does something the moment the tool opens.
        // They are drawn see-through rather than solid, which is what stops
        // that from looking identical to the shapes you started with: you can
        // see the interior regions, and taking one out is visible immediately.
        this.cellViews.set(cell.mask, { group, mesh, wire, kept: true });
      }
    }
    // The sources would otherwise sit exactly on top of their own regions,
    // z-fighting them and swallowing every click.
    for (const view of this.parts.values()) view.group.visible = !cells;
    this.applyCellMaterials();
    this.applyMaterials();
    this.reportCells();
  }

  private reportCells() {
    this.onCellsChanged?.(
      [...this.cellViews].map(([mask, view]) => ({ mask, kept: view.kept })),
    );
  }

  /** Put a region in or take it out from outside the viewport — the panel's
   *  way in, and the only way to reach a region with no visible surface. */
  setCellKept(mask: number, kept: boolean) {
    const view = this.cellViews.get(mask);
    if (!view || view.kept === kept) return;
    view.kept = kept;
    this.applyCellMaterials();
    this.reportCells();
  }

  /** Highlights a region without clicking it, so hovering its entry in the
   *  panel shows which part of the model it actually is. */
  previewCell(mask: number | null) {
    if (this.hoverCell === mask) return;
    this.hoverCell = mask;
    // The panel names one region, so it highlights exactly that one.
    this.hoverGroup = new Set(mask === null ? [] : [mask]);
    this.applyCellMaterials();
  }

  /** Which regions are currently kept — what a commit turns into a BuildNode. */
  keptCells(): number[] {
    return [...this.cellViews]
      .filter(([, view]) => view.kept)
      .map(([mask]) => mask)
      .sort((a, b) => a - b);
  }

  get hasCells(): boolean {
    return this.cellViews.size > 0;
  }

  private applyCellMaterials() {
    for (const [mask, view] of this.cellViews) {
      const hovered = this.hoverGroup.has(mask);
      view.mesh.material = view.kept
        ? hovered
          ? MATERIALS.cellHover
          : MATERIALS.cellKept
        : hovered
          ? MATERIALS.cellHoverRemoved
          : MATERIALS.cellRemoved;
      // Removed regions draw after the kept ones so their ghost reads as
      // "in front of, but not part of" the solid.
      view.mesh.renderOrder = view.kept ? 0 : 2;
      view.wire.visible = view.kept || hovered;
    }
  }

  /** Moves the +/− badge to the pointer, or hides it when there is nothing
   *  under it to act on. */
  private updateCellCursor(alt: boolean) {
    const at = this.cellCursorAt;
    const over = this.toolMode === "build" && this.cellViews.size > 0 && this.hoverCell !== null;
    if (!over || !at) {
      this.cellCursorEl.style.display = "none";
      return;
    }
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.cellCursorEl.textContent = alt ? "−" : "+";
    this.cellCursorEl.classList.toggle("is-remove", alt);
    this.cellCursorEl.style.left = `${at.x - rect.left + 16}px`;
    this.cellCursorEl.style.top = `${at.y - rect.top + 16}px`;
    this.cellCursorEl.style.display = "flex";
  }

  /**
   * What a click on `mask` acts on.
   *
   * A region belonging to exactly one shape stands for that whole shape: the
   * visible bulge of a sphere sunk into a box is "the sphere" to anyone
   * looking at it, and alt-clicking it has to subtract the sphere — all of
   * it, including the half buried inside the box that no click can reach.
   * Removing only the part sticking out leaves box-plus-overlap, which is
   * the box, which is exactly the "nothing happened" this kept producing.
   *
   * A region shared by several shapes is already a deliberate choice — the
   * overlap itself — so that one acts alone.
   */
  private cellGroup(mask: number): number[] {
    const single = (mask & (mask - 1)) === 0;
    if (!single) return [mask];
    return [...this.cellViews.keys()].filter((m) => m & mask);
  }

  /** The region under the pointer, or null. */
  private raycastCell(e: PointerEvent): number | null {
    if (!this.cellViews.size) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const meshes = [...this.cellViews.values()].map((v) => v.mesh);
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (!hits.length) return null;

    const maskOf = (object: THREE.Object3D): number | null => {
      for (const [mask, view] of this.cellViews) if (view.mesh === object) return mask;
      return null;
    };

    // A region still in the shape wins over any ghost in front of it. Without
    // this, removing one region walls off everything behind it: the ghost is
    // still solid geometry to a raycast, so it keeps swallowing the clicks
    // meant for the regions it is now merely a shell around.
    for (const hit of hits) {
      const mask = maskOf(hit.object);
      if (mask !== null && this.cellViews.get(mask)?.kept) return mask;
    }
    // Nothing kept along the ray — then the frontmost ghost is what you meant,
    // which is how a removed region gets clicked back in.
    return maskOf(hits[0].object);
  }

  /** Click adds what is under the pointer, alt-click takes it back out —
   *  a whole shape at a time when that is what was clicked (see cellGroup). */
  private paintCell(e: PointerEvent, keep: boolean): boolean {
    const mask = this.raycastCell(e);
    if (mask === null) return false;
    let changed = false;
    for (const m of this.cellGroup(mask)) {
      const view = this.cellViews.get(m);
      if (!view || view.kept === keep) continue;
      view.kept = keep;
      changed = true;
    }
    if (changed) {
      this.applyCellMaterials();
      this.reportCells();
    }
    return true;
  }

  setSnapEnabled(v: boolean) {
    if (this.snapEnabled === v) return;
    this.snapEnabled = v;
    if (!v) {
      this.guides.clear();
      this.clearCollisionContacts();
    }
  }

  setGridSnapEnabled(v: boolean) {
    this.gridSnapEnabled = v;
    this.gizmo.setTranslationSnap(v && !this.altDown ? 1 : null);
  }

  setShowSelectedCollisionContacts(v: boolean) {
    this.showSelectedCollisionContacts = v;
    if (v) this.refreshSelectedCollisionContacts();
    else if (!this.grab?.active) this.clearCollisionContacts();
  }

  setWireframe(v: WireframeMode | boolean) {
    const mode: WireframeMode = typeof v === "boolean" ? (v ? "edges" : "off") : v;
    if (this.wireframe === mode) return;
    this.wireframe = mode;
    this.applyMaterials();
  }

  /** Smoothly pans and zooms the camera to frame either the selected objects
   *  or all objects in the scene if nothing is selected, filling the screen. */
  zoomToFit(ids?: string[]) {
    cancelAnimationFrame(this.navAnimFrame);
    const targetIds = ids && ids.length > 0 ? ids : this.selectedIds;
    const box = new THREE.Box3();
    let count = 0;

    if (targetIds && targetIds.length > 0) {
      for (const id of targetIds) {
        const view = this.parts.get(id);
        if (view) {
          box.union(new THREE.Box3().setFromObject(view.group));
          count++;
        }
      }
    }

    // If nothing selected or selected not found, frame the entire (visible)
    // scene — a part hidden via the eye icon should not pull the camera out
    // to make room for something the user just asked not to see.
    if (count === 0) {
      for (const view of this.parts.values()) {
        if (!view.group.visible) continue;
        box.union(new THREE.Box3().setFromObject(view.group));
        count++;
      }
    }

    // If scene is completely empty, frame a default volume around origin
    if (count === 0 || box.isEmpty()) {
      box.set(new THREE.Vector3(-20, -20, 0), new THREE.Vector3(20, 20, 20));
    }

    const center = box.getCenter(new THREE.Vector3());
    const startPos = this.camera.position.clone();
    const startTarget = this.controls.target.clone();

    // Direction vector from target to camera (view direction)
    let camZ = startPos.clone().sub(startTarget);
    if (camZ.lengthSq() < 1e-4) {
      camZ.set(1, -1, 0.8).normalize();
    } else {
      camZ.normalize();
    }

    // Camera X and Y axes in world space
    const camX = new THREE.Vector3().crossVectors(this.camera.up, camZ).normalize();
    const camY = new THREE.Vector3().crossVectors(camZ, camX).normalize();

    // 8 corners of the selection bounding box
    const corners = [
      new THREE.Vector3(box.min.x, box.min.y, box.min.z),
      new THREE.Vector3(box.min.x, box.min.y, box.max.z),
      new THREE.Vector3(box.min.x, box.max.y, box.min.z),
      new THREE.Vector3(box.min.x, box.max.y, box.max.z),
      new THREE.Vector3(box.max.x, box.min.y, box.min.z),
      new THREE.Vector3(box.max.x, box.min.y, box.max.z),
      new THREE.Vector3(box.max.x, box.max.y, box.min.z),
      new THREE.Vector3(box.max.x, box.max.y, box.max.z),
    ];

    const aspect = Math.max(this.aspect(), 0.1);
    let endPos: THREE.Vector3;

    if (this.camera instanceof THREE.PerspectiveCamera) {
      const tanHalfFovV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
      const tanHalfFovH = tanHalfFovV * aspect;

      let maxRequiredDist = 0;
      for (const corner of corners) {
        const rel = corner.clone().sub(center);
        const x = Math.abs(rel.dot(camX));
        const y = Math.abs(rel.dot(camY));
        const z = rel.dot(camZ);

        const reqV = z + y / tanHalfFovV;
        const reqH = z + x / tanHalfFovH;
        maxRequiredDist = Math.max(maxRequiredDist, reqV, reqH);
      }

      // 10% padding so selection cleanly fills the screen with room for handles
      const dist = Math.max(maxRequiredDist * 1.10, 10);
      endPos = center.clone().add(camZ.clone().multiplyScalar(dist));
    } else {
      let maxHalfW = 0;
      let maxHalfH = 0;
      for (const corner of corners) {
        const rel = corner.clone().sub(center);
        maxHalfW = Math.max(maxHalfW, Math.abs(rel.dot(camX)));
        maxHalfH = Math.max(maxHalfH, Math.abs(rel.dot(camY)));
      }
      const fitHalfH = Math.max(maxHalfH, maxHalfW / aspect) * 1.10;
      const fitHalfW = fitHalfH * aspect;
      this.camera.left = -fitHalfW;
      this.camera.right = fitHalfW;
      this.camera.top = fitHalfH;
      this.camera.bottom = -fitHalfH;
      this.camera.updateProjectionMatrix();

      const orthoDist = 300;
      endPos = center.clone().add(camZ.clone().multiplyScalar(orthoDist));
    }

    const duration = 350;
    const startTime = performance.now();

    const step = () => {
      const t = Math.min(1, (performance.now() - startTime) / duration);
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      this.camera.position.lerpVectors(startPos, endPos, eased);
      this.controls.target.lerpVectors(startTarget, center, eased);
      this.controls.update();

      if (t < 1) {
        this.navAnimFrame = requestAnimationFrame(step);
      } else {
        this.saveCameraNow();
      }
    };
    step();
  }

  /** Resets camera position, target, and zoom to the default comfortable TinkerCAD home view. */
  resetView() {
    cancelAnimationFrame(this.navAnimFrame);
    const startPos = this.camera.position.clone();
    const startTarget = this.controls.target.clone();

    // Classic ISO 3D view: 45° corner azimuth with 35° isometric elevation
    const defaultTarget = new THREE.Vector3(0, 0, 0);
    const defaultPos = new THREE.Vector3(150, -150, 115);

    if (this.camera instanceof THREE.OrthographicCamera) {
      const halfH = 105;
      const halfW = halfH * Math.max(this.aspect(), 0.1);
      this.camera.left = -halfW;
      this.camera.right = halfW;
      this.camera.top = halfH;
      this.camera.bottom = -halfH;
      this.camera.zoom = 1;
      this.camera.updateProjectionMatrix();
    } else if (this.camera instanceof THREE.PerspectiveCamera) {
      this.camera.zoom = 1;
      this.camera.updateProjectionMatrix();
    }

    const duration = 350;
    const startTime = performance.now();

    const step = () => {
      const t = Math.min(1, (performance.now() - startTime) / duration);
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      this.camera.position.lerpVectors(startPos, defaultPos, eased);
      this.controls.target.lerpVectors(startTarget, defaultTarget, eased);
      this.controls.update();

      if (t < 1) {
        this.navAnimFrame = requestAnimationFrame(step);
      } else {
        this.saveCameraNow();
      }
    };
    step();
  }

  // ---- gizmo ------------------------------------------------------------

  /**
   * Three.js draws a second, detached arrowhead on the negative end of every
   * translation axis. Keep its generous invisible pickers (so an axis remains
   * easy to grab from either side), but simplify the visible control to the
   * conventional three complete positive-axis arrows.
   */
  private removeNegativeMoveArrowheads() {
    const helper = this.gizmo.getHelper();
    const transformGizmo = helper.children.find(
      (child) => child.type === "TransformControlsGizmo",
    );
    const translateGizmo = transformGizmo?.children[0];
    if (!translateGizmo) return;

    const negativeArrowheads = translateGizmo.children.filter((handle) => {
      if (!(handle instanceof THREE.Mesh) || !["X", "Y", "Z"].includes(handle.name)) return false;
      const geometry = handle.geometry;
      geometry.computeBoundingBox();
      const center = geometry.boundingBox?.getCenter(new THREE.Vector3());
      if (!center) return false;
      return (
        (handle.name === "X" && center.x < -0.4) ||
        (handle.name === "Y" && center.y < -0.4) ||
        (handle.name === "Z" && center.z < -0.4)
      );
    });

    for (const arrowhead of negativeArrowheads) translateGizmo.remove(arrowhead);
  }

  setToolMode(mode: ToolMode) {
    if (mode !== "face") this.armedFace = null;
    const leavingFace = (this.toolMode === "face" || this.toolMode === "place") && mode !== this.toolMode;
    // The offset readout belongs to select-tool dragging; leaving would strand
    // a start point that the next return to select has no reason to honour.
    if (mode !== "select") this.clearMoveReadout();
    if (this.toolMode === "build" && mode !== "build") this.setCells(null);
    this.toolMode = mode;
    if (mode !== "align" && this.alignPointDrag) {
      this.alignPointDrag = null;
      this.alignDragArrow.visible = false;
      this.controls.enabled = true;
      this.gizmo.enabled = true;
      this.clearAlignPreview();
      this.onDragChange?.(false);
    }
    if (mode !== "place" && this.placementPreview) this.placementPreview.visible = false;
    if (mode !== "edge") {
      this.clearEdgeSelection(true);
      this.clearEdgeHover();
    }
    if (leavingFace) {
      // A half-finished push/pull must not survive the tool switch — abandon
      // it rather than leaving its preview geometry and open distance pill
      // behind with no tool left that could resolve them.
      if (this.pushPullPending) this.commitOrAbandonPushPull(false);
      this.clearFaceHover();
      // Drop the red face highlight itself, not just the reference to it:
      // clearFaceHover only removes a HOVER highlight and then repaints
      // whichever face is selected, so clearing the selection alone would
      // leave the last face painted with no tool active that explains it.
      const held = this.selectedFace ? this.parts.get(this.selectedFace.partId) : undefined;
      this.selectedFace = null;
      if (held) clearHighlights(held.mesh.geometry as THREE.BufferGeometry);
    }
    if (mode === "move" || mode === "rotate") {
      this.gizmo.setMode(mode === "move" ? "translate" : "rotate");
      // Three.js defaults to a very large presentation-sized control. Keep
      // Move compact enough that it does not cover a medium part; Rotate gets
      // a touch more room because its circular rings need separation.
      this.gizmo.setSize(mode === "move" ? 0.7 : 0.82);
    }
    this.attachGizmo();
    this.updateResizeOverlay();
    this.updateAlignOverlay();
    this.updatePushPullOverlay();
    this.updateMoveReadout();
  }

  setFacePushPullEnabled(enabled: boolean) {
    this.facePushPullEnabled = enabled;
    if (!enabled) {
      if (this.pushPullPending) this.commitOrAbandonPushPull(false);
      else this.pushPullLabelEl.style.display = "none";
      this.pushPullLabelEl.style.display = "none";
      // A face can remain selected while switching tools. Hide the complete
      // Push/Pull affordance immediately, including any handle retained by a
      // stale drag state; Wall only needs the orange face highlight.
      this.pushPullHandles.visible = false;
    }
    this.pushPullHandleHovered = false;
    this.updatePushPullOverlay();
  }

  /** The gizmo drives one node at a time — the most recently selected. */
  private gizmoTarget(): string | null {
    return this.selectedIds.length ? this.selectedIds[this.selectedIds.length - 1] : null;
  }

  private attachGizmo() {
    const id = this.gizmoTarget();
    if (!id || this.showResult || (this.toolMode !== "move" && this.toolMode !== "rotate")) {
      if (this.gizmo.object) this.gizmo.detach();
      return;
    }

    if (this.assemblyGroups.has(id)) {
      let pivotObj = this.assemblyPivots.get(id);
      if (!pivotObj) {
        pivotObj = new THREE.Object3D();
        pivotObj.name = `AssemblyPivot-${id}`;
        this.scene.add(pivotObj);
        this.assemblyPivots.set(id, pivotObj);
      }
      const center = this.computeAssemblyCenter(id);
      const node = findNode(this.lastNodes, id);
      pivotObj.position.copy(center);
      if (node) {
        pivotObj.rotation.set(node.rotation[0] * DEG, node.rotation[1] * DEG, node.rotation[2] * DEG);
      }
      if (this.gizmo.object !== pivotObj) this.gizmo.attach(pivotObj);
      return;
    }

    const view = this.parts.get(id);
    if (view) {
      if (this.gizmo.object !== view.group) this.gizmo.attach(view.group);
    } else if (this.gizmo.object) {
      this.gizmo.detach();
    }
  }

  private onDraggingChanged = (e: { value: unknown }) => {
    this.controls.enabled = !e.value;
    if (!e.value) {
      this.guides.clear();
      this.assemblyDragStart = null;
    } else {
      const id = this.gizmoTarget();
      // TransformControls captures its handle before the canvas pointerdown
      // path runs. Clear any marker left by the previously selected object
      // here, at the authoritative start of every gizmo drag. Fresh contact
      // for the object being moved is rebuilt by onGizmoChange.
      this.clearCollisionContacts();
      if (id && this.assemblyGroups.has(id)) {
        const node = findNode(this.lastNodes, id);
        const pivotObj = this.assemblyPivots.get(id);
        if (pivotObj && node) {
          this.assemblyDragStart = {
            center: pivotObj.position.clone(),
            position: [...node.position],
            rotation: [...node.rotation],
          };
        }
      }
    }
    this.onDragChange?.(!!e.value);
  };

  private onGizmoChange = () => {
    // TransformControls can emit objectChange while it is being attached or
    // refreshed programmatically. Only a real pointer drag may alter document
    // transforms or invoke smart snapping.
    if (!this.gizmo.dragging) return;
    const obj = this.gizmo.object;
    const id = this.gizmoTarget();
    if (!obj || !id) return;
    if (this.gizmo.getMode() === "translate") this.applySmartSnap(id, obj);
    if (this.assemblyGroups.has(id)) {
      const start = this.assemblyDragStart;
      if (start) {
        const delta = obj.position.clone().sub(start.center);
        const newPos: Vec3 = [
          start.position[0] + delta.x,
          start.position[1] + delta.y,
          start.position[2] + delta.z,
        ];
        const newRot: Vec3 = [
          obj.rotation.x / DEG,
          obj.rotation.y / DEG,
          obj.rotation.z / DEG,
        ];
        this.onTransformObject?.(id, {
          position: newPos,
          rotation: newRot,
        });
      }
      return;
    }
    const view = this.parts.get(id);
    const rotatedPivot = view?.pivot.clone().applyEuler(obj.rotation) ?? new THREE.Vector3();
    this.onTransformObject?.(id, {
      position: [
        obj.position.x - rotatedPivot.x,
        obj.position.y - rotatedPivot.y,
        obj.position.z - rotatedPivot.z,
      ],
      rotation: [obj.rotation.x / DEG, obj.rotation.y / DEG, obj.rotation.z / DEG],
    });
  };

  /** Snaps `obj` to the guides around it and returns how far that moved it,
   *  so a multi-object drag can carry the rest of the selection along by the
   *  same amount instead of leaving them behind. */
  private applySmartSnap(id: string, obj: THREE.Object3D): Vec3 {
    // Alt bypasses snapping so a free-placed copy never gets pulled onto a
    // guide. Shift does NOT bypass it — shift-constrain only locks the drag
    // to a straight line; Smart Guides still snap along that line exactly
    // as they would without shift, matching Illustrator.
    // Off entirely, or held off for this one drag by Alt. Alt stays a
    // bypass rather than a toggle: reaching for it is how you place one
    // object freely without giving up snapping for everything after it.
    if (!this.snapEnabled || this.altDown) {
      this.guides.clear();
      this.collisionContactCache.delete(id);
      this.clearCollisionContacts();
      return [0, 0, 0];
    }

    // Everything travelling with the pointer is excluded, not just the one
    // object under it. A companion in the same drag is a moving target: the
    // dragged object snaps to it, it moves, the snap re-solves against its
    // new position, and the two chase each other frame after frame — which
    // is exactly the jitter this produced on a multi-object drag.
    const travelling = new Set(
      this.grab?.active ? this.grab.items.map((item) => item.id) : [id],
    );
    const moving = this.boundsOf(obj);
    const targets: SnapTarget[] = [];
    const movingRoot = this.assemblyGroups.get(id) ?? this.parts.get(id)?.group;
    for (const [targetId, view] of this.parts) {
      if (
        travelling.has(targetId) || !view.group.visible ||
        (movingRoot && movingRoot !== view.group && !!movingRoot.getObjectById(view.group.id))
      ) continue;
      const targetBounds = this.boundsOf(view.group);
      const surfaces = this.surfaceSnapTargets(targetId, view.group, moving);
      if (surfaces.length) targets.push(...surfaces);
      else {
        // Curved meshes may have no axis-aligned surface triangles. They can
        // still use their bounds as a fallback, but only when the two 3D
        // boxes are genuinely nearby. Previously a matching X or Y value
        // could magnetise objects that were far apart on another axis.
        const gapSquared = [0, 1, 2].reduce((sum, axis) => {
          const gap = moving.max[axis] < targetBounds.min[axis]
            ? targetBounds.min[axis] - moving.max[axis]
            : targetBounds.max[axis] < moving.min[axis]
              ? moving.min[axis] - targetBounds.max[axis]
              : 0;
          return sum + gap * gap;
        }, 0);
        if (gapSquared <= 4) targets.push({ id: targetId, bounds: targetBounds });
      }
    }

    const result = snapBounds(moving, targets, this.worldSnapTolerance(obj.position));
    const featureDelta = this.meshFeatureSnap(id, travelling, this.worldSnapTolerance(obj.position));
    // On a gizmo-axis drag, a corner-to-sloped-edge match is the meaningful
    // snap for that axis. Bounds may simultaneously report a zero-distance
    // centre alignment on another axis; that must not suppress this contact.
    const featureDistance = featureDelta ? Math.hypot(...featureDelta) : Infinity;
    const boundsDistance = Math.hypot(...result.delta);
    const featureWins = !!featureDelta && (
      (this.gizmo.dragging && !!this.gizmo.axis) ||
      boundsDistance <= 1e-6 || featureDistance < boundsDistance
    );
    if (featureWins && featureDelta) {
      obj.position.add(new THREE.Vector3(...featureDelta));
      obj.updateWorldMatrix(true, true);
      this.guides.clear();
      this.refreshCollisionContactsFor(id);
      return featureDelta;
    }
    if (!result.active.length) {
      if (featureDelta) {
        obj.position.add(new THREE.Vector3(...featureDelta));
        obj.updateWorldMatrix(true, true);
        this.guides.clear();
        this.refreshCollisionContactsFor(id);
        return featureDelta;
      }
      this.guides.clear();
      this.collisionContactCache.delete(id);
      this.clearCollisionContacts();
      return [0, 0, 0];
    }

    obj.position.x += result.delta[0];
    obj.position.y += result.delta[1];
    obj.position.z += result.delta[2];
    obj.updateWorldMatrix(true, true);
    const snappedBounds = this.boundsOf(obj);
    this.guides.show(result.active, snappedBounds);
    this.refreshCollisionContactsFor(id, result.active);
    return result.delta;
  }

  /** Magnetic corner/edge snapping for contacts that cannot be represented by
   * axis-aligned bounds, such as a box corner meeting a chamfered edge. */
  private meshFeatureSnap(id: string, travelling: Set<string>, tolerance: number): Vec3 | null {
    const movingTriangles = this.worldTriangles(id);
    if (!movingTriangles.length) return null;
    const movingRoot = this.assemblyGroups.get(id) ?? this.parts.get(id)?.group;
    const pointMap = new Map<string, THREE.Vector3>();
    const edgeMap = new Map<string, [THREE.Vector3, THREE.Vector3]>();
    const collect = (
      triangles: THREE.Vector3[][],
      points: Map<string, THREE.Vector3>,
      edges: Map<string, [THREE.Vector3, THREE.Vector3]>,
    ) => {
      for (const triangle of triangles) {
        for (let index = 0; index < 3; index++) {
          const a = triangle[index];
          const b = triangle[(index + 1) % 3];
          const aKey = this.contactPointKey(a);
          const bKey = this.contactPointKey(b);
          points.set(aKey, a);
          const keys = [aKey, bKey].sort();
          edges.set(`${keys[0]}|${keys[1]}`, [a, b]);
        }
      }
    };
    collect(movingTriangles, pointMap, edgeMap);

    const axis = this.gizmo.dragging ? this.gizmo.axis : null;
    const allowed = axis === "X" ? [0] : axis === "Y" ? [1] : axis === "Z" ? [2] : [0, 1];
    const contactTolerance = 0.06;
    let best: Vec3 | null = null;
    let bestLength = Math.min(tolerance, 2);
    let comparisons = 0;
    const consider = (delta: THREE.Vector3) => {
      for (let component = 0; component < 3; component++) {
        if (!allowed.includes(component) && Math.abs(delta.getComponent(component)) > contactTolerance) return;
        if (!allowed.includes(component)) delta.setComponent(component, 0);
      }
      const length = delta.length();
      if (length <= bestLength) {
        best = [delta.x, delta.y, delta.z];
        bestLength = length;
      }
    };
    const constrainedPointDelta = (
      point: THREE.Vector3,
      segmentA: THREE.Vector3,
      segmentB: THREE.Vector3,
      movingPoint: boolean,
    ) => {
      if (allowed.length !== 1) {
        const closest = new THREE.Line3(segmentA, segmentB)
          .closestPointToPoint(point, true, new THREE.Vector3());
        return movingPoint ? closest.sub(point) : point.clone().sub(closest);
      }
      const moveAxis = allowed[0];
      const fixedAxes = [0, 1, 2].filter((component) => component !== moveAxis);
      const estimates: number[] = [];
      for (const component of fixedAxes) {
        const span = segmentB.getComponent(component) - segmentA.getComponent(component);
        if (Math.abs(span) > 1e-8) {
          estimates.push((point.getComponent(component) - segmentA.getComponent(component)) / span);
        } else if (Math.abs(point.getComponent(component) - segmentA.getComponent(component)) > contactTolerance) {
          return null;
        }
      }
      const t = estimates.length ? estimates.reduce((sum, value) => sum + value, 0) / estimates.length : 0.5;
      if (t < -1e-6 || t > 1 + 1e-6 || estimates.some((value) => Math.abs(value - t) > 0.01)) return null;
      const crossing = segmentA.clone().lerp(segmentB, Math.max(0, Math.min(1, t)));
      for (const component of fixedAxes) {
        if (Math.abs(crossing.getComponent(component) - point.getComponent(component)) > contactTolerance) return null;
      }
      const delta = new THREE.Vector3();
      delta.setComponent(
        moveAxis,
        movingPoint
          ? crossing.getComponent(moveAxis) - point.getComponent(moveAxis)
          : point.getComponent(moveAxis) - crossing.getComponent(moveAxis),
      );
      return delta;
    };

    for (const [targetId, view] of this.parts) {
      if (
        travelling.has(targetId) || !view.group.visible ||
        (movingRoot && movingRoot !== view.group && !!movingRoot.getObjectById(view.group.id))
      ) continue;
      const targetTriangles = this.worldTriangles(targetId);
      const targetPoints = new Map<string, THREE.Vector3>();
      const targetEdges = new Map<string, [THREE.Vector3, THREE.Vector3]>();
      collect(targetTriangles, targetPoints, targetEdges);
      // A box corner commonly meets the interior of a chamfered face rather
      // than one of that face's boundary edges. Solve the intersection along
      // the active movement axis so that contact is magnetic in 3D as well as
      // visible in the collision overlay.
      for (const point of pointMap.values()) {
        for (const vertices of targetTriangles) {
          if (++comparisons > 300000) break;
          const triangle = new THREE.Triangle(vertices[0], vertices[1], vertices[2]);
          if (allowed.length === 1) {
            const moveAxis = allowed[0];
            const normal = triangle.getNormal(new THREE.Vector3());
            const along = normal.getComponent(moveAxis);
            if (Math.abs(along) <= 1e-8) continue;
            const distance = normal.dot(point.clone().sub(vertices[0]));
            const amount = -distance / along;
            if (Math.abs(amount) > bestLength) continue;
            const contact = point.clone();
            contact.setComponent(moveAxis, contact.getComponent(moveAxis) + amount);
            if (!triangle.containsPoint(contact)) continue;
            const delta = new THREE.Vector3();
            delta.setComponent(moveAxis, amount);
            consider(delta);
          } else {
            const contact = triangle.closestPointToPoint(point, new THREE.Vector3());
            consider(contact.sub(point));
          }
        }
        if (comparisons > 300000) break;
      }
      for (const point of pointMap.values()) {
        for (const [a, b] of targetEdges.values()) {
          if (++comparisons > 300000) break;
          const delta = constrainedPointDelta(point, a, b, true);
          if (delta) consider(delta);
        }
        if (comparisons > 300000) break;
      }
      for (const point of targetPoints.values()) {
        for (const [a, b] of edgeMap.values()) {
          if (++comparisons > 300000) break;
          const delta = constrainedPointDelta(point, a, b, false);
          if (delta) consider(delta);
        }
        if (comparisons > 300000) break;
      }
      if (comparisons > 300000) break;
    }
    return best;
  }

  /** Produces snap targets from real axis-aligned surface triangles. Concave
   * and compound shapes can therefore expose recessed faces instead of being
   * represented by one oversized outer bounding box. */
  private surfaceSnapTargets(id: string, root: THREE.Object3D, moving: Bounds3): SnapTarget[] {
    root.updateWorldMatrix(true, true);
    const targets: SnapTarget[] = [];
    const points = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    root.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || !(child.geometry instanceof THREE.BufferGeometry)) return;
      const position = child.geometry.getAttribute("position");
      if (!position) return;
      const index = child.geometry.getIndex();
      const count = index ? index.count : position.count;
      for (let offset = 0; offset + 2 < count; offset += 3) {
        for (let corner = 0; corner < 3; corner++) {
          const vertexIndex = index ? index.getX(offset + corner) : offset + corner;
          points[corner].fromBufferAttribute(position, vertexIndex).applyMatrix4(child.matrixWorld);
        }
        for (let axis = 0; axis < 3; axis++) {
          const coordinates = points.map((point) => point.getComponent(axis));
          const planeMin = Math.min(...coordinates);
          const planeMax = Math.max(...coordinates);
          if (planeMax - planeMin > 0.03) continue;
          const others = [0, 1, 2].filter((value) => value !== axis);
          const mins = [0, 0, 0] as [number, number, number];
          const maxs = [0, 0, 0] as [number, number, number];
          for (let component = 0; component < 3; component++) {
            const values = points.map((point) => point.getComponent(component));
            mins[component] = Math.min(...values);
            maxs[component] = Math.max(...values);
          }
          const overlaps = others.every((component) =>
            Math.min(moving.max[component], maxs[component]) -
              Math.max(moving.min[component], mins[component]) > 0.01
          );
          if (!overlaps) continue;
          const plane = (planeMin + planeMax) / 2;
          mins[axis] = plane;
          maxs[axis] = plane;
          targets.push({ id, bounds: { min: mins, max: maxs } });
          break;
        }
      }
    });
    return targets;
  }

  /** Highlights the shared patch only for opposing min/max faces that truly
   * overlap across both remaining axes. Centre/edge guide alignment is not a
   * collision and deliberately gets no orange contact surface. */
  private showCollisionContacts(id: string, moving: Bounds3, snaps: import("../snapping/snap").ActiveSnap[]) {
    this.clearCollisionContacts();
    const axisIndex = { x: 0, y: 1, z: 2 } as const;
    const faceTargets = new Set<string>();
    const selectedRoot = this.assemblyGroups.get(id) ?? this.parts.get(id)?.group;
    const movingBox = new THREE.Box3(
      new THREE.Vector3(...moving.min),
      new THREE.Vector3(...moving.max),
    ).expandByScalar(0.08);
    // Smart Guides can align objects across empty space. They are useful for
    // positioning but are not collisions, so never let those distant snaps
    // create either a face patch or an edge marker.
    const contactSnaps = snaps.filter((snap) => {
      const target = this.parts.get(snap.targetId)?.group;
      return !!target && target.visible && movingBox.intersectsBox(new THREE.Box3().setFromObject(target));
    });
    for (const snap of contactSnaps) {
      const axis = axisIndex[snap.axis];
      const others = [0, 1, 2].filter((value) => value !== axis);
      // The selected object's contact may itself be a recessed/internal
      // surface, so the actual shared plane comes from the matched surface,
      // not necessarily from the selected object's outer min/max bounds.
      const plane = snap.value;
      const movingTriangles = this.planarContactTriangles(id, axis, plane);
      const targetTriangles = this.planarContactTriangles(snap.targetId, axis, plane);
      const vertices: number[] = [];
      for (const subject of movingTriangles) {
        for (const clip of targetTriangles) {
          const polygon = this.clipContactPolygon(subject, clip);
          for (let i = 1; i + 1 < polygon.length; i++) {
            for (const [a, b] of [polygon[0], polygon[i], polygon[i + 1]]) {
              const point = [0, 0, 0];
              point[axis] = plane;
              point[others[0]] = a;
              point[others[1]] = b;
              vertices.push(point[0], point[1], point[2]);
            }
          }
        }
      }
      // Never substitute the selected object's outer footprint when its real
      // mesh has no surface here. Concave objects can have a large empty area
      // inside their bounds; painting the target through that empty area is a
      // false collision. Both meshes must contribute overlapping triangles.
      if (!vertices.length) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
      const patch = new THREE.Mesh(geometry, this.collisionContactMaterial);
      patch.renderOrder = 10;
      patch.frustumCulled = false;
      this.collisionContacts.add(patch);
      faceTargets.add(snap.targetId);
    }
    // Edge contact is independent from axis-aligned snapping. A box can touch
    // a sloped face without producing any ActiveSnap at all, so also inspect
    // every visible object whose bounds are genuinely at the moving object.
    const edgeTargets = new Set(contactSnaps.map((snap) => snap.targetId));
    for (const [targetId, view] of this.parts) {
      if (targetId === id || !view.group.visible || selectedRoot?.getObjectById(view.group.id)) continue;
      if (movingBox.intersectsBox(new THREE.Box3().setFromObject(view.group))) edgeTargets.add(targetId);
    }
    for (const targetId of edgeTargets) {
      if (!faceTargets.has(targetId)) this.showMeshEdgeContacts(id, targetId);
    }
    if (this.collisionContacts.children.length) {
      this.collisionContactOwnerId = id;
      this.collisionContactCache.set(id, contactSnaps);
    }
  }

  /** Highlights real edge-to-face contact when there is no shared face area. */
  private showMeshEdgeContacts(id: string, targetId: string) {
    const movingTriangles = this.worldTriangles(id);
    const targetTriangles = this.worldTriangles(targetId);
    if (!movingTriangles.length || !targetTriangles.length) return;
    const tolerance = 0.06;
    const segments = new Map<string, [THREE.Vector3, THREE.Vector3]>();
    const points = new Map<string, THREE.Vector3>();
    let comparisons = 0;

    const inspectEdges = (source: THREE.Vector3[], target: THREE.Vector3[]) => {
      const triangle = new THREE.Triangle(target[0], target[1], target[2]);
      const normal = triangle.getNormal(new THREE.Vector3());
      if (normal.lengthSq() < 1e-10) return;
      for (let edge = 0; edge < 3; edge++) {
        const next = (edge + 1) % 3;
        const da = Math.abs(normal.dot(source[edge].clone().sub(target[0])));
        const db = Math.abs(normal.dot(source[next].clone().sub(target[0])));
        if (da <= tolerance && db <= tolerance) {
          const clipped = this.clipCoplanarEdgeToTriangle(source[edge], source[next], target, normal);
          if (!clipped) continue;
          const [a, b] = clipped;
          if (a.distanceToSquared(b) <= 0.0009) {
            points.set(this.contactPointKey(a), a);
            continue;
          }
          const keys = [this.contactPointKey(a), this.contactPointKey(b)].sort();
          segments.set(`${keys[0]}|${keys[1]}`, [a, b]);
        }
      }
    };

    for (const movingTriangle of movingTriangles) {
      const movingBox = new THREE.Box3().setFromPoints(movingTriangle).expandByScalar(tolerance);
      for (const targetTriangle of targetTriangles) {
        if (++comparisons > 250000) break;
        const targetBox = new THREE.Box3().setFromPoints(targetTriangle);
        if (!movingBox.intersectsBox(targetBox)) continue;
        inspectEdges(movingTriangle, targetTriangle);
        inspectEdges(targetTriangle, movingTriangle);
      }
      if (comparisons > 250000) break;
    }

    for (const [a, b] of segments.values()) {
      const direction = b.clone().sub(a);
      const length = direction.length();
      if (length <= 0.03) continue;
      const geometry = new THREE.CylinderGeometry(0.05, 0.05, length, 8);
      const marker = new THREE.Mesh(geometry, this.collisionContactMaterial);
      marker.position.copy(a).add(b).multiplyScalar(0.5);
      marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
      marker.renderOrder = 10;
      marker.frustumCulled = false;
      this.collisionContacts.add(marker);
    }
    if (!segments.size) {
      for (const point of points.values()) {
        const marker = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), this.collisionContactMaterial);
        marker.position.copy(point);
        marker.renderOrder = 10;
        marker.frustumCulled = false;
        this.collisionContacts.add(marker);
      }
    }
  }

  private contactPointKey(point: THREE.Vector3) {
    return [point.x, point.y, point.z].map((value) => Math.round(value / 0.05)).join(",");
  }

  /** Clips a coplanar 3D edge to a triangle by projecting onto the triangle's
   * strongest 2D plane. This finds partial edge contact, not just cases where
   * both original edge endpoints happen to fall inside one mesh triangle. */
  private clipCoplanarEdgeToTriangle(
    a: THREE.Vector3,
    b: THREE.Vector3,
    triangle: THREE.Vector3[],
    normal: THREE.Vector3,
  ): [THREE.Vector3, THREE.Vector3] | null {
    const absolute = [Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)];
    const drop = absolute.indexOf(Math.max(...absolute));
    const components = [0, 1, 2].filter((axis) => axis !== drop);
    const point2 = (point: THREE.Vector3): [number, number] => [
      point.getComponent(components[0]), point.getComponent(components[1]),
    ];
    const a2 = point2(a);
    const b2 = point2(b);
    const triangle2 = triangle.map(point2);
    const cross = (u: [number, number], v: [number, number]) => u[0] * v[1] - u[1] * v[0];
    const subtract = (u: [number, number], v: [number, number]): [number, number] => [u[0] - v[0], u[1] - v[1]];
    const parameters: number[] = [];
    const threeTriangle = new THREE.Triangle(triangle[0], triangle[1], triangle[2]);
    if (threeTriangle.containsPoint(a)) parameters.push(0);
    if (threeTriangle.containsPoint(b)) parameters.push(1);
    const direction = subtract(b2, a2);
    for (let index = 0; index < 3; index++) {
      const c = triangle2[index];
      const d = triangle2[(index + 1) % 3];
      const targetDirection = subtract(d, c);
      const denominator = cross(direction, targetDirection);
      if (Math.abs(denominator) <= 1e-9) continue;
      const offset = subtract(c, a2);
      const t = cross(offset, targetDirection) / denominator;
      const u = cross(offset, direction) / denominator;
      if (t >= -1e-6 && t <= 1 + 1e-6 && u >= -1e-6 && u <= 1 + 1e-6) {
        parameters.push(Math.max(0, Math.min(1, t)));
      }
    }
    if (!parameters.length) return null;
    parameters.sort((left, right) => left - right);
    const start = a.clone().lerp(b, parameters[0]);
    const end = a.clone().lerp(b, parameters[parameters.length - 1]);
    return [start, end];
  }

  private worldTriangles(id: string): THREE.Vector3[][] {
    const root = this.assemblyGroups.get(id) ?? this.parts.get(id)?.group;
    if (!root) return [];
    root.updateWorldMatrix(true, true);
    const triangles: THREE.Vector3[][] = [];
    root.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || !(child.geometry instanceof THREE.BufferGeometry)) return;
      const position = child.geometry.getAttribute("position");
      if (!position) return;
      const index = child.geometry.getIndex();
      const count = index ? index.count : position.count;
      for (let offset = 0; offset + 2 < count && triangles.length < 1500; offset += 3) {
        const triangle: THREE.Vector3[] = [];
        for (let corner = 0; corner < 3; corner++) {
          const vertexIndex = index ? index.getX(offset + corner) : offset + corner;
          triangle.push(new THREE.Vector3().fromBufferAttribute(position, vertexIndex).applyMatrix4(child.matrixWorld));
        }
        triangles.push(triangle);
      }
    });
    return triangles;
  }

  /** Actual coplanar mesh triangles at a contact plane, projected to 2D. */
  private planarContactTriangles(id: string, axis: number, plane: number): [number, number][][] {
    const root = this.assemblyGroups.get(id) ?? this.parts.get(id)?.group;
    if (!root) return [];
    root.updateWorldMatrix(true, true);
    const others = [0, 1, 2].filter((value) => value !== axis);
    const triangles: [number, number][][] = [];
    const points = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    root.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || !(child.geometry instanceof THREE.BufferGeometry)) return;
      const position = child.geometry.getAttribute("position");
      if (!position) return;
      const index = child.geometry.getIndex();
      const count = index ? index.count : position.count;
      for (let offset = 0; offset + 2 < count; offset += 3) {
        let coplanar = true;
        for (let corner = 0; corner < 3; corner++) {
          const vertexIndex = index ? index.getX(offset + corner) : offset + corner;
          points[corner].fromBufferAttribute(position, vertexIndex).applyMatrix4(child.matrixWorld);
          if (Math.abs(points[corner].getComponent(axis) - plane) > 0.03) coplanar = false;
        }
        if (!coplanar) continue;
        triangles.push(points.map((point) => [
          point.getComponent(others[0]), point.getComponent(others[1]),
        ] as [number, number]));
      }
    });
    return triangles;
  }

  /** Intersects one projected triangle with another (Sutherland-Hodgman). */
  private clipContactPolygon(subject: [number, number][], clip: [number, number][]) {
    let polygon = subject.map((point) => [...point] as [number, number]);
    const area = clip.reduce((sum, point, index) => {
      const next = clip[(index + 1) % clip.length];
      return sum + point[0] * next[1] - next[0] * point[1];
    }, 0);
    const orientation = area >= 0 ? 1 : -1;
    for (let edge = 0; edge < clip.length && polygon.length; edge++) {
      const a = clip[edge];
      const b = clip[(edge + 1) % clip.length];
      const input = polygon;
      polygon = [];
      const side = (point: [number, number]) => orientation * (
        (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0])
      );
      for (let i = 0; i < input.length; i++) {
        const current = input[i];
        const previous = input[(i + input.length - 1) % input.length];
        const currentSide = side(current);
        const previousSide = side(previous);
        if ((currentSide >= -1e-6) !== (previousSide >= -1e-6)) {
          const ratio = previousSide / (previousSide - currentSide);
          polygon.push([
            previous[0] + (current[0] - previous[0]) * ratio,
            previous[1] + (current[1] - previous[1]) * ratio,
          ]);
        }
        if (currentSide >= -1e-6) polygon.push(current);
      }
    }
    return polygon;
  }

  /** Rebuilds the display-only contact patches from the current scene when an
   * object is selected. This reads rendered bounds only and never asks the
   * geometry kernel to rebuild the shape. */
  private refreshSelectedCollisionContacts() {
    if (!this.showSelectedCollisionContacts) {
      this.clearCollisionContacts();
      return;
    }
    if (this.selectedIds.length !== 1) {
      this.clearCollisionContacts();
      return;
    }
    this.refreshCollisionContactsFor(this.selectedIds[0]);
  }

  private refreshCollisionContactsFor(
    id: string,
    activeSnaps: import("../snapping/snap").ActiveSnap[] = [],
  ) {
    const selected = this.assemblyGroups.get(id) ?? this.parts.get(id)?.group;
    if (!selected) {
      this.clearCollisionContacts();
      return;
    }
    const moving = this.boundsOf(selected);
    const axes = ["x", "y", "z"] as const;
    const cached = (this.collisionContactCache.get(id) ?? []).filter((contact) => {
      if (!this.parts.has(contact.targetId)) return false;
      const axis = { x: 0, y: 1, z: 2 }[contact.axis];
      const coordinate = contact.movingAnchor === "min"
        ? moving.min[axis]
        : contact.movingAnchor === "max"
          ? moving.max[axis]
          : (moving.min[axis] + moving.max[axis]) / 2;
      return Math.abs(coordinate - contact.value) <= 0.05;
    });
    if (!cached.length) this.collisionContactCache.delete(id);
    const contacts: import("../snapping/snap").ActiveSnap[] = [...cached, ...activeSnaps];
    const tolerance = 0.05;
    for (const [targetId, view] of this.parts) {
      if (targetId === id || !view.group.visible || selected.getObjectById(view.group.id)) continue;
      const targetBounds = this.boundsOf(view.group);
      const selectedSurfaces = this.surfaceSnapTargets(id, selected, targetBounds);
      const targetSurfaces = this.surfaceSnapTargets(targetId, view.group, moving);
      const targetBuckets = new Map<string, SnapTarget[]>();
      for (const surface of targetSurfaces) {
        const axis = [0, 1, 2].find((candidate) =>
          Math.abs(surface.bounds.max[candidate] - surface.bounds.min[candidate]) <= 1e-4
        );
        if (axis === undefined) continue;
        const plane = surface.bounds.min[axis];
        const key = `${axis}:${Math.round(plane / tolerance)}`;
        const bucket = targetBuckets.get(key) ?? [];
        bucket.push(surface);
        targetBuckets.set(key, bucket);
      }
      for (const surface of selectedSurfaces) {
        const axis = [0, 1, 2].find((candidate) =>
          Math.abs(surface.bounds.max[candidate] - surface.bounds.min[candidate]) <= 1e-4
        );
        if (axis === undefined) continue;
        const plane = surface.bounds.min[axis];
        const bucket = Math.round(plane / tolerance);
        for (const offset of [-1, 0, 1]) {
          for (const targetSurface of targetBuckets.get(`${axis}:${bucket + offset}`) ?? []) {
            const targetPlane = targetSurface.bounds.min[axis];
            if (Math.abs(plane - targetPlane) > tolerance) continue;
            contacts.push({
              axis: axes[axis], movingAnchor: "center", targetAnchor: "center",
              value: (plane + targetPlane) / 2, targetId,
              targetBounds: targetSurface.bounds,
            });
          }
        }
      }
      // Check every real target surface, not only the target's outermost box.
      // This is what lets selection rediscover a contact against the inside
      // wall of a concave/L-shaped or compound object.
      for (const surface of this.surfaceSnapTargets(targetId, view.group, moving)) {
        for (let axis = 0; axis < axes.length; axis++) {
          if (Math.abs(surface.bounds.max[axis] - surface.bounds.min[axis]) > 1e-4) continue;
          const plane = surface.bounds.min[axis];
          if (Math.abs(moving.min[axis] - plane) <= tolerance) {
            contacts.push({
              axis: axes[axis], movingAnchor: "min", targetAnchor: "max",
              value: plane, targetId, targetBounds: surface.bounds,
            });
          }
          if (Math.abs(moving.max[axis] - plane) <= tolerance) {
            contacts.push({
              axis: axes[axis], movingAnchor: "max", targetAnchor: "min",
              value: plane, targetId, targetBounds: surface.bounds,
            });
          }
          break;
        }
      }
      for (let axis = 0; axis < axes.length; axis++) {
        if (Math.abs(moving.min[axis] - targetBounds.max[axis]) <= tolerance) {
          contacts.push({
            axis: axes[axis], movingAnchor: "min", targetAnchor: "max",
            value: targetBounds.max[axis], targetId, targetBounds,
          });
        }
        if (Math.abs(moving.max[axis] - targetBounds.min[axis]) <= tolerance) {
          contacts.push({
            axis: axes[axis], movingAnchor: "max", targetAnchor: "min",
            value: targetBounds.min[axis], targetId, targetBounds,
          });
        }
        // A freshly pasted duplicate may sit exactly over its source. Its
        // corresponding outside faces are min-to-min and max-to-max rather
        // than opposing, but they are still genuine coincident surfaces.
        if (Math.abs(moving.min[axis] - targetBounds.min[axis]) <= tolerance) {
          contacts.push({
            axis: axes[axis], movingAnchor: "min", targetAnchor: "min",
            value: targetBounds.min[axis], targetId, targetBounds,
          });
        }
        if (Math.abs(moving.max[axis] - targetBounds.max[axis]) <= tolerance) {
          contacts.push({
            axis: axes[axis], movingAnchor: "max", targetAnchor: "max",
            value: targetBounds.max[axis], targetId, targetBounds,
          });
        }
      }
    }
    const unique = [...new Map(contacts.map((contact) => [
      `${contact.targetId}|${contact.axis}|${contact.movingAnchor}|${contact.targetAnchor}|${contact.value.toFixed(4)}`,
      contact,
    ])).values()];
    this.showCollisionContacts(id, moving, unique);
  }

  private clearCollisionContacts() {
    for (const child of [...this.collisionContacts.children]) {
      this.collisionContacts.remove(child);
      (child as THREE.Mesh).geometry.dispose();
    }
    this.collisionContactOwnerId = null;
  }

  private boundsOf(object: THREE.Object3D): Bounds3 {
    object.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(object);
    return {
      min: [box.min.x, box.min.y, box.min.z],
      max: [box.max.x, box.max.y, box.max.z],
    };
  }

  /** Converts a stable screen-space snap radius into world millimetres. */
  private worldSnapTolerance(at: THREE.Vector3): number {
    const height = Math.max(1, this.renderer.domElement.clientHeight);
    let worldHeight: number;
    if (this.camera instanceof THREE.PerspectiveCamera) {
      const distance = this.camera.position.distanceTo(at);
      worldHeight = 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * distance;
    } else {
      worldHeight = (this.camera.top - this.camera.bottom) / this.camera.zoom;
    }
    // A screen-only radius grows without limit when zooming out: eight
    // pixels could become tens of millimetres and pull in a distant object.
    // Keep the visual usability, but never magnetise across more than 2 mm.
    return Math.min(2, (worldHeight / height) * SNAP_TOLERANCE_PX);
  }

  private onModifierChange = (e: KeyboardEvent) => {
    this.altDown = e.altKey;
    // TransformControls performs its own axis-handle quantization, so its
    // snap value must also follow the temporary Alt bypass.
    this.gizmo.setTranslationSnap(this.gridSnapEnabled && !this.altDown ? 1 : null);
    if (this.altDown) {
      this.guides.clear();
      this.clearCollisionContacts();
    }
    if (this.toolMode === "build") this.updateCellCursor(e.altKey);
  };

  /** The view cube's square viewport, top-right corner, in CSS pixels
   *  (top-left origin, matching pointer events) — independent of the
   *  decorative navCubeFrame div, which CSS positions the same way. */
  private navRect() {
    const w = this.renderer.domElement.clientWidth;
    return { x: w - CUBE_PX - CUBE_MARGIN_PX, y: CUBE_MARGIN_PX, w: CUBE_PX, h: CUBE_PX };
  }

  /** `e`'s position as clip-space [-1, 1] coordinates within the view cube's
   *  own viewport, or null when it falls outside that corner entirely. */
  private navNdc(e: PointerEvent): { x: number; y: number } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const nav = this.navRect();
    const px = e.clientX - rect.left - nav.x;
    const py = e.clientY - rect.top - nav.y;
    if (px < 0 || py < 0 || px > nav.w || py > nav.h) return null;
    return { x: (px / nav.w) * 2 - 1, y: -(py / nav.h) * 2 + 1 };
  }

  /** Eases the camera around to look straight at `dir` (one of
   *  FACE_DIRECTIONS, world-space, from the target) along the shortest arc,
   *  at whatever distance/zoom it is already at — a click on the view cube. */
  private snapToDirection(dir: THREE.Vector3) {
    cancelAnimationFrame(this.navAnimFrame);
    const target = this.controls.target.clone();
    const distance = this.camera.position.distanceTo(target);
    const startDir = this.camera.position.clone().sub(target).normalize();
    const endDir = dir.clone().normalize();
    const rotation = new THREE.Quaternion().setFromUnitVectors(startDir, endDir);
    const duration = 350;
    const start = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / duration);
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const q = new THREE.Quaternion().slerp(rotation, eased);
      this.camera.position.copy(target).add(startDir.clone().applyQuaternion(q).multiplyScalar(distance));
      this.controls.update();
      if (t < 1) this.navAnimFrame = requestAnimationFrame(step);
    };
    step();
  }

  // ---- picking ------------------------------------------------------------

  private onPointerDown = (e: PointerEvent) => {
    // Only the left button ever selects/drags — right/middle are reserved
    // for orbit/pan and must never be misread as a click on release.
    if (e.button !== 0) return;
    this.downAt = { x: e.clientX, y: e.clientY };
    // Shape Builder owns every left click while it is running: the regions
    // are what is on screen, and selecting the (hidden) sources underneath
    // them would mean nothing.
    if (this.toolMode === "build" && this.cellViews.size) {
      this.cellPaint = !e.altKey;
      this.paintCell(e, this.cellPaint);
      return;
    }
    if (this.toolMode === "edge") {
      this.pickEdge(e);
      this.downAt = null;
      return;
    }
    if (this.toolMode === "place") {
      e.preventDefault();
      return;
    }
    // Whatever gesture starts here owns the pointer until it ends — none of
    // them re-run updateFaceHover while active (see its own guard), so any
    // highlight left over from before would otherwise just sit there stale
    // for the whole gesture. beginPushPullFromHover below re-raycasts fresh
    // regardless, so clearing this first is purely cosmetic, not load-bearing.
    this.clearFaceHover();

    const navNdc = this.navNdc(e);
    if (navNdc) {
      // A click vs. a drag is only distinguishable in onPointerUp/Move (see
      // the resize/align/body-drag patterns above) — start passive here,
      // same as everything else that begins on the canvas.
      const target = this.controls.target.clone();
      const quat = new THREE.Quaternion().setFromUnitVectors(this.camera.up, new THREE.Vector3(0, 1, 0));
      this.navDrag = {
        downScreen: { x: e.clientX, y: e.clientY },
        active: false,
        target,
        quat,
        quatInverse: quat.clone().invert(),
        startSpherical: new THREE.Spherical().setFromVector3(
          this.camera.position.clone().sub(target).applyQuaternion(quat),
        ),
      };
      this.downAt = null;
      return;
    }

    if (this.beginAlign(e)) {
      this.downAt = null;
      return;
    }
    // Before beginResize: the face arrows sit outside the bounds cage, but
    // an arrow near a corner could otherwise fall inside beginResize's own
    // screen-space grab radius and be swallowed by it.
    if (this.beginPushPull(e) || this.beginPushPullFromFace(e)) {
      this.downAt = null;
      return;
    }
    if (this.beginResize(e)) return;
    this.dimensionPinnedHandleIndex = -1;

    // A gizmo-handle drag claims the event first: its own pointerdown
    // listener is registered on this same canvas before this one, so by the
    // time this runs, gizmo.dragging already reflects whether the click hit
    // an arrow. Do not ALSO start a body-drag on top of that.
    if (this.showResult || this.gizmo.dragging) return;

    const hitId = this.hitTest(e);
    if (!hitId) {
      // Empty space: this might turn out to be a rubber-band select, once the
      // pointer clears the click threshold (see onPointerMove). If it never
      // does, onPointerUp's existing pick()-on-empty-space path (deselect)
      // still runs exactly as before.
      this.marquee = {
        downScreen: { x: e.clientX, y: e.clientY },
        active: false,
        additive: e.ctrlKey || e.metaKey || e.shiftKey,
      };
      return;
    }

    // Face mode owns face drags. If a curved/non-editable face was hit, leave
    // the object in place instead of silently changing the gesture into Move.
    if (this.toolMode === "face") return;

    const targetId = e.altKey ? hitId : this.findRootOwner(hitId);
    const targetObj = this.assemblyGroups.get(targetId) ?? this.parts.get(targetId)?.group;
    if (!targetObj) return;
    // Collision markers live in world space and belong to the object that
    // produced them. Remove the previous owner's markers as soon as another
    // object begins a gesture; waiting for React's selection round-trip lets
    // the old marker linger while the new object is already moving.
    if (this.collisionContactOwnerId && this.collisionContactOwnerId !== targetId) {
      this.clearCollisionContacts();
    }

    const planeZ = targetObj.position.z;
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -planeZ);
    const grabPoint = this.rayPlaneHit(e, plane);
    if (!grabPoint) return;

    this.grab = {
      id: targetId,
      downScreen: { x: e.clientX, y: e.clientY },
      active: false,
      plane,
      grabPoint,
      startPos: targetObj.position.clone(),
      items: (this.selectedIds.includes(targetId) ? this.selectedIds : [targetId]).map((gId) => {
        const isAssembly = this.assemblyGroups.has(gId);
        const obj = this.assemblyGroups.get(gId) ?? this.parts.get(gId)?.group;
        const v = this.parts.get(gId);
        return {
          id: gId,
          startGroupPos: obj?.position.clone() ?? new THREE.Vector3(),
          pivot: isAssembly ? new THREE.Vector3() : (v?.pivot.clone() ?? new THREE.Vector3()),
          rotation: obj?.rotation.clone() ?? new THREE.Euler(),
        };
      }),
    };
  };

  private pickEdge(e: PointerEvent) {
    const selectedIndex = this.selectedEdgeAtScreen(e);
    if (selectedIndex >= 0) {
      const selected = this.selectedEdges[selectedIndex];
      selected.line.removeFromParent();
      selected.line.geometry.dispose();
      selected.line.material.dispose();
      this.selectedEdges.splice(selectedIndex, 1);
      this.clearEdgeHover();
      this.onSelectEdges?.(
        this.selectedEdges[0]?.partId ?? null,
        this.selectedEdges.map((edge) => edge.point),
      );
      return;
    }
    const picked = this.edgeAt(e);
    if (!picked) return;
    const existing = this.selectedEdges.findIndex(
      (edge) => edge.partId === picked.id && edge.groupIndex === picked.groupIndex,
    );
    if (existing >= 0) {
      this.selectedEdges[existing].line.removeFromParent();
      this.selectedEdges[existing].line.geometry.dispose();
      this.selectedEdges[existing].line.material.dispose();
      this.selectedEdges.splice(existing, 1);
    } else {
      if (this.selectedEdges.length && this.selectedEdges[0].partId !== picked.id) this.clearEdgeSelection(false);
      const line = this.edgeLine(picked.view, picked.groupIndex, 0xff5b13);
      if (!line) return;
      this.selectedEdges.push({ partId: picked.id, groupIndex: picked.groupIndex, point: picked.point, line });
    }
    this.clearEdgeHover();
    this.onSelectObject?.(picked.id, false);
    this.onSelectEdges?.(
      this.selectedEdges[0]?.partId ?? null,
      this.selectedEdges.map((edge) => edge.point),
    );
  }

  /** The preview removes the original topological edge from the part mesh,
   * but its orange selection stroke remains visible. Hit-test that stroke in
   * screen space first so clicking it can still toggle the edge off. */
  private selectedEdgeAtScreen(e: PointerEvent): number {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    (this.raycaster.params as THREE.RaycasterParameters & { Line2?: { threshold: number } }).Line2 = {
      threshold: 1,
    };
    const renderedHit = this.raycaster.intersectObjects(
      this.selectedEdges.map((edge) => edge.line),
      false,
    )[0];
    if (renderedHit) {
      const index = this.selectedEdges.findIndex((edge) => edge.line === renderedHit.object);
      if (index >= 0) return index;
    }
    const distanceToSegment = (
      px: number, py: number,
      ax: number, ay: number,
      bx: number, by: number,
    ) => {
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared
        ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
        : 0;
      return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    };
    let nearest = -1;
    let nearestDistance = 11;
    for (let edgeIndex = 0; edgeIndex < this.selectedEdges.length; edgeIndex++) {
      const line = this.selectedEdges[edgeIndex].line;
      line.updateWorldMatrix(true, false);
      const starts = line.geometry.getAttribute("instanceStart");
      const ends = line.geometry.getAttribute("instanceEnd");
      if (!starts || !ends) continue;
      for (let segment = 0; segment < starts.count; segment++) {
        const start = new THREE.Vector3().fromBufferAttribute(starts, segment)
          .applyMatrix4(line.matrixWorld).project(this.camera);
        const end = new THREE.Vector3().fromBufferAttribute(ends, segment)
          .applyMatrix4(line.matrixWorld).project(this.camera);
        const ax = rect.left + (start.x + 1) * rect.width / 2;
        const ay = rect.top + (1 - start.y) * rect.height / 2;
        const bx = rect.left + (end.x + 1) * rect.width / 2;
        const by = rect.top + (1 - end.y) * rect.height / 2;
        const distance = distanceToSegment(e.clientX, e.clientY, ax, ay, bx, by);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = edgeIndex;
        }
      }
    }
    return nearest;
  }

  private edgeAt(e: PointerEvent): { id: string; view: PartView; groupIndex: number; point: Vec3 } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    this.raycaster.params.Line = { threshold: 0.8 };
    const wires: THREE.LineSegments[] = [];
    for (const [id, view] of this.parts) {
      if (!view.group.visible) continue; // hidden via the eye icon: not pickable
      view.wire.userData.partId = id;
      wires.push(view.wire);
    }
    const hit = this.raycaster.intersectObjects(wires, false)[0];
    if (!hit) return null;
    const id = hit.object.userData.partId as string;
    const view = this.parts.get(id);
    if (!view) return null;
    const groupIndex = getEdgeIndex(hit.index ?? 0, view.wire.geometry);
    const group = view.wire.geometry.groups[groupIndex];
    const positions = view.wire.geometry.getAttribute("position");
    if (!group || !positions) return null;
    let displayPoint: THREE.Vector3;
    if (group.count <= 2) {
      displayPoint = new THREE.Vector3(
        (positions.getX(group.start) + positions.getX(group.start + 1)) / 2,
        (positions.getY(group.start) + positions.getY(group.start + 1)) / 2,
        (positions.getZ(group.start) + positions.getZ(group.start + 1)) / 2,
      );
    } else {
      const middle = group.start + Math.min(group.count - 1, Math.floor(group.count / 2));
      displayPoint = new THREE.Vector3(positions.getX(middle), positions.getY(middle), positions.getZ(middle));
    }
    const local = displayPoint.add(view.pivot);
    return { id, view, groupIndex, point: [local.x, local.y, local.z] };
  }

  private edgeLine(view: PartView, groupIndex: number, color: number): LineSegments2 | null {
    const group = view.wire.geometry.groups[groupIndex];
    const positions = view.wire.geometry.getAttribute("position");
    if (!group || !positions) return null;
    const edgePositions = new Float32Array(group.count * 3);
    for (let i = 0; i < group.count; i++) {
      edgePositions[i * 3] = positions.getX(group.start + i);
      edgePositions[i * 3 + 1] = positions.getY(group.start + i);
      edgePositions[i * 3 + 2] = positions.getZ(group.start + i);
    }
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(edgePositions);
    const material = new LineMaterial({ color, linewidth: color === 0xff5b13 ? 4 : 3, depthTest: false });
    material.resolution.set(this.host.clientWidth, this.host.clientHeight);
    const line = new LineSegments2(geometry, material);
    line.renderOrder = 39;
    view.group.add(line);
    return line;
  }

  private clearEdgeHover() {
    if (!this.hoverEdgeLine) return;
    this.hoverEdgeLine.removeFromParent();
    this.hoverEdgeLine.geometry.dispose();
    this.hoverEdgeLine.material.dispose();
    this.hoverEdgeLine = null;
  }

  private clearEdgeSelection(report: boolean) {
    for (const edge of this.selectedEdges) {
      edge.line.removeFromParent();
      edge.line.geometry.dispose();
      (edge.line.material as THREE.Material).dispose();
    }
    this.selectedEdges = [];
    if (report) this.onSelectEdges?.(null, []);
  }

  clearSelectedEdges() {
    this.clearEdgeSelection(true);
  }

  /**
   * Click-and-drag an object's BODY to move it — TinkerCAD's primary way of
   * repositioning something, distinct from the gizmo's small arrow handles.
   * Slides the object under the cursor at constant height (X/Y only); lifting
   * it in Z is still the gizmo's job. Only engages once the pointer clears the
   * click threshold, so a plain click still falls through to pick() exactly
   * as before — this never changes what a non-dragging click does.
   */
  private onPointerMove = (e: PointerEvent) => {
    if (this.toolMode === "place") {
      this.updateFaceHover(e);
      this.updatePlacementPreview(e);
      return;
    }
    if (this.toolMode === "edge") {
      const picked = this.edgeAt(e);
      this.clearEdgeHover();
      if (picked && !this.selectedEdges.some((edge) => edge.partId === picked.id && edge.groupIndex === picked.groupIndex)) {
        const hover = this.edgeLine(picked.view, picked.groupIndex, 0xffb04a);
        if (hover) {
          this.hoverEdgeLine = hover;
        }
      }
      return;
    }
    if (this.toolMode === "build" && this.cellViews.size) {
      if (this.cellPaint !== null) {
        this.paintCell(e, this.cellPaint);
        return;
      }
      const mask = this.raycastCell(e);
      if (mask !== this.hoverCell) {
        this.hoverCell = mask;
        this.hoverGroup = new Set(mask === null ? [] : this.cellGroup(mask));
        this.applyCellMaterials();
      }
      this.cellCursorAt = { x: e.clientX, y: e.clientY };
      this.updateCellCursor(e.altKey);
      return;
    }
    if (this.pushPullDrag) {
      const drag = this.pushPullDrag;
      if (!this.facePushPullEnabled) {
        this.pushPullLabelEl.style.display = "none";
        return;
      }
      if (!drag.active) {
        if (Math.hypot(e.clientX - drag.downScreen.x, e.clientY - drag.downScreen.y) <= CLICK_SLOP_PX) {
          return;
        }
        drag.active = true;
        this.onDragChange?.(true);
      }
      const distance = this.pushPullDistance(e, drag);
      drag.currentDistance = distance;
      this.onPushPullDistanceChange?.(distance);
      // Immediate feedback: the arrow slides along the face's normal on every
      // frame with no debounce or lag. The mesh rebuild itself is throttled
      // live — every step is a real OCCT boolean — so it updates once, on
      // release, and the readout carries the value in the meantime.
      drag.handle.position.copy(drag.handleBasePosition).addScaledVector(drag.worldNormal, distance);
      this.pushPullLabelEl.style.display = "block";
      this.positionPushPullLabel(drag.handle.position, drag.worldNormal);
      // Not focused during a live drag (the mouse button is down over the
      // canvas, not this input) — just reflecting the value, same as before
      // this became a real <input>. blur() below only fires from an actual
      // focused edit, so this never races with commitPushPullInput().
      this.pushPullLabelEl.value = formatLength(distance, this.displayUnit, this.decimalPlaces);
      this.pushPullLabelEl.style.width = `${Math.max(4.2, this.pushPullLabelEl.value.length + 1.6)}ch`;

      // The actual shape, not just the arrow — throttled, since each sample
      // is a real kernel rebuild (see previewLocal's doc comment).
      const now = performance.now();
      if (this.onPreviewPushPull && now - drag.lastPreviewAt >= PUSH_PULL_PREVIEW_MS) {
        drag.lastPreviewAt = now;
        this.requestPushPullPreview(drag, distance);
      }
      return;
    }

    if (this.navDrag) {
      const d = this.navDrag;
      const dx = e.clientX - d.downScreen.x;
      const dy = e.clientY - d.downScreen.y;
      if (!d.active) {
        if (Math.hypot(dx, dy) <= CLICK_SLOP_PX) return;
        d.active = true;
        cancelAnimationFrame(this.navAnimFrame); // a drag interrupts any in-flight snap
      }
      // Same up-agnostic spherical math OrbitControls itself uses to turn a
      // screen-space drag into an orbit — see NavDrag's quat/quatInverse.
      const h = this.renderer.domElement.clientHeight;
      const theta = d.startSpherical.theta - (2 * Math.PI * dx) / h;
      const phi = THREE.MathUtils.clamp(d.startSpherical.phi - (2 * Math.PI * dy) / h, 1e-3, Math.PI - 1e-3);
      const offset = new THREE.Vector3()
        .setFromSpherical(new THREE.Spherical(d.startSpherical.radius, phi, theta))
        .applyQuaternion(d.quatInverse);
      this.camera.position.copy(d.target).add(offset);
      this.controls.update();
      return;
    }

    if (this.resizeDrag) {
      this.updateScaleHint(e);
      const d = Math.hypot(e.clientX - this.resizeDrag.centreX, e.clientY - this.resizeDrag.centreY);
      const ratio = d / this.resizeDrag.startDistance;
      const factors: Vec3 = [1, 1, 1];
      // Shift flips whichever way proportions currently lock, for exactly
      // the length of the drag — free resize for a quick one-off uniform
      // scale without unlocking the padlock, or the reverse when it is
      // already unlocked. Never mutates resizeConstrained itself, so it
      // reverts the instant the key is released or the drag ends.
      const constrainedNow = e.shiftKey ? !this.resizeConstrained : this.resizeConstrained;

      if (constrainedNow) {
        factors[0] = Math.max(0.01, ratio);
        factors[1] = Math.max(0.01, ratio);
        factors[2] = Math.max(0.01, ratio);
      } else if (this.resizeDrag.lockAspectXY) {
        // When triangle angles are locked, preserve them by scaling uniformly in XY.
        if (this.resizeDrag.axis === 2) {
          factors[2] = Math.max(0.01, ratio);
        } else {
          const uniformRatio = Math.max(0.01, ratio);
          factors[0] = uniformRatio;
          factors[1] = uniformRatio;
        }
      } else if (this.resizeDrag.cornerSigns) {
        // Resolve the pointer movement into the selected object's projected
        // local X/Y axes. This lets an unlocked corner follow an asymmetric
        // drag instead of collapsing both dimensions into one radial ratio.
        const dx = e.clientX - this.resizeDrag.startX;
        const dy = e.clientY - this.resizeDrag.startY;
        const [xx, xy] = this.resizeDrag.basisX;
        const [yx, yy] = this.resizeDrag.basisY;
        const determinant = xx * yy - xy * yx;
        if (Math.abs(determinant) > 1e-6) {
          const worldX = (dx * yy - dy * yx) / determinant;
          const worldY = (dy * xx - dx * xy) / determinant;
          const nextX = Math.max(0.01, this.resizeDrag.startSize[0] + 2 * worldX * this.resizeDrag.cornerSigns[0]);
          const nextY = Math.max(0.01, this.resizeDrag.startSize[1] + 2 * worldY * this.resizeDrag.cornerSigns[1]);
          factors[0] = Math.max(0.01, nextX / this.resizeDrag.startSize[0]);
          factors[1] = Math.max(0.01, nextY / this.resizeDrag.startSize[1]);
          factors[2] = 1;
        }
      } else if (this.resizeDrag.axis !== null) {
        const axis = this.resizeDrag.axis;
        // A face handle changes its axis by an absolute world distance. Using
        // the radial ratio above makes recovery from a very thin dimension
        // depend on multiplying that tiny size (1 mm -> 20 mm needs an
        // enormous 20x radial drag). Projecting pointer travel onto the
        // selected local axis gives the same mm-per-pixel response whether
        // the part starts 1 mm or 100 mm thick.
        const basis = axis === 0
          ? this.resizeDrag.basisX
          : axis === 1
            ? this.resizeDrag.basisY
            : this.resizeDrag.basisZ;
        const dx = e.clientX - this.resizeDrag.startX;
        const dy = e.clientY - this.resizeDrag.startY;
        const basisLengthSq = basis[0] * basis[0] + basis[1] * basis[1];
        if (basisLengthSq > 1e-6) {
          const travelled = (dx * basis[0] + dy * basis[1]) / basisLengthSq;
          const startLength = Math.max(
            0.01,
            this.resizeDrag.rawSize[axis] * this.resizeDrag.startScale[axis],
          );
          const nextLength = Math.max(
            0.01,
            startLength + travelled * this.resizeDrag.handleSigns[axis],
          );
          factors[axis] = nextLength / startLength;
        }
      } else {
        factors[0] = Math.max(0.01, ratio);
        factors[1] = Math.max(0.01, ratio);
        factors[2] = Math.max(0.01, ratio);
      }

      if (this.resizeDrag.targets.length > 1) {
        for (const target of this.resizeDrag.targets) {
          const targetView = this.parts.get(target.id);
          const targetScale: Vec3 = [
            Math.max(0.01, target.startScale[0] * factors[0]),
            Math.max(0.01, target.startScale[1] * factors[1]),
            Math.max(0.01, target.startScale[2] * factors[2]),
          ];
          const targetPosition: Vec3 = [
            this.resizeDrag.startBoxCentre.x + (target.startPosition[0] - this.resizeDrag.startBoxCentre.x) * factors[0],
            this.resizeDrag.startBoxCentre.y + (target.startPosition[1] - this.resizeDrag.startBoxCentre.y) * factors[1],
            this.resizeDrag.startBoxCentre.z + (target.startPosition[2] - this.resizeDrag.startBoxCentre.z) * factors[2],
          ];
          if (targetView) {
            targetView.group.scale.fromArray(targetScale);
            const offset = new THREE.Vector3(
              targetPosition[0] - target.startPosition[0],
              targetPosition[1] - target.startPosition[1],
              targetPosition[2] - target.startPosition[2],
            );
            targetView.group.position.copy(target.startGroupPosition).add(offset);
          }
          this.onTransformObject?.(target.id, { scale: targetScale, position: targetPosition });
        }
      } else {
        const scale = [...this.resizeDrag.startScale] as Vec3;
        for (let i = 0; i < 3; i++) scale[i] = Math.max(0.01, this.resizeDrag.startScale[i] * factors[i]);
        const view = this.parts.get(this.resizeDrag.id);
        const localShift = new THREE.Vector3();
        // Alt held: keep the object's own centre fixed instead of the
        // opposite handle — every axis grows/shrinks symmetrically about
        // where it already is, rather than anchoring on whichever corner
        // or face is diagonally/directly opposite the one being dragged.
        // A zero shift IS "scale from centre": the shift below exists
        // specifically to slide the centre so the OPPOSITE handle stays
        // put, so skipping it is the whole change.
        if (!e.altKey) {
          for (let i = 0; i < 3; i++) {
            localShift.setComponent(
              i,
              this.resizeDrag.handleSigns[i] * this.resizeDrag.rawSize[i] *
                (scale[i] - this.resizeDrag.startScale[i]) / 2,
            );
          }
        }
        const worldShift = localShift.applyQuaternion(this.resizeDrag.rotation);
        const position: Vec3 = [
          this.resizeDrag.startPosition[0] + worldShift.x,
          this.resizeDrag.startPosition[1] + worldShift.y,
          this.resizeDrag.startPosition[2] + worldShift.z,
        ];
        if (view) {
          view.group.scale.fromArray(scale);
          view.group.position.copy(this.resizeDrag.startGroupPosition).add(worldShift);
        }
        this.onTransformObject?.(this.resizeDrag.id, { scale, position });
      }
      this.updateResizeOverlay();
      return;
    }

    if (this.marquee) {
      this.updateMarquee(e);
      return;
    }

    const g = this.grab;
    if (!g) {
      this.updateFaceHover(e);
      this.updateResizeHover(e);
      this.updateAlignHover(e);
      return;
    }

    if (!g.active) {
      if (Math.hypot(e.clientX - g.downScreen.x, e.clientY - g.downScreen.y) <= CLICK_SLOP_PX) {
        return;
      }
      g.active = true;
      // Adobe-style alt-drag: the object under the cursor is left in place
      // and a copy of it is what actually gets dragged. onDragChange fires
      // FIRST so the duplication and the drag that follows land in the same
      // undo batch — one alt-drag, one undo step, exactly like an ordinary
      // move. this.selectedIds is set directly (not through onSelectObject)
      // so the new id reads as selected immediately, without waiting for a
      // render round-trip back through setPlacements().
      const source = e.altKey ? this.parts.get(g.id) : undefined;
      const copyId = source ? this.onDuplicateObject?.(g.id) : null;
      if (source && copyId) {
        this.onDragChange?.(true);
        this.parts.set(copyId, this.cloneView(source));
        g.id = copyId;
        this.selectedIds = [copyId];
        this.applyMaterials();
      } else {
        if (g.items.length <= 1) {
          this.onSelectObject?.(g.id, false);
        }
        this.onDragChange?.(true);
      }
      // Measure from where THIS drag began — after the alt-drag branch above,
      // so a duplicate measures from its own start rather than the original's.
      this.beginMoveReadout(g.id, g.startPos);
    }

    const hit = this.rayPlaneHit(e, g.plane);
    if (!hit) return;

    // Adobe-style shift-constrain: lock the body-drag (plain move, or an
    // alt-drag copy — this runs after that branch has already retargeted
    // g.id) to the nearest horizontal/vertical/45° line through its start
    // point, exactly like Illustrator. Smart-snap sits back down for the
    // rest of the drag once shift releases.
    let dx = hit.x - g.grabPoint.x;
    let dy = hit.y - g.grabPoint.y;
    if (e.shiftKey) {
      const step = Math.PI / 4;
      const angle = Math.round(Math.atan2(dy, dx) / step) * step;
      const dist = Math.hypot(dx, dy);
      dx = Math.cos(angle) * dist;
      dy = Math.sin(angle) * dist;
    }

    // Grid and object snapping are independent. Grid snapping quantizes the
    // lead object's origin first; Smart Guides may then align it to a nearby
    // object's edge. Alt bypasses both for one precise free drag.
    const leadForGrid = g.items.find((item) => item.id === g.id);
    if (this.gridSnapEnabled && !this.altDown && leadForGrid) {
      dx = Math.round(leadForGrid.startGroupPos.x + dx) - leadForGrid.startGroupPos.x;
      dy = Math.round(leadForGrid.startGroupPos.y + dy) - leadForGrid.startGroupPos.y;
    }

    // Snap is resolved once, on the object under the cursor, and the answer
    // becomes part of the delta every item moves by. Snapping inside the loop
    // moved only that one object, so the selection quietly deformed as the
    // guides engaged and released — the object under the cursor jiggling
    // against companions that glided straight past.
    let snap: Vec3 = [0, 0, 0];
    const leadItem = g.items.find((item) => item.id === g.id);
    const leadObj = leadItem && (this.assemblyGroups.get(leadItem.id) ?? this.parts.get(leadItem.id)?.group);
    if (leadItem && leadObj) {
      leadObj.position.set(
        leadItem.startGroupPos.x + dx,
        leadItem.startGroupPos.y + dy,
        leadItem.startGroupPos.z,
      );
      leadObj.updateWorldMatrix(true, true);
      snap = this.applySmartSnap(g.id, leadObj);
    }

    for (const item of g.items) {
      const obj = this.assemblyGroups.get(item.id) ?? this.parts.get(item.id)?.group;
      if (!obj) continue;
      obj.position.set(
        item.startGroupPos.x + dx + snap[0],
        item.startGroupPos.y + dy + snap[1],
        item.startGroupPos.z + snap[2],
      );
      obj.updateWorldMatrix(true, true);
      const isAssembly = this.assemblyGroups.has(item.id);
      const rotatedPivot = isAssembly ? new THREE.Vector3() : item.pivot.clone().applyEuler(obj.rotation);
      this.onTransformObject?.(item.id, {
        position: [
          obj.position.x - rotatedPivot.x,
          obj.position.y - rotatedPivot.y,
          obj.position.z - rotatedPivot.z,
        ],
      });
    }
    this.updateResizeOverlay();
  };

  private onPointerUp = (e: PointerEvent) => {
    const down = this.downAt;
    this.downAt = null;
    if (!this.showSelectedCollisionContacts || !this.collisionContactOwnerId || !this.selectedIds.includes(this.collisionContactOwnerId)) {
      this.clearCollisionContacts();
    }

    if (this.alignPointDrag) {
      this.finishAlignPointDrag();
      return;
    }

    // The region click was already handled on pointerdown. Selection is
    // resolved here, though, so without this the same click would also pick
    // the (hidden) source underneath and change what the session is building.
    if (this.toolMode === "build" && this.cellViews.size) {
      this.cellPaint = null;
      return;
    }

    if (this.pushPullDrag) {
      const drag = this.pushPullDrag;
      this.pushPullDrag = null;
      this.controls.enabled = true;
      this.gizmo.enabled = true;
      if (drag.ephemeral) {
        this.pushPullHandles.remove(drag.handle);
        disposeArrow(drag.handle);
      } else {
        drag.handle.position.copy(drag.handleBasePosition);
      }
      const distance = drag.active ? this.pushPullDistance(e, drag) : 0;
      drag.currentDistance = distance;
      if (drag.active) {
        // A drag is a complete gesture: commit on release. Previously it
        // left a focused pending editor over live preview geometry. Starting
        // another drag blurred that editor and raced its old rebuild against
        // the new gesture, which made the second drag appear frozen.
        this.pushPullGeneration++;
        this.pushPullPending = null;
        this.pushPullLabelEl.style.display = "none";
        this.onDragChange?.(false);
        this.disposeGeom(drag.originalGeom);
        const travelled = this.toLocalDistance(distance, drag.worldPerLocal);
        this.armedFace = {
          id: drag.id,
          localPoint: [
            drag.localPoint[0] + drag.localNormal[0] * travelled,
            drag.localPoint[1] + drag.localNormal[1] * travelled,
            drag.localPoint[2] + drag.localNormal[2] * travelled,
          ],
          localNormal: drag.localNormal,
          view: drag.view,
          worldPerLocal: drag.worldPerLocal,
        };
        void this.applyPushPull(drag, distance);
      } else {
        // A click, unlike a drag, means the user wants exact numeric entry.
        this.showPushPullInput(drag, 0);
      }
      return;
    }

    if (this.navDrag) {
      const wasClick = !this.navDrag.active;
      this.navDrag = null;
      if (wasClick) {
        const ndc = this.navNdc(e);
        const hit = ndc && this.navCube.hitTest(ndc.x, ndc.y);
        if (hit) this.snapToDirection(hit.dir);
      }
      return;
    }

    if (this.resizeDrag) {
      const drag = this.resizeDrag;
      const wasClick = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) <= CLICK_SLOP_PX;
      this.resizeDrag = null;
      this.controls.enabled = true;
      this.gizmo.enabled = true;
      this.onDragChange?.(false);
      if (wasClick) {
        this.dimensionPinnedHandleIndex = drag.handleIndex;
        this.updateDimensionVisibility(drag.handleIndex);
        // A side handle unambiguously owns one dimension, so take the user
        // straight into typing. Corner handles expose all three values and
        // leave focus alone so the user can choose which one to edit.
        if (drag.axis !== null) {
          const input = this.dimensionInputs[drag.axis];
          requestAnimationFrame(() => {
            input.focus();
            input.select();
          });
        }
      } else {
        this.dimensionPinnedHandleIndex = -1;
        this.updateDimensionVisibility(this.resizeHoverIndex);
      }
      this.scaleHintEl.style.display = "none";
      return;
    }

    const m = this.marquee;
    this.marquee = null;
    if (m) {
      if (m.active) {
        this.finishMarquee(e, m);
        this.marqueeEl.style.display = "none";
        return; // a rubber-band select happened; this was not a click.
      }
      // Never activated (pointer stayed within the click threshold) — fall
      // through to the normal empty-space click below, unchanged.
    }

    const g = this.grab;
    this.grab = null;
    if (g?.active) {
      this.guides.clear();
      this.onDragChange?.(false);
      return; // a body-drag happened; this was not a click.
    }

    if (!down || this.gizmo.dragging) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP_PX) return;
    if (this.toolMode === "place") {
      this.placeAt(e);
      return;
    }
    // Only the face tool turns a click into a face pick. Under the select
    // tool a click on an object is just a click on the OBJECT — which is
    // what makes plain dragging reliably move things.
    if (this.toolMode === "face" && !(e.ctrlKey || e.metaKey || e.shiftKey) && this.selectFaceAt(e)) return;
    this.pick(e, e.ctrlKey || e.metaKey || e.shiftKey);
  };

  private beginResize(e: PointerEvent): boolean {
    if (!this.resizeHandles.visible || this.selectedIds.length === 0) return false;
    const rect = this.renderer.domElement.getBoundingClientRect();
    // Screen-space hit testing keeps the grab target comfortably clickable at
    // every zoom level; raycasting a tiny 3D cube made near-edge clicks fall
    // through to the object's body drag.
    let nearest = Infinity;
    let nearestIndex = -1;
    for (let i = 0; i < this.resizeHandleMeshes.length; i++) {
      const handle = this.resizeHandleMeshes[i];
      const p = handle.position.clone().project(this.camera);
      const x = rect.left + ((p.x + 1) / 2) * rect.width;
      const y = rect.top + ((1 - p.y) / 2) * rect.height;
      const distance = Math.hypot(e.clientX - x, e.clientY - y);
      if (distance < nearest) {
        nearest = distance;
        nearestIndex = i;
      }
    }
    if (nearest > 16) return false;

    const selectedViews = this.selectedIds
      .map((id) => ({ id, view: this.parts.get(id), node: findNode(this.lastNodes, id) }))
      .filter((item): item is { id: string; view: PartView; node: SceneNode } => !!item.view && !!item.node && item.view.group.visible);
    if (!selectedViews.length) return false;

    const box = new THREE.Box3();
    for (const { view } of selectedViews) {
      view.group.updateWorldMatrix(true, true);
      box.expandByObject(view.group);
    }
    const worldCentre = box.getCenter(new THREE.Vector3());
    const project = (point: THREE.Vector3): [number, number] => {
      const p = point.project(this.camera);
      return [
        rect.left + ((p.x + 1) / 2) * rect.width,
        rect.top + ((1 - p.y) / 2) * rect.height,
      ];
    };
    const [centreX, centreY] = project(worldCentre.clone());
    const first = selectedViews[0];
    const quaternion = first.view.group.getWorldQuaternion(new THREE.Quaternion());
    const invQuat = quaternion.clone().invert();
    const [xPixelX, xPixelY] = project(worldCentre.clone().add(new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion)));
    const [yPixelX, yPixelY] = project(worldCentre.clone().add(new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion)));
    const [zPixelX, zPixelY] = project(worldCentre.clone().add(new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion)));

    let localAxis: 0 | 1 | 2 | null = null;
    let handleSigns: Vec3 = [0, 0, 0];
    let cornerSigns: [number, number] | null = null;

    if (nearestIndex < 8) {
      const worldSignX = nearestIndex >= 4 ? 1 : -1;
      const worldSignY = Math.floor(nearestIndex / 2) % 2 ? 1 : -1;
      const worldSignZ = nearestIndex % 2 ? 1 : -1;
      const localCorner = new THREE.Vector3(worldSignX, worldSignY, worldSignZ).applyQuaternion(invQuat);
      handleSigns = [
        Math.sign(localCorner.x) || (worldSignX as 1 | -1),
        Math.sign(localCorner.y) || (worldSignY as 1 | -1),
        Math.sign(localCorner.z) || (worldSignZ as 1 | -1),
      ];
      cornerSigns = [handleSigns[0], handleSigns[1]];
    } else {
      const worldDir = new THREE.Vector3(
        nearestIndex === 8 ? -1 : nearestIndex === 9 ? 1 : 0,
        nearestIndex === 10 ? -1 : nearestIndex === 11 ? 1 : 0,
        nearestIndex === 12 ? -1 : nearestIndex === 13 ? 1 : 0,
      );
      const localDir = worldDir.clone().applyQuaternion(invQuat);
      const ax = Math.abs(localDir.x);
      const ay = Math.abs(localDir.y);
      const az = Math.abs(localDir.z);
      if (ax >= ay && ax >= az) {
        localAxis = 0;
        handleSigns[0] = Math.sign(localDir.x) || 1;
      } else if (ay >= ax && ay >= az) {
        localAxis = 1;
        handleSigns[1] = Math.sign(localDir.y) || 1;
      } else {
        localAxis = 2;
        handleSigns[2] = Math.sign(localDir.z) || 1;
      }
    }

    const targets: ResizeTarget[] = selectedViews.map(({ id, view, node }) => {
      view.mesh.geometry.computeBoundingBox();
      const rawSize = (view.mesh.geometry.boundingBox?.getSize(new THREE.Vector3()) ?? new THREE.Vector3(1, 1, 1)).toArray() as Vec3;
      return {
        id,
        startScale: [...node.scale] as Vec3,
        startPosition: [...node.position] as Vec3,
        startGroupPosition: view.group.position.clone(),
        rawSize,
        rotation: view.group.getWorldQuaternion(new THREE.Quaternion()),
      };
    });
    first.view.mesh.geometry.computeBoundingBox();
    const rawSize = (first.view.mesh.geometry.boundingBox?.getSize(new THREE.Vector3()) ?? new THREE.Vector3(1, 1, 1)).toArray() as Vec3;

    const lockAspectXY = selectedViews.some(
      ({ node }) =>
        node.type === "object" &&
        node.kind === "triangle" &&
        !!(node.params.lockAngleLeft || node.params.lockAngleRight || node.params.lockAngleApex),
    );

    this.resizeDrag = {
      id: first.id,
      targets,
      startScale: [...first.node.scale] as Vec3,
      axis: localAxis,
      lockAspectXY,
      centreX,
      centreY,
      startDistance: Math.max(1, Math.hypot(e.clientX - centreX, e.clientY - centreY)),
      startX: e.clientX,
      startY: e.clientY,
      startSize: box.getSize(new THREE.Vector3()).toArray() as Vec3,
      startBoxCentre: worldCentre,
      cornerSigns,
      basisX: [xPixelX - centreX, xPixelY - centreY],
      basisY: [yPixelX - centreX, yPixelY - centreY],
      basisZ: [zPixelX - centreX, zPixelY - centreY],
      startPosition: [...first.node.position] as Vec3,
      startGroupPosition: first.view.group.position.clone(),
      rawSize,
      handleSigns,
      rotation: quaternion,
      handleIndex: nearestIndex,
    };
    this.updateDimensionVisibility(nearestIndex);
    this.controls.enabled = false;
    this.gizmo.enabled = false;
    this.onDragChange?.(true);
    this.scaleHintEl.style.display = "flex";
    this.updateScaleHint(e);
    e.preventDefault();
    return true;
  }

  /** Grows the rectangle live and, past the click threshold, shows it. */
  private updateMarquee(e: PointerEvent) {
    const m = this.marquee;
    if (!m) return;
    if (
      !m.active &&
      Math.hypot(e.clientX - m.downScreen.x, e.clientY - m.downScreen.y) <= CLICK_SLOP_PX
    ) {
      return;
    }
    m.active = true;

    const hostRect = this.host.getBoundingClientRect();
    const x0 = m.downScreen.x - hostRect.left;
    const y0 = m.downScreen.y - hostRect.top;
    const x1 = e.clientX - hostRect.left;
    const y1 = e.clientY - hostRect.top;

    this.marqueeEl.style.display = "block";
    this.marqueeEl.style.left = `${Math.min(x0, x1)}px`;
    this.marqueeEl.style.top = `${Math.min(y0, y1)}px`;
    this.marqueeEl.style.width = `${Math.abs(x1 - x0)}px`;
    this.marqueeEl.style.height = `${Math.abs(y1 - y0)}px`;
  }

  /**
   * Selects every visible part whose screen-space bounds land FULLY inside
   * the drawn rectangle — "dragging a rectangle around the objects", per
   * TinkerCAD's own description, i.e. containment rather than mere overlap.
   */
  private finishMarquee(e: PointerEvent, m: Marquee) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const rx0 = Math.min(m.downScreen.x, e.clientX) - rect.left;
    const ry0 = Math.min(m.downScreen.y, e.clientY) - rect.top;
    const rx1 = Math.max(m.downScreen.x, e.clientX) - rect.left;
    const ry1 = Math.max(m.downScreen.y, e.clientY) - rect.top;

    const caught: string[] = [];
    for (const [id, view] of this.parts) {
      if (!view.group.visible) continue;
      const b = this.screenBoundsOf(view, rect);
      if (!b) continue;
      if (b.minX >= rx0 && b.maxX <= rx1 && b.minY >= ry0 && b.maxY <= ry1) caught.push(id);
    }
    this.onSelectMany?.(caught, m.additive);
  }

  /**
   * Tight screen-space (canvas-relative pixel) bounding box of a part, by
   * projecting every vertex of its ACTUAL mesh rather than its 3D AABB's 8
   * corners. The AABB approach undercounted nothing geometrically, but for
   * any round or tapered shape it is a real over-estimate on screen: a
   * cone's box is exactly as wide as its base circle, so the box's corners
   * sit out past the visible edge by a factor of √2 — measured on a typical
   * cone, that inflated the required marquee by 83px horizontally and 55px
   * vertically beyond what was actually visible, so a rectangle drawn
   * snugly around the rendered shape (the natural thing to do) failed the
   * containment test. Only run at marquee-release, not per frame, so
   * walking every vertex (a few thousand, even for a sphere) costs nothing
   * noticeable.
   */
  private screenBoundsOf(
    view: PartView,
    rect: DOMRect,
  ): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const pos = view.mesh.geometry.attributes.position;
    const m = view.group.matrixWorld;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const v = new THREE.Vector3();

    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m).project(this.camera);
      // Behind the camera: this vertex has no meaningful screen position.
      if (v.z > 1) return null;
      const px = ((v.x + 1) / 2) * rect.width;
      const py = ((1 - v.y) / 2) * rect.height;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    return { minX, minY, maxX, maxY };
  }

  private pick(e: PointerEvent, additive: boolean) {
    if (this.showResult) return;
    const hitId = this.hitTest(e);
    const rootId = hitId && !e.altKey ? this.findRootOwner(hitId) : hitId;
    if (!additive && this.collisionContactOwnerId !== rootId) {
      this.clearCollisionContacts();
    }
    this.onSelectObject?.(rootId, additive);
    // React records the click selection asynchronously. Refresh from the
    // object that was actually picked on the following frame, rather than
    // relying on the previous selectedIds value during this pointer event.
    if (rootId && !additive && this.showSelectedCollisionContacts) {
      requestAnimationFrame(() => this.refreshCollisionContactsFor(rootId));
    }
  }

  private hitTest(e: { clientX: number; clientY: number }): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    // A hidden object's mesh is still in this.parts (see applyMaterials) —
    // only Group.visible says it is not there. THREE.Raycaster does not
    // check that on its own, so without this an object hidden via the eye
    // icon would stay clickable and draggable while invisible.
    const targets = [...this.parts.values()].filter((v) => v.group.visible).map((v) => v.mesh);
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    if (!hit) return null;
    for (const [id, view] of this.parts) {
      if (view.mesh === hit.object) return id;
    }
    return null;
  }

  private rayPlaneHit(
    e: { clientX: number; clientY: number },
    plane: THREE.Plane,
  ): THREE.Vector3 | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(plane, out) ? out : null;
  }

  // ---- camera -----------------------------------------------------------

  /**
   * TinkerCAD's scheme: left click selects/drags, right-drag orbits,
   * middle-drag pans, wheel zooms (wheel is wired into OrbitControls
   * already and is unaffected by this remap). Reapplied after
   * setCameraMode() swaps in a fresh OrbitControls instance, which would
   * otherwise reset to three.js's own default (left=rotate, right=pan).
   */
  private applyControlBindings() {
    this.controls.mouseButtons = {
      LEFT: null,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.ROTATE,
    };
  }

  private onContextMenu = (e: MouseEvent) => e.preventDefault();

  /**
   * TransformControls has no concept of "ignore this button" — it hit-tests
   * and starts dragging a handle for ANY pointer button. Without this, a
   * right-click that happens to land on a gizmo arrow would try to drag it
   * instead of orbiting, which is exactly backwards from TinkerCAD's "right
   * mouse always orbits, everywhere" behaviour. Disabling the gizmo here
   * runs before its own pointerdown handler ever sees the event (ancestor
   * capture-phase always precedes the target phase, independent of
   * registration order), so it never starts a drag in the first place.
   */
  private onGlobalPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) this.gizmo.enabled = false;
  };

  private onGlobalPointerUp = () => {
    this.gizmo.enabled = true;
  };

  private cameraSaveTimeout: ReturnType<typeof setTimeout> | null = null;

  private onCameraChange = () => {
    if (this.cameraSaveTimeout) clearTimeout(this.cameraSaveTimeout);
    this.cameraSaveTimeout = setTimeout(() => {
      this.saveCameraNow();
    }, 200);
  };

  private onBeforeUnload = () => {
    this.saveCameraNow();
  };

  private saveCameraNow() {
    const mode: CameraMode = this.camera instanceof THREE.OrthographicCamera ? "orthographic" : "perspective";
    const pos = this.camera.position;
    const tgt = this.controls.target;
    const roundCoord = (n: number) => Math.round(n * 100) / 100;
    saveCameraState({
      mode,
      position: [roundCoord(pos.x), roundCoord(pos.y), roundCoord(pos.z)],
      target: [roundCoord(tgt.x), roundCoord(tgt.y), roundCoord(tgt.z)],
      zoom: this.camera.zoom !== 1 ? this.camera.zoom : undefined,
    });
  }

  setCameraMode(mode: CameraMode) {
    const isOrtho = this.camera instanceof THREE.OrthographicCamera;
    if ((mode === "orthographic") === isOrtho) return;

    const target = this.controls.target.clone();
    const position = this.camera.position.clone();
    const distance = position.distanceTo(target);

    let next: THREE.PerspectiveCamera | THREE.OrthographicCamera;
    if (mode === "orthographic") {
      const halfH = Math.tan(THREE.MathUtils.degToRad(45 / 2)) * distance;
      const halfW = halfH * this.aspect();
      next = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, 5000);
    } else {
      next = this.makePerspective();
    }
    next.up.set(0, 0, 1);
    next.position.copy(position);
    next.lookAt(target);

    this.controls.removeEventListener("change", this.onCameraChange);
    this.controls.dispose();
    this.camera = next;
    this.controls = new OrbitControls(next, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.applyControlBindings();
    this.controls.target.copy(target);
    this.controls.update();
    this.controls.addEventListener("change", this.onCameraChange);
    this.gizmo.camera = next;
    this.saveCameraNow();
  }

  // ---- loop -------------------------------------------------------------

  /**
   * Checked every frame rather than driven by a ResizeObserver: the canvas can
   * be created while the container is still zero-sized (hidden pane, layout not
   * settled), and a one-shot observer reading that initial zero never corrects
   * itself. This is cheap and self-healing.
   */
  private syncSize() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    const canvas = this.renderer.domElement;
    if (canvas.clientWidth === w && canvas.clientHeight === h) return;

    this.renderer.setSize(w, h);
    for (const edge of this.selectedEdges) edge.line.material.resolution.set(w, h);
    this.hoverEdgeLine?.material.resolution.set(w, h);
    if (this.camera instanceof THREE.PerspectiveCamera) {
      this.camera.aspect = w / h;
    } else {
      const halfH = (this.camera.top - this.camera.bottom) / 2;
      const halfW = halfH * (w / h);
      this.camera.left = -halfW;
      this.camera.right = halfW;
    }
    this.camera.updateProjectionMatrix();
  }

  /**
   * Tells the app which face is selected, when that changes.
   *
   * Driven from the frame loop with change detection rather than from each
   * assignment site: this.selectedFace is set and cleared from a dozen places
   * (a click, a push/pull starting, the selection changing, a rebuild
   * dropping the part), and any one of them left unhooked would strand the
   * app on a face the user can no longer see.
   */
  private lastFaceKey: string | null = null;
  private emitFaceSelection() {
    const selected = this.selectedFace;
    const view = selected ? this.parts.get(selected.partId) : undefined;
    const face = selected && view ? view.faces?.[selected.groupIndex] : undefined;
    const id = face ? selected!.partId : null;
    const point = face?.point ?? null;
    // Deliberately NOT cleared just because selectedFace went null: applying
    // an edit clears that, and the bar is still pointed at the same face.
    const key = id && point ? `${id}|${point.join(",")}` : null;
    if (key === this.lastFaceKey) return;
    this.lastFaceKey = key;
    this.onSelectFace?.(
      id,
      point,
      face?.normal ?? null,
      id && view && face ? this.sizeAcross(view, face.normal) : 0,
      face?.boundaryEdges ?? [],
    );
  }

  /** How thick the part is across a face, in world millimetres: its whole
   *  extent along that face's normal. This is the number the Size field
   *  edits — "make this dimension 40" — as opposed to push/pull's "move this
   *  face by 40". */
  private sizeAcross(view: PartView, normal: Vec3): number {
    const axis = this.kernelNormalToWorld(view, normal);
    const geometry = view.mesh.geometry as THREE.BufferGeometry;
    const position = geometry.getAttribute("position");
    if (!position) return 0;
    view.group.updateWorldMatrix(true, true);
    const point = new THREE.Vector3();
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < position.count; i++) {
      point.fromBufferAttribute(position, i).applyMatrix4(view.group.matrixWorld);
      const along = point.dot(axis);
      if (along < min) min = along;
      if (along > max) max = along;
    }
    return Number.isFinite(min) && Number.isFinite(max) ? max - min : 0;
  }

  private animate = () => {
    this.frame = requestAnimationFrame(this.animate);
    this.renderFrame();
  };

  /** One frame, independent of rAF. rAF is suspended whenever the page is not
   *  being composited, so this is also the hook for headless verification. */
  renderFrame() {
    this.syncSize();
    this.controls.update();
    this.updateResizeOverlay();
    this.updateAlignOverlay();
    this.updatePushPullOverlay();
    this.emitFaceSelection();
    this.updateMoveReadout();
    this.renderer.render(this.scene, this.camera);
    this.renderer.autoClear = false;
    this.renderer.clearDepth();
    this.renderer.render(this.gizmoScene, this.camera);
    this.renderer.autoClear = true;
    this.renderNavCube();
  }

  /** Draws the view cube into its own small corner viewport of this same
   *  canvas, after the main render — a separate WebGL context/canvas would
   *  cost a whole extra renderer for one small overlay. Always mirrors
   *  whichever direction the main camera is currently looking from. */
  private renderNavCube() {
    const offsetDir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.navCube.syncOrientation(offsetDir, this.camera.up);

    const w = this.renderer.domElement.clientWidth;
    const h = this.renderer.domElement.clientHeight;
    const nav = this.navRect();
    // WebGL's viewport/scissor origin is bottom-left; navRect() is top-left
    // (CSS/pointer-event space), so the y coordinate flips here.
    const glY = h - nav.y - nav.h;
    this.renderer.setScissorTest(true);
    this.renderer.setScissor(nav.x, glY, nav.w, nav.h);
    this.renderer.setViewport(nav.x, glY, nav.w, nav.h);
    this.renderer.render(this.navCube.scene, this.navCube.camera);
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, w, h);
  }

  /** Canvas backing-store size, for tests and diagnostics. */
  get canvasSize(): [number, number] {
    return [this.renderer.domElement.width, this.renderer.domElement.height];
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    // Appended to the host, so it outlives the renderer unless removed here —
    // in dev that leaves one orphan badge behind on every remount.
    this.cellCursorEl.remove();
    cancelAnimationFrame(this.navAnimFrame);
    this.navCube.dispose();
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.removeEventListener("pointermove", this.onPointerMove);
    this.renderer.domElement.removeEventListener("pointerup", this.onPointerUp);
    this.renderer.domElement.removeEventListener("contextmenu", this.onContextMenu);
    this.host.removeEventListener("pointerdown", this.onGlobalPointerDown, { capture: true });
    this.host.removeEventListener("pointerup", this.onGlobalPointerUp, { capture: true });
    window.removeEventListener("keydown", this.onModifierChange);
    window.removeEventListener("keyup", this.onModifierChange);
    this.gizmo.removeEventListener("dragging-changed", this.onDraggingChanged);
    this.gizmo.removeEventListener("objectChange", this.onGizmoChange);
    this.gizmo.dispose();
    this.controls.removeEventListener("change", this.onCameraChange);
    window.removeEventListener("beforeunload", this.onBeforeUnload);
    if (this.cameraSaveTimeout) clearTimeout(this.cameraSaveTimeout);
    this.saveCameraNow();
    this.controls.dispose();
    this.guides.dispose();
    this.clearCollisionContacts();
    this.collisionContactMaterial.dispose();
    this.alignHandleMeshes[0]?.geometry.dispose();
    for (const handle of this.alignHandleMeshes) (handle.material as THREE.Material).dispose();
    this.alignDragArrow.line.geometry.dispose();
    (this.alignDragArrow.line.material as THREE.Material).dispose();
    this.alignDragArrow.cone.geometry.dispose();
    (this.alignDragArrow.cone.material as THREE.Material).dispose();
    for (const handle of this.pushPullHandleMeshes) disposeArrow(handle);
    this.renderer.dispose();
    for (const input of this.dimensionInputs) input.remove();
    for (const pill of this.movePills) pill.remove();
    for (const pill of this.dimensionPills) pill.remove();
    for (const badge of this.cornerBadges) badge.remove();
    this.scaleHintEl.remove();
    this.moveGuide.geometry.dispose();
    (this.moveGuide.material as THREE.Material).dispose();
    this.dimensionEdges.geometry.dispose();
    (this.dimensionEdges.material as THREE.Material).dispose();
    for (const mat of this.solidMaterialCache.values()) mat.dispose();
    this.solidMaterialCache.clear();
    this.host.removeChild(this.renderer.domElement);
    this.host.removeChild(this.marqueeEl);
    this.host.removeChild(this.navCubeFrame);
    this.host.removeChild(this.pushPullLabelEl);
  }
}
