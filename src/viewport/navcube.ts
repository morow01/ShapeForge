import * as THREE from "three";

/**
 * Shapr3D-style view cube: a small, minimal labelled cube with a coloured
 * XYZ axis indicator, rendered into a corner of the main canvas, that
 * always shows the same orientation as the main camera. Click a face to
 * snap the main view to look straight at it; drag the cube to orbit the
 * main camera freely.
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

/** The little red/green/blue X/Y/Z ticks poking out of the cube — purely
 *  decorative, drawn once along the cube's own (fixed) local axes; the
 *  camera orbiting around the cube is what makes them appear to turn. */
const AXIS_TICKS: { dir: THREE.Vector3; color: number; label: string }[] = [
  { dir: new THREE.Vector3(1, 0, 0), color: 0xd94f4f, label: "X" },
  { dir: new THREE.Vector3(0, 1, 0), color: 0x4caf6a, label: "Y" },
  { dir: new THREE.Vector3(0, 0, 1), color: 0x3d8bd4, label: "Z" },
];

/** Square viewport the cube renders into, and its margin from the corner —
 *  both in CSS pixels, matching every other size in Scene. */
export const CUBE_PX = 160;
export const CUBE_MARGIN_PX = 18;

/** Half the cube's side length — every other placement (axis ticks, camera
 *  distance/extent) is expressed relative to this one number. */
const HALF = 0.5;

function makeFaceTexture(text: string): THREE.CanvasTexture {
  const size = 192;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fcfdfd";
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = "#dde2e5";
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, size - 4, size - 4);
  ctx.fillStyle = "#8a949c";
  ctx.font = "600 28px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, size / 2, size / 2 + 1);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeAxisSprite(text: string, color: number): THREE.Sprite {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 32px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, size / 2, size / 2 + 1);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, depthTest: false, sizeAttenuation: false }),
  );
  sprite.renderOrder = 10;
  sprite.scale.set(0.16, 0.16, 1);
  return sprite;
}

export class NavCube {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  readonly mesh: THREE.Mesh;
  private faceMaterials: THREE.MeshBasicMaterial[];
  private axisDisposables: { geometry?: THREE.BufferGeometry; material: THREE.Material }[] = [];

  constructor() {
    // Matches the main scene's own background — see Scene's constructor —
    // so the little viewport reads as a continuation of it, not a hole.
    this.scene.background = new THREE.Color(0xedf1f4);

    const half = 1.7;
    this.camera = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, 20);
    this.camera.up.set(0, 0, 1);

    this.faceMaterials = FACE_DIRECTIONS.map(
      (f) => new THREE.MeshBasicMaterial({ map: makeFaceTexture(f.label) }),
    );
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(HALF * 2, HALF * 2, HALF * 2), this.faceMaterials);
    this.scene.add(this.mesh);

    for (const tick of AXIS_TICKS) {
      const from = tick.dir.clone().multiplyScalar(HALF);
      const to = tick.dir.clone().multiplyScalar(HALF + 0.55);
      const geometry = new THREE.BufferGeometry().setFromPoints([from, to]);
      const material = new THREE.LineBasicMaterial({ color: tick.color, depthTest: false });
      const line = new THREE.Line(geometry, material);
      line.renderOrder = 9;
      this.scene.add(line);
      this.axisDisposables.push({ geometry, material });

      const sprite = makeAxisSprite(tick.label, tick.color);
      sprite.position.copy(tick.dir).multiplyScalar(HALF + 0.72);
      this.scene.add(sprite);
      this.axisDisposables.push({ material: sprite.material });
    }

    this.scene.add(new THREE.AmbientLight(0xffffff, 1));
  }

  /** Points the cube the same way the main camera is currently pointing, so
   *  whatever face you're looking at in the main view is the one facing you
   *  here too. Distance is fixed (the cube's own orthographic camera has no
   *  zoom of its own) — only direction matters. */
  syncOrientation(offsetDir: THREE.Vector3, up: THREE.Vector3) {
    const DIST = 6;
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
    for (const m of this.faceMaterials) {
      m.map?.dispose();
      m.dispose();
    }
    for (const d of this.axisDisposables) {
      d.geometry?.dispose();
      const mat = d.material as THREE.MeshBasicMaterial | THREE.SpriteMaterial;
      (mat as { map?: THREE.Texture | null }).map?.dispose();
      d.material.dispose();
    }
  }
}
