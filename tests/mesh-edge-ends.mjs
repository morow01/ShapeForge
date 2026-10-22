import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import ManifoldModule from 'manifold-3d';
import { MeshShape, getManifold, setManifold, setOC } from 'replicad';
import OpenCascade from 'replicad-opencascadejs';

setOC(await OpenCascade());
const wasm = await ManifoldModule();
wasm.setup();
setManifold(wasm);

// The production finish, and the same code with its end caps disabled — the
// square ends this test is about.
const source = readFileSync(new URL('../src/kernel/shape.ts', import.meta.url), 'utf8');
const operation = source.slice(source.indexOf('function finishMeshEdge('), source.indexOf('function hollowMesh('));
const js = ts.transpile(operation, { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None });
const build = (code) => new Function('MeshShape', 'getManifold', `${code}; return finishMeshEdge;`)(MeshShape, getManifold);
const finish = build(js);
const squareEnds = build(js.replace('const cap = atStart ? capStart : capEnd;', 'const cap = null;'));
assert.ok(js.includes('const cap = atStart ? capStart : capEnd;'), 'fixture must be able to disable the end caps');

// A block cut by a tilted block, as a cut tool leaves it. The tall border
// between the slanted face and the front face arrives at the top face at 78
// degrees, not square, which is where a square-ended cutter leaves a wedge.
const TILT = (12 * Math.PI) / 180;
const block = wasm.Manifold.cube([40, 20, 50], true)
  .subtract(wasm.Manifold.cube([40, 40, 80], true).rotate([0, 12, 0]).translate([-32, 0, 0]));
// Where that border runs: x = edgeX(z) on the front face, y = -10.
const edgeX = (z) => (-11.30 + Math.sin(TILT) * z) / Math.cos(TILT);
const anchor = [edgeX(0), -10, 0];
const solid = () => new MeshShape(new wasm.Manifold(block.getMesh()));
const probe = (x, y, z, size = 0.3) => wasm.Manifold.cube([size, size, size], true).translate([x, y, z]);

// A thin slice across the border: how much material is left beside it there.
// The finish is the same all the way along, so a slice just under the top
// face must hold as little as one from the middle. A square end leaves the
// corner near the top face full, and the slice shows it.
const slice = (z, thickness = 0.2) =>
  wasm.Manifold.cube([10, 6, thickness], true).translate([edgeX(z) + 3, -7, z]);
const left = (shape, z) => shape.intersect(slice(z)).volume();
assert.ok(left(block, 24.9) > 0, 'fixture: the corner starts full');

for (const kind of ['chamfer', 'fillet']) {
  const square = squareEnds(solid(), [anchor], 5, kind);
  const capped = finish(solid(), [anchor], 5, kind);
  assert.ok(square && capped, `${kind} must build`);
  assert.equal(capped.wrapped.status(), 'NoError');
  assert.equal(capped.wrapped.decompose().length, 1, `${kind}: one solid, no offcut`);
  const middle = left(capped.wrapped, 0);
  assert.ok(middle < left(block, 0) - 0.5, `fixture: the ${kind} itself must take material out`);
  assert.ok(left(square.wrapped, 24.9) > middle + 0.3,
    `fixture must reproduce the square-end wedge for ${kind}`);
  assert.ok(Math.abs(left(capped.wrapped, 24.9) - middle) < middle * 0.02,
    `${kind}: a wedge of material is left standing where the border meets the top face`);
  // The finish stays where it belongs: 8 mm from the border is untouched,
  // and no more is taken out than the finish itself can account for.
  const beside = probe(edgeX(24) + 8, -9.7, 24);
  assert.ok(Math.abs(capped.wrapped.intersect(beside).volume() - block.intersect(beside).volume()) < 1e-9,
    `${kind}: material away from the border must be untouched`);
  const removed = block.volume() - capped.wrapped.volume();
  assert.ok(removed > 0 && removed < 5 * 5 * 52, `${kind}: removed ${removed.toFixed(2)} mm3`);
}

// A cut tool that stops a fifth of a millimetre short of the far face leaves
// a sliver of the original corner standing above the border it made. The
// finish has to run through that remnant to the top face; stopping on it is
// the notch this bug was reported as.
const short = wasm.Manifold.cube([40, 20, 50], true)
  .trimByPlane([Math.cos(TILT), 0, Math.sin(TILT)], -14.408);
const remnantEdge = [(-14.408) / Math.cos(TILT), -10, 0];
const corner = probe(-19.8, -9.8, 24.9, 0.15);
assert.ok(short.intersect(corner).volume() > 1e-4, 'fixture: the remnant corner starts full');
const throughRemnant = finish(new MeshShape(new wasm.Manifold(short.getMesh())), [remnantEdge], 3, 'chamfer');
const stoppingShort = squareEnds(new MeshShape(new wasm.Manifold(short.getMesh())), [remnantEdge], 3, 'chamfer');
assert.ok(throughRemnant && stoppingShort, 'the shortened cut chamfers');
assert.ok(stoppingShort.wrapped.intersect(corner).volume() > 1e-4,
  'fixture must reproduce the notch left on the remnant');
assert.ok(throughRemnant.wrapped.intersect(corner).volume() < 1e-9,
  'the finish must run through a sliver of leftover surface to the face behind it');

// An edge that meets its end face square keeps its square end: no reaching
// past the corner into the shoulder below it.
const stepped = wasm.Manifold.cube([40, 20, 20], true).translate([0, 0, 10])
  .add(wasm.Manifold.cube([60, 20, 20], true).translate([0, 0, -10]));
const shoulder = new MeshShape(new wasm.Manifold(stepped.getMesh()));
// The upright border of the upper block, which ends on the shoulder below it.
const finished = finish(shoulder, [[20, 10, 10]], 3, 'chamfer');
assert.ok(finished, 'stepped solid chamfers');
assert.ok(stepped.volume() - finished.wrapped.volume() > 0, 'the border is chamfered');
const below = probe(19, 9, -2, 1);
assert.ok(Math.abs(finished.wrapped.intersect(below).volume() - stepped.intersect(below).volume()) < 1e-9,
  'the shoulder under a chamfered border must not be cut into');

console.log('Edge ends: slanted borders finish flush with the face they run into; square corners stay square');
