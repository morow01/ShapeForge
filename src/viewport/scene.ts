import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { syncGeometries } from "replicad-threejs-helper";
import type { ReplicadMesh, ThreeGeometry } from "replicad-threejs-helper";
import type { KernelMesh, ScenePart } from "../kernel/types";
import type { SceneNode, Vec3 } from "../document/types";
import { snapBounds } from "../snapping/snap";
import type { Bounds3, SnapTarget } from "../snapping/snap";
import { SmartGuides } from "./guides";

export type CameraMode = "perspective" | "orthographic";
export type ToolMode = "select" | "move" | "rotate";

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

interface Marquee {
  downScreen: { x: number; y: number };
  active: boolean;
  additive: boolean;
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

  onSelectObject: ((id: string | null, additive: boolean) => void) | null = null;
  /** Marquee release: every id whose screen-space bounds landed fully inside
   *  the drawn rectangle, in no particular order. */
  onSelectMany: ((ids: string[], additive: boolean) => void) | null = null;
  onTransformObject:
    | ((id: string, patch: { position?: Vec3; rotation?: Vec3; scale?: Vec3 }) => void)
    | null = null;
  /** Fires as a gizmo drag begins and ends, so the whole drag can become a
   *  single undo step instead of one per frame. */
  onDragChange: ((dragging: boolean) => void) | null = null;

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

    this.setupResizeOverlay();

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
    this.scene.add(this.resizeBox, this.resizeHandles);

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

  setResizeConstrained(value: boolean) {
    this.resizeConstrained = value;
  }

  // ---- parts ------------------------------------------------------------

  private makeView(mesh: KernelMesh, isHole: boolean): PartView {
    const geom = syncKernelGeometry(mesh);
    const pivot = this.centreGeometry(geom);
    const group = new THREE.Group();
    const m = new THREE.Mesh(geom[0].faces, isHole ? MATERIALS.hole : MATERIALS.solid);
    const wire = new THREE.LineSegments(
      geom[0].lines,
      new THREE.LineBasicMaterial({ color: 0x38505f, transparent: true, opacity: 0.7 }),
    );
    group.add(m, wire);
    this.scene.add(group);
    return { group, mesh: m, wire, geom, pivot, isHole };
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
      } else {
        this.parts.set(part.id, this.makeView(part.mesh, part.isHole));
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
      if (view.isHole) {
        view.mesh.material = sel ? MATERIALS.holeSelected : MATERIALS.hole;
        // Draw after opaque solids while still respecting their depth.
        view.mesh.renderOrder = 1;
      } else {
        view.mesh.material = sel ? MATERIALS.solidSelected : MATERIALS.solid;
        view.mesh.renderOrder = 0;
      }
      view.group.visible = !this.showResult;
    }
    if (this.resultView) this.resultView.group.visible = this.showResult;
    this.updateResizeOverlay();
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
    if (mode !== "select") this.gizmo.setMode(mode === "move" ? "translate" : "rotate");
    this.attachGizmo();
    this.updateResizeOverlay();
  }

  /** The gizmo drives one node at a time — the most recently selected. */
  private gizmoTarget(): string | null {
    return this.selectedIds.length ? this.selectedIds[this.selectedIds.length - 1] : null;
  }

  private attachGizmo() {
    const id = this.gizmoTarget();
    const view = id ? this.parts.get(id) : undefined;
    if (view && !this.showResult && this.toolMode !== "select") {
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

  // ---- picking ------------------------------------------------------------

  private onPointerDown = (e: PointerEvent) => {
    // Only the left button ever selects/drags — right/middle are reserved
    // for orbit/pan and must never be misread as a click on release.
    if (e.button !== 0) return;
    this.downAt = { x: e.clientX, y: e.clientY };

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
    if (!g) return;

    if (!g.active) {
      if (Math.hypot(e.clientX - g.downScreen.x, e.clientY - g.downScreen.y) <= CLICK_SLOP_PX) {
        return;
      }
      g.active = true;
      this.onSelectObject?.(g.id, false);
      this.onDragChange?.(true);
    }

    const view = this.parts.get(g.id);
    const hit = this.rayPlaneHit(e, g.plane);
    if (!view || !hit) return;

    view.group.position.set(
      g.startPos.x + (hit.x - g.grabPoint.x),
      g.startPos.y + (hit.y - g.grabPoint.y),
      g.startPos.z,
    );
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
    this.renderer.render(this.scene, this.camera);
  }

  /** Canvas backing-store size, for tests and diagnostics. */
  get canvasSize(): [number, number] {
    return [this.renderer.domElement.width, this.renderer.domElement.height];
  }

  dispose() {
    cancelAnimationFrame(this.frame);
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
    this.renderer.dispose();
    for (const input of this.dimensionInputs) input.remove();
    this.host.removeChild(this.renderer.domElement);
    this.host.removeChild(this.marqueeEl);
  }
}
