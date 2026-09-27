import {
  assembleWire,
  basicFaceExtrusion,
  makeCircle,
  makeCompound,
  makeFace,
  makeLine,
  makeThreePointArc,
  Vector,
  draw,
} from "replicad";
import type { Shape3D, Sketch, Wire } from "replicad";
import { InvalidShapeError } from "../geometry/triangle";

/**
 * Dividers and see-through wall patterns for the Organizer Bin ("tray").
 *
 * The bin itself (outer block minus the rounded cavity) is built in
 * makePrimitive; this module takes that outer block and cavity and adds:
 *
 *  - Dividers: equal compartments across the width and/or depth. They are
 *    subtracted from the CAVITY before the cavity is cut, so they come out
 *    as part of the same single solid with no extra fuse.
 *
 *  - Finger cut-outs: a U-shaped scoop down from the top edge, in the middle
 *    of any of the four walls and/or of each stretch of divider.
 *
 *  - Label tabs: a shelf flush with the rim along one side of every
 *    compartment, with a 45 degree underside so it prints without support.
 *
 *  - Wall patterns (hexagons, round holes, diamonds, slots) to save filament.
 *    Cutting hundreds of hole prisms from the bin is slow in OpenCascade
 *    (measured: 1360 hexes on a 300x200x100 bin took 27 s as one compound
 *    cut). Instead each flat wall panel is built directly as a face with the
 *    holes as inner outlines, extruded, and swapped in for the plain panel:
 *    one cut of a few boxes and one fuse (same volume, ~3.8 s for that bin,
 *    well under a second for ordinary sizes).
 *
 * Holes stay a solid border away from the rim, the floor, the rounded
 * corners and every place a divider meets a wall, so the bin keeps its
 * strength where it needs it. Every hole shape prints without supports on a
 * vertical wall: hexagons point up, diamonds are 45 degree squares, and the
 * round tops of circles and slots are small enough to bridge.
 */

export const TRAY_PATTERN = {
  solid: 0,
  hexagon: 1,
  circle: 2,
  diamond: 3,
  slot: 4,
} as const;

/** Bit flags: where the wall pattern goes. */
export const PATTERN_ON = {
  walls: 1,
  dividers: 2,
} as const;

/** Bit flags for the four sides, as label tabs use them. Front is -Y, left is -X. */
export const SIDE = {
  front: 1,
  back: 2,
  left: 4,
  right: 8,
} as const;

/** Bit flags: where finger cut-outs go (the sides, as in SIDE, plus dividers). */
export const FINGER = {
  front: 1,
  back: 2,
  left: 4,
  right: 8,
  dividers: 16,
} as const;

export const FINGER_SHAPE = {
  round: 0,
  trapezoid: 1,
  wave: 2,
  square: 3,
} as const;

/** Beyond this the rebuild takes long enough to feel like a hang. */
const MAX_HOLES = 3000;

export interface TrayLayout {
  w: number;
  d: number;
  h: number;
  wall: number;
  floor: number;
  cornerR: number;
  inCornerR: number;
  insideFillet: number;
}

type Interval = [number, number];

/** A flat rectangle of wall or divider to perforate.
 *  `axis` is the direction through its thickness; u runs along it
 *  (x for a y-facing panel, y for an x-facing one), v is height. */
interface Panel {
  axis: "x" | "y";
  u: Interval;
  v: Interval;
  /** Range along `axis` the panel occupies (its thickness). */
  t: Interval;
}

const SQRT3 = Math.sqrt(3);

/** Splits [lo, hi] around each blocked interval, keeping pieces >= minLen. */
function subtractIntervals(lo: number, hi: number, blocked: Interval[], minLen: number): Interval[] {
  let pieces: Interval[] = [[lo, hi]];
  for (const [a, b] of blocked) {
    const next: Interval[] = [];
    for (const [p, q] of pieces) {
      if (b <= p || a >= q) {
        next.push([p, q]);
        continue;
      }
      if (a > p) next.push([p, a]);
      if (b < q) next.push([b, q]);
    }
    pieces = next;
  }
  return pieces.filter(([p, q]) => q - p >= minLen);
}

