import svgpath from "svgpath";

/**
 * SVG → millimetre outlines.
 *
 * Runs on the MAIN thread, not in the kernel worker: reading the document
 * needs DOMParser, and a worker has no DOM. What crosses to the worker is the
 * plain numeric result below.
 */

/** One outline, already absolute, arc-free and in millimetres. */
export type SvgCommand =
  | ["M", number, number]
  | ["L", number, number]
  | ["C", number, number, number, number, number, number]
  | ["Z"];

export interface SvgOutlines {
  paths: SvgCommand[][];
  /** Artwork size in mm — what Illustrator's artboard reports. */
  width: number;
  height: number;
}

/**
 * CSS absolute units in millimetres. A unitless user unit is a CSS pixel,
 * 1/96 inch — that constant is what lands a 96dpi export at artboard size.
 */
const MM: Record<string, number> = {
  mm: 1,
  cm: 10,
  q: 0.25,
  in: 25.4,
  pt: 25.4 / 72,
  pc: 25.4 / 6,
  px: 25.4 / 96,
  "": 25.4 / 96,
};

function toMm(value: string | null): number | null {
  if (!value) return null;
  const m = /^\s*(-?[\d.]+)\s*([a-z%]*)\s*$/i.exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toLowerCase();
  if (unit === "%") return null; // relative to a viewport this file lacks
  const factor = MM[unit];
  return factor === undefined ? null : n * factor;
}

/** The shapes SVG offers besides <path>, rewritten as path data. */
function shapeToPath(el: Element): string | null {
  const num = (name: string) => Number(el.getAttribute(name) ?? 0);
  // Cubic approximation used by vector editors for a quarter circle. Using
  // explicit cubics here is more reliable than reflecting SVG arc commands:
  // a pill has a zero-length straight side and some arc converters choose the
  // opposite sweep after the Y-axis flip, turning its rounded end inward.
  const K = 0.5522847498307936;
  switch (el.tagName.toLowerCase()) {
    case "path":
      return el.getAttribute("d");
    case "rect": {
      const x = num("x"), y = num("y"), w = num("width"), h = num("height");
      if (!(w > 0 && h > 0)) return null;
      const rx = Math.min(Number(el.getAttribute("rx") ?? el.getAttribute("ry") ?? 0), w / 2);
      const ry = Math.min(Number(el.getAttribute("ry") ?? el.getAttribute("rx") ?? 0), h / 2);
      if (rx > 0 && ry > 0) {
        const kx = rx * K, ky = ry * K;
        return `M${x + rx} ${y}L${x + w - rx} ${y}` +
          `C${x + w - rx + kx} ${y} ${x + w} ${y + ry - ky} ${x + w} ${y + ry}` +
          `L${x + w} ${y + h - ry}` +
          `C${x + w} ${y + h - ry + ky} ${x + w - rx + kx} ${y + h} ${x + w - rx} ${y + h}` +
          `L${x + rx} ${y + h}` +
          `C${x + rx - kx} ${y + h} ${x} ${y + h - ry + ky} ${x} ${y + h - ry}` +
          `L${x} ${y + ry}` +
          `C${x} ${y + ry - ky} ${x + rx - kx} ${y} ${x + rx} ${y}Z`;
      }
      return `M${x} ${y}h${w}v${h}h${-w}Z`;
    }
    case "circle": {
      const cx = num("cx"), cy = num("cy"), r = num("r");
      if (!(r > 0)) return null;
      const k = r * K;
      return `M${cx + r} ${cy}C${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r}` +
        `C${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy}` +
        `C${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r}` +
        `C${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy}Z`;
    }
    case "ellipse": {
      const cx = num("cx"), cy = num("cy"), rx = num("rx"), ry = num("ry");
      if (!(rx > 0 && ry > 0)) return null;
      const kx = rx * K, ky = ry * K;
      return `M${cx + rx} ${cy}C${cx + rx} ${cy + ky} ${cx + kx} ${cy + ry} ${cx} ${cy + ry}` +
        `C${cx - kx} ${cy + ry} ${cx - rx} ${cy + ky} ${cx - rx} ${cy}` +
        `C${cx - rx} ${cy - ky} ${cx - kx} ${cy - ry} ${cx} ${cy - ry}` +
        `C${cx + kx} ${cy - ry} ${cx + rx} ${cy - ky} ${cx + rx} ${cy}Z`;
    }
    case "line":
      return `M${num("x1")} ${num("y1")}L${num("x2")} ${num("y2")}`;
    case "polyline":
    case "polygon": {
      const points = (el.getAttribute("points") ?? "").trim();
      if (!points) return null;
      const d = `M${points.replace(/\s*,\s*/g, " ").replace(/\s+/g, " ")}`;
      return el.tagName.toLowerCase() === "polygon" ? `${d}Z` : d;
    }
    default:
      return null;
  }
}

