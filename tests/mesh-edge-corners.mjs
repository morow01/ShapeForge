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
// Exercise the production mesh operation without loading browser-only imports.
const source = readFileSync(new URL('../src/kernel/shape.ts', import.meta.url), 'utf8');
const operation = source.slice(source.indexOf('function finishMeshEdge('), source.indexOf('function hollowMesh('));
const js = ts.transpile(operation, { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None });
const finish = new Function('MeshShape', 'getManifold', `${js}; return finishMeshEdge;`)(MeshShape, getManifold);
const squareCaps = new Function('MeshShape', 'getManifold', `${js.replace('const vertex = atStart', 'return point; const vertex = atStart')}; return finishMeshEdge;`)(MeshShape, getManifold);
const box = (size, position) => wasm.Manifold.cube(size).translate(position);
// A U-shaped raised rim, with two reentrant corners in its top border.
const rim = box([30, 30, 20], [0, 0, 0]).subtract(box([20, 26, 21], [5, 5, 0]));
const anchors = [[15,0,20],[30,15,20],[27.5,30,20],[25,17.5,20],[15,5,20],[5,17.5,20],[2.5,30,20],[0,15,20]];
for (const kind of ['chamfer', 'fillet']) {
  const result = finish(new MeshShape(new wasm.Manifold(rim.getMesh())), anchors, 2, kind);
  const previous = squareCaps(new MeshShape(new wasm.Manifold(rim.getMesh())), anchors, 2, kind);
  assert.ok(result && result.volume() < rim.volume());
  assert.equal(result.wrapped.status(), 'NoError');
  assert.equal(result.wrapped.decompose().length, 1);
  for (const x of [4.6, 25.4]) {
    const probe = box([0.04,0.04,0.04], [x-0.02,4.58,19.78]);
    assert.ok(rim.intersect(probe).volume() > 0.00006);
    assert.ok(previous.wrapped.intersect(probe).volume() > 0.00006, 'Fixture must reproduce the square-cap defect');
    assert.ok(result.wrapped.intersect(probe).volume() < 1e-8, `${kind}: raised corner wedge remains at ${x}`);
  }
  const lower = box([30,30,10], [0,0,0]);
  assert.ok(Math.abs(result.wrapped.intersect(lower).volume() - rim.intersect(lower).volume()) < 1e-5);
  assert.equal(finish(new MeshShape(new wasm.Manifold(rim.getMesh())), anchors, 3, kind), null,
    `${kind}: profiles wider than half the rim must be rejected`);
  const subdivided = finish(new MeshShape(rim.refine(8)), anchors, 2, kind);
  assert.ok(subdivided);
  const difference = subdivided.wrapped.subtract(result.wrapped).volume() + result.wrapped.subtract(subdivided.wrapped).volume();
  assert.ok(difference < 1e-3, `${kind}: mesh subdivisions changed the corner geometry (${difference})`);
  console.log(`${kind}: corner gaps removed; connected valid solid; lower geometry preserved`);
}
