import {
  makeBaseBox,
  makeCylinder,
  makeSphere,
  basicFaceExtrusion,
  Vector,
  draw,
  importSTLAsMesh,
  measureVolume,
  MeshShape,
  getManifold,
} from "replicad";
import type { Face, Shape3D } from "replicad";
import { InvalidShapeError, solveTriangle } from "../geometry/triangle";
import { getBlob } from "../document/blobStore";
import type { PushPullOp, Vec3 } from "../document/types";
import type { EditSpec, ImportSpec, NodeSpec, ObjectSpec } from "./types";

export { InvalidShapeError };

/**
 * A node's local geometry is a Shape3D (OCCT/BRep) for every ordinary
 * primitive and boolean, or a MeshShape (manifold-3d) specifically for an
 * imported STL — see makeImport() for why. Any node that combines the two
 * (a group containing an import, at any depth) is resolved entirely in
 * MeshShape terms; see combine().
 */
export type AnySolid = Shape3D | MeshShape;

const isMesh = (s: AnySolid): s is MeshShape => s instanceof MeshShape;

/**
 * Builds a primitive in LOCAL space: centred in XY with its base on z = 0,
 * with no position or rotation applied. Placement lives on the Three.js side
 * so dragging an object never needs a kernel rebuild.
 */
export function makePrimitive(spec: ObjectSpec): Shape3D {
  const p = spec.params;
  let s: Shape3D;

  switch (spec.kind) {
    case "box": {
      s = makeBaseBox(p.width, p.depth, p.height);
      // Clamp so the fillet can never exceed half the smallest side, which
      // would make OCCT throw instead of returning a shape.
      const maxR = Math.min(p.width, p.depth) / 2 - 0.01;
      const r = Math.min(p.fillet ?? 0, maxR);
      if (r > 0) s = s.fillet(r, (e) => e.inDirection("Z"));
      break;
    }
    case "cylinder":
      s = makeCylinder(p.radius, p.height);
      break;
    case "sphere":
      s = makeSphere(p.radius);
      break;
    case "cone": {
      const rb = Math.max(p.bottomRadius, 0);
      const rt = Math.max(p.topRadius, 0);
      // Revolve a profile in the XZ plane about Z. A zero top radius closes to
      // a true point rather than a degenerate zero-width face.
      let pen = draw([0, 0]).lineTo([Math.max(rb, 0.001), 0]);
      pen = rt > 0 ? pen.lineTo([rt, p.height]).lineTo([0, p.height]) : pen.lineTo([0, p.height]);
      s = pen.close().sketchOnPlane("XZ").revolve([0, 0, 1]) as Shape3D;
      break;
    }
    case "triangle": {
      if (p.thickness <= 0) throw new InvalidShapeError("Thickness must be greater than zero.");
      const { apexPoint } = solveTriangle(p);
      s = draw([0, 0])
        .lineTo([p.base, 0])
        .lineTo([apexPoint.x, apexPoint.y])
        .close()
        .sketchOnPlane("XY")
        .extrude(p.thickness) as Shape3D;
      break;
    }
  }

  return normalise(s) as Shape3D;
}

/** Centres a shape in XY and drops its base to z = 0 — the one origin
 *  convention every local shape shares, primitive or imported. */
function normalise<T extends AnySolid>(s: T): T {
  const [min, max] = s.boundingBox.bounds;
  return s.translate([-(min[0] + max[0]) / 2, -(min[1] + max[1]) / 2, -min[2]]) as T;
}

/**
 * Loads a previously-imported STL. The file bytes live in IndexedDB (see
 * blobStore.ts), keyed by blobId — the worker fetches them itself rather than
 * having the main thread ship the bytes over postMessage on every build.
 *
 * Uses importSTLAsMesh (manifold-3d), not importSTL (OCCT/BRep): the BRep
 * path hits a raw, uncatchable WebAssembly exception partway through solid
 * reconstruction in this WASM build — reproduced even round-tripping OCCT's
 * OWN STL export back through its OWN importer, so it is not a malformed-file
 * issue, it is this build. importSTLAsMesh sidesteps that path entirely.
 * See combine() for how this then composes with ordinary Shape3D primitives.
 *
 * Memoized by blobId (never a cache-miss twice for the same file): parsing +
 * manifold repair is the single most expensive step an import can trigger,
 * and blobId never changes for a node's lifetime, so every caller — the edit
 * view, the merged-result preview, export, or the same file imported more
 * than once — shares one parse instead of repeating it.
 */
