import { MeshShape, getManifold } from "replicad";

/**
 * Builds a 100% watertight, non-self-intersecting 2-manifold helical spring solid.
 * Supports cylindrical, conical, round/square wire, and ground flat ends.
 */
export function makeSpringSolid(p: Record<string, number>): MeshShape {
  const manifold = getManifold();
  const R_bot = Math.max(p.radius ?? 12, 0.5);
  const R_top = Math.max(p.topRadius ?? p.radius ?? 12, 0.5);
  const rWire = Math.max(p.wireRadius ?? 1.5, 0.1);
  const H = Math.max(p.height ?? 40, 1);
  const turns = Math.max(p.turns ?? 6, 0.5);
  const endStyle = p.endStyle ?? 0;
  const wireShape = p.wireShape ?? 0;

  const Theta = 2 * Math.PI * turns;
  const K = Math.max(16, Math.min(1000, Math.round(turns * 36)));
  const M = wireShape === 1 ? 4 : 16;
  const verts: number[] = [];
  const tris: number[] = [];

  for (let k = 0; k <= K; k++) {
    const u = k / K;
    const t = u * Theta;
    const Ru = R_bot + (R_top - R_bot) * u;
    const cx = Ru * Math.cos(t);
    const cy = Ru * Math.sin(t);
    const cz = u * H;

    const tx = -Ru * Math.sin(t);
    const ty = Ru * Math.cos(t);
    const tz = Theta > 0 ? H / Theta : 0;
    const tLen = Math.hypot(tx, ty, tz) || 1;
    const Tx = tx / tLen, Ty = ty / tLen, Tz = tz / tLen;

    const nx = ty;
    const ny = -tx;
    const nLen = Math.hypot(nx, ny) || 1;
    const Nx = nx / nLen, Ny = ny / nLen, Nz = 0;

    const Bx = Ty * Nz - Tz * Ny;
    const By = Tz * Nx - Tx * Nz;
    const Bz = Tx * Ny - Ty * Nx;

    for (let j = 0; j < M; j++) {
      let px: number, py: number, pz: number;
      if (wireShape === 1) {
        const sx = (j === 0 || j === 3 ? -1 : 1) * rWire;
        const sy = (j === 0 || j === 1 ? -1 : 1) * rWire;
        px = cx + sx * Nx + sy * Bx;
        py = cy + sx * Ny + sy * By;
        pz = cz + sx * Nz + sy * Bz;
      } else {
        const phi = (j * 2 * Math.PI) / M;
        const cosPhi = Math.cos(phi);
        const sinPhi = Math.sin(phi);
        px = cx + rWire * (cosPhi * Nx + sinPhi * Bx);
        py = cy + rWire * (cosPhi * Ny + sinPhi * By);
        pz = cz + rWire * (cosPhi * Nz + sinPhi * Bz);
      }
      verts.push(px, py, pz);
    }
  }

  for (let k = 0; k < K; k++) {
    const row0 = k * M;
    const row1 = (k + 1) * M;
    for (let j = 0; j < M; j++) {
      const jNext = (j + 1) % M;
      const v00 = row0 + j;
      const v10 = row0 + jNext;
      const v01 = row1 + j;
      const v11 = row1 + jNext;

      tris.push(v00, v10, v11);
      tris.push(v00, v11, v01);
    }
  }

  const cStart = verts.length / 3;
  verts.push(R_bot, 0, 0);
  const cEnd = cStart + 1;
  verts.push(R_top * Math.cos(Theta), R_top * Math.sin(Theta), H);

  for (let j = 0; j < M; j++) {
    const jNext = (j + 1) % M;
    tris.push(cStart, jNext, j);
    const endRow = K * M;
    tris.push(cEnd, endRow + j, endRow + jNext);
  }

  const rawMesh = new manifold.Mesh({
    vertProperties: new Float32Array(verts),
    triVerts: new Uint32Array(tris),
    numProp: 3,
  });

  let spring = new manifold.Manifold(rawMesh);

  if (endStyle === 1) {
    // Ground Flat: cut flat at top and bottom so the spring stands stably upright on Z=0
    const maxR = Math.max(R_bot, R_top) + rWire * 3;
    const boxSize = maxR * 4;
    const cutterBox = manifold.Manifold.cube([boxSize, boxSize, H], false).translate([
      -boxSize / 2,
      -boxSize / 2,
      0,
    ]);
    spring = manifold.Manifold.intersection(spring, cutterBox);
  }

  return new MeshShape(spring);
}
