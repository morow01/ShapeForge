import type { BooleanOp, PrimitiveKind, Vec3 } from "../document/types";

/** Mesh payloads crossing the worker boundary. All plain arrays, so they
 *  structured-clone without any special handling. */
export interface MeshedFaces {
  vertices: number[];
  triangles: number[];
  normals: number[];
  faceGroups: { start: number; count: number; faceId: number }[];
}

export interface MeshedEdges {
  lines: number[];
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

export type NodeSpec = ObjectSpec | GroupSpec;

export interface ScenePart {
  id: string;
  isHole: boolean;
  mesh: KernelMesh;
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
