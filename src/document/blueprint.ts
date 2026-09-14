import type { SceneNode, Vec3 } from "./types";
import type { ScenePart } from "../kernel/types";
import * as THREE from "three";
import { resolveNodeColor } from "./tree";

export interface BlueprintGeometry {
  id: string;
  vertices: Vec3[];
  localSize: Vec3;
  edges?: [Vec3,Vec3][];
}

export interface BlueprintPart {
  id: string;
  name: string;
  color: string;
  kind: string;
  min: Vec3;
  max: Vec3;
  center: Vec3;
  worldSize: Vec3; // [width(X), depth(Y), height(Z)] in world space
  localSize: Vec3; // [length, width, thickness] in local space
  position: Vec3;
  rotation: Vec3;
  isHole?: boolean;
  corners: Vec3[];
  vertices?: Vec3[];
  edges?: [Vec3,Vec3][];
}

export interface BlueprintDimension {
  id: string;
  type: "horizontal" | "vertical";
  start: [number, number]; // [x, y] in view coordinate space
  end: [number, number];
  offset: number; // distance away from measured object
  valueMm: number;
  label: string;
  kind: "overall" | "part" | "clearance";
}

export interface OrthoViewData {
  viewType: "front" | "top" | "side" | "iso";
  title: string;
  bounds: { minX: number; maxX: number; minY: number; maxY: number; width: number; height: number };
  parts: Array<{
    id: string;
    name: string;
    color: string;
    rect: { x: number; y: number; width: number; height: number };
    isHole?: boolean;
    isoPolys?: Array<Array<[number, number]>>;
    outline?: Array<[number, number]>;
    edges?: Array<[[number,number],[number,number]]>;
  }>;
  dimensions: BlueprintDimension[];
}

export interface CutListItem {
  id: string;
  name: string;
  kind: string;
  count: number;
  lengthMm: number;
  widthMm: number;
  thicknessMm: number;
  color: string;
}

/** The four standard projections for one set of parts, plus their extents. */
export interface ViewSet {
  overallSize: Vec3; // [width, depth, height]
  frontView: OrthoViewData;
  topView: OrthoViewData;
  sideView: OrthoViewData;
  isoView: OrthoViewData;
}

/** A single element's own shop drawing. */
export interface PartSheet extends ViewSet {
  id: string;
  name: string;
  kind: string;
  color: string;
  count: number;
  lengthMm: number;
  widthMm: number;
  thicknessMm: number;
  size: Vec3;
}

export interface BlueprintData extends ViewSet {
  projectName: string;
  date: string;
  unit: string;
  parts: BlueprintPart[];
  cutList: CutListItem[];
  partSheets: PartSheet[];
}

/** What the part *is*, for the cut list's benefit. The node's own type is an
 *  editing-history detail — "edit", "build", "group" tell a carpenter nothing
 *  about the piece in their hand, so an edited box still reports as a box. */
function partKind(node: SceneNode): string {
  switch (node.type) {
    case "object": return node.kind;
    // `base` is always present on a well-formed edit, but a single missing
    // field should cost one table cell, not the whole drawing.
    case "edit": return node.base ? `${partKind(node.base)} (edited)` : "edited";
    case "group": case "build": return "assembly";
    case "import": return "imported";
    default: return "part";
  }
}

/** What each joinery fitting is called on a cut list. */
const FITTING_NAMES: Record<number, string> = {
  0: "Dovetail Key", 1: "Dowel", 2: "Square Key", 3: "Loose Tenon", 4: "Screw Boss",
};
const FITTING_KINDS: Record<number, string> = {
  0: "dovetail", 1: "dowel", 2: "key", 3: "tenon", 4: "boss",
};
/**
 * Fittings are scheduled under one neutral tone rather than the colour they
 * happen to carry in the model.
 *
 * A board's colour stands in for its material, so two differently coloured
 * boards are different stock and belong on different rows. A fitting's colour
 * is decoration the app assigned at random when the joint was placed — eight
 * dominoes cut from one stick arrive in eight colours, and keying on that
 * would print eight rows of "1× Loose Tenon" for one stick of stock.
 */
const FITTING_COLOR = "#9aa5b1";

/**
 * The stock size of a joinery plug, taken from the parameters that define it
 * rather than from a bounding box.
 *
 * A loose tenon is cut from known stock, and the model fuses each one into the
 * board it joins — so there is no separate solid to measure, but the numbers
 * are known exactly. Mirrors `makeConnectorSolid` in the kernel.
 *
 * Returns null for the print-in-place fittings (hinge, snap pin), which are
 * printed features rather than anything cut from timber.
 */
export function connectorStockSize(params: Record<string, number>): Vec3 | null {
  const shape = Math.round(params.shape ?? 0);
  const size = (key: string, fallback: number) => Math.max(0.01, params[key] ?? fallback);
  switch (shape) {
    case 0: {
      // The dovetail flares as it rises, so the widest point is the stock width.
      const width = size("width", 14), height = size("height", 6);
      const taper = Math.min(45, Math.max(2, params.taperAngle ?? 20)) * Math.PI / 180;
      return [width + 2 * height * Math.tan(taper), height, size("length", 12)];
    }
    case 1: { const across = size("radius", 5) * 2; return [across, across, size("length", 12)]; }
    case 2: { const across = size("width", 10); return [across, across, size("length", 12)]; }
    case 3: return [size("width", 20), size("thickness", 6), size("length", 15)];
    case 4: { const across = size("outerRadius", 4) * 2; return [across, across, size("length", 10)]; }
    default: return null;
  }
}

