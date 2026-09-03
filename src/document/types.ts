export { TRI_BY_SIDES, TRI_BY_ANGLES, TRI_BY_SIDE_ANGLE } from "../geometry/triangle";
import { TRI_BY_SIDES, TRI_BY_ANGLES, TRI_BY_SIDE_ANGLE } from "../geometry/triangle";

export type PrimitiveKind =
  | "box"
  | "cylinder"
  | "sphere"
  | "cone"
  | "triangle"
  | "torus"
  | "pyramid"
  | "wedge"
  | "polygonPrism"
  | "hemisphere"
  | "capsule"
  | "tube"
  | "paraboloid"
  | "text"
  | "connector"
  | "threadedRod"
  | "threadedNut"
  | "star"
  | "tray"
  | "ellipsoid";

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
  /** True hides the range slider, leaving just the number field. Set on
   *  precise structural dimensions (width, radius, thickness, …) — a
   *  drag-to-approximate slider actively fights typing an exact value a
   *  print needs to fit something, and a 1000mm-range track makes every
   *  pixel of drag worth several millimetres besides. Left on (the
   *  default) for a proportional/aesthetic parameter like corner radius or
   *  a triangle's angles, where dragging to see the shape update live is
   *  actually the point and being a fraction of a unit off rarely matters
   *  the way a structural dimension does. */
  noSlider?: boolean;
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
  noSlider: true,
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
    defaults: { width: 20, depth: 20, height: 20, fillet: 0, filletMode: 0 },
    fields: [
      dim("width", "Width"),
      dim("depth", "Depth"),
      dim("height", "Height"),
      { key: "fillet", label: "Corner radius", min: 0, max: 500, step: 0.5 },
      {
        key: "filletMode",
        label: "Round",
        min: 0,
        max: 1,
        step: 1,
        options: [
          { value: 0, label: "Side edges" },
          { value: 1, label: "Every edge" },
        ],
      },
    ],
  },
  cylinder: {
    label: "Cylinder",
    defaults: { radius: 10, height: 20, sides: 48, sideEdges: 0, topFillet: 0, bottomFillet: 0 },
    fields: [
      dim("radius", "Radius"),
      dim("height", "Height"),
      { key: "sides", label: "Roundness", min: 8, max: 96, step: 1 },
      {
        key: "sideEdges",
        label: "Side lines",
        min: 0,
        max: 1,
        step: 1,
        options: [
          { value: 0, label: "Hidden" },
          { value: 1, label: "Shown" },
        ],
      },
      { key: "topFillet", label: "Top corner radius", min: 0, max: 500, step: 0.5 },
      { key: "bottomFillet", label: "Bottom corner radius", min: 0, max: 500, step: 0.5 },
    ],
  },
  sphere: {
    label: "Sphere",
    defaults: { radius: 10, surfaceSteps: 48, surfaceEdges: 0 },
    fields: [
      dim("radius", "Radius"),
      { key: "surfaceSteps", label: "Surface steps", min: 8, max: 64, step: 1 },
      {
        key: "surfaceEdges", label: "Surface lines", min: 0, max: 1, step: 1,
        options: [{ value: 0, label: "Hidden" }, { value: 1, label: "Shown" }],
      },
    ],
  },
  cone: {
    label: "Cone",
    defaults: {
      bottomRadius: 10, topRadius: 0, height: 20, sides: 48, sideEdges: 0,
      topFillet: 0, bottomFillet: 0,
    },
    fields: [
      { key: "bottomRadius", label: "Bottom radius", min: 0, max: 1000, step: 0.5, noSlider: true },
      { key: "topRadius", label: "Top radius", min: 0, max: 1000, step: 0.5, noSlider: true },
      dim("height", "Height"),
      { key: "sides", label: "Roundness", min: 8, max: 96, step: 1 },
      {
        key: "sideEdges",
        label: "Side lines",
        min: 0,
        max: 1,
        step: 1,
        options: [
          { value: 0, label: "Hidden" },
          { value: 1, label: "Shown" },
        ],
      },
      { key: "topFillet", label: "Top corner radius", min: 0, max: 500, step: 0.5 },
      { key: "bottomFillet", label: "Bottom corner radius", min: 0, max: 500, step: 0.5 },
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
      leftFillet: 0,
      rightFillet: 0,
      apexFillet: 0,
      cornerSteps: 32,
      cornerEdges: 0,
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
      { key: "leftFillet", label: "Left corner radius", min: 0, max: 500, step: 0.5 },
      { key: "rightFillet", label: "Right corner radius", min: 0, max: 500, step: 0.5 },
      { key: "apexFillet", label: "Apex corner radius", min: 0, max: 500, step: 0.5 },
      { key: "cornerSteps", label: "Corner steps", min: 1, max: 64, step: 1 },
      {
        key: "cornerEdges",
        label: "Corner lines",
        min: 0,
        max: 1,
        step: 1,
        options: [
          { value: 0, label: "Hidden" },
          { value: 1, label: "Shown" },
        ],
      },
    ],
  },
  torus: {
    label: "Torus",
    defaults: { radius: 15, tubeRadius: 5, ringSteps: 48, tubeSteps: 32, surfaceEdges: 0 },
    fields: [
      dim("radius", "Ring radius"),
      dim("tubeRadius", "Tube radius"),
      { key: "ringSteps", label: "Ring steps", min: 8, max: 64, step: 1 },
      { key: "tubeSteps", label: "Tube steps", min: 8, max: 64, step: 1 },
      {
        key: "surfaceEdges", label: "Surface lines", min: 0, max: 1, step: 1,
        options: [{ value: 0, label: "Hidden" }, { value: 1, label: "Shown" }],
      },
    ],
  },
  pyramid: {
    label: "Pyramid",
    defaults: {
      sides: 4, radius: 10, height: 20, sideEdges: 0,
      topFillet: 0, bottomFillet: 0, cornerSteps: 24,
    },
    fields: [
      { key: "sides", label: "Base sides", min: 3, max: 32, step: 1 },
      {
        key: "sideEdges",
        label: "Side lines",
        min: 0,
        max: 1,
        step: 1,
        options: [
          { value: 0, label: "Hidden" },
          { value: 1, label: "Shown" },
        ],
      },
      dim("radius", "Radius"),
      dim("height", "Height"),
      { key: "topFillet", label: "Top corner radius", min: 0, max: 500, step: 0.5 },
      { key: "bottomFillet", label: "Bottom corner radius", min: 0, max: 500, step: 0.5 },
      { key: "cornerSteps", label: "Corner steps", min: 1, max: 64, step: 1 },
    ],
  },
  wedge: {
    label: "Wedge",
    defaults: {
      width: 20, length: 20, height: 20,
      topFillet: 0, bottomFillet: 0, cornerSteps: 24, cornerEdges: 0,
    },
    fields: [
      dim("width", "Width"),
      dim("length", "Length"),
      dim("height", "Height"),
      { key: "topFillet", label: "Top corner radius", min: 0, max: 500, step: 0.5 },
      { key: "bottomFillet", label: "Bottom corner radius", min: 0, max: 500, step: 0.5 },
      { key: "cornerSteps", label: "Corner steps", min: 1, max: 64, step: 1 },
      {
        key: "cornerEdges", label: "Corner lines", min: 0, max: 1, step: 1,
        options: [{ value: 0, label: "Hidden" }, { value: 1, label: "Shown" }],
      },
    ],
  },
  polygonPrism: {
    label: "Polygon Prism",
    defaults: {
      sides: 6, radius: 10, height: 20, fillet: 0,
      topFillet: 0, bottomFillet: 0, cornerSteps: 24, cornerEdges: 0,
    },
    fields: [
      { key: "sides", label: "Base sides", min: 3, max: 32, step: 1 },
      dim("radius", "Radius"),
      dim("height", "Height"),
      { key: "fillet", label: "Side corner radius", min: 0, max: 500, step: 0.5 },
      { key: "topFillet", label: "Top corner radius", min: 0, max: 500, step: 0.5 },
      { key: "bottomFillet", label: "Bottom corner radius", min: 0, max: 500, step: 0.5 },
      { key: "cornerSteps", label: "Corner steps", min: 1, max: 64, step: 1 },
      {
        key: "cornerEdges", label: "Corner lines", min: 0, max: 1, step: 1,
        options: [{ value: 0, label: "Hidden" }, { value: 1, label: "Shown" }],
      },
    ],
  },
  hemisphere: {
    label: "Dome",
    defaults: { radius: 10, bottomFillet: 0, surfaceSteps: 24, surfaceEdges: 0 },
    fields: [
      dim("radius", "Radius"),
      { key: "bottomFillet", label: "Bottom corner radius", min: 0, max: 500, step: 0.5 },
      { key: "surfaceSteps", label: "Surface steps", min: 4, max: 64, step: 1 },
      {
        key: "surfaceEdges", label: "Corner lines", min: 0, max: 1, step: 1,
        options: [{ value: 0, label: "Hidden" }, { value: 1, label: "Shown" }],
      },
    ],
  },
  capsule: {
    label: "Capsule",
    defaults: { radius: 5, height: 20, surfaceSteps: 48, surfaceEdges: 0 },
    fields: [
      dim("radius", "Radius"),
      dim("height", "Height"),
      { key: "surfaceSteps", label: "Surface steps", min: 8, max: 64, step: 1 },
      {
        key: "surfaceEdges", label: "Surface lines", min: 0, max: 1, step: 1,
        options: [{ value: 0, label: "Hidden" }, { value: 1, label: "Shown" }],
      },
    ],
  },
  tube: {
    label: "Tube",
    defaults: {
      radius: 15, wallThickness: 3, height: 10, sides: 32, bevel: 0,
      outerTopFillet: 0, outerBottomFillet: 0, innerTopFillet: 0, innerBottomFillet: 0,
      cornerEdges: 0,
    },
    fields: [
      dim("radius", "Outer radius"),
      { key: "wallThickness", label: "Wall thickness", min: 0.1, max: 1000, step: 0.1, noSlider: true },
      dim("height", "Height"),
      { key: "sides", label: "Sides", min: 3, max: 64, step: 1 },
      { key: "outerTopFillet", label: "Outer top corner radius", min: 0, max: 100, step: 0.25 },
      { key: "innerTopFillet", label: "Inner top corner radius", min: 0, max: 100, step: 0.25 },
      { key: "outerBottomFillet", label: "Outer bottom corner radius", min: 0, max: 100, step: 0.25 },
      { key: "innerBottomFillet", label: "Inner bottom corner radius", min: 0, max: 100, step: 0.25 },
      {
        key: "cornerEdges", label: "Corner lines", min: 0, max: 1, step: 1,
        options: [{ value: 0, label: "Hidden" }, { value: 1, label: "Shown" }],
      },
    ],
  },
  paraboloid: {
    label: "Paraboloid",
    defaults: { radius: 10, height: 20, bottomFillet: 0, surfaceSteps: 32, surfaceEdges: 0 },
    fields: [
      dim("radius", "Radius"),
      dim("height", "Height"),
      { key: "bottomFillet", label: "Bottom corner radius", min: 0, max: 500, step: 0.5 },
      { key: "surfaceSteps", label: "Surface steps", min: 4, max: 64, step: 1 },
      {
        key: "surfaceEdges", label: "Corner lines", min: 0, max: 1, step: 1,
        options: [{ value: 0, label: "Hidden" }, { value: 1, label: "Shown" }],
      },
    ],
  },
  text: {
    label: "Text",
    defaults: { size: 20, thickness: 4 },
    fields: [
      dim("size", "Height"),
      { key: "thickness", label: "Thickness", min: 0.1, max: 500, step: 0.5, noSlider: true },
    ],
  },
  connector: {
    label: "Connector",
    // Both shapes' params live in one flat dict (same pattern triangle uses
    // across its three modes) so switching Shape or Fit never loses a value
    // the other combination had set.
    defaults: {
      shape: 0, // 0 = dovetail, 1 = round pin
      fit: 0, // 0 = plug (male), 1 = socket (female)
      width: 14,
      taperAngle: 12,
      height: 6,
      radius: 5,
      chamfer: 1,
      length: 12,
      clearance: 0.15,
    },
    fields: [
      {
        key: "shape",
        label: "Shape",
        min: 0,
        max: 1,
        step: 1,
        options: [
          { value: 0, label: "Dovetail" },
          { value: 1, label: "Round pin" },
        ],
      },
      {
        key: "fit",
        label: "Fit",
        min: 0,
        max: 1,
        step: 1,
        options: [
          { value: 0, label: "Plug (male)" },
          { value: 1, label: "Socket (female)" },
        ],
      },
      { ...dim("width", "Width"), showIf: { key: "shape", oneOf: [0] } },
      {
        key: "taperAngle",
        label: "Taper angle",
        min: 2,
        max: 30,
        step: 1,
        suffix: "°",
        noSlider: true,
        showIf: { key: "shape", oneOf: [0] },
      },
      { ...dim("height", "Height"), showIf: { key: "shape", oneOf: [0] } },
      { ...dim("radius", "Radius"), showIf: { key: "shape", oneOf: [1] } },
      {
        key: "chamfer",
        label: "Tip taper",
        min: 0,
        max: 20,
        step: 0.1,
        noSlider: true,
        showIf: { key: "shape", oneOf: [1] },
      },
      dim("length", "Length"),
      {
        key: "clearance",
        label: "Clearance",
        min: 0,
        max: 2,
        step: 0.05,
        noSlider: true,
        showIf: { key: "fit", oneOf: [1] },
      },
    ],
  },
  threadedRod: {
    label: "Threaded Rod / Bolt",
    defaults: {
      preset: 8,
      diameter: 8,
      pitch: 1.25,
      length: 30,
      headType: 1,
      headSize: 13,
      headHeight: 5.5,
      socketSize: 6,
      socketDepth: 4,
      topFillet: 0,
      bottomFillet: 0,
      cornerSteps: 16,
      cornerEdges: 0,
      chamfer: 1,
      density: 1,
    },
    fields: [
      {
        key: "preset",
        label: "Standard Preset",
        min: 0,
        max: 20,
        step: 1,
        options: [
          { value: 0, label: "Custom" },
          { value: 3, label: "M3 (3mm, 0.5p)" },
          { value: 4, label: "M4 (4mm, 0.7p)" },
          { value: 5, label: "M5 (5mm, 0.8p)" },
          { value: 6, label: "M6 (6mm, 1.0p)" },
          { value: 8, label: "M8 (8mm, 1.25p)" },
          { value: 10, label: "M10 (10mm, 1.5p)" },
          { value: 12, label: "M12 (12mm, 1.75p)" },
          { value: 16, label: "M16 (16mm, 2.0p)" },
          { value: 20, label: "M20 (20mm, 2.5p)" },
        ],
      },
      { ...dim("diameter", "Diameter"), min: 2, max: 100, step: 0.5, showIf: { key: "preset", oneOf: [0] } },
      { key: "pitch", label: "Pitch", min: 0.2, max: 10, step: 0.05, noSlider: true, suffix: "mm", showIf: { key: "preset", oneOf: [0] } },
      {
        key: "headType",
        label: "Head Style",
        min: 0,
        max: 3,
        step: 1,
        options: [
          { value: 0, label: "No Head (Rod / Stud)" },
          { value: 1, label: "Hex Head (Bolt)" },
          { value: 2, label: "Socket Cap (Allen)" },
          { value: 3, label: "Knurled Thumb Screw" },
        ],
      },
      { ...dim("headSize", "Head width"), min: 3, max: 200, step: 0.5, showIf: { key: "headType", oneOf: [1, 2, 3] } },
      { ...dim("headHeight", "Head Thickness"), min: 1, max: 100, step: 0.5, showIf: { key: "headType", oneOf: [1, 2, 3] } },
      { ...dim("length", "Thread Length"), min: 2, max: 500, step: 1 },
      { ...dim("socketSize", "Allen key size"), min: 0.5, max: 100, step: 0.5, showIf: { key: "headType", oneOf: [2] } },
      { ...dim("socketDepth", "Allen recess depth"), min: 0.2, max: 100, step: 0.5, showIf: { key: "headType", oneOf: [2] } },
      { key: "topFillet", label: "Head top corner radius", min: 0, max: 100, step: 0.1, showIf: { key: "headType", oneOf: [1, 2, 3] } },
      { key: "bottomFillet", label: "Head bottom corner radius", min: 0, max: 100, step: 0.1, showIf: { key: "headType", oneOf: [1, 2, 3] } },
      { key: "cornerSteps", label: "Corner steps", min: 1, max: 32, step: 1, showIf: { key: "headType", oneOf: [1, 2, 3] } },
      {
        key: "cornerEdges", label: "Corner lines", min: 0, max: 1, step: 1,
        options: [{ value: 0, label: "Hidden" }, { value: 1, label: "Shown" }],
        showIf: { key: "headType", oneOf: [1, 2, 3] },
      },
      {
        key: "chamfer",
        label: "Lead-in Chamfer",
        min: 0,
        max: 1,
        step: 1,
        options: [
          { value: 0, label: "Flat end" },
          { value: 1, label: "Chamfered 45°" },
        ],
      },
      {
        key: "density",
        label: "Thread Quality",
        min: 0,
        max: 2,
        step: 1,
        options: [
          { value: 0, label: "Draft (Fast / 32)" },
          { value: 1, label: "Standard (Smooth / 64)" },
          { value: 2, label: "Ultra (Fine / 96)" },
        ],
      },
    ],
  },
  threadedNut: {
    label: "Threaded Nut",
    defaults: {
      preset: 8,
      diameter: 8,
      pitch: 1.25,
      height: 6.5,
      outerWidth: 13,
      shape: 0,
      fit: 1,
      clearance: 0.3,
      density: 1,
      topFillet: 0,
      bottomFillet: 0,
      cornerSteps: 16,
      cornerEdges: 0,
    },
    fields: [
      {
        key: "preset",
        label: "Standard Preset",
        min: 0,
        max: 20,
        step: 1,
        options: [
          { value: 0, label: "Custom" },
          { value: 3, label: "M3 (3mm, 0.5p)" },
          { value: 4, label: "M4 (4mm, 0.7p)" },
          { value: 5, label: "M5 (5mm, 0.8p)" },
          { value: 6, label: "M6 (6mm, 1.0p)" },
          { value: 8, label: "M8 (8mm, 1.25p)" },
          { value: 10, label: "M10 (10mm, 1.5p)" },
          { value: 12, label: "M12 (12mm, 1.75p)" },
          { value: 16, label: "M16 (16mm, 2.0p)" },
          { value: 20, label: "M20 (20mm, 2.5p)" },
        ],
      },
      {
        key: "fit",
        label: "Print Fit",
        min: 0,
        max: 3,
        step: 1,
        options: [
          { value: 0, label: "Tight (0.20 mm)" },
          { value: 1, label: "Normal (0.30 mm)" },
          { value: 2, label: "Loose (0.40 mm)" },
          { value: 3, label: "Custom" },
        ],
      },
      { ...dim("diameter", "Thread Diameter"), min: 2, max: 100, step: 0.5, showIf: { key: "preset", oneOf: [0] } },
      { key: "pitch", label: "Pitch", min: 0.2, max: 10, step: 0.05, noSlider: true, suffix: "mm", showIf: { key: "preset", oneOf: [0] } },
      { ...dim("height", "Thickness"), min: 1, max: 100, step: 0.5 },
      { ...dim("outerWidth", "Outer width"), min: 3, max: 200, step: 0.5 },
      {
        key: "clearance",
        label: "Print clearance",
        min: 0,
        max: 1,
        step: 0.05,
        noSlider: true,
        suffix: "mm",
      },
      {
        key: "shape",
        label: "Nut Shape",
        min: 0,
        max: 2,
        step: 1,
        options: [
          { value: 0, label: "Hexagonal" },
          { value: 1, label: "Square" },
          { value: 2, label: "Knurled Thumb Nut" },
        ],
      },
      { key: "topFillet", label: "Top corner radius", min: 0, max: 100, step: 0.25, showIf: { key: "shape", oneOf: [0, 1] } },
      { key: "bottomFillet", label: "Bottom corner radius", min: 0, max: 100, step: 0.25, showIf: { key: "shape", oneOf: [0, 1] } },
      { key: "cornerSteps", label: "Corner steps", min: 1, max: 32, step: 1, showIf: { key: "shape", oneOf: [0, 1] } },
      {
        key: "cornerEdges", label: "Corner lines", min: 0, max: 1, step: 1,
        options: [{ value: 0, label: "Hidden" }, { value: 1, label: "Shown" }],
        showIf: { key: "shape", oneOf: [0, 1] },
      },
      {
        key: "density",
        label: "Thread Quality",
        min: 0,
        max: 2,
        step: 1,
        options: [
          { value: 0, label: "Draft (Fast / 32)" },
          { value: 1, label: "Standard (Smooth / 64)" },
          { value: 2, label: "Ultra (Fine / 96)" },
        ],
      },
    ],
  },
  star: {
    label: "Star",
    defaults: {
      points: 5,
      outerRadius: 15,
      innerRadius: 7.5,
      height: 10,
      style: 0,
      fillet: 0,
      outerFillet: 0,
      innerFillet: 0,
      topFillet: 0,
      bottomFillet: 0,
      cornerSteps: 24,
      cornerEdges: 0,
    },
    fields: [
      {
        key: "style",
        label: "Style",
        min: 0,
        max: 1,
        step: 1,
        options: [
          { value: 0, label: "Prism" },
          { value: 1, label: "Faceted 3D" },
        ],
      },
      { key: "points", label: "Points", min: 3, max: 32, step: 1 },
      dim("outerRadius", "Outer radius"),
      dim("innerRadius", "Inner radius"),
      dim("height", "Height"),
      { key: "outerFillet", label: "Outer point radius", min: 0, max: 500, step: 0.5, showIf: { key: "style", oneOf: [0] } },
      { key: "innerFillet", label: "Inner corner radius", min: 0, max: 500, step: 0.5, showIf: { key: "style", oneOf: [0] } },
      { key: "topFillet", label: "Top corner radius", min: 0, max: 500, step: 0.5, showIf: { key: "style", oneOf: [0] } },
      { key: "bottomFillet", label: "Bottom corner radius", min: 0, max: 500, step: 0.5, showIf: { key: "style", oneOf: [0] } },
      { key: "cornerSteps", label: "Corner steps", min: 1, max: 64, step: 1, showIf: { key: "style", oneOf: [0] } },
      {
        key: "cornerEdges", label: "Corner lines", min: 0, max: 1, step: 1,
        options: [{ value: 0, label: "Hidden" }, { value: 1, label: "Shown" }],
        showIf: { key: "style", oneOf: [0] },
      },
    ],
  },
  tray: {
    label: "Organizer Bin",
    defaults: {
      width: 60,
      depth: 30,
      height: 20,
      cornerRadius: 4,
      wallThickness: 2,
      floorThickness: 2,
      internalFillet: 1.5,
    },
    fields: [
      dim("width", "Width"),
      dim("depth", "Depth"),
      dim("height", "Height"),
      { key: "cornerRadius", label: "Corner Radius", min: 0, max: 200, step: 0.5, noSlider: true, suffix: "mm" },
      { key: "wallThickness", label: "Wall Thickness", min: 0.4, max: 50, step: 0.2, noSlider: true, suffix: "mm" },
      { key: "floorThickness", label: "Bottom Thickness", min: 0.4, max: 50, step: 0.2, noSlider: true, suffix: "mm" },
      { key: "internalFillet", label: "Inside Bottom Curve", min: 0, max: 20, step: 0.5, noSlider: true, suffix: "mm" },
    ],
  },
  ellipsoid: {
    label: "Ellipsoid",
    defaults: { radiusX: 15, radiusY: 10, radiusZ: 10, surfaceSteps: 48, surfaceEdges: 0 },
    fields: [
      dim("radiusX", "Radius X"),
      dim("radiusY", "Radius Y"),
      dim("radiusZ", "Radius Z"),
      { key: "surfaceSteps", label: "Surface steps", min: 8, max: 64, step: 1 },
      {
        key: "surfaceEdges",
        label: "Surface lines",
        min: 0,
        max: 1,
        step: 1,
        options: [
          { value: 0, label: "Hidden" },
          { value: 1, label: "Shown" },
        ],
      },
    ],
  },
};

