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
  /** Actual artwork geometry width in mm — matches Illustrator's selection. */
  width: number;
  /** Actual artwork geometry height in mm — matches Illustrator's selection. */
  height: number;
  /** Artboard width in mm if known */
  artboardWidth?: number;
  /** Artboard height in mm if known */
  artboardHeight?: number;
  /** Raw artwork width in SVG user units */
  rawWidth?: number;
  /** Raw artwork height in SVG user units */
  rawHeight?: number;
  /** Raw viewBox width if present */
  viewBoxWidth?: number;
  /** Raw viewBox height if present */
  viewBoxHeight?: number;
  /** How otherwise-unitless SVG coordinates were interpreted. */
  unitPreset: "illustrator" | "web" | "physical";
}

/**
 * CSS absolute units in millimetres. A unitless user unit is normally a CSS
 * pixel, 1/96 inch. Illustrator-authored files without physical root
 * dimensions are detected separately in parseSvg and use PostScript points.
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

function toMm(value: string | null, unitlessScale = MM.px): number | null {
  if (!value) return null;
  const m = /^\s*(-?[\d.]+)\s*([a-z%]*)\s*$/i.exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toLowerCase();
  if (unit === "%") return null; // relative to a viewport this file lacks
  const factor = unit === "" || unit === "px" ? unitlessScale : MM[unit];
  return factor === undefined ? null : n * factor;
}

function hasPhysicalUnit(value: string | null): boolean {
  return !!value && /^\s*-?[\d.]+\s*(mm|cm|q|in|pt|pc)\s*$/i.test(value);
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

/** Expands <use> tags by cloning their referenced elements in place. */
function expandUseElements(svg: Element) {
  const uses = Array.from(svg.querySelectorAll("use"));
  for (const use of uses) {
    const rawHref = use.getAttribute("href") ?? use.getAttribute("xlink:href") ?? "";
    const id = rawHref.startsWith("#") ? rawHref.slice(1) : rawHref;
    if (!id) continue;
    const target = svg.querySelector(`[id="${id}"]`);
    if (!target) continue;
    const clone = target.cloneNode(true) as Element;
    clone.removeAttribute("id");
    const x = use.getAttribute("x") ?? "0";
    const y = use.getAttribute("y") ?? "0";
    const transform = use.getAttribute("transform") ?? "";
    const useTransform = `translate(${x}, ${y}) ${transform}`.trim();
    if (useTransform) {
      const existing = clone.getAttribute("transform") ?? "";
      clone.setAttribute("transform", `${useTransform} ${existing}`.trim());
    }
    use.replaceWith(clone);
  }
}

/**
 * Reads an SVG into millimetre outlines.
 *
 * Explicit physical root dimensions are honoured against the viewBox. With
 * no physical dimensions, Illustrator-authored files use PostScript points
 * (72 DPI), while generic SVG uses CSS pixels (96 DPI). The returned size is
 * the tight artwork geometry, not the artboard/viewBox.
 */