const importCache = new Map<string, Promise<MeshShape>>();

async function makeImport(spec: ImportSpec): Promise<MeshShape> {
  let cached = importCache.get(spec.blobId);
  if (!cached) {
    cached = loadImport(spec.blobId);
    // A failed parse must not stick around as a poisoned cache entry — the
    // next attempt (e.g. after the user re-imports) should get a clean try.
    cached.catch(() => importCache.delete(spec.blobId));
    importCache.set(spec.blobId, cached);
  }
  return cached;
}

async function loadImport(blobId: string): Promise<MeshShape> {
  const bytes = await getBlob(blobId);
  if (!bytes) {
    throw new InvalidShapeError(
      "This imported file is missing from browser storage (site data may have been cleared).",
    );
  }
  const blob = new Blob([bytes], { type: "model/stl" });
  const shape = await importSTLAsMesh(blob);
  return normalise(shape);
}

/** True if a node or any of its descendants is an imported STL — those are
 *  MeshShapes, not Shape3Ds, so a group containing one anywhere below it must
 *  combine in MeshShape terms all the way up, not just at that one group. */
function hasImport(spec: NodeSpec): boolean {
  if (spec.type === "import") return true;
  if (spec.type === "group") return spec.children.some(hasImport);
  if (spec.type === "edit") return hasImport(spec.base);
  return false;
}

/**
 * Re-locates, on the CURRENT shape, the same planar face a PushPullOp was
 * created against — it cannot be addressed by index, since a later op's
 * target face is only created once earlier ops have already reshaped the
 * solid. "Same face" here means: still planar, facing the same way, lying
 * in the same plane as the point recorded when the op was made, AND that
 * point actually falling within (near) THIS face's own extent — not just
 * its infinite plane. That last check matters once a shape has had enough
 * edits done to it: two genuinely distinct faces (say, two separate walls
 * either side of a notch) can end up coplanar without being anywhere near
 * each other, and matching by plane distance alone picked whichever one
 * happened to be closest to the recorded point ALONG THE PLANE'S OWN
 * NORMAL — which says nothing about whether the point is anywhere near
 * that face's actual footprint. A generous 1mm pad on the bounding-box
 * check absorbs minor shifts from earlier ops in the sequence (this face
 * may have been slightly resized by one of them) without being loose
 * enough to also match a truly separate, merely-coplanar face — a real
 * failure mode this project actually hit (see the commit fixing this).
 * Still a plain nearest-match search, not true topological naming, and
 * still only sound as long as the base shape upstream of these ops never
 * itself changes (the deal a node makes once it has been pushed/pulled —
 * see EditNode in document/types.ts) — but considerably harder to fool.
 */
function findFace(solid: Shape3D, point: Vec3, normal: Vec3, tolerance = 0.05): Face | null {
  const FOOTPRINT_PAD = 1; // mm
  let best: Face | null = null;
  let bestDistance = Infinity;
  for (const face of solid.faces) {
    if (face.geomType !== "PLANE") continue;
    const c = face.center;
    const n = face.normalAt(c);
    const facing = n.x * normal[0] + n.y * normal[1] + n.z * normal[2];
    if (facing < 0.9) continue; // not (close enough to) the same outward direction
    const planeDistance = Math.abs(
      (point[0] - c.x) * n.x + (point[1] - c.y) * n.y + (point[2] - c.z) * n.z,
    );
    if (planeDistance > tolerance) continue;
    const [min, max] = face.boundingBox.bounds;
    const withinFootprint =
      point[0] >= min[0] - FOOTPRINT_PAD && point[0] <= max[0] + FOOTPRINT_PAD &&
      point[1] >= min[1] - FOOTPRINT_PAD && point[1] <= max[1] + FOOTPRINT_PAD &&
      point[2] >= min[2] - FOOTPRINT_PAD && point[2] <= max[2] + FOOTPRINT_PAD;
    if (!withinFootprint) continue;
    if (planeDistance < bestDistance) {
      bestDistance = planeDistance;
      best = face;
    }
  }
  return best;
}