/**
 * Loose tenons, dowels and keys are pieces of timber in their own right, even
 * though the model fuses each one into the board it joins. They are collected
 * separately from the boards so they reach the cut list and earn their own
 * detail page carrying their own size.
 *
 * Sockets are skipped: a mortise is the void the tenon goes into, not
 * something anybody cuts to length.
 *
 * The box is built at the origin from the fitting's own stock size rather than
 * placed in the world. Where it sits is already drawn on the assembly sheet by
 * the board it is fused into; what is missing, and all a detail page needs, is
 * how big it is.
 */
export function extractConnectorParts(nodes: SceneNode[]): BlueprintPart[] {
  const result: BlueprintPart[] = [];
  const visit = (items: SceneNode[], excluded: boolean) => {
    for (const node of items) {
      const skip = excluded || !!node.hidden || !!node.isHole;
      if (node.type === "object" && node.kind === "connector") {
        if (skip || Math.round(node.params.fit ?? 0) === 1) continue;
        const stock = connectorStockSize(node.params);
        if (!stock) continue;
        const shape = Math.round(node.params.shape ?? 0);
        const label = FITTING_NAMES[shape] ?? "Joinery Part";
        const [width, thickness, length] = stock;
        const corners = [0, 1].flatMap(x => [0, 1].flatMap(y => [0, 1].map(z =>
          [x ? width : 0, y ? thickness : 0, z ? length : 0] as Vec3)));
        result.push({
          id: node.id,
          // A name the user chose is theirs; only the tool's own default is replaced.
          name: /^Joinery Joint\b/i.test(node.name ?? "") ? label : (node.name || label),
          color: FITTING_COLOR,
          kind: FITTING_KINDS[shape] ?? "fitting",
          min: [0, 0, 0], max: [width, thickness, length],
          center: [width / 2, thickness / 2, length / 2],
          worldSize: [width, thickness, length], localSize: [width, thickness, length],
          position: node.position, rotation: node.rotation,
          corners, vertices: corners,
        });
        continue;
      }
      if (node.type === "group") visit(node.children, skip);
      else if (node.type === "edit" && node.base) visit([node.base], skip);
      else if (node.type === "build") visit(node.sources, skip);
    }
  };
  visit(nodes, false);
  return result;
}

/** Surfaces within this of a plane count as lying on it. */
const TRIM_TOLERANCE = 0.05;

/**
 * Area of the largest closed outline among edges lying in one plane, measured
 * in that plane's two axes. A board face is one outline spanning the part; a
 * tenon's end is a small outline of its own. Edges arrive unordered and
 * unoriented, so outlines are walked into loops before the shoelace sum.
 */
function largestLoopArea(edges: [Vec3, Vec3][], u: number, v: number): number {
  const key = (p: Vec3) => `${Math.round(p[u] * 1e4)}:${Math.round(p[v] * 1e4)}`;
  const points = new Map<string, [number, number]>();
  const links = new Map<string, string[]>();
  for (const [a, b] of edges) {
    const ka = key(a), kb = key(b);
    if (ka === kb) continue;
    points.set(ka, [a[u], a[v]]); points.set(kb, [b[u], b[v]]);
    (links.get(ka) ?? links.set(ka, []).get(ka)!).push(kb);
    (links.get(kb) ?? links.set(kb, []).get(kb)!).push(ka);
  }
  const segment = (p: string, q: string) => (p < q ? `${p}|${q}` : `${q}|${p}`);
  const used = new Set<string>();
  let largest = 0;
  for (const [start, neighbours] of links) {
    for (const first of neighbours) {
      if (used.has(segment(start, first))) continue;
      used.add(segment(start, first));
      const loop = [start];
      let previous = start, current = first;
      while (current !== start) {
        loop.push(current);
        const next = links.get(current)!.find(n => n !== previous && !used.has(segment(current, n)))
          ?? links.get(current)!.find(n => n === start && !used.has(segment(current, n)));
        if (!next) break;
        used.add(segment(current, next));
        previous = current; current = next;
      }
      if (current !== start || loop.length < 3) continue;
      let area = 0;
      for (let i = 0; i < loop.length; i++) {
        const [x1, y1] = points.get(loop[i])!, [x2, y2] = points.get(loop[(i + 1) % loop.length])!;
        area += x1 * y2 - x2 * y1;
      }
      largest = Math.max(largest, Math.abs(area) / 2);
    }
  }
  return largest;
}

/** How far each plug fused into this node's subtree stands proud of the board
 *  it is glued into — its stock length. */
