import { parse } from "opentype.js";
import type { SvgCommand, SvgOutlines } from "../svg/parse";

export interface LocalFontData {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
  blob(): Promise<Blob>;
}

declare global {
  interface Window {
    queryLocalFonts?: () => Promise<LocalFontData[]>;
  }
}

/** Thrown when the browser has no queryLocalFonts at all, as opposed to
 *  having it and refusing. The two need different advice: one is a permission
 *  the user can grant, the other is a browser that will never have it. */
export const NO_FONT_LISTING = "This browser cannot list installed fonts.";

/**
 * Wraps a font file the user picked into the same shape queryLocalFonts
 * returns, so the rest of the text pipeline cannot tell the difference.
 *
 * queryLocalFonts is Chromium-only — Firefox and Safari have no equivalent
 * and no plan for one — so without this the text tool simply does not exist
 * in half the browsers. Everyone can open a .ttf.
 */
export function fontFromFile(file: File): LocalFontData {
  const name = file.name.replace(/.[^.]+$/, "");
  return {
    family: name,
    fullName: name,
    postscriptName: name,
    style: "",
    blob: async () => file,
  };
}

export async function systemFonts(): Promise<LocalFontData[]> {
  if (!window.queryLocalFonts) throw new Error(NO_FONT_LISTING);
  const fonts = await window.queryLocalFonts();
  return fonts.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

let defaultFontPromise: Promise<ReturnType<typeof parse>> | null = null;

export async function getDefaultFont() {
  if (!defaultFontPromise) {
    defaultFontPromise = (async () => {
      try {
        const res = await fetch("/fonts/Roboto-Bold.ttf");
        const buf = await res.arrayBuffer();
        return parse(buf);
      } catch {
        return null as any;
      }
    })();
  }
  return defaultFontPromise;
}

export function fontToOutlines(font: ReturnType<typeof parse>, text: string, size: number): SvgOutlines {
  const paths: SvgCommand[][] = [];
  const scale = (1 / (font.unitsPerEm || 1000)) * size;
  let cursorX = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const glyph = font.charToGlyph(char);
    if (!glyph) {
      cursorX += size * 0.6;
      continue;
    }

    const glyphPath = glyph.getPath(cursorX, 0, size);
    cursorX += (glyph.advanceWidth ?? font.unitsPerEm * 0.6) * scale;

    const glyphCommands: SvgCommand[] = [];
    let px = 0;
    let py = 0;

    for (const c of glyphPath.commands) {
      if (c.type === "M") {
        glyphCommands.push(["M", c.x, c.y]);
        px = c.x;
        py = c.y;
      } else if (c.type === "L") {
        glyphCommands.push(["L", c.x, c.y]);
        px = c.x;
        py = c.y;
      } else if (c.type === "C") {
        glyphCommands.push(["C", c.x1, c.y1, c.x2, c.y2, c.x, c.y]);
        px = c.x;
        py = c.y;
      } else if (c.type === "Q") {
        const x1 = px + (2 / 3) * (c.x1 - px);
        const y1 = py + (2 / 3) * (c.y1 - py);
        const x2 = c.x + (2 / 3) * (c.x1 - c.x);
        const y2 = c.y + (2 / 3) * (c.y1 - c.y);
        glyphCommands.push(["C", x1, y1, x2, y2, c.x, c.y]);
        px = c.x;
        py = c.y;
      } else if (c.type === "Z") {
        glyphCommands.push(["Z"]);
      }
    }
    if (glyphCommands.length) paths.push(glyphCommands);
  }

  if (!paths.length) return { paths: [], width: 0, height: 0, unitPreset: "physical" };

  const coords: [number, number][] = [];
  for (const path of paths) {
    for (const c of path) {
      if (c[0] === "M" || c[0] === "L") coords.push([c[1], c[2]]);
      else if (c[0] === "C") coords.push([c[1], c[2]], [c[3], c[4]], [c[5], c[6]]);
    }
  }
  if (!coords.length) return { paths: [], width: 0, height: 0, unitPreset: "physical" };

  const minX = Math.min(...coords.map((p) => p[0]));
  const maxX = Math.max(...coords.map((p) => p[0]));
  const minY = Math.min(...coords.map((p) => p[1]));
  const maxY = Math.max(...coords.map((p) => p[1]));
  const shifted = paths.map((path) =>
    path.map((c): SvgCommand => {
      if (c[0] === "M" || c[0] === "L") return [c[0], c[1] - minX, maxY - c[2]];
      if (c[0] === "C") return ["C", c[1] - minX, maxY - c[2], c[3] - minX, maxY - c[4], c[5] - minX, maxY - c[6]];
      return ["Z"];
    }),
  );
  return { paths: shifted, width: maxX - minX, height: maxY - minY, unitPreset: "physical" };
}

