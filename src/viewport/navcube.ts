import * as THREE from "three";

/**
 * CAD-style view cube: a small, slightly see-through cube in a corner of the
 * main canvas that always shows the same orientation as the main camera.
 * It looks like a plain cube — no ruled lines —
 * but every face, edge and corner is its own click target: face for a
 * straight-on view, edge or corner for an angled one. The edge and corner
 * zones are invisible until the pointer is over them, when they light up.
 * Drag the cube to orbit the main camera freely.
 *
 * Kept as a self-contained scene/camera bundle so Scene only has to mirror one
 * orientation into it and forward a few pointer events — it does not know
 * anything about the document, the main scene, or its camera beyond the plain
 * THREE.Camera interface. It draws straight onto the main canvas with no
 * background of its own, so it floats over the model.
 */

/** World is Z-up here (see Scene's camera.up). */
export const FACE_DIRECTIONS: { dir: THREE.Vector3; label: string }[] = [
  { dir: new THREE.Vector3(1, 0, 0), label: "RIGHT" },
  { dir: new THREE.Vector3(-1, 0, 0), label: "LEFT" },
  { dir: new THREE.Vector3(0, 1, 0), label: "BACK" },
  { dir: new THREE.Vector3(0, -1, 0), label: "FRONT" },
  { dir: new THREE.Vector3(0, 0, 1), label: "TOP" },
  { dir: new THREE.Vector3(0, 0, -1), label: "BOTTOM" },
];

/** Square viewport the cube renders into, and its margin from the corner —
 *  both in CSS pixels, matching every other size in Scene. */
export const CUBE_PX = 150;
export const CUBE_MARGIN_PX = 18;

/** Half the cube's side length, and how wide the invisible edge and corner
 *  zones are on each face (a fraction of the face). */
const HALF = 0.5;
const BAND = 0.2;

/** The cube's frustum half-size, and how far the cube is nudged down so the
 *  hover toolbar has room above it. Together they set 60 px per unit. */
const FRUSTUM_HALF = 1.25;
const FRUSTUM_SHIFT = 0.05;

const FACE_COLOR = 0xffffff;
const FACE_OPACITY = 0.8;
const HOVER_COLOR = 0x86d8d5;
const OUTLINE_COLOR = 0x7d8e9b;
const LABEL_COLOR = "#43525e";

export interface NavHit {
  /** Stable name of the region, for hover bookkeeping. The two cells that
   *  make up one edge share a name, as do the three that make up a corner. */
  id: string;
  /** Direction, from the model, that the view should look from. */
  dir: THREE.Vector3;
  label: string;
  kind: "face" | "edge" | "corner";
}

interface Region {
  hit: NavHit;
  mesh: THREE.Mesh;
  material: THREE.MeshLambertMaterial;
}

/** A face's name, drawn dark on a transparent square so it can sit over the
 *  whole face, whatever hotspot cells lie underneath. */
function makeFaceLabel(text: string): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = LABEL_COLOR;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // The face is only a few dozen screen pixels wide, so the text is as large
  // as fits: "TOP" gets a bigger size than "BOTTOM".
  const family = "system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.font = `700 100px ${family}`;
  const fit = Math.min(100, (100 * size * 0.86) / ctx.measureText(text).width, 62);
  ctx.font = `700 ${fit}px ${family}`;
  ctx.fillText(text, size / 2, size / 2 + fit * 0.04);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** A flat quad with a fixed outward normal, wound counter-clockwise as seen
 *  from outside so the front-side-only material shows it from there. */
function quadGeometry(points: THREE.Vector3[], normal: THREE.Vector3): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const positions: number[] = [];
  const normals: number[] = [];
  for (const p of points) {
    positions.push(p.x, p.y, p.z);
    normals.push(normal.x, normal.y, normal.z);
  }
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return geometry;
}

export class NavCube {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  private readonly light: THREE.DirectionalLight;
  private regions: Region[] = [];
  private hoverId: string | null = null;
  private disposables: { dispose(): void }[] = [];
  private textures: THREE.Texture[] = [];

