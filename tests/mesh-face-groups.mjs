import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import ManifoldModule from 'manifold-3d';
import OpenCascade from 'replicad-opencascadejs';
import { MeshShape, setManifold, setOC } from 'replicad';

setOC(await OpenCascade());
const m = await ManifoldModule();
m.setup();
setManifold(m);

// Pull the real grouping function out of the worker so the test cannot drift from it.
const source = readFileSync(new URL('../src/kernel/worker.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('/** Neighbouring triangles that bend away');
const end = source.indexOf('/** Preserve exact analytic display normals');
assert.ok(start > 0 && end > start, 'found meshFromMeshShape in worker.ts');
const js = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None });
const meshFromMeshShape = new Function(`${js}; return meshFromMeshShape;`)();

const shape = (manifold) => new MeshShape(manifold);
const stats = (manifold) => {
  const { faces, edges } = meshFromMeshShape(shape(manifold));
  return { faces: faces.faceGroups.length, edges: edges.edgeGroups.length, triangles: faces.triangles.length / 3 };
};

// A box keeps its six flat faces and twelve edges.
const box = stats(m.Manifold.cube([20, 20, 10]));
assert.equal(box.faces, 6, 'box has 6 faces');
assert.equal(box.edges, 12, 'box has 12 edges');

// A round cylinder is a wall and two caps, not one face per side.
const cyl = stats(m.Manifold.cylinder(10, 5, 5, 64));
assert.equal(cyl.faces, 3, 'cylinder is wall + 2 caps');
assert.equal(cyl.edges, 128, 'cylinder has its two circular rims only');

// A box with a round hole through it: the box's own faces plus the hole wall.
const holed = stats(m.Manifold.cube([30, 30, 10]).subtract(m.Manifold.cylinder(12, 5, 5, 48).translate([15, 15, -1])));
assert.ok(holed.faces <= 8, `holed box has about 7 faces, got ${holed.faces}`);

// The bowl that made orbiting crawl: a revolved curved profile, ~96 steps around.
const profile = [];
for (let i = 0; i <= 190; i++) {
  const t = i / 190;
  profile.push([20 + 25 * Math.sin(t * Math.PI), 60 * t]);
}
const section = m.CrossSection.ofPolygons([[[0, 0], ...profile.map(([x, y]) => [x, y]), [0, 60]]]);
const bowl = section.revolve(96, 360);
const before = bowl.getMesh().triVerts.length / 3;
const b = stats(bowl);
assert.ok(b.triangles > 30000, `bowl is a heavy mesh (${b.triangles} triangles)`);
assert.ok(b.faces < 20, `bowl is a handful of faces, got ${b.faces} from ${before} triangles`);
assert.ok(b.edges < 2000, `bowl edges are only patch borders, got ${b.edges}`);

// Specks a boolean leaves behind are part of the face they lie in, not faces
// of their own. Every cut strews them — a border finish, which is dozens of
// cutters, strews hundreds — and counted as faces they cover the model in
// stray edge lines and shading facets.
const nicked = Array.from({ length: 18 }, (_, i) => i).reduce((solid, i) => solid.subtract(
  m.Manifold.cube([1.6, 0.12, 0.4], true).rotate([8, 0, 0]).translate([-18 + i * 2.1, -9.95, 25.18]),
), m.Manifold.cube([40, 20, 50], true));
const withSpecks = new Function(`${js.replace('const speckArea = Math.min(totalArea * SPECK_FACE_SHARE, SPECK_FACE_AREA);', 'const speckArea = 0;')}; return meshFromMeshShape;`)();
const raw = withSpecks(shape(nicked));
assert.ok(raw.faces.faceGroups.length > 50, `fixture must strew specks, got ${raw.faces.faceGroups.length} faces`);
const specked = stats(nicked);
assert.ok(specked.faces <= 8, `a nicked box is still about six faces, got ${specked.faces}`);
assert.ok(specked.edges <= 20, `and about twelve edges, got ${specked.edges}`);

// A small face is still a face: only specks are absorbed, and 9mm² is not a
// speck — it is something a person can see and click.
const stepped = m.Manifold.cube([40, 20, 50], true)
  .subtract(m.Manifold.cube([3, 3, 3], true).translate([0, -10 + 1.5, 25]));
const step = stats(stepped);
assert.ok(step.faces >= 10, `the 3mm step keeps its own faces, got ${step.faces}`);

console.log(`Faces: box ${box.faces}, cylinder ${cyl.faces}, holed box ${holed.faces}, revolved bowl ${b.faces} (was about ${Math.round(b.triangles / 2)}); bowl edges ${b.edges}. Nicked box ${specked.faces} faces, not ${raw.faces.faceGroups.length}.`);
