const { test } = require('node:test');
const assert = require('node:assert');
const { diff, isDiffTooLarge, buildChunks } = require('../lib/diff');

test('diff detects added and removed keys, ignoring null-key noise lines', () => {
  const entries = [
    { line: 'שורה א', key: 'k1' },
    { line: 'שורה ב', key: 'k2' },
    { line: 'רעש', key: null }
  ];
  const { addedKeys, removedKeys, newKeys } = diff(['k1', 'k3'], entries);
  assert.deepStrictEqual(addedKeys, ['k2']);
  assert.deepStrictEqual(removedKeys, ['k3']);
  assert.deepStrictEqual([...newKeys].sort(), ['k1', 'k2']);
});

test('diff deduplicates repeated keys', () => {
  const entries = [
    { line: 'א', key: 'k1' },
    { line: 'ב', key: 'k1' }
  ];
  const { newKeys } = diff([], entries);
  assert.deepStrictEqual(newKeys, ['k1']);
});

test('isDiffTooLarge triggers above 50% and on empty pages', () => {
  assert.strictEqual(isDiffTooLarge(['a', 'b', 'c'], [], 4, 4), true);  // 3/4 > 0.5
  assert.strictEqual(isDiffTooLarge(['a'], ['b'], 4, 4), false);        // 2/4 = 0.5 → not "too large"
  assert.strictEqual(isDiffTooLarge([], [], 0, 0), true);               // nothing to compare → fall back
});

test('buildChunks merges overlapping windows into one chunk of original lines', () => {
  const entries = [];
  for (let i = 0; i < 20; i++) entries.push({ line: `line${i}`, key: `k${i}` });
  const chunks = buildChunks(entries, ['k5', 'k7'], 3); // windows 2-8 and 4-10 overlap
  assert.strictEqual(chunks.length, 1);
  assert.ok(chunks[0].startsWith('line2'));
  assert.ok(chunks[0].endsWith('line10'));
});

test('buildChunks returns separate chunks for distant additions', () => {
  const entries = [];
  for (let i = 0; i < 30; i++) entries.push({ line: `line${i}`, key: `k${i}` });
  const chunks = buildChunks(entries, ['k2', 'k20'], 3);
  assert.strictEqual(chunks.length, 2);
});

test('buildChunks clamps windows at page boundaries and returns [] with no additions', () => {
  const entries = [{ line: 'a', key: 'k0' }, { line: 'b', key: 'k1' }];
  assert.deepStrictEqual(buildChunks(entries, ['k0'], 3), ['a\nb']);
  assert.deepStrictEqual(buildChunks(entries, [], 3), []);
});