/** Centres of dividers splitting `span` into n + 1 equal compartments. */
function dividerCentres(span: number, n: number, t: number): number[] {
  if (n <= 0) return [];
  const c = (span - n * t) / (n + 1);
  return Array.from({ length: n }, (_, i) => -span / 2 + (i + 1) * c + (i + 0.5) * t);
}

/** Closed polygon wire in the XY plane. Hole outlines must run clockwise
 *  or BRepBuilderAPI_MakeFace treats them as extra material. */
function polyWire(pts: [number, number][]): Wire {
  return assembleWire(
    pts.map((p, i) => {
      const q = pts[(i + 1) % pts.length];
      return makeLine([p[0], p[1], 0], [q[0], q[1], 0]);
    }),
  );
}

/** Clockwise outline of one hole centred on (cu, cv). */
function holeWire(pattern: number, cu: number, cv: number, size: number, slotH: number): Wire {
  if (pattern === TRAY_PATTERN.circle) {
    // A -Z normal makes the circle run clockwise seen from +Z.
    return assembleWire([makeCircle(size / 2, [cu, cv, 0], [0, 0, -1])]);
  }
  if (pattern === TRAY_PATTERN.slot) {
    const r = size / 2;
    const half = Math.max(0, slotH / 2 - r);
    if (half < 1e-3) return assembleWire([makeCircle(r, [cu, cv, 0], [0, 0, -1])]);
    return assembleWire([
      makeLine([cu - r, cv - half, 0], [cu - r, cv + half, 0]),
      makeThreePointArc([cu - r, cv + half, 0], [cu, cv + half + r, 0], [cu + r, cv + half, 0]),
      makeLine([cu + r, cv + half, 0], [cu + r, cv - half, 0]),
      makeThreePointArc([cu + r, cv - half, 0], [cu, cv - half - r, 0], [cu - r, cv - half, 0]),
    ]);
  }
  if (pattern === TRAY_PATTERN.diamond) {
    const r = size / 2;
    return polyWire([
      [cu, cv + r],
      [cu + r, cv],
      [cu, cv - r],
      [cu - r, cv],
    ]);
  }
  // Hexagon, point up; `size` is the distance across the flats.
  const R = size / SQRT3;
  const pts: [number, number][] = [];
  for (let k = 0; k < 6; k++) {
    const a = Math.PI / 2 - (k * Math.PI) / 3; // decreasing angle = clockwise
    pts.push([cu + R * Math.cos(a), cv + R * Math.sin(a)]);
  }
  return polyWire(pts);
}

/** Hole centres filling a panel, centred, staggered rows where it applies. */
function holeCentres(pattern: number, U: Interval, V: Interval, size: number, bar: number): {
  centres: [number, number][];
  slotH: number;
} {
  const uLen = U[1] - U[0];
  const vLen = V[1] - V[0];
  const uc = (U[0] + U[1]) / 2;
  const vc = (V[0] + V[1]) / 2;
  const centres: [number, number][] = [];

  if (pattern === TRAY_PATTERN.slot) {
    if (vLen < size || uLen < size) return { centres, slotH: 0 };
    const px = size + bar;
    const n = Math.floor((uLen - size) / px + 1e-6) + 1;
    for (let k = 0; k < n; k++) centres.push([uc + (k - (n - 1) / 2) * px, vc]);
    return { centres, slotH: vLen };
  }

  let holeW: number;
  let holeH: number;
  let px: number;
  let py: number;
  if (pattern === TRAY_PATTERN.diamond) {
    // Diagonal neighbours' facing edges are `bar` apart.
    holeW = holeH = size;
    px = size + bar * Math.SQRT2;
    py = px / 2;
  } else {
    // Honeycomb spacing: every neighbour is one pitch away, so the bars
    // between holes are all the same width.
    holeW = size;
    holeH = pattern === TRAY_PATTERN.hexagon ? (2 * size) / SQRT3 : size;
    px = size + bar;
    py = (px * SQRT3) / 2;
  }
  if (uLen < holeW || vLen < holeH) return { centres, slotH: 0 };
  const n = Math.floor((uLen - holeW) / px + 1e-6) + 1;
  const rows = Math.floor((vLen - holeH) / py + 1e-6) + 1;
  for (let r = 0; r < rows; r++) {
    const v = vc + (r - (rows - 1) / 2) * py;
    // Offset rows sit between the holes of the rows beside them.
    const count = r % 2 === 0 ? n : n - 1;
    for (let k = 0; k < count; k++) centres.push([uc + (k - (count - 1) / 2) * px, v]);
  }
  return { centres, slotH: 0 };
}