/** Fields visible for the current parameter values. */
export function visibleFields(def: PrimitiveDef, params: Record<string, number>): ParamField[] {
  return def.fields.filter((f) => !f.showIf || f.showIf.oneOf.includes(params[f.showIf.key]));
}

export type Vec3 = [number, number, number];

export type CameraMode = "perspective" | "orthographic";

/** How a group organizes or combines its children. */
export type BooleanOp = "assembly" | "union" | "subtract" | "intersect";

export const COMBINE_OPS: { value: "union" | "subtract" | "intersect"; label: string; hint: string }[] = [
  { value: "union", label: "Union", hint: "Merge children into a single solid; holes cut the solids" },
  { value: "subtract", label: "Subtract", hint: "First child minus all the rest" },
  { value: "intersect", label: "Intersect", hint: "Keep only the overlapping volume" },
];

export const BOOLEAN_OPS: { value: BooleanOp; label: string; hint: string }[] = [
  { value: "assembly", label: "Group (Assembly)", hint: "Link parts without merging geometry or losing colors" },
  ...COMBINE_OPS,
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
  /**
   * Hidden from the viewport, from export, and — when this node sits inside
   * a group — from the boolean that produces the group's own shape.
   *
   * A top-level node's mesh is still built and cached exactly as normal;
   * only its Group.visible is toggled, so showing it again is instant and
   * costs no rebuild. A node nested inside a group has no mesh of its own to
   * hide — the group renders as one unioned solid — so hiding one there
   * means excluding it from that union, which does need a rebuild (see
   * toSpec's children filter in App.tsx).
   */
  hidden?: boolean;
}