function fusedPlugLengths(node: SceneNode): number[] {
  const lengths = new Set<number>();
  // A scaled group stretches the tenons inside it along with the board: a
  // 20 mm tenon in a group scaled 0.66 along X stands 13.2 mm proud, and only
  // that length will match the geometry. Each axis's accumulated scale is a
  // candidate; the face walk in trimFusedPlugs decides which slab it fits.
  const visit = (items: SceneNode[], scale: Vec3) => {
    for (const child of items) {
      if (child.hidden || child.isHole) continue;
      const inner: Vec3 = [scale[0] * child.scale[0], scale[1] * child.scale[1], scale[2] * child.scale[2]];
      if (child.type === "object" && child.kind === "connector") {
        if (Math.round(child.params.fit ?? 0) === 1) continue;
        const stock = connectorStockSize(child.params);
        if (stock) for (const factor of inner) lengths.add(Math.abs(stock[2] * factor));
        continue;
      }
      if (child.type === "group") visit(child.children, inner);
      else if (child.type === "edit" && child.base) visit([child.base], inner);
      else if (child.type === "build") visit(child.sources, inner);
    }
  };
  const own = node.scale ?? [1, 1, 1];
  visit(node.type === "group" ? node.children
    : node.type === "build" ? node.sources
    : node.type === "edit" && node.base ? [node.base] : [], own);
  return [...lengths];
}

/**
 * Takes fused plug protrusions off a board's drawn geometry and its extents.
 *
 * The kernel fuses every tenon into the board it joins, so an 18 mm top with
 * 20 mm tenons standing proud of it measures 38 mm from corner to corner — and
 * a cut list built from that box sends the carpenter out for 38 mm stock. The
 * tenons are scheduled as pieces of their own now, so the board should measure,
 * and draw, as the board.
 *
 * A length match alone cannot say WHICH slab is the tenon. A 20 mm board with
 * 20 mm tenons on one face has two 20 mm slabs either side of that face, and
 * trimming every match took both and left a board 0 mm thick. What tells them
 * apart is the face: a tenon ends in a small face, a board in one spanning
 * most of the part. So each end is walked inward past small faces until the
 * first large one — the board's own face — and that slab comes off only if its
 * depth matches a plug length actually fused into this part, so a shaped board
 * is never quietly shortened. Walking, rather than looking one plane deep, is
 * what lets a chamfered dowel come off: its chamfer adds a plane of its own.
 *
 * The footprint ring left on the face is kept: that is where the tenon goes,
 * which is exactly what someone marking out the board wants to see.
 */
export function trimFusedPlugs(vertices: Vec3[], edges: [Vec3, Vec3][] | undefined, lengths: number[]):
    { vertices: Vec3[]; edges?: [Vec3, Vec3][]; trimmed: boolean } {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const point of vertices) for (const axis of [0, 1, 2]) {
    if (point[axis] < min[axis]) min[axis] = point[axis];
    if (point[axis] > max[axis]) max[axis] = point[axis];
  }
  const keepMin: Vec3 = [...min], keepMax: Vec3 = [...max];
  const matches = (gap: number) => lengths.some(length => Math.abs(length - gap) < TRIM_TOLERANCE);
  const plane = (value: number) => Math.round(value * 1000) / 1000;
  for (const axis of [0, 1, 2] as const) {
    const planes = [...new Set(vertices.map(p => plane(p[axis])))].sort((a, b) => a - b);
    // Two planes is a plain slab: nothing stands proud of anything.
    if (planes.length < 3) continue;
    const last = planes.length - 1;
    const [u, v] = ([0, 1, 2] as const).filter(a => a !== axis);
    const section = (max[u] - min[u]) * (max[v] - min[v]);
    if (edges?.length && section > 0) {
      const onPlane = new Map<number, [Vec3, Vec3][]>();
      for (const edge of edges) {
        const at = plane(edge[0][axis]);
        if (at !== plane(edge[1][axis])) continue;
        (onPlane.get(at) ?? onPlane.set(at, []).get(at)!).push(edge);
      }
      const small = (at: number) => largestLoopArea(onPlane.get(at) ?? [], u, v) < section * 0.5;
      let top = last;
      while (top > 0 && small(planes[top])) top--;
      if (top < last && matches(planes[last] - planes[top])) keepMax[axis] = planes[top];
      let bottom = 0;
      while (bottom < last && small(planes[bottom])) bottom++;
      if (bottom > 0 && matches(planes[bottom] - planes[0])) keepMin[axis] = planes[bottom];
    } else {
      // Without outlines there are no faces to compare, so when both ends
      // match there is no telling the tenon's slab from the board's. Trim only
      // when exactly one end does; otherwise leave the part as modelled.
      const high = matches(planes[last] - planes[last - 1]), low = matches(planes[1] - planes[0]);
      if (high && !low) keepMax[axis] = planes[last - 1];
      if (low && !high) keepMin[axis] = planes[1];
    }
    // Whatever the reasoning above, a part never loses a whole dimension.
    if (keepMax[axis] - keepMin[axis] <= TRIM_TOLERANCE) { keepMin[axis] = min[axis]; keepMax[axis] = max[axis]; }
  }
  if (keepMin.every((v, i) => v === min[i]) && keepMax.every((v, i) => v === max[i])) {
    return { vertices, edges, trimmed: false };
  }
  const inside = (p: Vec3) => p.every((v, i) => v >= keepMin[i] - TRIM_TOLERANCE && v <= keepMax[i] + TRIM_TOLERANCE);
  const kept = vertices.filter(inside);
  // Never trim a part down to nothing on a surprise; leave it as modelled.
  if (kept.length < 4) return { vertices, edges, trimmed: false };
  return { vertices: kept, edges: edges?.filter(([a, b]) => inside(a) && inside(b)), trimmed: true };
}

