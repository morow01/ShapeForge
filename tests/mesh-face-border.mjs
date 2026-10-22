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

// The border finder and the finish, and the same code cutting one border at a
// time the way it used to.
const src = readFileSync(new URL('../src/kernel/shape.ts', import.meta.url), 'utf8');
const anchors = src.slice(src.indexOf('function findMeshFaceBoundaryAnchors('), src.indexOf('function finishMeshEdge(')).replace(/export /g, '');
const finish = src.slice(src.indexOf('function finishMeshEdge('), src.indexOf('function hollowMesh('));
const js = ts.transpile(`${anchors}\n${finish}`, { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None });
const TOGETHER = '(isConcave ? toAdd : toCut).push(new manifold.Manifold(prismMesh));';
assert.ok(js.includes(TOGETHER), 'fixture must be able to put the cutters in one at a time');
const build = (code) => new Function('MeshShape', 'getManifold', `${code}; return { findMeshFaceBoundaryAnchors, finishMeshEdge };`)(MeshShape, getManifold);
const api = build(js);
const oneAtATime = build(js.split(TOGETHER).join(
  'currentSolid = isConcave ? currentSolid.fuse(new MeshShape(new manifold.Manifold(prismMesh))) : currentSolid.cut(new MeshShape(new manifold.Manifold(prismMesh)));',
));

// A bracket: a slot with a rounded end, and sides tilted in by 12 degrees, so
// the front face's border is two dozen pieces running in every direction.
const TILT = (12 * Math.PI) / 180;
const slot = wasm.Manifold.cube([10, 40, 30], true).translate([0, 0, 13])
  .add(wasm.Manifold.cylinder(40, 5, 5, 32, true).rotate([90, 0, 0]).translate([0, 0, -2]));
const bracket = wasm.Manifold.cube([40, 20, 50], true).subtract(slot)
  .trimByPlane([Math.cos(TILT), 0, Math.sin(TILT)], -14)
  .trimByPlane([-Math.cos(TILT), 0, Math.sin(TILT)], -14);
assert.equal(bracket.genus(), 0, 'fixture starts as a plain solid');

const front = { point: [0, -10, 0], normal: [0, -1, 0] };
const solid = () => new MeshShape(new wasm.Manifold(bracket.getMesh()));
const border = api.findMeshFaceBoundaryAnchors(solid(), front.point, front.normal);
assert.ok(border.length > 20, `the front face's border should be many pieces, found ${border.length}`);

for (const kind of ['fillet', 'chamfer']) {
  const finished = api.finishMeshEdge(solid(), border, 5, kind);
  assert.ok(finished, `${kind}: the border finish must build`);
  assert.equal(finished.wrapped.status(), 'NoError');
  assert.equal(finished.wrapped.decompose().length, 1, `${kind}: one solid, no offcuts`);
  assert.equal(finished.wrapped.genus(), 0, `${kind}: the finish must not tunnel through the part`);
  const taken = bracket.volume() - finished.volume();
  assert.ok(taken > 0 && taken < 5 * 5 * 400, `${kind}: removed ${taken.toFixed(2)} mm3`);

  // The surface it leaves cannot depend on which end of the border it starts
  // from. Cutting with one cutter at a time, each one met the face the last
  // one had just left behind, so the order decided what the booleans made of
  // the mitres between them and the finished mesh came out carrying dozens of
  // stray facets. Every cutter now goes in at once, in a single boolean.
  const fromTheOtherEnd = api.finishMeshEdge(solid(), [...border].reverse(), 5, kind);
  assert.ok(fromTheOtherEnd, `${kind}: reversed order must build too`);
  assert.ok(Math.abs(finished.volume() - fromTheOtherEnd.volume()) < 1e-6, `${kind}: same material either way`);
  const drift = Math.abs(finished.wrapped.numTri() - fromTheOtherEnd.wrapped.numTri());
  assert.ok(drift <= 4, `${kind}: the mesh changes with the order of the border (${drift} triangles)`);

  if (kind === 'fillet') {
    const before = oneAtATime.finishMeshEdge(solid(), border, 5, kind);
    const beforeReversed = oneAtATime.finishMeshEdge(solid(), [...border].reverse(), 5, kind);
    assert.ok(Math.abs(before.wrapped.numTri() - beforeReversed.wrapped.numTri()) > 20,
      'fixture must reproduce the order-dependent mesh');
    assert.ok(finished.wrapped.numTri() < before.wrapped.numTri(),
      'the finish should leave fewer facets than cutting one border at a time');
  }
}

console.log(`Face border: ${border.length} border pieces finish as one clean solid, whichever end they start from`);
