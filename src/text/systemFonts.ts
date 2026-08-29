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

export async function systemFonts(): Promise<LocalFontData[]> {
  if (!window.queryLocalFonts) throw new Error("System-font access is not supported by this browser.");
  const fonts = await window.queryLocalFonts();
  return fonts.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export async function textOutlines(fontData: LocalFontData, text: string, size: number): Promise<SvgOutlines> {
  const font = parse(await (await fontData.blob()).arrayBuffer());
  const paths: SvgCommand[][] = [];
  font.forEachGlyph(text, 0, 0, size, {}, (glyph, x, y, fontSize) => {
    const commands: SvgCommand[] = [];
    let px = 0;
    let py = 0;
    for (const c of glyph.getPath(x, y, fontSize).commands) {
      if (c.type === "M") {
        commands.push(["M", c.x, c.y]); px = c.x; py = c.y;
      } else if (c.type === "L") {
        commands.push(["L", c.x, c.y]); px = c.x; py = c.y;
      } else if (c.type === "C") {
        commands.push(["C", c.x1, c.y1, c.x2, c.y2, c.x, c.y]); px = c.x; py = c.y;
      } else if (c.type === "Q") {
        const x1 = px + (2 / 3) * (c.x1 - px);
        const y1 = py + (2 / 3) * (c.y1 - py);
        const x2 = c.x + (2 / 3) * (c.x1 - c.x);
        const y2 = c.y + (2 / 3) * (c.y1 - c.y);
        commands.push(["C", x1, y1, x2, y2, c.x, c.y]); px = c.x; py = c.y;
      } else if (c.type === "Z") commands.push(["Z"]);
    }
    if (commands.length) paths.push(commands);
  });
  if (!paths.length) throw new Error("That text has no printable glyphs.");

  const coords: [number, number][] = [];
  for (const path of paths) for (const c of path) {
    if (c[0] === "M" || c[0] === "L") coords.push([c[1], c[2]]);
    else if (c[0] === "C") coords.push([c[1], c[2]], [c[3], c[4]], [c[5], c[6]]);
  }
  const minX = Math.min(...coords.map((p) => p[0]));
  const maxX = Math.max(...coords.map((p) => p[0]));
  const minY = Math.min(...coords.map((p) => p[1]));
  const maxY = Math.max(...coords.map((p) => p[1]));
  const shifted = paths.map((path) => path.map((c): SvgCommand => {
    if (c[0] === "M" || c[0] === "L") return [c[0], c[1] - minX, maxY - c[2]];
    if (c[0] === "C") return ["C", c[1] - minX, maxY - c[2], c[3] - minX, maxY - c[4], c[5] - minX, maxY - c[6]];
    return ["Z"];
  }));
  return { paths: shifted, width: maxX - minX, height: maxY - minY, unitPreset: "physical" };
}
