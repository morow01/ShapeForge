import type { BooleanOp, EditOp, PrimitiveKind, Vec3 } from "../document/types";
import type { SvgCommand } from "../svg/parse";

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
  text?: string;
  fontName?: string;
  textPaths?: SvgCommand[][];
}

export interface GroupSpec extends SpecBase {
  type: "group";
  op: BooleanOp;
  children: NodeSpec[];
}

export interface ImportSpec extends SpecBase {
  type: "import";
  blobId: string;
  /** See ImportNode.svg — vector artwork, extruded rather than meshed. */
  svg?: { thickness: number };
}

export interface EditSpec extends SpecBase {
  type: "edit";
  base: NodeSpec;
  ops: EditOp[];
}

/** See BuildNode: frozen sources plus the cell masks to keep. */
export interface BuildSpec extends SpecBase {
  type: "build";
  sources: NodeSpec[];
  keep: number[];
}

export type NodeSpec = ObjectSpec | GroupSpec | ImportSpec | EditSpec | BuildSpec;

/** One piece of a Shape Builder decomposition, ready to show and click. */
export interface CellPart {
  mask: number;
  mesh: KernelMesh;
}

/** How finely an STL export tessellates curved faces. The actual tolerances
 *  live in worker.ts (EXPORT_PRESETS) next to the reasoning about them; only
 *  the choice travels across the worker boundary. */
export type ExportQuality = "draft" | "standard" | "fine";

/** One face of a top-level part, in the part's own local frame — everything
 *  the viewport needs to let a click directly on the 3D geometry highlight
 *  and, for a planar one, push/pull it into a PushPullOp back to the kernel.
 *  Curved faces (a cylinder's side, say) are included too, so hovering one
 *  still highlights it the way Shapr3D does — there just isn't a single
 *  well-defined push/pull direction for those, so `planar` gates that.
 *
 * This array's ORDER is explicitly aligned to the rendered mesh's
 * faceGroups (see faceInfoOf() in worker.ts). Its point, normal and planar
 * state are derived from the same triangles the viewport raycasts, avoiding
 * topology-order differences after angled booleans. */
export interface FaceInfo {
  planar: boolean;
  /** False only when a face can be highlighted but has no extrusion path. */
  pushPullable?: boolean;
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

/** A verified viewport mesh paired with the document transform/hole metadata
 * needed to reproduce the visible scene without rebuilding its CAD history. */
export interface DisplayedSceneItem {
  spec: NodeSpec;
  mesh: KernelMesh;
}

/** A node whose parameters cannot describe a real solid. */
export interface BuildError {
  id: string;
  message: string;
}

/** Prefix of worker.ts's "could not be rebuilt reliably" message — a node
 *  whose boolean genuinely failed on every retry within the SAME kernel
 *  worker. Measured on a reported case: the exact same geometry (byte-for-
 *  byte identical node data) failed deterministically for several minutes
 *  in one worker session, then succeeded deterministically every time in a
 *  freshly spawned one — so retrying against the SAME worker again, which is
 *  all buildScene's own internal attempts and App.tsx's one-shot recovery
 *  do, cannot help. client.ts's buildScene wrapper watches for this prefix
 *  and gives the rebuild one attempt against a fresh worker before handing
 *  the error to the UI. Shared here (rather than each site owning its own
 *  copy of the literal) because the match silently stops working the moment
 *  any one of them drifts from worker.ts's actual wording. */
export const RETRYABLE_MESH_ERROR = "This shape could not be rebuilt reliably.";

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

/** A live push/pull preview sample — see previewLocal() in worker.ts. Faces
 *  ride along so the push/pull arrow can reposition immediately from this,
 *  rather than sitting stale until the next real, committed rebuild. */
export interface PreviewBuild {
  mesh: KernelMesh;
  faces?: FaceInfo[];
}
