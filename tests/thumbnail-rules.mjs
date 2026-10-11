import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/drive/thumbRules.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n').replace(/^export /gm, '');
const js = ts.transpile(source, { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None });

const thumbnailAction = new Function(`${js}; return thumbnailAction;`)();

const mine = (at, has = true) => ({ has, at });
const theirs = (at, has = true) => ({ has, at });

// Nothing on Drive: send ours, if we have one.
assert.equal(thumbnailAction(mine(100), theirs(0, false)), 'push');
assert.equal(thumbnailAction(mine(0, false), theirs(0, false)), 'none');
// Nothing here: fetch theirs.
assert.equal(thumbnailAction(mine(0, false), theirs(100)), 'pull');
// Both have one: the newer wins, whichever side it is on.
assert.equal(thumbnailAction(mine(100), theirs(200)), 'pull');
assert.equal(thumbnailAction(mine(300), theirs(200)), 'push');
assert.equal(thumbnailAction(mine(200), theirs(200)), 'none');
// A picture made before pictures carried a time (0) loses to any dated one, so the first sync settles on Drive's.
assert.equal(thumbnailAction(mine(0), theirs(5)), 'pull');
assert.equal(thumbnailAction(mine(5), theirs(0)), 'push');

// The scenario that went wrong: A and B hold different pictures. Simulate repeated syncs from both and show
// the pair converges on the newest and then stays still, whatever order the syncs happen in.
function simulate(order) {
  const drive = { has: true, at: 50, pic: 'blank' };
  const pcs = { A: { has: true, at: 10, pic: 'zoomed' }, B: { has: true, at: 70, pic: 'small' } };
  const history = [];
  for (const who of order) {
    const pc = pcs[who];
    const act = thumbnailAction(pc, drive);
    if (act === 'pull') Object.assign(pc, { pic: drive.pic, at: drive.at });
    if (act === 'push') Object.assign(drive, { pic: pc.pic, at: pc.at });
    history.push(`${who}:${act}:${drive.pic}`);
  }
  return { drive, pcs, history };
}
for (const order of [['A', 'B', 'A', 'B', 'A', 'B'], ['B', 'A', 'B', 'A', 'B', 'A'], ['A', 'A', 'B', 'B', 'A', 'B'], ['B', 'B', 'A', 'A', 'B', 'A']]) {
  const { drive, pcs, history } = simulate(order);
  assert.equal(drive.pic, 'small', 'Drive ends on the newest picture: ' + history.join(' '));
  assert.equal(pcs.A.pic, 'small');
  assert.equal(pcs.B.pic, 'small');
  // After both have settled, no further action ever fires, so nothing can flip back.
  assert.equal(thumbnailAction(pcs.A, drive), 'none');
  assert.equal(thumbnailAction(pcs.B, drive), 'none');
}

console.log('Thumbnail rules: newest wins on either side; undated pictures lose; two computers converge on the newest picture and then stay still in every sync order.');