/** Orients a solid built in local (u, v, thickness=z) into the panel's place. */
function placePanel(solid: Shape3D, panel: Panel): Shape3D {
  const thick = panel.t[1] - panel.t[0];
  // +90 about X: (u, v, e) -> (u, -e, v); e in [0, thick] lands at y in [-thick, 0].
  const upright = solid.rotate(90, [0, 0, 0], [1, 0, 0]) as Shape3D;
  if (panel.axis === "y") return upright.translate([0, panel.t[0] + thick, 0]) as Shape3D;
  // +90 about Z: (u, -e, v) -> (e, u, v).
  return upright.rotate(90, [0, 0, 0], [0, 0, 1]).translate([panel.t[0], 0, 0]) as Shape3D;
}

/**
 * Builds the bin from its outer block and cavity (cavity already at its
 * floor height, with any inside bottom curve) and adds dividers and the
 * wall pattern described by `p`.
 */
export function buildTray(outer: Shape3D, cavity: Shape3D, L: TrayLayout, p: Record<string, number>): Shape3D {
  const { w, d, h, wall, floor, cornerR, inCornerR, insideFillet } = L;
  const inW = w - wall * 2;
  const inD = d - wall * 2;
  const depth = h - floor;

  // ---- Dividers -------------------------------------------------------
  const useDividers = (p.dividers ?? 0) === 1;
  const t = Math.min(Math.max(p.dividerThickness ?? 1.6, 0.4), 20);
  // Keep every compartment at least 1 mm wide.
  const maxCount = (span: number) => Math.max(0, Math.floor((span - 1) / (t + 1)));
  const nx = useDividers ? Math.min(Math.max(Math.round(p.dividersX ?? 1), 0), 30, maxCount(inW)) : 0;
  const ny = useDividers ? Math.min(Math.max(Math.round(p.dividersY ?? 0), 0), 30, maxCount(inD)) : 0;
  const heightPct = Math.min(Math.max(p.dividerHeight ?? 100, 10), 100);
  const dividerTop = floor + (depth * heightPct) / 100;
  const xs = dividerCentres(inW, nx, t); // dividers across the width sit at these x
  const ys = dividerCentres(inD, ny, t); // dividers across the depth sit at these y

  if (xs.length || ys.length) {
    // Taller than needed on purpose (and reaching into the walls): only
    // what overlaps the cavity matters, since the dividers are removed from
    // the cavity rather than added to the bin.
    const boxes: Shape3D[] = [];
    const slab = (sx: number, sy: number, cx: number, cy: number) =>
      polyFaceExtrude(
        [
          [cx - sx / 2, cy - sy / 2],
          [cx + sx / 2, cy - sy / 2],
          [cx + sx / 2, cy + sy / 2],
          [cx - sx / 2, cy + sy / 2],
        ],
        dividerTop,
      );
    for (const x of xs) boxes.push(slab(t, d, x, 0));
    for (const y of ys) boxes.push(slab(w, t, 0, y));
    // Crossing dividers overlap, and a compound of overlapping solids is not
    // a valid boolean tool (the cut silently drops most of it), so each
    // direction goes in as its own compound of disjoint slabs.
    const across = boxes.slice(0, xs.length);
    const along = boxes.slice(xs.length);
    for (const group of [across, along]) {
      if (group.length) cavity = cavity.cut(makeCompound(group) as Shape3D) as Shape3D;
    }
  }

  // ---- Label tabs -----------------------------------------------------
  // A shelf flush with the top edge along one side of every compartment,
  // to write on or stick a label to. Its underside slopes down into the
  // wall at 45 degrees so it prints without supports. Like the dividers,
  // tabs are taken out of the cavity, which also trims them neatly to the
  // rounded inside corners.
  const tabs = Math.round(p.labelTab ?? 0);
  const tabOn = (bit: number) => (tabs & bit) !== 0;
  const tabT = Math.min(Math.max(p.labelTabThickness ?? 1.6, 0.6), 10);
  // No wider than a compartment (half of one when both ends have a tab).
  const compartment = (span: number, n: number) => (span - n * t) / (n + 1);
  const tabRoomX = compartment(inW, xs.length) / (tabOn(SIDE.left) && tabOn(SIDE.right) ? 2 : 1) - 0.5;
  const tabRoomY = compartment(inD, ys.length) / (tabOn(SIDE.front) && tabOn(SIDE.back) ? 2 : 1) - 0.5;
  const tabWanted = Math.min(Math.max(p.labelTabWidth ?? 12, 2), 100);
  const tabW = { x: Math.min(tabWanted, tabRoomX), y: Math.min(tabWanted, tabRoomY) };
  /** Lowest point of a tab's sloped underside, for a tab whose top is `top`. */
  const tabBottom = (top: number, width: number) => Math.max(floor, top - tabT - width);
  /** Every face a tab hangs from on one side: [position, inward direction, top]. */
  const tabFaces = (side: number): [number, number][] => {
    if (side === SIDE.left) return [[-inW / 2, h], ...xs.map((x): [number, number] => [x + t / 2, dividerTop])];
    if (side === SIDE.right) return [[inW / 2, h], ...xs.map((x): [number, number] => [x - t / 2, dividerTop])];
    if (side === SIDE.front) return [[-inD / 2, h], ...ys.map((y): [number, number] => [y + t / 2, dividerTop])];
    return [[inD / 2, h], ...ys.map((y): [number, number] => [y - t / 2, dividerTop])];
  };
  for (const side of [SIDE.left, SIDE.right, SIDE.front, SIDE.back]) {
    if (!tabOn(side)) continue;
    const across = side === SIDE.left || side === SIDE.right;
    const width = across ? tabW.x : tabW.y;
    if (width < 2) continue;
    const length = 2 * Math.max(w, d);
    const strips = tabFaces(side).map(([at, top]) => {
      // Profile in (distance in from the face, height), reaching 1 mm back
      // into the wall so it overlaps it rather than just touching it.
      const low = tabBottom(top, width);
      const strip = polyFaceExtrude(
        [[-1, top], [width, top], [width, top - tabT], [0, low], [-1, low]],
        length,
      );
      // +90 about X: profile (s, z, e) -> (s, -e, z), running along y.
      const alongY = strip.rotate(90, [0, 0, 0], [1, 0, 0]).translate([0, length / 2, 0]) as Shape3D;
      // Then face it into the compartment from its own side.
      const turn = side === SIDE.left ? 0 : side === SIDE.right ? 180 : side === SIDE.front ? 90 : -90;
      const turned = turn ? (alongY.rotate(turn, [0, 0, 0], [0, 0, 1]) as Shape3D) : alongY;
      return (across ? turned.translate([at, 0, 0]) : turned.translate([0, at, 0])) as Shape3D;
    });
    cavity = cavity.cut(makeCompound(strips) as Shape3D) as Shape3D;
  }
  /** How far a tab reaches out from each face of a panel, for making room. */
  const tabReach = (side: number) => (tabOn(side) ? (side === SIDE.left || side === SIDE.right ? tabW.x : tabW.y) : 0);

  let tray = outer.cut(cavity) as Shape3D;

  // ---- Finger cut-outs (where they go) --------------------------------
  // A U-shaped scoop down from the top edge, centred on a wall or on each
  // stretch of divider, so small parts can be slid out with a finger. They
  // are cut last, after the wall pattern, so the pattern can simply stay
  // clear of them.
  const finger = Math.round(p.fingerCutout ?? 0);
  const fingerOn = (bit: number) => (finger & bit) !== 0;
  const fingerW = Math.min(Math.max(p.fingerWidth ?? 20, 4), 400);
  const fingerShape = Math.min(Math.max(Math.round(p.fingerShape ?? 0), 0), 3);
  const wallFingerD = Math.min(Math.max(p.fingerDepth ?? 12, 1), depth - 1);
  const divFingerD = Math.min(Math.max(p.fingerDepth ?? 12, 1), dividerTop - floor - 1);
  /** The asked-for width, narrowed to fit `room` (rounded rim corners
   *  included), or null if even a small one would not fit. */
  const fitWidth = (room: number, fingerD: number): number | null => {
    const width = Math.min(fingerW, room - 2 * scoopFlare(fingerShape, fingerW, fingerD));
    return width >= 4 ? width : null;
  };
  // Each wall's cut-out fits inside its straight stretch, clear of the corners.
  const wallScoop = (on: boolean, length: number): ScoopSpec[] => {
    const width = on ? fitWidth(length - 2 * Math.max(wall, cornerR) - 2, wallFingerD) : null;
    return width ? [{ c: 0, top: h, width, depth: wallFingerD, shape: fingerShape }] : [];
  };
  const scoopsFront = wallScoop(fingerOn(FINGER.front), w);
  const scoopsBack = wallScoop(fingerOn(FINGER.back), w);
  const scoopsLeft = wallScoop(fingerOn(FINGER.left), d);
  const scoopsRight = wallScoop(fingerOn(FINGER.right), d);
  /** One scoop in the middle of each stretch of a divider between the walls
   *  and the dividers crossing it, narrowed to fit a short stretch (so a
   *  wide wave can span the whole compartment). */
  const dividerScoops = (span: number, crossing: number[]): ScoopSpec[] => {
    if (!fingerOn(FINGER.dividers) || divFingerD < 1) return [];
    const out: ScoopSpec[] = [];
    for (const [a, b] of subtractIntervals(-span / 2, span / 2, crossing.map((c) => [c - t / 2, c + t / 2]), 4)) {
      const width = fitWidth(b - a - 1, divFingerD);
      if (width) out.push({ c: (a + b) / 2, top: dividerTop, width, depth: divFingerD, shape: fingerShape });
    }
    return out;
  };
  const scoopsOnX = dividerScoops(inD, ys); // the same for every divider across the width
  const scoopsOnY = dividerScoops(inW, xs);

  const cutScoops = (solid: Shape3D) => {
    // Each reaches a hair into the cavity, so the cut does not share the
    // inner face, and on through any label tab on that face, so the tab
    // gets the same scoop instead of blocking it. Walls and each direction
    // of divider go in as separate cuts: scoops that run on through tabs
    // can overlap where dividers cross, and overlapping tools in one
    // compound make an invalid cut.
    const groups: Shape3D[][] = [
      [
        ...scoopsFront.map((s) => scoopSolid("y", s, [-d / 2 - 1, -inD / 2 + 0.01 + tabReach(SIDE.front)])),
        ...scoopsBack.map((s) => scoopSolid("y", s, [inD / 2 - 0.01 - tabReach(SIDE.back), d / 2 + 1])),
        ...scoopsLeft.map((s) => scoopSolid("x", s, [-w / 2 - 1, -inW / 2 + 0.01 + tabReach(SIDE.left)])),
        ...scoopsRight.map((s) => scoopSolid("x", s, [inW / 2 - 0.01 - tabReach(SIDE.right), w / 2 + 1])),
      ],
      xs.flatMap((x) => scoopsOnX.map((s) => scoopSolid("x", s,
        [x - t / 2 - 0.01 - tabReach(SIDE.right), x + t / 2 + 0.01 + tabReach(SIDE.left)]))),
      ys.flatMap((y) => scoopsOnY.map((s) => scoopSolid("y", s,
        [y - t / 2 - 0.01 - tabReach(SIDE.back), y + t / 2 + 0.01 + tabReach(SIDE.front)]))),
    ];
    for (const tools of groups) {
      if (tools.length) solid = solid.cut(makeCompound(tools) as Shape3D) as Shape3D;
    }
    return solid;
  };

  // ---- Wall pattern ---------------------------------------------------
  const pattern = Math.round(p.wallPattern ?? 0);
  if (pattern < 1 || pattern > 4) return cutScoops(tray);

  const size = Math.min(Math.max(p.patternSize ?? 6, 1.5), 100);
  const bar = Math.min(Math.max(p.patternSpacing ?? 2, 0.6), 50);
  const border = Math.min(Math.max(p.patternBorder ?? 3, 0.5), 50);
  const patternOn = Math.round(p.patternOn ?? PATTERN_ON.walls | PATTERN_ON.dividers);
  const onWalls = (patternOn & PATTERN_ON.walls) !== 0;
  const onDividers = (patternOn & PATTERN_ON.dividers) !== 0;

  // Where a divider meets a wall, keep a solid strip one bar wide either side.
  const joints = (centres: number[]): Interval[] => centres.map((c) => [c - t / 2 - bar, c + t / 2 + bar]);
  const halfW = size / 2;
  // Radius of a circle around one hole, for keeping it clear of a scoop.
  const holeR = pattern === TRAY_PATTERN.hexagon ? size / SQRT3 : size / 2;
  const panels: (Panel & { holes: [number, number, number][] })[] = [];

  /**
   * Perforates one wall or divider. The holes form ONE grid laid out over
   * the whole of it, and holes that would land on a divider joint or too
   * close to a finger cut-out are just left out, so the pattern lines up
   * all the way across instead of restarting beside every obstacle. Each
   * stretch between joints becomes its own slab to swap in.
   */
  const perforate = (
    axis: Panel["axis"], u: Interval, v: Interval, thick: Interval, blocked: Interval[], scoops: ScoopSpec[],
  ) => {
    if (v[1] - v[0] < size) return;
    const free = subtractIntervals(u[0], u[1], blocked, size);
    if (!free.length) return;
    const { centres, slotH } = holeCentres(pattern, u, v, size, bar);
    const bySlab = free.map((s) => ({ s, holes: [] as [number, number, number][] }));
    for (const [cu, cv] of centres) {
      const slab = bySlab.find(({ s }) => cu - halfW >= s[0] - 1e-6 && cu + halfW <= s[1] + 1e-6);
      if (!slab) continue;
      if (pattern === TRAY_PATTERN.slot) {
        // A slot under a scoop gets shorter rather than disappearing.
        let top = v[1];
        for (const s of scoops) top = Math.min(top, scoopFloor(s, cu - halfW - border, cu + halfW + border) - border);
        if (top - v[0] < size) continue;
        slab.holes.push([cu, (v[0] + top) / 2, top - v[0]]);
      } else if (scoops.every((s) => scoopDistance(s, cu, cv) >= holeR + border)) {
        slab.holes.push([cu, cv, slotH]);
      }
    }
    for (const { s, holes } of bySlab) {
      if (holes.length) panels.push({ axis, u: s, v, t: thick, holes });
    }
  };

  if (onWalls) {
    const vWall: Interval = [floor + Math.max(border, insideFillet), h - border];
    // Behind a label tab the holes stop a border short of its underside.
    const vUnder = (side: number): Interval =>
      tabOn(side) ? [vWall[0], Math.min(vWall[1], tabBottom(h, tabReach(side)) - border)] : vWall;
    // Straight part of each wall, clear of the rounded corners on both faces.
    const straight = Math.max(wall, cornerR) + border;
    const along: Interval = [-w / 2 + straight, w / 2 - straight];
    const across: Interval = [-d / 2 + straight, d / 2 - straight];
    perforate("y", along, vUnder(SIDE.front), [-d / 2, -inD / 2], joints(xs), scoopsFront);
    perforate("y", along, vUnder(SIDE.back), [inD / 2, d / 2], joints(xs), scoopsBack);
    perforate("x", across, vUnder(SIDE.left), [-w / 2, -inW / 2], joints(ys), scoopsLeft);
    perforate("x", across, vUnder(SIDE.right), [inW / 2, w / 2], joints(ys), scoopsRight);
  }

  if (onDividers) {
    const vDiv: Interval = [floor + border, dividerTop - border];
    // A divider carrying a label tab on either face keeps holes clear of it.
    const vDivUnder = (a: number, b: number): Interval => {
      const reach = Math.max(tabReach(a), tabReach(b));
      return reach ? [vDiv[0], Math.min(vDiv[1], tabBottom(dividerTop, reach) - border)] : vDiv;
    };
    // A divider that runs into a rounded inner corner is shorter there.
    const inset = (c: number, span: number) => border + (Math.abs(c) + t / 2 > span / 2 - inCornerR ? inCornerR : 0);
    for (const x of xs) {
      const e = inset(x, inW);
      perforate("x", [-inD / 2 + e, inD / 2 - e], vDivUnder(SIDE.left, SIDE.right), [x - t / 2, x + t / 2], joints(ys), scoopsOnX);
    }
    for (const y of ys) {
      const e = inset(y, inD);
      perforate("y", [-inW / 2 + e, inW / 2 - e], vDivUnder(SIDE.front, SIDE.back), [y - t / 2, y + t / 2], joints(xs), scoopsOnY);
    }
  }

  const holeCount = panels.reduce((n, panel) => n + panel.holes.length, 0);
  if (holeCount > MAX_HOLES) {
    throw new InvalidShapeError(
      `The wall pattern would need over ${MAX_HOLES} holes. Make the holes bigger or the bars wider.`,
    );
  }

  const cuts: Shape3D[] = [];
  const fills: Shape3D[] = [];
  for (const panel of panels) {
    // The swapped-in slab reaches a little past the holes on every side: a
    // hole touching the slab's own edge (a slot always would) makes an
    // invalid face. It stays inside the solid border, and under half a bar
    // so neighbouring slabs never touch.
    const m = Math.min(bar, border) * 0.45;
    const rect: [number, number][] = [
      [panel.u[0] - m, panel.v[0] - m],
      [panel.u[1] + m, panel.v[0] - m],
      [panel.u[1] + m, panel.v[1] + m],
      [panel.u[0] - m, panel.v[1] + m],
    ];
    const thick = panel.t[1] - panel.t[0];
    const holes = panel.holes.map(([cu, cv, slotH]) => holeWire(pattern, cu, cv, size, slotH));
    const perforated = basicFaceExtrusion(makeFace(polyWire(rect), holes), new Vector([0, 0, thick])) as Shape3D;
    fills.push(placePanel(perforated, panel));
    cuts.push(placePanel(polyFaceExtrude(rect, thick), panel));
  }
  if (fills.length) {
    tray = tray.cut(makeCompound(cuts) as Shape3D) as Shape3D;
    tray = tray.fuse(makeCompound(fills) as Shape3D) as Shape3D;
  }
  return cutScoops(tray);
}

