export { TRI_BY_SIDES, TRI_BY_ANGLES, TRI_BY_SIDE_ANGLE } from "../geometry/triangle";
import { TRI_BY_SIDES, TRI_BY_ANGLES, TRI_BY_SIDE_ANGLE } from "../geometry/triangle";

export type PrimitiveKind = "box" | "cylinder" | "sphere" | "cone" | "triangle";

export interface ParamField {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Present => render a dropdown instead of a slider. */
  options?: { value: number; label: string }[];
  /** Only show this field when another param holds one of these values. */
  showIf?: { key: string; oneOf: number[] };
  /** Appended to the numeric input label, e.g. "°". */
  suffix?: string;
}

export interface PrimitiveDef {
  label: string;
  defaults: Record<string, number>;
  fields: ParamField[];
}

const dim = (key: string, label: string, max = 1000): ParamField => ({
  key,
  label,
  min: 1,
  max,
  step: 0.5,
});

const angle = (key: string, label: string, showIf?: ParamField["showIf"]): ParamField => ({
  key,
  label,
  min: 1,
  max: 178,
  step: 1,
  suffix: "°",
  showIf,
});

const onlyIn = (...modes: number[]) => ({ key: "mode", oneOf: modes });

export const PRIMITIVES: Record<PrimitiveKind, PrimitiveDef> = {
  box: {
    label: "Box",
    defaults: { width: 20, depth: 20, height: 20, fillet: 0 },
    fields: [
      dim("width", "Width"),
      dim("depth", "Depth"),
      dim("height", "Height"),
      { key: "fillet", label: "Corner radius", min: 0, max: 500, step: 0.5 },
    ],
  },
  cylinder: {
    label: "Cylinder",
    defaults: { radius: 10, height: 20 },
    fields: [dim("radius", "Radius"), dim("height", "Height")],
  },
  sphere: {
    label: "Sphere",
    defaults: { radius: 10 },
    fields: [dim("radius", "Radius")],
  },
  cone: {
    label: "Cone",
    defaults: { bottomRadius: 10, topRadius: 0, height: 20 },
    fields: [
      { key: "bottomRadius", label: "Bottom radius", min: 0, max: 1000, step: 0.5 },
      { key: "topRadius", label: "Top radius", min: 0, max: 1000, step: 0.5 },
      dim("height", "Height"),
    ],
  },
  triangle: {
    label: "Triangle",
    // Defaults describe the same 30-40-50 right triangle in every mode, so
    // switching between them does not jump the shape around.
    defaults: {
      mode: TRI_BY_SIDES,
      base: 40,
      sideLeft: 30,
      sideRight: 50,
      // In TRI_BY_ANGLES these three always sum to 180; editing one rebalances
      // the others. In TRI_BY_SIDE_ANGLE only angleLeft is used, independently.
      angleLeft: 90,
      angleRight: 36.87,
      angleApex: 53.13,
      thickness: 5,
    },
    fields: [
      {
        key: "mode",
        label: "Define by",
        min: 0,
        max: 2,
        step: 1,
        options: [
          { value: TRI_BY_SIDES, label: "Three sides" },
          { value: TRI_BY_SIDE_ANGLE, label: "Two sides + angle" },
          { value: TRI_BY_ANGLES, label: "Angles" },
        ],
      },
      dim("base", "Base"),
      { ...dim("sideLeft", "Left side"), showIf: onlyIn(TRI_BY_SIDES, TRI_BY_SIDE_ANGLE) },
      { ...dim("sideRight", "Right side"), showIf: onlyIn(TRI_BY_SIDES) },
      angle("angleLeft", "Angle between them", onlyIn(TRI_BY_SIDE_ANGLE)),
      angle("angleLeft", "Left corner", onlyIn(TRI_BY_ANGLES)),
      angle("angleRight", "Right corner", onlyIn(TRI_BY_ANGLES)),
      angle("angleApex", "Apex corner", onlyIn(TRI_BY_ANGLES)),
      dim("thickness", "Thickness"),
    ],
  },
};