/**
 * Extrudes `face` into a prism `distance` deep along its own outward normal
 * and fuses that volume into `solid` (pulling, distance > 0) or cuts it away
 * (pushing, distance < 0) — a push/pull.
 *
 * The prism is always built along the OUTWARD normal, even when pushing:
 * cutting wants the solid material sitting just inside the face, which is
 * the same prism mirrored, so a push extrudes inward (-normal) instead. Both
 * directions therefore start from the face itself and never leave a sliver
 * behind it.
 */
function pushPullFace(solid: Shape3D, face: Face, distance: number): Shape3D {
  if (Math.abs(distance) < 1e-6) return solid;
  const n = face.normalAt(face.center);
  const direction = new Vector([n.x, n.y, n.z]).normalized().multiply(distance);
  const prism = basicFaceExtrusion(face, direction) as Shape3D;
  return (distance > 0 ? solid.fuse(prism) : solid.cut(prism)) as Shape3D;
}

/** Push/pull fallback for a triangle-backed solid (non-uniformly scaled
 * groups and imports). The selected coplanar triangles are each extruded
 * into a closed triangular prism; composing them before the boolean avoids
 * changing unrelated facets of the mesh. */
function pushPullMesh(solid: MeshShape, op: PushPullOp): MeshShape | null {
  if (Math.abs(op.distance) < 1e-6) return solid;
  const raw = solid.mesh();
  const [nx, ny, nz] = op.normal;
  const manifold = getManifold();
  const points: number[][] = [];
  const pointIndex = new Map<string, number>();
  const selected: number[][] = [];
  const edges = new Map<string, { a: number; b: number; count: number }>();
  const candidates: { rawIds: number[]; centreDistance: number }[] = [];
  const canonical = (rawId: number) => {
    const i = rawId * 3;
    const point = [raw.vertices[i], raw.vertices[i + 1], raw.vertices[i + 2]];
    const key = `${Math.round(point[0] * 1e5)},${Math.round(point[1] * 1e5)},${Math.round(point[2] * 1e5)}`;
    let id = pointIndex.get(key);
    if (id === undefined) {
      id = points.length;
      points.push(point);
      pointIndex.set(key, id);
    }
    return id;
  };
  const addSelectedTriangle = (rawIds: number[]) => {
    const ids = rawIds.map(canonical);
    selected.push(ids);
    for (let edge = 0; edge < 3; edge++) {
      const a = ids[edge];
      const b = ids[(edge + 1) % 3];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const existing = edges.get(key);
      if (existing) existing.count++;
      else edges.set(key, { a, b, count: 1 });
    }
  };

  for (let offset = 0; offset < raw.triangles.length; offset += 3) {
    const ids = [raw.triangles[offset], raw.triangles[offset + 1], raw.triangles[offset + 2]];
    const ia = ids[0] * 3;
    const ib = ids[1] * 3;
    const ic = ids[2] * 3;
    const ab = [raw.vertices[ib] - raw.vertices[ia], raw.vertices[ib + 1] - raw.vertices[ia + 1], raw.vertices[ib + 2] - raw.vertices[ia + 2]];
    const ac = [raw.vertices[ic] - raw.vertices[ia], raw.vertices[ic + 1] - raw.vertices[ia + 1], raw.vertices[ic + 2] - raw.vertices[ia + 2]];
    const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const length = Math.hypot(...cross) || 1;
    const tx = cross[0] / length;
    const ty = cross[1] / length;
    const tz = cross[2] / length;
    const aligned = tx * nx + ty * ny + tz * nz > 0.9999;
    const onPlane = Math.abs((raw.vertices[ia] - op.point[0]) * nx + (raw.vertices[ia + 1] - op.point[1]) * ny + (raw.vertices[ia + 2] - op.point[2]) * nz) < 1e-3;
    if (aligned && onPlane) {
      const cx = (raw.vertices[ia] + raw.vertices[ib] + raw.vertices[ic]) / 3;
      const cy = (raw.vertices[ia + 1] + raw.vertices[ib + 1] + raw.vertices[ic + 1]) / 3;
      const cz = (raw.vertices[ia + 2] + raw.vertices[ib + 2] + raw.vertices[ic + 2]) / 3;
      candidates.push({ rawIds: ids, centreDistance: Math.hypot(cx - op.point[0], cy - op.point[1], cz - op.point[2]) });
    }
  }
  if (!candidates.length) return null;

  // Several disconnected faces can be coplanar. Only grow from the triangle
  // containing (or nearest to) the picked interior point; otherwise a pull on
  // one top patch also extrudes every separate patch on the same Z plane.
  const candidateEdges = new Map<string, number[]>();
  const rawPositionKey = (rawId: number) => {
    const i = rawId * 3;
    return `${Math.round(raw.vertices[i] * 1e5)},${Math.round(raw.vertices[i + 1] * 1e5)},${Math.round(raw.vertices[i + 2] * 1e5)}`;
  };
  candidates.forEach((candidate, index) => {
    for (let edge = 0; edge < 3; edge++) {
      const ka = rawPositionKey(candidate.rawIds[edge]);
      const kb = rawPositionKey(candidate.rawIds[(edge + 1) % 3]);
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const list = candidateEdges.get(key) ?? [];
      list.push(index);
      candidateEdges.set(key, list);
    }
  });
  const neighbours = Array.from({ length: candidates.length }, () => new Set<number>());
  for (const list of candidateEdges.values()) for (const a of list) for (const b of list) if (a !== b) neighbours[a].add(b);
  let seed = 0;
  for (let i = 1; i < candidates.length; i++) if (candidates[i].centreDistance < candidates[seed].centreDistance) seed = i;
  const queue = [seed];
  const visited = new Uint8Array(candidates.length);
  visited[seed] = 1;
  while (queue.length) {
    const index = queue.pop()!;
    addSelectedTriangle(candidates[index].rawIds);
    for (const next of neighbours[index]) if (!visited[next]) {
      visited[next] = 1;
      queue.push(next);
    }
  }

  // Manifold booleans are unreliable when the cutter starts exactly on the
  // target surface: the coincident triangles can survive as zero-thickness
  // sheets. Cross both ends by a tiny amount so this is an unambiguous
  // overlapping volume without changing the requested dimension visibly.
  const overlap = 1e-3;
  const baseOffset = op.distance > 0 ? -overlap : overlap;
  const endOffset = op.distance > 0 ? op.distance + overlap : op.distance - overlap;
  const vertices = points.flatMap(([x, y, z]) => [x + nx * baseOffset, y + ny * baseOffset, z + nz * baseOffset]);
  vertices.push(...points.flatMap(([x, y, z]) => [x + nx * endOffset, y + ny * endOffset, z + nz * endOffset]));
  const top = points.length;
  const triangles: number[] = [];
  // The prism is just an ordinary, outward-wound closed solid — the SAME
  // winding whether this is a pull (fuse) or a push (cut). It is only the
  // offsets above that decide which side of the original face the prism
  // occupies; solid.cut() already accounts for orientation internally when
  // subtracting, the same way any other cutting tool in this codebase does
  // (see pushPullFace's basicFaceExtrusion, which never flips winding by
  // sign either). An earlier version of this function additionally flipped
  // every triangle's winding for a negative distance, which double-negated
  // that internal handling and hands manifold-3d an inside-out cutting
  // tool — its boolean then does the wrong thing rather than failing loudly,
  // producing exactly the torn/sliver geometry this was reported as.
  for (const [a, b, c] of selected) {
    triangles.push(a, c, b, a + top, b + top, c + top);
  }
  for (const { a, b, count } of edges.values()) {
    if (count !== 1) continue;
    triangles.push(a, b, b + top, a, b + top, a + top);
  }
  const prism = new MeshShape(new manifold.Manifold(new manifold.Mesh({
    numProp: 3,
    vertProperties: Float32Array.from(vertices),
    triVerts: Uint32Array.from(triangles),
  })));
  return op.distance > 0 ? solid.fuse(prism) : solid.cut(prism);
}