export async function textOutlines(fontData: LocalFontData, text: string, size: number): Promise<SvgOutlines> {
  const font = parse(await (await fontData.blob()).arrayBuffer());
  return fontToOutlines(font, text, size);
}

const DEFAULT_TEXT_PATHS: SvgCommand[][] = [
  [["M",4.306640625,14.21875],["L",7.2265625,14.21875],["L",7.2265625,0],["L",4.306640625,0],["L",4.306640625,14.21875],["M",0,14.21875],["L",11.6015625,14.21875],["L",11.6015625,11.923828125],["L",0,11.923828125],["L",0,14.21875]],
  [["M",15.234375,2.28515625],["L",22.802734375,2.28515625],["L",22.802734375,0],["L",15.234375,0],["L",15.234375,2.28515625],["M",13.26171875,14.21875],["L",16.19140625,14.21875],["L",16.19140625,0],["L",13.26171875,0],["L",13.26171875,14.21875],["M",15.234375,8.427734375],["L",21.81640625,8.427734375],["L",21.81640625,6.201171875],["L",15.234375,6.201171875],["L",15.234375,8.427734375],["M",15.234375,14.21875],["L",22.79296875,14.21875],["L",22.79296875,11.923828125],["L",15.234375,11.923828125],["L",15.234375,14.21875]],
  [["M",23.5546875,14.21875],["L",26.923828125,14.21875],["L",29.599609375,9.2578125],["L",32.275390625,14.21875],["L",35.625,14.21875],["L",31.494140625,7.16796875],["L",35.732421875,0],["L",32.353515625,0],["L",29.599609375,5.05859375],["L",26.845703125,0],["L",23.447265625,0],["L",27.6953125,7.16796875],["L",23.5546875,14.21875]],
  [["M",40.64453125,14.21875],["L",43.564453125,14.21875],["L",43.564453125,0],["L",40.64453125,0],["L",40.64453125,14.21875],["M",36.337890625,14.21875],["L",47.939453125,14.21875],["L",47.939453125,11.923828125],["L",36.337890625,11.923828125],["L",36.337890625,14.21875]],
];

export function normalizeFontName(fontName?: string): string {
  if (!fontName || fontName.trim().toLowerCase() === "default") return "default";
  return fontName.trim();
}

const textPathsCache = new Map<string, SvgCommand[][]>([
  ["default:TEXT:20", DEFAULT_TEXT_PATHS],
]);

export function getCachedTextPaths(fontName?: string, text = "TEXT", size = 20): SvgCommand[][] | undefined {
  const content = text && text.trim() ? text : "TEXT";
  return textPathsCache.get(`${normalizeFontName(fontName)}:${content}:${size}`);
}

export function setCachedTextPaths(fontName: string | undefined, text: string, size: number, paths: SvgCommand[][]): void {
  const content = text && text.trim() ? text : "TEXT";
  textPathsCache.set(`${normalizeFontName(fontName)}:${content}:${size}`, paths);
}

export async function resolveTextPaths(
  fontName?: string,
  text = "TEXT",
  size = 20,
  fontList?: LocalFontData[],
): Promise<SvgCommand[][]> {
  const content = text && text.trim() ? text : "TEXT";
  const normalizedFont = normalizeFontName(fontName);
  const cacheKey = `${normalizedFont}:${content}:${size}`;
  if (textPathsCache.has(cacheKey)) {
    return textPathsCache.get(cacheKey)!;
  }
  let font: ReturnType<typeof parse> | null = null;
  if (normalizedFont !== "default" && fontList) {
    const found = fontList.find(
      (f) => f.fullName === fontName || f.postscriptName === fontName || f.family === fontName,
    );
    if (found) {
      try {
        font = parse(await (await found.blob()).arrayBuffer());
      } catch {
        font = null;
      }
    }
  }
  if (!font) {
    font = await getDefaultFont();
  }
  if (!font) return [];
  const outlines = fontToOutlines(font, content, size);
  textPathsCache.set(cacheKey, outlines.paths);
  return outlines.paths;
}

// Pre-warm default font and default TEXT outline on module load
getDefaultFont().then((font) => {
  if (font) {
    const outlines = fontToOutlines(font, "TEXT", 20);
    textPathsCache.set("default:TEXT:20", outlines.paths);
  }
});

