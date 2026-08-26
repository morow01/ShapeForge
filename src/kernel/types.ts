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

/** One flat (planar) face of a top-level part, in the part's own local
 *  frame — everything push/pull needs to let the viewport show a handle on
 *  it and, from a click there, describe a PushPullOp back to the kernel.
 *  Curved faces (a cylinder's side, say) are omitted entirely: there is no
 *  single well-defined push/pull direction for those. */
export interface FaceInfo {
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