/**
 * Builds the stable portion of a live push/pull preview: the edit's base and
 * every already-committed operation, excluding the tentative final operation
 * whose distance changes on every pointer move. The worker caches this solid
 * for the duration of a drag, which is especially important when the base is
 * a group whose children require several boolean operations to combine.
 */
export async function makePushPullPreviewBase(spec: EditSpec): Promise<Shape3D | null> {
  const base = await makeLocal(spec.base);
  if (!base || isMesh(base)) return null;

  let solid = base;
  for (const op of spec.ops.slice(0, -1)) {
    const face = findFace(solid, op.point, op.normal);
    if (!face) continue;
    solid = pushPullFace(solid, face, op.distance);
  }
  return solid;
}

/** Applies only the changing final operation to a cached preview base. */
export function applyPushPullPreview(base: Shape3D, op: PushPullOp): Shape3D | null {
  const face = findFace(base, op.point, op.normal);
  return face ? pushPullFace(base, face, op.distance) : null;
}

async function makeEdit(
  spec: EditSpec,
  onError?: (id: string, msg: string) => void,
  onProgress?: (id: string) => void,
): Promise<AnySolid | null> {
  const base = await makeLocal(spec.base, onError, onProgress);
  if (!base) return null;

  // A skipped op, not an aborted chain: stopping here entirely (as this
  // once did) meant one unrecoverable op anywhere in the history — from an
  // edit made before findFace() got more precise, say — permanently froze
  // every op AFTER it too, including any brand new one a user tries to add
  // going forward (this is exactly the bug behind a report of "the shape
  // doesn't resize while dragging, then fails on release": the live preview
  // and the real commit both append the new op at the END of the list, so
  // both silently never got past the earlier failure to even try it).
  // Skipping instead means the object stays editable — go-forward edits
  // keep working — while still surfacing the same error for whichever op
  // could not be replayed.
  let solid = base;
  for (const op of spec.ops) {
    if (isMesh(solid)) {
      const edited = pushPullMesh(solid, op);
      if (!edited) onError?.(spec.id, "A pushed/pulled face could not be found after rebuilding — try redoing that edit.");
      else solid = edited;
      continue;
    }
    const face = findFace(solid, op.point, op.normal);
    if (!face) {
      onError?.(
        spec.id,
        "A pushed/pulled face could not be found after rebuilding — try redoing that edit.",
      );
      continue;
    }
    solid = pushPullFace(solid, face, op.distance);
  }
  return solid;
}

