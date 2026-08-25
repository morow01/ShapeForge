import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { syncGeometries } from "replicad-threejs-helper";
import type { ThreeGeometry } from "replicad-threejs-helper";
import type { KernelMesh, ScenePart } from "../kernel/types";
import type { SceneNode, Vec3 } from "../document/types";
import { snapBounds } from "../snapping/snap";
import type { Bounds3, SnapTarget } from "../snapping/snap";
import { SmartGuides } from "./guides";

export type CameraMode = "perspective" | "orthographic";
export type GizmoMode = "translate" | "rotate";

/** How far the pointer may move between down and up and still count as a click
 *  rather than an orbit drag. */
const CLICK_SLOP_PX = 4;
const SNAP_TOLERANCE_PX = 10;
const DEG = Math.PI / 180;

interface PartView {
  group: THREE.Group;
  mesh: THREE.Mesh;
  wire: THREE.LineSegments;
  geom: ThreeGeometry[];
  isHole: boolean;
}

const MATERIALS = {
  solid: new THREE.MeshStandardMaterial({ color: 0x6f8fbf, metalness: 0.1, roughness: 0.55 }),
  solidSelected: new THREE.MeshStandardMaterial({
    color: 0xffa53d,
    metalness: 0.1,
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
    color: 0xe05c5c,
    transparent: true,
    opacity: 0.38,
    depthWrite: false,
    depthTest: true,
    roughness: 0.6,
  }),
  holeSelected: new THREE.MeshStandardMaterial({
    color: 0xffa53d,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    depthTest: true,
    roughness: 0.5,
  }),
  result: new THREE.MeshStandardMaterial({ color: 0x8fb98f, metalness: 0.1, roughness: 0.5 }),
};

export class Scene {
  private host: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  private controls: OrbitControls;
  private gizmo: TransformControls;
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

  onSelectObject: ((id: string | null, additive: boolean) => void) | null = null;
  onTransformObject:
    | ((id: string, patch: { position?: Vec3; rotation?: Vec3 }) => void)
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

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1d21);

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

    this.addLights();
    this.addGrid();

    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
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
    const grid = new THREE.GridHelper(200, 20, 0x4a5058, 0x2c3138);
    grid.rotation.x = Math.PI / 2;
    this.scene.add(grid);
    this.scene.add(new THREE.AxesHelper(25));
  }

  // ---- parts ------------------------------------------------------------

  private makeView(mesh: KernelMesh, isHole: boolean): PartView {
    const geom = syncGeometries([mesh], []);
    const group = new THREE.Group();
    const m = new THREE.Mesh(geom[0].faces, isHole ? MATERIALS.hole : MATERIALS.solid);
    const wire = new THREE.LineSegments(
      geom[0].lines,
      new THREE.LineBasicMaterial({ color: 0x11151a }),
    );
    group.add(m, wire);
    this.scene.add(group);
    return { group, mesh: m, wire, geom, isHole };
  }

  /** Replace the meshed parts. Only called when geometry actually changes. */
  setParts(parts: ScenePart[]) {
    const seen = new Set<string>();

    for (const part of parts) {
      seen.add(part.id);
      const existing = this.parts.get(part.id);
      if (existing) {
        existing.geom = syncGeometries([part.mesh], existing.geom);
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
      // Skip the part being dragged, so the gizmo is not fighting React state.
      if (this.gizmo.dragging && this.gizmo.object === view.group) continue;
      view.group.position.set(o.position[0], o.position[1], o.position[2]);
      view.group.rotation.set(o.rotation[0] * DEG, o.rotation[1] * DEG, o.rotation[2] * DEG);
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
  }

  setResult(mesh: KernelMesh | null) {
    if (this.resultView) {
      this.scene.remove(this.resultView.group);
      this.resultView = null;
    }
    if (mesh) {
      const view = this.makeView(mesh, false);
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

  setGizmoMode(mode: GizmoMode) {
    this.gizmo.setMode(mode);
  }

  /** The gizmo drives one node at a time — the most recently selected. */
  private gizmoTarget(): string | null {
    return this.selectedIds.length ? this.selectedIds[this.selectedIds.length - 1] : null;
  }

  private attachGizmo() {
    const id = this.gizmoTarget();
    const view = id ? this.parts.get(id) : undefined;
    if (view && !this.showResult) {
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
    this.onTransformObject?.(id, {
      position: [obj.position.x, obj.position.y, obj.position.z],
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

  // ---- picking ----------------------------------------------------------

  private onPointerDown = (e: PointerEvent) => {
    // Only the left button ever selects — right/middle are reserved for
    // orbit/pan and must never be misread as a click on release.
    if (e.button !== 0) return;
    this.downAt = { x: e.clientX, y: e.clientY };
  };

  private onPointerUp = (e: PointerEvent) => {
    const down = this.downAt;
    this.downAt = null;
    if (!down || this.gizmo.dragging) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP_PX) return;
    this.pick(e, e.ctrlKey || e.metaKey || e.shiftKey);
  };

  private pick(e: PointerEvent, additive: boolean) {
    if (this.showResult) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const targets = [...this.parts.values()].map((v) => v.mesh);
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    if (!hit) {
      this.onSelectObject?.(null, additive);
      return;
    }
    for (const [id, view] of this.parts) {
      if (view.mesh === hit.object) {
        this.onSelectObject?.(id, additive);
        return;
      }
    }
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
    this.renderer.render(this.scene, this.camera);
  }

  /** Canvas backing-store size, for tests and diagnostics. */
  get canvasSize(): [number, number] {
    return [this.renderer.domElement.width, this.renderer.domElement.height];
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
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
    this.host.removeChild(this.renderer.domElement);
  }
}
