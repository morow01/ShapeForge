export type Pt = [number, number];

const MAX_RASTER = 800;

/** One pass of a moving average along rows (horizontal) or columns, edges clamped to empty. */
function boxBlur(src: Float32Array, dst: Float32Array, w: number, h: number, half: number, horizontal: boolean) {
  const lines = horizontal ? h : w, length = horizontal ? w : h;
  const stride = horizontal ? 1 : w, step = horizontal ? w : 1;
  const norm = 1 / (2 * half + 1);
  for (let line = 0; line < lines; line++) {
    const base = line * step;
    let sum = 0;
    for (let i = 0; i <= half && i < length; i++) sum += src[base + i * stride];
    for (let i = 0; i < length; i++) {
      dst[base + i * stride] = sum * norm;
      const add = i + half + 1, drop = i - half;
      if (add < length) sum += src[base + add * stride];
      if (drop >= 0) sum -= src[base + drop * stride];
    }
  }
}

/**
 * The filled footprint of some triangles (x, y pairs, three points each), blurred
 * by `smooth` plane units and traced back to line segments. Detail smaller than
 * the blur disappears, so a rough scan comes out as one clean outline.
 */
export function smoothFootprint(triangles: Float32Array, smooth: number): [Pt, Pt][] {
  if (triangles.length < 6) return [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < triangles.length; i += 2) {
    const x = triangles[i], y = triangles[i + 1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const span = Math.max(maxX - minX, maxY - minY, 1e-6);
  const scale = MAX_RASTER / (span + smooth * 6);
  const sigma = smooth * scale * 0.5;
  const pad = Math.ceil(sigma * 3) + 3;
  const width = Math.ceil((maxX - minX) * scale) + pad * 2;
  const height = Math.ceil((maxY - minY) * scale) + pad * 2;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#fff";
  const px = (x: number) => (x - minX) * scale + pad;
  const py = (y: number) => (maxY - y) * scale + pad;
  // Every triangle the same way round, so overlapping ones add up under the
  // non-zero rule instead of cancelling each other out.
  ctx.beginPath();
  for (let t = 0; t + 5 < triangles.length; t += 6) {
    const ax = px(triangles[t]), ay = py(triangles[t + 1]);
    let bx = px(triangles[t + 2]), by = py(triangles[t + 3]);
    let cx = px(triangles[t + 4]), cy = py(triangles[t + 5]);
    if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) < 0) { [bx, by, cx, cy] = [cx, cy, bx, by]; }
    ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(cx, cy); ctx.closePath();
  }
  ctx.fill();

  const data = ctx.getImageData(0, 0, width, height).data;
  let field = new Float32Array(width * height);
  for (let i = 0; i < field.length; i++) field[i] = data[i * 4] / 255;
  if (sigma > 0.5) {
    // Three box passes approximate a Gaussian of that sigma.
    const half = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
    let other = new Float32Array(field.length);
    for (let pass = 0; pass < 3; pass++) {
      boxBlur(field, other, width, height, half, true);
      boxBlur(other, field, width, height, half, false);
    }
  }

  const out: [Pt, Pt][] = [];
  const toPlane = (x: number, y: number): Pt => [(x - pad) / scale + minX, maxY - (y - pad) / scale];
  const at = (x: number, y: number) => field[y * width + x];
  const edge = (x: number, y: number, side: 0 | 1 | 2 | 3): Pt => {
    // 0 top, 1 right, 2 bottom, 3 left of the cell whose centre-to-centre corners are (x,y)…(x+1,y+1)
    const [x0, y0, x1, y1] = side === 0 ? [x, y, x + 1, y] : side === 1 ? [x + 1, y, x + 1, y + 1]
      : side === 2 ? [x, y + 1, x + 1, y + 1] : [x, y, x, y + 1];
    const a = at(x0, y0), b = at(x1, y1);
    const t = b === a ? 0.5 : (0.5 - a) / (b - a);
    return toPlane(x0 + 0.5 + (x1 - x0) * t, y0 + 0.5 + (y1 - y0) * t);
  };
  // Segment pairs (edge sides) for each corner pattern: top-left 8, top-right 4, bottom-right 2, bottom-left 1.
  const cases: Record<number, [number, number][]> = {
    1: [[3, 2]], 2: [[2, 1]], 3: [[3, 1]], 4: [[0, 1]], 5: [[0, 1], [3, 2]], 6: [[0, 2]], 7: [[0, 3]],
    8: [[0, 3]], 9: [[0, 2]], 10: [[0, 3], [2, 1]], 11: [[0, 1]], 12: [[3, 1]], 13: [[2, 1]], 14: [[3, 2]],
  };
  for (let y = 0; y + 1 < height; y++) {
    for (let x = 0; x + 1 < width; x++) {
      const index = (at(x, y) >= 0.5 ? 8 : 0) | (at(x + 1, y) >= 0.5 ? 4 : 0) | (at(x + 1, y + 1) >= 0.5 ? 2 : 0) | (at(x, y + 1) >= 0.5 ? 1 : 0);
      const segments = cases[index];
      if (!segments) continue;
      for (const [s, e] of segments) out.push([edge(x, y, s as 0 | 1 | 2 | 3), edge(x, y, e as 0 | 1 | 2 | 3)]);
    }
  }
  return out;
}