/**
 * Replays spec.ops the same way makeEdit() does and returns just the ones
 * that actually found their face — an op that fails here never can succeed
 * again (the face it targeted is permanently gone; nothing about a LATER
 * edit brings it back), so unlike makeEdit() itself, which skips a dead op
 * but leaves it in place to keep re-failing and re-reporting the same error
 * on every future rebuild forever, this is what lets the app permanently
 * drop it from the node's own ops list instead — see the "Remove broken
 * edit" action wired to this in the app layer. Mirrors makeEdit()'s replay
 * loop exactly; kept as a separate function rather than a flag on makeEdit
 * so that function's existing, already-verified behaviour is untouched.
 */
export async function survivingOps(
  spec: EditSpec,
  onError?: (id: string, msg: string) => void,
  onProgress?: (id: string) => void,
): Promise<PushPullOp[]> {
  const base = await makeLocal(spec.base, onError, onProgress);
  if (!base || isMesh(base)) return spec.ops; // nothing to replay against — leave as-is
  let solid = base;
  const kept: PushPullOp[] = [];
  for (const op of spec.ops) {
    const face = findFace(solid, op.point, op.normal);
    if (!face) continue;
    solid = pushPullFace(solid, face, op.distance);
    kept.push(op);
  }
  return kept;
}