/** A finger cut-out on one wall or divider, in that panel's (u, v) terms. */
interface ScoopSpec {
  /** Centre along the panel. */
  c: number;
  /** Height of the top edge it is cut down from. */
  top: number;
  width: number;
  depth: number;
  shape: number;
}

/**
 * How far past `width` a shape's rounded rim corners reach on each side.
 * The trapezoid and square round off the edge where the scoop meets the
 * rim, which flares the opening slightly.
 */
function scoopFlare(shape: number, width: number, depth: number): number {
  if (shape !== FINGER_SHAPE.trapezoid && shape !== FINGER_SHAPE.square) return 0;
  return rimRadius(width, depth) + 0.5;
}

function rimRadius(width: number, depth: number): number {
  return Math.min(3, depth / 3, width / 8);
}

/**
 * The cutter's outline in the panel plane, closed above the top edge.
 *
 *  - U: a half-circle bottom with straight sides when deep enough, else one
 *    shallow arc through both top corners.
 *  - Trapezoid: sides sloping in at 45 degrees (steeper when shallow room
 *    runs out) to a flat bottom, every corner rounded, rim edges included.
 *  - Wave: two S-curves meeting at the bottom, level where they start and
 *    at the bottom, for a long gentle dip like a card or coin tray.
 *  - Square: straight sides and a flat bottom with rounded corners.
 *
 * Where a curve has to start at the rim, it starts a hair above it instead,
 * so the cut crosses the top face instead of touching it tangentially.
 */
