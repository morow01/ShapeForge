import * as THREE from "three";

/**
 * TinkerCAD-style view cube: a small labelled cube, rendered into a corner
 * of the main canvas, that always shows the same orientation as the main
 * camera. Click a face to snap the main view to look straight at it; drag
 * the cube to orbit the main camera freely.
 *
 * Kept as a self-contained scene/camera/mesh bundle so Scene only has to
 * mirror one orientation into it and forward a few pointer events — it does
 * not know anything about the document, the main scene, or its camera
 * beyond the plain THREE.Camera interface.
 */

/** World is Z-up here (see Scene's camera.up), so the box's own +Y/-Y groups
 *  are front/back, not top/bottom — only +Z/-Z are. */
export const FACE_DIRECTIONS: { materialIndex: number; dir: THREE.Vector3; label: string }[] = [
  { materialIndex: 0, dir: new THREE.Vector3(1, 0, 0), label: "RIGHT" },
  { materialIndex: 1, dir: new THREE.Vector3(-1, 0, 0), label: "LEFT" },
  { materialIndex: 2, dir: new THREE.Vector3(0, 1, 0), label: "BACK" },
  { materialIndex: 3, dir: new THREE.Vector3(0, -1, 0), label: "FRONT" },
  { materialIndex: 4, dir: new THREE.Vector3(0, 0, 1), label: "TOP" },
  { materialIndex: 5, dir: new THREE.Vector3(0, 0, -1), label: "BOTTOM" },
];

/** Square viewport the cube renders into, and its margin from the corner —
 *  both in CSS pixels, matching every other size in Scene. */
export const CUBE_PX = 96;
export const CUBE_MARGIN_PX = 16;

function makeLabelTexture(text: string): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#eef2f4";
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = "#8fa0a8";
  ctx.lineWidth = 5;
  ctx.strokeRect(2.5, 2.5, size - 5, size - 5);
  ctx.fillStyle = "#293841";
  ctx.font = "700 26px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, size / 2, size / 2 + 1);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class NavCube {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  readonly mesh: THREE.Mesh;
  private materials: THREE.MeshBasicMaterial[];

  constructor() {
    // Matches the main scene's own background — see Scene's constructor —
    // so the little viewport reads as a continuation of it, not a hole.
    this.scene.background = new THREE.Color(0xedf1f4);

    const half = 1.6;
    this.camera = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, 20);
    this.camera.up.set(0, 0, 1);

    this.materials = FACE_DIRECTIONS.map(
      (f) => new THREE.MeshBasicMaterial({ map: makeLabelTexture(f.label) }),
    );
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.materials);
    this.scene.add(this.mesh);

    this.scene.add(new THREE.AmbientLight(0xffffff, 1));
  }

  /** Points the cube the same way the main camera is currently pointing, so
   *  whatever face you're looking at in the main view is the one facing you
   *  here too. Distance is fixed (the cube's own orthographic camera has no
   *  zoom of its own) — only direction matters. */
  syncOrientation(offsetDir: THREE.Vector3, up: THREE.Vector3) {
    const DIST = 4;
    this.camera.position.copy(offsetDir).multiplyScalar(DIST);
    // lookAt is degenerate when the view direction is parallel to `up` (a
    // dead-on top/bottom view) — fall back to a perpendicular up just for
    // that shot so the cube never flips or freezes at the poles.
    const parallel = Math.abs(offsetDir.dot(up)) > 0.999;
    this.camera.up.copy(parallel ? new THREE.Vector3(0, 1, 0) : up);
    this.camera.lookAt(0, 0, 0);
  }

  /** Face hit by a ray through (ndcX, ndcY) in this cube's own [-1, 1] clip
   *  space, or null outside the cube. */
  hitTest(ndcX: number, ndcY: number): { dir: THREE.Vector3; label: string } | null {
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const hit = raycaster.intersectObject(this.mesh, false)[0];
    if (!hit || hit.face == null) return null;
    const face = FACE_DIRECTIONS.find((f) => f.materialIndex === hit.face!.materialIndex);
    return face ? { dir: face.dir.clone(), label: face.label } : null;
  }

  dispose() {
    this.mesh.geometry.dispose();
    for (const m of this.materials) {
      m.map?.dispose();
      m.dispose();
    }
  }
}