/**
 * Combines already-placed children. Children keep their own world transforms,
 * so a group introduces no frame of its own beyond its node transform.
 *
 * If nothing here is (or contains) an import, this runs entirely in Shape3D/
 * OCCT terms, unchanged from before imports existed. The moment an import is
 * involved, EVERY operand is converted to MeshShape first (Shape3D.meshShape()
 * is a direct, supported conversion) and the whole boolean runs on manifold-3d
 * instead — never the other direction, which is the broken path.
 */
export function combine(
  op: GroupOp,
  children: { solid: AnySolid; isHole: boolean }[],
): AnySolid | null {
  if (!children.length) return null;

  if (children.some((c) => isMesh(c.solid))) {
    const meshed = children.map((c) => ({
      solid: isMesh(c.solid) ? c.solid : (c.solid as Shape3D).meshShape(),
      isHole: c.isHole,
    }));
    return combineMesh(op, meshed);
  }
  return combineShape(op, children as { solid: Shape3D; isHole: boolean }[]);
}

function combineShape(
  op: GroupOp,
  children: { solid: Shape3D; isHole: boolean }[],
): Shape3D | null {
  if (op === "subtract") {
    let result = children[0].solid;
    for (let i = 1; i < children.length; i++) result = result.cut(children[i].solid) as Shape3D;
    return result;
  }
  if (op === "intersect") {
    let result = children[0].solid;
    for (let i = 1; i < children.length; i++) {
      result = result.intersect(children[i].solid) as Shape3D;
    }
    return result;
  }
  const solids = children.filter((c) => !c.isHole);
  const holes = children.filter((c) => c.isHole);
  if (!solids.length) return null;
  let result = solids[0].solid;
  for (let i = 1; i < solids.length; i++) result = result.fuse(solids[i].solid) as Shape3D;
  for (const h of holes) result = result.cut(h.solid) as Shape3D;
  return result;
}

/** Same three ops, run through manifold-3d instead of OCCT — used whenever an
 *  import is anywhere in the operands. */
function combineMesh(
  op: GroupOp,
  children: { solid: MeshShape; isHole: boolean }[],
): MeshShape | null {
  if (op === "subtract") {
    let result = children[0].solid;
    for (let i = 1; i < children.length; i++) result = result.cut(children[i].solid);
    return result;
  }
  if (op === "intersect") {
    let result = children[0].solid;
    for (let i = 1; i < children.length; i++) result = result.intersect(children[i].solid);
    return result;
  }
  const solids = children.filter((c) => !c.isHole);
  const holes = children.filter((c) => c.isHole);
  if (!solids.length) return null;
  let result = solids[0].solid;
  for (let i = 1; i < solids.length; i++) result = result.fuse(solids[i].solid);
  for (const h of holes) result = result.cut(h.solid);
  return result;
}

type GroupOp = "union" | "subtract" | "intersect";

/** Applies rotation (about the node origin) then translation. Works on either
 *  kernel's solid — both expose the same translate/rotate signatures. */
export function place(s: AnySolid, spec: NodeSpec): AnySolid {
  const [rx, ry, rz] = spec.rotation;
  let out = s;
  if (spec.scale.some((v) => v !== 1)) {
    const [min, max] = out.boundingBox.bounds;
    const center: Vec3 = [
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2,
    ];
    const [sx, sy, sz] = spec.scale;
    if (Math.abs(sx - sy) < 1e-9 && Math.abs(sx - sz) < 1e-9) {
      out = out.scale(sx, center);
    } else {
      const mesh = isMesh(out) ? out : out.meshShape();
      const transformed = mesh.wrapped
        .translate([-center[0], -center[1], -center[2]])
        .scale(spec.scale)
        .translate(center);
      out = new MeshShape(transformed);
    }
  }
  if (rx) out = out.rotate(rx, [0, 0, 0], [1, 0, 0]);
  if (ry) out = out.rotate(ry, [0, 0, 0], [0, 1, 0]);
  if (rz) out = out.rotate(rz, [0, 0, 0], [0, 0, 1]);
  return out.translate(spec.position);
}

