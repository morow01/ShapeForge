import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Pull the real function out of tree.ts so the test cannot drift from it.
const source = readFileSync(new URL('../src/document/tree.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('export function removeNodesDeep');
const end = source.indexOf('/** The parent list containing');
assert.ok(start > 0 && end > start, 'found removeNodesDeep in tree.ts');
const js = ts.transpile(source.slice(start, end).replace('export function', 'function'), { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None });
const isGroup = (n) => n.type === 'group';
const removeNodesDeep = new Function('isGroup', `${js}; return removeNodesDeep;`)(isGroup);

const box = (id) => ({ id, type: 'object' });
const imp = (id) => ({ id, type: 'import' });
const group = (id, ...children) => ({ id, type: 'group', children });
const edit = (id, base) => ({ id, type: 'edit', base, ops: [1] });

// A top-level object.
assert.deepEqual(removeNodesDeep([box('a'), imp('m')], new Set(['m'])).map((n) => n.id), ['a']);

// Inside a group: the group stays with its other children.
let out = removeNodesDeep([group('g', box('a'), imp('m'))], new Set(['m']));
assert.deepEqual(out[0].children.map((n) => n.id), ['a']);

// Inside an edit's base group (the case that used to hang the Logitech design).
out = removeNodesDeep([edit('e', group('g', box('a'), imp('m')))], new Set(['m']));
assert.equal(out[0].type, 'edit');
assert.deepEqual(out[0].base.children.map((n) => n.id), ['a']);

// A group left empty goes too, and so does an edit whose base disappears.
out = removeNodesDeep([group('g', imp('m')), edit('e', group('g2', imp('m2'))), box('keep')], new Set(['m', 'm2']));
assert.deepEqual(out.map((n) => n.id), ['keep']);

// Nothing to remove: the same tree comes back untouched (same references).
const tree = [group('g', box('a')), edit('e', group('g2', box('b')))];
const same = removeNodesDeep(tree, new Set(['nope']));
assert.equal(same[0], tree[0]);
assert.equal(same[1], tree[1]);

// Deeply nested: group in group in edit.
out = removeNodesDeep([edit('e', group('g1', group('g2', box('a'), imp('m')), imp('m3')))], new Set(['m', 'm3']));
assert.deepEqual(out[0].base.children[0].children.map((n) => n.id), ['a']);

console.log('removeNodesDeep: top level, groups, edit bases, emptied groups/edits, untouched trees and deep nesting all behave.');