/** The transform stack down to an element, outermost first. */
function transformsFor(el: Element, root: Element): string[] {
  const chain: string[] = [];
  let node: Element | null = el;
  while (node && node !== root.parentElement) {
    const t = node.getAttribute("transform");
    if (t) chain.unshift(t);
    node = node.parentElement;
  }
  return chain;
}

/**
 * Reads an SVG into millimetre outlines.
 *
 * Size comes from width/height measured against the viewBox, which is what
 * makes the result match the artboard: Illustrator writes width="100mm"
 * alongside viewBox="0 0 283.46 141.73", and the ratio between them is the
 * scale. With no physical size given, user units are CSS pixels at 96dpi.
 */
export function parseSvg(text: string): SvgOutlines {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  if (doc.querySelector("parsererror")) throw new Error("That file is not valid SVG.");
  const svg = doc.querySelector("svg");
  if (!svg) throw new Error("That file has no <svg> element.");

  const viewBox = (svg.getAttribute("viewBox") ?? "")
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  const hasViewBox = viewBox.length === 4 && viewBox[2] > 0 && viewBox[3] > 0;
  const [vbX, vbY, vbW, vbH] = hasViewBox ? viewBox : [0, 0, 0, 0];

  const widthMm = toMm(svg.getAttribute("width"));
  const heightMm = toMm(svg.getAttribute("height"));

  let scaleX = MM.px;
  let scaleY = MM.px;
  if (hasViewBox && widthMm !== null && heightMm !== null) {
    scaleX = widthMm / vbW;
    scaleY = heightMm / vbH;
  }

  const originX = hasViewBox ? vbX : 0;
  const originY = hasViewBox ? vbY : 0;
  // Artboard height in user units — needed to flip SVG's y-down to y-up.
  const spanY = hasViewBox ? vbH : (heightMm ?? 0) / scaleY;

  const paths: SvgCommand[][] = [];
  for (const el of Array.from(
    svg.querySelectorAll("path,rect,circle,ellipse,line,polyline,polygon"),
  )) {
    const d = shapeToPath(el);
    if (!d) continue;

    let p = svgpath(d);
    for (const t of transformsFor(el, svg)) p = p.transform(t);
    p = p
      .translate(-originX, -originY)
      .scale(scaleX, -scaleY)
      .translate(0, spanY * scaleY)
      // Arcs and shorthand become plain cubics and lines, which is all the
      // pen on the worker side has to understand.
      .unarc()
      .unshort()
      .abs();

    const commands: SvgCommand[] = [];
    // Do not keep svgpath's transform stack lazy here. With `true` as the
    // second argument iterate() returns the original Illustrator coordinates,
    // silently skipping the artboard scale, nested transforms and Y-axis
    // flip we just queued above. That distorted compound artwork even though
    // simple letters could appear plausible.
    p.iterate((seg) => {
      const op = String(seg[0]).toUpperCase();
      const a = seg.slice(1) as number[];
      if (op === "M") commands.push(["M", a[0], a[1]]);
      else if (op === "L") commands.push(["L", a[0], a[1]]);
      else if (op === "H") commands.push(["L", a[0], commands.length ? lastY(commands) : 0]);
      else if (op === "V") commands.push(["L", commands.length ? lastX(commands) : 0, a[0]]);
      else if (op === "C") commands.push(["C", a[0], a[1], a[2], a[3], a[4], a[5]]);
      else if (op === "Q") {
        // Quadratic raised to cubic: the two cubic controls sit two thirds of
        // the way from each end towards the single quadratic control.
        const [x0, y0] = [lastX(commands), lastY(commands)];
        commands.push([
          "C",
          x0 + (2 / 3) * (a[0] - x0),
          y0 + (2 / 3) * (a[1] - y0),
          a[2] + (2 / 3) * (a[0] - a[2]),
          a[3] + (2 / 3) * (a[1] - a[3]),
          a[2],
          a[3],
        ]);
      } else if (op === "Z") commands.push(["Z"]);
    });

    if (commands.length > 1) paths.push(commands);
  }

  return {
    paths: centred(paths),
    width: hasViewBox ? vbW * scaleX : (widthMm ?? 0),
    height: hasViewBox ? vbH * scaleY : (heightMm ?? 0),
  };
}