function scoopWire(s: ScoopSpec): Wire {
  const { c, top, width, depth, shape } = s;
  const half = width / 2;
  const above = top + 1;
  if (shape === FINGER_SHAPE.wave) {
    const lip = top + Math.min(0.3, depth / 10);
    const k = half / 2;
    return (draw([c - half, above])
      .lineTo([c - half, lip])
      .cubicBezierCurveTo([c, top - depth], [c - half + k, lip], [c - k, top - depth])
      .cubicBezierCurveTo([c + half, lip], [c + k, top - depth], [c + half - k, lip])
      .lineTo([c + half, above])
      .close()
      .sketchOnPlane("XY") as Sketch).wire;
  }
  if (shape === FINGER_SHAPE.trapezoid || shape === FINGER_SHAPE.square) {
    const bottomHalf = shape === FINGER_SHAPE.square ? half : Math.max(half - depth, half * 0.3);
    const rt = rimRadius(width, depth);
    const rb = Math.min(bottomHalf, depth) * 0.6;
    const lip = top + Math.min(0.3, depth / 10);
    const out = half + rt + 0.5;
    return (draw([c - out, above])
      .lineTo([c - out, lip])
      .lineTo([c - half, lip])
      .customCorner(rt)
      .lineTo([c - bottomHalf, top - depth])
      .customCorner(rb)
      .lineTo([c + bottomHalf, top - depth])
      .customCorner(rb)
      .lineTo([c + half, lip])
      .customCorner(rt)
      .lineTo([c + out, lip])
      .lineTo([c + out, above])
      .close()
      .sketchOnPlane("XY") as Sketch).wire;
  }
  const r = half;
  if (depth >= r) {
    const vc = top - depth + r;
    return assembleWire([
      makeLine([c - r, above, 0], [c - r, vc, 0]),
      makeThreePointArc([c - r, vc, 0], [c, vc - r, 0], [c + r, vc, 0]),
      makeLine([c + r, vc, 0], [c + r, above, 0]),
      makeLine([c + r, above, 0], [c - r, above, 0]),
    ]);
  }
  return assembleWire([
    makeLine([c - r, above, 0], [c - r, top, 0]),
    makeThreePointArc([c - r, top, 0], [c, top - depth, 0], [c + r, top, 0]),
    makeLine([c + r, top, 0], [c + r, above, 0]),
    makeLine([c + r, above, 0], [c - r, above, 0]),
  ]);
}

