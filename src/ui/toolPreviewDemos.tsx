import { useMemo, type ReactNode } from "react";

/*
 * The animations behind the toolbar hover previews (see ToolPreview.tsx).
 * All hand-drawn isometric SVG, so there are no recordings to keep current.
 *
 * Two styles live here: the first few demos are timed SMIL animations; the
 * rest use Flip, which renders a demo as a function of time into a looping
 * flipbook of frames — far easier to write and adjust per tool.
 */

// ---------------------------------------------------------------- iso helpers

const K = 2.2;           // px per model unit
const OX = 120, OY = 86; // screen position of the model origin
const DUR = "4.5s";

type P3 = [number, number, number];
const iso = ([x, y, z]: P3): [number, number] =>
  [OX + (x - y) * 0.866 * K, OY + (x + y) * 0.5 * K - z * K];
/** Screen offset of a model-space move. */
const isoDelta = ([x, y, z]: P3): [number, number] =>
  [(x - y) * 0.866 * K, (x + y) * 0.5 * K - z * K];
const pts = (...ps: P3[]) => ps.map((p) => iso(p).map((v) => v.toFixed(1)).join(",")).join(" ");
const xy = (p: [number, number]) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`;

type Box = { x: [number, number]; y: [number, number]; z: [number, number] };
function boxFaces({ x: [x0, x1], y: [y0, y1], z: [z0, z1] }: Box) {
  return {
    top: pts([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]),
    left: pts([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]),
    right: pts([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]),
    bottom: pts([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]),
  };
}

type Tint = { top: string; left: string; right: string };
const TINTS = {
  target: { top: "#f8c3b2", left: "#ee9f88", right: "#d9826b" },
  source: { top: "#8f84f2", left: "#6f62e6", right: "#5547c9" },
  neutral: { top: "#e2e8f0", left: "#c4ced9", right: "#a7b4c2" },
  ghost: { top: "#29b8bb", left: "#29b8bb", right: "#29b8bb" },
} satisfies Record<string, Tint>;
const HIGHLIGHT = "#f59e0b";
const EDGE = "#334155";

function BoxShape({ box, tint, opacity = 1 }: { box: Box; tint: Tint; opacity?: number }) {
  const f = boxFaces(box);
  return (
    <g strokeWidth={0.8} stroke={EDGE} strokeLinejoin="round" opacity={opacity}>
      <polygon points={f.left} fill={tint.left} />
      <polygon points={f.right} fill={tint.right} />
      <polygon points={f.top} fill={tint.top} />
    </g>
  );
}

// SMIL wrappers. Every animation shares DUR and loops, so the pieces of one
// demo stay in step; `t` holds the keyTimes (0 … 1) for `v`.
const seq = (a: (string | number)[]) => a.join(";");
function Anim({ attr, v, t }: { attr: string; v: (string | number)[]; t: number[] }) {
  return <animate attributeName={attr} values={seq(v)} keyTimes={seq(t)} dur={DUR} repeatCount="indefinite" />;
}
function Move({ v, t }: { v: [number, number][]; t: number[] }) {
  return <animateTransform attributeName="transform" type="translate" values={seq(v.map(xy))} keyTimes={seq(t)} dur={DUR} repeatCount="indefinite" />;
}

/** Pointer arrow that glides between `at` positions and ripples on `clicks`. */
function Cursor({ at, t, clicks }: { at: [number, number][]; t: number[]; clicks: number[] }) {
  return (
    <g>
      <Move v={at} t={t} />
      {clicks.map((c) => (
        <circle key={c} r={0} fill="none" stroke="#00a7a5" strokeWidth={1.6}>
          <Anim attr="r" v={[0, 0, 11, 11]} t={[0, c, Math.min(c + 0.07, 0.99), 1]} />
          <Anim attr="opacity" v={[0, 0, 1, 0, 0]} t={[0, c, c + 0.005, Math.min(c + 0.07, 0.99), 1]} />
        </circle>
      ))}
      <path d="M0 0 L0 13 L3.4 9.8 L6 15.2 L8.2 14.2 L5.7 9 L10.2 9 Z" fill="#0f172a" stroke="#fff" strokeWidth={1} strokeLinejoin="round" />
    </g>
  );
}

/** Step captions that swap at the given times. */
function Captions({ items }: { items: [string, number, number][] }) {
  return (
    <g fontSize={9.5} fontWeight={600} fill="#475569" textAnchor="middle">
      {items.map(([text, from, to]) => (
        <text key={text} x={120} y={146} opacity={0}>
          {text}
          <Anim attr="opacity" v={[0, 0, 1, 1, 0, 0]} t={[0, from, from + 0.01, to - 0.01, to, 1]} />
        </text>
      ))}
    </g>
  );
}

// -------------------------------------------------------------------- demos

function PlaceOnObjectDemo() {
  const target: Box = { x: [-16, 16], y: [-16, 16], z: [0, 12] };
  const src: Box = { x: [20, 30], y: [-31, -21], z: [8, 18] };
  const srcCentre: P3 = [25, -26, 8];
  // Two spots on the target's top the ghost passes through, then pins at B.
  const onTop = (cx: number, cy: number): [number, number] =>
    isoDelta([cx - srcCentre[0], cy - srcCentre[1], 12 - srcCentre[2]]);
  const A = onTop(-8, 4), B = onTop(4, -4);
  const bottomFace = boxFaces(src).bottom;
  const ghostTop = (d: [number, number]): [number, number] => {
    const c = iso([25, -26, 18]);
    return [c[0] + d[0] - 2, c[1] + d[1] + 6];
  };
  const pickFace = iso([25, -26, 8]);
  return (
    <>
      <BoxShape box={target} tint={TINTS.target} />
      {/* Ghost follows the pointer across the target, then pins. */}
      <g opacity={0}>
        <Anim attr="opacity" v={[0, 0, 0.55, 0.55, 0, 0]} t={[0, 0.3, 0.32, 0.64, 0.7, 1]} />
        <Move v={[A, A, B, B]} t={[0, 0.32, 0.5, 1]} />
        <BoxShape box={src} tint={TINTS.ghost} />
      </g>
      {/* The source itself: its picked face lights up, then it moves in. */}
      <g>
        <Move v={[[0, 0], [0, 0], B, B, [0, 0]]} t={[0, 0.64, 0.74, 0.97, 1]} />
        <BoxShape box={src} tint={TINTS.source} />
        <polygon points={bottomFace} fill="none" stroke={HIGHLIGHT} strokeWidth={2} strokeDasharray="3 2" opacity={0}>
          <Anim attr="opacity" v={[0, 0, 1, 1, 0, 0]} t={[0, 0.12, 0.13, 0.64, 0.7, 1]} />
        </polygon>
      </g>
      <g opacity={0}>
        <Anim attr="opacity" v={[0, 0, 1, 1, 0, 0]} t={[0, 0.52, 0.53, 0.64, 0.66, 1]} />
        <rect x={150} y={96} width={46} height={16} rx={8} fill="#00a7a5" />
        <text x={173} y={107} fontSize={9} fontWeight={700} fill="#fff" textAnchor="middle">✓ Pinned</text>
      </g>
      <Cursor
        at={[[200, 130], [pickFace[0], pickFace[1] + 2], [pickFace[0], pickFace[1] + 2], ghostTop(A), ghostTop(B), ghostTop(B), [200, 130], [200, 130]]}
        t={[0, 0.1, 0.24, 0.32, 0.5, 0.62, 0.74, 1]}
        clicks={[0.12, 0.51]}
      />
      <Captions items={[
        ["1 · Click the face that should touch", 0, 0.28],
        ["2 · Hover the target, click to pin", 0.28, 0.62],
        ["3 · Apply placement", 0.62, 1],
      ]} />
    </>
  );
}

function PushPullDemo() {
  const t = [0, 0.18, 0.55, 0.82, 1];
  const heights = [8, 8, 20, 20, 8];
  const x: [number, number] = [-17, 17], y: [number, number] = [-11, 11];
  const faces = heights.map((h) => boxFaces({ x, y, z: [0, h] }));
  const grip = heights.map((h) => iso([0, 0, h]));
  const tip = heights.map((h) => iso([0, 0, h + 9]));
  // Shifted down so the fully pulled box still fits the frame.
  return (
    <>
      <g transform="translate(0 12)">
      <g strokeWidth={0.8} stroke={EDGE} strokeLinejoin="round">
        <polygon fill={TINTS.neutral.left}><Anim attr="points" v={faces.map((f) => f.left)} t={t} /></polygon>
        <polygon fill={TINTS.neutral.right}><Anim attr="points" v={faces.map((f) => f.right)} t={t} /></polygon>
        <polygon fill={TINTS.neutral.top}>
          <Anim attr="points" v={faces.map((f) => f.top)} t={t} />
          <Anim attr="fill" v={[TINTS.neutral.top, TINTS.neutral.top, "#fcd88a", "#fcd88a", TINTS.neutral.top, TINTS.neutral.top]} t={[0, 0.12, 0.13, 0.82, 0.83, 1]} />
        </polygon>
      </g>
      <g stroke="#00a7a5" strokeWidth={1.8} fill="#00a7a5" opacity={0}>
        <Anim attr="opacity" v={[0, 0, 1, 1, 0, 0]} t={[0, 0.13, 0.15, 0.8, 0.82, 1]} />
        <line><Anim attr="x1" v={grip.map((p) => p[0])} t={t} /><Anim attr="y1" v={grip.map((p) => p[1])} t={t} /><Anim attr="x2" v={tip.map((p) => p[0])} t={t} /><Anim attr="y2" v={tip.map((p) => p[1])} t={t} /></line>
        <circle r={3}><Anim attr="cx" v={tip.map((p) => p[0])} t={t} /><Anim attr="cy" v={tip.map((p) => p[1])} t={t} /></circle>
      </g>
      <g opacity={0}>
        <Anim attr="opacity" v={[0, 0, 1, 1, 0, 0]} t={[0, 0.3, 0.32, 0.8, 0.82, 1]} />
        <rect x={170} y={30} width={50} height={16} rx={4} fill="#fff" stroke="#cbd5e1" />
        <text x={195} y={41} fontSize={9} fontWeight={700} fill="#0f172a" textAnchor="middle">+12 mm</text>
      </g>
      <Cursor at={[[200, 110], ...tip.slice(1).map((p) => [p[0] + 1, p[1] + 1] as [number, number])]} t={t} clicks={[0.12]} />
      </g>
      <Captions items={[
        ["Click a face, then drag", 0, 0.55],
        ["…or type an exact distance", 0.55, 1],
      ]} />
    </>
  );
}

function HollowDemo() {
  const outer: Box = { x: [-19, 19], y: [-19, 19], z: [0, 20] };
  const w = 4, floor = 3;
  const i0 = -19 + w, i1 = 19 - w;
  const opening = pts([i0, i0, 20], [i1, i0, 20], [i1, i1, 20], [i0, i1, 20]);
  const backX = pts([i0, i0, 20], [i0, i1, 20], [i0, i1, floor], [i0, i0, floor]);
  const backY = pts([i0, i0, 20], [i1, i0, 20], [i1, i0, floor], [i0, i0, floor]);
  const innerFloor = pts([i0, i0, floor], [i1, i0, floor], [i1, i1, floor], [i0, i1, floor]);
  const c = iso([0, 0, 20]);
  const f = boxFaces(outer);
  const rimOut = iso([19, 0, 20]), rimIn = iso([i1, 0, 20]);
  const rimMid: [number, number] = [(rimOut[0] + rimIn[0]) / 2, (rimOut[1] + rimIn[1]) / 2];
  return (
    <>
      <defs><clipPath id="tool-preview-wall-clip"><polygon points={opening} /></clipPath></defs>
      <g strokeWidth={0.8} stroke={EDGE} strokeLinejoin="round">
        <polygon points={f.left} fill={TINTS.neutral.left} />
        <polygon points={f.right} fill={TINTS.neutral.right} />
        <polygon points={f.top} fill={TINTS.neutral.top}>
          <Anim attr="fill" v={[TINTS.neutral.top, TINTS.neutral.top, "#fcd88a", "#fcd88a", TINTS.neutral.top, TINTS.neutral.top]} t={[0, 0.14, 0.15, 0.4, 0.5, 1]} />
        </polygon>
      </g>
      <g transform={`translate(${c[0]} ${c[1]})`}>
        <g>
          <animateTransform attributeName="transform" type="scale" values="0;0;1;1;0" keyTimes="0;0.34;0.5;0.95;1" dur={DUR} repeatCount="indefinite" />
          <g transform={`translate(${-c[0]} ${-c[1]})`}>
            <g clipPath="url(#tool-preview-wall-clip)" stroke={EDGE} strokeWidth={0.6}>
              <polygon points={innerFloor} fill="#94a3b8" />
              <polygon points={backX} fill="#b6c2cf" />
              <polygon points={backY} fill="#8795a6" />
            </g>
            <polygon points={opening} fill="none" stroke={EDGE} strokeWidth={0.8} />
          </g>
        </g>
      </g>
      <g opacity={0} stroke="#00a7a5" strokeWidth={1.4}>
        <Anim attr="opacity" v={[0, 0, 1, 1, 0, 0]} t={[0, 0.55, 0.58, 0.93, 0.96, 1]} />
        <line x1={rimOut[0]} y1={rimOut[1]} x2={rimIn[0]} y2={rimIn[1]} strokeWidth={2.2} />
        <polyline points={`${rimMid[0]},${rimMid[1]} 196,34 226,34`} fill="none" stroke="#94a3b8" strokeWidth={0.8} />
        <text x={196} y={30} fontSize={9} fontWeight={700} fill="#0f172a" stroke="none">2 mm walls</text>
      </g>
      {/* The pointer only picks the face, then fades out where it is, so it
          doesn't look like dragging the mouse is what thickens the walls. */}
      <g>
        <Anim attr="opacity" v={[1, 1, 0, 0]} t={[0, 0.22, 0.28, 1]} />
        <Cursor at={[[200, 130], [c[0] + 4, c[1] - 2], [c[0] + 4, c[1] - 2]]} t={[0, 0.12, 1]} clicks={[0.14]} />
      </g>
      <Captions items={[
        ["Click the face to open", 0, 0.34],
        ["The solid is hollowed out", 0.34, 1],
      ]} />
    </>
  );
}

function SpacingDemo() {
  const a: Box = { x: [-36, -12], y: [-10, 10], z: [0, 16] };
  const b: Box = { x: [16, 32], y: [-10, 10], z: [0, 16] };
  const slide = isoDelta([-18, 0, 0]);
  const t = [0, 0.4, 0.62, 0.95, 1];
  const endStart = iso([16, 10, 0]), endEnd = iso([-2, 10, 0]);
  const aEnd = iso([-12, 10, 0]);
  const drop = 10; // dimension line sits below the front edges
  const lineX2 = [endStart[0], endStart[0], endEnd[0], endEnd[0], endStart[0]];
  const lineY2 = [endStart[1], endStart[1], endEnd[1], endEnd[1], endStart[1]].map((v) => v + drop);
  const mid = (p: [number, number]) => [(aEnd[0] + p[0]) / 2, (aEnd[1] + p[1]) / 2 + drop + 12] as const;
  const m0 = mid(endStart), m1 = mid(endEnd);
  return (
    <>
      <BoxShape box={a} tint={TINTS.target} />
      <g>
        <Move v={[[0, 0], [0, 0], slide, slide, [0, 0]]} t={t} />
        <BoxShape box={b} tint={TINTS.source} />
        <line x1={endStart[0]} y1={endStart[1] + 2} x2={endStart[0]} y2={endStart[1] + drop + 5} stroke="#00a7a5" strokeWidth={1.2} />
      </g>
      <g stroke="#00a7a5" strokeWidth={1.4}>
        <line x1={aEnd[0]} y1={aEnd[1] + 2} x2={aEnd[0]} y2={aEnd[1] + drop + 5} strokeWidth={1.2} />
        <line x1={aEnd[0]} y1={aEnd[1] + drop} x2={endStart[0]} y2={endStart[1] + drop}>
          <Anim attr="x2" v={lineX2} t={t} />
          <Anim attr="y2" v={lineY2} t={t} />
        </line>
      </g>
      <g fontSize={9.5} fontWeight={700} fill="#0f172a" textAnchor="middle">
        <text x={m0[0]} y={m0[1]}>28 mm<Anim attr="opacity" v={[1, 1, 0, 0, 1]} t={[0, 0.4, 0.41, 0.97, 1]} /></text>
        <text x={m1[0]} y={m1[1]} opacity={0}>10 mm<Anim attr="opacity" v={[0, 0, 1, 1, 0, 0]} t={[0, 0.62, 0.63, 0.95, 0.97, 1]} /></text>
      </g>
      <g opacity={0}>
        <Anim attr="opacity" v={[0, 0, 1, 1, 0, 0]} t={[0, 0.12, 0.14, 0.62, 0.66, 1]} />
        <rect x={150} y={14} width={78} height={22} rx={5} fill="#fff" stroke="#cbd5e1" />
        <text x={157} y={28} fontSize={9} fill="#64748b">Gap</text>
        <rect x={180} y={18} width={42} height={14} rx={3} fill="#f8fafc" stroke="#00a7a5" />
        <text x={185} y={28} fontSize={9} fontWeight={700} fill="#0f172a">
          <tspan opacity={0}>1<Anim attr="opacity" v={[0, 0, 1, 1]} t={[0, 0.24, 0.25, 1]} /></tspan>
          <tspan opacity={0}>0 mm<Anim attr="opacity" v={[0, 0, 1, 1]} t={[0, 0.3, 0.31, 1]} /></tspan>
        </text>
      </g>
      <Captions items={[
        ["Select 2 objects, type the gap", 0, 0.5],
        ["…it moves to exactly that distance", 0.5, 1],
      ]} />
    </>
  );
}

// ------------------------------------------------------------ flipbook kit

type V2 = [number, number];
const FRAMES = 64;
const HOME: V2 = [214, 132];
const TEAL = "#00a7a5";
const AMBER_FILL = "#fcd88a";

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** Eased 0 → 1 as t goes from a to b. */
const ramp = (t: number, a: number, b: number) => { const x = clamp01((t - a) / (b - a)); return x * x * (3 - 2 * x); };
const lerp = (a: number, b: number, s: number) => a + (b - a) * s;
const lerp2 = (p: V2, q: V2, s: number): V2 => [lerp(p[0], q[0], s), lerp(p[1], q[1], s)];
const rect = (x0: number, x1: number, y0: number, y1: number): V2[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const rotate = (p: V2[], deg: number): V2[] => {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return p.map(([x, y]) => [x * c - y * s, x * s + y * c]);
};
const circle = (cx: number, cy: number, r: number, n = 24): V2[] =>
  Array.from({ length: n }, (_, i) => [cx + r * Math.cos(i / n * 2 * Math.PI), cy + r * Math.sin(i / n * 2 * Math.PI)]);
const signedArea = (p: V2[]) => p.reduce((sum, [x, y], i) => { const [x2, y2] = p[(i + 1) % p.length]; return sum + x * y2 - x2 * y; }, 0) / 2;
const flat = (p: V2[], z: number) => pts(...p.map(([x, y]) => [x, y, z] as P3));

function mixHex(a: string, b: string, w: number) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return "#" + pa.map((v, i) => Math.round(lerp(v, pb[i], w)).toString(16).padStart(2, "0")).join("");
}

/**
 * Any straight-sided solid: a footprint (`base` at z0) joined to a matching
 * `top` outline at z1, so boxes, tapers, chamfers, cylinders and L-shapes all
 * come from one routine. Faces turned away from the (true isometric) viewer
 * are skipped, and the rest are painted back to front and shaded by facing.
 */
function Solid({ base, top = base, z0 = 0, z1, tint, wire, opacity = 1, smooth, topFill, stroke = EDGE, dash }: {
  base: V2[]; top?: V2[]; z0?: number; z1: number; tint: Tint;
  wire?: boolean; opacity?: number; smooth?: boolean; topFill?: string; stroke?: string; dash?: string;
}) {
  if (signedArea(base) < 0) { base = [...base].reverse(); top = [...top].reverse(); }
  const sides: { depth: number; fill: string; facet: boolean; points: string }[] = [];
  for (let i = 0; i < base.length; i++) {
    const j = (i + 1) % base.length;
    const a: P3 = [base[i][0], base[i][1], z0], b: P3 = [base[j][0], base[j][1], z0];
    const c: P3 = [top[j][0], top[j][1], z1], d: P3 = [top[i][0], top[i][1], z1];
    // Outward normal = (b − a) × (d − a) for a counter-clockwise footprint.
    const e1 = [b[0] - a[0], b[1] - a[1], 0], e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (!wire && n[0] + n[1] + n[2] <= 1e-6) continue;
    const len = Math.hypot(n[0], n[1]) || 1;
    const fill = mixHex(tint.left, tint.right, clamp01(0.5 + (n[0] - n[1]) / len / 2));
    const facet = !!smooth && Math.hypot(e1[0], e1[1]) < 5;
    sides.push({ depth: a[0] + a[1] + b[0] + b[1], fill, facet, points: pts(a, b, c, d) });
  }
  sides.sort((p, q) => p.depth - q.depth);
  return (
    <g opacity={opacity} strokeLinejoin="round" strokeDasharray={dash}>
      {sides.map((s, i) => (
        <polygon key={i} points={s.points} fill={wire ? "none" : s.fill}
          stroke={wire || !s.facet ? stroke : s.fill} strokeWidth={wire ? 0.9 : s.facet ? 0.5 : 0.8} />
      ))}
      <polygon points={flat(top, z1)} fill={wire ? "none" : topFill ?? tint.top} stroke={stroke} strokeWidth={wire ? 0.9 : 0.8} />
    </g>
  );
}

/** Where a pointer following `keys` ([time, screen point]) is at time t. */
function along(t: number, keys: [number, V2][]): V2 {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    if (t <= keys[i + 1][0]) return lerp2(keys[i][1], keys[i + 1][1], ramp(t, keys[i][0], keys[i + 1][0]));
  }
  return keys[keys.length - 1][1];
}

function Pointer({ t, at, clicks = [] }: { t: number; at: V2; clicks?: number[] }) {
  return (
    <g>
      {clicks.map((c) => {
        const s = (t - c) / 0.08;
        return s >= 0 && s <= 1
          ? <circle key={c} cx={at[0]} cy={at[1]} r={2 + 10 * s} fill="none" stroke={TEAL} strokeWidth={1.6} opacity={1 - s} />
          : null;
      })}
      <path transform={`translate(${at[0]} ${at[1]})`} d="M0 0 L0 13 L3.4 9.8 L6 15.2 L8.2 14.2 L5.7 9 L10.2 9 Z"
        fill="#0f172a" stroke="#fff" strokeWidth={1} strokeLinejoin="round" />
    </g>
  );
}

function Caption({ t, steps }: { t: number; steps: [number, string][] }) {
  const text = [...steps].reverse().find(([from]) => t >= from)?.[1] ?? "";
  return <text x={120} y={146} fontSize={9.5} fontWeight={600} fill="#475569" textAnchor="middle">{text}</text>;
}

function Chip({ x, y, text, w = 54, accent }: { x: number; y: number; text: string; w?: number; accent?: boolean }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={16} rx={4} fill={accent ? TEAL : "#fff"} stroke={accent ? TEAL : "#cbd5e1"} />
      <text x={x + w / 2} y={y + 11} fontSize={9} fontWeight={700} fill={accent ? "#fff" : "#0f172a"} textAnchor="middle">{text}</text>
    </g>
  );
}

function Handle({ at }: { at: V2 }) {
  return <rect x={at[0] - 3} y={at[1] - 3} width={6} height={6} rx={1} fill="#fff" stroke={TEAL} strokeWidth={1.4} />;
}

/** Dashed teal outline of a box, as the viewport draws a selection. */
function SelectionBox({ x, y, z }: { x: [number, number]; y: [number, number]; z: [number, number] }) {
  return <Solid base={rect(x[0] - 1, x[1] + 1, y[0] - 1, y[1] + 1)} z0={z[0]} z1={z[1] + 1} tint={TINTS.neutral} wire stroke={TEAL} dash="3 2" />;
}

const planeZ = (z: number) => { const [e, f] = iso([0, 0, z]); return `matrix(${0.866 * K} ${0.5 * K} ${-0.866 * K} ${0.5 * K} ${e} ${f})`; };
const planeY = (y: number) => { const [e, f] = iso([0, y, 0]); return `matrix(${0.866 * K} ${0.5 * K} 0 ${K} ${e} ${f})`; };

/**
 * Renders `render(t)` at FRAMES evenly spaced times and flips through them in
 * a loop, so a demo is just a function of time instead of a web of
 * separately-timed animations.
 */
function Flip({ render }: { render: (t: number) => ReactNode }) {
  const frames = useMemo(() => Array.from({ length: FRAMES }, (_, i) => render((i + 0.5) / FRAMES)), [render]);
  return (
    <>
      {frames.map((node, i) => {
        const a = (i / FRAMES).toFixed(4), b = ((i + 1) / FRAMES).toFixed(4);
        const [values, keyTimes] = i === 0 ? ["visible;hidden", `0;${b}`]
          : i === FRAMES - 1 ? ["hidden;visible", `0;${a}`]
          : ["hidden;visible;hidden", `0;${a};${b}`];
        return (
          <g key={i} visibility={i === 0 ? "visible" : "hidden"}>
            <animate attributeName="visibility" calcMode="discrete" values={values} keyTimes={keyTimes} dur={DUR} repeatCount="indefinite" />
            {node}
          </g>
        );
      })}
    </>
  );
}
const flip = (render: (t: number) => ReactNode) => () => <Flip render={render} />;

// ------------------------------------------------------------ flipbook demos

const SelectDemo = flip((t) => {
  const x1 = 16 + 10 * ramp(t, 0.38, 0.66);
  const base = rect(-16, x1, -12, 12);
  const at = along(t, [[0, HOME], [0.1, iso([0, 0, 14])], [0.22, iso([0, 0, 14])], [0.36, iso([16, 0, 7])], [0.66, iso([26, 0, 7])], [0.86, iso([26, 0, 7])], [1, HOME]]);
  return (
    <>
      <Solid base={base} z1={14} tint={TINTS.neutral} />
      {t >= 0.14 && (
        <>
          <polygon points={flat(base, 14)} fill="none" stroke={TEAL} strokeWidth={1.6} />
          <Handle at={iso([x1, 0, 7])} />
          <Handle at={iso([(x1 - 16) / 2, 12, 7])} />
          <Handle at={iso([(x1 - 16) / 2, 0, 14])} />
        </>
      )}
      {t >= 0.38 && <Chip x={168} y={20} text={`${Math.round(32 + x1 - 16)} mm`} />}
      <Pointer t={t} at={at} clicks={[0.14, 0.37]} />
      <Caption t={t} steps={[[0, "Click an object to select it"], [0.34, "Drag a handle to resize it"]]} />
    </>
  );
});

const MoveDemo = flip((t) => {
  const dx = 18 * ramp(t, 0.2, 0.46), dz = 8 * ramp(t, 0.6, 0.82);
  const c: P3 = [dx, 0, 12 + dz];
  const xTip = (x: number, z: number) => iso([x + 10, 0, 12 + z]), zTip = (x: number, z: number) => iso([x, 0, 22 + z]);
  const at = along(t, [[0, HOME], [0.12, xTip(0, 0)], [0.2, xTip(0, 0)], [0.46, xTip(18, 0)], [0.54, zTip(18, 0)], [0.6, zTip(18, 0)], [0.82, zTip(18, 8)], [0.92, zTip(18, 8)], [1, HOME]]);
  const arrow = (v: P3, colour: string) => {
    const [x1, y1] = iso(c), [x2, y2] = iso([c[0] + v[0], c[1] + v[1], c[2] + v[2]]);
    return <g key={colour}><line x1={x1} y1={y1} x2={x2} y2={y2} stroke={colour} strokeWidth={1.8} /><circle cx={x2} cy={y2} r={2.6} fill={colour} /></g>;
  };
  return (
    <>
      {dz > 0.2 && <polygon points={flat(rect(-12 + dx, 12 + dx, -10, 10), 0)} fill="#0f172a" opacity={0.08} />}
      <Solid base={rect(-12 + dx, 12 + dx, -10, 10)} z0={dz} z1={12 + dz} tint={TINTS.source} />
      {arrow([0, 10, 0], "#22c55e")}
      {arrow([10, 0, 0], "#ef4444")}
      {arrow([0, 0, 10], "#3b82f6")}
      {t >= 0.2 && t < 0.56 && <Chip x={20} y={16} text={`X +${Math.round(dx)} mm`} w={60} />}
      {t >= 0.6 && <Chip x={20} y={16} text={`Z +${Math.round(dz)} mm`} w={60} />}
      <Pointer t={t} at={at} clicks={[0.19, 0.59]} />
      <Caption t={t} steps={[[0, "Drag an arrow to move along that axis"]]} />
    </>
  );
});

const RotateDemo = flip((t) => {
  const ang = 60 * ramp(t, 0.22, 0.62);
  const handle = (deg: number) => { const a = (deg - 45) * Math.PI / 180; return iso([24 * Math.cos(a), 24 * Math.sin(a), 0]); };
  const at = t >= 0.2 && t <= 0.62 ? handle(ang) : along(t, [[0, HOME], [0.16, handle(0)], [0.62, handle(60)], [0.84, handle(60)], [1, HOME]]);
  const h = handle(ang);
  return (
    <>
      <polygon points={flat(circle(0, 0, 24, 48), 0)} fill="none" stroke={TEAL} strokeWidth={1.4} opacity={0.8} />
      <Solid base={rotate(rect(-15, 15, -9, 9), ang)} z1={12} tint={TINTS.neutral} />
      <circle cx={h[0]} cy={h[1]} r={3.2} fill="#fff" stroke={TEAL} strokeWidth={1.6} />
      {t >= 0.22 && <Chip x={20} y={16} text={`${Math.round(ang)}°`} w={40} />}
      <Pointer t={t} at={[at[0] + 1, at[1] + 1]} clicks={[0.21]} />
      <Caption t={t} steps={[[0, "Drag the ring to turn it — or type an angle"]]} />
    </>
  );
});

const MirrorDemo = flip((t) => {
  const L: V2[] = [[-14, -12], [6, -12], [6, -4], [-6, -4], [-6, 12], [-14, 12]];
  const s = Math.cos(Math.PI * ramp(t, 0.3, 0.7));
  const cx = -4;
  const base = L.map(([x, y]) => [cx + (x - cx) * s, y] as V2);
  const plane = pts([cx, -18, 0], [cx, 18, 0], [cx, 18, 18], [cx, -18, 18]);
  return (
    <>
      {Math.abs(s) > 0.03 && <Solid base={base} z1={12} tint={TINTS.target} />}
      {t > 0.12 && t < 0.86 && <polygon points={plane} fill={TEAL} fillOpacity={0.14} stroke={TEAL} strokeDasharray="3 2" />}
      {t > 0.12 && <Chip x={20} y={16} text="Mirror X" w={52} accent />}
      <Caption t={t} steps={[[0, "Pick an axis: X, Y or Z…"], [0.3, "…and it flips across that plane"]]} />
    </>
  );
});

const AlignDemo = flip((t) => {
  const s = ramp(t, 0.34, 0.62);
  const parts = [
    { x0: -20, w: 16, y: [-26, -14], h: 10, tint: TINTS.target },
    { x0: -8, w: 18, y: [-6, 6], h: 14, tint: TINTS.source },
    { x0: 2, w: 12, y: [14, 26], h: 8, tint: TINTS.neutral },
  ];
  const [g1, g2] = [iso([-20, -32, 0]), iso([-20, 32, 0])];
  return (
    <>
      {t > 0.16 && <line x1={g1[0]} y1={g1[1]} x2={g2[0]} y2={g2[1]} stroke={TEAL} strokeWidth={1.3} strokeDasharray="4 3" />}
      {parts.map((p) => {
        const x = lerp(p.x0, -20, s);
        return <Solid key={p.h} base={rect(x, x + p.w, p.y[0], p.y[1])} z1={p.h} tint={p.tint} />;
      })}
      <Caption t={t} steps={[[0, "Select 2 or more objects"], [0.16, "Line up their edges or centres"]]} />
    </>
  );
});

const DropDemo = flip((t) => {
  const f = clamp01((t - 0.26) / 0.2);
  const bounce = 2.2 * Math.sin(Math.PI * clamp01((t - 0.46) / 0.1));
  const z = t < 0.46 ? 22 - 14 * f * f : 8 + bounce;
  const top = iso([0, 0, z]), land = iso([0, 0, 8]);
  return (
    <>
      <g transform="translate(0 12)">
      <Solid base={rect(-16, 16, -16, 16)} z1={8} tint={TINTS.target} />
      <polygon points={flat(rect(-6, 6, -6, 6), 8)} fill="#0f172a" opacity={0.06 + 0.1 * (1 - (z - 8) / 14)} />
      {t > 0.08 && t < 0.28 && <line x1={top[0]} y1={top[1] + 4} x2={land[0]} y2={land[1] - 2} stroke={TEAL} strokeWidth={1.5} strokeDasharray="3 2" />}
      <Solid base={rect(-6, 6, -6, 6)} z0={z} z1={z + 10} tint={TINTS.source} />
      </g>
      <Caption t={t} steps={[[0, "Press D — it falls onto whatever is below"]]} />
    </>
  );
});

const MeasureDemo = flip((t) => {
  const P1: P3 = [-21, 0, 12], P2: P3 = [19, 0, 18];
  const at = along(t, [[0, HOME], [0.15, iso(P1)], [0.2, iso(P1)], [0.55, iso(P2)], [0.86, iso(P2)], [1, HOME]]);
  const s = ramp(t, 0.2, 0.55);
  const dist = Math.hypot((P2[0] - P1[0]) * s, (P2[2] - P1[2]) * s);
  const a = iso(P1), b = t < 0.86 ? at : iso(P2);
  const mid: V2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 12];
  return (
    <>
      <Solid base={rect(-30, -12, -8, 8)} z1={12} tint={TINTS.target} />
      <Solid base={rect(10, 28, -8, 8)} z1={18} tint={TINTS.source} />
      {t >= 0.18 && (
        <>
          <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={HIGHLIGHT} strokeWidth={1.8} />
          <circle cx={a[0]} cy={a[1]} r={2.4} fill={HIGHLIGHT} />
          {t >= 0.56 && <circle cx={b[0]} cy={b[1]} r={2.4} fill={HIGHLIGHT} />}
          {dist > 2 && <Chip x={mid[0] - 27} y={mid[1] - 8} text={`${dist.toFixed(1)} mm`} />}
        </>
      )}
      <Pointer t={t} at={at} clicks={[0.18, 0.56]} />
      <Caption t={t} steps={[[0, "Click a first point…"], [0.2, "…then a second point"], [0.58, "The distance is shown in mm"]]} />
    </>
  );
});

const ResizeFaceDemo = flip((t) => {
  const i = 8 * ramp(t, 0.36, 0.66);
  const corner = (inset: number) => iso([16 - inset, 16 - inset, 16]);
  const at = along(t, [[0, HOME], [0.12, iso([0, 0, 16])], [0.2, iso([0, 0, 16])], [0.34, corner(0)], [0.66, corner(8)], [0.86, corner(8)], [1, HOME]]);
  return (
    <>
      <Solid base={rect(-16, 16, -16, 16)} top={rect(-16 + i, 16 - i, -16 + i, 16 - i)} z1={16} tint={TINTS.neutral} topFill={t > 0.16 ? AMBER_FILL : undefined} />
      {t > 0.16 && <Handle at={corner(i)} />}
      <Pointer t={t} at={at} clicks={[0.16, 0.35]} />
      <Caption t={t} steps={[[0, "Select a face"], [0.32, "Drag to resize it — the sides follow"]]} />
    </>
  );
});

const OffsetExtrudeDemo = flip((t) => {
  const off = 5 * ramp(t, 0.22, 0.4), e = 12 * ramp(t, 0.5, 0.76);
  const inner = rect(-16 + off, 16 - off, -16 + off, 16 - off);
  return (
    <>
      <Solid base={rect(-16, 16, -16, 16)} z1={10} tint={TINTS.neutral} topFill={t > 0.12 ? AMBER_FILL : undefined} />
      {t > 0.2 && t < 0.52 && <polygon points={flat(inner, 10)} fill="none" stroke={TEAL} strokeWidth={1.4} strokeDasharray="3 2" />}
      {e > 0.3 && <Solid base={inner} z0={10} z1={10 + e} tint={TINTS.source} />}
      {t > 0.22 && <Chip x={20} y={16} text={t < 0.5 ? `Offset ${off.toFixed(0)} mm` : `Extrude ${e.toFixed(0)} mm`} w={78} />}
      <Caption t={t} steps={[[0, "Select a face"], [0.2, "Offset its outline…"], [0.48, "…then extrude it"]]} />
    </>
  );
});

/** A box whose top border is bevelled (steps = 1) or rounded (steps > 1). */
function finishedBox(size: number, h: number, c: number, steps: number, tint: Tint) {
  const levels = Array.from({ length: steps + 1 }, (_, j) => {
    const a = (j / steps) * Math.PI / 2;
    return steps === 1 ? { inset: j * c, z: h - c + j * c } : { inset: c * (1 - Math.cos(a)), z: h - c + c * Math.sin(a) };
  });
  const sq = (inset: number) => rect(-size + inset, size - inset, -size + inset, size - inset);
  return (
    <>
      <Solid base={sq(0)} z1={h - c} tint={tint} />
      {c > 0.05 && levels.slice(1).map((lv, j) => (
        <Solid key={j} base={sq(levels[j].inset)} top={sq(lv.inset)} z0={levels[j].z} z1={lv.z} tint={tint}
          smooth={steps > 1} topFill={j === steps - 1 ? undefined : tint.left} />
      ))}
    </>
  );
}

const BevelFaceDemo = flip((t) => {
  const bevel = t < 0.6, c = 5 * (bevel ? ramp(t, 0.28, 0.5) : 1);
  return (
    <>
      {finishedBox(16, 16, c, bevel ? 1 : 5, TINTS.neutral)}
      {t > 0.12 && t < 0.3 && <polygon points={flat(rect(-16, 16, -16, 16), 16)} fill="none" stroke={HIGHLIGHT} strokeWidth={2.2} />}
      {t > 0.28 && <Chip x={20} y={16} text={bevel ? "Bevel" : "Round"} w={46} accent />}
      <Caption t={t} steps={[[0, "Select a face"], [0.28, "Every edge around it is bevelled…"], [0.6, "…or rounded"]]} />
    </>
  );
});

const EdgeDemo = flip((t) => {
  const c = 8 * ramp(t, 0.36, 0.64);
  const x0 = -16, x1 = 16, y0 = -12, y1 = 12, h = 16;
  const arc = Array.from({ length: 7 }, (_, j) => { const a = j / 6 * Math.PI / 2; return [x1 - c + c * Math.cos(a), y1 - c + c * Math.sin(a)] as V2; });
  const base: V2[] = c < 0.05 ? rect(x0, x1, y0, y1) : [[x0, y0], [x1, y0], ...arc, [x0, y1]];
  const e0 = iso([x1, y1, 0]), e1 = iso([x1, y1, h]), mid = iso([x1, y1, h / 2]);
  return (
    <>
      <Solid base={base} z1={h} tint={TINTS.neutral} smooth />
      {t > 0.14 && t < 0.38 && <line x1={e0[0]} y1={e0[1]} x2={e1[0]} y2={e1[1]} stroke={HIGHLIGHT} strokeWidth={2.6} />}
      {t > 0.36 && <Chip x={20} y={16} text={`Radius ${c.toFixed(0)} mm`} w={72} />}
      <Pointer t={t} at={along(t, [[0, HOME], [0.12, mid], [0.3, mid], [0.4, HOME]])} clicks={[0.15]} />
      <Caption t={t} steps={[[0, "Click an edge…"], [0.34, "…then fillet or chamfer it"]]} />
    </>
  );
});

const TextDemo = flip((t) => {
  const typed = "ABC".slice(0, Math.floor(ramp(t, 0.06, 0.3) * 3.01));
  const d = 7 * ramp(t, 0.42, 0.7);
  const layers = 10;
  return (
    <>
      <rect x={20} y={14} width={70} height={18} rx={4} fill="#fff" stroke="#cbd5e1" />
      <text x={26} y={27} fontSize={10} fontWeight={600} fill="#0f172a">{typed}{t < 0.34 && Math.floor(t * 16) % 2 === 0 ? "|" : ""}</text>
      {Array.from({ length: layers + 1 }, (_, j) => layers - j).map((j) => {
        const [dx, dy] = isoDelta([0, -d * j / layers, 0]);
        return (
          <text key={j} transform={`translate(${dx} ${dy}) ${planeY(8)} translate(-20 0)`} fontSize={17} fontWeight={800}
            fill={j === 0 ? TINTS.source.top : TINTS.source.right} stroke={j === 0 ? EDGE : "none"} strokeWidth={0.25}>{typed}</text>
        );
      })}
      <Caption t={t} steps={[[0, "Type your text, pick a font…"], [0.4, "…and it becomes a 3D solid"]]} />
    </>
  );
});

const BLOB = "M-16 -4 C-16 -16 2 -20 10 -12 C18 -4 16 12 4 14 C-6 16 -16 8 -16 -4 Z";
const SketchDemo = flip((t) => {
  const p = ramp(t, 0.08, 0.42), h = 12 * ramp(t, 0.52, 0.78), layers = 12;
  return (
    <>
      <g transform={planeZ(0)} opacity={1 - ramp(t, 0.5, 0.6)}>
        <rect x={-26} y={-26} width={52} height={52} fill={TEAL} fillOpacity={0.05} stroke={TEAL} strokeOpacity={0.4} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
        {[-18, -9, 0, 9, 18].map((v) => (
          <g key={v} stroke="#dbe3ea">
            <line x1={v} y1={-26} x2={v} y2={26} vectorEffect="non-scaling-stroke" />
            <line x1={-26} y1={v} x2={26} y2={v} vectorEffect="non-scaling-stroke" />
          </g>
        ))}
      </g>
      {t < 0.46
        ? <path transform={planeZ(0)} d={BLOB} fill="none" stroke={TEAL} strokeWidth={1.8} vectorEffect="non-scaling-stroke" pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - p} />
        : Array.from({ length: layers + 1 }, (_, j) => (
          <path key={j} transform={planeZ(h * j / layers)} d={BLOB} fill={j === layers ? TINTS.source.top : TINTS.source.right}
            stroke={j === layers || j === 0 ? EDGE : "none"} strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
        ))}
      <Caption t={t} steps={[[0, "Pick a plane and draw a shape…"], [0.46, "…then extrude it into a solid"]]} />
    </>
  );
});

const ShapeBuilderDemo = flip((t) => {
  const aOnly: V2[] = [[-22, -12], [6, -12], [6, -8], [-6, -8], [-6, 8], [-22, 8]];
  const bOnly: V2[] = [[6, -8], [22, -8], [22, 14], [-6, 14], [-6, 8], [6, 8]];
  const mixed: Tint = { top: mixHex(TINTS.target.top, TINTS.source.top, 0.5), left: mixHex(TINTS.target.left, TINTS.source.left, 0.5), right: mixHex(TINTS.target.right, TINTS.source.right, 0.5) };
  return (
    <>
      <Solid base={aOnly} z1={10} tint={TINTS.target} />
      {t < 0.42 && <Solid base={rect(-6, 6, -8, 8)} z1={10} tint={mixed} topFill={t > 0.26 ? AMBER_FILL : undefined} />}
      <Solid base={bOnly} z1={10} tint={TINTS.source} />
      <Pointer t={t} at={along(t, [[0, HOME], [0.24, iso([0, 0, 10])], [0.46, iso([0, 0, 10])], [0.62, HOME]])} clicks={[0.4]} />
      <Caption t={t} steps={[[0, "Overlapping shapes split into regions"], [0.24, "Click a region to remove it"], [0.5, "Keep, merge or delete any region"]]} />
    </>
  );
});

const JoineryDemo = flip((t) => {
  const sep = 14 * ramp(t, 0.16, 0.32) - 14 * ramp(t, 0.5, 0.72);
  const strips: [number, number, boolean][] = [[-10, -5, true], [-5, 0, false], [0, 5, true], [5, 10, false]];
  return (
    <>
      <g transform="translate(6 6)">
        <Solid base={rect(-26, 0, -10, 10)} z1={6} tint={TINTS.target} />
        {t >= 0.36
          ? strips.map(([y0, y1, tab]) => (
            <g key={y0}>
              {tab && <Solid base={rect(0, 6, y0, y1)} z1={6} tint={TINTS.target} />}
              <Solid base={rect(sep, 6 + sep, y0, y1)} z0={tab ? 6 : 0} z1={26} tint={TINTS.source} />
            </g>
          ))
          : <Solid base={rect(sep, 6 + sep, -10, 10)} z1={26} tint={TINTS.source} />}
      </g>
      <Caption t={t} steps={[[0, "Select 2 parts that touch"], [0.3, "Pick a joint: fingers, dovetails, dowels"], [0.56, "…and the parts interlock"]]} />
    </>
  );
});

const CutDemo = flip((t) => {
  const px = lerp(-30, 0, ramp(t, 0.1, 0.32));
  const sep = 10 * ramp(t, 0.5, 0.7);
  return (
    <>
      {t < 0.48
        ? <Solid base={rect(-18, 18, -14, 14)} z1={16} tint={TINTS.neutral} />
        : (
          <>
            <Solid base={rect(-18, 0, -14, 14)} z1={16} tint={TINTS.neutral} />
            <polygon points={pts([0, -14, 0], [0, 14, 0], [0, 14, 16], [0, -14, 16])} fill={AMBER_FILL} stroke={EDGE} strokeWidth={0.8} />
            <Solid base={rect(sep, 18 + sep, -14, 14)} z1={16} tint={TINTS.neutral} />
          </>
        )}
      {t > 0.08 && t < 0.5 && <polygon points={pts([px, -20, -3], [px, 20, -3], [px, 20, 21], [px, -20, 21])} fill={TEAL} fillOpacity={0.18} stroke={TEAL} strokeWidth={1.2} />}
      <Caption t={t} steps={[[0, "Position the cutting plane…"], [0.46, "…and split into separate parts"]]} />
    </>
  );
});

const GroupDemo = flip((t) => {
  const dx = 14 * ramp(t, 0.56, 0.8);
  const grouped = t >= 0.3;
  return (
    <>
      <Solid base={rect(-24 + dx, -8 + dx, -8, 8)} z1={12} tint={TINTS.target} />
      <Solid base={circle(10 + dx, 0, 8)} z1={16} tint={TINTS.source} smooth />
      {grouped
        ? <SelectionBox x={[-24 + dx, 18 + dx]} y={[-8, 8]} z={[0, 16]} />
        : <><SelectionBox x={[-24, -8]} y={[-8, 8]} z={[0, 12]} /><SelectionBox x={[2, 18]} y={[-8, 8]} z={[0, 16]} /></>}
      {grouped && <Chip x={20} y={16} text="Group" w={44} accent />}
      <Caption t={t} steps={[[0, "Select the parts"], [0.3, "Group them (Ctrl+G)…"], [0.56, "…and they move as one"]]} />
    </>
  );
});

const CombineDemo = flip((t) => {
  const f = ramp(t, 0.4, 0.52);
  return (
    <>
      <g opacity={1 - f}>
        <Solid base={rect(-24, 4, -10, 10)} z1={14} tint={TINTS.target} />
        <Solid base={rect(-4, 24, -10, 10)} z1={14} tint={TINTS.source} />
      </g>
      {f > 0 && <Solid base={rect(-24, 24, -10, 10)} z1={14} tint={TINTS.source} opacity={f} />}
      {t > 0.5 && <Chip x={20} y={16} text="1 solid" w={48} accent />}
      <Caption t={t} steps={[[0, "Two overlapping solids"], [0.38, "Combine fuses them into one"]]} />
    </>
  );
});

const UngroupDemo = flip((t) => {
  const s = ramp(t, 0.36, 0.6);
  return (
    <>
      <Solid base={rect(-19 - 7 * s, -1 - 7 * s, -9, 9)} z1={12} tint={TINTS.target} />
      <Solid base={circle(8 + 7 * s, 0, 9)} z1={16} tint={TINTS.source} smooth />
      {t >= 0.3
        ? <><SelectionBox x={[-19 - 7 * s, -1 - 7 * s]} y={[-9, 9]} z={[0, 12]} /><SelectionBox x={[-1 + 7 * s, 17 + 7 * s]} y={[-9, 9]} z={[0, 16]} /></>
        : <SelectionBox x={[-19, 17]} y={[-9, 9]} z={[0, 16]} />}
      <Caption t={t} steps={[[0, "A group or combined solid"], [0.3, "Ungroup — the parts are separate again"]]} />
    </>
  );
});

const ViewModesDemo = flip((t) => {
  const mode = t < 0.34 ? 0 : t < 0.67 ? 1 : 2;
  const common = { wire: mode === 1, opacity: mode === 2 ? 0.45 : 1 };
  return (
    <>
      <Solid base={rect(-22, -2, -10, 10)} z1={14} tint={TINTS.neutral} {...common} />
      <Solid base={circle(12, 0, 9)} z1={18} tint={TINTS.source} smooth={mode !== 1} {...common} />
      <Chip x={20} y={16} text={["Solid", "Wireframe", "X-ray"][mode]} w={62} accent />
      <Caption t={t} steps={[[0, "Switch how the model is drawn (W)"]]} />
    </>
  );
});

const TransparencyDemo = flip((t) => {
  const op = 1 - 0.68 * (ramp(t, 0.3, 0.42) - ramp(t, 0.86, 0.96));
  return (
    <>
      <Solid base={circle(-6, -8, 6)} z1={10} tint={TINTS.source} smooth />
      <Solid base={rect(-22, 14, -2, 14)} z1={20} tint={TINTS.target} opacity={op} />
      {t > 0.28 && t < 0.9 && <Chip x={20} y={16} text="T" w={22} accent />}
      <Caption t={t} steps={[[0, "Select an object"], [0.28, "Press T to see what is behind it"]]} />
    </>
  );
});

const ZoomDemo = flip((t) => {
  const z = ramp(t, 0.3, 0.6) - ramp(t, 0.86, 0.97);
  const f = lerp2([120, 76], iso([18, 10, 5]), z), sc = lerp(1, 2.3, z);
  return (
    <>
      <g transform={`translate(120 76) scale(${sc}) translate(${-f[0]} ${-f[1]})`}>
        <Solid base={rect(-30, -22, -6, 2)} z1={6} tint={TINTS.neutral} />
        <Solid base={rect(-4, 4, -22, -14)} z1={8} tint={TINTS.neutral} />
        <Solid base={circle(-12, 16, 4, 16)} z1={8} tint={TINTS.target} smooth />
        <Solid base={rect(14, 22, 6, 14)} z1={10} tint={TINTS.source} />
        <polygon points={flat(rect(14, 22, 6, 14), 10)} fill="none" stroke={TEAL} strokeWidth={1.4 / sc} />
      </g>
      <rect x={0} y={134} width={240} height={18} fill="#f8fafc" />
      <Caption t={t} steps={[[0, "Select an object"], [0.3, "Z zooms to fit it in view"]]} />
    </>
  );
});

const ExplodedDemo = flip((t) => {
  const e = ramp(t, 0.2, 0.45) - ramp(t, 0.76, 0.93);
  const [a, b] = [iso([0, 0, 0]), iso([0, 0, 44])];
  return (
    <>
      <g transform="translate(0 18)">
        {e > 0.02 && <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={TEAL} strokeWidth={1} strokeDasharray="3 3" opacity={e} />}
        <Solid base={rect(-14, 14, -14, 14)} z1={6} tint={TINTS.neutral} />
        <Solid base={rect(-9, 9, -9, 9)} z0={6 + 8 * e} z1={16 + 8 * e} tint={TINTS.target} />
        <Solid base={rect(-5, 5, -5, 5)} z0={16 + 16 * e} z1={22 + 16 * e} tint={TINTS.source} />
      </g>
      <Caption t={t} steps={[[0, "An assembly of parts"], [0.2, "Exploded View spreads them apart"]]} />
    </>
  );
});

// ------------------------------------------------------------------ registry

export type Preview = { title: string; keys?: string; what: string; how: string; demo: () => ReactNode };

/** Keyed by the toolbar button's aria-label; keys ending in "…" are prefixes
 *  for buttons whose label carries state (e.g. "Drop down"). */
export const PREVIEWS: Record<string, Preview> = {
  "Select tool": { title: "Select & Resize", keys: "V", what: "Picks objects and resizes them with the handles.", how: "Shift or Ctrl-click to add to the selection.", demo: SelectDemo },
  "Move tool": { title: "Move", keys: "M", what: "Moves the selection along one axis at a time.", how: "Drag an arrow, or type an exact distance.", demo: MoveDemo },
  "Rotate tool": { title: "Rotate", keys: "R", what: "Turns the selection around an axis.", how: "Drag a ring, or type the angle.", demo: RotateDemo },
  "Mirror tool": { title: "Mirror", what: "Flips the selection across the X, Y or Z plane.", how: "Select an object, then pick an axis.", demo: MirrorDemo },
  "Align tool": { title: "Align", keys: "A", what: "Lines up the edges or centres of several objects.", how: "Select 2 or more. Hold the button for Box or Node align.", demo: AlignDemo },
  "Drop …": { title: "Drop", keys: "D", what: "Moves the selection until it lands on the object or floor below.", how: "Hold the button to choose another direction.", demo: DropDemo },
  "Measuring tape tool": { title: "Measuring tape", what: "Measures the distance between any two points.", how: "Click a first point, then a second.", demo: MeasureDemo },
  "Push/Pull": { title: "Push / Pull", keys: "F", what: "Drags a face in or out to make the solid taller, shorter or deeper.", how: "Click a face, then drag the arrow or type a distance.", demo: PushPullDemo },
  Hollow: { title: "Hollow", what: "Hollows a solid out, leaving walls of a set thickness with the picked face open.", how: "Click the face to open, then set the wall and bottom thickness.", demo: HollowDemo },
  "Resize Face": { title: "Resize Face", what: "Makes one face bigger or smaller; the sides taper to follow.", how: "Select a face, then drag its handles.", demo: ResizeFaceDemo },
  "Offset & Extrude": { title: "Offset & Extrude", what: "Offsets a face's outline, then extrudes it as a new step.", how: "Select a face, set the offset, then the height.", demo: OffsetExtrudeDemo },
  "Round / Bevel Face Border": { title: "Round / Bevel Face Border", what: "Rounds or bevels every edge around a face in one go.", how: "Select a face; choose Round or Bevel in the panel.", demo: BevelFaceDemo },
  "Edge finishing tool": { title: "Edge Fillet / Chamfer", keys: "E", what: "Rounds or cuts off a single edge.", how: "Click an edge, then set the radius or size.", demo: EdgeDemo },
  "Add text tool": { title: "3D Text", what: "Turns typed text into a solid, using fonts installed on your computer.", how: "Type the text, pick a font and a depth.", demo: TextDemo },
  "Sketch tool": { title: "Sketch", what: "Draw a 2D shape on a plane, then extrude it into a solid.", how: "Pick a plane, draw with lines or Bézier curves, extrude.", demo: SketchDemo },
  "Shape Builder tool": { title: "Shape Builder", keys: "B", what: "Splits overlapping shapes into regions you can keep, merge or delete.", how: "Select 2 or more overlapping objects.", demo: ShapeBuilderDemo },
  "Joinery tool": { title: "Joinery", keys: "J", what: "Cuts interlocking joints where two parts meet.", how: "Select 2 parts that touch at a flat face.", demo: JoineryDemo },
  "Exact Spacing and Alignment tool": { title: "Exact Spacing & Align", what: "Moves one object so the gap to another is an exact distance, or flush.", how: "Select exactly 2 objects to enable it.", demo: SpacingDemo },
  "Cut / Split tool": { title: "Cut / Split", keys: "C", what: "Slices a model with a plane into separate parts, e.g. for printing.", how: "Select 1 object, then position the plane.", demo: CutDemo },
  "Place on object": { title: "Place on object", what: "Sets one object onto a face of another, flush to the surface.", how: "Select the object first, then pick its contact face.", demo: PlaceOnObjectDemo },
  Group: { title: "Group / Assembly", keys: "Ctrl+G", what: "Links objects so they move and copy together.", how: "Select 2 or more objects.", demo: GroupDemo },
  "Combine Solid": { title: "Combine Solid", keys: "Ctrl+Shift+B", what: "Fuses overlapping solids into a single solid.", how: "Select 2 or more overlapping objects, or a group.", demo: CombineDemo },
  Ungroup: { title: "Ungroup / Separate", keys: "Ctrl+Shift+G", what: "Splits a group or combined solid back into its parts.", how: "Select a group or a combined solid.", demo: UngroupDemo },
  "View mode options…": { title: "View modes", keys: "W", what: "Switches between solid, wireframe and X-ray drawing.", how: "Click to choose a mode.", demo: ViewModesDemo },
  "Toggle transparency": { title: "Transparency", keys: "T", what: "Makes the selection see-through so you can work behind it.", how: "Select objects, then press T again to restore.", demo: TransparencyDemo },
  "Zoom to selected": { title: "Zoom to fit", keys: "Z", what: "Frames the selection — or everything, if nothing is selected.", how: "Works from any view angle.", demo: ZoomDemo },
  "Exploded View": { title: "Exploded View", what: "Spreads an assembly apart so every part can be seen.", how: "Click again to put it back together.", demo: ExplodedDemo },
};

export function lookupPreview(label: string): Preview | undefined {
  if (PREVIEWS[label]) return PREVIEWS[label];
  for (const [key, preview] of Object.entries(PREVIEWS)) {
    if (key.endsWith("…") && label.startsWith(key.slice(0, -1))) return preview;
  }
  return undefined;
}

