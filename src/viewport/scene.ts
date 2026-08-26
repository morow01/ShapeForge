import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { clearHighlights, getFaceIndex, highlightInGeometry, syncGeometries } from "replicad-threejs-helper";
import type { ReplicadMesh, ThreeGeometry } from "replicad-threejs-helper";
import type { FaceInfo, KernelMesh, ScenePart } from "../kernel/types";
import type { SceneNode, Vec3 } from "../document/types";
import { snapBounds } from "../snapping/snap";
import type { Bounds3, SnapTarget } from "../snapping/snap";
import { SmartGuides } from "./guides";
import { CUBE_MARGIN_PX, CUBE_PX, NavCube } from "./navcube";

export type CameraMode = "perspective" | "orthographic";
export type ToolMode = "select" | "move" | "rotate" | "align";
type AlignAxis = 0 | 1 | 2;
type AlignAnchor = "min" | "center" | "max";

/** How far the pointer may move between down and up and still count as a click
 *  rather than an orbit drag. */
const CLICK_SLOP_PX = 4;
const SNAP_TOLERANCE_PX = 10;
const DEG = Math.PI / 180;

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
}

interface ResizeDrag {
  id: string;
  startScale: Vec3;
  axis: 0 | 1 | 2 | null;
  centreX: number;
  centreY: number;
  startDistance: number;
  startX: number;
  startY: number;
  startSize: Vec3;
  cornerSigns: [number, number] | null;
  basisX: [number, number];
  basisY: [number, number];
  startPosition: Vec3;
  startGroupPosition: THREE.Vector3;
  rawSize: Vec3;
  handleSigns: Vec3;
  rotation: THREE.Quaternion;
}

interface PartView {
  group: THREE.Group;
  mesh: THREE.Mesh;
  wire: THREE.LineSegments;
  geom: ThreeGeometry[];
  /** Centre of the kernel geometry before it is shifted around the visual
   * pivot. Document positions still refer to the kernel's original origin. */
  pivot: THREE.Vector3;
  isHole: boolean;
  /** Planar faces, in the kernel's ORIGINAL (pre-pivot-shift) local frame —
   *  see kernelLocalPoint(). Undefined for a part with no OCCT topology. */
  faces?: FaceInfo[];
}

const MATERIALS = {
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
  // Material index 1 on every part's geometry (see applyMaterials) — painted
  // over whichever face group is currently hovered/clicked, Shapr3D-style.
  // Flat, unlit red so it reads clearly against both the translucent hole
  // material and the opaque solid one.
  faceHighlight: new THREE.MeshBasicMaterial({ color: 0xff3b30 }),
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
      ? mesh.faces.vertices
      : Float32Array.from(mesh.faces.vertices);
  const triangles =
    mesh.faces.triangles instanceof Uint32Array
      ? mesh.faces.triangles
      : Uint32Array.from(mesh.faces.triangles);
  faces.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
  faces.setIndex(new THREE.BufferAttribute(triangles, 1));

  if (mesh.faces.normals.length) {
    const normals =
      mesh.faces.normals instanceof Float32Array
        ? mesh.faces.normals
        : Float32Array.from(mesh.faces.normals);
    faces.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  } else {
    faces.computeVertexNormals();
  }
  for (const group of mesh.faces.faceGroups) faces.addGroup(group.start, group.count, 0);
  faces.computeBoundingBox();

  const lines = new THREE.BufferGeometry();
  lines.setAttribute("position", new THREE.BufferAttribute(new Float32Array(), 3));
  return [{ faces, lines }];
}

/** One push/pull grip: a stubby arrow (shaft + cone) built pointing along
 *  +Y, so a single setFromUnitVectors aims it down any face normal. Drawn
 *  without depth testing so a face's own arrow is never buried in it. */