/** Fields visible for the current parameter values. */
export function visibleFields(def: PrimitiveDef, params: Record<string, number>): ParamField[] {
  return def.fields.filter((f) => !f.showIf || f.showIf.oneOf.includes(params[f.showIf.key]));
}

export type Vec3 = [number, number, number];

export type CameraMode = "perspective" | "orthographic";

/** How a group combines its children. */
export type BooleanOp = "union" | "subtract" | "intersect";

export const BOOLEAN_OPS: { value: BooleanOp; label: string; hint: string }[] = [
  { value: "union", label: "Union", hint: "Merge children; holes cut the solids" },
  { value: "subtract", label: "Subtract", hint: "First child minus all the rest" },
  { value: "intersect", label: "Intersect", hint: "Keep only the overlapping volume" },
];

export const DEFAULT_OBJECT_COLOR = "#43aede";

export interface ColorPreset {
  hex: string;
  name: string;
}

export const TINKERCAD_COLORS: ColorPreset[] = [
  // Warm Reds & Oranges
  { hex: "#e74c3c", name: "Red" },
  { hex: "#c0392b", name: "Dark Red" },
  { hex: "#e67e22", name: "Orange" },
  { hex: "#f39c12", name: "Amber" },
  { hex: "#f1c40f", name: "Yellow" },
  { hex: "#d4ac0d", name: "Gold" },

  // Greens
  { hex: "#a3e048", name: "Lime" },
  { hex: "#2ecc71", name: "Light Green" },
  { hex: "#27ae60", name: "Green" },
  { hex: "#16a085", name: "Teal" },
  { hex: "#1abc9c", name: "Mint" },
  { hex: "#00b894", name: "Emerald" },

  // Blues & Cyans
  { hex: "#43aede", name: "ShapeForge Cyan" },
  { hex: "#3498db", name: "Sky Blue" },
  { hex: "#2980b9", name: "Blue" },
  { hex: "#1f4ba6", name: "Dark Blue" },
  { hex: "#34495e", name: "Navy" },
  { hex: "#6c5ce7", name: "Indigo" },

  // Purples & Pinks
  { hex: "#9b59b6", name: "Purple" },
  { hex: "#8e44ad", name: "Dark Purple" },
  { hex: "#e056fd", name: "Magenta" },
  { hex: "#fd79a8", name: "Pink" },
  { hex: "#ff7675", name: "Coral" },
  { hex: "#fab1a0", name: "Peach" },

  // Earth & Neutrals
  { hex: "#e0cda9", name: "Sand" },
  { hex: "#a0522d", name: "Brown" },
  { hex: "#5c3a21", name: "Dark Brown" },
  { hex: "#ffffff", name: "White" },
  { hex: "#bdc3c7", name: "Light Grey" },
  { hex: "#7f8c8d", name: "Grey" },
  { hex: "#2c3e50", name: "Charcoal" },
  { hex: "#1e272e", name: "Black" },
];

interface NodeBase {
  id: string;
  name: string;
  /** Position of the node's origin, in mm. */
  position: Vec3;
  /** Euler angles in degrees, applied X then Y then Z about the origin. */
  rotation: Vec3;
  /** Independent X/Y/Z size multipliers. */
  scale: Vec3;
  /** TinkerCAD-style hole: subtracts from its siblings instead of adding. */
  isHole: boolean;
  /** Hex color for solid rendering, defaults to DEFAULT_OBJECT_COLOR (#43aede). */
  color?: string;
  /** Whether the solid object is rendered with translucency. */
  transparent?: boolean;
}

export interface ObjectNode extends NodeBase {
  type: "object";
  kind: PrimitiveKind;
  params: Record<string, number>;
}

export interface GroupNode extends NodeBase {
  type: "group";
  op: BooleanOp;
  children: SceneNode[];
  collapsed?: boolean;
}

/** An imported STL. The file bytes live in IndexedDB (see blobStore.ts) keyed
 *  by blobId — never inline here, so the document itself (autosaved to
 *  localStorage) stays small no matter how many/how large the imports are. */
