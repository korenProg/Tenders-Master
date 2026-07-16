const { test } = require('node:test');
const assert = require('node:assert');
const { paginate, DEFAULTS } = require('../lib/paginator');

// Mock driver: scripted page texts + scripted goNext answers.
function mockDriver(texts, nexts = []) {
  const calls = { settle: 0, read: 0, next: 0 };
  return {
    calls,
    settle: async () => { calls.settle++; },
    readText: async () => { calls.read++; return texts[calls.read - 1] ?? ''; },
    goNext: async () => { calls.next++; return nexts[calls.next - 1] ?? false; }
  };
}

const PAGE = (n) => `עמוד ${n} `.repeat(120); // > 500 chars, distinct per n

test('collects pages until goNext says no more', async () => {
  const d = mockDriver([PAGE(1), PAGE(2), PAGE(3)], [true, true, false]);
  const pages = await paginate(d);
  assert.deepStrictEqual(pages, [PAGE(1), PAGE(2), PAGE(3)]);
  assert.strictEqual(d.calls.settle, 1); // settle exactly once, before the loop
});

test('stops at maxPages (default 5)', async () => {
  const texts = [1, 2, 3, 4, 5, 6, 7].map(PAGE);
  const d = mockDriver(texts, [true, true, true, true, true, true]);
  const pages = await paginate(d);
  assert.strictEqual(pages.length, 5);
  assert.strictEqual(DEFAULTS.maxPages, 5);
});

test('maxPages is overridable', async () => {
  const d = mockDriver([PAGE(1), PAGE(2), PAGE(3)], [true, true, true]);
  const pages = await paginate(d, { maxPages: 2 });
  assert.strictEqual(pages.length, 2);
});

test('stops on short text without collecting it', async () => {
  const d = mockDriver([PAGE(1), 'קצר'], [true]);
  assert.deepStrictEqual(await paginate(d), [PAGE(1)]);
});

test('stops on empty first read → returns []', async () => {
  const d = mockDriver(['']);
  assert.deepStrictEqual(await paginate(d), []);
});

test('stops on "Page not found"', async () => {
  const d = mockDriver([PAGE(1), 'x'.repeat(600) + 'Page not found'], [true]);
  assert.deepStrictEqual(await paginate(d), [PAGE(1)]);
});

test('stops when pagination did not change the content', async () => {
  const d = mockDriver([PAGE(1), PAGE(1)], [true]);
  assert.deepStrictEqual(await paginate(d), [PAGE(1)]);
});

test('goNext is not called after the final page', async () => {
  const d = mockDriver([PAGE(1)], [false]);
  await paginate(d);
  assert.strictEqual(d.calls.next, 1);
});
