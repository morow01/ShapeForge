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
  if (isMesh(base)) {
    onError?.(spec.id, "Push/pull isn't supported on an imported mesh.");
    return base;
  }

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