/** Local (cut) dimensions after a world-space trim. The cut list reads local
 *  size, so a trimmed board has to lose the same millimetres there — matched
 *  by value, since a rotated board's local axes are not its world axes. */
function trimLocalSize(localSize: Vec3, before: THREE.Box3, after: THREE.Box3): Vec3 {
  const next: Vec3 = [...localSize];
  const wasSize = before.getSize(new THREE.Vector3()).toArray();
  const nowSize = after.getSize(new THREE.Vector3()).toArray();
  const claimed = new Set<number>();
  for (const axis of [0, 1, 2]) {
    if (Math.abs(wasSize[axis] - nowSize[axis]) < TRIM_TOLERANCE) continue;
    let best = -1, closest = Infinity;
    for (let i = 0; i < 3; i++) {
      if (claimed.has(i)) continue;
      const gap = Math.abs(next[i] - wasSize[axis]);
      if (gap < closest) { closest = gap; best = i; }
    }
    if (best >= 0 && closest < Math.max(0.5, wasSize[axis] * 0.02)) { next[best] = nowSize[axis]; claimed.add(best); }
  }
  return next;
}

/**
 * Extracts accurate world bounding boxes and geometry for all active workpiece parts.
 */
export function extractBlueprintParts(nodes: SceneNode[], parts: ScenePart[], geometry?: BlueprintGeometry[]): BlueprintPart[] {
  const result: BlueprintPart[]=[];
  const source=new Map(parts.map(p=>[p.id,p]));
  const displayed=geometry ? new Map(geometry.map(p=>[p.id,p])) : null;
  const traverse=(items:SceneNode[])=>{
    for(const node of items) {
      // Reject the entire negative/hidden subtree, including named legacy tools.
      if(node.isHole || node.hidden) continue;
      // Joinery fittings are scheduled separately as pieces of their own, so
      // they must not also arrive here — by kind, since a renamed one would
      // slip past the legacy name check and be counted twice.
      if((node.type==='object' && node.kind==='connector') || /^Joinery Joint\b/i.test(node.name ?? '')) continue;
      const live=displayed?.get(node.id);
      const part=source.get(node.id);
      if(node.type==='group' && !live && !part) { traverse(node.children); continue; }
      if(displayed && !live) continue;
      let vertices=live?.vertices;
      let localSize=live?.localSize;
      if(!vertices && part) {
        // Kernel ScenePart buffers are local geometry. Match the viewport's
        // centre-pivot transform rather than rotating an invented box.
        const raw=part.mesh.faces.vertices;
        const box=new THREE.Box3();
        for(let i=0;i<raw.length;i+=3) box.expandByPoint(new THREE.Vector3(raw[i],raw[i+1],raw[i+2]));
        if(box.isEmpty()) continue;
        const pivot=box.getCenter(new THREE.Vector3());
        const scale=new THREE.Vector3(...node.scale);
        localSize=box.getSize(new THREE.Vector3()).multiply(scale).toArray().map(Math.abs) as Vec3;
        const matrix=new THREE.Matrix4().compose(new THREE.Vector3(...node.position),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(...node.rotation.map(v=>v*Math.PI/180) as [number,number,number],'XYZ')),scale);
        vertices=[];
        for(let i=0;i<raw.length;i+=3) vertices.push(new THREE.Vector3(raw[i],raw[i+1],raw[i+2]).sub(pivot).applyMatrix4(matrix).toArray() as Vec3);
      }
      if(!vertices?.length || !localSize) continue;
      let edges=live?.edges;
      // A vertex-only capture still uses the renderer's original index order
      // (syncFaces copies kernel positions and indices without reordering).
      if(!edges && part && vertices.length*3===part.mesh.faces.vertices.length) {
        const mesh=new THREE.BufferGeometry();
        mesh.setAttribute('position',new THREE.Float32BufferAttribute(vertices.flat(),3));
        mesh.setIndex(Array.from(part.mesh.faces.triangles));
        const outline=new THREE.EdgesGeometry(mesh,1),positions=outline.getAttribute('position');
        edges=[];
        for(let i=0;i<positions.count;i+=2) edges.push([
          new THREE.Vector3().fromBufferAttribute(positions,i).toArray() as Vec3,
          new THREE.Vector3().fromBufferAttribute(positions,i+1).toArray() as Vec3]);
        outline.dispose();mesh.dispose();
      }
      let box=new THREE.Box3(); vertices.forEach(p=>box.expandByPoint(new THREE.Vector3(...p)));
      // Tenons fused into this board are scheduled as pieces of their own, so
      // they must not also make the board measure — or draw — thicker than it is.
      const protrusions=fusedPlugLengths(node);
      if(protrusions.length) {
        const bare=trimFusedPlugs(vertices,edges,protrusions);
        if(bare.trimmed) {
          vertices=bare.vertices; edges=bare.edges;
          const trimmedBox=new THREE.Box3(); vertices.forEach(p=>trimmedBox.expandByPoint(new THREE.Vector3(...p)));
          localSize=trimLocalSize(localSize,box,trimmedBox);
          box=trimmedBox;
        }
      }
      const min=box.min.toArray() as Vec3,max=box.max.toArray() as Vec3;
      result.push({id:node.id,name:node.name || `Part ${result.length+1}`,color:resolveNodeColor(node),
        kind:partKind(node),min,max,center:box.getCenter(new THREE.Vector3()).toArray() as Vec3,
        worldSize:box.getSize(new THREE.Vector3()).toArray() as Vec3,localSize,
        position:node.position,rotation:node.rotation,corners:vertices,vertices,edges});
    }
  };
  traverse(nodes); return result;
}

