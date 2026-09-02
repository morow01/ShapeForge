import { MeshShape, getManifold } from "replicad";

/**
 * Builds a 100% watertight, non-self-intersecting 2-manifold helical thread solid using a high-density cylindrical grid.
 */
export function makeThreadSolid(
  diameter: number,
  pitch: number,
  length: number,
  isInternal = false,
  clearance = 0,
  chamfer = true,
  density = 1,
): any {
  const manifold = getManifold();
  const D = Math.max(diameter, 1);
  const P = Math.max(pitch, 0.2);
  const L = Math.max(length, 1);

  // ISO Metric profile parameters
  const Htri = (Math.sqrt(3) / 2) * P;
  const ht = (5 / 8) * Htri;
  const majorR = D / 2 + (isInternal ? clearance : 0);
  const minorR = Math.max(0.2, majorR - ht);

  const crestR = isInternal ? majorR + ht * 0.08 : majorR;
  const rootR = isInternal ? minorR : Math.max(0.2, minorR - ht * 0.04);

  // Thread Quality: 0 = Draft (32 radial, 8 vert), 1 = Standard (64 radial, 14 vert), 2 = Ultra (96 radial, 18 vert)
  const S = density === 0 ? 32 : density === 2 ? 96 : 64;
  const stepsPerPitch = density === 0 ? 8 : density === 2 ? 18 : 14;
  const maxRings = density === 0 ? 100 : density === 2 ? 300 : 220;
  const H = Math.max(16, Math.min(maxRings, Math.round((L / P) * stepsPerPitch)));
  const dz = L / H;
  const dTheta = (2 * Math.PI) / S;

  const verts: number[] = [];
  const tris: number[] = [];

  const chamferH = Math.min(P * 0.8, L * 0.2);

  // Generate smooth cylindrical height-grid
  for (let k = 0; k <= H; k++) {
    const z = k * dz;
    for (let j = 0; j < S; j++) {
      const theta = j * dTheta;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);

      // Fractional thread phase along the helix [0, 1)
      let phase = (z / P - j / S) % 1;
      if (phase < 0) phase += 1;

      // Metric trapezoidal profile with smooth Hermite curvature transitions
      let r: number;
      if (phase < 0.35) {
        // Flank: Root to Crest
        const u = phase / 0.35;
        const s = u * u * (3 - 2 * u);
        r = rootR + (crestR - rootR) * s;
      } else if (phase < 0.45) {
        // Crest Flat
        r = crestR;
      } else if (phase < 0.8) {
        // Flank: Crest to Root
        const u = (phase - 0.45) / 0.35;
        const s = u * u * (3 - 2 * u);
        r = crestR - (crestR - rootR) * s;
      } else {
        // Root Flat
        r = rootR;
      }

      // Smooth 45-degree lead-in chamfer on the top tip
      if (chamfer && !isInternal && L > 2 && z > L - chamferH) {
        const t = (L - z) / chamferH;
        const maxR = rootR * 0.85 + (crestR - rootR * 0.85) * t;
        if (r > maxR) r = maxR;
      }

      verts.push(r * cos, r * sin, z);
    }
  }

  // Lateral grid triangles (2 triangles per quad with outward normals)
  for (let k = 0; k < H; k++) {
    const rowCurr = k * S;
    const rowNext = (k + 1) * S;
    for (let j = 0; j < S; j++) {
      const jNext = (j + 1) % S;

      const v00 = rowCurr + j;
      const v10 = rowCurr + jNext;
      const v01 = rowNext + j;
      const v11 = rowNext + jNext;

      tris.push(v00, v10, v11);
      tris.push(v00, v11, v01);
    }
  }

  // Bottom and top closing disk caps
  const cBot = (H + 1) * S;
  verts.push(0, 0, 0); // Bottom center

  const cTop = (H + 1) * S + 1;
  verts.push(0, 0, L); // Top center

  // Bottom cap fan (facing -Z)
  for (let j = 0; j < S; j++) {
    const jNext = (j + 1) % S;
    tris.push(cBot, jNext, j);
  }

  // Top cap fan (facing +Z)
  const topBase = H * S;
  for (let j = 0; j < S; j++) {
    const jNext = (j + 1) % S;
    tris.push(cTop, topBase + j, topBase + jNext);
  }

  const rawMesh = new manifold.Mesh({
    vertProperties: new Float32Array(verts),
    triVerts: new Uint32Array(tris),
    numProp: 3,
  });

  return new manifold.Manifold(rawMesh);
}

/**
 * Builds a watertight knurled cylinder with vertical gripping ribs.
 */