export interface ImportNode extends NodeBase {
  type: "import";
  blobId: string;
  fileName: string;
  byteSize: number;
  /**
   * Present when the import came from vector artwork rather than a mesh. The
   * blob then holds millimetre outlines (see svg/parse.ts), not STL bytes,
   * and the solid is those outlines extruded — so thickness stays editable
   * and the artwork keeps the size its artboard gave it.
   */
  svg?: { thickness: number; width: number; height: number };
}

/** One push/pull: a face on the (frozen) base shape, identified by a point
 *  and outward normal in the base's own local frame — not by index, since
 *  a later op's face only exists after earlier ops have already run — and
 *  a signed distance along that normal (positive adds material, negative
 *  removes it). Re-locating "the same" face after a rebuild is a nearest-
 *  match search (see findFace() in kernel/shape.ts), so it only works
 *  reliably on flat (planar) faces — the only kind push/pull targets. */
export interface PushPullOp {
  kind?: "pushPull";
  point: Vec3;
  normal: Vec3;
  distance: number;
}

/** A fillet or chamfer applied to the edge containing `point`. The point is
 * stored instead of a topology index so the edit can be found again when the
 * model is rebuilt. */
export interface EdgeOp {
  kind: "fillet" | "chamfer";
  /** Legacy single-edge anchor, retained for saved-project compatibility. */
  point: Vec3;
  /** One stable interior point per selected edge. */
  points?: Vec3[];
  distance: number;
}

export type EditOp = PushPullOp | EdgeOp;

/**
 * A shape produced by pushing/pulling a face of an ordinary object or group.
 * That is no longer expressible as primitive parameters, so — like an
 * imported STL — it stops being parametrically editable: `base` is a frozen
 * snapshot of whatever it was built from (at the local origin, unrotated,
 * unscaled — this node's own position/rotation/scale now own its placement,
 * same split as every other node type), and `ops` replay on top of it, in
 * order, on every rebuild.
 */
export interface EditNode extends NodeBase {
  type: "edit";
  base: ObjectNode | GroupNode;
  ops: EditOp[];
}

/**
 * The result of the Shape Builder: overlapping solids cut into the pieces
 * their boundaries divide space into, with a chosen subset kept.
 *
 * A "cell" is one such piece, named by a bitmask over `sources` in order:
 * bit i set means source i contains it. So with two sources, 0b01 is
 * A-minus-B, 0b10 is B-minus-A, and 0b11 is their overlap — every boolean of
 * the two is some combination of the three, which is exactly what makes one
 * click-and-alt-click gesture able to express union, subtract and intersect.
 *
 * Like an EditNode this freezes what it was built from, so it stays
 * rebuildable (and the kept set stays revisitable) instead of collapsing to
 * an opaque mesh. Sources keep the placements they had relative to each
 * other — they have to, since the overlap is the whole point — and this
 * node's own transform applies on top, exactly as a group's does.
 */
export interface BuildNode extends NodeBase {
  type: "build";
  sources: SceneNode[];
  /** Cell masks to keep. Empty means nothing survived, which the UI prevents. */
  keep: number[];
}

export type SceneNode = ObjectNode | GroupNode | ImportNode | EditNode | BuildNode;

/** Every cell mask over `count` sources: 1 .. 2^count - 1. */
export function cellMasks(count: number): number[] {
  return Array.from({ length: (1 << count) - 1 }, (_, i) => i + 1);
}

/** Cap on sources in one Shape Builder operation: cells grow as 2^n - 1, and
 *  every one of them costs booleans to find. Four gives 15, which is already
 *  more regions than anyone can keep track of on screen. */
export const MAX_BUILD_SOURCES = 4;

export const isGroup = (n: SceneNode): n is GroupNode => n.type === "group";

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  objectCount: number;
}

export interface ProjectData {
  version: number;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  nodes: SceneNode[];
  camera?: {
    mode: CameraMode;
    position: Vec3;
    target: Vec3;
    zoom?: number;
  } | null;
}

export interface ProjectFile {
  format: "shapeforge";
  version: number;
  id?: string;
  name: string;
  exportedAt: number;
  nodes: SceneNode[];
  camera?: {
    mode: CameraMode;
    position: Vec3;
    target: Vec3;
    zoom?: number;
  } | null;
}
