import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// The real runner, straight from the source.
const source = readFileSync(new URL('../src/drive/serial.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n').replace('export function', 'function');
const js = ts.transpile(source, { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None });
const createSerialRunner = new Function(`${js}; return createSerialRunner;`)();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = createSerialRunner();

// Jobs never overlap, and start in the order they were asked for, whatever their duration.
const log = [];
let running = 0;
let overlapped = false;
const job = (name, ms) => async () => {
  running++;
  if (running > 1) overlapped = true;
  log.push('start ' + name);
  await sleep(ms);
  log.push('end ' + name);
  running--;
  return name;
};
const results = await Promise.all([run(job('slow', 40)), run(job('fast', 1)), run(job('medium', 15))]);
assert.deepEqual(results, ['slow', 'fast', 'medium'], 'each caller gets its own result');
assert.equal(overlapped, false, 'no two jobs ran at once');
assert.deepEqual(log, ['start slow', 'end slow', 'start fast', 'end fast', 'start medium', 'end medium'], 'in the order asked');

// A job that fails rejects for its own caller only; the ones behind it still run.
const after = [];
const failing = run(async () => {
  throw new Error('boom');
});
const next = run(async () => {
  after.push('ran');
  return 'ok';
});
await assert.rejects(failing, /boom/);
assert.equal(await next, 'ok');
assert.deepEqual(after, ['ran']);

// A job started later while others are still going waits for all of them.
const order = [];
const a = run(async () => { await sleep(20); order.push('a'); });
await sleep(5);
const b = run(async () => { order.push('b'); });
await Promise.all([a, b]);
assert.deepEqual(order, ['a', 'b']);

console.log('Serial runner: one at a time, in order, a failure does not block the queue, late arrivals wait their turn.');