/** Monotone-chain projected hull: true outer extents of the mesh, not its AABB. */
export function projectedHull(points:Array<[number,number]>):Array<[number,number]> {
  const unique=new Map(points.map(p=>[p.map(v=>v.toFixed(6)).join(','),p]));
  const sorted=[...unique.values()].sort((a,b)=>a[0]-b[0] || a[1]-b[1]);
  if(sorted.length<3) return sorted;
  const cross=(a:number[],b:number[],c:number[])=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  const chain=(list:Array<[number,number]>)=>{const out:Array<[number,number]>=[]; for(const p of list) {
    while(out.length>=2 && cross(out[out.length-2],out[out.length-1],p)<=1e-9) out.pop(); out.push(p);
  } return out;};
  const lower=chain(sorted),upper=chain([...sorted].reverse()); lower.pop(); upper.pop(); return [...lower,...upper];
}

export interface OpeningSpan { min: number; max: number }

/** Surfaces closer than this count as touching, not as a gap worth stating. */
const TOUCH = 0.05;

/**
 * Face-to-face openings along one world axis: the numbers a carpenter reaches
 * for first — clear height between shelves, internal carcass width between the
 * sides, the clear span between two legs.
 *
 * This measures *opposed parts*, not empty projected space. Measuring
 * emptiness is what a projection cannot do: in a front elevation the carcass
 * sides run the full height and the shelves run the full width, so the union
 * of everything is one solid block and no gap survives — likewise a tabletop
 * bridges its legs. The distance from the top of one shelf to the underside of
 * the next is still a real opening, and this finds it by pairing parts that
 * face each other across the axis.
 *
 * A pair qualifies when the two parts substantially overlap on both other axes
 * (so a front leg is never measured against a back leg it does not face), and
 * when nothing sits *strictly* between them. "Strictly" matters: a shelf that
 * runs wall-to-wall touches both sides, which makes it a spanning member rather
 * than an obstruction, so it does not suppress the internal-width dimension it
 * happens to fill.
 */
export function openingSpans(parts: BlueprintPart[], axis: 0|1|2): OpeningSpan[] {
  const others = ([0,1,2] as const).filter(a => a !== axis);
  // Opposed enough to be facing each other, not merely adjacent in passing.
  const faces = (a: BlueprintPart, b: BlueprintPart) => others.every(ax => {
    const shared = Math.min(a.max[ax], b.max[ax]) - Math.max(a.min[ax], b.min[ax]);
    const smaller = Math.min(a.max[ax] - a.min[ax], b.max[ax] - b.min[ax]);
    return shared > Math.max(TOUCH, smaller * 0.25);
  });
  const spans = new Map<string, OpeningSpan>();
  for (const a of parts) for (const b of parts) {
    if (a === b) continue;
    const min = a.max[axis], max = b.min[axis];
    if (max - min < 0.1 || !faces(a, b)) continue;
    const blocked = parts.some(c => c !== a && c !== b &&
      c.min[axis] > min + TOUCH && c.max[axis] < max - TOUCH && faces(c, a) && faces(c, b));
    if (blocked) continue;
    // Opposed pairs repeat the same opening (both cabinet sides sit either side
    // of every shelf); one dimension line is enough.
    spans.set(`${min.toFixed(3)}:${max.toFixed(3)}`, { min, max });
  }
  return [...spans.values()].sort((p, q) => p.min - q.min || p.max - q.max);
}

export interface RailSpan extends OpeningSpan { kind: "clearance" | "part" }

/**
 * The size of each individual element, so the drawing says how wide a leg is
 * and how thick a panel is rather than only how big the whole assembly is.
 *
 * One entry per distinct size on each axis: four identical legs need the
 * number stated once, not four times. Sizes already carried by the overall
 * dimension, or by an opening of the same value, are left off — repeating a
 * number in two places on one drawing invites the two to disagree.
 */
export function partSpans(parts: BlueprintPart[], axis: 0|1|2,
    overall: [number, number], taken: number[]): RailSpan[] {
  const seen = new Set(taken.map(value => value.toFixed(1)));
  const spans: RailSpan[] = [];
  for (const part of parts) {
    const min = part.min[axis], max = part.max[axis], size = max - min;
    if (size < 0.1) continue;
    if (Math.abs(min - overall[0]) < TOUCH && Math.abs(max - overall[1]) < TOUCH) continue;
    const key = size.toFixed(1);
    if (seen.has(key)) continue;
    seen.add(key);
    spans.push({ min, max, kind: "part" });
  }
  return spans.sort((a, b) => a.min - b.min || a.max - b.max);
}

/** Openings and element sizes measured on dedicated outside rails, one set per
 * view axis. A label gets a separate lane when its text interval would collide.
 *
 * Small elements are dimensioned out here rather than across the element
 * itself: on a 1000 mm drawing a 50 mm leg is narrower than its own label, so
 * the number sits on the rail and its extension lines point back to the leg. */
