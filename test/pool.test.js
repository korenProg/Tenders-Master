const { test } = require('node:test');
const assert = require('node:assert');
const { runPool } = require('../lib/pool');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A worker that records how many tasks were in flight at once.
function tracker(durations = []) {
  const state = { live: 0, peak: 0, order: [] };
  const worker = async (item, i) => {
    state.live++;
    state.peak = Math.max(state.peak, state.live);
    state.order.push(item);
    await sleep(durations[i] ?? 5);
    state.live--;
    return `done:${item}`;
  };
  return { state, worker };
}

test('runs every item exactly once and returns results in INPUT order', async () => {
  // Reverse durations: item 0 finishes LAST, so completion order is scrambled.
  const { worker } = tracker([40, 25, 10]);
  const results = await runPool(['a', 'b', 'c'], worker, { concurrency: 3 });
  assert.deepStrictEqual(results, [
    { ok: true, value: 'done:a' },
    { ok: true, value: 'done:b' },
    { ok: true, value: 'done:c' }
  ]);
});

test('never exceeds the concurrency cap', async () => {
  const { state, worker } = tracker(new Array(9).fill(15));
  await runPool([1, 2, 3, 4, 5, 6, 7, 8, 9], worker, { concurrency: 3 });
  assert.strictEqual(state.peak, 3);
});

test('concurrency 1 executes in strict sequence', async () => {
  const { state, worker } = tracker([20, 5, 5]);
  await runPool(['a', 'b', 'c'], worker, { concurrency: 1 });
  assert.strictEqual(state.peak, 1);
  assert.deepStrictEqual(state.order, ['a', 'b', 'c']);
});

test('dispatches as slots free, not in fixed batches', async () => {
  // concurrency 2 over [long, short, short]: with batching, item 3 would wait
  // for the long item. With slot dispatch it starts as soon as item 2 is done.
  const started = [];
  const worker = async (item) => {
    started.push(item);
    await sleep(item === 'long' ? 60 : 5);
  };
  await runPool(['long', 'short1', 'short2'], worker, { concurrency: 2 });
  assert.deepStrictEqual(started, ['long', 'short1', 'short2']);
});

test('a throwing worker is captured, does not reject, and siblings still run', async () => {
  const worker = async (item) => {
    if (item === 'bad') throw new Error('boom');
    return `ok:${item}`;
  };
  const results = await runPool(['a', 'bad', 'c'], worker, { concurrency: 2 });
  assert.strictEqual(results[0].ok, true);
  assert.strictEqual(results[1].ok, false);
  assert.strictEqual(results[1].error.message, 'boom');
  assert.deepStrictEqual(results[2], { ok: true, value: 'ok:c' });
});

test('passes the input index to the worker', async () => {
  const seen = [];
  await runPool(['a', 'b'], async (item, i) => { seen.push([item, i]); }, { concurrency: 1 });
  assert.deepStrictEqual(seen, [['a', 0], ['b', 1]]);
});

test('empty list returns an empty array without calling the worker', async () => {
  let called = 0;
  const results = await runPool([], async () => { called++; }, { concurrency: 4 });
  assert.deepStrictEqual(results, []);
  assert.strictEqual(called, 0);
});

test('concurrency larger than the item count is harmless', async () => {
  const { state, worker } = tracker([10, 10]);
  const results = await runPool(['a', 'b'], worker, { concurrency: 99 });
  assert.strictEqual(results.length, 2);
  assert.strictEqual(state.peak, 2);
});

test('bad concurrency values coerce to at least 1', async () => {
  for (const bad of [0, -3, NaN, undefined]) {
    const { state, worker } = tracker([5, 5]);
    const results = await runPool(['a', 'b'], worker, { concurrency: bad });
    assert.strictEqual(results.length, 2, `concurrency=${bad}`);
    assert.ok(state.peak >= 1, `concurrency=${bad}`);
  }
});

test('defaults to concurrency 4 when no options are given', async () => {
  const { state, worker } = tracker(new Array(8).fill(15));
  await runPool([1, 2, 3, 4, 5, 6, 7, 8], worker);
  assert.strictEqual(state.peak, 4);
});
