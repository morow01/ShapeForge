import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { temporal } from 'zundo';
import { createStore } from 'zustand/vanilla';

// Pull the real helpers out of store.ts so the test cannot drift from them.
const source = readFileSync(new URL('../src/document/store.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('export function historyTimeline');
const end = source.indexOf('/* ---- clipboard');
assert.ok(start > 0 && end > start, 'found the history helpers in store.ts');
const js = ts.transpile(source.slice(start, end).replaceAll('export function', 'function'), {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.None,
});

// Configured exactly as the document store is, so the two stacks these
// helpers read are real zundo ones in real zundo order — which is the whole
// point: its future stack runs backwards, and the panel must not.
const doc = createStore(
  temporal(() => ({ nodes: [], historyLabel: 'Open' }), {
    partialize: (s) => ({ nodes: s.nodes, historyLabel: s.historyLabel }),
    equality: (a, b) => a.nodes === b.nodes,
    limit: 200,
  }),
);
const { historyTimeline, historyJump, jumpToHistory } = new Function(
  'useDoc',
  `${js}; return { historyTimeline, historyJump, jumpToHistory };`,
)({ temporal: doc.temporal });

/** An edit, as the store's own `set` makes one: a new node list, and the name
 *  of the action that produced it stamped onto the same write. */
const edit = (label, node) => doc.setState((s) => ({ nodes: [...s.nodes, node], historyLabel: label }));

const timeline = () => {
  const t = doc.temporal.getState();
  return historyTimeline(t.pastStates, t.futureStates, doc.getState().historyLabel);
};
const labels = () => timeline().map((s) => s.label);
const current = () => timeline().find((s) => s.current);
const undone = () => timeline().filter((s) => s.undone).map((s) => s.label);

// A document nobody has touched is one step: the state it was opened at.
assert.deepEqual(labels(), ['Open']);
assert.equal(current().index, 0);
assert.deepEqual(undone(), []);

// Steps list oldest first, newest last, with the present on the last one.
edit('Add Box 1', 'box');
edit('Add Cylinder 1', 'cyl');
edit('Chamfer edge', 'chamfer');
assert.deepEqual(labels(), ['Open', 'Add Box 1', 'Add Cylinder 1', 'Chamfer edge']);
assert.equal(current().index, 3);
assert.deepEqual(undone(), []);

// Clicking an earlier step puts the document back at exactly that state, and
// the steps after it stay listed as undone rather than disappearing.
jumpToHistory(1);
assert.deepEqual(doc.getState().nodes, ['box']);
assert.equal(current().index, 1);
assert.equal(current().label, 'Add Box 1', 'each state carries its own name back with it');
assert.deepEqual(undone(), ['Add Cylinder 1', 'Chamfer edge']);
assert.deepEqual(labels(), ['Open', 'Add Box 1', 'Add Cylinder 1', 'Chamfer edge'], 'the list does not reorder');

// And forward again, several steps at once.
jumpToHistory(3);
assert.deepEqual(doc.getState().nodes, ['box', 'cyl', 'chamfer']);
assert.equal(current().index, 3);
assert.deepEqual(undone(), []);

// However many steps a jump covers, the document changes once — so the kernel
// rebuilds once rather than replaying every step on the way.
let writes = 0;
const stop = doc.subscribe(() => writes++);
jumpToHistory(0);
assert.equal(writes, 1, 'one state change for a three-step jump back');
writes = 0;
jumpToHistory(3);
assert.equal(writes, 1, 'and one for the jump forward');
stop();

// Carrying on from an earlier step discards everything after it.
jumpToHistory(1);
edit('Move Box 1', 'moved');
assert.deepEqual(labels(), ['Open', 'Add Box 1', 'Move Box 1']);
assert.equal(current().index, 2);
assert.deepEqual(undone(), []);

// The arithmetic the jump is built on: negative to step back, positive to go
// forward, zero when the step clicked is the one already in use.
assert.equal(historyJump(1, 4), -3);
assert.equal(historyJump(6, 4), 2);
assert.equal(historyJump(4, 4), 0);

// Clicking the step in use does nothing at all.
const before = doc.getState();
jumpToHistory(current().index);
assert.equal(doc.getState(), before);

// A state saved before labels existed, or by a write no action named, still
// lists as something rather than blank.
assert.deepEqual(historyTimeline([{ nodes: [] }], [], 'Add Box 1'), [
  { index: 0, label: 'Edit', current: false, undone: false },
  { index: 1, label: 'Add Box 1', current: true, undone: false },
]);

console.log('history-timeline: ok');