  constructor() {
    this.camera = new THREE.OrthographicCamera(
      -FRUSTUM_HALF, FRUSTUM_HALF, FRUSTUM_HALF + FRUSTUM_SHIFT, -FRUSTUM_HALF + FRUSTUM_SHIFT, 0.1, 20,
    );
    this.camera.up.set(0, 0, 1);

    this.buildCube();

    // Lit from the viewer's upper left rather than from the world, so
    // whichever faces turn toward you are the bright ones as the cube spins.
    // (Lit surfaces get 1/π of a light's intensity, hence the factors of π.)
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.72 * Math.PI));
    this.light = new THREE.DirectionalLight(0xffffff, 0.34 * Math.PI);
    this.scene.add(this.light);

    this.scene.updateMatrixWorld(true);
  }

  private track<T extends { dispose(): void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }

  private buildCube() {
    // A face is cut into 3 x 3 cells. The middle one is the face itself, the
    // four beside it are edge zones and the four at its corners are corner
    // zones. All look identical at rest, so the cube reads as a plain one.
    const spans: [number, number][] = [
      [-HALF, -HALF + BAND],
      [-HALF + BAND, HALF - BAND],
      [HALF - BAND, HALF],
    ];
    const key = (v: THREE.Vector3) => `${Math.round(v.x)},${Math.round(v.y)},${Math.round(v.z)}`;

    for (const face of FACE_DIRECTIONS) {
      const n = face.dir;
      // Labels stay upright: the four sides read with +Z up, the top with the
      // back of the model at its top edge, the bottom with the front at its.
      const up =
        Math.abs(n.z) < 0.5
          ? new THREE.Vector3(0, 0, 1)
          : new THREE.Vector3(0, n.z > 0 ? 1 : -1, 0);
      const right = new THREE.Vector3().crossVectors(up, n);
      const at = (a: number, b: number) =>
        n.clone().multiplyScalar(HALF).addScaledVector(right, a).addScaledVector(up, b);

      for (let j = 0; j < 3; j++) {
        for (let i = 0; i < 3; i++) {
          const [r0, r1] = spans[i];
          const [u0, u1] = spans[j];
          const points = [at(r0, u0), at(r1, u0), at(r1, u1), at(r0, u1)];
          const sum = n.clone().addScaledVector(right, i - 1).addScaledVector(up, j - 1);
          const kind = i === 1 && j === 1 ? "face" : i === 1 || j === 1 ? "edge" : "corner";
          const material = this.track(
            new THREE.MeshLambertMaterial({
              color: FACE_COLOR,
              transparent: true,
              opacity: FACE_OPACITY,
              side: THREE.FrontSide,
              // Faces write depth, so the far edges never show through the near
              // faces; and they sit a touch back so the outline wins on the rim.
              depthWrite: true,
              polygonOffset: true,
              polygonOffsetFactor: 1,
              polygonOffsetUnits: 1,
            }),
          );
          const mesh = new THREE.Mesh(this.track(quadGeometry(points, n)), material);
          this.scene.add(mesh);
          this.regions.push({
            hit: {
              id: key(sum),
              dir: sum.clone().normalize(),
              label: kind === "face" ? face.label : "",
              kind,
            },
            mesh,
            material,
          });
        }
      }

      // The name, over the whole face and not part of any click target.
      const texture = makeFaceLabel(face.label);
      this.textures.push(texture);
      const label = new THREE.Mesh(
        this.track(new THREE.PlaneGeometry(0.9, 0.9)),
        this.track(
          new THREE.MeshBasicMaterial({
            map: texture,
            transparent: true,
            depthWrite: false,
            side: THREE.FrontSide,
          }),
        ),
      );
      label.matrixAutoUpdate = false;
      label.matrix.makeBasis(right, up, n).setPosition(n.clone().multiplyScalar(HALF + 0.003));
      label.renderOrder = 2;
      this.scene.add(label);
    }

    // Only the cube's own twelve edges are drawn.
    const outline = new THREE.LineSegments(
      this.track(new THREE.EdgesGeometry(new THREE.BoxGeometry(HALF * 2, HALF * 2, HALF * 2))),
      this.track(new THREE.LineBasicMaterial({ color: OUTLINE_COLOR })),
    );
    outline.renderOrder = 1;
    this.scene.add(outline);
  }

  /** Points the cube the same way the main camera is currently pointing, so
   *  whatever face you're looking at in the main view is the one facing you
   *  here too. Distance is fixed (the cube's own orthographic camera has no
   *  zoom of its own) — only direction matters. */
  syncOrientation(offsetDir: THREE.Vector3, up: THREE.Vector3) {
    const DIST = 6;
    // lookAt is degenerate when the view direction is parallel to `up` (a
    // dead-on top/bottom view) — fall back to a perpendicular up just for
    // that shot so the cube never flips or freezes at the poles.
    const parallel = Math.abs(offsetDir.dot(up)) > 0.999;
    const camUp = parallel ? new THREE.Vector3(0, 1, 0) : up;
    this.camera.position.copy(offsetDir).multiplyScalar(DIST);
    this.camera.up.copy(camUp);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();

    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const above = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    const toCamera = offsetDir.clone().normalize();
    this.light.position.copy(toCamera).addScaledVector(above, 0.9).addScaledVector(right, -0.9).multiplyScalar(5);
  }

  /** Region hit by a ray through (ndcX, ndcY) in this cube's own [-1, 1] clip
   *  space, or null outside the cube. */
  hitTest(ndcX: number, ndcY: number): NavHit | null {
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const hit = raycaster.intersectObjects(this.regions.map((r) => r.mesh), false)[0];
    if (!hit) return null;
    const region = this.regions.find((r) => r.mesh === hit.object);
    return region ? { ...region.hit, dir: region.hit.dir.clone() } : null;
  }

  /** Lights up one region (or none). Returns whether anything changed. */
  setHover(id: string | null): boolean {
    if (id === this.hoverId) return false;
    this.hoverId = id;
    for (const r of this.regions) r.material.color.setHex(r.hit.id === id ? HOVER_COLOR : FACE_COLOR);
    return true;
  }

  /** Draws the cube into the square of the renderer's canvas whose lower-left
   *  corner is (x, y) and whose side is `size` — CSS pixels, y measured from
   *  the bottom. Draws over whatever is already there, with no background of its own. */
  render(renderer: THREE.WebGLRenderer, x: number, y: number, size: number) {
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setScissorTest(true);

    renderer.setScissor(x, y, size, size);
    renderer.setViewport(x, y, size, size);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);

    renderer.setScissorTest(false);
    renderer.autoClear = autoClear;
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    for (const t of this.textures) t.dispose();
  }
}
