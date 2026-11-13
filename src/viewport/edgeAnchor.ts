/** Pick strictly inside a displayed segment, never at a shared junction.
 * Mesh edge groups store pairs of vertices, not a continuous vertex list.
 * Their middle array entry can be the end of a different feature edge. */
export function edgeInteriorAnchor(
  positions: { getX(i: number): number; getY(i: number): number; getZ(i: number): number },
  start: number,
  count: number,
): [number, number, number] | null {
  let longest = 0;
  let anchor: [number, number, number] | null = null;
  for (let i = start; i + 1 < start + count; i += 2) {
    const a = [positions.getX(i), positions.getY(i), positions.getZ(i)];
    const b = [positions.getX(i + 1), positions.getY(i + 1), positions.getZ(i + 1)];
    const length = Math.hypot(...b.map((v, j) => v - a[j]));
    if (length > longest) {
      longest = length;
      anchor = a.map((v, j) => (v + b[j]) / 2) as [number, number, number];
    }
  }
  return anchor;
}