export function railDimensions(view:OrthoViewData,spans:[RailSpan[],RailSpan[]]=[[],[]]):BlueprintDimension[] {
  if(view.viewType==='iso') return [];
  const result:BlueprintDimension[]=[];
  const span=Math.max(view.bounds.width,view.bounds.height,20);
  const sf=Math.max(0.6,Math.min(3,span/100));
  for(const axis of [0,1]) {
    const lanes:number[][]=[[],[],[],[],[]];
    spans[axis].forEach((entry,i)=>{
      const a=entry.min,b=entry.max;
      if(b-a<0.1) return;
      const label=`${(b-a).toFixed(1)} mm`,middle=(a+b)/2;
      const half=(label.length*3.6+6)*sf/2;
      const lane=lanes.findIndex(used=>used.every((end,j)=>j%2===1 || middle+half<end || middle-half>used[j+1]));
      if(lane<0) return;
      lanes[lane].push(middle-half,middle+half);
      // Overall dimensions occupy top/left (right for the side view).
      const offset=Math.max(14,span*0.08)+(lane*12*sf);
      result.push({id:`${view.viewType}-${entry.kind}-${axis}-${i}`,type:axis===0?'horizontal':'vertical',
        start:axis===0?[a,view.bounds.minY]:[view.viewType==='side'?view.bounds.minX:view.bounds.maxX,a],
        end:axis===0?[b,view.bounds.minY]:[view.viewType==='side'?view.bounds.minX:view.bounds.maxX,b],
        offset:axis===0 || view.viewType==='side'?-offset:offset,valueMm:b-a,label,kind:entry.kind});
    });
  }
  return result;
}
/**
 * The name a cut list should group on. Duplicating a part appends "(Copy)" and
 * each new primitive gets a running number, so three identical shelves reach
 * here as "Shelf", "Shelf (Copy)" and "Shelf (Copy) (Copy)". Grouping on the
 * raw name prints one row per board and hands the carpenter a quantity of 1
 * for a part they have to cut three of.
 */
export function partFamilyName(name: string): string {
  let family = name.trim(), previous = "";
  while (family !== previous) { previous = family; family = family.replace(/\s*\((?:copy|duplicate)\)$/i, "").trim(); }
  return family.replace(/\s+\d+$/, "").trim() || name.trim();
}

/**
 * Generates the Cut List breakdown.
 */
export function generateCutList(parts: BlueprintPart[]): CutListItem[] {
  const list: CutListItem[] = [];
  const solidParts = parts.filter((p) => !p.isHole);

  for (const part of solidParts) {
    const dims = [part.localSize[0], part.localSize[1], part.localSize[2]].sort((a, b) => b - a);
    const lengthMm = Math.round(dims[0] * 10) / 10;
    const widthMm = Math.round(dims[1] * 10) / 10;
    const thicknessMm = Math.round(dims[2] * 10) / 10;
    const name = partFamilyName(part.name);

    const existing = list.find(
      (item) =>
        item.lengthMm === lengthMm &&
        item.widthMm === widthMm &&
        item.thicknessMm === thicknessMm &&
        item.kind === part.kind && item.color === part.color && item.name === name
    );

    if (existing) {
      existing.count += 1;
    } else {
      list.push({
        id: part.id,
        name,
        kind: part.kind,
        count: 1,
        lengthMm,
        widthMm,
        thicknessMm,
        color: part.color,
      });
    }
  }

  return list.sort((a,b)=>b.lengthMm-a.lengthMm || b.widthMm-a.widthMm || b.thicknessMm-a.thicknessMm || a.name.localeCompare(b.name));
}

/**
 * Builds standard 2D Orthographic Projections & Dimension annotations.
 *
 * Runs over the whole assembly for the main sheet and over a single part for
 * that part's own detail page, so both are measured by identical rules. With
 * one part there is nothing to face it across a gap and nothing whose size the
 * overall dimension does not already state, so a detail page comes out with
 * just that part's own extents — which is exactly what it should carry.
 */