/**
 * Cheap sanity checks that catch a silently-failed boolean:
 *  - a union can never be smaller than its largest operand;
 *  - a subtraction that removes *everything* is usually a failure, though it
 *    can legitimately happen when the first child is fully enclosed.
 * Only meaningful for the Shape3D/OCCT path — the sphere-seam bug this guards
 * against is an OCCT quirk; manifold-3d's booleans do not have it.
 */
function suspicious(
  op: GroupOp,
  result: AnySolid,
  kids: { solid: AnySolid; isHole: boolean }[],
): boolean {
  if (isMesh(result)) return false;
  try {
    const volume = measureVolume(result);
    if (op === "union") {
      if (kids.some((k) => k.isHole)) return false;
      const largest = Math.max(...kids.map((k) => measureVolume(k.solid as Shape3D)));
      return volume < largest - 1e-6;
    }
    if (op === "subtract") return volume <= 1e-9;
    return false;
  } catch {
    return true;
  }
}

/** Spins a sphere about its own axis: geometrically identical, but it moves
 *  the seam meridian, which is what OCCT actually trips over. */
function respin(spec: NodeSpec): NodeSpec {
  if (spec.type !== "object" || spec.kind !== "sphere") return spec;
  const [rx, ry, rz] = spec.rotation;
  return { ...spec, rotation: [rx, ry, rz + 90] as Vec3 };
}

/**
 * A node in its own frame, before its transform is applied.
 * Leaves are normalised primitives or imports; groups are their evaluated
 * children. Returns null when a group has nothing solid to show.
 *
 * onProgress, when given, fires with a node's id right before that node's
 * OWN work starts (not for groups themselves — their children each report).
 * It exists so a caller racing this against a watchdog timeout (see
 * kernel/client.ts) can tell which node was actually in flight when a call
 * had to be abandoned — an import's mesh-repair step is the one piece of
 * this pipeline that can legitimately run long enough to matter.
 */
export async function makeLocal(
  spec: NodeSpec,
  onError?: (id: string, msg: string) => void,
  onProgress?: (id: string) => void,
): Promise<AnySolid | null> {
  if (spec.type === "object") {
    onProgress?.(spec.id);
    return makePrimitive(spec);
  }
  if (spec.type === "import") {
    onProgress?.(spec.id);
    return makeImport(spec);
  }
  if (spec.type === "edit") {
    onProgress?.(spec.id);
    return makeEdit(spec, onError, onProgress);
  }

  const build = async (spin: boolean, report?: (id: string, msg: string) => void) => {
    const kids: { solid: AnySolid; isHole: boolean }[] = [];
    for (const child of spec.children) {
      try {
        const solid = await makeWorld(spin ? respin(child) : child, report, onProgress);
        if (solid) kids.push({ solid, isHole: child.isHole });
      } catch (e) {
        report?.(child.id, e instanceof Error ? e.message : String(e));
      }
    }
    return kids;
  };

  const kids = await build(false, onError);
  const result = combine(spec.op, kids);
  if (!result || !suspicious(spec.op, result, kids)) return result;

  // Known OCCT weakness: a sphere's seam meridian crossing the other shape's
  // boundary makes the boolean return an invalid solid. Spinning the seam away
  // is a no-op geometrically and fixes it — so it is only worth retrying when
  // there is actually a sphere involved. (suspicious() already short-circuits
  // to false for MeshShape results, so this never fires on the import path.)
  const hasSphere = spec.children.some((c) => c.type === "object" && c.kind === "sphere");
  if (hasSphere) {
    const retryKids = await build(true);
    const retry = combine(spec.op, retryKids);
    if (retry && !suspicious(spec.op, retry, retryKids)) return retry;
  }

  if (spec.op === "union") {
    onError?.(spec.id, "This union produced an invalid solid — try moving or rotating a part.");
  }
  return result;
}

/** A node placed into its parent's frame. */
export async function makeWorld(
  spec: NodeSpec,
  onError?: (id: string, msg: string) => void,
  onProgress?: (id: string) => void,
): Promise<AnySolid | null> {
  const local = await makeLocal(spec, onError, onProgress);
  return local ? place(local, spec) : null;
}

export { hasImport, isMesh };