export function parseSvg(text: string): SvgOutlines {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  if (doc.querySelector("parsererror")) throw new Error("That file is not valid SVG.");
  const svg = doc.querySelector("svg");
  if (!svg) throw new Error("That file has no <svg> element.");

  // Expand <use> symbols and clones
  expandUseElements(svg);

  const viewBox = (svg.getAttribute("viewBox") ?? "")
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  const hasViewBox = viewBox.length === 4 && viewBox[2] > 0 && viewBox[3] > 0;
  const [vbX, vbY, vbW, vbH] = hasViewBox ? viewBox : [0, 0, 0, 0];

  const widthAttr = svg.getAttribute("width");
  const heightAttr = svg.getAttribute("height");
  const illustratorAuthored = /Adobe\s+Illustrator/i.test(text);
  const defaultUnitScale = illustratorAuthored ? MM.pt : MM.px;
  const widthMm = toMm(widthAttr, defaultUnitScale);
  const heightMm = toMm(heightAttr, defaultUnitScale);
  const hasPhysicalRootSize = hasPhysicalUnit(widthAttr) || hasPhysicalUnit(heightAttr);
  const unitPreset: SvgOutlines["unitPreset"] = hasPhysicalRootSize
    ? "physical"
    : illustratorAuthored
      ? "illustrator"
      : "web";

  let scaleX = defaultUnitScale;
  let scaleY = defaultUnitScale;
  if (hasViewBox && widthMm !== null && heightMm !== null) {
    const candidateX = widthMm / vbW;
    const candidateY = heightMm / vbH;
    const preserve = (svg.getAttribute("preserveAspectRatio") ?? "xMidYMid meet").trim();
    if (/^none(?:\s|$)/i.test(preserve)) {
      scaleX = candidateX;
      scaleY = candidateY;
    } else {
      // SVG's default preserveAspectRatio is uniform `meet`; `slice` is the
      // only other uniform choice. Never stretch X and Y independently just
      // because rounded header dimensions disagree by a tiny amount.
      const uniform = /\bslice\b/i.test(preserve)
        ? Math.max(candidateX, candidateY)
        : Math.min(candidateX, candidateY);
      scaleX = scaleY = uniform;
    }
  } else if (widthMm !== null && hasViewBox && vbW > 0) {
    scaleX = scaleY = widthMm / vbW;
  } else if (heightMm !== null && hasViewBox && vbH > 0) {
    scaleX = scaleY = heightMm / vbH;
  }

  const originX = hasViewBox ? vbX : 0;
  const originY = hasViewBox ? vbY : 0;
  // Artboard height in user units — needed to flip SVG's y-down to y-up.
  const spanY = hasViewBox ? vbH : (heightMm ?? 0) / scaleY;

  const paths: SvgCommand[][] = [];
  const candidateElements = Array.from(
    svg.querySelectorAll("path,rect,circle,ellipse,line,polyline,polygon"),
  ).filter((el) => {
    if (el.closest("defs,clipPath,mask")) return false;
    const style = (el.getAttribute("style") ?? "").toLowerCase();
    if (style.includes("display:none") || style.includes("visibility:hidden") || style.includes("opacity:0")) {
      return false;
    }
    if (el.getAttribute("display") === "none" || el.getAttribute("visibility") === "hidden" || el.getAttribute("opacity") === "0") {
      return false;
    }
    const fill = (el.getAttribute("fill") ?? "").toLowerCase();
    const stroke = (el.getAttribute("stroke") ?? "").toLowerCase();
    if (fill === "none" && (!stroke || stroke === "none") && !style.includes("fill:") && !style.includes("stroke:")) {
      return false;
    }
    return true;
  });

  for (const el of candidateElements) {
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

  const { paths: centredPaths, width: shapeW, height: shapeH } = centred(paths);

  const artboardW = hasViewBox ? vbW * scaleX : widthMm;
  const artboardH = hasViewBox ? vbH * scaleY : heightMm;

  const width = shapeW > 0 ? shapeW : (artboardW ?? 10);
  const height = shapeH > 0 ? shapeH : (artboardH ?? 10);

  return {
    paths: centredPaths,
    width,
    height,
    artboardWidth: artboardW ?? undefined,
    artboardHeight: artboardH ?? undefined,
    rawWidth: shapeW > 0 && scaleX > 0 ? shapeW / scaleX : undefined,
    rawHeight: shapeH > 0 && scaleY > 0 ? shapeH / scaleY : undefined,
    viewBoxWidth: hasViewBox ? vbW : undefined,
    viewBoxHeight: hasViewBox ? vbH : undefined,
    unitPreset,
  };
}

/** Rescales an array of SVG commands uniformly or non-uniformly. */
export function scaleSvgCommands(
  paths: SvgCommand[][],
  scaleX: number,
  scaleY: number,
): SvgCommand[][] {
  if (Math.abs(scaleX - 1) < 1e-6 && Math.abs(scaleY - 1) < 1e-6) return paths;
  return paths.map((path) =>
    path.map((c) => {
      if (c[0] === "M" || c[0] === "L") {
        return [c[0], c[1] * scaleX, c[2] * scaleY] as SvgCommand;
      }
      if (c[0] === "C") {
        return [
          "C",
          c[1] * scaleX,
          c[2] * scaleY,
          c[3] * scaleX,
          c[4] * scaleY,
          c[5] * scaleX,
          c[6] * scaleY,
        ] as SvgCommand;
      }
      return c;
    }),
  );
}

function cubicExtremaRoots(p0: number, c1: number, c2: number, p1: number): number[] {
  const a = 3 * (-p0 + 3 * c1 - 3 * c2 + p1);
  const b = 6 * (p0 - 2 * c1 + c2);
  const c = 3 * (c1 - p0);
  const roots: number[] = [0, 1];
  if (Math.abs(a) < 1e-9) {
    if (Math.abs(b) > 1e-9) {
      const t = -c / b;
      if (t > 0 && t < 1) roots.push(t);
    }
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sqrtDisc = Math.sqrt(disc);
      const t1 = (-b + sqrtDisc) / (2 * a);
      const t2 = (-b - sqrtDisc) / (2 * a);
      if (t1 > 0 && t1 < 1) roots.push(t1);
      if (t2 > 0 && t2 < 1) roots.push(t2);
    }
  }
  return roots;
}

function evalCubic(t: number, p0: number, c1: number, c2: number, p1: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * c1 + 3 * u * t * t * c2 + t * t * t * p1;
}

/**
 * Moves the artwork so its own centre sits on the origin and computes
 * the tight analytical bounding box dimensions of the artwork itself.
 */
function centred(paths: SvgCommand[][]): {
  paths: SvgCommand[][];
  width: number;
  height: number;
} {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const see = (x: number, y: number) => {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  };

  let cursor: [number, number] = [0, 0];
  for (const path of paths) {
    for (const c of path) {
      if (c[0] === "M" || c[0] === "L") {
        cursor = [c[1], c[2]];
        see(cursor[0], cursor[1]);
      } else if (c[0] === "C") {
        const [x0, y0] = cursor;
        const [c1x, c1y, c2x, c2y, p1x, p1y] = [c[1], c[2], c[3], c[4], c[5], c[6]];
        for (const t of cubicExtremaRoots(x0, c1x, c2x, p1x)) {
          see(evalCubic(t, x0, c1x, c2x, p1x), evalCubic(t, y0, c1y, c2y, p1y));
        }
        for (const t of cubicExtremaRoots(y0, c1y, c2y, p1y)) {
          see(evalCubic(t, x0, c1x, c2x, p1x), evalCubic(t, y0, c1y, c2y, p1y));
        }
        cursor = [p1x, p1y];
        see(p1x, p1y);
      }
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { paths, width: 0, height: 0 };
  }

  const width = Math.max(0, maxX - minX);
  const height = Math.max(0, maxY - minY);
  const dx = -(minX + maxX) / 2;
  const dy = -(minY + maxY) / 2;

  return {
    width,
    height,
    paths: paths.map((path) =>
      path.map((c) => {
        if (c[0] === "M") return ["M", c[1] + dx, c[2] + dy] as SvgCommand;
        if (c[0] === "L") return ["L", c[1] + dx, c[2] + dy] as SvgCommand;
        if (c[0] === "C") {
          return ["C", c[1] + dx, c[2] + dy, c[3] + dx, c[4] + dy, c[5] + dx, c[6] + dy] as SvgCommand;
        }
        return c;
      }),
    ),
  };
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