export function buildViews(solidParts: BlueprintPart[]): ViewSet {
  if (solidParts.length === 0) {
    const emptyView = (title: string, viewType: "front" | "top" | "side" | "iso"): OrthoViewData => ({
      viewType,
      title,
      bounds: { minX: 0, maxX: 100, minY: 0, maxY: 100, width: 100, height: 100 },
      parts: [],
      dimensions: [],
    });
    return {
      overallSize: [0, 0, 0],
      frontView: emptyView("Front View (X-Z)", "front"),
      topView: emptyView("Top View (X-Y)", "top"),
      sideView: emptyView("Right Side View (Y-Z)", "side"),
      isoView: emptyView("Isometric 3D View", "iso"),
    };
  }

  // Overall bounding box
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of solidParts) {
    if (p.min[0] < minX) minX = p.min[0];
    if (p.max[0] > maxX) maxX = p.max[0];
    if (p.min[1] < minY) minY = p.min[1];
    if (p.max[1] > maxY) maxY = p.max[1];
    if (p.min[2] < minZ) minZ = p.min[2];
    if (p.max[2] > maxZ) maxZ = p.max[2];
  }

  const overallSize: Vec3 = [
    Math.round((maxX - minX) * 10) / 10,
    Math.round((maxY - minY) * 10) / 10,
    Math.round((maxZ - minZ) * 10) / 10,
  ];

  const maxModelDim = Math.max(overallSize[0], overallSize[1], overallSize[2]);
  const viewMargin = Math.max(18, maxModelDim * 0.14);

  // Helper to build Front View (X horizontal, Z vertical)
  const buildFrontView = (): OrthoViewData => {
    const viewParts = solidParts.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      outline: projectedHull((p.vertices ?? p.corners).map(v=>[v[0],v[2]])),
      edges: p.edges?.map(edge=>edge.map(v=>[v[0],v[2]]) as [[number,number],[number,number]]),
      rect: {
        x: p.min[0],
        y: p.min[2],
        width: p.worldSize[0],
        height: p.worldSize[2],
      },
    }));

    const dims: BlueprintDimension[] = [];

    // Overall Width (Top)
    dims.push({
      id: "front-overall-w",
      type: "horizontal",
      start: [minX, maxZ],
      end: [maxX, maxZ],
      offset: viewMargin,
      valueMm: overallSize[0],
      label: `${overallSize[0]} mm`,
      kind: "overall",
    });

    // Overall Height (Left)
    dims.push({
      id: "front-overall-h",
      type: "vertical",
      start: [minX, minZ],
      end: [minX, maxZ],
      offset: -viewMargin,
      valueMm: overallSize[2],
      label: `${overallSize[2]} mm`,
      kind: "overall",
    });

    return {
      viewType: "front",
      title: "Front View (Elevation)",
      bounds: { minX, maxX, minY: minZ, maxY: maxZ, width: maxX - minX, height: maxZ - minZ },
      parts: viewParts,
      dimensions: dims,
    };
  };

  // Helper to build Top View (X horizontal, Y vertical)
  const buildTopView = (): OrthoViewData => {
    const viewParts = solidParts.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      outline: projectedHull((p.vertices ?? p.corners).map(v=>[v[0],v[1]])),
      edges: p.edges?.map(edge=>edge.map(v=>[v[0],v[1]]) as [[number,number],[number,number]]),
      rect: {
        x: p.min[0],
        y: p.min[1],
        width: p.worldSize[0],
        height: p.worldSize[1],
      },
    }));

    const dims: BlueprintDimension[] = [];

    // Overall Width (Top)
    dims.push({
      id: "top-overall-w",
      type: "horizontal",
      start: [minX, maxY],
      end: [maxX, maxY],
      offset: viewMargin,
      valueMm: overallSize[0],
      label: `${overallSize[0]} mm`,
      kind: "overall",
    });

    // Overall Depth (Left)
    dims.push({
      id: "top-overall-d",
      type: "vertical",
      start: [minX, minY],
      end: [minX, maxY],
      offset: -viewMargin,
      valueMm: overallSize[1],
      label: `${overallSize[1]} mm`,
      kind: "overall",
    });

    return {
      viewType: "top",
      title: "Top View (Plan)",
      bounds: { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY },
      parts: viewParts,
      dimensions: dims,
    };
  };

  // Helper to build Right Side View (Y horizontal, Z vertical)
  const buildSideView = (): OrthoViewData => {
    const viewParts = solidParts.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      outline: projectedHull((p.vertices ?? p.corners).map(v=>[v[1],v[2]])),
      edges: p.edges?.map(edge=>edge.map(v=>[v[1],v[2]]) as [[number,number],[number,number]]),
      rect: {
        x: p.min[1],
        y: p.min[2],
        width: p.worldSize[1],
        height: p.worldSize[2],
      },
    }));

    const dims: BlueprintDimension[] = [];

    // Overall Depth (Top)
    dims.push({
      id: "side-overall-d",
      type: "horizontal",
      start: [minY, maxZ],
      end: [maxY, maxZ],
      offset: viewMargin,
      valueMm: overallSize[1],
      label: `${overallSize[1]} mm`,
      kind: "overall",
    });

    // Overall Height (Right)
    dims.push({
      id: "side-overall-h",
      type: "vertical",
      start: [maxY, minZ],
      end: [maxY, maxZ],
      offset: viewMargin,
      valueMm: overallSize[2],
      label: `${overallSize[2]} mm`,
      kind: "overall",
    });

    return {
      viewType: "side",
      title: "Right Side View (Profile)",
      bounds: { minX: minY, maxX: maxY, minY: minZ, maxY: maxZ, width: maxY - minY, height: maxZ - minZ },
      parts: viewParts,
      dimensions: dims,
    };
  };

  // Helper to build Isometric View from oriented world corners
  const buildIsoView = (): OrthoViewData => {
    const cos30 = Math.cos(Math.PI / 6);
    const sin30 = Math.sin(Math.PI / 6);

    const projectIso = (x: number, y: number, z: number): [number, number] => {
      return [(x - y) * cos30, z + (x + y) * sin30];
    };

    let isoMinX = Infinity, isoMinY = Infinity;
    let isoMaxX = -Infinity, isoMaxY = -Infinity;

    // Sort parts from back to front for painters algorithm
    const sortedParts = [...solidParts].sort((a, b) => (a.center[0] + a.center[1]) - (b.center[0] + b.center[1]));

    const viewParts = sortedParts.map((p) => {
      const projCorners = p.corners.map(([x, y, z]) => projectIso(x, y, z));

      for (const [px, py] of projCorners) {
        if (px < isoMinX) isoMinX = px;
        if (px > isoMaxX) isoMaxX = px;
        if (py < isoMinY) isoMinY = py;
        if (py > isoMaxY) isoMaxY = py;
      }

      const hull=projectedHull(projCorners);
      return {id:p.id,name:p.name,color:p.color,
        rect:{x:isoMinX,y:isoMinY,width:isoMaxX-isoMinX,height:isoMaxY-isoMinY},
        outline:hull,isoPolys:[hull],edges:p.edges?.map(edge=>edge.map(v=>projectIso(...v)) as [[number,number],[number,number]])};    });

    return {
      viewType: "iso",
      title: "Isometric 3D Assembly",
      bounds: { minX: isoMinX, maxX: isoMaxX, minY: isoMinY, maxY: isoMaxY, width: isoMaxX - isoMinX, height: isoMaxY - isoMinY },
      parts: viewParts,
      dimensions: [],
    };
  };

  // Openings and element sizes are properties of the model, not of a
  // projection, so they are found once in world space and then handed to
  // whichever views measure along those axes: front is X-Z, top is X-Y,
  // side is Y-Z.
  const range:[number,number][]=[[minX,maxX],[minY,maxY],[minZ,maxZ]];
  const openings=[0,1,2].map(axis=>openingSpans(solidParts,axis as 0|1|2));
  const sizes=[0,1,2].map(axis=>partSpans(solidParts,axis as 0|1|2,range[axis],openings[axis].map(s=>s.max-s.min)));
  const rail=(axis:number):RailSpan[]=>
    [...openings[axis].map(s=>({...s,kind:"clearance" as const})),...sizes[axis]];
  const dimensioned=(view:OrthoViewData,spans:[RailSpan[],RailSpan[]])=>
    ({...view,dimensions:[...view.dimensions,...railDimensions(view,spans)]});
  return {
    overallSize,
    frontView: dimensioned(buildFrontView(),[rail(0),rail(2)]),
    topView: dimensioned(buildTopView(),[rail(0),rail(1)]),
    sideView: dimensioned(buildSideView(),[rail(1),rail(2)]),
    isoView: buildIsoView(),
  };
}

