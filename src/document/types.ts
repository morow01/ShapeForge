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

const dim = (key: string, label: string, max = 200): ParamField => ({
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
      { key: "fillet", label: "Corner radius", min: 0, max: 20, step: 0.5 },
    ],
  },
  cylinder: {
    label: "Cylinder",
    defaults: { radius: 10, height: 20 },
    fields: [dim("radius", "Radius", 100), dim("height", "Height")],
  },
  sphere: {
    label: "Sphere",
    defaults: { radius: 10 },
    fields: [dim("radius", "Radius", 100)],
  },
  cone: {
    label: "Cone",
    defaults: { bottomRadius: 10, topRadius: 0, height: 20 },
    fields: [
      { key: "bottomRadius", label: "Bottom radius", min: 0, max: 100, step: 0.5 },
      { key: "topRadius", label: "Top radius", min: 0, max: 100, step: 0.5 },
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
      dim("thickness", "Thickness", 100),
    ],
  },
};

/** Fields visible for the current parameter values. */
export function visibleFields(def: PrimitiveDef, params: Record<string, number>): ParamField[] {
  return def.fields.filter((f) => !f.showIf || f.showIf.oneOf.includes(params[f.showIf.key]));
}

export type Vec3 = [number, number, number];

/** How a group combines its children. */
export type BooleanOp = "union" | "subtract" | "intersect";

export const BOOLEAN_OPS: { value: BooleanOp; label: string; hint: string }[] = [
  { value: "union", label: "Union", hint: "Merge children; holes cut the solids" },
  { value: "subtract", label: "Subtract", hint: "First child minus all the rest" },
  { value: "intersect", label: "Intersect", hint: "Keep only the overlapping volume" },
];

interface NodeBase {
  id: string;
  name: string;
  /** Position of the node's origin, in mm. */
  position: Vec3;
  /** Euler angles in degrees, applied X then Y then Z about the origin. */
  rotation: Vec3;
  /** TinkerCAD-style hole: subtracts from its siblings instead of adding. */
  isHole: boolean;
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
}

export type SceneNode = ObjectNode | GroupNode | ImportNode;

export const isGroup = (n: SceneNode): n is GroupNode => n.type === "group";
