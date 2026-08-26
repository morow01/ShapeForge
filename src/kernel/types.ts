import type { BooleanOp, PrimitiveKind, PushPullOp, Vec3 } from "../document/types";

/** Typed arrays keep large imported scans compact while structured-cloning
 *  efficiently across the worker boundary. Replicad's own meshes use arrays. */
export type NumericArray = number[] | Float32Array | Uint32Array;

export interface MeshedFaces {
  vertices: NumericArray;
  triangles: NumericArray;
  normals: NumericArray;
  faceGroups: { start: number; count: number; faceId: number }[];
}

export interface MeshedEdges {
  lines: NumericArray;
  edgeGroups: { start: number; count: number; edgeId: number }[];
}

export interface KernelMesh {
  name: string;
  faces: MeshedFaces;
  edges: MeshedEdges;
}

interface SpecBase {
  id: string;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  isHole: boolean;
}

/** The subset of a scene node the kernel needs — no display concerns, so
 *  renaming or collapsing a node never triggers a rebuild. */
export interface ObjectSpec extends SpecBase {
  type: "object";
  kind: PrimitiveKind;
  params: Record<string, number>;
}

export interface GroupSpec extends SpecBase {
  type: "group";
  op: BooleanOp;
  children: NodeSpec[];
}

export interface ImportSpec extends SpecBase {
  type: "import";
  blobId: string;
}

export interface EditSpec extends SpecBase {
  type: "edit";
  base: NodeSpec;
  ops: PushPullOp[];
}

export type NodeSpec = ObjectSpec | GroupSpec | ImportSpec | EditSpec;

/** One face of a top-level part, in the part's own local frame — everything
 *  the viewport needs to let a click directly on the 3D geometry highlight
 *  and, for a planar one, push/pull it into a PushPullOp back to the kernel.
 *  Curved faces (a cylinder's side, say) are included too, so hovering one
 *  still highlights it the way Shapr3D does — there just isn't a single
 *  well-defined push/pull direction for those, so `planar` gates that.
 *
 * This array's ORDER matches the mesh's own faceGroups order (both are built
 * by walking the same solid's s.faces list — see faceInfoOf() in worker.ts),
 * so the viewport resolves "the pointer hit this triangle" to "which
 * FaceInfo is that" via getFaceIndex()'s group index used as a plain array
 * position into this list — not by matching any id. The mesh's own
 * faceGroups[].faceId is some OCCT-internal value (confirmed empirically:
 * not a small sequential index), so it is deliberately not carried here or
 * relied on for that correlation. */
export interface FaceInfo {
  planar: boolean;
  point: Vec3;
  normal: Vec3;
}

export interface ScenePart {
  id: string;
  isHole: boolean;
  mesh: KernelMesh;
  /** Omitted for parts with no OCCT topology (an import, or anything a
   *  MeshShape boolean touched) — push/pull just has nothing to offer there. */
  faces?: FaceInfo[];
}

/** A node whose parameters cannot describe a real solid. */
export interface BuildError {
  id: string;
  message: string;
}

export interface SceneBuild {
  parts: ScenePart[];
  errors: BuildError[];
  buildMs: number;
}

export interface ResultBuild {
  mesh: KernelMesh | null;
  volume: number;
  faceCount: number;
  errors: BuildError[];
  buildMs: number;
}
