import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const sketchSource = readFileSync(new URL('../src/sketch/geometry.ts', import.meta.url), 'utf8')
  .replace(/^import.*;\r?\n/gm, '');
const patternSource = readFileSync(new URL('../src/geometry/pattern.ts', import.meta.url), 'utf8')
  .replace(/^import.*;\r?\n/gm, '');

const transpiled = ts.transpileModule(sketchSource + '\n' + patternSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;

const exportsObj = {};
const fn = new Function('exports', 'require', transpiled);
fn(exportsObj, () => ({}));
const { generateCircularTransforms, generateGridTransforms, generatePathTransforms } = exportsObj;

// Test 1: Circular Pattern (Tire / Radial)
const basePos = [0, 50, 10];
const baseRot = [0, 0, 0];
const circ = generateCircularTransforms(basePos, baseRot, { count: 4, totalAngle: 360, axis: 2, center: [0, 0, 0], rotateCopies: true });
assert.equal(circ.length, 4);
assert.equal(Math.round(circ[0].position[1]), 50);
assert.equal(Math.round(circ[1].position[0]), -50);
assert.equal(Math.round(circ[2].position[1]), -50);
assert.equal(Math.round(circ[3].position[0]), 50);
console.log('Circular pattern radial transforms passed');

// Test 2: Grid / Honeycomb Matrix (Grill / Vents)
const grid = generateGridTransforms([0, 0, 0], [0, 0, 0], { rows: 3, cols: 3, spacingX: 10, spacingY: 10, stagger: 'hex', centerGrid: true, plane: 'XY' });
assert.equal(grid.length, 9);
console.log('Grid and Honeycomb transforms passed');

// Test 3: Path Pattern
const linePath = {
  id: 'p1',
  closed: false,
  anchors: [
    { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0, mode: 'corner' },
    { x: 100, y: 0, inX: 0, inY: 0, outX: 0, outY: 0, mode: 'corner' }
  ]
};
const pathResult = generatePathTransforms([0, 0, 0], [0, 0, 0], { path: linePath, count: 5, followTangent: true, startOffset: 0, plane: 'XY' });
assert.equal(pathResult.length, 5);
assert.equal(Math.round(pathResult[0].position[0]), 0);
assert.equal(Math.round(pathResult[4].position[0]), 100);
console.log('Path pattern arc-length transforms passed');