/** The cutter for one finger cut-out, through the thickness range `t`. */
function scoopSolid(axis: Panel["axis"], s: ScoopSpec, t: Interval): Shape3D {
  const solid = basicFaceExtrusion(makeFace(scoopWire(s)), new Vector([0, 0, t[1] - t[0]])) as Shape3D;
  return placePanel(solid, { axis, u: [s.c - s.width / 2, s.c + s.width / 2], v: [s.top - s.depth, s.top + 1], t });
}

const floorCache = new WeakMap<ScoopSpec, [number, number][]>();

/**
 * The cut's lower edge below the top face, as a polyline ordered along u,
 * sampled from the cutter's own outline so it matches every shape exactly
 * enough for spacing holes around it.
 */
function scoopFloorLine(s: ScoopSpec): [number, number][] {
  const cached = floorCache.get(s);
  if (cached) return cached;
  const pts: [number, number][] = [];
  for (const edge of scoopWire(s).edges) {
    for (let i = 0; i <= 24; i++) {
      const p = edge.pointAt(i / 24);
      if (p.y < s.top - 1e-6) pts.push([p.x, p.y]);
    }
  }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  floorCache.set(s, pts);
  return pts;
}

/** Height of the scoop's lowest edge at u, or Infinity where it does not reach. */
function scoopFloorAt(s: ScoopSpec, u: number): number {
  const line = scoopFloorLine(s);
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const [u0, v0] = line[i];
    const [u1, v1] = line[i + 1];
    if (u < u0 - 1e-9 || u > u1 + 1e-9) continue;
    best = Math.min(best, u1 - u0 < 1e-9 ? Math.min(v0, v1) : v0 + ((u - u0) / (u1 - u0)) * (v1 - v0));
  }
  return best;
}

/** Lowest point of the scoop anywhere over [a, b]. */
function scoopFloor(s: ScoopSpec, a: number, b: number): number {
  let best = Math.min(scoopFloorAt(s, a), scoopFloorAt(s, b));
  for (const [u, v] of scoopFloorLine(s)) if (u >= a && u <= b) best = Math.min(best, v);
  return best;
}

/** How far (u, v), below the top edge, is from what the scoop removes. */
function scoopDistance(s: ScoopSpec, u: number, v: number): number {
  const line = scoopFloorLine(s);
  if (!line.length) return Infinity;
  if (u >= line[0][0] && u <= line[line.length - 1][0] && v >= scoopFloorAt(s, u)) return 0;
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = line[i];
    const [bx, by] = line[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const k = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((u - ax) * dx + (v - ay) * dy) / len2));
    best = Math.min(best, Math.hypot(u - (ax + k * dx), v - (ay + k * dy)));
  }
  return best;
}

/** A polygon in the XY plane extruded straight up by `height`. */
function polyFaceExtrude(pts: [number, number][], height: number): Shape3D {
  return basicFaceExtrusion(makeFace(polyWire(pts)), new Vector([0, 0, height])) as Shape3D;
}
