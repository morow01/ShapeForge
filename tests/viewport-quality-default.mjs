import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// The real file, with a stand-in for the browser's saved settings.
const source = readFileSync(new URL('../src/viewport/quality.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n').replace(/^export /gm, '');
const js = ts.transpile(source, { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None });

function run(saved) {
  const store = new Map(Object.entries(saved));
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  const read = new Function('localStorage', `${js}; return readViewportQuality;`)(localStorage);
  return { first: read(), second: read(), store };
}

// A new browser starts on high.
assert.equal(run({}).first, 'high');
// The old automatic default ("normal", saved on first load) is upgraded once.
assert.equal(run({ 'cad.viewportQuality': 'normal' }).first, 'high');
// Deliberate choices are kept.
assert.equal(run({ 'cad.viewportQuality': 'draft' }).first, 'draft');
assert.equal(run({ 'cad.viewportQuality': 'high' }).first, 'high');
// After the upgrade, choosing "normal" again sticks.
const afterUpgrade = run({ 'cad.viewportQuality': 'normal' });
afterUpgrade.store.set('cad.viewportQuality', 'normal');
const again = new Function('localStorage', `${js}; return readViewportQuality;`)({
  getItem: (k) => (afterUpgrade.store.has(k) ? afterUpgrade.store.get(k) : null),
  setItem: (k, v) => afterUpgrade.store.set(k, String(v)),
});
assert.equal(again(), 'normal');
// Reading twice gives the same answer.
const twice = run({ 'cad.viewportQuality': 'normal' });
assert.equal(twice.first, twice.second);
// Storage that throws still gives high.
const broken = new Function('localStorage', `${js}; return readViewportQuality;`)({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } });
assert.equal(broken(), 'high');

console.log('Viewport quality default: new browsers get high, the old automatic normal is upgraded once, draft and high are kept, a later normal sticks.');
