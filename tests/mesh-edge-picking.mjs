import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import ManifoldModule from 'manifold-3d';
import { MeshShape, setManifold, setOC } from 'replicad';
import OpenCascade from 'replicad-opencascadejs';

setOC(await OpenCascade());
const wasm = await ManifoldModule();
wasm.setup();
setManifold(wasm);

// The production mesher, without the browser-only imports around it.
const source = readFileSync(new URL('../src/kernel/worker.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const body = source.slice(source.indexOf('function meshFromMeshShape('), source.indexOf('function normalsPerCadFace('));
const js = ts.transpile(body, { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None });
const meshFromMeshShape = new Function(
  'SMOOTH_PATCH_MAX_AREA_SHARE', 'SMOOTH_PATCH_DEGREES', 'SPECK_FACE_SHARE', 'SPECK_FACE_AREA',
  `${js}; return meshFromMeshShape;`,
)(0.02, 20, 1e-4, 2);

const shape = (manifold) => new MeshShape(new wasm.Manifold(manifold.getMesh()));
const point = (lines, vertex) => [lines[vertex * 3], lines[vertex * 3 + 1], lines[vertex * 3 + 2]];
const span = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

/** Every group as one polyline: its length, and the checks that it really is
 *  one edge — segments joined end to end, all running the same way. */
function edges(solid) {
  const { edges: { lines, edgeGroups } } = meshFromMeshShape(solid);
  return edgeGroups.map((group) => {
    assert.ok(group.count >= 2 && group.count % 2 === 0, `group of ${group.count} points`);
    let length = 0;
    let heading = null;
    for (let at = group.start; at + 1 < group.start + group.count; at += 2) {
      const from = point(lines, at);
      const to = point(lines, at + 1);
      const step = span(from, to);
      length += step;
      const way = to.map((value, i) => (value - from[i]) / (step || 1));
      if (heading) {
        const straight = heading[0] * way[0] + heading[1] * way[1] + heading[2] * way[2];
        assert.ok(straight > Math.cos(Math.PI / 90), 'one edge must not turn a corner');
        assert.ok(span(point(lines, at - 1), from) < 1e-4, 'one edge must run end to end');
      }
      heading = way;
    }
    return length;
  });
}

// A cube tessellated into four pieces along each edge: a person sees twelve
// edges and must be able to pick twelve edges, not forty-eight crumbs.
const refined = edges(shape(wasm.Manifold.cube([20, 20, 20]).refine(4)));
assert.equal(refined.length, 12, `refined cube edges: ${refined.length}`);
for (const length of refined) assert.ok(Math.abs(length - 20) < 1e-3, `edge length ${length}`);

// The reported case: a block cut by two tilted blocks. Straight borders come
// out of the boolean chopped into fragments, some a hundredth of a millimetre
// long, and every one of them used to be its own pickable edge.
const block = wasm.Manifold.cube([40, 20, 50], true)
  .subtract(wasm.Manifold.cube([10, 30, 36], true).translate([0, 0, 10]))
  .refine(3);
const tilt = (degrees, x) => wasm.Manifold.cube([40, 40, 80], true).rotate([0, degrees, 0]).translate([x, 0, 0]);
const cut = block.subtract(tilt(12, -32)).subtract(tilt(-12, 32));
const { edges: { lines, edgeGroups } } = meshFromMeshShape(shape(cut));
const lengths = edges(shape(cut));
const segments = lines.length / 6;
assert.ok(edgeGroups.length < segments, `${edgeGroups.length} edges from ${segments} segments`);
// Nothing may be lost or counted twice while the runs are joined up.
let total = 0;
for (let at = 0; at < segments; at++) total += span(point(lines, at * 2), point(lines, at * 2 + 1));
assert.ok(Math.abs(total - lengths.reduce((sum, value) => sum + value, 0)) < 1e-6, 'every segment belongs to one edge');
// The tall slanted borders this bug was reported on are whole edges again.
assert.ok(lengths.filter((length) => length > 40).length >= 4, `long edges: ${lengths.filter((l) => l > 40).length}`);

console.log(`Edge picking: refined cube is 12 edges; cut block is ${edgeGroups.length} edges from ${segments} segments`);
