import * as THREE from "three";

export type FaceBounds = [number, number, number, number];
export interface FaceResizeFrame {
  bounds: FaceBounds;
  units: [number, number];
}

const CORNER_COLOR = 0xffffff;
const EDGE_COLOR = 0x00a9b7;
const HOVER_COLOR = 0xff9f1a;
const HOVER_GROW = 1.18;
/** Same screen-constant sizing formula as the object-level resize dots
 *  (Scene.worldSnapTolerance), duplicated here since that method is private
 *  to Scene and this class only ever needs it for its own eight handles. */
const HANDLE_PX = 7;
const MIN_HANDLE_WORLD = 0.02;
const MAX_HANDLE_WORLD = 2;

/**
 * Eight little cubes on the selected face's own plane — the same look as the
 * object-level resize dots (white corners, teal edges, orange on hover, a
 * constant size on screen) — real meshes in the 3D scene rather than an HTML
 * overlay, so they sit correctly among the geometry instead of floating flat
 * on top of it.
 *
 * Picking runs on a capture-phase listener on `host` (the canvas's direct
 * parent), which fires before Scene's own pointerdown/move/up — themselves
 * bubble-phase listeners on the canvas, a descendant of host. Swallowing the
 * event there (stopPropagation, during capture) keeps it from ever reaching
 * Scene's handlers or OrbitControls/TransformControls, both also bound to
 * the canvas — exactly as a DOM button overlay would have absorbed the
 * click, but for a real mesh with no DOM element of its own to hit-test.
 */