export interface ObjectNode extends NodeBase {
  type: "object";
  kind: PrimitiveKind;
  params: Record<string, number>;
  /** Text content when kind === "text". */
  text?: string;
  /** Chosen font family / postscript name when kind === "text". */
  fontName?: string;
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
  /** When created from a face selection, resolve all of that face's true CAD
   * boundary edges again on every rebuild instead of storing mesh segments. */
  face?: { point: Vec3; normal: Vec3 };
  distance: number;
}

/**
 * Hollows the solid out into a container: everything more than `thickness`
 * from the surface is removed, and the faces anchored by `points` are taken
 * away entirely so there is an opening.
 *
 * The wall goes INWARDS, so the outside of the shape keeps the size it had.
 *
 * Faces are anchored by an interior point rather than a topology index, for
 * the same reason EdgeOp anchors edges that way: indices do not survive a
 * rebuild, a point does.
 */
export interface ShellOp {
  kind: "shell";
  thickness: number;
  /** One point on each face to open. Empty means a fully closed hollow. */
  points: Vec3[];
  /** Actual outward direction of the selected opening face. Older saved
   * designs omit this and fall back to locating the nearest bounding side. */
  normal?: Vec3;
}

/**
 * Resizes one planar face in its own plane. Positive values grow its outline
 * outwards, negative values inset it. The opposite extent of the solid stays
 * fixed, so the faces joining the two become sloped rather than the whole
 * object merely being scaled.
 */
export interface ResizeFaceOp {
  kind: "resizeFace";
  point: Vec3;
  normal: Vec3;
  /** Per-edge inset/outset in millimetres, not the total width change. */
  offset: number;
}

/**
 * Insets (or outsets) a planar face's own outline, then extrudes that smaller
 * outline along the face normal — the standard way to raise a rim or sink a
 * pocket that follows the real edge of a face, rounded corners and all,
 * rather than a box laid over the top of it.
 *
 * Two numbers because it is two things: how far in from the edge, and how far
 * out (or in) to go from there.
 */
export interface OffsetExtrudeOp {
  kind: "offsetExtrude";
  point: Vec3;
  normal: Vec3;
  /** Distance in from the face's edge. Negative overhangs it instead. */
  inset: number;
  /** Along the face normal: positive adds material, negative cuts a pocket. */
  height: number;
}

export type EditOp = PushPullOp | EdgeOp | ShellOp | ResizeFaceOp | OffsetExtrudeOp;

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
  // A Shape Builder result is already one frozen, resolved solid — pushing,
  // pulling, filleting or chamfering it further is exactly as meaningful as
  // doing the same to a Group's fused solid, which this already allowed.
  base: ObjectNode | GroupNode | BuildNode;
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