function makeArrow(): THREE.Object3D {
  const material = new THREE.MeshBasicMaterial({ color: 0x1c9e8e, depthTest: false });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.7, 10), material);
  shaft.position.y = 0.35;
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.42, 12), material);
  head.position.y = 0.9;
  const group = new THREE.Group();
  group.add(shaft, head);
  group.renderOrder = 26;
  shaft.renderOrder = 26;
  head.renderOrder = 26;
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
  private host: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  private controls: OrbitControls;
  private gizmo: TransformControls;
  private resizeBox = new THREE.Box3Helper(new THREE.Box3(), 0x00a9b7);
  private resizeHandles = new THREE.Group();
  private resizeHandleMeshes: THREE.Mesh[] = [];
  private alignBox = new THREE.Box3Helper(new THREE.Box3(), 0x00a9b7);
  private alignHandles = new THREE.Group();
  private alignHandleMeshes: THREE.Mesh[] = [];
  /** One arrow per planar face of the single selected part — push/pull. */
  private pushPullHandles = new THREE.Group();
  private pushPullHandleMeshes: THREE.Object3D[] = [];
  /** id+face-count the handle pool was last built for, so it is only rebuilt
   *  when that actually changes (every other frame just repositions them). */
  private pushPullPoolKey = "";
  private pushPullDrag: PushPullDrag | null = null;
  /** The live push/pull readout — a real input, not just a label, so a plain
   *  click on a face (no drag) can show it ready to type an exact distance
   *  into, the same way the resize handles' dimension inputs work. See
   *  showPushPullInput()/commitPushPullInput(). */
  private pushPullLabelEl: HTMLInputElement;
  /** What the typed-input pill would apply to, while it's open — set by
   *  showPushPullInput(), read by commitPushPullInput(), cleared once it
   *  closes (blur/Enter/Escape or a new drag starting elsewhere). */
  private pushPullPending: { id: string; localPoint: Vec3; localNormal: Vec3 } | null = null;
  /** Whichever face the pointer is directly over right now — Shapr3D-style
   *  hover, independent of object selection: any face of any visible part,
   *  planar or curved, not just the arrows on a pre-selected object's own
   *  faces. Painted via faceHighlight (material index 1, see applyMaterials)
   *  on the group getFaceIndex() resolves the hit triangle to. */
  private hoverFace: { view: PartView; groupIndex: number } | null = null;
  private dimensionInputs: HTMLInputElement[] = [];
  private resizeDrag: ResizeDrag | null = null;
  private resizeConstrained = true;
  private toolMode: ToolMode = "select";
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private downAt: { x: number; y: number } | null = null;
  private frame = 0;
  private altDown = false;
  private guides = new SmartGuides();

  private parts = new Map<string, PartView>();
  private resultView: PartView | null = null;
  private showResult = false;
  private selectedIds: string[] = [];
  /** Most recent nodes passed to setPlacements, so a part that is (re)created
   *  by setParts — which runs on its own async schedule from the kernel and
   *  has no node data of its own — can be placed correctly the moment it
   *  exists, instead of sitting at the origin until some unrelated state
   *  change happens to call setPlacements again. */
  private lastNodes: SceneNode[] = [];
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

  onSelectObject: ((id: string | null, additive: boolean) => void) | null = null;
  /** Marquee release: every id whose screen-space bounds landed fully inside
   *  the drawn rectangle, in no particular order. */
  onSelectMany: ((ids: string[], additive: boolean) => void) | null = null;
  onTransformObject:
    | ((id: string, patch: { position?: Vec3; rotation?: Vec3; scale?: Vec3 }) => void)
    | null = null;
  onAlignObjects: ((updates: { id: string; position: Vec3 }[]) => void) | null = null;
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
    | ((id: string, op: { point: Vec3; normal: Vec3; distance: number }) => void)
    | null = null;

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
    this.pushPullLabelEl = document.createElement("input");
    this.pushPullLabelEl.type = "number";
    this.pushPullLabelEl.step = "0.5";
    this.pushPullLabelEl.title = "Push/pull distance in millimetres";
    this.pushPullLabelEl.setAttribute("aria-label", "Push/pull distance in millimetres");
    this.pushPullLabelEl.style.cssText =
      "position:absolute;display:none;z-index:30;width:70px;transform:translate(-50%,-130%);" +
      "padding:5px 6px;border:1px solid #00a9b7;border-radius:10px;background:white;" +
      "color:#25313b;font:600 12px system-ui,sans-serif;text-align:center;" +
      "box-shadow:0 2px 7px rgba(0,0,0,.14);";
    this.pushPullLabelEl.addEventListener("focus", () => this.onDragChange?.(true));
    this.pushPullLabelEl.addEventListener("blur", () => this.commitPushPullInput());
    this.pushPullLabelEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter") this.pushPullLabelEl.blur();
      else if (event.key === "Escape") {
        this.pushPullPending = null; // Escape abandons the edit — see commitPushPullInput()
        this.pushPullLabelEl.blur();
      }
    });
    host.appendChild(this.pushPullLabelEl);

    this.setupResizeOverlay();
    this.setupAlignOverlay();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xedf1f4);

    this.camera = this.makePerspective();
    this.camera.position.set(70, -70, 55);
    this.camera.up.set(0, 0, 1);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.applyControlBindings();

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setTranslationSnap(1); // 1 mm
    this.gizmo.setRotationSnap(15 * DEG);
    this.gizmo.addEventListener("dragging-changed", this.onDraggingChanged);
    this.gizmo.addEventListener("objectChange", this.onGizmoChange);
    this.scene.add(this.gizmo.getHelper());
    this.scene.add(this.guides.group);
    this.scene.add(this.resizeBox, this.resizeHandles, this.alignBox, this.alignHandles);
    this.scene.add(this.pushPullHandles);

    this.addLights();
    this.addGrid();

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

  private addGrid() {
    // 10 mm cells over a 200 mm bed.
    const grid = new THREE.GridHelper(200, 20, 0xaebac2, 0xd8e0e5);
    grid.rotation.x = Math.PI / 2;
    this.scene.add(grid);
    this.scene.add(new THREE.AxesHelper(25));
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
      handle.renderOrder = 21;
      this.resizeHandles.add(handle);
      this.resizeHandleMeshes.push(handle);
    }
    this.resizeHandles.visible = false;

    for (const axis of ["Width", "Depth", "Height"]) {
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0.01";
      input.step = "0.1";
      input.title = `${axis} in millimetres`;
      input.setAttribute("aria-label", `${axis} in millimetres`);
      input.style.cssText =
        "position:absolute;display:none;z-index:30;width:64px;padding:5px 6px;" +
        "border:1px solid #00a9b7;border-radius:5px;background:white;color:#25313b;" +
        "font:12px system-ui;text-align:center;box-shadow:0 2px 7px rgba(0,0,0,.14);";
      input.addEventListener("focus", () => this.onDragChange?.(true));
      input.addEventListener("blur", () => {
        this.applyTypedDimension(input);
        this.onDragChange?.(false);
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          input.blur();
        }
      });
      this.host.appendChild(input);
      this.dimensionInputs.push(input);
    }
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
    for (let axis = 0; axis < 3; axis++) {
      for (const anchor of ["min", "center", "max"] as AlignAnchor[]) {
        const handle = new THREE.Mesh(
          geometry,
          new THREE.MeshBasicMaterial({
            color: anchor === "center" ? 0x222a30 : 0x87939a,
            depthTest: false,
          }),
        );
        handle.userData.alignAxis = axis;
        handle.userData.alignAnchor = anchor;
        handle.renderOrder = 25;
        this.alignHandles.add(handle);
        this.alignHandleMeshes.push(handle);
      }
    }
    this.alignHandles.visible = false;
  }

  setResizeConstrained(value: boolean) {
    this.resizeConstrained = value;
  }

  // ---- parts ------------------------------------------------------------

  private makeView(mesh: KernelMesh, isHole: boolean, faces?: FaceInfo[]): PartView {
    const geom = syncKernelGeometry(mesh);
    const pivot = this.centreGeometry(geom);
    const group = new THREE.Group();
    const m = new THREE.Mesh(geom[0].faces, [isHole ? MATERIALS.hole : MATERIALS.solid, MATERIALS.faceHighlight]);
    const wire = new THREE.LineSegments(
      geom[0].lines,
      new THREE.LineBasicMaterial({ color: 0x38505f, transparent: true, opacity: 0.7 }),
    );
    group.add(m, wire);
    this.scene.add(group);
    return { group, mesh: m, wire, geom, pivot, isHole, faces };
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
    const mesh = new THREE.Mesh(faces, source.mesh.material);
    const wire = new THREE.LineSegments(lines, source.wire.material);
    const group = new THREE.Group();
    group.position.copy(source.group.position);
    group.rotation.copy(source.group.rotation);
    group.scale.copy(source.group.scale);
    group.add(mesh, wire);
    this.scene.add(group);
    return { group, mesh, wire, geom, pivot: source.pivot.clone(), isHole: source.isHole };
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
        existing.geom = syncKernelGeometry(part.mesh, existing.geom);
        existing.pivot = this.centreGeometry(existing.geom);
        existing.mesh.geometry = existing.geom[0].faces;
        existing.wire.geometry = existing.geom[0].lines;
        existing.isHole = part.isHole;
        existing.faces = part.faces;
      } else {
        this.parts.set(part.id, this.makeView(part.mesh, part.isHole, part.faces));
      }
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
  }

  /** Cheap: placement and selection only, no kernel involvement. */
  setPlacements(objects: SceneNode[], selectedIds: string[]) {
    this.lastNodes = objects;
    this.selectedIds = selectedIds;
    this.applyPlacements();
    this.applyMaterials();
    this.attachGizmo();
  }

  private applyPlacements() {
    for (const o of this.lastNodes) {
      const view = this.parts.get(o.id);
      if (!view) continue;
      // Skip the part being dragged, so the drag is not fighting React state.
      if (this.gizmo.dragging && this.gizmo.object === view.group) continue;
      if (this.grab?.active && this.grab.id === o.id) continue;
      view.group.rotation.set(o.rotation[0] * DEG, o.rotation[1] * DEG, o.rotation[2] * DEG);
      view.group.scale.fromArray(o.scale);
      const rotatedPivot = view.pivot.clone().applyEuler(view.group.rotation);
      view.group.position.set(
        o.position[0] + rotatedPivot.x,
        o.position[1] + rotatedPivot.y,
        o.position[2] + rotatedPivot.z,
      );
      view.isHole = o.isHole;
    }
  }

  private applyMaterials() {
    for (const [id, view] of this.parts) {
      const sel = this.selectedIds.includes(id);
      // Index 1 (faceHighlight) is picked per-triangle-group by the geometry's
      // own .groups, set via highlightFace()/clearFaceHover() below — this
      // array is what makes that actually render as anything other than the
      // base material (a BufferGeometry's .groups are ignored entirely unless
      // .material is an array).
      if (view.isHole) {
        view.mesh.material = [sel ? MATERIALS.holeSelected : MATERIALS.hole, MATERIALS.faceHighlight];
        // Draw after opaque solids while still respecting their depth.
        view.mesh.renderOrder = 1;
      } else {
        view.mesh.material = [sel ? MATERIALS.solidSelected : MATERIALS.solid, MATERIALS.faceHighlight];
        view.mesh.renderOrder = 0;
      }
      view.group.visible = !this.showResult;
    }
    if (this.resultView) this.resultView.group.visible = this.showResult;
    this.updateResizeOverlay();
    this.updateAlignOverlay();
    this.updatePushPullOverlay();
  }

  /** Draws a TinkerCAD-style bounds cage, eight corner handles, and editable
   * world-size readouts around the one actively selected object. */
  private updateResizeOverlay() {
    const id = this.selectedIds.length === 1 ? this.selectedIds[0] : null;
    const view = id ? this.parts.get(id) : undefined;
    const node = id ? this.lastNodes.find((n) => n.id === id) : undefined;
    const visible =
      this.toolMode === "select" && !!view && !!node && !this.showResult && view.group.visible;
    this.resizeBox.visible = visible;
    this.resizeHandles.visible = visible;
    for (const input of this.dimensionInputs) input.style.display = visible ? "block" : "none";
    if (!visible || !view || !node) return;

    view.group.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(view.group);
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
    const handleSize = Math.max(0.6, this.worldSnapTolerance(centre) * 0.9);
    for (const handle of this.resizeHandleMeshes) handle.scale.setScalar(handleSize);

    const size = box.getSize(new THREE.Vector3());
    const labelPoints = [
      new THREE.Vector3(centre.x, min.y, min.z),
      new THREE.Vector3(max.x, centre.y, min.z),
      new THREE.Vector3(max.x, max.y, centre.z),
    ];
    const rect = this.renderer.domElement.getBoundingClientRect();
    const values = [size.x, size.y, size.z];
    for (let i = 0; i < this.dimensionInputs.length; i++) {
      const p = labelPoints[i].project(this.camera);
      const input = this.dimensionInputs[i];
      if (document.activeElement !== input) input.value = values[i].toFixed(2);
      input.dataset.nodeId = node.id;
      input.dataset.currentSize = String(values[i]);
      input.style.left = `${((p.x + 1) / 2) * rect.width}px`;
      input.style.top = `${((1 - p.y) / 2) * rect.height}px`;
      input.style.transform =
        i === 0 ? "translate(-50%, 12px)" : i === 1 ? "translate(12px, 4px)" : "translate(12px, -50%)";
    }
  }

  /** Combined multi-selection cage with TinkerCAD-style min/centre/max dots. */
  private updateAlignOverlay() {
    const views = this.selectedIds
      .map((id) => this.parts.get(id))
      .filter((view): view is PartView => !!view && view.group.visible);
    const visible = this.toolMode === "align" && views.length >= 2 && !this.showResult;
    this.alignBox.visible = visible;
    this.alignHandles.visible = visible;
    if (!visible) return;

    const box = new THREE.Box3();
    for (const view of views) {
      view.group.updateWorldMatrix(true, true);
      box.expandByObject(view.group);
    }
    this.alignBox.box.copy(box);
    this.alignBox.updateMatrixWorld(true);

    const centre = box.getCenter(new THREE.Vector3());
    const offset = Math.max(2, this.worldSnapTolerance(centre) * 3.2);
    const anchors = (min: number, mid: number, max: number) => [min, mid, max];
    const xs = anchors(box.min.x, centre.x, box.max.x);
    const ys = anchors(box.min.y, centre.y, box.max.y);
    const zs = anchors(box.min.z, centre.z, box.max.z);
    for (let i = 0; i < 3; i++) {
      this.alignHandleMeshes[i].position.set(xs[i], box.min.y - offset, box.min.z);
      this.alignHandleMeshes[3 + i].position.set(box.min.x - offset, ys[i], box.min.z);
      this.alignHandleMeshes[6 + i].position.set(box.max.x + offset, box.max.y, zs[i]);
    }
    const handleSize = Math.max(0.75, this.worldSnapTolerance(centre) * 1.05);
    for (const handle of this.alignHandleMeshes) handle.scale.setScalar(handleSize);
  }

  private beginAlign(e: PointerEvent): boolean {
    if (!this.alignHandles.visible) return false;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.alignHandleMeshes, false)[0]?.object as THREE.Mesh | undefined;
    if (!hit) return false;
    this.alignSelection(hit.userData.alignAxis as AlignAxis, hit.userData.alignAnchor as AlignAnchor);
    e.preventDefault();
    return true;
  }

  private alignSelection(axis: AlignAxis, anchor: AlignAnchor) {
    const selected = this.selectedIds
      .map((id) => ({ id, view: this.parts.get(id), node: this.lastNodes.find((n) => n.id === id) }))
      .filter((item): item is { id: string; view: PartView; node: SceneNode } => !!item.view && !!item.node);
    if (selected.length < 2) return;

    const boxes = selected.map(({ view }) => new THREE.Box3().setFromObject(view.group));
    const overall = boxes.reduce((all, box) => all.union(box.clone()), new THREE.Box3());
    const target = anchor === "min"
      ? overall.min.getComponent(axis)
      : anchor === "max"
        ? overall.max.getComponent(axis)
        : overall.getCenter(new THREE.Vector3()).getComponent(axis);

    const updates: { id: string; position: Vec3 }[] = [];
    selected.forEach(({ id, view, node }, index) => {
      const box = boxes[index];
      const current = anchor === "min"
        ? box.min.getComponent(axis)
        : anchor === "max"
          ? box.max.getComponent(axis)
          : box.getCenter(new THREE.Vector3()).getComponent(axis);
      const delta = target - current;
      if (Math.abs(delta) < 1e-9) return;
      const position = [...node.position] as Vec3;
      position[axis] += delta;
      view.group.position.setComponent(axis, view.group.position.getComponent(axis) + delta);
      updates.push({ id, position });
    });
    if (updates.length) this.onAlignObjects?.(updates);
    this.updateAlignOverlay();
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

  /** Rotation only — a normal must not pick up the group's translation. */
  private kernelNormalToWorld(view: PartView, n: Vec3): THREE.Vector3 {
    return new THREE.Vector3(n[0], n[1], n[2])
      .applyQuaternion(view.group.getWorldQuaternion(new THREE.Quaternion()))
      .normalize();
  }

  /**
   * One small arrow per planar face of the single selected part, sitting on
   * the face and pointing out along its normal — Shapr3D's push/pull grips.
   * Only in Select mode, and only for a part the kernel gave face topology
   * for (never an import — see faceInfoOf() in kernel/worker.ts).
   */
  private updatePushPullOverlay() {
    const id = this.selectedIds.length === 1 ? this.selectedIds[0] : null;
    const view = id ? this.parts.get(id) : undefined;
    const faces = view?.faces;
    const visible =
      this.toolMode === "select" && !!view && !!faces && faces.length > 0 && !this.showResult &&
      view.group.visible;
    this.pushPullHandles.visible = visible;
    if (!visible || !view || !faces) {
      this.pushPullPoolKey = "";
      return;
    }

    // Rebuilding the arrows every frame would churn geometry for nothing —
    // only their placement actually changes as the camera or object moves.
    const key = `${id}:${faces.length}`;
    if (this.pushPullPoolKey !== key) {
      this.rebuildPushPullPool(faces.length);
      this.pushPullPoolKey = key;
    }

    view.group.updateWorldMatrix(true, true);
    for (let i = 0; i < faces.length; i++) {
      const handle = this.pushPullHandleMeshes[i];
      const at = this.kernelLocalToWorld(view, faces[i].point);
      const normal = this.kernelNormalToWorld(view, faces[i].normal);
      // Keep a constant on-screen size, like the resize/align handles.
      const scale = Math.max(0.5, this.worldSnapTolerance(at) * 0.85);
      handle.position.copy(at).addScaledVector(normal, scale * 1.1);
      handle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
      handle.scale.setScalar(scale);
      handle.userData.faceIndex = i;
      handle.userData.partId = id;
    }
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
  private raycastFace(e: PointerEvent): { view: PartView; groupIndex: number } | null {
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
    return groupIndex < 0 ? null : { view, groupIndex };
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
      this.toolMode !== "select" || this.showResult || this.gizmo.dragging ||
      this.pushPullDrag || this.navDrag || this.resizeDrag ||
      this.grab?.active || this.marquee?.active
    ) {
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

    const at = this.kernelLocalToWorld(view, face.point);
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
    };
    this.controls.enabled = false;
    this.gizmo.enabled = false;
    e.preventDefault();
    return true;
  }

  /**
   * Path 2 of beginPushPull: a direct click-drag on whatever planar face is
   * currently hovered (see updateFaceHover), not just the small fixed arrow
   * updatePushPullOverlay places at the face centre — this is what lets a
   * drag started anywhere on the face itself work, Shapr3D-style.
   *
   * Deliberately still gated on the part already being selected, unlike
   * Shapr3D's own "one click on any face, selected or not" gesture: this
   * app's PRIMARY select-mode drag is click-and-drag-the-body-to-move-it (a
   * deliberately TinkerCAD-matched interaction from earlier in the project),
   * and a flat face is most of a typical primitive's clickable surface — if
   * a face-drag meant push/pull even before the object was selected, that
   * body-move gesture would be unreachable by dragging almost anywhere on
   * most shapes. Once an object IS selected, though, push/pull is the more
   * useful thing for a face-drag to mean (repositioning it again is the
   * gizmo's job at that point), so it takes over from there. A curved face
   * still highlights on hover regardless of selection — it just never starts
   * a drag here, planar or not, since it always falls through to path 1.
   */
  private beginPushPullFromHover(e: PointerEvent): boolean {
    if (this.toolMode !== "select" || this.showResult) return false;
    // A fresh raycast at THIS event's coordinates, not this.hoverFace — see
    // raycastFace()'s doc comment for why trusting the cached hover here
    // caused a real bug (a stale hover resuming a push/pull nowhere near a
    // later, unrelated click).
    const found = this.raycastFace(e);
    if (!found) return false;
    const { view, groupIndex } = found;
    const partId = [...this.parts.entries()].find(([, v]) => v === view)?.[0];
    const face = view.faces?.[groupIndex];
    if (!partId || !face || !face.planar || !this.selectedIds.includes(partId)) return false;

    const rect = this.renderer.domElement.getBoundingClientRect();
    view.group.updateWorldMatrix(true, true);
    const at = this.kernelLocalToWorld(view, face.point);
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
    if (pixelsPerUnit < 1e-3) return false;

    const scale = Math.max(0.5, this.worldSnapTolerance(at) * 0.85);
    const handle = makeArrow();
    handle.position.copy(at).addScaledVector(worldNormal, scale * 1.1);
    handle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), worldNormal);
    handle.scale.setScalar(scale);
    this.pushPullHandles.add(handle);

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
    };
    this.controls.enabled = false;
    this.gizmo.enabled = false;
    e.preventDefault();
    return true;
  }

  /** Distance (mm) the pointer currently represents, snapped to 0.5mm. */
  private pushPullDistance(e: PointerEvent, drag: PushPullDrag): number {
    const dx = e.clientX - drag.downScreen.x;
    const dy = e.clientY - drag.downScreen.y;
    const along = dx * drag.screenDir.x + dy * drag.screenDir.y;
    return Math.round((along / drag.pixelsPerUnit) * 2) / 2;
  }

  /** Opens the push/pull pill for typing an exact distance, at the same
   *  screen position the live-drag readout would use — triggered by a plain
   *  click (no drag) on a face's arrow/hover-highlight, the way clicking a
   *  resize handle's dimension pill lets you type instead of dragging. */
  private showPushPullInput(drag: PushPullDrag) {
    this.pushPullPending = { id: drag.id, localPoint: drag.localPoint, localNormal: drag.localNormal };
    const rect = this.renderer.domElement.getBoundingClientRect();
    const p = drag.handleBasePosition.clone().project(this.camera);
    this.pushPullLabelEl.style.display = "block";
    this.pushPullLabelEl.style.left = `${((p.x + 1) / 2) * rect.width}px`;
    this.pushPullLabelEl.style.top = `${((1 - p.y) / 2) * rect.height}px`;
    this.pushPullLabelEl.value = "0";
    this.pushPullLabelEl.focus();
    this.pushPullLabelEl.select();
  }

  /** Applies (or abandons) whatever is in the push/pull pill, on blur/Enter/
   *  Escape — pushPullPending is cleared by the Escape handler first when
   *  that is why this fired, so this is also what a plain Escape resolves
   *  to: close with nothing applied. */
  private commitPushPullInput() {
    const pending = this.pushPullPending;
    this.pushPullPending = null;
    this.pushPullLabelEl.style.display = "none";
    this.onDragChange?.(false);
    if (!pending) return;
    const distance = Number(this.pushPullLabelEl.value);
    // Same 0.5mm floor as a drag: a typed 0 (or nothing usable) is not an
    // edit — never turn a parametric node into a baked one for that.
    if (!Number.isFinite(distance) || Math.abs(distance) < 0.5) return;
    this.onPushPullFace?.(pending.id, {
      point: pending.localPoint,
      normal: pending.localNormal,
      distance,
    });
  }

  private applyTypedDimension(input: HTMLInputElement) {
    const id = input.dataset.nodeId;
    const current = Number(input.dataset.currentSize);
    const desired = Number(input.value);
    const node = id ? this.lastNodes.find((n) => n.id === id) : undefined;
    if (!node || !Number.isFinite(current) || current <= 0 || !Number.isFinite(desired) || desired <= 0) {
      this.updateResizeOverlay();
      return;
    }
    const ratio = desired / current;
    const axis = this.dimensionInputs.indexOf(input);
    const scale = [...node.scale] as Vec3;
    if (this.resizeConstrained) {
      for (let i = 0; i < 3; i++) scale[i] = Math.max(0.01, scale[i] * ratio);
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
      view.mesh.material = MATERIALS.result;
      this.resultView = view;
    }
    this.applyMaterials();
  }

  setShowResult(v: boolean) {
    this.showResult = v;
    this.applyMaterials();
    this.attachGizmo();
  }

  // ---- gizmo ------------------------------------------------------------

  setToolMode(mode: ToolMode) {
    this.toolMode = mode;
    if (mode === "move" || mode === "rotate") this.gizmo.setMode(mode === "move" ? "translate" : "rotate");
    this.attachGizmo();
    this.updateResizeOverlay();
    this.updateAlignOverlay();
    this.updatePushPullOverlay();
  }

  /** The gizmo drives one node at a time — the most recently selected. */
  private gizmoTarget(): string | null {
    return this.selectedIds.length ? this.selectedIds[this.selectedIds.length - 1] : null;
  }

  private attachGizmo() {
    const id = this.gizmoTarget();
    const view = id ? this.parts.get(id) : undefined;
    if (view && !this.showResult && (this.toolMode === "move" || this.toolMode === "rotate")) {
      if (this.gizmo.object !== view.group) this.gizmo.attach(view.group);
    } else if (this.gizmo.object) {
      this.gizmo.detach();
    }
  }

  private onDraggingChanged = (e: { value: unknown }) => {
    this.controls.enabled = !e.value;
    if (!e.value) this.guides.clear();
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

  private applySmartSnap(id: string, obj: THREE.Object3D) {
    // Alt bypasses snapping so a free-placed copy never gets pulled onto a
    // guide. Shift does NOT bypass it — shift-constrain only locks the drag
    // to a straight line; Smart Guides still snap along that line exactly
    // as they would without shift, matching Illustrator.
    if (this.altDown) {
      this.guides.clear();
      return;
    }

    const moving = this.boundsOf(obj);
    const targets: SnapTarget[] = [];
    for (const [targetId, view] of this.parts) {
      if (targetId === id || !view.group.visible) continue;
      targets.push({ id: targetId, bounds: this.boundsOf(view.group) });
    }

    const result = snapBounds(moving, targets, this.worldSnapTolerance(obj.position));
    if (!result.active.length) {
      this.guides.clear();
      return;
    }

    obj.position.x += result.delta[0];
    obj.position.y += result.delta[1];
    obj.position.z += result.delta[2];
    obj.updateWorldMatrix(true, true);
    this.guides.show(result.active, this.boundsOf(obj));
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
    return (worldHeight / height) * SNAP_TOLERANCE_PX;
  }

  private onModifierChange = (e: KeyboardEvent) => {
    this.altDown = e.altKey;
    if (this.altDown) this.guides.clear();
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
    if (this.beginPushPull(e) || this.beginPushPullFromHover(e)) {
      this.downAt = null;
      return;
    }
    if (this.beginResize(e)) return;

    // A gizmo-handle drag claims the event first: its own pointerdown
    // listener is registered on this same canvas before this one, so by the
    // time this runs, gizmo.dragging already reflects whether the click hit
    // an arrow. Do not ALSO start a body-drag on top of that.
    if (this.showResult || this.gizmo.dragging) return;

    const id = this.hitTest(e);
    if (!id) {
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

    const view = this.parts.get(id);
    if (!view) return;

    const planeZ = view.group.position.z;
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -planeZ);
    const grabPoint = this.rayPlaneHit(e, plane);
    if (!grabPoint) return;

    this.grab = {
      id,
      downScreen: { x: e.clientX, y: e.clientY },
      active: false,
      plane,
      grabPoint,
      startPos: view.group.position.clone(),
    };
  };

  /**
   * Click-and-drag an object's BODY to move it — TinkerCAD's primary way of
   * repositioning something, distinct from the gizmo's small arrow handles.
   * Slides the object under the cursor at constant height (X/Y only); lifting
   * it in Z is still the gizmo's job. Only engages once the pointer clears the
   * click threshold, so a plain click still falls through to pick() exactly
   * as before — this never changes what a non-dragging click does.
   */
  private onPointerMove = (e: PointerEvent) => {
    if (this.pushPullDrag) {
      const drag = this.pushPullDrag;
      if (!drag.active) {
        if (Math.hypot(e.clientX - drag.downScreen.x, e.clientY - drag.downScreen.y) <= CLICK_SLOP_PX) {
          return;
        }
        drag.active = true;
        this.onDragChange?.(true);
      }
      const distance = this.pushPullDistance(e, drag);
      // Preview by sliding the arrow only. The solid itself cannot follow
      // live — every step is a real OCCT boolean — so it updates once, on
      // release, and the readout carries the value in the meantime.
      drag.handle.position.copy(drag.handleBasePosition).addScaledVector(drag.worldNormal, distance);
      const rect = this.renderer.domElement.getBoundingClientRect();
      const p = drag.handle.position.clone().project(this.camera);
      this.pushPullLabelEl.style.display = "block";
      this.pushPullLabelEl.style.left = `${((p.x + 1) / 2) * rect.width}px`;
      this.pushPullLabelEl.style.top = `${((1 - p.y) / 2) * rect.height}px`;
      // Not focused during a live drag (the mouse button is down over the
      // canvas, not this input) — just reflecting the value, same as before
      // this became a real <input>. blur() below only fires from an actual
      // focused edit, so this never races with commitPushPullInput().
      this.pushPullLabelEl.value = distance.toFixed(1);
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
      const d = Math.hypot(e.clientX - this.resizeDrag.centreX, e.clientY - this.resizeDrag.centreY);
      const ratio = d / this.resizeDrag.startDistance;
      const scale = [...this.resizeDrag.startScale] as Vec3;
      if (this.resizeConstrained) {
        for (let i = 0; i < 3; i++) scale[i] = Math.max(0.01, scale[i] * ratio);
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
          scale[0] = Math.max(0.01, this.resizeDrag.startScale[0] * nextX / this.resizeDrag.startSize[0]);
          scale[1] = Math.max(0.01, this.resizeDrag.startScale[1] * nextY / this.resizeDrag.startSize[1]);
        }
      } else if (this.resizeDrag.axis !== null) {
        const axis = this.resizeDrag.axis;
        scale[axis] = Math.max(0.01, scale[axis] * ratio);
      } else {
        for (let i = 0; i < 3; i++) scale[i] = Math.max(0.01, scale[i] * ratio);
      }
      const view = this.parts.get(this.resizeDrag.id);
      const localShift = new THREE.Vector3();
      for (let i = 0; i < 3; i++) {
        localShift.setComponent(
          i,
          this.resizeDrag.handleSigns[i] * this.resizeDrag.rawSize[i] *
            (scale[i] - this.resizeDrag.startScale[i]) / 2,
        );
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
        this.onSelectObject?.(g.id, false);
        this.onDragChange?.(true);
      }
    }

    const view = this.parts.get(g.id);
    const hit = this.rayPlaneHit(e, g.plane);
    if (!view || !hit) return;

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
    view.group.position.set(g.startPos.x + dx, g.startPos.y + dy, g.startPos.z);
    view.group.updateWorldMatrix(true, true);

    this.applySmartSnap(g.id, view.group);
    const rotatedPivot = view.pivot.clone().applyEuler(view.group.rotation);
    this.onTransformObject?.(g.id, {
      position: [
        view.group.position.x - rotatedPivot.x,
        view.group.position.y - rotatedPivot.y,
        view.group.position.z - rotatedPivot.z,
      ],
    });
  };

  private onPointerUp = (e: PointerEvent) => {
    const down = this.downAt;
    this.downAt = null;

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
      if (drag.active) {
        this.pushPullLabelEl.style.display = "none";
        const distance = this.pushPullDistance(e, drag);
        // A drag that resolved to nothing is not an edit — never turn a
        // parametric node into a baked one for a 0mm push.
        if (Math.abs(distance) >= 0.5) {
          this.onPushPullFace?.(drag.id, {
            point: drag.localPoint,
            normal: drag.localNormal,
            distance,
          });
        }
        this.onDragChange?.(false);
      } else {
        // A plain click, no drag: open the same pill for typing an exact
        // distance instead, rather than doing nothing.
        this.showPushPullInput(drag);
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
      this.resizeDrag = null;
      this.controls.enabled = true;
      this.gizmo.enabled = true;
      this.onDragChange?.(false);
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
    this.pick(e, e.ctrlKey || e.metaKey || e.shiftKey);
  };

  private beginResize(e: PointerEvent): boolean {
    if (!this.resizeHandles.visible || this.selectedIds.length !== 1) return false;
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

    const id = this.selectedIds[0];
    const view = this.parts.get(id);
    const node = this.lastNodes.find((n) => n.id === id);
    if (!view || !node) return false;
    const box = new THREE.Box3().setFromObject(view.group);
    const worldCentre = box.getCenter(new THREE.Vector3());
    const project = (point: THREE.Vector3): [number, number] => {
      const p = point.project(this.camera);
      return [
        rect.left + ((p.x + 1) / 2) * rect.width,
        rect.top + ((1 - p.y) / 2) * rect.height,
      ];
    };
    const [centreX, centreY] = project(worldCentre.clone());
    const quaternion = view.group.getWorldQuaternion(new THREE.Quaternion());
    const [xPixelX, xPixelY] = project(worldCentre.clone().add(new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion)));
    const [yPixelX, yPixelY] = project(worldCentre.clone().add(new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion)));
    const cornerSigns: [number, number] | null = nearestIndex < 8
      ? [nearestIndex >= 4 ? 1 : -1, Math.floor(nearestIndex / 2) % 2 ? 1 : -1]
      : null;
    const handleSigns: Vec3 = nearestIndex < 8
      ? [cornerSigns![0], cornerSigns![1], nearestIndex % 2 ? 1 : -1]
      : [
          nearestIndex === 8 ? -1 : nearestIndex === 9 ? 1 : 0,
          nearestIndex === 10 ? -1 : nearestIndex === 11 ? 1 : 0,
          nearestIndex === 12 ? -1 : nearestIndex === 13 ? 1 : 0,
        ];
    view.mesh.geometry.computeBoundingBox();
    const rawSize = view.mesh.geometry.boundingBox!
      .getSize(new THREE.Vector3())
      .toArray() as Vec3;
    this.resizeDrag = {
      id,
      startScale: [...node.scale] as Vec3,
      axis: nearestIndex < 8 ? null : (Math.floor((nearestIndex - 8) / 2) as 0 | 1 | 2),
      centreX,
      centreY,
      startDistance: Math.max(1, Math.hypot(e.clientX - centreX, e.clientY - centreY)),
      startX: e.clientX,
      startY: e.clientY,
      startSize: box.getSize(new THREE.Vector3()).toArray() as Vec3,
      cornerSigns,
      basisX: [xPixelX - centreX, xPixelY - centreY],
      basisY: [yPixelX - centreX, yPixelY - centreY],
      startPosition: [...node.position] as Vec3,
      startGroupPosition: view.group.position.clone(),
      rawSize,
      handleSigns,
      rotation: quaternion,
    };
    this.controls.enabled = false;
    this.gizmo.enabled = false;
    this.onDragChange?.(true);
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
    this.onSelectObject?.(this.hitTest(e), additive);
  }

  private hitTest(e: { clientX: number; clientY: number }): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const targets = [...this.parts.values()].map((v) => v.mesh);
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

    this.controls.dispose();
    this.camera = next;
    this.controls = new OrbitControls(next, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.applyControlBindings();
    this.controls.target.copy(target);
    this.controls.update();
    this.gizmo.camera = next;
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
    this.renderer.render(this.scene, this.camera);
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
    this.controls.dispose();
    this.guides.dispose();
    this.alignHandleMeshes[0]?.geometry.dispose();
    for (const handle of this.alignHandleMeshes) (handle.material as THREE.Material).dispose();
    for (const handle of this.pushPullHandleMeshes) disposeArrow(handle);
    this.renderer.dispose();
    for (const input of this.dimensionInputs) input.remove();
    this.host.removeChild(this.renderer.domElement);
    this.host.removeChild(this.marqueeEl);
    this.host.removeChild(this.navCubeFrame);
    this.host.removeChild(this.pushPullLabelEl);
  }
}