/**
 * One shop drawing per distinct element: the part on its own, dimensioned, at
 * its own scale, ready to be a page of its own at the bench.
 *
 * Identical pieces share a page and carry a quantity — four legs cut to the
 * same size are one drawing marked "4× required", not four drawings a
 * carpenter has to compare to be sure they really are the same.
 */
export function generatePartSheets(parts: BlueprintPart[]): PartSheet[] {
  const solid = parts.filter(p => !p.isHole);
  const byItem = new Map<string, BlueprintPart>();
  for (const part of solid) {
    // Keyed exactly as the cut list groups, so the pages and the schedule can
    // never disagree about what counts as the same piece.
    const dims = [...part.localSize].sort((a, b) => b - a).map(v => Math.round(v * 10) / 10);
    const key = `${partFamilyName(part.name)}|${part.kind}|${part.color}|${dims.join('x')}`;
    if (!byItem.has(key)) byItem.set(key, part);
  }
  const counts = new Map(generateCutList(solid).map(item =>
    [`${item.name}|${item.kind}|${item.color}|${item.lengthMm}x${item.widthMm}x${item.thicknessMm}`, item]));

  return [...byItem.entries()].map(([key, part]) => {
    const item = counts.get(key);
    // A detail page shows the part where it was modelled; re-centring it would
    // only make the numbers harder to check against the assembly sheet.
    const views = buildViews([part]);
    return {
      id: part.id,
      name: partFamilyName(part.name),
      kind: part.kind,
      color: part.color,
      count: item?.count ?? 1,
      lengthMm: item?.lengthMm ?? 0,
      widthMm: item?.widthMm ?? 0,
      thicknessMm: item?.thicknessMm ?? 0,
      size: views.overallSize,
      ...views,
    };
  }).sort((a, b) => b.lengthMm - a.lengthMm || b.widthMm - a.widthMm || a.name.localeCompare(b.name));
}

/**
 * Builds the whole workshop package: assembly projections, cut list, and a
 * detail drawing for every distinct element.
 */
export function generateBlueprintData(projectName: string, nodes: SceneNode[], parts: ScenePart[], geometry?: BlueprintGeometry[]): BlueprintData {
  const bpParts = extractBlueprintParts(nodes, parts, geometry);
  const solidParts = bpParts.filter((p) => !p.isHole);
  // Boards plus the loose fittings that join them. The drawings stay on the
  // boards alone — a fused tenon is already drawn by the board it belongs to,
  // and adding it again would only double its outline.
  const schedule = [...bpParts, ...extractConnectorParts(nodes)];
  return {
    projectName: projectName || "ShapeForge Project",
    date: new Date().toLocaleDateString("en-GB"),
    unit: "mm",
    parts: bpParts,
    cutList: generateCutList(schedule),
    partSheets: generatePartSheets(schedule),
    ...buildViews(solidParts),
  };
}
