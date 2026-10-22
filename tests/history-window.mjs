import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Pull the real functions out of the sources so the test cannot drift.
const slice = (file, from, to) => {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const start = source.indexOf(from);
  const end = source.indexOf(to);
  assert.ok(start > 0 && end > start, `found ${from} in ${file}`);
  return source.slice(start, end).replaceAll('export function', 'function');
};
const js = ts.transpile(
  slice('../src/document/historyStore.ts', 'export function trimHistoryWindow', 'function openDb') +
    slice('../src/document/store.ts', 'export function historyTimeline', '/** Steps of redo'),
  { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None },
);
const { trimHistoryWindow, historyTimeline, PERSISTED_HISTORY_STEPS } = new Function(
  `const PERSISTED_HISTORY_STEPS = ${
    readFileSync(new URL('../src/document/historyStore.ts', import.meta.url), 'utf8').match(
      /PERSISTED_HISTORY_STEPS = (\d+)/,
    )[1]
  };
   ${js};
   return { trimHistoryWindow, historyTimeline, PERSISTED_HISTORY_STEPS };`,
)();

// The number the whole thing is sized around stays somewhere sensible: big
// enough to walk a session back, small enough to serialise on a real design.
assert.ok(
  PERSISTED_HISTORY_STEPS >= 10 && PERSISTED_HISTORY_STEPS <= 50,
  'the persisted window is a workable size',
);

const snap = (label) => ({ nodes: [label], historyLabel: label });
const past = ['a', 'b', 'c', 'd', 'e'].map(snap);
// zundo's future stack runs backwards: its LAST entry is the next redo.
const future = ['z', 'y', 'x'].map(snap);

// Both stacks are cut from the far end, so what is kept is what sits closest
// to the present on either side.
const cut = trimHistoryWindow(past, future, 'now', 2);
assert.deepEqual(cut.past.map((s) => s.historyLabel), ['d', 'e']);
assert.deepEqual(cut.future.map((s) => s.historyLabel), ['y', 'x']);
assert.equal(cut.label, 'now');

// Which is the invariant that matters: a trimmed window still reads as an
// unbroken run of steps around the present, in the same order.
const full = historyTimeline(past, future, 'now').map((s) => s.label);
const trimmed = historyTimeline(cut.past, cut.future, cut.label).map((s) => s.label);
assert.deepEqual(full, ['a', 'b', 'c', 'd', 'e', 'now', 'x', 'y', 'z']);
assert.deepEqual(trimmed, ['d', 'e', 'now', 'x', 'y']);
assert.ok(full.join('|').includes(trimmed.join('|')), 'the kept steps are contiguous around the present');

// A stack shorter than the window comes back whole.
assert.deepEqual(trimHistoryWindow(past, [], 'now', 99).past.length, 5);

// A limit of none keeps nothing, and never goes negative on a slice.
assert.deepEqual(trimHistoryWindow(past, future, 'now', 0), { past: [], future: [], label: 'now' });
assert.deepEqual(trimHistoryWindow(past, future, 'now', -3), { past: [], future: [], label: 'now' });

// Entries a stored file cannot be trusted on: no nodes means no state to go
// back to, and a missing name still has to list as something.
const dodgy = trimHistoryWindow([{ historyLabel: 'no nodes' }, { nodes: ['k'] }, snap('ok')], [], 'now');
assert.deepEqual(dodgy.past.map((s) => s.historyLabel), ['Edit', 'ok']);
assert.deepEqual(dodgy.past[0].nodes, ['k']);

// Trimming is a copy, not a splice of what the live stack is still using.
const live = [snap('a'), snap('b')];
assert.notEqual(trimHistoryWindow(live, [], 'now', 1).past[0], live[1]);
assert.equal(live.length, 2);

console.log('history-window: ok');