function makeKnurledCylinder(
  height: number,
  diameter: number,
  numKnurls = 24,
): any {
  const manifold = getManifold();
  const K = Math.max(12, Math.min(48, numKnurls));
  const N = K * 2;
  const rCrest = diameter / 2;
  const knurlDepth = Math.max(0.35, Math.min(1.2, diameter * 0.05));
  const rRoot = rCrest - knurlDepth;
  const dTheta = Math.PI / K;

  const verts: number[] = [];
  const tris: number[] = [];

  const pts: [number, number][] = [];
  for (let j = 0; j < N; j++) {
    const r = j % 2 === 0 ? rCrest : rRoot;
    const a = j * dTheta;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }

  // Bottom ring at z = 0
  for (let j = 0; j < N; j++) {
    verts.push(pts[j][0], pts[j][1], 0);
  }
  // Top ring at z = height
  for (let j = 0; j < N; j++) {
    verts.push(pts[j][0], pts[j][1], height);
  }

  const cBot = N * 2;
  verts.push(0, 0, 0);
  const cTop = N * 2 + 1;
  verts.push(0, 0, height);

  // Bottom cap fan
  for (let j = 0; j < N; j++) {
    const next = (j + 1) % N;
    tris.push(cBot, next, j);
  }
  // Top cap fan
  for (let j = 0; j < N; j++) {
    const next = (j + 1) % N;
    tris.push(cTop, N + j, N + next);
  }
  // Lateral fluted sides
  for (let j = 0; j < N; j++) {
    const next = (j + 1) % N;
    const b0 = j;
    const b1 = next;
    const t0 = N + j;
    const t1 = N + next;
    tris.push(b0, b1, t1);
    tris.push(b0, t1, t0);
  }

  const mesh = new manifold.Mesh({
    vertProperties: new Float32Array(verts),
    triVerts: new Uint32Array(tris),
    numProp: 3,
  });
  return new manifold.Manifold(mesh);
}

/**
 * Builds a complete Threaded Rod / Bolt solid with optional heads.
 */
export function makeThreadedRodSolid(p: Record<string, number>): MeshShape {
  const manifold = getManifold();
  const diameter = Math.max(p.diameter ?? 8, 2);
  const pitch = Math.max(p.pitch ?? 1.25, 0.2);
  const length = Math.max(p.length ?? 30, 2);
  const headType = p.headType ?? 0;
  const headSize = Math.max(p.headSize ?? 13, diameter + 1);
  const headHeight = Math.max(p.headHeight ?? 5.5, 1);
  const chamfer = (p.chamfer ?? 1) === 1;
  const density = p.density ?? 1;

  const threadSolid = makeThreadSolid(diameter, pitch, length, false, 0, chamfer, density);

  if (headType === 0) {
    // No Head (Stud / Rod)
    return new MeshShape(threadSolid);
  }

  let headSolid: InstanceType<typeof manifold.Manifold>;

  if (headType === 1) {
    // Hex Head (Bolt)
    const rVertex = headSize / Math.sqrt(3);
    headSolid = manifold.Manifold.cylinder(headHeight + 0.05, rVertex, rVertex, 6).translate([0, 0, -headHeight]);
  } else if (headType === 2) {
    // Socket Cap (Allen Head)
    const cap = manifold.Manifold.cylinder(headHeight + 0.05, headSize / 2, headSize / 2, 48).translate([0, 0, -headHeight]);
    const hexKeySize = diameter * 0.6;
    const rKey = hexKeySize / Math.sqrt(3);
    const socketDepth = headHeight * 0.65;
    const socket = manifold.Manifold.cylinder(socketDepth + 0.1, rKey, rKey, 6).translate([0, 0, -socketDepth]);
    headSolid = manifold.Manifold.difference(cap, socket);
  } else {
    // Knurled Thumb Screw Head
    const numKnurls = Math.max(16, Math.round(headSize * 1.6));
    headSolid = makeKnurledCylinder(headHeight + 0.05, headSize, numKnurls).translate([0, 0, -headHeight]);
  }

  // Union head with thread and shift so local base rests on z = 0
  const combined = manifold.Manifold.union([headSolid, threadSolid]).translate([0, 0, headHeight]);
  return new MeshShape(combined);
}

/**
 * Builds a complete Threaded Nut with matching internal thread & 3D print clearance.
 */