/**
 * Moves the artwork so its own centre sits on the origin.
 *
 * Outlines arrive in artboard coordinates, where (0,0) is a corner of the
 * board rather than anywhere near the art. Imported as-is, a 100x50 board
 * lands the shape 50mm right and 25mm up of wherever the node says it is,
 * and an A4 board throws it off the grid entirely — which is what made
 * imports appear outside the workspace instead of in the middle of it.
 *
 * Centring on the ART, not on the board: what you want in view is the
 * drawing, and empty margin around it should not push it off centre. The
 * cost is that two SVGs exported from the same board no longer line up with
 * each other by construction — they each arrive centred, and are aligned by
 * moving them, like any other pair of objects.
 */
function centred(paths: SvgCommand[][]): SvgCommand[][] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const see = (x: number, y: number) => {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  };

  // Curves are sampled, not just cornered: a bowl bulging past its endpoints
  // is part of the drawing and belongs inside the bounds being centred.
  let cursor: [number, number] = [0, 0];
  for (const path of paths) {
    for (const c of path) {
      if (c[0] === "M" || c[0] === "L") {
        cursor = [c[1], c[2]];
        see(cursor[0], cursor[1]);
      } else if (c[0] === "C") {
        const [x0, y0] = cursor;
        for (let i = 1; i <= 8; i++) {
          const t = i / 8, u = 1 - t;
          const a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
          see(
            a * x0 + b * c[1] + d * c[3] + e * c[5],
            a * y0 + b * c[2] + d * c[4] + e * c[6],
          );
        }
        cursor = [c[5], c[6]];
      }
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return paths;

  const dx = -(minX + maxX) / 2;
  const dy = -(minY + maxY) / 2;
  return paths.map((path) =>
    path.map((c) => {
      if (c[0] === "M") return ["M", c[1] + dx, c[2] + dy] as SvgCommand;
      if (c[0] === "L") return ["L", c[1] + dx, c[2] + dy] as SvgCommand;
      if (c[0] === "C") {
        return ["C", c[1] + dx, c[2] + dy, c[3] + dx, c[4] + dy, c[5] + dx, c[6] + dy] as SvgCommand;
      }
      return c;
    }),
  );
}

function lastX(commands: SvgCommand[]): number {
  for (let i = commands.length - 1; i >= 0; i--) {
    const c = commands[i];
    if (c[0] === "M" || c[0] === "L") return c[1];
    if (c[0] === "C") return c[5];
  }
  return 0;
}

function lastY(commands: SvgCommand[]): number {
  for (let i = commands.length - 1; i >= 0; i--) {
    const c = commands[i];
    if (c[0] === "M" || c[0] === "L") return c[2];
    if (c[0] === "C") return c[6];
  }
  return 0;
}