export class FaceResizeHandles {
  private group = new THREE.Group();
  private geometry = new THREE.BoxGeometry(1, 1, 1);
  private cornerMaterial = new THREE.MeshBasicMaterial({ color: CORNER_COLOR, depthTest: false });
  private edgeMaterial = new THREE.MeshBasicMaterial({ color: EDGE_COLOR, depthTest: false });
  private hoverMaterial = new THREE.MeshBasicMaterial({ color: HOVER_COLOR, depthTest: false });
  private meshes: THREE.Mesh[] = [];
  /** The dragged outline itself, redrawn every frame straight from `bounds`
   *  — no debounce, no kernel round-trip — so there is always something
   *  showing exactly how far and which way the current drag has gone, even
   *  while the real rebuilt preview is still catching up behind it. */
  private outlineGeometry = new THREE.BufferGeometry();
  private outlineMaterial = new THREE.LineBasicMaterial({ color: HOVER_COLOR, depthTest: false, transparent: true, opacity: 0.9 });
  private outline = new THREE.LineLoop(this.outlineGeometry, this.outlineMaterial);
  private hoverIndex = -1;
  private bounds: FaceBounds;
  private drag: { pointer: number; bounds: FaceBounds; start: THREE.Vector3; x: number; y: number } | null = null;
  private inverse: THREE.Matrix4;
  private plane: THREE.Plane;
  private ray = new THREE.Raycaster();
  private directions = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];
  private host: HTMLElement;
  private camera: () => THREE.Camera;
  private matrix: THREE.Matrix4;
  private change: (bounds: FaceBounds) => void;
  private dragging: (active: boolean) => void;

  constructor(
    host: HTMLElement,
    scene: THREE.Scene,
    camera: () => THREE.Camera,
    matrix: THREE.Matrix4,
    bounds: FaceBounds,
    change: (bounds: FaceBounds) => void,
    dragging: (active: boolean) => void,
  ) {
    this.host=host; this.camera=camera; this.matrix=matrix; this.change=change; this.dragging=dragging;
    this.bounds = [...bounds];
    this.inverse = matrix.clone().invert();
    this.plane = new THREE.Plane(new THREE.Vector3(0,0,1),0).applyMatrix4(matrix);
    const names = ["bottom left", "bottom", "bottom right", "left", "right", "top left", "top", "top right"];
    this.directions.forEach(([x,y], i) => {
      const mesh = new THREE.Mesh(this.geometry, x && y ? this.cornerMaterial : this.edgeMaterial);
      mesh.userData.baseMaterial = mesh.material;
      mesh.name = `Resize face ${names[i]}`;
      mesh.renderOrder = 999;
      this.group.add(mesh);
      this.meshes.push(mesh);
    });
    this.outlineGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12), 3));
    this.outline.renderOrder = 998;
    this.outline.visible = false;
    this.group.add(this.outline);
    scene.add(this.group);
    host.addEventListener("pointerdown", this.onPointerDown, { capture: true });
    host.addEventListener("pointermove", this.onPointerMove, { capture: true });
    host.addEventListener("pointerup", this.onPointerUp, { capture: true });
    host.addEventListener("pointercancel", this.onPointerUp, { capture: true });
    this.render();
  }

  private ndc(e: PointerEvent): THREE.Vector2 {
    const r = this.host.getBoundingClientRect();
    return new THREE.Vector2((e.clientX-r.left)/r.width*2-1, 1-(e.clientY-r.top)/r.height*2);
  }

  private pick(e: PointerEvent): number {
    this.ray.setFromCamera(this.ndc(e), this.camera());
    const hit = this.ray.intersectObjects(this.meshes)[0];
    return hit ? this.meshes.indexOf(hit.object as THREE.Mesh) : -1;
  }

  private setHover(index: number) {
    if (index === this.hoverIndex) return;
    if (this.hoverIndex >= 0) {
      const prev = this.meshes[this.hoverIndex];
      prev.material = prev.userData.baseMaterial as THREE.Material;
    }
    this.hoverIndex = index;
    if (index >= 0) this.meshes[index].material = this.hoverMaterial;
    this.host.style.cursor = index >= 0 ? "move" : "";
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const index = this.pick(e);
    if (index < 0) return;
    e.preventDefault(); e.stopPropagation();
    const start = this.point(e);
    if (!start) return;
    const [x,y] = this.directions[index];
    this.drag = { pointer: e.pointerId, bounds: [...this.bounds], start, x, y };
    this.setHover(index);
    this.outline.visible = true;
    this.host.setPointerCapture(e.pointerId);
    this.dragging(true);
  };

  private onPointerMove = (e: PointerEvent) => {
    const drag = this.drag;
    if (drag && drag.pointer === e.pointerId) {
      e.preventDefault(); e.stopPropagation();
      const point = this.point(e);
      if (!point) return;
      this.adjust(drag.bounds, drag.x ? point.x-drag.start.x : 0, drag.y ? point.y-drag.start.y : 0, drag.x, drag.y);
      return;
    }
    if (drag) return;
    this.setHover(this.pick(e));
  };

  private onPointerUp = (e: PointerEvent) => {
    if (this.drag?.pointer !== e.pointerId) return;
    e.preventDefault(); e.stopPropagation();
    if (e.type === "pointercancel") { this.bounds=this.drag.bounds; this.change([...this.bounds]); }
    this.drag=null; this.dragging(false);
    this.outline.visible = false;
    if (this.host.hasPointerCapture(e.pointerId)) this.host.releasePointerCapture(e.pointerId);
    this.setHover(this.pick(e));
  };

  private adjust(bounds:FaceBounds,dx:number,dy:number,x:number,y:number) {
    const next:FaceBounds=[...bounds];
    if(x<0) next[0]=Math.min(next[1]-0.1,next[0]+dx);
    if(x>0) next[1]=Math.max(next[0]+0.1,next[1]+dx);
    if(y<0) next[2]=Math.min(next[3]-0.1,next[2]+dy);
    if(y>0) next[3]=Math.max(next[2]+0.1,next[3]+dy);
    this.bounds=next; this.render(); this.change([...next]);
  }

  private point(e:PointerEvent) {
    this.ray.setFromCamera(this.ndc(e),this.camera());
    const point=this.ray.ray.intersectPlane(this.plane,new THREE.Vector3());
    return point?.applyMatrix4(this.inverse) ?? null;
  }

  setBounds(bounds:FaceBounds) { this.bounds=[...bounds]; this.render(); }

  /** Screen-constant handle size, same formula as Scene.worldSnapTolerance. */
  private handleSize(at: THREE.Vector3): number {
    const camera = this.camera();
    const height = Math.max(1, this.host.clientHeight);
    let worldHeight: number;
    if (camera instanceof THREE.PerspectiveCamera) {
      const distance = camera.position.distanceTo(at);
      worldHeight = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * distance;
    } else if (camera instanceof THREE.OrthographicCamera) {
      worldHeight = (camera.top - camera.bottom) / camera.zoom;
    } else {
      worldHeight = 1;
    }
    return Math.max(MIN_HANDLE_WORLD, Math.min(MAX_HANDLE_WORLD, (worldHeight / height) * HANDLE_PX));
  }

  render() {
    const [l,r,b,t]=this.bounds;
    const centre = new THREE.Vector3((l+r)/2,(b+t)/2,0).applyMatrix4(this.matrix);
    const size = this.handleSize(centre);
    this.directions.forEach(([x,y],i)=>{
      const p=new THREE.Vector3(x<0?l:x>0?r:(l+r)/2,y<0?b:y>0?t:(b+t)/2,0).applyMatrix4(this.matrix);
      const mesh=this.meshes[i];
      mesh.position.copy(p);
      mesh.scale.setScalar(size * (i === this.hoverIndex ? HOVER_GROW : 1));
    });
    const corners = [[l,b],[r,b],[r,t],[l,t]];
    const positions = this.outlineGeometry.attributes.position as THREE.BufferAttribute;
    corners.forEach(([u,v], i) => {
      const p = new THREE.Vector3(u,v,0).applyMatrix4(this.matrix);
      positions.setXYZ(i, p.x, p.y, p.z);
    });
    positions.needsUpdate = true;
  }

  dispose() {
    if(this.drag) this.dragging(false);
    this.host.removeEventListener("pointerdown", this.onPointerDown, { capture: true });
    this.host.removeEventListener("pointermove", this.onPointerMove, { capture: true });
    this.host.removeEventListener("pointerup", this.onPointerUp, { capture: true });
    this.host.removeEventListener("pointercancel", this.onPointerUp, { capture: true });
    this.host.style.cursor = "";
    this.group.removeFromParent();
    this.geometry.dispose();
    this.cornerMaterial.dispose();
    this.edgeMaterial.dispose();
    this.hoverMaterial.dispose();
    this.outlineGeometry.dispose();
    this.outlineMaterial.dispose();
  }
}