export function makeThreadedNutSolid(p: Record<string, number>): MeshShape {
  const manifold = getManifold();
  const diameter = Math.max(p.diameter ?? 8, 2);
  const pitch = Math.max(p.pitch ?? 1.25, 0.2);
  const height = Math.max(p.height ?? 6.5, 1);
  const outerWidth = Math.max(p.outerWidth ?? 13, diameter + 2);
  const shape = p.shape ?? 0;
  const clearance = Math.max(p.clearance ?? 0.2, 0);
  const density = p.density ?? 1;
  const cornerSteps = Math.max(1, Math.min(32, Math.round(p.cornerSteps ?? 16)));
  const wall = Math.max(0, (outerWidth - (diameter + clearance * 2)) / 2);
  const maxCorner = Math.max(0, Math.min(height / 2, wall) - 0.01);
  const topCorner = Math.min(Math.max(p.topFillet ?? 0, 0), maxCorner);
  const bottomCorner = Math.min(Math.max(p.bottomFillet ?? 0, 0), maxCorner);

  let nutBody: InstanceType<typeof manifold.Manifold>;

  if ((shape === 0 || shape === 1) && (topCorner > 0 || bottomCorner > 0)) {
    const sides = shape === 0 ? 6 : 4;
    const fullRadius = shape === 0 ? outerWidth / Math.sqrt(3) : outerWidth / Math.sqrt(2);
    const rotation = shape === 0 ? 0 : Math.PI / 4;
    const rings: Array<{ radius: number; z: number }> = [];
    if (bottomCorner > 0) {
      for (let i = 0; i <= cornerSteps; i++) {
        const angle = Math.PI / 2 * i / cornerSteps;
        rings.push({
          radius: fullRadius - bottomCorner * (1 - Math.sin(angle)),
          z: bottomCorner * (1 - Math.cos(angle)),
        });
      }
    } else rings.push({ radius: fullRadius, z: 0 });
    if (topCorner > 0) {
      for (let i = 0; i <= cornerSteps; i++) {
        const angle = Math.PI / 2 * i / cornerSteps;
        const ring = {
          radius: fullRadius - topCorner * (1 - Math.cos(angle)),
          z: height - topCorner + topCorner * Math.sin(angle),
        };
        if (Math.abs(rings[rings.length - 1].z - ring.z) > 1e-7) rings.push(ring);
      }
    } else if (Math.abs(rings[rings.length - 1].z - height) > 1e-7) {
      rings.push({ radius: fullRadius, z: height });
    }
    const verts: number[] = [];
    for (const ring of rings) {
      for (let side = 0; side < sides; side++) {
        const angle = rotation + side * 2 * Math.PI / sides;
        verts.push(ring.radius * Math.cos(angle), ring.radius * Math.sin(angle), ring.z);
      }
    }
    const bottomCentre = verts.length / 3;
    verts.push(0, 0, 0);
    const topCentre = verts.length / 3;
    verts.push(0, 0, height);
    const tris: number[] = [];
    for (let ring = 0; ring < rings.length - 1; ring++) {
      for (let side = 0; side < sides; side++) {
        const next = (side + 1) % sides;
        const a = ring * sides + side;
        const b = ring * sides + next;
        const c = (ring + 1) * sides + side;
        const d = (ring + 1) * sides + next;
        tris.push(a, b, c, b, d, c);
      }
    }
    const topStart = (rings.length - 1) * sides;
    for (let side = 0; side < sides; side++) {
      const next = (side + 1) % sides;
      tris.push(bottomCentre, next, side);
      tris.push(topCentre, topStart + side, topStart + next);
    }
    nutBody = new manifold.Manifold(new manifold.Mesh({
      vertProperties: new Float32Array(verts),
      triVerts: new Uint32Array(tris),
      numProp: 3,
    }));
  } else if (shape === 0) {
    // Hexagonal Nut
    const rVertex = outerWidth / Math.sqrt(3);
    nutBody = manifold.Manifold.cylinder(height, rVertex, rVertex, 6);
  } else if (shape === 1) {
    // Square Nut
    nutBody = manifold.Manifold.cube([outerWidth, outerWidth, height], true).translate([0, 0, height / 2]);
  } else {
    // Knurled Thumb Nut
    const numKnurls = Math.max(16, Math.round(outerWidth * 1.6));
    nutBody = makeKnurledCylinder(height, outerWidth, numKnurls);
  }

  // Internal thread cutter
  const internalThread = makeThreadSolid(diameter, pitch, height + 2, true, clearance, false, density);
  const cutter = internalThread.translate([0, 0, -1]);

  const finishedNut = manifold.Manifold.difference(nutBody, cutter);
  return new MeshShape(finishedNut);
}
